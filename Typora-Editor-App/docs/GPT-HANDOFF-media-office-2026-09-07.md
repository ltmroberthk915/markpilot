# GPT 接手：原生 Office 图片粘贴超时定位（进行中）+ 其余 media-office 剩余工作

交接时间：2026-09-07。本文件是继上一份 `GLM-HANDOFF-media-office-2026-09-07.md`（下称"GLM 文档"）之后的第二轮交接。上一轮 GLM 已把源码改动收尾；本轮我来接手 P0-1（原生 Office 图片粘贴超时），已把超时**精确定位到 Word `SaveAs2` 挂起**，但根因尚未完全锁定。其余 P0/P1/P2 事项**本轮未动**，仍以 GLM 文档为准。

## 一、磁盘当前状态（本轮改了什么）

### 已修改的正式文件

1. **`D:\BuyKey\Typora-Editor-App\app\main\doc.js`**（唯一正式源码改动）
   - `copy-image` 从 Electron 44 的 `clipboard.write([new ClipboardItem({...})])` 改为调用 `windowsClipboard`（WinForms 桥，见 GLM 文档第四节 media-clipboard.ps1）。
   - 顶部 import 增加 `windowsClipboard`（`const {imageBytes,TYPES,windowsClipboard}=require('../renderer/js/media-host.cjs');`）。
   - 非 PNG 图片先 `nativeImage.createFromBuffer(...).toPNG()` 转 PNG 再走桥。
   - **方向正确但尚未定论**：见第四节，完整 app 环境下 Word SaveAs2 仍挂，此改动不能宣称已修复。

2. **`D:\BuyKey\Typora-Editor-App\scripts\office-native-verify.ps1`**（重写）
   - 新增 `-App word|excel|powerpoint|all` 参数：image 模式可按应用拆分，独立超时、互不拖累。
   - 新增 `Log` 函数：每个 COM 步骤前打印 `[HH:mm:ss.fff]` 时间戳并 `[Console]::Out.Flush()`，超时被杀时 stdout 能精确定位卡点。
   - 新增 `Start-Office`：启动 Office COM 前记录已有 PID，启动后把新 spawn 的 PID 写盘（`<stamp>-pids.json`），供 harness 超时后 `taskkill` 精确清理（不误伤用户文档实例）。
   - 每分支独立 try/finally（Quit + `FinalReleaseComObject`）。
   - **注意已移除两处会引入死锁的代码**（见第四节根因）：
     - 剪贴板格式诊断里的 `[System.Windows.Forms.Clipboard]::GetDataObject()` 已删除（会持有 IDataObject 让 PowerShell 变延迟渲染 owner）。
     - `Get-CimInstance Win32_Process` 已改为 `Get-Process`（当前进程名匹配有问题，spawned pids 抓不到，但不影响 SaveAs2 定位，待 GPT 修正）。

3. **`D:\BuyKey\Typora-Editor-App\scripts\desktop-media-office.cjs`**（改动较多）
   - `native()` 改造：支持 `-App` 拆分、`TYPORA_OFFICE_SYNC=1` 切换同步 `execFileSync`、超时后用 pids.json `taskkill` 清理、日志写入 `native-<stamp>.log`。
   - 新增 SHA256 媒体字节比对：粘贴后的 docx/xlsx/pptx 解包（用 `app/renderer/js/vendor/fflate.mjs` 的 `unzipSync`），提取 `word/media/`、`xl/media/`、`ppt/media/` 下的图片与源 PNG SHA256 比对，验证原像素+透明度比特一致。
   - **移除了两处 Electron 侧 `clipboard.read()` 自校验**（原 49、82 行的 `clipboardImage()`/`clipboardImageAny()`），改为以原生 Office 粘贴轮为唯一权威——桥写入的剪贴板不保证对 Electron 可读回，但 Office 能读。
   - 临时诊断开关（定位后应清理）：`TYPORA_OFFICE_IMAGE_ONLY`（跳 table 步骤）、`TYPORA_OFFICE_DIRECT`（主进程直接桥写、绕渲染链）、`TYPORA_OFFICE_NOCLIP`（跳过 finally 的剪贴板保存/恢复）、`TYPORA_OFFICE_SYNC`（同步 execFileSync）、`TYPORA_OFFICE_SYNC_PROBE`（同步跑简化 probe）。默认全部关闭。

### 新建的临时诊断文件（定位后可删除）

