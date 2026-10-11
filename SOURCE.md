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

`build-from-source.cjs` 做四件事：打引擎（esbuild，含字体 loader）、打打印层排版包、
拷 mermaid 资产、可选打包。`MarkPilot-CM6/renderer/cm6/mermaid.min.js` 就是随源码提供的图表引擎，
**不需要联网下载**（离线可用）。

## 这份源码快照**不含**什么（都不是源码）

| 不含 | 原因 |
|---|---|
| `node_modules/` | 依赖安装产物，`npm install` 可复原 |
| `MarkPilot-CM6/dist/`、`Typora-Editor*/dist/` | 构建产物（安装包、解包目录） |
| 开发期的探针 / 夹具 / 截图 / 历次运行产物 | 属于内部验证脚手架，对二次开发没有价值（它也是本仓库曾经达到 2.5 GB 的原因） |
| `*.vsix`、`*.log` | 已打包扩展与日志 |

第三方组件与许可证保留在源码树内（例如 `*/renderer/cdn/vditor/dist/js/mermaid/mermaid.min.js`、
`*/renderer/cdn/vditor/dist/js/katex/`）。

## 许可与使用

程序与插件本体免费；**源码在此公开，欢迎全量魔改**。二次分发时请保留原项目的名称与来源说明，
并自行确认你所分发内容的合规性。
