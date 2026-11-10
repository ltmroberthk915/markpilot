# MarkPilot DSH 插件 · 1.8.1 交接技术文档

> 交接范围：`dsh-markdown-editor-typora` 插件后续开发、发布与验收。
> 交接基线：`main` 已推送，插件 1.8.1，GitHub Release / npm 均已发布。
> 读者：接手本项目的工程师。先读第 1～3 节，再按第 4 节以后的任务顺序推进。

---

## 0. 结论摘要

1. **1.8.1 已交付**：AI 审阅状态可跨编辑区关闭/重开保留；恢复草稿后 review 横幅回来；撤销组跨 live epoch/version 重置时按正文 sha 校验，不再误报 `MP_DOC_STALE`。
2. **P0 已收口**，但有一个**验收缺口**和一个**健壮性缺口**，见第 4 节。
3. **下一项应做 B4.3 冲突界面**，而不是 B5。B4.3 的 host `merge3` 已有，客户端 UI 没有任何冲突解决入口。
4. **B4.2b-full / B5 内核大改都没有开始编码**。已有明确边界、失败经验和候选架构，但尚未落码；不要把它们说成“已完成设计”。
5. **性能预热方案已失败并回退**：1.7.6 的 iframe 保活/预热破坏 Markdown 显示，不能再直接重试。启动慢的根因是 iframe/CM6 启动本身约 718–775 ms，不是左栏按钮。
6. **不要为了收尾而压缩验收**：本项目的数据安全问题是真实事故驱动的，review/undo/conflict 都必须保留“先归档、fail-closed、不自动覆盖”的不变量。
7. **前期调研结论**：CodeMirror 6 / VS Code / ProseMirror / Lexical 都把“不可变文档状态 + 单一 transaction 入口 + 显式 undo 边界”作为核心；VS Code 的 3-way merge editor 是 B4.3 的直接范式；CRDT（Zed/Yjs）成本高，当前没有必须引入的需求。详见 §2.7。
8. **引用区两项新缺陷已复现、未修复**：Shift+Enter 在引用区插入裸换行，破坏连续引用；跨行/含 `>` 前缀的 Ctrl+B/I 会把标记写到前缀外。详见 §2.8，下一批需要修改 `dsh-markpilot/src-cm6` 并同步核心。

---

## 1. 当前交付状态

### 1.1 代码与版本

| 项 | 值 |
|---|---|
| 仓库 | `D:\BuyKey\markpilot-public` |
| 分支 | `main` |
| 交接 HEAD | `fd450d8`（`merge upstream main before 1.8.1 release`） |
| 插件目录 | `dsh-markdown-editor-typora/` |
| 插件版本 | `1.8.1` |
| 内核版本 | CM6 `3.6.17` |
| `coreHash` | `4499e09378a8743fd1ec985c11bf8046f33b55350688dd9d996b839fe0d589ba` |
| 测试 | `449 tests / 448 pass / 1 skip / 0 fail` |
| 工作区状态 | `main...origin/main` 同步；有未跟踪的本地 tgz/dist 产物，未纳入发布 |

### 1.2 发布状态

| 渠道 | 状态 |
|---|---|
| GitHub main | 已推送 |
| GitHub Release | `dsh-markdown-editor-typora-v1.8.1` |
| Release 资产 | `dsh-markdown-editor-typora-1.8.1.tgz` |
| 资产大小 | 2,801,268 B |
| 资产 SHA-256 | `f955dba6251d0d73b6ec6bbc4016c19e69534b1982b537c24cab0e5afa1e749d` |
| npm | `dsh-markdown-editor-typora@1.8.1`，`latest = 1.8.1` |
| npm shasum | `b648c94f284c694a10b77086b7c7cdf71b5903e4` |
| npm tarball | 与 Release 资产 SHA-256 逐字节一致 |
| 官方市场 | PR `awesome-dsh-plugin/awesome-dsh-plugin#13960`，OPEN / MERGEABLE，CI pending |
| 开放市场 | Issue `polang233/dsh-plugin-index#407`，OPEN |
| 本机 profile | `desktop` 的 `node_modules/dsh-markdown-editor-typora` 为 junction，指向本仓库源码，版本 1.8.1 |

### 1.3 当前代码结构

```
dsh-markdown-editor-typora/
  package.json            1.8.1；files 白名单；engines dsh >= 0.2.0-rc.2
  core.json               124 个内核文件 + coreHash
  host.json               9 个 host 文件清单（document-store / live-documents / native worker…）
  cordis.patch.yml        DSH bundle patch
  lib/index.js            宿主插件：路由、documents.*、模型 markdown 工具、设置、diag
  lib/client.js           浏览器端 sidebar 编辑器外壳：iframe、保存、review、recovery、live 中继
  lib/documents-service.js 宿主权威文档服务：authority、revision、applyEdits、recover、merge3、review
  host/                   host 侧文件/房间实现（来自 MarkPilot-CM6/shell）
  renderer-cm6/           CM6 3.6.17 的逐字节同步产物（不要手改）
```

### 1.4 验证口径

每次改动至少跑：

```powershell
cd D:\BuyKey\markpilot-public\dsh-markdown-editor-typora
npm test
node scripts/sync-host.mjs --check
node scripts/sync-core.mjs --check
```

`sync-core` 的期望：

```text
CHECK_OK 124 files, 7351676 bytes, coreHash=4499e09378a8743fd1ec985c11bf8046f33b55350688dd9d996b839fe0d589ba
```

`sync-host` 必须 `HOST_CHECK_OK 9 files`。任何 renderer/core 改动都必须重新构建、重新同步、重新计算 `coreHash`，不能手改 `renderer-cm6/`。

### 1.5 分支、工作树与隔离产物

| 位置 | 状态 | 处理方式 |
|---|---|---|
| `.agents/worktrees/b4.2b-review-persist` | 1.8.1 的 review 持久化/epoch 修复分支，已合入 main | 只读参考，不要再改 |
| `.agents/worktrees/perf-prewarm-skeleton` | 1.7.6 的预热/骨架实验，**已验证会破坏 Markdown 显示** | **不要合并、不要安装**；留作失败证据 |
| `dsh-markdown-editor-typora-1.7.6-*.tgz` / 隔离包 | 坏包 | 不要发布/安装 |
| 仓库根未跟踪的 `dsh-markdown-editor-typora-*.tgz` | 历次本地打包 | 不参与发布；不要 `git add .` |

### 1.6 本机数据位置（禁止随意清理）

