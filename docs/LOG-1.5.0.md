# LOG 1.5.0 — 顶部提示 rail（B1a）

## 目的

编辑面板的恢复/冲突/错误/保存状态原先在 iframe 上方按内容占流，出现时把正文整体下移 20–300px；保存药丸 absolute 又盖住引擎工具栏 21/32px。B1a 把父窗口侧提示收进**固定 28px 顶部 rail**，iframe 从 rail 下方开始，任何提示不改变几何。

## 实现

- `EditorTabBodyInner` 渲染 `[rail 28px, iframe, popover]`；rail `flex:0 0 28px; box-sizing:border-box`，iframe `flex:1 1 auto; min-height:0`；root `container-type:inline-size`。
- 左槽：保存状态（`data-mp-save-status` 仅非空；`未保存·按 Ctrl+S`/`已保存`/clean「就绪」）；saved 3s 生命周期沿用既有 controller。
- 主提示：loading / error（重试 + 条件「丢弃恢复内容」）/ conflict（重载+复制）/ recovery（恢复+丢弃）/ recovered（查看+知道了）；按钮文本与动作语义不变。
- recovered 路径/复制路径/知道了在 root 的 absolute **popover 兄弟层**（`top:34`，`max-height:calc(100%-42px)`，`overflow:auto`，`box-sizing:border-box`），默认 hidden，DOM 常驻供测试与无障碍；不再占流。
- 窄窗：`@container (max-width:360px)` 动作图标化（文本节点保留）、saved 状态点变空心环；`≤200px` 动作 20px、去 `♻N` 次要动作、主提示文本本身可点/键盘打开 recovered 入口、日期隐藏。
- chrome inset：workbench `railInsetLeft=collapsed?52:0`、`railInsetRight=20`；overlay `railInsetRight=26`（避让 close ×、drag 16、`#mp-stage::after`）。
- 切文档/phase 变化/dismissRecovered 清 `railOpen`，避免跨代串台。

## 验证

- 几何：95 组 state×width×入口（workbench/overlay/tab，160/200/300/360/420/760/1000，短面板 300/200）实测 `railH=28`、`iframeTop=28`、`iframeH=面板−28`、`railOverflow=0`、toolbar 不重叠；popover 不越界、160 workbench recovered5 无横向滚动。
- 视觉：2x 截图覆盖 conflict 1000/420/300/160、recovery、recovered-open、overlay、workbench collapsed、short panel；见 `.audit-work/layout-bug/review-b1-impl/shots/`。
- 测试：新增 `test/rail-layout.test.mjs`（28px/flex 契约、按钮保留、popover 兄弟层）；全量 `node --test test/*.test.mjs`。

## 边界（B1b）

- 未迁 `showNotice` / 25 条 `post("toast")` / iframe 内引擎 toast / 工作台 `WorkspaceNotice`，底部仍可能出现瞬时轻提示；B1b 统一。
- popover 无 Esc/点击外部关闭/焦点管理；overlay close 中心命中 `#mp-stage` 为 1.4.2 既有缺陷，与 rail 无关。
- 160px + conflict + recovered 时主文本约 17px，靠 title/aria 与可点入口；后续可做 20px 独立 `♻` 入口。
- `<style>`/container query 依赖宿主 CSP 与 Chromium；当前 Electron 44/主页面 style-src unsafe-inline 已验证。
