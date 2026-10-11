# CM6 表格编辑方案（Excel/Word 手感）

- 对象：`dsh-markpilot` 的 **CM6 引擎**（`src-cm6/main.js` → esbuild → `renderer-cm6/app.js`）
- 证据：`.mp-verify/tbl/`（11 个探针脚本 + 41 张截图 + JSON 读数）；关联 BUG-DB `U-091 / U-092 / A-028 / A-029`
- 基线：真实 Typora（本机 `D:\Users\ltmroberthk\AppData\Local\Programs\Typora\Typora.exe`）＋ 2.x/vditor 侧既有实现（`renderer/js/media-tools.js`、`typora-patches.js`、`toolbar.js`）

---

## 0. 一句话目标

把「点格 → 弹出一块**体外文本框**（同一句话画两遍：上行原文、下行预览）」改成
「**格内就地渲染态直改**（只画一遍，源码不露出）＋ **Excel/Word 的键位与矩形剪贴板语义**」，
并修掉列宽导致的中文竖排。

---

## 1. 现状（实测，非代码推断）

### 1.1 架构落点

| 位置 | 职责 |
|---|---|
| `scanTables()` / `parseTableRow()` / `cellRangesOf()` / `cellHTML()` | 扫描表格、行内各格源码区间、格内容 HTML（**仅转义 + 行内 `$…$`**） |
| `TableRowWidget`（每源码行一个 widget） | 行级投影：`table-layout:fixed` + `<colgroup>` 比例列宽；活动格 `class=mp-cell-editing` 且 **`innerHTML=""`** |
| `tableCellClick`（mousedown） | 点格 → `setActiveCell` 效果 + `activateCellOverlay()` |
| `.mp-cell-overlay`（挂 `document.body`，`position:fixed`） | 内含 `.mp-cell-overlay-text`（contenteditable＝**原文**）＋ `.mp-cell-preview`（**渲染预览**） |
| `syncCellEdit()` | 公共前后缀 diff → 最小 change 写回 CM6 |
| `tableKeys` / overlay 内 keydown | Esc 收场、Tab/Shift+Tab 换格、Ctrl+Z、**Enter 被吞** |

### 1.2 缺陷清单（每条都有实测数值）

| # | 现象 | 实测 |
|---|---|---|
| D1 | **同一内容画两遍** | overlay 内原文与预览 Δy = **26.80 / 31.80 / 55.60px**（纯文本格 / 公式格）；被点格 `td.innerHTML === ""` |
| D2 | **点格后 CM6 光标不动** | 15 次交互 `selection.head` **恒为 0**；只有"点表格外正文"落对（1551） |
| D3 | **Enter 零反应** | 内容/行数/rect 全不变；截图与 Tab 后 **SHA256 逐字节相同** |
| D4 | **Tab 不换行** | col1→col2 有效；到本行末列再按停在原地（不越到下一行） |
| D5 | **方向键不越格**；首键前光标不可见 | DOM 选区锚在**外层 div**，caret rect **0×0**；→42/43、↑23、↓43 全在格内；`head` 恒 0 |
| D6 | **Escape 后光标仍在文档开头** | overlay 隐藏、格回渲染态（截图逐字节等于点击前），但 `head` 仍 **0** |
| D7 | **Ctrl+Z 破坏视图** | 焦点被踢出覆盖层、overlay 隐藏、**scrollTop 1405 → 21（拽回文首）**、overlay 残留文本与源码脱节 |
| D8 | **预览只认行内公式** | `**粗** *斜* [链接](…)` 预览 `innerHTML` 是**原样字符串**：`<strong>=0 <em>=0 <a>=0`；`` `code` `` → `<code>=0`；`![图](…)` → `<img>=0` |
| D9 | 转义竖线未还原 | 预览显示 `a\|b`（应为 `a|b`） |
| D10 | **超长格覆盖层无限增长** | 244 字格：overlay bottom **918.81 > 面高 831**（溢出 87.81）；同格 TD 高度 **268.88 → 117.75（−151.13）** → 整表跳动；无 `max-height`/内部滚动 |
| D11 | **列宽按字符数比例 → 中文竖排** | 首列宽 45.83px、内容宽 **13.83px < 14px（一个汉字）**；「I 概率地基」= **5 个行盒一字一行**；「II 随机过程」6 行盒 |
| D12 | 表头 `th` 也能进编辑态 | `TH.mp-cell-editing`（`innerHTML=""`） |
| D13 | 滚动/缩放 | 滚动零漂移 ✓；改窗宽 x/y/w 完全跟格 ✓，但 scrollTop 1568 → 1412（−156） |
| — | 控制台 | 8 次独立启动 **0 console error / 0 pageerror** |

