# 修改报告与新发现问题 — marcopilot 1.0.15 / 0.1.25-local（2026-09-07）

本轮为"媒体与 Office"收尾轮：图片缩放、无 Pandoc 的 Office 迁移、图片随文件走三大能力在 1.0.14 已实现并 8/8 真机验收，本轮按交接计划补齐正确性缺口、修复真宿主缺陷、清理诊断残留、完成 Trae 与 Pandoc 对照并完成发布闭环。自用线产品名为 `marcopilot`，应用 ID 为 `app.personal.marcopilot`，插件 ID 为 `marcopilot.marcopilot`；另行构建 `Jinxi` 公开线，使用独立 App ID 与 VSIX publisher，并从发布包移除个人远程补全 API。改动前全部文件备份于 `.perf/backup-media-office/`，8/8 基线快照于 `.perf/baseline-8pass-2026-09-07/`。本轮又捕获并修复了右键缩放重复插图的真实 UI 缺陷；自用线交付目录未被公开线覆盖。两仓库均非 git，回滚以备份为准。

## 一、修改清单（按文件）

### App 主进程（`D:\BuyKey\Typora-Editor-App`）

| 文件 | 修改 |
| --- | --- |
| `app/main/doc.js` | ① openFile 改为"先掩蔽新文档、成功后才销毁旧文档补全/定时器"，失败时旧文档完全不动（P0-1）。② 新增 `embedRelativeImages()`：另存为前把相对路径图片以旧文件为基准读出并注册为内嵌，副本跨目录/跨设备自包含；读取期间用户继续输入时以快照两轮重试，永不覆盖用户最新文本；读取失败/超限保留原引用并汇总提示（P0-2）。③ saveAs 写盘前自动创建目标父目录。④ checkFile 外部更新路径 mask 容错 + try/catch（消除 unhandled rejection）。⑤ reload 的空 catch 改为仅忽略 ENOENT，其余错误弹窗。⑥ media-command 的 save-image 取消回 `{ok:true,cancelled:true}`。⑦ 打开/重载有坏图时一次性警告提示 |
| `app/main/export.js` | 未改（docx/pdf/html/便携 md 四格式与防覆盖链保持） |
| `package.json` / `package-lock.json` | 版本 → 1.0.15；产品名/安装包名统一为 `marcopilot`，应用 ID 为 `app.personal.marcopilot`；新增 `test:media` 脚本（单测 + 生命周期 + media-office 一键跑） |
| `README.md` | 版本引用 0.1.23→0.1.25-local、1.0.13→1.0.15，补 1.0.15 功能段、`marcopilot` 安装路径与 `test:media` 说明 |
| `app/main/state.js` | 新用户数据目录迁移为 `marcopilot`，首次启动兼容读取旧版 `TyporaEditor` / `Typora Editor` 状态 |
| `docs/` | 新增 `FEATURES-1.0.15.md`、`release-1.0.15.json`（含产物 SHA256）、本报告 |

### 共享渲染层（唯一源码 `D:\BuyKey\Typora-Editor\extension-src\render`，改后 `npm run sync`，App 副本 474/474 逐字节一致）

| 文件 | 修改 |
| --- | --- |
| `js/portable-images.cjs` | ① `maskSync/register` 增加 `{tolerant}`：打开/重载路径遇超限、空图跳过并收集警告、保留原文；插入新图仍严格 20MB。② 缓存写失败降级为警告，`flush()` 永不抛出（VSIX 不再白屏）。③ CACHE 正则同时匹配 `file+` 与 `file%2B` 两种拼写（修复 VSIX 保存写入伪 URL 的数据丢失缺陷，详见问题 A-2） |
| `js/media-host.cjs` | 本地相对路径不再剥 `#`/`?`；`decodeURIComponent` 失败（字面 `%`）时保留原文；扩展名识别先取完整 extname、不认识再回退剥查询串（支持 `img.png?v=2` 式缓存穿透名） |
| `js/media-tools.js` | `save-image` 豁免 30 秒计时（上限 600 秒防悬挂）；对话框按钮区分"已取消 / 已导出原图 / 已复制" |
| `js/media-tools.js` | 图片缩放改为按共享渲染层的源码偏移在原文中原位替换：raw Markdown、既有 HTML、IR 与 WYSIWYG 都只保留一个规范 `<img>`，保留 alt/title、原像素与 undo/redo；不再通过 `insertMD` 追加第二张图片（P0-media）。 |
| `js/toolbar.js` | 更多菜单按 1.0.14 asar 原版恢复 `content-theme` 与内置 `export` 两项（outline 已独立顶级按钮，不重复） |
| `js/office-math.mjs` | PUA 占位符抽取为纯函数 `freePuaSymbol(used,taken)`：分配前扫描公式已用 E000–EFFF 码位并跳过，字面 U+E000 类公式不再被占位符碰撞破坏；4096 上限语义不变 |

