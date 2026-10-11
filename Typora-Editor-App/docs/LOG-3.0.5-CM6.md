# LOG 3.0.5（CM6 引擎 · 引用区表格回归修复 + 工具栏改版）——内部记录

> 面向用户的说明见 `RELEASE-3.0.5-CM6.md`。上一版记录：`LOG-3.0.4-CM6.md`。
> 本轮来源：Lead 转来用户对 3.0.4 装机版的回归反馈（引用区表格列宽/格内公式）+ 四项工具栏改版要求。
> 全部取证脚本在 `.mp-verify\v305\`。

## §1 范围（六项）

| 项 | 内容 | 结果 |
|---|---|---|
| ① | 引用区表格**第一列被压成一字宽** | 修（列宽按显示宽度 + 下限） |
| ② | 引用区表格**格内行内公式不渲染** | 修（格内容数学扫描器重写）+ ③ 一并解释用户实际原文的根因 |
| ③ | `| —— |` 手写分隔行 ⇒ 整段裸源码（**用户原文真实根因**） | 修（分隔行认 en/em dash） |
| ④ | 「更多」挪到工具栏**最右** | 已改（折叠按钮之前） |
| ⑤ | 「界面透明度」收进「更多」菜单（内联滑杆 + 数字口） | 已改 |
| ⑥ | 「阅读调色盘」收进「更多」菜单（内联三档 + 进入/退出） | 已改（并修了阅读态下菜单被一起隐藏的缺陷） |
| ⑦ | 「双开」与「阅读模式」图标太像 | 已重画；「明暗切换」换太阳/月亮二态并挪到主题旁 |

## §2 ①③ 现象 → 根因 → 改法（引用区表格）

### 2.1 用户原文的真实根因是分隔行（③）

用户给的原文里分隔行是 **`| —— | —— | —— |`**（U+2014 em dash ×2），而三处"分隔行判据"都是
`/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/` —— 字符类里只有 **ASCII 连字符**。
⇒ 该行不算分隔行 ⇒ 表头行与数据行都不成表 ⇒ **整个引用区表格退化成字面源码**
（本机用原文形态复现到同一画面：`.mp-verify\v305\A-user-emdash.png`，改前 0 个表格 widget、4 行裸管道）。

**改法**：`tables.js` 新增 `SEPARATOR_BODY_RE` / `isSeparatorBody()`（短横含 `-`、`–`(U+2013)、`—`(U+2014)），
渲染层 `scanTables`、源码键位 `tableBlockOf`、扩展包 `tableAt` 三处统一消费。
放宽方向与既有 A4c 口径一致（多认一种分隔行只会让"本来就是表"的东西渲染成表）。

### 2.2 列宽：按**显示宽度**分配，不再数源码字符（①）

改前 `weights[c] = max(表头与各行的**源码字符串长度**)`。`$v_t=P\,v_{t+1}$` 有 15 个源码字符，
渲染出来只有 9 个拉丁字宽；引用区表格里这类格子扎堆时，中文列被挤到 **89px**
（实测：`colgroup = ["9%","40%","51%"]`，首列 89px、**行高 67px**＝"名称"竖排成两行）。

**改法**（`tables.js` + `main.js`）：
1. `displayWidth(s)`：先剥掉不显示的字形（`$`、反引号、`**`、链接 URL），CJK/全角算 2 个单位宽；
2. `fitWidths(weights, minPercent)`：按显示宽度比例分配，再把**每列下限**摊回去（从宽列扣）；
3. `TableRowWidget` 首帧先落静态比例，挂载后按**实测表宽**现算一次下限（`requestAnimationFrame`，
   不在每键路径上；只在表格行 widget 重建时跑）。

**读数**（1400 视口 / 版心 74%）：

| | 改前 | 改后 |
|---|---|---|
| colgroup | 9% / 40% / 51% | **21.1% / 36.8% / 42.1%** |
| 首列宽 | 89px | **208px** |
| 首列可用文本宽 | 89−16−17≈56px（容纳 2.7 个中文字） | 176px |
| 行高 | 67px（"名称"竖排两行） | **42px（单行）** |
| 900px 窗 | 首列 57px（3 字竖排） | 130px（单行） |
| 700px 窗 | 40px | 98px（单行） |

### 2.3 格内行内公式（②）：扫描器换掉 + 口径说明

改前 `cellHTML` 用 `/\\$([^$\\n]+)\\$/g` 一条正则，三个已知漏点：
转义 `\$` 会被当定界符、**格内多行**永不匹配（`[^$\n]` 排掉换行）、**未闭合的 `$`** 会把后面内容一起吃掉。

**改法**：换一次线性扫描（`cellHTML`），支持 `\$` 转义、定界符内允许换行；
**未闭合或 KaTeX 报错时原样输出字面**（宁可显示源码也不吞掉后面的内容）。

**口径纠正（重要，避免误报）**：用户原文里 `KB: $\partial_t w$` 在本机**改前就已经渲染**
（`probe-quoted-table-regress.mjs` 的 B/C 臂：`katex=1`、无字面 `$`）。
用户看到的"字面源码"来自 **③ 那条分隔行**——整张表都没成表，四行一起显示源码，
所以"部分格子像是渲染了、部分没有"其实是"引用区的行内公式扫描照样工作、而表格文本全在源码态"。
本轮把这条写进判据：**格内公式按源码区间（dataset from/to）数**，
而不是数渲染后的 DOM（KaTeX 渲染后 `$` 本就没了，用 DOM 数会恒为 0——我第一版判据就踩了这个坑）。

### 2.4 顺带修掉的一个真缺陷：`> | a | b |` 的前缀把表头管道吃掉了

`tableLead` 原正则 `/^([ \t]*(?:>[ \t]?)+)/` 对 `> | a | b |` 会匹配 `"> | "`（4 字符）
——把**表头行首那根管道**也算进引用前缀 ⇒ 首格区间整体左移一位、首格凭空多出 `>`。

**改法**：`tableLead` 改为 `/^[ \t]*>+(?:[ \t]+>+)*[ \t]?/`（前缀只吃 `>` 与它们之间的空白，不吃 `|`）。
判据 R7：`>|甲|乙|` 与 `> | 甲 | 乙 |` 都必须得到 `甲/乙` 两格、无多格。

## §3 ④⑤⑥⑦ 工具栏改版

### 3.1 槽位顺序（改后，实测 DOM 顺序）

```
大纲 │ 主题 │ 明暗切换 │ Emoji │ H │ B │ I │ S │ 查找 │ 链接 │
列表 │ 有序 │ 任务 │ 减进 │ 加进 │ 引用 │ 分割线 │ 代码块 │ 行内码 │ 前插行 │ 后插行 │
图片 │ 表格 │ 撤销 │ 重做 │ 全屏 │ 双开 │ 阅读模式 │ 导出 │ 重新加载 │ **更多** │ 折叠
```

- 「更多」从**第 2 位**挪到**折叠按钮之前**（展开态里最右的可点项）；
  折叠按钮仍在它右侧 ⇒ 收起后的小圆岛依旧贴右（`island-fold` J3 判据仍绿）。
- 「界面透明度」「阅读调色盘」两个独立按钮**删除**（`ITEMS` 与 `EXTRAS_IDS` 同步移除，
  避免"已实现集合"与实际槽位对不上）。
- 「明暗切换」插到「主题」正后方（实测 `theme-settings.right=287`、`theme-toggle.x=288` → 间距 1px＝岛上标准间距）。

### 3.2 「更多」菜单内联两件事

| 内联块 | 控件 | 生效路径 | 持久化 |
|---|---|---|---|
| 界面透明度 | 滑杆（0–100）+ 数字口 + 当前值 | 滑杆 `input` 即时；数字口**回车**生效、Esc 还原、失焦提交 | `mp-surfaces`（与「设置」面板同源） |
| 阅读模式 | 三档配色（当前档带「当前」标记）+ 进入/退出 | 点档即切；未进阅读态会自动进入 | `mp-reading-palette` / `mp-reading` |

**拍板口径**：滑杆与数字口都写**全部三个表面组件**（工具岛/公式框/大纲）的 alpha，
使"一个值、一处显示"成立；逐项微调仍在「设置」里（菜单里给了提示文案）。

### 3.3 顺带修掉两个真缺陷

1. **阅读态下菜单被一起隐藏**：`[data-mp-reading="1"] .mp-pop { display:none !important }` 把菜单也藏了
   ⇒ 阅读模式里点「更多」是**空的一下**（pop 的 rect 全 0，实测 `popRect=[0,0,0,0]`）。
   改法：只放行「更多」这一只（`.mp-pop-keep`），其余浮层照旧隐藏。
   判据 T12 的三档切换里最后一次切档发生在阅读态内 —— 改前直接卡死。
2. **锚点不可见时菜单跑到屏幕外**：阅读态工具栏 `display:none`，锚点 rect 全 0。
   `openPop` 改为"锚点不可见就退视口右上角"，并在建完后按实际高度**夹回视口内**。

### 3.4 图标重画（⑦）

| 按钮 | 改前 | 改后 | 剪影差异 |
|---|---|---|---|
| 双开 | 方框 + 中竖线 | **两个方正面板 + 中缝** | 方、直边、上下顶满 |
| 阅读模式 | 两块镜像"书页"（与双开几乎同形） | **一本打开的书**（宽扁、外缘斜边、中间书脊） | 扁宽 + 斜边 + 书脊 |
| 明暗切换 | 半圆"D"（左实右空） | **太阳 / 月亮二态**（跟随 `html[data-mode]`，MutationObserver 自动换） | 放射线 vs 月牙 |

「为什么用户不会认错」：**双开是"方框被一条缝切成两栏"、阅读模式是"一张展开的书页"**
——外轮廓一个是近似正方形（16×14，直边顶满）、一个是宽扁形（14.4×11.2，两侧斜边收进去），
中心结构一个是"一条贯通的竖缝"、一个是"书脊 + 两道页缘线"；缩小到 24px 时轮廓差异仍然成立，
不依赖颜色（`currentColor` + 1.7 线宽与岛上其它图标同源）。

主题图标跟随用的是**主题应用的单一真源回显**（`html[data-mode]` / `data-editor-theme`），
而不是"点击时自己翻转"——因为主题的唯一写者是 `window.mpTheme`，工具栏不是写者。

## §4 判据与读数

### 4.1 引用区表格（`.mp-verify\v305\probe-v305-judge.mjs`，11 项全绿）

| # | 判据 | 读数 |
|---|---|---|
| R1 | 引用区表格渲染成行 widget（em dash 分隔行也认） | widgets 3、字面管道行 0 |
| R2a | 首列可容纳最长单元格文本（不竖排） | 可用 176px ≥ 需要 28px |
| R2b | 各行为单行高度 | rows [42]、行高 25.2 |
| R3 | 引用区 vs 非引用区同内容表列宽一致（Δ≤1%） | 21.1/36.8/42.1 == 21.1/36.8/42.1 |
| R4a | 格内行内公式全部渲染 | 4 个含公式格：`$`2 → `katex`1 各自成立 |
| R4b | 格内无字面 `$` 残留 | 文本为 `vt=Pvt+1`、`KB: ∂tw` 等 |
| R4c | 引用区块公式仍渲染 | katex-display 1 |
| R5-900 / R5-700 | 窄窗口下首列仍可容纳文本且单行 | 130px / 98px，rows [42] |
| R6 | 点格 → 覆盖层贴合且文本 == 该格源码 | Δ(0,0,0,0)、文本「有限状态」 |
| R7 | `>|甲|乙|` 首格为空、格数 2 | cells = [甲, 乙] |

### 4.2 工具栏（`.mp-verify\v305\probe-toolbar-judge.mjs`，20 项全绿）

| # | 判据 | 读数 |
|---|---|---|
| T1/T2 | 不再有「界面透明度」「阅读调色盘」独立按钮 | 两者都 false；按钮数 32 |
| T3 | 明暗切换紧跟主题 | themeIdx 1 → toggleIdx 2 |
| T4 | 「更多」是折叠前一位（最右可点项） | more.right 1140、fold.x 1141 |
| T4c | 窄到换行时仍在**最后一行**最右 | 900px：末行 [document-export, reload, more, toolbar-fold] |
| T5 | 明暗图标是太阳/月亮二态 | 深色态 `data-mp-dark-now=1`、标题「切换到浅色模式（当前：深色）」 |
| T6 | 无按钮被裁切 | clipped [] |
| T7 | 菜单内联界面透明度（滑杆 + 数字口 + 当前值） | range/num 65、标签 65% |
| T8 | 菜单内联阅读模式三档 + 当前态 | 三档齐全、「跟随主题 · 当前」 |
| T9 | 数字口 65 + 回车生效并持久化 | `mp-surfaces` 三个组件 alpha 均 65、`--mp-surface-alpha=0.65` |
| T10 | 菜单再次打开显示新值 | num/range 65、标签 65% |
| T11 | 两个端点 0% / 100% 都生效 | `0.00` / `1.00` |
| T12 | 三档配色都能切换且持久化 | beige `#f4efdf` → green `#e5eee2` → theme `#1f2126`（**最后一次在阅读态内完成**） |
| T13 | 阅读态工具栏按既有口径隐藏 | display none |
| T14 | 退出阅读模式还原主题配色 | `--mp-bg=#1f2126` |
| T15×3 | 岛缩放 80%/140% + 窄窗 900：不裁不糊、更多仍在折叠前 | 三档 clipped [] |
| T16 | 点明暗切换：主题真变 + 图标跟着换 | dark→light、sun→moon、`#1f2126`→`#ffffff` |

