# MarkPilot 2.0.0-rc.1（文件管理方向发布候选）

日期：2026-11-12

## 范围

- P4 文件生命周期：missing/rename/readonly/saveAs/recovery center 已真机覆盖。
- P5 安全切片：
  - `documents.state` 走 SessionManager 快照；
  - 缓存 key 覆盖 room 成员/版本/resolvedDisk/mirror/recovery；
  - write guard 有界 fail-closed；
  - 真实 SQLite 锁测试通过；
  - 磁盘权威 AI 写归档 `agent-before`；
  - `fsSessionIntents` 默认关闭。
- P1 影子：66 场景 0 差异。

## 明确限制

- `documents.read/applyEdits` 仍直接走实时权威，未缓存完整正文（见 LOG §59）。
- P1 完整 11 状态/客户端接线未完成。
- P5 recovery marker 枚举/性能、key 采样开销未优化。
- 这不是 2.0 正式版；Desktop 最终重启验收仍需做。

## 产物

- `dsh-markdown-editor-typora-2.0.0-rc.1.tgz`
- 150 files / 2.8 MB
- SHA256 `8BA49D0A7A772BB1E63D3CAB25D74BBCEE916B1D723350663E42100D738D9938`

## 测试

- `npm test`：541 / 540 pass / 1 skip / 0 fail。
- sync-host / sync-core 通过。
- MarkPilot 编辑器内核未改，coreHash 不变。
