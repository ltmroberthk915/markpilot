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
tests 429, pass 428, fail 0, skipped 1
```

- `B3.3-S1/S2/S3`：buffer 恢复、脏 buffer/旧 token 拒绝、丢弃。
- `B3-API8`：真实 LiveDocuments append 副本 → 删房 → UI recover 写盘 → discard 删行。
- `B3.3-R1`：恢复路径越界拒绝、read/discard 校验。

## 5. 后续

- 真机：打开文档 → AI 改 → 删房 → 重开横幅 → 点恢复/丢弃 → 验证编辑器、磁盘、token。
- 未做：自动恢复、diff3、untitled/liveUnsupported 宿主草稿（B3.3b）。
