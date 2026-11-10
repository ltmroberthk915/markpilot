# dsh-markdown-editor-typora 1.4.0（更名收据 + 修复记录）

内部记录，不进入 README / Release 说明。2026-11-08。

## 更名

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `dsh-markdown-typora` | `dsh-markdown-editor-typora` |
| 目录 | `dsh-markdown-typora/` | `dsh-markdown-editor-typora/` |
| bundle id / patch name | `dsh-markdown-typora` | `dsh-markdown-editor-typora` |
| 宿主路由前缀 | `/dsh-markdown-typora` | `/dsh-markdown-editor-typora` |
| 右侧栏 tab 类型 | `dsh-markdown-typora/editor` | `dsh-markdown-editor-typora/editor` |
| 恢复槽键前缀 | `dsh-markdown-typora:recovery:` | `dsh-markdown-editor-typora:recovery:` |
| 版本 | 1.3.2（未发布） | 1.4.0 |

保留不变（避免丢用户数据/破坏宿主约定）：`dsh.markpilot.*` 设置与最近文档存储、`dsh.markpilot.handles.v1`、文件地址协议 `dsh-resource://`、Markdown 工具名 `markdown`、诊断键 `window.__DSH_MARKDOWN__`。

## 本次同时发布的修复

1. 外部修改不刷新：live 房间新增 `refresh` 入口（HTTP `/api/live` action=`refresh`）并在 SSE/可见性/保存后对账接入；干净文档自动采纳，脏草稿显示冲突横幅。
2. 主题保持：`dsh-bridge.js` 不再在 iframe boot / 宿主明暗切换时用 telari 默认覆盖用户主题，改为只切同族（`mpTheme.sibling`）。
3. 侧栏手柄：拖动位置此前只写不读；新增冷启动/切会话恢复（0/400/1400ms + 会话切换后 420ms）。
4. 透明恢复：主题应用后重新断言 `data-mp-transparent` 并清内联背景。
5. 对抗验证后的加固：live 刷新在本地 dirty/保存中不自动采纳；失败不再静默（横幅）；`MP_FILE_CONFLICT/MISSING/BUSY` 有界重试；恢复后重置冲突 phase。

## 兼容性说明

- 旧 tab 类型 `dsh-markdown-typora/editor` 不再注册：升级后宿主 layout 里残留的旧 tab 可能显示为未知类型，重启后按需重开文档。
- 旧恢复槽键前缀不再读取；未保存草稿如需迁移，可在旧 profile 存储里按新前缀改名。
- 旧包 `dsh-markdown-typora` 不删除，保留在 1.3.x；升级后应从 profile 移除旧包，避免两个插件同时挂载 `markdown` 工具与右侧栏 tab kind。

## 验证

- 全量测试：342 项，341 通过、1 项 POSIX 跳过、0 失败（更名后按新路由/tab/恢复槽断言）。
- `node scripts/sync-core.mjs --check`、`node scripts/sync-host.mjs` 均通过。
- 打包：`dsh-markdown-editor-typora-1.4.0.tgz`（见发布记录哈希）。

## 1.4.0 发布与验证（2026-11-08 13:35–13:45）

- Git main `6b56420`，标签 `dsh-markdown-editor-typora-v1.4.0`（轻量标签）。
- GitHub Release：https://github.com/ltmroberthk915/markpilot/releases/tag/dsh-markdown-editor-typora-v1.4.0 ，资产 `dsh-markdown-editor-typora-1.4.0.tgz`，2,761,504 字节。
- TGZ SHA-256：`7bed7827a9e269ad93ac4f3d656f5347fd2d3c5c5ece90b6d0316dafbc431bdd`；GitHub asset digest、npm 下载包、本地打包三方一致（worktree 与 D:\BuyKey\markpilot-public 两个 checkout 各自 npm pack 同哈希）。
- npm：`dsh-markdown-editor-typora@1.4.0` 已发布，latest=1.4.0。首次发布新包名时 npm 先建了一个 `0.0.0-stage` 占位（staged publishing），随后 1.4.0 正常可见；两者同属本账号。
- 旧包 `dsh-markdown-typora@1.3.1` 已 `npm deprecate`，提示安装新包；旧包不删除。
- 本机 desktop profile：依赖键、bundles 条目、pnpm-lock 与 node_modules junction 全部从旧名换到 `dsh-markdown-editor-typora`（备份 `D:\BuyKey\dsh-backup-desktop-rename-20261108-133335`）；旧 junction 只指向旧目录，已按目标校验后移除。
- headless profile 仍是旧的 `dsh-markdown-typora@1.3.1`，待桌面验证通过后升级/替换。
- 市场文案与 PR 由另一会话负责（用户明确不让我改），本记录不涉及。

