# 收官轮：最后一个量级性能修复 + 边缘用例大扫描（2.0.18，2026-09-11）

> **要"照着一份文件跑完整轮"请用 `docs/LOG-20260911-2.0.18.md`**：那份是自包含日志（交付物 + 全部数据 + 全部脚本 + 经验 + 执行清单），这份是叙事版报告。

用户令：「最后一次大规模性能优化改进……进行史无前例的最大规模量级的边缘 case 的检验，
从小到数学公式表格内编辑复制粘贴删减增，到页面滚动、框架渲染等大情况的问题检查。」

本轮结论先写在最前面：

1. **冷启动找到并修掉了一个 1.1 秒级的真凶**，不是"预热宿主"那类结构改造，而是内部服务
   用 `createReadStream` 读 **app.asar 内**文件——Electron 会把整个文件先抄到临时目录。
   安装版实测：编辑器页面内耗时 **1218ms → 214ms**，lute.min.js 取用 **882ms → 13ms**。
2. **顺手抓到并修掉一个真功能缺陷**：右键菜单的「剪切」只把文字放进剪贴板、**不删正文**
   （Ctrl+X 正常）。用户点剪切会觉得"没反应"，再粘贴就是一份重复内容。
3. **边缘用例扫描扩到 12 个场景**（新增 70–73）：表格单元格里的公式编辑/行列增删/复制表格、
   行内公式的**往返字节保真**、大文档滚轮到底 + 文末编辑 + 文档切换、查找替换/粘贴/剪切撤销。
4. **一条被数据否掉的改动**（外壳延迟挂载 iframe）已按纪律回退，并留下实测数字。
5. **一条"看着像 bug、其实不是"的结论**：含表格的文档保存时表格会被重排（列宽补空格、
   分隔行破折号数按列宽重算），但重新打开行/列/内容全对——是对齐行为，不是数据损坏。

---

## 一、冷启动 1.1 秒的真凶：asar 内文件被"抄"到临时目录

### 怎么定位的

台账上"安装版页面内 1218–1261ms、开发树 234ms"这个 5 倍差距一直被我按"asar 读得慢"糊过去。
本轮拆开量：

| 谁 | 耗时 |
|---|---|
| `fs.readFileSync(<asar>/…/lute.min.js)` | 1.1ms |
| `fs.promises.readFile` 同一文件 | 1.5ms |
| **`fs.openSync` 同一文件** | **868ms** |
| `fs.openSync` 290KB 的 index.min.js | 93ms |
| `fs.openSync` 44KB 的 index.css | 1.3ms |
| `fs.openSync` package.json | 4.9ms |
| 第二次 `openSync` 同一文件 | 0.0ms |

耗时与**文件大小成正比**、且只有第一次付——这形状说明 Electron 在 `open()` 归档内路径时
把文件整体抄了出去（约 4MB/s）。而 `app/main/server.js` 的 `sendFile` 正是
`fs.createReadStream(file).pipe(res)`，`createReadStream` 内部走 `open`。于是：
**编辑器页要的 3.8MB lute.min.js 在冷启动关键链上被"抄"了一次。**

用生产代码的 `startServer`（把 `rendererRoot` 指向已安装产物的 app.asar）做 A/B：

| 服务方式 | lute.min.js(3.8MB) | index.min.js(290KB) |
|---|---|---|
| `createReadStream`（改前） | **1161ms** | 78ms |
| `readFile` + `res.end`（改后） | **13ms** | 1.0ms |

### 改动

`app/main/server.js` 的 `sendFile` 改为 `fs.readFile` 整读后一次性回写（带 `Content-Length`，
并顺带把 HEAD 走对），并留了「不要再改回 createReadStream」的注释与**两条永久防线**：

- 单测 `scripts/acceptance/external-resource.test.cjs`：`app/main/server.js` 里不许再出现
  `createReadStream|openSync|fs.open(`（注释里提到不算）；
- 验收场景 00 的产物审计同时比对 asar 内 server.js 与开发树字节。

### 效果（安装版，同一台机器，同一份素材，`scripts/acceptance/probe-codecache.cjs`）

