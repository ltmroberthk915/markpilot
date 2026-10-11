# 族报告：path-edge（路径异常 · 第三波真实用户操作普查）

**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**sha16 = `1b4e32a2263fcbe6`**，188 784 128 B，mtime 2026-10-10 12:25:48（**早于本族开工**；收尾复核仍一致 ⇒ 全部读数只属于这一份包）
**用例数**：**25**（10 支探针 / 23 次应用启动），全部跑完
**启动范式**：`spawn(exe, [...args, --remote-debugging-port=<空端口>, --user-data-dir=<独立>])` + `MP_DEBUG=1 MP_TEST_HOOKS=1 MP_TEST_NO_DIALOG=1` + `delete ELECTRON_RUN_AS_NODE` + `playwright-core connectOverCDP`
**纪律**：只在 `.mp-verify\` 写文件；**未改一行产品代码**；每条读数带产物 sha16；收尾 `tasklist` 复核本族残进程 **0**，`net use` 空、无 subst、只读目录 ACL 已解禁

**通道声明**（判据按此口径记账）

| 动作 | 通道 |
|---|---|
| 打开 | ① 启动参数 argv（=双击 .md）② `mpHost.openPath(绝对路径)`（=「文件→打开…」选中后的落点）——两条分开记账 |
| 编辑 | 真实鼠标点正文 + `page.keyboard.type` / `press`（CDP Input.*），按键前断言焦点在 `.cm-content` 内 |
| 保存 | **不做显式保存动作**，走 500 ms 去抖自动保存（用户打字后最真实的那条路） |
| 另存为 | 菜单项自身 click（`recent:test-menu-click menu-save-as`）+ `MP_TEST_SAVE_AS` 提供目标路径（不弹原生框） |
| 提示条按钮 | **真实鼠标**（读按钮矩形中心 → `page.mouse.click`），命中判定读 `document.elementFromPoint`（浏览器自己算的结果） |
| 网络盘 | `net use R: \\localhost\E$`（真映射，DriveType=4）/ `net use R: /delete`（运行中断开）；不可达形态用 RFC5737 黑洞段 `\\192.0.2.1\share` |
| 只读目录 | `icacls <dir> /deny <用户>:(WD,AD)` + 探针侧**自证写不进去**（EPERM）；用完立即解禁 |
| 目录联接 | `fs.symlinkSync(target, link, 'junction')`（不需管理员）；符号链接需管理员 ⇒ 未测 |

**隔离（一支都要自己证明）**：`main.js` 的 `migrateUserDataFromCm6()` 会把 `%APPDATA%\MarkPilot CM6` **整目录**拷进任何没有 `settings.json` 的 profile ⇒ 用真实用户数据出假读数。e2b 起每个 profile 预置 `settings.json`（`restoreLast:false`）+ `recents.json=[]`，并以 `migrated-from-cm6.txt` **不存在**自证。

---

## 一、没反应 / 行为不符预期

### P1（最严重，影响**所有**路径形态）「另存为…」到**新路径**必定失败，且报"原文件已不在磁盘上"

| 臂（同源同类，只换启动形态/目标存在性） | 结果 |
|---|---|
| 空文档 → 另存为到**新路径**（e2b-A2） | **成功**（目标创建、标题/MRU 切过去、再打字写新路径 ✓） |
| 打开的文件 → 另存为到**已存在**的目标（e2-B） | **成功**（覆盖、再打字进新路径 ✓） |
| 打开的文件 → 另存为到**新路径**（e2-C、e1 三臂） | **失败**，目标从未创建（ENOENT） |

- 壳层一手证据（`userData\main-debug.log`，e1-argv）：
  `pickSaveAs:env …\另存 输出 A.md` → **8 ms 后** `writeDoc:file-missing {…另存 输出 A.md}` → `file:save:error {"error":"原文件已不在磁盘上（可能被重命名或删除）：…"}`
- 用户可见后果：提示条写着"原文件已不在磁盘上（可能被重命名或删除）"（**与真实成因完全不符**——那个路径本来就不存在）；而**会话路径/标题/「文件位置」菜单已经切到新路径**；再打字仍不落盘（`docLen 28→30`，标题变 `● 另存 输出 A.md`，第二次 `writeDoc:file-missing`）；**源文件内容不变**（数据没丢，但副本永远存不出来）
- 代码位置（只读推断）：`main.js` `writeDoc()` 的 `if (S.diskMtime)` 守卫（第二波为修"改名后静默重建旧文件"所加）用**新目标路径**去 stat，而 `pickSaveAs()` 只改 `state.filePath`、**未复位 `S.diskMtime`** ⇒ 守卫把"新路径不存在"误判成"原文件被改名/删除"
- 注：第二波 file-ops 报告里"另存为到新目录成功"是 **sha16 `15b8a1b699a0782e` 那份包**的读数；本次为另一份包，判据一致地指向"目标是否已存在"
- 截图：`shots\e2-mech-A-空文档→新路径-after-saveas.png`、`…-C-打开的文件→新路径-after-saveas.png`

### P2（**数据丢失**）提示条只有一行时，它的按钮被工具栏盖住 → 点到的是工具栏按钮

配对实验（e6，同一按钮「放弃这次自动保存」，**只换消息长度**；消息长度由路径长度决定）：

| 臂 | 路径字符 | 提示条高 | 按钮中心 y | 工具栏下沿 | 点击前实测命中 | 点完提示条 |
|---|---|---|---|---|---|---|
| S 短消息 | 59 | **42** | **21** | 37 | `BUTTON:更多（导出 / 设置 / …）` | **还在**（没点到） |
| L 长消息 | 186 | **63** | **42** | 37 | `BUTTON:放弃这次自动保存` | **消失**（点到了） |

- 机理：提示条是一行内联流；消息短 ⇒ 按钮留在第一行（y≈8..34），**正好落在工具栏带（y 6..37）里**
- 真网络盘场景（e7，`net use R: \\localhost\E$` 断开后）：提示条 h=42；「重试」中心 (853,21) 实测命中 **`BUTTON:重做 Ctrl+Y`**；「另存为…」中心 (922,21) 命中 `BUTTON:双开：左侧渲染编辑面…`。连点 3 次「重试」：提示条一直在、用户刚敲的 `N2` **始终没落盘**（盘上仍只有 `N1`）
- **数据丢失那一次**（e4 臂 D）：断盘后点两次「重试」，文档 **28→26→24 字**，重连后那次自动保存把 **42 B（= 原始文本，用户敲的 `N1`/`N2` 全没了）** 写回磁盘——**已经成功存过盘的 `N1` 被抹掉**。壳层序列：`file:save bytes:44`（N1 成功）→ 2× `file:save:error` → `file:save bytes:42`
  - 当次点击坐标 (814,21) 落在工具栏「撤销 Ctrl+Z」矩形（x 808..834, y 10..34）内 ⇒ **"点到撤销"是与几何一致的推断**；e4 当时未做命中取证，e7 实测命中的是「重做」——**两个按钮都出现过，取决于窗口宽度**，但"点到工具栏、没点到提示条按钮"是实测事实
- 对照臂（同处境另一条恢复路径）：改用**菜单「保存」** ⇒ 成功，盘上 `# 网盘 标题\nN1N2N3\nMARK-NET7。\n`
- 说明：第二波 F6 只报了"提示条被工具栏压住、看不清"；本次把"**点不到 + 误触工具栏按钮**"量实，并量到"只在**一行**高时才发生"（两行高时按钮在 y=42，正常工作）

