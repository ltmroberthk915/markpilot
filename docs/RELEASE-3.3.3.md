# MarkPilot 3.3.3

这次更新改善公式、表格和图片笔记的连续编辑与保存。

- 高的行内公式展开为源码时，保留相邻文字的高度和基线，减少单行源码造成的间距抖动；源码实际换行按内容重排。
- 独立块公式的两个 `$$` 围栏显示在源码首尾行，减少额外空行；上下往返后能回到原正文列。原文件的换行、选区和撤销历史仍保留。
- 表格编辑保留原单元格的高度，源码按当前缩放比例排版；长文字可以撑高单元格，撤销或删除后正常缩回。点击按实际文字位置落光标，格内滚轮继续滚动正文。高缩放下，输入长文字后也能保持光标可见。
- 图片地址含尖括号、空格或 HTML 实体时，HTML 导出正确保留图片；代码中的图片示例保持字面内容。
- 跨目录另存为时，已有的相对路径图片先复制到对应位置，再提交 Markdown。已有不同内容的同名图片会阻止这次另存为，避免覆盖。

手动保存、自动保存间隔、多文档独立窗口和公式预览设置继续保留。公式预览避让上限仍为 67.2 px，横向滚动条仍为 3px。

## 下载

- [Windows 安装版](https://github.com/ltmroberthk915/markpilot/releases/download/v3.3.3/markpilot-Setup-3.3.3.exe)
- [Windows 便携版](https://github.com/ltmroberthk915/markpilot/releases/download/v3.3.3/markpilot-3.3.3-portable.exe)
- [SHA-256 校验文件](https://github.com/ltmroberthk915/markpilot/releases/download/v3.3.3/SHA256SUMS.txt)

安装版可升级现有 MarkPilot V3 并保留个人设置。
