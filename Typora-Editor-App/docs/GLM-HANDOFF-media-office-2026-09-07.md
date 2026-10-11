# GLM 接手：保存失败、图片随文档迁移、图片缩放、Office 导出

交接时间：2026-09-07。用户因剩余 token 不足，明确要求立即收尾，余下工作交给 GLM。本文件描述当前磁盘状态，不代表已发布。

## 一、目标与用户已确认的选择

用户反馈桌面文件 `D:\Users\Ming\Desktop\AI教材炼丹.md` 保存时报 `EPERM ... rename 临时文件 -> 原文件`，当时做过截图粘贴、删除图片、保存。

同时要求 App 和 VSIX：

1. 图片可设置显示缩放百分比，仍保持长文本编辑效率。
2. 尽量保真导出 Word；表格可复制到 Excel；图片可保留质量迁移到 Word / Excel / PPT。无需 Pandoc，但不要未经对照测试声称比 Pandoc 更快。
3. 图片随文件迁移。用户明确选择：**默认嵌入图片，单个 .md 就能迁移**。保存标准 `data:image/...;base64,...`，编辑时只用短缓存 URL，避免图片编码进入每次解析、撤销、AI 上下文。

不要再次询问默认存储方式。不要调用此前对话中的 API 密钥；本轮不需要付费 AI 实验。以前完成的补全优化不要重做。

## 二、已确认的保存错误根因与用户文件处理

实际检查发现上述真实文件具有 `ReadOnly, Archive` 属性。用隔离的只读测试文件复现了同类 rename EPERM。

已将**这个用户文件**的 `IsReadOnly` 改为 false；修改前后内容哈希一致，没有改写 Markdown 正文，没有操作用户尚未保存的编辑器缓冲区。

- 记录：`D:\BuyKey\Typora-Editor-App\.perf\media-office-1.0.15\readonly-repair.json`
- 原文件 SHA256：`9FB476CD43EA4913469455E2FBEE3FDAE4DF73A753E47BDB376BEC31855578F7`
- 当时长度：8679 bytes。

已告知用户可以再次 Ctrl+S。没有证据证明粘贴或删除图片导致了只读属性。

## 三、仓库与生成规则

- App：`D:\BuyKey\Typora-Editor-App`。
- 插件项目：`D:\BuyKey\Typora-Editor`。
- **共享编辑器唯一源码：`D:\BuyKey\Typora-Editor\extension-src`**。
- App `app/render`、共享补全等通过 App 根目录 `npm run sync` 生成；不要直接修改生成副本。
- 两个目录均无 Git 仓库；本轮未发现适用 AGENTS.md。
- 插件现有的是预编译 JS，修改 `extension-src/out`；打包在插件根目录执行 `python pack.py`，不要运行不存在的 TS 编译流程。
- App 仍为 **1.0.14**，插件仍为 **0.1.24-local**。**本轮未升版本、未打包、未安装、未覆盖旧安装包。** 下一版拟为 1.0.15 / 0.1.25-local。
- App 旧文件备份在 `.perf/media-office-1.0.15/`：`doc.js`、`snapshots.js`、`export.js`、`main.js`。
- 当前修改均已保存到磁盘，最近一次 sync 已包含 office-math 和列表修正；最终必须重新 sync 并验证打包内容一致。

## 四、现有实现位置

以下路径以插件 `extension-src` 为相对根，除特别标注 App。

### 保存与图片存储

- App `app/main/snapshots.js`：原子写仍为临时文件 + fsync + rename。EPERM/EACCES/EBUSY 有 60/120/240/400ms 重试；每次重试重新执行 beforeCommit 检查外部改动。真正只读返回 EREADONLY 和中文说明；没有通过删原件或直接截断原件强行保存。失败清理临时文件。
- `render/js/portable-images.cjs`：新模块。图片缓存按 SHA256 去重，保存原始二进制；mask/expand 在 I/O 边界转换。跳过代码中的示例 dataURI。diff 把紧凑编辑文本变化映射回真实 Markdown 的最小修改范围，避免每键重新处理数 MB 图片。保留缓存映射支持删除后撤销。
- App `app/main/doc.js`：`cur.text` / `savedText` 是紧凑编辑文本；`savedDisk` 是完整磁盘文本；`cur.images` 管理缓存。保存、快照、导出展开图片；打开、外部更新掩蔽图片。新增默认内嵌插图、另存为和保存失败时“另存为副本”。
- App `app/main/main.js`：文件菜单增加“另存为…” Ctrl+Shift+S。
- `out/provider/markdownEditorProvider.js`：每个 VS Code TextDocument 用 WeakMap 管理图片映射；Webview 和补全文本紧凑化；最小 WorkspaceEdit 写回 native document。`sourceDocument` 代理及 `toNativePosition` 映射确保 native 补全位置对应真实文本。
- `out/completion/host.cjs`：仅增加可选 `toNativePosition` 使用。未改模型策略或进行 API 请求。
- `render/js/portable-markdown.cjs`：显式“便携 Markdown”导出时，把已有外链/相对路径图片也嵌入。并发 4，新增图片总量限 100MB，单图 20MB。任何缺失图片使导出失败，避免假称便携成功。