### VSIX 扩展（`extension-src/out/provider/markdownEditorProvider.js` 等）

| 文件 | 修改 |
| --- | --- |
| `out/provider/markdownEditorProvider.js` | ① 删除冻结 TextDocument 的 Proxy，改为纯门面对象（uri/version/fileName/languageId/eol/lineCount/isDirty/isClosed/isUntitled 活 getter + positionAt/offsetAt/lineAt/range/getWordRangeAtPosition/validateRange/validatePosition/save 透传 + getText 紧凑化 + toNativePosition 映射）——修复当前 VS Code 下激活即抛不变式错误。② 四处 `maskSync/mask` 裸调用收口：容错 + try/catch + `showWarningMessage` 汇总；init 的 flush 失败不再阻断 emit open。③ save-image 取消回执 `cancelled:true` |
| `extension-src/package.json`、`vsix-meta/extension.vsixmanifest` | 版本 → 0.1.25-local（两处一致）；产品名、publisher、插件 ID 统一为 `marcopilot` / `marcopilot.marcopilot`，编辑器 viewType 为 `marcopilot.editor` |
| `extension-src/CHANGELOG.md` | 补 0.1.24-local（图片内嵌/缩放/Office 剪贴板/DOCX 导出）与 0.1.25-local（本轮全部修复）两条目 |

### 测试与脚本

| 文件 | 修改 |
| --- | --- |
| `scripts/desktop-media-lifecycle.cjs` | **新增**：真实主进程生命周期套件，5 场景（粘贴截图→删除→保存→撤销→重开；缩放 50%→undo/redo；保存进行中继续编辑；外部修改冲突+文件删除 Ctrl+S 重建；只读 EPERM→另存副本跨目录内嵌），断言落盘零伪 URL |
| `scripts/build-public-release.cjs`、`scripts/public-release/*` | **新增公开发行线**：临时 staging 覆盖 API-free 补全内核与桌面适配层；公开 App 使用 `app.personal.marcopilot.public`、`marcopilot Public`，不携带 `completion-vault.js`、`profiles.cjs` 或私有补全内核 |
| `pack.py --public`、`public-release/*` | **新增 Jinxi 公开 VSIX 打包模式**：归档内只保留本地/宿主补全，publisher/author 为 `Jinxi`，不注册 API Key/模型命令 |
| `scripts/audit-public-release.cjs`、`test/public-completion-suite.cjs`、`test/audit-public-vsix.py` | **新增公开版验收**：解包 app.asar/VSIX 实包静态安全审计、公开菜单/设置/本地补全真实宿主测试 |
| `scripts/perf-runner.cjs` | 注册 `media-lifecycle` 模式；media-office / media-lifecycle 分支补 try/finally{win.destroy()} 防僵尸窗口 |
| `scripts/desktop-media-office.cjs` | 删除 IMAGE_ONLY/DIRECT/NOCLIP/SYNC/SYNC_PROBE 五个诊断开关，保留 TYPORA_OFFICE_NATIVE 总开关与八项 Office 主流程；新增真实右键菜单/预设/应用断言，覆盖 raw Markdown、既有 HTML 和 WYSIWYG 的单图原位缩放及 undo/redo |
| `scripts/desktop-export-large.cjs` | 增加"真实编辑+保存"端到端计时与 docx 格式（html/pdf/docx 三格式计时） |
| `scripts/media-core.test.cjs` | 新增 2 例：超限/坏图容错（严格模式仍拒绝、tolerant 保留原文+警告+expand 还原）、缓存目录不可用降级（flush 不抛、编辑保存不受影响） |
| `scripts/office-math-pua.test.cjs` | **新增**：PUA 碰撞单测（跳过已用码位、4096 耗尽抛错） |
| `Typora-Editor/test/portable-markdown.test.cjs` | **新增**（插件侧，node --test）：引用式/尖括号/`<img>`/代码字面量识别；空格、括号、`#`、字面 `%`、百分号编码文件名解析；重复图去重；远程失败整单报错且不产生半成品 |
| `Typora-Editor/test/vscode-smoke.cjs` | "外部文件"断言改为内嵌语义（data URI 落盘、零伪 URL）；新增：偏移映射（rawOffset 边界 + 编码内抛错路径）、undo/redo×内嵌图、media-command 结构化错误回执（不动系统剪贴板）、CRLF 文档往返；最终 `marcopilot` 0.1.25-local VSIX 在 VS Code 与 Trae 实包 smoke 均 105/105 |
| 删除 | `scripts/clipboard-electron-probe.cjs`、`.perf/media-office-1.0.15/word-save-*.ps1`×5、`probe-image.b64`（均有备份） |

