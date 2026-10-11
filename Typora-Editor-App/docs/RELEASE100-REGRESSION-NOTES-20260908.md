# 私版 1.0.0 回归工作记录

状态：继续执行中。用户已恢复桌面测试；收到任何新的打断立即暂停。1.0.0 私版候选包已构建并通过文件一致性校验，最终 IDE 及人工验收进行中。下文记录保留各阶段原始状态。

再次人工复核（北京时间 22:48）：第二版实际 portable `.perf/release100-manual-exe-1788878140538` 中，取消 RN 正文公式再撤销，内容还原但焦点落在编辑区外，直接输入无效。已保留 `rn-undo-baseline.json`、`rn-direct-typing.json`，关闭该窗口，第二版同样未验收。`recordFirstPosition` 现在也记录直接改 DOM 的公式/格式命令选区。新增原生鼠标公式用例进一步发现 IR 正文 code@0 输入可被 Chromium 写入相邻 `$` 标记，虽导出源码看似改变，预览却仍旧。`math-edit.js` 现在在原生输入后将越入标记的文字移回原公式源代码，并延至组合输入完成后修正；粘贴也记录原始目标。

当前源码专项：`workflow-gaps-1788878695212` 的 18 项命令/普通输入撤销位置检查通过；`workflow-gaps-1788878807845` 的 48 项公式首尾输入检查通过（IR/WYS × 普通/加粗/表格 × 首/尾 × 输入/粘贴/中文提交/取消），逐项比较实际 code 文本、预览的 data-math、单元格及历史。尚须当前源码完整回归、窄窗分屏人工测试，之后重新构建最终候选。此前第一、二版包均保留，仅作失败与修复前证据。

修复后复测（北京时间 22:33）：新增 `history-selection.js`，用源 DOM 的祖先路径与合并文本偏移记录每笔原生输入前后的正向/反向选区，单独附着在历史补丁上；不重写原生文本差异链。补齐直接由 keydown 完成的换行/删除路径，取消组合输入不增加空历史。`workflow-gaps-1788877325460` 两模式均复现旧光标失败；增加的 12 项专项及完整 `workflow-gaps-1788877726738` 共 65 案例通过，错误与资源错误为空。`release100-background-visual-caret-final` 的 245 Node / 71 语法 / 480 同源 / 公版哈希检查通过。桌面 Ctrl+Alt+B 通过主进程输入路由切换侧边栏，避免 Vditor 的 Ctrl+Shift+B 插段冲突。

已保留第一版候选包，第二版候选包位于 `dist/release-1.0.0-private-final-v2`；VSIX 解包目录为 `D:/BuyKey/Typora-Editor/test/.runs/vsix-private-1.0.0-final-v2`。`.perf/release100-delivery/v2/coherence.json` 已逐字节验证 480 共享渲染文件、14 扩展宿主文件及全部 app 文件。当前继续补做这次输入/历史改动所影响的回归与最终包人工验收，尚无最终交付结论。

人工复核新发现（北京时间 22:20）：当前候选包暂停交付。真实 portable 的 RN 公式点击、取消及恢复、米色窄窗中的表格公式切格已通过，但末格删空后撤销虽然恢复完整内容，光标却跳回之前 RN 段落的旧位置。证据为 `.perf/release100-manual-exe-1788875706943/undo-focus-boundary.json`。另外 Ctrl+Shift+B 与编辑器插入前置段落冲突，未执行菜单标注的侧边栏切换。上述两项须修复并补充原生输入回归。测试副本已恢复、保存并正常关闭；运行期间 JavaScript 异常为 0，原始输入文件未变；退出成功不代表人工流程全部通过。

最终候选版的 VS Code / Trae 全量各 150 项、焦点专项各 29 项均已通过。两个 IDE 中实际鼠标选区、Alt+U 后直接键入专用测试标记，均进入 AI 输入框，附件分派各一次且未提交消息；证据在 `.perf/release100-final/*-focus-*/manual`。最终 math-table 68 案例/1216 步、workflow-gaps 53 项通过，但旧历史测试在撤销后重新点击目标格，未覆盖此次光标问题，因此不作为此问题已解决的依据。

