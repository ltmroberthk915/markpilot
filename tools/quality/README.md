# MarkPilot 可移植质量工具

这套工具把“能加载的测试”“真实输入的结果”“发布文件身份”“源码能否重建”分别验证。它不把历史探针数量当作覆盖率，也不把有截图当作已经看过截图。

## 安装

Node.js 22 或更新版本。Windows 位图测试另需 PowerShell 7，并在可用的桌面会话中运行。

```powershell
npm ci --prefix tools/quality --ignore-scripts --no-audit --no-fund
npm ci --prefix dsh-markpilot --ignore-scripts --legacy-peer-deps --no-audit --no-fund
npm run preflight --prefix tools/quality
npm test --prefix tools/quality
```

`MP_PLAYWRIGHT` 可指定已有的 playwright-core 包目录；`MP_PWSH` 可指定 pwsh.exe 的完整路径。无需下载 Playwright 的浏览器，测试连接被测 Electron 自带的 Chromium。

## 测已发布的 Windows 便携版

先下载官方发布文件，再把发布资产的 SHA256 填入命令。输出目录必须为空。

```powershell
node tools/quality/acceptance.cjs --exe C:/artifacts/markpilot-3.2.5-portable.exe --expected-sha256 df37e3e44bee42637da1dabddd6aeeab9d422aff61f5458505fc1dd19af77d2b --out .mp-verify/quality/acceptance
node tools/quality/critical.cjs --exe C:/artifacts/markpilot-3.2.5-portable.exe --expected-sha256 df37e3e44bee42637da1dabddd6aeeab9d422aff61f5458505fc1dd19af77d2b --out .mp-verify/quality/critical
node tools/quality/performance.cjs --exe C:/artifacts/markpilot-3.2.5-portable.exe --expected-sha256 df37e3e44bee42637da1dabddd6aeeab9d422aff61f5458505fc1dd19af77d2b --out .mp-verify/quality/performance
```

3.2.5 的 critical 套件会以非零退出码结束，已确认的产品缺陷保留为失败。详见 [3.2.5 审计记录](../../docs/LOG-3.2.5-AUDIT.md)。修复后应让相同判据通过，不应删掉失败判据或将其标成成功。

源码模式：把 `--exe` 换成 `--electron C:/runtime/electron.exe --app MarkPilot-CM6`。源码模式和便携版可能使用不同 Electron 版本，结果会记录实际运行版本，不能直接当作相同环境的性能对照。

## 工具与判据

| 工具 | 验证内容 | 不代表什么 |
| --- | --- | --- |
| preflight.cjs | 124 个历史 CJS 的语法、选定核心模块的提前使用、绝对 Playwright 安装路径 | 没有执行这 124 个产品场景；不是完整 JS 静态分析 |
| tests/ | 工具加载、SHA 拒绝、真实 TDZ 突变、锁归属、空套件、证据发布防串路径 | 不是产品功能验收 |
| acceptance.cjs | 真实键鼠、格式、Unicode、固定种子输入模型、公式、Mermaid、任务列表、拖选、保存、双窗口、输入延迟 | 不覆盖原生输入法合成、实际文件对话框或全部 Markdown 方言 |
| critical.cjs | Windows Bitmap→Ctrl+V→PNG→MD→重开；围栏/补全/导出；BOM/EOL/已保存内容/路径隔离；UTF-16 安全；未保存关窗保护 | 一个失败用例不等于一个独立根因 |
| data-safety.cjs | 窗口文档身份、保存回执、磁盘冲突、另存为、刷新/关闭、UTF-16 字节往返与无损拒绝 | 不覆盖所有 OS 对话框交互、崩溃恢复或跨进程文件锁 |
| performance.cjs | 1千/1万/10万行普通文本，1千/1万行公式；每档 5 次预热、30 个有效输入样本 | 没有 Typora 对照；含 CDP 往返和帧调度开销 |
| build-check.cjs | 在临时目录打包，比较重建 bundle 与仓库 bundle 的完整 SHA256 | SHA 不同不能直接证明行为不同，也不能证明行为等价 |
| editing.cjs | 引用／围栏代码、列表选区及多光标、公式候选优先级、标题、下划线、编辑／导出方言 | 用例数量不是覆盖率；并未穷举 Markdown |
| worker-integration.cjs | 完整树与真实原生 parser 对照、UTF-16 混合语言位置、pending 操作与原生命令对照、URL 粘贴、CDP 合成输入 | CDP 合成更新＋insertText 不能替代操作系统输入法候选窗口或证明 compositionend 事件 |
| worker-degradation.cjs | 真实 asar 的 Worker 缺失／15秒超时／协议不匹配后，编辑、撤销、代码缩进和保存继续可用 | 只准使用自己的故障产物，不能破坏已安装应用 |
| worker-latency.cjs | 55万字符文档 pending 引用回车20次，分别记录初次与稳态延迟 | 普通字母的速度不代表结构命令的速度 |
| performance.cjs 扩充项 | 10万行退格及代码输入；首击、帧间隔、Worker 错误 | 默认通过只说明输入完整；`--latency-budget-ms 50` 另约束各档稳态P95≤50ms |
| build-check.cjs Worker 核对 | 同时比较独立 Worker 的完整 SHA256 | 哈希相同证明对应字节；不能替代行为测试 |

