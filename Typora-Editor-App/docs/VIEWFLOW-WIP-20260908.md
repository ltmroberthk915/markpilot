# 私版分屏与嵌套公式工作记录（已验收）

## 最终验收完成：2026-09-08

最终 v8 EXE 1.0.18 / VSIX 0.1.28-local 已全部通过，正式记录见 [验收报告](D:/BuyKey/Typora-Editor-App/docs/CHANGE-REPORT-PRIVATE-VIEWFLOW-1.0.18.md) 与 .perf/viewflow-delivery/accepted.json。最终完整输出为 .perf/viewflow-final-v8-accepted：8 个桌面套件全部退出 0，真实 VSCode 完整 150、VSCode chat 25、Trae chat 25 全部通过；捕获范围内 JS 异常数组为空。实际便携 EXE 与 Trae 人工证据、479 共享文件同源、3 宿主文件及公版哈希均已核验。以下内容仅为保留的过程记录，其中“当前运行”“未验收”“剩余”等均是历史状态。

## 16:50 当前状态（产品未再改动，测试准备已修正）

v8 在旧输出目录复跑遇到 enter-wysiwyg-blockCode 断言，证据 .perf/viewflow-v8-entry-bounds：切换前 selection 是 pre offset 0，预期坐标却属于被代码预览覆盖的源字符 offset 36；实际分屏正确保留了 0。测试现通过真实方向键把可编辑光标定位到该字符，并先验证实际焦点，再验证切换保持位置。沿用原失败尺寸的 .perf/viewflow-v8-entry-keyboard 已 60 / 60 全过，产品包无需重构建，人工验收证据仍有效。

最终整轮使用新的 .perf/viewflow-final-v8-accepted，避免和早期失败/中断日志混淆。write-viewflow-report.cjs 已指向该目录。当前重新串行运行完整 8 套 + IDE 150/25/25；通过后重新同源校验、报告验收、完成 goal。人工目录仍为上文/下文的 1788856009346（Trae）与 1788856228136（EXE）。

## 16:38 当前状态（v8，人工已通过，最终全量回归运行中）

v7 全部自动检查通过：8 个桌面套件，以及真实 VSCode 150、VSCode chat 22、Trae chat 22。但真实 Windows Computer Use Alt+U 未触发：manual-live.json 证明输入有 key='u'、code=''，与自动测试的 code='KeyU' 不同。最终 v8 native-chat.js 增加仅在 code 为空时用键值判定；三种模式增加无扫描码 Alt+U 用例。其他产品源码与 v7 一致。

v8 包已生成、同源校验已通过。ASAR SHA256 7c6c44e6246bafd43004825ef2b31aa1c171c31424336ded8fac5e18f53bbf55。最终提取 VSIX 是 test/.runs/vsix-private-0.1.28-viewflow-v8-final/extension。真实 Trae 人工通过目录 .perf/viewflow-manual-trae-1788856009346（exit 0、鼠标重复单元格与表头 B、真实 Alt+U、精确原生回执 2 次、25 自动检查）。最终便携 EXE 人工通过目录 .perf/viewflow-manual-exe-1788856228136（RN 原句公式预览再点、逐个展开/收起、分屏进入、左右滚轮、双向拖分隔条、表格 Ctrl+Shift+E 输入 P(A|B)+分式、单元格退出、取消公式、撤销、保存副本；observer exit 0 / runtimeErrorCount 0；实际运行 ASAR hash 已比对）。禁止覆盖用户原笔记。

正在 exec_command session 88616 串行跑 run-viewflow-regressions.mjs -> run-viewflow-ide.mjs，输出 .perf/viewflow-final-v8。两个人工测试均已关闭，可继续完整回归。先前 v8 回归因测试窗口遮挡人工窗口主动终止，保留 .perf/viewflow-final-v8-interrupted-ui-overlap，不是产品失败，也不得拿它代替这次完整回归。

剩余：等待 88616 全部通过（8 套 + IDE 150/25/25，所有异常数组为空）；重新 verify-viewflow-private.cjs；运行 write-viewflow-report.cjs 传上面两个人工绝对目录，生成验收报告和 accepted.json；核对报告后才能 update_goal complete、提供当前私版 EXE/portable/VSIX 链接。

## 16:15 当前状态（以下时间较早的版本均非本轮最终依据）

最终候选 v7 已生成，EXE 16:08、VSIX 16:07，版本仍为 1.0.18 / 0.1.28-local。ASAR SHA256 为 6b045290b14fb2e48ce083d4395f63e0e4426d74d1b40256b4be758671b4379d。提取 VSIX 是 test/.runs/vsix-private-0.1.28-viewflow-v7-final/extension。v7 修复旧分屏入口锚点在外部刷新、查找及新输入后未及时释放、导致补全输入被拉回行首的问题；独立开发 60 项分屏及真实 VSCode 补全专项已通过。