---

## 2. 基线（要对齐谁）

### 2.1 真实 Typora

- 点格＝**格内就位**，其余格保持渲染；**不重复画内容**（无"原文 + 预览"两段）。
- Tab / Shift+Tab 换格（跨行）；格内软换行用 `<br>`；行结构（源码一行）不变。
- 单元格里的公式、粗体、代码、链接都是**渲染态**。

### 2.2 v2.3.3 / vditor 侧**已实现**（本次要 observational equivalence 平移到 CM6）

| 能力 | vditor 侧落点 |
|---|---|
| 矩形选区 → TSV(`text/plain`) + 只含矩形的 `<table>`(`text/html`)，应用内复制打 markdown 标记 | `media-tools.js` `tableRectangle() / rectanglePayload()` |
| 粘贴矩形：从光标格向右下铺开，**缺行补行、缺列补列**（补到每行含表头） | `pasteRectangle() / growTable()` |
| 剪切＝同一套载荷 + 清空矩形 | `media-tools.js` cut 分支 |
| 右键：上方/下方插入行、左/右插入列、删除行/列、"复制表格到 Excel"(CF_HTML) | 2.x 右键菜单（CHANGE-REPORT-1.0.15 / 1.0.16） |
| 格内 Enter → `<br>` 软换行（不破行结构） | `typora-patches.js`（让路容器） |
| 整格/整行选中 Delete → 按 CSV 语义清空 | `media-tools.js` |

### 2.3 Excel / Word 直觉对照

| 操作 | Excel | Word | 本方案（Markdown 约束下的最优解） |
|---|---|---|---|
| 点格 | 选中格 | 落光标到点击处 | 落光标到**点击处**（Word） |
| 打字 | 覆盖整格 | 插入 | 未全选时插入；**全选态**打字覆盖（Excel） |
| Tab / Shift+Tab | 右/左移，末列换行 | 同 | 右/左移，**末列换行**；末行末列 Tab＝**新增一行** |
| Enter | 提交并下移 | 段内换行 | **提交并下移**；**Shift+Enter＝格内 `<br>`** |
| Esc | 取消本格编辑 | — | **取消本格编辑并退出**（还原进入前文本）；再 Esc 退出表格 |
| 方向键到边界 | 相邻格 | 相邻格 | **相邻格**；Shift+方向键＝**扩成矩形选区** |
| 拖拽跨格 | 矩形选区 | 矩形选区 | 矩形选区 |
| Ctrl+C/X/V | 矩形 ↔ TSV/HTML | 同 | 同（平移 2.2） |

---

## 3. 设计

### 3.1 单元格内容模型（不变更文件格式）

- **允许**：文本、`**粗**`、`*斜*`、`` `行内代码` ``、`[链接](url)`、`![图](src)`、`$行内公式$`、**单行** `$$块公式$$`、`<br>`（软换行）。
- **不允许**（GFM 单行表达不了）：围栏代码块、引用块、列表、多段落。
- **粘贴降级**（必须给一次性提示，不静默）：
  - 代码块 → 每行一个行内代码，行间 `<br>`；超过 N 行截断并提示
  - 引用块 → 去 `>` 前缀的纯文本
  - 多段/列表 → 段间 `<br>`，列表符号保留为字面文本
  - 真块级公式 `$$…$$` 多行 → 压成单行 `$$…$$`（A-029 的数据损坏必须在此处被拦住）

### 3.2 编辑面：格内就地「渲染态直改」

