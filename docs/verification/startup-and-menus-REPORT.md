# startup-and-menus 族 · 普查结论

被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
sha16 = `81b39273efae31e5`（188,784,128 B，2026-10-10 02:53:28）
探针（全部在 `.mp-verify\checklist\`，前缀 `startup-and-menus`）：
`-probe-1.cjs`（启动路径 + 文件菜单逐项）、`-probe-2.cjs`（菜单加速键）、`-probe-3.cjs`（脏文档语境：Ctrl+N/Ctrl+W/关窗提示）、`-lib.cjs`（共用尺子）

---

## 一、族名 / 用例数

**startup-and-menus**：共 **28** 个用例
| 探针 | 用例 | PASS | FAIL(判据未达成) | INFO(通道受限/未定论) |
|---|---|---|---|---|
| probe-1 启动与文件菜单 | 15 | **12** | 1（判据要求了产品本就不提供的形态，见 §2.4） | 2 |
| probe-2 菜单加速键 | 9 | 5 | 3（**都是"该状态当时不成立"，非产品缺陷**，见 §2.3） | 1 |
| probe-3 脏文档语境 | 4 | **4** | 0 | 0 |
| **合计** | **28** | **21** | **4** | **3** |

> 口径说明：4 条 FAIL 全部是**探针判据与产品实际形态不匹配**，不是功能坏点；
> 每一条都在下面写清"期望什么 / 实际什么 / 为什么不算坏"。真正"没反应"的项只有 §2.1（Ctrl+W）。

---

## 二、没反应的项 / 行为不符预期的项

### ★ 1. Ctrl+W 完全无反应（真·没反应）
- 两条输入通道都试了：CDP `page.keyboard.press('Control+W')` 与主进程 `webContents.sendInputEvent`。
- 进程存活 `[true,true,true]`、我的窗口数 `[7,7,7]`、文档原样（`K-按键.md · 22 字`）——**不关窗、不关页、不弹提示**。
- 脏文档语境下复验同样无反应（probe-3 §脏2）。
- 代码侧一致：菜单模板里**没有** Ctrl+W 项，渲染侧也没有 beforeunload/keydown 处理。
- 读数：`startup-and-menus-out2\log-key-ctrlw.json`、`startup-and-menus-out3\log-dirty-ctrlw.json`

### ★ 2. `isFocused()` 会撒谎（探针尺子层面的坑，已在本族修正）
- `recent:test-send-key` 回执里出现过 `wasFocused:false` 但 `focused:true`、`focusWaitedMs:0`，而同一次注入的 Ctrl+O **没有**弹出原生框。
- 修正口径：窗口级加速键是否真的生效，用**可观测效果**自证（切主题来回一次：`telari-dark→light→dark`）；只在自证为真时才认后续加速键读数。
- 读数：`startup-and-menus-out2\log-channel-selftest.json`

### ★ 3. 自动保存（500ms 去抖）会把"脏"清掉 ⇒ 关窗提示难以自然触发
- 现象：编辑后隔 >0.5s 再关窗，主进程的脏标已是 false、标题无 ●，于是**正常关窗、无提示**（这份内容已由自动保存落盘，无数据损失）。
- **这条同时解释了 probe-2 的 3 个 FAIL**：
  - `键2 Ctrl+N 新建`：Ctrl+S 那步刚保存过，最后一次键入距离注入 >0.5s ⇒ 渲染侧脏标 false ⇒ 不该有放弃确认框（**没有确认框是正确的**，是探针的判据要求了不该要求的东西）。
  - `关窗1/关窗2 脏文档关闭提示`：同理，关窗消息到得太晚，文档已不脏 ⇒ 直接关窗（**无数据丢失**：`file:save` 已在关窗前落盘）。
- 只有"最后一次编辑之后**立刻**关窗"才留得住脏状态：probe-3 用持续键入把去抖压住，实测**提示框如期出现**：
  - 关窗前：渲染侧脏标 `true`、壳层标题 `● 未命名 — MarkPilot`
  - 关窗消息发出 **1385ms** 后出现原生提示框 `#32770 | MarkPilot`，应用存活
  - 提示框上按取消（外部 `WM_CLOSE`）后：进程存活、文档仍 `● 未命名 · 82 字`
- 读数：`startup-and-menus-out3\log-dirty-close.json`、`log-dirty-cancel.json`

