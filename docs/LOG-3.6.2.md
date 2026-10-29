# 3.6.2 维护版发布记录

本版不改变编辑行为，只发布重新打包并完成本机安装验证的 Windows 安装版与便携版。表格行重建的性能优化仍留给后续处理，不在本版宣称修复。

## 源码与版本

- 公开仓库：`D:\BuyKey\markpilot-public`，基于 `7e03ddb`（3.6.1 回执提交）。
- 版本改动：`MarkPilot-CM6/package.json` 与 `MarkPilot-CM6/package-lock.json` 顶层及 `packages[""]` 由 3.6.1 → 3.6.2；DSH 插件保持 0.1.0。
- 新增 `docs/RELEASE-3.6.2.md`、`docs/LOG-3.6.2.md`；README 增加 3.6.2 段，旧内容保留（README keep 回执 `README-KEEP-362-R2.json`，两份均 passed）。

## 普通用户 token owner 实验

- 远端临时标准用户非交互启动被主机策略阻止：`Start-Process -Credential` 返回 `0xC0000142`；计划任务未实际启动（结果 267011）。临时用户、任务与 ProgramData 目录已清理。
- 本机 DSH 进程本身是普通用户 token（`LAPTOP-5NTLMFRQ\Ming`，Administrators 为 deny-only，Medium 完整性）。用同一套 Node/PowerShell 新建与 rename 控制在 `D:\BuyKey\owner-qual-normal-user-20261029` 实测：四个控制文件 owner 全部是 `LAPTOP-5NTLMFRQ\Ming`，`isAdmin=false`。
- 回执：`OWNER-QUALIFICATION-NORMAL-USER.json` 与 `SAVE-METADATA-OWNER-QUALIFICATION.md`。
- 结论：管理员 token 下 `owner -> BA` 是 token 默认 owner 行为；普通用户 token 下新建/rename 保持用户 owner。普通用户 token 上未单独重放 MarkPilot 原子保存，因此保留“产品是否应显式保留自定义 owner”的策略边界。

## 构建与打包

- 运行时：`convergence-20261025/runtime-44.9.3`（Electron 44.9.3 Windows x64）。
- `build-from-source.cjs` 重建：引擎 `741ec9303807b52a704e8da14d9fccc336fac0ba95d3235c4d197553a52c2d9e`（1,466,846 B），后台解析 Worker `281c97bd645b8777`，产品源码未改。
- `tools/quality/package-candidate.cjs` 重建 ASAR、rcedit 写入 PE 版本 `3.6.2.0`/`3.6.2`。
- 候选身份：ASAR `c9d580b38d8cd222e5da43eb98c7e5f12135dad9aa7e14ccf5786fc5d91ec130`；staged EXE `f9140880aeb49ff7f4d74dfc978c387bd90b84b7250d638134dc2ca33cf35772`（246,814,720 B）。
- `verify-package` 通过：三份安装包解包后的 EXE/ASAR、全部 ASAR 成员与运行时载荷一致。
- 产物：安装版 `markpilot-Setup-3.6.2.exe` 117,592,422 B / `b5b8c1d09f5c0ce8c5419930a2f8908e24db3a5d71e6812a02ddb095ff1c15ad`（远端候选，已安装）；便携版 `markpilot-3.6.2-portable.exe` 102,526,625 B / `414464ce9c328135e98c412a0e76d1558a39a8cea0f799132b18276c3dff1d65`（远端下载通道中断后，从本机已安装 3.6.2 载荷用 electron-builder 26.15.3 本地重建并启动验证；不是远端候选的 8e1c… 字节）；隔离测试版 `markpilot-quality-Setup-3.6.2.exe` 117,527,435 B / `53ee7e4174b923bd5d8328d112b02aaed4619d51176ef62378469ed378523fd5`。

## 本机升级（3.6.1 → 3.6.2）

- 安装前已正常关闭 MarkPilot；备份安装树、两套 profile、HKCU Uninstall 注册表与本机状态到 `D:\BuyKey\backups\MarkPilot-CM6-3.6.1-20261029-164959`。
- 安装前：`MarkPilot.exe` `3.6.1.0`/`3.6.1` / `b141e38c25cbc8003d2bd0912cdb4b6fb3b0a9a75300ca55ebc2c2088acda382`；ASAR `edc5daf53be422df86fa38356e7cb9c8a4c72908c93a0f00b28e87790c3079d2`。
- 静默安装退出码 0；安装后 `MarkPilot.exe` `3.6.2.0`/`3.6.2` / `f9140880aeb49ff7f4d74dfc978c387bd90b84b7250d638134dc2ca33cf35772`；ASAR `c9d580b38d8cd222e5da43eb98c7e5f12135dad9aa7e14ccf5786fc5d91ec130`。
- 安装树仅三个文件变化：`MarkPilot.exe`、`resources/app.asar`、`Uninstall MarkPilot.exe`；80 个文件、394,177,405 B。
- 注册表卸载项更新为 `MarkPilot 3.6.2`；另一套 2.3.3 安装记录保留。
- 两套 `settings.json` 哈希与安装前完全一致。
- 安装后的 3.6.2 正常启动并恢复 `doc-copy.md` 窗口，关闭正常。
- 本机重建的便携版从临时目录启动，同样恢复 `doc-copy.md` 窗口，关闭正常；7-Zip 解包核对 80 个运行时文件、394,177,405 B，`MarkPilot.exe` `3.6.2.0`/`3.6.2` / `f9140880…`，ASAR `c9d580b3…`，与安装版载荷一致。

## 发布（本地）

- 发布提交：`8005fc97b7044c6d7399c208c6f00a833d3cdb9b`（`release: MarkPilot 3.6.2`），父提交 `7e03ddb`；目标分支 `main`。
- 标签：`v3.6.2`（annotated，tag object `75a5dde7c0451eee2b8ca39d7d34997afa449265`）。
- 本地附件目录：`D:\BuyKey\markpilot-3.6.2`；安装版 `b5b8c1d0…`，便携版 `414464ce…`，SHA256SUMS 187 B。
- 未推送到 GitHub，未创建 GitHub Release；本轮只完成本地打包与本地装机。

## 保留项

- `PERF-INACTIVE-TABLE-ROW-REMOUNT` 未修复，按用户决定留给 Codex 后续处理。
- 本版不修改产品行为、不关闭性能台账项。
- 3.6.2 隔离 appId 安装包已构建并通过载荷核对，但未在本机重复安装/卸载；主安装采用安装前备份 + 直接升级，并在安装后核对文件差异、注册表与正常启动。
