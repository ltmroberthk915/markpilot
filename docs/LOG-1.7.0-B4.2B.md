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
- `查看差异` 使用 rail 面板显示红/绿 `- 旧 / + 新`，最多 12 处、每处 1500 字符；真机已确认显示“修改 1（替换 48 字符）”及新旧文本。
- 未改 core/renderer；无需 coreHash 变更。

## 4. 测试

```text
npm test
tests 446, pass 445, fail 0, skipped 1
```

- `B4.2B-R1`：append 的 `groupId` 进入 exchange updates。
- `B4.2B-API1`：受信任 UI 可 `reviewGroup` + `undoGroup`，正文恢复。\n- `B4.2B-API2`：两组连续 review 一次 `undoGroups` 全量恢复，两个组都标记 `undoneAt`。
- 真机：
  - README 打开，AI 追加 `B4.2B-REVIEW-PROBE`；
  - 等 3 秒，磁盘 hash 仍为 `835bff35…`、7825 B，未自动保存；
  - 横幅出现“AI 修改了 1 处，保存前请确认”；
  - 点“撤销本次”：toast“已撤销本次 AI 修改，磁盘未改变”，正文恢复、磁盘未变，旧组 `undoneAt` 已置；
  - 再追加 `B4.2B-KEEP-PROBE`，等 3 秒磁盘仍未变；点“保留并保存”后磁盘变为 7841 B 且包含该标记；
  - README 已恢复原 hash/7825 B；live room、agent_group、append_recovery 测试行已清理。
- `查看差异` 真机打开 rail 面板，显示“AI 修改差异（1 处）/ 修改 1（替换 48 字符）/ 红色旧文本 / 绿色新文本”；host `reviewGroup` 由 API 测试覆盖。

## 5. 未做

- renderer/core 的原生 CM6 undo group、装饰 diff、原生 Ctrl+Z 整组撤销。
- 磁盘权威编辑的 review。
- review 未决时关闭后，重开只回到客户端恢复草稿，不恢复“审阅状态”；这是有意选择：先保证不丢文本、不写盘。
- 多组 AI 修改通过 `documents.undoGroups` 一次性原子撤销；组必须连续，最后一组必须等于当前 revision。

## 6. 边界验证（B4.2b-edge）

- 真机：AI 修改后按 Ctrl+S，等待 3 秒磁盘仍为原 hash/7825 B，review 横幅仍在。
- 真机：review 未决时直接关闭编辑面，磁盘仍为原 hash；重开后出现“检测到上次关闭时未保存的内容”，可选择恢复/丢弃。
- 多组入口按 `review.groups` 累积；`documents.undoGroups` 按组链模拟逆变换，最后一次性写回；`B4.2B-API2` 覆盖两组连续撤销。\n- 真机：README 连续两组 AI 修改，横幅显示“AI 修改了 2 处（共 2 组）”；点“撤销本次”toast“已撤销本次 AI 修改（2 组）；磁盘未改变”，两组 `undoneAt` 均置，正文恢复、磁盘 hash 不变。
- 差异面板：显示红/绿行、修改序号/替换长度；最多 12 处、每处 1500 字符。
- 多组 review 状态（累积、最近组、multi 判定、保存抑制）已加入 `test/client.test.mjs`；关闭/重开、Ctrl+S 拦截仍为真机用例。
