# 私版 1.0.0 交接：先解决边界测试失败，再验收

更新时间：2026-09-09，北京时间约 00:57。用户因 token 额度不足要求立即交接。本轮停止，不再启动测试。

## 0. 先读这几条

- **任务没有完成，v4 是候选包，不能宣称全量通过或直接交付。**
- 当前覆盖报告：64 个工作流，16 基础、48 边缘（25% / 75%）；**52 项证据就绪**。8 个测试任务未完成，另有 B12、E48 人工/产物验收缺口。
- **最新真实失败：`quality-boundaries` 在 150000 字符边界输入时，`z` 落到了源偏移 358，而非尾部 ENDTOKEN。** 还没有确定是产品缺陷还是测试定位与异步恢复竞争。不要增加等待超时、删除断言或直接重跑到绿就算修好。
- 没有已知仍在运行的测试。最后失败任务已退出，`.perf/release100-gui-active.json` 不存在。所有旧命令 session 均已收尾。
- 用户要求：继续时自主完成；**用户打断就立即暂停**。一次只能运行一个 GUI 测试。不要启动测试队列、不要多开 IDE/EXE 并行测试。
- **不要启动子代理。** 当前开发者明确禁止主动委派。
- 只处理私版。**公版不改、原始笔记不改**。所有输入和保存只用隔离副本。

## 1. 用户目标与工作目录

原始问题：Ctrl+Shift+E 在表格内使表格退回源码；移到另一格时公式预渲染不收起；取消公式破坏正文/表格格式；加粗等格式附近点击公式导致后面公式一起露出源码并变黑；经常 JS 报错。

后续已接受目标：Alt+U 将选区放入 IDE 原生 AI 侧栏后，焦点停在 AI 输入框；最后做性能调整和 25% 基础 / 75% 边缘的饱和测试，完成私版版本 1.0.0。

- 当前项目：`D:\BuyKey\Typora-Editor-App`
- **权威渲染源码**：`D:\BuyKey\Typora-Editor\extension-src\render`
- 桌面渲染副本：`D:\BuyKey\Typora-Editor-App\app\renderer`
- 扩展宿主：`D:\BuyKey\Typora-Editor\extension-src\out`
- 修改渲染代码必须先改权威目录，然后在当前项目执行 `node scripts/sync-renderer.mjs`。当前共享渲染文件 480 个。
- 本环境 PowerShell；无限制文件权限，approval=never，**不要传 sandbox_permissions**。
- 前人未发现 Git 或 AGENTS.md。不要假定可以 git diff/reset。
- 不要使用 `$HOME`、`$home` 或 `$CODEX_HOME` 作临时变量。

原始笔记：`D:\Users\Ming\Desktop\实用经济与金融理论\1-重识概率论.md`

它仍为 19246 字节，SHA256：
`6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7`

当前原文有 3 张表、28 个单元格，形状 `[[6,6,6],[2],[2,2,2,2]]`。旧测试夹具包含另一份 11 列复杂表，不要混淆。

## 2. 候选包与不能碰的旧版本

**当前 v4**：`D:\BuyKey\Typora-Editor-App\dist\release-1.0.0-private-final-v4`

| 文件 | SHA256 |
|---|---|
| marcopilot-Setup-1.0.0.exe | 23b0fb82a5a791c829dbe290621c494a9b6626271424fcbcfdb8b6bc34dba367 |
| marcopilot-v1.0.0-portable.exe | 5ba02aa002a558037c57f8afa30348cf97a3295dbe7296724c8bdb81e3840fb3 |
| win-unpacked/resources/app.asar | dcb75b3768c2055fe8699a134aff474754967a47c356ed43ac2498ac81af982e |
| marcopilot-1.0.0.vsix | 6287ceadf7a5405c0fa6da39a897b2a1e8476094791036c9e5b28ec376c8f8cc |

v4 VSIX 已提取至：
`D:\BuyKey\Typora-Editor\test\.runs\vsix-private-1.0.0-final-v4\extension`

同源核对：`.perf/release100-delivery/v4/coherence.json`，480 渲染文件、14 扩展宿主文件、全部 app 文件及公版哈希已核对。

`release-1.0.0-private-final`、`...-v2`、`...-v3` 都是**保留的拒收候选/负对照**，不要删、不要交付、不要把其测试当成当前版本。若又改产品，生成新 v5，不能覆盖 v4。

## 3. 已完成的产品修复（现在不要再重做）