### P3 网络路径不可达时，启动被**同步** stat 卡住 21 秒

- 配对（e8，同尺子：spawn→CDP 可连）：对照（MRU 两条本地）**1045 ms** vs 实验（MRU 首位=不可达 UNC）**21303 ms**
- 壳层时间戳定位（`main-debug.log`）：`recents:loaded 04:57:44.970` → `newwin:trace 04:57:44.998` → **21.045 s 空档** → `jumplist:set 04:58:06.043` → `ready 04:58:06.044`（对照同段仅 30 ms）⇒ 卡在 `buildMenu()` → `recentMenuItems()` → `recents.menuModel(list, isFile)` 的**同步 `fs.statSync`**
- 同一黑洞地址的读盘超时一致：`openPath` 到 `\\192.0.2.1\share\pe-dead.md` = **21055 ms**
- 边界（如实记账）：**干净断开**的映射盘（`net use /delete` 后盘符消失）所有操作都是毫秒级（e4-D 实测），**不**会卡；21 秒只出现在"路径看着合法、服务器不响应"的情形

### P4 网络路径失败时的提示**不可读**，且路径在消息里被打断

- 断开映射盘后打字：`保存失败：ENOENT: no such file or directory, mkdir '\?'（R:\…\网盘 文档.md）` —— 引号里只剩 `\?`（真实路径没进错误串）
- 另存为到不可达 UNC（5.0 s 后出现）：`保存失败：UNKNOWN: unknown error, mkdir '\\192.0.2.1\share\'（…pe-dead.md）`
- 打开不可达路径：**21.1 s 零反馈**后 `{ok:false, error:"UNKNOWN: unknown error, open '\\192.0.2.1\share\pe-dead.md'"}`（本次 `MP_TEST_NO_DIALOG=1` 抑制了模态框；真人那 21 秒里界面上没有任何动静）
- 只读**目录**里另存为：`保存失败：EPERM: operation not permitted, open '…\.只读目标.md.mp-tmp-53836'（…只读目标.md）`（与第二波 F4 同一条：原始 libuv 英文 + 临时文件名进提示）

