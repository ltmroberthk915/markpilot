# 私版 2.0.0 最终测试报告（候选 v5）

报告时间：2026-09-09。第一版候选 v4（1.0.0）完成全部测试后，用户指出版本编号有误（此前已有 1.0.18，1.0.0 属于降版），改版为 **2.0.0**，重新打包为 **v5**。本报告以 v5 为交付候选；v4 目录原样保留。

## 1. 版本变更（1.0.0 → 2.0.0）与影响面

改动内容（权威源，备份于 `.backups/2026-09-09-version-bump/`）：
- `D:\BuyKey\Typora-Editor-App\package.json`：1.0.0 → 2.0.0
- `D:\BuyKey\Typora-Editor\extension-src\package.json`：1.0.0 → 2.0.0
- `D:\BuyKey\Typora-Editor\vsix-meta\extension.vsixmanifest`：Identity Version → 2.0.0
- 校验脚本 `scripts/verify-release100-private.cjs` 的版本断言与产物名同步改为 2.0.0（测试工具改动）

影响面核实：app 与扩展的**全部代码树无任何改动**（app/main、app/renderer、app/shared、app/shell、app/preload、extension/out、extension/render 七棵产品树逐字节不变；代码中无版本号硬编码，grep 确认）。变化仅限 ASAR/VSIX 内的 package.json、VSIX 清单与安装包元数据/文件名。

重打包与重校验：
- VSIX：`pack.py`（未加 --public）→ `marcopilot-2.0.0.vsix`（503 文件）
- 桌面：electron-builder → `dist/release-2.0.0-private-final-v5`（新目录，未覆盖 v4）
- VSIX 提取至 `D:\BuyKey\Typora-Editor\test\.runs\vsix-private-2.0.0-final-v5\extension`（本地 fflate，路径安全校验）
- 同源校验 `verify-release100-private.cjs` → `.perf/release100-delivery/v5/coherence.json`：verified=true，480 共享渲染文件、14 扩展宿主文件、全部 app 文件在 权威源码/桌面源码/ASAR/VSIX 四处一致；公版产物哈希不变；`SHA256SUMS.txt` 逐项复核 OK。
- v5 字节针对性回归（RELEASE100_ARCHIVE 指向 v5 ASAR）：`regression-1788890437380`、`file-launch-1788890468231`、`shell-1788890487227` 全部通过，记录 sourceVersions {app:2.0.0, extension:2.0.0}。
- 既有全量证据继续有效：coverage 按七棵产品树哈希判定，版本号改动不触及任何代码树，64/64 工作流保持就绪；人工证据针对的代码路径与 v5 字节一致（同源校验证明）。此推理边界如实记录：ASAR 整体哈希因元数据而不同，未对 v5 重跑全部 30+ 套件，而是以"代码树逐字节一致 + 三项针对性重跑"作为依据。

## 2. 产物与完整性（v5，2.0.0）

| 文件 | SHA256 | 字节 |
|---|---|---|
| marcopilot-Setup-2.0.0.exe | a84d5c056ab87bc76827909b5a24027345a9f2bd823f3f5fac081fbd4dbf130e | 116,230,079 |
| marcopilot-v2.0.0-portable.exe | cda72d9365e9aff7eb410ed8e27acffcf7611a56b388e61d49f837a26f8562e2 | 116,002,671 |
| win-unpacked/resources/app.asar | 6caa3d243680e6bbb5e4ef1955f2e1179a6d7d6d42fc54a5cce4b93fb92c378e | 23,239,325 |
| marcopilot-2.0.0.vsix | c9e96319dcb1c067b897595dd151fb6f196748f791cec3b2e9d0ddcbd6106a42 | 6,234,481 |

- 原始笔记 `1-重识概率论.md` 仍为 19,246 字节，SHA256 `6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7`，未被任何测试触碰。
- v1/v2/v3/v4 各候选与负对照目录全部保留，未删除、未交付。

## 3. quality-boundaries 失败的根因与修复（v4 阶段完成，结论对 v5 同样成立）

失败（保留证据 `.perf/release100-final/quality-boundaries-1788886514107`）：150000 档原生编辑时 `z` 落在源偏移 358 而非尾部 ENDTOKEN。

诊断（`scripts/quality-boundaries-diag.cjs`，证据 `.perf/quality-diag-1/2/3`）：
1. 工具栏切入源码视图时 `toolbar.js` `captureVisual→enterAt` 捕获视口 30% 处锚点（本例恰为偏移 358、y≈210，与失败现场 anchor 完全吻合）；`split-navigation.js` 的 `maintainEntry` 在真实用户操作到来前每帧把光标/滚动拉回该锚点——设计行为（真实用户的一切输入路径都会先触发 pointerdown/keydown/wheel 取消锚点）。
2. 测试用脚本 `getSelection().collapse()` 设选区不产生任何取消事件：诊断 A 阶段复现——collapse 到 149998 后 3ms 内光标被拉回 358，`insertText('z')` 落在 "Rezpeated"。
3. 诊断 B 阶段：真实点击 + End 键定位到 ENDTOKEN 尾部后光标稳定不被抢回，输入/撤销/重做/保存全部正确——**产品无缺陷，失败根因是测试入口**。
4. blocks 档（>150000 字符）下脚本 `reveal` 滚动同样被持有中的锚点拉回（150ms 内 scrollTop 55982→17.71）。

