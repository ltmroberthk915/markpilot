# 族报告：control-chars（控制字符与行尾 · 第三波真实用户操作普查）

**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**sha16 = 1b4e32a2263fcbe6**，188 784 128 B（每支探针启动即打印尺子卡；`_probe-common.cjs` 在设了 `MP_EXPECT_EXE` 时不一致即 exit(9)）
**随包载荷**：`dist\win-unpacked\resources\app.asar` sha16 = `bd172e68f484e69c`，2 657 225 B，mtime **12:25:47**（＝在我全部探针启动之前就冻结；结束时复核未变）。本会话里 `renderer\host.js`(12:54)、`renderer\cm6\app.js`(12:54) 被**别的队友改过源码/包体**，但**没有重新打包** ⇒ 本族 7 次探针运行读到的都是同一份装机载荷（每次运行的尺子卡都记到 `1b4e32a2263fcbe6`）
**启动范式**：照抄既有探针 —— `spawn(exe, [夹具, --remote-debugging-port=随机空闲口, --user-data-dir=独立])` + `MP_DEBUG=1 MP_TEST_HOOKS=1 MP_TEST_NO_DIALOG=1` + `delete ELECTRON_RUN_AS_NODE` + `playwright-core connectOverCDP`；`findPage` 断言 `docInfo().filePath` 命中本次夹具（不是默认回退值）
**用例数**：**20**（P1=4 / P2=7 / P3=4 臂 / P4=3 / P6=2），全部跑完；本族 profile 残进程 **0**（`tasklist` 复核）
**纪律**：只在 `.mp-verify\` 写文件；**未改一行产品代码**；每条结论都带读数或截图；判断"写没写盘"以**磁盘字节**为准
**时间范围**：以下读数**当时（2026-10-10 12:30–13:25）如此**；第二波 file-ops 族的产物是 sha16 `15b8a1b699a0782e`，**与本波不是同一份产物，跨波读数不可直接比**

**通道声明**

| 动作 | 通道 |
|---|---|
| 打开文件 | `spawn` 时把夹具作为 argv（＝用户双击那个文件）；另有一支走裸 spawn（不连 CDP） |
| 粘贴 | **系统剪贴板四步**：① 独立 pwsh 进程 `Set-Clipboard` 装弹（载荷走 base64，不碰代码页）→ ② **另一个**独立 pwsh 进程 `Get-Clipboard -Raw` 回读 → ③ `page.keyboard.press('Control+v')`（按前断言 `document.hasFocus()` 且 `activeElement=DIV.cm-content`）→ ④ 再回读 |
| 粘贴归属 | 页面内 `paste` 事件见证器（`clipboardData.getData('text/plain')` **＝按键那一刻浏览器交给编辑器的内容**，零竞态）＋ 文档末尾逐字符比对 |
| 输入 | `page.keyboard.type/insertText/press`、`page.mouse.click`（CDP Input.*）；键鼠配合＝真实按下 Shift → 真实点击 → 抬起 |
| 保存 | 真实 `Ctrl+S`；**落地断言**：按后在壳层 `main-debug.log` 里等一条**属于本夹具**的 `file:save` 新行（计数比对），没落地就重按（≤3 次）。打字路径另有 500 ms 去抖自动保存 |
| 磁盘判据 | 逐字节计数：`crlf / lfOnly / crOnly / bom / nul / esc / bel` + sha16 + head/tail hex |
| 原生框 | 复用 `win-file-ops-win.ps1`（枚举/关框）与 `dragdrop-files\dlg-dump.ps1`（读 #32770 标题＋子控件文本） |

---

## 一、没反应 / 行为不符预期（3 项）

### C1 自己保存的文件，自己打不开：NUL 落进前 4 KB ⇒ 被自己的二进制嗅探拒读
壳层口径（`main.js:205-222`）：`readDoc` 对**前 4 KB 含 NUL**的文件一律当二进制拒绝。实测这条链**完全由真人操作可达**：

| 步 | 真人动作 | 读数 |
|---|---|---|
| 1 | 双击打开 `f7-deep-nul.md` | 4419 B，首 NUL 在**偏移 4414**（4 KB 之外）⇒ **正常打开**；引擎读数 `docLines=13`、控件表 `{0:1, 10:12}`（NUL 就在文档里） |
| 2 | 真实鼠标点第 1 行 → 按住 Shift 真实点第 5 行 → `Delete` | 选区 `from=0 to=1604`（len 1604，活动行类 `cm-line cm-activeLine`）；删后 `docLen=2811`，NUL 字符下标 **2808** |
| 3 | `Ctrl+S` | 磁盘 2815 B，首 NUL **偏移 2810**（< 4096）、`lfOnly=8`；壳层 `file:save` 落地 |
| 4 | 再打开这个文件 | 壳层一手记录：`readDoc:binary-refused {"head":[65,65,65,…]}` + `openPath:error 这是一个二进制文件…`；**原生框弹出**；窗口里是 `未命名 — MarkPilot`、`docLen=0`、无提示条 |

- 同一形态在另一支里用 `Input.insertText` 把 NUL 送进文档后复现（磁盘 60 B，NUL@55）：`p1\control-chars-3-cc-paste.json`
- 用户可见后果：**存过之后这个文件再也打不开**，而应用给出的解释是"这是个二进制文件（图片/压缩包/可执行文件等）"，与真实情况（自己的文本里有个 NUL）不符
- 佐证（对照臂，证明拒读的判据就是 NUL 而不是 ESC/BEL）：`cc-esebel.md`（含 ESC+BEL、**无 NUL**）打开→改字→保存→**再打开照常接受**，文档里 ESC/BEL 各一个

### C2 "什么都不改，随手按一下 Ctrl+S" 会重写磁盘；混合行尾 / 只有 CR 的文件被静默归一
P4 分四段独立观察（段间用 `watchDisk` 带基线比对），三个夹具**同形**：

| 夹具 | 段1 纯空转 4s | 段2 只读读数后 4s | 段3 第 1 次 Ctrl+S | 段4 第 2 次 Ctrl+S | 写盘后字节 |
|---|---|---|---|---|---|
| G1 BOM+LF（33 B） | 0 次变化 | 0 次 | **落地并写盘**（mtime 变） | **又写一次** | 与打开前**逐字节相同**（BOM 保住） |
| G2 混合行尾（52 B，3 CRLF+2 LF） | 0 次 | 0 次 | **落地并写盘** | **又写一次** | 54 B：`crlf=5, lfOnly=0` ⇒ **全部变 CRLF** |
| G3 只有 CR（35 B，3 CR） | 0 次 | 0 次 | **落地并写盘** | **又写一次** | 35 B：`crOnly=0, lfOnly=3` ⇒ **CR 全变 LF** |

- 判据不是"看 mtime 猜"：每次按键都在壳层日志等到**属于本夹具**的 `file:save` 新行（P4 三夹具 6/6 落地），再读字节
- P2 的 7 个夹具同形：不改动保存后 F4（3 CRLF+2 LF）→ 54 B 全 CRLF、F5（2 CRLF+3 LF）→ 49 B 全 LF、F6（3 CR）→ `crOnly=0`、F1/F2/F3/F7 字节不变
- 用户可见后果：**混合行尾的文件，用户只是打开看了一眼、按了下 Ctrl+S，整篇行尾就被统一**（版本库里表现为整个文件被重写）；"只有 CR"的老文件同一次操作后行尾全部变成 LF
- 口径说明：多数派归一（`crlf >= lf - crlf` 才算 CRLF）是**代码里写明的设计**（`main.js:226-229`），本族只给现状读数与后果，**不等于缺陷**；"Typora 会不会这么做"未对拍（见未验证 6）

### C3 拒读时的原生框：标题实测 `Error`（代码里写的是「打开失败」）；正文读不到
- `#32770` 标题读数 **`Error`**（两次不同夹具、两次独立运行都一样）；代码位置 `main.js:591` `dialog.showErrorBox('打开失败', …)`
- 子控件枚举只拿到 `DirectUIHWND`（空文本）与 `Button 确定` ⇒ **用户看到的中文正文本次没读到**（另见未验证 1）
- 自动化口径对照（`MP_TEST_NO_DIALOG=1`）：**连框都不弹**，窗口只是个空的 `未命名 — MarkPilot`（`docLen=0`、无提示条）——用户侧无任何解释
- 另：模态框在场时 **CDP 连不上**（`connectOverCDP` 45 次重试全失败，实测报 `CDP 连不上（port=16512）`）⇒ 该臂改为裸 spawn + 裸 Win32 取证