### P5 另存为失败后**标题停在旧状态**（"● 未命名"）

- S5 读数：`保存失败：EPERM …` 的同时，`document.title = "● 未命名 · 2 字 — MarkPilot"`，而 `mpHost.docInfo().filePath` 与「文件位置」菜单**已是目标路径**（`code: main.js doc:path:write {path:"只读目标.md"}` 已在壳层留痕）
- 机理：`renderer/host.js` `doSave()` 只在**成功**分支调 `refreshTitle()`（:211），失败分支只弹提示条；`saveAsFlow()` 也不刷标题 ⇒ 标题停在上一次刷新（e1 里表现为仍显示**旧文件名**，再打一个字才跳到新名）
- 附：只读目录里失败**没有**留下 `.mp-tmp-*` 残留（writeDoc 的 catch 已清理）✓

### P6 同一文件的不同路径形态，在「最近打开」里算**多条**

- e9（同一个文件）：真身路径 → **1** 条；再开 junction 路径 → **2** 条；再开 UNC 路径 → **3** 条 ⇒ 菜单上出现**三个** `同一份.md`，用户无法区分
- 大小写变体则被正确合并（`E:\MARKPILOT\…` 覆盖了 `E:\MarkPilot\…` 那条，键做了小写化）

---

## 二、正常路径的阳性读数

| 形态 | 结论 | 关键读数 |
|---|---|---|
| UNC `\\localhost\E$\…` | 有反应 | 打开命中逐字符相等（argv 与 openPath 两条通道都 ✓）；自动保存落盘；**空文档**另存为到 UNC 新路径成功；标题 `UNC 源.md · 25 字`；「文件位置」= `\\localhost\E$\…\e3-shapes\s4-unc`（**保留 UNC 原文，不被解析成盘符**），过长时中段省略 `\\localhost\E$\…\s4-unc`；MRU 存 UNC 原文 |
| 超长路径（>260） | 有反应 | 源 **264** 字符 / 目标 **265** 字符：打开 31 ms、另存为、再打字落目标、自动保存落源，全通；`dirShown` = `E:\…\dddd…`（省略）而 `model.dir` 是完整值 |
| emoji + 单引号 + 空格 | 有反应 | 目录 `🚀 emoji '单引' 双 空格  目录`、文件 `源 '文件' 🚀.md` 全通；标题带 emoji 与引号；baseURI 百分号编码正确（`%F0%9F%9A%80%20emoji%20'%E5%8D%95%E5%BC%95'…`）；MRU 逐字符相等 |
| junction（目录联接） | 有反应 | 经联接打开/另存为/自动保存全通；**写入落到真身目录**（真身目录内容 = `["源 经联接.md","目标 经联接.md"]`）；会话路径/「文件位置」/MRU **保留联接路径**（不解析成真身） |
| 不可达 UNC 的 MRU 条目 | 有反应 | `alive:false`、菜单标签 `pe-dead.md (文件不存在)` 且置灰；此后 `recentList` 2 ms、菜单读数 3 ms（不卡） |
| 真·映射网络盘（连接时） | 有反应 | `R:\…` 打开 49 ms、打字落盘、MRU 存 `R:\…`；断开后 `mkdir` 失败路径**没有**丢数据（磁盘字节未变） |

