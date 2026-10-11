# 1.0.3 / VSIX 0.1.10-local

## 用户可见变化

- **撤销的公式缓存**：IR 撤销与重做保留未修改正文块和已渲染 KaTeX 节点；同一修改块内源码相同的公式也可复用。历史仍只记录源码，不把数十万渲染节点复制进 50 步撤销记录。全局 TeX 定义变化时保留安全的重建路径。
- **查找替换**：Ctrl+F 查找，Ctrl+H 替换，也可用工具栏放大镜或桌面“编辑”菜单。支持区分大小写、Enter/Shift+Enter、F3/Shift+F3、单次/全部替换、空字符串删除和单步撤销。查找可覆盖可编辑公式源码与代码，排除生成的公式预览及重复的目录标签；按字面匹配，不提供正则模式。命中高亮最多绘制当前命中附近 800 处，计数和全部替换覆盖所有命中。
- **加粗及下划线**：正文粗体字重从 500 调整为 700；IR Ctrl+B 在加粗内部取消格式时保留嵌套强调与公式源码。Ctrl+U 设为下划线，可在快捷键设置中修改/停用；下划线保存为 `<u>…</u>`。默认水平分隔线取消 Ctrl+U 绑定，设置界面拒绝占用查找、保存、剪贴板和撤销等保留快捷键。
- **图片**：工具栏图片上传、图片粘贴走统一管线。每张图生成一次唯一文件名，保存成功才插入；支持多个文件、原图片格式、中文/空格/#/括号路径。图片保存在 Markdown 所在目录的 `images/<文档名>/` 子目录，文档使用相对链接，重开后可正常渲染。旧宿主 insertValue 消息也改为按 Markdown 插入。
- **Konayuki**：工具栏圆形明暗图标打开主题选择（默认浅色/深色、Konayuki Light/Dark）；原明暗切换按钮保留当前主题系列。桌面侧栏随主题同步，两端均保存主题选择。使用本机 Typora 目录中的原 CSS，按 [作者仓库](https://github.com/aerandirsf/Konayuki) 的 MIT 许可保留署名并适配 Vditor，未修改官方 Typora 文件。

## 性能边界与结果

完整教材只读测试：SHA-256 `576956e99093bd8d0e0f5195a14e55b2d097c0b23a0f72fa09f48a6ba981f3b3`。在教材前添加独立粗体测试段，在隔离窗口用真实 Ctrl+B / Ctrl+Z 复现。

一轮测得：撤销到同步检查约 **304 ms**；**5,631 / 5,631** 个已渲染正文公式节点保持连接，**新增公式渲染 0，队列待处理 0**，撤销后的 Markdown 与操作前完全一致。块复用阶段约 125 ms，保留 2,576 个正文块。完整数据见 `.perf/history-large.json`；这是该机器该测试场景的结果，不代表每类编辑均有相同延迟。

隐藏大纲中的 55 个公式副本不再后台排队，展开大纲时再渲染。文内 `[toc]` 在正文编辑与历史切换时复用已有节点，标题变化仍会更新。

查找按需创建 Worker，关闭查找栏立即终止；无空闲轮询。大教材查找“函数”得到 269 处，Worker 内匹配约 0.3 ms（不含主线程提取索引、绘制和 IPC）。本轮为单文档检索，没有建立跨文件全文索引。当前 Electron/Vditor 的 DOM 与历史问题在渲染层解决；没有引入 Rust、Tauri、Tantivy 或框架迁移，也没有重新压缩用户图片。

## 验证与构建

最终共 375 项检查通过：原编辑 16、一致性/IME 154、快捷键/Mermaid 66、本轮修复 58、桌面宿主 27、最近记录 2、KaTeX 21、实际 VSIX 的 VSCode 宿主 31。最终 ASAR 另重复通过 27 项桌面宿主检查。

实际桌面归档 451 个应用文件、两端 442 个渲染文件、VSIX 与已安装 VSCode 插件的 456 个扩展文件均通过字节/包元数据一致性核验。VSCode CLI 确认已安装 `seepine.md-editor@0.1.10-local`，已有窗口重载后生效。桌面安装包及便携包位于 `dist/` 根目录；完整解包程序位于 `dist/release-1.0.3-final/win-unpacked/`。

渲染回归包括原公式映射、中文 IME、三模式编辑/历史、快捷键、查找替换、粗体嵌套、下划线、目录复用和主题。桌面测试使用真实 iframe/IPC/文件保存及系统图片粘贴；VSCode 使用隔离配置、真实扩展宿主与可信按键。剪贴板测试使用有效 PNG 并恢复读取到的内容，另核对恢复后的文字。

VSIX 最低 VSCode 版本更新为 1.85，使用 CSS Custom Highlight API 绘制搜索命中与下划线；实际宿主测试为本机 VSCode 1.134。Mermaid 保持 11.6.0，既有核查见 `FEATURES-1.0.2.md`。

```powershell
npm run sync
npm run test:renderer
npm run test:state
node --test ../Typora-Editor/test/katex-source-map.test.cjs
node scripts/run-electron-test.mjs history-large
npm run dist -- --config.directories.output=dist/release-1.0.3-final
node scripts/run-electron-test.mjs shell dist/release-1.0.3-final/win-unpacked/resources/app.asar
```

插件目录执行 `python pack.py`；将实际 VSIX 解压后的 extension 目录交给 `test/vscode-smoke.cjs` 验证后安装。两端共用 `Typora-Editor/extension-src/render`，通过 `npm run sync` 同步，禁止单独修改桌面 renderer 副本。

修改前备份：桌面 `.backups/1.0.2-before-editor-repairs/`；插件 `tools/backups/0.1.9-before-editor-repairs/`。最终产物校验见 `release-1.0.3.json`。
