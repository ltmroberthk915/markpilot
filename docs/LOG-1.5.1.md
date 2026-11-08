# LOG 1.5.1 — 顶部 rail 通知迁移（B1b）

## 变更

- 父窗口所有 `post("toast")` / `showNotice` 不再发 iframe 底部 toast，统一进入 rail 通知队列（`ui.notices`）。
- `notify`：同文案去重、最多 5 条、TTL 6s（归档 10s）、过期/清空/文档代际清理计时器；跨文档 `depKey` reset 清 `notices`。
- rail：phase 主提示优先；无 phase 时最新 notice 为主提示；phase/recovered 在场时 `＋N` 进入统一 popover（通知 + recovered 两段）；主文本可点/Enter/Escape 开合。
- 归档通知识别 `已归档旧草稿副本：<path>`（trim），提供 `复制路径` action（`clipboardOf`；不可用/失败转 rail 提示）。
- ≤200 popover 左右分别按 `--mp-rail-inset-left/right` 计算，避开 workbench floating 与 overlay `#mp-stage::after` 热区；`＋N` 在窄窗 icon 模式用 `title/aria-label` 保留数量。
- 最低支持面板宽度 160px（`rightbarMin`）；100px 不承诺通知入口，仅记录。

## 测试

- 新增 `test/rail-notice.test.mjs`：去重、TTL、`railOpen` 自动关闭、5 条截断同步、`h.posts` toast=0、phase 优先 `＋N`、归档复制路径、clear、Escape。
- 更新 `save-status` / `blank-save-edge` / `recovery-safety` 的 4 条 toast 断言为 rail 文本；归档用例增加真实“复制路径”点击（剪贴板不可用回落）。
- 全量（隔离 worktree）：383 tests / 382 pass / 1 skipped / 0 fail。
- 对抗：B1b 两轮（P0 跨代残留、P1 截断/inset/100 入口、P2 TTL/trim）修复后结论“行为层面可落地”。

## 未做（B1c）

- iframe 内引擎 toast（`.mp-toast` / `#dsh-md-toast` / `.mp-tools__toast`）仍未迁。
- 工作台 `WorkspaceNotice`（fixed bottom）仍未迁。
- popover 外部点击关闭（iframe 内点击父文档收不到；仅 Esc/再点/rail 关闭）。
