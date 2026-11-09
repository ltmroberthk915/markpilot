# LOG 1.7.0 · `documents.*` 文档服务（B3.1）

- 基线：`main` @ `8d49f55`，插件 1.6.0。
- 工作树：`.agents/worktrees/b3-documents-service`（分支 `b3-documents-service`）。
- 本批目标：让模型 `markdown` 工具读写**编辑器当前正文**（含未保存修改），而不是只看到磁盘；同时不破坏渲染端、客户端保存/恢复协议、B2 写守卫与 EXE 共享模块。
- 未安装到用户的 `desktop` profile；所有验证在隔离工作树/临时目录完成。

## 1. 用户可见变化

1. 文档在 MarkPilot 中打开时，`markdown.read` 返回房间缓冲区文本（含未保存修改），并返回 `source:"buffer"`、`dirty` 与 revision token。
2. `markdown.edit` 在缓冲区上追加一笔远端编辑：编辑器立即出现，磁盘在 AI 返回时**不变**；随后由编辑器既有自动保存落盘。返回 `saved:false`。
3. 每次 buffer 编辑（干净或脏）前都把改前文本归档到 `%LOCALAPPDATA%\.markpilot\draft-archive\`，tag=`agent-before`；工具渲染会把路径显示出来。
4. 未打开的文档保持原有磁盘 CAS：`source:"disk"`、`saved:true`。
5. 读取后正文被改过 → `MP_DOC_STALE`（带 `currentRevisionId`）；脏缓冲 + 磁盘已变 → `MP_DOC_EXTERNAL_CONFLICT`；死进程留下的脏房间 → `MP_DOC_ORPHAN_DRAFT`。
6. HTTP 面无法调用 `documents.*`：`handleApiPost → dispatch` 没有 `MODEL_TOOL` authority，返回 `bad-request`，不产生任何写入。

## 2. 文件

| 文件 | 内容 |
| --- | --- |
| `MarkPilot-CM6/shell/live-documents.js` | 新增 `readTx`、`localStoreUsable`、`LiveDocuments.readRoom`、`LiveDocuments.append`；`leave` 增加"未 ack 的 agent 变更保留房间" |
| `dsh-markdown-editor-typora/host/live-documents.js` + `host.json` | `sync-host` 同步产物（逐字节相同） |
| `dsh-markdown-editor-typora/lib/documents-service.js` | 新模块：authority 选择、revision token、buffer/disk apply、policy、归档 |
| `dsh-markdown-editor-typora/lib/index.js` | 装配 service、两个端点、`KNOWN_ENDPOINTS`、`MODEL_TOOL` 导出、`markdown` 工具改写 |
| `dsh-markdown-editor-typora/package.json` | 1.7.0；`files` 增加 `lib/documents-service.js` |
| `dsh-markdown-editor-typora/test/*` | 新增 3 个测试文件；扩展 `model-authority`/`host`/`host-lazy-binding` |
| `dsh-markdown-editor-typora/README.md` | 1.7.0 用户说明（只增不删） |
| `docs/DESIGN-B3-DOCUMENTS-SERVICE.md` | 设计稿 + 两轮对抗收敛记录 |

## 3. 关键实现

### 3.1 authority

- 有活 client 且磁盘未变 → buffer；
- 有活 client、房间干净、磁盘已变 → disk（`external:true`）；
- 有活 client、房间脏、磁盘已变 → buffer + `conflict:true`，写拒绝；
- 无活 client、脏房间 → disk + `orphanDraft:true`，写拒绝；
- 无房间 → disk。
- `savedText` 只在 `saved >= floor` 时可物化；否则 `diskChanged:null`，按 buffer 处理。
- provider 读 → room 读 → `fs.stat` 复核；三次仍变返回 `FS_STALE_VERSION`。
- 比较用 `normalizeCompare`（剥前导 BOM、CRLF→LF）；返回文本与 token 哈希保持原文。

### 3.2 revision token

```text
rev1:live:<epoch>:<version>:<sha256(text)>
rev1:disk:<providerVersion>:<sha256(text)>
```

- disk 版本可含冒号，解析按"前缀 + 最后一个冒号"。
- 写操作要求 token 组件 + 当前 textSha/epoch/version 全部相等。
- `markdown.read` 的 `version` 字段就是 revisionId；`markdown.edit` 的 `baseVersion` 即回传该值（旧磁盘版本仍兼容 disk 分支）。

### 3.3 buffer apply

- `readRoom` 用独立只读连接 + deferred `BEGIN`；不建库、不写库、不 sweep；host stamp 不符返回 null。
- `append` 在 `withFileCommit` + SQLite `BEGIN IMMEDIATE` 内重校验 `epoch/version/materialize==baseText`，插入一笔 `client='agent'` 的 change，版本 +1，`saved/disk` 不动，compact 后返回新文本；append 租约上限 10s。
- `leave`：若存在 `version > saved` 且未被任何 client ack 的 agent change，保留房间；下一次 join 由既有 `parkRecovery` 停尸成 recovery 文件。已被 ack 的 agent change 按原逻辑删房。

### 3.4 disk apply

- `oldString` 形态委托 `apiEdit`（保留 `fs.editText` 的 policy/CAS）。
- `edits` 形态计算新全文后委托 `apiSave`（保留 queueSave + live.external + DocumentStore CAS）。
- 外层不再套 `queueSave`，避免同路径队列自等待死锁。

### 3.5 安全

- `documents.read/applyEdits` 只允许 `MODEL_TOOL`；HTTP 调用返回 `bad-request`。
- buffer 写策略自判（因为绕过了 `fs` 写）：`read-only` 拒；`workspace-write` 要求 canonical target 在 `workspaceRoot` 下；`danger-full-access` 放行；未知 mode 拒；`workspaceRoot` 空拒。
- `checkpoint` 无关闭开关；模型工具不暴露 `checkpoint` 参数。
- `documents.read` 先经 provider 读证明可读，才返回房间文本。

## 4. 验证

### 4.1 测试

```text
npm test
tests 411, pass 410, fail 0, skipped 1
```

新增用例：

- `test/live-documents-authority.test.mjs`（7）：readRoom 不建库/不写库、坏库回退、干净与脏房间、stale/invalid/no-member、`saved<floor`、leave 保留未 ack agent 变更、两实例同 base 只赢一个。
- `test/documents-service.test.mjs`（12）：authority 三态、BOM/CRLF、orphan/conflict、stale、append 竞态映射、干净/脏归档、disk 委托、policy（read-only/workspace-write 内外/danger/未知 mode）、token、路径包含、replaceExact。
- `test/documents-api.test.mjs`（7）：端点权限、buffer append 不写盘 + live save 落盘、disk CAS、模型工具、sandbox 拒绝、HTTP 拒绝、非本宿主房间退化为 disk/拒绝。
- 扩展 `host`/`host-lazy-binding`；工具 buffer 路径由 API4 覆盖。

### 4.2 突变验证（注掉修复必须变红）

| 突变 | 结果 | 恢复 |
| --- | --- | --- |
| `leave` 保护改为 `keep = false` | `B3-A5` 红（5 pass / 1 fail） | 文件哈希与备份一致 |
| 干净缓冲跳过 checkpoint | `B3-S5` 红（10 pass / 1 fail） | 一致 |
| 删除 `documents.*` 的 MODEL_TOOL authority 检查 | `B3-API1`、`B3-API6` 红（4 pass / 2 fail） | 一致 |
| `savedTextAvailable` 恒 true | `B3-A4` 红（5 pass / 1 fail） | 一致 |
| 删除 buffer base token 校验 | `B3-S4` 红（10 pass / 1 fail） | 一致 |
| 关闭"非本宿主成员"门 | `B3-API7` 红（6 pass / 1 fail） | 一致 |
| 删除 disk 分支 policy 检查 | `B3-S8` 红（11 pass / 1 fail） | 一致 |
| 删除 disk oldString 的 providerVersion CAS | `B3-S6` 红（11 pass / 1 fail） | 一致 |

所有突变均在临时备份→注掉→同命令复跑→恢复的脚本里完成；最终三份产品文件哈希与备份一致，`node --check` 通过，`git status` 无突变残留。

### 4.3 门禁

```text
node scripts/sync-host.mjs --check  → HOST_CHECK_OK 9 files
node scripts/sync-core.mjs --check  → HOST_CHECK_OK 9 files; CHECK_OK 124 files, 7351676 bytes, coreHash=4499e09378a8743fd1ec985c11bf8046f33b55350688dd9d996b839fe0d589ba
npm pack --dry-run                  → lib/documents-service.js 20.6 KB 在载荷内
git diff --numstat README.md        → 11 0（只增不删）
```

## 5. 对抗审阅

两轮设计对抗 + 两轮实现对抗（报告在 `.mp-verify/b3-inventory/ADVERSARIAL-*.md`）：

- P0（设计）：provider BOM/CRLF 口径、`saved<floor` 假冲突、append 后未投递关窗、HTTP 注入、readRoom 写锁——全部在落码中修复并有对应测试。
- P0（实现）：旧 EXE 3.6.17 的旧 `leave` 会在未 ack 窗口删房。修法不是重建 EXE，而是 §3 的"非本宿主成员"规则：房间里有旧 EXE/另一宿主进程的活 client 时，不再 append（干净→磁盘写，脏→`MP_DOC_UNSAVED_ELSEWHERE`），因此旧 EXE 关闭时没有 agent change 可删。极窄的"AI 先 append、旧 EXE 后 join、DSH 宿主再关闭"序列留给 B3.2 的 recovery 副本或 EXE 重建。
- P1（实现）：disk `edits[]` 委托 `apiSave` 缺 policy 检查（已补 `checkWritePolicy`）；`enqueue` 键与 `queueSave` 大小写域不一致（已包 `pathKey`）；disk oldString 无 base 无 CAS（已强制 providerVersion）；append 竞态错误缺 `currentRevisionId`/`checkpointPath`（已补）；disk token sha 用计算文本而非落盘文本（已写后复读）；`readRoom` 打不开 WAL 库时硬失败（已退回 disk 权威）；UNC 长路径归一。
- P2：归档 64MB 上限/增长、checkpoint 无用户入口、`MP_LIVE_READ` 失败面、非本宿主房间只读退化均已登记；`model-authority` 的旧断言按新前置拒绝调整（服务层先拒，provider 不再被调用）。

## 6. 回滚

### 文件身份（SHA-256，LF）

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `lib/index.js` | 104216 | `0b8e503e0646caa6a9cadd29b95d8415e950010aded103da16cbd3adf00cfe9e` |
| `lib/documents-service.js` | 23962 | `25a78b5e6d21073c04201efc84010c1ea6bea3a14310f97de9e9dffbe1de0756` |
| `host/live-documents.js` | 37853 | `8896709e3a48fa3b37ecddfdb3c0fd59c41f712a119fb9c35e05a2cd41d441d1` |
| `MarkPilot-CM6/shell/live-documents.js` | 37853 | `8896709e3a48fa3b37ecddfdb3c0fd59c41f712a119fb9c35e05a2cd41d441d1` |
| `host.json` | 1443 | `4422923973246dd96a5fe7473470e3f281756e3b50568c1bc6ff67e222fd0b1d` |
| `package.json` | 1712 | `512231a793039f4939c145242bee60bb4baf5492c59b9ce718f61478384651c1` |
- `lib/index.js`、`lib/documents-service.js`、`package.json`、测试、README 可整体 revert。
- `MarkPilot-CM6/shell/live-documents.js` 的改动是纯加法（`readRoom/append`）+ `leave` 条件；`host/` 与 `host.json` 随 `sync-host` 回退。
- 不涉及 renderer 字节；`check:core` 不因本批变化。