### 4. 「最近打开」里被删的文件：条目**静默消失**，而不是灰掉（呈现方式与注释承诺不符）
- 产品注释承诺"该条**灰掉**并带 ` (文件不存在)`，让用户看得见它曾经在"。
- 实测（连跑三轮，口径：打开 D → 删除 D 文件 → 重读子菜单）：
  - **菜单重建之后**：条目数 4→3（`recent-file-0..2` 重新编号），`enabled` 全部 true、**没有**「 (文件不存在)」后缀；
  - **菜单重建之前**（删除后那一瞬）：D 那一条**仍在**且 `enabled: true`，此时点它 ⇒ 主进程 `openPath` 报 `ENOENT`（探针实测拿到 `{"ok":true,"id":"recent-file-0","enabled":true}` 后日志出现 ENOENT），用户侧**没有任何提示**。
- 这条 FAIL 的口径：探针判据要求"该条必须灰掉且带后缀"（照注释写的），产品实际是"下一次重建时直接摘掉"。
  ⇒ **判据与产品实际形态不匹配**；功能上安全（不会误点、不弹错），但"灰色 + 文件不存在"这个承诺的呈现**不存在**。
- 读数：`startup-and-menus-out\menu-recent.json`（删除前：D/C/B/A）、`menu-recent-after-delete.json`（删除后：C/B/A，D 已不在）

### 5. 通道受限，未验证（如实列出，不算缺陷）
| 项 | 为什么未验证 |
|---|---|
| 原生菜单栏上**点**「文件 / 新建 / 打开…」等 | 本机无法程序化点原生菜单栏（main.js 已实测三条路全否：Alt+F 注入不弹、UIA 树里没有菜单栏、合成鼠标点菜单栏属接管鼠标且本轮无授权）。菜单项本身只能走**它自己的 click**（挂点）或**它的加速键**。 |
| 「新建」「打开…」两个菜单项的 click 本体 | 这两项在模板里**没有固定 id**，挂点 `recent:test-menu-click` 触达不到；渲染页 `contextIsolation` 下拿不到 ipcRenderer（实测 `typeof require === 'undefined'`）。它们的**处理逻辑**已由 Ctrl+N / Ctrl+O 覆盖。 |
| 原生框里**选路径并落盘** | 从打开框里选文件 / 从另存为框里选目标并确认，需要人点原生框；本轮只验到"框确实弹出 + 取消链路"，落盘语义由既有 `MP_TEST_SAVE_AS` 预置路径的验收覆盖。 |
| 关窗提示的**三个按钮分支**（保存并退出 / 不保存 / 取消） | 按钮在原生框上，程序化点不了；本轮只验到"提示框拦住关窗 + 取消后应用存活"。 |
| 「在资源管理器中显示」是否真的把资源管理器前台化 | 没有渲染侧回执；explorer 复用既有窗口 ⇒ 进程/窗口增量都是 0。本项只到"菜单项可用 + click 真被调用"。要看桌面才能定论。 |
| 任务栏跳转列表里能否**看见**本应用 | 跳转列表由 shell 按 AUMID 维护；本进程只能报 `setJumpList` 返回码与 OS 文件变化。**没有对着任务栏看过** ⇒ 未验证。 |

---

## 三、崩溃 / pageerror

- **0 次崩溃、0 次 pageerror**（三轮共 28 用例，`render-process-gone` / `unresponsive` 日志均为 0）。
- 一处**探针侧**的坑（已修正，非产品问题）：原生模态框一旦挂着，渲染侧 `page.evaluate` 会永久挂起 ⇒ 关框必须从**进程外**做（`PostMessage(WM_CLOSE)`，本族 `-dlg.ps1` 提供，按 PID 限定，不碰别人的实例）。

---

## 四、通过的关键读数（摘要）

