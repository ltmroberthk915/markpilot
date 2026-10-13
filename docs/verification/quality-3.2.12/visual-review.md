# MarkPilot 3.2.12 最终独立验收（全新 DSH session，只读核验 + 真实看图）

**结论：FINAL AGREED**（限本门禁范围：frozen 23 套 **343/343** renderer 链 + 实际 main MenuItem/host 路由 + 真实看图）
会话：`session-096ccfed-9d40-4472-8a17-4a890ce373ec`（不在 `priorReviewerSessions` 的 7 个旧会话内；未复用 baseline/plan/旧验收观察）
本轮不启动产品/GUI/slot/CDP、不碰剪贴板、不构建/打包/安装、不改产品；未重跑已冻结 GUI。

## 1. 身份（自行按字节核对，非版本号）

- 完整报告：`cm6-gestures-3.2.12-suites.json`，SHA256 = `10cf699686b1a83cbd5b30ec42c229ca5c2f20673711e6d6266c65588ca169eb`（实测重算一致）
- 整 ASAR：`cm6-gestures-final-source-3.2.12/unpacked/resources/app.asar`，SHA256 = `f794e8c23ea631afe1b66552c8674d9bd8c0a48eaf4b957b581832b57b624143`（7 535 884 B，实测重算一致；非 bundle/版本号）
- 实际 runtime EXE：`unpacked/MarkPilot.exe`，SHA256 = `c32d46ec6aebc4f587a8c9e1d4f345ccb7d5ebd99217c8c1cc672a38c89e5c7b`（188 779 520 B）
- 变异报告 SHA256 = `76403386ec498d9921b16330a755241b86b60a794c05746be84f85b8cce2c180`；图像 manifest SHA256 = `f6bb46280253f3e3db51d641a6d609189d8b7ba007a9a2e4efde4932a1f18ef1`（191 refs / 57 唯一 SHA）
- `artifact.json` version=3.2.12；`C.stage()` 通过：staged `app-source` 与 `MarkPilot-CM6` 逐文件一致，且与 ASAR 内 7 个核心文件逐条 sha 相同（`main.js / preload.js / renderer/host.js / shell/document-store.js / shell/text-codec.js / renderer/cm6/app.js / renderer/cm6/markdown-worker.js`）
- 冻结成员重算：742 个 source/probe 文件**逐字节一致**（0 差异、0 缺项）；runtime 目录 73 文件与冻结清单一致；`buildCheck` 匹配且 app.js / markdown-worker.js 构建 sha 与 ASAR 内一致

## 2. 343 聚合回归（23 套，全量重算，非抽样）

- `passed=true`，`expectedSuites=23`、`expectedCases=343`；逐套 `result.json` 实测 SHA 与 `results[].resultSha256` **23/23 一致**，用例数 23×n=343 且 `status` 全 pass，**用例 ID 与派生清单逐个相等**（16 套旧 ID 取自 3.2.11 前序报告的 cases；7 套新 ID 为流水线声明的固定 ID 集）
- 每套 `metadata/artifact`：`app.version=3.2.12`、`sourceMode=false`、`asarSha256=f794…`、`runtimeExecutableSha256=exeSha256=c32d…`、`asarPath` 指向本 canonical、核心成员 = `artifact-files.cjs` 且每个文件 sha 与 `artifact.json` 相同、Node/Electron/Chromium 版本与报告一致
- 产物真实：每套目录树（仅 .md/.png、排除 profile*/node_modules）与 `results[].fixtures` **逐文件 sha+bytes 一致**（共 23 套 fixtures 全等）
- cleanup：23/23 `cleanup.residual=[]`，无 `fatal / cleanupError / cleanupErrors / errors`，中间臂 cleanup 同样为空
- 剪贴板：`restored=true` 的 13 套（selection/math/math-entry/math-paste/mixed/rich/images/critical/worker-integration/quoted/cross-drag/native-pending/search-pending）全部真还原；`touched=false` 的 4 套（search / native-menu / math-gesture / cell-composition）均未触碰 —— 与各族声明一致
- probe 来源：10 套在 result 内记录 probe 哈希（`probe.file.sha256` 8 套 + `probeSha256` 2 套），**全部等于实际文件字节且等于冻结成员值**；其余 13 套未在 result 记录 probe 字段，其 `tools/quality/<suite>.cjs` 经 742 文件冻结清单逐字节核验（无套外探针、无冻结后被改）