- 覆盖层**只画一份**，且与静态格**同字体/同行高/同 padding/同列宽**（消除 D1、D10 的视觉错位）。
- 覆盖层 DOM = **可编辑的渲染树**：`strong / em / code / a / img / span.mp-cm6-math(KaTeX) / br`。
- 输入 → 结构变化 → **序列化回 markdown**（小型 codec，规则表见下）→ 最小 diff 写回（复用 `syncCellEdit`）。
- 语法开关：`Ctrl+B` / `Ctrl+I` / `Ctrl+`` ` `` / `Ctrl+K`（链接）/ `Ctrl+Shift+M`（公式）。
- 光标不给源码：源码只在"链接 URL 编辑（Ctrl+K 弹层）"里出现；其余一律渲染态。
- 点公式字形 → 复用 `mathGlyphOffset()` 精确映射（与正文同口径）。
- `max-height = 格的 clientHeight`，超出**格内滚动**（不再向下溢出压住别的内容）。
- IME 沿用现有 composition 门控；每次序列化必须幂等（`serialize(parse(src)) === src` 作为断言）。

### 3.3 键位表（写进 `tableKeys`，与正文键位互斥）

| 键 | 语义 |
|---|---|
| `Tab` / `Shift+Tab` | 提交并右/左移；末列 → 下一行首列；末行末列 Tab → 新增一行 |
| `Enter` | 提交并下移（Excel）；末行 → 新增一行 |
| `Shift+Enter` | 格内 `<br>`（修 U-091 / A-028） |
| `Esc` | 取消本格改动（还原进入前文本）→ 退出编辑；再 Esc 把光标交给表格后的正文 |
| `↑/↓/←/→` | 格内移动；到文本边界 → 进相邻格（Word） |
| `Shift+方向键` | 扩成矩形选区（Excel） |
| `Ctrl+A` | 全选本格；再按 → 全选整表 |
| `Delete/Backspace` | 有矩形选区 → 按 CSV 语义清空该矩形；否则按字符删 |
| `Ctrl+C/X/V` | 矩形载荷（TSV + 只含矩形的 HTML + 应用内标记） |
| `Ctrl+Z/Y` | 走 CM6 事务栈；**撤销后保持 overlay 与滚动位置**（修 D7） |

### 3.4 矩形选区与剪贴板（平移 2.2，不重写）

- `tableRect = {top,left,bottom,right}`（锚点格↔焦点格包围盒）；拖拽 / Shift+点 / Shift+方向键都产出它。
- 复制：`text/plain`=TSV（一行一 `<tr>`，`\t` 分列）、`text/html`=只含该矩形的 `<table>`、应用内额外打 markdown 标记。
- 粘贴：HTML 表格优先 → TSV → 纯文本；`pasteRectangle + growTable` 落位；越界扩表。
- 剪切＝复制 + 清空矩形，光标落矩形左上格。

### 3.5 右键菜单

插入行（上/下）、插入列（左/右）、删除行、删除列、复制表格到 Excel、复制矩形（TSV/HTML）。菜单项与 2.x 同名同序（observational equivalence）。

### 3.6 列宽与对齐

- 弃用"字符数比例"：改为 **CJK 感知宽度**（汉字/全角=2，ASCII=1；或 canvas 实测）＋ 每列 `min/max` 钳制 ＋ 余量按需分配 ⇒ 消除 D11 竖排。
- 尊重分隔行对齐（`:--` / `--:` / `:-:`）：左/中/右。
- 拖拽列边界 → 只改视图宽度；**默认不回写文档**（Typora 亦不持久化），需要持久化时改写分隔行破折号数量（可选项）。

### 3.7 与既有架构的接口（不可破坏的契约）

| 契约 | 要求 |
|---|---|
| 文档即真源 | overlay 只是视图；所有改动走 CM6 事务（撤销/版本守卫/桥同步自动成立） |
| CM6 选区必须跟着走 | 点格/移动格/退出格时 `dispatch({selection})` 落到被编辑格源码位（修 D2/D6） |
| 高度图 | overlay 不进文档流；被编辑格的 widget **不得清空自身内容**（改为"渲染态 + 覆盖层叠同款内容"），消除 D10 的整表跳动 |
| 防抖保存 | 沿用现有 `post("change", {len})` 脏标；序列化不得每键触发全文克隆 |
| 虚拟滚动 | 每行一个 widget 的现状保留；跨行矩形选区只对**已在 DOM 的行**做视觉，逻辑用源码区间 |

