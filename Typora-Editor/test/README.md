# 编辑回归验证

在项目根目录运行 `python test/serve.py`，打开
[本地测试页](http://127.0.0.1:8766/test/index.html)，展开左下角“编辑回归测试”，点击“运行回归测试”。

测试页加载 `extension-src/render` 中的实际编辑器及 Webview 桥接脚本，仅将宿主消息替换为本地记录。
自动测试覆盖标题标记/正文边界、不同标题等级、公式快照、立即撤销、宿主 historyUndo/historyRedo、原生 cut 事件、编辑快捷键的宿主转发隔离、左右移动及 Shift 选区，以及公式预览定位、透明布局层命中、复制和编辑后的映射更新。剪切测试分别检查剪贴板内容、准确删除、单步撤销和只读预览；取消或未产生 cut 事件时不能在定时器里删除选区。

浏览器原生输入还需按以下步骤验证（合成键盘事件不会执行浏览器默认编辑行为）：

1. 点击已渲染公式，再点击灰底源码的中间，确认光标能按点击位置插入。
2. 点击“光标放在公式尾部 $ 前”，持续按左键，再持续按右键；光标应逐字符移动且不进入浮动预览。
3. 在公式源码内部输入、退格、撤销和重做；在公式之前的正文处退格，应删除正文字符。
4. 在标题和正文中输入、回车、退格，再 Ctrl+Z、Ctrl+Y；所有行内及块级公式都应保留源码和显示。
5. 使用“切换 200% 缩放”和工具栏明暗主题按钮重复鼠标及光标检查。
6. 点击“光标放在 # 前”后连续回车，光标应跟随标题逐行下移并保持在 `#` 左侧；撤销和重做后落点应一致。
7. 点击“加载公式定位用例”，再点击公式使其展开。单击预览中的分子 `a`、分母 `b`、第二个 `a`、`Ω`、根号、指数及分数线，源码光标应分别定位；`Ω` 定位到 `Omega` 首字母，分数线定位到 `frac` 首字母。
8. 拖选预览中的文字并复制，确认剪贴板只包含所选文字；退格、删除或输入不能直接改动预览。之后单击预览可继续定位源码。
9. 分别在正文和公式源码中选择一段文字后按 Ctrl+X：剪贴板内容应正确、选区只删除一次，并可由一次 Ctrl+Z 完整恢复。在即时渲染、所见即所得和分屏预览三种模式各重复一次；再检查 Ctrl+C 不修改正文、Ctrl+V 只粘贴一次、Ctrl+A 只选择编辑内容。
10. 在 Trae 的侧栏输入框中检查 Ctrl+A/C 仍作用于该输入框；返回 Markdown 后 Ctrl+S 仍正常保存。用右 Ctrl+X、Ctrl+Shift+Z 检查公式源码的剪切和重做。

执行 `node --test test/katex-source-map.test.cjs` 检查 KaTeX 的源码位置、重复字符、宏展开，以及关闭映射时的上游输出一致性和启用后的布局指标。
KaTeX 使用仓库内的 0.16.9 版本；`python tools/patch_katex_source_map.py` 可从 `orig-render` 重新生成修改后的 bundle，脚本校验上游哈希并拒绝覆盖未知修改。更新 KaTeX 时需重新核对补丁锚点和上述测试。

在 VSCode / Trae 中安装 `dist/marcopilot-0.1.25-local.vsix` 后执行“开发人员: 重新加载窗口”，重复上述原生输入检查。
打包命令为 `python pack.py`。此仓库是已编译扩展的可维护副本，缺少原 TypeScript 源码；不使用 package.json 遗留的 compile/test 脚本。

## VSCode 宿主与性能优化验证

`node test/vscode-smoke.cjs "D:/Program Files/Microsoft VS Code/Code.exe"` 使用独立配置目录和临时 Markdown 文件运行真实扩展宿主，加载实际 Webview 的资源及消息桥。它检查优化模块、KaTeX / mhchem 加载、三种模式输入到 TextDocument 的同步与磁盘保存、历史事件及外部修改后缓存更新。输入通过 Webview 的浏览器 `insertText` 命令，历史通过 `beforeinput` 事件；不等同于系统快捷键实测。

第三个命令行参数可指定从 VSIX 解压得到的 `extension` 目录，用于验证最终包。0.1.9 起还通过仅绑定本机的 Chromium 调试接口发送可信组合键，检查三种模式的 Ctrl+Shift+E/Q/K、自定义 Ctrl+Alt+M 及设置持久化。测试配置、文档和结果都写到 `test/.runs/`，不写入实际用户配置或教材，测试结束自动关闭测试窗口。

性能实现位于 `extension-src/render/js/math-scheduler.js`、`incremental-ir.js` 和 `typora-patches.js`，与相邻 `Typora-Editor-App/app/renderer` 保持逐字节一致。共用渲染器的一致性、中文 IME、队列调度及原生输入测试可在 `../Typora-Editor-App` 运行 `npm run test:renderer`；12 万字基准用 `npm run bench:renderer`。具体数据与边界见 `../Typora-Editor-App/docs/PERF-RESULTS-2026-09-05.md`，其中 CPU 指标来自独立 Electron 进程。