| 数据 | 路径 |
|---|---|
| 房间 SQLite | `%LOCALAPPDATA%\.markpilot\live-v1\rooms.sqlite` |
| 恢复副本 | `%LOCALAPPDATA%\.markpilot\live-v1\recovery\agent-append\` |
| 改前归档 | `%LOCALAPPDATA%\.markpilot\draft-archive\` |
| review 持久化 | 浏览器 `localStorage`，key 前缀 `dsh-markdown-editor-typora:review:v1:` |
| 客户端恢复槽 | `localStorage` + IndexedDB（父窗口 draft store） |

**不要删除用户目录、`~/.dsh`、attachments 或任何非本测试产生的恢复/归档文件。** 测试清理只允许按路径字面量清理自建探针文件。

---

## 2. 架构与权威边界（读后续任务前必须理解）

### 2.1 分层

| 层 | 拥有的东西 | 当前实现 |
|---|---|---|
| renderer iframe | CM6 `EditorState`：正文、选区、撤销历史、IME、装饰 | `renderer-cm6/cm6/`，逐字节同步 |
| 父窗口 client | 保存身份：path / version / generation / recovery slot / review 横幅 | `lib/client.js` |
| 宿主 `documents-service` | 当前正文权威选择、revision token、applyEdits、review group、recover、merge3 | `lib/documents-service.js` |
| `LiveDocuments` room | 多 client 的 checkpoint + 增量、epoch/version/saved、成员 | `host/live-documents.js` |
| 磁盘 | 最终字节；`ctx.fs` 版本守卫 + 原子替换 | `ctx.fs` / host native worker |
| DSH 内核 | 文件工具、连接认证、插件生命周期 | 只读依赖，当前没有改内核 |

### 2.2 四个“真相”是理解所有 bug 的入口

1. **CM6 buffer**：内存里的正文，是用户看到的文本；崩溃即消失。
2. **父窗口 mirror + IndexedDB WAL**：恢复草稿、连续 delta；关闭后还在。
3. **LiveDocuments room**：SQLite 的 checkpoint + `changes`；跨 client/重启还在。
4. **磁盘文件**：`ctx.fs` 的 version + CAS。

这四者没有天然相同的 revision。B3 的 `documents-service` 就是在宿主侧选一个当前权威，并把 AI 的读写固定到它上面；它没有把四个真相合并成一个。**B5 要解决的正是这个根本分裂。**

### 2.3 当前 authority 规则（B3）

`documents.read` / `applyEdits` 先做：

```text
target = resolve(path, cwd)
canonical = canonicalTarget(target)
provider = apiOpen(target, MODEL_TOOL)       // 文本 + ctx.fs version
room = localRoomPath(target) ? live.readRoom(canonical) : null
diskChanged = room ? normalize(provider.text) !== room.savedText : false
```

选择顺序：

1. **有活成员（`members > 0`）**
   - 只有本宿主成员且 `diskChanged === false` → **buffer 权威**，revision `rev1:live:<epoch>:<version>:<sha>`。
   - 只有本宿主成员、房间干净、磁盘已变 → **disk 权威**，`external:true`，revision `rev1:disk:...`。
   - 房间脏且磁盘也变 → **conflict 权威**：读取返回 buffer + `conflict:true`；写一律 `MP_DOC_EXTERNAL_CONFLICT`。
   - 有非本宿主成员（旧 EXE / 另一个 DSH 实例）→ disk 权威；脏则 `unsavedElsewhere:true`，写拒绝。
2. **房间脏但无活成员** → `orphanDraft:true`，读磁盘文本，写拒绝 `MP_DOC_ORPHAN_DRAFT`；草稿只能显式恢复。
3. **无房间** → disk 权威，写走 `ctx.fs` CAS。

### 2.4 关键不变量（任何后续改动都不能破坏）

- **I1** 磁盘写入必须带 CAS；不能新增绕过 `ctx.fs` 的写者。
- **I2** 房间 append 在同一事务校验 `epoch + version + materialize == baseText`；不满足零变化。
- **I3** append 不修改 `saved`/disk；AI 编辑不产生“已保存”假象。
- **I4** 一次 `applyEdits` 最多推进一个房间版本（一组 edits 合并为一笔 change）。
- **I5** 改脏缓冲前必须有独立归档；归档失败则不应用。
- **I6** 不把“宿主进程已死的脏房间”当权威；死草稿只能显式恢复。
- **I7** 不改 renderer 字节时 `sync-core --check` 必须绿；改了就必须重新构建与同步。
- **I8** `documents.read` 不产生写入（不建库、不建房间、不清 recovery）。
- **I9** review 期间不自动保存；必须先“保留并保存”或“撤销”。
- **I10** 任何“过期/无权限/不一致”默认失败，不自动合并、不自动覆盖。
- **I11** review group 必须是最新未撤销组；组链必须连续；inverse changes 必须匹配当前正文。
- **I12** 恢复副本只在持久化 checkpoint 成功后清理；不能先删旧副本再写新内容。

### 2.5 当前客户端 review 实现（P0 的核心）

代码位置：

| 功能 | 位置 |
|---|---|
| review store key | `lib/client.js:693` 附近 |
| review 持久化 | `persistReviewState()`，`lib/client.js:5873` |
| review 恢复 | `restorePersistedReview()`，`lib/client.js:5892` |
| 应用回执/恢复后显示 | `commitApplied()`，`lib/client.js:5668` |
| 保存抑制 | `scheduleSave()` 中 `reviewSuppressesSave(doc)`，`lib/client.js:5961` |
| 撤销/保留动作 | `reviewUndo()` / `reviewKeep()`，`lib/client.js:6934` 起 |
| host 审阅组 | `documents-service.js` 的 `reviewGroup` / `reviewGroups` / `undoGroup` / `undoGroups` |

本地存储记录形状：

```json
{
  "v": 1,
  "pathKey": "d:/.../readme.md",
  "baseVersion": "rev1:live:...",
  "groups": ["uuid"],
  "count": 1,
  "at": 179...
}
```

规则：

- `pathKey` 把反斜杠转 `/` 并小写；
- `baseVersion` 必须等于打开时的 `doc.lastVersion`；
- group 1–20 个、UUID、无重复、count 不小于 group 数；
- 干净打开不立即恢复，也不立即删除；等异步 recovery-slot 探测确认没有未保存内容后再删；
- 有恢复草稿时保留记录，恢复后 `commitApplied()` 再恢复 review；
- review 期间不自动保存；
- `保留并保存` / 撤销成功 / group 过期时清除记录。

### 2.6 发布/安装口径

- 源码 profile 使用 junction，指向仓库目录；当前运行的就是 1.8.1 源码。
- 市场条目的 tarball 指向 GitHub Release，不指向 npm（npm 也提供同一 tarball）。
- 若改成 npm 解包安装，必须重启宿主；不要在运行中替换 `node_modules` 目录。
- npm 发布需要 **WebAuthn 安全密钥 2FA**；`npm publish` 会打印浏览器认证 URL，完成安全密钥后回车。发布成功后 `npm view --prefer-online` 才能看到最新版本，CDN/代理缓存可能滞后几分钟。

---

### 2.7 前期调研：主流与前沿编辑器的处理方式

> 调研目的：给 B4.2b-full / B4.3 / B5 找可复用的成熟模式，避免自己发明一套“文档权威 + 撤销 + 冲突”的语义。
> 调研快照：2026-11；链接以官方文档/源码为准。这里记录的是**架构模式**，不是让 MarkPilot 照搬产品功能。

#### 2.7.1 一张表

| 项目 | 文档/更新模型 | 撤销与审阅 | 冲突/协同 | 持久化与恢复 | 对本项目最有价值的一点 |
|---|---|---|---|---|---|
| **CodeMirror 6** | 不可变 `EditorState` + `Transaction`；`ChangeSet` 描述区间替换；扩展用 StateField/annotation | `@codemirror/history` 扩展；事务可带 annotation/metadata；远端事务可不进本地历史 | `@codemirror/collab` 以中央 authority + rebase 为核心，不是 CRDT | 本身不管磁盘；view 只渲染 viewport | **事务是唯一写入口**；review 应做成 transaction annotation/group，而不是只在外层拼 group |
| **VS Code / Monaco** | 共享 `ITextModel`（Monaco core）；所有编辑是 model 上的操作；`versionId` 单调递增 | `pushStackElement()` 把一组编辑合成一个 undo 元素；`alternativeVersionId` 用于撤销/重做后的版本判断 | 多编辑器共享同一 model；AI 修改进入 working set，Keep/Undo；冲突用 3-way merge editor | 保存/备份/hot exit 由 workbench 管理；model 可恢复 | **一个 model 权威** + **显式 undo 组边界**；AI 修改先 review 再 Keep/Undo |
| **ProseMirror** | 不可变文档树 + `Transaction`/`Step`；所有更新经 transaction | `prosemirror-history` 观察 transaction、存 inverse；transaction meta 控制是否进历史 | `prosemirror-collab` 中央 authority 接受/拒绝 steps，客户端 rebase | 序列化 JSON/HTML；持久化由应用负责 | **所有更新必须经过单一 transaction pipeline**；undo 的“逆操作”应基于操作记录，而不是文本 diff |
| **Lexical** | 不可变 `EditorState` 快照；`editor.update()` 内批量修改，commit 后锁定 | 历史可由内置 history 或协作层管理；更新监听器拿快照 | 协作模式让 Yjs 拥有初始状态（`initialEditorState: null`），Lexical 不做第二权威 | 序列化 JSON；持久化由应用负责 | **状态快照 + 单一 update 入口**；协作时明确“谁是初始权威” |
| **Zed** | CRDT 文本/多 buffer；锚点、tombstone 处理删除与并发 | 编辑历史与协作层结合 | 实时多人协作；CRDT 保证收敛 | 本地文件 + 协作会话 | 若真要做 CRDT，**锚点/墓碑/undo 语义**是核心成本；单机不需要先付这个成本 |
| **Obsidian** | Markdown 文件 + 编辑器 buffer；文件是长期权威 | 文件恢复快照可查看差异/恢复 | 无内建实时协同（Sync 另算） | **File Recovery** 定期保存完整快照，存在 vault 外，保留期可配；可 diff/restore | **周期快照 + 显式恢复 UI** 是比“只存增量”更稳的兜底；MarkPilot 已有 archive/recovery，但还没有周期快照产品化 |
| **Yjs（协作库）** | CRDT 共享类型（Y.Text 等） | `Y.UndoManager` 可按 shared type/origin 选择性撤销；`captureTimeout` 合并编辑；`stopCapturing()` 切组；StackItem 可带 cursor meta | CRDT 自动收敛；适合离线/多 writer | 需要持久化 update/state | **选择性 undo + origin/组边界**的成熟参考；但引入 CRDT 会把 Markdown 文本变成 CRDT 文档，成本高 |
| **VS Code Copilot / AI 编辑器** | 编辑器 model + AI working set | AI 改动先进 working set，Keep/Undo；diff review；可恢复 checkpoint | 冲突不自动覆盖；用户决定 | 由编辑器保存/checkpoint | **AI 修改默认是 pending review**，不能直接落盘；与我们的 review 方向一致，但我们还缺原生 undo/装饰 diff |
| **Git / VS Code merge editor** | 共同 base + ours/theirs 三方 | 逐冲突 Accept Current/Incoming/Both/Compare；Result 面板可手改 | 3-way merge；不可自动合并时人工决定 | 保存/暂存后完成合并 | B4.3 的直接参考：**base / current / incoming / result** 四区 + 逐块选择 + 手动编辑 |

#### 2.7.2 CodeMirror 6：事务是不可变状态的唯一入口

官方系统指南明确把架构分成“函数式核心、命令式外壳”：

- `EditorState` 是不可变值；旧 state 仍完整可用；
- 编辑通过 `Transaction` 描述，`dispatch` 后才产生新 state；
- 事务可以带 **annotations**（例如 `userEvent`）和 **effects**；
- `ChangeSet` 是纯值，扩展可以精确追踪变化，因此 undo history、collaborative editing 可以在 core 外实现；
- 文档变化位置全部相对“事务开始文档”，multiple changes 一次性描述；
- 重置文档推荐**新建 state**，而不是发一个事务，避免旧 undo history 残留。

官方指南：<https://codemirror.net/docs/guide/>

对本项目的含义：

1. 我们已经在用 CM6，但 review 仍然在外层 client 拼 group；**B4.2b-full 应把 review group 做成 transaction annotation/state field**，让 CM6 自己知道“这组变更属于同一个 review”。
2. 远端事务本来就可以不进本地 history；如果要让 Ctrl+Z 整组撤销 AI 修改，必须由 renderer 侧产生带 annotation 的事务，并明确 `addToHistory` 语义；不能只靠 host 的文本 inverse。
3. CM6 官方把 collaboration 作为独立包，核心不绑定 OT/CRDT；这支持我们“先把本地做稳，再决定协同”的路线。

#### 2.7.3 VS Code / Monaco：一个 Model + 显式 undo 组

VS Code 的源码组织把 Monaco Editor Core 放在 `src/vs/editor`，workbench 只是宿主；Monaco 的 `ITextModel` 是多个编辑器共享的文档 model。

源码事实（可直接搜索）：

- `src/vs/editor/common/model.ts` 定义 `pushStackElement()`；
- `src/vs/editor/common/model/editStack.ts` 负责 undo/redo 栈，记录 `alternativeVersionId`；
- `src/vs/editor/common/model/textModel.ts` 有 `_alternativeVersionId`，`pushStackElement()` 调 `_commandManager.pushStackElement()`；
- `versionId` 单调递增，`alternativeVersionId` 用于“撤销后是否回到某个历史状态”的判断。

源码：<https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/model/editStack.ts>
<https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/model/textModel.ts>

AI 审阅的产品模式（VS Code Copilot 文档）：

- AI 改文件后进入 **working set**，用户可以 **Keep / Undo**；
- 可以打开变更文件的 diff；
- 有 checkpoint 恢复；
- Keep 只是清除 pending review，不等于自动提交 Git。

文档：<https://code.visualstudio.com/docs/copilot/chat/copilot-edits>

对本项目的含义：

1. **一个权威 model + 一组显式 undo 边界**比“多个真相 + 文本 diff”可靠；B5 的 `DocumentSession` 应参考这个形状。
2. AI 修改默认 pending，用户 Keep/Undo；我们 1.8.1 的 review 已经方向正确，但 **undo 边界在 host，不在 renderer**，这是 B4.2b-full 要补的。
3. `alternativeVersionId` 的教训：**版本号不是内容哈希**；跨撤销/重做/重开时，不能用“版本号相等”判断“内容相同”。1.8.1 的 epoch/sha 误判就是同类问题的变体。

#### 2.7.4 ProseMirror：所有更新经过 transaction，undo 存 inverse

ProseMirror 指南的核心：

- 文档是持久化（不可变）值；每次更新产生新文档；
- 所有更新经过 `Transaction`；`prosemirror-transform` 记录可重放的 steps；
- `prosemirror-history` 通过观察 transaction、保存 inverse 来实现 undo；
- transaction 可以带 metadata（如 `addToHistory:false`）；
- collaborative editing 使用**中央 authority**：authority 决定 step 顺序；并发客户端被拒后 rebase 再提交。

文档：<https://prosemirror.net/docs/guide/>

对本项目的含义：

1. 我们 host 的 `merge3` 是“行级 diff + 全文替换”，不是 step/transaction；B5 如果要做真正的 intent pipeline，应把“操作”而不是“最终文本”作为协议的一部分。
2. 中央 authority 与我们现在 `LiveDocuments` 的房间模型同构；**不需要为了协同先上 CRDT**。
3. transaction metadata 是 review group 的天然载体；这与 CM6 的 annotation 是同一思路。

#### 2.7.5 Lexical：不可变快照 + 明确的初始权威

Lexical 官方文档：

- “source of truth is not the DOM, but an underlying state model”；
- EditorState 在 update 期间可变、commit 后不可变；
- 更新必须通过 `editor.update()`，异步工作要先做完再进入 update；
- 协作时可以让 Yjs 拥有初始状态（`initialEditorState: null`），Lexical 不抢初始权威；
- `getEditorState()` 是已提交快照，`setEditorState()` 用于设置状态。

文档：<https://lexical.dev/docs/concepts/editor-state>

对本项目的含义：

1. “谁是初始权威”必须在协议里写死；B5 的 session 打开时要明确 disk/buffer/mirror 哪个是初始值。
2. 异步操作（读取 recovery、拉取远端）必须在进入写事务前完成；不能在一个 update 里 await 后再改状态。

#### 2.7.6 Zed：CRDT 的锚点与墓碑

Zed 官方文档确认它支持实时多人协作；其源码中 `crates/text`、`crates/multi_buffer` 使用 CRDT 语义，测试与注释提到 tombstone、CRDT order、anchor。源码搜索可见：

- `crates/editor/src/selection.rs` 注释提到删除的 CRDT fragment 保留为 tombstone；
- `crates/multi_buffer/src/multi_buffer_tests.rs` 讨论 anchor 在 CRDT order 中的位置。

文档：<https://zed.dev/docs/collaboration>
源码：<https://github.com/zed-industries/zed/tree/main/crates/text>

对本项目的含义：

- CRDT 不是“加个库”那么简单：锚点、墓碑、undo、选区映射都要重做；
- MarkPilot 当前是单机 + live room OT，**没有必须上 CRDT 的需求**；B5 的默认方案应是中央 session + CAS，CRDT 只在明确多 writer 离线场景再评估。

#### 2.7.7 Obsidian：周期快照 + 显式恢复

Obsidian 的 File Recovery：

- 定期保存**完整快照**（默认最短 5 分钟，保留 7 天，可配置）；
- 快照存在 vault 外（全局设置目录），按绝对路径索引；
- 可查看差异、复制或恢复；
- 明确说明它不是完整备份方案。

文档：<https://help.obsidian.md/plugins/file-recovery>

对本项目的含义：

1. MarkPilot 已有 `agent-before` 归档 + recovery slot，但这是“事件驱动”的；
2. 可考虑增加“周期快照”（尤其是大文档/长时间编辑），但必须先解决保留策略、磁盘上限和隐私；
3. 恢复 UI 的“查看差异/复制/恢复”三动作值得借鉴；不要做“一键自动恢复”。

#### 2.7.8 Yjs UndoManager：选择性撤销与组边界

Yjs 的 `Y.UndoManager`：

- 可绑定一个或多个 shared type；
- 默认追踪本地、无 origin 的修改；
- `trackedOrigins` 可以只追踪指定来源；
- `captureTimeout` 默认 500ms，合并相邻编辑；
- `stopCapturing()` 强制下一笔不合并；
- StackItem 可存 cursor meta，撤销时恢复。

文档：<https://docs.yjs.dev/api/undo-manager>

对本项目的含义：

- “review 组”本质上是一个 **capture boundary**：AI 的一次 applyEdits 必须是不可与用户输入合并的组；
- 我们的 host group 已经做到“组边界”，但 renderer 历史没有；B4.2b-full 应对齐这个语义；
- 若未来做 CRDT，UndoManager 的 `trackedOrigins` 可以直接表达“只撤销 AI/只撤销用户”。

#### 2.7.9 AI 编辑器：pending review 是行业默认

VS Code Copilot 的 working set / Keep / Undo / diff / checkpoint 说明：

- AI 修改默认不直接成为“已接受”；
- 用户先 review，再 Keep 或 Undo；
- diff 是审阅的主要界面；
- checkpoint 是失败恢复，不是自动保存。

这与 MarkPilot 1.8.1 的 review 方向一致；差距是：

- 我们没有 CM6 原生 undo group；
- diff 是 client 文本面板，不是编辑器装饰；
- review 关闭/重开依赖 localStorage，不是内核状态；
- 没有“多文件 working set”概念（MarkPilot 单文档，暂不需要）。

#### 2.7.10 冲突 UI：VS Code 3-way merge editor 是直接范式

VS Code 的 merge editor：

- 三栏：Incoming（左）/ Current（右）/ Result（下）；
- 每个冲突：Accept Current / Accept Incoming / Accept Both / Compare；
- Result 可直接手动编辑；
- 有 unresolved count，全部解决后 Complete Merge；
- base 视图可切换。

文档：<https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts>

B4.3 应直接采用这套交互语义，而不是自创：

- **base / ours / theirs / result** 四区；
- 每个 hunk 四选一 + manual；
- 未解决计数；
- 应用前不写盘；
- 结果面板可手改；
- 完成后进入 review（保留/撤销），而不是直接保存。

#### 2.7.11 对本项目的直接结论

**应该借鉴的：**

1. **单一权威 model + 单一更新入口**（VS Code model / CM6 transaction / ProseMirror transaction / Lexical update）。
2. **显式 undo 边界**（VS Code `pushStackElement` / Yjs `stopCapturing` / CM6 annotation）。
3. **AI 修改 pending review**（VS Code working set / Keep/Undo）。
4. **3-way 冲突 UI + 逐块选择 + 手动 result**（VS Code merge editor）。
5. **周期快照作为恢复兜底**（Obsidian File Recovery），与现有 archive/recovery 互补。

**不应该照搬的：**

1. 不要为了“前沿”直接引入 CRDT；Zed 的锚点/墓碑/undo 成本很高，当前没有多 writer 离线需求。
2. 不要把 Markdown 改成富文本 block model；MarkPilot 的差异化和兼容性都建立在 Markdown 纯文本上。
3. 不要在没有 renderer 构建/五通道预算时改 CM6 core；1.7.6 已经证明代价。
4. 不要把“版本号”当“内容身份”；1.8.1 的 sha 修复是必要基础。

**对 B5 的最终建议：**

- 采用 **宿主 DocumentSession + 单一 intent 入口**（方案 A），参考 VS Code model + ProseMirror transaction；
- 保留 CM6 作为 view，不把权威放进 renderer；
- review/undo 用 **transaction annotation + host group 双写校验**，而不是文本 diff；
- 冲突用 B4.3 的 3-way session；
- CRDT 仅作为未来可选，不进入 B5 第一阶段；
- 任何“统一四个真相”的改动都必须保留现有 CAS、归档、fail-closed 不变量。

---

## 2.8 已复现的用户报障：引用区 Shift+Enter 与 Ctrl+B

> 状态：**已复现，未修复**。这两项属于引擎 `dsh-markpilot/src-cm6` 的行为，插件与独立 EXE 共用同一套 CM6 内核；当前 1.8.1 插件实测已复现。修复需要走 renderer/core 构建链，不能只改 `lib/client.js`。

### 2.8.1 复现环境

| 项 | 值 |
|---|---|
| 插件 | `dsh-markdown-editor-typora@1.8.1` |
| 内核 | CM6 `3.6.17`（`coreHash=4499e...`） |
| 系统 | Windows 10/11，中文输入法，DSH Web GUI 内嵌 MarkPilot |
| 测试文件 | `D:\BuyKey\Typora-Editor-App\zz-quote-bug-20261110.md`（测试后删除） |
| 初始 Markdown | 见下 |

初始内容：

```markdown
# Quote Test