### 图片、表格交互与 Office 剪贴板

- `render/js/media-tools.js`、`render/css/media-tools.css`：右键图片进入图片设置，5–400%，预设 25/50/75/100/150%。100% 为原像素宽度。只改显示尺寸；序列化为标准 `<img ... width="..." data-typora-scale="50" />`，不缩小原文件。
- 图片面板另有“复制原图”“导出原图”。右键表格有“复制表格到 Excel”。复制 HTML + TSV，保留单元格结构和文本值，避免 `00123`、`=1+1` 被自动改写。只遍历选定图片或表格，没有每键全文扫描。
- `render/js/media-host.cjs`、`media-clipboard.ps1`：有界图片读取，VSIX Windows 原生剪贴板桥接。PowerShell 隐藏启动，UTF-8 stdin，Windows.Forms DataObject 同时放 PNG/Bitmap 或 HTML/UnicodeText。
- App `doc.js`：**Electron 44 使用新的异步 ClipboardItem API**。本机 `clipboard.readHTML` / `writeImage` 已不适用。现在为 `clipboard.write([new ClipboardItem({...})])`；图像 MIME 对应 Blob。不要退回旧接口。
- `render/js/index.js`、`render/index.html`：引入以上模块与样式。

### DOCX 导出

- `render/office.html`：隔离、按需创建的导出页面，不增加编辑时负载。
- `render/js/office-render.mjs`：Vditor 转 HTML，复用 prepareMathMarkdown，再用 KaTeX 的 MathML 输出；公式每 32 个让出事件循环；Mermaid 尝试 SVG；不支持的内容保留源码并报告警告。
- `render/js/office-docx.mjs`：直接生成 OOXML + ZIP。原生可编辑 OMML 公式、Word 表格、标题、粗斜体/下划线、代码、列表、超链接、图片。PNG/JPEG 等保留原 bytes；WebP/AVIF 为 Office 生成 PNG 并在包中保留原始文件。SVG 尝试 SVG + PNG fallback。设置不自动压缩图片。
- `render/js/office-math.mjs`：包裹未修改的 mathml2omml，改善大括号/矩阵伸缩分隔符、sup/tr 等运算符直立字形。**这是首次视觉检查之后新增，最新视觉效果尚未重验。**
- `render/js/vendor/`：fflate 0.8.3（MIT）、mathml2omml 0.5.0（LGPL-3.0）未修改版本、许可证、源码映射、源代码 ZIP 和说明。mathml2omml 源码提交 `0ddeb8b59ff1a97796b25d8f682dfb410febde1d`。最终打包务必保留许可证与对应源码。
- App `app/main/export.js`：导出类型增加 docx、便携 md。DOCX 在隐藏 BrowserWindow 导出；真实打开窗口与用户源文件不受影响；延续目标冲突和取消保护。
- App `app/main/resource-auth.js`：仅受信任导出窗口可访问 `/render/office.html`，未向其他进程/窗口放开鉴权。
- `out/common/office-export.cjs`：VSIX 导出选择、保存对话框、可取消进度、资源读取、临时文件原子提交。
- `render/js/office-client.js`：VSIX 隐藏 iframe 与主机分阶段通信，检查 source 和 job id。
- 工具栏更多菜单增加 Word / 便携 Markdown 入口，不增加工具栏行数。

## 五、已完成的验证（以实际日志为准）

全部输出位于 App `.perf/media-office-1.0.15/`。

