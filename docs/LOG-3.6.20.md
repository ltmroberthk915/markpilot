# MarkPilot 3.6.20 桌面发布记录

基线是 3.6.19 已实装验收的桌面载荷；本版只改版本号并重新打包、安装、发布，不改编辑、保存、导出与协同协议。证据目录 `.mp-verify/desktop-release-3620/`。

## 基线与改动范围

- 3.6.19 候选（`.mp-verify/quote-keys-207/distribution/candidate.json`）记录的 23 个产品源码 SHA-256 与本轮 `MarkPilot-CM6/` 当前文件逐项一致；已装 3.6.19 的 `MarkPilot.exe` = `cccc994a527446c1b3041149a9d361074a7810d2a6e8d66f4303fe2d6012bb4a`，`resources/app.asar` = `2193feaa6f0d6040756ba6343726c19dfa280ab359a989a8cc0238d5cca80a0d`。
- 编辑内核源文件 `dsh-markpilot/src-cm6/` 的 3.6.19 修复（引用内 Shift+Enter、围栏增量扫描、补全非触发字符短路、历史锚点越界守卫）随本版提交；新增 `quote-keys.js`。
- 版本：`MarkPilot-CM6/package.json`、`package-lock.json` 从 3.6.19 改为 3.6.20；`app.js` 未重建，直接使用 3.6.19 验收过的字节（SHA-256 `0d6d653f10b2cdd06891d278a98e849677258b2af3f560f40b4e86a9864556bf`）。
- 发布提交 `3cd1107`，tag `v3.6.20` 指向该提交。提交只含 19 个桌面侧文件（`MarkPilot-CM6/`、`dsh-markpilot/src-cm6/`、对应 3 个质量测试、`docs/RELEASE-3.6.20.md`、`npm/markpilot-cm6/`），未改动 `dsh-markdown-editor-typora/` 与插件 2.0.7 发布文件。
- 分支说明：当前提交位于 `b4.2b-review-chain`（父提交 `2bbe3e8 release: 2.0.7`）；`main` 未推进，tag/Release 独立可用。

## 隔离打包

用 `tools/quality/package-candidate.cjs`，运行时取自已安装的 3.6.19（Electron 44.9.3），rcedit 为 electron-builder 缓存的 `rcedit-x64.exe`，builder 25.1.8，未重建引擎。

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `markpilot-Setup-3.6.20.exe` | 117,650,082 | `b0ddf6bdfeff4588353a3e6a734b5433b1c0d6cba065d3d6105d2c65448c8a4c` |
| `markpilot-3.6.20-portable.exe` | 117,388,793 | `3910314fd140ca6a812dcd185f1cf7bbac89f21b261746ac704129ee0db00d96` |
| `markpilot-quality-Setup-3.6.20.exe`（隔离 appId `app.markpilot.quality.3bdc351a12af413d8c1bcf8538c643e9`） | 117,585,086 | `f39603fbb1d17f108263524f6cb0e470e5bf2af4ea1dc3b818e62f949407bce8` |

- 打包后 exe：`4b41d09089222ec9a0a14307a4c958a0d3afd34bdbafd29251e5773bbc114704`；ASAR：`7e4a7333016d5c8712ccbe5c10a5e5131aec6a21af85952a4fef991acd76632d`（8,127,827 B）。PE `FileVersion=3.6.20.0`、`ProductVersion=3.6.20`、`ProductName=MarkPilot`。
- `tools/quality/verify-package.cjs` 拆开三个 EXE：3/3 载荷匹配，ASAR 成员集合与 `stage/app-source` 逐文件一致，运行时文件逐字节一致（`payload/result.json` 的 `passed=true`）。

## 实装与运行

