# LOG B4.2a · AI 编辑组撤销（host-only）

- 基线：`main` @ `4d48f9c`（B4.1 已完成）。
- 工作树：`.agents/worktrees/b4.2-host`。
- 本批只做 host 侧；renderer 的“审阅横幅/查看差异/保留并保存”未动。

## 1. 用户可见变化

- `markdown edit` 返回 `groupId`（所有 AI 编辑，不只是块编辑）。
- `markdown action:"undo"` + `groupId`：撤销**最近一组** AI 编辑，正文回到编辑前。
- `documents.state` 返回最近 5 组 `groups`（含 `undoneAt`）。
- 撤销本身也生成新 `groupId`，审计不丢历史。

## 2. 审计/撤销

- `agent_group` 增加 `changes`（含 `from/to/insert/removed`）和 `undone_at`。
- `recordAgentGroup` 持久化每组的正向 changes；超过 4 MiB 不落 changes（撤销会拒绝）。
- `documents.undoGroup`：
  - 必须带当前正文的 revision；否则 `MP_DOC_STALE`；
  - 只允许最新未撤销组；否则 `MP_GROUP_NOT_LATEST`；
  - 组内当前文本必须仍等于 `insert`，否则 `MP_GROUP_STALE`；
  - 反向 changes 走既有 `applyEdits`，复用 buffer append / 磁盘 CAS / policy / 归档；
  - 成功后标记 `undone_at`。
- 撤销只撤该组；不会撤用户后续编辑（resultRevision 不等于当前就拒绝）。

## 3. 工具

- `action` 增加 `undo`，参数 `groupId`。
- 输出 `undoOf`、新 `groupId`、新版本、`saved/dirty`。
- render 显示“已撤销 AI 编辑组”。
- 真机：临时文件块编辑 → `undo` 首次因 `documents.undoGroup` 未进入沙箱 policy 解析而 `FS_SANDBOX_DENIED`；把该端点加入 policy 解析后同一 `groupId` 撤销成功，正文恢复 `# B\nbeta`，临时文件已删除。

## 4. 测试

```text
npm test
tests 437, pass 436, fail 0, skipped 1
```

- `B4.1-API1`：块编辑 → `agent_group` 有记录 → `undo` → 正文恢复 → 旧组 `undoneAt` 已置。
- 既有 B3/B4.1 测试全绿；撤销复用原有写路径，因此 buffer/disk 两态都被既有测试覆盖。

## 5. 未做/边界

- **未改 renderer**：用户还不能在编辑器横幅点“撤销/保留/看差异”；目前只能由模型工具或后续 UI 调 `documents.undoGroup`。
- 只允许撤销**最新一组**；不支持跨组重放/redo。
- 撤销组不区分用户后续手动编辑；resultRevision 不符即拒绝。
- 未做 `groupId` 作为 UI 通知字段的 SSE 投影；B4.2b 需要。
