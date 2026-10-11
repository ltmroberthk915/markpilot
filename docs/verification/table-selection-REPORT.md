# table-selection 族 · 第二波普查（表格选择层级）

- **被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`，188784128 B，**sha16 = 15b8a1b699a0782e**（每个探针启动先打尺子卡并断言 `MP_EXPECT_EXE`，不符即 exit 9 不出数）
- **夹具**：`.mp-verify\checklist\table-selection-out\<dir>\doc.md`，130 B，**sha16 = 63ec3d619ede724f**（3 列 × 表头 + 2 数据行；表外有上/下两段，用于"点击边栏/跨表拖拽"）
- **时间**：2026-10-10 11:01–11:07（当时如此）
- **通道**：全部真实输入 —— `page.mouse`（move/down/up 多次移动）/ `page.keyboard`（CDP `Input.*`）；启动范式照抄现有探针（spawn + 随机 `--remote-debugging-port` + 独立 `--user-data-dir` + `MP_DEBUG=1` + 删 `ELECTRON_RUN_AS_NODE` + `connectOverCDP`）
- **尺子**：读数一律"最终状态"（`.mp-sel-row/.mp-sel-col/.mp-sel-table` 看得见的高亮 + CM 选区 + 文档文本 + `document.getSelection()` + 活动元素），一组读数**一次 evaluate 拿全**；同族只有一份 `table-selection-lib.cjs`
- **用例数：39**（p1 选中通道 11；p2 复制/剪切/删除/粘贴 10；p3 层级态按键 11；p4 打字诊断+4 条对照臂 7）

## 域内成立（读数支撑）

| 项 | 关键读数 |
|---|---|
| 阶梯本身正常 | 点格 → Ctrl+E → Ctrl+A×3：层级序列 `['cell','row','col','table']`，选区 `[57,61]→[51,67]→[57,61]→[17,84]`，**每一拍文档逐字节不变** |
| 三级高亮肉眼可见 | 行底色 `color(srgb .298 .604 1/.16)`、列底色 `…/.13`、整表描边 `solid/1.714px`；三张局部图 s3c-row/col/table.png |
| 整表 Ctrl+C = 可粘 Excel | 事件层 `types=["text/plain","text/html"]`，plain=`甲\t乙\t丙\na1\tb1\tc1\na2\tb2\tc2`，html=`<meta charset="utf-8"><table><tr><th>甲</th>…` |
| 行 Ctrl+C = 行源码 | plain=`| a1 | b1 | c1 |`，prevented=true |
| 格 Ctrl+C 不接管 | prevented=false，`cellCopyDiag={calls:1,mode:'dom-selection'}`（交浏览器默认） |
| 表外 Ctrl+A 不动表 | 选区 `[0,92]` 全文档，表格层级高亮 0/0/0 |
| 到顶不循环 | 整表后再按 2 次：始终 `[0,92]`，不回"格"级 |

## 没反应 / 行为不符预期（按严重度）

### F1 行层级按 Delete / Backspace ⇒ **表格被劈开**（C6/C7/K9）
- 读数（doc 前→后）：
  - 前 `…| --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n…`
  - 后 `…| --- | --- |\n\n| a2 | b2 | c2 |\n…`（那一行变**空行**）
- 渲染行数 3→1、表格数 3→1；`判据_表格结构是否还在: false`；后面的数据行退化成表外裸源码
- 截图 `p2-clip/shots/c6-row-delete.png`：表头还在，下面 `| a2 | b2 | c2 |` 变成普通文字
- 对照：同一选区 Ctrl+X 走 `row-delete`，行干净消失、表还在、提示「删除本行」
- 码侧印证：`tableSelInputGuard` 只拦 `tr.isUserEvent("input")`，而 CM6 `deleteByChar` 对**非空选区**发的 userEvent 是 `delete.selection` ⇒ 守卫不生效；Cut 另有 `isFullTableRowSelection` 分支
- 可撤销：一次 Ctrl+Z 回到 pristine（读数 ok）

### F2 整表层级打字 ⇒ **整张表被一个字替换**（D3/K8）
- 前 `CM选区=[17,84]`、整表高亮 3；打完 `z`：文档 5–8 行整块变 `z`，`判据_表结构没坏: false`；可一次撤销

### F3 行/列层级打字 ⇒ 字**没落进当前格**，掉到表格下面那一行（D1/D2、K6/K7）
- D1：`diff 行9: "" → "x"`，`判据_字落进当前格b1: false`，层级被清（高亮 0/0/0）
- 机制读数（打字**前**）：CM 选区 `[51,67]`，但 DOM 选区 = `DIV.cm-content` offset 0、**rect 0×0**、`posAtDOM→85`（表格下方的空行）
- 对照臂（同夹具、同尺子、同顺序）：
  - **D5 无层级、光标就在表行里**（真实点行左侧空白 → CM 光标 行7列16）→ **同样**落到行9 ⇒ 与"选择层级"无关
  - **D6 普通段落**：DOM 光标是真实 `#text.cm-line` rect(172,128,15px) → 打字得 `x前置段落。` ✓ 落在光标处
  - **D7 点格进覆盖层**：DOM 光标在 `.mp-cell-overlay-text` offset 2 → 打字得 `| a1 | bx1 | c1 |` ✓ 落进该格
- 结论：表行被 block widget 整行替换 ⇒ 表行上**没有可落字的原生光标**；守卫**确实被调度**（层级高亮被清），但它只搬"选区"、没搬"这次输入"⇒ 拦不住

