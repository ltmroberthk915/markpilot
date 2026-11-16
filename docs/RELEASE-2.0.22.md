# MarkPilot for DSH 2.0.22

表格里同时有文字和公式时，点哪一条公式就只有那一条展开成源码，其余保持排版；点旁边的文字不会再让整格的公式一起露出来。

- **点公式落到那个字符**。在已排版的公式上点某个字符，光标落到它在源码中的对应位置，和正文点公式一致。在公式前面增删文字后依然准确，两个内容相同的公式也各自独立。
- **中文输入法换格不断字**。一格词还没上屏时直接点另一格，这段中文会先落到原来那一格，随后在新格里可以继续输入。若文档结构在这期间变化，这次换格会放弃而不是写错位置。
- **复制剪切给源码**。选区里有公式时，复制和剪切给出 Markdown 原文，可在粘贴处继续编辑；剪切失败不会删掉内容。
- 普通表格格保持轻快：不含公式的格每次输入只读一次文本。

在 DSH 的插件市场搜索 `MarkPilot`，或运行 `dsh plugin --profile desktop add dsh-markdown-editor-typora@2.0.22`。打开 DSH 后，点左侧 **Markdown** 进入编辑器。

[下载插件安装包](https://github.com/ltmroberthk915/markpilot/releases/download/dsh-markdown-editor-typora-v2.0.22/dsh-markdown-editor-typora-2.0.22.tgz) · [查看 npm 版本](https://www.npmjs.com/package/dsh-markdown-editor-typora/v/2.0.22)
