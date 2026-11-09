# B3 设计草案：`documents.*` 文档服务（宿主权威层）

> 状态：**草案，等待对抗审阅**。不写产品代码，直到本稿经子代理对抗并收敛。
>
> 基线：`main` / `8d49f55` / 插件 1.6.0。B1a、B1b、B1c、B2 已交付。
> 本批只讨论 **B3.1**；B3.2（草稿 WAL 上移、reconcile UI）与 B4（块/选区协议）各自单独立项。

---

## 1. 现状：同一份正文有四个"真相"

| 层 | 保存形态 | 谁是写者 | 崩溃后是否还在 |
| --- | --- | --- | --- |
| 编辑器 CM6 buffer | 内存 | 用户输入（iframe 内） | 否 |
| 父窗口镜像 + IndexedDB WAL | checkpoint + 连续 delta + localStorage 尾 | 父窗口（每次 delta） | 是（浏览器侧） |
| `LiveDocuments` room | SQLite `rooms.checkpoint` + `changes`（有序增量） | 每个编辑器 client 的 exchange | 是（`%LOCALAPPDATA%\.markpilot\live-v1\rooms.sqlite`） |
| 磁盘文件 | 原子替换 + CAS | 编辑器 save / AI `markdown` 工具 / 外部程序 | 是 |

外加两份"副本"：

- `recovery` 表 + `%LOCALAPPDATA%\.markpilot\live-v1\recovery\*.md`：崩溃孤儿房间的脏草稿；
- `%LOCALAPPDATA%\.markpilot\draft-archive\`：恢复前/退役前的归档副本（`docs/archive`）。

> 宿主侧真源补充（`.mp-verify/b3-inventory/HOST-INVENTORY.md`）：DSH 宿主里的 `DocumentStore` session 是"每次保存新建、用完即弃"的临时对象（`lib/index.js:622–641`、`document-store.js:14–16`），`revision/lastSavedRevision` 在 DSH 侧没有跨保存记忆；真正跨请求、跨进程的文档状态全在 `rooms.sqlite` 五张表。B3 的 revision 必须建立在**房间/SQLite**上，不能建立在 `DocumentStore` session 上。

四个真相之间**没有统一的 revision 语义**：

- 磁盘是 `ctx.fs` 的 `version`（`dev:ino:size:mtimeNs:ctimeNs`）；
- 房间是 `epoch` + 单调递增 `version` + `saved`；
- 父窗口是 `docToken` + `sourceRevision` + `editSeq`；
- IndexedDB WAL 又是 `session{epoch,sourceRevision}` + `checkpointId`。

### 1.1 由此产生的用户可见缺陷

1. **AI 看不到未保存内容**。`markdown.read` 走 `apiOpen(..., MODEL_TOOL, ...)`，只读磁盘；用户有未保存修改时，AI 读到的是旧文本。
2. **AI 写不进正在编辑的文档**。`markdown.edit` 走 `apiEdit`：先读盘，再 `fs.editText`，并包在 `live.external` 里；房间有未保存修改时 `live.external` 直接抛 `MP_FILE_CONFLICT`。B2 守卫还会在通用 `fs` 工具路径上先抛 `MP_DOC_DIRTY`。两条路都只"拒绝"，没有安全的应用通道。
3. **revision 不可互换**。AI 拿到的 `version` 是磁盘版本，编辑器/房间说的是房间版本；B4 要做 `readToken`、`replaceExact`、审计时没有共同基座。
4. **untitled / liveUnsupported 没有宿主级草稿索引**。它们不在 room 里，B2 守卫完全看不见；恢复依赖浏览器 IndexedDB。
5. **外部变更 reconciliation 分散**。`fs.watch` → SSE `change`、`live.refresh`、父窗口 `externalStale`、`DocumentStore.outsideChange` 四套判断，没有统一出口。

### 1.2 这次**不改**什么

- 不改 `renderer-cm6/`（core 同步产物，改了就 `CHECK_DRIFT`）。
- 不重写 `DocumentStore` / `LiveDocuments` 的磁盘事务与房间增量；只在 `LiveDocuments` 上做**加法**。
- 不改 DSH 内核、不改 `ctx.fs`、不接管通用 `fs` 写工具（那是 B5）。
- 不重建 EXE 安装产物；`MarkPilot-CM6/shell/live-documents.js` 的改动是向后兼容的加法，下次 EXE 构建自然带上。
- 不做块/选区解析、diff3、审查 UI（B4）。

---

## 2. 目标与非目标

### 2.1 B3.1 目标

| 编号 | 目标 | 用户可见判据 |
| --- | --- | --- |
| G1 | AI 读取**当前正文**（含编辑器未保存修改） | 用户改一段不保存，AI `read` 能看到这段 |
| G2 | AI 能在**当前正文**上原子应用编辑，不覆盖磁盘、不撞 dirty 死路 | AI 改一段，编辑器里立刻出现该修改并变脏；磁盘此时不变 |
| G3 | 每次应用都有**单一、可校验的 revision**，过期即拒 | 用户/AI 并发改同一段时，后手收到 `MP_DOC_STALE`，两边的文本都不丢 |
| G4 | 应用前有**可恢复检查点**（脏缓冲被改时） | AI 应用后能从归档/恢复副本找回改前文本 |
| G5 | 未打开的文档保持**磁盘 CAS** 语义 | 对没开的文件，AI 编辑仍然直接落盘、带版本守卫 |
| G6 | 不改 renderer / 不改内核 / 不改 B2 守卫 | `check:core` 仍绿；B2 负控仍红 |

> G1/G2 的适用范围：**有 live 房间的本地文件**（正常本地 .md）。untitled、`liveUnsupported`（引擎 facade 缺失）、虚拟 provider 投影文件没有房间，B3.1 仍按磁盘视图处理；它们的宿主级草稿是 B3.2 的范围。

### 2.2 与客户端旧协议的关系（回答盘点里的三个问题）

客户端盘点（`.mp-verify/b3-inventory/CLIENT-INVENTORY.md`）提出三个边界问题，B3.1 的答案固定如下：

1. **`documents.applyEdits` 不是 `save` 的替代品**。编辑器保存继续走 `runSave` 的全文拉取 + 盘 CAS + `live.save`（`client.js:5831–6009`）。`documents.applyEdits` 只服务 **AI / 模型工具**，替代的是旧 `markdown.edit` → `apiEdit` → `fs.editText` 那条路。`runSave`、`pullText`、`editedDuringSave`、STALE 退避、IME 让路全部不动。
2. **revision 不替换客户端的 `version`**。客户端 `doc.lastVersion`、`applyToFrame` 的 `baseVersion` 比较、`sameRecoveryBase`、SSE 的 `version` 比较继续使用 `ctx.fs` 的版本字符串；`documents.revisionId` 是**新增的、只给 AI 工具用**的 token，两者在宿主侧由同一份权威状态生成，但对外不混用。
3. **live 不并入 documents 服务**。引擎 facade ↔ 父窗口 ↔ `/api/live` 的 exchange 通道、`live-status` 消七条件、双 epoch 契约全部保留。`documents` 只是**宿主侧**读写房间的另一个入口（`readRoom`/`append`），不改变客户端 live 协议；`append` 产生的 `updates` 仍由现有 exchange 下发给所有 client。

因此 B3.1 的产品行为变化只有一条：**AI 的 `markdown.read/edit` 从"磁盘视图"变成"当前正文视图"**。编辑器本身的打开/保存/恢复/冲突/IME/撤销/多窗口协议零改动。

### 2.3 非目标（B3.1 明确不做）

- 不做 `documents.save`（AI 不替用户保存；保存仍走编辑器 Ctrl+S / 自动保存）。
- 不把 IndexedDB WAL 搬进宿主（B3.2 再评估）。
- 不做 untitled 文档的宿主会话（B3.2）。
- 不做 diff3 / 冲突自动合并（B4）。
- 不改变自动保存节拍、不清脏、不替用户决定保存时机。
- 不删除任何房间/恢复文件；不做归档 GC（B3.2 加保留策略）。

---

## 3. 权威选择规则（authority resolution）

所有 `documents.*` 操作先解析出一个**当前权威**，再读写。规则必须固定、可测：

```
resolve target = fs.resolve(path, cwd)
canonical = realpath-ish(canonicalTarget(target))
provider = apiOpen(target, MODEL_TOOL)      // 文本 + provider version（走 ctx.fs，执行读策略）
room = localRoomPath(target) ? live.readRoom(canonical) : null
diskChanged = room
  ? (room.savedTextAvailable ? normalize(provider.text) !== room.savedText : null)
  : false
