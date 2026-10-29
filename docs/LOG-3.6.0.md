# 3.6.0 长文档输入与剪贴板交付记录

本批在公开 3.5.9 之后，把大文档行内公式输入、行内公式源码展开、公式补全菜单避让、Electron 44 剪贴板迁移、剪切焦点保持与表格单元格编辑的已验证修复冻结为 3.6.0，完成一次打包、载荷核对、本机升级与 GitHub Release。发布源码来自维护工作区 `convergence-20261025/repo`；公开仓库只追加本版源码、版本与文档，不改写既有历史。

## 源码与版本

- 公开基线：`ltmroberthk915/markpilot` main `f38c54033cd40bec0627ef9fb8be16b21a313c56`（v3.5.9 标签 `d1c92d8bd8fe4f7655058a9d5db07add801adda8`）。
- 维护工作区：`convergence-20261025/repo` main `9e1b956f5e4377fc18a10411ea3f056db60766e9`，工作树干净。
- 相对 3.5.9 纳入的源码提交：`6ed03b8`（发布回执）、`4e1ffe5`（同表其他行编辑保持）、`13305f1`（Electron 44 剪贴板与剪切焦点）、`85374bd`（右侧源码展开与补全避让）、`15eac16`（投影重建判据）、`9e1b956`（异步语法 pending 前缀高亮）。中间提交 `8a05124` 已被 `9e1b956` 覆盖，不单独计入最终差异。
- 版本改动：`MarkPilot-CM6/package.json` 与 `MarkPilot-CM6/package-lock.json` 顶层及 `packages[""]` 由 3.5.9 → 3.6.0；DSH 插件版本保持 0.1.0。
- 新增 `docs/RELEASE-3.6.0.md`、`docs/LOG-3.6.0.md`；`docs/LOG-3.5.9.md` 保留维护集成记录。

## 修复与证据摘要

- 大文档键入闪烁：10fps 连拍 34 帧，旧版上方段落区域单帧变化 180,760 像素；最终版 34 帧全部为 0。60fps 字体采样 232/232 帧保持粗体 900。
- 行内公式右侧进入/点击展开：真实键盘与鼠标，渲染 widget 1→0，源码展开；左侧进入对照一致。
- 公式补全菜单：420px 视口，菜单底 633.1 < 光标行顶 638.7（16px 间距），Enter 接受候选。
- 剪贴板/焦点：维护工作区 276/276 单元测试通过；`worker-integration` 27/28（唯一失败为宿主剪贴板服务 `copy arm write acknowledgement`，基线一致）、`math-entry-workflows` 14/14、`math-workflows` 13/16（3 项同一宿主剪贴板失败，基线一致）。

## 打包

- 运行时：`convergence-20261025/runtime-44.9.3`（Electron 44.9.3 Windows x64）。
- 使用 `tools/quality/package-candidate.cjs` 重建 ASAR、rcedit 写入 PE 版本 `3.6.0.0`/`3.6.0`，生成生产安装版、便携版与唯一 appId 的隔离测试安装版。
- 候选身份：ASAR `a0502db669855db13eba595054fc99dbdf22be960a3e6232910bd8f0015925cc`（7,879,591 B）；staged EXE `1d92dd16976da69d36f8c7fdde55de8a3811a82c65e5bc00e8effb0e20b559f6`（246,814,720 B）。
- 产物：安装版 `markpilot-Setup-3.6.0.exe` 117,592,506 B / `50e76bf600df4f6c75decfaf95a6593be7bb2a15ec69d8e3a9035f1912585bdf`；便携版 `markpilot-3.6.0-portable.exe` 117,331,176 B / `33862f6739133c09971e0893e5600295c7ed61f57a1c538d278a5429fab7faa5`；隔离测试版 `markpilot-quality-Setup-3.6.0.exe` 117,527,474 B / `783c7fd5d3240ebc72d9c9d0f25544e49d1794a9450e0ae6d592700f06dc24a7`。隔离 appId 为 `app.markpilot.quality.ca5d6e942b5b44f3a0166bd6dd61530a`。
- `tools/quality/verify-package.cjs` 拆解三个 EXE 的实际载荷：全部通过，内层 EXE/ASAR 摘要与候选一致，完整 ASAR 成员集与 staged app-source 逐字节一致，运行时载荷完整。
- `tools/quality/isolated-install.cjs` 在隔离 appId 上完成安装、复核、卸载：三步退出码 0，原有 2 个 MarkPilot 安装记录保持不变，安装后 EXE/ASAR 摘要与候选一致。

## 本机升级（3.5.9 → 3.6.0）

- 安装前无 MarkPilot 进程；备份安装树、两套 profile、注册表卸载项与开始菜单快捷方式，保存 3.5.9 的 EXE/ASAR/文档基线哈希。备份目录 `D:\BuyKey\backups\MarkPilot-CM6-3.5.9-20261029-102924`。
- 静默安装退出码 0；安装后 `MarkPilot.exe` 版本 `3.6.0.0`/`3.6.0`，EXE 摘要 `1d92dd16…`、ASAR 摘要 `a0502db6…` 均与候选一致。
- 安装树仅三个文件变化：`MarkPilot.exe`、`resources/app.asar`、`Uninstall MarkPilot.exe`；无缺失、无额外文件。
- 注册表卸载项由 `MarkPilot 3.5.9` 更新为 `MarkPilot 3.6.0`，另一套 2.3.3 安装记录保持不变。
- 两套 profile 文件数与总字节不变，`MarkPilot\settings.json` 哈希与安装前一致；升级未改写用户设置。
- 用隔离 profile 启动已安装的 3.6.0：UA 为 `MarkPilot/3.6.0 … Electron/44.9.3`；10fps 连拍 34 帧、上方区域 0 变化；行内公式右侧进入/点击展开与补全菜单避让复验通过。测试实例已关闭。

## GitHub Release

- 发布提交：`ad73829fbc128560098560c83ad6eaf0b492e9ac`（`release: MarkPilot 3.6.0`），父提交为公开 `f38c54033cd40bec0627ef9fb8be16b21a313c56`；目标分支 `main`。
- 标签：`v3.6.0`（annotated，tag object `b329268bf691d4318fec6d4c3049f0a95c9abb7f`）。
- Release：`https://github.com/ltmroberthk915/markpilot/releases/tag/v3.6.0`，正文取自 `docs/RELEASE-3.6.0.md`，已上传安装版、便携版与 `SHA256SUMS.txt`。
- 附件：安装版 117,592,506 B / `50e76bf600df4f6c75decfaf95a6593be7bb2a15ec69d8e3a9035f1912585bdf`；便携版 117,331,176 B / `33862f6739133c09971e0893e5600295c7ed61f57a1c538d278a5429fab7faa5`；校验文件 187 B / `2d5719a1789381dc730097bb6e0165e8fb241684971be46005c1d1f9333a034e`。
- GitHub 计算的附件 digest 与本地逐项一致；release 已发布，非 draft、非 prerelease。

## 未完成与保留项

- C2 代码块可见选区子缺陷仍在维护台账中，本版不包含其未经验证的候选。
- 原 40 项台账未关闭任何业务 ID；未覆盖的历史边界与失败项按台账原文保留。
- 未 push 维护工作区分支；公开仓库只追加发布提交与标签。
