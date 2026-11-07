# DSH 插件 1.1.2 → 1.2.0 内部记录

2026-11-07。用户报告：被动打开的 Markdown（对话里的文件链接、切会话恢复的文档）虽然是同一个编辑器，但没有文档工作台左上角那两个小按钮（展开/收起文件列表、关闭工作台）。

## 根因

- 插件有两种展示形态：显式点 Markdown / 自动恢复 → `DocsWorkbench`（docsModeOn=true，有左列表与 rail）；宿主原生 md 标签 → `EditorOverlayStage` 的浮层分支（docsModeOn=false，只有右上角 closeBtn）。
- 对话里的文件链接与切会话恢复的文档都走宿主原生标签 → 落在浮层分支，因此没有 rail。这是 1.0.0 起就有的两种形态差异，不是 1.1.x 引入的退化。

## 改动

- 新增设置 `passiveOpenMode`：`workbench`（默认）/ `overlay`。默认把被动打开的原生 md 标签接进文档工作台，使左列表与左上角两个按钮与点 Markdown 一致；选 `overlay` 保持旧的「全宽浮层、仅右上角关闭」。
- 新增 `workbenchEntryOfNative(tab, sessionId)`：从 `dsh-resource://file/` 地址解析路径、所属会话与工作目录，构造工作台条目。
- 新增 `routePassiveNativeDoc(tab, sessionId)`：受设置约束、并且只在标签确实公布成功（未被 × 记忆挡住）时接进工作台，避免关掉后又被会话恢复重新弹出。
- `EditorTabRedirect` 的 effect 在 `explicit === false && visible` 时调用它；宿主内显式导航（revision 增加）仍按原逻辑让位给原生浮层。
- 设置页「打开与切换」新增「被动打开的文档」一项；枚举校验、默认值与旧存档兼容（没有该字段 → workbench）。

## 验证

- `node --test test/*.test.mjs`：323 项，322 通过，1 项 POSIX 在 Windows 跳过，0 失败。
- `node --test test/workspace-navigation.test.mjs`：35 项全过（新增：原生标签默认进工作台且渲染 toggle/close、overlay 设置保持浮层、× 关闭后恢复的标签不再进工作台、passiveOpenMode 校验与默认值）。
- README 只增不删在 `readme-baseline-1.1.1` 基线下仍通过。

## 现场事实

- 用户当时运行的 DSH 主进程启动于 09:37，而插件 1.1.1 / 1.1.2 的文件分别在 11:27 / 11:49 同步，因此观测到的现象来自启动时加载的旧代码；本轮修复要重启后才会生效。
- 无法用 computer-use 驱动 DSH 宿主窗口（HOST-GUARDED，agent 不能操作自己的宿主），复现以插件渲染树与单元测试为准。
