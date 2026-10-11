# 私版 1.0.0 饱和测试计划

状态：已按用户“继续后续任务，若我有打断就暂停”恢复桌面执行；源码全量回归进行中，最终包验收尚未完成。64 个工作流程中，16 个基础（25%）、48 个边缘（75%）。比例以工作流程为计数单位；模式、内容、平台的展开执行数及断言数另报，不用局部 Alt+U 矩阵代表全应用验收。

本文件是计划目录，不启动应用，也不根据测试脚本存在就宣称通过。当前执行证据记录在 .perf/release100-source 各任务目录；每项工作流程须核对实际步骤后单独映射，最终包复核另记。收到用户打断立即停止当前测试，不自动串联下一组桌面任务。

夹具使用 .backups 中的原笔记复杂表格、较新笔记快照和本轮 user-note-start.md；另加小型边界夹具。恢复时已读取最新笔记，生成 user-note-resumed-1788864957504.md（19246 字节，SHA256 6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7），包含三张表共 28 格。只修改隔离副本，不把快照覆盖回用户原文件。

每项执行记录须包含案例 ID、实际模式/平台/夹具哈希、操作与可观察结果、源码/产物哈希、异常日志路径和通过/失败状态。公式/表格断言包含行列结构、未操作单元格内容、光标所属格、每条公式源码可见性、磁盘及脏标记；视觉异常另留截图。故意输入不完整 TeX 的可预期渲染提示与未处理 JS 异常分别记录。

每组列出的脚本只是可复用的证据入口，未声称它们已经自动覆盖该组所有步骤。人工步骤和脚本缺口须补齐后逐项验收；旧版本报告不能作为当前版本通过证据。

先完成当前源码全量回归，再将私版版本改为 1.0.0 并构建；最终包仍须运行复核。旧 verify-viewflow-private.cjs 和 run-viewflow-* 脚本硬编码旧版本，不能直接用于签收新包。

## 文档与路径

私版 EXE、VS Code、Trae；空白、中文/空格/emoji 路径；全程使用副本。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B01 / 基础 | 新建、输入正文、保存后重开。 | 文件与正文一致，标题和脏标记正确，能够继续输入。 |
| E01 / 边缘 | 分别通过最近文件、文件关联和 IDE 重开中文及空格路径的同名文件。 | 打开正确的完整路径，已有编辑不被另一份同名文档覆盖。 |
| E02 / 边缘 | 在测试副本未保存时尝试切换文件，分别取消、保存和放弃。 | 各分支符合选择；取消保留编辑；不存在隐式覆盖。 |
| E03 / 边缘 | 从最近文件打开已移动/删除的副本，再打开正常文件。 | 错误可见且能够恢复；列表和当前文档状态不串线。 |

证据入口（待逐项映射）：[file-open.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/file-open.test.cjs)；[new-document.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/new-document.test.cjs)；[run-file-launch-tests.mjs](D:/BuyKey/Typora-Editor-App/scripts/run-file-launch-tests.mjs)；[vscode-smoke.cjs](D:/BuyKey/Typora-Editor/test/vscode-smoke.cjs)。

## 保存、恢复和外部刷新

正文、表格和数学源码；IR/WYS/SV；自动保存开启/关闭。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B02 / 基础 | 编辑正文和单元格，等待自动保存，再手动保存并重开。 | 磁盘、宿主及编辑器内容一致，保存后脏标记清除。 |
| E04 / 边缘 | 快速编辑、撤销、重做并切换文件，使保存任务连续排队。 | 旧任务不能覆盖较新的正文，撤销与重做内容可恢复。 |
| E05 / 边缘 | 在隔离副本模拟不可写、短暂写入失败，再恢复写入。 | 失败不被显示成成功，编辑内容仍在，可重试并恢复快照。 |
| E06 / 边缘 | 分屏保留旧位置后外部更新测试副本，再点击别处输入中文和公式。 | 刷新后旧锚点释放，新输入留在实际光标处；冲突分支不静默丢字。 |

证据入口（待逐项映射）：[autosave.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/autosave.test.cjs)；[snapshots.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/snapshots.test.cjs)；[desktop-protection.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-protection.cjs)；[viewflow-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/viewflow-suite.cjs)。

## 正文格式与编辑历史