### F4 全选之后点格再按 Ctrl+A ⇒ **阶梯卡死**（S9）
- 点格后 CM 选区**仍是全选** `[0,92]`（点格不落 CM 选区）；`Ctrl+A` 一拍**什么都没变**（判据 false）
- `Ctrl+E` 能回到"格"级（DOM 选区 ` b1 ` 起在覆盖层里），但 CM 选区仍 `[0,92]` ⇒ 再按 `Ctrl+A` **仍无反应**（判据 false）
- 码侧印证：`cycleTableSelection()` 第一句 `if (main.from===0 && main.to===doc.length) return false;` 早退

### F5 层级态按 Tab / 方向键：高亮不跟光标，且层级不退出（K1/K3/K4/K5/K11）
- K1 行层级 Tab×2：CM 光标 `[67]→[70,70]→[75,75]`（行 7 → 行 8），**行高亮仍亮在 a1 行**（截图 k1-row-tab.png：a1 行还是蓝的）
- K3/K4 方向键：光标被带出表格（行 9/行 10）而 行高亮 1 / 列高亮 3 仍在
- K5 整表层级 `↓`：光标出表（行 9 列 0），**整表描边仍亮**（截图 k5-table-arrowdown.png：状态栏「92 字」＝无选区，表格仍整圈蓝框）
- K11 `Esc` **不能退出层级**（Esc 后仍 row；再点空白仍 row）——`setTableSel(null)` 只写在覆盖层那条 keydown 分支里，源码键位没有 Escape 绑定
- K10 行层级 `Enter`：文档未变、选区折叠到行尾 `[67,67]`、层级仍 row（无表操作）

### F6 列层级 Ctrl+C 给的是**当前格源码**，不是整列（C3）
- 事件层 plain=` b1 `、`types=["text/plain"]`、`判据_有没有整列出口: false` —— 源码注释里登记的已知取舍，但用户侧"选中一列、复制只有一格"

### F7 拖拽/全选跨过表格时，**表格上看不出被选中**（S7、S9）
- S7 从上段拖到下段：CM 选区 `[13,89]`（含 4 行表格源码），产品层级高亮 0/0/0；DOM 选区文本是转写后的表 `甲\t乙\t丙…`
- S9 截图（全选态）：状态栏「选中 92 字」，而**表格块整片是黑的**，与未选中无差别

### F8 在渲染表格上**拖拽不能选格/选行**（S6）
- 真实 按下→6 次移动→抬起：CM 选区仍 `[10,10]`、层级 none，只把落点那格变成编辑态（覆盖层 true）

### F9 没有"点击边栏选行"这条通道（S5）
- `.cm-gutters` 存在但 `display:none`（gutter 元素 14 个全不可见）、行手柄类元素 **0** 个
- 点表格左缘外侧 14px：CM 光标落到该行行尾（行 7 列 16），**不产生行选择**（`判据_是否选中了整行: false`）

### F10 行层级 Ctrl+X 会**整表重排**（C5）
- 剪切成功、表还在（渲染行数 2）、提示「删除本行」，但剩余行被按列宽重排：`| 甲   | 乙   | 丙   |`、`| a2  | b2  | c2  |`
- `判据_那一行干净消失: false`（差异在重排，不在内容）

### F11 整表层级 Delete 留下连续空行（C8）
- 表消失 ✓，但文档变成 `["# 表格选择层级","","前置段落。","","","","末尾段落。",""]`（多出空行段）；一次 Ctrl+Z 完全还原 ✓

## pageerror / 崩溃

- 4 个探针全部 `pageerror: []`、`consoleError: []`；`启动次数` 均为 1、`外部中断: 0`；无崩溃、无页面被关闭
- 收场：所有实例由 `taskkill /PID <本进程> /T /F` 结束；复查 `Win32_Process` 里 `table-selection-out` 的实例 **0 个**（其他族的 12 个实例未动）

## 未验证 / 环境阻断

- **系统剪贴板（环境阻断，已证）**：`Set-Clipboard` 返回 ok 但 `Get-Clipboard -Raw` 读回长度 **0**、`clip.exe` 退出码 **1**（Access is denied）。凡"落到别的程序里"的复制/剪切/粘贴一律**不出通过也不出失败**（事件层载荷只证明"产品给了什么"）
- **层级态粘贴**：真 Ctrl+V 事件到了（`prevented=true, types=[], plain=''`）但没有内容落地 ⇒ `tableSelInputGuard` 的 `input.paste` 分支**未验证**
- 格层级 Ctrl+C 的"粘到别处"未验证（产品不接管、交浏览器默认，而系统剪贴板不可读）
- 未做突变验证（本族为普查，不改产品码）

## 尺子修正记录（诚实标注）

- 第一版把"Ctrl+E 选格"的判据写成 `getSelection().toString()==='b1'`，实测是 `' b1 '`（**含格内前后空格＝该格源码**）⇒ 是**尺子错**，不是产品错；第二版改为与该格源码逐字节比较，判据转 ✓
- 第一版 `toLevel` 从"点格 + Ctrl+A"起手，读数与推断矛盾（第一拍直接跳到 row）。查证结果：**点格不落 CM 选区**，且 `cycleTableSelection` 对"已是全文档"早退 ⇒ 台阶会被前一个用例的残留状态带偏。第二版改为 `点表外段落 → 点格 → Ctrl+E（确定性入口） → Ctrl+A×(n-1)`，并逐拍自证层级，读数随即自洽（S3 判据 ✓）
