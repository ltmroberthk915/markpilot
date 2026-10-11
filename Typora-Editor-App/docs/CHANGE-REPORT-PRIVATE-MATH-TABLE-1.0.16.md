# marcopilot 私版 1.0.16 / VSIX 0.1.26-local：公式与表格验收

验收日期：2026-09-08。共用渲染源码来自 D:/BuyKey/Typora-Editor/extension-src/render。本轮只更新私版。

## 修复结果

1. Ctrl+Shift+E 在当前公式内再次按下会移除公式边界、保留源码和本地光标。空公式、部分选中公式、重复内容以及源码视图都分别处理，消除了旧实现继续套美元符号和全局搜索光标的问题。
2. 表内行内公式键入、删除和粘贴通过局部编辑事务更新。未完成的 TeX 保持可编辑，普通 Markdown 的表格分隔处理不会接管公式输入。表内裸竖线保存为数学意义相同的 \vert{}；粘贴的行内换行转为空格，以防 Markdown 重开时拆列、拆行或丢邻格。删空时立即清理浏览器遗留的 BR 并使用可序列化占位；再次 Backspace/Delete 会完整移除空公式，再键入和重开不会拆出新行。
3. 焦点或选区移动到同表其他单元格时，旧公式源码立即收起。无需离开整张表；撤销重做后仍保留可编辑源码与预览。
4. 单元格中的 `<br />` 保持换行，不再暴露 HTML 源码编辑组件。
5. 手工验收额外发现末行公式预览被表格裁切。现在表内编辑预览占用真实单元格高度，完整展示在源码下方；正文仍使用原有浮动预览。

跨单元格和跨段落选择保留原结构并作为一次操作撤销。字面行内代码、围栏代码保持代码边界。块级公式沿用既有输入路径，其历史、矩阵和引用/列表中的数学回归均已检查。

## 使用的真实文档

以用户指定概率论文件的固定副本作为基准，含四张表：6 列表、11 列多行表、含三个换行的两列表头，以及文末对照表。测试覆盖重复的 a、空单元格、空 `$$`、多行 `<br />` 和原有数学内容。

原文件 D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md 保持不变，SHA256：`4950c9576bd733b821f26549e2326c5e3f53e2d122c243e8ac13428cc85738df`。原文已有不配对的美元符号，本轮没有自动改写用户内容；所有键入、保存和重开使用独立副本。

## 最终产物上的验证

| 环境 | 本轮结果 | 证据 |
| --- | --- | --- |
| 最终 EXE 内 app.asar，真实桌面主进程/preload/编辑器/保存链路 | **68/68 场景通过，888 次逐步检查** | [逐项结果](D:/BuyKey/Typora-Editor-App/.perf/math-table-accepted-v2/results.json) |
| 最终 VSIX 解包后，真实隔离 VS Code 及 Webview | **116/116 检查通过**，包括 IR/WYSIWYG/SV、可信快捷键、TextDocument 保存重开 | [VS Code 结果](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788838782686/results.json) |
| 最终便携 EXE，Computer Use 可见鼠标键盘操作 | **7 项可见检查通过**，从启动到关闭捕获的 JavaScript 异常为 0 | [操作记录](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/manual-verified.json)、[异常日志](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/runtime-errors.json) |
| 共同源码、App 源码、最终 ASAR、最终 VSIX | **475 个渲染文件逐文件 SHA256 一致**；4 个公版产物和原笔记哈希不变 | [完整哈希清单](D:/BuyKey/Typora-Editor-App/.perf/math-table-delivery/coherence.json) |

矩阵包含：空/已有公式、中文和 emoji、上下标、分式、矩阵、裸竖线、不完整 TeX、特殊标点、剪贴板及多行粘贴、表头和末行、Tab/Shift+Tab/上下键/Enter/Backspace、鼠标换格、连续 30 次开关、重复公式定位、部分选择取消、跨格和跨段选择、源码往返、保存重开、撤销重做，以及每种可视模式在同一副本上连续 24 轮交错编辑。

每次操作检查表结构、焦点与异常；保存重开场景比较所有单元格的源码内容，而非只比较行列数。连续编辑还检查所有未编辑单元格不变，并穿插撤销、重做和磁盘保存。原生键盘/鼠标承担输入和导航，复杂自动化选区用 DOM Range 定位；可见人工操作独立补充鼠标定位与实际画面检查。

## 最终便携版的可见操作证据

