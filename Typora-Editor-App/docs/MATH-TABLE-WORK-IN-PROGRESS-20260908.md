# 2026-09-08 私版公式与表格修复（历史工作记录，已完成验收）

最终验收已于 2026-09-08 完成，以 [最终报告](D:/BuyKey/Typora-Editor-App/docs/CHANGE-REPORT-PRIVATE-MATH-TABLE-1.0.16.md) 为准。以下各时间段是开发过程记录，旧候选包、旧哈希和“待完成”状态均已被最终报告覆盖。

- 最终 11:38 私版：EXE 1.0.16 / VSIX 0.1.26-local。475 个渲染文件在共同源码、App 源码、最终 ASAR 和最终 VSIX 中逐文件一致；公版四个产物、用户原笔记哈希不变。
- 最终 ASAR：`.perf/math-table-accepted-v2`，68/68 场景、888 次逐步检查通过，无 JavaScript 或 preload 异常。
- 最终 VSIX：`D:/BuyKey/Typora-Editor/test/.runs/vscode-1788838782686`，116/116 通过，`unhandled-errors.json` 为空。
- 最终 portable：`.perf/math-table-manual-exe-1788839382176`，7 项可见检查、约 10 分钟运行，退出码 0、JavaScript 异常 0。实际运行的 ASAR 哈希与交付包完全一致；全部操作均在笔记副本进行。
- 最终产物和验收入口：`.perf/math-table-delivery/accepted.json`、`coherence.json`。相关测试窗口已经关闭，报告包含逐项结果、截图和可点击产物链接。

用户要求：基于 9 月 8 日最新私版 1.0.15 EXE / 0.1.25-local VSIX，只改私版；以指定概率论笔记副本做充分模拟人工交互和饱和回归。用户特别提醒 JavaScript 经常报错，必须捕获并解决，禁止将异常算通过。

工作目录不是 Git 仓库。共用源码为 `D:/BuyKey/Typora-Editor/extension-src/render`，用 `node scripts/sync-renderer.mjs` 同步 EXE 工程的 `app/renderer`，不手改后者。未使用子代理。

原始文件在 `.backups/2026-09-08-math-table/user-note-original.md`，同目录保留修改前四个源码文件。原文件只读，含四张表：第一张 6 列，第二张 11 列，第三张只有表头并含三个 `<br />`，第四张为文末对照表。测试基准采用此固定副本，避免原笔记被用户后续编辑影响。

已观察与修复：

- 快捷键没有取消分支；旧版第二次按下会堆叠美元符号。
- 旧光标恢复按字符串全局查找，重复/空公式会跳往其他表格，并有多个无条件延迟回调。
- 旧版表格公式输入 `|` 会被 Vditor 当作表格分隔/导航，`$` 会提前结束公式。
- 源码折叠以块为单位，切换单元格后会残留预览。
- 表格 `<br />` 变成 HTML 源码编辑组件。
- WYSIWYG 空公式的 DOM 序列化会触发 Lute nil pointer；改用原生空 `$$` 占位并处理跨文本节点的取消；删除到空同样转换。
- WYSIWYG 快速离开公式后行内代码快捷键会使用过时的工具栏状态，已按实际选区同步。

新增共用 `math-edit.js`：局部 DOM 事务，显式包装/解包，原地光标；公式内部捕获普通按键与 input/paste 保留 TeX，不让通用 Markdown 路径拆表；通知宿主并保留历史。跨单元格/段落分别处理，不删除结构。监听选区、指针、焦点收起旧公式。`math-markdown.js` 对 IR parser 返回的表内 br 源码组件规范为真实 BR。`index.css` 给空公式最小光标盒。

测试设施：