- `D:\BuyKey\Typora-Editor-App\scripts\clipboard-electron-probe.cjs`：最小 Electron 二分探针，参数 `<winmode> <execmode>`（winmode=nowindow|blank|img|editor，execmode=sync|async），用于区分窗口/渲染内容/调用方式对挂起的影响。
- `D:\BuyKey\Typora-Editor-App\.perf\media-office-1.0.15\word-save-probe.ps1`：简化 Word 粘贴+保存探针（`-Test write-clipboard|empty-save|paste-save|paste-close`）。
- `D:\BuyKey\Typora-Editor-App\.perf\media-office-1.0.15\probe-image.b64`：从 workspace/media.md 提取的测试 PNG base64（1800 字符，640×320）。

### 环境清理确认

- 两处测试遗留的僵尸 WINWORD 已核实归属（`/Automation -Embedding`、无窗口、创建时间与测试吻合）并 `taskkill //PID <pid> //T //F` 清理干净（PID 11676、34764 及其 ai.exe 子进程）。**当前无残留 Office 进程**。

## 二、根因二分：精确卡点在 Word SaveAs2

### 已确认的事实链（按时间，均以实际日志为准）

1. 原超时死无输出。加固 ps1 加分步日志后，第一次复跑得到关键证据：剪贴板格式正常（`Bitmap, PNG, System.Drawing.Bitmap`），Word 粘贴**成功**（280ms，`InlineShapes.Count=1`），随后 **`SaveAs2` 挂起**——不是 Paste 挂，也不是进程启动挂。
2. 独立 PowerShell 探针（WinForms 写剪贴板、进程写完后退出）→ Word 粘贴+保存 100ms 正常。
3. 桥写入（node 进程存活 20s）→ 正常。
4. 桥写入（Electron **headless** 主进程，无窗口）→ 正常。
5. 桥写入（Electron + blank window）→ 正常。
6. 桥写入（Electron + 同一 PNG 的 `<img>` 窗口）→ 正常。
7. 桥写入（Electron + contenteditable 窗口）→ 正常。
8. headless + **异步** execFile → 正常（排除"事件循环活跃"）。
9. 完整 app 环境 + **同步** execFileSync 跑**简化 probe** → 正常（一次成功）。
10. 完整 app 环境 + 同步/异步 execFileSync 跑**完整 office-native-verify.ps1** → 始终挂（`code=ETIMEDOUT` 或 `signal=SIGTERM`，均卡在 `SaveAs2`）。

### 结论

- **App 的 `copy-image` 改走 WinForms 桥是正确方向**：剪贴板内容、Word 粘贴、`InlineShapes.Count` 均已验证正常；独立进程、headless、各种窗口下 SaveAs2 都成功。
- **剩余矛盾点（GPT 下一步聚焦这里）**：完整 app 环境下，`word-save-probe.ps1` 的 SaveAs2 成功过一次，而 `office-native-verify.ps1` 的 SaveAs2 始终挂。两个脚本 Word 分支的差异只有三处，且都在 SaveAs2 之前：
  1. `Start-Office` 里的 `Get-Process` PID 查询 + 写 `pids.json`；
  2. `Documents.Count` 检查；
  3. `InlineShapes.Count` 查询。
  理论上这些不该影响 SaveAs2，但尚未逐一 A/B 排除。
- **未验证的假设**：Electron 主进程（完整 app 的 main.js 里有多处 `clipboard` 调用：`writeText`、`role:'copy'/'paste'` 菜单等）可能注册了剪贴板监视，与 Word SaveAs2 期间需要重新序列化图片数据的 OLE 渲染握手竞争。headless/blank 窗口不触发这个监视，所以成功。

## 三、GPT 下一步二分建议（按优先级）

1. **先复现矛盾**：完整 app 环境，桥写入剪贴板后，先 `execFileSync` 跑 `word-save-probe.ps1 -Test paste-save`（预期成功），再 `execFileSync` 跑 `office-native-verify.ps1 -Mode image -App word`（预期挂）。确认 probe 成功、verify 挂稳定可复现。
2. **逐条对齐**：把 verify 的 Word 分支逐步删到与 probe 相同（先删 `InlineShapes.Count`、再删 `Documents.Count` 检查、最后把 `Start-Office` 换成裸 `New-Object -ComObject`），每删一条重跑一次，锁定引入挂起的那一处。
3. **怀疑 main.js 剪贴板监视**：若 probe 成功但 verify 挂与脚本差异无关，转查 `app/main/main.js` 里所有 `clipboard.*` 调用（`writeText`、`role:'copy'`/`'paste'`、`tree-copy` handler 等），临时注释掉重测。定位到是哪个剪贴板 API 让 Electron 持有监视后，绕开它（或用 `clipboard.clear()` 时机调整）。
4. **验证修复的最终形态**：一旦完整 app 环境下 Word/Excel/PPT 三端 SaveAs2 都成功，跑 `TYPORA_OFFICE_NATIVE=1 node scripts/run-electron-test.mjs media-office`（去掉所有 `TYPORA_OFFICE_*` 诊断开关），SHA256 媒体比对（已实现）三端全过才算 P0-1 完成。
5. **修正 ps1 的 PID 抓取**：`Get-Process -Name WINWORD` 当前抓不到（进程名可能不含 .EXE 后缀匹配问题），改用 `Get-Process winword` 或恢复 `Get-CimInstance`（但保留"启动前/后差集"逻辑），确保超时 taskkill 能精确清理。

