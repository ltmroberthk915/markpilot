# 魔改 seepine.md-editor：Typora 式数学渲染 + 回车修复（部署目标：仅 Trae）

## 背景结论（已核实）
- **安全**：本机 VS Code 与 Trae 中已安装的 seepine.md-editor-0.1.1 均为微软市场**合法版**（out/extension.js SHA-256 = 4a1a21dd…，不匹配 Open VSX 恶意克隆的 IoC 哈希 37c4d24e…；文件内无 beststats/.vsx-id 特征；~/.vsx-id 不存在，恶意 beacon 从未在本机激活）。下载目录里的 VSIX 实施时再验证一次，若命中恶意特征则改名隔离并改用已安装目录（已验证干净）为基线。
- **架构**：`out/` = 扩展宿主（明文 JS，很小）；`render/` = webview，内核为 Vditor v3.11.1（含作者定制）IR 即时渲染模式 + Lute 解析器 + KaTeX 0.16.9。三个问题全部出在 Vditor 层。

## 补丁策略：零接触混淆代码，全部落在明文文件
不动 `index.min.js` / `lute.min.js`（保留作者定制、可维护），补丁只写进扩展自有的明文文件 `render/index.js`、`render/index.css`：

1. **数学增量渲染（问题2）**：monkey-patch `katex.renderToString`——渲染失败时读取 KaTeX ParseError 的 position，对合法前缀递归渲染，剩余源码以红色内联显示（Typora 行为），彻底替代 "KaTeX parse error: Undefined control sequence…" 报错文本。无 position 的错误则整体红色显示源码。
2. **数学预览位置（问题1）**：CSS 覆盖 IR 行内数学节点 `.vditor-ir__preview` 的布局——编辑时渲染结果出现在源码**正下方、左对齐、宽度随内容**的浮动块（Typora 样式），而非现在的右侧同行。DOM 结构以测试台实测为准微调。
3. **标题行首回车（bug3）**：在 `render/index.js` 以捕获阶段 keydown 拦截 Enter——检测光标位于标题 `#` 标记之前时，手动在标题前插入空段（带 `<wbr>` 锚点）、光标置于空行，preventDefault 掉 vditor 原生（有 bug 的）处理，再派发 input 事件走 Lute 重解析 + undo 栈，实现 Typora 式"上方插空行、标题原样保留"。若拦截 shim 在实测中不稳，兜底方案为直接补丁 minified 的 Enter 处理器。

## 实施步骤
1. **基线**：从 `~/.trae/extensions/seepine.md-editor-0.1.1`（已验证干净）拷贝到 `D:\BuyKey\Typora-Editor\extension-src\`；同时验证下载的 VSIX，命中恶意特征则隔离改名。版本号改为 `0.1.2-local`。
2. **测试台**：建 `test/test.html` 直接加载本地 vditor dist（复刻 render/index.js 的 IR 配置），用浏览器复现 3 个问题并截图存证。
3. **逐项实现**上述 3 个补丁，浏览器中迭代验证至 Typora 行为（前后对照截图）。
4. **回归**：确认保存/getValue 输出的 .md 内容不变质，撤销重做、粘贴、大纲、图片粘贴等主流程不受 shim 影响。
5. **打包**：保留原 VSIX 的 manifest 结构，仅替换 `extension/` 内文件，产出 `dist/md-editor-0.1.2-local.vsix`。
6. **安装到 Trae**：优先 `trae --install-extension`，失败则手动投放 `~/.trae/extensions/` 并重启 Trae 验证。VS Code 中的 0.1.1 保持不动。

## 验收标准
- 输入 `$\Omega \Omeg$`：显示 Ω 后紧跟红色源码 `\Omeg`，不再出现 parse error 文本
- 编辑行内公式时，渲染预览浮动在源码正下方左对齐（Typora 式）
- `# 一、集合运算法则` 光标置于 `#` 前回车：上方出现空行、光标在空行、标题保持渲染；连续回车不会复制 `#` 或使标题失效
- 保存的 markdown 文件内容与编辑显示一致