包级串行回归运行于 exec_command session 94346，先 run-viewflow-regressions.mjs，再 run-viewflow-ide.mjs，统一输出 .perf/viewflow-final-v7。截至 16:15，nested-math 24、viewflow 60、navigation 63 已通过，math-table 68 / 888 步尚在进行。当前 coherence.json 已校验 v7 同源及公版不改。只有此轮全部通过后，才执行两套 manual-viewflow 脚本与 Computer Use 复核、生成验收报告并完成 goal。

## 15:53 最新验收状态

最终 EXE 是 15:39 构建，ASAR SHA256 c80330a5da9bf47bfd67ffa811a1ff5245952bd3fb35adc1409c59f30a82f782。完整最终 EXE 回归 .perf/viewflow-final-v5/results.json 8 套全通过：nested 24、viewflow 59、navigation 63、math-table 68/888 步、chat-selection 110、locations 10、source-toggle-host、math-history。新增 rich 下划线案例发现 WYS html-inline 隐藏标签偏移，已在此最终 EXE 中修复并通过 110 个选区测试。

最终 VSIX 提取目录是 Typora-Editor/test/.runs/vsix-private-0.1.28-viewflow-v6-final/extension。v6 仅清理扩展 manifest 中无效的宿主快捷键条件；Alt+U 始终由 native-chat.js 在当前编辑 webview 捕获，其他侧栏不会被宿主 fallback 抢键，命令面板命令保留。renderer 479 和 host 3 文件仍与已验收 EXE/shared 一致；verify-viewflow-private.cjs 已指向 v6 并更新 coherence.json。

自动 EXE 测试窗口曾收到用户输入“类似”，现 showInactive + Emulation.setFocusEmulationEnabled 只接收指定 Chromium 目标的脚本事件，不反复抢 OS 焦点；真实 Computer Use 仍待做。VSCode 新分屏入口原断言 220ms 早于异步源码高亮提交，已像 desktop 套件一样等待实际 source/anchor ready 再断言；最终 VSIX 专项 test/.runs/vscode-1788853843204 全通过，源码和渲染光标一致。

当前正在运行 tools exec_command session 15113：node scripts/run-viewflow-ide.mjs，依次 final v6 VSCode full、VSCode chat、Trae chat，输出 .perf/viewflow-final-v5/ide-results.json。旧 v5 的 vscode-full.log/ide-results 是失败过的，必须以新这轮全部通过为准。真实 Chat 专项现每 host 应 22 检查（5 启动 + 17 原生上下文）。登录后的 Trae 专用 profile 仍是 test/.runs/vscode-1788852017792/profile。

剩余：完成 IDE 回归；Computer Use 人工 Trae Alt+U（vscode-smoke 支持 MD_EDITOR_CHAT_HOLD_DIR：自动 Chat 专项后写 ready.json 并等待该目录 done 文件；完成手工选择/Alt+U 后 touch done，自动写 native-receipts.json 并退出）；最终 portable 人工复核脚本 scripts/manual-viewflow-exe.mjs。为两个 manual 目录写真实 manual-verified.json，EXE 需含 verified:true 与实际运行解压 ASAR 的 asarSHA256。随后运行 node scripts/write-viewflow-report.cjs <manualExeDir> <manualTraeDir>（会强制所有验证通过才生成 docs/CHANGE-REPORT-PRIVATE-VIEWFLOW-1.0.18.md 和 .perf/viewflow-delivery/accepted.json）。仍未完成 goal，不能提前交付。

## 15:27 最新状态（以下旧记录是历史）

active goal 已追加第 4 项：Trae/VSCode Alt+U 原生 AI 侧边栏选区附件。新 render/js/native-chat.js 与 out/common/native-chat.cjs；provider 在 boot 开启 nativeChat，贡献 marcopilot.addSelectionToChat 和 Alt+U。保留 DOM Range，flushChanges 仅同步待输入内容，host 等 completion synchronized 后发送当前原始 compact source，selectedMarkdownRange 对应 AST/DOM 选区，PortableImages.rawOffset 还原真实行列。Trae 调用 workbench.action.chat.icube.open 的 docviewPayload（其内置 docview 同款），VSCode chat.open attachFiles。只添加上下文，不发送提示词，不为匹配选区改写 Markdown。

已修复 WYSIWYG HTML 实体使后续数学源偏移，以及 SV canonical 表格空格与原始文件不同的映射。80 选区组合 .perf/chat-selection-dev-05 通过：IR/WYS/SV × LF/CRLF、重复项、emoji、跨段、公式源码、元素边界。