---

## 二、正常路径的阳性读数（简表）

| 用例 | 结论 | 关键读数 |
|---|---|---|
| P1-CC-1 ESC+BEL 粘贴 | **四步全齐、逐字节落地** | 装弹回读＝载荷；paste 见证＝载荷（14 码含 `27,7`）；按后回读仍＝载荷；文档 `ESC=1 BEL=1`，`docLen 13→27`；磁盘 39 B `esc=1 bel=1`，tailHex `…432d411b4207432d454e440a` |
| P1-CC-1 视觉 | 控制字符**渲染成红色占位符**（截图已看：`AAMPCC-A`＋红 `ESC`＋`B`＋红 `BEL`＋`C-END`） | `p1\shots\CC-1-esc-bel-line.png` |
| P1-CC-2 NUL 经系统剪贴板 | **平台在首个 NUL 处截断**（不是应用的问题） | 16 字符载荷回读成 10 字符 `MPCC2-NUL[`（独立进程回读＋paste 见证一致）；文档 `Δ=10`、`NUL=0`；磁盘 `nul=0` |
| P1-CC-3 NUL 经 `Input.insertText` | NUL 能进文档并落盘（**该通道不经过剪贴板，不代表用户能粘进 NUL**） | `Δ=11`、文档 `NUL=1`；磁盘 60 B、`NUL@55` |
| P2-F1 BOM+LF | 读时剥 BOM、写时补回 | 打开后文档 `ctrl 表 {10:3}`、**无 U+FEFF**；保存后 `bom=true`、headHex `efbbbf…`、内容一字不差 |
| P2-F2 无 BOM（对照臂） | **不凭空加 BOM** | 保存后 `bom=false` |
| P2-F3 CRLF | **行尾保持** | 4 个行尾全是 CRLF（`crlf=4, lfOnly=0, crOnly=0`），改字保存后仍 CRLF |
| P2-F4/F5 混合行尾 | 按**多数派**统一（设计如此） | F4 → 全 CRLF；F5 → 全 LF |
| P2-F6 只有 CR 的老文件 | **显示正常**（不是一整行怪字符） | 打开即 `docLines=4 / renderedLines=4`、文档 `ctrl 表 {10:3}`（CR 已被引擎当换行）；保存后磁盘 `crOnly=0` |
| P2-F7 深 NUL 文件 | NUL 在 4 KB 之外时**可以正常打开** | `docLines=13`、`{0:1, 10:12}` |
| P2 全部 7 个夹具 | **磁盘解码（剥 BOM、CRLF→LF）后与引擎文档逐字符相等**（无丢字/多字） | `④一致性 = true` ×7 |
| P2/P4 空转 | **应用不会自己动盘** | 空转 1.6 s / 4 s / 6 s 全部 `变化次数=0` |
| P6 ESC/BEL 无 NUL 文件 | 打开→保存→**再打开照常**，ESC/BEL 仍在 | 5/5 判据通过，无原生框 |

