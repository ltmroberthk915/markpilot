# LOG B4.2b · AI 修改审阅组（client + host，未改 renderer/core）

- 基线：`main` @ `8bba4dd`。
- 工作树：`.agents/worktrees/b4.2b-lite`。
- 本批只做 client + host；没有改 renderer/core。

## 1. 用户可见行为

AI 修改 buffer 后：

- 不再 1.5 秒自动写盘；
- 顶部显示 `AI 修改待确认：AI 修改了 N 处，保存前请确认`；
- 按钮：`撤销本次` / `保留并保存` / `查看差异`；
- `撤销本次` 调 host 反向应用该组，正文恢复，磁盘不变；
- `保留并保存` 清 review 后才进入保存队列；
- 手动 Ctrl+S 在 review 期间被阻止并提示。

## 2. 协议

- `changes` 表增加 `group_id`；`live.append` 接受 `groupId`；`exchange` update 返回 `groupId`。
- `applyEdits` 把当前 `groupId` 传给 buffer append；磁盘编辑没有 live delta，不进入本批 review。
- `documents.reviewGroup`：只读返回该组 `changes`（含 `removed/insert`）。
- `documents.undoGroup`：允许受信任 UI 调用；仍校验当前 revision、最新组、组内文本匹配。
- UI 调用 `applyEdits` 时跳过模型侧 policy；模型调用保持原 policy。
- client 从 `live-exchange` 的 updates 记录 `version -> groupId`，在 `acceptDelta` 消费；带 groupId 的 delta 进入 review，不自动保存。

## 3. 安全/边界

- 只 review **live buffer** 的 AI 编辑；磁盘权威编辑不进入（已落盘，没有“审阅前不保存”语义）。
- review 期间不自动保存；用户继续编辑仍保留 review，Ctrl+S 被拦截。
- 撤销只允许最新未撤销组；当前 revision/文本不匹配时拒绝。
- `查看差异` 当前是 host `reviewGroup` + toast 文本摘要，不是 renderer 装饰 diff。
- 未改 core/renderer；无需 coreHash 变更。

## 4. 测试

```text
npm test
tests 444, pass 443, fail 0, skipped 1
```

- `B4.2B-R1`：append 的 `groupId` 进入 exchange updates。
- `B4.2B-API1`：受信任 UI 可 `reviewGroup` + `undoGroup`，正文恢复。
- 真机：
  - README 打开，AI 追加 `B4.2B-REVIEW-PROBE`；
  - 等 3 秒，磁盘 hash 仍为 `835bff35…`、7825 B，未自动保存；
  - 横幅出现“AI 修改了 1 处，保存前请确认”；
  - 点“撤销本次”：toast“已撤销本次 AI 修改，磁盘未改变”，正文恢复、磁盘未变，旧组 `undoneAt` 已置；
  - 再追加 `B4.2B-KEEP-PROBE`，等 3 秒磁盘仍未变；点“保留并保存”后磁盘变为 7841 B 且包含该标记；
  - README 已恢复原 hash/7825 B；live room、agent_group、append_recovery 测试行已清理。
- `查看差异` 已点击但截图未捕获 toast；host `reviewGroup` 由 API 测试覆盖，客户端显示路径未做像素级确认。

## 5. 未做

- renderer/core 的原生 CM6 undo group、装饰 diff、原生 Ctrl+Z 整组撤销。
- review 期间用户继续输入的完整 UX（目前保留 review、禁止自动保存/手动保存）。
- 磁盘权威编辑的 review。