> alpha
> beta
> gamma

outside
```

“连续引用区”指连续的 `> ` 行在渲染上是一个整体 blockquote；中间任何一行丢掉 `>` 都会被 CommonMark 当成引用区结束。

### 2.8.2 问题 A：Shift+Enter 在引用区内换行会隔断引用区

**实测 1：光标在 `beta` 中间（`bet|a`），按 Shift+Enter**

结果缓冲区：

```markdown
# Quote Test

> alpha
> bet
a
> gamma

outside
```

- 新行 `a` **没有 `>` 前缀**；
- 渲染上 `a` 落到引用区外，连续引用被切成两个 block；
- 原 `beta` 的剩余内容没有带回引用前缀。

**实测 2：光标在 `alpha` 行尾（`alpha|`），按 Shift+Enter**

结果缓冲区：

```markdown
# Quote Test

> alpha

> beta
> gamma

outside
```

- 插入的是**裸空行**，不是 `>` 空行；
- 渲染上 `alpha` 与 `beta/gamma` 成为两个独立引用块；
- 用户在视觉上看到“引用区中间被隔开”，与描述一致。

**代码层原因（已定位到入口）**

- 引擎没有为普通 blockquote 的 `Shift-Enter` 注册自定义命令；`Shift-Enter` 走 CM6 默认换行路径（`insertNewline`/默认 keymap），只插入 `\n`，不会复制当前 blockquote 的 `quoteLead`。
- `markdown-context.js` 已有 `quoteLead(text)`（`/^ {0,3}>[ \t]?/` 可解析嵌套 `> >`），但 Shift+Enter 路径没有使用它。
- `src-cm6/main.js` 中唯一显式的 `Shift-Enter` 特判在**表格单元格**（`tables.js` 的 `<br>` 语义），普通引用区没有对应分支。
- 因此这不是“CSS 显示问题”，是**写进缓冲区的 Markdown 字节少了 `>` 前缀**；保存后磁盘文件也会缺。

**期望行为（按用户要求固定）**

在连续引用区任意光标处按 Shift+Enter，必须保证：

1. 换行后仍在同一个连续引用区；
2. 新行带当前引用前缀；嵌套引用保留全部层（`> > `）；
3. 原有后续行不丢前缀；
4. 行尾按 Shift+Enter 产生**引用区内的空行**（建议写成 `>` 或 `> ` 的行）；
5. 单元格内 Shift+Enter 仍保持表格的 `<br>` 语义，不被本修复影响；
6. 普通段落、列表、代码块行为不变。

建议的目标形态：

```markdown
> alpha
> beta
>
> gamma
```

中间换行：

```markdown
> bet
> a
```

（即插入 `\n` + 当前完整 `quoteLead`，而不是裸 `\n`。）

**修复方案（待设计对抗，不在本文件落码）**

1. 在 `main.js` 增加 `Prec.high` 的 `Shift-Enter` 命令，作用域仅普通编辑面，排除表格单元格/覆盖层：
   - 取当前行 `line.text`，用 `quoteLead` 得到 `{off, depth, q}`；
   - `depth===0` 时回退默认 `insertNewline`（不改普通段落）；
   - 有选区时先删除选区；在光标处插入 `\n` + `q`；
   - 光标落到新行 `q` 之后；
   - 若光标位于行首前缀之前/之中，按“保持当前引用层”规则钳制。
2. 若光标在行尾且下一行也是引用行：插入 `\n` + `q`，得到 `> alpha\n> \n> beta` 这类连续引用；需要验证 CommonMark 是否把 `>` 空行仍算同一 blockquote（用项目内 markdown parser/真机双重验证）。
3. 若当前行是 nested quote，`q` 必须是完整 `> > `；不能只加一层。
4. 若当前行在 quote 内的列表中，Shift+Enter 的语义需要单独定义（引用层优先还是列表层优先），先做设计对抗，不直接改。
5. 新增探针/单测：
   - `quoteLead` 解析：`> `、`>>`、`> > `、带 0–3 空格缩进；
   - 中间/行尾/行首/嵌套引用四种插入；
   - 表格 Shift+Enter 回归；
   - 普通段落 Shift+Enter 回归；
   - 存盘后 Byte 级断言（不是只看渲染）。

### 2.8.3 问题 B：引用区选中后 Ctrl+B 无效 / 跨行时写坏标记

**实测 1：在引用区内双击选中单个词 `alpha`，按 Ctrl+B**

缓冲区结果：

```markdown
> **alpha**
> beta
> gamma
```

- 这个形态下 **B 是生效的**，与用户“完全无效”的描述不一致；
- 说明 `Mod-b → wrapInline('**')` 的 keymap 和 `wrap` 主路径本身可用。

**实测 2：从引用区一行拖选到另一行（选区包含 `> ` 前缀/换行），按 Ctrl+B**

选区大致为 `alpha\n> beta`，结果：

```markdown
> alpha
****> beta
> gamma
```

- `**` 被加在 `> beta` 前面，形成 `****> beta`；
- 这不是合法的“把选中文段加粗”，渲染上也不显示为用户期望的粗体；
- `> gamma` 行仍在缓冲区，但前一行标记结构已坏，整段引用显示异常。

**实测 3：同样的跨行选区按 Ctrl+I**

结果：

```markdown
> *alpha
> beta*
> gamma
```

- 斜体标记跨行落在 `alpha` 开头和 `beta` 结尾，同样不是合法的逐行斜体；
- 所以“I/U 正常”只在**单行内容选区**成立；跨行/含引用前缀时 I/U 也会写坏。

**代码层原因（已定位）**

- `extras.js` 的默认键表（`DEFAULT_KEYS`）把 `bold` 映射到 `Mod-b`，`ACTIONS.bold` 调 `deps.wrapInline(v,'**')`；与工具栏按钮共用 `toolbar.js` 的 `wrap`。
- `toolbar.js` 的 `wrapSingle` 把选区文本 `sel` 原样包在 `**...**` 里：
  - 选区不含换行、不含 `> ` 前缀时，结果正确；
  - 选区跨行或包含 blockquote 前缀时，`**` 会包住 `> ` 或换行，产生非法 Markdown；
  - `enclosingSpan` 只按 `doc.lineAt(from)` 判断，不能处理跨行结构。
- 因此**跨行/含前缀的 B 与 I/U 是同一类 bug**，不是 B 独有。
- 用户报告的“B 完全无效、I/U 正常”还有第二种可能：**按键根本没到达 `wrap`**。需要区分：
  1. `mp-keys` / 快捷键设置里 `bold` 被保存为空或别的组合；
  2. DSH 父窗口在捕获阶段截了 Ctrl+B（`defaultPrevented=true`）；
  3. 选区起点/终点落在引用前缀或隐藏标记上，`wrap` 视作“已包裹/不可包裹”而返回；
  4. 输入法/键盘布局吞键。

**必须先做的 B-only 诊断（不要直接改 wrap）**

- 引擎已有 `window.__keyLog`（`main.js:8203` 附近）记录 `key + shift + defaultPrevented`；对比按 Ctrl+B/I/U 时 iframe 是否收到事件、是否 `prevented`。
- 读取 `localStorage['mp-keys']`（快捷键设置），确认 `bold` 的值；不要假设默认表生效。
- 在 `ACTIONS.bold`/`wrap` 入口加**一次性自证计数**（`window.__mpBoldCalls++`），复验“事件到没到、wrap 进没进、进了返回什么”。
- 用同一个选区分别按 B/I/U，记录 `sel` 的原文/起止位置；先证明三者的选区完全相同。
- 如果事件没到编辑器 ⇒ 快捷键/父级拦截问题；如果到了但 wrap 未改文档 ⇒ wrap/选区判定问题。两条修法完全不同。

**修复方案（待设计对抗）**

1. **选区规范化**：在 `wrap` 前把每个 selection 的文本按行拆开，剥离 `quoteLead`/列表/标题前缀后再格式化；保留原前缀。
2. **单行内容选区**：只把内容段包 `**`/`*`/`<u>`，不得把 `> ` 包进去。
3. **跨行选区**：
   - 逐行格式化每行的内容段（Typora 语义），或
   - 明确拒绝并 toast “引用/列表内跨行格式暂不支持”，但绝不能写出非法 Markdown。
   先做产品决策，不能默默写坏。
4. **嵌套引用/列表**：用 `quoteLead` 的完整 `q`；不要只剥第一层。
5. **空选区**：保持现有 `**|**` 占位行为，但同样要排除前缀区。
6. **快捷键层**：如果诊断证明是 `mp-keys` 覆盖，修复设置迁移/显示；如果是父级拦截，不能靠改 wrap 解决，必须在 keymap/宿主层处理。
7. 新增单测/探针：
   - 单行内容选区 B/I/U；
   - 选区含 `> ` 前缀；
   - 跨两行引用、嵌套 `> >`；
   - 选区含列表/引用混合；
   - 工具栏按钮与快捷键结果逐字节一致；
   - Ctrl+B 事件到达自证。

### 2.8.4 两项的优先级与验收

- **P1（格式正确性/用户可见）**：两项都应在本轮引擎修复中处理；不要只修 B 或只修 A。
- 两项都不能只改 `lib/client.js`；必须改 `dsh-markpilot/src-cm6`，走 `build-from-source.cjs` / 引擎同步链，更新 `coreHash`。
- **独立 EXE 与插件共用引擎**：修复后必须同时验证插件和独立 EXE；本轮只复现了插件，未在本次单独启动 EXE 复验。
- 验收必须包含：
  - 中间/行尾/行首/嵌套引用的 Shift+Enter；
  - 单行/跨行/含前缀的 B/I/U；
  - 表格 Shift+Enter `<br>` 回归；
  - 存盘字节断言；
  - 视觉截图（引用区没有被切成两块、粗体真的渲染）；
  - 五通道真实键鼠（键盘、鼠标、组合键、键鼠配合、拖拽选区）。

### 2.8.5 复现记录表（供后续追加）

| 编号 | 操作 | 期望 | 实测 | 状态 |
|---|---|---|---|---|
| Q-A1 | `bet|a` Shift+Enter | `> bet\n> a` | `> bet\na`，`a` 出引用 | **失败** |
| Q-A2 | `alpha|` Shift+Enter | `> alpha\n>\n> beta` | `> alpha\n\n> beta`，裸空行断引用 | **失败** |
| Q-B1 | 双击 `alpha` + Ctrl+B | `> **alpha**` | `> **alpha**` | 通过 |
| Q-B2 | 跨行选区 + Ctrl+B | 合法逐行粗体或明确拒绝 | `****> beta` / 结构错乱 | **失败** |
| Q-B3 | 跨行选区 + Ctrl+I | 合法逐行斜体或明确拒绝 | `*alpha\n> beta*` | **失败** |
| Q-B4 | 用户报告的“B 完全无效” | 需定位键事件/配置 | 本轮未复现；单行 B 生效 | **待定位** |

> 注：Q-B4 不能因为 Q-B1 通过就关闭；必须按 §2.8.3 的诊断区分“键没到”和“wrap 写坏”。用户实际选区/快捷键配置需要下一轮采集。

---

## 3. 剩余需求池与优先级

| 优先级 | 任务 | 是否改 renderer/core | 依赖 | 目标 |
|---|---|---|---|---|
| P0 收尾 | review 持久化加固 | 否 | 1.8.1 | 多组链校验、最终验收、清理 |
| P1 | **B4.3 冲突解决界面** | 否（host/client） | P0 | 用户与 AI/磁盘冲突时可见、可选择、零静默覆盖 |
| P1 | B3.3b `liveUnsupported` 宿主草稿 | 可能小改 client | B4.3 可并行 | 引擎无 facade 时 AI 仍能读未保存正文 |
| P2 | B4.2b-full 原生 review | 是（renderer/core） | B4.3 稳定 | CM6 原生 undo group、装饰 diff、Ctrl+Z 整组撤销 |
| P2 | B5 内核权威 buffer/fs intent | 是（内核） | B4 稳定 | 合并四个真相，通用 fs 写受文档会话约束 |
| P2 | 启动性能 | 可能 renderer | 无 | 安全降低首开时间，不破坏显示 |
| P3 | CRDT/协同 | 是 | B5 | 多 writer 离线合并，非当前需求 |

**建议顺序：P0 收尾 → B4.3 → B3.3b → B4.2b-full → B5。** 性能单独排期，不得在 B4/B5 改造期间混做。

---

## 4. P0 收尾：review 持久化加固

### 4.1 已完成

- AI 改 buffer 后 review 横幅 / 差异 / 撤销 / 保留；
- 关闭编辑区不丢 review 记录；
- 重新打开先恢复 recovery，再恢复 review；
- 撤销跨 live epoch 的校验从完整 revision 相等改为**正文 sha** 比较；
- `documents.reviewGroups` 返回 `undoneAt`；
- 单组关闭/恢复/撤销真机通过；
- 多组“一次 `undoGroups` 撤销”在 1.7.0 的日志中已有真实通过记录（`LOG-1.7.0-B4.2B.md`）。

### 4.2 剩余缺口 A：旧 group 链没有校验

**现象**：localStorage 里可能残留历史 group；`restorePersistedReview()` 会把记录里的所有 group 都装回，即使它们与当前正文不连续。测试中出现过“横幅显示 2 组，但只能撤 1 组”，因为其中一组是上一轮探针留下的。

**要求**：

- 恢复前必须验证 group 链连续：
  - 最后一个 group 的 `resultRevision` 内容 sha 必须等于当前正文；
  - 相邻 group 满足 `prev.resultRevision === next.baseRevision`；
  - 任一不满足则丢弃整条记录，不显示 review。
- 需要 host 在 `documents.reviewGroups` 返回 `baseRevision` / `resultRevision`（只读字段；不要暴露文本）。
- 不能只凭 `undoneAt` 判断；已撤销组和“结果不是当前正文”的组都要拒绝。
- 兼容旧记录：读不到 revision 字段的旧记录直接丢弃，不猜测。

**落码点**：

1. `documents-service.js` 的 `reviewGroups` 返回值增加 `baseRevision/resultRevision`（已有 group 审计数据）。
2. `client.js` 的 `normalizeReviewRecord` / `restorePersistedReview` 增加链校验；失败时 `clearPersistedReview()` 并 toast“之前的 AI 修改审阅已过期”。
3. 单测覆盖：连续链、断链、最后一组内容不是当前正文、旧格式无 revision、已撤销组。

### 4.3 剩余缺口 B：最终多组 UI 验收

- 1.8.1 的最后一次双组 UI 验收被宿主退出打断，没有形成完整的现场截图证据。
- 现在 `README` 磁盘干净、无 review/recovery 残留。
- 验收脚本（人力约 5 分钟）：

```text
1. 打开 MarkPilot README；
2. AI 追加 A，追加 B（同一 review）；
3. 确认横幅“2 处（共 2 组）”，磁盘 hash 不变；
4. 关闭编辑区，重开，点“恢复”；
5. review 横幅恢复，点“撤销本次”；
6. 确认两组 undoneAt 都置、正文恢复、磁盘 hash 不变。
```

不要用“点退出 DSH”来模拟重启；这会结束宿主进程。用关闭编辑区（X）或重新打开文档来模拟用户操作。

### 4.4 P0 完成定义

- `npm test` 全绿；
- 单组 + 双组恢复、撤销、保留保存真机通过；
- 旧 group/断链/过期组不会恢复；
- 测试产生的 `agent_group`、`append_recovery`、review localStorage 全部清理；
- README 恢复 `835bff35…`、7825 B；
- 文档更新 `LOG-1.8.1-REVIEW-PERSIST.md` 或补进 `LOG-1.8.0`。

---

## 5. B4.3：冲突解决界面（下一项）

### 5.1 问题

用户有未保存修改，磁盘被外部程序/AI 改了。当前行为：

- `documents.state` 返回 `conflict:true`、`recommended:"resolve"`；
- 客户端只有“重载磁盘版本 / 复制我的内容”的简单横幅；
- 没有 diff 视图、没有逐块选择、没有“保留我的/用磁盘的”结构化协议；
- host 的 `merge3` 只供模型工具使用，客户端拿不到 conflict session。

### 5.2 需求

**用户可见**：

- 冲突横幅明确显示“磁盘与编辑器都改了，未覆盖任何一边”；
- 可打开三栏/逐块视图：base / 我的 / 磁盘；
- 每个冲突可选择：用我的、用磁盘、两边都保留、手动编辑；
- 确认前不写盘、不改 buffer；
- 可取消并保留现状；
- 关闭/重开后冲突会话不能复活成脏写。

**系统要求**：

- 不自动合并；无用户明确确认零写入；
- 冲突会话有 TTL 和一次性 token；
- 过期/正文已变 → 拒绝，保留双方文本；
- 只允许编辑面 UI 调用；**不暴露给模型工具**；
- 大文件有上限与提示，不能把 10MB 文本塞进三栏 DOM；
- 与 review group 兼容：解决后生成的写入应成为可审阅/可撤销的一组。

### 5.3 推荐方案：host 一次性 conflict session

不直接把 `documents.merge3` 开放给客户端；新增三层：

**1. `documents.conflictOpen`（编辑面 authority）**

输入：`path`、`baseRevisionId`（当前 buffer revision）。
行为：

- `authority()` 重新解析；非 conflict 直接返回 `{conflict:false}`；
- 捕获 `baseText = room.savedText`、`ours = room.text`、`other = provider.text`；
- 用 `merge3Text` 计算 hunks；生成 `conflictId`（UUID）、`expiresAt`（10 分钟）、`currentRevision`；
- 存内存 `ConflictSession`（不落盘，进程重启即失效）；
- 返回：

```json
{
  "conflictId": "...",
  "path": "...",
  "baseRevision": "rev1:live:...",
  "currentRevision": "rev1:live:...",
  "baseText": "...",
  "oursText": "...",
  "otherText": "...",
  "hunks": [{ "index": 0, "baseFrom": 1, "baseTo": 2, "base": "...", "ours": "...", "other": "..." }],
  "truncated": false
}
```

**2. `documents.conflictResolve`（编辑面 authority）**

输入：

```json
{
  "path": "...",
  "conflictId": "...",
  "baseRevisionId": "rev1:live:...",
  "resolutions": [
    { "index": 0, "choice": "ours" },
    { "index": 1, "choice": "theirs" },
    { "index": 2, "choice": "both", "separator": "\n" },
    { "index": 3, "choice": "manual", "text": "..." }
  ]
}
```

行为：

- 校验 session 存在、未过期、path/revision 未变；
- 重新读 authority，确认仍是同一 conflict；任何一边又变 → `MP_DOC_STALE`，零写入；
- 在 session 上物化最终文本；生成一次 `applyEdits` 全文替换（或逐 hunk 的 edits，必须不重叠）；
- 走现有 `applyEdits`：归档、buffer append、review group、revision；
- 写成功后删除 session；失败保留 session 供重试；
- 支持 `cancel`：只删 session，零写入。

**3. `documents.conflictCancel`**

只删 session；不影响正文/磁盘。

### 5.4 UI

- 冲突横幅：`磁盘与编辑器都改了；未覆盖任何一边`；
- 按钮：`查看冲突` / `保留我的` / `用磁盘` / `稍后处理`；
- 查看冲突打开 rail 面板：
  - 标题：`第 1/3 处冲突`；
  - 三段：base 灰、ours 绿（我的）、theirs 蓝（磁盘）；
  - 每段单选项：用我的 / 用磁盘 / 两边保留 / 手动编辑；
  - 顶部/底部：`应用选择`、`取消`；
  - 超过 2000 行或 2MB 时只显示块级摘要，禁止自动全部渲染；
- 键盘：Tab 在选项间移动，Esc 取消，Ctrl+Enter 应用；
- 应用后：显示 review 横幅（如产生 group），不自动保存；用户再选择保留或撤销。

### 5.5 不变量

- 确认前零写入；
- 任何 revision 变化都使 session 失效；
- 不自动合并；
- 不覆盖任一边；
- 冲突结果仍走 `applyEdits` 的归档 + revision + group；
- 不在模型工具中暴露 conflict session；
- 不在 HTTP 端点暴露；
- 大文本截断只影响 UI 展示，不截断实际 resolution 输入。

### 5.6 测试

单元：

- `merge3Text` 纯函数：独立改动、重叠、插入/删除、首尾；
- conflict session 过期、revision 变化、path 不一致、重复 resolve；
- 所有 choice 组合的物化文本；
- manual text 长度/换行/CRLF 归一；
- 取消零写入。

API：

- `conflictOpen` 只在 `conflict` 状态返回 hunks；
- `conflictResolve` 写入一次 buffer append、一组 review；
- 并发：resolve 前用户又编辑 → `MP_DOC_STALE`；
- 外部磁盘又变 → `MP_DOC_STALE`；
- 无 authority 的 HTTP 调用拒绝。

真机：

- 编辑器改一段不保存；外部程序改同一段；冲突横幅出现；
- 打开冲突面板，选择“用我的/用磁盘/两边保留”；
- 应用后正文正确、磁盘未自动写；
- 关闭/重开不再重复提示；
- 大文件不卡死；
- 取消后双方文本仍在。

### 5.7 实施顺序

1. host `conflictOpen/Resolve/Cancel` + 单测/API；
2. client 横幅/动作/rail 面板；
3. 真实外部写冲突；
4. 与 review 组合；
5. 文档 `LOG-1.9.0-B4.3C.md`。

---

## 6. B3.3b：`liveUnsupported` 宿主草稿

### 6.1 问题

引擎 facade 缺失（`MP_LIVE_FACADE_MISSING`）时，客户端走单窗口安全模式：

```js
doc.liveUnsupported = true;
showNotice("当前引擎暂不支持跨窗口实时同步，已切换为单窗口安全模式");
```

此时没有 room，`documents.read` 看不到未保存正文；恢复依赖浏览器 IndexedDB，AI 读到的是旧磁盘内容。

### 6.2 方案（分两小步，不要一次做写回）

**B3.3b1 只读镜像（先做）**

- 客户端在编辑后 debounce 发送 `documents.mirror`：
  - `path`、`text`、`baseVersion`、`docToken`、`session`、`sha256`、`bytes`；
  - 只对已打开、有路径的文件；
  - 拒绝 untitled；
  - 限制大小（如 8MB）并返回拒绝原因，不截断。
- host 新增 `draft_index` 表（与 rooms 同一个 SQLite，独立表/独立事务）：
  - key = canonical path；
  - 字段：text、text_sha、bytes、base_version、doc_token、created_at、updated_at；
  - 只存宿主本地草稿，不写磁盘、不建 room、不改变 saved/version。
- `documents.read` 在无 room 时：
  - 先读 provider/disk；
  - 如果 draft_index 有较新 snapshot（base 与磁盘版本匹配），返回 `source:"mirror"`、`draft:true`、`text`、`baseVersion`，并明确 `writable:false`；
  - 如果 base 不匹配，返回 `draftStale:true`，不回传旧草稿正文，避免 AI 在旧基线上编辑。

**B3.3b2 写回（后做，可选）**

- host 只接收编辑面确认后的 `mirrorApply` 队列；
- 写回必须先让编辑面接受（同 `applyEdits` 的 client apply 路径），不能直接写磁盘；
- 没有编辑面 ACK 时只更新 mirror，不写；
- 任何 stale 都拒绝；
- 关闭/保存/丢弃时清理 mirror 行；
- 重启后可定位草稿，但恢复仍由用户确认。

### 6.3 验收

- facade 被禁用时，`markdown.read` 能看到未保存正文；
- `markdown.edit` 返回 `writable:false`，不写盘、不抢编辑器；
- 磁盘版本变化后，旧 mirror 不返回正文；
- 重启后草稿可定位；
- 清理 mirror 不影响 rooms/recovery；
- 大文本/二进制/untitled 有明确错误。

### 6.4 风险

- 镜像可能成为“第五个真相”；必须明确它只是**只读投影**，不是权威；
- 不能把 mirror 当 room 用；
- 不能让 mirror 绕过 `ctx.fs` 读策略；
- 需要保留策略，避免无限增长；
- 与 B5 的 document session 有重叠，先做只读版，B5 时再合并。

---

## 7. B4.2b-full：原生 CM6 review / 撤销组

### 7.1 为什么还要做

1.8.1 的 review 是 **client 侧的 group 聚合**：

- AI 的远端事务在 renderer 里是 `Transaction.remote + addToHistory:false`；
- 用户按 Ctrl+Z 不会整组撤销 AI 修改；
- 差异是 client rail 的文本 diff，不是 CM6 装饰；
- review 记录在 localStorage，不在内核；
- review 关闭/重开依赖 client 逻辑。

这对“审阅”够用，但不是内核级语义。B4.2b-full 的目标是：

- AI 修改作为**一个 CM6 transaction/undo group**进入历史；
- Ctrl+Z 可整组撤销，不受普通编辑穿插影响；
- review 状态由 renderer 事务标注 + host group 双向校验；
- diff 用 CM6 装饰而不是简单文本面板（可选）；
- 关闭/重开仍能恢复，但以 host group 为权威。

### 7.2 方案边界

**不要直接改 `renderer-cm6/cm6/app.js`。** 它是 `MarkPilot-CM6` 的构建产物，必须：

```text
MarkPilot-CM6 源码改动
  → build-from-source.cjs
  → sync-core.mjs（逐字节复制 + core.json）
  → sync-core.mjs --check
  → 五通道交互验收
