# 验收标准落地 + 三项用户实测缺陷（2026-09-11 第三轮，发布 2.0.16）

本轮起点是用户的三条实测反馈，外加一句更重要的要求：**"假通过太多，从本轮开始建立更完善、更高效、
涵盖更多真实可验收情况的检验标准"**。所以本轮的交付分两半：一半是修缺陷，一半是**把"通过"重新定义成
可被机器强制的东西**（`docs/ACCEPTANCE-STANDARD-20260911.md`）。

## 0. 结论速览

| 用户反馈 | 根因 | 处置 | 证据 |
|---|---|---|---|
| ① 复制图片失败：`无法写入系统剪贴板：-File …app.asar…` | 媒体宿主把 `__dirname/media-clipboard.ps1` 交给 PowerShell，而打包后 `__dirname` 在 `app.asar` 这个**虚拟文件系统**里，外部进程打不开 | 新增 `external-resource.cjs`（asar→`app.asar.unpacked`，缺失时读出来落临时文件，都拿不到就明确报错）+ 打包配置 `asarUnpack: app/**/*.ps1` + 脚本改为 stdout 回一行 JSON（错误不再依赖 PowerShell 本地化文本与码页） | 安装版实测：Ctrl 多选 3 图 → Ctrl+C → **另一个进程**读回 CF_HDROP 3 个文件，SHA256 与磁盘素材逐一对账 |
| ② 小文件打开好像变慢了 | 无可测退化（见 §2） | 建立"打开延迟台账"：窗口可见 / 内容进 DOM / 外壳→iframe / 页面内→DOM / 首屏后安静，冷启 + 热启双路，进基准按容差比 | 2.0.14 → 2.0.15 → 2.0.16 同盘同素材：小文档 1516 / 1541 / 1543ms；热打开 138 / 135 / 130ms |
| ③ Shift+Enter 按一次没反应，要按两次 | 块尾换行在 `white-space: pre-wrap` 下按规范"悬挂"：Chromium 不给它建行盒 ⇒ 块高不变、光标矩形为空 ⇒ 用户看不到任何变化 | 落在块尾的软换行额外补一个**零宽空格脚手架**（有内容才建行盒），用户输入后由 input 监听摘掉；零宽字符在 Lute 序列化时被丢弃（实测四种表示法给出同一 markdown），存盘文件保持干净 | 行号 1→2、光标框高 16px、光标落在新行最左侧（left=28=正文左边界）；未输入时存盘**文件不变**；输入后磁盘出现软换行且**不含**零宽字符 |

四个数字（安装版 2.0.16）：
- Setup `671527e52d375c39731b68ddc347c5f1af4da7c28dc2bdd2189800ccd882c690`
- portable `c853cd5eae4be22214a81d8b2332e0bbff70fa49db569d351bb1d601e642d369`
- VSIX `1cd06fc4305c55b34f03176d2bef2a31666708eb80b4b2777329bbba0c71a9d3`
- app.asar `31fa4bbd7f2a25679d9c054e191a1b77a4be17c3be56f60801dcd1dcec367ac3`
四方哈希链 `verified: true`（`extension-src/render` == `app/renderer` == 安装版 asar 内 `app/renderer` == VSIX 内 `extension/render`；
515 扩展文件 / 492 共享渲染文件；App = 扩展 = vsixmanifest = **2.0.16**）。

## 1. 缺陷 ① 的完整链路（为什么开发树永远测不出来）

```
renderer(iframe)  --copy 事件--> mediaRequest('copy-images')
   --> main: doc.js 解析每张图为真实文件路径（data:/http 的先落图片缓存）
   --> media-host.windowsClipboard()
   --> spawn(powershell, ['-File', __dirname + '/media-clipboard.ps1'])   ← 故障点
```

开发树：`__dirname` = `E:\…\app\renderer\js` → 真路径，一切正常。
安装版：`__dirname` = `…\resources\app.asar\app\renderer\js` → PowerShell 回
`-File 形式参数的实际参数"…app.asar…"不存在`，而这段本地化的用法文本按 UTF-8 解码后就是用户截图里的乱码。