IR/WYS/SV；中文、emoji、组合字符；正向/反向选区。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B03 / 基础 | 应用加粗、斜体、删除线、下划线及行内代码，保存重开。 | 格式与正文正确，标记成对，快捷键不串用。 |
| E07 / 边缘 | 在嵌套格式的开头、结尾和相邻格式边界输入、删除、撤销。 | 格式边界不吞字，撤销恢复整个操作，邻段内容保留。 |
| E08 / 边缘 | 跨段正向/反向选择含 emoji 的文本，再格式化并往返切换编辑模式。 | 选区映射正确，不产生半个字符或重复正文。 |
| E09 / 边缘 | 中文输入法组词过程中触发格式键和模式切换，再提交/取消组词。 | 没有重复提交或丢字；组合输入期间不误执行编辑快捷键。 |

证据入口（待逐项映射）：[shell-features.cjs](D:/BuyKey/Typora-Editor-App/scripts/shell-features.cjs)；[shell-repairs.cjs](D:/BuyKey/Typora-Editor-App/scripts/shell-repairs.cjs)；[math-history.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-history.cjs)；[vscode-smoke.cjs](D:/BuyKey/Typora-Editor/test/vscode-smoke.cjs)。

## 标题、列表、引用和导航

重复标题、多级列表、任务列表、引用套列表；与表格/公式相邻。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B04 / 基础 | 创建标题、列表和引用，通过目录跳转并继续编辑。 | 层级和跳转位置对应正确，继续输入不返回旧位置。 |
| E10 / 边缘 | 在同名标题下放置重复段落，用目录及源码定位最后一次出现。 | 不跳到首次出现的同名内容，滚动与光标一致。 |
| E11 / 边缘 | 在多层引用/列表边界使用 Enter、Backspace、Tab 与撤销。 | 缩进和层级符合操作，邻近表格和公式保持完整。 |
| E12 / 边缘 | 搜索重复的中文/emoji/公式文本，查找替换后立即输入并撤销。 | 替换范围准确，旧定位不抢光标，撤销恢复原文。 |

证据入口（待逐项映射）：[shell-features.cjs](D:/BuyKey/Typora-Editor-App/scripts/shell-features.cjs)；[reading-experience.cjs](D:/BuyKey/Typora-Editor-App/scripts/reading-experience.cjs)；[viewflow-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/viewflow-suite.cjs)；[markdown-locations.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/markdown-locations.test.cjs)。

## 表格结构

原笔记历史复杂表格、最新快照、窄表、宽表；IR/WYS；表头/中间/末行。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B05 / 基础 | 创建表格、填入文字，增加和删除一行/一列，再保存重开。 | 行列数和单元格内容符合操作，不退回原始 Markdown 表格。 |
| E13 / 边缘 | 在第一/末行及第一/末列执行增删，包含空单元格。 | 边界索引正确；存活单元格内容和可继续输入的光标正确。 |
| E14 / 边缘 | 对带 br 换行、转义竖线、链接、代码和公式的单元格做结构操作。 | 换行不暴露 HTML 源码；竖线不意外增加列，公式内容不丢失。 |
| E15 / 边缘 | 在宽表横向滚动到末列后打开菜单、改变列宽并撤销结构操作。 | 菜单作用于目标单元格；撤销恢复表形，源内容未串列。 |

证据入口（待逐项映射）：[math-table-matrix.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-table-matrix.cjs)；[desktop-table-context.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-table-context.cjs)；[desktop-table-input.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-table-input.cjs)。

## 表格内导航与粘贴

IR/WYS；表头、空格、换行、重复单元格、最后一格；隔离剪贴板测试留待桌面恢复。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B06 / 基础 | 用鼠标、Tab、Shift+Tab 和上下方向键移动，再在目标格输入。 | 焦点及输入留在目标格，已有表格结构保持正确。 |
| E16 / 边缘 | 在内容相同的多个单元格之间来回点击并反向选择文本。 | 按实际单元格身份定位，不误选相同文字的另一格。 |
| E17 / 边缘 | 粘贴含制表符、换行、Markdown 竖线和 Office 内容的片段，再撤销。 | 目标区域可预测，未选择的邻格不被改写，撤销完整。 |
| E18 / 边缘 | 在末格/空格/多行格连续执行导航、退格、删除及撤销重做。 | 无卡死、越界或丢格；必要的新行只创建一次。 |

证据入口（待逐项映射）：[math-table-matrix.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-table-matrix.cjs)；[desktop-table-input.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-table-input.cjs)；[desktop-media-office.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-media-office.cjs)。

