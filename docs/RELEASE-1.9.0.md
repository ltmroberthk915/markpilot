# MarkPilot 1.9.0-rc.6 发布候选（B4.3 + B3.3b 草稿镜像）

日期：2026-11-11

## 内容

- B4.3 冲突解决：`documents.conflictOpen/Resolve/Cancel`，面板支持「用我的 / 用磁盘 / 两边保留 / 手动编辑」。
- resolve 只改缓冲区，不写磁盘；写盘仍由 `live.save` 的 version + materialize + diskHash + `room_resolved` 四重校验放行。
- 「用我的」零正文解决写入 `room_resolved`；undo 用空哨兵撤销写授权；`markResolved` 记录用户批准的磁盘 hash。
- 修复 live 保存误用父窗口镜像：`mpEngine.setValue`/整篇替换走引擎旁路不发 delta，保存改为向引擎请求当前全文。
- 修复 no-op resolve 后 `doc.dirty` 未置、review phase 丢失、reviewKeep 保存、`applyConflict` changed 分支 dirty 防御。
- 修复 sealed keep-mine 未清 `room_resolved` 导致的保存死路（N1）。

## B3.3b 草稿镜像（rc.2 新增）

- `rooms.sqlite.draft_index` 只读镜像：8 MiB/条、512 条、128 MiB、14 天。
- live facade 不可用（`MP_LIVE_FACADE_MISSING`）时，客户端 dirty 即上报当前 buffer（leading-edge + 1.5s debounce）。
- `documents.read` 在无 live room/clean room 0 members 时返回 `source:'mirror'`、当前正文、`writable:false`。
- base 不匹配返回 `draftStale`、不返回 mirror 正文；mirror token 不能作为写基线。
- `applyEdits` 对 mirror/stale/unknown 返回 `MP_DOC_MIRROR_READONLY`。
- 保存成功/clean close 清理 mirror；dirty close 保留供重启定位；打开时 `draftRead` 探测旧句柄。
- 新表独立，不改 `rooms` 8 列布局，旧 EXE 不读该表。

## 验证

- `npm test`：511 / 510 pass / 1 skip / 0 fail。
- `sync-host --check`：9 files；`sync-core --check`：124 files / 7,351,676 bytes；coreHash `4499e09378a8743fd1ec985c11bf8046f33b55350688dd9d996b839fe0d589ba`。
- Web 独立 `mp-web-test` 真机（未操作 Desktop）：
  - 「用我的」→ 写盘 `mine`，`rooms.saved=1`，`room_resolved` 清空；
  - AI append 进引擎，无 `Position out of range`；
  - review「保留并保存」→ `/api/save`，磁盘 `ai2`，`rooms.saved=3`；
  - 「用磁盘」→ 磁盘 `theirs`，`rooms.saved=2`；
  - 「两边保留」→ 磁盘 `ours2\ndisk2`，`rooms.saved=4`。

## 已知限制 / 发布前最后检查

- 真实 OS 键盘 Ctrl+S 尚未稳定复现；现有证据是 `mpHost.__save()`（与 Ctrl+S 同一入口，但不覆盖键盘焦点路由）。
- 「手动编辑」textarea 的 Web 面板真实点击仍缺一条；host resolve 与客户端 manual payload 已有测试。
- 双客户端 `resolvedDisk`/R1 未在 Web 双窗口验证。
- 超过约 3000 行文档的冲突面板会返回 `MP_MERGE_LIMIT`（fail-closed，提示重载/复制），尚未做友好 UI 提示。
- `room_resolved` 旧 root 不认识该表；混合版本宿主不要共用同一文档。
- 新测试 `test/client-conflict-ui.test.mjs`、`client-draft-mirror.test.mjs`、`live-draft-index.test.mjs` 与本文档均已随 25f569b 提交。
- 旧 `1.9.0.tgz`、`1.9.0-rc.1.tgz`、`1.9.0-rc.2.tgz` 为 GA 前产物，不得按文件名安装或重发。
- B3.3b mirror 仍可能被 stale client / PID 复用误判为活房间；不自动删除未知归属的新一代 mirror。

## 产物

- `dsh-markdown-editor-typora-1.9.0-rc.6.tgz`
- 149 files / 2.8 MB
- SHA256 `71A305D3A77B9D85337A0A300BE6924867E42E5E8BD278627755146C66DE4F79`
- 源码冻结提交 `a3b2085`（GA cleanup：移除 debug hooks、补 lifecycle 测试、README/SHA）

**注意**：rc.1 与更早的 1.9.0 包在 B3.3b 之前构建，不包含 `draft_index`/mirror 代码；rc.2 为 B4.3+B3.3b 的新候选，不能与 rc.1 混用。

## 包安装验证

- rc.6 已在隔离 profile `~/.dsh/profiles/mp-pkg-test` 中从 tarball 安装成功（pnpm `file:` 包，版本 1.9.0-rc.6）；
- rc.2 的 Markdown 面板/编辑器加载已通过；rc.3 移除 debug hooks、补测试；rc.4/rc.5 仅 README/版本/hash 清理，包结构一致；
- 未在 DSH Desktop 安装；正式实装前需用户明确确认。