1. `render/js/history-selection.js` + `typora-patches.js`：撤销/重做选区书签、正确恢复表格/公式位置；公式异步重排时限时跟随；普通单元格完整可见；高于视口的格只跟随光标行；WYS 表格工具条按新表格位置重定位。新输入、指针、滚轮、IME、选区变化、模式变化、失焦、销毁会停止跟随。
2. `math-edit.js`：IR 数学代码边界输入移入 CODE，中文组合输入提交/取消、粘贴与预渲染焦点收起。
3. `scripts/patch-lute-sv-table.cjs`：Lute SV 表格原始 Tokens 经过 EscapeHTML，避免 `<br />` 等源码在切换后丢失。
4. `scripts/patch-lute-source-entities.cjs`：两个 Vditor DOM→AST 清理入口，节点类型 9/15/302（HTML 块、代码块内容、块公式内容）跳过第二次实体解码，保留 `&amp;` / `&lt;` 等字面源内容。不能广泛去掉其他 unescape。
5. 早先修复：Alt+U 原生 AI 焦点（VS Code chat.open/focusInput；Trae 一次选区附件后空 figmaList 聚焦）；分屏缓存与 resize 合帧；长文档历史避免病态 halfMatch；自动链接线性预查；跨段加粗边界；表格粘贴监听顺序。
6. 文件侧栏快捷键改为 Ctrl+Alt+B，避免与原生 Ctrl+Shift+B 冲突。

重要负对照：`.perf/release100-negative-control/workflow-gaps-1788881919793`，旧 v2 明确失败于 WYS 工具条遮挡和窄窗整格越界。更早仅看光标的负对照全部绿，已废弃其判定；必须同时检查格边框与工具条。

备份均在 `.backups/2026-09-08-release100`。详细历程：`docs/RELEASE100-REGRESSION-NOTES-20260908.md`。

## 4. 最新失败：按这个顺序排查

失败目录：
`.perf/release100-final/quality-boundaries-1788886514107`

先读这些小文件：
- `results.json`：初始 150000 长度 / precise 正确；下一项原生编辑超时。
- `fatal.txt`：等待 `vditor.getValue().includes("ENDTOKENz") && vditor.__splitNavigation.source===vditor.getValue()` 失败。
- `failure-state.json`：仍在 SV，quality 已变 blocks，anchor offset=359；source.scrollTop≈17.7，preview.scrollTop≈69.1，位于开头。
- `failure.png`：实际画面也在文档开头。
- `threshold-150000-1.md`：**保存后的长度 150001，`z` 在 index 358，尾部仍是 ENDTOKEN 后两个换行。** 这说明输入确实发生，但位置错了。不是“没打进去”。

对应测试：`scripts/release100-quality-boundaries.cjs` 第 29–44 行。

当前流程：
1. 打开生成的边界文件；校准 SV 换行后长度精确为 150000。
2. IR → source-toggle，等待 splitNavigation.source 等于 getValue。
3. 用脚本 `getSelection().collapse(...__flow.point("source","ENDTOKEN",0,8))` 设置尾部光标。
4. 马上 `win.webContents.insertText('z')`。

**尚未验证的假设**：源码切换后的异步锚点恢复覆盖第 3 步，或单纯脚本设选区没有触发真实用户定位所需的取消事件。不要把该假设当成结论。

建议最小诊断（只改测试工具，暂不改产品）：
- 在输入前后记录焦点、真实选区源偏移、anchor、source/getValue 长度和首尾摘要；不要输出整篇 90 万字。
- 记录 source toggle 后延迟恢复和 selectionchange/keydown/beforeinput 的顺序。
- 用真正的源码点击或原生 Ctrl+End 定位，再断言实际光标确实位于 ENDTOKEN 末尾后输入；不能只修改 DOM 或直接 setValue 冒充用户输入。
- 若真实点击/键盘定位仍被抢回，是产品缺陷，修产品并加负对照；若只脚本设置光标会触发，修测试入口且保留上述失败证据。
- 该组有 150000、150001、900000、900001 四个长度，每组检查初始质量和一字符输入/撤销/重做/保存，共 8 项；要完整通过。

测试公共工具：`scripts/viewflow-suite.cjs`、`scripts/split-navigation-runner.cjs`。runner 使用 Chromium focus emulation，正常测试窗口 showInactive，避免抢用户真实键盘。不要随便改为前台循环。

## 5. 精确执行命令（每次只启动一项）

在 PowerShell，工作目录 `D:\BuyKey\Typora-Editor-App`：

```powershell
$env:RELEASE100_ROOT='D:\BuyKey\Typora-Editor-App\.perf\release100-final'
$env:RELEASE100_ARCHIVE='D:\BuyKey\Typora-Editor-App\dist\release-1.0.0-private-final-v4\win-unpacked\resources\app.asar'
$env:RELEASE100_EXTENSION='D:\BuyKey\Typora-Editor\test\.runs\vsix-private-1.0.0-final-v4\extension'
node scripts/run-release100-task.mjs quality-boundaries
```

每次 exec 是新 shell，**三个环境变量前缀必须每次都带上**，否则会误测源码/旧扩展。`run-release100-task.mjs` 的 live PID guard 会阻止 GUI 并发。不要删除仍活着的 guard。

