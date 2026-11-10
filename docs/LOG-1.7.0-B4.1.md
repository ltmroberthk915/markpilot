# LOG B4.1 · 文档块解析 / blockId / readToken / groupId

- 基线：`main` @ `2316d05`（B3.3a 已实装）。
- 工作树：`.agents/worktrees/b4.1-blocks`。
- 本批 host-only，不改 renderer。

## 1. 用户可见变化

- `markdown` 新增 `action:"blocks"`：返回文档顶层 section 的 `id/title/level/from/to/textLength/preview`，并带 `readToken`。
- `markdown edit` 支持 `blockId + newString`，按 section 整块替换，不再要求模型猜 `oldString`。
- read/edit 结果带 `readToken`；块编辑返回 `blockId` 和 `groupId`（供后续审查/撤销组使用）。
- 块 ID 由序号 + section 内容 sha8 组成；正文变化后旧 ID 失效，服务端 `MP_BLOCK_NOT_FOUND`，不会误改别的块。

## 2. 解析规则

- ATX 标题（`#`–`######`）开始新 section；标题前内容是 `preamble`。
- 围栏代码块（``` / ~~~）内的 `#` 不当标题。
- section 范围到下一个标题前；编辑整块时由调用方提供新文本（含或不含标题由调用方决定）。
- 不做 setext 标题、行内格式、列表/表格嵌套解析；这些留给后续 B4.3/选区协议。

## 3. 服务

- `parseDocumentBlocks(text)` / `findDocumentBlock(text,id)` 在 `documents-service.js` 导出。
- `applyEdits({blockId,newString,baseVersion})`：
  - 校验 block ID；找不到 → `MP_BLOCK_NOT_FOUND`。
  - buffer 需 `requireBufferBase`；磁盘需 `requireDiskBase` + `apiSave` CAS。
  - 生成单条全文替换 change（`from/to` 由服务端算），复用既有 checkpoint/recovery/policy。
  - 结果包含 `blockId`/`groupId`。
- `read` 结果增加 `readToken`（与 version 同源）。

## 4. 工具

- schema：`action` 枚举增加 `blocks`，新增 `blockId`，输出增加 `readToken/blockId/groupId/blocks[]`。
- `blocks` 执行：`documents.read` → `parseDocumentBlocks`，返回块数组与 readToken。
- `edit` 执行透传 `blockId`，返回块 ID/组 ID。
- render：blocks 列表、edit 的块 ID/groupId。

## 5. 测试

```text
npm test
tests 437, pass 436, fail 0, skipped 1
```

- `B4.1-S1`：heading/fence/preamble、ID 内容绑定、旧 ID 拒绝。
- `B4.1-S2/S3`：buffer 块替换、未知 blockId fail-closed。
- `B4.1-S4`：未打开文件 block edit 走磁盘 CAS。
- `B4.1-API1`：真实 live room 的 blocks → blockId edit → 正文；`groupId`/readToken。
- `host.test`：read 输出增加 readToken。

## 6. 边界/后续

- 不解析 setext/列表/表格/行内格式；不提供选区锚点。
- 每次 AI 编辑生成 `groupId`；buffer 与磁盘编辑都写入 `agent_group` 审计表（source/actor/kind/base/result/at），`documents.state` 返回最近 5 组。`groupId` 目前只用于审计，不提供回滚；B4.2 再消费。
- `blocks` 一次最多返回 200 个（`totalBlocks/truncated` 标明截断）；超大文档的解析/输出后续可加按需分页。
- 无 ATX 标题的文档标记为单个 `kind:'document'` 块，避免把纯段落误当普通 section。

## 7. 对抗修正

`.mp-verify/b4.1/ADVERSARIAL.md` 未发现 P0，6 条 P1/P2 已处理：

- **围栏闭合**：改为按开围栏长度校验，关闭行不允许尾随 info string；` ``` trailing ` 不再提前闭合。
- **返回的 blockId**：编辑后返回**新块 ID**（`previousBlockId` 为旧 ID），不再给模型一个立刻失效的 ID。
- **非末块尾随换行**：newString 无尾随 `\n` 时由服务端补一个，避免吞掉下一标题；`B4.1-S5` 固化。
- **无标题文档**：单块标 `kind:'document'`，不冒充普通 section。
- **blockId + oldString 同时给出**：`bad-request`，不做二选一猜测。
- **blocks 上限**：工具层截 200 并返回 `totalBlocks/truncated`；错误码写进工具说明。
- 未处理（已登记）：CRLF 磁盘夹具混合换行取证、setext 标题不解析。
- 已补：`groupId` 写入 `agent_group` 审计表，`state` 可读最近 5 组。