- `scripts/run-math-table.mjs` → `math-table-runner.cjs` → `math-table-matrix.cjs`，实际 EXE 主进程/preload/iframe/宿主保存。原生 sendInputEvent 逐字符键入，真实鼠标，inputText 模拟组合输入；每步检查表结构、光标与渲染 JS 异常，保存失败截图/trace。env `MATH_TABLE_OUTPUT` 指定输出；`MATH_TABLE_CASES` 可选正则过滤；`MATH_TABLE_HOLD=1` 保留窗口及 manual-observation.md 供 Computer Use。
- `math-table-before3` 是可靠的旧版基线，12 场景 9 失败，保存错误堆栈（含真实 Lute 异常）。before/before2 早期日志包含测试启动 stdout EPIPE 和滚动定位缺陷，不可当作产品结果。
- EPIPE 测试工具问题已解决：Node 包装启动、日志落 run.log、uncaught/rejection 记录 fatal.txt 后失败退出，不反复弹窗。Computer Use 已确认旧窗口清理，已读完 Computer Use skill/guidance/api/confirmations，已初始化 sky；后续继续使用 node_repl 的 sky。
- `math-table-expanded2` 50 场景 471 事件，3 失败：两个是源码视图空行标准化的过严格中途断言（修改为最终返回视觉视图源文本必须精确不变）；另一个 WYS 快速开关暴露跨文本/元素光标问题，已修。
- `math-table-targeted3` 12/12 通过：快速30次、源码往返、Enter、选部分公式取消、跨单元格、跨段落（每种视觉模式）。
- 目前运行 `.perf/math-table-full-dev`（exec session 20791），完整58场景。运行期间不可再次 sync 渲染器，防止不同用例加载不同源码。
- 既有 `features` 回归已通过65项（输出 `.perf/features.json` 的实际计数为准）。测试的空公式光标断言更新为源码内而非强制文本美元标记。暂留失败诊断变量 `__codeShortcutDebug`，交付前可清理。
- `node --test scripts/math-markdown.test.cjs` 当前22通过1失败：旧测试要求 SpinVditorIRDOM 函数身份不变，因新增 br 规范需改为语义不变+表格换行正确验证，而非去掉检查。
- 新增 `D:/BuyKey/Typora-Editor/test/math-table-suite.cjs`，接入 vscode-smoke.cjs。运行真实 VS Code Webview 与可信按键，含IR/WYS/SV取消、特殊LaTeX逐字输入、同表切换、TextDocument/磁盘保存重开、重复公式快速开关。尚未运行。

尚需完成：

1. 收敛 full-dev 失败，补源码SV和渲染预览选区/剪贴板换行/表格结构等边界；检查 source持久化，invalid TeX 不应破坏表结构。
2. 清理代码和诊断、扩大已有数学/历史/表格/宿主回归，不要沿用旧报告的通过数。
3. Computer Use 真实可视操作并截图验证用户4种现象，仅在测试副本上。node_repl globalThis.sky 已初始化，窗口需重新 list_windows；前次测试均已退出。
4. 更新私版版本（建议 EXE 1.0.16，VSIX 0.1.26-local，尚未执行），保留旧包和公版。打包 `electron-builder --win nsis portable --config.directories.output=dist/release-1.0.16-private-final`；VSIX用 pack.py 默认private，更新extension-src/package.json与vsix-meta/extension.vsixmanifest版本。Code.exe 已知路径 `D:/Program Files/Microsoft VS Code/Code.exe`。
5. 对最终ASAR再跑完整矩阵/必要宿主回归，对最终VSIX解包隔离跑 vscode-smoke，逐文件哈希确认两端同源并公版不变；产物哈希/测试报告/证据链接。
6. 不得提前把goal标完成；用户明确要充分测试后交付。

## 10:39 更新（前文的“当前运行”已过时）