| 检查 | 实际观察 | 证据 |
| --- | --- | --- |
| 01-ir-delete-to-empty | 最终 portable 中 r 删空后成为正常 $$ 占位，预览消失，表格仍为原来的三行六列。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/01-ir-delete-to-empty.png) |
| 02-ir-type-after-deletion | 连续两次 Backspace 后再键入 s，s 留在原单元格，无残留美元符号、额外表格行或表格源码。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/02-ir-type-after-deletion.png) |
| 03-ir-toggle-on | 通过 Shift+Home 确认选中文本 s 后使用 Ctrl+Shift+E；源码为 $s$，下方预览完整处于单元格内。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/03-ir-toggle-on.png) |
| 04-ir-collapse-on-cell-change | 光标仍在同一表格，切换单元格后 $s$ 源码和预览面板立即收起，仅保留渲染的 s。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/04-ir-collapse-on-cell-change.png) |
| 05-ir-toggle-off | 重新点击公式，再按 Ctrl+Shift+E 后恢复普通文本 s；无嵌套美元符号，表格恢复正常行高。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/05-ir-toggle-off.png) |
| 06-wysiwyg-empty-forward-delete | 所见即所得模式中，Delete 删除整个空公式 $$，表格工具栏仍显示 3×6。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/06-wysiwyg-empty-forward-delete.png) |
| 07-wysiwyg-type-after-forward-delete | 删除空公式后输入 q，文字保留在原单元格，没有美元符号残留或新增表格行。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/math-table-manual-exe-1788839382176/07-wysiwyg-type-after-forward-delete.png) |

## 开发回归和 JavaScript 诊断

修复过程中运行并通过了 13 组既有回归：features、math-history、math-colors、math-boundaries、regression、consistency、repairs、ui、table-context、table-context-host、table-input-host、source-toggle-host、shell；其中包含行内/块级/引用/列表公式历史、原生中文 IME、宏与化学公式、2,844 个公式的教材。数学 Markdown 单元测试 23/23 通过。最后的显示调整另用最终包完整矩阵和可见操作验收。

[回归日志索引](D:/BuyKey/Typora-Editor-App/.perf/math-table-regressions/results-math-history-math-colors-math-boundaries-regression-consistency-repairs-ui-table-context-table-context-host-table-input-host-source-toggle-host-shell.json)；[IME/宿主补充回归](D:/BuyKey/Typora-Editor-App/.perf/math-table-regressions/results-features-math-history-consistency-table-input-host.json)；[删空修复后的最终快捷键和历史回归](D:/BuyKey/Typora-Editor-App/.perf/math-table-regressions/results-features-math-history.json)。

旧版本基线在同一笔记副本上有 12 个场景、9 个失败，并捕获过 WYSIWYG 空公式序列化导致的 Lute 异常。本轮为空公式建立可序列化占位，首次真实输入及粘贴再建立公式节点。

测试启动器的 EPIPE 管道问题已改为持久日志与正确进程等待。本地前后对照还发现：在 Electron 空白页面尚未提交时开启 Runtime 调试会触发预加载 bootstrap 的 startupData 空值错误；加载完成后接入的对照测试通过。因此调试观察等待真实文档初始化，原生启动日志从进程创建开始独立保留。

VS Code 测试中的模拟补全服务曾在收到取消后的空请求时发生 JSON.parse 异常。已修复模拟服务的空请求和断连处理，并让未处理 Promise 异常直接阻断验收；最终 116 项检查的 [未处理异常记录](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788838782686/unhandled-errors.json) 为空。

外部图片请求失败单独保留在 resource-errors.json，不计为 JavaScript 异常。测试不屏蔽编辑器的 error、unhandledrejection 或 preload 错误；这些错误会使验收失败。

## 私版文件

时间戳下表用 UTC，北京时间加 8 小时。

| 文件 | 生成时间 | 字节 | SHA256 |
| --- | --- | ---: | --- |
| [marcopilot-Setup-1.0.16.exe](D:/BuyKey/Typora-Editor-App/dist/release-1.0.16-private-final/marcopilot-Setup-1.0.16.exe) | 2026-09-08 03:38:12.210 UTC | 116,130,037 | `1e958ade5ca50b7cf9209510006a9fe8d93432cfc476fd798239ae81de0b0f0d` |
| [marcopilot-v1.0.16-portable.exe](D:/BuyKey/Typora-Editor-App/dist/release-1.0.16-private-final/marcopilot-v1.0.16-portable.exe) | 2026-09-08 03:38:17.456 UTC | 115,902,634 | `d17f577b4698153f7256dec5db9a178c0acef1bff17cd857db555432769ab536` |
| [app.asar](D:/BuyKey/Typora-Editor-App/dist/release-1.0.16-private-final/win-unpacked/resources/app.asar) | 2026-09-08 03:37:45.939 UTC | 23,158,835 | `41f083d91fcbecb02fbf47365e2963835642beb3cf34ac43369e1072df89e22d` |
| [marcopilot-0.1.26-local.vsix](D:/BuyKey/Typora-Editor/dist/marcopilot-0.1.26-local.vsix) | 2026-09-08 03:37:37.406 UTC | 6,206,344 | `a40c2873f0a574d82e7a7243484aa4b174f2df2867e3897d246117f7437243cb` |

