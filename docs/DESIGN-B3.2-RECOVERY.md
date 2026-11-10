# DESIGN B3.2 · 缓冲区 AI 编辑的独立恢复副本、归档保留与状态出口

- 基线：`main` @ `26da427`，B3.1 已实装并真机通过。
- 本批只做 P0 可靠性收口；untitled / `liveUnsupported` 宿主草稿、B4 块/选区协议、diff3 不在本批。
- 不改 renderer 字节，不改内核，不改 B2 守卫语义。

## 1. 要解决什么

B3.1 的 buffer 编辑已有 `agent-before` 归档（改前文本），但有两个残余风险：

1. **AI 追加后、编辑器应用前关窗/旧 EXE 删房**：房间日志里的 AI 增量没有独立副本。`agent-before` 只能恢复“改前”，不能恢复“AI 改后”。
2. **`agent-before` 长期累积**：归档按内容确定性命名，重复编辑会增长；没有保留策略。

同时 B3.1 只有内部状态判定，没有只读出口让编辑器/诊断看到
`clean / external / conflict / orphan / owned-elsewhere`，也没有把 append 恢复副本暴露给用户。

## 2. 目标

- G1 `LiveDocuments.append` 在提交前写出**改后正文**的独立恢复副本；写失败则拒绝这次 AI 编辑（fail-closed）。
- G2 房间被删/未应用时，恢复副本仍可定位；下次 `join` 把“磁盘里没有的 append 副本”放进既有 `recovered` 提示。
- G3 只清理 `agent-before`/`agent-append` 自动副本，保留策略有上限、按来源、幂等；不动用户自己的恢复副本、不动 `parked` 恢复文件。
- G4 新增只读 `documents.state` / `documents.reconcile`，不产生任何写入。
- G5 模型工具返回 `recoveryPath`，渲染同时显示 `改前副本` 与 `恢复副本`。

## 3. 恢复副本

### 3.1 路径与格式

```text
%LOCALAPPDATA%\.markpilot\live-v1\recovery\agent-append\
  <basename>.<fileKey sha8>.<epoch sha8>.agent-append.<version>.<text sha8>.md
  <same>.json
```

- 以 `fileKey`（canonical path）哈希分段，和现有 `recovery/` 的 parked 文件分开。
- 文件名确定：同 epoch/version/sha 重试不会重复。
- `.json` 元数据：`schema/sourcePath/epoch/version/at/bytes/sha256/textLength/kind:"agent-append"`。
- 正文是**追加后**的完整文本，LF，UTF-8；上限 64 MiB，超过则拒绝 append（`MP_RECOVERY_TOO_LARGE`）。

### 3.2 append 顺序

在 `withFileCommit` 文件租约内，`BEGIN IMMEDIATE` 事务中：

1. 校验 room/epoch/members/baseVersion/materialize==baseText（同现有 append）。
2. `nextText = apply(baseText, changes)`；`checkedLength` 已校验范围。
3. **同步**写恢复副本 + sidecar（`fsyncSync` 后再 rename），回读校验 sha；失败 → `MP_RECOVERY_FAILED`，事务回滚。
4. 在同一事务内插入 `append_recovery` 行（source/recoveryPath/epoch/version/at/bytes/sha256），再写 change、version+1、compact，然后 `COMMIT`。
5. 事务失败（`MP_LIVE_STALE` 等）→ 尽力删除由本次创建的副本；行随事务回滚。
6. 成功后按 `append_recovery` 行执行保留策略（每文件 20 份，当前返回路径无条件保留）。

**提交事实由 SQLite 行表示**：文件先落盘、行与 change 同事务提交。进程在 COMMIT 前死亡 ⇒ 行回滚，文件是无行孤儿，join/state **不会**把它当草稿；进程在 COMMIT 后死亡 ⇒ 行已存在，副本可见（前提是文件 fsync 成功）。这样不再需要“COMMIT 后再写 committed 标记”，消除了 marker 窗口和 marker 半截 JSON 的问题。没有行的旧文件只是磁盘垃圾，不进入权威列表。

同步写放在事务内，而不是事务前异步写：exchange() 不走文件租约，只有 SQLite 写事务能保证恢复副本对应的版本不会被并发编辑推进。代价是单次 append 期间阻塞事件循环/SQLite 写锁约“全文写入时间”；64 MiB 上限和 AI 编辑低频率是本批接受的边界。

### 3.3 发现与提示

- 权威索引是 `append_recovery` 表，不是目录扫描；只有已提交事务留下的行才会被 `join`/`state` 看到。
- `LiveDocuments.listAppendRecovery(filePath)` 用只读连接查询本文件的行，逐个回读文件、校验 `bytes/sha256`；文件缺失/损坏的行不返回（不把坏路径交给用户）。
- `join` 在返回前比较 recovery.sha256 与当前磁盘的 **raw hash** 或 **normalized LF text hash**（`readDisk.textSha256`），任一相等 → 磁盘已包含该版本，不提示。
- 只提示，不自动恢复；实际恢复仍是用户显式动作（本批不新增写恢复 API）。
- 只提示不排序跨类别：`parked`（崩溃草稿）先占槽，append 副本只填剩余槽位，避免信息性副本挤掉唯一草稿。

### 3.4 保留策略

