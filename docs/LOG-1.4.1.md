# LOG 1.4.1 — 恢复草稿安全与归档（内部记录）

## 背景

1.4.0 的恢复横幅按“路径”查询草稿，但保存/关闭清理按“打开实例 token”执行：历史未解决的草稿不会被任何后续保存清除，每次打开都会再次弹出；且“恢复”会把旧草稿直接写回当前文件，没有备份。

1.4.1 的目标是：**恢复动作只对与当前磁盘版本一致的草稿生效；与磁盘版本不一致的历史草稿先归档再清除；归档失败时保留可重试入口；恢复过程中出现新编辑或磁盘版本变化时取消恢复。**

## 行为变化

- `createDraftStore.clear` 拒收空 `docToken`（真实 IndexedDB 的 `getAllKeys(undefined)` 会匹配全部记录，legacy 槽无 token 时曾存在全库清理风险）。
- 恢复槽判定新增 `sameRecoveryBase(slot, currentVersion)`：
  - untitled 草稿（两侧均无磁盘版本）→ 可恢复；
  - 其余情况必须两侧都是非空字符串且相等。
- 首次打开与“恢复”动作：
  - 草稿文本与当前正文相同 → 清记录，不提示；
  - 草稿基于旧磁盘版本 → 调用 `docs/archive` 归档后清除，不提供“恢复”入口；
  - 归档失败 → 错误横幅 + `staleDraftPending`，可重试；不覆盖当前文件。
- `docs/archive` 端点（插件 host）：
  - 归档到 `%LOCALAPPDATA%\.markpilot\draft-archive\<原名>.<tag>.<sha16>.md` + `.meta.json`；
  - 源路径只参与命名/元数据，不写源文件；
  - 同名同内容幂等；并发 rename 失败时回读目标 sha 兜底。
- 恢复动作：
  - 恢复前把当前正文归档为 `pre-restore`，失败即取消；
  - 恢复后不再自动写盘，用户按 `Ctrl+S` 才提交（药丸提示“未保存 · 按 Ctrl+S 保存”）；
  - 备份 await 后重新校验 `editSeq`、dirty、磁盘版本；期间出现新编辑则取消并保留恢复槽，版本变化则改走 stale 归档。
- 保存成功：
  - `await markSaved` 后再判断保存期间是否有新编辑（避免 await 窗口丢字）；
  - legacy 槽内容与本次保存文本不同时先 `legacy-draft` 归档再清；归档失败保留槽；
  - 恢复记录更新失败时提示，不再静默。
- 恢复横幅可见时按 `Ctrl+S`：提示“先恢复或丢弃”，不再内部产生“已保存”回执。
- 恢复前备份失败时错误横幅提供“重试 / 丢弃恢复内容”，重试回到恢复流程而不是重载磁盘。

## 验证

- 插件全量：`node --test test/*.test.mjs`（29 文件）= **363 tests / 362 pass / 1 skipped / 0 fail**。
- 新增：`test/archive-endpoint.test.mjs`、`test/recovery-safety.test.mjs`。
- 独立对抗审查：
  - 第一轮发现保存 await 竞态（已修）；
  - 第二轮发现 `clear(undefined)` 全库清理、恢复备份 TOCTOU、恢复提示不可见、备份失败出口丢失（已修）；
  - 第三轮确认 M1–M6 通过，并发现“休眠 recovery 槽劫持重试”（已用 `recoveryBackupFailed` 专用标志修复，重试/丢弃只在备份失败上下文出现）；
  - 独立复核确认 M1–M4 + legacy 归档通过；全量测试在更新 M3 文案断言后回到 0 fail。

## 已知后续（不阻断 1.4.1）

- 跨窗口“另一窗口已保存、本窗口旧脏草稿”仍会被判 stale 归档（文本进归档，不再覆盖；无应用内常驻入口）。
- `pre-restore` 归档的是打开时已知文本，不是点击恢复那一刻的磁盘字节；外部写入由保存版本守卫与备份后重查兜住。
- `flushClose` 不补发待执行的防抖保存；关闭前最后几字仍依赖恢复槽。
- 顶部提示 rail、全部提示迁移、归档入口（复制路径/打开目录）属 batch 2。