实际 IDE 开发验证：VSCode test/.runs/vscode-1788851959035 和 Trae test/.runs/vscode-1788852267299，各 16 检查通过；webview-errors/unhandled-errors=[]。已追加各模式公式和代码选区，最终包需重跑。用户本轮说“帮你登陆好了”，登录后的独立 Trae 测试 profile 为 test/.runs/vscode-1788852017792/profile。不能操纵用户原笔记窗口。Trae AI 也有 iframe，测试按 workbench.parts.editor 几何范围选择编辑 iframe。

分屏入口延迟 focus 把 caret 重置为 0 的疑点已修复：持有入口锚点时恢复实际源节点/offset，用户操作立即释放。v3 最终包 nested-math 24、viewflow 59、navigation 63 通过。v3 math-table 68 中 rapid-toggle 一次读取时按键尚未送达；测试加 native focus 和 keyup 到达确认，同一 v3 两模式针对性复测 .perf/viewflow-rapid-delivered 通过。最终仍需全 68 / 888 步，不以复测代替。

当前构建 v4：EXE 1.0.18 / VSIX 0.1.28-local，VSIX 已提取 test/.runs/vsix-private-0.1.28-viewflow-v4-final；EXE 正在构建。下一步 run-viewflow-regressions.mjs 输出 .perf/viewflow-final-v4（已加入 chat-selection）；final VSIX 完整 VSCode smoke、Chat 专项 VSCode/Trae；Computer Use 人工复核；verify-viewflow-private.cjs 校验 479 renderer 文件和 3 host 文件/命令/键位、公版 4 包不改；最终报告/accepted/完成 goal。

原笔记用户已在工作期间修改，不能声称 live file 保持初始 hash。旧复杂快照 user-note-original.md，14:37 最新快照 user-note-latest.md（12062 字符）；人工 EXE 用后者副本，68 矩阵仍用更早复杂表格快照。禁止改写或恢复原笔记。

## 历史记录

当前目标包含：切换双屏保持位置、双向滚动（性能优先，自动降级）、拖动分隔条；用户后补截图要求解决加粗等嵌套格式中的相邻公式源码和黑底误显示。均须完成，不能先交付部分功能。

共享源码为 `D:/BuyKey/Typora-Editor/extension-src/render`，只用 sync-renderer.mjs 同步 app/renderer。当前版本元数据 EXE 1.0.18 / VSIX 0.1.28-local。已经生成过的 1.0.18 构建还未包含嵌套公式修复，必须重新构建和验收，不能交付。

分屏实现位于 split-navigation.js、split-resize.js、markdown-locations.js、toolbar.js、index.css。开发验收已通过正文/代码/列表/两种模式/公式/矩阵/双向滚动/拖动/缓存，以及 191513 和 969763 字符文件。粗略阈值 150000 字符与 900000 字符。连续滚动无需重新解析，大文件同步测得约 1.4 ms / 0.3 ms 最慢（开发记录，最终须重测）。

新增截图问题用原笔记第 256 行复现，证据 `.perf/nested-math-before`：相邻两个公式自身 expanded=false，但祖先 strong 展开令 vendor 后代选择器把源码显示出来，background 为 rgb(42,45,46)。index.css 增加只按自身状态隐藏直接数学标记的规则；math-edit.js 增加 ownMath，防止普通加粗/链接文本的光标激活或取消该容器的第一条公式。

新测试：viewflow-suite.cjs、viewflow-performance-suite.cjs、nested-math-suite.cjs。split-navigation-runner.cjs 支持三种套件，真实 Chromium 输入前确保原生窗口有焦点，否则编辑器失焦收起公式会造成错误的测试状态。嵌套公式包含 24 种组合：两模式 × 六格式 × 正文/表格，各包含打开、预览再点、普通文本焦点、快捷键往返。

当前需继续：完成嵌套公式复测；重新打包 private EXE 和 VSIX；运行 run-viewflow-regressions.mjs（最终 ASAR 的嵌套公式、分屏新行为、原有 63 项定位、68 项公式表格矩阵、单元、宿主切换和数学历史）；实际 VSCode 提取 VSIX 完整 smoke（已添加新分屏和原句嵌套公式测试）；Computer Use 最终 portable 真实笔记副本人工复核（分屏切换、左右滚轮、拖分隔条、原句公式和普通文本点击）；同源校验、最终报告、完成 goal。

原笔记本轮快照 `.backups/2026-09-08-viewflow/user-note-original.md`；不得编辑原文件。公开产物哈希基线 `.perf/viewflow-delivery/public-before.json`。本轮最终证据计划放 `.perf/viewflow-final`、`.perf/viewflow-delivery`；前次交付证据和安装包保留。

未解决的验收疑点：第一次 final ASAR 新套件在入口时 source/preview ready 但 anchor=null，之后带轨迹重跑通过。现已等待位置锚点建立后才断言，并在输入前激活原生窗口；仍需最终连续重复与人工复核，不能忽略此现象。可用 VIEWFLOW_ENTRY_TRACE=1 生成入口事件日志（仅测试）。
