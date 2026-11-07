# DSH 插件 1.1.0 → 1.1.1 内部记录

2026-11-07。行为修复：会话切换只恢复该工作目录上一次打开的 Markdown，空目录不再自动弹出文件列表。

## 改动

- `lib/client.js`：`openWorkspace` 增加 `options.auto`；自动路径只走 recent（含未保存空白草稿），空态直接返回，不再回退到 files/blank；跟随模式下若上一个目录的文档仍开着，先过 `prepareWorkspaceLeave` 再 `closeDocsWorkbench()`；自动路径失败只写 `console.warn`，不弹提示。显式点击路径（`DocsEntryRedirect`）行为不变。
- 设置页「打开与切换」两段说明与 follow 选项标签改为与新语义一致；枚举值与 localStorage 键不变。
- 测试：`test/workspace-navigation.test.mjs` 拆分为 22 个用例，新增异目录文档残留、空白草稿恢复、接口失败不打扰、空态只查一次四类。

## 验证

- `node --test test/*.test.mjs`：310 项，309 通过，1 项 POSIX 在 Windows 跳过，0 失败。
- `node --test test/workspace-navigation.test.mjs`：22 项全过。
- README 只增不删：`node scripts/verify-readme-keep.cjs --baseline <1.1.1 改前副本>` 通过（详见本次提交的收据）。

## 包与实装

- TGZ：`dsh-markdown-typora-1.1.1.tgz`，见下方尺寸与 SHA-256。
- npm：`dsh-markdown-typora@1.1.1`，与 GitHub Release 资源同一字节。
- 本机实装：`C:\Users\Ming\.dsh\profiles\desktop\node_modules\dsh-markdown-typora`（junction → `D:\BuyKey\markpilot-public\dsh-markdown-typora-trial-20261104`），文件已同步；宿主重载后生效。

## 未做

- 未在实机做交互/视觉复核（用户选择本轮不重载宿主）。行为由单元/集成测试与对抗评审覆盖。
- 发行说明与 README 未新增推广文案。