## 打包复核

- `package.json` name=`dsh-markdown-editor-typora` version=`1.4.0`，repository.directory/homepage 已指向新目录。
- 解包复核：`cordis.patch.yml` id/name 均为新名；shipped js 中无旧路由 `/dsh-markdown-typora`、旧 tab `dsh-markdown-typora/editor`、旧恢复槽前缀。
- `node scripts/sync-core.mjs --check` 通过；`node scripts/sync-host.mjs` → `HOST_SYNC_OK 9 files`。

## 独立对抗验证（子代理）与处置（2026-11-08 13:20–13:45）

子代理在隔离 harness（真实 HTTP + 真实文件系统 + 临时 LOCALAPPDATA 的 rooms.sqlite）自建 48 个对抗用例，结论：**未能证伪核心刷新修复**（48/48 通过；官方 external-refresh 9/9；仓库 342 项 341 pass / 1 skip）。核心链路 SSE → host refresh → 房间 adopt → exchange delta → 正文，在写类型、大文件、Unicode/路径别名、冲突、双窗口、双外部写者下自洽。

### 已按报告处置

- **R1（编辑中误采纳）**：`refreshLiveRoom()` 在非 discard 路径先检查 `doc.dirty / doc.conflict / doc.saving`，命中就只弹冲突横幅、不自动采纳。
- **R2（失败静默）**：refresh 失败改为冲突横幅（带错误码），不再 `return null` 静默；外部删除/编码错误可见。
- **R3（瞬时冲突不重试）**：`MP_FILE_CONFLICT / MP_FILE_MISSING / MP_FILE_BUSY` 有界重试（最多 2 次，300/600ms）。
- **R5（成功后 phase 不重置）**：refresh 成功且无脏草稿时，若仍停在 conflict 则回到 ready。
- **R-extra（官方测试碰真实数据库）**：`test/external-refresh.test.mjs` 改为给 `createHost` 传临时目录的 `LiveDocuments`，结束 `retireLiveStorage()` 并删临时目录；跑测试不再 sweep 用户真实 `%LOCALAPPDATA%\.markpilot\live-v1`（已核对真实 rooms.sqlite 的 mtime 不再变化）。

### 记录在案、暂不改动

- **R4（banner 的「重载磁盘版本」走 forceReload 而非 refresh(discard)）**：现有 forceReload（leave→以磁盘重载）经子代理 15/15 并发用例验证可用；`refresh(discard)` 的宿主路径也已由 C1/C2 验证。UI 改走 discard 会改变“关房间/丢房间草稿”的语义，留到 1.4.1 在真实浏览器复验后处理，避免在改名发版这一版引入新的编辑期风险。
- **R6（无浏览器级验证）**：`post("live-refresh")` 是 fire-and-forget，facade 重基只能在真实 DSH 窗口验证——由用户重启后实测。
- **R7（无跨 OS 进程/UNC/慢盘/>2MB/MP_SAVE_BUSY 覆盖）**：同进程双 host + SQLite/WAL 已验证；跨进程与极端 IO 属后续测试扩展。
- **R8（Windows 句柄语义）**：目标被打开时 rename 返回 EPERM，是 Windows 行为，不是插件缺陷。