## 数学快捷键往返

Ctrl+Shift+E；IR/WYS；正文、表格、引用和列表；空选区/完整/局部/反向选区。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B07 / 基础 | 选中普通内容，按 Ctrl+Shift+E 包裹，再按一次取消。 | 往返后的 Markdown 与基线一致，光标留在原内容处。 |
| E19 / 边缘 | 在已有公式、空公式和公式边界执行取消，再输入及退格。 | 移除对应定界符，不嵌套额外美元符号，不吞邻接文本。 |
| E20 / 边缘 | 输入分式、矩阵、竖线、转义美元、反引号和未完成 TeX，再取消。 | TeX 字符保存正确；未完成表达式可继续编辑，不触发 JS 异常。 |
| E21 / 边缘 | 对同一选区以快慢交替节奏执行至少 30 次快捷键，再撤销、重做、保存重开。 | 每次完整往返可逆，无延迟光标跳转、历史错乱或后续正文被包入。 |

证据入口（待逐项映射）：[math-table-matrix.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-table-matrix.cjs)；[math-boundaries.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-boundaries.cjs)；[math-history.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-history.cjs)；[math-markdown.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-markdown.test.cjs)。

## 嵌套格式中的数学预览

原 RN 导数段及无加粗、斜体、删除线、三重强调、链接变体；正文/表格；IR/WYS。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B08 / 基础 | 打开一条渲染公式并再次点击其预览，再点击普通文字。 | 只展开当前公式；离开后恢复渲染，正文未被编辑。 |
| E22 / 边缘 | 依次打开同一加粗行内的第一、第二、第三条公式，再回到第一条。 | 相邻公式持续渲染，不连带打开源码或出现黑色遮挡。 |
| E23 / 边缘 | 去掉加粗或替换为多层强调/链接，在段落及单元格重复预览点击。 | 修复不依赖加粗特征；各公式按自身焦点独立显示。 |
| E24 / 边缘 | 在公式之间的普通格式文本处点击并执行快捷键往返，切换明暗主题。 | 不会激活容器中第一条公式；其他公式的 TeX、可读颜色及显示状态不变。 |

证据入口（待逐项映射）：[nested-math-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/nested-math-suite.cjs)；[math-colors.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-colors.cjs)；[katex-source-map.test.cjs](D:/BuyKey/Typora-Editor/test/katex-source-map.test.cjs)。

## 公式与表格连续交互

原复杂表格及新快照；IR/WYS；普通格、空格、末行、相同公式多次出现。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B09 / 基础 | 在单元格插入公式并输入，再直接点击同一表格另一单元格。 | 离开该公式即收起源码与编辑预览，无须离开整个表格。 |
| E25 / 边缘 | 公式尚未输入完成时用 Tab、Shift+Tab、上下方向键和鼠标退出。 | 旧公式随实际焦点收起，目标格可继续输入，表格不退回源码。 |
| E26 / 边缘 | 在末行窄格输入长分式/矩阵，滚动并改变窗口宽度，然后点击另一格。 | 预览处于可见区域，不遮蔽后续行；定界符与焦点不脱离目标格。 |
| E27 / 边缘 | 在多格连续进行插入、输入、预览、取消、导航、撤销重做和保存，固定操作种子，至少 50 轮。 | 逐轮核对表形和未操作单元格；无随机丢格、源码回退、焦点漂移或 JS 异常。 |

证据入口（待逐项映射）：[math-table-matrix.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-table-matrix.cjs)；[desktop-table-input.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-table-input.cjs)；[desktop-user-file.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-user-file.cjs)。

## 源码与渲染位置对应

IR/WYS 到 SV 往返；重复文字、表格、行内/块公式、代码块、实体和内嵌图片。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B10 / 基础 | 在可见正文中定位光标，切入源码，再从源码定位回渲染侧。 | 位置对应同一字或相同语义边界，切换不修改正文。 |
| E28 / 边缘 | 从重复表格内容、公式内部、代码第二行和图片后的文字切换。 | 按源偏移定位到目标实例，不跳到同文首项或代码块开头。 |
| E29 / 边缘 | 把旧光标滚出屏幕后切换源码；再分别操作空格、空单元格和文档末尾。 | 采用当前阅读锚点或有效边界，不突然拉回旧光标。 |
| E30 / 边缘 | 定位后查找替换、中文输入、撤销、外部刷新及再次切换，测试延迟回调交错。 | 新编辑位置优先，过期锚点不把输入拉回行首或其他单元格。 |

