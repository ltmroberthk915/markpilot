# 族：multi-window-daily（文件多开的日常序列 · 第二波普查）

**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
sha16=`15b8a1b699a0782e`（188,784,128 B，2026-10-10 10:50:34）—— 探针启动前用 `_probe-common.cjs` **断言并打印**，不符即 exit(9) 不出数。

**范围**：连开 3 个文件（`mpHost.openInNewWindow` 带参）→ 三个窗口各自编辑与 Ctrl+S 保存 → 关掉中间那个 → 全部关闭；全程核对「标题 / 脏标各自正确」。

**跑了两轮**（同一条命令、不同随机 run 目录与端口）：
`run-6k6kj`（11:04:20，ps1 修 `titleBefore` 之前）、`run-ihhvx`（11:06:22，修正后）。**两轮 9/9 用例判据逐条相同**。
另有一跑尺子自证 `diagargs-y4y78`（见下）。

**通道**：真实鼠标点正文（`page.mouse.click` 真实坐标）+ 真实按键（`page.keyboard.press/insertText`）+ `mpHost.openInNewWindow(path)`（**逐项对齐签名传参**）+ **WM_CLOSE**（＝点标题栏 X 的同一条 Win32 消息，可指认到具体 hwnd）+ Win32 标题轮询（35 ms，落 JSONL）+ 主进程 `main-debug.log`（MP_DEBUG=1）+ `tasklist`/`Win32_Process.CommandLine` + fs 直读磁盘。

---

## 一、用例与结论（9 条，**无"没反应 / 不符预期"项**）

| id | 用例 | 结论 | 关键读数 |
|---|---|---|---|
| S1 | 启动 1 个窗口 | 符合预期 | wcId=1、sessTotal=1、原生标题 `mwA-…md — MarkPilot`（无 ●） |
| M1 | 连开 3 个文件（带参） | 符合预期 | 3 窗口 wcId=1/2/3、docPath **各自**、文档头各自对得上、sessTotal=3、只有 1 个 isPrimary、原生标题 3 条且集合正确 |
| M2 | 三个窗口各自编辑 | 符合预期 | 三笔各 Δ=8 字；按键前 `activeInEditor=true`；每份文档**只含自己那一笔**（别人的标记 0 命中） |
| M3 | 三个窗口各自 Ctrl+S | 符合预期 | 三份磁盘各含本笔、**交叉命中 0**；标题与原生标题均无 ●；无横幅 |
| M3b | 脏标各自正确（两把尺子） | 符合预期 | 原生 35 ms 时间线：每笔只有本窗口出现 ●（别的窗口 0 次）；页内 30 ms：本窗口 17/18 个采样带 ●，别的窗口 0 |
| M4 | 关掉中间那个（B） | 符合预期 | WM_CLOSE 后 250 ms 窗口消失；剩 A/C 两条原生标题干净；渲染侧 2 页、sessTotal=2、sessIds=[1,3]；A/C 文档字节数未变 |
| M4b | 关掉一个之后幸存窗口还能用 | 符合预期 | A、C 各再落 9 字并 Ctrl+S 落盘，旧笔仍在，sessIds 仍 [1,3]，无横幅 |
| M5 | 全部关闭 | 符合预期 | 逐步关闭后原生窗口集合 `[]`；**500 ms 内进程整体退出**；tasklist 残留 0 |
| M6 | 主进程 trace 交叉印证 | 符合预期 | `newwin:trace` wcId=1/2/3（isPrimary true/false/false，sessionsBefore 0/1/2）；`newwin:created` 分别记了 B、C 的真实路径；`win:closed` remaining=2,1,0；`file:save` 10 行，每行只碰自己那份文件 |

**pageerror：0**（三个窗口全部挂了监听）。**页面崩溃：0**。
**CDP 断开：1 次**，相位 `M5-close-all` —— 应用在最后一个窗口关闭后自行退出导致，判读「预期」，不是崩溃。
**残留进程：0**（按命令行里的唯一 run 标记复查，两轮都是 0）。

## 二、两个观察项（**未判为缺陷**，但读数值得记账）

1. **CDP 通道下 Ctrl+W 无反应**：`run-ihhvx` M4-pre 读数 —— 按 Ctrl+W 前 3 条原生标题（含 B），按后 1.6 s 仍是那 3 条，B 还在。
   机制（代码位置）：`关闭窗口` 只挂在应用菜单加速键上（`main.js:449` `CmdOrCtrl+W`）；引擎自己的快捷键表里没有 close（`app.js` 的 `oe()` 表＝bold/italic/code/quote/list/save/outline/export），而 CDP 注入的键进不了 Electron 的加速键体系（仓内既有实测，见 `preload.js` 的 `recentTestSendKey` 注释）。
   ⇒ **不能**判成"Ctrl+W 失效"；真人是 OS 级按键走加速键。→ 记 U1 未验证。
