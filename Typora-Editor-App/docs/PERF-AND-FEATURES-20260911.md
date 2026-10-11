# 首次排版前置 + 三项交互需求（2026-09-11 第二轮，发布 2.0.15）

上一轮把首屏从 4.3s 压到 2.7s 之后，剩下的账很清楚：**打开长任务里最大的一段是 Chromium 对整篇的
第一次排版**（实测 ~1.0s，`K` 读 `clientWidth` 触发），而它必须在画出来之前完成。这一轮把它前置掉，
并落地三项交互需求。同一份产物、同一素材、交错两臂的读数如下。

## 0. CV 在首次排版之前生效（首屏第一目标）

做法：
- `index.js` 在构造 Vditor **之前**按内容长度预判大文档（阈值 20 万字符 ≈ 1500 顶层块），给
  `document.documentElement` 加 `typora-cv-pre`；`css/large-doc.css` 里这条规则让**顶层块一插进来就带**
  `content-visibility: auto; contain-intrinsic-size: auto 320px`，于是"插入后的第一次排版"只排可见的几块。
- 真正的门槛（≥1500 顶层块）仍由 `large-doc.js` 在首屏之后复核：不够就把预置类摘掉（小文档零规则命中）。
- 预置期的 320px 是估算高度，量真实高度前必须先摘类（这是上一轮踩过的坑），校准完再挂上 `typora-cv`
  并写回逐块真实高度 + 总量校准。
- 校准期间几何会变一次，所以 `large-doc.js` 对外发布 `window.__typoraCvPending`，滚动位置还原的
  "稳定"判据会一直等到它落定（否则会在"高度稳定 400ms"上提前收工，然后被校准推走）。

同产物 A/B（`ir-perf-probe --flags=cvFirst=off` 为对照，各自全新加载）：

| 指标 | 对照（改前行为） | 本次交付 |
|---|---|---|
| first-contentful-paint | 2732ms | **1892ms** |
| 首屏就绪（一屏公式+图片） | 3239ms | **1952ms** |
| 打开长任务 | 1975ms | **1449ms** |

累计到本轮开始时（`.perf/ir-perf-baseline3.json`，FCP 4324ms / 长任务 3626ms / 首屏 4368ms）：
**FCP −56%、长任务 −60%、首屏就绪 −55%**。整篇排版并没有消失，它变成了首屏之后一次 999ms 的校准
任务（`--flags=cvFirst=off` 时它在首屏之前；这是"先看见文档"换来的必然代价）。

证据：`.perf/ir-perf-cvfirst1.json`（on）、`.perf/ir-perf-cvfirst-off2.json`（off）。

## 1. 内存：归因 + 这一轮的帕累托收益

**归因（冷加载普查，`.perf/mem-census-r2.json`）**：打开 34.8 万字符素材后，渲染进程 592MB，
而 DOM 只有 48,673 个节点、**KaTeX 树只有 65 棵**（窗口化已经把公式渲染成本挡在视口外）。
节点构成：

| 家族 | 数量 | 说明 |
|---|---|---|
| 公式脚手架 | **30,860** | `$` 分隔符 marker 19,547 + preview 5,645 + `<code>` 源码 5,668 |
| 语法/标记 span | 6,129 | `marker--pre/heading/link` |
| 列表/标题/表格 | 1,358 | |
| KaTeX 树 | 65 | 只有视口带被渲染 |
| 其他 | ~10,000 | 工具栏/大纲/正文文本等 |

也就是说：**63% 的节点是公式的源码脚手架**，而不是公式渲染结果。上一轮的新鲜加载 A/B 已证明
（公式全渲染 vs 无公式：1,131MB vs 591MB）——窗口化把渲染进程带到了"无公式"的地板；剩下的
590MB 是 Vditor 的 IR 源码结构 + Blink 的每节点成本。再往下只能虚拟化**编辑面** DOM，那会动
序列化/撤销/IME 的正确性前提，项目明确排除，本轮不动。

**收益（同产物 A/B，`math-perf-probe --flags=cvFirst=off` 为对照）**：

| 指标 | 对照 | 本次交付 |
|---|---|---|
| 渲染进程 privateBytes（静止） | 620MB | **555MB（−10.5%）** |
| 整棵进程树 privateBytes | 880MB | **773MB（−12%）** |

