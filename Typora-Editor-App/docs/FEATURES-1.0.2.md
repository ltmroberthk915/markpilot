# 1.0.2 / VSIX 0.1.9-local 功能与兼容性记录

## 快捷键

两端使用相同的 `render/js/edit-shortcuts.js`。在编辑区域捕获配置的组合键，再交给现有插入与历史管线；普通输入不进入组合键处理。

- `Ctrl+Shift+E`：插入两个美元符号并把光标放到中间；有选区时包裹选中文字，光标停在关闭符号前。
- `Ctrl+Shift+Q`：引用选中的段落。跨段选区先导出选中的源码，再一次性插入引用，保留选区外的内容与公式。
- `Ctrl+Shift+K`：单行使用行内代码，多行使用代码块。代码围栏长度避开选区中的反引号。

编辑器工具栏的键盘图标打开设置；桌面端还提供“编辑 → 快捷键设置”。支持重录组合键、停用、重复检查、恢复默认，关闭设置后恢复原选区。桌面端保存至 `state.json` 的 `editorShortcuts`，VSIX 保存至扩展全局状态并同步当前各文档。

## 桌面最近记录

文件与文件夹分别保存 50 项，重复路径最近打开的置顶，Windows 路径规范化并忽略大小写去重。旧记录数组自动迁移，重启后保留。

“文件 → 最近打开”、侧边栏按钮、欢迎页“查看全部”和 `Ctrl+Alt+O` 均可打开完整面板，支持按名称/路径搜索。重命名、删除会同步记录；打开失败或取消切换不会改变顺序。再次选择当前文件时保留尚未保存的内容。

记录查询不逐项访问磁盘，避免不存在或暂时离线的目录拖慢面板；失效路径在点击时提示无法打开。

## Mermaid 核查（2026-09-05）

本机两端捆绑 **Mermaid 11.6.0**，Vditor 的加载 URL 也明确指定 `v=11.6.0`。通过官方 npm `latest` 元数据和 [Mermaid 官方发布记录](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4011.17.2) 核实，最新稳定版为 **11.17.2**（2026-08-25 发布）。当前不是最新版。

实际检查结果：Vditor 的 Mermaid 流程图渲染成功，时序图解析成功；`venn-beta` 和 `treeView-beta` 解析失败。官方文档标明 [Venn 需要 11.12.3+](https://mermaid.js.org/syntax/venn.html)、[TreeView 需要 11.14.0+](https://mermaid.js.org/syntax/treeView.html)。因此不能声称兼容最新版的所有语法。本次需求为检查，未替换 Mermaid bundle。

## 验证与复现

共 302 项检查通过：原编辑回归 16 项、一致性与中文 IME 154 项、快捷键与 Mermaid 核查 66 项、桌面宿主 20 项、最近记录状态 2 项、KaTeX 21 项、VSCode 宿主 23 项。最终桌面归档另重复通过全部 20 项宿主检查。

归档内 436 个应用文件与源码一致，两端 427 个渲染文件逐字节一致。VSIX 已安装到本机 VSCode，441 个安装文件与源码一致（忽略安装器附加的包元数据）。版本、安装包路径与 SHA-256 见 [release-1.0.2.json](release-1.0.2.json)。

```powershell
npm run sync
npm run test:state
npm run test:renderer
node --test ../Typora-Editor/test/katex-source-map.test.cjs
npm run dist -- --config.directories.output=dist/release-1.0.2
node scripts/run-electron-test.mjs shell dist/release-1.0.2/win-unpacked/resources/app.asar
```

VSIX 打包：在 `../Typora-Editor` 执行 `python pack.py`。将 VSIX 解压后的 `extension` 目录作为第三个参数传给 `node test/vscode-smoke.cjs <Code.exe> <extension目录>`，验证实际包。此测试使用独立 VSCode 配置，Chromium 可信按键穿过真实 Webview 转发链路，覆盖三种模式的预设组合键、宿主保存与自定义组合键。

本轮使用 `dist/release-1.0.2/` 独立构建目录，安装包和便携包已复制到 `dist/` 根目录；完整解包程序位于 `dist/release-1.0.2/win-unpacked/`。

回归日志位于 `.perf/`，VSCode 测试日志位于插件项目 `test/.runs/`。桌面设置与最近面板的截图分别为 `.perf/shortcut-settings.png`、`.perf/recent-dialog.png`。测试仅写入隔离文档与配置。

修改前备份：桌面 `.backups/1.0.1-before-shortcuts/`；插件 `tools/backups/0.1.8-before-shortcuts/`。原 1.0.1 EXE 与 0.1.8-local VSIX 保留。