- `agent-append`：每个文件最多 20 份，按 `append_recovery.at` 最新保留；当前这次 append 返回的路径无条件保留；删除行 + 文件 + sidecar。
- `agent-before`：每个 sourcePath 最多 20 份，总上限 200 份；只处理 `tag==='agent-before'` 且 sidecar 可解析的文件；当前这次 archive 返回的路径无条件保留（即使总上限已满），避免把即将交给用户的 checkpoint 删掉。
- 不删除：`parked` 恢复文件、用户其它 tag（`draft` 等）、没有 `append_recovery` 行的磁盘孤儿（不会被列出，但清理不冒险删）。
- 清理失败只记日志，不影响 append/archive 返回；清理在写入完成后执行。
- 只有模型工具 `documents.applyEdits` 的 checkpoint 路径会以 `prune:true` 调用归档；HTTP 的 `docs/archive` 即使传入 `tag:agent-before` 也被 `bad-request` 拒绝，普通 `stale-draft` 归档不会触发自动副本清理。防止同会话 HTTP 客户端伪造/挤掉真实 checkpoint。
- 不按“文件名像”删除；必须读 sidecar 并校验 sourcePath/tag/sha。

## 4. 只读状态

`documents.state` / `documents.reconcile`（同一实现，别名）：

```json
{
  "path": "...",
  "displayPath": "...",
  "state": "clean|dirty|external|conflict|orphan|owned-elsewhere|unsaved-elsewhere|missing|disk",
  "source": "buffer|disk",
  "dirty": false,
  "diskChanged": true,
  "conflict": false,
  "orphanDraft": false,
  "external": false,
  "bufferOwnedElsewhere": false,
  "unsavedElsewhere": false,
  "version": "rev1:...",
  "head": { "epoch": "...", "version": 2, "savedVersion": 2 },
  "recovery": [{ "recoveryPath": "...", "sha256": "...", "at": 0, "kind": "agent-append" }],
  "recommended": "none|reload|resolve|recover"
}
```

- 只允许 `MODEL_TOOL` authority；HTTP 仍 `bad-request`。
- `authority()` 的三次读校验不变；state 不 archive、不 append、不建库。
- 未知/无房间：`state:"disk"`，`recommended:"none"`。

## 5. 工具返回

- buffer apply 结果增加 `recoveryPath`。
- `markdown` 工具 output schema 增加 `recoveryPath`；渲染：
  `改前副本: <checkpoint>；恢复副本: <recoveryPath>`。
- `recoveryPath` 缺失不影响编辑；只有 append 成功才有。

## 6. 失败/边界

| 情况 | 行为 |
| --- | --- |
| 恢复副本写失败/回读不一致 | `MP_RECOVERY_FAILED`，不提交 append |
| 正文 >64MiB | `MP_RECOVERY_TOO_LARGE`，不提交 |
| 事务 stale | 删除本次创建的副本，返回 `MP_DOC_STALE`（保留原 currentRevision） |
| 副本写入后、COMMIT 前进程死亡 | `committed:false`，join/state 不提示；房间日志仍是真源 |
| COMMIT 后、committed 标记前死亡 | append 已提交；副本不可见，房间日志/leave 保护仍在 |
| sidecar 被外部截断/破坏 | 副本文件保留但不再被列出（P2，已知；不自动删除） |
| 清理失败 | 只 warn，不影响主操作 |
| sidecar 损坏 | 不删除、不列入 state/recovered |
| 旧 EXE 删房 | 已提交副本仍在；下次 join 若磁盘不含该 sha 则提示 |
| 磁盘已含 AI 编辑 | recovery.sha == disk sha，不提示 |
| 恢复副本与用户手动改盘冲突 | 只提示；不自动覆盖 |

## 7. 验收

1. append 成功后副本存在、sha 等于返回文本；模拟删除房间后 `join` 返回 `recovered` 含该副本；磁盘 hash 与副本相同则不提示。
2. append 事务 stale 后不留下“已提交但无副本”，本次副本被清理或保留但版本未提交。
3. 写副本失败注入 → append 失败且房间版本不变。
4. 保留：25 份 agent-before → 只留 20；其它 tag/`parked` 不动；append 21 份 → 20。
5. `documents.state` 对 clean/dirty/external/conflict/orphan/disk 六态返回正确，且不写入 DB/磁盘。
6. 工具返回 `recoveryPath` 并渲染。
7. 全量测试、sync-host/core；真机重复 B3.1 buffer 编辑，检查改前/恢复两个路径。

## 8. 不做

- 不自动恢复、不自动合并、不删除任何 `parked` 恢复文件。
- 不改自动保存节拍、不改 renderer。
- 不把 IndexedDB WAL 搬到宿主（B3.3/后续）。
- 不做 untitled / liveUnsupported 宿主草稿（B3.2 的另一半，另行立项）。

## 9. 风险

- 每次 AI buffer 编辑多写一份全文，文档很大时 I/O/空间上升；用 64MiB 上限和 20 份保留封顶。
- 恢复副本与真实房间日志可能短暂不一致；以“已提交版本”事务为真源，副本只用于丢失后的人工恢复，不参与正常读。
- join 的 recovered 列表增加条目，可能让用户看到旧副本；用 sha 与磁盘比较并限制最近 5 条缓解。
- 旧 EXE/旧客户端只认 `recovery` 表，不认新目录；本批保证文件可定位，不保证旧 EXE 自动提示。
