# 3.5.9 表格边界与阅读意图交付记录

本批把已验证的表格边界／阅读意图候选冻结为 3.5.9，完成一次打包、载荷核对、本机升级与 GitHub Release。发布只包含已验源码；未合入的 Electron 44 剪贴板 API 修复不进入本版。

## 源码与版本

- 源码基线：远端 `convergence-20261025/repo` main `4cb17b9fa2d069df18eaccad6f912569f9fa9710`，工作树干净。
- 打包前逐文件复核 `stage-table-boundary-fix-r4` 的 21 个核心文件，当前源码与已验证候选逐字节一致（差异 0）。
- 版本改动仅 `MarkPilot-CM6/package.json` 与 `MarkPilot-CM6/package-lock.json` 的顶层及 `packages[""]` 版本，3.5.8 → 3.5.9；DSH 插件版本保持 0.1.0。
- 新增 `docs/RELEASE-3.5.9.md`、`docs/LOG-3.5.9.md`。

## 打包

- 运行时：`stage-table-boundary-fix-r4/unpacked`（Electron 44.9.3 Windows x64，运行时 EXE 3.5.8 的 SHA256 `485a107fe08a161f4f967940f9678723f8347b1e47fd0f6860f484d6e0b3319b`）。
- 使用 `tools/quality/package-candidate.cjs` 从该运行时复制完整载荷、重建 ASAR、经 rcedit 写入 PE 版本 `3.5.9.0`/`3.5.9`，再生成生产安装版、便携版与唯一 appId 的隔离测试安装版。
- 候选身份：ASAR `3562f7d91e7a6c689dd291e1c43fbec698f1d959b7ee9d32d59ca9ee44753875`（7,858,677 B）；staged EXE `36632d3c8dd386d365e000251c4def4cc9f4199839e54417434d0f2a7e4cdbfd`（246,814,720 B）。
- 产物：安装版 `markpilot-Setup-3.5.9.exe` 117,587,000 B / `cf691c707d29d946c9b4013f31d14d54d8841ca6a7d0db3ee06151d017598730`；便携版 `markpilot-3.5.9-portable.exe` 117,325,695 B / `e277c65d40bd2dbc094fed333c5ffe3ddf06fbaa137d61e533c629421425c40e`；隔离测试版 `markpilot-quality-Setup-3.5.9.exe` 117,522,013 B / `647120245af2822b8f8212669cc913533b9bc2592ea3c7ec0a6e1201577772d5`。
- `tools/quality/verify-package.cjs` 拆解三个 EXE 的实际载荷：三个包全部通过，均为完整 78 个运行时文件、157 个 ASAR 成员，内层 EXE/ASAR 摘要与候选一致。
- `tools/quality/isolated-install.cjs` 在隔离 appId 上完成安装、复核、卸载：三步退出码 0，原有 2 个 MarkPilot 安装记录保持不变，安装后 EXE/ASAR 摘要与候选一致。

## 本机升级（3.5.8 → 3.5.9）

- 安装前无 MarkPilot 进程；按既有备份目录保存安装树、两套 profile、注册表与快捷方式、49 份关联文档哈希。
- 静默安装退出码 0；安装后 `MarkPilot.exe` 版本 `3.5.9.0`/`3.5.9`，EXE 与 ASAR 摘要均与候选一致。
- 安装树仅三个文件变化：`MarkPilot.exe`、`resources/app.asar`、`Uninstall MarkPilot.exe`；无缺失、无额外文件。
- 49 份关联文档哈希全部一致；`MarkPilot CM6` profile 逐文件不变；`MarkPilot` profile 有 15 个缓存/会话文件变化，`settings.json` 仅窗口尺寸 1237×808 → 1241×813，主题、自动保存等用户设置未变。
- 注册表仅本应用卸载项由 `MarkPilot 3.5.0` 更新为 `MarkPilot 3.5.9`（版本与估算大小变化），另一套 2.3.3 安装记录保持不变。
- 安装器重写了两个快捷方式；已按备份恢复原始 `.lnk` 字节，恢复后两个快捷方式 SHA256 与安装前一致，目标/参数/工作目录/图标未变。
- 本机未启动图形界面做交互复核，以避免写入真实 profile；表格边界、阅读意图与原生全选的交互证据来自远端同一源码候选及同字节 ASAR，安装包不改变该段行为。

## GitHub Release

