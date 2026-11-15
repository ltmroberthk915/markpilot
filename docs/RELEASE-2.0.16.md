# MarkPilot for DSH 2.0.16

在 DeepSeek Harness 里并排写 Markdown 和聊 AI 时，文档和对话现在有更多可用空间。

- 打开 Markdown 工作台后，会话标题、视图标签与常用操作在宽度允许时排在同一行，正文可以多显示几行。
- 从侧栏打开 Markdown 时保留当前对话。拖窄 AI 分栏时，输入框底部控件会先用满可用宽度，空间不足才换行，发送按钮保持靠右。
- 来回拖动分栏手柄时，收起的编辑工具栏固定在编辑区右侧，跨过折叠宽度也能保持稳定。

## 安装

在 DeepSeek Harness 插件市场搜索 **MarkPilot**，或在命令行安装指定版本。

```sh
dsh plugin --profile desktop add dsh-markdown-editor-typora@2.0.16
```

也可以下载本页的 `dsh-markdown-editor-typora-2.0.16.tgz`，用同一条命令将包名替换为下载文件的绝对路径。

支持 DeepSeek Harness 0.2.0-rc.2 及以上和 Node.js 20 及以上。编辑器内核为 MarkPilot CM6 3.6.24。插件和对应的编辑器源码均包含在本版本标签中。
