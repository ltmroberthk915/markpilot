# LOG 3.0.3（CM6 引擎 · 编辑面图片渲染修复）——内部记录

> 面向用户的说明见 `RELEASE-3.0.3-CM6.md`。上一版记录：`LOG-3.0.2-CM6.md`。
> 触发：用户报"8 MB 多的含图文档，旧 v2 能正常打开，装了 v3 之后成这样了"（**最高优先级**）。

## §1 现象与定位（本机复现，原文件只读）

样本：`D:\…\wxid_…\msg\file\2026-10\新建 Markdown 文档(3).md` —— **8,527,008 B / 191 行**，其中
**20 行是单行裸 `<img src="data:image/png;base64,…">`（最长 916,279 字符）**，另有 4 行 `![image](data:…)`。

| 复现读数 | 修复前（3.0.2 引擎 `30effdae`） |
|---|---|
| 单行高度（113KB 的 data URI） | **20,587 px** |
| 整篇 `scrollHeight` | **282,779 px** |
| 首屏渲染字符 | 11,129（单行 10,971） |
| 渲染文本里出现 `<img` / `data:image` 的行 | 1 / 1 |
| 四种写法的图 | `![](url)` 生成 4 个 **`src` 全空**的 `<img>`；裸 `<img>` **完全不处理**（字面文本） |

**根因（前沿线逐层实测，行号级依据在 `img-bug\frontier\FRONTIER-IMG.md`）**：
CM6 的语义是"文档即 DOM 文本"，916K 字符的无空格 base64 **必须参与浏览器折行**——
`@lezer/markdown` 全量解析只要 36 ms、CM6 语法树 163 ms、`EditorState.create` 17 ms，
但**真实排版**：定宽 900px 时 **544 ms**、内容高 **1,679,561 px**；把 23 条 data URI 折成 60 字符占位符后 **1.1 ms / 2,804 px**。
且 `heightForLine` 按字符**估算**行高 ⇒ 巨行必然落进视口 ⇒ 整条进 DOM；文本按 512 字符分块 ⇒ 916K 字符 ≈ **1,790 个文本节点/行**。
⇒ 结论：**病因在排版层，解法是"把字符挡在文本层之外"**（原子 widget），不是解析或数据层。

## §2 修复（引擎 `dsh-markpilot\renderer-cm6\app.js` 最终 `b4aa58e02102172c` / 1,117,670 B）

`src-cm6\main.js`（110,547 → 115,973 B）：
1. **新增 `ImageWidget`**：`toDOM` 里才赋 `src`（CM6 只为视口内的行建 widget ⇒ 只有可见的图解码）；
   `eq` 用 **`srcKey`＝"长度+首尾32字符"指纹**（前沿预警：900KB 整段逐字比会拖慢每键）；`ignoreEvent() → false`。
2. **新增 `imgAttr()` 与 `scanImageMarks(line, free, take)`**：一条扫**裸 `<img …>`**（属性大小写不敏感、单双引号与裸值都认），
   一条扫 **`![](url)`**（含 `<url>` 与可选 title）；命中即 `take()` 占位，后面的链接扫描不会重复隐藏。
3. `scanInlineMarks` 里插**一行**调用（放在 `free/take` 就绪之后）。
4. **装饰消费端图片优先判**：`src.length > 512` 的图**永远保持 widget**——即使光标进入区间也不展开源码
   （前沿预警：一展开就是 90 万字符回灌 DOM，实测那种行 50–78 ms/键）。
5. **长行护栏**：`const huge = t.length > 20000;` ⇒ 逐字符转义循环加 `!huge`、`scan()` 助手函数内 `if (huge) return;`
   （图片扫描只依赖 `indexOf("<img")`/`indexOf("![")`，成本与行长无关，**不受护栏影响**）。
6. **`EditorView.atomicRanges`**：长 src 的图当原子区间（方向键/选区整块跳过）。
7. CSS `.mp-img`（不超宽、行内块、未加载留最小占位）。

另修一条**独立硬伤**：`dsh-markpilot\lib\index.js` 的 `BODY_MAX_BYTES` **8 MB → 64 MB**
（原值让这份 8,527,008 B 的文档保存时被 **HTTP 413 too-large** 拒掉：能打开、存不回去）。

## §3 验收（头less 三探针 + 装机端到端）