## 二、验证矩阵（全部实跑）

| 验证项 | 结果 |
| --- | --- |
| 核心单测（media-core 7 + autosave 8 + snapshots 9 + export-assets/server-auth + PUA） | **41/41** |
| portable-markdown 边界单测（插件侧） | **5/5** |
| `test:math` / `test:completion` | 全绿（补全 diff/rawOffset 映射无回归，23 项） |
| `media-lifecycle` 真机套件（开发树） | **5/5**（可重复运行） |
| `media-lifecycle`（解包打包产物） | **5/5**；解包目录 `D:\BuyKey\Typora-Editor-App\.perf\release-1.0.15-marcopilot-extracted-1788788429294` |
| media-office 原生八项（开发树，清理开关后复跑） | **8/8**（组合套件 10/10） |
| media-office 原生八项（解包 app.asar） | **8/8**（组合套件 10/10）；解包目录 `D:\BuyKey\Typora-Editor-App\.perf\release-1.0.15-marcopilot-extracted-1788788429294` |
| 图片缩放真实 UI（raw Markdown、既有 HTML、WYSIWYG） | **3/3**；真实菜单/预设/应用后单图、源码落盘与 undo/redo 均通过 |
| VS Code 真宿主 smoke（`marcopilot` 0.1.25-local） | **105/105**（VS Code 1.134.0；旧基线 101 + 新增 4 项；证据 `D:\BuyKey\Typora-Editor\test\.runs\vscode-1788789137742\results.json`） |
| Trae 真宿主 smoke（`marcopilot` 0.1.25-local） | **105/105**（Trae API 1.107.1；证据 `D:\BuyKey\Typora-Editor\test\.runs\vscode-1788789137749\results.json`；未输入或提交账号凭据） |
| 最终交付目录 shipping EXE 启动链路 | **6/6**（`marcopilot.exe` 文件参数、独立 profile、Jump List 15 项、Unicode、单实例转交、编辑保存；证据 `D:\BuyKey\Typora-Editor-App\.perf\exe-launch-1788787790386\results.json`） |
| Word COM→PDF→逐页视觉复验 | 矩阵括号随内容伸缩、嵌套列表 1.→2.→• 无误编号、00123 前导零保留、中文与 640×320 渐变图完整 |
| 长文实测（262KB/2,844 公式真实教材） | 编辑+保存端到端 **501ms**；DOCX **3,087ms**/199KB；PDF 20.0s；HTML 3,502ms |
| Pandoc 3.11 同条件对照 | 同一输入、运行前后 SHA 不变；Pandoc DOCX **1,111ms**/183,440B/2,822 公式，HTML **800ms**/1,399,761B/2,822 MathML；严格 PDF exit 43，按边界记录，不作 PDF 速度结论；证据 `D:\BuyKey\Typora-Editor-App\.perf\pandoc-compare-1.0.15\comparison.json` |
| 共享文件同步 | `npm run sync` 后逐文件 SHA256：渲染层 474/474、补全 4/4 + policy 完全一致 |

### 公开版并行交付（Jinxi）

公开版与自用版使用不同输出目录和标识，可并行安装；自用版现有产物没有被覆盖。公开包的边界是移除本项目部署的个人 AI 补全 API，不等同于替宿主 VS Code/Trae 禁止其自身网络服务或远程图片加载。

