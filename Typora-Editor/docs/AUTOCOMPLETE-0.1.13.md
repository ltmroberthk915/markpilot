# 插件自动补全（0.1.13-local）

> 当前版本 0.1.18：在工具栏 **补全 ▾** 中一键切换 GLM、GLM Flash、DS Flash Vision Exp、DS Pro，各平台分别保存密钥。数学优先，输入或进入公式后停顿均可触发，结合公式两侧和附近说明，单次调用直接生成，并复用已有结果。详见 [0.1.18 更新说明](FEATURES-0.1.18.md) 和 [40 个缺口的模型对照报告](QUALITY-DP-MODELS-0.1.17.md)。下文保留 0.1.13 的最初实现记录。

本次只更新 VSIX。桌面程序没有同步、重打包或启用自动补全；桌面 Agent 仍是待讨论的方向。

## 使用入口

编辑器工具栏的 **补全**，或命令面板的 **Markdown Editor: 补全设置**。

| 操作 | 效果 |
| --- | --- |
| 输入 `/` | 表格、代码、Mermaid、公式、引用、任务等模板 |
| 输入 `\` | LaTeX 命令和常用矩阵、对齐环境 |
| 输入 `@` / `!` | 当前工作区文件链接 / 图片路径；同目录优先 |
| 输入 `#标题关键词` | 插入指向当前文档标题的链接 |
| `Ctrl+Space` | 手动请求本地和兼容的宿主候选 |
| `↑` / `↓`，`Tab` / `Enter` | 选择、接受候选 |
| `Alt+\` | 手动请求 AI 续写 |
| `Tab` / `Esc` | 接受 / 取消 AI 灰字预览 |

公式、模板和路径补全不需要账号。AI 默认关闭，配置 API 后启用手动请求；自动请求另有开关。输入法组词期间不请求补全，也不接管确认按键。

## 借用的智谱配置

在“配置自定义 API”中选择“智谱 GLM（预设）”，地址和模型已预填：

```json
{
  "protocol": "anthropic",
  "baseUrl": "https://open.bigmodel.cn/api/anthropic",
  "model": "glm-5.3-flash"
}
```

接着在宿主的密码输入框中填写 API Key。密钥通过 VS Code / Trae 的 `SecretStorage` 保存，不进入 Markdown、Webview、普通设置或 VSIX 包；两个 IDE 各自保存密钥。

实际请求地址是 `https://open.bigmodel.cn/api/anthropic/v1/messages`，使用 `x-api-key` 和 Anthropic Messages 格式。[智谱兼容接口文档](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)

`[1M]` 是 Claude Code 的上下文标记；Claude Code 自身也会在请求前去掉这个后缀。插件会同样去除末尾的 `[1m]` / `[1M]`，而不是把它当作模型 ID 的一部分。[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)

`glm-5.3-flash` 按用户提供的配置保留，并非从当前账号查得的可用模型。未提供密钥，因此真实账号的模型权限、配额和延迟需要在配置密钥后验证。模型 ID 可随时修改。也支持自定义 Anthropic Messages 或 Chat Completions 服务。

补全只发送光标附近最多 4000 个字符的前文和 1000 个字符的后文，输出最多 256 tokens；0.1.15 起超时为 15 秒，并显示等待和错误状态。智谱补全关闭深度思考。不会继承 Claude Code 的一小时超时、百万上下文、128K 输出、子代理、hooks 或其他 CLI 行为。连续输入会取消请求，旧响应不会覆盖新位置，也不会在空闲时反复轮询。

## 宿主补全能接入什么

插件调用 `vscode.executeCompletionItemProvider` 查询标准候选，并在自己的 Webview 菜单中展示。Markdown 源码位置必须精确匹配；在重复段落或无法证明范围正确时跳过宿主候选。带有额外文本修改、命令、复杂 snippet 转换或跨节点修改的候选暂不接受，避免修改错误位置。

灰字预览在编辑 DOM 外，接受前不改变文档、保存内容或撤销历史。接受后复用现有局部编辑与公式缓存。并未把 Copilot 或 Trae CUE 的私有灰字服务接进 Webview。

