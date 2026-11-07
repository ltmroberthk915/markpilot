# DSH 插件 1.1.1 → 1.1.2 内部记录

2026-11-07。1.1.1 发布后的对抗复核修复：× 关闭记忆写入了错误的工作目录。

## 问题与改动

- **× 记忆目录归属错误（必须修）**：`lib/client.js` 原用 `workspaceContext().key` 记录，但会话可能已切到别的目录而编辑区还停在前一个目录的文档上（keep 模式常态；follow 模式在 leave guard 拒绝收起时也会出现）。实测反例：A 文档开着 → 会话切到 B → 点 × → 记忆写进 B，A 下次照常自动弹回。改为新增 `displayedDocWorkspaceKey()`：工作台文档取 `workbenchDoc.workspace`，原生浮层取 `overlayDoc.sessionId` 对应 cwd，兜底才用会话目录。
- **浮层 × 先记后关（改）**：改为先 `clearOverlayDoc()`，确认 `overlayDoc` 已清空后再写记忆；同时使用文档所属目录。
- **关闭被拒却已写记忆（消）**：左栏 × 仍只在 `docsModeOn` 变 false 后写；新增测试「leave guard 拒绝时不写」。
- **提示文案（改）**：`prepareWorkspaceLeave(refusal)` 支持按调用方给文案；自动收起路径的拒绝提示改为「上一个工作目录的文档还没有安全留存，编辑区保持打开。」，不再说「再切换」（会话其实已经切走）。
- **文档表述（改）**：README / 插件 README 的 × 段说明改为「重新打开该目录里的任一文档（点 Markdown 或从文件树打开）即恢复」，并写明未保存草稿仍在本地。

## 验证

- `node --test test/*.test.mjs`：319 项，318 通过，1 项 POSIX 在 Windows 跳过，0 失败。
- `node --test test/workspace-navigation.test.mjs`：31 项全过（新增：× 记文档目录而非会话目录、关闭被拒不写记忆、recordRecentDoc 解除记忆、200 条上限淘汰、浮层 × 记录并收起）。
- README 只增不删在校验基线 `readme-baseline-1.1.1` 下仍通过。

## 发布

- Git：见本次提交与标签 `dsh-markdown-typora-v1.1.2`。
- npm：`dsh-markdown-typora@1.1.2`。
- 官方市场：更新 tarball 到 1.1.2。
- 本机实装：同步到 1.1.2 内容，宿主重载后生效。