1. `scripts/media-core.test.cjs`：**5/5 通过**，见 media-core.log。覆盖嵌入/移动/字节一致、短文本 diff、emoji/重复图片、只读原子保存和锁重试/外部冲突。约 18 万字符正文 + 5MB 图片，100 次编辑 diff 的 P95 约 **0.85ms**。这是 diff 微基准，不能宣传为整条输入管线延迟。
2. `scripts/autosave.test.cjs` + `scripts/snapshots.test.cjs`：**17/17 通过**，见 save-tests.log。
3. `scripts/desktop-media-office.cjs`：最后 `desktop-results.json` 记录 **6 个已通过检查**：图片原像素解码且编辑/补全文本无 Base64；50% 显示并保留其他公式 DOM；单独移动 md 后恢复图片和尺寸；生成 DOCX 无转换警告；源 Markdown 未被覆盖；原生 Excel 粘贴基础表格。
4. 原生 Word 打开第一版测试 DOCX：**7 个可编辑公式、1 个原生表格、1 张图片、1 页**。`office-native/docx-result.json`；PDF 为 `office-native/word-quality.pdf`，截图 `page-1.png`。
5. 初版一页视觉检查发现矩阵括号不伸缩、嵌套项目符号被错误编号。已修正代码（office-math、numbering 顺序/列表 id），**还没有重新做最终 Word PDF 视觉检查**。
6. DOCX 内原 PNG bytes 与输入完全一致，1349 bytes，SHA256 `504a0ef5286a86061e80c0341c1476a29037e9af8457171a1425039e870b8966`。测试样本 DOCX 转换约 0.35 秒；不是 12 万字文档成绩，也不是 Pandoc 对照结论。

### 最后一次测试的真实失败 / 中断点

最后运行 `TYPORA_OFFICE_NATIVE=1` 的 desktop media-office 检查，**进程退出码为 1**。原生 Excel 表格步骤完成，但接下来的：

`powershell.exe -NoProfile -NonInteractive -File scripts/office-native-verify.ps1 -Mode image`

**超时被子进程 timeout 终止（SIGTERM），无 stdout/stderr**。见 desktop.log。因此 Word/Excel/PPT 的图片剪贴板三端互通 **尚未验证通过**，不能宣称完成。

- harness 已在 finally 尝试恢复原剪贴板。继续检查是否 COM 粘贴调用等待剪贴板拥有者、模态窗口或其他 Office 状态；不要未经定位就扩大 timeout 当作修复。
- 最后检查时仍有一个自动化 Word 进程 PID **11676**，父 PID 1828，命令行为 `WINWORD.EXE /Automation -Embedding`。未强杀，以免误伤用户文档。PID 可能变化/复用；需重新核实归属和打开文档，仅清理确定属于测试的实例。
- `native-table.log` 的中文在终端显示乱码；`office-native-verify.ps1` 验证了前导零和非公式，但中文字段目前仅输出，尚需加精确断言并检查实际 XLSX Unicode，避免把日志编码与内容损坏混淆。

## 六、GLM 优先执行的剩余工作

### P0：正确性与不可丢内容

1. 定位上述原生图片粘贴超时；分别测 App ClipboardItem 与 VSIX PowerShell helper，验证三个 Office 应用原像素及透明度，失败要有正常反馈。不能只以 ClipboardItem 写入成功代替实际粘贴。
2. 审查 App `openFile`：当前在异步 mask 成功之前就清理旧 completion/timer，若打开失败会影响旧文档，需延后切换或完整恢复。
3. 审查另存为：默认新图片内嵌可迁移，但**已有相对路径图片**另存到不同目录可能失效，应嵌入或正确重定位。
4. 补实际“粘贴截图 → 删除图片 → 保存 → 撤销/重开”测试，以及缩放 undo/redo、自动保存中继续编辑、外部修改冲突、只读/锁定/另存为，确认不丢数据、磁盘不残留内部缓存 URL。
5. PortableImages 的 >20MB、坏 dataURI、不支持格式，在**打开现有文件**时不应导致整个文档打不开。可保留原文并降级提示；插入新图仍可限制大小。
6. 插件 native TextDocument 与紧凑 Webview 的版本/CRLF/undo/range 映射需真实宿主验证；确保 AI 不收到 Base64，API 不可用不影响本地编辑。

### P1：导出质量与兼容性