等待命令 session 完成后检查 `task.json.passed`，失败看 fatal/results，不能只看进程启动成功。用户打断时停止自己测试进程，不能继续下一项。

解决当前失败后，剩余必跑任务（替换上面最后的任务名，一次一个）：

```text
media-office
export
media-lifecycle
reading
ui
benchmark-after
history-large
```

为最终广泛回归还建议跑当前 v4 的 `regression`、`math-boundaries`、`export-large`；前面只在旧候选跑过，不能声称 v4 已跑。

查看最终覆盖：`node scripts/release100-coverage.cjs`

若只改测试脚本、产品字节不变，不必把已过产品回归全重跑。若改任意产品文件，同源打包与相关回归必须更新，coverage 会严格按 7 个产品树哈希排除旧证据，**不要削弱它的检查**。

## 6. 当前 v4 已通过的证据

同名目录均位于 `.perf/release100-final/`，下列已完成不是待办：

| 测试 | 目录后缀 / 结果 |
|---|---|
| math-table | 1788884550112；68 案例 / 1216 步，两模式各 50 轮 |
| vscode-full | 1788884816382；150 项 |
| trae-full | 1788885001082；150 项 |
| vscode-focus（纯自动） | 1788885776218；29 项 |
| trae-focus（含可见人工） | 1788885434161；29 项 + 人工操作 |
| file-launch | 1788885810567 |
| shell | 1788885855665 |
| protection | 1788885903051 |
| user-file-host | 1788885915702 |
| source-history | 1788885951783；24 项 |
| viewflow | 1788885992805 |
| features | 1788886096958 |
| math-history | 1788886133956 |
| consistency | 1788886201143 |
| navigation | 1788886219520 |
| selection | 1788886270463 |
| repairs | 1788886280161 |
| table-context-host | 1788886324104 |
| table-input-host | 1788886334514 |
| nested-math | 1788886348197；24 项 |
| math-colors | 1788886433847 |
| completion | 1788886465797 |

同一当前产品字节的其他证据：
- `.perf/release100-source/workflow-gaps-1788883348088`：完整 **137/137**，runtime-health 的 errors/resourceErrors 都为空。包含原笔记、混合 HTML、块实体、原生输入/历史/保存/重开、窄窗和光标边界。覆盖脚本要求至少 137，不能用旧 133 或定向 12 顶替。
- `.perf/release100-background-source-entities-final`：**291/291 Node、71 语法、480 同源、4 公版哈希**；测试前后全部产品文件指纹一致。
- 两款 IDE full 的 webview-errors / unhandled-errors 均为空。

## 7. 人工复核已做什么、缺什么

### v4 实际 portable 已完成

目录：`.perf/release100-manual-exe-1788883646022`

读 `manual-status.json` 和 `runtime-archive.json`。实际运行时解压 ASAR 与 v4 哈希相同，不是只测源码。

已做：RN 加粗段第一个公式点击 → Ctrl+Shift+E 取消 → Ctrl+Z → 不再点击直接输入 q → Ctrl+Z 精确恢复；邻居公式正常，没有黑块。米色、放大两级、754 px 窄窗（编辑器 627×593）末格删除/撤销/中文续写/撤销；整格和光标可见，表格工具条在表格上方。分式/矩阵展开后点击同表邻格及时收起。分屏双向拖动、两侧滚动；`首格<br />第二行` 源码及两行显示保留。返回 WYS、保存、重新加载，源码和磁盘精确一致。

基线 SHA：IR `15f310c9391e9ce3d78d30c08708af42f360955ed9af7dc255e6b1f663bc5663`；WYS `301df4a799326b704beec5f4858c3757abb031ba7382c240e66177f70ecf0291`。模式本身会规范化表格填充空格/空行，不能把不同模式直接字节比较当产品丢字，也不能放宽格内内容比较。

该轮 JS 异常 0；**5 条原笔记同一张 Wikimedia 外链图 ERR_CONNECTION_RESET**，单独保留在 resource-errors.json，不能说所有网络资源无错。原笔记和输入夹具未变。

### v4 Trae 人工已完成

`.perf/release100-final/trae-focus-1788885434161/manual/sky-actions.json`

真实鼠标选中文/emoji → 物理 Alt+U → 不点击 AI 框直接输入 `人工复核v4焦点🙂`，标记进入原生 AI 草稿；仅新增一次附件；精确宿主原文/磁盘不变；左右拖动 AI 侧栏正常；**未提交任何 AI 消息**。native-receipts.json errors 为空。

### v4 VS Code 可见人工仍缺，自动已过

Computer Use 的 @oai/sky 对正确返回的 VS Code 窗口报错：
`window id 28447026 no longer belongs to Microsoft.VisualStudioCode; current owner is Microsoft.VisualStudioCode`