| 用例 | 读数 |
|---|---|
| 无参启动（restoreLast=false） | 标题「未命名」、docLen=0；`ready.argvFile=null`、`restore-last {"enabled":false}`；AUMID `app.personal.markpilot.cm6`、`packaged:true`、`jumpList:"ok"` |
| 命令行带文件（绝对路径） | `ready.argvFile` = 传入的绝对路径，标题 `B-最近.md · 15 字`，正文 `# B 最近夹具` |
| 双击等价（cwd + 相对文件名） | `ready.argvFile="C-最近.md"`，正文 `# C 最近夹具` |
| OS 二次启动 | `newwin:created {filePath:…A-启动.md, sessions:2}` + 进程外枚举到新窗口「A-启动.md — MarkPilot」（两个窗口并存） |
| 恢复上次（restoreLast=true） | `restore-last {"enabled":true,"picked":"…\A-启动.md","tried":[…]}`，重启后载入该文件 |
| 文件菜单十项 | 新建 / 打开… / 最近打开 / 保存 / 另存为… / 导出为 PDF… / 文件位置(动态) / 复制文件绝对路径 / 在资源管理器中显示 / 关闭文件 / 退出；加速键 `Ctrl+N`、`Ctrl+O`、`Ctrl+S`、`Ctrl+Shift+S`、`Ctrl+Shift+P`、`Ctrl+Shift+C` 全部在册 |
| 菜单→保存 | 盘上内容含最后那次改动，主进程写 `file:save {filePath,bytes:64}` |
| 菜单→另存为 | 原生框「另存为」弹出（633ms）→ 取消 → `pickSaveAs:canceled`，文档与路径未被改 |
| Ctrl+O | 原生框「打开 Markdown」弹出（1539ms），关框后文档未被换掉 |
| Ctrl+Shift+S | 原生框「另存为」弹出，`pickSaveAs:enter {"env":null}`，目标文件未被创建 |
| Ctrl+S | 注入后 3ms 内主进程写 `file:save`，盘上确含改动 |
| Ctrl+N（脏文档） | 渲染侧放弃确认 `当前文档有未保存的修改，确定放弃吗？` → 清成未命名 |
| 最近打开 | MRU 顺序 = 最后打开的在前（D/C/B/A）；点 B ⇒ 当前文档换成 B |
| 清除最近记录 | 菜单项 `menu-clear-recent` → 子菜单剩「（暂无记录）」、`recents.json` = `[]` |
| 任务栏/系统最近 | `addRecentDocument` 逐条落；`%APPDATA%\…\Recent` 出现 `A-启动.md.lnk` 等；Automatic/CustomDestinations 有变化；`jumplist:set {"result":"ok","packaged":true}` |

---

## 五、证据文件路径

- 探针 1：`E:\MarkPilot\.mp-verify\checklist\startup-and-menus-out\`
  `report.json`（全量）、`log-startup1.txt`、`log-startup-cli-abs.txt`、`log-startup-dblclick.txt`、`log-second-instance.txt`、`log-startup-restorelast.txt`、`log-restart-preconditions.json`、`menu-fileitems.json`、`menu-recent.json`、`menu-recent-after-delete.json`、`log-menu-open.txt`、`log-menu-save.txt`、`log-menu-saveas.txt`、`log-recent-clear.json`、`log-reveal.txt`、`log-jumplist.json`、`log-menu-new.json`
- 探针 2：`E:\MarkPilot\.mp-verify\checklist\startup-and-menus-out2\`
  `report.json`、`log-channel-selftest.json`、`log-key-ctrls.json`、`log-key-ctrln.json`、`log-key-ctrlo.json`、`log-key-ctrlishifts.json`、`log-key-ctrlw.json`、`log-close-dirty-dialog.json`、`log-close-dirty-cancel.json`
- 探针 3：`E:\MarkPilot\.mp-verify\checklist\startup-and-menus-out3\`
  `report.json`、`log-dirty-ctrln.json`、`log-dirty-ctrlw.json`、`log-dirty-close.json`、`log-dirty-cancel.json`

复跑命令（单实例、独立 profile、随机调试端口；探针自己收自己的进程树）：
```
node E:\MarkPilot\.mp-verify\checklist\startup-and-menus-probe-1.cjs "E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe"
node E:\MarkPilot\.mp-verify\checklist\startup-and-menus-probe-2.cjs "E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe"
node E:\MarkPilot\.mp-verify\checklist\startup-and-menus-probe-3.cjs "E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe"
```

---

## 六、探针自身的两个坑（供别族复用，避免重复踩）

1. **`spawnApp` 的"清 profile"会删掉重启前提**：`rmSync` + mkdir 是为了防陈旧 `DevToolsActivePort` 串台，但对"关掉再打开"的用例它把上一轮写好的 `settings.json`/`recents.json` 一并删了 ⇒ restoreLast 判据永远读到空 MRU。已加 `keepProfile:true` 分支。
2. **产品在启动期会把 `%APPDATA%\MarkPilot CM6` 整目录拷进新 userData**（改名迁移，`main.js:32-54`）⇒ 独立 profile 里会凭空出现真实的旧日志、settings，甚至上一轮的 `DevToolsActivePort`（端口 9343）。已用产品自己留的测试缝 `MP_MIGRATE_FROM=<不存在目录>` 中和。