引擎的固定依赖安装和构建比较：

```powershell
npm ci --prefix dsh-markpilot --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node tools/quality/build-check.cjs --out .mp-verify/quality/build
```

所有应用启动自动使用同一 app-slot。旧探针可通过 `node scripts/acceptance/app-slot.cjs -- node tools/probes/<probe>.cjs ...` 串行运行；这几个新套件已经自行取锁，不要再包一层同一把锁。

新套件创建独立 profile，禁止迁移真实历史 profile，只写自己生成的 Markdown/图片。`MP_TEST_*` 跳过文件选择框；菜单回调或 Electron 输入挂点会按此口径记录，不能叫作真实点选了操作系统对话框。Windows 位图夹具暂时替换系统剪贴板，原数据仅保存在辅助进程内存，正常结束和输入管道关闭时恢复，结果中的恢复失败会阻止成功。

`setValue`/选区事务只用于准备夹具。被测动作使用 CDP 键鼠或已标明的原生菜单挂点，禁止构造 DOM 的 KeyboardEvent/PasteEvent 来冒充用户操作。截图中的红条是按 caret 坐标画的取证标记，不代表 CDP 拍到了原生光标。

## 发布小型证据

候选打包：`node tools/quality/package-candidate.cjs --runtime <已验证 runtime> --rcedit <rcedit.exe> --out <空目录> [--builder-cache <离线缓存>]`。它写入图标并回读 PE 版本，保留仓库引擎，生成正常 portable/Setup 与唯一 appId 的隔离测试 Setup。安装器会记录文件 SHA；未设置签名证书时是未签名候选。

`verify-package.cjs --candidate <候选目录> --7zip <7za.exe> --out <空目录>` 拆三个 EXE 的实际载荷，逐个核对内层 exe、asar 和源码哈希。`isolated-install.cjs install|verify|uninstall --candidate <候选目录> --out <.mp-verify下验证目录>` 只准安装隔离测试包，保留既有注册信息；未知结果先 verify，不重复安装。测试完运行 uninstall，再核对原有记录。正常 Setup 的用户升级需要另外验收。

