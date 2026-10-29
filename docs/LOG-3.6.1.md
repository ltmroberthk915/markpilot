# 3.6.1 反向拖拽行内公式显示修正记录

本版修正 3.6.0 中“从后往前拖拽选中行内公式”与“从前往后”表现不一致的问题，完成打包、载荷核对、本机升级与 GitHub Release。其余功能与 3.6.0 相同。

## 源码与版本

- 公开基线：`ltmroberthk915/markpilot` main `c27098bb282704006a246cbeafcd955c52e228b0`（3.6.0 回执提交）。
- 维护工作区：`convergence-20261025/repo` main `ad99469183755521b630eac6ca72950b71fc2311`（`fix(math): keep backward drag selection symmetric with forward`），父 `c9816a0`；工作树干净。
- 版本改动：`MarkPilot-CM6/package.json` 与 `MarkPilot-CM6/package-lock.json` 顶层及 `packages[""]` 由 3.6.0 → 3.6.1；DSH 插件保持 0.1.0。
- 新增 `docs/RELEASE-3.6.1.md`、`docs/LOG-3.6.1.md`；README 增加 3.6.1 段，旧内容全部保留。

## 根因与修复

- `dsh-markpilot/src-cm6/region-session.js` 的 math 编辑判据原来只有单边 `selection.head < r.to`，缺 `head >= r.from`。反向选择时 head 在已划过公式左侧，这些公式全部被判为 editing/preview，因而全部展开源码；每个公式创建浮框后，head 离开时 intent 不变，旧浮框不销毁 ⇒ 累积。
- 改为“head 在公式内，右边界按鼠标分流”：`head >= r.from && (head < r.to || (head === r.to && lastPointer))`。正向不变，反向只有 head 所在公式源码+浮框，已划过的公式恢复渲染+选中底色；鼠标右边界仍编辑、键盘右边界仍渲染。
- `main.js` 重建产物 `renderer/cm6/app.js` 同步更新（app.js sha256 `741ec9303807b52a704e8da14d9fccc336fac0ba95d3235c4d197553a52c2d9e`）。

## 验证

- 方向探针（同一行 3 个公式，慢速鼠标）：正向/反向均 maxSourceCount=1、maxFloats=1；抬起后 source=0、floats=0；反向逐点确认离开公式后恢复渲染、不残留浮框。
- 拖拽终点停在中间公式：正向/反向均只剩 head 公式源码+浮框，其余渲染。
- `local-cdp-verify`：右边界一次 ArrowLeft、紧后侧点击、420px 补全菜单避让，全部通过。
- `float-layout-workflows` 10/10；`math-entry-workflows` 14/14（首轮一次 ENOENT 夹具缺失，重跑通过）；`worker-integration` 27/28（唯一失败为宿主剪贴板 `pending-url-paste-over-selection`）；`mixed-selection-workflows` 2/2 在 `ENTRY_UNCONFIRMED: actual native clipboard arm` 处失败（未进入行为断言，同一宿主剪贴板环境问题）。
- `verify-package` 通过；隔离 appId 安装/复核/卸载通过，原有 2 个安装记录保留。

## 打包

- 运行时：`convergence-20261025/runtime-44.9.3`（Electron 44.9.3 Windows x64）。
- `tools/quality/package-candidate.cjs` 重建 ASAR、rcedit 写入 PE 版本 `3.6.1.0`/`3.6.1`，生成生产安装版、便携版与隔离测试安装版。
- 候选身份：ASAR `edc5daf53be422df86fa38356e7cb9c8a4c72908c93a0f00b28e87790c3079d2`（7,879,625 B）；staged EXE `b141e38c25cbc8003d2bd0912cdb4b6fb3b0a9a75300ca55ebc2c2088acda382`（246,814,720 B）。
- 产物：安装版 `markpilot-Setup-3.6.1.exe` 117,592,434 B / `0a18783b4bb3a7b9e9d4c6eee05f9a4a9af09e1a95aeacbb99f5bcac45bebc45`；便携版 `markpilot-3.6.1-portable.exe` 117,331,152 B / `88731240dce39ab125772eb4c7aa4d0c1282396e61fbcf2ed49b302d0cad98af`；隔离测试版 `markpilot-quality-Setup-3.6.1.exe` 117,527,451 B / `f8d1124f5cbbce2e38caf3d1732fc7ca2270e5443bc9d213a1dbb4e54201cace`。

## 本机升级（3.6.0 → 3.6.1）

- 安装前无 MarkPilot 进程；备份安装树、两套 profile、注册表卸载项与开始菜单快捷方式，保存 3.6.0 的 EXE/ASAR/文档基线哈希。备份目录 `D:\BuyKey\backups\MarkPilot-CM6-3.6.0-20261029-111808`。
- 静默安装退出码 0；安装后 `MarkPilot.exe` 版本 `3.6.1.0`/`3.6.1`，EXE/ASAR 摘要与候选一致。
- 安装树仅三个文件变化：`MarkPilot.exe`、`resources/app.asar`、`Uninstall MarkPilot.exe`；无缺失、无额外文件。
- 注册表卸载项由 `MarkPilot 3.6.0` 更新为 `MarkPilot 3.6.1`，另一套 2.3.3 安装记录保持不变。
- `MarkPilot\settings.json` 哈希与安装前一致；两套 profile 未被升级改写。
- 用隔离 profile 启动已安装的 3.6.1：UA 为 `MarkPilot/3.6.1 … Electron/44.9.3`；正向/反向方向探针均 maxSourceCount=1、maxFloats=1，抬起后 0/0。测试实例已关闭。

## GitHub Release

- 发布提交：`b5490e1cdb14bf5c5896129e0554e049f101d73b`（`release: MarkPilot 3.6.1`），父提交为公开 `c27098bb282704006a246cbeafcd955c52e228b0`；目标分支 `main`。
- 标签：`v3.6.1`（annotated，tag object `40f79fbcb0c0465d5805acba1a06ad132a59b7a9`）。
- Release：`https://github.com/ltmroberthk915/markpilot/releases/tag/v3.6.1`，正文取自 `docs/RELEASE-3.6.1.md`；已标记 Latest；附件已上传安装版、便携版与 `SHA256SUMS.txt`。
- 附件：安装版 117,592,434 B / `0a18783b4bb3a7b9e9d4c6eee05f9a4a9af09e1a95aeacbb99f5bcac45bebc45`；便携版 117,331,152 B / `88731240dce39ab125772eb4c7aa4d0c1282396e61fbcf2ed49b302d0cad98af`；校验文件 187 B / `efa5050e467af02ed8519c42bf70c67b1e4583cd8cccb242b0d30b6e62d734d8`。
- GitHub 计算的附件 digest 与本地逐项一致；release 已发布，非 draft、非 prerelease。

## 保留项

- 本版只修正反向拖拽展示，不改变 3.6.0 的其它行为；未关闭原 40 项台账中的业务 ID。
- 维护工作区的 3.6.1 提交未直接推送到 GitHub；公开仓库以发布提交方式追加。