刷新 list_windows/list_apps/get_window、重置 JS kernel、另建窗口仍失败。新窗口 34409860 也报同型错误。**这不是应用 JS 错误**，不可冒充人工已通过。

两次未完成的 hold 目录：`vscode-focus-1788885187522`、`vscode-focus-1788885681014`；manual-status.json 保存失败原因。仅关闭了已验证 profile/可执行文件对应的隔离测试进程，没有输入、没有动用户应用。

`.perf/release100-delivery/manual-acceptance.json` 中 **B12.passed=false**；旧 v1 人工证据只是历史记录，不能写成 v4 可见通过。E48 仍待最终验收。

恢复可见检查时，在上述 3 个环境变量后加：
```powershell
$env:RELEASE100_MANUAL_HOLD='1'
node scripts/run-release100-task.mjs vscode-focus
```

等输出目录 `manual/ready.json` 出现，才操作窗口。使用 Computer Use skill，读 `C:/Users/Ming/.codex/plugins/cache/openai-bundled/computer-use/26.901.51231/skills/computer-use/SKILL.md` 及其 guidance/api/confirmations。全部 Windows 输入用 `@oai/sky`，不要 PowerShell UIAutomation，不要 Windows 键，不要伪造 app/window 标识绕过校验。

通过后用 `scripts/observe-native-focus.cjs <manual/ready.json>` 只读确认 AI 输入，保存人工记录，再写 `manual/done` 释放 hold；harness 会精确核对宿主和磁盘。**没有完成人工操作不要写 done 假装通过**。若工具仍坏，保留缺口，向用户说明需要该项人工确认，不要无休止重试工具。

## 8. 性能和导出报告的边界

当前 source-history：150002 字符尾部原生撤销约 **104.8 ms**，900002 约 **115.6 ms**。独立构造的 200000 个重复 a、移动 WBR 后 diff+patch 约 **8202.6 ms**（中文/emoji 重复约 1010 ms）；内容都正确，但不能声称任意大文本操作都百毫秒。

新 benchmark-after 完成后：
```powershell
node scripts/compare-release100-performance.cjs .perf/release100-source/benchmark-before-1788865195411 <新的benchmark-after目录> .perf/release100-delivery/v4/performance
```
若基线路径不存在，用 `rg --files .perf | rg 'benchmark-before-1788865195411.*task.json'` 找到真实目录，不要另造基线。比较器要求 12 对相同夹具/源偏移/可视光标，8 次测量去首轮取 7 次中位数。旧报告的 50%–87.421% 只是锚点映射局部性能，不是整机提速，不能复制当 v4 结果。

旧 export-large 书籍：2844 公式 / 96 页；只目视抽查 1、2、21、32、35、49、96 页；DOCX 有 138 个既有 LaTeX fallback，没跑 Native Office COM。不要写成全页全格式无损。新导出要检查实际文件，必要时用已安装 Python/Poppler，旧 QA 在 `.perf/release100-pdf-qa`。

Python：`C:\Users\Ming\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`

## 9. 若必须修产品和重打包

先备份、改权威源码、sync、跑针对性真失败负对照和回归，再完整当前字节工作流/Node。不要先打包后赌测试。

私版 VSIX：在 `D:\BuyKey\Typora-Editor` 用上面的 Python 执行 `pack.py`，**不要 --public**。旧 v4 VSIX 已保存在其交付文件夹，可以保留。

桌面在当前项目：
```powershell
node node_modules/electron-builder/cli.js --win nsis portable --config.electronDist=node_modules/electron/dist --config.directories.output=dist/release-1.0.0-private-final-v5
```

逐文件核对：`node scripts/verify-release100-private.cjs <新release目录> <新vsix文件> <新报告目录>`。提取 VSIX 使用本地 `render/js/vendor/fflate.mjs` 的动态 import，不要 require 一个未安装的 fflate 包。新路径先校验在指定目录内，不要递归删旧目录。

## 10. 最后收尾清单

1. 当前 quality-boundaries 失败有明确解释和有效修复/正确入口证据，完整 8 项通过。
2. 第 5 节剩余任务全部通过，检查真实输出，不只看 exit code。
3. 两款 IDE 的焦点证据不混用版本；VS Code 可见缺口如实关闭或保留。
4. 重新生成 coverage、同源报告、SHA256SUMS，原笔记与公版哈希不变。
5. 写最终测试报告，区分 64 工作流、展开案例、断言和人工抽查，不夸大“所有可能交互”。
6. 只有以上完成，才把候选称为交付版本并将 goal 标记 complete。当前 goal 未完成，不能因为额度不足标记完成。

接手者可直接从第 4 节开始，不必重新调查整个项目或重跑已通过且产品字节未变化的全部测试。
