# LOG 1.6.0 — 提示统一到顶部 rail（B1c）

## 变更

- **iframe 引擎 toast**（`.mp-toast` / `#dsh-md-toast` / `.mp-tools__toast`）不再在编辑区底部显示：
  - 不改 `renderer-cm6`/`app.js`（保持 core-sync 逐字节一致，`sync-core --check` 通过）。
  - 父窗口在 iframe `onLoad` 后注入同源 DOM 桥：body 只监听直接 childList，命中 toast 后对该元素细观察；把文本转成 rail 通知，注入样式 + inline `display:none` 隐藏原 toast。
  - `.mp-toast-link` 动作（如“打开所在文件夹”）作为 rail action 保留，点击回调原 link；link 晚到时 `notify` 以 update 方式补 action。
  - 跨源/不可访问/异常时保留原生 toast，不阻断编辑器。
- AI 发送成功的引擎侧重复提示（`已提交请求`/`已交给对话框`）在桥里过滤，保留父 `insert-to-chat` 的唯一结果。
- 工作台 `WorkspaceNotice` 从 `fixed bottom:24` 移到 `fixed top:114`（Windows titlebar 40 + tab strip 38 + rail 28 + 8 间距），加 `box-sizing:border-box`、`maxHeight:40vh`、纵向滚动；不再压宿主 tab strip/rail。
- 旧 iframe 晚到 load 只在 `current.key===depKey && !dead` 时装桥；installer 缺失时 50ms×3 重试。

## 已知边界

- iframe 内 toast 依赖同源访问；跨源包装/非 DSH 预览保留原生底部 toast。
- 带 action 的引擎 toast 通过父 rail action 回调原 link；若 link 元素已被移除，点击无效。
- 100px 面板仍低于支持的 160px 下限（B1b 已记录）。
- 工作台 notice 的 top114 为 Windows 固定值；全屏/无 titlebar 时位置更低但安全，未做容器锚定。

## 验证

- `sync-core --check`：HOST_CHECK_OK 9 / CHECK_OK 124。
- 全量 node 测试（隔离 worktree）：见提交记录；新增 fake iframe/DOM/Observer 注入测试，覆盖 style、observer→rail、link 晚到 action/click、AI 去重。
- 对抗：B1c v3 结论“可落地”；P0（app.js core drift）已通过回退 renderer 消除。
