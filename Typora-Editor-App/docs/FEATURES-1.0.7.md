# 1.0.7：AI 补全与公式撤销编辑状态

桌面版移植插件 0.1.19-local 的补全能力和设置，复用同一份前端、上下文策略与 API 调用核心。

- 工具栏左侧“补全 ▾”内切换 GLM、GLM Flash、DS Flash Vision Exp、DS Pro；API 地址、模型、密钥和开关都收在下拉菜单内。
- 本地 LaTeX 命令、Markdown 模板、文件和图片路径补全；Ctrl+Space 手动显示候选，Tab/Enter 接受。
- AI 接收光标前后文、当前公式和邻近说明。Alt+\\ 手动请求，Tab 接受，Esc 取消；可开启输入停顿和进入公式后的自动建议。
- 保存两家平台各自的密钥，切换模型不必重新输入。桌面使用系统加密存储；密钥不进入普通设置、Markdown 或渲染页。首次安装默认关闭付费请求。
- 本机现有 VS Code 配置和两家密钥已通过原生 SecretStorage 迁移到桌面，保留 DS Pro 默认模型及 650 ms 基础等待时间。桌面没有 VS Code 的第三方 CompletionItemProvider，因此该宿主候选开关不显示；公式、模板、路径及 AI 能力均可用。
- 切换文件或模型、修改内容、最小化窗口时取消失效请求；同一上下文复用缓存。切换文件后，旧请求不会把结果插入新文件。

即时渲染及所见即所得模式中，公式编辑后 Ctrl+Z / Ctrl+Y 保留数学源码、光标及下方预览，可以直接继续输入。历史快照使用可编辑源码，避免把异步公式渲染记成内容修改；即时渲染仍复用未改变的公式节点。

100 次真实笔记实验全部使用 `deepseek-v4-flash-vision-exp`：70 个数学、30 个文字缺口，每处一次。请求到显示中位数 951 ms、P95 1679 ms（不含自动触发等待）。逐条语义审阅的原始直接可用数为 70/100；本地去重后同批响应离线重放为 72/100。69/70 条公式可渲染，但可渲染不代表数学含义正确。

详细实验设计、失败样本和后续优化空间见 [100 次实验报告](../../Typora-Editor/docs/autocomplete-harness-100.md)。此次没有增加第二轮模型调用；本地后处理去除明确的后文重复、重复句点和纯标点建议。

构建：`npm run sync && npm run dist`。`sync` 同时同步插件 renderer、completion host/core/profiles 和共享策略；不要手改 `app/renderer` 或 `app/shared` 副本。

产物：

- `dist/TyporaEditor-Setup-1.0.7.exe`
- `dist/TyporaEditor-v1.0.7-portable.exe`
- `dist/release-1.0.7-final/win-unpacked/TyporaEditor.exe`
- `../Typora-Editor/dist/seepine.md-editor-0.1.19-local.vsix`

验证记录及产物 SHA-256 见 `release-1.0.7.json`。

最终验证：插件单元检查 24 项；VS Code 与 Trae 各 57 项；桌面单元检查 40 项；公式撤销 8 类场景；最终 ASAR 补全链路 16 项、文件启动 22 项及编辑/保存/图片/查找/主题回归均通过。大文档撤销保留 5634/5634 个公式节点，额外重渲染 0 次。470 个应用文件与最终 ASAR 一致，451 个共享渲染文件及 4 个补全核心/策略文件与插件一致。两款 IDE 已安装 0.1.19-local，安装文件已逐一核验。

桌面安装包及便携版已生成，现有用户配置已迁移；运行新版即可使用。未改变 Windows 当前默认应用关联。