```

> `localRoomPath` 只接受 `targetKey` 为本地绝对路径（盘符/UNC）的目标；虚拟 provider 的 targetKey（如 `dsh://…`）不尝试读房间，直接按磁盘权威处理，避免把虚拟路径 realpath 到本机不相关文件。

> 为什么不用 `DocumentStore.snapshot` 的磁盘字节哈希：`snapshot` 是本地文件的直读通道，绕过 `ctx.fs` 的会话读策略；模型工具不能借它判断/读取沙箱外文件。B3.1 统一用**provider 文本**与**房间 saved 文本**比较，既执行读策略，又不需要字节。

按顺序：

1. **room 存在且 `members > 0`（有活着的编辑器 client）**
   - **只要存在非本宿主成员**（`members > localMembers`，例如旧 EXE 3.6.17 或另一个 DSH 实例）→ **disk 权威 + `bufferOwnedElsewhere:true`**：旧 EXE 的 `leave` 会无条件删房（见 §12 #10），本宿主绝不能把 agent change 追加进它可能删掉的房间。房间干净时允许磁盘写（旧 EXE/另一 DSH 会按外部变更 adopt）；房间脏时读返回磁盘文本 + `unsavedElsewhere:true`，写一律 `MP_DOC_UNSAVED_ELSEWHERE`。
   - 只有本宿主成员（`members === localMembers`）时：
     - `diskChanged === false` → **buffer 权威**：正文 = `room.text`，revision = `rev1:live:<epoch>:<version>:<textSha>`。
     - `room.version === room.saved` 且 `diskChanged === true` → **disk 权威**：外部已改盘、编辑器尚未 adopt；正文取 provider 文本，revision = `rev1:disk:...`，结果标 `external:true`。写操作走磁盘 CAS（编辑器之后按 fresh 逻辑 adopt）。
     - `room.version !== room.saved` 且 `diskChanged === true` → **冲突权威**：读返回 buffer + `conflict:true`；写一律拒绝 `MP_DOC_EXTERNAL_CONFLICT`，要求用户先处理。
2. **room 存在、dirty、但 `members === 0`（崩溃孤儿）**
   - 读：provider 正文 + `orphanDraft:true`（不复活旧草稿）；写：拒绝 `MP_DOC_ORPHAN_DRAFT`。孤儿草稿由既有 `sweepOrphans` 在下次 join/external 时 park 成 recovery 文件。
3. **无 room** → **disk 权威**：正文 = provider 文本，revision = `rev1:disk:<providerVersion>:<textSha>`。

> `diskChanged:null` 的语义：房间脏且 `saved < floor`，无法重建"上次保存文本"来和磁盘比较。此时按 **buffer 权威** 处理，结果如实返回 `diskChanged:null`；`applyEdits` 允许改缓冲区，但下一次编辑器保存会在 `live.save` 的 diskHash 校验里暴露磁盘冲突（`MP_FILE_CONFLICT`），不会静默覆盖。B3.1 不为了"能判断"而给房间加新列；B3.2 再评估存 `savedText/磁盘版本`。
>
> EOL/BOM 口径：`provider.text` 与 `room.savedText` 比较前**只对 provider 文本做 `replace(/\r\n?/g,'\n')` + 去前导 `\uFEFF` 归一**，用于判定 `diskChanged`；**返回给调用方的 `text` 保持权威原文**（buffer=房间 LF 文本，disk=provider 原样文本），避免改变旧 `markdown.read`/`apiEdit` 的 `oldString` 匹配语义。`textSha256` 对**返回的 text** 计算。实测覆盖 BOM+CRLF 的 `B3-S1b`。
>
> 实测（`.mp-verify/b3-inventory/scratch-room.js`）：两个 client 交替 130 笔编辑后 `version=130, saved=0, floor=128`；对 `saved=0` 调 `materialize` 得到的是 checkpoint 在 floor 处的 134 字符文本，不是 130 笔前的 saved 文本。故 `savedTextAvailable` 必须按 `saved >= floor` 判定，不能无条件物化。

> 关键取舍：**绝不让"死会话的草稿"成为读/写权威**。旧事故的根因就是过期 draft 被当成当前正文；这里用"有没有活 client"把死草稿挡在门外。

`members` 的判定：`clients` 表里该 epoch 的 `pid` 仍通过 `process.kill(pid,0)`（与 `alive()` 同口径）。`localMembers` 是其中 `pid === process.pid` 的数量；`members > localMembers` 即存在旧 EXE/另一宿主进程的成员，权威退化为 disk（见上）。

> 已知近似：`clients.pid` 是**宿主进程**，不是浏览器 tab。tab 崩溃但宿主进程还在时，租约行会留到宿主关闭/显式 leave；因此 `members>0` 可能包含"已经没人看的 tab"。对本批的影响：读/写会以房间缓冲为权威，但**不写磁盘**；最坏情况是 AI 改了一份暂时无人显示的草稿，下次打开时以脏房间恢复。B3.2 可加租约心跳（或按 `leases` + 最近 exchange 时间）缩小这个窗口；B3.1 先接受并在测试里注明。

---

## 4. Revision token

### 4.1 形状

```text
rev1:live:<epoch>:<version>:<textSha256>
rev1:disk:<providerVersion>:<textSha256>
```

- `textSha256` = `sha256(utf8(text))`，`text` 是**本次返回给调用方的正文**：buffer 权威是房间 LF 文本，disk 权威是 provider 原样文本（可能含 BOM/CRLF）。比较 `diskChanged` 时才做 BOM/CRLF 归一，归一不改变返回文本与 token 哈希。
- 解析规则：live 用固定段正则；disk 用"前缀 + 最后一个 `:` 之后是 64 hex sha"切分，因此 `providerVersion` 内部含冒号不会切碎（实现见 `documents-service.js` 的 `parseRevisionId`）。
- `diskHash`（磁盘字节 sha256）单独返回，用于 `LiveDocuments` 的 adopt/保存校验；不塞进 token，避免同一文本因 BOM/EOL 不同产生两个 revision。

### 4.2 语义

- token 对调用方**不透明**，只做"读时拿到、写时回传"。
- 写操作必须同时满足：`token` 完全相等 **且** 当前权威的 `textSha256` 相等 **且** 房间 epoch/version（或磁盘 providerVersion）相等。
- 只比文本哈希不够：同一文本可能是"删了又加回来"，房间版本已前进，必须拒。
- token 里带 `textSha` 是为了在房间 checkpoint/compaction、跨进程读到撕裂文本时**尽早发现**，而不是替代版本比较。

### 4.3 返回字段

所有 `documents.*` 成功结果统一带：

```json
{
  "revisionId": "rev1:live:...",
  "revision": { "kind": "live", "epoch": "...", "version": 42, "savedVersion": 40, "diskHash": "..." },
  "textSha256": "...",
  "source": "buffer" | "disk",
  "dirty": true,
  "diskChanged": false,
  "orphanDraft": false
}
```

`kind:"disk"` 时 `revision` 为 `{kind:"disk", version:"<provider version>", diskHash:"..."}`。

---

## 5. API

### 5.1 `documents.read`

请求：

```json
{ "path": "D:/notes/a.md", "cwd": "D:/notes" }
```

