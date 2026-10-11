# 工作检查点：桌面操作仍暂停

2026-09-08：用户明确说“我有急事要办，你先暂停”。当时停止工作，没有创建后台自动任务。暂停时已确认本轮 IDE/Electron 测试进程均已退出。

随后用户授权“你执行不需要控制电脑的部分”。现行范围：可以改代码、执行纯 Node 测试、读已有证据、准备回归计划；桌面/IDE/Electron 窗口、浏览器以及鼠标键盘操作仍暂停。不要因整体目标未完成而自动恢复桌面操作。

这次后台阶段已完成：240 项 Node 测试通过，70 个产品代码文件语法通过，479 个共享文件一致，4 个公版产物哈希未变。新修复包含原生选区消息的空对象异常、重复范围及切走编辑器的异步保护；另补充渲染桥接和布局回归。已准备 64 个全应用流程（16 基础 / 48 边缘），桌面验收状态均为待执行。

性能旧数据只作阶段参考：原脚本缺少文档版本和光标矩形断言，原笔记屏内/屏外标签落到同一锚点；已增强脚本但未重跑。焦点矩阵已使用唯一输入标记排除旧草稿误判，也未重跑。后续以 [后台阶段报告](D:/BuyKey/Typora-Editor-App/docs/RELEASE100-BACKGROUND-20260908.md) 和 [当前源码哈希检查点](D:/BuyKey/Typora-Editor-App/.perf/release100-background/checkpoint.json) 为准，下方为暂停时的历史信息。尚未打包 1.0.0。

当前目标：Alt+U 后输入焦点留在 IDE 的 AI 输入框；最后一次性能优化；全量饱和测试（25% 基础 / 75% 边缘场景）；通过后私版 EXE 与 VSIX 均进入 1.0.0。尚未完成全量验收，尚未修改版本或打包 1.0.0。

已改产品代码（权威源在 ../Typora-Editor/extension-src）：
- out/common/native-chat.cjs：附件完成后聚焦输入框；VS Code 使用原生命令，Trae v2 使用空原生附件批次完成焦点交接（figmaList 为空，不增加附件或发送提示）。补获初始同步异常；失效请求、已关闭/切走的编辑器不再抢焦点。
- render/js/split-navigation.js：匹配从剩余候选开始；源码切换仅为当前光标或可见锚点所在块建立逐字映射。
- render/js/split-resize.js：ResizeObserver 内的宽度写入延后到动画帧，避免 AI 侧栏改变宽度时触发循环通知错误。
- 已执行 scripts/sync-renderer.mjs，同步 479 个 renderer 文件到桌面端。

证据与测试：
- scripts/native-chat-platform.test.cjs：28 项宿主边缘/正常行为测试通过。
- Trae 与 VS Code 首个实际焦点输入测试均通过；VS Code 的 native-edit-context 必须按 EditContext 检测，不是仅检查 contenteditable。
- 新矩阵 ../Typora-Editor/test/native-focus-matrix.cjs：每个 IDE 24 个场景，6 基础 / 18 边缘，覆盖 IR/WYS/SV、草稿保留、重复内容、公式、代码、跨块、无扫描码、关闭后重开侧栏。最近 Trae 运行日志 test/.runs/release100-focus-matrix-trae3.log，进程在暂停前 exit 0；尚未汇总明细。VS Code 完整矩阵尚未运行。
- 前两轮矩阵的测试等待错误已修复；第三轮前修复产品 ResizeObserver 回调写入。旧失败记录保留。
- 性能基线 .perf/release100-perf-before-v3/benchmark.json（冻结的 1.0.18 ASAR），优化后 .perf/release100-perf-after-v1/benchmark.json（当前源码）：各 12 组测量均正常退出。需要正式比较、确认锚点一致，再做全量回归；后者测量发生在 split-resize 修复前。
- 新基准脚本 scripts/release100-mapping-benchmark.cjs；split-navigation-runner.cjs 增加 benchmark 入口。

后续：检查 Trae 矩阵证据；补 VS Code 矩阵、Windows 人工 Alt+U 后继续输入（不发送消息）；确认映射性能及准确性；建立全应用 25/75 场景目录并跑完整回归；更新私版版本与 VSIX manifest；打包、核验同源、公版未改、实际 EXE/VSIX 人工测试；报告并完成目标。全应用场景目录尚未定稿，不能将局部矩阵比例冒充全量比例。

用户原文没有被测试修改。新快照 .backups/2026-09-08-release100/user-note-start.md，原始快照 SHA256 6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7；不要用它覆盖用户继续编辑的原文。
