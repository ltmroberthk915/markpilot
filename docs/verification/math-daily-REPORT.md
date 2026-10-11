# math-daily 族 · 普查报告（第二波·真实用户日常操作）

- **族名**：math-daily（公式日常：`$$`+回车进块 / 点公式进源码 / 源码内方向键与选区 / 选中公式复制给文档源码 / 公式后回车离开 / 多行公式 / 中文混排的光标与列稳定）
- **被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`（188784128 B，**sha16=`15b8a1b699a0782e`**，8 次启动逐次打印并断言，不符即 exit(9) 拒出数）
- **夹具**：`math-daily-out\<族>\doc.md`（唯一真源在 `math-daily-lib.cjs` 的 `FIXTURE()`；主夹具 191 字、sha16=`3519a8476f706ca8`；r7 用另一份单行块夹具 50 字、sha16=`ebf4dbcede5b6840`）
- **尺子**：`math-daily-lib.cjs`（唯一读数入口 `snap()`＝**一次 evaluate 拿全**：文档全文 + 选区 anchor/head/selText + head 行列 + **每个 DOM 行的类名/文本/widget 数/矩形** + widget 清单（kind/live/selected/katex/字形/矩形）+ 浮动预览清单（from/to/display）+ **光标矩形** + DOM 选区 + 选中底色矩形 + 滚动 + toast + 补全菜单 + 焦点 `document.hasFocus()`/`view.hasFocus`）。另有 `copy/cut` 事件载荷监听（capture+bubble 两相）、鼠标事件轨迹监听（判"原生选区 vs CM 状态选区"分叉）。
- **输入通道**：全部真实 —— `page.mouse`（含"按下→多次移动→抬起"的拖拽）、`page.keyboard`（CDP `Input.dispatchKeyEvent`）、`page.keyboard.type`。**0 处 JS 造 DOM 事件**。
- **规模**：**8 支探针 / 8 次启动（每次 1 实例、netstat 现查空闲端口、独立 profile、`MP_DEBUG=1`）/ 60 个用例 / 92 条读数条目 + 6 张截图**。
- **测量窗口**：2026-10-10 10:57:21 – 11:08:5x（r1–r5 独占；r6 尾段与 r7 期间另有 2 个**其他族**的实例在跑（`outline-modes-run` 11:07:05、`search-replace-real` 11:07:25），互不干扰：端口各不相同、profile 独立；8 份 `main-debug.log` 里 `second-instance|EADDRINUSE|conflict|error` **命中 0**；每条读数的 docLen/标记都等于夹具本身）。

---

## 一、范围逐条结论

| # | 范围项 | 结论 | 关键读数 |
|---|---|---|---|
| 1 | 输入 `$$` + 回车「进块」 | **不成立**（两次独立复现） | `E1c`/`R7c`：打完 `$$` 光标在行尾 col2 → 回车后 `headLine+1、col0`，文档尾 `…\n$$\n`，**自动补闭围栏=false**、`nWidgets 1→1`、没有块环境；必须自己再打内容 + 闭 `$$` 才成块（`E1e`/`R7c-C`）。见 §二.1 |
| 2 | 点击公式进源码 | **成立**（行内/块/多行块三形态） | `C1` 点 `$E=mc^2$` 正中 → head 落 13–21 区间内、该行 DOM 变 `行内公式 $E=mc^2$…`（源码展开）、浮层 `inline from=13 to=21`、`nWidgets 4→3`；`C3` 点块公式 → 落第 6 行、`nMathSrc=3`（`$$/内容/$$` 三行居中）、浮层 `display from=29 to=65`；`M1` 点多行块 → `nMathSrc=6`＝块行数、浮层 `display from=74 to=134` |
| 3 | 点渲染体**精确落位** | **成立（钳到最近可用位置）** | `C2` 点行内 widget 左缘 `fx=0.06` → head=14（源码区间 13–21 的第 1 格）；右缘 `fx=0.96` → head=20（末格前 1） |
| 4 | 点空白 → 块回渲染态 | **成立** | `C4` 点第 2 行 → `nWidgets 3→4`、`nKatex 4`、`nMathSrc 0`、`nFloats 0`；四式全部 `katex=true` |
| 5 | 双击公式整段选中 | **成立（不吞中文）** | `C5` 行内：`selText="$E=mc^2$"`、`[13,21]` 与源码区间逐字节同；`M7` 中文紧贴行：`selText="$x+a$"`（左右中文都没被并进来） |
| 6 | 源码内 ←/→/Home/End | **成立（逐字符、光标不消失）** | `C6` Home→col0，→×4 → 1/2/3/4（x=186/200/214/228 每格 +14），←×3 → 3/2/1（x 同步回退），End→col19＝行尾；8 个采样点 `cursorRect.w` 恒=2 |
| 7 | 源码内 Shift+→ 扩选 | **成立（口径与产品自述一致）** | `C7` 15 次 Shift+→：head 进公式区间时 `nWidgets 4→3`（**只有 head 所在那一个**展开），head 出区间后 `nWidgets 回 4` 且该公式带 `mp-math-selected`（`selectedWidgets=["inline \"E=mc2\""]`）；选区底色矩形恒 1 个、单调变宽 |
| 8 | 中文紧贴公式：逐字符穿越 | **成立** | `N1` 行 18 col0→col12：列**单调 +1 不跳格**、`cursorRect.w>0` 全程；col4（`$`）展开＋浮层出现，col10 收起＋浮层消失（`nWidgets` 轨迹 `4,4,4,4,3,…,3,4,4,4`） |
| 9 | 公式后回车离开 | **成立** | `R7b` 单行块行尾回车 → 新增空行、head 落块后新行 col0、`nWidgets 1→1 nKatex 1`（块回到渲染态）；`E1f` 闭围栏后回车 → `nWidgets 4→5`（新块开始渲染）；`M2` 多行块内容末行 ↓ → 出块落块外下一行 |
| 10 | 多行公式 | **成立** | `M1` `$$\begin{aligned}…\end{aligned}$$` 渲染成**一整块**（55px、katex）→ 点击展开 6 行源码（`nMathSrc=6`＝块行数）＋display 浮层；`M4` 内容行末回车 → 块内加一行、`\end{aligned}\n$$` 仍完整、一次 Ctrl+Z 还原；截图 `v3-multiline-source.png` |
| 11 | 选中公式复制＝**文档源码** | **成立（有非空选区时 6/6，head 在公式内外都成立）** | `D1` 拖选行内 → 载荷 `$E=mc^2$`＝`state.sliceDoc(选区)` 逐字节同；`D3` 键盘扩选块公式 → 载荷＝选区源码；`D4` 中文混排 136–149 → `中文紧贴$x+a$紧贴中文`（**不是字形 `中文紧贴x+a紧贴中文`**）；`D6` 源码展开态选整行 → `$E=mc^2$ 在句子里。`；`B0` 对照臂普通段落拖选；`B3` 块源码态拖整块 → `$$\n\int_0^1 x^2\,dx = \frac{1}{3}\n$$` 逐字节同。`B4` 剪切（cut 事件）载荷 `$E=mc^2$`、文档 −8、一次 Ctrl+Z 还原 |
| 12 | **渲染态块公式上用鼠标拖选** | **不成立** | `B1`/`B2`/`D2`/`D5`/`V5`：拖完选区 `from==to`（空）、DOM 选区也塌，Ctrl+C 载荷是**缺 `$$` 的单行文本**。见 §二.2 |
| 13 | 中文混排的列稳定（相邻行往返） | **成立** | `N2` A(18,col12,x309) ↑→17(col0) ↓→**col12/x309**（回原 head）；`M6` A(20,col10,x261) ↑↑→18(col9,x268) ↓↓→**20,col10,x261** |
| 14 | 中文混排的列稳定（**穿过块公式**往返） | **不成立** | `P1` col3→**col0**；`P1b` col12→**col0**；同形状对照臂 `P1c`（中间层是标题行、无块）col12→col13（x 293→302，目标位保住）。见 §二.3 |
| 15 | 围栏 `$$` 的"普通字符"程度 | **部分**（读得到/点得到/删得掉，**方向键进不去**） | 点得到：`P2` 源码展开态点 (592,237) → 落 line7 col2 `$$`；退格删得掉：`P2b` 两次 Backspace 把 `$$` 删空；**方向键进不去**：`N3-0` 从内容末行 ↓ 直接到块外下一行（15→17），`E3-2` 4→5→7→9→10 —— 围栏行不作停靠点。见 §二.4 |
| 16 | 删掉闭围栏的后果 | **现象已取证（可一次撤销还原）** | `P2b`：`docLines` 21→21（不吞行）、`nWidgets 4→2`、块消失，**`nMathSrc` 暴涨到 12 行**（"待闭合"态把后续正文一起居中）；`P2c` Ctrl+Z×2 → `docLen` 复原 191、`nKatex` 回 4 |
| 17 | 单行块公式内回车 | **现象已取证** | `R7a` 中点回车 → `$$\sigma` / `(X) := …$$` 拆成两行、以「`$$` 带内容跨行」形态继续渲染（`nKatex 1` 全给浮层）；`R7a-撤销` 一次还原（docLen 50）。紧贴开围栏后回车（`E4`）会把围栏单独成行并与邻近块的围栏**重新配对**（`nWidgets 5→3`、`nKatex 5→2`）——见 §四.3 |
| 18 | 行中段 `$$…$$` 收笔即独占一行 | **成立** | `E2` 行 3 行尾打 ` $$x+1$$` → 文档变 `[行内公式 …在句子里。 , "$$x+1$$", "", "$$"]`，`光标后是否紧跟换行=true`、`公式后无尾随字=true`、浮层 `display "x+1"` |
| 19 | 中文混排：公式前插一个中文字 | **成立** | `M8` 行 18 变 `中文紧贴测$x+a$紧贴中文，后面还有字。`、docLen 191→192、一次 Ctrl+Z 复原 |

---

## 二、没反应 / 行为不符预期的项（带关键读数）

### 1. `$$` + 回车**不会进块**：既不自补闭围栏，也没有任何块环境（两次独立复现）
- `E1c`（主夹具文末新起一行）：`E1b` 打完 `$$` → `headLine 22, col 2, nWidgets 4, nMathSrc 1`（该行被加 `mp-math-src` 居中）；`E1c` 回车 → `docLines 22→23, headLine 23, col 0`，文档尾 `…列参考行。\n\n$$\n`，**是否自动补了闭围栏 = false**，`nWidgets 4→4`（一个块都没多）。
- `R7c`（另一份夹具、另一次启动，独立复现）：`A_打完$$` headLine2 col2 text `$$`；`B_回车后` headLine3 col0、`自动补闭围栏=false`、`nWidgets 1→1`；直到 `C` 自己补上内容与闭 `$$` 才出现 `nKatex 2`＋`nFloats 1`（新块以浮层形态在编辑中）。
- 结论口径：产品把孤立的 `$$` 行**认成待闭合围栏**（行被居中），但没有"回车即补闭围栏/即进块"这一步；帮助文案（`extras.js`）也只承诺"行中段直接打 $$…$$，收笔会自动独占一行"（那条**实测成立**，见 §一.18），未承诺本条。
- **未验证**：与 Typora 实机的对照——本机无 Typora 实机（`E:\MarkPilot\Typora-Editor*` 是 v2 引擎源码，不是 Typora 本体），web 取证本轮也未取到可引用的官方说明（引擎全部失败）。故本条只报"范围项未实现"这一事实，不下"与 Typora 不符"的断言。

### 2. 在**渲染态块公式**上用鼠标拖拽 ⇒ 选不中；Ctrl+C 给的是"缺 `$$` 的半截"（本族最重，5 处复现）
- 读数（`B1`，单行块 `$$\int_0^1 x^2\,dx = \frac{1}{3}$$`，拖 widget 盒 (174,176)→(992,218)）：
  - 鼠标轨迹：`mousedown (174,176) state=empty@0 dom=""` → `mouseup (992,218) state=empty@33 dom=""`；
  - 终态：`选区 from=33 to=33（空）`、`DOM 选区 collapsed（anchorOffset=1,focusOffset=1）`、`nMathSrc=3`、`nFloats=1`；
  - Ctrl+C 载荷 = `\int_0^1 x^2\,dx = \frac{1}{3}`（**没有 `$$` 围栏**），`载荷含围栏=false`。
- `B2`（多行块 aligned，同样手法）：终态选区 `empty@93`、载荷 = `a &= b + c \\`（**只有一行内容**），`载荷含围栏=false`。
- **对照臂（同源同类）** `B0`：同一支探针、同一套拖拽代码、同一份夹具，在**普通中文段落** 136–149 上拖 → `state=136-149`、载荷 `中文紧贴$x+a$紧贴中文` ＝ `state.sliceDoc(选区)` 逐字节同 ⇒ 排除"探针拖拽实现坏了"。
- **正确路径存在**：`B3` 先点一下块进源码态，再拖 29→65 → 选区 `[29,65]`、DOM 选区 `$$\n\int…\n$$`、载荷与块源码逐字节同；`P3` 同（`selRects=3`，三行都有高亮）。
- 机制（两条一手证据，不是猜）：
  1. 产品 `clickToSource` 的 `mousedown` 处理器（`dsh-markpilot/src-cm6/main.js:3326`）**抢走 mousedown 并 return true，但不 `preventDefault`** ⇒ CM6 自己的拖选机制不启动；而该处理器同一拍把光标 dispatch 进 span，widget 当场换成源码文本，浏览器原生选区在脚下"换了地板" ⇒ 原生选区也塌掉（`mouseup` 时 `dom=""`）。
  2. 于是 `state.selection` 为空，产品的 `docSourceClipboard.copy`（`main.js:3042` `if (!ranges.length) return false`）不接管；落到 **CM6 内置 copy 的"无选区＝整行复制"分支**（`node_modules/@codemirror/view/dist/index.js:5203-5214` "Nothing selected, do a line-wise copy"）⇒ 交出光标所在那一行的文本。
- 视觉证据：`v5-block-drag-no-selection.png`（拖完整屏**没有任何选中高亮**，红标记光标停在 `\int_0^1 x^2\,dx = \frac{1}{3}` 行首，状态栏无"选中 n 字"）。

### 3. 穿过块公式往返会**丢掉目标列**（实验臂 2/2 丢，同形状对照臂保住）
| 臂 | 起点 | 上 1 | 上 2 | 下 1 | 下 2 | 回原列 |
|---|---|---|---|---|---|---|
| `P1` 实验（中间层是块公式） | 行9 col3 x214 | 行8 col0 x172 | **进块** 行6 col30 x679 | 行8 col0 x172 | **行9 col0 x172** | ✗（col3→col0） |
| `P1b` 实验（块紧邻行） | 行18 col12 x309 | 行17 col0 x172 | **进块** 行15 col13 x626 | 行17 col0 x172 | **行18 col0 x172** | ✗（col12→col0） |
| `P1c` 对照（中间层是标题行，无块） | 行3 col12 x293 | 行2 col0 x172 | 行1 col6 x323 | 行2 col0 x172 | **行3 col13 x302** | ≈✓（目标位 293→302，落在公式 widget 边界吸附） |

- 机制：CM6 原生的纵向移动把**像素目标列**存在 `SelectionRange.goalColumn` 里跨步保留（`@codemirror/view/dist/index.js:3738` `let goal = start.goalColumn`），这正是 `P1c`/`M6` 能走回来的原因；而产品的 `verticalIntoMath`（`main.js:1105` `const goalCol = sameRun ? mathPass.goalCol : col;`）在**每次进出块的 dispatch 里用当前行的逻辑列重建目标列且不带 goalColumn** ⇒ 中间隔了一个空行（col0）时，目标列在进块那一刻就被重置成 0。
- 与代码自述意图不符：该函数注释写的是"列用**经过前**的值：穿过块不许吃掉横向位置"，而 `P1b` 实测横向位置 309→172（吃掉 137px）。
- 与验收口径不符：AGENTS §三.3「不动的按键就是不动，但**不许丢掉目标列**（到底了再往回走，仍回到原来的列）」。
- 附口径说明（**不是缺陷**）：`M2` 多行块源码内的 ↑↓ 走的是**像素列**（块源码 `text-align:center`，行 14 col0 在 x=552；↓ 依次落 15 col2 / 16 col0 / 17 col0 / 18 col20 / 19 col0 / 20 col32，其中 col20/col32 都是"该行最接近目标像素的位置"＝行尾），逐行不跳行、也不消失。

### 4. 围栏行 `$$` 不作纵向停靠点（与验收口径 §三.4 的字面表述不一致；与产品自述的 Typora 口径一致）
- `N3-0` trace（源码展开态）：`line14 col0 \`d &= e + f\`` → `line15 col2 \`\end{aligned}\`` → **直接跳到 `line17`**（跳过 `line16` 的 `$$`）。
- `E3-2` hist（渲染态）：从 `line4` ↓ 依次 `5 → 7 → 9 → 10`（跳过 `line6`/`line8` 两条围栏）。
- 但**不是"够不着"**：`P2` 源码展开态下直接点闭围栏 → 落 `line7 col2 text="$$"`（真实鼠标命中）；`P2b` `End` + 2×Backspace → `$$` 被删空（**围栏符按普通字符删除** ✓），文档行数不变。
- AGENTS §三.4 写的是"围栏符按普通字符对待：退格删一个字符、**方向键能进出**、拖拽能选中"；产品在 `main.js:1084` 明确写了反口径（"围栏行（`$$`）不作为纵向停靠点……这条来自 Typora 实机"）。**本机无 Typora 实机，二者谁对未验证**；本轮只报"读数与验收口径字面不符"。