响应 `value`：

```json
{
  "path": "D:/notes/a.md",
  "displayPath": "D:/notes/a.md",
  "canonical": "D:\\notes\\a.md",
  "size": 1234,
  "text": "……",
  "source": "buffer",
  "revisionId": "rev1:live:...",
  "revision": {"kind":"live","epoch":"...","version":42,"savedVersion":40,"diskHash":"..."},
  "textSha256": "...",
  "dirty": true,
  "diskChanged": false,
  "orphanDraft": false,
  "recovered": [{"recoveryPath":"...","sha256":"...","at":123}]  // 可选，仅 join 票带过
}
```

说明：

- `text` 是权威正文；`source:"buffer"` 表示含未保存修改。
- 读取顺序：`apiOpen` 拿 provider 文本+版本 → `readRoom` → `fs.stat` 复核 provider 版本 → **再 `apiOpen` 复读一次**，要求版本与 textSha 都与首次一致；任一不一致重试整个读取（最多 3 次），仍变 ⇒ `FS_STALE_VERSION`。这同时挡住"版本没变但 provider 缓存仍是旧文本"的拼接。复读让 provider 读次数×2，但只影响 AI 调用，换来 read 不返回过期文本。
- `dirty` 直接来自 room 的 `version !== saved`（disk 权威恒 false）。
- `recovered` 不主动查；只在权威来自房间且宿主手头有 join 票信息时透传（B3.1 可先不返回）。
- 不返回"当前正文"以外的历史；历史走 `docs/archive` / recovery 路径。

### 5.2 `documents.applyEdits`

请求（两种形态，二选一）：

```json
{
  "path": "D:/notes/a.md",
  "cwd": "D:/notes",
  "baseRevisionId": "rev1:live:...",
  "oldString": "原文",
  "newString": "新文",
  "replaceAll": false,
  "checkpoint": true
}
```

或底层形态：

```json
{
  "path": "...",
  "baseRevisionId": "...",
  "edits": [
    {"from": 10, "to": 14, "insert": "新文", "oldText": "原文"},
    {"from": 40, "to": 40, "insert": "插入"}
  ],
  "checkpoint": true
}
```

响应 `value`：

```json
{
  "changed": true,
  "source": "buffer",
  "revisionId": "rev1:live:...",
  "revision": {"kind":"live","epoch":"...","version":43,"savedVersion":40,"diskHash":"..."},
  "textSha256": "...",
  "dirty": true,
  "saved": false,
  "applied": [{"from":10,"to":14,"insertedLength":3}],
  "checkpoint": {"archivePath": "...", "sha256": "..."} | null,
  "textLength": 1234
}
```

- `saved:false` = 只改了缓冲区，磁盘未写；`saved:true` = 未打开文档，已按 CAS 落盘。
- 结果**不返回全文**（AI 要全文会再 read）；避免一次编辑回传几十 MB。
- `oldString/newString` 形态：宿主在权威正文里定位，必须唯一（除非 `replaceAll:true`）；`oldString` 必须非空。
- `replaceAll` 的替换次数上限 1000；超过 ⇒ `MP_DOC_EDIT_INVALID`，不做任何修改。
- buffer 分支的 `insert` 先做 `\r\n?` → `\n` 归一（编辑器/房间都是 LF）；disk 分支保留调用方原文（交给 `apiEdit`/`apiSave` 的现有格式处理）。
- `edits` 形态：按 `from` 升序、区间互不重叠；`oldText` 若提供必须与 `text.slice(from,to)` 逐字相等。`insert` 不允许含 `\r`（房间/编辑器都是 LF 规范）。
- 全部为 no-op（例如 `oldString === newString`）→ `changed:false`，**不推进版本**，返回当前 revision。
- `checkpoint` 默认 `true`；**buffer 分支一律落归档**（包括干净缓冲，见 §7）；disk 分支不归档。`checkpoint:false` 只留给内部测试/批量工具，模型工具不暴露该参数。

### 5.3 `documents.state`（只读，内部/测试用）

返回权威选择结果 + room 头 + 磁盘哈希，不带全文。给 B2 守卫和 B4 做单点状态查询用；B3.1 先内部使用，不暴露给 AI。

### 5.4 `documents.reconcile`（只读，B3.1 先不做写）

```text
{state:"clean"|"external"|"conflict"|"missing"|"orphan", head, diskHash, diskVersion}
```

`applyEdits` 内部会调用同样的判定（§8），因此 B3.1 可以只实现内部函数，HTTP 端点在 B3.2 再开。

### 5.5 错误码

| 码 | 含义 | 副作用 |
| --- | --- | --- |
| `MP_DOC_STALE` | baseRevision 不再是当前权威 | 无 |
| `MP_DOC_EXTERNAL_CONFLICT` | 缓冲区脏且磁盘也被外部改 | 无 |
| `MP_DOC_ORPHAN_DRAFT` | 目标有死会话脏草稿 | 无 |
| `MP_DOC_UNSAVED_ELSEWHERE` | 房间有非本宿主成员且带未保存修改 | 无；不 append，不写盘 |
| `MP_DOC_EDIT_INVALID` | 区间越界/重叠/顺序错/含 CR | 无 |
| `FS_EDIT_NOT_FOUND` | `oldString` 不存在 | 无（沿用现有码） |
| `FS_AMBIGUOUS_EDIT` | `oldString` 不唯一 | 无（沿用现有码） |
| `FS_SANDBOX_DENIED` | 模型工具会话策略拒绝 | 无 |
| `MP_LIVE_*` | 房间/租约/变更协议错误 | 由 `LiveDocuments` 事务回滚 |
| `MP_LIVE_NO_ROOM` / `MP_LIVE_NO_MEMBER` | 权威在调用期间消失（房间被删/无在线编辑器） | 无；调用方应重新 read，通常下一次会走磁盘权威 |
| `FS_STALE_VERSION` | disk 分支委托 `apiSave`/`apiEdit` 时版本已变 | 无（盘未被覆盖） |
| `MP_ARCHIVE_FAILED` | 要求检查点但归档失败（可配 fail-open） | 无 |

错误响应统一 `{ok:false,error:{code,message}}`，不夹带正文。`MP_DOC_STALE` 额外带只读提示：

```json
{"ok":false,"error":{"code":"MP_DOC_STALE","message":"...","currentRevisionId":"rev1:...","source":"buffer","dirty":true,"diskChanged":false}}
```

`currentRevisionId` 只帮助调用方重读，不授予写权限；调用方必须重新 `documents.read` 才能拿到新正文。

---

## 6. `LiveDocuments` 的加法

### 6.1 新方法

```js
// 读房间权威（不建房间、不推进版本）
readRoom(filePath) -> null | {
  file, epoch, version, savedVersion, diskHash, length,
  text, savedText, savedTextAvailable, textSha256, members
}

// 往房间缓冲区原子追加一笔远端编辑；不写磁盘、不改 saved
append(filePath, {epoch, baseVersion, baseText, changes, actor}) -> {
  epoch, version, savedVersion, diskHash, text, textSha256
}
```

`readRoom`：

- `canonicalFile(filePath)` → `fileKey` → `roomFor`；
- 在**同一个读事务**里读 `checkpoint` + `changes`，避免 checkpoint/增量撕裂；
- **只读，不建库**：`readRoom` 先 `existsSync(<directory>/rooms.sqlite)`；不存在直接 `null`，并用**独立的 read-only `DatabaseSync`** 打开（`busy_timeout=2000`），读完即关。不能走 `this.db`（`database()` 会 mkdir、建表、写 hostStamp，读操作不得有副作用）。
- `text` = `materialize(db, room)`；
- `savedText`：只有当 `room.saved >= room.floor` 时才物化（`materialize(db, room, room.saved)`），否则为 `null` 且 `savedTextAvailable:false` —— compact 后旧 changes 已删，`saved < floor` 的文本不可重建，不能拿 checkpoint 冒充旧文本；
- `members` = `clients` 里同 epoch 且 `alive(pid)` 的行数；
- 无房间返回 `null`；不触发 sweep，不写库。

