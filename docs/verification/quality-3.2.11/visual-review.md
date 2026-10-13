# flash-common-final-review-3.2.11 — 独立验收者复核（视觉 ＋ 真实键鼠证据）

结论（终局）：**FINAL AGREED —— 322/322 通过，102 张实开图无一处与判据矛盾**。首轮（回归未跑完时）的
VISUAL REVIEWED / WAITING FOR FULL REGRESSION 记录保留在下方 §一~§三，作为当时的实际状态，不改写（§四 已换成终局核对）。
- 判定依据的注册表修订版：`.mp-verify/codex-audit/cm6-common-3.2.11-suites.json`，`passed=true`、16 套/322 项、
  `at=2026-10-11T23:02:08.703Z`，我重算的**注册表 SHA256 = `a5ce549ae0784e0aba7ad779b230d3256cf38c7176d0f4cdb8c7e8bfd25c8e90`**（130,460 B）。
- reviewed ASAR `0ea5ef6c394dc0b62bf7464b89cb4a4afe8bca07a94028a5f6e343131ac3dcf7`（7,534,868 B，我重算）
- runtime EXE `3cfaa172cfd79ba414e8118f330569894c7a1108ad6e02ae38422db0846b9f47`（188,779,520 B，我重算）
  两者都在 `…\cm6-common-final-source-3.2.11\unpacked\`（EXE 与 `resources\app.asar`），与终局 16 套全部 result.json 记录一致（首轮只比过其中 6 套）。
- 实际 opened frame 数：**102**（清单 102 条 → 按 sha256 去重 102 → 逐张用看图工具打开；整幅与 `-caret-2x` 分别打开）。
- 完整报告：`.mp-verify/codex-audit/cm6-common-3.2.11-suites.json`；图清单：`.mp-verify/codex-audit/common-final-review-3.2.11-images.json`；
  我的开图台账：`.mp-verify/codex-audit/goal-6h5/flash-common-final-opened-3.2.11.json`（每项 file/sha256/references/所见/是否有红光标）。

## 一、图上实际看到的现象（不是读字段）
1. 纵向进入＋紧接输入（14 臂，实开 28 张）：引用 `> Zx+y`、嵌套 `> > Zx+y`、单行 `$$Zx+y$$`、开闭行带正文 `$$Zx+`/`y$$`、多行正文、UTF-16 `Zx+\text{😀}` 全部是 **Z 落在正文 TeX 字符位**（前缀/围栏都没被推到行中），红标记紧贴 Z 右侧，下方渲染框同步成 `Zx+y`/`Zx+😀`；状态栏行/列与 JSON 选区逐一对上（例：quoted-down 行3/列4 = 源码偏移 13＋插入后 14；单行 `$$Z|x+y$$` 行2/列4 = 偏移 6）。
2. 行内公式正文粘贴：`PRE $x+Q$ POST` 里红标记在 Q 与收尾 `$` 之间（**没有**把 `$` 挤走、**没有**「已粘贴富文本」浮层），续写后 `PRE $x+QR$ POST`；HTML-only `<pre>␣␣Q\nR␣␣\n</pre>` 呈 `PRE $x+␣Q` / `R` / `$ POST` —— **前导两空格与内部换行原样保留、没有任何载体空行**（27 字）；`<em>` 粘贴在引用块内写成 `x+Q` 而不是 `*Q*`；跨公式臂才出现「已粘贴富文本」浮层（与范围声明一致）。
3. 查找返回：Ctrl+F/工具栏打开后 Find 框内 `KEEP` 原生蓝底全选＋琥珀聚焦环（**查找焦点可直接看见**）；Escape 返回后 K 格带蓝色焦点环、`KEEP|` 红标记是**字行高度、落在格文字上**（不是旧的行带高度），状态栏「行5/8·列9 选中4字」；紧接输入得到格内 `KEEPR`（行5/列10）。直接替换臂：`KEEP` 蓝底选区 → 替换后该格只剩 `R`（行5/列6）。Escape 关格臂：红标记回到源码行右缘、**无延迟重开**。
4. 跨格 `H|K`、separator `---`、半个转义 `\` 三臂：图上红标记是**整行带高度、贴表格右缘**，仍是原生 CM 焦点、无格 overlay（＝只保留原生范围与焦点归属，没被钳进格）。
5. 翻页后混合内容：键盘臂整篇选区（蓝底）连续覆盖多段＋渲染中的行内公式，状态栏「行116/列1 选中3252字」，选区止于 `READING_TAIL_32917`；剪切/替换/历史后新起 `CONTINUE_K_32917`（红标记在末）。反向拖拽臂 选中53字，起点红标记在 `M_BEGIN` 行首，三行含渲染公式与引用行被整体盖住；替换/历史后 `CONTINUE_M_32917`。
6. Shift 字形臂（selection-workflows 12 张）：`alpha $x+y$ omega` 里只有 head 所在的那一个行内公式展开源码、选区蓝底、行内渲染预览框仍在；Delete 后分别留下 `$ omega`、`alpha $`、`alpha $$`；math-workflows 双击臂 `alpha`→`ALPHA`（渲染字形保留）、拖拽臂（按下→12 次移动→抬起＋Shift+←×2 收窄）蓝底覆盖渲染字形。

## 二、图 ↔ JSON ↔ 代码 交叉核对（独立算过）
1. 台帐 102 项的 sha256 我自己从盘上重算：**0 缺失、0 不一致**，且 references 与主控清单**逐条相等**（校验输出 refMismatch=0）。4 张无红光标标记的正是 search `04-found`/`cell-02-after`（焦点在 Find 框），与 result.json limitations「Native INPUT caret geometry is not measured」一致。
2. 状态栏读数与 JSON 对得上：选中 53 字 = mixed-selection detail `payloadLength:53`；`READING_TAIL_32917`/`CONTINUE_*_32917` = 该套 `seed:32917`；`KEEPR` 行5/列10 = `|ab|KEEPR|` 内替换点；单行 `$$Zx+y$$` = result detail `contentFrom:6`。
3. 探针哈希链：6 个探针文件在我盘上的 sha256 **全部等于** result.json 记录值与 suites.json `sourceAndProbeHashes`（math-entry/math-paste/search 三套自带 probe 字段，mixed-selection/selection/math-workflows 三套靠注册表核对）。
4. 「立即输入前无探针插入等待/补焦点」我读了源码而非采信注释：
   - math-entry：`keyboard.press(entryKey)` 后**立刻** `insertText('Z')`，中间没有 wait/读帧/断言/重定位（L115–116）；进入证据来自 **keyup 捕获的同步快照**（文本、选区、焦点、event.isTrusted）——即"按键那一刻"的真实状态，而不是事后读数。
   - search 立即臂：`Escape` → `ArrowRight` → `insertText('R')` 之间所有 `waitUntil`/capture 都被 `arm.immediate` 跳过（L262/L276），随后用 **trusted 输入事件落在 `.mp-cell-overlay-text`** 做自证（L293），不是只看终态。
5. 五通道确实执行（真实渲染侧输入，非合成 DOM 事件）：键盘（math-entry/search 全部，`p.keyboard.press/insertText`）；鼠标（search 格与工具栏 `locator.click`、selection/math-paste 字形点击、math-workflows `mouse.click(...,{clickCount:2})` 真双击）；组合键（`Shift+End`/`Control+Shift+End`/`Ctrl+Z/Y/C/V/X`）；键鼠配合（`keyboard.down('Shift')`→`mouse.click`→`keyboard.up('Shift')`：selection-workflows L25–27、math-paste L112–114、math-workflows L97）；按下-移动-抬起拖拽（mixed-selection L141–143 十六步且断言 trusted `mousedown/mouseup/≥16 次带键 mousemove`；math-workflows L103–104 十二步）。
   **未覆盖**：native OS 键盘快捷键本身——三套 result.json 自己写明 `electronAcceleratorVerified=False` / "native menu accelerators not covered" / "Electron accelerators and physical OS input unverified"。本批只证明"渲染侧真实按键链"，**不能**声称 OS 菜单加速键已覆盖。
6. 突变（本批新增五组，非 3.2.10 的 12 组）：`math-entry`（11 vs 应 13）、`math-paste`、`html-fragment`（红侧多出载体 LF）、`cell-search`、`search-return`（红侧 R 掉到表后新行）。`workflow-mutations.cjs` 的红臂用 `fails+controls` 精确过滤并逐条断言 **非目标 controls 必须 pass、fails 必须按 oracle 正则红**（L143–150）；`greenAsar` 五组都等于我复核的冻结 ASAR；`restoredEngine` 等于六套共用的 `60b8939…`；字节级还原＝重新构建后 `build()===baseline`＋24 个身份文件逐一相等（L175–176、193）。**口径提醒**：`checkoutUnchanged` 指的是这 24 个身份文件未变，不等价于 `git status` 全树干净。

## 三、本批达不到/不该写成已修的（与主控声明一致，我如实记账）
1. cross-cell / separator / partial-escape：只看"原选区＋焦点归属保留"，result.json 自己标 `continuedEditCovered:false`；**不保证**这些选址能继续编辑。
2. F3、多范围搜索返回：本批没有用例（search 套只有 body/toolbar/cell/replace/encoded/ordinary/cross/separator/partial-escape/immediate 十臂）。
3. query INPUT 里"表格单词高亮"不是本批修复目标；我看到的 `04-found` 文档侧确无命中高亮，这与计划里的机制说明一致，**不作为新缺陷**。
4. mixed keyboard 是**整篇源码选择**（选中3252字），不能写成"局部跨页范围覆盖"。
5. 55 万字符引用回车**有专项用例**（更正我先前的"未覆盖"表述）：`cm6-common-3.2.11-worker-latency/result.json`（完整回归第 2 套）`pending-quote-enter-20-repetitions` 已 pass —— 555008 字符、20 次采样、first=133ms、steadyP50=108ms、steadyP95=123ms（fixture `latency-fixture.md` 555088 B，native/command fallback 记录在案，cleanup residual 为空）。**结论仍是"性能待优化项"**：该延迟量级对 55 万字符引用回车明显偏高，只是"已实测且判据通过"，不能写成"本批从未测"。performance 套的 7 档普通输入（≤10 万行/3.59M 字符、p95≈33ms）是**另一项指标**，两者不可互相替代。
6. search 的 FIND 输入框内光标几何未量（上面的 limitations），所以那 4 张 2x 只能证明"查找框聚焦"，不能当"格内光标"证据。
7. 台账小瑕疵（不影响判据）：math-workflows `mouse-02-replaced` 的 stages 在同一 case 里重复列了两次。

## 四、终局核对（我独立复算，不采信转述）
1. 注册表终局状态：`passed=true`、**16 套/322 项**、`anyFalse=0`、16 套 `exitCode` 全 0、16/16 套 `result.json` 都在盘上；SHA256 与时长见文首。回归期间注册表确实在增长（11 套 → 12/233 → 13/256 → 14/298 → 16/322），我按最后一次终局修订版判定。
2. 产物身份：盘上 `resources\app.asar` 与 `MarkPilot.exe` 我再次重算，仍是 `0ea5ef6c…` / `3cfaa172…`（长度、mtime 未变），与注册表 `artifact` 及各 result.json 记录一致 —— **全套 322 项跑的是同一个完整 ASAR**。
3. 源码/探针冻结：注册表 `sourceAndProbeHashes` 的 **81 个条目**我逐条从盘上重算，**0 缺失、0 变更**；6 个 workflow 探针的哈希链（result.json 记录值＝注册表值＝盘上值）全对。
4. 独立 build-check：`common-build-check-3.2.11/result.json`（23:02:55.934Z）`matches=true` —— app 重建＝签入 `60b89391077c8e2a0ccfe4fff969316b2488d12c13c59dee57ef5d0b34219878`（1,312,873 B）、worker 重建＝签入 `281c97bd645b87778bff2181be5b974deae5c1328c7fc4d6481d896f2e451c04`（63,411 B）；另：`sourceCommit=d360a37d6e50986e1f64371a315e8bb5ba10d5ca` 与我从工作树 `git rev-parse HEAD` 读到的一致。
5. 突变：`cm6-workflow-common-mutations-3.2.11/result.json` 5 组全部 `passed/checkoutUnchanged=true`，每组红 ASAR 各不相同、绿 ASAR 五组都等于冻结 ASAR、`restoredEngine=60b8939…`，非目标 controls 1–2 条/组均在红臂强制为 pass。
6. 台账时间戳校正：`flash-common-final-opened-3.2.11.json` 的 `at` 改为**实测钟表值** `2026-10-11T23:03:38.290Z`（本地 2026-10-12T07:03:38+08:00，取自 `new Date().toISOString()` 与 `Get-Date`），并注明它是"台账写入／核验时间"、不是图像采集时刻；初稿手填的 `07:10:00+08:00` 晚于真实钟表、属未来时刻，已在 `atCorrection` 里作废留痕（台账文件 mtime 07:00:40 与首轮报告 mtime 07:01:33 也一并记下）。

## 五、终局判定：FINAL AGREED
- **322/322 项全通过**（16 套），**102 张图实开**且无一处图上现象与 JSON 判据矛盾，**终局注册表 SHA256 `a5ce549ae0784e0aba7ad779b230d3256cf38c7176d0f4cdb8c7e8bfd25c8e90`**。
- **源／产物边界**：本次判定覆盖的是"冻结源码（81 项哈希）→ 受控构建 → 冻结 unpacked 产物（ASAR `0ea5ef6c…` ＋ 运行时 EXE `3cfaa172…`）→ 该产物上的 322 项真实 GUI 回归与五组突变"。**不含**装机态（未安装、未宣称已安装）、不含跨机复核、不含 native OS 菜单加速键路径。
- **已声明限制（随判定一并生效，不得当作已修）**：cross-cell／separator／partial-escape 仅证明原选区与焦点归属保留（`continuedEditCovered:false`），不保证继续编辑；F3 与多范围搜索返回无覆盖；query INPUT 里表格单词高亮不是本批目标；mixed keyboard 是整篇源码选择（3252 字），不是局部跨页范围；**55 万字符引用回车仍是性能待优化项**（专项已测已过：555008 字符、first 133ms、steadyP95 123ms）；search INPUT 光标几何未量（那 4 张 2x 只证明查找框聚焦）。
- **修订生效条件**：本判定绑定上述注册表 SHA 与产物哈希。若此后任一探针/源码再改、或注册表被重跑覆写，本结论对**新对象**失效，须重新核对（我不会沿用）。
- **未做也未被授权**：本次未安装、未打包实装；主控后续锁 SHA＋打包实装属另一个待验环节。
