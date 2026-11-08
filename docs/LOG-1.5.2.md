# LOG 1.5.2 — 窄窗 notice/recovered popover 可读性修复

1.5.1 的 `≤200px` 统一 popover 在 workbench collapsed 下只剩 72px（header 竖排）。1.5.2 改为：

- `≤200px` popover 移到 `top:92px`（toolbar/floating 控件下方），`left:8px`、`right:calc(8px + --mp-rail-inset-right)`，`max-height:calc(100%-100px)`；不再覆盖 workbench floating 控件，也不进入 overlay `#mp-stage::after` 右缘热区。
- `.mp-rail-head` 允许换行，标题 `strong` 占整行，“知道了/清除”下移；160 workbench 标题从逐字竖排恢复为可读多行。
- 日期在 `≤200` 仍换行，无横向滚动。

仅 CSS/类名变更；1.5.1 的通知队列/行为不变。全量 1.5.1 为 383/382/1/0；本补丁只影响窄窗布局。