---

## 三、pageerror / 崩溃 / 外部中断

- **0 pageerror、0 consoleError、0 崩溃**：8 次启动全部 `pageerrors=[] cerrs=[]`；8 份 `main-debug.log` 无异常；`外部中断次数=0`（无一例 `Target closed`）。
- 收场纪律：每次探针 `finish()` 只 `taskkill /PID <自己 spawn 的 pid> /T /F`；本轮结束时对照 `Win32_Process`，仍在跑的 8 个 MarkPilot.exe 进程命令行全部指向**其他族**的 profile（`outline-modes-run`、`search-replace-real`），**没有一个是本族遗留**。

## 四、未验证 / 环境限制（不猜）

1. **跨系统剪贴板（环境阻断）**：本机锁屏态下系统剪贴板对所有进程不可用 —— 一手自证 `D8`：渲染侧 `navigator.clipboard.writeText('MATHDAILY-PROBE-7')` 返回 **`ok`**，写后立刻用主进程外 `Get-Clipboard` 回读 **`""`**（`自证成功=false`）；渲染侧 `readText()` 也恒为 `""`（无异常）。旁证：`Set-Clipboard` 报 OK 但 `Get-Clipboard` 读空、`"xyz" | clip.exe` **exit=1 Access is denied**。
   ⇒ **本族所有"复制"结论都只到"产品写进 `copy` 事件 `clipboardData` 的载荷"这一级**（页内一手读数，D1/D3/D4/D6/B0/B3 共 6 处，`types=["text/plain"]`、`prevented=true`）；"粘到系统剪贴板之后能不能粘进别的程序"这一腿 **未验证（环境阻断）**，既不算通过也不算失败。
