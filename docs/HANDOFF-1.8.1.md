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