2. **不带参的 `openInNewWindow()` 会静默打开"主会话那个文件"**：尺子自证跑（`diagargs-y4y78`）里，新窗口 docName/docPath 与主窗口**完全相同**（两条原生标题也一模一样），两窗口 sessTotal=2。
   这条回退是设计内的（`main.js:837` `openInNewWindow(p || state.filePath || null)`）；记读数，不判缺陷。**它的价值在于**：这正是 AGENTS 错-7 ② 里"漏参被读成新窗口载入了目标文件"的坑，本族主探针 M1 对它有鉴别力 —— 见下。

## 三、尺子自证（本波禁止改产品代码，故用探针侧突变代替产品侧突变验证）

`multi-window-daily-diag-args.cjs` 故意复现错-7 ②：**不传参**调 `openInNewWindow()`。结果：

| 主探针 M1 的判据 | 在这一态下的结果 |
|---|---|
| `docPath === 目标文件(B)` | **false（变红）** |
| `docName ∈ {B,C} 且不是主会话文件` | **false（变红）** |

⇒ M1 的绿灯有鉴别力：漏参会双双变红，不会被读成"新窗口载入了目标文件"。
（说明：本波纪律明令 `src-cm6/`、`MarkPilot-CM6/` 只读，**未做产品侧突变验证**；产品侧结论均为"同一条命令两轮复跑一致 + 两条独立尺子同结论"。）

## 四、未验证项

| id | 项 | 为什么未验证 |
|---|---|---|
| U1 | 键盘/菜单关窗（Ctrl+W、「文件 → 关闭窗口」）能否关掉"中间那个" | 见观察项 1；需解锁桌面用真实按键复验 |
| U2 | 脏窗口被关时的「保存并退出/不保存/取消」原生对话框 | 需真实桌面点击；本序列每个关窗点都先 Ctrl+S 落盘（原生标题无 ● 为证），全程未触发它 |
| U3 | 新窗口是否被系统置于前台 / Z 序 / 任务栏分组 | 锁屏态无真实前台窗口（`GetForegroundWindow` 属安全桌面），不可判 |
| U4 | SendInput 真点标题栏 X（而非 WM_CLOSE） | 需接管鼠标，本任务未授权；WM_CLOSE 与 X 是同一条消息 |

## 五、环境与尺子卫生（本轮实测到的两个坑，已规避）

- **工作站锁屏**（LogonUI 在跑）：系统剪贴板全线不可用；本族不碰剪贴板，故不受影响。
- **该产物首启会把上一代 profile 播种进新的 `--user-data-dir`**（`profile/migrated-from-cm6.txt`；`settings.json`/`recents.json`/`main-debug.log` 连旧 mtime 一起带过来 —— 实测日志首行是 `2026-10-06`）。
  ⇒ 本族所有日志读数**按启动时间戳切**（`logAfter(T_LAUNCH)`），绝不把历史行当本次证据。
- 原生窗口尺子按 **pid** 限定（首跑用 `pid=0` 全桌面扫描按唯一夹具名反查归属 pid，再全程按该 pid 读），不碰并行普查里别的族的实例。

## 六、证据文件

**探针与尺子（.mp-verify\checklist\，族名前缀，互不冲突）**
- `multi-window-daily-probe.cjs`（主探针，9 用例）
- `multi-window-daily-win.ps1`（本族唯一原生尺子：list / watch 35 ms / close+回读）
- `multi-window-daily-diag-args.cjs`（尺子自证）
- `multi-window-daily-smoke.cjs`（启动范式冒烟，先证通道再写普查）

**读数（.mp-verify\multi-window-daily\）**
- `run-ihhvx\result.json`（本轮全量读数，含每个用例的判据与细节）
- `run-ihhvx\profile\main-debug.log`（主进程一手 trace）
- `run-ihhvx\native-title-timeline.json`、`title-timeline-page.json`（两把标题/脏标尺子的原始时间线）
- `run-ihhvx\native-title-timeline.jsonl`（原生 35 ms 采样原始 JSONL）
- `run-ihhvx\out-*.json`（每次原生读数的原始返回：list / close）
- `run-ihhvx\shots\S1-A.png`、`M1-mw{A,B,C}-ihhvx.md.png`、`M4-mw{A,C}-ihhvx.md.png`（CDP 截图；注：CDP 拍不到原生标题栏，标题证据在 Win32 时间线里）
- `run-6k6kj\result.json`（第一轮，判据逐条相同）
- `diagargs-y4y78\diag-args.json`（尺子自证读数）