```

**推荐增加 bridge API，而不是让 client 直接操纵 CM6：**

```
dsh-bridge.js / engine facade:
  reviewBegin({ docToken, groupId, label }) -> transaction annotation
  reviewCommit({ docToken, groupId, addToHistory: true })
  reviewUndo({ docToken, groupId })
  reviewDiff({ docToken, groupId }) -> hunks (只读)
```

约束：

- 只能由父窗口经现有 `postMessage` 调用；
- 必须校验 `docToken`/session/generation；
- CM6 不认识 host 的 groupId 时退化为普通 transaction，不能伪造历史；
- host 仍是 group/revision 的权威；renderer 失败时 client 回退到 1.8.1 语义；
- 需要 capability flag；旧 DSH/旧 renderer 不启用原生路径。

### 7.3 状态机

```
remote apply
  -> reviewBegin(groupId) [client]
  -> renderer transaction with annotation
  -> review pending (no autosave)
  -> user:
       undo  -> renderer undo group / host undoGroups (二选一，必须幂等)
       keep  -> reviewCommit(addToHistory) + save
       diff  -> reviewDiff (read-only)
```

“撤销”只能有一个写者：**优先 renderer undo**，成功后通知 host 标记 group undone；renderer 不可用时回退 host `undoGroups`。不能两边都写。

### 7.4 验收

- AI 改 3 处，Ctrl+Z 一次全撤；
- 用户中途编辑再 Ctrl+Z，只撤自己的输入，不误撤 AI 组；
- review 期间不自动保存；
- 关闭/重开 review 恢复；
- 旧 renderer/无 capability 时回退 client review；
- `sync-core --check` 更新为新的 coreHash；
- 五通道：键盘、鼠标、组合键、键鼠配合、拖拽；
- 视觉：diff 装饰/横幅截图。

---

## 8. B5：内核权威 buffer / 通用 fs intent（大改）

> 状态：**尚未编码**。以下是已探索的边界、候选架构和迁移方案；不要把候选方案当已批准实现。

### 8.1 目标

把“同一份正文有四个真相”收敛成一个**文档会话**：

- 一个 canonical path 在宿主内只有一个 `DocumentSession`；
- 编辑器 buffer 是用户输入的唯一入口；
- 磁盘是持久化结果，不是并发写入口；
- 模型/AI 的修改通过 **document intent**，不是直接 `fs.editText`；
- 通用 `fs` 写工具受同一会话约束（B2 的已知缺口）；
- 冲突、review、recovery 都成为会话状态机的一部分；
- 可选 CRDT/协同，但不是第一阶段目标。

### 8.2 当前约束与已探明事实

1. **`DocumentStore` 是临时的**：每次保存新建、用完即弃；`revision/lastSavedRevision` 不跨保存。跨请求状态在 `rooms.sqlite` 五张表。B5 的 session 不能建在 `DocumentStore` 上。
2. **`documents-service` 只服务模型工具**；编辑器保存路径 `runSave/pullText/live.save` 完全没动。B5 若改保存路径，等于改产品最核心的数据链路。
3. **通用 `fs` 写工具仍然绕过 B2/B3 守卫**：当前 `createWriteGuard` 只监听 `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent`（`lib/index.js:1846` 起），给干净打开文档加 `replaceIfVersion`/`version` intent；**没有** `fs/patch-intent` / `fs/move-intent`。因此 `fs.patchText`/`fs.moveFile` 可直接写盘。终端、computer-use、任意本机进程天然绕过。B5 补的是这两个事件，不是终端。另一个已知缺口：guard 的 `lookup` 异常走 fail-open（`stateOf` 返回 undefined 时放行），B5 要么保持并记录，要么在设计对抗中决定 fail-closed 的兼容代价。
4. **`documents.*` 没有暴露给 HTTP**；`handleApiPost` 的 authority 为 undefined，端点会拒绝。UI 只能走 plugin client 的 `api()`，模型走 `MODEL_TOOL`。B5 不能把这层打开。
5. **renderer 字节契约**：`core.json` 124 文件、`coreHash=4499e...`；任何 renderer 改动都会触发全量重建/同步/五通道验收。1.7.6 的预热实验已经证明：在这个项目里“看起来只是性能”的 iframe 改动可以直接把 Markdown 显示打坏。
6. **review 的历史包袱**：1.8.1 的撤销曾因为 live epoch/version 变化误判 stale，最终改为按正文 sha 比较。这说明 revision token 的语义必须非常小心；B5 不能把“token 相等”简化成“字符串相等”。
7. **多实例/旧 EXE**：`clients.pid` 是宿主进程；旧 EXE 的 `leave` 会删房。当前规则是“有非本宿主成员就不 append”。B5 必须保留这个防线，直到旧 EXE 全部退役。
8. **归档上限**：单次 `docs/archive` 64MB；超过会 `MP_ARCHIVE_FAILED`。B5 的大文档 session 必须解决分块/旁路归档，不能先改后归档。

### 8.2.1 已经做过的探索与实测结论

这些不是“方案想象”，是已经跑过、会影响 B5 设计的事实：

| 探索 | 结论 | 对 B5 的含义 |
|---|---|---|
| 两 client 交替 130 笔编辑 | `version=130, saved=0, floor=128`；对 `saved=0` 调 `materialize` 得到的是 floor 处 checkpoint，不是 130 笔前的 saved 文本 | 不能无条件用 `savedText` 做共同祖先；`savedTextAvailable` 必须按 `saved >= floor` 判定 |
| 最后 client `leave` | 旧实现会删房，即使房间 dirty；未 ack 的 agent change 曾可能被删 | B3 加了“未 ack agent change 保留房间”的防线；B5 迁移前要保留 |
| 房间有非本宿主成员 | 旧 EXE/另一 DSH 的 `leave` 行为不可控 | 当前规则是有非本宿主成员就不 append；B5 迁移必须保留这道防线 |
| 外部磁盘写 + 脏 buffer | `documents.state` 返回 `conflict:true`；写拒绝 `MP_DOC_EXTERNAL_CONFLICT` | conflicts UI 的触发点已存在，缺的是可操作协议 |
| `documents.*` 无 authority 的 HTTP 调用 | 返回 `bad-request`，不可借 HTTP 绕过 | B5 不要把这层打开；UI 必须走 plugin client |
| B2 `createWriteGuard` | 已监听 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent`；给干净文档加版本 intent，脏文档抛 `MP_DOC_DIRTY` | B5 可沿用同一 `prepend` 事件模式补 `patch-intent`/`move-intent`，不必重写 guard |
| guard 的 lookup 异常 | 目前 fail-open（`warn` 后返回 base） | B5 若要 fail-closed，需评估旧宿主兼容与误拒风险 |
| review 跨 live epoch 撤销 | 旧校验比较完整 revision，重开后因 epoch/version 变化误报 `MP_DOC_STALE`；1.8.1 改为按正文 sha 比较 | B5 的 token 不能简化为字符串相等；必须区分“内容身份”和“进程代际” |
| 1.7.6 iframe 保活/预热 | Markdown 显示不出来，部分启动 `import failed`/404；已回退 | B5/B4.2b-full 任何 renderer 改动都必须有完整构建/五通道/视觉验收预算 |
| `core.json` / `sync-core` | 124 文件、7,351,676 B、`coreHash=4499e...`；1 字节漂移会 `CHECK_DRIFT` | 改内核不是“改一个 JS 文件”；版本身份和同步链是硬约束 |
| `docs/archive` 单次 64MB | 超过返回 `MP_ARCHIVE_FAILED`，B3 选择 fail-closed | B5 大文档 session 必须先解决分块/旁路归档 |