本轮继续发现并修复两类产品问题：

- 源码模式快速输入后立即撤销，延迟历史记录尚未提交。现在先提交待记录的源码编辑、取消旧定时器，再执行编辑器的撤销/重做；源码模式的原生历史事件走同一条路径。无 keydown 的输入也按原有机制记录初始光标。
- 超长重复文本有两处独立的耗时来源。Lute 1.7.6 的自定义协议识别对每个字节重新分割后缀；现先以一次扫描计算必要条件，候选仍交给原生解析逻辑。依据是 [上游对应版本解析代码](https://github.com/88250/lute/blob/v1.7.6/parse/auto_link.go)。历史差异算法的重复片段启发式也可能忽略其超时边界；未匹配区超过 65536 字符时，现使用原有的有时限差异计算路径。

源码快照：`.backups/2026-09-08-release100/typora-patches-before-source-undo.js`、`lute-before-autolink.min.js`。Lute 修改可由 `scripts/patch-lute-autolink.cjs` 重现；共享文件仅从 extension-src/render 同步到 app/renderer。

当前证据：

- `.perf/release100-background-resumed`：245/245 Node 测试通过，无跳过或取消；70 个脚本语法检查通过；479 个共享渲染文件一致；4 个公版产物哈希未变。新增 Lute 比对覆盖四种渲染方法、随机混合、链接/邮件/自定义协议、真实笔记和超长文本。
- `.perf/release100-source/source-history-1788868596853`：首次完整的 18 项源码历史测试通过，但 900002 字符单行撤销耗时约 198884 ms。
- `.perf/release100-source/source-history-1788869286900/source-history.cpuprofile`：定位到 diff_halfMatch/commonPrefix/commonSuffix 热点。
- `.perf/release100-source/source-history-1788869529547`：18 项输入及历史测试通过。相同 150002 / 900002 字符夹具首次撤销分别约 135.5 / 118.1 ms。属于特定压力用例的单次原生输入测量，不代表普通编辑或整机的普遍提速。之后增加的双向补丁还原断言尚待执行。
- `.perf/release100-source/math-boundaries-1788869652060`：数学边界及 2844 条公式教材渲染通过。
- `.perf/release100-source/history-large-1788869787961`：整本笔记的历史操作通过，保留既有公式节点，没有额外公式重渲染。

旧测试工具问题也已修正，失败证据保留：

- 新测试配置未写空 state.json 时会触发旧品牌迁移，异步启动恢复可能覆盖当前夹具。测试宿主现预建空配置并等待 boot 完成。
- Windows 空剪贴板可能返回不含 MIME 类型的项目。测试保存剪贴板时保留全部可读格式并正确处理空项目。
- 旧剪切测试直接选择隐藏公式源码；现先点击公式并断言源码可见，再保留精确删除及撤销断言。
- 源码文首的光标从 PRE@0 规范化为首个文本节点@0，旧测试误以为位置改变。现比较实际源位置，并增加真实输入及撤销验证；这一步发现了上述快速撤销问题。
- 旧教材/媒体复现脚本从输出目录读取夹具；现明确读取静态输入并把所有修改写到本轮独立副本。
- 一次补全测试与尚未退出的菜单测试有短暂重叠，该补全记录不作为验收；已单独重跑通过。任务启动器增加活动进程锁，避免再次同时启动两个桌面套件。

仍须完成：剩余源码回归、对新增产品改动重跑相关核心矩阵、逐项映射 16 基础/48 边缘工作流程与补缺、最终私版 1.0.0 打包、EXE/VSIX 全部文件核对、最终包回归和人工复核。当前记录不是交付报告。

继续补测记录（北京时间 20:45）：

- `source-history-1788870436310`：新增的完整 24 项已通过，包括大文件重做和再次撤销、6 项 diff/patch 双向还原。150002 / 900002 字符原生撤销实测约 145.6 / 99.0 ms；直接构造的 200000 字符 diff+patch_apply 压力用例仍可达约 8 秒，不能把原生用例成绩推广到所有差异计算。
- `vscode-full-1788870036055`：源码 IDE 全量 150 项通过。
- `math-table-1788870500692`：68 案例、1216 步、IR/WYS 各 50 轮通过。该次在下面两处新补缺修复之前，后续还须验证其影响。
- 新增 `release100-workflow-gaps.cjs`，第一次执行发现 IR 跨段加粗会合并段落，以及单格 TSV/竖线文本粘贴会覆盖邻格。保留失败运行 `workflow-gaps-1788870840127` 等目录。
- `edit-shortcuts.js` 现在对跨块 IR 加粗分别处理选区中的各段/格，保留块边界，支持取消和完整历史。`media-tools.js` 现在将单格纯文本粘贴中的换行、竖线保留为单元格内容；数学源码、HTML 和图片仍使用各自处理入口。备份为 `edit-shortcuts-before-multiblock.js`、`media-tools-before-cell-paste.js`。
- `workflow-gaps-1788871403835`：完整 47 项通过，覆盖同名中文/空格/emoji 路径，取消/保存/放弃分支，保存失败后重试及快照记录，首末行列，正反向 Unicode 跨段加粗/取消/历史，多级列表按键，重复单元格，TSV/特殊字符粘贴及重开，Office HTML 表格粘贴，窄窗宽表末列菜单。错误及资源错误均为空。源码模式末尾空行的原生规范化单独记录；段落边界和其他字符严格比较。
- `.perf/release100-background-workflow`：当前代码 245/245 Node、70 语法、479 共享文件一致、4 公版产物哈希不变。
- `.perf/release100-pdf-qa`：普通导出 PDF 两页均已查看；96 页教材查看 1、2、21、32、35、49、96 页，未见抽查页面重叠/黑块。教材部分跨行单美元公式显示源码，当前 HTML 与之前导出逐字节相同（SHA256 `cc8896c1c69a82e230c5af92c7a8fbee4eceb2bcfdd0a6b0139b9322473ce6dc`），是既有行为；Word 的 138 处源码回退也与此前相同。未声称 96 页均已人工查看或所有公式都成功渲染。

当前仍未打包 1.0.0；无最终交付结论。后续以当前源哈希的相关回归、64 项流程证据、最终包及人工复核为准。

继续补测记录（北京时间 21:11）：

- `workflow-gaps-1788872139101` 扩至 51 项，通过真实中文组合输入时的公式键保护，以及鼠标点击源码按钮后的提交/取消；两种视觉模式均通过。
- `completion-1788872391305` 增加三种模式的表格内公式补全，旁边保留竖线公式与矩阵，精确核对撤销/重做/磁盘；26 项通过。
- `file-launch-1788872221013` 的异常来自测试等待探针在编辑器完成初始化前调用 getValue。三个探针现先检查已完成补丁初始化；重跑 `file-launch-1788872262169` 的 8 种启动场景、30 项检查与异常捕获通过。
- 当前非粘贴回归通过：`nested-math-1788871516234`、`viewflow-1788871651449`、`navigation-1788871831924`、`selection-1788871911124`、`regression-1788871925527`、`features-1788871997651`、`repairs-1788872084053`、`protection-1788872513321`、`consistency-1788872524808`、`user-file-host-1788872545589`。
- 空公式联合粘贴补测 `workflow-gaps-1788872679400` 发现新普通格保护会先于 WYS 空公式处理，生成不正确的公式源码。只改一行，将普通格 paste 捕获器从 document 移到已注册数学处理器之后的编辑器根节点。`workflow-gaps-1788872754569` 完整 53 项通过，错误为空；`.perf/release100-background-final` 再次 245/245、70 语法、479 同源、公版哈希通过。
- 修改前完整产品哈希清单为 `.perf/release100-source-revisions/before-math-paste-order.json`。`scripts/release100-coverage.cjs` 逐字节证明仅两个同源副本的上述一行注册顺序不同，允许明确列举的非粘贴流程复用已通过记录，并在证据中标注兼容条件；普通/数学粘贴、剪贴板宿主等流程要求当前代码重跑。没有把任意旧版本报告算作当前通过。
- 64 项覆盖映射现位于 `.perf/release100-delivery/coverage.json`，列出各流程实际依据、缺少的当前回归和人工/产物证据。未完成的流程保留 pending，不以脚本存在或断言总数代替验收。
- 人工测试输入 `.perf/release100-manual-fixtures/概率论-人工复核副本.md` 保留最新笔记完整前缀，另附隔离的窄表/长公式测试段。尚未执行当前最终包人工操作。

继续补测及候选包记录（北京时间 21:30）：

- 当前代码的 `math-table-1788872863091` 通过 68 案例、1216 步、两种视觉模式各 50 轮；菜单宿主、shell、公式历史/配色、阅读、UI、大文件边界与历史回归均通过。
- `table-input-host-1788873459846` 暴露旧测试的弱断言：按单元格宽度点击却假定追加顺序 HJKL，且单字母可误匹配图片编码。测试改为先滚动到目标格并断言实际光标，逐字检查目标格长度和所有邻格，保存前等待完整渲染文本到达宿主，精确比较图片展开后的磁盘字节。加强版 `table-input-host-1788873614158` 通过；产品代码未为此改动。
- `source-history-1788873626581` 完整 24 项通过，150002 / 900002 字符原生撤销实测约 104.4 / 103.0 ms；200000 字符人工差异压力用例仍约 7.6 秒，保留限定说明。
- 版本元数据备份至 `.backups/2026-09-08-release100/version-before-1.0.0`，私版 app / VSIX 清单版本均为 1.0.0。只运行默认私版 pack.py 和私版 Electron 构建。
- `.perf/release100-delivery/coherence.json` 验证 479 共享文件、14 扩展宿主文件及全部 app 文件在源码/包内一致，4 个公版产物哈希不变。校验脚本的 ASAR 查询路径已改为 Windows 原生 path.join；这是校验器修正，包内文件原本存在。
- 最终 ASAR 的 media-office、export、media-lifecycle 已通过；导出 PDF 两页实际查看均清晰，E42 记录在 manual-acceptance.json。Word 教材 138 处既有源码回退、未运行原生 Office COM 等限制保留。
- 最终 VSIX 解包至 `D:/BuyKey/Typora-Editor/test/.runs/vsix-private-1.0.0-final/extension`，当前真实 IDE 全量回归继续中，人工操作尚待。


继续人工复核记录（北京时间 23:09）：

- 源码人工运行 `release100-manual-source-1788878956217` 未通过验收，保留 manual-status.json 和逐步证据。RN 公式取消/撤销/直接续写及末格撤销位置已通过，仍有两处必须修复。
- WYS 撤销后公式异步重排，光标仍在正确末格，但行底部落到视口之外（610.744 > 592.857）；直接续写仍被裁切。
- WYS 切到分屏后，首格 `首格<br />第二行` 变成 `首格第二行`。Lute 的 SV 表格 DOM 将原始 HTML 当作 DOM 解释，不能通过只比较视觉结果验收。
- 该运行应用 JavaScript 错误数为 0，原始人工输入夹具哈希未变；只修改隔离副本。v1/v2 候选包均不交付。


补测及修复记录（北京时间 23:27）：

- `history-selection.js` 增加限时的撤销选区可视保护：公式重排后的布局合并到动画帧检查，新的键盘/鼠标/滚动/组合输入、选区变更、模式切换及销毁均停止。恢复后的视口不再持续追随用户。
- `scripts/patch-lute-sv-table.cjs` 将 Lute 1.7.6 SV 表格节点的原始 Tokens 输出改为已有 EscapeHTML 路径；生成的换行标记不变。依据 [对应版本源码](https://github.com/88250/lute/blob/v1.7.6/render/vditor_sv_renderer.go)。备份 `lute-before-sv-table.min.js`。
- `.perf/release100-background-render-roundtrip`：265/265 Node 测试、71 语法、480 共享文件一致、4 公版哈希未变。新增 20 项检查覆盖重排跟随的取消/合并/销毁与表格 HTML、实体、代码和数学符号。
- `workflow-gaps-1788881118425`：8 项真实宿主的 IR/WYS × 模式菜单/源码按钮 × 原笔记/混合 HTML 往返全部通过，含原生源码续写、撤销/重做、保存和重开。JS 与资源错误均为空。模式序列化只单独归一化表格填充空格、表格前空行和末尾空行；格内非填充字符及周围内容比较，源码输入和磁盘另做精确字节比较。
- `workflow-gaps-1788881196910`：真实笔记的两模式 × 普通/窄窗缩放 4 项可视撤销通过。首次测试坐标遗漏宿主缩放、且错误地把视图补空格等同正文更改，保留失败报告并修正工具，未为此修改产品。
- 完整工作流现扩至 133 项，尚待全量当前版本重跑与实际包人工验收。


视口人工诊断及回归加强（北京时间 23:39）：

- `release100-manual-source-1788881328451` 重新用可见窗口复现了相同 627×593 内容视口、米色、两级原生放大、初始 scrollTop=7323.333。第一版跟随只能让光标行进入视野，普通末格底边仍被裁切，表格工具条的旧 data-top=7755 还遮住末行。此次人工状态判定 changes-required。应用错误为 0、输入夹具未变、末格已还原。
- 进一步修复：普通高度单元格完整保留在可视区；高度超过视口的单元格只跟随光标行。WYS 表格工具条同步原有定位公式的 data-top、top 和 left，避免公式异步重排后沿用旧位置。工具条不进入正文快照。
- `workflow-gaps-1788881859038` 加强后的 4 项当前源码全部通过。对旧 v2 ASAR 的负对照 `release100-negative-control/workflow-gaps-1788881919793` 明确复现 2 项失败：普通窗工具条遮挡、窄窗末格越界。更早负对照 1788881238788 仅检光标的 4 项均通过，因此已废弃旧判定作为本问题证据。
- 新增大于视口单元格和旧工具条位置的 Node 边界检查。当前可视保护含 11 项 Node 检查；完整工作流 133 项正在运行，最终包人工复核尚待。


当前候选包记录（北京时间 23:45）：

- `workflow-gaps-1788881998231`：完整 133/133 通过，应用 JS 和资源错误均为空。新增普通/缩放窄窗、旧历史后续写、公式边界输入、中文组合输入、取消、往返与精确保存等全部纳入。
- `.perf/release100-background-table-viewport-final`：267/267 Node、71 语法、480 同源、公版哈希通过。原始笔记仍为 19246 字节，SHA256 `6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7`。
- 新建 `dist/release-1.0.0-private-final-v3`；EXE / VSIX / 源码 480 渲染文件、14 扩展宿主文件及全部 app 文件核对通过，详见 `.perf/release100-delivery/v3/coherence.json`。VSIX 解包 503 文件至 `vsix-private-1.0.0-final-v3/extension` 后再次逐文件核对。SHA256SUMS.txt 随候选包保存。
- 本候选包尚未验收或交付；当前继续最终包的全量回归与真实 IDE / 可见窗口人工操作。v1/v2 保留作失败对照，均不交付。


额外内容保留问题（后续源码修复）：

- v3 的 math-table（68 案例、两模式各 50 轮）、nested-math（24 案例）和 math-history 均通过。但混合源码检查发现独立的底层数据改写：代码块、块数学、HTML 块中的字面 `&amp;` 等实体在转回 Markdown 时被二次解码。此前的初始视觉基线把该改写计入了基线，现增加对原始输入的断言。v3 不进入最终验收。
- `scripts/patch-lute-source-entities.cjs` 只在两个 Vditor DOM→AST 清理入口跳过已由 HTML 解析器解码过的三种块类型（9、15、302）的第二次解码；其他节点合并/清理逻辑不变。依据 [IR 源码](https://github.com/88250/lute/blob/v1.7.6/vditor_ir.go) 与 [WYS 源码](https://github.com/88250/lute/blob/v1.7.6/vditor_wysiwyg.go)。备份 `lute-before-source-entities.min.js`。
- 新增 24 项 Node 检查：10 种语言 × 两模式、重复 Spin/序列化，块数学、HTML 块、行内和表格相邻内容；加上已有 Lute 检查共 40 项已通过。真实宿主新增四项块源码点击/续写/历史，并强化八项混合内容的初始原文断言，当前完整工作流为 137 项，正进行定向验证。

v4 源码与实际便携版复核（北京时间 2026-09-09 00:26）：

- `workflow-gaps-1788883348088` 完整 137/137 通过，应用 JavaScript 与资源错误数组均为空。`.perf/release100-background-source-entities-final` 为 291/291 Node、71 语法、480 同源文件、4 公版哈希通过，测试开始与结束的全部产品文件指纹一致。
- v4 私版候选包保存在 `dist/release-1.0.0-private-final-v4`，同源报告 `.perf/release100-delivery/v4/coherence.json`。尚未完成剩余 IDE 和全量最终包回归，不能据此交付。
- 实际 portable 人工运行 `.perf/release100-manual-exe-1788883646022` 已完成，运行时提取 ASAR SHA256 与 v4 完全一致。RN 公式取消/撤销/直接 q/撤销精确恢复，邻接公式保持渲染；实际放大两级、754 px 窄窗的 WYS 末格删除/撤销/中文替换/撤销通过，完整格底 574.554 小于视口底 592.857，工具条在表格上方。
- 分式/矩阵展开后切到邻格即时收起。分屏保留字面 `首格<br />第二行` 和两行渲染；左右拖动分隔线、两侧交替滚动不改变源码。返回 WYS、保存并通过工具栏重新加载文件，源码及磁盘 SHA256 均为 `301df4a799326b704beec5f4858c3757abb031ba7382c240e66177f70ecf0291`，与同模式操作前基线一致。
- 该可见便携版运行无 JavaScript 异常，原始笔记与人工输入夹具哈希未变。有 5 条原笔记外链 Wikimedia 图片的 `ERR_CONNECTION_RESET`，单独保留为网络资源问题，不计作 JavaScript 异常，也不声称网络资源全部加载成功。`manual-status.json` 已记录实际行为和边界。

v4 最终包回归进度（北京时间 00:30）：

- `math-table-1788884550112` 68/68 案例、1216 交互步骤通过，IR/WYS 各 50 轮混合编辑。两个结束 PNG 已目视检查，表格保留渲染，WYS 表格工具条位于表格上方。
- `vscode-full-1788884816382` 对 v4 提取 VSIX 在真实 VS Code 完成 150/150，webview-errors 与 unhandled-errors 均为空。Trae 与其他最终版本回归继续中。

真实 IDE 与窗口工具边界（北京时间 00:37）：

- `trae-full-1788885001082` 最终 v4 VSIX 完成 150/150，webview-errors 和 unhandled-errors 均为空。
- `vscode-focus-1788885187522` 自动焦点 29 项进入 MANUAL_READY，但 @oai/sky 对准确返回的 VS Code 窗口始终报 `window id 28447026 no longer belongs to Microsoft.VisualStudioCode; current owner is Microsoft.VisualStudioCode`。刷新应用/窗口、get_window 和重建 JS 会话仍失败，未注入任何人工输入。
- 该次 hold 运行保存 tool-window-binding-failure，未计为人工或最终焦点通过。仅关闭经 profile 路径和可执行文件核对的测试进程；其他应用未操作。保留为待复核项，继续独立的最终版测试。
