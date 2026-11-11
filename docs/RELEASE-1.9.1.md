# MarkPilot 1.9.1（P5 安全切片）

日期：2026-11-11

## 内容

- 磁盘权威 AI 写（`documents.applyEdits`）写前归档 `agent-before`；归档失败 `MP_ARCHIVE_FAILED` 且零写入。
- 虚拟 provider 归档使用稳定合成路径，避免非本地绝对 targetKey 无法写。
- write guard 能看见无 live room 的 `draft_index` mirror，并拒绝通用 fs 写。
- lookup 连续失败 3 次后 `MP_DOC_LOOKUP_FAILED`，单次失败仍 fail-open。
- 全量：530 / 529 pass / 1 skip / 0 fail。

## 产物

- `dsh-markdown-editor-typora-1.9.1.tgz`
- 150 files / 2.8 MB
- SHA256 `92DC1DCCE378848F894F916BA023FABCE592AA27517123F1699D75BA7E3720AE`

## 未完成

- P5 的 fsSessionIntents/fsArchiveAll/fs observed 未实现。
- P1 完整 11 状态 G1 未完成。
- 不是 2.0。