| 指标 | 2.0.17（改前） | 2.0.18（改后） | 变化 |
|---|---|---|---|
| 页面内 → 内容进 DOM | 1261 / 1218 / 1213 ms | **234 / 211 / 227 ms** | **−1004ms（−82%）** |
| lute.min.js 取用（start+duration） | 264+885 / 226+882 / 233+865 | **77+10 / 73+12 / 67+17** | **−869ms** |
| 进程启动 → 内容进 DOM | 1564 / 1482 / 1463 ms | **829 / 537 / 558 ms** | **−924ms** |
| 进程启动 → 窗口可见 | 513 / 488 / 479 ms | 496 / 497 / 481 ms | 不变（本来就不在这个链上） |

> 第一次启动的 829ms 比后两次（537/558）高，是系统还在扫描刚装的 asar（老现象）。

---

## 二、顺手抓到的真缺陷：右键「剪切」不删正文

### 证据（打包产物，`scripts/acceptance/probe-cut2.cjs`）

在真实选中的文字上右键 → 点「剪切」，页面内 hook 住 `document.execCommand` 记录到：

```
{command:'cut', result:true, atCall:'第一段要剪切的文字甲', collapsedAtCall:false}
剪切后: occurrences 仍然是 1（文字还在），剪贴板里确实有这段文字
对照：同一个选区按 Ctrl+X → occurrences 1 → 0（真的删掉了）
```

即：`execCommand('cut')` 在 Electron 里**返回 true、也写了剪贴板，就是不删正文**——而
`cutSelection()` 原来是 `if(ok)return true;` 直接放行，于是菜单里的「剪切」看起来"没反应"。

### 改动

`extension-src/render/js/media-tools.js` 的 `cutSelection` 改为以**事实**为准：剪切成功后选区
必然塌掉，所以「选区还在」就自己用 `Range.deleteContents()` 删，并先用 `execCommand('copy')`
兜一次剪贴板（`cut` 已写过时是幂等的）。选区不在编辑面内时保留原来的 cut 事件回退。
验收场景 73 现在把这条钉住：粘贴后出现 1 次 → 剪切断言 0 次 → Ctrl+Z 断言 1 次。

---

## 三、边缘用例扫描（新增 70–73，全部跑在打包产物上）

| 场景 | 覆盖 | 关键判据（都是代码之外的东西） |
|---|---|---|
| **70-table-cell-math** | 单元格里的行内公式：点进去编辑、真键盘打字、行列增删、复制表格 | 点前源码折叠（`codeWidth=0`）、点后展开且光标在源码里、`data-math` 与源码逐字一致、**加完再删磁盘字节必须回到加之前**、CF_HTML 片段含表头/中文单元格/公式 |
| **71-inline-math-edges** | 行内公式行首/行尾/紧贴全角标点、块级公式、单元格公式改写 | **往返保真**：打字+退格（内容回到原文）后存盘，磁盘字节与原始**逐字节相同**；行尾公式后追加的字进磁盘且公式没被写坏；表格语义（行/列/内容）往返不变 |
| **72-large-doc-scroll-edit** | 2002 块大文档：真滚轮到文末、文末编辑落盘、文档切换（大→小→大）、打字延迟 | 滚轮位置单调增加到文末、视口内文字都能在磁盘素材里找到、可见区公式全部渲染、末尾段落在视口、切换后标题/字数与目标素材一致且旧内容不残留 |
| **73-mixed-editing-stress** | 查找/替换（Ctrl+F 真按键 → 面板 → 计数 → 替换 → 落盘）、剪贴板粘贴（内容由独立进程写入）、剪切 + Ctrl+Z | 命中计数 1/1、替换后磁盘标题变更且行数不变、粘贴**只出现 1 次**、剪切后 0 次、撤销后 1 次 |

新增素材：`math-table.md`（单元格里就是公式）、`dense-math.md`（公式+表格）、
`math-only.md`（只有公式，用于严格字节保真）。

### 扫描过程中被"证据"纠正的三个假判据（值得记下来）

1. **剪贴板要轮询**：写剪贴板走 PowerShell（首次 `Add-Type` 要 1–2s），点完菜单立刻读会读到
   用户原来的内容——"复制表格失败"的第一版就是这么假失败的（实际产品没问题）。
2. **表格行/列增删不能只数行数**：删掉的可能是另一行。改成"插一行 → 删掉刚插的那一行 →
   磁盘字节必须回到插之前"，才真正钉住语义。
3. **右键必须落在选区内部**：落在选区外，Chromium 会把光标挪过去、选区塌掉，于是"剪切"变成
   对空选区的操作。场景 73 因此改为"在选区中心右键"（`edge.selectionPoint`）。

---

## 四、含表格文档保存时会重排表格（是行为，不是损坏）

