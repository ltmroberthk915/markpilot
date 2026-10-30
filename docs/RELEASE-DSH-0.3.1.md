# dsh-markdown-typora 0.3.1

DSH 右侧栏的 Markdown 编辑器，内核是 MarkPilot CM6 3.6.6。

这个版本把插件名字定为 **dsh-markdown-typora**——「在 DSH 里，像 Typora 一样写 Markdown」。功能与上一版一致。

## 能做什么

- **即时渲染**：标题、列表、引用、表格、代码块、公式与 Mermaid 图表，写下来就是排版后的样子；光标进块看源码，离开回到渲染。
- **公式点哪改哪**：点渲染预览里的任意符号，源码光标落到生成它的那段 LaTeX。
- **选中文段，送进对话**：选一段 Markdown，点「插入对话」，源码直接落进当前会话的输入框。
- **保存带版本守卫**：磁盘上的新版本不会被旧缓冲覆盖，冲突会明确报错而不是盲写。
- **离线可用**：KaTeX、Mermaid、语法高亮 Worker 全部随包，不依赖网络。

## 安装

在 DSH 里装进当前 profile：

```bash
dsh plugin --profile web add dsh-markdown-typora-0.3.1.tgz
dsh plugin --profile desktop add dsh-markdown-typora-0.3.1.tgz
```

装完重启宿主，右侧栏打开 Markdown 文件即用。

从旧包名升上来的话，先移除旧包再装新包：

```bash
dsh plugin --profile web remove dsh-markdown
dsh plugin --profile web add dsh-markdown-typora-0.3.1.tgz
```

## 兼容性

- 文件地址协议（`dsh-resource://file/…`）不变，已打开的文件路径照常可用。
- 旧包名下的未保存草稿恢复槽不会自动迁移；升级前把未保存的内容存盘。
- 右侧栏标签类型随名字更新，重启后旧标签不会自动恢复，重新打开文件即可。

## 已知限制

- 插件只支持 DSH 0.2.1-rc 及以上版本的右侧栏契约。
- 大文档（15 万字以上）首次打开需要构建一次语法树，之后的输入与滚动不再受它影响。
