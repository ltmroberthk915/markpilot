# theme-switch 族 · 普查报告（第二波·真实用户日常操作）

- **族名**：theme-switch（主题切换：浅 / 深 / 护眼米黄 / 社区主题；闪烁、滚动与光标、工具栏与状态栏配色、切换后立刻打字）
- **被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`，188784128 B，**sha16=15b8a1b699a0782e**（每次启动先断言，不符 exit 9 拒出数）
- **夹具**：`theme-switch-out\main\doc.md`（18464 B，sha16=6bfa8d61bcad2df3，8064 字 / 622 行，每次运行重建）；重启臂 `theme-switch-out\restart\doc.md`（sha16=e420b1c09a79f352）
- **用例数**：**21 个用例 / 91 条判据**（主探针，全绿）＋ 重启臂 **3 臂 / 9 条判据**（5 绿 4 红，红的是同一个缺陷的两面）＋ 2 支诊断探针；共 **17 次应用启动**（主探针 4 发、重启臂 2 发×4、诊断 3 发、冒烟 2 发）、**31 张截图**
- **输入通道**：一律真实键鼠（`page.mouse` / `page.keyboard` ⇒ CDP `Input.*`）——工具栏按钮点 rect 中心；主题弹层逐项真实点击；关窗用 `taskkill /PID`（WM_CLOSE，不用 /F）

## 一、三把尺子（同一现象不同源，各自的数不互比）

| 尺子 | 量什么 | 本族读数规模 |
|---|---|---|
| ① 渲染侧逐帧 | 一次 `evaluate` 内 rAF＋10ms 定时器采计算样式（主题账 / `--mp-*` / body / 工具栏 / 状态栏 / 编辑面 / 正文色） | 每次切换 **128 帧**（raf 48 ＋ iv 80） |
| ② 合成器出图帧 | CDP `Page.startScreencast` 收真实出图帧 → 按字节哈希归并 → **在页面内解码每帧 JPEG**、取指定 CSS 坐标的像素 | 每次切换 13~16 帧、11~12 个不同哈希 |
| ③ 截图逐点像素 | `Page.captureScreenshot` → 交给页面 `Image`+`canvas` 读像素（2058×1253，dpr 1.75） | 每次 4 点（正文左/右纸面、工具栏、状态栏） |

判据口径都是**用户能看见的性质**：一次切换里"画面上出现过的配色状态"只允许有切换前与切换后两种；账面（dataset）与画面（像素）不许脱节；工具栏/状态栏底色必须与纸面同帧同源。

## 二、范围逐条结论

| # | 范围项 | 结论 | 关键读数（最终状态口径） |
|---|---|---|---|
| 1 | 工具栏「切换明暗」浅⇄深 | **成立** | 深→浅：`theme telari-dark→telari-light`、`bodyBg rgb(31,33,38)→rgb(255,255,255)`、纸面像素 `#1f2126→#ffffff`（左右两处都白）、图标 `data-mp-dark-now 1→0`（太阳→月亮）、标题 `切换到深色模式（当前：浅色）`；账同源 `lsTheme=telari-light / lsDark=false` |
| 2 | 切换闪烁（有没有中间态） | **不闪（成立）** | ①状态序列只有 2 条（t≈11ms 前 / t≈170ms 后），**中间态帧 0、失配帧 0、表面滞后帧 0**，落定 171~180ms；②合成器逐帧像素：纸面色序列 `["#1f2229","#ffffff"]`（JPEG 量化偏移）、左右两侧**同帧翻**；③最低对比度 10~11.5（文字全程可读） |
| 3 | 滚动位置保持 | **成立** | 工具栏路径：`scrollTop 2674.29 → 2674.29`（Δ0）；菜单路径：`2895.43 → 2895.43`（Δ0） |
| 4 | 光标位置与可见性保持 | **成立（视觉位置零位移）** | `head 1466→1466`、`caret left/top 193.1/405.8` 逐项相同（Δleft=0 Δtop=0）、光标盒 `1.7×13.7 @(192.5,405.8)` 切换前后完全相同并在视口内 |
| 5 | 工具栏配色跟着走 | **成立（9/9 套）** | 底色=`color(srgb …bg… / 0.76)` 与纸面同 rgb，边框=该套 `--mp-border`，按钮字色=该套 `--mp-fg`（如 GitHub 深色：`tb=0.0508/0.0667/0.0902`、边 `rgb(33,38,45)=#21262d`、按钮 `rgb(201,209,217)=#c9d1d9`） |
| 6 | 状态栏配色跟着走 | **成立（9/9 套）** | 底色同上；字色=该套 `--mp-muted`（`rgb(139,148,158)=#8b949e`）、选中项=该套 `--mp-primary`（`rgb(88,166,255)=#58a6ff`）、缩放徽标=该套 `--mp-fg`；像素点读回 `#959ca3`（浅色态状态栏文字） |
| 7 | 9 套配色逐一点（含护眼米黄 / 社区配色） | **成立（9/9）** | 9 套的实测 `bodyBg`/编辑面底色/工具栏/状态栏 == 独立期望值：`telari-dark #1f2126`、`telari-light` 与 `notion-light #ffffff`、`notion-dark #191919`、`solarized-dark #002b36`、`solarized-light #fdf6e3`、`github-dark #0d1117`、`sepia-light #f7f1e3`、`green-light #e5eee2`；其中 4 套（宋韵深/护眼米黄/GitHub 深/柔和淡绿）另取**截图像素**逐点核对，全部相符；账三方同源（dataset==localStorage==按下的一套） |
| 8 | 弹层「当前」是否跟画面一致 | **成立** | 每次开菜单前「当前」都落在上一套（如点 Solarized 深之前标记=`Solarized 浅浅 · 当前`）；9 次都对；读完后重新开菜单：`柔和淡绿浅 · 当前` == 画面 `green-light` |
| 9 | 切换后**立刻**打字（工具栏路径） | **成立** | 点击→打字 **9ms**、打完 22ms：`docLen 8064→8065`、`head 154→155`、光标行文本 `Z`、焦点 `inEditor=true / viewHasFocus=true`；一次 Ctrl+Z 回到 8064 |
| 10 | 快速连点 5 次 | **成立** | 终态 `telari-dark`：账/画面/图标三方一致、无 pageerror |
| 11 | 社区主题（Typora .css）安装 | **成立**（走产品核心 `installTyporaThemeFromText`；文件选择那一步见 §三.5） | `data-mp-user-theme=1`、`当前：konayuki-test`、纸面像素 `#2b2b2b`、正文字体变 `Georgia, "Times New Roman", SimSun…`、代码块底 `rgb(51,51,51)` |
| 12 | 社区主题「移除」 | **成立**（真实点击：更多→设置→滚动→移除） | `ut=null`、`当前=null`、`lsBytes=0`、纸面/工具栏/状态栏全部回到当前调色板（`#ffffff`）＋ toast「已移除主题「konayuki-test」」 |
| 13 | 重启后是否还是我选的那套 | **不成立（见 §三.2）** | 3 臂：宋韵浅色 ✔ 保持；护眼米黄 → 变宋韵**浅**色；GitHub 深色 → 变宋韵**深**色；两臂都把 `localStorage['editor-theme']` 改写成 `telari-*` |

