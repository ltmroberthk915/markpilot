# MarkPilot 可移植质量工具

这套工具把“能加载的测试”“真实输入的结果”“发布文件身份”“源码能否重建”分别验证。它不把历史探针数量当作覆盖率，也不把有截图当作已经看过截图。

## 安装

Node.js 22 或更新版本。Windows 位图测试另需 PowerShell 7，并在可用的桌面会话中运行。

```powershell
npm ci --prefix tools/quality --ignore-scripts --no-audit --no-fund
npm run preflight --prefix tools/quality
npm test --prefix tools/quality
```

`MP_PLAYWRIGHT` 可指定已有的 playwright-core 包目录；`MP_PWSH` 可指定 pwsh.exe 的完整路径。无需下载 Playwright 的浏览器，测试连接被测 Electron 自带的 Chromium。

## 测已发布的 Windows 便携版

先下载官方发布文件，再把发布资产的 SHA256 填入命令。输出目录必须为空。

```powershell
node tools/quality/acceptance.cjs --exe C:/artifacts/markpilot-3.2.5-portable.exe --expected-sha256 df37e3e44bee42637da1dabddd6aeeab9d422aff61f5458505fc1dd19af77d2b --out .mp-verify/quality/acceptance
node tools/quality/critical.cjs --exe C:/artifacts/markpilot-3.2.5-portable.exe --expected-sha256 df37e3e44bee42637da1dabddd6aeeab9d422aff61f5458505fc1dd19af77d2b --out .mp-verify/quality/critical
node tools/quality/performance.cjs --exe C:/artifacts/markpilot-3.2.5-portable.exe --expected-sha256 df37e3e44bee42637da1dabddd6aeeab9d422aff61f5458505fc1dd19af77d2b --out .mp-verify/quality/performance
```

3.2.5 的 critical 套件会以非零退出码结束，已确认的产品缺陷保留为失败。详见 [3.2.5 审计记录](../../docs/LOG-3.2.5-AUDIT.md)。修复后应让相同判据通过，不应删掉失败判据或将其标成成功。

源码模式：把 `--exe` 换成 `--electron C:/runtime/electron.exe --app MarkPilot-CM6`。源码模式和便携版可能使用不同 Electron 版本，结果会记录实际运行版本，不能直接当作相同环境的性能对照。

## 工具与判据

| 工具 | 验证内容 | 不代表什么 |
| --- | --- | --- |
| preflight.cjs | 124 个历史 CJS 的语法、选定核心模块的提前使用、绝对 Playwright 安装路径 | 没有执行这 124 个产品场景；不是完整 JS 静态分析 |
| tests/ | 工具加载、SHA 拒绝、真实 TDZ 突变、锁归属、空套件、证据发布防串路径 | 不是产品功能验收 |
| acceptance.cjs | 真实键鼠、格式、Unicode、固定种子输入模型、公式、Mermaid、任务列表、拖选、保存、双窗口、输入延迟 | 不覆盖原生输入法合成、实际文件对话框或全部 Markdown 方言 |
| critical.cjs | Windows Bitmap→Ctrl+V→PNG→MD→重开；围栏/补全/导出；BOM/EOL/已保存内容/路径隔离；UTF-16 安全；未保存关窗保护 | 一个失败用例不等于一个独立根因 |
| data-safety.cjs | 窗口文档身份、保存回执、磁盘冲突、另存为、刷新/关闭、UTF-16 字节往返与无损拒绝 | 不覆盖所有 OS 对话框交互、崩溃恢复或跨进程文件锁 |
| performance.cjs | 1千/1万/10万行普通文本，1千/1万行公式；每档 5 次预热、30 个有效输入样本 | 没有 Typora 对照；含 CDP 往返和帧调度开销 |
| build-check.cjs | 在临时目录打包，比较重建 bundle 与仓库 bundle 的完整 SHA256 | SHA 不同不能直接证明行为不同，也不能证明行为等价 |

引擎的固定依赖安装和构建比较：

```powershell
npm ci --prefix dsh-markpilot --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node tools/quality/build-check.cjs --out .mp-verify/quality/build
```

所有应用启动自动使用同一 app-slot。旧探针可通过 `node scripts/acceptance/app-slot.cjs -- node tools/probes/<probe>.cjs ...` 串行运行；这几个新套件已经自行取锁，不要再包一层同一把锁。

