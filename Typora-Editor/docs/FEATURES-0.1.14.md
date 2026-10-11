# 0.1.14-local：API 配置独立一行

VS Code 和 Trae 插件的格式工具栏下方新增 **AI API** 栏：

**AI API　地址：…　模型：…　填写 API Key　AI 状态**

- 点击地址、模型，各自直接打开对应的输入框。
- 点击“填写 API Key”，直接粘贴密钥并回车保存；无需逐层进入补全菜单。
- 密钥仍通过宿主 SecretStorage 保存，留空或取消不更改已保存密钥。
- 也可在命令面板运行“Markdown Editor: 填写 API Key”。
- 更改为不同服务地址时清除旧地址的密钥并关闭 AI，重新填写密钥后开启。

已安装到 VS Code 和 Trae，重载 IDE 窗口后显示新入口。桌面 EXE 本次未更新。

最终 VSIX 在 VS Code 1.134.0 中通过 67 项回归，含独立行布局、直接填写密钥、单独修改模型/地址及原有编辑功能。检查记录：`test/.runs/vscode-1788657914327/results.json`。

安装包：`dist/seepine.md-editor-0.1.14-local.vsix`。