`append`：

- `withFileCommit(file, ...)` 内执行；
- 事务内重读房间，校验 `epoch`、`version === baseVersion`、`materialize(db, room) === baseText`；
- 同一事务内确认**仍有活 client**（`alive(pid)`）；一个都没有 ⇒ `MP_LIVE_NO_MEMBER`，不制造"无人在看"的脏孤儿；
- `checkedLength(changes, room.length)` 校验增量；
- `INSERT INTO changes(epoch, version+1, actor, 0, JSON)`；
- `UPDATE rooms SET version=version+1, length=?`；
- `compact(db, room)`；
- 返回新 head + 新文本（`apply(baseText, changes)`，并与 `materialize` 对照）；
- **不碰** `saved`、`disk`；
- 没有任何文件 IO（除 canonical/lease），所以不会误写磁盘。

`actor` 只允许 `[a-z0-9-]{1,32}`（B3.1 用 `agent`；`disk` 保留给既有 adopt）；seq 固定 0，避免和 client 的 `lease.seq+1` 混。

### 6.2 为什么不复用 `exchange`

`exchange` 要求 `this.clients` 里有该 client 的租约，且 `seq` 必须是 `lease.seq+1`；宿主没有、也不应该伪造一个编辑器租约（会让 `leave`/`saved`/`ack` 语义混乱）。`append` 只做"权威日志追加"，与"客户端上行"分开。

### 6.3 伪代码（落码时以这段为准）

```js
// 一致读：不能只读 checkpoint 再读 changes 而不开事务（跨进程写入会在两步之间落地）
function readTx(db, action) {
  db.exec('BEGIN');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

class LiveDocuments {
  async readRoom(filePath) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    const dbFile = path.join(this.directory, 'rooms.sqlite');
    if (!require('node:fs').existsSync(dbFile)) return null;   // 读操作绝不建库
    const db = new (require('node:sqlite').DatabaseSync)(dbFile, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=2000');
      return readTx(db, () => {
        const room = roomFor(db, key);
        if (!room) return null;
        const text = materialize(db, room);
        const savedTextAvailable = room.saved >= room.floor;
        const savedText = room.version === room.saved ? text
          : (savedTextAvailable ? materialize(db, room, room.saved) : null);
        const members = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch)
          .filter(({ pid }) => alive(pid)).length;
        return {
          ...head(room), length: room.length, text, savedText, savedTextAvailable,
          textSha256: digest(Buffer.from(text, 'utf8')), members,
        };
      });
    } finally { db.close(); }
  }

  async append(filePath, { epoch, baseVersion, baseText, changes, actor = 'agent' }) {
    if (typeof baseText !== 'string') throw fault('MP_LIVE_APPEND', '缺少权威正文');
    if (!/^[a-z0-9-]{1,32}$/.test(actor)) throw fault('MP_LIVE_APPEND', '无效的追加者');
    const file = await canonicalFile(filePath), key = fileKey(file);
    if (!require('node:fs').existsSync(path.join(this.directory, 'rooms.sqlite')))
      throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请改用磁盘写入');
    return withFileCommit(file, async () => {
      const db = this.db;
      return atomic(db, () => {
        const room = roomFor(db, key);
        if (!room) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请改用磁盘写入');
        if (room.epoch !== epoch) throw fault('MP_LIVE_SESSION', '文档协同会话已改变');
        const members = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch)
          .filter(({ pid }) => alive(pid)).length;
        if (!members) throw fault('MP_LIVE_NO_MEMBER', '没有在线的编辑器会话，请改用磁盘写入');
        if (room.version !== baseVersion || materialize(db, room) !== baseText)
          throw fault('MP_LIVE_STALE', '文档刚有新编辑，请重新读取后再应用');
        const length = checkedLength(changes, room.length);
        const version = room.version + 1;
        db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)')
          .run(room.epoch, version, actor, 0, JSON.stringify(changes));
        db.prepare('UPDATE rooms SET version=?, length=? WHERE epoch=?')
          .run(version, length, room.epoch);
        room.version = version; room.length = length;   // compact 依赖这两个字段
        compact(db, room);
        const text = materialize(db, room);
        return { ...head(room), text, textSha256: digest(Buffer.from(text, 'utf8')) };
      });
    }, this.directory, this.leaseOptions());
  }
}
```

注意：

- `actor` 写进 `changes.client`，与真实 client UUID 不会相等，渲染端因此把它当远端增量。
- `compact` 的 `MIN(ack)` 只看 `clients`；`actor` 不是 client，不会把 floor 推错。
- 读取 `savedText` 只在 dirty 时多一次 `materialize`；干净房间直接复用 `text`。
- `readTx` 必须是 deferred `BEGIN`（不是 `BEGIN IMMEDIATE`），避免只读查询抢写锁；跨进程写入在提交后可见。
- `append` 里 `materialize` 在事务内至少执行一次；大文档（9MB）成本已由 T14 预算覆盖，B3 测试要复测一次。

### 6.4 同步影响

- `MarkPilot-CM6/shell/live-documents.js` 加两个方法（纯加法，现有导出不变）；
- `node scripts/sync-host.mjs` 更新 `host/` + `host.json`；
- `MarkPilot-CM6` 本期不重打包 EXE；源码向前兼容，下次 EXE 构建自然带上；
- `check:core` 不涉及 host 模块，仍应绿；`sync-host --check` 必须绿。

---

## 7. 检查点（checkpoint）

`documents.applyEdits` 在**改脏缓冲区之前**调用既有 `apiDocsArchive`：

- `tag: "agent-before"`（符合现有 `^[a-z0-9][a-z0-9-]{0,31}$`）；
- `text` = 改前权威正文；
- 目标 = `%LOCALAPPDATA%\.markpilot\draft-archive\<stem>.<tag>.<sha16>.md`（既有确定性命名：`sha256(path\0tag\0bytes)` 前 16 hex，重试幂等；见 `lib/index.js:1237–1245`）；
- 返回 `{archivePath, sha256}`。

规则：

| 权威 | 是否归档 | 理由 |
| --- | --- | --- |
| buffer，`dirty:true` | **是** | 改前文本只存在于缓冲区/WAL，归档是唯一独立副本 |
| buffer，`dirty:false` | **是** | 改前文本虽然此刻等于磁盘，但 AI 的远端增量会触发父窗口 `scheduleSave(1500ms)` 并覆盖磁盘；等用户看到时磁盘已不是改前文本。归档是自动保存后唯一的改前副本 |
| disk | 否 | 走 `DocumentStore.save`，已有 `recoveryBackup`；且不经过编辑器自动保存 |
| `checkpoint:false` 显式关闭 | 否 | 仅内部测试/批量工具使用；模型工具不暴露该参数 |

归档失败：

- buffer + dirty：**fail-closed**，抛 `MP_ARCHIVE_FAILED`，不应用编辑。理由：没有独立副本就改唯一草稿，违背本批的安全目标。
- 其余路径：不归档，也不报错。

> 归档会增长。B3.1 只对"脏缓冲被 AI 改"这一种低频率场景落盘；B3.2 加保留策略（按 tag/来源/时间上限）。本批不删任何既有归档。

---

## 8. `applyEdits` 的完整流程