---

## 三、pageerror / 崩溃 / 收尾

- 全部 6 支探针 `pageerror` **全为 `[]`**；无 `crash` 事件（`PAGE_CRASH` 未出现）
- 每支结束 `tasklist` 复核：本族 profile 的 MarkPilot 进程 **0**；`Get-CimInstance` 按命令行过滤 `control-chars` 的残留 **0**
- 壳层一手记录与渲染侧一致（`readDoc:binary-refused` / `openPath:error` / `file:save` 时间戳与磁盘 mtime 对得上）

---

## 四、环境阻断与尺子修正（都保留了原始读数）

1. **剪贴板被别族抢占（错-13 现场）**：本机同时有 cross-window-clipboard 族的探针在写同一块剪贴板。实测抢占值：`MP-WC-SENT-70576-1-chzz`、`MP-WC-SENT-70576-2-qytb`、`MP-WC-SENT-70576-3-lig0`、`V1\nV2\nV3\nV4`、`xy`、`季度报告…`。处置：装弹回读带重试（`clipArm` 记录每次 attempt），并引入 **paste 事件见证器**把"按键那一刻的剪贴板内容"钉死；`CC-1` 最终 **第 1 次尝试四步全齐**
2. **不改动保存的"落地"必须断言**：本机 rename 偶发 `EPERM`，失败时磁盘一字不动。物证（壳层日志原文）：`p5\H2\profile\main-debug.log` 里 `05:00:09.892 file:save:error … EPERM … rename '…\.h2-mix.md.mp-tmp-97088' -> '…\h2-mix.md'`，3.3 秒后同一条路 `05:00:13.167 file:save … "bytes":54` 成功。**成因未验证**（不排除杀软/索引器持有新写的 tmp）；这与第二波 file-ops 族 F4（原始英文 libuv 错误直接给用户看）同形，**不重复计为本族新缺陷**
3. **尺子修正（保留原文，就地标注）**：`control-chars-5.cjs` 与 P4 的第一版用"窗口内自己跟自己比"的观察函数计数 ⇒ 落盘若发生在**第一个采样点之前**就被记成 `变化次数=0`，于是 P4 首版给出"段3 没写盘"的读数，与 P2 的 `waitDisk`（按前状态比对）冲突。**该读数作废**，原文与 stdout 保留在 `p5-stdout.txt` / `p4-stdout.txt`；修法是把观察函数抽成 lib 里的单一实现 `watchDisk(p, ms, {baseline})`（与基线比 + 与上一采样比取或），修好后 P4 三夹具 6/6 落地并写盘（见 C2）。修好前那次 P4 复跑的"首按全部 EPERM、二按成功"也保留在案
4. **模态框会把 CDP 挡在门外**：`dialog.showErrorBox` 在场时 `connectOverCDP` 连不上（实测 45 次重试全失败）⇒ P3 臂 A 完全不依赖 CDP，只用原生窗口＋壳层日志

