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

3.2.5 的公开依赖重建与发布 bundle 仍有 SHA 差异；`build-check` 会以非零退出码报告这种差异。工具自测通过与产品交互通过是两种判据。详见 `docs/LOG-3.2.5-AUDIT.md`，其中的产品失败项尚未修复。