1. 重新用 Word 渲染最新 DOCX，检查修复后的矩阵和列表，加入复杂数学、合并单元格、SVG/Mermaid、长公式、缺失图片/取消/目标冲突测试。
2. `office-math.mjs` 用私用区字符作占位，当前应补选取原式中未使用字符，避免极端原文碰撞。
3. VSIX 实际验证 iframe 资源/CSP/跨来源通信及保存；确认 More 菜单没有丢失原先打印/PDF/HTML 入口。当前替换旧 export 的实现可能使旧入口消失，需保留原能力。
4. portable-markdown 对引用式图片、空格/括号/标题、代码字面量、重复与远程失败补边界测试。
5. 图片保存对话框取消应显示“已取消”，不要提示成功；mediaRequest 的 30s 超时与用户停留保存对话框时间可能冲突，需处理。
6. 真实长数学笔记跑导出与编辑性能测试，报告实际时间；禁止把0.85ms diff基准当全文重渲染性能。不要重跑付费补全实验。

### P2：发布闭环

1. 更新 App 版本/lock 和插件 package/vsixmanifest 为一致的新版本；补功能说明、限制与测试报告。
2. 最终 sync，构建 EXE/portable/VSIX，核对产物里的共享文件和许可证。
3. 正式产物回归通过后再交付路径。不要把当前未完成实现或旧 1.0.14 安装包冒充本轮结果。

## 七、运行命令与环境

App 根目录（PowerShell；GUI 检查依次运行，避免抢剪贴板）：

```powershell
npm run sync
node --test scripts/media-core.test.cjs scripts/autosave.test.cjs scripts/snapshots.test.cjs
node --test scripts/export-assets.test.cjs scripts/server-auth.test.cjs
node scripts/run-electron-test.mjs media-office
$env:TYPORA_OFFICE_NATIVE='1'
try { node scripts/run-electron-test.mjs media-office } finally { Remove-Item Env:TYPORA_OFFICE_NATIVE }
```

输出重定向后务必保留真实 `$LASTEXITCODE`；不要因后续 Get-Content 成功误报测试通过。

原生 Word 渲染（不附加到用户已有文档实例；脚本有 guard）：

```powershell
powershell -NoProfile -NonInteractive -File scripts/office-native-verify.ps1 -Mode docx -Source 'D:\BuyKey\Typora-Editor-App\.perf\media-office-1.0.15\workspace\office-quality.docx'
```

本机没有 LibreOffice，documents 技能的 render_docx.py 因找不到 soffice 失败，已改用安装的 Microsoft Word 导出 PDF，再用 Python PyMuPDF 出 PNG 做视觉检查。不要为此无端安装整个 Office 套件。

- Word：`C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`
- Python：`C:\Users\Ming\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`
- VS Code：`D:\Program Files\Microsoft VS Code\Code.exe`
- Trae：`C:\Users\Ming\AppData\Local\Programs\Trae\Trae.exe`
- 宿主 smoke：插件项目下 `node test/vscode-smoke.cjs [exe] [extension-src 或解包的最终 extension]`。
- Trae 可复用已经过欢迎页的**隔离测试 profile**：`D:\BuyKey\Typora-Editor\test\.runs\vscode-1788633185088\profile`，通过 `MD_EDITOR_SMOKE_PROFILE` 环境变量指定，finally 清除环境变量。不要用用户的实际 profile。
- 旧宿主 tests 假设图片保存为外部文件，需要改为验证新的内嵌语义；不得删除覆盖或把 expected 随意改成实际值来掩盖问题。

构建（测试完成且升版以后）：

```powershell
# D:\BuyKey\Typora-Editor-App
npm run sync
npm run dist -- --config.directories.output=dist/release-1.0.15-final
# D:\BuyKey\Typora-Editor
python pack.py
```

## 八、交付时必须说明的边界

内嵌图片可以让此程序中单个 md 迁移；部分第三方 Markdown 预览器会禁用 dataURI，不能保证所有软件任何设置都能显示。原图 bytes 和显示缩放分离，DOCX 可编辑数学/表格尽量保真，但不支持的公式和复杂结构必须保留内容并提示，不能笼统承诺“任何内容完全无损”。目前没有能耗实测，也没有 Pandoc 同条件对照。

参考实现依据：Electron 当前 Clipboard 文档 https://www.electronjs.org/docs/latest/api/clipboard ，fflate https://github.com/101arrowz/fflate ，mathml2omml https://github.com/fiduswriter/mathml2omml 。
