# LOG 1.8.0 · B4.2b 审阅态持久化与跨 epoch 撤销

## 目标

AI 修改进入 review 后，关闭编辑区/切走再回来，review 仍可查看差异、撤销或保留；不自动保存、不自动撤销。

## 实现

- `lib/client.js`
  - localStorage 记录 `dsh-markdown-editor-typora:review:v1:<path>`；
  - 严格校验路径、`baseVersion`、1–20 个 UUID group、count；
  - 打开文档先同步装回 provisional review（抑制 autosave），再异步用 `documents.reviewGroups` 校验 group 未撤销；
  - 编辑区关闭时**不删除**记录；`保留并保存`/撤销成功/组过期时删除；
  - 干净打开不立即删记录，等异步 recovery-slot 探测确认没有未保存内容后再删；有恢复草稿则保留，恢复后再恢复 review。
- `lib/documents-service.js`
  - `reviewGroups` 返回 `undoneAt`；
  - 撤销校验由“完整 revision 相等”改为**内容身份相等**：live token 的 epoch 在关闭/重开后变化，但 version+sha 相同，group 仍可撤销；正文 inverse changes 仍逐条校验。

## 验证

```text
npm test
tests 449, pass 448, fail 0, skipped 1
```

真机已确认：

- AI 改 README → review 横幅；
- 关闭编辑区 → 再打开 → 出现恢复草稿横幅；
- 点「恢复」后，review 横幅恢复，显示“AI 修改了 1 处”。

真机未完成：

- 重开后的“撤销本次”在 1.7.9 上因 epoch 不同被宿主拒绝；1.8.0 已改为内容身份比较，待重启后点按钮复验。
- README 磁盘仍为原始 `835bff35…`、7825 B；当前缓冲区 sentinel 未落盘。

## 打包

- `dsh-markdown-editor-typora-1.8.0.tgz`
- 大小：2,801,136 B
- shasum：`860c6387849d2426e2443f81779442b676f6d745`

## 重启后验收

已完成：

- 打开 MarkPilot → 恢复草稿横幅；
- 点「恢复」→ review 横幅恢复（AI 修改 1 处）；
- `markdown undo` 带 groupId + 当前 read token → **成功**（跨 epoch 的内容身份比较生效）；
- 正文 sentinel 被撤销，README 恢复 `835bff35…`、7825 B；
- 磁盘始终未写入测试 sentinel；清理了测试 recovery/agent_group 行。

注意：测试过程中沿用了上一轮遗留的第二个 review group，撤销最近一组后 UI 仍显示该历史组；这是测试夹具污染，不是单组 P0 链路。真实单组“关闭→恢复→撤销”已通过。