- `.perf/math-table-full-dev` 58/58、514事件通过；随后发现块级公式兼容回归，已将输入保护与折叠收敛到行内公式（Ctrl+Shift+E新增的类型），块级公式使用既有路径。支持Ctrl+Shift+E移除已有块公式不受影响。
- 12组既有回归全部通过：math-history、math-colors、math-boundaries、regression、consistency、repairs、ui、table-context、table-context-host、table-input-host、source-toggle-host、shell。详情 `.perf/math-table-regressions/results-math-history-math-colors-math-boundaries-regression-consistency-repairs-ui-table-context-table-context-host-table-input-host-source-toggle-host-shell.json`。
- 单元测试23/23通过；features测试65项通过。sourceToggle已支持跨高亮文本节点的SV取消，选中渲染预览也能取消公式。
- 真VS Code完整smoke从源码运行通过，输出 `D:/BuyKey/Typora-Editor/test/.runs/vscode-1788834613608`。这是开发阶段结果，不能替代最终VSIX包验证。
- 针对“保存后重开”继续强化后发现形状不变仍可能丢邻格：裸 `|` 会在GFM重解析时拆格。现在表内公式输入裸竖线规范成数学意义相同的 `\vert{}`，不使用语义不同的 `\|`；行内公式粘贴换行规范成空格。测试重开比较每一个单元格源码内容（仅忽略Markdown单元格外侧padding），防止只检查行列数的假通过。
- `.perf/math-table-boundary-soak` 的IR/WYS连续24轮序列均通过；发现WYS空 `$$` 占位直接粘贴带裸竖线/换行会拆表，已为占位状态添加beforeinput与paste事务处理。现在正在跑完整 `.perf/math-table-final-dev`（session 93763），62场景（58+2个24轮连续序列+2个多行粘贴重开）。源码与app渲染器已同步到这一修复。
- 版本已更新：App1.0.16 / VSIX0.1.26-local；原元数据已备份。App candidate 已构建在 `dist/release-1.0.16-private-final`，VSIX已在 `D:/BuyKey/Typora-Editor/dist/marcopilot-0.1.26-local.vsix`，但这两个候选包都早于最后的空占位粘贴修复，必须重新打包。解包目录 `D:/BuyKey/Typora-Editor/test/.runs/vsix-private-0.1.26-math-table` 也需更新或用新目录。
- 公版4个产物SHA保存在 `.perf/math-table-delivery/public-before.json`，必须最终验证一致。原用户文件未修改。
- 下一步：收取final-dev，检查失败；重打App/VSIX，完整矩阵跑最终ASAR（runner第二参数为ASAR绝对路径）；最终VSIX解包运行vscode-smoke（包含强化内容断言）；ComputerUse视觉验证；报告/哈希/交付。程序日志run.log、fatal.txt、renderer-errors.log都用于验收，不弹JS报错窗。

## 11:27 最终收尾状态（以上运行编号均为历史）

- 最新最终包生成于 11:16：App 1.0.16 / VSIX 0.1.26-local，目录仍是 release-1.0.16-private-final 和 Typora-Editor/dist，最终 VSIX 解包在 test/.runs/vsix-private-0.1.26-math-table-final/extension。
- 手工验收发现末行预览裁切，先改占位布局后又发现闭合美元符号落在预览下方。最终 CSS 使用三列、两行 inline-grid，让完整源码在第一行、预览在第二行；新增几何检查同时约束预览不越界、首尾美元符号和源码同一行。开发定向 6 场景通过，截图已检查；数学历史和明暗配色回归再跑均通过。源码注释同步清理，475 文件与包 SHA 一致。
- 真实最终 portable EXE 已完成 Computer Use 手工操作：表格公式输入、同表换格、重入取消；正文中文 Shift+Home 选择后两次快捷键；含三个 br 的表头点击和键入；WYSIWYG 空公式输入、同表换格与取消。9 张截图与 manual-verified.json 位于 .perf/math-table-manual-exe-1788837425315。portable 解出的实际 ASAR SHA 已和最终包核对。窗口已保存测试副本并关闭，启动器 exit 0，runtimeErrorCount=0。
- 原生 Chromium 启动日志也已保留，KaTeX 中文 warn 与外部 Wikimedia 图片连接重置分开记录，不属于 JS 异常。曾发现调试器在空白窗口尚未提交时 Runtime.enable 会触发 Electron startupData 空值；延迟至真实文档完成初始化后，对照重测无此错误。未改变产品权限或屏蔽错误。矩阵现从窗口创建开始监听 console/preload，初始化完成后再用 CDP 抓 error 和异常。
- 当前运行最终完整 66 场景矩阵，输出 .perf/math-table-accepted-final，exec session 95450。不要重打包或改渲染源码。较早的 math-table-accepted-packaged 虽 66/66、878 事件通过，但早于最后的 inline-grid，不能替代本次最终结果。
- 最终 VSIX 上次 116 检查虽通过，但测试用 completion-suite.cjs 的模拟 HTTP 服务遇到被取消的空请求出现未处理 JSON.parse 异常。已修模拟服务以返回 400/处理断连，并在 vscode-smoke 增加 unhandledRejection 阻断验收。必须在当前矩阵结束后，再跑一次最终 VSIX，获得 results.json 和空 unhandled-errors.json。
- 最新同源/原文件/公版哈希清单：.perf/math-table-delivery/coherence.json。Setup SHA 98ee397a7950a15f399d14d20ad65d4194e202edc0a24769853fca4c4ff3126a；portable ef9077e1bd3c25cfecb2c95210f8b6a6408435edba63eacec63f1c40c879d866；ASAR ae5008b62d96fd80756895df1655de628525269197c9ec7f121ab9019adb4f5e；VSIX 3ca0e993e90b119f10dad58e1e333df8f53262ce886a3f7a5e0aac269aa664c6。
- scripts/write-math-table-report.cjs 已写好，调用参数依次为最新手工输出目录、最终 VS Code 输出目录。它要求 66 场景通过、无 fatal/renderer-error、VSIX 未处理异常为 []、手工 exit0/JS0/verified，并生成 docs/CHANGE-REPORT-PRIVATE-MATH-TABLE-1.0.16.md 和 .perf/math-table-delivery/accepted.json。
- 剩余：收取最终矩阵；串行跑最终 VSIX（路径同上）；可再用 test-packaged-launch.mjs 对最终 win-unpacked EXE 跑 6 项真实启动/保存（前次早于最后 CSS，必要性低但仅 3 秒）；最终哈希复核并生成报告，检查链接与源文件未改；goal 标完成，中文简洁交付安装包/portable/VSIX和报告。不要再重复已通过的开发回归或扩充无关范围。

