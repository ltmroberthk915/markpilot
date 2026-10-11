# 第三波·真实用户操作普查 —— 族：session-truth（会话与 MRU 真源）

- **族名**：session-truth
- **被测产物（当时 2026-10-10 12:32–12:43）**：
  - `E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe` sha16 = **1b4e32a2263fcbe6**（探针内断言，不符即 exit 9 不出数）
  - `resources\app.asar` sha16 = **bd172e68f484e69c**（12:25:47 构建；14:39/14:42 两次复核哈希未变 ⇒ 三轮读数对的是同一份产物）
- **用例数**：22（probe-1 十二条 + probe-2 五条 + probe-3 两条 + probe-4 三条）
- **探针与证据**（全部在 `.mp-verify\checklist\`）：
  | 探针 | 用例 | 证据 |
  |---|---|---|
  | `session-truth-1.cjs` | T0 基线 / T1 连开 5 文件 / T1b 重开去重置顶 / T1c 5 窗各一文件 / T2 逐个关闭 / T2b 关完退出+落盘 / T5a 恢复哪一只 / T3 死条目 / T3b 运行中删文件 / T5b 关掉恢复设置重启 / T4 清空 | `session-truth-1.log`、`session-truth-1\readings.json` |
  | `session-truth-2.cjs` | M1 整目录迁移 / M2 迁移设置是活的 / M3 迁移+顶部已删时恢复谁 / M4 落盘对账 / M5 旧目录原样 | `session-truth-2.log`、`session-truth-2\readings.json` |
  | `session-truth-3.cjs` | C1 对照臂 Ctrl+W / C2 Ctrl+N 后 Ctrl+W | `session-truth-3.log`、`session-truth-3\readings.json` |
  | `session-truth-4.cjs` | D1 对照窗口表 / D2 新建后自报脏标 / D3 Ctrl+W 后的 OS 窗口表 | `session-truth-4.log`、`session-truth-4\readings.json` |
  | 共用 | 启动范式 + 单次 evaluate 读数 + 身份/出处闸门 | `session-truth-lib.cjs`、`session-truth-winlist.ps1` |
  | 首轮被污染读数（保留） | 迁移观测 | `session-truth-1-migration-observation.log` |

---

## 一、行为不符预期 / 没反应的项

### F1（真缺陷，已钉到机制）新建（Ctrl+N）之后 Ctrl+W 关不掉窗口

| 臂 | 操作 | 读数 |
|---|---|---|
| 对照 C1 | 打开文件后直接 Ctrl+W | `win:closed` 0→**1**，引擎页消失，进程退出 ✅ |
| 试验 C2 | Ctrl+N（新建生效：doc 路径 null、编辑器长度 0）后 Ctrl+W **连按两次** | `win:closed` 1→**1→1**，引擎页仍在、进程仍在 ❌ |

三条腿（同一轮取全，probe-4）：

1. **渲染侧**：`document.title` 新建前 = `ST-DIRTY.md · 40 字 — MarkPilot`（无脏标）→ 新建后 = **`● 未命名 · 41 字 — MarkPilot`**（引擎自己算出来的脏标）。
2. **主进程**：OS 主窗口标题（`Chrome_WidgetWin_1`）同样带 `●` ⇒ 主进程 `S.dirty=true`；`win:closed` 不增加。
3. **操作系统**：Ctrl+W 之后本进程顶层窗口表**新增一条 `#32770 | MarkPilot | vis=true`**（Win32 对话框，可见）—— 原生模态框，CDP 拍不到也点不到。

机制（只读引用源码，未改一行）：`renderer/host.js` 的 `case 'new'` 先置 `dirty=false`，紧接着 `down('setValue','')` 改文档 ⇒ 触发上行 `case 'change'` ⇒ `if (!dirty) { dirty = true; refreshTitle(); mpHost.docDirty(true) }` ⇒ 主进程会话 `S.dirty=true` ⇒ `main.js` 的 `W.on('close')` 走 `e.preventDefault()` + `dialog.showMessageBox('还有未保存的修改')`。

用户可见的现象：**新建一份空文档后按 Ctrl+W（或点窗口 X）不关窗，弹出「还有未保存的修改」确认框**。附带读数：新建后编辑器长度 0，标题却写「41 字」（`charCount` 是上一份文档的值）。另：该确认框不受 `MP_TEST_NO_DIALOG=1` 约束（close 路径没接这个开关），自动化下会一直挂着。

> 这一条解释了 probe-1 T5b 前置关窗"注入回执 ok、壳层没反应"的异常（三次运行一致）。

### F2（行为特性，非缺陷；把复现条件写清）MRU 条目是"建菜单那一刻"的快照

- 应用运行中把文件删掉、**不触发重建**：`recent:list` 的 `alive=false`（实时），但菜单里那条仍 `enabled=true`、**没有**「(文件不存在)」后缀。
- 触发一次重建（Ctrl+N／再打开一个文件／菜单栏将要弹出）后：立刻变 `enabled=false` + 后缀「(文件不存在)」。
- 点灰条目：挂点拒绝（`{ok:false,error:'该菜单项已灰掉（不禁用模拟点击）'}`）；强制点它 ⇒ `openPath:error ENOENT` ⇒ **该条从 MRU 里摘掉**（`[D,E,C,B,A] → [D,C,B,A]`），与设计注释一致。