**头less（`img-bug\` 下三个探针，样本＝副本）**

| 判据 | 修复前 | 修复后 |
|---|---|---|
| 四种写法 | 4 个空 src / 裸图字面文本 | 均出 `.mp-img>img`：https `srcLen=25`；data:gif **natural 1×1** |
| 113KB 单行高 | 20,587 px | **27 px** |
| 8.13MB 文档 `scrollHeight` | 282,779 px | **6,177 px**（"长行换占位"对照臂 5,405） |
| 8.13MB 文档字面 base64 行 | 1 | **0** |
| **不回灌判据**（光标进入长 data URI 区间） | — | chars=9、行高 27px、widget 仍在 **✓** |

**装机端到端（3.0.3 portable，`verify-img-exe.cjs`）**：打开就绪 **7 ms**、`docLen=8,523,373`、
`litImgText=0`、`litDataText=0`、**4 张真图**（自然尺寸 1921×575 / 1843×505 / **1855×1250** / 1837×732）、
滚动 1500px 后 7 张、`scrollHeight=5,954`；Ctrl+S 后副本 sha256 **不变**（未损坏）。
小文档对照（同一条打包路径）：`mpImg=1`（裸 `<img src=data:gif>` 也渲染成真图）。

## §3.5 表格格点击映射修复（`cellmap\`，引擎最终 `b2d944294ae0d097`）

**报障现象**：表格渲染出来后点某格，光标没落到对应源码处，且"可能跳到别的格"。

**本机复现（`probe-cellclick2.mjs`，30 格逐格真点）**：28/30 正确，2 个异常**全是"幻影格"**——
参差行（源码 4 格、渲染按**表头列数**出 6 格）里，
`TableRowWidget.toDOM` 给缺格补了 `data-mp-from=0, data-mp-to=0` 的**假区间**；
点它 → `tableCellClick` 照 dataset dispatch `setActiveCell(幻影列)` →
但 `cellRangesOf(源码行)` 取不到 `ranges[4]` ⇒ `if (ranges[col])` 守卫**跳过激活**
⇒ 覆盖层**停在上一格的内容**上（点第 5 格、显示第 4 格的字）——继续打字会写进第 4 格。

**修复（两处）**：
1. `toDOM` 不再撒谎：源码里没有的格**不打 from/to**，改打 `data-mp-phantom="1"`；
2. `tableCellClick` **钳到最近的真实格**，并让 `setActiveCell` 与覆盖层**同进同退**。

**顺带修"点哪落哪"**：改前点格后光标**一律落在格尾**。现按点击点在格内的横向比例估源码字符位置传给
`activateCellOverlay(…, caretOffset)`，`focusIt` 把 Range 折到该字符上。

**诊断路上踩到的两个坑（都留了证据）**：
- 比例算式一开始永远算出"末尾"：因为 mousedown 期间 CM6 可能刚重建过整行 widget，
  事件里的 td 已**脱离文档**，而 detached 节点的 `getBoundingClientRect()` 全是 0 ⇒ frac 兜底成 1。
  改用**活节点**现查（`view.dom.querySelectorAll` 按 row/col 找，同 `positionCellOverlay` 的口径）后正常。
- 探针里"点在格的 50%/75% 处仍是末尾"**不是 bug**：覆盖层 div 占满整格（609px），文本只有 146px，
  点已越过文本末尾 ⇒ 浏览器原生就把光标钳到末尾；在**文本宽度内**点 35%/60%/85% → offset 4/7/10 ✓。

**判据**：`probe-cellclick3.mjs` 30 格全绿（幻影格按"钳到最近真实格"判）；`probe-caret.mjs` 25% → offset 3；
装机产物 `verify-cellmap-exe.cjs` **24 格全部正确**（含 2 个幻影格）。

## §3.6 图片扫描器的三条同族缺陷（独立复核抓出，已修）

| 缺陷 | 现象 | 修法 |
|---|---|---|
| 属性名无边界 | `<img data-src="lazy.png" src="real.png">` 渲染成 **lazy.png**（`data-src` 是常见懒加载写法，且在 `src` 之前）；`data-alt` 同理取错 alt | 单趟属性扫描 + 名字**精确匹配**（`imgAttrs`） |
| 标签扫描忽略引号 | `<img alt="a>b" src=x>` 里的 `>` 会提前截断标签 | 引号感知的手工扫描 |
| URL 正则不支持配平括号 | `![a](https://x/y(1).png)` 被截成 `https://x/y(1`，`.png)` 残留成字面文本 | `](` 之后按**深度 0 的 `)`** 找结束、支持 `\(` 转义 |

**验证**：复核方的 13 条夹具在**活包**上重跑（`probe-edge-live.mjs`）**全部符合期望**，
外加"引号里有 `>`"一条共 14 条 ✓。（复核脚本注入的是它自己冻结的旧字节，所以它那轮仍是红的。）

**未解决（如实记账）**：把 6 遍正则降成 1 遍扫描**并没有**降低每键成本——
8.13MB 样本上 `p50=90.7ms / p95=92.8ms`（改前 90.1/96.2）。
⇒ 90ms 主要来自**四个整篇扫描器**（`scanMathSpans`/`scanLineStyles`/`scanTables`/`scanInlineMarks`
每次 docChanged 都全量重扫 8.5MB），不是属性正则。真正的解法是**增量扫描**（只重扫 changed ranges 覆盖的行，
未受影响的行平移 mark），属独立工作项。

## §3.7 引用区里的单 `$` 跨行数学块（`mathquote\`，引擎 `3a557e0ba0dc316d`）

**报障**：引用区里 `$\begin{align}…\end{align}$` 整段不渲染；`x^*_` 的**星号总被自动折叠吞掉**。

**同源根因**：`scanMathSpans` 的跨行逻辑只认 `$$`（围栏 / 单行 / 行首带内容），
而这份是**单 `$` 定界、跨多行、每行还带引用前缀 `> `** —— 三条都不沾 ⇒ 没被认成数学
⇒ ① 不渲染；② 里面的 `*` 落进行内标记扫描，被 `/\*[^*\n]+\*/` 当成斜体定界符**成对隐藏**（`x^*_t` → `x_t`）。

**修法**：内容以 `$\begin{` 开头即开启"单 `$` 跨行"形态；逐行**剥掉引用前缀**后拼 tex（不剥的话 KaTeX 会吃到 `>`）；
遇到以 `$` 结尾的行闭合，推一个 `display:true` 的块级 span。识别成数学后，`overlapsMath` 守卫自然让星号不再被吞。

**判据（`probe-mathquote.mjs`，用户那份推导块逐字复刻）**：KaTeX 节点 3、**字面 TeX 残留 0**、
渲染总字符 71 / 8 行；截图肉眼确认：块级公式带 `(1)` 编号正常显示，`u^*_{S:t}` / `x^*_t` / `u^*` / `x^*_S` 星号齐全。

**未处理**：报障第三条"引用区**选中的高亮提示**不直观"尚未取证（需要明确期望：选区底色、引用左侧竖条、
还是隐藏 `>` 后的选区边界）。属下一轮。

## §4 已知取舍与后续

1. **超长单行不再做行内标记投影**（>20,000 字符）：这类行通常是机器生成的图片数据；换来的是每键不再扫 850 万字符。
2. **长 data URI 的地址不在写作面展开**（要改用「编辑源码」）——展开即 90 万字符回灌，实测 50–78 ms/键。
3. **8.5MB 文档的每键 dispatch ≈ 94 ms**（`scanMathSpans`/`scanLineStyles`/`scanTables`/`scanInlineMarks` 仍是**整篇**扫描）。
   这一版没动它（用户的直接症状已解）；若要继续优化，方向是"巨行只扫前缀 + 增量扫描"，属 β/后续。
4. **插件面的 64MB 上限**只在代码层改并核对了常量；真正的"保存 8.5MB 文档"要在 DSH 面板里跑一次端到端。
5. 前沿线推荐的两条更远期路线：块级图片 widget（须 `StateField` 直供 + `estimatedHeight`，官方硬约束：**直供才能改垂直布局、间接提供才能读视口**）与"按需抽成 `assets/` 外链"（会改写用户文档，默认行为不可接受）。

## §5 复现命令

```powershell
cd E:\MarkPilot
node .mp-verify\img-bug\probe-img-syntax.mjs      # 四种写法 → 是否出真图
node .mp-verify\img-bug\repro-img-doc.mjs         # 8.13MB 文档 → scrollH / 字面 base64（含对照臂）
node .mp-verify\img-bug\probe-noreveal.mjs        # 光标进长 data URI → 是否回灌
node Typora-Editor-App\scripts\acceptance\app-slot.cjs -- node E:\MarkPilot\.mp-verify\img-bug\verify-img-exe.cjs
```