证据入口（待逐项映射）：[split-navigation-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/split-navigation-suite.cjs)；[viewflow-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/viewflow-suite.cjs)；[chat-selection-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/chat-selection-suite.cjs)；[markdown-locations.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/markdown-locations.test.cjs)。

## 分屏、滚动和窗口布局

IR/WYS/SV；左右不同高度；IDE AI 侧栏打开/关闭；窄窗与宽窗。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B11 / 基础 | 拖动分隔条、双向滚动并重新进入分屏。 | 左右位置相符，比例被记住，拖动后内容重新排版。 |
| E31 / 边缘 | 快速改变 AI 侧栏宽度和主窗口尺寸，再恢复正常宽度。 | 最终比例稳定，无 ResizeObserver 循环错误及持续布局震荡。 |
| E32 / 边缘 | 拖动中切换模式或关闭文档；使用方向键、Shift+方向键和双击复位。 | 已退出模式不再收到宽度写入，控件行为和存储比例正确。 |
| E33 / 边缘 | 极窄窗口、末行长公式和大表格并存，交替滚动两边后停止操作。 | 列宽有界，预览可读，停止后没有互相驱动的滚动循环。 |

证据入口（待逐项映射）：[viewflow-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/viewflow-suite.cjs)；[viewflow-performance-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/viewflow-performance-suite.cjs)；[split-resize.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/split-resize.test.cjs)。

## IDE 原生 AI 选区与焦点

VS Code 和 Trae；IR/WYS/SV；仅加附件及编辑草稿，不提交消息。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B12 / 基础 | 选中正文或表格文本，Alt+U 后立即输入本轮唯一标记。 | 只添加一次正确文件范围，键入进入 AI 草稿，正文和磁盘不变。 |
| E34 / 边缘 | 用反向、重复单元格、跨段、数学和代码选区调用，再关闭侧栏后用无扫描码输入重开。 | 范围映射准确，草稿保留，焦点进入实际可编辑输入框。 |
| E35 / 边缘 | 制造重复范围消息、同步失败、超时、迟到/空消息、请求替换以及编辑版本改变。 | 失败被处理，重复消息不重复添加；陈旧范围不能加入，恢复后可以重试。 |
| E36 / 边缘 | 在异步同步、命令发现、添加附件各阶段切换/关闭编辑器；组合输入和长按 Alt+U。 | 不向已离开的文档发起操作，不抢回焦点，不产生未处理异常或重复附件。 |

证据入口（待逐项映射）：[native-focus-matrix.cjs](D:/BuyKey/Typora-Editor/test/native-focus-matrix.cjs)；[native-chat-platform.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/native-chat-platform.test.cjs)；[native-chat-renderer.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/native-chat-renderer.test.cjs)；[chat-selection-suite.cjs](D:/BuyKey/Typora-Editor-App/scripts/chat-selection-suite.cjs)。

## 补全与输入竞争

IR/WYS/SV；正文、表格、数学；使用本地模拟提供商，不请求真实 AI 服务。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B13 / 基础 | 输入、展示补全、接受及撤销，再保存。 | 补全只插入目标位置；接受和撤销不重复正文。 |
| E37 / 边缘 | 在请求未返回时编辑、移动光标、切模式或外部刷新。 | 旧补全不覆盖新状态，过期请求能够取消或安全丢弃。 |
| E38 / 边缘 | 在表格公式中触发补全，含美元、竖线、矩阵和未完成 TeX。 | 返回内容留在当前语法范围，定界符和表形不被破坏。 |
| E39 / 边缘 | 模拟超时、断开、畸形响应、超长内容和中文组合输入。 | 错误可恢复，组词不被打断，无持续请求、重复插入或凭据日志。 |

证据入口（待逐项映射）：[completion-platform.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/completion-platform.test.cjs)；[desktop-completion.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-completion.cjs)；[completion-core.test.cjs](D:/BuyKey/Typora-Editor/test/completion-core.test.cjs)；[completion-structure.test.cjs](D:/BuyKey/Typora-Editor/test/completion-structure.test.cjs)。

## 媒体、粘贴和导出