```text
1. resolve/canonicalize；provider 读（apiOpen，MODEL_TOOL）拿文本 + provider version
2. readRoom；判定 authority（§3）
3. 若 authority 是 disk：走 §8.2
4. 若 authority 是 buffer：
   a. token/baseRevisionId 必须完全等于当前 revision → 否则 MP_DOC_STALE
   b. 校验 edits（区间、oldText、CR）
   c. 计算 newText；若与 text 相同 → changed:false
   d. buffer 分支归档改前文本（§7；干净/脏都归档）
   e. live.append(canonical, {epoch, baseVersion:version, baseText:text, changes, actor:"agent"})
      - 事务内再次校验 epoch/version/text，任何一项变了 → MP_DOC_STALE，事务回滚
   f. 返回新 revision；saved:false
5. 若 authority 是 disk：
   a. token 必须匹配 disk revision；不匹配 → MP_DOC_STALE
   b. 校验 edits，计算 newText
   c. oldString/newString 形态：委托既有 apiEdit（传 baseVersion = token 的 providerVersion；
      fs.editText 的 policy/版本守卫原样保留）
   d. edits 形态：委托既有 apiSave（传 {path, text:newText, baseVersion:providerVersion}；
      queueSave + live.external + DocumentStore CAS 原样保留）
   e. 注意：**不要在外层再套 queueSave 去调 apiSave/apiEdit** —— 同一路径队列会等待自己造成死锁。
      盘分支的串行化交给被委托端点；buffer 分支才用外层 queueSave。
   f. 读回 stat/version；返回 saved:true
6. 任何异常：不广播、不推进版本；LiveDocuments 事务自行回滚
```

并发串行化：

- buffer 分支：同一路径的 `documents.applyEdits` 先过 `queueSave(key)`（既有宿主内队列），与编辑器 `save` 同队列；房间写入再进 `withFileCommit(file)`（跨进程租约）。
- disk 分支：不套外层队列，直接委托 `apiEdit`/`apiSave`；它们内部已有 `queueSave` + `live.external` + DocumentStore CAS。
- `documents.read` 不进队列（只读），但 `readRoom` 用一致读事务。
- 跨进程：房间写入靠 SQLite 事务 + `withFileCommit`；磁盘写入靠 `DocumentStore` 原生字节 CAS。

---

## 9. 模型工具迁移（`markdown`）

### 9.1 语义

| 动作 | 1.6.0（现状） | B3.1 |
| --- | --- | --- |
| `read` | 磁盘文本 + 磁盘 version | 权威正文（含未保存）+ revisionId + `source`/`dirty` |
| `edit` | 读盘 → `fs.editText` → `live.external`（脏则拒） | 打开且有活会话 → 缓冲区追加（不写盘）；否则磁盘 CAS |

### 9.2 schema

- `read` 输出：`version` = **revisionId**（不透明 token；旧的"磁盘版本"不再直接暴露），另加 `source`、`dirty`、`diskChanged`、`revision` 组件、`text`。这样模型沿用"read 拿 version → edit 回传 baseVersion"的旧习惯，但回传的已经是 revision token。
- `edit` 参数：继续叫 `baseVersion`（等同 revisionId），另加别名 `baseRevisionId`；两者都给时以 `baseRevisionId` 为准。
  - `source:"disk"` 且调用方传的是**旧式磁盘版本**（不是 `rev1:` 开头）时，兼容映射到 provider version（只对 disk 分支；buffer 分支必须 `rev1:` token）。
  - `source:"buffer"` 必须 `rev1:` token；只有旧磁盘版本 ⇒ `MP_DOC_STALE` 并返回当前 revisionId。
- `edit` 输出：`version` = 新 revisionId；`source`、`dirty`、`saved`、`checkpoint`；`diskVersion` 仅调试/兼容时可选返回。

### 9.3 工具描述（面向模型）

- read：读取"当前正文"，包含用户在编辑器里尚未保存的修改；`dirty:true` 时磁盘上不是这个内容。
- edit：默认在"当前正文"上原子替换；若返回 `saved:false`，说明修改只在编辑器缓冲区，**不要声称文件已保存**；用户会看到并决定何时保存。
- 冲突纪律：`MP_DOC_STALE` = 读后被改过，必须重新 read 拿新 revision，绝不重试旧 base。
- 不得用其它写工具（`fs` / 终端）绕过该通道；对脏文档的通用写工具会被 `MP_DOC_DIRTY` 拒绝，这是有意的。

### 9.4 为什么不让 AI 直接写盘

- 写盘会触发编辑器外部刷新/adopt，用户当前光标与撤销栈被扰动，且"AI 在用户没保存时替他落盘"违背本事故的修复方向；
- 缓冲区追加走的是房间既有协作通道：编辑器把它当远端编辑应用，`addToHistory:false`，不会污染用户撤销栈（但也不可撤销，见 §12）；
- 磁盘仍由用户的 Ctrl+S / 自动保存决定，保留"用户是最后保存者"。

---

### 9.5 沙箱策略（安全边界，必须与 `fs` 写工具同权）

AI 的缓冲区编辑**绕过了 `fs.writeText/editText`**，因此不能依赖 `fs` 服务替我们执行沙箱策略。`documents.applyEdits` 在 buffer 分支必须自己判定：

```js
// 仅当 provider 暴露 sandboxMode（真实沙箱）时才强制判定；
// 测试 provider / 无沙箱宿主与现有 apiEdit 的 gate 同口径。
if (fs.sandboxMode !== undefined) {
  const policy = await sandboxPolicy.resolve(session ? {session} : {});
  if (!policy?.mode) throw FS_SANDBOX_DENIED;
  if (policy.mode === 'read-only') throw FS_SANDBOX_DENIED;          // 只读会话不得改缓冲区
  if (policy.mode === 'workspace-write') {
    // 与 dsh-fs-sandbox 同口径：canonical target 必须在 workspaceRoot 下。
    // 比 DSH 的 writableRoots 更严（不额外放行 temp），fail-closed。
    if (!isCanonicalUnder(await canonicalTarget(target), policy.workspaceRoot)) throw FS_SANDBOX_DENIED;
  }
  // danger-full-access 直接放行
}
```

