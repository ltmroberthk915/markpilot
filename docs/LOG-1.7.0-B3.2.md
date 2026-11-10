# LOG B3.2 · 缓冲区 AI 编辑的独立恢复副本 / 归档保留 / 状态出口

- 基线：`main` @ `26da427`（B3.1 已实装并真机通过）。
- 工作树：`.agents/worktrees/b3.2-safety`（分支 `b3.2-safety`）。
- 目标：补齐 B3.1 的残余风险，不扩大为 B4/untitled 宿主草稿。

## 1. 用户可见变化

1. 每次 AI 缓冲区编辑成功后，工具结果多一个 `恢复副本` 路径；这是**改后正文**的独立全文，不是 `agent-before` 改前副本。
2. 编辑器/旧 EXE 在 AI 编辑未被 ack 时删房，重新打开文件可在既有“恢复副本”提示里看到该路径（磁盘已含该正文时不提示）。
3. 保留策略：`agent-before` 每 source 最多 20 份、总 200 份；append 副本每文件最多 20 份；当前返回路径不删。
4. `documents.state` / `documents.reconcile` 只读出口返回 `clean/dirty/external/conflict/orphan/owned-elsewhere/unsaved-elsewhere/missing/disk`、head、恢复副本列表和 `recommended`。
5. HTTP 的 `docs/archive` 不能使用 `tag:agent-before`，避免同会话 HTTP 触发自动副本清理。

## 2. 文件

| 文件 | 内容 |
| --- | --- |
| `MarkPilot-CM6/shell/live-documents.js` | 新 `append_recovery` 表、append 同步恢复副本、join 恢复提示、只读 list、保留 |
| `dsh-markdown-editor-typora/host/live-documents.js` + `host.json` | `sync-host` 同源产物 |
| `dsh-markdown-editor-typora/lib/documents-service.js` | buffer 结果透传 `recoveryPath`；只读 `state` |
| `dsh-markdown-editor-typora/lib/index.js` | archive 保留、HTTP archive authority 门、state/reconcile 分发、工具 schema/render/execute |
| `docs/DESIGN-B3.2-RECOVERY.md` | 设计 + 对抗修正记录 |
| `test/b3.2-recovery.test.mjs` 等 | 新 8 个恢复测试 + 状态/保留/工具用例 |

## 3. 关键实现

### 3.1 append_recovery 表（提交事实）

```sql
CREATE TABLE append_recovery (
  source TEXT NOT NULL, recoveryPath TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  version INTEGER NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL);
```

append 顺序（文件租约内，SQLite `BEGIN IMMEDIATE`）：

1. 校验 room/epoch/members/baseVersion/materialize==baseText。
2. 计算 `nextText`；写全文恢复副本 + sidecar，`fsyncSync` 后 rename，回读校验。
3. 同事务插入 `append_recovery` 行和 change，提交。
4. 成功后才返回 `recoveryPath`；事务失败删除本次创建的副本，行自动回滚。
5. 成功后按行做 20 份保留，当前路径无条件保留。

关键：**行与 change 原子提交**，因此“写副本后、提交前 kill”留下的是无行孤儿，join/state 不会误报；不需要 COMMIT 后的 committed 标记，也不存在标记半截窗口。旧的无行文件不进入权威列表。

### 3.2 join / state 过滤

- 副本 sha 是 LF/UTF-8 文本；磁盘比较同时用 `disk.hash`（原始字节）和 `disk.textSha256`（去 BOM、EOL 归一后的文本），覆盖 CRLF/BOM 文件。
- 只对 clean 房间提示 append 副本；dirty 房间以房间日志为权威。
- 只提示“副本比磁盘新”的版本（`entry.at >= disk.mtimeMs`），避免保存后继续编辑时把祖先副本当丢失草稿。
- parked 恢复行优先占 5 个 UI 槽，append 副本只填剩余槽；同 sha 去重。
- `state` 用相同 sha 过滤；文件不存在返回 `state:"missing"`，不抛 FS_NOT_FOUND。

### 3.3 归档保留

- `agent-before` 每 source 20、总 200，按 sidecar 的 `archivedAt` 排序；sidecar 必须能解析、tag=schema 匹配、文件名 key 与 `sha256(sourcePath\0tag\0sha256)` 一致。
- idempotent 归档会补写缺失的 sidecar，避免“返回 metaPath 但文件不存在、且永不计数”。
- 只有 `documents.applyEdits` 的 checkpoint 路径传 `prune:true`；HTTP `docs/archive` 传 `agent-before` 直接 `bad-request`，其它 tag 不触发清理。

## 4. 验证

### 4.1 测试

```text
npm test
tests 424, pass 423, fail 0, skipped 1
```