## 3. 三个独立根因：红 → byte-exact 还原 → 绿

`checkoutUnchanged=true`、`selectedKinds=[native-menu, math-gesture, menu-pending]`、`mutations.length=3`、`passed=true`；六份 red/green 原报告 SHA 逐个实测匹配（26d2b474…/e032e1b1…、7ea219d0…/e913edb3…、ccb490e8…/de57cd0c…）

| 根因 | 红 ASAR（改动文件） | 绿 ASAR | 负臂 | 正臂/控制 |
|---|---|---|---|---|
| native-menu | `39fdf4d3…`（renderer/host.js） | `f794e8c2…` | 6 个目标用例 fail | 正臂 10/10 pass；4 个空历史控制臂在负臂仍 pass |
| math-gesture | `833ab216…`（renderer/cm6/app.js） | `f794e8c2…` | `formula-held-wheel-loop` fail | 正臂 2/2 pass；对照 `plain-held-wheel-loop` 负臂仍 pass |
| menu-pending | `6eb657f3…`（renderer/cm6/app.js） | `f794e8c2…` | 空历史用例 fail | 正臂 2/2 pass；非空历史 CM undo 控制臂负臂仍 pass |

- byte-exact restore：三份 `restored-*-artifact.json` 的 `files[]` 与 canonical `artifact.json` **逐条 sha 相同**、`asarSha256` 回到 `f794e8c2…`、EXE sha 未变；`sourceRestored=true`、`idempotentOnOff=true`、`positive=true`
- 负臂失败 id 与声明 `ids` 集合完全相等（6/1/1），控制臂未被误计为应红；六个臂 `cleanup.residual=[]`，无脚本错误
- 失败原因文本为可见语义（如 `actual menu undo preserves expected document history`、`late image response never inserts Markdown after native Undo`）

## 4. 七套新 suite：图像只证实可见态，IPC/时序/磁盘读实际 trace

