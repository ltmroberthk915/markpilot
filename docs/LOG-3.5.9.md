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