### 8.3 候选架构

#### 方案 A：宿主 DocumentSession（推荐，渐进）

在 `lib/index.js` / `documents-service` 之上增加：

```
DocumentSession {
  canonicalPath
  baseDiskVersion
  baseText
  text
  version
  savedVersion
  members
  state: clean | dirty | review | conflict | recovery | orphan | owned-elsewhere
  undoGroups[]
  reviewGroups[]
  recoverySlot
}
```

- 编辑器通过现有 live/exchange 附着到 session；CM6 仍是 view，不直接写 session。
- 模型 `documents.applyEdits` 改为 session intent；session 统一追加 buffer/review。
- 保存仍是编辑器触发，但 session 负责 CAS 与归档。
- 通用 `fs` 写改为 `fs/patch-intent`：host 先查 session；有 session 且 dirty → 生成 review/conflict，不直接写。
- 优点：复用 B3 authority、房间、review；可 feature flag 回退；不改 CM6。
- 缺点：session 与 room 仍有重叠，需要明确谁持久化；多实例需要 session 归属。

#### 方案 B：renderer 内核 session（更难）

把 session 放进 CM6/engine：

- `EditorState` + transaction annotations 是权威；
- 宿主只做持久化/冲突/审计；
- renderer 提供 `sessionVersion`、`beginIntent`、`applyIntent`、`undoGroup`；
- 需要 renderer/core 大改，跨 DSH 版本兼容难；
- 对 1.7.6 的教训而言，这是最高风险方案。