本地图片、内嵌图片、Office 公式；中文路径；HTML/PDF/Word 支持的导出入口。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B14 / 基础 | 插入图片和公式，保存重开，再分别导出受支持格式。 | 媒体和公式可见，导出文件打开后内容及资源完整。 |
| E40 / 边缘 | 粘贴含 Office 公式、特殊字符及图片的表格，撤销后再次粘贴。 | 公式转义/私用字符处理正确，不重复附加资源或破坏表格。 |
| E41 / 边缘 | 删除/撤销/移动带图片的内容，保存到新路径后重开。 | 仍被引用的资源不误删，相对路径有效，选区映射不受图片压缩偏移影响。 |
| E42 / 边缘 | 导出长表、跨页公式、宽代码和缺失资源；模拟资源读取失败。 | 失败可见且正文保留；成功导出无截断、遮挡及资源越界读取。 |

证据入口（待逐项映射）：[media-core.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/media-core.test.cjs)；[desktop-media-office.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-media-office.cjs)；[desktop-media-lifecycle.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-media-lifecycle.cjs)；[desktop-export.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-export.cjs)；[desktop-export-large.cjs](D:/BuyKey/Typora-Editor-App/scripts/desktop-export-large.cjs)；[export-assets.test.cjs](D:/BuyKey/Typora-Editor-App/scripts/export-assets.test.cjs)。

## 主题、字体和阅读

明亮、暗色、米色阅读背景；字体/字号；公式、代码、表格及阅读模式。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B15 / 基础 | 切换主题、字号和阅读模式，打开公式预览再返回编辑。 | 文字和公式清晰，编辑入口及焦点可用，正文不变。 |
| E43 / 边缘 | 在嵌套格式公式展开期间连续切换明暗和阅读背景。 | 没有黑块、透明到不可读的文字或相邻公式源码泄漏。 |
| E44 / 边缘 | 大字号、窄窗、长 TeX 和宽表组合，滚动并调整分屏。 | 控件及预览可访问，无遮盖导致的误点击或不可编辑区域。 |
| E45 / 边缘 | 隐藏/显示目录、进入/退出阅读模式、定位再继续中文输入。 | 旧视图状态不抢焦点，主题和宽度设置恢复正确。 |

证据入口（待逐项映射）：[math-colors.cjs](D:/BuyKey/Typora-Editor-App/scripts/math-colors.cjs)；[reading-experience.cjs](D:/BuyKey/Typora-Editor-App/scripts/reading-experience.cjs)；[ui-refinements.cjs](D:/BuyKey/Typora-Editor-App/scripts/ui-refinements.cjs)；[theme-compatibility-audit.cjs](D:/BuyKey/Typora-Editor-App/scripts/theme-compatibility-audit.cjs)。

## 性能、异常与私版产物

最终 EXE 与提取的 VSIX；共享源哈希；普通文件、接近/跨越 150000 与 900000 字符阈值。

| ID / 类型 | 操作 | 通过条件 |
|---|---|---|
| B16 / 基础 | 对普通笔记执行打开、编辑、分屏、保存及原生选区协作，记录耗时和异常。 | 关键路径可用，实际输入及预览正常；本轮捕获的未处理 JS 异常为零。 |
| E46 / 边缘 | 对基准的三种内容各跑 IR/WYS 两种定位状态；预热后重复七次，核对源偏移。 | 前后夹具哈希和锚点一致，报告映射耗时；不把局部耗时当作整机性能。 |
| E47 / 边缘 | 在大文件降级阈值上下切换、滚动、修改尾部并重建映射，连续操作后停留。 | 块/比例降级符合阈值，无重复全文解析或持续活动；输入、保存及目标位置正确。 |
| E48 / 边缘 | 源码全量通过后更新私版版本到 1.0.0，再打包并按最终 EXE/VSIX 重跑与人工复核。 | manifest、宿主和全部共享文件与验收源码一致；公版哈希不变；产物证据完整才交付。 |

证据入口（待逐项映射）：[release100-mapping-benchmark.cjs](D:/BuyKey/Typora-Editor-App/scripts/release100-mapping-benchmark.cjs)；[release100-quality-boundaries.cjs](D:/BuyKey/Typora-Editor-App/scripts/release100-quality-boundaries.cjs)；[run-release100-background.mjs](D:/BuyKey/Typora-Editor-App/scripts/run-release100-background.mjs)；[verify-release100-private.cjs](D:/BuyKey/Typora-Editor-App/scripts/verify-release100-private.cjs)。