## 三、没反应 / 行为不符预期的项

### 1. 从「主题」菜单选配色后，接着打字会被**吞掉**（工具栏路径不吞）
- 用例 B3（真实点击菜单项 → 0ms 后打字）：点完菜单项那一刻 `active=BODY`、`viewHasFocus=false`、`cmFocused=true`；打 `Q` 后 `cmFocused=false`、**`docLen 8064→8064`（一个字符都没进文档）**、`head` 不动、`cursorDom` 由 `1.7×15.4@(171.5,401.2)` 变 **`0×0`（光标消失）**；页面确实收到了按键（`__keyLog` 尾部 `["Control","z","Q"]`）。
- 对照（同源同类）：工具栏路径 B2 同一夹具同一时刻 `docLen 8064→8065`、`head 154→155`、字符落在光标处。
- 根因形态：工具栏按钮的 `mousedown` 里 `preventDefault()`（`toolbar.js:343`）保住了编辑面焦点；弹层项只有 `onclick`（`extras.js:2493` → 无 preventDefault），点非可聚焦 `div` 时 Chromium 把焦点移到 `body` ⇒ CM6 `hasFocus` 转假，后续按键不再进编辑器。
- 用户可见后果：选完主题想接着写字，"敲了没反应"，得先点回正文一下。

