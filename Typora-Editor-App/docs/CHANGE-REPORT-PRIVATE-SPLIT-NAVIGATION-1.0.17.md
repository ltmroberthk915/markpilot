# marcopilot 私版 1.0.17 / VSIX 0.1.27-local：源码双屏双向定位

验收日期：2026-09-08。仅更新私版；共同渲染源码为 D:/BuyKey/Typora-Editor/extension-src/render。

## 使用行为

- 右侧单击渲染文字、表格单元格或公式符号，左侧真实编辑光标移到对应源码；重复文本按原来的段落、行、单元格分别定位。
- 左侧单击、移动光标或输入，右侧对应文字或公式符号自动滚动到与光标中心相同的水平线。首段、末段、窗口缩窄及公式异步渲染后继续对齐。源码分隔标记、空格等没有可见字形的位置使用相应内容或单元格定位。
- 右侧滚轮和拖选可继续阅读、复制；左侧再次操作后恢复跟随。右侧普通单击链接/图片执行源码定位，带修饰键的单击保留原有处理。
- 输入后预览尚未更新时，点击旧画面仍转换到当前源码位置；导航本身不会改写 Markdown、制造保存脏标记或插入定位标记。

## 最终产物验证

| 环境 | 结果 | 证据 |
| --- | --- | --- |
| 最终 app.asar，真实桌面主进程、preload、iframe | **63/63 双屏场景通过** | [逐项结果](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-accepted-v3/results.json) |
| 同一最终 app.asar，上一轮公式和表格矩阵 | **68/68 场景、888 次逐步检查通过** | [公式表格回归](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-math-regression-v2/results.json) |
| 最终 VSIX 解包，真实隔离 VS Code 与 Webview | **130/130 检查通过**，含双向原生点击及保存不变 | [VS Code 结果](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788845529931/results.json) |
| 源位置解析、源码切换与公式历史 | **9 项解析测试及 2 组既有回归通过** | [回归日志索引](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-regressions/results.json) |
| 最终 portable EXE，可见鼠标键盘操作 | **4 项复核通过**，捕获的 JavaScript 异常 0 | [操作记录](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/manual-verified.json) |
| 共同源码、App 源码、最终 ASAR、最终 VSIX | **477 个渲染文件逐文件 SHA256 一致** | [完整哈希清单](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-delivery/coherence.json) |

双屏矩阵覆盖正文、加粗、实体、转义、Unicode、列表、引用、链接、脚注、HTML、代码、分式、上下标和积分符号、重复表格内容与空格、首尾连续定位、同一光标位置重复点击 12 次、原生滚轮/拖选、旧预览点击、输入/撤销/重做/保存、模式往返及窗口缩窄。水平对齐由独立 DOM 字形测量验收，阈值为 4 CSS 像素；原生鼠标点击负责移动真实光标，测试定位 Range 用于查找屏幕上的目标。

公式表格回归包括 Ctrl+Shift+E 开关、逐字符 TeX、未完成公式、中文和 emoji、裸竖线/换行粘贴、空公式删除、同表换格收起预览、重复格、保存重开及连续交错编辑，保留上一轮修复。

## 当前概率论笔记及人工复核

本轮以用户 12:09:34 更新后的概率论笔记副本验收，包含 11 列表格与文末对照表；所有编辑发生在隔离副本。原文件 [1-重识概率论.md](D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md) 的 SHA256 为 `d5c9d7469bea1540cfc2d6c83d58894cbf874abb9f2ed201825f7ad253ce1dfb`，与本轮取样时一致。4 个公版产物哈希不变。

| 操作 | 实际观察 | 证据 |
| --- | --- | --- |
| 01-first-right-heading | 全新便携版会话首次进入源码双屏后直接点击右侧章节标题，左侧光标与标题同高；Shift+右方向键实际选中左侧“法”，无右侧目标误跳。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/01-first-right-heading.png) |
| 02-left-table-align | 单击左侧 col2 源码，右侧对应表头由下方滚动到同一水平线，表格行列保持正常。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/02-left-table-align.png) |
| 03-right-duplicate-formula | 点击右侧第五格内的第二个 a，再按 Shift+右方向键实际选中左侧第五格的 a，未误选第一格相同公式；左右公式同高。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/03-right-duplicate-formula.png) |
| 04-left-wide-table-align | 单击左侧第二张 11 列表格的 a 源码，右侧对应行的 a 自动与左侧同高；第一张表及宽表邻行保持正常。 | [截图](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/04-left-wide-table-align.png) |