## 11:35 删空回归截获与修复，覆盖上方“最终包”状态

- .perf/math-table-accepted-final 实际 66 场景有 1 个真实失败：ir-delete-empty-formula。inline-grid 使 Chromium 删掉最后一个字符后在 code 内留下 BR，IR commit 未清理它，序列化变成 `$\n$`，后续键入拆出一行。失败诊断已保留；不能交付 11:16 的包。
- 已修改共用 math-edit.js：所有模式删空后立即替换为普通 $$ 占位；空占位或空 rich math 内 Backspace/Delete 都调用局部取消事务删除完整边界；共用 queueUndo 保留历史。emptyPairAt 排除字面 code，避免普通代码中的 $$ 被误判为公式占位。
- 定向 8/8、64 事件通过，输出 .perf/math-table-empty-deletion-fixed。新增每模式的 empty-math-forward-delete，并强化 delete-empty-formula，要求第二次退格后只剩 s、保存重解析逐格不变。
- 当前正在跑开发完整 68 场景，.perf/math-table-complete-dev，session 6042（目前 IR 普通场景全过）。源码与 App renderer 已同步。不应在这个运行期间 sync。
- 本次完整开发矩阵通过后，再打 App/VSIX，并跑最终 ASAR 到 .perf/math-table-accepted-v2（新目录避免混合旧失败日志）。最终 VSIX 仍须一次干净 116 检查和空 unhandled-errors.json。必要时最后的删除相关历史回归再跑，但不要扩充无关范围。
- report 生成器已改为要求 accepted-v2、68 场景，参数仍为手工输出目录和最终 VS Code 输出目录。交付前必须给最终新 portable 做删空/再输入可见复核，保存新 manual-verified.json 和相同 ASAR 哈希；此前 9 张人工截图是 11:16 候选包证据，应作为补充，不能冒充新包。

## 11:43 打包与验收进展

- .perf/math-table-complete-dev 68/68、888 次检查通过（03:37:14 UTC），无 renderer/fatal 错误。随后 features 和 math-history 再跑通过。
- 已重新打包，最终当前包时间为 11:38。coherence.json 已更新：Setup 1e958ade5ca50b7cf9209510006a9fe8d93432cfc476fd798239ae81de0b0f0d，portable d17f577b4698153f7256dec5db9a178c0acef1bff17cd857db555432769ab536，ASAR 41f083d91fcbecb02fbf47365e2963835642beb3cf34ac43369e1072df89e22d，VSIX a40c2873f0a574d82e7a7243484aa4b174f2df2867e3897d246117f7437243cb；475 文件一致、公版/原文不变。
- 正在跑最终 VSIX，session 69372，输出 D:/BuyKey/Typora-Editor/test/.runs/vscode-1788838782686。目前数学表格和三模式全部通过，在补全异常回归阶段；要求最后 results.json 116 项且 unhandled-errors.json 为 []。
- 待本 VSIX 完成后，串行跑最终 ASAR 全部68场景到 .perf/math-table-accepted-v2，然后 final portable 人工删空/再次删除/重新输入及至少换格和取消复核。新报告生成器还核对 manual-verified 的 sha256 必须等于最后 ASAR，并且矩阵 metadata.application 必须是最终 ASAR 路径。
- 无产品源码工作未完成，不要再做无证据扩展；只有最终包测试出现真实失败才继续改产品。剩余结果/人工补充/报告/goal完成。