- quoted-math-subrange：Shift+点击反向选区 anchor18/head12 → Ctrl+C 剪贴板 6 字符 `x+\n> y` 精确命中 → Ctrl+X 后正文 `> $$ > (空) > $$` → Ctrl+Z 还原 → Ctrl+Y 再切 → 原位 Ctrl+V 复原 → paste undo/redo → 续写 `R`；磁盘 `quoted-subrange.md` 字节 = oracle.final 且 sha `c9e5572c…` 与 detail 一致
- cell-composition：`compositionRequested=false`（诚实标注非 IME）；`beforeinput insertText trusted data="中文" isComposing=false` 进入 escaped-pipe 格（`a\|b`→`a|中文b`，dom→source 映射 26→30 有 lag）→ Ctrl+Z 回 `a|b` → Ctrl+Y 回中文 → 立即 `1` → `a|中文1b`；磁盘 `ordinary.md` sha `002d68fe…` 与 detail.finalSha256 一致
- native-menu：`transport` 明示走**实际主进程 `MenuItem.click(event, focusedWindow, focusedWebContents)`（本地 main V8 inspector）**，非 OS 点击/物理加速键；每次真菜单调用留 `ack{ok,label:撤销,accelerator:CmdOrCtrl+Z,focused:true}` 与 `menus[{cmd,at}]`；正文/格/搜索三类 undo/redo 各 6 臂全 pass，搜索框 `searchValue abc→ab` 且保焦点；空历史额外留 `empty-owner-handled-API-contract handled=true`，其 scope 自述“real engine no-op return contract; **not a native fallback invocation counter**”——即单独 API 合同，不伪称监控了原生调用次数
- cross-page-drag：`mousedown`(buttons=1) → **32 次 mousemove（buttons 恒 1、时间戳单调、17 个不同坐标）** → 跨页滚轮(deltaY 300×2) → `mouseup`；抬起前后 **selection 完全守恒**（plain 8/363、formula 18/424），正文长度不变(958)，随后 STA 复制 354/405 B、粘贴、undo/redo、续写，末态 1294/1345 字有独立 UTF-8 磁盘臂
- math-gesture：click 与 jitter 为**正控**（同样落到 glyph 端点 11，鼠标真实 mousedown/mousemove/mouseup、trusted），local-loop（33 指针拖拽循环）与 wheel-only（1 指针 + 2 滚轮、光标随滚动移出视口）为两种独立 drag，`discriminating=true`、`sourceUntouched=true`
- native-pending：主进程真实注入 5 000 ms 延迟（`mainDelayProof{pid,hooks:1,delay:5000,profile}`），trusted Files/PNG(512×384) 粘贴 → 实际 MenuItem undo(ack) → 迟到响应：空历史与非空历史**都**取消插入，正文无 `![]()`、无图片，toast `插入位置或文档已变化，图片插入已取消`；`ticketFieldRead=false`、`lateAssetMayRemain=true` 如实保留
- search-pending：搜索框收到 trusted native `beforeinput historyUndo`（target `INPUT.cm-textfield`、`inEditor=false`）→ 查询 `abc→ab` 且搜索保持焦点 → 正文 pending 位图最终**正常插入**（正文出现 `![](assets/pasted-image.png)`、rendered=1、toast `已存入 assets 并插入图片`）；`ownerIsolation=true`

## 5. 五通道：真实入口/事件 + 连续终态（非仅索引）

跨 23 套实测的**键/指针/滚轮/输入事件**均为 `trusted=true`：键事件 **7 444**（ctrl 4 269、shift 466；含 Control/Shift/Arrow/Home/End/PageUp/PageDown/Backspace/Delete/字符键）、指针事件 **948**（mousedown/mousemove/mouseup/pointerdown/pointerup/click，带 buttons/detail）、滚轮 **40**、`input/beforeinput` **619**（insertText / historyUndo / historyRedo）、composition 记录 10（worker-integration）
- **例外一处（不得泛化）**：对本轮 23 套结果做递归全量扫描，3 069 条带 `type`+`trusted` 的事件记录中**恰有 1 条** `trusted=false` —— `worker-integration/cases/4/trace/1/events/4`（用例 `pending-cdp-composition-preserves-unicode-and-quotes`）的 `compositionend`。该条是合成 composition 结束事件，**不能算可信的系统 IME 事件**，故本报告不宣称“所有事件全 trusted”；五通道结论只建立在上列 trusted 键/指针/滚轮/输入证据与真机终态上
- keyboard：字符/导航/历史真实键入并落字（cell-composition 逐键 docLen 单调、native-menu `02-typed` 等）
- mouse：真实点击/double-click（math-workflows detail `{channel:mouse, clickCount:2}`）与 trusted 指针序列
- combination：Ctrl+C/X/Z/Y/V、Shift+点击/Shift+方向键真实修饰键事件
- keyboard-mouse：同一用例内键+指针混用且时序单调（quoted-math、cross-drag×2、mixed-selection、cell-composition）
- pressed-move-release-drag：cross-page-drag、math-gesture local-loop、math-workflows real-drag 均为 mousedown→多次 move→mouseup 连续序列

## 6. 代表旧 suite 复核