用只有公式+表格的素材实测：只在一个**段落**里打字再退格（正文内容等于原文）后 Ctrl+S：

```
原始：| 项 | 值 |          →  保存后：| 项 | 值              |
      | --- | --- |                 | -- | --------------- |
      | 一 | $\alpha+\beta$ |        | 一 | $\alpha+\beta$ |
      | 二 | $\gamma$ |             | 二 | $\gamma$       |
```

- 列宽被补齐空格、分隔行的破折号数按列宽重算（`--` 只有 2 个）。
- **决定性一问**：这种表格重新打开还能不能当表格解析？→ 实测 `rows:3, cells:[2,2,2]`，内容
  一字不差。**所以是排版归一，不是数据损坏。**
- 推论（已写进判据）：**"往返字节保真"必须在没有表格的素材上量**（`math-only.md`）；含表格的
  素材单独验"表格语义往返不变"。

---

## 五、被数据否掉的改动（同样重要）

**外壳先上屏、两帧之后再装编辑器 iframe**：假设是"iframe 一导航就解析 4MB 脚本，把外壳首帧
压在后面，窗口因此晚 ~220ms 出现"。安装版实测：

| | 改前 | 改后 |
|---|---|---|
| 窗口可见 | 513 / 488 / 479 ms | 496 / 497 / 481 ms |
| 外壳 → iframe 导航 | 303 / 264 / 250 ms | **595 / 326 / 331 ms** |
| 内容进 DOM（同轮） | 1564 / 1482 / 1463 ms | 829 / 537 / 558 ms |

窗口可见**没有变化**（外壳首帧的瓶颈是渲染进程启动，不是 iframe 抢主线程），而内容进 DOM
被推迟了约 60ms。**按"没收益就回退"的纪律把这段删了**，并把实测数字留在
`app/shell/shell.js` 的注释里，避免下一轮再想当然地做一遍。

同轮被数据否掉的还有两项（见 SKILL 规则 39）：预置 lute/katex 脚本标签、把 warmup 片预算
从 8ms 降到 4ms——前者在 asar 修复后"取回"只剩 10–17ms，没有可省的了；后者没有新的证据
说明 8ms 预算在制造卡顿。

---

## 六、构建链路本身也有一个坑（已修）

本轮 electron-builder 连续三次失败，都是 `Timeout awaiting 'request' for 600000ms`
（`connect ETIMEDOUT 20.205.243.166:443`，GitHub 不可达）：它要下载并解包
`electron-v44.2.0-win32-x64.zip`。`ELECTRON_BUILDER_BINARIES_MIRROR` 对 electron 本体的
下载**不生效**（那个变量只管 builder-binaries，如 winCodeSign/nsis）。

修法：`scripts/dist-fresh.cjs` 现在自动带上 `--config.electronDist=node_modules/electron/dist`
（同一版本同一平台的解包产物），**构建完全不依赖外部下载**；`--no-local-electron` 可退回默认。
winCodeSign（rcedit/signtool 用到）也已从 npmmirror 镜像预先放进
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign-2.6.0\winCodeSign-2.6.0.7z`。

---

## 七、既有红测（本轮确认是"陈旧期望"而非新缺陷）

`node scripts/run-electron-test.mjs math-table` 报
`Formula queue did not finish: {total:5634, missing:5617, gated:5617}`。

用 `git stash` 把本轮改动摘掉后**同一失败复现**，所以不是本轮引入。原因：测试等"5634 处公式
全部渲染完"，而产品对 ≥1500 块的文档**故意**只渲染视口附近（`math-scheduler` 的窗口化闸门，
`gated:5617` 就是被 park 掉的部分）。结论：这条测试的期望写在窗口化之前，需要按新语义改写，
本轮只记录、不改（改它属于测试维护，且要连带确认窗口化语义，不在"性能+边缘 case"范围内）。

---

## 八、复现命令

```bash
# 1) asar 服务 A/B（生产代码的 startServer，进程内量）
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe /tmp/serve-ab.js stream|read

# 2) 冷启动 / 代码缓存（同一 profile 连续启动）
node scripts/acceptance/probe-codecache.cjs --app=installed --runs=3 --label=installed-after

# 3) 剪切缺陷复现（打包产物）
node scripts/acceptance/probe-cut2.cjs

# 4) 全套验收（12 场景）
npm run accept

# 5) 表格重排取证
node scripts/acceptance/probe-cut.cjs
```
