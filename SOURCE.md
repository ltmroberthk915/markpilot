# 源码说明（供二次开发 / 魔改）

这个仓库现在包含 **MarkPilot 的完整源码**。你可以直接 fork、改、重新打包发布。

## 仓库结构

| 目录 | 是什么 |
|---|---|
| `MarkPilot-CM6/` | **当前产品线**的 Electron 壳层：主进程、preload、导出 PDF / HTML、打包配置与图标钩子 |
| `dsh-markpilot/` | **当前产品线**的编辑器引擎源码。你日常要改的东西几乎都在 `src-cm6/` |
| `Typora-Editor-App/` | 更早的 2.x 产品线（VS Code 壳） |
| `Typora-Editor/` | 2.x 线的扩展源码 |
| `docs/`、`scripts/` | 文档与脚本 |

`dsh-markpilot/src-cm6/` 里的主要模块（改功能一般只用动这里）：

| 文件 | 负责 |
|---|---|
| `main.js` | 编辑器装配：CodeMirror 扩展、投影层（标题 / 代码块 / 行内公式 / 块公式 / **mermaid 图表**）、纵向导航、行样式 |
| `toolbar.js` | 工具栏与**行内格式包裹**（加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 引用前缀） |
| `extras.js` | 更多菜单、设置面板、导出（HTML / 文件夹 / PDF / 复制）、表格、大纲、快捷键设置 |
| `tables.js`、`lists.js`、`completion.js`、`typography.js`、`splitview.js` | 表格、列表续项、补全、中文排版、分栏 |
| `markdown-context.js` | 编辑、投影、按键与导出共用的引用／围栏上下文；普通编辑映射已有位置 |
| `async-markdown.js`、`markdown-worker.js`、`worker-tree-codec.js` | 大文档后台 Markdown 解析、带版本的增量文本镜像与原生语法树传输；敏感命令和故障回退使用 CM6 原生解析 |

## 特殊区域编辑协议（CM6 3.2.15）

图片、公式、代码、Mermaid 与表格的事实源仍是同一个 CM 文档和撤销历史。识别器提供精确字面区间，区域索引保存文档 epoch、稳定 ID、内容修订与上下文版本；编辑会话决定当前 owner，各类投影分别展示源码和预览。不要在投影里维护另一份可编辑文档或撤销栈。

| 模块 | 契约 |
|---|---|
| `region-index.js`、`region-session.js` | 归属、会话与共享失效集合；区间位移与内容变化分开处理，歧义或完整替换会退休旧区域 |
| `math-source-map.js`、`cell-source-map.js` 与图片字面区间 | 在文档 UTF-16 坐标与显示坐标之间映射；不能用解码后的 URL 或显示文本反查字面位置 |
| `command-context.js` | 命令捕获真实 owner、选区、文档和操作状态；异步完成时重新验证，按有效操作意图交还焦点 |
| `viewport-intent.js` | 展开时锚定预览，输入时照顾光标；新输入或新操作取代旧视口请求 |
| `render-lifecycle.js` | 区域渲染租约、相同内容任务合并、缓存与过期结果丢弃；节点销毁时清理所属资源 |
| `overlay-layout.js` | 浮层共用避让与命中几何，保留源码、光标、可交互控件及滚动条的可用空间 |

依赖顺序为识别器 → 区域索引 → 编辑会话 → 投影。源码与预览分别管理：图片编辑保留下方预览，公式使用编辑预览，代码与 Mermaid 使用适合其内容的投影。表格格子的原生选区同步到主文档，不额外制造历史项。

壳层另用操作序号、文档身份与 store 授权串联重载和另存为；验证须覆盖等待期间的新输入、新窗口/文档、取消以及旧结果晚到。watcher 的恢复提示有独立凭据，不能用全局关闭回调撤走另一操作的提示。

KaTeX 0.19.0 的受控源码映射构建、严格输入清单与可复现输出保留在 vendor 构建流程中。交互验收及故障注入入口见 `tools/quality/README.md`，本版证据与性能口径见 `docs/LOG-3.2.15.md`。