**结论：先 A，B 只在 A 被证明不够时启动。**

#### 方案 C：CRDT（不做）

Yjs/Automerge 能合并离线/多 writer，但：

- 会把 Markdown 文本变成 CRDT 文档，CM6 需要 binding；
- 需要处理大文档、公式/表格、撤销语义、持久化迁移；
- 现有 room/OT 已经覆盖多数场景；
- 没有明确多 writer 离线需求前，不引入。

### 8.4 建议的 API 形状

不要求一次全做；先定义 intent 协议，再逐步迁移调用方。

```
documents.session.open   { path, cwd } -> session view
documents.session.read   { path, baseRevisionId }
documents.intent.apply   { path, baseRevisionId, edits, kind }
documents.review.begin   { path, baseRevisionId, groupId }
documents.review.decide  { path, groupId, decision: keep|undo, baseRevisionId }
documents.fs.patchIntent { path, oldString, newString, baseRevisionId }
documents.fs.moveIntent  { from, to, baseRevisionId }
documents.conflict.open  { path }         // B4.3 先落地
documents.conflict.resolve { conflictId, resolutions }
```

所有写端点：

- 必须带 `baseRevisionId`；
- 必须经过 authority；
- 必须有归档；
- 必须返回 `revisionId/groupId`；
- 失败保持零变化；
- 不允许 HTTP/无 authority 调用。