机制与首屏同源：**静止水位由打开时的峰值决定**（Chromium 分配器不把池还给系统），
第一次排版不再覆盖整篇 ⇒ 峰值更低 ⇒ 静止水位跟着降。这条不需要额外改动，是 §0 的附带收益。

## 2. 含图片文档"关掉再打开回到上次位置"（新做）

上一轮先做了两件事：真正定位 + 补齐功能。现状与病根：
- 位置确实持久化（`state.json` 的 `scrollStore[文件路径]`），但只有**一个像素值**，而且还原是
  `after()` 里"10ms 轮询到容器 → 一次 `scrollTo`"。含图片的文档重开时图片还没占位、内容更矮，
  这次 `scrollTo` 会被 `scrollHeight−clientHeight` 夹住，等图片加载把内容撑高之后视口就停在偏上的
  位置（偏差与还原点上方所有图片的高度同阶）。
- 另外切换/关闭文档时 iframe 被换掉，防抖里那次滚动（最多 200ms）永远发不出去。

改法：
- 主进程 `state.js` 增加 `scrollAnchor[文件路径] = {index, delta, head, total}`（与像素值并存），
  `doc.js` 的 `scroll` 消息一并存、`open` 载荷一并给。
- 渲染层 `util.js`：滚动时始终记锚点（顶部块序号 + 块内偏移 + 块开头 24 字）；
  还原时按块找回（序号漂移就用文本头找回），并在**图片加载 / 字体就绪 / 公式队列清空 / 根尺寸变化**
  时持续重贴，直到"高度稳定 400ms 且锚点贴准"或 6s 兜底；`pagehide/beforeunload/hidden` 立刻补发位置。
- 一旦检测到"不是我们造成的滚动"（读者滚轮/点击/输入，或大纲跳转、查找、分屏同步），立刻停手。

验收（`scripts/restore-anchor-probe.cjs`，同一文档、同一记录值，只换还原策略；图片在重开时延迟
900ms 到位以复现真实时序）：

| 臂 | 还原结果 | 视口顶部块 |
|---|---|---|
| legacy（改动前的行为） | 偏差 **145px** | 错 |
| pixel（只重贴像素值） | 偏差 0px | 对 |
| **anchor（本次交付）** | 偏差 **1px** | 对 |
| anchor + 一张图 404（高度变了） | 偏差 **1px** | 对 |
| 用户接管后 | 还原循环停止（`applies` 不再增长） | — |

大文档臂（20 万字符 + 4 图，跨过 CV 与窗口化两道门）：**视口顶部块一致**，像素值差 608px——
这正是"像素不可靠、锚点才可靠"的证明。证据：`.perf/restore-anchor-final.json`、
`.perf/restore-anchor-big1.json`。

## 3. Shift+Enter：块内换行，光标停在新行行首

- Vditor 的 IR 分支没有 Shift+Enter：按键落到浏览器默认的 `insertLineBreak`，随后
  `SpinVditorIRDOM` 会把行尾换行剥掉，于是表现为"没有换行"或"变成新段落"。
- `typora-patches.js` 新增 `patchSoftBreak`：只插一个 `\n`（IR 的 reset 是 `white-space: pre-wrap`，
  一个文本换行就画成紧贴的下一行）并把光标放到它后面；插两个 `\n` 会被解析成两个段落，行尾插 `<br>`
  会被 spin 删掉且 DOM→Markdown 时丢——两条都不行。
- 让路容器：表格单元格、代码/公式/HTML 块、标题（Vditor 自己在这两类里就把 Enter 变成换行；
  标题里的换行在这版 Lute 里会被拆成 `h1+p`）。踩坑：**不能写 `at.closest("pre")`**——整个 IR
  编辑面本身就是 `<pre class="vditor-reset">`，那样写会把所有段落都当成代码块让路。