## 构建

需要 Node.js 与 npm。

```bash
# 1) 装依赖（引擎侧 esbuild 装在这里）
cd dsh-markpilot && npm install
cd ../MarkPilot-CM6 && npm install

# 2) 从源码构建（本仓库自带脚本）
cd ..
node build-from-source.cjs             # 构建引擎并同步到壳层
node build-from-source.cjs --package   # 再打出 Windows 安装包 + 便携版（输出 MarkPilot-CM6/dist/）

# 3) 开发态直接起
cd MarkPilot-CM6 && npm start
```

`build-from-source.cjs` 构建引擎（esbuild，含字体 loader）与独立的 Markdown Worker、打打印层排版包、
拷 mermaid 资产、可选打包。`MarkPilot-CM6/renderer/cm6/mermaid.min.js` 就是随源码提供的图表引擎，
**不需要联网下载**（离线可用）。

## 这份源码快照**不含**什么（都不是源码）

| 不含 | 原因 |
|---|---|
| `node_modules/` | 依赖安装产物，`npm install` 可复原 |
| `MarkPilot-CM6/dist/`、`Typora-Editor*/dist/` | 构建产物（安装包、解包目录） |
| 大体积开发期夹具、完整运行目录、profile 与中间构建 | 避免把用户数据和临时产物入库；可复跑探针与限额合成证据保留在 `tools/`、`docs/verification/` |
| `*.vsix`、`*.log` | 已打包扩展与日志 |

第三方组件与许可证保留在源码树内（例如 `*/renderer/cdn/vditor/dist/js/mermaid/mermaid.min.js`、
`*/renderer/cdn/vditor/dist/js/katex/`）。

## 二次开发时会用到的两样东西

- **`docs/VERIFICATION.md`** —— 验证手册：产品内置的测试挂点（环境变量、只读取证口）、
  探针怎么跑、以及**哪些取证方式不可信**。改一行代码之前先看它，能省掉很多来回。
- **`docs/verification/`** —— 历次改动的验收报告（判据怎么写的、实测读数是多少）。
  **`docs/DEBUG-DB.md`** 是总台账：每处改动的原因、判据、以及**走错的路**。
- **`tools/probes/`** —— 可复跑的探针脚本（真实键鼠输入，不合成事件）。
## 许可与使用

**程序、插件与全部源码完全免费**——个人用、商业用、改、二次分发、做成自己的编辑器，都可以，不需要另行授权。
二次分发时请保留原项目的名称与来源说明，并自行确认你所分发内容的合规性。

## 可重复的质量检查入口

`tools/quality/README.md` 提供固定依赖、真实输入验收、Windows 截图粘贴、性能基线和证据发布方法。先运行：

```bash
npm ci --prefix tools/quality --ignore-scripts --no-audit --no-fund
npm run preflight --prefix tools/quality
npm test --prefix tools/quality
```

引擎侧已补充测试用 NPM lock；无需覆盖仓库发布 bundle 即可比较重建身份：

```bash
npm ci --prefix dsh-markpilot --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node tools/quality/build-check.cjs --out .mp-verify/quality/build
```

3.2.5 的公开依赖重建与发布 bundle 有 SHA 差异，历史结果见 `docs/LOG-3.2.5-AUDIT.md`。当前源码的 `build-check` 同时比较引擎和 Worker 的完整 SHA，任一不同均以非零退出码报告。工具自测与产品交互是独立判据，后续修复验证见 `docs/LOG-3.2.7.md`。

截图粘贴、图片缩放与图片文件操作另有独立入口 `tools/quality/images.cjs`。它使用真实 Windows 位图剪贴板及键鼠输入，核对即时渲染、文件字节、文档归属和缩放尺寸；`image-mutate.cjs` 可在自己的临时源码副本中逐项关闭修复，检验测试是否确实能发现回退。使用方法见 `tools/quality/README.md`，3.2.8 的产物与测试记录见 `docs/LOG-3.2.8.md`。