同时修复 Webview 桥接脚本和编辑器入口重复发送 `init` 的竞态：只在 `open` 监听注册后启动一次，避免同一页面出现两个编辑器实例及重复监听。

## VS Code / Trae 原本如何补全

**VS Code 的普通 IntelliSense** 由语言服务、扩展的 `CompletionItemProvider`、词语和片段等构成；语言服务常通过 LSP 工作，不一定使用 LLM。AI 灰字使用另一类 inline completion 接口。我们的 Custom Editor 内部是 Vditor Webview，不能直接显示 Monaco 的补全界面。[IntelliSense](https://code.visualstudio.com/docs/editing/intellisense)、[语言扩展接口](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)、[Custom Editor](https://code.visualstudio.com/api/extension-guides/custom-editors)

**Copilot** 的行内补全、下一处编辑预测和聊天是不同能力。聊天选择的模型不能直接等同于 Tab 补全模型。GitHub 曾明确发布 GPT-4.1 Copilot 专用补全模型，但那是 2025 年的发布记录，不能据此断言所有账号今天仍用它。具体可查看命令“GitHub Copilot: Change Completions Model”。[补全模型选择](https://docs.github.com/en/copilot/how-tos/use-ai-models/change-the-completion-model)、[2025 年发布记录](https://github.blog/changelog/2025-08-27-copilot-code-completion-now-uses-the-gpt-4-1-copilot-model/)

**Trae 的 CUE（Context Understanding Engine）** 会结合近期编辑、浏览位置、诊断和仓库上下文，提供补全、多行修改与下一处编辑预测。公开文档没有给出可对所有版本和账号成立的固定底层模型 ID；其聊天模型菜单也不能用来反推 CUE 的模型。目前未找到受官方支持、能让其他扩展直接调用 CUE 灰字的公开桥接接口。[CUE](https://docs.trae.cn/ide_cue)、[更新记录](https://docs.trae.cn/ide_changelog)

## 桌面 Agent 的讨论建议

后台直接调用第三方 API 是接入方式；是否属于 Agent，取决于是否允许模型循环调用工具完成多步任务。单纯续写、改写、解释选中文字可以先做“写作助手”，不需要 Agent。

如果希望它“阅读这一章、找相关定义、检查符号一致性、修改多个段落”，再加入 Agent 更合适：先支持选择范围内的文件读取、搜索、提出编辑建议和差异预览，用户接受后再应用。`glm-5.3-flash` 可作为补全/短任务候选，较大的 `glm-5.3` 可作为长任务候选；最终分工应通过实际教材任务测延迟、质量和费用后决定。后台 API 调用不需要引入 Rust；文件索引等确有性能瓶颈的模块再独立选择实现语言。

## 验证与维护

2026-09-06 验证结果：接口单元测试 8 项；VS Code 1.134.0 加载最终 VSIX 解包内容，64 项回归通过；本机 Trae（VS Code API 1.107.1）实际运行 27 项测试通过。两个 IDE 均已安装 0.1.13-local，重载窗口后使用。

15.6 万字符、2200 个公式的合成文档中，局部补全上下文准备在 VS Code 最终测试中为 0.2–0.9 ms（10 次采样），没有调用整篇 `getValue()`；这不是总体输入延迟或真实 LLM 响应时间。API 联调使用本机模拟服务，未验证真实智谱账号的模型权限和网络延迟。

完整结果及安装包校验记录见 [release-0.1.13.json](release-0.1.13.json)。

接口测试：`node test/completion-core.test.cjs`。

真实 IDE 测试：`node test/vscode-smoke.cjs "IDE.exe" "解包后的 extension 目录"`，使用独立用户配置、临时 Markdown 和本机模拟 API；不会读取用户密钥或向真实模型上传教材。结果保存在 `test/.runs/`。

构建时同时更新 `extension-src/package.json` 和 `vsix-meta/extension.vsixmanifest`，然后运行 `python pack.py`。本次不要在桌面仓库执行 `npm run sync`。
