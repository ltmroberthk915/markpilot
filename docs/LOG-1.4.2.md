# LOG 1.4.2 — DSH 文件工具写前守卫（B2，内部记录）

## 目的

1.4.0/1.4.1 修的是编辑器自身的恢复/归档；只要 DSH 的 `write/edit/apply_patch` 仍直写磁盘，AI/程序仍可在编辑器有未保存草稿时覆盖文件。1.4.2 在 MarkPilot 插件里注册 DSH 的文件写前守卫（不改 DSH 内核）：

- 目标文件在 MarkPilot 中打开且 `rooms.version !== rooms.saved`（有未保存草稿）→ 拒绝工具写入，提示先在编辑器保存/丢弃；
- 打开且干净 → 用当前 `fs` version 做 expected-version CAS；
- 未打开 → 保持原行为。

## 实现

- 注册 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent`（均 `{prepend:true}`）；每个 handler 先 `await next()`，**其他 policy 已给 intent 时不覆盖**（不弱化）；dirty 仍拒绝；base 为空且打开干净时补 CAS。
- 覆盖 `write` / `edit` / `apply_patch`（Add→write、Update/Move 源→edit、Move 目的→write、Delete→delete）与 `str_replace_editor`（写/编辑 intent）。
- 守卫判定以 **rooms 表为唯一真相**（跨进程/多窗口共享），不依赖本 host 的 `leases`；`rooms.sqlite` 用 `node:sqlite` **只读连接**查询，避免 `live.db` 首开建库/迁移/`hostStamp` 清库；DB 不存在或查询失败时 fail-open + 去重 warn。
- 安装防御：`ctx.on` 不存在时 no-op（测试 fake ctx）；同 ctx WeakSet 幂等；`ctx.effect` 持有 disposer；关闭 host 时关闭只读连接。
- `forceReload`（冲突横幅“重载磁盘版本”）：先拒绝 `dead/pendingApply/applyUnknown/saving`；先归档 `doc.recovery.text`（`pre-reload-recovery`），再归档 dirty 的 room 文本（`pre-reload`，优先 `pullText` 的 room 正文），任一失败不重载；归档期间有新编辑则取消。
- 错误：`MP_DOC_DIRTY`，message 带 `[MP_DOC_DIRTY]`、绝对路径和“在编辑器中保存或丢弃后重试”。

## 已知边界（不承诺覆盖）

- 只保护本 MarkPilot 插件已 join 的 live 房间：关 tab/HMR 时 `live.leave` 会删房间（即使脏），此后守卫不可见；此路径靠 1.4.1 的恢复槽/归档兜底。
- `liveUnsupported` 回退、untitled、baseline 缺失的文档没有 room，不在守卫范围。
- headless/CLI profile 不加载本插件（inject webServer），没有守卫；EXE 自身保存不走 DSH 工具（已有 `live.external` 冲突检查）。
- `pwsh`、terminal、computer-use 等写入口绕过守卫；守卫是纪律边界，不是安全沙箱。
- orphan 脏房间（clients 全死）会持续 deny，文案引导打开 MarkPilot 恢复/清理；不会静默放行。
- clean 打开时允许 delete（带 CAS）；产品语义待定。
- 只读 SQLite 打开失败（锁/权限/旧 Node）时守卫 fail-open，仅日志；此时依赖 P0 恢复槽。

## 验证

- 插件全量：`node --test test/*.test.mjs`（新增 `test/write-guard.test.mjs`；`recovery-safety` 新增 forceReload 归档/前置检查）。
- 对抗审查：设计评审 M1–M9（dsh-fs-audit）；独立审查 N1–N7；实现评审 P0-1/P1-1–P1-4 均已修。
- 真机验证：需重启桌面端；打开一个测试 md 并制造未保存草稿后，用带 `write` 工具的会话写同一文件，应得到 `MP_DOC_DIRTY` 且字节不变；干净打开时应成功或在竞争时 `FS_STALE_VERSION`；未打开文件保持现状。