修复分三层，任何一层单独都能把功能救回来：
1. `asarUnpack: ["app/**/*.ps1"]`：脚本被解包到 `resources/app.asar.unpacked/app/renderer/js/`（构建产物已核）；
2. `external-resource.cjs`：打包布局下解析到解包副本；**没解包**（配置漏了/换了打包器）就从 asar 读出内容
   写到 `%TEMP%\markpilot-external\<内容哈希>-media-clipboard.ps1`；都拿不到 → 抛错，绝不 spawn 一个不存在的路径；
3. `media-clipboard.ps1` 改为把结果写成 **stdout 的一行 JSON**：`{ok, action, files, formats, error}`，
   宿主不再解析 PowerShell 的本地化报错；顺带把 stdout 也钉成 UTF-8（原来只钉了 stdin，中文错误经管道回来就是乱码）。

**同一个 bug 还波及 `copy-table`（复制表格到 Excel）与 `copy-image`（单图到 Office）**——它们共用这段宿主，
所以从 1.0.x 起在安装版里一直是坏的，只是没人报到我们这里。本轮一并修好，但**验收只覆盖到共用通路**
（见 `docs/ACCEPTANCE-STANDARD-20260911.md` §三的未覆盖清单）。

## 2. 缺陷 ② 的定位过程（"感觉慢了"怎么变成可判定的）

先把"打开"拆成可观测的四段，再在两份**打包产物**上同盘同素材比：

| 指标 | 含义 | 2.0.14 | 2.0.15 | 2.0.16 |
|---|---|---|---|---|
| `spawnToWindow` | 进程启动→窗口真的出现在屏幕上（OS 层 `IsWindowVisible` 轮询） | 484 | 498 | 479 |
| `shellToIframe` | →应用外壳就绪、编辑器 iframe 开始加载 | 289 | 314 | 303 |
| `inPageToDom` | →内容进 DOM（Vditor+Lute 装载与首次渲染） | 1201 | 1227 | 1242 |
| 小文档合计 | | **1516** | **1541** | **1543** |
| 中文档 / 大文档合计 | | 1590 / 2104 | 1609 / 1918 | 1623 / 1908 |
| 热打开（已开着再开第二个小文档） | | 138 | 135 | 130 |
| 热打开（开着大文档再开小文档） | | 146 | 152 | 144 |

（单位 ms，均为同盘打包产物的中位数；小文档三档取"缓存已热"的复测值。）

结论：**没有可测的退化**。小文档打开成本的大头是编辑器 iframe 里装载 Vditor+Lute 的 ~1.2s，
这一项两版一致；窗口在 ~0.5s 出现。

过程中被排除的两个假象，值得记下来：
- 拿**安装版（D: 盘）**与 **dist 构建（E: 盘）**比，得到"外壳多花 400ms"——换到同盘对比后消失，是磁盘缓存差异；
- 刚装完的头几次启动实测 2740/2923ms：系统在扫描新写入的 23MB asar 与解包出来的新文件，
  热态立刻回到 1543ms。**所以"升级后第一次打开变慢"是真的，但它不是代码问题**，而且用户很可能正是这么感觉到的。

台账因此规定：延迟类指标取"多次样本的最小值"（单次冷启抖动实测可达 1.5s–5.3s），
并且"退化"必须同时超过相对容差**与**绝对下限（ms 类默认 20ms），否则 3ms→4ms 这种噪声会把闸门判死。

## 3. 缺陷 ③ 的定位过程（块尾悬挂换行）

用户原句是以全角右括号收尾的段落行尾。实测四种"换行表示法"在 IR 编辑面里的表现：

| DOM | 块高 | 光标矩形 | 序列化后的 markdown |
|---|---|---|---|
| `text\n`（原实现） | 1 行（不变） | **0×0（无框）** | `text` |
| `text\n<br>` | 2 行 | 0×0 | `text` |
| `text<br>` | 1 行 | 0×0 | `text` |
| `text\n\u200b`（采用） | **2 行** | **有框（高 16px，x=正文左边界）** | `text` |