- 发布提交：`d1c92d8bd8fe4f7655058a9d5db07add801adda8`，父提交为已公开的 `ede3444`；提交树与远端交付提交 `2d009f3` 逐字节一致（tree `f16e5cbb1e62bcfe8fdbd631c4be36c66b910210`）。
- 标签：`v3.5.9`（annotated，tag object `914f9f2296c321a5b4210a0fb940d86dcb616447`）。
- Release：`https://github.com/ltmroberthk915/markpilot/releases/tag/v3.5.9`，已上传安装版、便携版与 `SHA256SUMS.txt`。
- GitHub 计算的附件 digest 与本地一致：安装版 `cf691c707d29d946c9b4013f31d14d54d8841ca6a7d0db3ee06151d017598730`，便携版 `e277c65d40bd2dbc094fed333c5ffe3ddf06fbaa137d61e533c629421425c40e`，校验文件 `43ef90bea71b0bb798ffa0408e29681294bb9601f06bba84e9733b89e1565b8b`。

## 未完成与保留项

- `NEW-ELECTRON44-CLIPBOARD-API`：已确认的 Electron 44 剪贴板 API 迁移缺陷；修复仍为私有 proposal，未经复核合入，3.5.9 不包含该修复。
- `convergence-ledger.r30.json`：98 条登记中 35 条为待处理/待复验（不等于 35 个已确认未修复缺陷），28 条已验待交付项随本版交付；其余按台账保留。
- 原生长路径入口只完成只读准备，未执行。
- 本版未覆盖的既有边界与历史失败项按台账原文保留，不在本记录中改记为通过。

## 发布后的剪贴板维护集成

此节记录后续维护工作区的源码集成。公开 `v3.5.9` 标签、发布附件、版本号和已安装产品均未改动；上文发布时的载荷与未完成项记录继续保留。

- 从独立审阅且实际验过的 N2 冻结候选集成 6 个源码/产物/测试文件：Electron 44 公共 `ClipboardItem` 服务与串行写入、主进程各写入口和异步结果处理、严格产物清单、11 项服务测试，以及剪切菜单按下时保持当前编辑器焦点的修复。表格引擎源码 `038519a85b6c49784accb9f36015224f05541c024770ec82d85d5dfaf6e011b9` 保持不变。
- 私有候选 ASAR 为 `70b5b343ebe4f66806988720a82d31e6ce3d67d40ec2d7394a8a4cc73ec225c8`，引擎为 `d2e185ae281f662c81fc0788bd7d447e639f369f65b08d998019b2961ccccebe`。源码集成后的 34 个引擎源成员与 158 个应用源成员分别与该冻结候选一致。原有预检通过；41 个测试文件的聚合结果为 276 项通过、0 失败、0 跳过，服务测试还正向确认唯一的 11/0 汇总。隔离重建的编辑器、Markdown worker 与维护产物逐字节一致。
- 该候选已实际完成 HOST 3 臂、CUT 3 臂和原 21 臂数值检查，每次均通过原 23 个传输/身份/清理门。取消剪切导致失焦的同臂失败与恢复后通过记录均保留。原生菜单补证使用公开子菜单弹出入口、唯一可见 UIA 项和一次 `SendInput` 点击；30 项行为检查与 23 个门通过，独立进程回读完整路径，源文/选区/文档身份/磁盘及真实撤销重做成立。两张原生截图经实际看图复核可读；仅外缘有不遮挡所需内容的未绘制边框。此证据不代表物理菜单栏点击，也不把测量光标代理当作原生光标证据。
- 原始失败入口和黑屏截图均保留。新截图采用同一 owned-HWND `PrintWindow` 路径的 `PW_RENDERFULLCONTENT` 标志，未更改产品渲染参数，也未使用屏幕或其他窗口像素。未受改动影响且 SHA 相同的帧按明确别名复用，未重复计为新看图。
- C2 仍有当前候选上已确认的代码块可见选区子缺陷：两处模型选区正确，但 paste 前后均无可见高亮；历史版本与 API44 因果未建立。该项、literal 拒绝臂历史、C2-X、GAP-62、原生长路径及其余原登记范围仍待各自验收。此次源码集成不关闭任何业务登记，也不构成全范围、安装或发布验收。

内部记录：`.mp-verify/restart-40-r1/astra-api44-canonical-integration-r1/INTEGRATION-RESULT.json`、对应单测/预检/构建日志，以及接管目录中的 `HOST-FOCUS-R1-ROOT-FINAL.json`、`CUT-FOCUS-ROOT-FINAL.json`、`ORIGINAL21-FOCUS-ROOT-ADJUDICATION.json`、`G2-FOCUS-R3-ROOT-FINAL.json` 和独立审阅报告。
