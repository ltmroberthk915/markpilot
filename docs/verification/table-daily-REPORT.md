# table-daily 族 · 普查报告

- **族名**：table-daily（表格日常操作：Tab / Shift+Tab / Enter / 方向键 / 粘贴 TSV / 格内打字 / 末行补行 / 撤销）
- **被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`（188784128 B，**sha16=81b39273efae31e5**，启动即断言，不符则拒出数）
- **夹具**：`table-daily-out\<族>\doc.md`（每次运行重建；sha16=54b244c8579dfb8d）
- **尺子**：`table-daily-lib.cjs`（唯一读数入口 `snap()`＝**一次 evaluate 拿全**：文档全文 + CM 选区 + 活动格（`.mp-cell-editing` 的 `data-mp-row/col`）+ 覆盖层 + 焦点 + DOM 选区 + toast + 每个渲染行的格数与源偏移）。输入一律真实通道：`page.mouse` / `page.keyboard`（CDP Input.*），粘贴＝真 `Ctrl+V`，剪贴板写入＝壳层 `mpHost.writeClipboard`（与产品「复制表格」同一条通道）+ PowerShell 读**系统剪贴板**回读自证。
- **用例数**：9 支探针 / 7 次启动（每次启动 1 实例、独立 profile、随机空闲端口）/ **90 条读数条目** + 12 张截图。

---

## 一、范围逐条结论（判据 → 读数）

| # | 范围项 | 结论 | 关键读数 |
|---|---|---|---|
| 1 | 光标在表中按 Tab（格间前进） | **成立** | 点表头首格→覆盖层激活（格内文本=「甲」）；Tab：列 0→1→2（CM 列 2→6→10），再 Tab 落到**下一条数据行第 1 格**（跳过分隔行）；全程文档逐字节不变。源码键位路径（点表格左侧 gutter 把 CM 光标放进表行）同语义：列 0→6→10→(行7)2 |
| 2 | Shift+Tab | **成立（顶停为静默）** | 数据行第 1 格 Shift+Tab → 表头末格；表头首格再 Shift+Tab → 停住、焦点不跑、文档不变（**无位移、无提示**，见 §二.2） |
| 3 | Enter（换行/新行） | **成立（本仓口径＝下移一格）** | 表头 Enter → 数据行 1 同列；末数据行 Enter → **补一行** `\|  \|  \|  \|`，文档 11→12 行；Shift+Enter → 格内插入**字面 `<br>`**（行变 `\| a<br>1 \| b1 \| c1 \|`） |
| 4 | 方向键跨格 | **不成立** | 见 §二.1：格尾连按 →×3 零位移；← 只在格内回退；↓/↑ 在中间行不跨行。仅**末行 ↓ / 表头 ↑ 退出表格**（光标到表后/表前，覆盖层收起） |
| 5 | 粘贴多行 TSV 进表格应扩行 | **不成立（产品拒绝 + 提示）** | 见 §二.3：`prevented=true`、文档零变化、toast「格内不支持多行粘贴（会把表格切开）—— 请粘到表格外」 |
| 6 | 粘贴（表外 / 表行内 / 含管道 / HTML 表） | **建表可用，但两处有副作用** | 表外 TSV → 建 2×3 表（toast「已建成 2 行 × 3 列」）；含 `\|` 单行 → 落地成 `\\\|`；HTML 表 → 建 2×2 表。副作用见 §二.4、§二.5 |
| 7 | 在表格里打字不破坏结构 | **成立** | 三格各打一字符 → `\| a11 \| b21 \| c31 \|`；每行管道数恒 4/4/4/4、行数不变；格内打 `\|` → 落地 `\\\|`（toast「已转义为 \\\|」）；中文 `insertText` → `\| a中文1 \| …`，结构不变；14 次编辑后终态与夹具**逐字节相同** |
| 8 | 表格末行 Tab 应新增一行 | **成立** | 末行末格 Tab → 行数 +1、新行 `\|  \|  \|  \|`（3 列）、活动格落在新行第 1 格；截图 `v1-after-append.png`（4 行，状态栏 101 字）。源码键位路径连按 9 次 Tab 同样补行 |
| 9 | 撤销一次回到原状 | **单次操作成立；多次独立输入按历史项计数** | 打字 Z＝1 次、末行 Tab 补行＝1 次、Shift+Enter＝1 次、中文输入＝1 次，均**一次 Ctrl+Z 逐字节回原状**（连补行/粘贴/破表场景也可一次回退）；三格各打一字符＝3 次（三次独立输入＝三个历史项，U5b） |

## 二、没反应的项 / 行为不符预期的项

1. **方向键不跨格（范围项 4 直接不成立）** — `A1b/A1c/A2`：光标推到格尾（点右缘，DOM offset=4）后连按 →×3，DOM offset 恒 4、活动格恒 (行7,列1)、文档不变；连按 ←×3 只在格内 4→3→2→1；中间行 ↓ 零位移、↑ 只回到格首。产品帮助文案（`extras.js` 快捷键说明）也只承诺 Enter/Tab/Shift+Tab，未承诺方向键跨格 ⇒ 属"未实现"，非回归。
2. **Shift+Tab 在表头首格＝静默顶停** — `K5`：按键被消费（焦点不出编辑器、文档不变），但**没有任何视觉/文案反馈**（无 toast、无双击感）。设计如此（`tables.js applyTab` 的 `stopped` 分支），用户侧表现为"按了没反应"。
3. **粘贴多行 TSV 进表格：不扩行，改为拒绝** — `P2`（剪贴板自证 match=true）：粘贴事件 `prevented=true`、`text/plain` 完整到达（`T1\tT2\tT3\nT4\tT5\tT6`）、文档零变化、toast「格内不支持多行粘贴（会把表格切开）—— 请粘到表格外」。**与本族任务书"应扩行"的期望不符**；产品侧是有意止血（结构未破），但"扩行"这一日常诉求目前无入口。HTML 表在格内同一条提示（`P6b`）。
4. **光标在表行（无覆盖层）粘 TSV ⇒ 原表被劈开（本族最重）** — **【2026-10-10 复跑：在当前产物 sha16=db7613632e37d99e 上已修复、不复现；原文保留，见 §六.2】** — `P5b`：真实点表格左侧 gutter 把 CM 光标放进表头行（行 5 列 0，`headLineIsTable=true`、无覆盖层）→ 真 Ctrl+V：走后一条"文档里建表"分支，把新表**插进原表行中间**：第 7 行源码 `\| T4 \| T5 \| T6 \|\| 甲 \| 乙 \| 丙 \|`（管道 4→8），渲染结果 `["T1·T2·T3","T4·T5·T6","---·---·---","a1·b1·c1","a2·b2·c2"]`——原表头被粘走、分隔行 `---` 被当成数据行渲染。一次 Ctrl+Z 可回原状（`P5c`）。粘贴处理器只对"焦点在格覆盖层里"设防，**没有判"CM 光标是否已在表内"**。
5. **正文行里粘 TSV：建表成功但把该行剩余文字粘进新表最后一行** — **【2026-10-10 复跑：在当前产物 sha16=db7613632e37d99e 上已修复、不复现；原文保留，见 §六.2】** — `P4`：光标在第 3 行行首（该行文本「前置段落。」）粘 TSV → 新表 2×3 建好，但最后一行成为 `\| T4 \| T5 \| T6 \|前置段落。`（`P6c` HTML 表同理：`\| H3 \| H4 \|前置段落。`）。渲染按表头列数裁列 ⇒ **屏幕上那句正文消失**（源码仍在，`判据_原正文句是否还单独成行=false`）。插入未按块级做前后换行。
6. **点格落点按点击横向比例**（口径，不是缺陷） — 点格子正中再打字会插在文本中间（`K9` → `cXY1`、`U5` → `a11|b21|c31`、`U6` → `a中文1`）；点格子右缘或按 End 即在格尾追加（`A3/A4` 实测 `\| … c1 XY\|`）。建议写进验收口径，免得后人把"中间插入"读成串位。
7. **"撤销一次回到原状"的粒度** — 单次按键/单次输入都是 1 次 Ctrl+Z 回原状；但**三个格各打一个字符要 3 次**（每格一次 dispatch＝一个历史项，`U5b`）。属 CM 历史语义，不是缺陷，但用户会感到"撤销要按好几下"。

## 三、崩溃 / pageerror

- **0 崩溃、0 pageerror、0 consoleError**（7 支探针 7 次启动，`errs=[] cerrs=[]`；最终文档均逐字节回夹具）。
- 曾遇**外部干扰**：09:04:11 第一发 keys 探针在 K9 被"页面已关闭"打断——同分钟邻族 `window-states/crash.txt` 记录同一条 `page.evaluate: Target page, context or browser has been closed`，且 Windows 应用日志无 MarkPilot 崩溃记录 ⇒ 判定为**外部 `taskkill MarkPilot.exe`**（多族并行跑同一 exe），非产品崩溃。随后给 lib 加护栏（换 profile 重启 + 重跑用例），之后 7 次启动全部 1 次跑完（`外部中断次数=0`）。

## 四、未验证 / 环境限制（不猜）

> **【2026-10-10 复跑更新 · 环境已解除】** 工作站已解锁、系统剪贴板恢复可用（本族自证见 §六.0）。
> 下面第 1、2 条是当时的两处环境阻断，现已**逐条复跑**：原文保留（不改历史），结论就地更新，
> 复跑读数与证据路径见 **§六**。注意复跑时被测产物已换代：`81b39273efae31e5` → **`db7613632e37d99e`**。

1. ~~**剪贴板在本会话时好时坏**~~ → **【已解除：剪贴板可用】** 原文：同一条写入通道（`mpHost.writeClipboard` 返回 `{ok:true,bytes:N}`）在 01:18 那一发回读 `match=true`（P1–P6 全部实测），在 01:20 / 01:22 两发回读为空；同时 `"x" | clip.exe` 直接 **Access is denied**、`Get-Clipboard` 抛 ExternalException。
   **复跑结论**：三通道全部**精确回读一致**（`Set-Clipboard`→独立 pwsh 进程落文件回读：ASCII 44/44、多行 TSV 17/17、中文 7/7、置空 0/0；`clip.exe` 退出码 **0** 且回读一致 —— 先前报的 `Access is denied` 不再出现）。当时"回读为空"的根因是**会话锁屏**（写入返回 ok、回读长度 0），不是通道损坏；现已不可复现。**探针侧不必再记「未验证」。**

2. ~~**W1/W2 整屏视觉证据未取到**~~ → **【已取到：W1/W2 两条破损在当前产物上都不再出现】** 原文：试了两发 `table-daily-paste-visual.cjs`，剪贴板都不可用（探针自行记「未验证」并停止）。
   **复跑结论**：`table-daily-paste-visual.cjs` 一发跑完（1 次启动、0 pageerror），W0/W1/W1b/W2/W2b 全部出数；**并且我逐张打开了截图看图**（不是只看数字）。详见 §六.2。

3. **未覆盖（不属本族范围）**：表格浮动条/右键菜单的命令族（复制表格、插删行列）、公式/图片格、引用区表格、阅读态。**本条无变化**：复跑只覆盖粘贴/视觉臂，未扩到这些范围。

4. **【复跑新增·多族并行的剪贴板抢占】** 剪贴板是**会话级全局资源**：复跑期间邻族 `list-continuation-rerun/clip-selfproof.cjs` 于 `03:48:32Z` 把哨兵 `MPCLIP-SENTINEL-中文行1\r\n中文行2\ttab&"quote"` 写进系统剪贴板，正压在 `03:48:35Z` 的 Ctrl+V 上 ⇒ **"我按的 Ctrl+V"粘进去的是别人的哨兵**（本次首跑实测：W1/W2 终态里出现该哨兵、TSV 一次都没落地）。只看终态会把它误读成"产品粘贴行为异常"。
   **对策已落进尺子**：`table-daily-lib.cjs` 新增 `pasteProof()` —— 装弹自证 + **按键前一瞬快读** + **paste 事件载荷必须等于预期文本**，载荷不符即判该发被污染、撤销还原后重试（本轮实测装弹重写 1~2 次才成功的情况真实发生）。**凡不带载荷证明的 Ctrl+V 读数，本族的"通过"都不算数。**

## 五、证据文件

**探针（9 支，全部 `table-daily` 前缀）**
- `E:\MarkPilot\.mp-verify\checklist\table-daily-lib.cjs`（共用尺子：启动/一次读数/真实点击/剪贴板/截图/护栏）
- `table-daily-keys.cjs`（Tab/Shift+Tab/Enter/Shift+Enter/末行补行/打字/撤销，24 条）
- `table-daily-arrows.cjs`（方向键跨格 + 打字落点，9 条）
- `table-daily-srctab.cjs`（源码键位通道：gutter 进表行，8 条）
- `table-daily-undo.cjs`（撤销粒度 + 结构守恒，16 条）
- `table-daily-paste.cjs`（粘贴 6 用例 + 剪贴板自证，21 条）
- `table-daily-paste-visual.cjs`（W1/W2 整屏视觉，两发未验证）
- `table-daily-clipdiag.cjs`（剪贴板通道判别，8 条）
- `table-daily-shots.cjs`（基线/补行/撤销三张整屏图，4 条）

**读数（JSON，含每条的完整读数）**
- `E:\MarkPilot\.mp-verify\checklist\table-daily-out\{keys,arrows,srctab,undo,shots,paste,clipdiag,pastevisual}\result.json`
- 运行日志：`E:\MarkPilot\.mp-verify\checklist\_table-daily-*.log`

**截图（12 张）**
- `table-daily-out\shots\shots\{v0-baseline,v1-after-append,v2-after-undo}.png`（整屏三连：3 行 → Tab 补行 4 行 → 一次 Ctrl+Z 回 3 行）
- `table-daily-out\keys\shots\{k1-click-header,k6c-enter-append,k9-typed,k11-tab-append,k11b-after-undo}.png`
- `table-daily-out\undo\shots\u5-three-cells-typed.png`（三格 `a11|b21|c31`，活动格描边可见）
- `table-daily-out\paste\shots\{p2-tsv-in-cell,p4-tsv-outside,p5-tsv-in-tablerow}.png`
- `table-daily-out\srctab\shots\s1-tab-src.png`

**外部交叉证据**
- `E:\MarkPilot\.mp-verify\window-states\crash.txt`（09:04:17 同一条 "Target page … closed"）
- `E:\MarkPilot\.mp-verify\checklist\code-fence-daily-clipdiag.log`（09:04 剪贴板同症状）
- 产品侧代码口径（只读、未改）：`E:\MarkPilot\dsh-markpilot\src-cm6\tables.js`（Tab/Enter/方向键语义）、`src-cm6\extras.js`（onDocPaste 的格内拒绝 / 表外建表）、`src-cm6\main.js`（覆盖层键位分支、点格落点、活动格字段）

---

## 六、【2026-10-10 复跑】剪贴板解除阻断后的真结论

> 本节的数**换了产物**，不要与 §一~§三 混读。每条结论都给：判据（用户能看见的性质）→ 读数 → 证据。

- **被测产物**（固定件）：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
  **sha16=`db7613632e37d99e`**（SHA256 `db7613632e37d99e053d5c5424117576c8a668130ebb736638c0dc03e223b06e`，188784128 B，11:43:39；每发探针的尺子卡均回打此值）
- §一~§三 的读数是**上一代产物 sha16=`81b39273efae31e5`**；两代之间的差异见六.2。
- ⚠️ **产物与源码已错位**：`dsh-markpilot/src-cm6/main.js` mtime **11:46:38** 晚于 asar 打包时间 **11:43:39** ⇒ 本节读数只对**这份 exe**成立，不代表当前源码树。
- **夹具**：`table-daily-out\pastevisual\doc.md` / `paste\doc.md`，124 B，sha16=`54b244c8579dfb8d`（同 §一）
- **尺子**：`table-daily-lib.cjs`；本次加固三处：`snap()` 一并取 **paste 事件载荷**（错-7①：终态与载荷同一次 evaluate）、`clipArm/clipPeek`、`pasteProof()`（见六.3）

### 六.0 剪贴板自证（未自证不出数）

| 通道 | 写入 | 独立进程回读 | 精确相等 |
|---|---|---|---|
| `Set-Clipboard` → 独立 pwsh 进程 `[IO.File]::WriteAllText(Get-Clipboard -Raw)` | ASCII 44 字 | 44 字 | **true**（字符码逐字相同） |
| 同上 | 多行 TSV 17 字（`T1\tT2\tT3\nT4\tT5\tT6`） | 17 字（LF 保留） | **true** |
| 同上 | 中文 7 字（`单行内容·哨兵`） | 7 字 | **true** |
| 同上 | 置空（反向对照） | 0 字 | **true**（尺子能分辨空/非空） |
| `clip.exe`（`… \| clip.exe`） | `MP-CLIPEXE-B-20261010` | 21 字 | **true**，**退出码 0**（先前报 `Access is denied`，不再出现） |

- 尺子伪影纠错留档：第一版自证用 `& pwsh … | Out-String` 回读，会把行尾统一成 CRLF 并补尾换行 ⇒ 看着"不匹配"，其实是**尺子**的问题（AGENTS「图上与数字对不上时先怀疑尺子」）。已改用文件式回读，并给 `clipWrite` 补 `回读为空` / `规范化后相等` 两条**诊断**字段（`match` 仍是严格相等，不放松）。
- 当时"回读为空"的根因：**会话锁屏**（写入返回 `ok`、回读长度 0 ⇒ 命中的正是尺子新加的 `回读为空=true` 这条诊断分支）；解锁后不可复现。
- 证据：`_table-daily-clip-selfcheck.log`、`_table-daily-clip-selfcheck2.log`、`table-daily-clip-selfcheck.ps1`、`table-daily-clip-selfcheck2.ps1`

### 六.1 粘贴项 P1–P6 复跑（每发都带载荷证明）

跑法：`node table-daily-paste.cjs "<exe>"`（1 次启动，`启动次数=1`，`外部中断=0`），日志 `_table-daily-paste-rerun2.log`，读数 `table-daily-out\paste\result.json`。

| # | 用例 | **新结论** | 关键读数 |
|---|---|---|---|
| P1 | 格内粘单行（正对照） | **通过** | 载荷=`单行内容`（相符）；`prevented=false`（交回默认）；`判据_落地=true`；`判据_结构未破=true`；一次 Ctrl+Z 回原状 `true` |
| P2 | 格内粘多行 TSV（任务书期望"扩行"） | **不成立（产品有意拒绝，与上一代同）** | 载荷=TSV（相符）；`prevented=true`；`判据_是否扩行=false`；`判据_文档未变=true`；`判据_结构未破=true`；toast「格内不支持多行粘贴（会把表格切开）—— 请粘到表格外」 |
| P3 | 格内粘含裸 `\|` 单行 | **通过（转义）** | 载荷=`左\|右`（相符）；`prevented=true`；`判据_转义=true`；第 7 行 `\| a左\\\|右1 \| b1 \| c1 \|`；`判据_结构未破=true`；toast「已转义为 \\\|」 |
| P4 | 表外（正文行首）粘 TSV | **通过（副作用已不复现）** | 载荷=TSV（相符）；`prevented=true`；`判据_新建表=true`；**`判据_原正文句是否还单独成行=true`**（上一代为 `false`）；文档 11→14 行；toast「已建成 2 行 × 3 列」 |
| P5b | **表行内（无覆盖层）粘 TSV** | **通过（劈表已不复现）** | 光标落点：真实 gutter 点击 → 行 5 列 0、`在表行=true`、无覆盖层；载荷=TSV（相符）；`prevented=true`；**`判据_渲染表行数不变=true`、`判据_行数不变=true`**（上一代双双 `false`）；管道数 `[4,4,4,4]` 不变（上一代 `[4,4,8,4,4,4]`）；toast 同 P2 那句 |
| P6b | 格内粘 HTML 表 | **通过（拒绝）** | 载荷=`H1\tH2\nH3\tH4`（相符，html=true）；`prevented=true`；`判据_文档未变=true`；`判据_结构未破=true` |
| P6c | 表外粘 HTML 表 | **通过（副作用已不复现）** | 载荷同上（相符）；`判据_建表=true`；新增行 `\| H1 \| H2 \|` / `\| --- \| --- \|` / `\| H3 \| H4 \|` 后接**独立成行**的「前置段落。」（上一代为 `\| H3 \| H4 \|前置段落。`）；toast「已建成 2 行 × 2 列」 |
| P99 | 终态 | **通过** | `判据_逐字节回原状=true`；`pageerror=[]`、`consoleError=[]` |

### 六.2 W1/W2 整屏视觉臂（本次补上；图我看过）

跑法：`node table-daily-paste-visual.cjs "<exe>"`，日志 `_table-daily-paste-visual-rerun2.log`，读数 `table-daily-out\pastevisual\result.json`。
**W1/W2 的图我都打开逐张看过**（不是只看数字）；截图裁 `.cm-content`（整块编辑面），并各配一张 before 图。

| # | 用例 | **新结论** | 关键读数 + 图上看什么 |
|---|---|---|---|
| W0 | 剪贴板自证 | **通过** | `match=true`；装弹第 2 次才成功（第 1 次回读被人抢占后重写） |
| W1 | 正文行里粘 TSV | **通过（"吞正文"不复现）** | 载荷=TSV（相符，一发即中）；`prevented=true`；`判据_建表=true`；**`判据_原正文句是否还单独成行=true`**、`判据_正文句没被并进表格行=true`；文档 11→14 行；toast「已建成 2 行 × 3 列」。图上：`w1-before.png` 是「前置段落。」独占一行；`w1-tsv-in-bodyline.png` 里新表 T1/T2/T3+T4/T5/T6 渲染在**上面**，「前置段落。」**仍单独成行**在表下，底部 toast 可见，状态栏 90 字 → 144 字 |
| W2 | 表行内（无覆盖层）粘 TSV | **通过（劈表不复现）** | 载荷=TSV（相符）；`prevented=true`；`判据_文档未变=true`、`判据_渲染表行数不变=true`、`判据_每行管道数不变=true`、`判据_原表头行是否被粘走=false`；管道数前后均 `[4,4,4,4]`。图上：`w2-before.png` 表格完好、光标在表头行（左侧可见 caret 与表格浮动条）；`w2-tsv-inside-tablerow.png` 表格**一字未动**，底部 toast「格内不支持多行粘贴（会把表格切开）—— 请粘到表格外」，状态栏**仍 90 字** |
| W1b/W2b | 各一次 Ctrl+Z | **通过** | `判据_回原状=true`（两发都逐字节回夹具） |

**判据有鉴别力吗**（错-12「绿灯的可信度」）：`node table-daily-judgement-selftest.cjs` —— 把**留档的两态真实文档**喂给探针里那一批判据：

| 态 | 文档行数 | 每行管道数 | `判据_每行管道数不变` | `判据_渲染表行数不变` | `判据_原表头行是否被粘走` | 第 7 行 |
|---|---|---|---|---|---|---|
| 红·修复前 `81b39273`（`_table-daily-paste.log` 09:18:58） | 13 | `[4,4,8,4,4,4]` | **false** | **false** | **true** | `\| T4 \| T5 \| T6 \|\| 甲 \| 乙 \| 丙 \|` |
| 绿·当前 `db761363`（本次复跑） | 11 | `[4,4,4,4]` | **true** | **true** | **false** | `\| a1 \| b1 \| c1 \|` |

W1/P4 那条（正文句被吞）同样两态可分：红态（P4 留档重建，行数与当时记录一致）→ `判据_原正文句是否还单独成行=false`、`判据_正文句没被并进表格行=false`，含「前置段落。」的那行是 `\| T4 \| T5 \| T6 \|前置段落。`；绿态（本次 W1 原文）→ 两条都 `true`，含「前置段落。」的那行就是 `前置段落。`。
⇒ 结论：**同一批判据在修复前/后分别给出"破损/完好"**，不是"探针压根测不出来"。

### 六.3 仍未验证 / 本轮新增风险（不猜、不硬出数）

1. **代码级突变验证我没做**（本角色对产品代码只读，且修复前产物 `81b39273efae31e5` 未留存 —— 全盘搜 `MarkPilot.exe` 无此 sha16）。我拿到的是**同尺子·跨产物两态**（六.2 表）+ 代码位置（`src-cm6/extras.js:3070-3100` 的 `inTableAt` 守卫与 `headNl/tailNl` 块级换行）。**要"注掉必须变红"的突变验证，得由能改产品代码的角色补做。**
2. **复制/剪切（copy/cut）方向本轮没测**：六.0 只证明了"写系统剪贴板 → 独立进程能读到"，**产品自己的「复制表格」落到剪贴板的内容**未逐字回读（`clipWrite` 走的是壳层同一条通道，可作旁证但不能替代）。
3. **多族并行抢占剪贴板是常态风险**：只要别的族还在写剪贴板，任何 Ctrl+V 类读数都可能被污染。**没有 `pasteProof()` 载荷证明的粘贴结论一律不算数**；建议族间约定"同一时刻只允许一个族用系统剪贴板"。
4. **产物与源码错位**（六.开头）：`main.js` 11:46:38 > asar 11:43:39，重组装后本节结论需重测。

### 六.4 复跑证据路径

- 自证：`_table-daily-clip-selfcheck.log`、`_table-daily-clip-selfcheck2.log`、`table-daily-clip-selfcheck.ps1`、`table-daily-clip-selfcheck2.ps1`
- 首跑（**被邻族污染，已作废、只作污染证据**）：`_table-daily-paste-visual-rerun.log`
- 复跑：`_table-daily-paste-visual-rerun2.log`、`_table-daily-paste-rerun2.log`
- 读数 JSON：`table-daily-out\pastevisual\result.json`、`table-daily-out\paste\result.json`
- 截图（7 张，W1/W2 各 before + after）：`table-daily-out\pastevisual\shots\{w1-before,w1-tsv-in-bodyline,w2-before,w2-tsv-inside-tablerow}.png`；`table-daily-out\paste\shots\{p2-tsv-in-cell,p4-tsv-outside,p5-tsv-in-tablerow}.png`
- 判据鉴别力：`_table-daily-judgement-selftest.log`、`table-daily-judgement-selftest.cjs`
- **红态原始记录**（修复前产物 `81b39273`，唯一一处）：`_table-daily-paste.log`（09:18:58，含尺子卡与 P4/P5b 全文读数）
- **`_archive\` 的来历要说清**（我核对过 mtime 与字段格式，避免张冠李戴）：
  · `paste-sha81b39273efae31e5\result.json` mtime=**11:44:22**、用例里还带老版 `粘贴事件` 字段 ⇒ 它是**老版探针在换代后（11:43:39 打包）跑的第二发**，读数是**绿态**，**不是**修复前的红态；它带尺子卡的运行日志才是 09:18 那一发（即上面的 `_table-daily-paste.log`）。留它是因为：**无载荷证明的第二套实现与我这次带载荷证明的结论一致**（交叉印证）。
  · `pastevisual-sha81b39273efae31e5\` 是我在复跑**启动之后**才拷的，`boot()` 已先清过目录 ⇒ 里面是**新发的在跑文件**，只有归档价值、**不能当红态证据**；那一发的真身是完整日志 `_table-daily-paste-visual.log`（09:20:35，记 W0 回读为空 + W·未验证）。