关键发现：**Lute 序列化时会把行尾的 `\n`、`<br>`、`\u200b` 一起丢掉**，四种写法产出的 markdown 完全一样。
所以零宽空格在这个位置是纯渲染脚手架：它让 Chromium 建出那一行的行盒（光标才有地方站），
却不会落进文件。用户接着输入时由 `input` 监听把脚手架摘掉，避免留在正文里被复制出去。
验收里"没输入内容就存盘 → 文件字节不变"与"输入后磁盘有软换行且不含零宽字符"两条就是钉这个行为的。

## 4. 本轮新增的验收基建（可复用）

```
scripts/acceptance/harness.cjs           CDP 驱动打包产物：启动/注入观测器/真实键鼠/截图/剪贴板证人/产物审计
scripts/acceptance/run.cjs               运行器：场景清单固定、结构闸门、数字台账、基准比对
scripts/acceptance/clipboard.ps1         独立进程的剪贴板证人（read / save / restore，纯 ASCII）
scripts/acceptance/window-visible.ps1    OS 层"窗口真的出现了"证人
scripts/acceptance/external-resource.test.cjs  不启 GUI 的路径解析单测（7 条）
scripts/acceptance/fixtures.cjs          现场生成素材（小/中/大文档、多图、软换行原句、锚点文档）
scripts/acceptance/scenarios/00|10|11|20|30-*.cjs  五个场景
docs/ACCEPTANCE-STANDARD-20260911.md     标准本体（六条判据 + 覆盖边界 + 假通过复盘）
npm run accept / accept:dev / test:acceptance
```

## 5. 顺带修掉的既有缺陷

- `app/main/server.js`：内部服务绑定固定端口 `48190`，被占用时应用**直接崩掉**（`listen` 抛 EADDRINUSE →
  `app.exit(1)`）。便携版 + 安装版同时开、或上一份进程没退干净，用户看到的就是"应用起来了又没了"。
  现在被占用时退到系统分配的空闲端口（端口本来就是动态传给渲染层的）。
- 测试环境自身的一个坑：`spawn(..., {windowsHide:true})` 会让 Windows 把进程**第一次** `ShowWindow`
  改写成 `SW_HIDE`，于是被测窗口从来没出现过——"窗口可见"这类判据会全部假通过（已写进 harness 注释）。

## 6. 复现命令

```bash
npm run test:acceptance            # 7 条路径解析单测
npm run accept                     # 对安装版跑全套（发布闸门）
npm run accept:dev                 # 对开发树跑（asar 审计自动标"不适用"）
# 单场景排查
node scripts/acceptance/run.cjs --app=installed --label=tmp --only=copy-images
# 产物层四方链
node scripts/verify-vsix-chain.cjs "E:/MarkPilot/Typora-Editor/dist/markpilot-2.0.16.vsix" \
  "D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/resources/app.asar"
```

## 7. 交付与安装

- 安装包：`dist/release-2.0.16-private/markpilot-Setup-2.0.16.exe`（已静默安装到用户目录，安装后
  `resources/app.asar.unpacked/app/renderer/js/media-clipboard.ps1` 与源逐字节一致）；
- 便携版：`dist/release-2.0.16-private/markpilot-v2.0.16-portable.exe`
- VSIX：`dist/release-2.0.16-private/markpilot-2.0.16.vsix`（本机无 Python，`pack.py` 的逻辑已等价移植为
  `Typora-Editor/scripts/pack-vsix.cjs`，清单 Identity Version 自动同步）
- 校验：`dist/release-2.0.16-private/SHA256SUMS.txt` 四项 `sha256sum -c` 全 OK
- 受保护素材 md5 未变：`5d347a296614a75d19e649a81e78100d` / `14373f2e9a7c0f498790ebc735e121b7` /
  `d1a7f263e9c05d4375f5bc96d6804d22`（本轮未复制该目录，验收素材全部现场生成）

## 8. 遗留（下一轮的第一批）

1. 补两个打包产物场景：**阅读位置还原**、**复制表格/单图**（CF_HTML 与位图字节级）。
2. `docs/ACCEPTANCE-STANDARD-20260911.md` §三列的"未覆盖"逐条消掉；微信等第三方目标仍需用户手工确认。
3. 性能方向的旧账仍在：首次排版前置、输入重解析收窄到当前块（当前打字成本仍与编辑 DOM 规模成正比）。
