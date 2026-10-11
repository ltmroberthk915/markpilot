# marcopilot 私版验收报告：表格与统一右键菜单

日期：2026-09-08  
范围：私用版 `marcopilot` 1.0.15 / VSIX 0.1.25-local；作者/发布名：Jinxi（公版保持冻结）

## 交付结论

私版表格交互与统一右键菜单已完成，并通过开发树、真实 Electron 宿主、打包后的私版 App、刚生成的私版 VSIX 和隔离 VS Code 宿主验收。

公版目录和公版产物没有改动。本轮没有把 Trae 宿主复跑或 Pandoc 对照写成已完成事项。

## 实现内容

- 任意 `.vditor-content` 区域（普通正文、标题、代码、公式、表格单元格、图片）右键均提供：复制、复制 plain text、粘贴、剪切；图片额外保留“图片设置…”。
- 公式预览为只读 KaTeX 时，复制 plain text 和 `Ctrl+Alt+V` 回退到对应 LaTeX 源码；源视图直接复制选区文本。
- `Ctrl+Alt+V` 已接入编辑器快捷键，用于复制 plain text。
- 表格右键提供：上方插入行、下方插入行、左侧插入列、右侧插入列、删除当前行、删除当前列，以及原有的“复制表格到 Excel”。
- `Ctrl+Enter` 在当前行下方插入新行；`Ctrl+Backspace` 删除当前行。
- 表格结构编辑直接作用于当前 DOM，未重建未改动的公式、代码、链接节点；每次结构编辑为一个 undo 步骤，并可 redo。
- 私版 App 增加主进程系统剪贴板读写桥接，Electron 44 的异步剪贴板 API 已真实验证。

## 验收矩阵

| 验收范围 | 结果 |
| --- | --- |
| `npm run test:table-context` | 133/133 PASS；IR、WYSIWYG、SV，覆盖正文/标题/代码/公式/表格/引用、四类右键入口、六个表格动作、剪贴板、快捷键、撤销重做 |
| `npm run test:table-context-host` | 11/11 PASS；开发树真实 App 宿主、原生剪贴板、保存回读 |
| 私版打包 App `table-context-host` | 11/11 PASS；`win-unpacked` 生产产物 |
| 私版打包 App `media-lifecycle` | 5/5 PASS |
| 私版打包 App `media-office` | 7/7 PASS；图片缩放、图片生命周期、DOCX 导出 |
| `TYPORA_OFFICE_NATIVE=1 npm run test:media` | 媒体核心 8/8、生命周期 5/5、Office 10/10 PASS；实际 Excel、Word、PowerPoint 粘贴与图片字节一致 |
| `npm run test:renderer` | regression / consistency / features / repairs / UI / shell 全部 PASS |
| `npm run test:math` | Markdown 数学 23/23、数学边界 8/8 PASS |
| `npm run test:completion` | 平台 4/4 PASS，桌面补全与三种编辑模式链路全部 PASS |
| 私版 VSIX 解包一致性 | 496 个文件；`media-tools.js`、`edit-shortcuts.js` 与源文件 SHA256 一致 |
| 隔离 VS Code 真实宿主 | 105/105 PASS；私版 VSIX 版本 `0.1.25-local` 激活、资源 URL、保存同步、图片内嵌、偏移映射、撤销重做与补全链路 |

## 私版产物

| 产物 | 大小 | SHA256 |
| --- | ---: | --- |
| `dist/release-1.0.15-private-final/marcopilot-Setup-1.0.15.exe` | 116,206,290 B | `B0A06A81CB1A73189557CB4B1E8BE2E887DAEFB99D2368CFED2C5B8E2CB34DF4` |
| `dist/release-1.0.15-private-final/marcopilot-v1.0.15-portable.exe` | 115,978,891 B | `AC79AA792A2F072D513F7409CF7D12FC80605C52D1935CAE59E005E94A1F42E0` |
| `dist/release-1.0.15-private-final/win-unpacked/resources/app.asar` | 23,132,176 B | `B8D005671550554F4B457A00FC6F273060546E0B78AC2BB0DB30F319EAD376EF` |
| `D:\BuyKey\Typora-Editor\dist\marcopilot-0.1.25-local.vsix` | 6,197,950 B | `362B41AEAD75DFBE0F39E9440648D0D7DD85337631702207CC4891B48FB2B840` |

## 公版不变性核验

以下当前 SHA256 与公版冻结记录一致：

- `dist/public-release-1.0.15/marcopilot-public-Setup-1.0.15.exe`：`31062B6E3869DE145796BA04D4C93DD2004B8F68A8F67BB97E39363982582CFF`
- `dist/public-release-1.0.15/marcopilot-public-v1.0.15-portable.exe`：`028390B8BA02ADEEE7E108F0EBA9DFE5019162620A8166603DDDFB40037EEE5F`
- `dist/public-release-1.0.15/win-unpacked/resources/app.asar`：`13EAA14F278B2ADE214871DD44EE94A3C7970527DBBAEFAF80DD09F42C8E5EFA`
- `D:\BuyKey\Typora-Editor\dist\Jinxi.marcopilot-0.1.25-local.vsix`：`103890BD54629CC7A8FCEF119DC1EBCE4FFED389E7E0B55FFD49C1720B623D00`

## 边界

- Trae 宿主本轮没有复跑，仍按原报告记录为未完成。
- Pandoc 对照本轮没有执行，不给出速度或质量对照结论。
- 表格验收针对 Markdown 生成的标准表格；未新增 rowspan/colspan 等非 Markdown 合并单元格语义。