### 2. 除「宋韵 深/浅」外，任何配色**重启后都会退回宋韵**（并把用户的选择改写成宋韵）
- 用例 R-*（同一 profile、优雅关窗、带落盘见证）：每一臂点完都当场生效（`#f7f1e3` / `#0d1117`），**关窗前 leveldb 里确实有该值**（`000003.log` 命中 `sepia-light` / `github-dark`，`found=true`），重启后：
  - 宋韵 浅色 → 仍是 `telari-light`（`#ffffff`）✔
  - 护眼米黄 → **`telari-light`**（`#ffffff`）；`lsTheme` 由 `sepia-light` 变 `telari-light`
  - GitHub 深色 → **`telari-dark`**（`#1f2126`）；`lsTheme` 由 `github-dark` 变 `telari-dark`
  - 截图对照：`R-sepia-light-before-restart.png`（米黄）↔ `R-sepia-light-after-restart.png`（白）
- 根因位置（读码，未改码）：`src-cm6/main.js:3404` 的 `preferredEditorTheme()` 白名单只认 `telari-(light|dark)`、`^(light|dark)$`、`konayuki-(light|dark)`；启动末尾 `applyEditorTheme()`（`main.js:3411/4511`）拿到归一化后的 `telari-*` 再 `mpTheme.apply()`，后者会把 `editor-theme` 写回 `telari-*` ⇒ **7 套后加配色（Notion/Solarized/GitHub/护眼米黄/柔和淡绿）全部无法持久化**，且用户的原始选择被覆盖。
- 明暗是保住的（浅色回浅色、深色回深色），丢的是"具体哪一套"——所以用户感受是"我选的护眼米黄，重开变成宋韵浅色"。

### 3. 装着社区主题时切调色板 ⇒ 颜色全换了、**字体与登记不换**（两个 UI 都自称"当前"）
- 用例 G2（装着 `konayuki-test` 时真实点击「宋韵 浅色」）：纸面/工具栏/状态栏/正文色/代码块底**全部**跟到 `telari-light`（`#ffffff`、`rgb(36,41,47)`、`rgb(242,244,247)`，像素读回 `#ffffff`），但
  - 正文字体仍是社区主题的 `Georgia, "Times New Roman", SimSun, 宋体, NSimSun, "Noto Serif CJK SC"`；
  - `data-mp-user-theme=1`、设置面板仍写 `当前：konayuki-test`，而「主题」菜单写 `宋韵 浅色 · 当前`。
- 用户可见后果：配色换了、字形没换，两处"当前"不一致；没有"卸载社区主题再换配色"的提示。
- 移除后一切归位（§二.12），说明不是残留；成因（**推断**，未改码验证）：社区主题把 8 个 `--mp-*` 以**内联**写进 `documentElement`，调色板同样内联写同一批 token（后写者胜 ⇒ 颜色跟调色板），而社区 CSS 的**样式表规则**（字体等非 token 项）没有任何人撤销。

### 4. 设置面板底部按钮要滚动才够得到（口径，不算缺陷，但会骗过照 rect 点的探针）
- `#mp-theme-remove` 初始 `rect.y=659.5`，而 `.mp-dlg` 可视盒底 `bottom=630`（`max-height:76vh; overflow:auto`）⇒ 照 rect 点命中的是**下面的编辑器**：第一发 G4 读成"移除没反应"、H1 读成"没弹对话框"，全是尺子的错。真人在这个面板里会先滚一下（滚轮 120px 后按钮 `y=539, hit=self`）。
- 已在共用尺子里固化成 `clickInScrollPanel()`（先把面板滚到按钮可见 + `elementFromPoint` 命中测试，命中才点）。

### 5. 环境阻断（**不判通过也不判失败**）：社区主题的"安装 .css…"这一跳无法在本会话走完
- 已证事实（进程侧，非渲染侧）：点「安装 .css…」后本实例新增顶层窗口 **`#32770` / 标题「选择 Typora 主题 CSS」/ visible=true / hasOwner=true**，且主窗口 `Chrome_WidgetWin_1` 变成 **`enabled=false`** ⇒ 原生模态文件选择器**确实弹出**，按钮→对话框这条路是通的。
- 阻断点：本机工作站锁屏，无法在该原生对话框里输入路径 / 点「打开」/ 点「取消」；因此"选一个 .css 文件装上去"这一步**未验证**。本族用产品自己的核心函数（与对话框同一个 `installTyporaThemeFromText`）注入同一份 CSS 完成其余读数。
- 附带教训（写下来防后人再犯）：**CDP 注入的鼠标绕过 Windows 的窗口禁用态**——"CDP 还点得动"不能推翻模态对话框；判据只能用进程侧窗口表（`theme-switch-winlist.ps1`）。