- `isCanonicalUnder` 对双侧做 realpath 后的路径比较：Windows 去 `\\?\`/`\\.\` 前缀、`/`→`\`、大小写折叠、去尾分隔符；支持 UNC、junction（realpath 已展开）。B3.1 只支持 `workspaceRoot`，不接受额外 writableRoots。
- `documents.read` 在返回 buffer 文本前，**必须先成功执行一次 `fs` 读**（`apiOpen(MODEL_TOOL)` 或 `fs.readText`），证明该路径对当前会话可读；否则不得从房间 DB 直接返回文本。
- `documents.applyEdits` 的 disk 分支直接复用既有 `apiEdit` / `fs.editText` 的 policy 参数，不新写策略判定。
- 测试必须包含：`read-only` 拒；`workspace-write` + 工作区外路径拒；`workspace-write` + 工作区内通过；`danger-full-access` 通过；拒绝时房间版本/磁盘字节零变化。

> 已知缺口：`workspace-write` 的 temp 放行在 B3.1 不复制；如果用户把文档放在系统临时目录并希望 AI 编辑，会被拒。这是有意的 fail-closed，B3.2 再按真实需求放开。

### 9.6 客户端在 B3.1 完全不变（有意的）

B3.1 的 buffer 分支只改宿主与房间；客户端仍走现有链路：

1. 渲染端 `liveDocument` 收到 `updates`，按远端增量 `apply()`（`Transaction.remote`、`addToHistory:false`）。
2. 父窗口收到 `document-delta` → `acceptDelta`：`doc.dirty=true`、`editSeq++`、`draftStore.append`、`scheduleSave(1500ms)`（`client.js:5666–5678`）。
3. `runSave` 照常 `flushLive` → `pullText` → `POST /api/save`（`baseVersion` + live 票）→ `live.save` 校验 `version/text/disk` 后写盘、`saved=version`。
4. `onStatus` 只有在 `version===savedVersion && pending===0 && error===null` 时才消脏（`client.js:6409–6417`）。

因此：

- AI 编辑会像"另一个窗口"一样在约 1.5s 后被自动保存；B3.1 不改变这个节拍，也不新增"待审阅"状态。
- 恢复横幅、四道恢复闸（`sameRecoveryBase`、`markSaved`、恢复不自动保存、恢复期 Ctrl+S 拦截）全部不动；AI 追加不经过 `docs/archive` 之外的恢复路径。
- `applyToFrame` 的五重守卫（path/baseVersion/editSeq/loadSeq/mirror.continuous）不动；服务不向 iframe 下发全文。
- 代价：远端编辑不可撤销（`addToHistory:false`），且自动保存会在用户"审阅"前落盘。B3.1 用"改前归档"兜底；B4 的审查/撤销组是后续项。

## 10. B2 守卫的关系

B3.1 **不改** `createWriteGuard`：

- `markdown` 工具不再走 `fs` 写，因此不会被 `MP_DOC_DIRTY` 挡住；
- 通用 `fs` / 终端 / 其它插件写仍在 `fs/*-intent` 上被 B2 挡住（脏房间）或加 CAS（干净房间）；
- AI 缓冲区编辑后房间变脏，通用写工具继续被挡，直到用户保存 —— 这是期望的 defense-in-depth。

B3.2 可把 `lookupDocument` 换成 `documents.state`，减少一次 SQLite 读；本批不做。

> B2 的已知缺口（B3.1 不修，避免扩大范围）：内核没有 `fs/patch-intent` / `fs/move-intent`，直接调 `fs.patchText`/`fs.moveFile` 不被守卫拦截；终端 / computer-use / 任意本机进程天然绕过。B3 只把**模型 `markdown` 工具**从"通用 fs 写"迁到 `documents.applyEdits`，不改变这些边界。`documents.read/applyEdits` 端点只允许 `MODEL_TOOL`；编辑器/任意 HTTP 客户端不能借它绕过 B2。

---

## 10.5 代码落点

- **新增 `lib/documents-service.js`**：纯工厂 + token/authority/edits 校验，不直接碰 HTTP；通过回调拿 `openModel/edit/save/readRoom/append/archive/canonical/localPath`，便于用假实现做单测。
  - 导出：`createDocumentsService`, `parseRevisionId`, `makeLiveRevisionId`, `makeDiskRevisionId`, `normalizeEol`, `validateEdits`, `isCanonicalUnder`。
- **`lib/index.js`**：在 `createHost` 内创建 service，`dispatch` 增加 `documents.read`/`documents.applyEdits` 分支；`KNOWN_ENDPOINTS` 增加两项；模型工具 `createMarkdownToolDefinition` 改走新端点。
- **`MarkPilot-CM6/shell/live-documents.js`**：新增 `readRoom`/`append`（及内部 `readTx`），同步到 `host/` + `host.json`。
- **测试**：`test/live-documents-authority.test.mjs`、`test/documents-service.test.mjs`、`test/documents-api.test.mjs`；扩展 `model-authority.test.mjs`。

## 11. 不变量与失败矩阵

### 11.1 不变量

- **I1** 磁盘写入必须带 CAS；`documents.applyEdits` 的 disk 分支不引入新写者。
- **I2** 房间追加必须在同一事务里校验 `epoch + version + materialize == baseText`；任一不满足则零变化。
- **I3** `append` 绝不修改 `saved` / `disk`；AI 编辑不产生"已保存"假象。
- **I4** 一次 `applyEdits` 最多推进一个房间版本（一组 edits 合并为一笔 change）。
- **I5** 任何 buffer 编辑改前必须有独立归档（含干净缓冲，因为自动保存会覆盖磁盘）；归档失败则不应用。
- **I6** 读/写永不把"**宿主进程已死**（`alive(pid)` 为假）的脏房间"当权威；死草稿只通过显式恢复路径复活。同宿主进程内已经崩溃的 tab（pid 仍活）无法区分，这是已知近似（§3 注）。
- **I7** 不改 renderer 字节；`sync-core --check` 必须绿。
- **I8** `documents.read` 不产生任何写入（不建库、不建房间、不清 recovery、不 sweep）；`readRoom` 用只读连接。

### 11.2 失败矩阵

| 场景 | 行为 | 数据后果 |
| --- | --- | --- |
| baseRevision 过期（用户又打字） | `MP_DOC_STALE`，附当前 revision | 两边文本都在 |
| 房间在 apply 中途被其他窗口推进 | `append` 事务回滚 → `MP_DOC_STALE` | 无 |
| 磁盘在 buffer apply 期间被外部改 | 允许 apply 到 buffer；返回 `diskChanged:true`；下一次保存会 `MP_FILE_CONFLICT` | 缓冲/磁盘都在，用户处理 |
| 磁盘在 buffer apply 前已被外部改且 buffer 干净 | 权威切到 disk（§3），apply 走磁盘 CAS | 无 |
| 磁盘在 buffer apply 前已被外部改且 buffer 脏 | `MP_DOC_EXTERNAL_CONFLICT` | 无 |
| 目标是无活 client 的脏房间 | `MP_DOC_ORPHAN_DRAFT` | 无 |
| 房间有非本宿主成员（旧 EXE/另一 DSH）且脏 | 读 disk + `unsavedElsewhere`；写 `MP_DOC_UNSAVED_ELSEWHERE` | 无；不 append |
| 房间有非本宿主成员但干净 | disk 权威；磁盘 CAS 写 | 旧 EXE/另一宿主按外部变更 adopt |
| 归档失败（脏缓冲） | `MP_ARCHIVE_FAILED` | 无 |
| 房间 SQLite busy/只读打不开（读） | `readRoom` 返回 null，读退回 disk 权威；写仍经 live.external/CAS | 无 |
| append 等待文件租约超过 10s | `MP_SAVE_BUSY`（append 专用 ceiling，避免 AI 工具等满 30s） | 无 |
| 房间 SQLite busy（append 写事务） | `MP_LIVE_BUSY`（映射 SQLITE_BUSY，不冒充 MP_SAVE_BUSY） | 事务回滚 |
| 编辑器正在组字（IME） | `append` 照常入日志；渲染端在 composition 结束后才 receive | 无 |
| 多个 tab 同时收到 | 每个 tab 走既有 exchange/receive；`ambiguous()` 判冲突 | 冲突端 halt 保草稿 |
| 编辑器在 apply 后立刻关闭、未保存 | 房间 dirty；client WAL 记录 delta；房间 `leave` 当前会删房间（见 §12） | 残余窗口，B3.2 处理 |

---

## 12. 已知风险与未决问题（交对抗审阅）

1. **远端编辑不可撤销**。渲染端对远端增量用 `Transaction.remote + addToHistory:false`；AI 的缓冲区编辑因此不能 Ctrl+Z。B3.1 用"改前归档"兜底；B4 应做审查/撤销组。是否接受？
2. **自动保存会把 AI 编辑落盘**。父窗口对任何 delta 都 `scheduleSave(SAVE_DEBOUNCE_MS)`，包括远端应用后的 delta；因此 AI 改缓冲区后约一个去抖周期就会被保存。若要求"用户先审阅再保存"，B3.1 做不到（需要改父窗口/渲染端的保存触发条件，与本批"不改 renderer"冲突）。是否接受"立即自动保存 + 改前归档"？
3. **删房间时机**。`leave` 在最后一个 client 离开时直接删房间（即使 dirty；`live-documents.js:501–511`）。B3.1 已按对抗审阅改为：**若房间里有未被任何 client ack 的 `agent` 变更，保留房间**，让下一次 `join` 走既有 `parkRecovery` 停尸；已被 ack 的 agent 变更按原逻辑删房（此时 editor WAL 已记录）。正常用户脏房间的删除语义不变（1.4.1 的客户端 WAL 兜底）。实测：未 ack 时 leave 后 `rooms` 行仍在，下一次 join 返回 `recovered` 且恢复文件内容含 AI 编辑；ack 后 leave 行数归零。
4. **归档增长**。`agent-before` 只对脏缓冲生成，但长期使用仍会积累。B3.2 需要保留策略（按来源/时间/大小），且不能误删用户恢复副本。
5. **oldString 定位的语义**。模型拿到的文本可能很大；在宿主侧重定位而不是让模型算偏移，能避免偏移漂移；但 `replaceAll` 可能放大破坏面。是否限制单次 edits 数量/总插入长度？
6. **B4 的 readToken/groupId/audit 是否应现在预留**。若 B4 需要"块 ID/选区锚点"，B3.1 的 revision token 里要不要带 docId/groupId？
7. **`documents.read` 返回全文的隐私/体积**。现有 `open` 已能读任意文本；B3.1 维持同等能力，但模型工具一次可能回传 10MB+ 文本。是否在 read 上加 `maxChars`/截断（会破坏 edit 的精确性）？
8. **多 DSH 宿主进程**。`clients.pid` 是宿主进程；两个 DSH 实例各自有 client，房间共享。`append` 会同时被两个宿主看到；`withFileCommit` 只保护写盘，不保护房间（SQLite 事务够）。需要确认 `append` 在跨进程下无丢失。
9. **provider 版本字符串含冒号**。token 解析必须只切前 4 段；测试要覆盖。
10. **EXE 源码先行与旧 EXE 共存**。`shell/live-documents.js` 加了方法/`leave` 保护，但本期不重建 EXE；已安装的 3.6.17 EXE 仍是无条件删房的旧 `leave`。B3.1 的防线是 §3 的"非本宿主成员"规则：只要房间里有旧 EXE/另一宿主进程的活 client，就**不 append**（干净→磁盘写，脏→拒写），因此旧 EXE 关闭时不可能删掉一笔 agent change。残留：AI 先 append、旧 EXE 之后才 join、DSH 宿主随后关闭、EXE 再关闭的极窄序列不在保护内；B3.2 需要 append 时落独立 recovery 副本，或等 EXE 重建。
11. **成员判定的近似**（§3）：tab 崩溃后租约行可能残留，`members>0` 不等于"真的有人在看"。B3.1 不写盘，最坏只是改了一份暂时无人显示的草稿；是否需要心跳，交对抗判断。
12. **沙箱策略的 buffer 分支是自写判定**（§9.5）：`workspace-write` 的 temp 放行被刻意省略，比 DSH 更严。若用户真实场景依赖 temp 目录编辑，会误拒；需要确认产品是否接受。
13. **`documents.read` 的全文回传**可能让模型在一次调用里拿到 10MB+ 文本。B3.1 不截断（截断会破坏 edit 的精确性）；是否需要分页/`maxChars`，交 B4 的 `readToken` 设计一起定。
14. **磁盘文件被删/不可读时读不到缓冲区**。`documents.read` 先做 provider 读以证明可读并执行读策略；磁盘 ENOENT/权限失败会先失败，即使房间里有未保存正文。B3.1 选择 fail-closed（不绕过 `fs` 读策略），B3.2 再评估"磁盘已删但缓冲区仍在"的只读通道。
15. **用户输入与 AI 改同一段**。渲染端 `remote()` 的 `ambiguous()` 会判冲突并 halt 共享会话（`live-document.js:117–135`）；房间已前进，用户本地草稿保留，但会弹冲突横幅。B3.1 不自动合并；这是 B4 diff3 的范围。测试要至少记录该行为，不把它误报成数据丢失。
16. **burst append 与自动保存**。连续多次 AI 编辑会让父窗口连续 `scheduleSave`；与用户输入交错时可能命中 `MP_LIVE_STALE`，触发客户端 3 快 3 慢退避后 `liveStaleBlocked` 停自动保存（`client.js:622–631`）。B3.1 的终态必须靠用户 Ctrl+S / 重新 read；B4 需要批量协议。
17. **`fs.readText` 的编码口径**。房间侧是 `decodeDocument`（剥 BOM、全 LF）；provider 侧是 `fs.readText`（BOM/非 UTF-8 行为未完全取证）。B3.1 在比较前剥 BOM + CRLF 归一；UTF-16/GBK 文档仍可能被判为 diskChanged 或读成乱码。B3.2 可改成 `fs.readBytes + decodeDocument` 同管线，但会改变模型读投影，需单独验收。
18. **归档增长**。干净缓冲现在也要归档（因为自动保存会覆盖磁盘），AI 使用频率高时 `agent-before` 文件会积累。B3.1 不删；B3.2 必须加按 tag/来源/时间/大小的保留策略，且不能误删用户恢复副本。
19. **HTTP 暴露**。`documents.*` 虽在 `KNOWN_ENDPOINTS`，但 `handleApiPost` 调用 `dispatch` 时没有 MODEL_TOOL authority，两个端点都返回 `bad-request`；测试 `B3-API1` 覆盖。任何未来把 authority 注入 HTTP 的改动都必须重新过对抗。
20. **legacy 磁盘版本 / 无 base 的兼容路径**。非 `rev1:` 的旧 `baseVersion` 只比较 provider version，不带 textSha；无 base 的 disk `oldString` 现在也强制用 authority 的 provider version 做 CAS（不再无守卫），但 token sha 仍来自服务计算文本，若 provider 有编码变换可能自罚一次 STALE。新模型工具始终回传 rev1 token；legacy 路径只为旧调用/旧测试保留，B4 可移除。
21. **checkpoint 64MB 上限**。`docs/archive` 单次上限 64MB；超过 64MB 的 buffer 文档做 AI 编辑会因 `MP_ARCHIVE_FAILED` 被拒。B3.1 选择 fail-closed（大文档很少，且没有独立副本时改脏缓冲风险更高）；B3.2 评估分块/旁路归档。

---

## 13. 测试计划（B3.1 落地时必须全绿）

### 13.1 单元（Node test，临时目录，不碰用户房间）

`test/live-documents-authority.test.mjs`：

- `readRoom` 无房间 → null；建房间后 → 正确 `text/version/saved/members`；
- `append`：base 正确 → version+1、saved 不变、text 正确、members 不变；
- `append`：baseVersion 过期 → `MP_LIVE_STALE`，房间零变化；
- `append`：baseText 不匹配 → 拒绝，零变化；
- `append`：changes 越界/重叠/含 CR → `MP_LIVE_CHANGE`；
- `append` 后 `exchange` 的另一个 client 能收到该版本（用真实 LiveDocuments 两 client）；
- `append` 在 `saved===version` 时也允许（干净房间），之后 `saved < version`；
- `append` 无活 client ⇒ `MP_LIVE_NO_MEMBER`，房间零变化；
- `readRoom` 在 rooms.sqlite 不存在时返回 null，且**不创建**该文件/目录；
- `readRoom` 在 `saved < floor` 时 `savedTextAvailable:false`、`savedText:null`（用 130 笔编辑触发 compact 复现）；
- `readRoom` 在另一进程写入中途不返回撕裂文本（单进程下用事务边界模拟）。

`test/documents-service.test.mjs`：

- authority 选择三态：buffer / disk / conflict；
- 无活 client 的脏房间 → `orphanDraft` / 拒写；
- revisionId 生成与比较（含 provider version 带冒号）；
- applyEdits：oldString 唯一/重复/不存在、replaceAll、no-op、越界、含 CR、base 过期；
- checkpoint：buffer（干净/脏）都生成归档，disk 不生成；归档失败 fail-closed（注入 `apiDocsArchive` 失败）；
- disk 分支：oldString 形态委托 `apiEdit`；edits 形态委托 `apiSave`；CAS 写入、版本前进、读回校验；**外层不套 queueSave**；
- policy：`read-only` 拒；`workspace-write` 工作区外拒/内通过；`danger-full-access` 通过；`sandboxMode` 未定义时与 `apiEdit` 同口径；
- `readRoom` 返回 `savedTextAvailable:false` 时 `diskChanged:null`，apply 仍按 buffer 处理；
- provider 读取期间版本变化 → 重试；3 次仍变 → `FS_STALE_VERSION`；
- 并发：两个 apply 串行，第二个 `MP_DOC_STALE`。

### 13.2 宿主端点

`test/documents-api.test.mjs`：

- `documents.read` / `documents.applyEdits` 在 `KNOWN_ENDPOINTS` 内，非 JSON/超限/未知端点行为不变；
- 模型工具 authority 下 `applyEdits` 走 sandbox policy；拒绝时零写入；
- 编辑器 authority 调 `documents.applyEdits` 必须被拒（B3.1 只允许模型工具；防止客户端绕过 lease）；
- `documents.read` 不做任何写入（对比 rooms.sqlite 的 mtime/行数）。

### 13.3 模型工具

扩展 `test/model-authority.test.mjs` / 新增：

- 非本地 provider（无 room）：read 返回 provider 文本；edit 仍走 `fs.editText` 版本守卫，拒绝时零写；
- 本地文件 + 活房间：read 返回 buffer 文本；edit 走 `append`，磁盘字节不变；返回 `saved:false`；
- `baseRevisionId` 过期 → `MP_DOC_STALE`，磁盘/房间都不变；
- 无 `baseRevisionId` 对 buffer 编辑 → 拒绝；
- 输出渲染含 `dirty`/`saved:false` 文案。

### 13.4 负控与突变

- 把 `append` 的 `baseVersion` 校验注掉 → 并发用例必须变红；
- 把 `textSha` 比较注掉 → 过期 token 用例必须变红；
- 把 `queueSave` 去掉 → 并发用例至少一条变红；
- 把 checkpoint 注掉 → 归档用例变红；
- 恢复后跑 `check:core` 与 `sync-host --check`。

### 13.5 全量

- `npm test`（当前 385 项）全绿；新增用例计入；
- `node scripts/sync-host.mjs --check`；
- `node scripts/sync-core.mjs --check`；
- 不启动用户实例、不动 `~/.dsh`。

---

## 14. 交付与回滚

- 版本：1.7.0（新 API + 行为变化）。
- 文件：
  - `MarkPilot-CM6/shell/live-documents.js`（+ `host/live-documents.js`, `host.json`）
  - `dsh-markdown-editor-typora/lib/index.js`
  - 新增 `dsh-markdown-editor-typora/lib/documents-service.js`
  - 测试：`test/live-documents-authority.test.mjs`（7）、`test/documents-service.test.mjs`（12）、`test/documents-api.test.mjs`（7）；扩展 `host`/`host-lazy-binding`
  - `docs/LOG-1.7.0.md`
- 安装：本次**不主动装进用户正在用的 profile**；先在隔离 profile/测试实例验证，再按用户指示安装。
- 回滚：`lib` 改动可整体 revert；`live-documents.js` 的加法对旧代码无影响，host.json 随之回退即可。

---

## 15. 验收判据（用户可观察）

1. 打开 `a.md`，改一段**不保存**；让 AI `markdown.read`：它必须看到这段修改，并返回 `dirty:true`。
2. 让 AI `markdown.edit` 改另一段：编辑器里立刻出现，磁盘**此刻不变**；返回 `saved:false`。
3. 在 AI 返回前用户又改同一段：**若用户编辑先到房间**，AI 返回 `MP_DOC_STALE`；**若 AI 先 append**，渲染端判 `ambiguous` 并弹冲突横幅，两边文本都保留（B4 自动合并前不承诺无横幅）。
4. AI 应用后按 `Ctrl+S`：磁盘写入 AI 合并后的文本；房间 `savedVersion === version`。
5. 对未打开的文件让 AI 编辑：直接落盘，旧 `baseVersion` 重试返回 `FS_STALE_VERSION`。
6. 对"崩溃孤儿脏房间"的文件让 AI 编辑：拒绝 `MP_DOC_ORPHAN_DRAFT`，不写盘。
7. 全程 `check:core` / `sync-host --check` / `npm test` 绿。

---

## 16. 对抗审阅收敛记录

两轮独立对抗（`.mp-verify/b3-inventory/ADVERSARIAL-DESIGN.md`、`ADVERSARIAL-2.md`）的结论与处理：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| P0-1（adversary 1） | provider 文本 BOM/CRLF 与房间 savedText 口径不同，脏房恒冲突 | `normalizeCompare` 剥 BOM + CRLF 归一；`B3-S1b` 覆盖 |
| P0-1（adversary 2） | 干净缓冲不归档，但自动保存会覆盖磁盘唯一改前副本 | buffer 分支**一律**归档（§7）；`B3-S5` 改为断言归档 |
| P0-2 | `saved < floor` 后 `materialize(saved)` 返回 floor 文本，误判冲突 | `savedTextAvailable` 门；`B3-A4`/`B3-S3` 覆盖 |
| P0-3 | append 后未投递即关窗会连房间一起删，AI 编辑静默丢失 | `leave` 保留"存在未被 ack 的 agent 变更"的房间，下一次 join park 成 recovery；`B3-A5` 覆盖 |
| P0-4 | HTTP 暴露 documents.* 可绕过策略 | `dispatch` 强制 `authority === MODEL_TOOL`；`B3-API1` 覆盖 |
| P0-5 | readRoom 不能复用 `atomic`（BEGIN IMMEDIATE） | 独立只读连接 + `readTx`（deferred BEGIN）；`B3-A1`/`B3-A2` 覆盖 |
| P1 | provider/room 读序竞态 | `authority` 读后 `fs.stat` 复核，最多 3 次，仍变返回 `FS_STALE_VERSION` |
| P1 | sandboxPolicy 形态不符会穿透 | `checkWritePolicy` 对 `!policy.mode`/空 `workspaceRoot` 显式拒绝；`B3-S8`/`B3-API5` 覆盖 |
| P1 | token 解析把 providerVersion 切碎 | 实现用"前缀 + 最后冒号"；`B3-S9` 覆盖带冒号版本 |
| P1 | 用户打字与 AI 同段 → ambiguous halt | 列为 §12 #15 已知风险，B4 处理 |
| P1 | burst append 触发 STALE 退避风暴 | 列为 §12 #16 已知风险，B4 批量协议处理 |
| P2 | 归档无用户入口、增长 | §12 #18；B3.2 加保留策略与入口 |

对抗中确认成立、未改动的关键机制：`updates` 连续性 + `receive` 逐版断言、`MIN(ack)` floor 不受 agent 行影响、`onStatus` 七条件不会误清脏、`actor='agent'` 与 client UUID 不相撞、IME 期间 `cycle` 早退、disk 分支委托 `apiEdit` 保留 CAS/policy。

### 16.1 实现级对抗（两轮）

| 发现 | 处理 |
| --- | --- |
| 旧 EXE 3.6.17 的 `leave` 会删未 ack agent room | §3 增加 `members > localMembers` 门：存在非本宿主成员时不 append（干净→disk，脏→`MP_DOC_UNSAVED_ELSEWHERE`）；`B3-API7` 覆盖 |
| disk `edits[]` 走 `apiSave` 无 policy | disk 分支统一 `checkWritePolicy`；`B3-S8` disk 臂覆盖 |
| `enqueue` 键大小写域与 `queueSave` 不同 | 注入处包 `pathKey` |
| disk oldString 无 base 无 CAS | 强制 `baseVersion = diskBase ?? providerVersion` |
| append 竞态错误缺 currentRevision/checkpoint | 复读 room 补 `currentRevisionId`，错误带 `checkpointPath` |
| disk token sha 用计算文本而非落盘文本 | 写后 `rereadDiskText`，用实际 provider 文本算 sha |
| `readRoom` WAL/坏库硬失败 | 读失败一律返回 null，退回 disk 权威；`B3-A1b` 覆盖 |
| `\\?\UNC` 归一 | `isCanonicalUnder` strip 顺序修正；`B3-S10` 覆盖 |

已知残留：AI 先 append、旧 EXE 之后 join、DSH 宿主再关闭的极窄序列仍需 B3.2 的 append recovery 副本或 EXE 重建；`checkpoint` 64MB 上限与归档增长已登记 §12。

