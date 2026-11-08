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