### 6. 另一条尺子教训（同样的坑）：`taskkill /F` 会让 localStorage 丢掉最近写入
- 第一发重启臂 **3/3 全红**（连白名单里的宋韵浅色也"没保持"）：Chromium 的 DOM Storage 有提交延迟，点完配色 1~2s 内强杀，profile 的 leveldb 一个字节都没写（`000003.log` mtime 还是前一天）⇒ 读数是尺子造的假象。
- 硬性对策已进共用尺子：重启前 `sleep(9000)` ＋ **优雅关窗**（`taskkill /PID` 不带 /F，实测 1.0~1.3s 退出）＋ `lsWitness()` 直接读 leveldb 见证。§三.2 的结论是在**见证为 found=true** 的前提下得到的。

## 四、崩溃 / pageerror

- **0 崩溃、0 pageerror、0 consoleError**：主探针 4 次运行（含最终 91/91 那次）全部为 0；诊断探针、重启探针 0；**外部中断 0 次**。
- 主进程侧无异常退出记录；每次收场 `taskkill /PID /T /F`，跑完复查 `MarkPilot.exe` 命令行含 `theme-switch-out` 的进程 = **0 个**（没留孤儿，也没动别的族的实例）。

## 五、未验证 / 不在本族范围

1. **原生文件对话框内部操作**（选文件/取消/路径跳转）——锁屏态阻断，见 §三.5。
2. **字体度量变化引起的滚动漂移**：社区主题带 `font-family` 时正文度量会变，但本族只测了"颜色 + 光标几何在纯配色切换下零位移"；"字体族变化后滚动位置是否保持"未测。
3. **主题切换与多窗口/storage 事件的联动**（`main.js:3428` 的 `storage` 监听路径）未测——本族只用单窗口。
4. **阅读模式三档配色**（`readingPaletteDialog`）与**护眼"阅读配色"**是另一条通道（`extras.js:2295` 还原逻辑），未覆盖。
5. 剪贴板相关用例本族不涉及（本机锁屏态剪贴板不可用，见邻族记录）。

## 六、证据文件

**探针（全部 `theme-switch` 前缀，均在 `.mp-verify\checklist\`）**
- `theme-switch-lib.cjs` —— 共用尺子（启动/一次读数拿全/真实点击/弹层点击/滚动面板命中点击/三把尺子/重启与落盘见证/进程侧窗口表）
- `theme-switch-probe-1.cjs` —— 主探针（21 用例 / 91 判据）→ `theme-switch-probe-1.log`
- `theme-switch-probe-2.cjs` —— 重启保持 3 臂 → `theme-switch-probe-2.log`
- `theme-switch-diag1.cjs` —— 逐帧能力体检（rAF 48/800ms、定时器 80/800ms、页面 visible、screencast 通）
- `theme-switch-diag2.cjs` + `theme-switch-winlist.ps1` —— 「安装 .css…」进程侧取window证
- `theme-switch-smoke.cjs` —— 尺子冒烟（含第一发的坑：采样器没包 Promise ⇒ 0 帧）

**读数与截图（`E:\MarkPilot\.mp-verify\checklist\theme-switch-out\`）**
- `main\result.json`（91 条判据 + 每个用例完整读数）、`main\shots\`（22 张：A 基线 / B1 浅色整屏+工具栏+状态栏 / B3 菜单切换后 / D1 滚动 / E 四套像素 / E2 菜单「当前」 / G1 社区主题 / G2 半新半旧 / G4 移除后）
- `restart\result.json` + `restart\shots\`（每臂 before/after 各一张）
- `diag1\result.json`、`diag2\result.json`（窗口表前后对比）

**复跑**
```powershell
cd E:\MarkPilot\.mp-verify\checklist
$env:MP_EXPECT_EXE='15b8a1b699a0782e'
node theme-switch-probe-1.cjs "E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe"   # 91/91
node theme-switch-probe-2.cjs "E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe"   # 3 臂重启保持
```