修复（仅改测试脚本 `release100-quality-boundaries.cjs`、`viewflow-suite.cjs`、`split-navigation-runner.cjs`）：入口改为真实用户路径——原生 Ctrl+End → 真实点击 ENDTOKEN 末字符 → End 键精确就位 → 断言光标偏移等于期望值后才 `insertText`。结果 `quality-boundaries-1788888381000` **8/8 通过**（四档长度 × 初始质量+输入/撤销/重做/保存）。

## 4. 覆盖与任务结果（代码树同 v4，证据同源有效）

覆盖：64 工作流（16 基础 / 48 边缘 = 25% / 75%），**64/64 就绪**，无缺失任务、无人工待办。coverage 按产品树哈希严格判定，未削弱检查。

v4 阶段完成的全部任务（代码树与 v5 逐字节一致，见 §1）：quality-boundaries 8/8；media-office、export、media-lifecycle、reading 12 项、ui 43 项、benchmark-after、history-large；regression、math-boundaries、export-large（HTML 8.9MB/2844 公式 0 警告、PDF 96 页 0 警告、DOCX 138 处既有 LaTeX fallback）；math-table 68 案例/1216 步、vscode-full 150、trae-full 150、vscode-focus 自动 29、trae-focus 29+人工、file-launch、shell、protection、user-file-host、source-history 24、viewflow 60、features、math-history、consistency、navigation 63、selection 110、repairs、table-context-host、table-input-host、nested-math 24、math-colors、completion；背景证据 workflow-gaps 137/137、source-entities 291/291 Node / 71 语法 / 480 同源 / 4 公版哈希。两款 IDE full 的 webview-errors / unhandled-errors 均为空。

以上为断言级案例数；一个工作流含多条展开变体。本报告不声称覆盖"所有可能交互"，coverage.json 的 64 工作流清单为准确边界。

## 5. 性能

- 前后对比（基线 `benchmark-before-1788865195411` vs `benchmark-after-1788888513226`，报告 `.perf/release100-delivery/v4/performance/`）：12 对相同夹具/源偏移/可视光标，8 次测量去首轮取 7 次中位数；**锚点映射局部耗时降低 50%–86.79%**（局部指标，非整机提速）。
- source-history：150002 字符尾部原生撤销约 104.8ms，900002 约 115.6ms；独立构造的 200000 重复字符 diff+patch 约 8202.6ms（中文/emoji 重复约 1010ms）——不能声称任意大文本操作都是百毫秒级。

## 6. 人工复核（真实可见操作，无提交任何 AI 消息）

1. **实际 portable EXE**（`.perf/release100-manual-exe-1788883646022`，v4 字节；代码树与 v5 一致）：RN 加粗段公式取消/撤销/直接输入/精确恢复、邻居公式无黑块；放大两级、754px 窄窗整格与光标可见、工具条不遮挡；分式/矩阵跨格及时收起；分屏双向滚动；`<br />` 字面保留；保存重载磁盘一致。JS 异常 0；5 条原笔记同一 Wikimedia 外链图 ERR_CONNECTION_RESET 单独记录（网络问题）。
2. **Trae**（`trae-focus-1788885434161/manual`）：真实选中文/emoji → 物理 Alt+U → 不点击 AI 框直接输入 `人工复核v4焦点🙂`；一次附件；宿主原文/磁盘不变；未提交。
3. **VS Code**（`vscode-focus-1788888826125`，B12 缺口已闭合）：隔离 Extension Development Host；自动化 29 项过后，真实鼠标拖选正文"加粗中文" → 真实 Alt+U → `workbench.action.chat.open` 精确派发一次（附件第 3 行 11–15 列，finished、无错误），焦点落在原生 AI 输入框（DIV.native-edit-context）→ 未点击输入框直接输入 `人工复核v4焦点VSCode🙂`；harness 断言文档与磁盘逐字节不变。误选标题标记的一次 Alt+U 产生"请选中正文"警告且零派发、零文档改动，作为守门负证据记录。@oai/sky 工具损坏的两次历史 hold 目录保留；本轮使用 ZCode computer-use 真实 OS 事件完成。

## 7. 边界与如实声明

- 96 页教材 PDF 仅人工抽查 1、2、21、32、35、49、96 页（`.perf/release100-pdf-qa`）；教材部分跨行单美元公式显示源码为既有行为。
- DOCX 138 处 LaTeX fallback 为既有现状；Native Office COM 自动化未运行。
- 网络资源错误仅 5 条 Wikimedia 外链；不能宣称所有网络资源无错。
- 大文本极端重复内容的 diff+patch 仍为秒级。
- v5 仅重跑 regression/file-launch/shell 三项针对性验证，其余证据基于"代码树逐字节一致"的同源判定（§1 已说明边界）；人工证据对应 v4 代码路径。

## 8. 结论

64/64 工作流就绪，产物同源、公版与原始笔记哈希不变，版本号已更正为 2.0.0。`dist/release-2.0.0-private-final-v5` **可作为私版 2.0.0 交付版本**。