### 8.5 状态机

```
disk-clean
  -> user edit / intent -> dirty
  -> external disk change -> external (clean) / conflict (dirty)
  -> save -> clean
  -> AI edit -> review
       -> keep -> dirty -> save -> clean
       -> undo -> dirty/clean (inverse applied)
  -> close with dirty -> recovery
  -> reopen -> recovery -> user restore/discard
  -> no live member + dirty -> orphan
  -> non-local member -> owned-elsewhere
```

每个状态必须有：

- 唯一权威；
- 允许的写操作；
- 归档/恢复路径；
- stale 检测；
- UI 文案与动作；
- 测试。

### 8.6 迁移阶段

**Phase 0 · 冻结与度量**

- 保存 1.8.1 的 `coreHash`、package tarball、测试数；
- 建立 `DocumentSession` 状态机单测，不接生产；
- 定义 capability flag（例如 `documentSession: true`），默认关。

**Phase 1 · 宿主 session 影子**

- 在 `documents-service` 内建立 session，但只做只读/影子计算；
- 对比 session 结果与现有 authority，所有写仍走旧路径；
- 记录差异，不改变用户可见行为。

**Phase 2 · 模型工具切换**

- `markdown.read/edit` 走 session；
- 编辑器保存路径不动；
- review/undo 走 session；
- 回退开关可一键回旧路径。

**Phase 3 · 编辑器附着**

- client 通过现有 live 协议把 buffer 附着到 session；
- session 知道 editor 的 revision/undo 能力；
- 仍不改变保存触发条件。

**Phase 4 · 通用 fs intent**

- 注册 `fs/patch-intent`、`fs/move-intent`；
- 有 session 的路径，通用 fs 写变为 intent；
- 没有 session 的路径仍走 CAS；
- 不承诺拦截终端/外部程序。

**Phase 5 · 冲突/review 原生**

- B4.3 conflict session 与 B4.2b-full 原生 review 并入；
- 保留 client fallback；
- 旧 renderer/旧 EXE 继续按能力降级。

**Phase 6 · CRDT（可选，不默认）**

- 仅在有明确多 writer 离线需求时评估。

### 8.7 回滚

- capability flag 关闭 → 回到 1.8.1 路径；
- session 数据不删，保留只读；
- 旧 package/coreHash 可回装；
- 每一次写都保留 `agent-before` 归档；
- 回滚验收：打开/保存/review/undo/recovery 五条链路恢复到旧行为，且不丢草稿。

### 8.8 未决问题

1. session 持久化到底放 rooms.sqlite 还是新表？谁清理？
2. 多 DSH 宿主实例如何选 owner？租约心跳？
3. 编辑器关闭后 session 保留多久？与 recovery 合并还是分开？
4. untitled 文档是否进入 session？
5. 外部进程写盘（非 fs 工具）是否只能靠 watch 发现，无法阻止？
6. 大文档（>64MB）的归档分块策略？
7. native worker 与 session 的写入顺序/崩溃恢复？
8. CRDT 是否值得引入，还是只做“最后写入者 + 冲突 UI”？
9. 是否允许 session 接管 `runSave`？这是最大风险点，必须有独立设计对抗。
10. 旧 EXE 退役时间表；不退役就必须一直保留 non-local member 防线。

### 8.9 进入 B5 的前置条件

- B4.3 冲突 UI 真机通过；
- review 持久化链校验完成；
- 1.8.x 发布稳定至少一个周期；
- 有独立的设计对抗（不能由实现者自审）；
- 有可回滚的 capability flag；
- 明确“不改变 renderer 字节”还是“接受 coreHash 变更”；后者必须准备完整五通道与视觉验收预算。

---

## 9. 启动性能（暂缓，不要重复 1.7.6）

### 9.1 已测事实

- 点击左侧栏后慢的主因不是按钮/路由，而是 iframe + CM6 启动；
- 实测 iframe/CM6 启动约 **718–775 ms**，总启动约 **853–928 ms**；
- 1.7.6 尝试 iframe 保活 / 空闲预热 / 骨架屏，导致 Markdown 显示不出来（部分启动 `import failed`/404）；
- 1.7.6 已回退，1.7.7 恢复稳定；1.7.6 包已隔离，不要安装。

### 9.2 安全方向

按风险从低到高：

1. **静态骨架/首帧**：左栏点击后立即显示非交互骨架，不提前创建编辑器；
2. **资源预取**：只预取 `app.js/app.css/fonts` 的 HTTP 缓存，不创建 iframe/EditorState；
3. **延迟挂载**：等 tab 真正可见再挂 iframe；
4. **保活**：只在“同 tab 关闭/重开”场景保留编辑器实例，必须证明不会触发 404/显示空白；这是 1.7.6 失败点，优先级最低。

### 9.3 验收

- 首开时间测量（至少 10 次，冷/热分开）；
- Markdown 必须正常渲染（不是只看时间）；
- 关闭/重开、切换 tab、外部修改、保存、review 全部回归；
- 任何预热都不能在隐藏 iframe 里创建第二份文档；
- 失败则立即回退，不合并。

### 9.4 工具调用流式渲染期间按键卡顿（2026-11-10 诊断）

**现象**：AI 连续调用工具、聊天区不断向下追加“工具调用”卡片时，在 MarkPilot 编辑器里按住一个键，会每出现一张新工具卡就卡一下；松开后恢复。

**环境事实**：

- 当前 DSH 桌面进程只有一个 renderer 进程（PID 45812，`--type=renderer`）；聊天 UI 与 MarkPilot 的 iframe 编辑器共享同一个 renderer 主线程。
- 这是**运行时流式渲染卡顿**，与 §9.1 的“首次打开 iframe/CM6 慢”不是同一个问题。

**代码层定位（app.asar 内 `@deepseek-ai/dsh-client-ui-chat`）**：

1. **聊天 transcript 没有虚拟化**。`ChatView` 用 `entries` 直接 `renderSlot("conversation.chat.flow", {entries,...})` 渲染所有行；`useVirtualizer` 只用于右侧 Turn Navigator 的 28px 标记轨，不用于消息正文。
2. **每次 content commit 都可能在 layout effect 里强制滚到底**。`useChatScroll` 的 `processContent()` 在 `useLayoutEffect` 中执行；条件包含 `order.length` / `lastKey` / `running` 变化，且 `reading.followingTail` 为真时调用 `reading.followTail()`。
3. `followTail()` → `ChatViewport.scrollToBottom()`：
   - 读 `clientHeight` / `scrollHeight` / `scrollTop`（`scrollMetrics`）；
   - `reclaimBelow()`；
   - 再读一次 scroll metrics 并写 `scrollTop`。
   这是**一次同步布局读 + 写**，在 layout effect 中运行，发生在浏览器 paint 前。