**截图**（`.mp-verify\v305\`）：`A-user-emdash.png`（改前：整段裸源码）、
`final-user-doc.png` + `final-user-table-zoom.png`（改后：表格 + 三列正常 + 公式渲染）、
`final-user-narrow-1000.png`、`toolbar-after.png`、`toolbar-more-menu.png`、
`icons-left-zoom.png`（大纲/主题/明暗/表情）、`icons-right-zoom.png`（双开/阅读/导出/重新加载/更多/折叠）、
`icons-split-vs-reading.png`、`theme-toggle-dark.png` / `theme-toggle-light.png`、
`judge-narrow-900.png` / `judge-narrow-700.png`、`toolbar-island80-1400.png` / `toolbar-island140-1400.png`。

## §5 回归（既有套件，全部对本轮头跑）

| 套件 | 结果 |
|---|---|
| `cellmap\probe-cellclick3.mjs` | ✓ 全部正确（幻影格 2） |
| `island\island-fold.cjs` | ✓ 全部通过（J3–J9；展开宽 959＝改版后新宽度） |
| `mathquote\probe-mathquote.mjs` / `probe-indent.mjs` | ✓ 均通过 |
| `exporttypo\typo-parity.cjs` | ✓ 全部通过 |
| `export-table\scripts\probe-table.cjs` | `base 全绿=true`（20 红全在它自己的 mut 臂） |
| `print\print-layer.cjs` | ✓ 全部通过 |
| `.mp-verify\v304\probe-v304-accept*.mjs`、`probe-statusbar-perf.mjs`、`probe-quote-selection2.mjs` | 见 §6（3.0.5 头复跑） |

## §6 装机端到端（3.0.5 portable EXE，`verify-v305-exe.cjs`，走 app-slot 锁）

**结果：16/16 全绿**（`exe-verify.json` + `shots-exe\`）：

| # | 判据 | 实测 |
|---|---|---|
| S1a | 引用区表格渲染成行 widget（em dash 分隔行） | `rowWidgets=3` |
| S1b | 引用区无字面管道源码行 | `litPipe=0` |
| S2a | 首列可容纳最长单元格文本 | 列宽 21.1% → 171px、可用 139px ≥ 需要 56px |
| S2b | 各行为单行高 | rows [42] |
| S3 | 格内行内公式全部渲染 | 4 个格 `$`2 → `katex`1；`litTex=0` |
| S4a | 不再有「界面透明度」「阅读调色盘」按钮 | 都 false，按钮数 32 |
| S4b | 「更多」在折叠前一位（最右可点项） | 末三项 `reload / more / toolbar-fold`；more.right 1023、fold.x 1024 |
| S5a | 明暗切换紧跟「主题」 | theme.right 170 → toggle.x 171 |
| S5b | 图标二态与主题态一致 | mode=dark / toggleMode=1 / 标题「切换到浅色模式（当前：深色）」 |
| S5c | 点它：模式变了且图标换 | dark→light、太阳路径→月亮路径 |
| S6a/S6b | 菜单内联：滑杆+数字口（65）、阅读三档（含「当前」） | 见读数 |
| S6c | 数字口 55 + 回车生效并持久化 | `--mp-surface-alpha=0.55`、三组件 alpha=55 |
| S7a | 重开后不透明度保持 55% | surfaces.toolbar.alpha=55 |
| S7b | 重开后引用区表格与公式仍渲染 | 3 / 4 / 0 / 0 |

**截图**（`shots-exe\`）：`exe-1-base.png`（用户原文形态：表格三列正常 + 三条竖线 + 公式渲染）、
`exe-2-more-menu.png`（菜单内联不透明度滑杆 65% + 数字口 + 阅读三档 + 当前标记）、
`exe-3-alpha55.png`、`exe-4-reopen.png`。

## §7 发布件（`MarkPilot-CM6\dist\`，`dist-fresh.cjs` 8 闸全绿）

| 文件 | 字节 | sha256_16 |
|---|---|---|
| `markpilot-cm6-3.0.5-portable.exe` | 82,702,904 | `2e0e16a6d7e5dca3` |
| `markpilot-cm6-Setup-3.0.5.exe` | 82,961,683 | `b8d30c3cde030672` |

**引擎**：`renderer-cm6\app.js` 1,150,027 B / `9584b89780a9d7ce`
（源码构建 == `MarkPilot-CM6\renderer\cm6\app.js` == asar 内 == 两个 EXE 载荷内，四处逐字节相同）；
asar `412fcd8352acda87`；`package.json` 版本 → `3.0.5`；`dist-fresh.log` 在 `.mp-verify\v305\`。

> 出包前的最后一次引擎改动：**引用块的左右轴**（`margin-left: var(--mp-q-inset)`）——
> 改前引用行比正文列左移了 10.08px（`-(inset+.8em)` 那版），引用框与选中高亮会凸出正文列一截；
> 现在竖条左缘 = 正文文字列左缘（实测 201 = 201），文字位置逐像素不变。
> 这是 §4 之外的补修，已在 20 项 toolbar judge + 11 项 table judge + 16 项装机判据下复跑。

## §8 未验证 / 未做（如实记账）

1. **用户截图里"格内公式显字面源码"未逐字复现**：本机改前引擎在**标准 `---` 分隔行**下就能渲染这些格子；
   已定位到用户原文的分隔行是 em dash（③），并据此复现了**整段源码**的同一画面。
   若用户看到的确实是"同一张已渲染的表里只有带文字的格子不渲染"，需要那份原文的**逐字**副本。
2. **仅暗色主题**：亮色主题下新图标（太阳/月亮）与菜单内联控件的对比度未逐项量（T16 只验了切换与配色值）。
3. **滑杆"拖动"只验了 `input` 事件路径**（端点 0/100 与 65），没有做真实鼠标按住拖动的轨迹测试。
4. **`> |` 前缀改动对"引用前缀含制表符/多级 `> >`"的组合**只在代码层推导，未逐形态写夹具。
5. **菜单高度**：三项内联后菜单高 554px（1400×900 视口），未在 600px 高的窗口下量滚动行为
   （`openPop` 已做"越界整体上移 + `.mp-pop` 自身 `max-height:60vh; overflow:auto`"）。
6. **能量闸门 `e3\run-gates-3.0.1.ps1` 未跑**（LOG-3.0.2 §7 已记该尺本机噪声 > 5% 判限）。

## §9 复现命令

```powershell
# 引擎重建 + 同步
cd E:\MarkPilot\dsh-markpilot
node node_modules/esbuild/bin/esbuild src-cm6/main.js --bundle --format=iife --outdir=renderer-cm6 `
  --entry-names=app --asset-names=fonts/[name]-[hash] --loader:.woff=file --loader:.woff2=file --loader:.ttf=file --minify
cd E:\MarkPilot\MarkPilot-CM6; node scripts/sync-engine.mjs

# 本轮判据
node E:\MarkPilot\.mp-verify\v305\probe-quoted-table-regress.mjs   # 复现（A 臂 em dash 改前为裸源码）
node E:\MarkPilot\.mp-verify\v305\probe-v305-judge.mjs             # 11 项
node E:\MarkPilot\.mp-verify\v305\probe-toolbar-judge.mjs          # 20 项
node E:\MarkPilot\.mp-verify\v305\shots-icons.mjs                  # 图标放大截图
node E:\MarkPilot\.mp-verify\v305\shots-final.mjs                  # 用户原文成图

# 既有套件回归
node E:\MarkPilot\.mp-verify\cellmap\probe-cellclick3.mjs
node E:\MarkPilot\.mp-verify\island\island-fold.cjs
node E:\MarkPilot\.mp-verify\mathquote\probe-mathquote.mjs
node E:\MarkPilot\.mp-verify\exporttypo\typo-parity.cjs
node E:\MarkPilot\.mp-verify\export-table\scripts\probe-table.cjs
node E:\MarkPilot\.mp-verify\print\print-layer.cjs

# 装机端到端（必须走 app-slot 锁）
node E:\MarkPilot\Typora-Editor-App\scripts\acceptance\app-slot.cjs -- node E:\MarkPilot\.mp-verify\v305\verify-v305-exe.cjs
node E:\MarkPilot\.mp-verify\v304\kill-stale.cjs      # 残留进程清理（按 profile 匹配）

# 出包（8 闸）
cd E:\MarkPilot\MarkPilot-CM6; node scripts/dist-fresh.cjs
```