新套件创建独立 profile，禁止迁移真实历史 profile，只写自己生成的 Markdown/图片。`MP_TEST_*` 跳过文件选择框；菜单回调或 Electron 输入挂点会按此口径记录，不能叫作真实点选了操作系统对话框。Windows 位图夹具暂时替换系统剪贴板，原数据仅保存在辅助进程内存，正常结束和输入管道关闭时恢复，结果中的恢复失败会阻止成功。

`setValue`/选区事务只用于准备夹具。被测动作使用 CDP 键鼠或已标明的原生菜单挂点，禁止构造 DOM 的 KeyboardEvent/PasteEvent 来冒充用户操作。截图中的红条是按 caret 坐标画的取证标记，不代表 CDP 拍到了原生光标。

## 发布小型证据

候选打包：`node tools/quality/package-candidate.cjs --runtime <已验证 runtime> --rcedit <rcedit.exe> --out <空目录> [--builder-cache <离线缓存>]`。它写入图标并回读 PE 版本，保留仓库引擎，生成正常 portable/Setup 与唯一 appId 的隔离测试 Setup。安装器会记录文件 SHA；未设置签名证书时是未签名候选。

`verify-package.cjs --candidate <候选目录> --7zip <7za.exe> --out <空目录>` 拆三个 EXE 的实际载荷，逐个核对内层 exe、asar 和源码哈希。`isolated-install.cjs install|verify|uninstall --candidate <候选目录> --out <.mp-verify下验证目录>` 只准安装隔离测试包，保留既有注册信息；未知结果先 verify，不重复安装。测试完运行 uninstall，再核对原有记录。正常 Setup 的用户升级需要另外验收。

窗口/编码修复可单独运行 `node tools/quality/data-safety.cjs --exe <实际 MarkPilot.exe 或 portable.exe> --scope sessions|encoding|all --out <空目录>`。`stage-app.cjs --runtime <已核验的 Electron runtime> --out <空目录>` 用当前壳源码及仓库 bundle 生成一次性 unpacked/asar；它不下载运行时，也不重建引擎。重封装产物与最终 portable/安装器分别测试和记录身份。

`mutate.cjs on|off --kind window-sessions|receipt-revision|external-conflict|utf16-read|utf16-write --app <一次性源码副本> [--baseline-ref <Git提交>]` 提供可逆负向控制，拒绝直接修改产品工作区。on/off 可重复调用，恢复时核对文件 SHA 防止覆盖后来修改。窗口/codec 回退必须给真实 Git 基线。回执 GUI 可用 `--scope sessions --case save-receipt-does-not-clear-later-edit` 独立复跑；磁盘测试用 `MP_TEST_DOCUMENT_STORE=<副本/shell/document-store.js>` 指向突变副本，不能把预期非零退出当通过。

截图现在同时保存全图及 2 倍 caret 局部图，必须有可测的 caret 坐标；`publish-evidence.cjs` 核对两类图片哈希。跨 IPC 的异步等待使用 `waitUntil` 真正 await 每次谓词，避免 Promise 本身为真而提前放行。

```powershell
node tools/quality/publish-evidence.cjs --in .mp-verify/quality/critical --out docs/verification/quality-3.2.5/critical
```

只发布 result.json 与清单内、哈希匹配的 PNG。每帧不超过 1MiB、整批不超过 5MiB；机器路径替换、长内联文本摘要化。浏览器 profile、安装包、下载文件、临时 bundle、模型会话和凭据都留在被忽略的 `.mp-verify/`。发布前仍应确认输入只包含合成夹具，不含用户文档。

`ci/quality-tools.yml` 提供 Windows/Linux 的安装、预检和工具自测模板。当前 GitHub OAuth 凭据没有 `workflow` scope，因此本次把模板公开在工具目录，尚未启用 Actions，也没有声称云端 CI 通过。具备工作流写入权限后，将模板放入 `.github/workflows/quality-tools.yml` 即可启用。桌面交互测试仍由有桌面会话的机器运行。

PDF 的只读文本检查另需 Python 与 pypdf；安装 pypdf 后运行 `python tools/quality/pdf-text-check.py <file.pdf> --expect <当前文档独有标记> --forbid <另一文档独有标记>`。若 PATH 有 Poppler 的 `pdftotext`，会同时保留两种提取结果。至少一个提取器必须读出全部正向标记，任何提取器读出禁用标记都会失败；不归一化重复文本，也不能用文本检查代替打开实际页面。