## JavaScript 问题与实现

可见人工复核还发现了单靠连续自动化点击漏掉的首次焦点问题：窗口恢复焦点时，浏览器可能将光标放在编辑区容器边界；旧逻辑取整个面板中心，造成右侧目标在鼠标点击前移动。现在只有实际源码操作或导航才启动跟随，并把容器边界转换到对应的文字位置。修复前后的同一回归分别出现 80 像素跳动和保持原位，最终矩阵包含新会话中先点击右侧及真实笔记上的首次反向定位。

[修复前的失败对照](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-activation-before-v2/results.json) 与 [人工复现记录](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788844943511/first-click-reproduction.json) 保留供复核。

验收额外发现 Vditor 在已预加载 material 图标后，仍尝试同步 XMLHttpRequest；VS Code 的资源加载路径可能拒绝该请求并产生未处理 Promise 异常。现为已加载脚本设置 Vditor 自身识别的 ID，阻止重复同步请求；没有吞掉异常。最终 VSIX 同时验证单次图标加载、启动异常和未处理 Promise。

[最终 Webview 异常记录](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788845529931/webview-errors.json)、[扩展宿主未处理异常](D:/BuyKey/Typora-Editor/test/.runs/vscode-1788845529931/unhandled-errors.json)、[portable JavaScript 记录](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/runtime-errors.json) 均为空。桌面矩阵从窗口创建起监听 console/preload 错误，调试 Runtime 在真实页面提交后接入；便携版另保留整个进程启动日志。外部图片网络请求与编辑器 JavaScript 异常分开记录。

原笔记中的一张 Wikimedia 外链图片在手工会话中连接失败，保留于 [资源请求记录](D:/BuyKey/Typora-Editor-App/.perf/split-navigation-manual-exe-1788845722763/resource-errors.json)，未影响本次双屏定位操作。

位置映射复用 Lute AST 与现有 KaTeX 符号位置。双屏模块独立管理滚动、异步刷新与退出清理；首尾对齐空间由 CSS 伪元素提供，不写入文档。相关源码为 [markdown-locations.js](D:/BuyKey/Typora-Editor/extension-src/render/js/markdown-locations.js)、[split-navigation.js](D:/BuyKey/Typora-Editor/extension-src/render/js/split-navigation.js) 和 [index.html](D:/BuyKey/Typora-Editor/extension-src/render/index.html)。

## 私版文件

以下生成时间均为北京时间。

| 文件 | 生成时间 | 字节 | SHA256 |
| --- | --- | ---: | --- |
| [marcopilot-Setup-1.0.17.exe](D:/BuyKey/Typora-Editor-App/dist/release-1.0.17-private-final/marcopilot-Setup-1.0.17.exe) | 2026-09-08 13:32:33 | 116,219,083 | `e073b4d9ff083ec59b4f7025600a8722573b9e04e89a034524ad06d29b3bfb90` |
| [marcopilot-v1.0.17-portable.exe](D:/BuyKey/Typora-Editor-App/dist/release-1.0.17-private-final/marcopilot-v1.0.17-portable.exe) | 2026-09-08 13:32:39 | 115,991,680 | `1b5929f129c8f73f329e3858a62bcd4d0a314c2f895d620af9b267de7d7a74a9` |
| [app.asar](D:/BuyKey/Typora-Editor-App/dist/release-1.0.17-private-final/win-unpacked/resources/app.asar) | 2026-09-08 13:32:04 | 23,186,701 | `1f153da1708efd6d6f61ae7214d696ad5b36c6cbd42d6d981bccd96a967d93c9` |
| [marcopilot-0.1.27-local.vsix](D:/BuyKey/Typora-Editor/dist/marcopilot-0.1.27-local.vsix) | 2026-09-08 13:31:58 | 6,215,504 | `e988d577fc063c50ebb08de036f6c43cddce09fe28f74ed782ac12348172241e` |