---

## 三、pageerror / 崩溃

- 10 支探针 `pageerror` **全为 `[]`**，无 `PAGE_CRASH`
- 收尾复核：本族 profile 的 MarkPilot 进程 **0** 个（别的族同时在跑的 12 个进程**未触碰**，杀进程前的判据是"命令行含本族 profile 根"）；`net use` 列表空；无 subst；只读目录 ACL 已解禁（复测可写）

## 四、证据路径

- 探针源码（`.mp-verify\checklist\`）：`path-edge-lib.cjs`（共用尺子/夹具/回合，复用已验证的 `file-ops-real-lib.cjs`）、`path-edge-1-unc.cjs` … `path-edge-9-mru-identity.cjs`、`path-edge-dump.cjs`
- 读数 JSON + stdout（`.mp-verify\path-edge\`）：`path-edge-1-unc.json` … `path-edge-9-mru-identity.json`、`pe1-stdout.txt` … `pe9-stdout.txt`
- 截图（`.mp-verify\path-edge\shots\`，20 张）：`e4-net-D2-disconnected-banner.png`、`e6-banner-short-short.png` / `-long.png`（配对几何）、`e7-netdrive-hit-final.png`、`e3-shapes-s5-rodir-final.png` 等
- 壳层一手记录：各 profile 下 `main-debug.log`（P1/P3/P4/P5 的时间戳与错误串都取自它）

## 五、未验证 / 环境阻断

1. **符号链接**（`New-Item -ItemType SymbolicLink`）：需管理员 ⇒ **未测**（junction 已测，二者在内核里都是重解析点，但不完全等价）
2. **原生「另存为」框里手选异常路径**：未测。`MP_TEST_SAVE_AS` 只替换"路径从哪来"，框本身的浏览/输入行为未覆盖
3. **"盘符还在但服务器不响应"**：未直接测。断开用 `net use /delete`（盘符消失，瞬时 ENOENT）；不可达形态用黑洞 IP 模拟 ⇒ 真实域共享/VPN 掉线未覆盖
4. **UNC 用的是本机管理共享** `\\localhost\E$`（非域网络共享），权限与 SMB 方言差异未覆盖
5. **打开失败时模态框的内容**：被 `MP_TEST_NO_DIALOG=1` 抑制 ⇒ 未验证（只量到"21 秒无反馈"）
6. **P2 中 e4 臂 D 那两次点击命中的具体工具栏按钮**（推断为「撤销」）：当时未做命中取证 ⇒ 记为推断；e7 在同类场景实测命中「重做」
7. **只读卷（写保护盘）/ 磁盘满 / 配额**：未测
8. **>32767 字符的 `\\?\` 极端长路径**：未测（本次测到 265 字符）
9. **e1 的 MRU 读数**取自"加隔离之前"（`recents.json` 会被 CM6 目录迁移灌入真实用户历史）⇒ 该支的 MRU 列表含别的族/真实用户的条目；**P1 的判据不受影响**（壳层 trace + 磁盘 ENOENT + 目标未创建），e2b 起已加隔离复测
10. **e2 臂 A 作废**：原判"空文档→另存为新路径"应成功，实测失败——根因是迁移 + `restoreLast` 把真实 MRU 第一条打开了（`filePath` 竟为 `…\img-bug\verify\copy-original.md`）。**保留原读数并就地标注**：该臂结论作废，改由 e2b（加隔离）重测为"成功"
11. **突变验证**：本族是只读普查，无修复项 ⇒ **未做**；P1–P6 均为**现状读数**，不含"已修复"结论，也**未与 Typora 实机对拍**
