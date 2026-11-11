# MarkPilot 2.0.0

日期：2026-11-12

## 内容

- P4 文件生命周期：missing/rename/readonly/saveAs/recovery center。
- P5 安全切片：state SessionManager 快照、写守卫、磁盘权威 AI 写归档、真实 SQLite 锁 fail-closed、fsSessionIntents 默认关闭。
- P1 影子：66 场景 0 差异、只读保证。

## 明确限制

- `documents.read/applyEdits` 仍直接走实时权威，不缓存完整正文（P5 推荐 A）。
- P1 客户端接线未完成。
- 恢复中心/saveAs 等 Desktop 逐项验收已有大部分证据，但本次 2.0.0 安装后仍建议重启再跑一次冒烟。

## 产物

- `dsh-markdown-editor-typora-2.0.0.tgz`
- 150 files / 2.8 MB
- SHA256 `A4CAF71165A75B95A8C0581ECAD83A112AA1E07F28C9B29A62E056A7C1C2D31A`

## 测试

- 542 / 541 pass / 1 skip / 0 fail。
- sync-host / sync-core 通过。
- MarkPilot 编辑器内核未改，coreHash 不变。