导航（PageDown/PageUp + 源码复制）pass；Shift/拖选（shift-mouse 17 字、real-drag moves=12 后 Shift 缩短到 15 字）pass；`same-text` 双文档 **historyIsolated=true / documentIdentityChanged=true**；活动格打开新文件 `inputFocus=true / oldOverlayRetired=true` 且立即打字落字；rich `mixed-html` 11 个哨兵 **按序**保留且 `atomicUndoRedo=true`；images `saved-screenshot-immediate` 任意 md 保存后截图**立即渲染**（naturalWidth 1369×857、complete=true、failed=false，toast 已存入 assets 并插入图片）

## 7. 真实看图（本轮亲自 read_image，非标签猜测）

- `manifest.images` 57 张唯一 SHA 全部真实打开：57/57 opened，`missing=0`、`unreadable=0`；48 张实际看到红色光标标记（caret=true），9 张未见红标记（caret=false）——其中 7 张为搜索框图（manifest `caret:null`，真实 INPUT 无可靠 Range，我按实际像素记为未见图），2 张为 wheel-only 帧（光标矩形在视口之外，2× 裁剪落在工具条区域）
- 观察写入 `goal-6h5/flash-gestures-final-opened-3.2.12.json`：`saw/caret` 全部由我逐帧看图后撰写；重复字段（dir/file/SHA/refs）由我著写的短脚本 `_assemble-opened-3.2.12.cjs` 从 manifest 提取，主控原样执行保存，脚本未看图、未复制旧观察；`at=2026-10-12T00:59:35.568Z` ≥ 两报告 finishedAt（full 00:37:43Z / mutations 00:41:32.596Z）
- 台账复核：12 groups / 57 frames / 57 唯一 SHA；每个 `dir+file` resolve 后等于 manifest canonical file，SHA 与磁盘字节一致，`refs` 等于该图 references 去重（191 refs 全覆盖），全部 refs 可落到对应 suite 的真实 trace stage（189）或 images 的 `frames` 阶段（2）

## 8. 未确认 / 明确限制（不求放宽）

- **未测**：真实 OS 菜单点击与物理加速键（本轮验的是真实主进程 MenuItem 桥，不是 OS 点击）；微软拼音等实际 IME 候选与提交；窗口外/未测的 scroll-return 生命周期
- 普通 Unicode 通过（`insertText data="中文"`、`isComposing=false`）**不代表** OS IME 提交通过；此前严格 composition `Input.insertText` 缺 trusted 提交，**保持 unconfirmed**（本轮唯一 `trusted=false` 的合成 `compositionend` 不能作为 IME 提交证据）
- pending 链的票据字段未读（`tickets not read`），延迟只用“真实注入延迟 + 资产 mtime/hostLog 上界”证明；迟到资产文件可能残留（`lateAssetMayRemain=true`）
- 图像证据只证实可见态；history IPC、票据时序、磁盘保真以实际 trace/落盘为准（本报告已分别引用）
- 打包与生产安装是**之后独立门禁**：本轮**未安装 3.2.12**，也未验证安装边界/注册项

## 9. 身份口径说明

本轮源级 canonical 的 **ASAR/app package 已是 3.2.12（f794…）**；runtime EXE 沿用干净 candidate 3.2.11 的 `c32d…`，其 PE 资源仍显示 3.2.11，这是**源码样机身份**（正式打包才以 rcedit 升为 PE 3.2.12 并逐文件核验）。不得据 PE 11 判旧源码，也不得宣称已正式安装 3.2.12。

**最终：FINAL AGREED，343/343，57/57 唯一图实开；整 ASAR `f794e8c23ea631afe1b66552c8674d9bd8c0a48eaf4b957b581832b57b624143`、完整报告 `10cf699686b1a83cbd5b30ec42c229ca5c2f20673711e6d6266c65588ca169eb`、runtime EXE `c32d46ec6aebc4f587a8c9e1d4f345ccb7d5ebd99217c8c1cc672a38c89e5c7b`。**