安装路径必须包含空格做一次真实安装/卸载验证。当前固定的 electron-builder 25.1.8 模板用 `StdUtils.GetParameter` 再次读取 `/D`；在 `windowsVerbatimArguments:true` 下，参数值需保留字面引号，例如 `'/D="' + target + '"'`，不能把传统 NSIS 的裸尾路径规则直接照搬。[StdUtils 官方规则](https://muldersoft.com/docs/stdutils_readme.html)说明了这层差异。仅把正常 Setup 的 `/D` 指向私有目录仍会卸载同 appId 的现有安装，不能当作隔离；只有唯一测试 appId 的 Setup 适合此工具。升级前完整备份目标程序、可能冲突的同名安装、用户配置、两类安装注册项和快捷方式，核对实际目录再启动程序。

窗口/编码修复可单独运行 `node tools/quality/data-safety.cjs --exe <实际 MarkPilot.exe 或 portable.exe> --scope sessions|encoding|all --out <空目录>`。`stage-app.cjs --runtime <已核验的 Electron runtime> --out <空目录>` 用当前壳源码及仓库 bundle 生成一次性 unpacked/asar；它不下载运行时，也不重建引擎。重封装产物与最终 portable/安装器分别测试和记录身份。

`mutate.cjs on|off --kind window-sessions|receipt-revision|external-conflict|utf16-read|utf16-write --app <一次性源码副本> [--baseline-ref <Git提交>]` 提供可逆负向控制，拒绝直接修改产品工作区。on/off 可重复调用，恢复时核对文件 SHA 防止覆盖后来修改。窗口/codec 回退必须给真实 Git 基线。回执 GUI 可用 `--scope sessions --case save-receipt-does-not-clear-later-edit` 独立复跑；磁盘测试用 `MP_TEST_DOCUMENT_STORE=<副本/shell/document-store.js>` 指向突变副本，不能把预期非零退出当通过。

截图现在同时保存全图及 2 倍 caret 局部图，必须有可测的 caret 坐标；`publish-evidence.cjs` 核对两类图片哈希。跨 IPC 的异步等待使用 `waitUntil` 真正 await 每次谓词，避免 Promise 本身为真而提前放行。

```powershell
node tools/quality/publish-evidence.cjs --in .mp-verify/quality/critical --out docs/verification/quality-3.2.5/critical
```

只发布 result.json 与清单内、哈希匹配的 PNG。每帧不超过 1MiB、整批不超过 5MiB；机器路径替换、长内联文本摘要化。浏览器 profile、安装包、下载文件、临时 bundle、模型会话和凭据都留在被忽略的 `.mp-verify/`。发布前仍应确认输入只包含合成夹具，不含用户文档。

`ci/quality-tools.yml` 提供 Windows/Linux 的安装、预检和工具自测模板。当前 GitHub OAuth 凭据没有 `workflow` scope，因此本次把模板公开在工具目录，尚未启用 Actions，也没有声称云端 CI 通过。具备工作流写入权限后，将模板放入 `.github/workflows/quality-tools.yml` 即可启用。桌面交互测试仍由有桌面会话的机器运行。

PDF 的只读文本检查另需 Python 与 pypdf；安装 pypdf 后运行 `python tools/quality/pdf-text-check.py <file.pdf> --expect <当前文档独有标记> --forbid <另一文档独有标记>`。若 PATH 有 Poppler 的 `pdftotext`，会同时保留两种提取结果。至少一个提取器必须读出全部正向标记，任何提取器读出禁用标记都会失败；不归一化重复文本，也不能用文本检查代替打开实际页面。

## 图片与启动协议

```powershell
node tools/quality/images.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/images.cjs --exe <实际产物.exe> --case long-document-paste-is-visible-without-extra-input --image-delay-ms 0 --out <空目录>
node tools/quality/host-startup.mjs --artifact <stage-app生成的artifact.json> --out <空目录>
node tools/quality/image-predecode.mjs --artifact <stage-app生成的artifact.json> --out <空目录>
```

`images.cjs` 覆盖真实位图粘贴、中文及特殊字符目录、边界与源码编辑、异步插入位置、取消与独立撤销、同名冲突、HTML 属性和第二张图菜单、25/50/75/100% 预设、5/100/400% 自定义、页面缩放与宽度、只读目录回退、多窗口、PNG/JPEG/WebP 与 HTTP 复制和另存。五通道含真实双击、Shift+点击和分步拖选；对话框的输出路径使用标明的宿主测试挂点。Windows 剪贴板像素由独立 STA 辅助进程回读；PNG/WebP 精确比较，JPEG 使用报告中明确记录的平均字节误差容限。

默认图片落盘人为延迟为 5000ms，用于稳定制造写入期间继续输入、撤销或切文档的时序，不代表日常粘贴延迟。快速 Ctrl+End→Ctrl+V 的长文档视口臂单独以 `--image-delay-ms 0` 运行，要求小图完整位于正文可见区，不以解码成功代替屏幕可见。预解码故障臂只在自己的渲染进程暂时替换 `decode()`，仍通过真实剪贴板与 Ctrl+V；拒绝和真实十秒超时后都须保留一次实际图片插入，并及时恢复方法。

`image-directory-access.ps1` 只对带 `quality-run.json` 的测试目录临时拒绝写入，保存并恢复原 SDDL。`windows-clipboard-check.ps1` 只输出合成夹具的尺寸及像素比较结果，不输出原系统剪贴板内容。`host-startup.mjs` 使用真实 host、主进程处理函数和 DocumentStore，控制 IO/IPC/DOM 时序检查启动身份竞争；它不启动 Electron，不计作 GUI 用例。

`image-predecode.mjs` 抽取实际插入函数，并使用真实 CMState 和位置预留字段，在受控 Image/FileReader/clock/host 模型中检查完成、失败、超时、失效、请求顺序及撤销边界。它没有 GUI、不会操作剪贴板；源码与核心文件重新计算 SHA，原生 EXE/ASAR 哈希只作为声明记录，报告明确写出 `nativeBinaryHashesVerified:false`。省略 `--artifact` 可只跑模型，省略 `--out` 不写证据目录。先安装 `dsh-markpilot` 的锁定依赖，不能把这 13 项模型与 GUI 用例相加当覆盖率。

负控入口：`node tools/quality/image-mutate.cjs on|off --root <已标记的可丢弃源码副本> --kind <类型>`。支持 scan、boundary、widget-anchor、range、identity、scale、reset、order、assets、source、format、exclusive、predecode。它拒绝 Git 工作树和未标记目录，要求唯一锚点命中，记录修改前的完整 SHA 与字节；on/off 重复调用幂等，还原时拒绝覆盖其他修改。突变后须重建并在同一真实 GUI 判据上见红，还原后重新构建、核对源与 bundle/asar 身份并见绿。`exclusive` 的外部文件生产者必须确实在临时文件创建后赢得目标路径，未发生竞争的绿灯不算证明。

定向复验、最终回归、证据复用及安装边界的选择规则见 [修复时效策略](../../docs/LOG-3.2.8-STRATEGY.md)。修改期先跑失败用例和相关模型，冻结后按依赖做最终验收；小型流程或文档修改无需重新打包编辑器。时间统计来自原始结果中的起止时间，不能把套件执行时间当作整个任务用时。

## 文档与文字／公式连续操作

```powershell
node tools/quality/document-workflows.cjs --exe <实际产物.exe> --out <空目录>
node tools/quality/math-workflows.cjs --exe <实际产物.exe> --out <空目录>
node tools/quality/rich-workflows.cjs --exe <实际产物.exe> --out <空目录>
node tools/quality/workflow-mutations.cjs --runtime <已验证runtime目录> --out <空目录>
```

`document-workflows` 检查不同文件相同内容、新建空稿、跨文件重做、重新打开同一路径与同文件刷新；也从活动表格格子切文档后立即输入，核验自定义快捷键、现有扩展、分屏源码、焦点及实际磁盘内容。打开文件通过已注明的宿主入口，不冒充操作系统文件选择框。

`math-workflows` 从普通／引用／嵌套引用／多行／带空白公式的真实字形点击出发，连续输入、撤销、重做并点当前浮层。翻页、全选复制、真实双击、Shift+点击、分步拖选后用 Shift+方向键缩选，均检查精确 Markdown 内容。此套件的 Shift+点击臂终点在公式外的正文；它不证明 Shift+点击公式字形的行为。`rich-workflows` 核验两张 HTML 表格及前中后文本的完整顺序、包装层、裸文本、嵌套／合并表的完整纯文本回退、TSV、代码块及纯文本粘贴，并检查整次粘贴的一步撤销／重做。富文本套件本身使用键盘输入，不能单独宣称五通道覆盖。

这些工具可用 `MP_QUALITY_CASES` 正则限定用例；过滤后零用例仍是失败。实际按键须记录 `key/code/modifiers` 并保留生效正对照：例如 Playwright 的 `Control+Shift+u` 会发送小写 key；模拟实际 Shift+U 使用 `Control+Shift+U`，不能把前者与本地键盘按法当成同一输入。

`workflow-mutate.cjs on|off --kind history|rich|math --root <已标记的一次性源码副本>` 提供三根因负控。`workflow-mutations.cjs` 重建并暂封装该副本，在同一个真实 GUI 判据上确认指定失败、逐字节恢复、重建及恢复后通过；启动失败不能算突变成功。副本的拥有标记、绝对边界、源 SHA 与幂等恢复均受检查，拒绝 Git 工作树或产品目录。

`clipboard.hold()` 仅在内存保留原剪贴板，不放入无关位图；URL／富文本装弹用它即可。独立 STA 回读只返回匹配与长度，禁止输出意外剪贴板内容。套件记录完整 ASAR 与实际资源目录、启动 EXE 和真正运行的内层 EXE；便携外壳的 SHA 不能代替内层产物身份。工作流截图可放在输入状态 trace 中，证据工具汇总、去重并同时校验全图和 2 倍局部，重复图不算独立视觉样本。

## 选区、纵向导航与表格连续编辑

```powershell
node tools/quality/selection-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
```

`selection-workflows` 用真实鼠标和键盘检查普通／浮动公式字形的正反向 Shift 选区、精确源码复制、删除及撤销重做；也检查整行复制后重新复制／剪切非空选区，粘贴是否仍落在当前光标。LF 与 CRLF 文件均有独立夹具。

表格操作从实际点格开始，检查竖线转义后的后续输入、既有竖线与反斜线、emoji、正反向选中删除／替换、复制剪切到下一格、单行粘贴及完整邻格保真。撤销重做同时核对源文本、DOM 文本、焦点、选区方向和光标；跨格历史须跟随源码恢复的格，格尾与空格子也各自验证。输入和剪贴板动作前确认实际焦点及载荷，保存结果由磁盘回读。

公式导航区分连续上下移动和水平键／浮层点击／编辑撤销后的重新定位；多行块内部的原生上下键必须保住进入前的目标列。复制而未重新定位是保列正对照。启动测试分别检查不点即能输入和早期点格后延迟补焦不打断操作。

此套件与 `math-workflows` 的真实双击、拖拽后组合键等场景配合使用。表格空内容或焦点丢失时，DOM caret 可能没有可测矩形：对应失败证据允许保留未标记的原图，记录 `caret:null`；不绘制一个虚假的红色光标。截图仍需独立视觉复核，测试通过与看过截图分别记录。

工作流负控扩充 `shift|nav|cell-text|cell-history|cell-owner|boot|clipboard`，保留原三种类型。每种撤掉一个具体机制；跨格 owner 检查单独撤掉，同格 Undo 仍须通过。负控及恢复态都核对实际运行的完整 ASAR、运行时、七个壳文件和全部可读 CM6 源文件，包含格文本 codec；正对照须保持通过。结束逐字节恢复副本，现有工作区授权修改原样保留。

`document-focus` 负控只撤掉切换文档末尾的同步交焦：从活动表格格子打开新文档后立即输入必须失败；同文件刷新与真实设置面板保焦须仍通过，逐字节恢复后原失败臂转绿。`document-workflows` 的持久控件臂从「更多 → 设置」真实点击滑杆，切文档后验证同一控件仍连接、持焦并接收真实方向键；设置帧记录 `caret:null`，2 倍图仅展示实际控件上下文，不借用未持焦正文的 CM 坐标画光标。

`cell-activation` 负控还原格激活的 rAF 与 30ms 双落点；真实 Tab → Home → 短暂停顿 → 输入必须重现格尾误写，恢复同步一次落点后通过。探针记录实际 keyup／selectionchange／beforeinput；DOM 的 child-boundary 下标与文本字符偏移分开，使用只读 Range 长度核验 Home 到输入间的光标，不派发选区。普通点格立即输入、80 行表格末格补行、Shift+Tab 返回和 Ctrl+E 选格分别作为相关边界。

新增日常操作链可分别运行：

```powershell
node tools/quality/math-entry-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/math-paste-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/search-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/mixed-selection-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/workflow-mutations.cjs --runtime <runtime目录> --out <空目录> --kinds math-entry,math-paste,html-fragment,cell-search,search-return
```

`math-entry-workflows` 用真实 Up／Down 进入七种块公式，紧接着输入、撤销重做、反向退出并保存；包括引用、嵌套引用、空白、UTF-16、单行双美元及围栏同行正文。进入和立即输入之间没有读数、截图或选区修补。`math-paste-workflows` 从字形点击和真实选区开始，以系统剪贴板验证普通 HTML、纯文本快捷键、仅 HTML、真实多行与空白、引用公式以及跨公式富文本负控；核对完整源码、历史、继续输入和磁盘。其 HTML 原始载体记录只来自明确写入的合成夹具，原用户剪贴板仅在内存持有并恢复。

`search-workflows` 从正文、工具栏、实际活动格三个入口查询，返回后替换／续写及撤销重做；另有 Escape→Right→立即输入的无中间等待臂，以及转义管道、emoji、公式源码格与普通正文对照。搜索 INPUT 没有可测光标时只保留控件上下文，不借正文光标。跨格、分隔行和半个转义的臂只验证原选区及输入归属不被钳格，没有继续编辑保证；多选区与 F3 返回不据此声明已覆盖。`mixed-selection-workflows` 的键盘臂先翻页再全文剪切／替换，鼠标臂分步反向跨公式拖选／复制；它们不等同于局部跨页选择或多行块内的字形子选区。

新突变分别撤回公式正文入口映射、公式内文字粘贴保护、HTML 片段提取、活动格搜索转发和搜索返回的格编辑归属。`--kinds` 必须是已知且不重复的根因列表；默认执行全部定义。所选失败臂须在真实运行产物上失败，相邻正对照须通过，精确恢复后全部转绿。全部操作只在标记的一次性源码副本上进行，不要求或清理授权工作区。

```powershell
node tools/quality/quoted-math-subrange-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/cell-composition-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
```

`quoted-math-subrange-workflows` 从多行引用公式的真实字形点击和反向 Shift+字形点击开始，验证局部源码选区的复制、剪切、原位粘贴、各自撤销重做和后续输入。历史步骤包含等待、读数和截图；此臂不声称 Redo→输入之间无间隔。复制与剪切各自覆盖独立剪贴板哨兵，STA 回读必须得到带引用前缀的原始源码；不以归一化 TeX 代替选区源码。

`cell-composition-workflows` 默认只运行直接 Unicode 输入正控：在包含转义管道的真实活动格里输入中文，撤销、重做后立即输入数字，核对 DOM、源码、位置和磁盘。原生方向键默认动作后，CM 选区可以暂时滞后；探针在真正输入边界的被动 bubble 快照核对同步，不加补焦点或选区修复。

用 `MP_QUALITY_CASES` 显式选择 `cell-cdp-composition-commit-history-continue` 可启用严格合成臂，它仍强制先跑独立 Unicode 正控。可信组字更新之后，必须观察可信的提交或结束事件才能继续历史链；否则记录 `transport/commit-unconfirmed` 并非零退出。当前 Chromium 130 实测只有不可信的结束事件，不能据此宣称系统输入法通过或失败；这条未确认结果不加入通过数。CDP 合成不替代微软拼音候选窗口、229 键序列或物理键盘验收。

```powershell
node tools/quality/native-menu-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/cross-page-drag-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/math-gesture-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/native-pending-image-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/search-pending-image-workflows.cjs --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空目录>
node tools/quality/workflow-mutations.cjs --runtime <runtime目录> --out <空目录> --kinds native-menu,math-gesture,menu-pending
```

`native-menu-workflows` 在正文、活动格和搜索输入框各自准备独立撤销／重做历史，用真实键盘验证正控，再调用实际原生菜单项。拥有的测试进程使用 [Electron 主进程调试入口](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)；菜单身份、聚焦窗口和文档所有权均须确认，角色路线还须收到该编辑面的可信历史事件。搜索框保留原生字符历史单位，正文和格内沿用文档历史。随后输入及磁盘回读检查焦点归属。此入口证明实际 [MenuItem](https://www.electronjs.org/docs/latest/api/menu-item) 回调，不证明操作系统物理点击或加速键。

默认十臂包括正文和格内各两条空历史链。空历史的实际菜单动作验证源、焦点和续写；额外调用真实引擎的无操作历史入口，核对 owner 的 handled=true 契约。该 API 检查与真实菜单动作分别记录，不以可信历史事件缺席推断 native 调用次数；旧版本没有此入口时记为未确认。

`cross-page-drag-workflows` 先跑普通文字正控，再从渲染公式开始持按拖动、滚轮翻页、回到原屏幕坐标并松手。固定种子和路径要求真实带按钮移动、实际滚动、完整跨越两块公式，且松手前的选区端点在普通 ASCII 行；入口不足记为未确认。松手必须保留既有选区，后续缩选、源码复制、替换目标、撤销重做和输入由独立夹具切片与剪贴板回读核验。轮事件的 `buttons=0` 单独记录，持按状态由它前后的真实移动和无提前松手证明。仅在 Redo 后需要原生 Right 收起选区时，Right→R 之间没有等待、读数或截图。

`math-gesture-workflows` 独立核验公式单击、小幅抖动、局部持按回环和原地持按滚轮。真正单击保持字形对应的源码落位；已经移动或滚动的手势在松手时保持此前选区。窗外释放和滚动后返回原 scrollTop 不据此声明覆盖。

`native-pending-image-workflows` 使用合成位图、真实系统剪贴板和测试实例的 5000ms 写盘延迟，在空与非空历史中调用实际菜单撤销。迟到的资产写入及时间戳须证明宿主等待已覆盖撤销动作，才判断文档是否错误插回图片；证据不足分别记入口或传输未确认。它只证明宿主待写，不读取内部 ticket 字段。资产文件可以留下，Markdown、渲染、焦点和磁盘须保持撤销后的状态。

`search-pending-image-workflows` 在正文位图待写时进入搜索框、真实键入查询并调用菜单撤销。搜索必须撤掉自己的输入，正文待图不得被取消；迟到图片仍须正常渲染并保存。待图后不使用正文 Undo 建搜索正控，避免测试自身取消图片。搜索帧使用实际控件位置，不能借正文光标作标记。

三种新负控分别撤掉菜单消费、公式点击的拖动／滚动保护及菜单入口的待图取消。待图负控的非空历史正对照必须仍通过；普通跨页文字拖选也是正对照。恢复后使用同一实际输入、夹具与判据验证，不能把启动失败计作产品突变成功。

### 3.3.3 源码布局与导出入口

`source-layout-workflows.cjs` 覆盖 15 条表格/行内公式/视口链，`block-source-workflows.cjs` 覆盖 21 条围栏投影和原始源码选区链，`export-source-workflows.cjs` 覆盖 19 条实际导出与另存为链。均使用明确的安装产物 `--exe`、`--expected-sha256` 与新的空 `--out`；原有完整回归仍须按改动范围执行。这些数字是当前显式用例数，不是覆盖率。

活动格的原生菜单保存通过真实菜单项回调验证。CDP 的 Ctrl+S 不保证触发 Electron 的原生菜单加速键，不能补发带字符事件的通用 sendKey 后把多出的字符当成产品输入。高缩放时，先用真实滚轮把目标行带到屏内，再按当前坐标点击；离屏点击失败不能当作编辑入口的产品失败。

### 私有数学语料的特征抽样

`corpus-math-workflows.cjs` 先将完整语料按原字节复制并装入实际产物，再用保留引用/列表上下文的片段测试真实字形点击、立即输入、Undo、Redo 后立即输入、反向选择、原生复制/剪切/粘贴及完整保存字节。系统剪贴板会恢复，只关闭本工具拥有的测试进程。原件不参与编辑。

```powershell
node tools/quality/corpus-math-workflows.cjs --corpus <私有语料.md> --samples <私有manifest.json> --exe <实际产物.exe> --expected-sha256 <完整SHA256> --out <空的私有目录>
```

Manifest 格式如下；`corpusSha256` 对应原文件完整字节，`span` 是 `text` 内目标公式的 UTF-16 源范围。case ID 只用小写字母、数字和连字符。先校验全部样本身份及范围，再运行 GUI。

```json
{
  "corpusSha256": "<完整SHA256>",
  "cases": [{
    "id": "plain-inline",
    "text": "BEFORE\n\n$x+y$\n\nAFTER\n",
    "span": {"from": 8, "to": 13},
    "features": ["inline", "plain"]
  }]
}
```

输入链只确认进入目标公式源码范围，并按实际原生选区核对编辑结果；不独立证明字形的精确落点。保存不等于重开，语料扫描数量不等于渲染成功数量，CDP 输入不等于系统 IME。本工具不声称拖拽、跨屏、所有环境内部编辑或性能已覆盖。报告不记录正文，但 fixture、manifest.text、截图仍含原文，应留在私有输出；公开的是工具源码与合成夹具。[统一交互方案与实测边界](../../docs/LOG-3.2.13-REGION-ARCHITECTURE.md)

Autosave liveness: autosave-liveness-model.cjs extracts the actual host functions and checks 21 scheduling boundaries. autosave-liveness-workflows.cjs uses explicit EXE/SHA/output arguments and real CDP cell/body input, composition cancellation, disk reads, history and cell selection gestures. Cancellation has trusted update/beforeinput/input but untrusted compositionend on this Chromium; this is not an OS IME claim.


### PDF export lifecycle (3.3.6)

`export-two-frontier-workflows.cjs` covers cancellation during observed HTML appends, native editing/history/drag continuation, second-window busy and folder isolation, retired-generation rejection, existing PDF preservation and export recovery. The source-only fault notification is labeled separately. Observers forward actual handler arguments and original Promises without delay. `tests/export-writer-lifecycle.test.cjs` exercises real stream open/write/finish/abort settlement and asset cancellation.

### Table geometry and rich-document viewport budget (3.3.7)

`table-scroll-workflows.cjs` uses seven synthetic native-input cases: three zoomed cell handoffs with paint-only invalidation, source/history and independent save checks; block height units; a tall atomic formula with document-budget restoration through undo; identical formula owner isolation; and automatic drag selection across screens with reversal, release, and Shift-key continuation. `tests/table-geometry.test.cjs` extracts the actual geometry and state-field code. `tests/viewport-budget.test.cjs` verifies the pinned maintained view and default/finite bounds. `build-check.cjs` requires one view and one state module.


## Save As 文件目标边界（真实文件系统）

`save-target-boundary-workflows.cjs` 直接调用指定产品目录中的真实 `DocumentStore` 和 `prepareSaveAsAssets`，在自己创建的 Markdown、图片和链接夹具上验证保存目标。它不启动 Electron，不占 app-slot，也不计作 GUI 验收。

```powershell
node tools/quality/save-target-boundary-workflows.cjs --product "C:/workspace/markpilot/MarkPilot-CM6" --out "C:/workspace/markpilot/.mp-verify/save-target-001"
```

两个参数都必须使用绝对路径。`--out` 必须尚不存在，父目录必须已存在，且输出目录不能包含产品目录或位于产品目录内。工具保留夹具、原始错误和 `receipt.json`，记录实际产品目录、两个真实模块的 SHA256、回执、文件字节哈希和 mtime。不会清理既有目录、递归删除文件或修改系统权限。

| ID（数字别名） | 判据 |
| --- | --- |
| `same_directory_alias`（`1`） | 通过目录 junction/dir symlink 别名向同一目录另存，`copied=0/reused=0`；图片字节和 mtime 不变；MD 回执及会话路径等于 canonical 目标。 |
| `file_symlink_target`（`2`） | 末级文件 symlink 指向另一目录时，MD 和相对图片均落在实际目标目录；源文件、图片及 symlink 保留。 |
| `parent_alias_retarget`（`3`） | 原选目标父链接在 prepare hook 期间改向，MD 必须拒绝，两侧竞争图片保真；允许原 canonical 目录保留已发布图片，改向后的未获许可目录不能新增图片。 |

`MP_QUALITY_CASES` 使用完整 ID 或数字的精确列表，以逗号、空白、分号或竖线分隔；此工具不采用其他工作流常用的正则筛选。未知 ID、重复 ID 或零选中均失败。例如：

```powershell
$env:MP_QUALITY_CASES='same_directory_alias,parent_alias_retarget'
node tools/quality/save-target-boundary-workflows.cjs --product "C:/workspace/markpilot/MarkPilot-CM6" --out "C:/workspace/markpilot/.mp-verify/save-target-002"
Remove-Item Env:\MP_QUALITY_CASES
```

每臂独立保留结果，前一臂失败不阻止后续臂。文件 symlink 无权限或平台不支持时，记录 `entry_unconfirmed`、保留原始 `cause.code`，整体 `passed=false` 且退出码为1；不能把该入口记为通过。工具不会提权或调整 OS 设置。`fullSuite` 仅表示三个 ID 都被选中；只有 `passed=true` 且三臂均为 `pass` 才能宣称三条边界全部得到验证。筛选后的通过只覆盖已选择的臂。

该工作流独立于 `npm test` 的核心单元测试。`npm run save-target-boundary --prefix tools/quality -- --product <绝对产品目录> --out <不存在的绝对目录>` 等价于直接运行上述 CLI。导入模块不会自动运行夹具，私有包装器如需执行，必须显式调用导出的 `main()`；每次使用独立 Node 进程及新输出目录。