新增/扩展：
- `test/b3.2-recovery.test.mjs`（8）：恢复副本内容/sidecar、删房后 join、磁盘已含不提示、旧 token 不发布、20 份保留、提交失败回滚、未提交副本不展示、BOM/CRLF 归一、parked 优先。
- `test/documents-service.test.mjs`: state clean/disk/conflict/missing、recovery 过滤、`recoveryPath` 透传。
- `test/documents-api.test.mjs`: API 缓冲区 apply 的 `recoveryPath`、state/reconcile 的 model authority/HTTP 拒绝、工具 execute→render 显示恢复副本。
- `test/archive-endpoint.test.mjs`: 20 份保留、idempotent sidecar 修复、HTTP agent-before 拒绝。

### 4.2 突变验证

在 `.mp-verify/b3.2/mutate.ps1` 上执行，注掉修复后同命令复跑，恢复后哈希一致：

| 突变 | 结果 | 恢复 |
| --- | --- | --- |
| 去掉 `disk.textSha256` 比较 | R7 红 | 哈希一致 |
| 跳过 `append_recovery` 行插入 | R1/R2 红 | 一致 |
| 去掉 state recovery sha 过滤 | S11 红 | 一致 |
| 去掉 HTTP agent-before authority | archive 测试红 | 一致 |

### 4.3 门禁

```text
node scripts/sync-host.mjs --check  → HOST_CHECK_OK 9 files
node scripts/sync-core.mjs --check  → CHECK_OK 124 files, 7351676 bytes, coreHash=4499e09378a8743fd1ec985c11bf8046f33b55350688dd9d996b839fe0d589ba
```

### 4.4 真机 / 审阅

- B3.1 已实测 clean/dirty buffer、AI buffer edit、agent-before、恢复原文；B3.2 的路径与提示由新增单元/API 测试覆盖。
- 两轮设计/时序对抗（`.mp-verify/b3.2/ADVERSARIAL-*.md`）抓到的 P0：raw-byte vs LF-text sha、未提交副本误报、parked 被 append 挤出、fsync/提交窗口、HTTP 触发 prune；本批已按上表修掉。
- **真机关窗恢复冒烟**（`D:\BuyKey\Typora-Editor-App\README.md`，外部备份后恢复）：
  1. MarkPilot 打开 README，`markdown.read` 返回 `source:"buffer"`、`rev1:live:…:0`；AI edit 末尾加 `B3.2-LIVE-PROBE`，返回 `恢复副本 …recovery\agent-append\README.md…md`。
  2. 立即删除 rooms 的 clients/rooms 行（模拟旧 EXE 删房）并把 README 恢复为测试前字节、原 mtime；`append_recovery` 行保留。
  3. plugin disable/enable 后重新点 Markdown，客户端顶部出现：**“该文件存在 1 份共享会话恢复的草稿副本（原件未被覆盖）”**，带“查看/知道了”。`append_recovery` 行 version=1、bytes=7743，副本内容含 `B3.2-LIVE-PROBE`。
  4. 清理测试行/副本后 README SHA-256 仍为 `835bff35…`、7825 字节，与测试前完全一致。
  - 说明：删房是 SQLite 模拟而非自然关窗；但走的是真实 `join`/客户端横幅链路，不是单元桩。
- `main` fast-forward 到 `b6e42f2`；profile junction 指向主树，`plugin_manager` disable/enable 返回 `application:"applied"`；热载后 `markdown.read` 正常返回磁盘完整 revision，证明新 host 代码可加载。未重启 DSH。
- 最终文件身份：`MarkPilot-CM6/shell/live-documents.js` = `dsh-markdown-editor-typora/host/live-documents.js`，48399 字节，SHA-256 `9b413d32…`；`host.json` 1443 字节 `c5c5be9e…`；`documents-service.js` 26639 字节 `bdc35dbd…`；`index.js` 110778 字节 `0bb4eca1…`。
- 剩余已知边界：64 MiB 全文同步写在 SQLite 写事务内，超大文档会阻塞事件循环/并发读；`documents.state` 的只读 WAL 连接仍可能创建 `-wal/-shm`（B3.1 既有）；sidecar 丢失的磁盘孤儿不计数；无 base_sha 三态/自动恢复；`kind` 在客户端 recovery 投影里被忽略。均不阻塞本批 P0。

## 5. 回滚

- 回滚 `MarkPilot-CM6/shell/live-documents.js`、`host/`、`host.json`、`lib/documents-service.js`、`lib/index.js`、测试与设计/日志即可。
- 新表 `append_recovery` 为纯加法；回滚旧代码会忽略该表，不影响 rooms/recovery。
- 保留的恢复副本文件在 `%LOCALAPPDATA%\.markpilot\live-v1\recovery\agent-append\`，回滚不删除；如需清理由后续保留策略处理。
