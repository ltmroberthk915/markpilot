# LOG B3.3a · 恢复副本一键恢复 / 丢弃

- 基线：`main` @ `74e3d39`（B3.2 已实装）。
- 工作树：`.agents/worktrees/b3.3a-recovery-ui`。
- 目标：让 B3.2 的恢复横幅从“只能看路径”变成用户可执行的恢复/丢弃。

## 1. 主机

- `LiveDocuments.readAppendRecovery(filePath, recoveryPath)`：
  - 只读打开 rooms DB，校验 host stamp；
  - 只接受 `recovery/agent-append` 目录的直接子文件；
  - 必须命中 `append_recovery` 行，且 bytes/sha256 与磁盘内容一致；
  - 返回 `{text,sha256,bytes,epoch,version,at}`。
- `discardAppendRecovery(filePath, recoveryPath)`：
  - 同样校验受控目录/host stamp/行存在；
  - 删除 `append_recovery` 行后删正文+sidecar；不删其它恢复副本。
- `documents.recover`：
  - 先走 `authority()`；拒绝 conflict/orphan/unsaved-elsewhere/bufferOwnedElsewhere；
  - 脏 buffer 拒绝（`MP_DOC_DIRTY`），避免覆盖用户未保存内容；
  - `baseVersion` 必须是当前 revisionId；clean 文档兼容编辑器上报的 providerVersion；
  - 先写 `pre-recovery` 归档，再 buffer append 全文替换或磁盘 CAS save；
  - 返回 `recovered:true`、新 token、`saved:false/true`、checkpoint/recoveryPath。
- `documents.discardRecovery`：只删指定 recovery 行/文件，不碰正文。
- 两个端点允许 UI HTTP（本地插件连接鉴权），路径/索引校验在主机侧；模型工具不暴露。

## 2. 客户端

- 恢复横幅每项增加按钮：`恢复`、`丢弃`、`复制路径`。
- `restoreLiveRecovered(index)`：
  - 调用 `documents.recover`，带 `doc.absPath`、`recoveryPath`、`doc.lastVersion`；
  - buffer 恢复：编辑器接收全文 append，提示“已恢复到编辑器缓冲区，请审阅后保存”；
  - disk 恢复：提示“已恢复到文件”，停 live 并重新从磁盘加载；
  - 失败保留横幅，显示错误码/消息。
- `discardLiveRecovered(index)`：确认后调用主机丢弃，成功移除该项。
- `removeLiveRecovered` 只更新当前代 `liveRecoveredItems`/`ui.recovered`，不继承到新文档。

## 3. 安全/边界

- 不允许任意路径：只接受 `%LOCALAPPDATA%\.markpilot\live-v1\recovery\agent-append\` 直接子文件 + 表行。
- 不允许覆盖脏 buffer；clean 文档才可恢复。
- 恢复前必有 `pre-recovery` 归档；归档失败拒绝恢复。
- 恢复不自动合并；磁盘 CAS 由 providerVersion 保护。
- 丢弃只影响选中的恢复副本，parked recovery 不动。

## 4. 测试

```text
npm test
tests 430, pass 429, fail 0, skipped 1
```

- `B3.3-S1/S2/S3`：buffer 恢复、脏 buffer/旧 token 拒绝、丢弃。
- `B3-API8`：真实 LiveDocuments append 副本 → 删房 → UI recover 写盘 → discard 删行。
- `B3.3-R1`：恢复路径越界拒绝、read/discard 校验。

## 5. 后续

- 真机：打开文档 → AI 改 → 删房 → 重开横幅 → 点恢复/丢弃 → 验证编辑器、磁盘、token。
- 未做：自动恢复、diff3、untitled/liveUnsupported 宿主草稿（B3.3b）。

## 6. 对抗修正

`.mp-verify/b3.3a/ADVERSARIAL.md` 的 1 个 P0 + 5 个 P1：

- **P0**：客户端 `doc.lastVersion` 是 provider/disk 版本，不是 `rev1:` token。recover 增加“clean 文档接受 providerVersion”的兼容分支；`B3-API8` 直接用 `baseVersion:'v0'` 复现客户端路径。
- **P1**：`discardRecovery` 增加与 recover 相同的 `checkWritePolicy`；新增只读沙箱用例；可信 UI（无 invocation）使用宿主默认策略。
- **P1**：buffer 恢复后 UI 不再只说“已恢复”，改为“已请求恢复到编辑器缓冲区”，并主动拉一次 snapshot 核对。
- **P1**：pre-recovery 归档先于 CAS 失败会留档（用户副本，保留不删，已登记）。
- **P1**：external 分支的编辑器广播/关窗时序未做真实并发夹；留作真机回归。
- **P1**：discard 改为先删文件、成功后再删 DB 行，避免“UI 说丢弃成功但盘上仍有不可索引文件”。
- **真机**：README 恢复横幅出现，`查看` 打开副本面板，`恢复/丢弃/复制路径` 按钮可见；首次点击因 UI 无 policy 返回“Cannot resolve filesystem policy”，修复为可信 UI 跳过 policy 后再次点击无错误、横幅消失。该次恢复的副本内容已因编辑器自动保存与当前正文相同，未把它当作“内容确实被替换”的最终证据；不同内容的替换由 `B3-API8`（磁盘）和 `B3.3-S1`（buffer）覆盖。