---

## 4. 分期与验收判据

| 期 | 内容 | 验收（可测量，全部要真实输入 + 截图） |
|---|---|---|
| **P0 修丑** | 覆盖层只画一份、与格同款同轴、与格同高（内部滚动）；被编辑格不清空；CJK 列宽 | ① 覆盖层文本与同格内容**不重复**（Δy 检测 = 0）；② 覆盖层 rect 与格 rect x/y/w 差 ≤1px；③ 首列「I 概率地基」行盒 **1**（不再 5）；④ 首列内容宽 ≥ 2 个汉字宽 |
| **P1 Word 手感** | 点字落位、Enter/Shift+Enter/Esc、方向键越格、Tab 换行、光标跟随 | ① 点格后 `head` 落在该格源码区间内；② Shift+Enter 后源码出现 `<br>` 且**行数不变**；③ 末列 Tab → 下一行首列；④ 方向键越格后 `data-mp-row/col` 递增；⑤ 长格 overlay 高 ≤ 格高 + 1px |
| **P2 Excel 手感** | 矩形选区、Ctrl+C/X/V（TSV+HTML）、growTable、右键增删行列 | ① 拖选 2×2 → 剪贴板 `text/plain` 为 2 行 2 列 TSV；② 粘贴 3×3 到 2×2 表 → 行数/列数按 growTable 增长且**逐字节校验**；③ 插入/删除行列后源码行数变化正确；④ Delete 清空矩形后仅该矩形为空 |
| **P3 富内容** | 粗/斜/代码/链接/图片/公式的**直改**与序列化；块内容降级提示 | ① 预览 DOM 含 `strong/em/a/code/img` 节点（D8 归零）；② 序列化幂等断言（对素材 B 全部格 `serialize(parse(x))===x`）；③ 粘贴代码块 → 单行化 + 一次提示，**不破坏表结构**（A-029 反向用例） |

每期的**突变验证**：把该期关键分支注掉必须变红（例：注掉 `<br>` 分支 → Shift+Enter 变硬换行 → P1-②失败）。

---

## 5. 风险与对抗清单

1. **contenteditable 里做 WYSIWYG**＝序列化歧义（`**a *b* c**`、嵌套、`<br>` 与续行）。对策：codec 只支持"一层扁平标记"；遇到超纲结构**退回源码编辑**并提示（不猜）。
2. **每键全文克隆**：序列化必须只写回该格区间（diff），不得全文重建。
3. **CM6 widget 重建**会打断 IME/焦点（实测 `.mp-row` 12 → 18）。对策：活动行 widget `eq()` 忽略内容（现状已有），overlay 与格 DOM 解耦。
4. **撤销语义**：一次编辑一步撤销；序列化 diff 必须是最小 change（公共前后缀），否则撤销粒度爆炸。
5. **表格里的图片**：`![…](…)` 离线失败要有占位（D8 未覆盖，需补测）。
6. **大表性能**：492KB 文档 12 行表已实测可用；矩形选区只做视觉、逻辑用区间，避免 DOM 范围跨 widget。

---

## 6. 业界对标与架构判断（2026-10-07）

**一句话结论：本方案不是业界最先进，是"投影式"路线的上限档**——把「md 单源 + 零序列化」做到很好，
但表格的**结构模型**比最先进做法落后一代。