本报告记录上述具体版本、笔记副本和交互范围的结果，不声称穷尽任意 Markdown、任意输入法或所有未来操作序列。

## 68 个最终场景

| 场景 | 结果 | 逐步检查 |
| --- | --- | ---: |
| ir-empty-cell-math-focus | PASS | 5 |
| ir-selected-cell-toggle-off | PASS | 3 |
| ir-prose-toggle-off | PASS | 3 |
| ir-existing-math-toggle-off | PASS | 2 |
| ir-empty-math-cancel | PASS | 3 |
| ir-br-cell-is-linebreak | PASS | 1 |
| ir-preview-contained-in-final-row | PASS | 18 |
| ir-typing-ascii | PASS | 11 |
| ir-typing-fraction | PASS | 19 |
| ir-typing-pipe | PASS | 17 |
| ir-typing-matrix | PASS | 41 |
| ir-typing-unfinished | PASS | 13 |
| ir-typing-punctuation | PASS | 15 |
| ir-navigation-tab | PASS | 5 |
| ir-navigation-shift-tab | PASS | 5 |
| ir-navigation-down | PASS | 5 |
| ir-navigation-up | PASS | 5 |
| ir-rapid-toggle-30 | PASS | 32 |
| ir-mouse-between-duplicates | PASS | 18 |
| ir-type-undo-redo-save-reopen | PASS | 9 |
| ir-delete-empty-formula | PASS | 7 |
| ir-empty-math-forward-delete | PASS | 4 |
| ir-chinese-and-emoji-input | PASS | 4 |
| ir-br-edit-and-math | PASS | 6 |
| ir-clipboard-in-formula | PASS | 5 |
| ir-multiline-paste-reopen | PASS | 5 |
| ir-header-cell | PASS | 4 |
| ir-source-mode-roundtrip | PASS | 7 |
| ir-enter-inside-math | PASS | 7 |
| ir-partial-formula-selection-off | PASS | 2 |
| ir-multi-cell-selection | PASS | 3 |
| ir-multi-paragraph-selection | PASS | 3 |
| ir-literal-code-boundary | PASS | 4 |
| ir-sequence-soak-24 | PASS | 153 |
| wysiwyg-empty-cell-math-focus | PASS | 5 |
| wysiwyg-selected-cell-toggle-off | PASS | 3 |
| wysiwyg-prose-toggle-off | PASS | 3 |
| wysiwyg-existing-math-toggle-off | PASS | 2 |
| wysiwyg-empty-math-cancel | PASS | 3 |
| wysiwyg-br-cell-is-linebreak | PASS | 1 |
| wysiwyg-preview-contained-in-final-row | PASS | 18 |
| wysiwyg-typing-ascii | PASS | 11 |
| wysiwyg-typing-fraction | PASS | 19 |
| wysiwyg-typing-pipe | PASS | 17 |
| wysiwyg-typing-matrix | PASS | 41 |
| wysiwyg-typing-unfinished | PASS | 13 |
| wysiwyg-typing-punctuation | PASS | 15 |
| wysiwyg-navigation-tab | PASS | 5 |
| wysiwyg-navigation-shift-tab | PASS | 5 |
| wysiwyg-navigation-down | PASS | 5 |
| wysiwyg-navigation-up | PASS | 5 |
| wysiwyg-rapid-toggle-30 | PASS | 32 |
| wysiwyg-mouse-between-duplicates | PASS | 18 |
| wysiwyg-type-undo-redo-save-reopen | PASS | 9 |
| wysiwyg-delete-empty-formula | PASS | 7 |
| wysiwyg-empty-math-forward-delete | PASS | 4 |
| wysiwyg-chinese-and-emoji-input | PASS | 4 |
| wysiwyg-br-edit-and-math | PASS | 6 |
| wysiwyg-clipboard-in-formula | PASS | 5 |
| wysiwyg-multiline-paste-reopen | PASS | 5 |
| wysiwyg-header-cell | PASS | 4 |
| wysiwyg-source-mode-roundtrip | PASS | 7 |
| wysiwyg-enter-inside-math | PASS | 7 |
| wysiwyg-partial-formula-selection-off | PASS | 2 |
| wysiwyg-multi-cell-selection | PASS | 3 |
| wysiwyg-multi-paragraph-selection | PASS | 3 |
| wysiwyg-literal-code-boundary | PASS | 4 |
| wysiwyg-sequence-soak-24 | PASS | 153 |