| 产物/验证 | 结果 |
| --- | --- |
| App 安装包 | `dist/public-release-1.0.15/marcopilot-public-Setup-1.0.15.exe`，116,110,364 B，SHA256 `31062B6E3869DE145796BA04D4C93DD2004B8F68A8F67BB97E39363982582CFF` |
| App portable | `dist/public-release-1.0.15/marcopilot-public-v1.0.15-portable.exe`，115,882,824 B，SHA256 `028390B8BA02ADEEE7E108F0EBA9DFE5019162620A8166603DDDFB40037EEE5F` |
| 公开 app.asar | 23,073,390 B，SHA256 `13EAA14F278B2ADE214871DD44EE94A3C7970527DBBAEFAF80DD09F42C8E5EFA`；独立 App ID `app.personal.marcopilot.public` |
| 公开 VSIX | `D:\BuyKey\Typora-Editor\dist\Jinxi.marcopilot-0.1.25-local.vsix`，6,179,996 B，SHA256 `103890BD54629CC7A8FCEF119DC1EBCE4FFED389E7E0B55FFD49C1720B623D00`；publisher/author `Jinxi` |
| API-free 静态审计 | **11/11 App + 10/10 VSIX**；`completion-vault.js`、`profiles.cjs`、`structure.cjs`、私有端点、`fetch`、SecretStorage、`requestAI` 均未进入公开补全链路；最新证据分别见 `.perf/public-release-audit-1788795526761/results.json` 与 `test/.runs/public-vsix-audit-20260907234800/results.json` |
| 公开 App 真机启动/编辑保存 | **6/6**；证据 `.perf/exe-launch-1788795004189/results.json` |
| 公开 VSIX 真 VS Code 1.134.0 | **51/51**；证据 `D:\BuyKey\Typora-Editor\test\.runs\vscode-1788795018757\results.json` |
| 公开 VSIX 实包静态审计 | **10/10**；证据 `D:\BuyKey\Typora-Editor\test\.runs\public-vsix-audit-20260907234200\results.json` |
| 公开 VSIX Trae 复跑 | 本轮未完成：Trae 在隔离 profile 的首启登录/初始化页未进入扩展测试；未输入或提交凭据。自用版此前的 Trae 1.107.1 105/105 结论仍保持，但不冒充公开包复验 |

产物：`dist/release-1.0.15-final/marcopilot-Setup-1.0.15.exe`（116,120,911 B，SHA256 `C7ABDF84A6F8EDDD2D0F3483A134B4F002DA9D96FDF0BA1FC830404EF7E89CA3`）、`marcopilot-v1.0.15-portable.exe`（115,893,503 B，`587AFB92CA9934E8E9563FE00313B43A6E249F566537CB0F1778E414D6970603`）、`D:\BuyKey\Typora-Editor\dist\marcopilot-0.1.25-local.vsix`（6,192,541 B，`577FADFF5423013D988322AF4945E759CC73F2A13EE92A5FE91E53C4735B4B55`）；最终 `app.asar` 为 23,112,511 B、SHA256 `7C635E3C4E8E0D3AD5D1E241D5435FC960A5B5AA993023B8B4E8E4F89DC9FF0C`。解包主程序 `marcopilot.exe` 为 246,248,448 B、SHA256 `802D135A0C949A02A557160F884CCFC5E5EB184DB6DB2786C08C9EF015F5297B`。许可证（fflate MIT、mathml2omml LGPL-3.0+源码 ZIP）在 asar 与 VSIX 内均核对在位；1.0.0–1.0.14 历史安装包未覆盖，1.0.15-final 按本轮重建结果更新。

## 三、本轮新发现的问题

### A. 新发现并已在本轮修复