---

## 五、证据文件

探针源码（`.mp-verify\checklist\`，文件名均以族名开头）：
`control-chars-lib.cjs`（共用尺子：字节尺/观察窗/一次拿全/剪贴板四步/见证器）、`control-chars-clipcheck.cjs`（剪贴板尺子体检）、`control-chars-1.cjs`（粘贴）、`control-chars-2.cjs`（BOM/行尾矩阵）、`control-chars-3.cjs`（再打开被拒，两臂）、`control-chars-4.cjs`（不改动 Ctrl+S 分段归因）、`control-chars-5.cjs`（**尺子有缺陷的版本，保留为过程证据**）、`control-chars-6.cjs`（纯 ESC/BEL 文件来回）

原始读数与截图（`.mp-verify\control-chars\`）：

| 内容 | 路径 |
|---|---|
| 剪贴板体检（6 载荷，含 NUL 截断） | `clipcheck.json`、`clipcheck-stdout.txt` |
| P1 粘贴/落盘/见证器四步 | `p1\control-chars-1.json`、`p1-stdout.txt`、`p1\shots\CC-1-esc-bel-line.png` |
| 落盘后的夹具（物证仍在盘上） | `p1\cc-paste.md`（60 B：`esc=1 bel=1 nul@55`） |
| P2 七个夹具四拍读数 | `p2\control-chars-2.json`、`p2-stdout.txt` |
| P2-F7 深 NUL 夹具（2815 B，`nul@2810`） | `p2\F7\f7-deep-nul.md` |
| P3 再打开被拒（cc-paste / f7-deep-nul 各两臂） | `p1\control-chars-3-cc-paste.json`、`p2\F7\control-chars-3-f7-deep-nul.json`、`p3-stdout.txt`、`p3-F7-stdout.txt` |
| P4 分段归因（含落地断言） | `p4\control-chars-4.json`、`p4-stdout.txt` |
| P5 尺子缺陷版原始读数（作废但保留） | `p5\control-chars-5.json`、`p5-stdout.txt` |
| EPERM 物证（壳层日志原文） | `p5\H2\profile\main-debug.log` |
| P6 纯 ESC/BEL 文件来回 | `p6\control-chars-6.json`、`p6-stdout.txt` |

---

## 六、未验证 / 环境阻断

1. **原生错误框的正文文本**：未读到（子控件是 `DirectUIHWND`，`GetWindowText` 返回空，只枚举到 `确定` 按钮）⇒ 只能确认**标题是 `Error`**，不能确认用户看到的中文正文是什么样
2. **NUL 有没有别的真人可达通道**：未验证。系统剪贴板（CF_UNICODETEXT）实测在首个 NUL 处截断；来自浏览器/终端/十六进制编辑器的其他格式（CF_HTML 等）没测
3. **NUL 落进 4 KB 窗口的其它路径**：只测了"删掉前部"这一条（还有"另存为到别处""外部程序截断文件"等未测）
4. **混合行尾的边界**：只构造了 3:2 与 2:3（多数派明确）；**1:1 平分**时取向未测
5. **另存为（Save As）对 BOM / 行尾的保留**：未测（属 file-ops 族范围）
6. **与 Typora 实机对拍**：未做。"混合行尾按多数派统一""CR-only 转 LF""不改动 Ctrl+S 也重写"这三条的"应该怎样"以 Typora 使用习惯为准，本轮只给现状读数与后果
7. **阅读模式 / 导出 PDF / 复制到外部**路径下的控制字符表现：未测（本族范围只到编辑与落盘）
8. **`Error` 这个标题为什么不是「打开失败」**：未查到成因（只给了代码位置与两处实测读数），不作推断
