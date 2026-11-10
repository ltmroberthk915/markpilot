# LOG B4.3a · 批量编辑协议（host-only）

- 基线：`main` @ `7890fc3`（B4.2a 已完成）。
- 工作树：`.agents/worktrees/b4.3-batch`。
- 本批只做 `markdown` 工具批量 edits；diff3/冲突合并仍在后续。

## 1. 用户可见变化

- `markdown action:"batch"`：一次提交多处非重叠 `{from,to,insert}`。
- 整批使用同一个 `baseVersion` 和同一个 `groupId`；buffer 只 append 一次。
- 返回 `applied[]`，客户端/模型可核对每处范围。

## 2. 协议

- 复用 `documents.applyEdits` 的 `edits` 分支：
  - 必须按 `from` 升序、互不重叠；
  - buffer 需要 base token；磁盘需要 provider base 并走 CAS；
  - 一次 checkpoint/归档；写后记录一个 `agent_group`。
- 工具 schema：`action` 增加 `batch`，新增 `edits[]`，输出 `applied[]`。
- 不新增 service 端点；没有绕开既有 policy/room/恢复副本。

## 3. 测试

```text
npm test
tests 439, pass 438, fail 0, skipped 1
```

- `B4.3-API1`：真实 live room 两处 batch edits → 正文两处替换、`applied.length=2`、单个 `groupId`。
- `host.test` / registration：action 枚举包含 `batch`，array items schema 通过 fallback 注册。

## 4. 边界

- 不支持重叠 edits、跨块 diff3 合并、冲突自动解决。
- 不暴露给 UI；renderer 审阅仍未做（B4.2b）。
- batch 与 undo 组合可用：batch 生成 group，undo 可撤该组（同一 host 路径）。
