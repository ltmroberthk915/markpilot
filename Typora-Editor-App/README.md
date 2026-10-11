# MarkPilot（中文名：万可百律；个人版 EXE）

复用 VSCode / Trae 插件 `markpilot.markpilot`（0.1.25-local）的渲染器，封装为独立 Windows 桌面应用，提供目录浏览、文件管理和最近记录。

**编辑器前端与插件字节级一致**：`app/renderer/` 是 `E:\MarkPilot\Typora-Editor\extension-src\render\` 的只读同步副本，永不手改。全部外壳代码（Electron 主进程、preload、shell）在本项目内。

## 成品

- 安装包：`dist/markpilot-Setup-1.0.15.exe`（约 111MiB，中文向导，可选目录，桌面/开始菜单快捷方式，注册 .md「打开方式」，带卸载程序）
- 单文件便携版：`dist/markpilot-v1.0.15-portable.exe`（约 111MiB，双击即用，无需安装）
- 也可直接传文件参数：`markpilot.exe D:\notes\a.md`（单实例：重复启动会聚焦已有窗口并打开该文件）

## 功能

1.0.15 收尾图片与 Office 能力：内嵌图片容错打开、另存为自动内嵌相对路径图片、右键图片 5–400% 显示缩放（源码原位替换、无重复、可撤销重做）、Word/Excel/PPT 原像素迁移（原生验证 8/8）、可编辑公式 DOCX 导出（无 Pandoc）与 VS Code / Trae 真宿主 105 项全绿，详见 [1.0.15 说明](docs/FEATURES-1.0.15.md)。Pandoc 同条件 DOCX/HTML 对照数据也已记录；严格 PDF 因原始 Markdown 的历史 LaTeX 语法错误未完成，不宣称 PDF 速度结论。

同时提供 [Jinxi 公开版](docs/PUBLIC-RELEASE-1.0.15.md)：与自用版并行、独立安装标识，移除本项目部署的个人远程补全 API、密钥存储和模型配置，仅保留本地/宿主补全。构建命令为 `npm run dist:public`，公开版产物位于 `dist/public-release-1.0.15/`。

1.0.13 修复浅色阅读配色下的公式源码黑框和下方预览黑框，详见 [修复与验证](docs/FEATURES-1.0.13.md)。

1.0.12 与插件同步加入本地标题索引辅助 AI 补全、独立阅读调色盘、展开大纲时固定工具栏。章节上下文可在补全菜单关闭；调色盘图标在主题图标旁。实测成本与 Typora 社区 CSS 的适配评估见 [1.0.12 说明](docs/FEATURES-1.0.12.md)。

1.0.7 加入与插件共用的 AI 补全、四模型切换和系统加密密钥存储；公式撤销后保留源码编辑和下方预览。见 [1.0.7 说明](docs/FEATURES-1.0.7.md)。

1.0.6 修复从资源管理器打开 Markdown 时只显示目录的问题，增加“文件 → 打开文件所在文件夹 / 复制绝对路径”，文件树右键菜单也提供相同操作。更新内容与实际 EXE 验证见 [1.0.6 说明](docs/FEATURES-1.0.6.md)。

- **编辑器**：与 Trae 插件完全一致 —— Vditor 3.11.1 IR 即时渲染、Typora 式数学公式（增量渲染 + 点击预览定位源码）、三种编辑模式、暗色/明亮、大纲、完整工具栏（0.1.7）、撤销重做、Ctrl+滚轮缩放、粘贴图片默认内嵌为 data URI（另存为时兼容相对路径图片）
- **侧边栏（新增）**：打开文件夹后的目录树（懒加载、记住展开状态、递归监视自动刷新）、只看 Markdown 开关、展开/收起全部
- **文件管理（新增）**：新建 .md / 新建文件夹 / 重命名（F2）/ 删除到回收站（Delete）/ 在资源管理器中显示 / 复制路径 / 非 md 文件双击用系统程序打开
- **其他**：Ctrl+S 保存（未保存关闭有确认框）、外部修改自动重载、每文件滚动位置记忆、窗口大小位置记忆、最近文件夹/文件、拖放文件/文件夹进窗口打开、欢迎页、系统明暗主题跟随
- **状态栏（新增）**：字数（Typora 规则：中文逐字、英文按词）、字符数（不含空白）、行数、阅读时间、保存状态 —— 主进程计算，30 万字符文档开销 ~5ms

## 1.0.2 快捷键与最近记录

| 预设快捷键 | 操作 |
| --- | --- |
| Ctrl+Shift+E | 插入 `$$` 并把光标放在中间；有选区时变为 `$选中文字$` |
| Ctrl+Shift+Q | 将选中段落转为 `>` 引用，支持跨段和多行 |
| Ctrl+Shift+K | 单行选区转行内代码，多行选区转围栏代码块 |

点击编辑器工具栏的键盘图标，或桌面菜单“编辑 → 快捷键设置”，可录入新组合键、停用某项及恢复默认。设置跨文件保存，三个操作覆盖即时渲染、所见即所得和源码模式。

菜单“文件 → 最近打开”、侧边栏“最近打开”按钮和 `Ctrl+Alt+O` 打开完整记录面板。文件、文件夹分别保留 50 个，支持搜索，重复路径按最近打开顺序置顶；Windows 路径忽略大小写去重。

当前内置 **Mermaid 11.17.2**；流程图、时序图及 Venn、TreeView 已通过渲染验证。

## 大文档性能（1.0.1 起）

1.0.1 加入公式分片与合批写入、源码快照缓存、局部 Markdown 转换和大纲缓存。同份 12 万字教材的对照测试：刚打开时首次输入的整条响应链从 16.5s 降到 209ms，全部公式完成后的输入到下一帧约 77ms；同一套测试累计渲染进程 CPU 时间降低约 57.5%。

首次缓存建立使初始化由 2.58s 增至 3.56s，公式全部完成的检查时点由 45.8s 降至 25.7s。当前保留完整 DOM，稳态滚动约 56fps。测试口径、原始数据和 200 项回归结果见 [docs/PERF-RESULTS-2026-09-05.md](docs/PERF-RESULTS-2026-09-05.md)。

## 开发

```bash
npm install            # 首次（Electron 二进制走 npmmirror，见 .npmrc）
npm run sync           # 重新同步插件 render 目录到 app/renderer（插件升级后执行）
npm start              # 开发运行（可带文件参数）
node scripts/smoke.mjs # CDP 回归测试（需以 --remote-debugging-port=9222 启动）
npm run test:renderer # 隔离配置与测试文件：编辑回归、一致性、真实保存链路
npm run test:state    # 最近记录的上限、去重、迁移、持久化与路径更新
npm run test:launch   # 文件关联启动、单实例转交、会话恢复及路径菜单
npm run test:media    # 内嵌图片/缩放/Office 迁移：单元 + 真实生命周期 + media-office 套件
npm run bench:renderer # 同教材性能基准，输出到 .perf/optimized.json
npm run dist           # 打包 dist/markpilot-Setup-*.exe（安装包）+ markpilot-v*-portable.exe（便携版）
```

## 插件升级流程

GPT 修改 `E:\MarkPilot\Typora-Editor\extension-src\render\` 后：

```bash
npm run sync && npm run dist
```

同步脚本（`scripts/sync-renderer.mjs`）只读取源目录，不会写入 Typora-Editor 项目任何文件。

## 架构

```
app/main/main.js    窗口/菜单/单实例/IPC/伪 vscode-cdn 域重定向
app/main/server.js  本地 HTTP 服务（127.0.0.1 固定端口 48190 起）：
                    /render/* 服务编辑器资源；/doc/<路径> 动态生成编辑器页
                    （等价扩展 buildPath）；/ws/* 服务 md 同目录图片
app/main/doc.js     文档控制器：复刻扩展宿主消息协议
                    init/open/change/img/openLink/scroll/reload/setValue/insertValue
app/main/tree.js    目录树枚举/管理/递归监视
app/preload/        伪造 acquireVsCodeApi（renderer 的 js/vscode.js 原样可用）
app/shell/          侧边栏 + iframe 外壳（全部新代码）
app/renderer/       插件 render 的同步副本（永不手改）
```

编辑器页跑在 iframe 里，经 preload 暴露的假 `acquireVsCodeApi` 与主进程通信 —— GPT 的代码无需任何修改即可在 EXE 中运行。

## 数据位置

状态（最近打开、滚动位置、窗口记忆）存于 `%APPDATA%\markpilot\state.json`；首次升级会尝试迁移旧版 `%APPDATA%\TyporaEditor\state.json`。
