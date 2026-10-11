# cross-window-clipboard 族普查记录

- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`，188784128 B，sha16=`81b39273efae31e5`
- 夹具图：`.mp-verify/checklist/assets/small.png`（96×64 PNG，495 B）
- 探针：`cross-window-clipboard.cjs`（`run` / `recon`）；诊断：`cross-window-clipboard-diag{,2,3,4}.cjs`、`cross-window-clipboard-ps.ps1`
- 用例数：**11**（X1–X11）
- 判决分布：符合预期 **5** / 环境阻断 **5** / 不符预期 **1**（X4，探针选表手势，非产品缺陷）
- 渲染侧 `pageerror`：**两次正式运行全部为空 `[]`**（run1 曾有一条 `onerror:undefined`，是坏图夹具所致）

## 一、本族被一个**环境事实**卡死（先说这条，否则后面读数会被误读）

**OS 剪贴板在本会话里对所有进程都不通**，四个独立证据：

| # | 证据 | 读数 | 来源 |
|---|---|---|---|
| 1 | 应用**自己的壳层**写剪贴板 | `mpHost.writeClipboard({text,html})` → `{ok:true,bytes:15,hasHtml:true}` | run4 `0 环境体检` |
| 2 | 紧接着用**同一个壳层**读 | `clipboardHasImage().textLen` = **0**（哨兵没进去） | run4 `0 环境体检` |
| 3 | 应用自报「已复制图片（96×64）」，壳层读 | `hasImage:false, width:0, height:0, textLen:0` | run4 X5 |
| 4 | **会话外**独立进程（Win32 `OpenClipboard`，30 次重试） | `FAIL open OpenClipboard err=5`（拒绝访问） | `cross-window-clipboard-ps.ps1` |

另：渲染侧 `navigator.clipboard.writeText()` 报成功、`readText()` 恒空串；`grantPermissions` / `Browser.grantPermissions` / `Browser.setPermission` 三条授权路全试过，读数不变（`cross-window-clipboard-diag.cjs`）。

⇒ 「复制进系统剪贴板」与「从系统剪贴板粘贴」两端都**不可观测**。凡是要跨过 OS 剪贴板的用例，本环境一律判不出真伪，标**环境阻断**，附各自「已证事实」，不写「通过」也不写「失败」。

## 二、逐用例判决

| # | 用例（真实通道） | 判决 | 关键读数 |
|---|---|---|---|
| X1 | A 拖拽选行 → 真实 Ctrl+C → B 末尾真实 Ctrl+V | 环境阻断 | 拖拽选中成功（`第一行标记 …-T1`，`activeInEditor:true`）、copy 事件 `inEditor:true, dom=选中文本`、Ctrl+V 的 paste 事件 `inEditor:true` 但 `types:[]`；剪贴板递给应用 `textLen:0` |
| X2 | B → A 反向同一套 | 环境阻断 | 同上（B 里选中 `乙初始 …。`，A 侧 paste `types:[]`） |
| X3 | A 复制 → A 自己粘贴 | 环境阻断 | 同上（同窗口也拿不到，说明不是"跨窗口"特有的断点） |
| X4 | A 拖拽选整表（表头+分隔行+2 数据行）→ B 粘贴 | **不符预期（探针手势）** | `table.mp-row` 的矩形 `top:275 bottom:317`（视口 716），起点/终点坐标都落在矩形内，但拖拽后 `activeInEditor:false`、选区折叠在 206。**表格是 block widget，本探针的"跨表拖拽"手势选不中它**（与既有普查记录「点数据格不会移动 CM 光标」同源）⇒ 判据不可用，非产品缺陷；也未验证"真人从表格左侧空白起拖"能否选中 |
| X5 | A 把图片滚到可见 → 真实右键 →「复制图片」→ B 粘贴 | 环境阻断 | 右键菜单项存在且真实可点；toast `已复制图片（96×64）`；壳层读 `hasImage:false,textLen:0` |
| X6 | 粘贴矩阵·纯文字两行 → B | **符合预期** | 文档 29→68；末尾两行齐全；paste 事件 `types:['text/plain']` |
| X7 | 粘贴矩阵·表格 HTML（`<meta charset><table>`，等同应用「复制表格」写出的口味）→ B | **符合预期** | 68→129；落成 Markdown 表格（表头/`\| --- \|`/两条数据行齐全），toast `已建成 3 行 × 2 列`，**落盘自证**：`clipB.md` 里就是 `\| 头A \| 头B \|` / `\| --- \| --- \|` / 两条数据行 |
| X8 | 粘贴矩阵·只有 `text/plain` TSV（Excel 口味）→ B | **符合预期** | 129→190；同样转成 Markdown 表格，toast 同上，无报错 |
| X9 | 粘贴矩阵·图片（PNG File 进 `clipboardData.items`）→ B | **符合预期** | 文档尾部出现 `![](data:image/png;base64,…)`，**页面里图片真渲染**（`naturalWidth/Height = 96×64`），toast `已插入图片`；注：走的是内联 data URL（`mp-image-mode` 默认 inline），不是 `assets/` 落盘 |
| X10 | 对照臂·同一注入打到 A | **符合预期** | A 的图片引用 2→（新增 1 条），渲染 2 张（原有 96×64 + 新粘 96×64）⇒ X9 不是「B 窗口特有」 |
| X11 | 表格浮动条 →「复制为 Markdown 源码」（真实鼠标点 ▦ + 点菜单项） | 环境阻断 | 浮动条 6 个按钮、菜单 13 项都在，点击后 toast `已复制表格源码（Markdown）`、文档长度不变；壳层读 `textLen:0` |

## 三、**必须上报的异常**：粘贴序列之后，第二个窗口变成了 A 的文件

- 现象（run3/run4 两次一致，**截图实锤**）：跑到末尾时窗口 B 显示的是 **A 的文档**（标题、正文、表格全同），不是 `clipB.md`。
  - `B-final.png` 左上角标题 = `A 文档 XWCH41X`，底栏 `行 17/17 · 206 字`（= A 的夹具长度 206）
  - `A-final.png` 同样是 A 的文档，底栏 `893 字`（= A 粘完图片后的长度）
- 渲染侧一手读数（run4 `Z5`）：`A 收尾自报 = {name:'clipA.md', sessions:{mine:1,total:2}, docLen:893}`；两窗口同文件。
- 壳层一手事实（本实例 `main-debug.log`，只取本实例 ready 之后的行）：
  ```
  01:14:55.073 openPath:start ...\clipA.md
  01:14:55.073 openPath:target {"hasTarget":false,"isPrimary":true,"sessionPath":"...clipB.md","tag":null,"wcId":2}
  01:14:55.077 doc:push:openPath {"to":2,"path":"clipA.md"}
  01:14:55.082 recent:addRecentDocument ...\clipA.md
  01:14:55.084 openPath:loaded {...clipA.md, len:206}
  ```
  （55.073 与 55.084 两行 `start/loaded` 成对出现，是**两次** load；同一秒 `wcId:2` 的会话被推成 `clipA.md`，紧接着 `01:14:56.513 file:save {...clipA.md, bytes:945}`）
- **没能定位来源**（不猜）：
  - 产品代码只读核对：渲染侧 bundle 里**搜不到 `openPath`**；壳层能无 target 调 `openPath` 的入口只有 `file:openPath`（渲染侧从未调用）/`recent:open`/`second-instance`/启动回退。
  - 插桩复现（`cross-window-clipboard-diag4.cjs`：把应用复制到 `.mp-verify`，只在副本 `main.js` 的 `openPath` 里加一行调用栈 trace，跑同一套手势）——**没有复现**：全程只有 2 次 `openPath`，栈分别是 `main.js:746`（启动 argvFile）与 `main.js:627`（`openInNewWindow` 的 `ready-to-show`），粘贴序列之后一次都没有。
  - 最可疑的外部因素：**并行普查里别的会话同期也在起 MarkPilot 实例**（同期 `tasklist` 可见 `startup-and-menus-out\p-main`、`window-states\profile`、`table-daily-out\clipdiag\profile` 等 profile），而 `app.on('second-instance')` 正是"拿 argv 里的 .md 调 openInNewWindow"那条路；本次环境的并发实例互相干扰已在第一轮证实（夹具被同秒改写、端口撞车）。
  - ⇒ 结论口径：**「B 窗口拿到 A 的文件」是实测到的现象（截图 + 壳层 log 双证）；成因未定位，未验证**。要坐实需要：在**打包产物**上重跑同一序列并插桩（本族的插桩只能作用于开发副本），或先排除并发实例干扰后单跑。
- 对本族判读的影响：X1–X5、X11 这些"环境阻断"结论**不受影响**（它们的读数在异常发生之前各自成对采集）；但**收尾态的 X1–X4 之外的读数不要再引用**。

## 四、运行时异常 / 崩溃

- 渲染侧 `pageerror`：run4 `[]`、run3 `[]`（两次正式运行皆空）。
- 应用自报的失败提示：本轮**没有**（X5 图片复制这次是成功的：toast `已复制图片（96×64）`；上一版普查里那条 `nativeImage is not defined` 已被修掉，核对 `main.js:7` 已解构 `nativeImage`）。
- 收尾 `tasklist`：本族实例全部 `taskkill /PID … /T /F` 清理干净（收尾任务查询无输出行，按 profile 过滤复查「无」）。
- 产品代码未改动：`main.js` sha16=`48a75ecb14559714`，`git status` 对 `MarkPilot-CM6/main.js`、`preload.js` 无输出。

## 五、给下一轮的可用结论

1. **粘贴内容正确性已经可判**（不依赖 OS 剪贴板）：文字、表格（HTML 口味与 TSV 口味）、图片（File 口味）三条路都**符合预期**，且表格/图片都有落盘与渲染两层自证。这一组是本族可复用的回归臂。
2. **跨窗口那半边（复制→另一端粘贴）在当前环境下无法穷尽**：需要一台剪贴板可用的机器/会话（本会话连 Win32 `OpenClipboard` 都被拒），或由主进程侧提供"读剪贴板"的取证通道（现在只有 `clipboardHasImage()` 一个口，且它也读不到）。
3. 复跑方式：
   ```
   node E:\MarkPilot\.mp-verify\checklist\cross-window-clipboard.cjs "E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe" run
   ```
   探针自带环境体检：一旦剪贴板可用（壳层写后读 `textLen>0`），跨窗口用例会**自动改判**成真实的「符合/不符预期」，不需要改码。
4. 探针隔离纪律（本轮踩过，务必保留）：目录与端口都带随机后缀；夹具长度与 app 读到的长度不符就 **exit(4) 拒绝出数**；`main-debug.log` 只认本实例 ready 之后的行。

## 六、证据文件

- 探针：`.mp-verify/checklist/cross-window-clipboard.cjs`（本族主探针，11 用例）
- 诊断：`cross-window-clipboard-diag.cjs`（剪贴板通道体检）、`-diag2.cjs`（壳层写/读对照）、`-diag3.cjs`（图片渲染 + 复制图片 toast 与壳层读的矛盾）、`-diag4.cjs`（副本插桩查 openPath 调用者）
- 外部尺子：`.mp-verify/checklist/cross-window-clipboard-ps.ps1`（Win32 剪贴板读写，用来说明"会话外进程也够不到"）
- 读数：`.mp-verify/xwclip-elg3s9/result.json`（run4 主记录）、`xwclip-vvs4i2/result.json`（run3）、`xwdiag2-9yh27/diag2.json`、`xwdiag3-g71mp/diag3.json`
- 截图：`.mp-verify/xwclip-elg3s9/A-final.png`、`B-final.png`（两张都是 A 的文档 = 第三节异常的视觉证据）
- 日志：`.mp-verify/xwclip-run3.log`、`xwclip-run4.log`、`xwclip-diag.log`、`xwclip-diag2.log`、`xwclip-diag3.log`、`xwclip-diag4.log`
- 壳层 trace：`.mp-verify/xwclip-elg3s9/profile/main-debug.log`（本实例 100 行，含第三节那 5 行 openPath）