4. 新工具卡会改变 `order.length` / 行高；若用户正在底部跟随，几乎每张新卡都触发上述路径。长会话中 transcript 行数不断增长，React reconciliation + 整棵 scroll 容器的 `scrollHeight` 计算也随之变贵。
5. 伴随的视觉工作：
   - 工具卡/运行状态有 CSS transition、shimmer/whale 动画、`data-chat-motion` 下的 `margin-top .16s` transition；
   - 工具卡展开/收起还有 `ResizeObserver` 测量；
   - 这些和 scroll 的强制布局叠加，进一步占用主线程。
6. 按键重复（Windows key repeat）由 renderer 事件循环派发；主线程被上述 task 占用时，`keydown/keypress` 会延迟甚至合并。按住键时每一张新工具卡都可能造成一次可感知的 repeat gap；单击时同样有延迟，只是不容易察觉。

**因此主因不是**：

- 不是左栏按钮或路由；
- 不是 MarkPilot 的保存/自动保存；
- 不是 CM6 的 keymap/快捷键处理本身；
- 不是单张工具卡的 JS 特别慢，而是 **transcript 无虚拟化 + 每次工具更新强制滚动/布局 + 同一 renderer 主线程** 三者的叠加，长会话放大。

**建议修复顺序（先低风险，再结构改动）**：

1. **合并滚动到 rAF**：`processContent` 不再同步 `scrollHeight` 读+写；把 follow-tail 合并到每帧一次，使用 `scrollTop = 1e9` 或缓存 metrics，避免 layout effect 里读 layout；同帧多个工具事件只滚一次。
2. **跳过不可见/无需滚动的更新**：只在 `followingTail` 且确实发生高度变化时滚；工具卡切换时若当前已有 pending scroll，合并而不是排队。
3. **虚拟化/延迟已完成 turn**：只保留可视窗口 + 尾部 live 行；或对已完成 turn 用 `content-visibility:auto` + `contain-intrinsic-size`，避免 `scrollHeight` 触发所有历史行布局。
4. **减少运行态动画**：工具卡流式更新时禁用 `margin-top` transition；运行 whale/shimmer 用 `transform/opacity`，并对行加 `contain: layout paint style`。
5. **缩小 React 更新范围**：让 `ChatView` 只订阅尾部变化；工具行按 `callId + status` memo；不要每个 streaming chunk 重建整个 `entries` 数组。
6. **隔离编辑器**：若前三步仍不够，再把 MarkPilot iframe 做成独立 renderer（Electron `webview` / 独立 `WebContents` 或 OOPIF）；这是架构改动，最后做。

**验收/测量**：

- 在 DSH renderer 上用 `PerformanceObserver({type:"longtask"})` 记录工具卡更新前后；确认 long task 落在 chat commit/scroll，而不是 CM6；
- DevTools Performance 看 `Layout` / `UpdateLayoutTree` / `Task` 时长；对比“长会话 vs 新会话”是否随行数增长；
- 按住键 + 连续工具调用，记录 keydown 间隔 p95 与掉帧；目标：无 >50ms 的 repeat gap，长会话不随 transcript 行数线性恶化；
- 先做 1+2（低风险）复测，再决定 3/6；不要先改 CM6 引擎。

---

## 10. 发布与实装 Runbook

### 10.1 版本发布

```powershell
cd D:\BuyKey\markpilot-public\dsh-markdown-editor-typora
# 1. 改 package.json version
npm test
node scripts/sync-host.mjs --check
node scripts/sync-core.mjs --check
npm pack --json
# 2. 提交、推送 main、创建 GitHub release（附 tgz）
# 3. npm publish（需要 WebAuthn 安全密钥 2FA）
# 4. 官方市场 PR / 开放市场 issue
```

### 10.2 npm 注意

- 当前 npm 账号 `ltmroberthk`；
- `npm publish` 可能返回 `EOTP`；终端会打印 `https://www.npmjs.com/auth/cli/<id>`；
- 打开 URL，完成安全密钥，回终端按 Enter；
- 发布成功后用 `npm view <pkg>@<version> --prefer-online` 验证；
- 若返回 `403 cannot publish over previously published versions`，说明已经成功，先查 `dist-tags`，不要重复发新版本；
- 代理：系统代理端点从注册表读，不要写死；npm 单条命令临时设置 `HTTPS_PROXY/HTTP_PROXY`。

### 10.3 市场

- 官方市场：`awesome-dsh-plugin/awesome-dsh-plugin`，条目 `data/plugins/ltmroberthk915__markpilot--dsh-markdown-editor-typora.yml`；
- 开放市场：`polang233/dsh-plugin-index`，新 issue（模板 `plugin-add.yml`）；
- 两个市场都只指向 GitHub Release tarball，不直接指 npm；
- 更新条目时必须保留旧内容（市场条目是公开索引，不要删描述）。

### 10.4 实装

- 本机 profile 当前是 **link 安装**：`desktop/node_modules/dsh-markdown-editor-typora -> 仓库源码`；
- 若改成 npm 解包，必须重启 DSH；不要在运行中替换目录；
- 安装后验证：
  - `package.json` 版本；
  - 编辑器能打开/保存；
  - review/恢复链路；
  - `documents.*` 端点仍拒绝无 authority 调用。

---

## 11. 测试与验收矩阵

### 11.1 每次改动必跑

| 命令 | 期望 |
|---|---|
| `npm test` | 449+ / 0 fail；skip 只允许 POSIX-only |
| `sync-host --check` | `HOST_CHECK_OK 9 files` |
| `sync-core --check` | 124 files / coreHash 匹配 |
| `node --check lib/*.js` | 通过 |

### 11.2 review / recovery

- 单组关闭/重开/恢复/撤销；
- 双组关闭/重开/恢复/一次性撤销；
- 保留并保存后磁盘变、review 清；
- Ctrl+S 在 review 期间被拦截；
- baseVersion 不匹配不恢复；
- group 断链/过期不恢复；
- recovery 无槽/槽等于磁盘/槽过期/丢弃；
- 关闭时磁盘不变；
- 重启后 recovery 仍可定位。

### 11.3 冲突（B4.3 落地后）

- 干净/脏 + 外部改；
- ours/theirs/both/manual；
- stale/过期/取消；
- 大文件；
- 多窗口；
- 保存后不再提示。

### 11.4 内核（B5 落地后）

- 多实例/旧 EXE/非本地成员；
- 崩溃/重启/房间孤儿；
- IME/组合输入；
- 大文档/归档失败；
- 外部写盘；
- capability 回退；
- coreHash/五通道。

---

## 12. 交接检查清单

### 接手当天

- [ ] 读 `AGENTS.md`、`docs/ROADMAP-B3-B5.md`、本文件；
- [ ] `git status` 确认 main 干净（未跟踪 tgz/dist 不要误提交）；
- [ ] `npm test` + host/core check 全绿；
- [ ] 确认 profile link 指向当前源码；
- [ ] 确认 `README` 干净、无 review/recovery 残留。

### 第一项任务（P0 收尾）

- [ ] 加 `reviewGroups` 的 revision 字段；
- [ ] 客户端链校验 + 单测；
- [ ] 双组真机验收（不要退出 DSH 来“重启”）；
- [ ] 清理测试数据。

### 第二项任务（B4.3）

- [ ] 设计对抗（至少一位独立审阅）；
- [ ] conflict session host；
- [ ] UI + 真机；
- [ ] 文档 `LOG-1.9.0-B4.3C.md`。

### 大改之前

- [ ] 不碰 `renderer-cm6/`，除非有完整构建链预算；
- [ ] 不启动 B5，直到 B4.3 + P0 稳定；
- [ ] 不重用 1.7.6 预热方案；
- [ ] 任何写路径先问“归档了吗、CAS 了吗、失败是否零变化”。

---

## 13. 术语与错误码

### 13.1 Revision token

```text
rev1:live:<epoch>:<version>:<sha256>
rev1:disk:<providerVersion>:<sha256>
```

- `epoch`：房间/客户端代际 UUID；
- `version`：房间单调版本；
- `sha256`：正文内容哈希；
- `rev1:disk` 的 providerVersion 可能含冒号，解析只切前缀/后缀，不要按冒号分割所有段。

### 13.2 常见错误码

| 码 | 含义 |
|---|---|
| `MP_DOC_STALE` | baseRevision 过期/正文已变 |
| `MP_DOC_EXTERNAL_CONFLICT` | 缓冲和磁盘都改了，拒绝写；需走冲突界面 |
| `MP_DOC_DIRTY` | 文档有未保存修改 |
| `MP_DOC_ORPHAN_DRAFT` | 房间脏但无活 client |
| `MP_DOC_UNSAVED_ELSEWHERE` | 另一个窗口/宿主拥有未保存修改 |
| `MP_LIVE_FACADE_MISSING` | 引擎无 facade，回落单窗口 |
| `MP_LIVE_STALE` | 共享会话版本变化，halt 保草稿 |
| `MP_FILE_CONFLICT` | 保存时磁盘版本冲突 |
| `MP_ARCHIVE_FAILED` | 改前归档失败，拒绝写 |
| `MP_GROUP_NOT_FOUND` | review group 不存在/已撤销 |
| `MP_GROUP_NOT_LATEST` | 只能撤销最新组 |
| `MP_GROUP_STALE` | group 链/文本不匹配 |
| `FS_STALE_VERSION` | `ctx.fs` 版本守卫失败 |

### 13.3 一句话原则

> **编辑器是用户输入的唯一入口；磁盘是持久化结果；任何自动写都必须先归档、带 revision、可撤销；任何不确定都 fail-closed。**

---

## 14. 附：当前发布链接

- GitHub Release：<https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-editor-typora-v1.8.1>
- npm：<https://www.npmjs.com/package/dsh-markdown-editor-typora>
- 官方市场 PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13960>
- 开放市场 issue：<https://github.com/polang233/dsh-plugin-index/issues/407>
- 仓库：<https://github.com/ltmroberthk915/markpilot>
