# LOG 3.0.4（CM6 引擎 · 版心/缩放/状态栏 + 引用区数学·表格·高亮）——内部记录

> 面向用户的说明见 `RELEASE-3.0.4-CM6.md`。上一版记录：`LOG-3.0.3-CM6.md`。
> 本轮来源：用户加急四项 + Lead 追加第 5 项（引用区表格）。
> 全部取证脚本在 `.mp-verify\v304\`（本目录即本轮的证据仓）。

## §1 范围与决定（五项）

| 项 | 用户可见目标 | 拍板决定与理由 |
|---|---|---|
| ① 页面宽度 | 设置里可调正文宽度（0–100%，默认贴合 Typora 观感） | 滑杆 40–100、默认 **74%**；只作用于 `.cm-content`（居中留白），工具栏/状态栏/大纲不动 |
| ② 缩放解耦 | `Ctrl+=/-/0` 只缩放正文；工具岛大小独立可调；底部状态栏 + 右下角可键入缩放 | 缩放＝`.cm-editor` 上的 CSS **`zoom`**（实测语义见 §3）；岛大小＝`.mp-toolbar` 自己一档 `zoom`（设置项 80–140%） |
| ③ 引用区块公式 | 引用区 `$\begin{cases}…\end{cases}$` 等形态渲染 | 修 `scanMathSpans` 的"单 `$` 同**行**闭合"分支（见 §4） |
| ④ 引用区选中高亮 | 选区覆盖整段引用、隐藏 `>` 不造成"多一块少一块" | 口径：① 引用框左缘＝正文列左缘（正文列左 padding 24px 作引用框留白）；② 隐藏标记改**零宽 widget**（不再零宽 replace）；③ 竖条保持 `--mp-quoteBar`、选中态不变色（保连续性） |
| ⑤（追加）引用区表格 | `> | a | b |` 渲染成表格 | 新增 `tableLead()` 作为**唯一**前缀判据，渲染层 / 源码键位 / 扩展包三处同源（见 §5） |

## §2 证据与复现脚本（真 CDP 键鼠 + 截图 + read_image 真看）

| 脚本 | 量什么 | 备注 |
|---|---|---|
| `probe-quote-math-table.mjs` | 引用区公式（cases/align/array、单行/跨行、1–2 层引用、带缩进）+ 表格渲染 | 改前：字面管道行 4、表格 widget 0；改后：0 / 5 |
| `probe-caret-in-quote-math.mjs` | 光标在块公式内时的可见文本（"源码 + 套框"的成因对照） | 确认"源码态"是 F7 既有契约（浮动预览在下、正文显源码） |
| `probe-quote-selection.mjs` | 选中整段引用后的原生高亮盒集合 | 改前实测：竖条 x=60、高亮从 **73.1** 起 ⇒ **13.1px 空档** |
| `probe-quote-selection2.mjs` | 高亮口径 A/B/C/D 四条判据 + 光标入行显源码回归 | 改后：零宽盒 5 个、高亮起点不晚于文字列 |
| `probe-quote-sel-pixels.mjs` | **像素级**对照（自写 PNG 解码） | 改前：变色最左端 x=197、引用框左缘 182.9（差 14.1px）；改后框左缘=文字列，差 ≈1px |
| `probe-zoom-mech.mjs` | CSS `zoom` 对 CM6 高度图/命中测试的影响（三档 × 逐行↓ + 真点） | 1 / 1.25 / 1.5 三档：连按 ↓ 逐行落 5,6,7,8、视觉间距自洽 ⇒ **高度图不失真** |
| `probe-zoom-measure.mjs` | `zoom` 的测量语义 | 被缩放元素自身 rect 仍读未缩放值；`width:100%` 按未缩放父盒解析 ⇒ 版心要除以缩放 |
| `probe-v304-accept.mjs` | 引用表对齐/竖条、版心、岛解耦、状态栏 | 见 §6 读数 |
| `probe-v304-accept2.mjs` | 引用表格内编辑、覆盖层贴合、复制表格、状态栏数字口 | 覆盖层 Δ=(0,0,0,0)；TSV `名称\t数值\n甲 丙\t1\n乙\t2` |
| `probe-statusbar-perf.mjs` | 状态栏的**每键 DOM 写入** | 见 §7 |
| `verify-v304-exe.cjs` | 装机端到端 13 项（走 app-slot 锁） | 全绿，截图在 `shots-exe\` |

## §3 机制实验：CSS `zoom` 能不能用（结论：能，且是唯一满足"岛解耦"的做法）

`zoom` 的实测语义（`probe-zoom-measure.mjs`，产品真页里注入）：

| 观测 | 读数 | 对实现的意义 |
|---|---|---|
| 被缩放元素（`.cm-editor`）自身 rect | `1400×900` **不随 zoom 变** | CM6 的高度图/命中测试坐标自洽（`probe-zoom-mech` 三档逐行↓全对） |
| 缩放盒**外**的 fixed 元素（工具栏） | rect 完全不变（1013×32） | 岛与缩放**天生解耦**，不需要任何补偿 |
| 缩放盒上 `width:100%` 的子元素 | 视觉宽 = 父盒宽 × zoom | 版心与缩放叠加时必须"除以 zoom" |
| 直接给工具栏 `zoom:1.5` | `computedStyle.height` 56.33、`rect.height` 84.5（= ×1.5） | 岛自己缩放的视觉高度靠 rect 量（`toolbar.js` 已有），正文 padding 自动跟上 |
| `.cm-content` 的 max-width | 文档坐标；视觉 = 值 × zoom | 版心写成 `视觉宽度 ÷ zoom` |

**没选 v2.3.3 的 `font-size`+`em` 路线**：那需要把表格 padding、KaTeX 字号、行高全部改成相对单位，改动面覆盖整个版式系统；`zoom` 只动一行 CSS，且实测高度图/命中/文字换行都不失真。

## §4 ③ 引用区块公式：`scanMathSpans` 的"单 `$` 同**行**闭合"

改前逻辑（3.0.3 引入）：

```js
const first = qText.slice(lead + 1);
if (first.endsWith("$") && first.length > 1) { …同一行闭合… }   // ← 永远不成立
openSingle = { parts: [first] };                                  // ← 一律当"跨行开口"
```

`first` 是 `\begin{…}` 开头，**永远不可能** `endsWith("$")` ⇒ 单行形态必然被当成"跨行开口"，
只能等下一行用行尾 `$` 闭合；下一行若没有 `$`（单行形态本来就没有）⇒ 这个 span 永远闭不上。

改为：取 `body.lastIndexOf("$")`，`> 0` 即"同一行闭合"，`span.to` 落在 `$` 之内
（**修掉了改前那个"`to: line.to` 连闭合 `$` 一起吞进 tex"的隐患**）。

**同族形态覆盖（判据全部为绿，见 §6）**：`cases` / `align` / `aligned` / `array`；
单行与跨行；1 层与 2 层引用（`>> `、`> > `）；`>     $` 这类缩进形态。

> **未闭合的疑点（如实记账）**：用户给的截图症状（整段源码 + 套框）在本机**无法复现**：
> 用 `>> $\begin{cases}…\end{cases}$` 原样复刻，改前引擎就已经渲染成块级公式（`probe-quote-math-table` 改前基线）。
> 本轮按"把单行闭合这条路径修硬"处理；若用户手上那份原文另有形态（例如 `$$` 围栏、`>` 后无空格、
> 行尾有零宽字符），需要用户给出可复现原文才能定点。

## §5 ⑤ 引用区表格：三处判据同源 + 四个坑

**同源改造**：`tables.js` 新增并导出 `tableLead(t) / withTableLead(q, body)`；
`main.js`（渲染层 `scanTables`/`cellRangesOf`/`TableRowWidget`）与 `extras.js`（`tableAt`/`splitRow`/`colIdx`/`anchorPosInCell`/`rewriteTable`）全部改为消费它。
`tableBlockOf`（源码键位）也加了"同引用前缀才同表"。

**踩到并修掉的四个坑**：

1. **`parseTableRow` 的贪婪/懒惰混搭**（原有正则 `^(\s*)(\|)?(.*?)(\|)?\s*$`）：
   `(.*?)` 懒惰 + 末尾 `(\|)?` 可选 ⇒ 引擎一路吃到**最后一个**管道，`| a | b |` 被切成 `['>','a','b']`
   —— 引用区表格**首列印着 `>`**（截图实锤）。改为与 `cellRangesOf` 同构的显式剥管道。
2. **收块上界丢失**：重写后一度让"没有管道的普通行"也能成行 ⇒ 表格把后面的 `尾段。` 吃进来
   （`cellmap` 探针 6 格异常、末行 dataset 变成表外行号）。加回"必须有**裸**管道"守卫（`/(?<!\\)\|/`）。
3. **首格区间从 0 起算**：`> | a | b |` 的第 0 格会拿到 `> `。`cellRangesOf` 内部先剥前缀（且**只剥一次**：
   调用方早先各自又传了一遍 skip，叠加后首格跑出 `>`——实测抓到）。
4. **行内零宽 replace vs 引用框**：引用行的 `>` 前缀原先是 `Decoration.replace({})`（零宽 replace），
   浏览器给选区画盒时会跳过它 ⇒ 整段选中时高亮"缺开头一块"。改成 `QuoteMarkWidget`（零宽 inline-block）。

**观感补齐**：widget 是整行块级替换 ⇒ `.mp-line.mp-quote` 的行类对它无效，竖条与缩进必须在 widget 内画。
最终对齐公式（两处 `ch` 同字号可约掉）：

```
引用文字左缘 = wrap左缘 + 3(竖条) + .8em + qLead_ch
表首列文字左缘 = wrap左缘 + 3(竖条) + wrapPad + 1(表格外框) + 16(单元格 padding) + qLead_ch
⇒ wrapPad = .8em − 16px = .8em − (单元格 padding 16 + 外框 1)
```

实测：`wrap.x = 205`、`table.x = 208`、引用文字 `textX = 208`（1400 宽视口 / 版心 74%）。

## §6 ④ 引用区选中高亮：口径与读数

**口径（本轮拍板）**：
1. **选区覆盖整段引用**：引用框（竖条 + 底色）与正文列**左缘对齐**，选中时高亮从框左端起连续覆盖到行尾；
2. **隐藏 `>` 不再占宽**：改为零宽 widget，DOM 里存在（选区盒因此连续）但不占像素；
3. **竖条在选中态保持不变色**：`--mp-quoteBar` 与引用底色都不随选中变色 —— 换来的是
   "整段引用被选中时看起来仍是一整块"，与用户"整段被选中"的直觉一致；
4. **光标入引用行仍显源码**（F7 既有契约，不能被本轮破坏）——判据 C 复验通过。

| 读数 | 改前 | 改后 |
|---|---|---|
| 引用框左缘 / 正文列左缘 | 182.9 / 182.9（框比文字列宽 10.08px） | 191.9 / 191.9（含 24px 留白公式，两者同缘） |
| 原生高亮最左端 | 196（文字列） | 191.9（框左缘） |
| 引用文字 textX | 196 | 196（**逐像素不变**） |
| 隐藏标记占宽 | 8.1px（8.1→0 的高亮断口） | 0（零宽盒） |
| 像素对照：框左端到变色点 | 14.1px 空档 | 0（同缘）/ 高亮与框逐像素对齐 |

## §7 ② 状态栏：性能口径与实测

**架构**（与"行内标记/表格投影"同一纪律）：数据源只有 **文档长度** 与 **选区主位置** 两个数，
`update()` 里先做 O(1) 相等判断，不等才在 **rAF 合并后**更新；
DOM 侧用 `setText()` 直接改**已存在文本节点的 `nodeValue`**（原地写）。

> **为什么不是 `el.textContent = s`**：它的实现是**删旧文本节点 + 建新文本节点**，
> 每次都是 childList 变动 + 一次分配。探针第一次跑出来 `childList=6/6/9/21`，就是它。

| 场景（真 CDP 键鼠） | childList 变动 | characterData | 读数 |
|---|---|---|---|
| 20 次 ↓ 移动光标 | **0** | 3 | 行 25/44 ✓（读数确实在动） |
| 连续键入 20 字符 | **0** | 8 | 806→826 字 ✓ |
| Shift+→ 12 次 | **0** | 4 | 选中 12 字 ✓ |
| 鼠标拖拽选区 | **0** | — | 选中 18 字 ✓ |

**输入口**：右下角百分比 → 点击展开数字框（`is-editing` 态）→ 输入 → **回车生效** / Esc 还原；
与设置面板滑杆、`Ctrl+=/-/0`、`Ctrl+滚轮` 共用同一个 setter（单一真值源 `mp-pref-zoom`）。

## §8 ① 版心宽度：口径与兼容

- 设置滑杆 `pageWidth`（40–100%，默认 74%）＝**窗口宽 × 百分比**的视觉正文宽；
- 实现：`--mp-page-width = round(窗口宽 × 百分比 ÷ zoom)`；CSS `max-width: min(var(--mp-page-width), max(1240px, 100% − 320px))`；
- **文字列随之变窄**（用户诉求"一行字太多"的直接解法）；
- 左右 padding 各 24px：左 24px 同时是**引用框的落位留白**（见 §6），右 24px 保持对称。

## §9 回归（既有套件，全部对本轮头跑）

| 套件 | 结果 | 备注 |
|---|---|---|
| `mathquote\probe-mathquote.mjs` | ✓ KaTeX 3 / 字面 TeX 0 | 引用区跨行数学块 |
| `mathquote\probe-indent.mjs` | ✓ 缩进形态仍渲染 | |
| `cellmap\probe-cellclick3.mjs` | ✓ 全部正确（幻影格 2） | 30 格逐格真点 |
| `cellmap\probe-cellclick2.mjs` | 28/30 全对（2 个是参差行的既有形态） | |
| `island\island-fold.cjs` | ✓ 全部通过（J3–J9） | 岛折叠/持久化/高度联动 |
| `export-table\probe-table.cjs` | `base 全绿 = true`（20 红全在它自己的 mut 臂） | |
| `exporttypo\typo-parity.cjs` | ✓ 全部通过 | **P3b 期望值按新版心更新**（见下） |
| `print\print-layer.cjs` | ✓ 全部通过 | |
| `exportux\export-ux.cjs` | ✓ 全部通过 | 设置面板多了一节仍能开 |

**P3b 口径更新（`.mp-verify\exporttypo\typo-parity.cjs`）**：该判据原先写死
"编辑面 padding == `max(46, (视口−1280)/2)`（1600 视口下 160px）"。本轮把"靠大 padding 收窄"的旧版心形态
换成"固定 24px 呼吸位 + `max-width` 收窄"⇒ padding 期望值改为 24，**等式结构不变**
（文字列宽 == 盒宽 − 两侧 padding；导出件内宽 == max-width − 2×padding，仍为 1224）。
读数：`1184 − 24 − 24 = 1136`（实测 1136）。

## §10 装机端到端（3.0.4 portable EXE，`verify-v304-exe.cjs`，走 app-slot 锁）

**结果：13/13 全绿**（`exe-verify.json` + `shots-exe\`）：

| # | 判据 | 实测 |
|---|---|---|
| S1a | 引用区表格渲染成行 widget | `rowWidgets=3`（表头 + 2 数据行；分隔行含在表头 widget 内） |
| S1b | 无字面管道源码行 | `litPipe=0` |
| S1c | 引用竖条/缩进（`mp-table-quote`） | 3 个 wrap 全带 |
| S1d | 表格左缘 ≈ 引用文字左缘 | 170.5 vs 173.2（Δ=2.7px，含 3px 竖条） |
| S2a/S2b | 引用区单行 cases 渲染、无字面 TeX | `katex-display=1` / `litTex=0` |
| S5a | 底部状态栏（贴底、高 24） | `y=733 h=24` |
| S3 | 页面宽度 58% ⇒ 正文可见变窄 | 863 → 676px |
| S4 | 缩放 150%：正文行盒变大、**岛 rect 不变** | 48.7 → 73.3；岛 1012×31 → 1012×31 |
| S5b | 数字口键入 130 + 回车生效 | 编辑态获焦、`prefs.zoom=130`、badge `130%`、`editorZoom=1.3` |
| S6 | 行/列读数随光标更新 | `行 4/14` |
| S7 | 缩放持久化（重开同 profile） | 仍 130% |
| S8 | 重开后引用区表格 + 公式仍渲染 | 3 / 1 / 0 / 0 |

**截图**（`shots-exe\`）：`exe-1-base.png`（引用区表格 + 竖条 + 块公式 + 状态栏）、
`exe-3-zoom150.png`（150% 内容缩放，岛与状态栏纹丝不动）、`exe-4-statusbar-130.png`、`exe-5-reopen.png`。

## §11 发布件（`MarkPilot-CM6\dist\`，`dist-fresh.cjs` 8 闸全绿）

| 文件 | 字节 | sha256_16 |
|---|---|---|
| `markpilot-cm6-3.0.4-portable.exe` | 82,700,825 | `2d15b5fcd0e7fb58` |
| `markpilot-cm6-Setup-3.0.4.exe` | 82,959,558 | `f3922ffa16adcd40` |

**引擎**：`renderer-cm6\app.js` 1,141,991 B / `6e79567a1ca3a3a5`
（源码构建 == `MarkPilot-CM6\renderer\cm6\app.js` == asar 内 == 两个 EXE 载荷内，四处逐字节相同）。
`package.json` 版本 → `3.0.4`；asar `97922a620a533db9`。

## §12 未验证 / 未做（如实记账）

1. **用户那条"引用区单行 cases 渲染成源码"的截图未能在本机复现**（改前引擎就已经渲染）：
   本轮修的是"单 `$` 同行闭合"这条确定性缺陷（改前逻辑上必然不闭合）；若原文另有形态，需要可复现原文。
2. **仅暗色主题**：亮色主题下新元素（状态栏、引用表格底纹）的对比度未量。
3. **`zoom` 与双开分屏的组合未端到端验**：`splitview.js` 的 `zoomScale()` 读 `devicePixelRatio`，
   本轮没动它；分屏 + 内容缩放的几何只在代码层确认"各算各的"，没有装机读数。
4. **`Ctrl+滚轮` 缩放未在探针里覆盖**（代码路径与快捷键共用同一 setter；仅代码层确认）。
5. **引用区表格 + 单元格内编辑的"点格落点"仍是比例近似**（与 3.0.3 同一算法，未在本轮重新定量）。
6. **导出 HTML/PDF 对引用区表格的端到端**只验到"复制表格"通道 + `export-table/exporttypo/print` 三套既有套件；
   引用区表格**专门**的导出夹具未单独写。
7. **`alt/插入符` 类无障碍**：状态栏加了 `aria-label`，未做读屏实测。
8. **性能闸门（`e3\run-gates-3.0.1.ps1`）本轮未跑**：`LOG-3.0.2` §7 已记该尺在本机噪声 > 5% 判限。

## §13 复现命令

```powershell
# 引擎重建 + 同步（改 src-cm6 后必做）
cd E:\MarkPilot\dsh-markpilot
node node_modules/esbuild/bin/esbuild src-cm6/main.js --bundle --format=iife --outdir=renderer-cm6 `
  --entry-names=app --asset-names=fonts/[name]-[hash] --loader:.woff=file --loader:.woff2=file --loader:.ttf=file --minify
cd E:\MarkPilot\MarkPilot-CM6; node scripts/sync-engine.mjs

# 本轮判据（全部只写 .mp-verify\v304\）
node E:\MarkPilot\.mp-verify\v304\probe-quote-math-table.mjs
node E:\MarkPilot\.mp-verify\v304\probe-caret-in-quote-math.mjs
node E:\MarkPilot\.mp-verify\v304\probe-quote-selection.mjs
node E:\MarkPilot\.mp-verify\v304\probe-quote-selection2.mjs
node E:\MarkPilot\.mp-verify\v304\probe-quote-sel-pixels.mjs
node E:\MarkPilot\.mp-verify\v304\probe-zoom-mech.mjs
node E:\MarkPilot\.mp-verify\v304\probe-zoom-measure.mjs
node E:\MarkPilot\.mp-verify\v304\probe-v304-accept.mjs
node E:\MarkPilot\.mp-verify\v304\probe-v304-accept2.mjs
node E:\MarkPilot\.mp-verify\v304\probe-statusbar-perf.mjs

# 既有套件回归
node E:\MarkPilot\.mp-verify\mathquote\probe-mathquote.mjs
node E:\MarkPilot\.mp-verify\mathquote\probe-indent.mjs
node E:\MarkPilot\.mp-verify\cellmap\probe-cellclick3.mjs
node E:\MarkPilot\.mp-verify\island\island-fold.cjs
node E:\MarkPilot\.mp-verify\exporttypo\typo-parity.cjs
node E:\MarkPilot\.mp-verify\print\print-layer.cjs
node E:\MarkPilot\.mp-verify\exportux\export-ux.cjs

# 装机端到端（必须走 app-slot 锁）
node E:\MarkPilot\Typora-Editor-App\scripts\acceptance\app-slot.cjs -- node E:\MarkPilot\.mp-verify\v304\verify-v304-exe.cjs
# 残留进程清理（只杀命令行带 v304 profile 的）
node E:\MarkPilot\.mp-verify\v304\kill-stale.cjs

# 出包（8 闸）
cd E:\MarkPilot\MarkPilot-CM6; node scripts/dist-fresh.cjs
```