验收（`scripts/soft-break-probe.cjs`，真实 DOM + 真实按键）：7/7。其中
段落中间（只多一个 `\n`、块数不变、光标后移一位）、列表项内、往返保真（产物 Markdown 重新解析后
换行还在）、标题/单元格/代码块三处让路容器不被打坏。已知边界：紧贴块尾的换行在序列化时会被 Lute
归一化掉（`"text\n"` 与 `"text"` 不可区分），所以"按完什么都不输入"在重开文件后不留空行；
后面接着输入内容就固定住了。

## 4. Ctrl 多选图片 + Ctrl+C 一次把多张图放进剪贴板

- 渲染层（`media-tools.js`）：Ctrl+单击加入/移出多选集合（虚线框），普通单击清空集合、Escape 清空、
  失联节点自动剔除；集合非空（或单击选中的那张仍在选区内）时接管 Ctrl+C。
  正文里选文字按 Ctrl+C 不会被图片抢走（选区不再罩着图片时单选不参与）。
- 剪贴板（`media-clipboard.ps1` 新增 `copy-images`）：主格式 **CF_HDROP 文件拖放列表**——
  微信/资源管理器/Chrome 系网页（DeepSeek 这类）读的都是它；同时给**纵向拼接的位图回退**
  （只认图片的目标），并按需给 `UnicodeText`。无路径的来源（内嵌 data:、http(s)、失效相对引用）
  由主进程先取字节落到图片缓存，拿到真实路径再进列表。**这个 ps1 必须保持纯 ASCII**：
  PowerShell 5.1 用活动 ANSI 代码页解码无 BOM 脚本，中文字节会让解析器报错（实测）。

验收（两层）：
- `scripts/multi-image-copy-probe.cjs`（真实 DOM + 真实按键）：**7/7**（三张 Ctrl+单击、Ctrl+C 发出
  带 3 项的 `copy-images`、再 Ctrl+单击移出、普通单击清空、单图 Ctrl+C、正文 Ctrl+C 不抢、Escape 清空）。
- `scripts/multi-image-clipboard-probe.cjs`（真实系统剪贴板，跑完还原）：三张文件 →
  `FileDrop/FileNameW/FileName/PNG/System.Drawing.Bitmap/Bitmap/UnicodeText/Text` 全部到位，
  拼接图高 540px；混入不存在路径时忽略且不报错；全部无效时明确报错。
- `scripts/multi-image-paste-probe.cjs`（真实网页粘贴）：在一个真实页面里粘贴，
  `clipboardData.files.length === 3`（paste-1/2/3.png），且 items 里带 `image/png`。
  这就是"一次多张进微信/AI/DeepSeek 网页"的自动化等价物。

## 5. 本轮回归

Node 228/228；GUI 21 套件全绿（regression/consistency/features/repairs/ui/reading/math-history/
math-colors/math-boundaries/history-large/table-context/theme-audit/source-toggle-host/protection/
export/shell/table-context-host/table-input-host/media-lifecycle/media-office/media-repro）；
CV 两套（`cv-edge-cases`/`cv-geometry`）与两条新探针全绿；`math-perf-probe` 的
`placeholderKeepsMarkdown=true mdDelta=0 errors=0`。

## 6. 复跑命令

```bash
# 首屏（0）：同产物 A/B
node_modules/electron/dist/electron.exe scripts/ir-perf-probe.cjs --label=now
node_modules/electron/dist/electron.exe scripts/ir-perf-probe.cjs --label=now-off --flags=cvFirst=off
# 内存（1）
node_modules/electron/dist/electron.exe scripts/math-perf-probe.cjs --label=mem-on
node_modules/electron/dist/electron.exe scripts/math-perf-probe.cjs --label=mem-off --flags=cvFirst=off
node_modules/electron/dist/electron.exe .perf/mem-census.cjs --label=now
# 位置还原（2）
node_modules/electron/dist/electron.exe scripts/restore-anchor-probe.cjs --label=now
node_modules/electron/dist/electron.exe scripts/restore-anchor-probe.cjs --label=big --big
# Shift+Enter（3）与多图复制（4）
node_modules/electron/dist/electron.exe scripts/soft-break-probe.cjs --label=now
node_modules/electron/dist/electron.exe scripts/multi-image-copy-probe.cjs --label=now
node scripts/multi-image-clipboard-probe.cjs
node_modules/electron/dist/electron.exe scripts/multi-image-paste-probe.cjs --label=now
```
