# 第 5 轮 VSIX 域 smoke 清单（B1/B2/B3/B5/B6/B7/B8）

改动源：`E:\MarkPilot\Typora-Editor\extension-src\`（源码树即发布内容，`pack.py` 直接打包，
无 tsc 编译链；`out/provider/markdownEditorProvider.js`、`render/js/vscode.js`、
`render/js/about.js`、`render/js/toolbar.js`、`render/js/media-clipboard.ps1`）。

## 0. 环境与准备

1. VS Code：`D:\Users\ltmroberthk\AppData\Local\Programs\Microsoft VS Code\Code.exe`（App Paths 注册名 `Code.exe`）。
2. 直接以开发模式挂载源码树（免打包）：
   ```
   "D:/Users/ltmroberthk/AppData/Local/Programs/Microsoft VS Code/Code.exe"
     --extensionDevelopmentPath=E:\MarkPilot\Typora-Editor\extension-src <某个一次性工作区>
   ```
   或 `python E:\MarkPilot\Typora-Editor\pack.py` 后安装 dist 里的 vsix 验证包体。
3. 素材一律从 `E:\MarkPilot\测试素材_每次使用需复制用后需删除试验副本\` 复制一次性副本，
   验收完删除副本，原件只读。
4. 自动回归（无人工步骤，先跑）：`node E:\MarkPilot\Typora-Editor\test\vscode-smoke.cjs
   "D:/Users/ltmroberthk/AppData/Local/Programs/Microsoft VS Code/Code.exe"`。
   本轮改动后基线：17 项 PASS（2026-10-02 实跑，两项判定见文末 §8：唯一红项经
   HEAD 基线对照确认为存量问题，非本轮引入）。

## 1. B1 复制/剪切图片（多图进系统剪贴板）

前置：文档内含 2 张以上本地图片 + 1 张内嵌（data:）图片。

1. Ctrl+点选 3 张图（含内嵌那张），按 Ctrl+C。
   - 期望：右下角 toast「已复制 3 张图片，可一次粘贴到微信、文档或网页。」（此前是报错
     「不支持的图片或表格操作」）。
2. 到资源管理器某临时目录按 Ctrl+V：期望 3 个图片文件落盘（CF_HDROP 主格式；内嵌图
   已物化到 globalStorage embedded-images 缓存再入列）。
3. 到 Word / 浏览器（DeepSeek 输入框）按 Ctrl+V：期望拿到竖排拼接位图（≤8 张时）。
4. Ctrl+点选 1 张，Ctrl+X：期望 toast「已剪切这张图片」，原文位置图片删除，粘贴到
   资源管理器仍是文件。
5. 右键选中图片 → 菜单「复制」：与 Ctrl+C 同通道同 toast。

证据：toast 截图 + 资源管理器粘贴结果截图。

## 2. B2 剪贴板读取（右键“粘贴”复活）

1. 在任意编辑器复制一段含中文与换行的文本。
2. MarkPilot 编辑器正文点一下放光标，右键 → 「粘贴」。
   - 期望：文本插入正文（此前三级降级全断，菜单是死键）。
   - 通道：execCommand('paste') 被拒 → `hostApi.invoke('clipboard-read-text')`
     （vscode.js 新 shim → provider host-invoke → `vscode.env.clipboard.readText`）。
3. 顺手验同一条 shim 的写通道：右键「复制为纯文本」、右键链接「复制链接地址」，
   到记事本 Ctrl+V 应得纯文本/URL。

证据：粘贴前后文档截图（文字保真、无乱码）。

## 3. B3 滚动恢复锚点 + 关文档清键

1. 打开**含多张图片**的长文档副本，滚到中下部（图片陆续加载完成后）。
2. 关闭该标签页，重新打开。
   - 期望：回到原阅读位置附近（锚点还原 + 图片占位后重贴；此前只有像素值，
     含图文档重开系统性偏上）。
3. 关闭该文档的全部标签（文档真正 close），再重新打开：期望回到顶部
   （`scrollTop_`/`scrollAnchor_` 键已随 onDidCloseTextDocument 删除，不再只增不减）。

证据：关前/重开后两张视口截图对比（同一小节出现在视口顶部）。

## 4. B5 文档相对链接（Ctrl+点）

文档副本同目录准备 `sub/目标.md`、`img.png`，正文写：

```
[跳子文档](sub/目标.md) · [看图](img.png) · [外链](https://github.com/ltmroberthk915/markpilot)
```

1. WYSIWYG：Ctrl+点「跳子文档」→ 期望用 MarkPilot 打开（默认编辑器，vscode.open）。
2. Ctrl+点「看图」→ 期望系统默认看图程序（openExternal file:，失败时退 VS Code 预览）。
3. Ctrl+点「外链」→ 系统浏览器。
4. 切 IR 模式重复 1（IR marker 走相对路径文本分支：join 文档目录）。
5. 指向不存在文件的相对链接 → 期望警告「链接目标不存在：…」（不再无声无息）。

证据：每次点击后的落点截图（新标签标题 / 看图窗口 / 浏览器）。

## 5. B6 表格回退与 PNG 转换

1. Windows：右键表格 → 复制表格 → Excel 粘贴，期望带格式（既有行为回归，不回归即红）。
2. copy-image 转 PNG：右键一张 **JPEG** 图 → 「复制图片」→ 分别到 Word 与画图粘贴。
   - 期望：两处都能粘贴成功；剪贴板含 PNG 格式（GDI+ 重编码）。
   - 校验命令（PowerShell）：
     ```powershell
     Add-Type -AssemblyName System.Windows.Forms
     [System.Windows.Forms.Clipboard]::GetDataObject().GetFormats()
     ```
     复制后立即执行，`PNG` 应出现在格式列表（此前 JPEG 只有 Bitmap/DIB）。
3. 非 win32 回退：静态口径（代码路径 `process.platform==='win32'?windowsClipboard:writeText`），
   mac/linux 实机可用时验证：复制表格 → 粘贴得 TSV 纯文本，不报
   「此宿主的 Office 图片剪贴板暂只支持 Windows」。

## 6. B7 关于/帮助弹窗外链

1. 工具栏 ⋮ → 「关于 MarkPilot」：期望显示「版本 2.2.16（VS Code 扩展）」
   （app-info 走 shim 读 extension.packageJSON，此前版本行整行不显示）。
2. 点弹窗里的 GitHub 仓库链接：期望**系统默认浏览器**打开仓库页
   （此前 webview 无 allow-popups，window.open 被拦，链接死链）。
3. 「帮助（GitHub 仓库）」同样验一次。

证据：浏览器打开后的地址栏截图。

## 7. B8 导出提示按宿主区分

1. VSIX：悬停工具栏导出图标，期望提示「导出 / Export（Word · Markdown，先选保存位置）」，
   点击后 QuickPick 只有 Word / 便携 Markdown 两项。
2. 对照（EXE 侧回归，非本文件改动面）：桌面版同位置提示仍为
   「PDF · Word · HTML · Markdown」。

证据：两宿主 tooltip 截图。

## 8. 回归边界与已知事项

- 全量自动 smoke 见 §0.4；2026-10-02 本机实跑：激活/资源加载/三种模式存盘/历史/
  外部保存刷新/CRLF/公式编辑 17 项 PASS。其中「nested formula exposes other
  sources」一项红：**已用干净 HEAD 基线（git worktree，无任何工作区改动）复现同一
  坐标同一失败**——判定为存量问题（数学交互域 math-edit.js / 或本机 VS Code 版本
  变化），与第 5 轮 VSIX 域改动无关，移交数学域跟进。工作树版与基线版该项行为
  一致，本轮改动无回归。
- B4（addThemeCss ！important 压主题规则）归主题工，本轮不动。
- B4 相邻的 `vscode.js` 宿主判定改动（__vscodeHost guard）系主题工并行提交，
  本文件的 hostApi shim 与其共存无冲突（各自独立分支）。