| # | 问题 | 影响 | 根因与修复 |
| --- | --- | --- | --- |
| A-1 | **当前 VS Code 下 VSIX 激活即崩**：`sourceDocument` Proxy 对冻结的 `TextDocument.getText` 返回不同函数，违反 Proxy 不变式，webview 永不初始化 | VS Code 宿主完全不可用（旧代码同样炸，属 VS Code 版本升级暴露的既有缺陷；本轮 smoke 一启动即捕获） | 改纯门面对象；期间还发现补全内核 `core.cjs` 实际依赖 `document.offsetAt/getText(range)`，门面必须补全 TextDocument 表面，否则补全菜单静默为空 |
| A-2 | **VSIX 保存内嵌图片会把内部缓存 URL 写进 md（数据丢失级）**：`asWebviewUri().toString()` 返回百分号编码 `file%2B.vscode-resource…`，与 CACHE 正则（字面 `file+`）不匹配 → expand/diff 失配 | 此前从未被真宿主验证；smoke 改为内嵌语义后暴露 | CACHE 正则同时匹配两种拼写；真宿主验证落盘含 data URI 且零伪 URL |
| A-3 | saveAs 目标父目录不存在时 `atomicWrite` ENOENT 静默失败（错误对话框被吞） | 程序化/跨目录另存失败 | saveAs 写盘前 `mkdir -p`（与保存路径对齐） |
| A-4 | saveAs 内嵌图片读取期间用户继续输入的竞态：偏移按旧文本切片会错位或覆盖用户新文本 | 极端情况下另存副本内容错乱/丢字 | 快照式两轮重试，永不覆盖用户最新文本；旧 iframe 迟到消息由 frameId=null 过滤兜底 |
| A-5 | 崩溃的 Electron 测试留僵尸窗口持有 fs.watch → Windows 目录删除挂起（EPERM 连锁） | 测试不可重复 | 套件分支 try/finally{win.destroy()}；workspace 用时间戳新目录 + 尽力清扫 |
| A-6 | 大文档切换/重开后，新 iframe 的 `open` 推送受 `completions.ready` 门控可迟到数秒，早到的编辑会被其覆盖 | 测试与真实切换场景共有的时序窗口 | 测试侧已用"等 getValue===cur.text"规避；产品侧该窗口仅在 closeDoc+openFile 切换瞬间存在，实际用户输入焦点随 iframe 卸载而丢失，风险低（记录为已知行为） |
| A-7 | **真实右键缩放会追加第二张图片**：raw Markdown 图片或既有 `<img>` 应用预设后，旧源节点仍在，新的 HTML 图片被追加到文末；undo/redo 还会放大重复风险 | 用户看到重复图片，保存后的 Markdown 结构与显示结果均错误；此前仅测了程序化路径，未覆盖真实菜单 | `imageRange()` 改用共享源码偏移，`setImageScale()` 在 `cloneSource()` 的源码副本内只替换命中范围，再以当前模式转换回 Markdown；IR/WYSIWYG 的真实右键/预设/应用、磁盘落盘与 undo/redo 均重新通过 |
| A-8 | 发布产物仍沿用旧产品名与插件标识，安装包、快捷方式、窗口标题和 VSIX 标识不一致 | 用户安装后看到旧名称，宿主命令/编辑器类型也可能与新品牌不一致 | App 统一为 `marcopilot` / `app.personal.marcopilot`，插件统一为 `marcopilot` / `marcopilot.marcopilot` / `marcopilot.editor`；重新构建安装包、便携版与 VSIX，并对最终产物做元数据核验 |

### B. 新发现、记录在案（本轮不修 / 属边界）

| # | 问题 | 说明 |
| --- | --- | --- |
| B-1 | **DOCX 公式覆盖率**：真实教材 2,844 个公式中 138 个（≈4.8%）MathML→OMML 转换不支持（约束记号、`\forall S\leqslant t<T` 类等），按设计保留 LaTeX 源码并逐条警告，内容零丢失 | 属 mathml2omml 能力边界；如需提升需扩展 office-math.mjs 的转换补丁，另立一轮 |
| B-2 | PDF 导出长文 20.0s（printToPDF 主导），明显慢于 DOCX/HTML | 已知性能特征，非本轮回归；优化空间在渲染分片，另立议题 |
| B-3 | PowerShell 无法读取 asar 归档内脚本 → 打包产物上的 Office 剪贴板验证必须先 `npx asar extract` 解包 | 流程限制，已写入 release-1.0.15.json limitations |
| B-4 | `vditor.setValue()` 是程序化赋值，**不触发 input/change 事件** | 产品 API 行为（非 bug）；对自动化测试是关键坑：真实编辑必须走 `execCommand('insertText'/'delete')` 或 `insertMD` |
| B-5 | copy-image 在非 Windows 平台直接报错（copy-table 有 ClipboardItem fallback，两者不对称） | 审计 P1-opt，交接明示默认不做；如需跨平台对称化可后续补 |
| B-6 | Trae 首次启动可能出现登录/初始化门控 | 本轮使用独立可复用 profile 完成 Trae API 1.107.1 的 105/105 smoke；未输入或提交账号凭据，首次启动的交互门控仍属于宿主环境条件 |
| B-7 | Pandoc 严格 PDF 对照受源文档语法边界限制 | Pandoc 3.11 的 DOCX/HTML 同条件对照已完成；严格 xelatex PDF 在第 903 行附近因 `$`/转义语法失败（exit 43），因此不作 PDF 速度结论 |

## 四、遗留与建议

1. **B-1 公式覆盖**：可按警告清单（`.perf/export-book.json` docx.warnings）定向补 office-math 转换补丁，预计一轮即可把 4.8% 降到 1% 以下。
2. **Pandoc 严格 PDF**：如需可比 PDF 数据，先清理教材第 903 行附近的 TeX `$`/转义语法，再单独重跑；当前 DOCX/HTML 对照数据可直接复核。
3. 本轮未调用任何付费 API、未重跑补全实验、未触碰 API/模型配置；诊断残留清理后 media-office 与基线 8/8 完全一致。
