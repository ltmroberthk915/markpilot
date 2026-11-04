# dsh-markdown-typora 0.3.12

DSH 右侧栏的 Markdown 编辑器，内核升级到 MarkPilot CM6 3.6.17。

## 这一版的变化

- **新增内置主题「宋韵 深蓝」**：恢复 MarkPilot V2 最后版本的宋体-暗配色——深蓝纸面 `#2E3440`、正文 `#C3C7CF`、主色 `#28AAF1`、引用 `#353C4A`、代码 `#232935`。工具栏「主题」里可直接选，现有「宋韵 深色」保持不变。
- **其余行为与 0.3.11 相同**：共享编辑、保存稳定性、多窗口协同、表格与跨笔记能力未改动。

## 安装

在 DSH 里装进当前 profile，装完重启宿主：

```bash
dsh plugin --profile web add dsh-markdown-typora@0.3.12
dsh plugin --profile desktop add dsh-markdown-typora@0.3.12
```

也可以从 [GitHub Release](https://github.com/ltmroberthk915/markpilot/releases) 下载 `dsh-markdown-typora-0.3.12.tgz` 安装；npm 包为 `dsh-markdown-typora@0.3.12`。

从 0.3.11 升级直接覆盖安装即可。

## 已知限制

与 0.3.11 相同：分屏源码视图不套用正文落点规则；引用绝对 Windows 路径或文件名含 `#`、`?`、`%` 时图片不显示；只读/被锁定/不可写磁盘上的文件保存会报错。