## 四、本轮未动的剩余工作（直接沿用 GLM 文档第六节）

P0-1 之外的所有事项**本轮未开始**，清单不变，逐字沿用 GLM 文档：

- **P0-2** `app/main/doc.js:94-97` openFile 在 `images.mask` 成功前就 `disposeCompletion()`+`cancelTimers()`，失败路径无 `scheduleProtection()`（旧文档补全/自动保存保护丢失）。
- **P0-3** `doc.js:147-160` 另存为不处理已有相对路径图片重定位（新粘贴/拖放走内嵌 `images.insert`，此问题只影响旧文档既有相对引用）。
- **P0-4** `portable-images.cjs` 打开时 >20MB/不支持格式/损坏 base64 抛错阻断整篇文档打开；`doc.js:264` checkFile unhandled rejection、`doc.js:407` reload 空 catch、provider `maskSync` 裸调用。
- **P0-5** 生命周期测试（粘贴→删除→保存→撤销→重开、缩放 undo/redo、自动保存中编辑、外部冲突、只读/锁定/另存为副本）+ VSIX 真宿主 smoke（`test/vscode-smoke.cjs` 内嵌语义断言改造）。
- **P1-1** Word 重渲染最新 DOCX 复查矩阵括号/嵌套列表 + 扩充导出测试。
- **P1-2** `office-math.mjs` PUA 占位符避让原文字符。
- **P1-3** 恢复 1.0.14 更多菜单被删项（`content-theme`/`outline`/`export`，打印/PDF/HTML 内置项；已从 `dist/release-1.0.14-final` 的 asar 确认原菜单内容）+ VSIX iframe 资源/CSP 验证。
- **P1-4** `portable-markdown.cjs` 边界单测。
- **P1-5** 取消导出误报成功修复（App `doc.js:347-351` + VSIX `markdownEditorProvider.js:133-137`）。
- **P1-6** 长数学笔记导出+编辑性能实测。
- **P2** 升版（App 1.0.15 / 插件 0.1.25-local）+ CHANGELOG + 最终 sync + 构建 EXE/VSIX + 产物核对 + 全量回归 + 交付报告。

## 五、运行命令与环境（同 GLM 文档第七节，补充本轮诊断开关）

App 根目录（PowerShell）：

```powershell
npm run sync
node --test scripts/media-core.test.cjs scripts/autosave.test.cjs scripts/snapshots.test.cjs
node --test scripts/export-assets.test.cjs scripts/server-auth.test.cjs
node scripts/run-electron-test.mjs media-office
$env:TYPORA_OFFICE_NATIVE='1'
try { node scripts/run-electron-test.mjs media-office } finally { Remove-Item Env:TYPORA_OFFICE_NATIVE }
```

本轮诊断开关（定位时用，交付前务必清空）：

```powershell
$env:TYPORA_OFFICE_IMAGE_ONLY='1'   # 跳 table 步骤，只测图片
$env:TYPORA_OFFICE_DIRECT='1'       # 主进程直接桥写，绕渲染 mediaRequest 链
$env:TYPORA_OFFICE_NOCLIP='1'       # 跳过 finally 的剪贴板保存/恢复
$env:TYPORA_OFFICE_SYNC='1'         # native() 用同步 execFileSync
$env:TYPORA_OFFICE_SYNC_PROBE='1'   # 跑简化 probe（word-save-probe.ps1）
```

最小 Electron 探针：

```powershell
node_modules/electron/dist/electron.exe scripts/clipboard-electron-probe.cjs <nowindow|blank|img|editor> <sync|async>
```

Office/Python/VS Code/Trae 路径与 Trae 隔离 profile、构建命令、边界声明，全部同 GLM 文档第七、八节，不重复。

## 六、纪律提醒

- 不要重问已定方案（默认内嵌图片）；不要调用付费 API；不要虚报测试结果（保留真实 `$LASTEXITCODE`）。
- GUI 检查串行执行避免抢剪贴板。
- 定位到根因前不要扩大 timeout 当作修复。
- 交付时附 GLM 文档第八节的边界声明。
