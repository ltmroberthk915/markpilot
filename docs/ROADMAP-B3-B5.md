# ROADMAP · B3 收尾到 B5 的后续规划

- 当前基线：`main` @ `80e18dd`；B3.1/B3.2/B3.3a/B4.1 已实装并真机通过。
- 验证基线：`npm test` 437 tests / 436 pass / 1 skip；host/core 门禁绿。
- 原则：数据安全优先于功能；默认 fail-closed；不做自动覆盖/自动合并；每批先设计对抗、再落码、再突变+真机。

## 1. 优先级总表

| 顺序 | 批次 | 目标 | 是否改 renderer | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | B3.3a | 恢复副本的一键恢复/丢弃 UI + `documents.recover`（已完成） | 否（client 小改） | B3.2 |
| 2 | B3.3b | `liveUnsupported` 文件的宿主草稿索引 | 可能小改 client | B3.3a |
| 3 | B4.1 | 文档块解析、块 ID、`readToken`/`groupId` 审计（已完成） | 否（host-only） | B3.2 |
| 4 | B4.2 | AI 编辑审查/撤销组、审阅前不自动落盘（4.2a host 撤销已完成；4.2b renderer 待批准） | **是**（renderer/core） | B4.1 |
| 5 | B4.3 | diff3/冲突合并、批量编辑协议（4.3a/4.3b host 已完成；冲突界面待做） | 部分 | B4.2 |
| 6 | B5 | 内核权威 buffer/CRDT、通用 fs patch/move 守卫 | 是（内核） | B4 稳定后 |

**建议**：先做 1，再做 3；2 与 4 可并行评估，但不要先动 B5。

## 2. B3.3a · 恢复副本的闭环（已完成）

### 要做

- 新增写端点 `documents.recover`：从 `append_recovery` 的副本恢复正文。
- 编辑器恢复横幅增加动作：`恢复此副本` / `丢弃` / `查看路径`。
- 恢复纪律：
  - 只接受 `%LOCALAPPDATA%\.markpilot\live-v1\recovery\agent-append\` 下、`append_recovery` 有行、sha/bytes 校验通过的副本；
  - 必须带当前 `baseVersion`；正文在读取后被改过 → `MP_DOC_STALE`；
  - 恢复前先写 `agent-before` 改前副本；不自动覆盖用户新编辑；
  - 恢复走 buffer append（编辑器可见）或磁盘 CAS，不能裸写；
  - `丢弃` 只删该 recovery 行/文件，不删其它恢复副本。
- 真机判据：AI 改 → 删房 → 重开横幅 → 点恢复 → 编辑器出现副本正文 → 保存 → 磁盘内容正确；点丢弃 → 横幅消失、正文不变。

### 不做

- 不自动恢复、不自动合并、不删除 parked 恢复文件。

### 验收

- 单元：路径穿越、伪造 sha、stale token、磁盘已改、用户已编辑、恢复/丢弃幂等。
- API：HTTP 无 authority 拒绝；模型工具不暴露 recover（或只读）。
- 真机：横幅按钮 + 编辑器内容 + 磁盘 CAS + 原文件恢复。

## 3. B3.3b · `liveUnsupported` 宿主草稿

### 问题

引擎 facade 缺失时文档没有 room，B3 的 documents 服务看不到未保存正文；恢复依赖浏览器 IndexedDB。

### 方案候选

- 客户端在编辑后把带 token 的正文快照发给宿主 `documents.mirror`，宿主落 `draft-index`；
- `markdown.read` 优先读镜像，写回走“只在编辑器确认后应用”的队列；
- 明确不支持 untitled（无路径）时，先只做 `liveUnsupported` 文件。

### 验收

编辑器 facade 被禁用时，AI read 仍能看到未保存正文；写回不写盘、不抢编辑器；重启后草稿可定位。该批范围较大，先做设计对抗再决定是否拆成 B3.3b1/b2。

## 4. B4.1 · 块/readToken/groupId（host-only，已完成）

### 目标

让 AI 不靠 `oldString` 猜位置，能按文档结构编辑。

- `markdown` 增加 `action:"blocks"`：返回顶层块/标题 section 的 `id/type/title/from/to/preview`。
- `edit` 支持 `blockId + newString`；服务端定位块，校验 `baseVersion`，复用现有 buffer/disk 写路径。
- `read` 返回 `readToken`（与 `version` 同源）和可选的 `groupId`；AI 编辑必须回传。
- 每次 AI 编辑生成 `groupId`，把 `groupId`/actor/token 记入审计（`append_recovery` 或新 `agent_group` 表）。
- 块解析规则：ATX 标题 section + 围栏代码块 + 列表/引用/表格作为一个块；不解析行内格式。

### 不做

- 不做选区锚点（需要 renderer 选区同步）；不做 diff3。

### 验收

块 ID 在正文变化后失效；重复标题用前缀/序号区分；编辑整块不误删后续 section；跨 CRLF/BOM 一致；工具 render 显示块标题和新 token。

## 5. B4.2 · 审查/撤销组（4.2a host 已完成；4.2b renderer 待批准）

### 目标

AI 改完后用户能先看再决定，而不是 1.5s 自动保存。

- renderer 远端事务进入独立 undo group，`addToHistory:true` 或等价 review group；
- client 横幅：`AI 修改了 N 处`，操作 `撤销本次 / 保留并保存 / 查看差异`；
- 审阅前不触发自动保存；保留后走既有 save 队列；
- 撤销必须只撤本组，不撤用户编辑。

### 风险

改 core/renderer 需完整构建、五通道交互测试、真机截图；会触及 B3.1 不变的 renderer 字节契约，必须在设计对抗中明确版本与 coreHash。

## 6. B4.3 · diff3/批量协议（4.3a/4.3b host 已完成）

- 用户与 AI 同段冲突：共同 base + diff3；不能自动合并时给出三栏/逐块选择。
- 连续 AI append 批量提交，避免每笔触发 auto-save/STALE 退避。
- 与 B4.2 的 review group 绑定：一个 group 一次审阅。

## 7. B5 · 内核权威 buffer / 通用写守卫（可选）

- 把编辑器 buffer 提升为内核文档会话，`fs` 写工具统一受文档服务约束；
- 补 `fs/patch-intent`、`fs/move-intent`；
- CRDT/协同可选；优先级最低，只有 B4 稳定且用户明确要求时再做。

## 8. 明确暂不做

- 不重构 `DocumentStore`/`LiveDocuments` 的磁盘事务；
- 不把 `documents.*` 暴露给 HTTP；
- 不自动恢复、不自动覆盖、不删除 parked 恢复文件；
- 不为了“看起来完成”跳过对抗/突变/真机。

## 9. 每批固定门禁

1. 设计稿 + 至少一位独立对抗审阅；P0 收敛后才落码。
2. 单测/API 测试；关键修复做“注掉必红”突变。
3. `npm test` + `sync-host --check` + `sync-core --check`。
4. 真机至少一条用户可见链路；改 renderer 时补五通道交互与截图。
5. 文档写 `LOG-*`；数据安全相关改动附恢复/回滚步骤。

## 10. 建议决策点

- **先做 B3.3a**：当前横幅只能看路径，不能恢复，是 B3.2 的用户级断点。
- B3.3b 是否值得做，取决于用户是否实际使用 `liveUnsupported` 文件；可先做只读镜像。
- B4.2 是否允许改 renderer/core，是本路线最大的架构决策；B4.1 可以先独立交付。
- B5 在内核层，除非 B4 的 host 方案被证明不够，否则不启动。
