# MarkPilot 2.0.5

## 主题

另存为在 Desktop 真机被 `FS_SANDBOX_DENIED` 误拒的修复，以及配套的原子创建、read-only 边界和临时文件清理。

## 修复

- **另存为不再被 workspace-write 沙箱误拒**
  - 仍然优先走 `ctx.fs.writeText({kind:'createIfAbsent'})`；
  - 只有 `FS_SANDBOX_DENIED` 且不是 read-only 时，才回退到编辑面的本地 staged 创建；
  - 虚拟 provider、read-only 模式保持原错误，不越过围栏。
- **原子创建**
  - 本地回退使用同目录 `.mp-tmp-*`；
  - Windows 走 `safeFile.prepareFile({baseline:null})` + `writeFile(temp,'r+')` + `commit()`；
  - POSIX 走 `open(temp,'wx')` + `write` + `fsync` + `link`；
  - 失败不留下半截目标文件，成功后用真实 `fs.stat` version 回执。
- **read-only 判定**
  - 用 `fs.sandboxMode === 'read-only'` 或精确的 `under read-only mode` 判定，不再因目标路径里出现 `read-only` 字样而误拒。
- **临时文件**
  - `.mp-tmp-*` 在成功和普通失败后清理；
  - safeFile 明确要求保留恢复副本（`preserveTemp`）时保留。
- **编码**
  - 另存为副本改用 `textCodec.encodeDocument`，孤立代理不再被静默替换为 U+FFFD。

## 验证

- 单元/集成：**544 tests / 543 pass / 1 skip / 0 fail**。
- Desktop 2.0.5 真机：
  - 只读 `g3mirror2.md` → 另存为 `g3mirror2-copy.md` 成功；
  - 副本内容为当时编辑器正文，源文件未被覆盖；
  - 源目录无 `.mp-tmp-*` 残留。
- 覆盖场景：missing、rename 候选、readonly、recovery center、saveAs、冲突/共享会话结束重载。

## 已知边界

- 另存为副本按 UTF-8 / LF / 无 BOM 写出；不继承源文件的 BOM/EOL/UTF-16 元数据。
- 编辑面是操作者能力：HTTP 编辑器端点通过宿主连接认证，不绑定模型工具权限。
- POSIX native 分支已实现但当前桌面验收以 Windows 为准。
- 普通保存失败（非另存）在只读路径上仍可能留下一个 `.mp-tmp-*`，已记录为独立待查项，不属于本次另存修复。
