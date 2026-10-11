# 私版 1.0.0 后续验收已恢复

用户在 2026-09-08 明确要求“继续后续任务 若我有打断就暂停”。当前可继续桌面和 IDE 回归、人工复核；收到用户打断即停止继续发出输入，并终止本轮测试进程。仍只处理私版，不修改用户原笔记，不提交 AI 消息。

恢复时复制最新笔记到 `.backups/2026-09-08-release100/user-note-resumed-1788864957504.md`，SHA256 为 `6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7`，与本轮起始快照相同。

当前代码完整 Trae 回归已通过 150 项，证据目录：`D:/BuyKey/Typora-Editor/test/.runs/vscode-1788864770220`；该次入口误未选择焦点专用子套件，因此按完整编辑回归记录，不计作焦点矩阵。已修正 FOCUS_ONLY 入口使其明确进入 CHAT_ONLY 分支。

增强的 Trae 焦点矩阵已通过 24 个场景（6 基础 / 18 边缘，另有 5 项启动检查）。运行 UUID `669bfd65-d2b6-46fb-8a93-d337610fafa4`，每个标记均在输入前验证不存在。证据：`D:/BuyKey/Typora-Editor-App/.perf/release100-source/trae-focus-1788864975011/task.json`；实际 IDE 结果：`D:/BuyKey/Typora-Editor/test/.runs/vscode-1788864975077`。三种模式均确认焦点进入 AI 草稿，正文及磁盘不变；捕获错误为空。

新增 `scripts/run-release100-task.mjs` 每次只运行一个明确任务，输出独立目录及 `task.json`（进程、参数、源码路径和退出结果）。不能在前一个 GUI 测试仍运行时启动另一套 GUI 或进行人工输入。测试名包括 `trae-focus`、`vscode-focus`、`vscode-full`、`benchmark-before/after`、`nested-math`、`viewflow`、`navigation`、`selection`、`math-table` 和各 Electron 套件。

源码阶段使用 `.perf/release100-source`，尚未升级或构建 1.0.0。增强性能测量、公式/表格全量、其余应用流程、最终包及人工复核仍待完成。所有最终验收应映射到 64 项流程计划，并分别记录脚本、实际宿主、人工操作及尚存覆盖缺口。
