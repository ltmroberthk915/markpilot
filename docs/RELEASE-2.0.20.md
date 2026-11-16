# MarkPilot for DSH 2.0.20

在 Markdown 文档里用四个反引号包住一段 `markdown` 示例，光标移出后，里面的 Mermaid 流程图、表格和公式会直接显示在正文里。点回预览，或用方向键移入，就能接着改源码。保存时保留原来的围栏和缩进。`md` 也支持这一交互。

- 在新对话里选中文字，按 Ctrl/Cmd+Shift+Enter 即可把引用放进对话草稿。在「修改此处」写好要求后，点「提交给对话」就能直接发送这次修改。
- 切换「编辑器居中」时，已打开的文档会随之调整。审阅 AI 修改时，差异面板使用深色磨砂背景和浅色文字，浅色主题下也能看清。
- 在带有求和符号的公式里，点击 ∑ 可回到对应的 `\sum` 命令，光标紧贴字母 s。

## 安装

在 DSH 插件市场搜索 **MarkPilot**，或安装指定版本。

```sh
dsh plugin --profile desktop add dsh-markdown-editor-typora@2.0.20
```

也可以下载本页的 `dsh-markdown-editor-typora-2.0.20.tgz`，把命令里的包名替换为下载文件的绝对路径。支持 DeepSeek Harness 0.2.0-rc.2 及以上、Node.js 20 及以上。

