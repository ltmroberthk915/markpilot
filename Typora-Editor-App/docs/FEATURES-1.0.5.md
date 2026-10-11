# 1.0.5 / VSIX 0.1.12-local

2026-09-06，针对桌面《动态规划教材.md》的矩阵和大片红色源码问题。

## 已验证的原因

Lute 对块公式闭合符号的要求与部分 Typora 文档写法不同。原始讲义中存在 `> $$公式$$,`：结束的两个 dollar 后有逗号，Lute 会把它视为尚未闭合，后续中文段落和行内公式进入同一个数学块。KaTeX 在数学模式中遇到这些 dollar 报错，渐进预览把无法解析的尾部显示为红色源码。

最小复现：`> $$a+b$$,` 后再写 `> 正文 $x$`，原始 Lute 的公式源码为 `a+b$$,\n正文 $x$`。补丁将闭合 fence 与正文分行，解析后的块公式只有 `a+b`，正文和 `$x$` 单独显示。

检查时，桌面文档第 1034 行的矩阵已有另外两类源码变化：早期讲义中的五个 `\\` 行分隔符只剩单个 `\`；两个 underbrace 的下标 `_` 缺失。这些符号缺失的具体发生环节无法仅从当前文件确定。早期稿件位于 `C:/Users/Ming/Desktop/随机动态规划草稿/动态规划新讲(三) 连续动态规划.md:189`。

文档第 954 行还有一个当前 KaTeX 不支持的 `\array` 命令。这里仅包含单行表达式，因此副本去掉该命令并保留原分组和表达式。

## 修复

新增 `render/js/math-markdown.js`，在 Vditor 异步加载 Lute 前安装 Markdown 兼容处理，覆盖初次打开、插入 Markdown、setValue、模式切换和预览。遇到闭合 `$$` 后带正文/标点的情况，将公式、闭合 fence 和后文分行；支持引用、嵌套引用、列表和多行公式，保留 TeX 的反斜杠和下标。

普通规范公式、代码块、行内代码、缩进代码、HTML 和注释不变。源码模式的原始文本、DOM 到 Markdown 的转换、撤销序列化及逐键 SpinVditorIRDOM 路径仍走原方法，未引入逐键全文扫描。

桌面生成 `C:/Users/Ming/Desktop/动态规划教材（渲染修复副本）.md`，仅改两行：对照早期稿恢复矩阵；移除单行式中的不支持命令。没有覆盖原文件。原件在生成副本至核验时保持 SHA-256 `04d72d08a2ab7c2c1ec8fee64c1cdeb9885fa3053b4a735408c8f13282ba0087`。

副本共 2,844 个公式源码节点，2,844 个预览完成渲染，错误尾部为 0。原文有意设置的 `\color{red}` 按公式内容显示。此结果验证解析与渲染，没有审订教材的数学推导。

审计快照与两行差异：`.perf/dynamic-planning/original-at-repair.md`、`repaired.md`、`document-repairs.json`。实际渲染截图：`.perf/dynamic-planning/matrix-fixed.png`。

## 验证与产物

451 项检查通过，包括新增 23 项边界/保护测试、8 项实际渲染测试；真实 VSCode 的 39 项检查覆盖 VSIX 初始打开带矩阵与尾随标点的文件。桌面 30 项检查包含真实文件打开、原生编辑及磁盘保存后的反斜杠/下标验证。最终 ASAR 另通过相同 30 项宿主检查。本轮桌面测试使用 `MD_EDITOR_TEST_SKIP_CLIPBOARD=1`，未重新写入系统剪贴板。

另一个大教材的撤销复测：本轮 5,634 / 5,634 个已渲染公式保持连接，新增渲染 0，待处理 0，Markdown 与撤销前一致；单次同步检查约 329 ms。该时间不是多轮性能比较。具体结果见 `release-1.0.5.json`。

445 个共用渲染文件、454 个应用文件及 459 个扩展文件均完成源码、归档和实际安装的一致性核验。VSCode CLI 已确认 `seepine.md-editor@0.1.12-local`；已有窗口重载后生效。

- 桌面安装包：`dist/TyporaEditor-Setup-1.0.5.exe`
- 便携版：`dist/TyporaEditor-v1.0.5-portable.exe`
- VSIX：`../Typora-Editor/dist/seepine.md-editor-0.1.12-local.vsix`
- 最终 ASAR：`dist/release-1.0.5-final/win-unpacked/resources/app.asar`

尺寸和 SHA-256 记录于 `release-1.0.5.json`。桌面程序需运行安装包更新；本次没有自动覆盖正在运行的个人版应用。
