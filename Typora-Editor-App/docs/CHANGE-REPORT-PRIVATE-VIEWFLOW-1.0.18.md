# marcopilot 私版 1.0.18 / 0.1.28-local 验收记录

本轮完成分屏三项需求、IDE 原生 AI 选区协作，以及加粗等嵌套格式中公式源码连带展开和黑底的问题。EXE 与 VSIX 的 479 个共享渲染文件逐一校验一致；新增 IDE 宿主代码和命令也与最终 VSIX 一致。Alt+U 由编辑器自身接收，不拦截其他侧栏的快捷键。公开版四个产物哈希与本轮开始时一致。

切换源码/渲染双屏时保留当前可见编辑位置；纯阅读、旧光标在屏外时保留阅读位置。左右两侧滚动对应移动；拖动中央分隔条会重新排版，宽度会记住，分隔条也支持方向键和双击复位。小文件使用精确对应；超过 150000 字符使用段落/单元格对应；超过 900000 字符使用比例同步。连续滚动复用映射缓存，不逐次解析整篇文档。外部文档刷新、查找和继续输入会及时释放切换时保留的位置，避免旧位置将新输入拉回行首；该问题加入分屏回归，并验证三种模式的补全、中文输入法和撤销。

Trae 和 VS Code 中，在正文、表格、公式或代码中选中文字后按 Alt+U，可将对应文件及行列范围加入原生 AI 输入区。命令面板也提供“marcopilot: 将选区加入 AI 对话”。待同步的输入会先完成同步，未保存内容可作为上下文；附件操作不自动提交提示词，不为匹配位置重写 Markdown。验证包含重复单元格、反向和跨段选区、内嵌图片后的偏移、源码视图的表格空格差异及刚输入的中文/emoji。Ctrl+U 下划线功能保留。

公式黑底问题由外层格式的展开选择器波及后代数学标记引起，现按每个公式自身的状态显示源码。普通加粗、斜体、链接等文本的焦点不会误激活同一容器里的第一条公式。对原笔记 RN 导数段及其正文/表格变体逐个打开公式、再次点击预览、离开公式、执行快捷键往返进行验证。选区映射另修复了 HTML 实体和下划线隐藏标签造成的偏移。

| 最终包验证 | 结果 | 证据 |
|---|---:|---|
| 嵌套格式中的公式独立展开 | 24 / 24 | [详细结果](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/nested-math/results.json) |
| 分屏进入、双向滚动、分隔条及性能 | 60 / 60 | [详细结果](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/viewflow/results.json) |
| 原有源码/渲染点击定位 | 63 / 63 | [详细结果](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/navigation/results.json) |
| 原始复杂表格与数学快捷键矩阵 | 68 / 68 | [详细结果](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/math-table/results.json) |
| 原始 Markdown 选区映射 | 110 / 110 | [详细结果](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/chat-selection/results.json) |
| 源位置解析单元测试 | 10 / 10 | [日志](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/markdown-locations.log) |
| 宿主源码切换与数学历史回归 | 通过 | [切换](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/source-toggle-host.log)；[历史](D:/BuyKey/Typora-Editor-App/.perf/viewflow-final-v8-accepted/math-history.log) |
| vscode-full（真实 IDE，提取最终 VSIX） | 150 项通过 | [结果](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788857697516/results.json) |
| vscode-chat（真实 IDE，提取最终 VSIX） | 25 项通过 | [结果](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788857872387/results.json) |
| trae-chat（真实 IDE，提取最终 VSIX） | 25 项通过 | [结果](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788857893056/results.json) |

原始数学/表格矩阵共 888 个步骤；嵌套公式组合共 264 个步骤。除数学历史使用共享 renderer 测试宿主外，上表桌面交互套件运行在最终 app.asar 的真实主进程、preload 和编辑 iframe 上。自动回归在独立窗口以 Chromium 输入事件运行；最终可执行文件和 Trae 另经 Computer Use 鼠标、滚轮、拖动、键盘人工操作复核。

| 大文件 | 降级方式 | 首次切换耗时 | 最慢滚动同步 | 滚动时重建/重新解析 |
|---|---|---:|---:|---|
| 191513 字符 / 444371 字节 | 块对应 | 2.28 s | 0.90 ms | 无 |
| 969763 字符 / 2233981 字节 | 比例对应 | 4.15 s | 0.20 ms | 无 |

本轮捕获范围内，编辑器 renderer/preload 与扩展测试的 JavaScript 异常、未处理 Promise 拒绝均为 0。该结论限定于已执行的测试，不把 IDE 其他内置组件的日志算作 marcopilot 异常。

人工复核：[最终 portable EXE](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-exe-1788856228136/manual-verified.json)；[Trae 真实 Alt+U](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-trae-1788856009346/manual-verified.json)；[原生附件回执](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-trae-1788856009346/native-receipts.json)。

截图：[原段落公式预览再次点击](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-exe-1788856228136/01-rn-preview-reclick.png)；[表格内切换单元格后正常渲染](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-exe-1788856228136/06-table-cell-exit.png)；[拖动分隔条](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-exe-1788856228136/04-divider-wider-preview.png)；[Trae 原生附件](D:/BuyKey/Typora-Editor-App/.perf/viewflow-manual-trae-1788856009346/02-header-attached.png)。

测试使用笔记副本。原始文件 D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md 在用户工作期间有更新：复杂矩阵保留较早快照，人工 EXE 复核使用 14:37 的较新快照。未将副本覆盖回原文件。当前 live hash 与各测试快照分别记录在 [同源及文件校验](D:/BuyKey/Typora-Editor-App/.perf/viewflow-delivery/coherence.json)，不声称原文件仍与初始快照一致。

| 私版产物 | 北京时间 | SHA-256 |
|---|---|---|
| [marcopilot-Setup-1.0.18.exe](D:/BuyKey/Typora-Editor-App/dist/release-1.0.18-private-final/marcopilot-Setup-1.0.18.exe) | 2026/9/8 16:27:00 | `9cab5d245a97ce4064006a9f19066241e668902373cb62f355826389542585b4` |
| [marcopilot-v1.0.18-portable.exe](D:/BuyKey/Typora-Editor-App/dist/release-1.0.18-private-final/marcopilot-v1.0.18-portable.exe) | 2026/9/8 16:27:05 | `e86c2e3ac3467c296fab101e751c9d3f88b5167b804f9c37c1d951062e379448` |
| [app.asar](D:/BuyKey/Typora-Editor-App/dist/release-1.0.18-private-final/win-unpacked/resources/app.asar) | 2026/9/8 16:26:33 | `7c6c44e6246bafd43004825ef2b31aa1c171c31424336ded8fac5e18f53bbf55` |
| [marcopilot-0.1.28-local.vsix](D:/BuyKey/Typora-Editor/dist/marcopilot-0.1.28-local.vsix) | 2026/9/8 16:26:30 | `b34f32e802ba314ce9d8285ca3c6dc69248c35061c7f636ac0661ee9e58b77f8` |

过程中未通过的检查均保留证据：公式点击测试曾收到脚本未输入的“类似”，随后自动回归改为后台输入隔离并整轮重跑；Alt+U 的 HTML 实体、原始表格空格和下划线映射问题经修正后加入覆盖。人工操作另发现 Windows 辅助输入只有键值、没有扫描码时 Alt+U 被漏掉，已补键值回退并在三个编辑模式验证。代码块分屏用例曾把被预览层覆盖的坐标误当成编辑光标，现通过真实方向键定位、核对切换前光标，并在原失败窗口尺寸复核通过。最终验收只依据上列全部通过的包和记录。