| 维度 | 业界最先进 | 本方案（现状＋设计） | 差 |
|---|---|---|---|
| 表格结构 | ProseMirror `tableNode` + **cellSelection**（自定义选区类、Tab/Shift-Tab 命令、TSV/HTML slice）；Lexical `@lexical/table` 同样有 cell selection & navigation | 每源码行一个 `<table>` widget ＋ `colgroup` 百分比宽度 | **一代**：没有"单元格"这个对象，跨行选区/列宽/剪贴板全靠源码区间模拟 |
| 单元格内容 | 任意块内容（段落/列表/图/代码/公式）；Notion 每格是块容器 | GFM 单行：文本＋行内标记＋行内公式＋单行 `$$…$$`＋`<br>` | **受文件格式约束**（非工程问题） |
| 格内编辑 | 编辑树＝文档树（PM/Lexical 的 contenteditable 就是真源） | body 上 fixed 覆盖层（现状）→ 设计改为格内渲染态直改 | 覆盖层是"体外编辑面"：CM6 选区不动（实测 15/15 次 head=0）、撤销掀桌（scrollTop 1405→21） |
| 键位导航 | `selectNextCell/selectPreviousCell` + 箭头 + Enter | 现状仅行内 Tab；设计补齐 | 可追平 |
| 矩形剪贴板 | cellSelection slice（TSV+HTML） | 平移 vditor 侧 `tableRectangle/pasteRectangle/growTable` | 语义可对齐，鲁棒性偏低（区间模拟） |
| 高级表操作 | Obsidian Advanced Tables：移动行列、列对齐、**公式、排序、导出 CSV** | 右键增删行列 + 复制到 Excel | 刻意不做（那是电子表格） |
| 公式编辑预渲染 | Obsidian Live Preview：光标进块只显源、无预览框；Typora：块内源＋预览 | **浮动预渲染框**（毛玻璃 / 可点字形回源码 / 滚动跟随 / 居中不跳） | **此处超出主流一档**（差异化，但属 overlay，是漂移风险点） |
| 大文档性能 | PM/Lexical 十万行级需重度虚拟化 | CM6 视口虚拟化＋widget LRU＋高度图 | **不落后，局部更优** |
| 单源真值 | md↔model 双向序列化（有损风险） | 文档即 md 文本，零序列化残留（F5/F6） | **更优** |

### 6.1 三个结构性缺口（要"到 SOTA"必须动的）

1. **单元格不是一等公民**（行级 widget＋百分比列宽）⇒ 一个表＝一个 widget，`colgroup` 由**实测文本宽**得出；
   单元格选区用"源码区间矩形"建模（GFM 无 rowspan，不追）。
2. **体外覆盖层** ⇒ 改为**单元格内嵌 CM6 子 EditorView**（CM6 官方讨论过的嵌套编辑器模式）：选区/撤销/IME
   天然归位，D2/D5/D6/D7 从"打补丁"变成"结构上不存在"；覆盖层只保留定位与尺寸同步。
3. **格内容上限（GFM 单行）** ⇒ 纯产品/文件格式决策：接受"行内富内容＋`<br>`"（Typora/vditor/Obsidian 同档），
   或放弃 GFM（HTML 内嵌/自定义语法），或换块模型引擎。

### 6.2 取舍判断

- **值得做**：子 EditorView（治本）＞ 一表一 widget＋真实列宽 ＞ 矩形剪贴板/键位（2.x 语义可平移）。
- **不值得做**：rowspan/colspan、格内块级内容、单元格公式/排序/CSV——那是电子表格，不是 Markdown 编辑器；
  互操作已有「复制表格到 Excel」这一条出口。
- **该继续打磨而不是拆掉**：浮动预渲染框（比 Obsidian/Typora 都细一档），但要把它纳入统一的"数学编辑面"
  组件（坐标纪律、失焦/退出语义、z 序），否则它永远是漂移风险源。

参考：ProseMirror tables <https://github.com/ProseMirror/prosemirror-tables>（`selectNextCell` 等命令见
<https://prosemirror.net/docs/ref/version/0.21.0.html>）；Lexical table plugin
<https://lexical.dev/docs/packages/lexical-table>；Obsidian Advanced Tables
<https://community.obsidian.md/plugins/table-editor-obsidian>；CM6 嵌套编辑器
<https://discuss.codemirror.net/t/dispatch-changes-without-redrawing-the-widget/6320>。

---

## 7. 待拍板（实现前需要一次确认）

1. **格内是否允许多行**（`<br>` 软换行）？Typora/vditor 都允许；不允许则 Enter 只能"提交并下移"。
2. **编辑态显示**：格内**渲染态直改（推荐，Word 手感）** vs 显示该格源码（Typora 手感，改动小但仍有源码露出）。
3. **块级内容的降级**：粘贴代码块/引用块时**降级 + 一次性提示（推荐）**，还是直接拒绝？
4. **列宽拖拽是否回写文档**（改写分隔行破折号）？默认不回写。