⇒ 第二波"死条目没变灰"那条结论，在本产物上的**成立条件**是"菜单还没重建"；重建后即变灰。

---

## 二、验证通过的关键读数（摘要）

- **T1 连开 5 个文件**：逐次 MRU = `A` → `B>A` → `C>B>A` → `D>C>B>A` → `E>D>C>B>A`；菜单项顺序、`recents.json` 落盘三者逐字符一致。
- **T1b 重开已开过的文件**：置顶且无重复（5 条仍是 5 条）。
- **T1c 5 个文件各占一窗**：逐窗断言新窗口的 `docInfo().filePath` 逐字符等于**请求的那个**（不是默认回退到当前文件）；会话表 `wcId 1..5 → A..E`，`isPrimary` 只有 1 号。
- **T2 逐个关闭（真实加速键）**：5 次 `win:closed`，`remaining` 序列 `4,3,2,1,0`、`sessionsLeft 5→1`；关窗前后的 MRU 逐字符不变；关完最后一个窗口应用退出（`tasklist` 事实）；**磁盘 `recents.json` 仍是 `[E,D,C,B,A]` 5 条**。
- **T5a 顶部条目已删后重启**：壳层一手 `restore-last {"enabled":true,"picked":"…ST-D.md","tried":[ST-E,ST-D,ST-C]}` ⇒ 跳过已删除的 E，恢复 D；已删条目仍留在清单里灰着（不静默消失）。
- **T5b 关掉「启动时打开上次的文件」后重启**：MRU 非空（4 条）但文档空白、MRU 未动；壳层 `restore-last {"enabled":false}`。
- **T4 清空最近记录**：真点菜单项自身 click ⇒ MRU `[]`、菜单只剩一条灰的「（暂无记录）」、`recents.json=[]`、`settings.json` 旧字段 `recent=[]`、日志 `recent:cleared 4`。
- **M1–M5 真源迁移**：全新 userData 首启把旧目录整目录搬来（`migrated-from-cm6.txt`）；迁移来的 `theme=telari-dark` 读回不是默认值 `system`；旧目录 recents `[Y(已删),X,Z]` ⇒ 恢复 X 并置顶落盘（`[X,Y,Z]`）；旧目录哈希前后一致（原样保留）。
- **每条读数都带身份/出处闸门**：MRU 真源文件必须落在本次 profile；日志末条 `ready` 的调试端口必须等于本次端口（否则可能是"新进程被单实例锁弹回、连到上一个实例"）。
- **pageerror：0；console error：0；渲染进程崩溃：0**（4 支探针全轮）。残留进程 0（按我的 profile 过滤；全机另有 24 个同名进程属并行的其它腿，未动）。

---

## 三、未验证项（不许当结论用）

1. **系统「最近使用的文档」/ 任务栏跳转列表**是否真的跟着 MRU 走：日志有 `recent:addRecentDocument <路径>`（逐条）与 `jumplist:set {"result":"ok","packaged":true}`，但 Windows shell 侧表现（资源管理器「最近」、跳转列表）本机**未取证**。
2. **「关闭文件」菜单项**（`{label:'关闭文件', click:…}`，无固定 id）挂点触达不到 ⇒ 本族没测它；Ctrl+N 之外的清空文档路径未测。
3. **MRU 上限 10 的截断**：本族只开过 5 条（+迁移 3 条），没测"第 11 条挤掉最旧一条"（首轮被污染的读数里曾出现过 10 条上限，那轮不作判据）。
4. **多显示器/特殊窗口管理器**下的关窗与模态框行为未测。

## 四、方法学记录（避免下次重踩）

1. **全新 `--user-data-dir` 不等于干净基线**：main.js 的「改名迁移」在新目录没有 `settings.json` 而 `%APPDATA%\MarkPilot CM6` 有时会**整目录搬过来**（含 recents.json），而 `restoreLast` 默认开 ⇒ 首启直接打开了别人留下的 `copy-original.md`，基线 MRU 里混进 7 条外来记录。隔离必须用源码写明的测试缝 `MP_MIGRATE_FROM`（指到不存在的目录）。首轮被污染的读数已原样保留为证据。
2. **闸门不许把"引擎的合法状态"写成前提**：`menuModel()` 在 MRU 为空时**只返回一条灰的「（暂无记录）」**，`menu-clear-recent` 此时根本不存在；第一版闸门要求它必须在，导致空基线启动每次都被自己的尺子拦下。
3. **dbg 首段是裸字符串**：日志形态是 `restore-last {…}` / `win:closed {…}`，正则写成 `/"restore-last"/` 会读空（曾据此误判一条 ✗）；`ready` 的锚点若写成 `/\bready \{/` 会连 `doc:ready {…}` 一起命中。
4. **"读不到"不许判成"变了"**：关掉最后一个窗口后渲染侧已不存在，那一轮"MRU 没变"只能由磁盘 `recents.json` + 下次启动的 `recents:loaded count` 来回答。