- 隔离安装（`tools/quality/isolated-install.cjs`）：安装到 `.mp-verify/desktop-release-3620/isolated-install/installed`，原有 2 条 MarkPilot 注册记录保持；只新增 1 条隔离卸载项，目录、exe、asar 哈希均匹配。安装后跑真实键盘冒烟：`app.version=3.6.20`、打开磁盘一致、输入「冒烟 installed：中文与公式 `$a^2+b^2=c^2$`。」后落盘、错误条为空、console error 0。卸载后注册表恢复到安装前，隔离目录清空。
- 便携版：从 `markpilot-3.6.20-portable.exe` 启动，运行时 exe `4b41d090…`、asar `7e4a7333…` 与候选一致，真实键盘输入并落盘，console error 0。
- 生产安装版：`markpilot-Setup-3.6.20.exe /S /D="D:\Users\Ming\AppData\Local\Programs\MarkPilot CM6"` 覆盖升级原 3.6.19。安装前后各 79 个文件，逐文件对比只有 3 个变化：`MarkPilot.exe`、`resources/app.asar`、`Uninstall MarkPilot.exe`；其余运行时文件哈希不变。用户配置 `C:\Users\Ming\AppData\Roaming\MarkPilot` 488 个文件哈希清单前后完全一致。注册表 `MarkPilot 3.6.19` → `MarkPilot 3.6.20`，旧 `MarkPilot 2.3.3` 保留；桌面与开始菜单快捷方式目标存在。安装后同一套冒烟通过。回滚副本：`.mp-verify/desktop-release-3620/production-install/rollback-3.6.19/`。

## npm 桌面分发包

- 名称/归属：`markpilot-cm6` 在发布前查询为 404（可用）；发布账号 `ltmroberthk`（`npm whoami`），维护者与 `dsh-markdown-editor-typora` 相同。桌面工程 `private:true`，不直接发布工程；改为 `npm/markpilot-cm6/` 最小公开包（6 个文件，5.7 kB 打包、12.8 kB 解包），不含 117 MB EXE——npm 单包对百 MB 级 tarball 不适用，包内只放元数据、许可、SHA-256 清单和下载/启动 CLI。
- 内容：`package.json`、`README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`SHA256SUMS-3.6.20.txt`、`bin/markpilot.cjs`。CLI 支持 `--download [--portable] [--out]`、`--path`、`--exe`、`--version`，下载后逐字节核对 SHA-256；`--path` 通过卸载注册表定位真实安装目录。
- 本地验证：`npm pack` 后 tarball SHA-256 `0addb75079b3235eb96ee4099e480f164fadad1316accc09169ac56f4df52053`；临时 prefix 全局安装后 `--version=3.6.20`、`--path` 找到 `…\Programs\MarkPilot CM6\MarkPilot.exe`；本地 HTTP 测试下载 117,388,793 B 并通过哈希，投放坏哈希时按预期退出 1 且不留成品文件。
- 发布：`npm publish --access public` 经 WebAuthn 浏览器二次验证完成；`dist-tags.latest=3.6.20`，`dist.shasum=dacec882bed91c6d602451b09169851f6886e157`，`dist.integrity=sha512-IQGg//oHuI4ipIYiQiIt22AxzBOOQlhfSojugm0/n/VLUUf7hdKGAomj22xS53spmu830eJ7cfEgQY0/noRPnA==`。registry 下载的 tarball SHA-256 与本地 `0addb750…` 完全一致。
- registry 安装验证：全新 prefix 执行 `npm install -g markpilot-cm6@3.6.20` 后 `--version=3.6.20`、`--path` 正确；由该 registry 安装副本执行 `--download --portable`，从线上 Release 下载 `3910314f…`，字节数与 3.6.19 验收后的便携版一致。

## GitHub Release

- [MarkPilot 3.6.20](https://github.com/ltmroberthk915/markpilot/releases/tag/v3.6.20)，tag `v3.6.20`。
- 资产 digest 与本地一致：Setup `b0ddf6bd…`、portable `3910314f…`、`SHA256SUMS.txt` digest `30d4d748…`。资产大小分别为 117,650,082 / 117,388,793 / 189 B。
- Release 触发的 winget 工作流 `43435432873` 成功。

## 边界与已知限制

- npm 包的下载 CLI 在当前网络必须借系统代理：Node 内置 fetch 默认不读 Windows 系统代理，验证时用 `HTTP_PROXY`/`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`。已发布的 3.6.20 包没有自动探测系统代理；下一版应在 CLI 内做代理回退（或改用 `curl.exe` 兜底）。
- 本版没有重跑 3.6.19 的 40 套桌面回归与真实 IME；依据是 23 个源码哈希与已验收载荷完全一致、三个产物载荷逐字节核对、安装版/便携版真实键鼠冒烟。插件 2.0.7 的 npm 发布不在本任务范围。
- `main` 分支未推进；发布仅由 tag/Release 与实际资产承载。