2. **粘贴（Ctrl+V）整条腿未测**：依赖系统剪贴板，同上环境阻断。
3. **`E4`（紧贴开围栏后回车）的"围栏重新配对"只取了现象级读数**（`nWidgets 5→3`、`nKatex 5→2`、`doc行4到10`），**未逐项取证**被重配后的块渲染明细；`R7a`（单行块中点回车）已逐项取证。
4. **W1/W2 整屏视觉**：本族截图是 `.cm-content` 局部裁切，未做 2 倍放大（CDP 连接的页面 `page.screenshot` 只有 1x 与 clip，无缩放通道）；图上按 AGENTS §一.3 画了标记（红实线＝浏览器自报光标矩形、琥珀虚线＝选区、青虚线＝带 `mp-math-selected` 的公式盒），**CDP 拍不到原生光标这一点已在标记口径里说明**。
5. **未覆盖（不属本族范围）**：导出/打印里的公式排版、阅读模式、双开从视图里的公式、表格格内公式（`Ctrl+Shift+E`）、公式补全菜单的候选质量（只测了它吃 ↑/↓ 这一条归属）、LaTeX 渲染正确性本身。

## 五、证据文件

**探针（8 支，全部 `math-daily-` 前缀，均在 `.mp-verify\checklist\`）**
- [math-daily-lib.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-lib.cjs) —— 共用尺子（夹具唯一真源、`snap()` 一次读数、真实点击/拖拽/按键、copy/cut/鼠标轨迹监听、reboot 护栏、截图）
- [math-daily-r1.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r1.cjs) —— `$$`+回车 / 收笔换行 / 块内回车 / 块上回车（11 条）
- [math-daily-r2.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r2.cjs) —— 点公式进源码、精确落位、双击、源码内方向键/Home/End/Shift 扩选/拖选、纵向目标列、补全菜单归属（12 条）
- [math-daily-r3.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r3.cjs) —— 复制载荷（行内/块/中文混排/源码展开态/剪切）+ 剪贴板三级读数（12 条）
- [math-daily-r3b.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r3b.cjs) —— 块公式拖拽机制判别（含同源对照臂）+ cut 载荷（9 条）
- [math-daily-r4.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r4.cjs) —— 多行公式、块内逐行、块下方向上进块、内容行回车的结构守恒、中文混排（15 条）
- [math-daily-r5.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r5.cjs) —— 逐字符穿越、↑↓ 往返、围栏行可点性 + 5 张带标记截图（12 条）
- [math-daily-r6.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r6.cjs) —— 穿过块公式的目标列（实验/对照/复测三臂）、围栏删除、块源码内选区 + 选区视觉图（11 条）
- [math-daily-r7.cjs](E:\MarkPilot\.mp-verify\checklist\math-daily-r7.cjs) —— 单行块公式中点/行尾回车、`$$`+回车独立复现（7 条）

**读数（JSON，每条含完整读数、产物 sha16、夹具 sha16、pageerror 数组）**
`math-daily-out\{r1,r2,r3,r3b,r4,r5,r6,r7}\result.json`；运行日志 `_math-daily-{r1,r2,r3,r3b,r4,r5,r6,r7}.log`

**截图（6 张，`math-daily-out\<族>\shots\`）**
- [v1-baseline.png](E:\MarkPilot\.mp-verify\checklist\math-daily-out\r5\shots\v1-baseline.png)（基线：四式全渲染，H1 上的光标红标记）
- [v2-inline-source.png](E:\MarkPilot\.mp-verify\checklist\math-daily-out\r5\shots\v2-inline-source.png)（**点开行内公式**：`行内公式 $E=|mc^2$ 在句子里。` 源码展开，红标记在 `$E=` 与 `mc^2$` 之间，正下方浮出虚线预览框 `E = mc²`）
- [v3-multiline-source.png](E:\MarkPilot\.mp-verify\checklist\math-daily-out\r5\shots\v3-multiline-source.png)（**点开多行块公式**：6 行源码整段居中展开，红标记在 `d &= e+f` 行，闭围栏下方浮出 display 预览 `a=b+c / d=e+f`）
- [v5-block-drag-no-selection.png](E:\MarkPilot\.mp-verify\checklist\math-daily-out\r5\shots\v5-block-drag-no-selection.png)（**§二.2 的视觉证据**：拖完整屏无任何选中高亮；∫ 块已变源码、状态栏无"选中 n 字"）
- [v4-selection.png](E:\MarkPilot\.mp-verify\checklist\math-daily-out\r6\shots\v4-selection.png)（**选区里的公式保持渲染＋选中底色**：中文行整段带琥珀选中带、`x + a` 仍是渲染体并带青虚线盒、红标记在选区尾，状态栏 `选中 19 字`）
- `math-daily-out\r5\shots\v4-selection.png` —— **无效图**（该发拖拽起止点算错成同一点，选区为空），保留以便复核，不作为证据。

**产品侧代码（只读，未改一行）**
`E:\MarkPilot\dsh-markpilot\src-cm6\main.js`（`mathSpansField`/`blockMathField`/`mathDecorations` :1011–1075、`verticalIntoMath` :1089–1161、`clickToSource` :3326–3372、`docSourceClipboard` :3033–3078、`autoBreakMath` :2879–2927）、`extras.js`（帮助文案 :2374）、`node_modules\@codemirror\view\dist\index.js`（:3734 `moveVertically`、:5196 `copiedRange` 的整行复制分支、:5219 `copy/cut` 处理器）

**工作树状态**：本族只新增 `.mp-verify\checklist\math-daily-*` 与 `.mp-verify\checklist\math-daily-out\**`，`src-cm6/`、`MarkPilot-CM6/` **零改动**（只读）。
