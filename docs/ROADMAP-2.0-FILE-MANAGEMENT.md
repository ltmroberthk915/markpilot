# ROADMAP · MarkPilot 2.0「文件管理彻底完善」接管计划

> **事故警告**：2026-11-11 发生 profile 插件组合配置丢失事故（`cordis.patch.yml` 与 `package.json` 的 `dsh.profile.bundles` 同时被截断），详见 [LOG-1.8.1 · 插件配置丢失事故](LOG-1.8.1-INCIDENT-PLUGIN-CONFIG-LOSS.md)。在修好 profile 配置/插件入口前，禁止在生产 DSH 上用 DevTools reload；诊断先看 `plugin_manager list_bundles` 的 enabled 状态。**实机测试一律 Web 端 + 独立测试 profile，不启动 Desktop。**

> 状态：**计划稿（2026-11-10）**。本文只定方向、边界、阶段、验收与回滚；产品代码按 §7 分批落。
> 基线：`main` @ `edb8b05`，插件 1.8.1，CM6 3.6.17，449 测试 / 448 通过 / 1 skip / 0 失败（详见 §1）。
> 执行状态（2026-11-11）：**P0 blocking 已修**（CRLF/BOM 修订 sha 归一、`undoGroups` 内容身份、断链/缺 revision/epoch 用例）；**B4.3 host/API + 客户端冲突面板已落**；独立对抗审查后修了 B1–B4：撤销冲突解决用 `room_resolved` 空哨兵撤销写授权、`markResolved` 记录“用我的”零正文解决、`live.save` 校验解决标记、join 票带 `resolvedDisk`、`startLive` 去 firstOpen 门、`handleLiveError` 先 unbind、首次保存后 clean 重载 join（不回退正文）；`npm test 511/510 pass/1 skip/0 fail`，coreHash 未变。Web 实机（独立 `mp-web-test`，未碰 Desktop）已确认 MarkPilot 加载、冲突横幅→面板→「用我的」→ `room_resolved` 写入；发现并修复 no-op resolve 后 `doc.dirty` 为 false、review phase 丢失，以及 live 保存误用父镜像（`mpEngine.setValue` 的 `_o` 旁路不发 delta）导致永久 `MP_LIVE_STALE` 三个客户端问题；修复后 `b43-keepmine2.md` Web 复测通过：Ctrl+S 后磁盘写入 `mine`、`rooms.saved=1`、`room_resolved` 清空、UI 就绪。剩余 Web 复测：仅「手动编辑」textarea 端到端（host resolve 已有 API1）；「用磁盘」「两边保留」Web UI 已通过（磁盘分别写 `theirs`、`ours2\ndisk2`，`rooms.saved` 2/4）。详见 [LOG-1.8.1 · B4.3 Web 实机测试记录](LOG-1.8.1-B4.3-WEB-REALTEST.md)。
> **B3.3b 第一切片**：`draft_index` 数据层已落并 sync-host；host 读门已接：mirror 不再被 clean room 遮蔽，fresh+dirty 返回 `source:'mirror'`/`writable:false`，base 不匹配 `draftStale`，读失败 `draftUnknown`；`applyEdits` 对 mirror/stale/unknown 返回 `MP_DOC_MIRROR_READONLY`；`draftMirror` 与磁盘写共用 per-file queue；模型输出 schema 已补 `writable/draft/mirrorDraft/draftStale/draftUnknown`。客户端 live 模式保存/clean close 也会清残留 mirror；clear 不再重读后删新一代（mismatch 保留句柄）。`live-draft-index` 12 条 + `documents-api` mirror 5 条 + `client-draft-mirror` 8 条通过。G3 核心路径通过：真实 `MP_LIVE_FACADE_MISSING`（bridge 控制路径）+ conflict 态真实输入后 mirror 已写入；清理遗留测试 host 进程后，host `documents.read` 返回 `source='mirror'`、当前正文、`writable=false`，`applyEdits` 返回 `MP_DOC_MIRROR_READONLY`，独立进程可见。authority 在 clean room + 0 live members 时优先返回 fresh mirror。
> **发布候选**：已生成 `dsh-markdown-editor-typora-1.9.0-rc.7.tgz`（149 files / 2.8 MB，SHA256 `C539C82D…`，B4.3+B3.3b，GA 清理：移除 debug hooks、补 clean-close/removed:0 测试、README/SHA256SUMS），已在隔离 Web profile `mp-pkg-test` 安装，并在 Desktop profile 以 file:rc.7.tgz 实装（TEMP disable 已移除，Markdown 模型工具已可调用）；Desktop 客户端 UI 重启验收待做。旧 rc.1/rc.2/rc.3/1.9.0 包不含最终清理，不能重发。详见 [RELEASE-1.9.0](RELEASE-1.9.0.md)。
> 读者：主控 Agent / 后续接手的工程师。先读 §1、§2，再读 §4（计划 A）与 §6（选择）。

---

## 0. 结论摘要

1. **推荐计划 A**：把“文件管理”收敛成宿主侧的一个 `DocumentSession` + 文件生命周期状态机；**不动 CM6 引擎字节**（coreHash 不变），先补 P0 review 链校验，再做 B4.3 冲突界面、B3.3b 草稿索引、外部改名/删除/只读处理、恢复中心，最后让 AI/工具写全部经过 session。
2. **计划 B 是真正的“引擎内核路线”**：先把文档权威与原生 review/undo 组放进 CM6 引擎，再接宿主 session。它能原生 Ctrl+Z 整组撤销 AI 修改、编辑器内装饰 diff，但要求 `coreHash` 变更 + 完整重建 + 五通道/视觉验收；在 1.7.6 已证明高风险，且对本轮“文件管理”不是必需。
3. **本轮真正的用户价值在宿主侧**：冲突可选择、改名/删除不丢稿、恢复副本可浏览、未保存草稿 AI 可见、AI 写永远不静默覆盖。这些都不需要动 CM6。
4. **一处重要纠偏**：HANDOFF §8.2 第 3 条说“`fs.patchText`/`fs.moveFile` 绕过守卫、需要补 `fs/patch-intent`/`fs/move-intent`”，在本机桌面内核 `0.2.2-rc.1` 上**已不成立**：`edit` 工具的 add/update/delete/move 分别走 write/edit/delete-intent，patch 走 edit-intent、move 走 edit-intent+write-intent。2.0 不需要为此改 DSH 内核；守卫剩余问题是**没有会话语义**与 **lookup 异常 fail-open**，不是“事件缺口”。详见 §1.3 与 §10。
5. **二处纠偏**：HANDOFF 说“`documents.*` 没有暴露给 HTTP，端点会拒绝”，字面不准确：`documents.reviewGroups`/`recover`/`discardRecovery`/`undoGroup(s)` 在插件 HTTP 路由上可被编辑面调用（受宿主连接认证保护），只有 `read/applyEdits/state/merge3` 强制 `MODEL_TOOL`。2.0 新增的冲突/草稿/文件生命周期端点必须沿用“编辑面可调、模型工具不可调、路由仍受 host 认证”的边界，并顺手收紧现有端点。详见 §10。
6. **不引入 CRDT**；不自动合并；不自动覆盖；不把 `documents.*` 开放给模型工具；不修改 DSH 安装包（`app.asar`）。任何“动内核”都优先解释为**插件宿主内核 `lib/`**，不是 DSH 应用内核。

---

## 1. 接管口径与已核实事实

### 1.1 基线

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 / 分支 | `D:\BuyKey\markpilot-public` / `main` | `git status`；HEAD `edb8b05` |
| 插件版本 | `dsh-markdown-editor-typora@1.8.1` | `package.json` |
| 测试 | `449 tests / 448 pass / 1 skip / 0 fail` | `npm test`（2026-11-10 本机） |
| host/core 门禁 | `HOST_CHECK_OK 9 files`；`CHECK_OK 124 files, 7351676 bytes, coreHash=4499e09…` | `node scripts/sync-host.mjs --check`、`sync-core.mjs --check` |
| 本机安装 | `profiles/desktop/node_modules/dsh-markdown-editor-typora` 为 junction → 仓库源码；版本 1.8.1 | `Get-Item` LinkType/Target |
| DSH 桌面运行时 | `@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.1`（app.asar 内 `dsh/package.json`） | 从 `app.asar` 提取 |
| 参考内核（headless） | `@deepseek-ai/dsh 0.2.1-rc.5`（`D:\npm-global`） | 只作对照；**不是**本机 GUI 运行时 |

### 1.2 现有分层与四个“真相”

| 层 | 拥有 | 现状 |
|---|---|---|
| renderer iframe（CM6） | `EditorState`、选区、撤销历史、IME、装饰 | `renderer-cm6/cm6/app.js` 为逐字节同步产物 |
| 父窗口 client | 保存身份 path/version/generation/recovery slot/review 横幅 | `lib/client.js`（7,628 行） |
| 宿主 `documents-service` | 当前正文权威、revision token、applyEdits、review group、recover、merge3 | `lib/documents-service.js`（959 行） |
| `LiveDocuments` room | checkpoint + 增量、epoch/version/saved、成员 | `host/live-documents.js`（949 行） |
| 磁盘 | 最终字节，`ctx.fs` 版本守卫 + 原子替换 | `ctx.fs` / native worker |
| DSH 内核 | fs 工具、连接认证、插件生命周期 | 只读依赖，**本轮不改 app.asar** |

四个真相（CM6 buffer / 父窗口 mirror+IndexedDB / live room / 磁盘）仍没有统一 revision；B3 的 `documents-service` 只是给 AI 选了一个当前权威，没有把它们合并。2.0 要解决的就是这个分裂带来的**文件生命周期**问题。

### 1.3 关键纠偏（与 HANDOFF-1.8.1 的差异）

| 编号 | HANDOFF 原文 | 实测/核对 | 对 2.0 的影响 |
|---|---|---|---|
| C1 | §8.2 #3：`fs.patchText`/`fs.moveFile` 直接写盘；需补 `fs/patch-intent`/`fs/move-intent` | 桌面 0.2.2-rc.1（`dsh/package.json` + `dsh/desktop-runtime.json` 双重确认）：`dsh-tool-fs` 的 add/update/delete/move 分别走 `fs/write-intent`/`fs/edit-intent`/`fs/delete-intent`/`fs/edit-intent`(源)+`fs/write-intent`(目标)；`patchText` 走 edit-intent、`moveFile` 走 edit+write-intent；`dsh-tool-str-replace-editor` 的 create→write-intent、str_replace/insert→edit-intent；全包无 `fs/patch-intent`/`fs/move-intent` 事件；`dsh-fs-local` 接受 `{version}`/`{kind:'replaceIfVersion',version}` | **不需要改 DSH 内核或新增 intent 事件**；2.0 的守卫重点是“会话语义 + fail-open + 运行时 capability 探测”，不是事件缺口；旧运行时（engines `dsh>=0.2.0-rc.2`）行为未核，P0/P1 要加**实机 intent 断言** |
| C2 | §8.2 #4：`documents.*` 没有暴露给 HTTP，端点会拒绝 | 仅 `documents.read/applyEdits/state/merge3` 强制 `MODEL_TOOL`；`documents.reviewGroups/recover/discardRecovery/undoGroup(s)` 可由编辑面 HTTP 路由调用（路由仍受 host connection 认证） | 冲突/草稿/生命周期端点沿用“编辑面可调、模型工具不可调”；顺手把现有端点补齐 authority 注释与测试 |
| C3 | §4.2 P0 缺口 A：reviewGroups 无 revision 字段、客户端无链校验 | 确认：`documents.reviewGroups` 只回 `{index,groupId,at,kind,changes,undoneAt}`；`restorePersistedReview()` 只过滤 `undoneAt` | 2.0 的第一批就是补 P0，不能跳过 |
| C4 | §7 B4.2b-full：远端事务 `addToHistory:false`，Ctrl+Z 不能整组撤销 AI | 确认；且引擎已有 `history-guard.mjs` 的 foreignSpans/eventGen 保护（远端写入后旧 undo 事件重插会被拦） | 计划 B 的原生 review 必须与 history-guard 兼容，工作量不是“加一个 annotation” |
| C5 | §2.8 引用区 Shift+Enter / Ctrl+B 已复现未修复 | 确认：`src-cm6` 有 `quoteLead` 但普通 blockquote 的 Shift-Enter 没有分支；跨行 wrap 仍会包进 `> ` 前缀 | 独立 Track E（引擎批次），不混进计划 A 的宿主架构批次 |

### 1.4 现有不变量的红线（2.0 全部保留）

HANDOFF §2.4 的 I1–I12：磁盘写必须 CAS；append 必须在同一事务校验 epoch+version+materialize==baseText；append 不改 saved/disk；一次 applyEdits 最多推进一个房间版本；改脏缓冲前必须独立归档；死草稿不当权威；不改 renderer 字节时 coreHash 必须绿；`documents.read` 不产生写入；review 期间不自动保存；任何过期/不一致 fail-closed；review group 必须最新且链连续；恢复副本只在持久化 checkpoint 成功后清理。

> 2.0 新增的文件生命周期动作（另存为、改名重绑、删除后保留、恢复中心）**不得**绕过以上任何一条；新增写路径必须先回答“归档了吗、CAS 了吗、失败是否零变化”。

### 1.5 三个“内核”不要混

| 名称 | 位置 | 谁发布 | 计划 A | 计划 B | 风险 |
|---|---|---|---|---|---|
| **DSH 应用内核** | `DeepSeek Harness/resources/app.asar` 内 `dsh/`（0.2.2-rc.1） | DSH 官方 | **不动** | **不动**（除非上游契约变化） | 高：改安装包不可持续、升级即丢 |
| **插件宿主内核** | `dsh-markdown-editor-typora/lib/index.js`、`documents-service.js`、`host/` | 本插件 | **动**（session/conflict/lifecycle/guard） | 动（消费引擎 session） | 中：可测试、可回滚 |
| **MarkPilot 引擎内核** | `renderer-cm6/cm6/`（逐字节同步）＋ `dsh-markpilot/src-cm6/` | MarkPilot/插件 coreHash | **不动**（Track E 修 bug 时例外） | **动**（native review/session） | 高：coreHash/五通道/显示事故史 |

> 因此：用户说“动内核”时，A 只动**插件宿主内核**；B 才动**MarkPilot 引擎内核**；两者都**不建议**改 DSH `app.asar`。如果需求只是“文件管理彻底完善”，A 已经覆盖，不必为“内核”二字付出 coreHash 成本。
>
> 若确实需要比现有 intent 更细的 fs 事件（例如 intent 要携带写入正文/hunks，才能让 session 把通用 fs 写转成 review），正确路径是：① 先在插件里**包装 `ctx.fs` 的 writeText/editText/patchText/deleteFile/moveFile**（capability flag + 还原函数 + 版本检测），拿到调用参数后再做 session 语义；② 或者向 DSH 上游提契约需求。**不要改 `app.asar`**：升级即丢、无法发布、且会把“插件问题”变成“宿主分叉问题”。

---

## 2. 把“文件管理彻底完善”定义成可验收的能力

### 2.1 文档生命周期状态（2.0 的统一语言）

```text
missing            文件在盘上不存在（被删除/改名/移走）
clean              磁盘权威，无未保存改动
dirty              buffer 权威，有未保存改动（含 review 前的普通编辑）
review             buffer 有 AI 修改组，等待保留/撤销
conflict           buffer 与磁盘都改了，未覆盖任何一边；需要冲突界面
external           磁盘被外部改了，buffer 干净；可静默采纳
recovery           存在关闭时留下的未保存草稿，等待恢复/丢弃
orphan             房间脏但无活成员（崩溃孤儿），只能显式恢复
owned-elsewhere    另一窗口/旧 EXE 持有未保存修改；本宿主只读/拒写
readonly/locked    文件/目录只读或被占用；保存必须给出明确出路
```

每个状态必须有：唯一权威、允许的写操作、归档/恢复路径、stale 检测、UI 文案与动作、测试。**2.0 的验收就是这 11 个状态都有可复现的入口与出口。**

### 2.2 用户可见能力矩阵（1.8.1 现状 → 2.0 目标）

| # | 能力 | 1.8.1 现状 | 缺口 | 归属 |
|---|---|---|---|---|
| F1 | 打开（最近/文件树/空白稿） | 有；`docs/recent` 会剔除不存在条目 | 无 | — |
| F2 | 自动保存 / Ctrl+S | 有；CAS + live.save + 外部对账（`runSave`，client 6015–6210） | 与 documents session 分离 | A-P5（可选）/ B |
| F3 | 另存为 | **无**；只有空白稿首次保存 `docs/create` | 需要 `docs/saveAs`；冲突/只读/改名后没有出路 | A-P4 |
| F4 | 外部修改（干净） | 有；watch/SSE → 静默采纳 | 无 | — |
| F5 | 外部修改（脏） | 只有横幅“重载磁盘版本/复制我的内容” | 无三栏、无逐块选择、无 base | **A-P2（B4.3）** |
| F6 | AI 修改审阅 | 有横幅/差异/撤销/保留；localStorage 持久化 | 链校验缺失（P0）；Ctrl+Z 不能整组撤销（B） | **A-P0 / B-P1** |
| F7 | 恢复（关闭时草稿） | 有 recovery slot / recovery 横幅 / 恢复/丢弃 | 无恢复中心、无历史浏览、无归档列表 | A-P4 |
| F8 | 恢复（崩溃孤儿房间） | 有 parkRecovery + 横幅 | 无统一入口；无“查看差异” | A-P4 |
| F9 | `liveUnsupported` 草稿 | **无宿主草稿**；AI 读到旧磁盘 | 需要 B3.3b 只读镜像 | **A-P3** |
| F10 | untitled 空白稿 | 首次保存 `docs/create`；IndexedDB 恢复 | AI 不可见；无宿主草稿索引 | A-P3（只读可见性，flag） |
| F11 | 外部改名/移动 | host `tickWatch` 已检测 missing，但 SSE 不带 missing；客户端当通用外部变更，无重绑入口 | 无“继续编辑新路径/另存为”；改名后 save 仍打到旧路径 | **A-P4** |
| F12 | 外部删除 | `apiSave` “file no longer exists” 被归入 `FS_STALE_VERSION`，客户端显示泛化冲突横幅 | 无“另存为/保留草稿/关闭”；干净文档会走 `loadFromDisk` 失败 | **A-P4** |
| F13 | 只读/被占用 | 保存失败并显示错误 | 无“另存为”逃生门 | A-P4 |
| F14 | 大文件 | 编辑器可开 150k 字符；归档上限 64MB，超限 `MP_ARCHIVE_FAILED` fail-closed | 无分块归档/无明确提示 | A-P4 可选 / B |
| F15 | 多窗口 | live room + 非本地成员防线 | 无 owner 租约心跳；session 归属未定义 | A-P5 评估 |
| F16 | 多实例/旧 EXE | 有非本地成员→disk 权威/unsavedElsewhere | 旧 EXE 退役前必须保留 | 全部 |
| F17 | 历史/备份 | `agent-before` 20/源、append recovery 20、parked recovery | 无浏览/对比/一键恢复 UI；无周期快照 | A-P4（可选快照） |
| F18 | AI 读写当前正文 | `documents.*` 已做 buffer 权威 + review | 通用 fs 工具没有会话语义；guard fail-open | **A-P5** |
| F19 | 冲突不覆盖 | 写拒绝 `MP_DOC_EXTERNAL_CONFLICT` / `MP_FILE_CONFLICT` | 无结构化解决协议 | A-P2 |
| F20 | 失败零变化 | 现有不变量 | 新端点必须逐条测试 | 全部 |

---

## 3. 当前架构到底缺什么

### 3.1 不是“再写一个服务”，而是缺一个**文件生命周期的唯一协调者**

现有 `documents-service` 只服务模型工具：`read/applyEdits/state/recover/merge3/review*`。编辑器的 `runSave/pullText/live.save` 完全没经过它；B2 写守卫只在 `ctx.fs` 的 intent 上做“脏就拒/干净就 CAS”；外部改名/删除只是 watch 的 version 变化。于是：

- 打开一个文件后，**谁代表“这个文件现在的会话”**没有对象；`DocumentStore` 每次保存新建、用完即弃（DESIGN-B3 §1 已记录）。
- 冲突、review、recovery、draft、rename 各自有一套局部判断，没有共同状态；
- AI 工具与通用 fs 工具对同一个“打开的文件”行为不同（一个走 documents，一个走 guard）；
- 文件被改名/删除时，没有对象能说“这是同一个文件，只是路径变了”。

### 3.2 计划 A 的核心：`DocumentSession` 是**协调者**，不是第五个真相

- 它不复制正文，不另存一份权威；它只缓存 canonical path 的**解析结果**（source/revision/dirty/conflict/...）与**动作状态**（review groups、conflict session、draft mirror、recovery refs）。
- 持久化仍只有：`rooms.sqlite`（rooms/changes/agent_group/append_recovery/recovery/writers）、`draft-archive/`、`recovery/`、磁盘文件。
- 新增的唯一持久表是 B3.3b 的 `draft_index`（镜像，不是权威），以及可选的 `file_identity` 缓存（内存即可）。
- 所有写仍走现有 `applyEdits`/`apiSave`/`apiEdit`/`live.save` 的 CAS 与归档链。

---

## 4. 计划 A（推荐）：宿主文档会话 + 文件生命周期

### 4.1 设计原则

1. **一个 canonical path 一个 session**；session 是宿主进程内对象，键为 `canonicalTarget(path)`。
2. **编辑器 buffer 仍是用户输入唯一入口**；session 不接管 CM6，不直接改 buffer。
3. **磁盘是持久化结果**；所有写带 CAS；AI/工具写先归档；编辑器保存保持现有 `runSave`（2.0 不强行接管，见 P5）。
4. **单一 intent 入口**：AI 的 `markdown` 工具继续走 `documents.applyEdits`；通用 fs 写继续由 guard 拦；新增的冲突/草稿/生命周期端点只给编辑面。
5. **fail-closed 优先**：任何 revision/正文/路径不一致 → 拒绝并保留双方文本；不自动合并、不自动覆盖。
6. **能力开关**：`documentSession`、`fileLifecycle`、`conflictUi` 三个 capability flag（默认在 2.0.0-rc 关，验证后开），可一键回 1.8.1 语义。

**A 明确不做（防止范围膨胀）**：

- 不做 CRDT/离线多 writer；
- 不做多文件 working set；未打开的文档 AI 写仍直接落盘（但 2.0 补改前归档，见 P5）；
- 2.0 不接管编辑器 `runSave`（只做 flag 原型）；
- 不做 CM6 原生 review/undo 组（那是 B）；
- 不自动合并、不自动恢复、不自动覆盖；
- 不把 `documents.*` 暴露给模型工具，也不新开公网 HTTP 端点。

### 4.2 架构

```text
┌──────────────────────────── 父窗口 client（React/iframe 外壳） ────────────────────────────┐
│  runSave / pullText / live 中继 / review 横幅 / 冲突面板 / 恢复中心 / 改名删除横幅           │
│         │ api()（host connection auth）                    │ postMessage（iframe）          │
└─────────┼──────────────────────────────────────────────────┼───────────────────────────────┘
          ▼                                                  ▼
┌──────────────────────────── 插件宿主 lib/ ────────────────────────────────────────────────┐
│  index.js 路由/认证/SSE/watch/apiSave/apiEdit/docs.*                                       │
│      │                                                                                     │
│      ├── documents-service.js（模型工具权威：read/applyEdits/review/undo/merge3）          │
│      ├── document-sessions.js（新：session 快照/状态机/动作编排，缓存+TTL）                  │
│      ├── conflict-service.js（新：一次性 conflict session，TTL/token，merge3 hunks）        │
│      ├── draft-index.js（新：B3.3b 只读镜像）                                              │
│      ├── file-lifecycle.js（新：missing/renamed/readonly/saveAs/recovery 列表）             │
│      └── createWriteGuard（B2：fs/write|edit|delete-intent → 脏拒/CAS）                    │
│                                                                                            │
│  host/live-documents.js（rooms.sqlite：rooms/changes/agent_group/append_recovery/recovery） │
│  host/document-store.js / native worker（原子写、prepare/commit/abort）                    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
          │                                                          │
          ▼                                                          ▼
   磁盘文件（ctx.fs CAS）                               %LOCALAPPDATA%\.markpilot\（rooms.sqlite / recovery / draft-archive）
```

**关键点**：`document-sessions.js` 调用 `documents-service` 的 `authority()`（重构为可复用的 `resolveAuthority()`），不复制其判断；`conflict-service.js` 复用 `merge3Text` 与 `applyEdits`；`draft-index.js` 只写新表；`file-lifecycle.js` 只做路径/存在性/身份与 UI 动作编排。

### 4.3 数据模型

#### 4.3.1 新表 `draft_index`（B3.3b，rooms.sqlite 内独立表）

```sql
CREATE TABLE IF NOT EXISTS draft_index (
  source       TEXT PRIMARY KEY,   -- canonical path（仅本地绝对路径）
  text         TEXT NOT NULL,
  text_sha     TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  base_version TEXT NOT NULL,      -- 编辑器打开时的磁盘版本（用于判 stale）
  doc_token    TEXT,
  session      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS draft_index_updated ON draft_index(updated_at DESC);
```

- 只存**已打开、有路径、引擎 facade 缺失**时的只读镜像；不写磁盘、不建 room、不改 saved/version。
- 上限：单条 8MB、总条数 512、保留 14 天；超限返回明确错误，不截断。
- 清理：保存成功、关闭并丢弃、文档删除、过期回收。

#### 4.3.2 内存结构（不持久化，进程重启即失效）

```text
Session {
  canonicalPath, displayPath, docToken;
  lastSource: 'disk'|'buffer';
  lastRevisionId; lastTextSha; providerVersion;
  state: clean|dirty|review|conflict|external|recovery|orphan|owned-elsewhere|missing|readonly;
  room: {epoch,version,savedVersion,members,localMembers,savedTextAvailable};
  reviewGroups: [{groupId,baseRevision,resultRevision,undoneAt}];
  conflict: {conflictId,expiresAt,baseRevision,currentRevision,hunks} | null;
  recovery: [{kind,path,at,bytes,sha256}];
  file: {exists,identity:{dev,ino,size,mtimeNs},renameCandidates?};
  lastAccessAt;
}
```

#### 4.3.3 现有表复用（仅 `rooms` 加一列）

| 表 | 用途 | 2.0 是否改 |
|---|---|---|
| `rooms` | 房间 checkpoint/version/saved/epoch | **不改**（旧 EXE 用位置参数 `INSERT INTO rooms VALUES(?,?,0,0,?,?,0,?)`，加列会 `SQLITE_ERROR`；B4.3 用独立表） |
| `room_resolved`（新） | 冲突已解决时的磁盘 hash，`epoch PK REFERENCES rooms(epoch) ON DELETE CASCADE` | B4.3 新增；旧 EXE 不读，零影响；SET 只在 `appendResolvedConflict` 事务内，CLEAR 在 save/adoptDisk/房间删除 |
| `changes` | 增量 + `group_id` | 否 |
| `clients` | 成员 pid/ack | 否 |
| `agent_group` | review 组审计（base/result revision） | 否；只增加返回字段 |
| `append_recovery` | AI 改前副本（20/源） | 否 |
| `recovery` | 崩溃/关闭草稿 parked | 否 |
| `writers` | 保存租约（owner/pid/since） | 否 |

#### 4.3.4 为什么 2.0 不建 `document_session` 表（对规划搭档方案的裁决）

规划搭档建议在 `rooms.sqlite` 新建 `document_session` 表，存 `state/base_disk_version/base_text_sha/epoch/saved_version/lease_owner/lease_pid/...`，理由是“多实例归属 + 跨重启可见”。**本文裁决：2.0 不建这张表**，理由：

1. **session 状态是派生的，不是真相**：`rooms` + 磁盘 + `agent_group` + `draft_index` + `recovery` 已能算出全部状态；再存一份 state 等于复制第五个真相，崩溃/旧 EXE/多实例下会漂移。
2. **死会话不得当权威（I6）**：内存 session 随宿主进程消失；持久 session 行必须靠 pid/心跳判定死活，复杂度高且仍然可能误判。宿主重启后从 rooms 重建 session 更安全。
3. **多实例归属已有事实来源**：`rooms.members`/`clients.pid` + `localMembers` 的 non-local member 防线已经决定“谁可以 append”；再来一套 session lease 只会引入第二套所有权。
4. **跨重启可见性由 B3.3b `draft_index` + 既有 recovery 提供**；session 本身不需要跨重启。

**何时重新评估**：如果 2.0 之后出现“同一台机器多个 DSH 宿主同时编辑同一文件”的真实需求，且 rooms 的 pid 防线不足以决定 owner，再加 `document_session`（带 pid-alive 租约），作为独立批次；不在 2.0 默认路径。

> 数据位置补充（HANDOFF §1.6 遗漏）：最近文档 `%APPDATA%\MarkPilot\recents.json` + `workspace-recents.json`；untitled 首次保存草稿在浏览器 IndexedDB + workspace draft；`docs/create` 的 `draftReceipts` 是内存回执（2048 上限，重启后靠固定 UUID 名 + 字节复核保证幂等）。

### 4.4 API 形状与权限边界

> 约定：`编辑面` = 插件 client `api()`（HTTP，host connection 认证）；`模型` = `MODEL_TOOL`。新增端点**只给编辑面**，不注册为模型工具，不接受 `MODEL_TOOL`。

| 端点 | 权限 | 作用 | 关键约束 |
|---|---|---|---|
| `documents.session` | 编辑面（只读） | `{path,cwd}` → session 快照 + allowed actions | 不创建房间、不写、不清理（I8） |
| `documents.conflictOpen` | 编辑面 | `{path,cwd,baseRevisionId}` → `{conflict:false}` 或 conflict session + hunks | 只在 `conflict` 状态返回；无 base 文本则拒绝 |
| `documents.conflictResolve` | 编辑面 | `{path,cwd,conflictId,baseRevisionId,resolutions[]}` → applyEdits 结果 + groupId | 重新 authority；任一边再变 → `MP_DOC_STALE`，零写入 |
| `documents.conflictCancel` | 编辑面 | `{path,conflictId}` → `{cancelled:true}` | 只删 session |
| `documents.draftMirror` | 编辑面 | `{path? ,cwd?,docToken,text,baseVersion,session,sha256,bytes}` | 8MB/512 条；不写盘；无路径的 untitled 只做只读可见性（flag `untitledDraftIndex`），不参与 AI 路径解析 |
| `documents.draftRead` | 编辑面（只读） | `{path,cwd}` → `{source:'mirror',draft:true,writable:false,text,baseVersion}` 或 `{draftStale:true}` | base 不匹配不回传正文 |
| `documents.draftClear` | 编辑面 | `{path,cwd,docToken}` | 只删镜像 |
| `documents.fileState` | 编辑面（只读） | `{path,cwd}` → `{exists,state,renameCandidates?,readonly?}` | 只读；不创建 |
| `documents.locate` | 编辑面（只读） | `{path,cwd}` → 同目录同 dev/ino 的候选（改名检测） | 只扫父目录；上限 4096 项 |
| `docs/saveAs` | 编辑面 | `{path,cwd,targetPath,text,baseVersion?}` → 版本 | 目标必须不存在或 CAS；不覆盖；归档旧路径不删；**沙箱策略与 apiSave/apiEdit 同权** |
| `documents.recoveryList` | 编辑面（只读） | `{path,cwd}` → append/parked/archive 条目 | 只回元数据，正文按需读 |
| `documents.recoveryRead` | 编辑面（只读） | `{path,cwd,recoveryPath,sha256}` → `{text}` | 路径必须在允许目录；sha 校验；大小上限 |
| `documents.archiveList` | 编辑面（只读） | `{path,cwd}` → `draft-archive` 中该 source 的 sidecar 条目 | 只读元数据 |
| `documents.read/applyEdits/state/merge3` | 模型 | 不变 | 现有 `MODEL_TOOL` 强制 |
| `documents.reviewGroup(s)/recover/discardRecovery/undoGroup(s)` | 编辑面 | 不变 | 2.0 补 authority 注释/测试 |

**绝不**：把 `documents.*` 注册成模型工具；让 HTTP 免认证；把 conflict session 暴露给模型；让 `documents.read` 产生写入。

> **模型可达性有两层防线**（不要只守一层）：① `dispatch` 的 `authority === MODEL_TOOL` 守卫；② `markdown` 工具的 action 参数白名单（`lib/index.js:2133-2214`，当前只有 read/applyEdits/undoGroup 等）。2.0 新增的 session/conflict/mirror/recovery/文件生命周期端点**不得**加进模型工具参数；现有 `documents.recover` 虽无 dispatch 守卫，但模型实际不可达，靠的就是工具面白名单——保持这个结构。

### 4.5 状态机与动作

| 当前状态 | 触发 | 下一状态 | 允许动作 | 禁止 |
|---|---|---|---|---|
| clean | 用户编辑 | dirty | 保存、关闭 | 无 |
| clean | 外部写 | external | 静默采纳、保存 | 无 |
| clean/dirty | AI 写成功 | review | 撤销/保留并保存/看差异 | 自动保存 |
| review | keep | dirty | 保存 | 自动写盘 |
| review | undo | dirty/clean | 保存 | 双写（renderer 与 host 只能一个写者） |
| dirty | 外部写 | conflict | 打开冲突面板、取消 | 自动合并/覆盖 |
| conflict | resolve | review | 应用选择后审阅 | 直接落盘 |
| conflict | cancel | dirty | 继续编辑 | 清空正文 |
| dirty | 关闭编辑区 | recovery | 恢复/丢弃 | 自动恢复 |
| 无活成员 + 脏房间 | 打开 | orphan | 显式恢复 | 把死草稿当权威 |
| 非本地成员 | 打开/写 | owned-elsewhere | 磁盘权威/只读 | append |
| any | 文件删除 | missing | 另存为/保留草稿/关闭 | 静默重建旧路径 |
| any | 文件改名 | missing→clean（重绑） | 继续编辑新路径/另存为 | 在旧路径静默新建 |
| any | 只读/占用 | readonly | 另存为/重试 | 绕过 CAS |

### 4.6 阶段计划（每阶段独立可验收、可回滚）

#### P0 · 冻结与 review 链收口（2–3 人日）

> **推荐执行顺序：P0 → P2（冲突）→ P3（mirror）→ P4（文件生命周期）→ P1（session 影子）→ P5（session 权威/guard）→ P6（发布）**。P0 必须先做；P1 与 P2/P3/P4 无硬依赖，可以并行或前后调换；把 P1 放在 P4 后是为了先拿到用户可见的文件管理闭环，再用 session 影子收口。P2 不依赖 P1（可直接用 `authority()`），P1 也不依赖 P2。

- 冻结基线：记录 HEAD、`npm test` 计数、coreHash、tarball SHA；不动 tag。
- `lib/documents-service.js`：
  - `reviewGroups` 增加 `baseRevision/resultRevision/actor`（只读字段，不暴露文本）；
  - `reviewGroups` 同时返回 **`chainOk/chainReason/currentRevisionId`**：host 用 `authority()` 读当前正文，校验“所有组未撤销 + 相邻组 `sameRevisionContent(prev.resultRevision, next.baseRevision)`（**按内容 sha 比较，不按 revision 字符串**，否则 epoch 变化会误判断链）+ 末组 `resultRevision` 的内容 sha === 当前正文 sha”。**链校验放 host**：client 不需要 sha256（client.js 无此实现），只消费 `chainOk`。**不新增 `documents.reviewChain` 端点**（减少一个 API 面）。
- `lib/client.js`：
  - `normalizeReviewRecord` 升 v2（`v:2`），只接受带 host 校验语义的新记录；v1 记录直接丢弃（不猜）；v2 可选存 `revisions` 供诊断，但**链校验的权威在 host**，客户端不自己算 sha；
  - `persistReviewState` 写 `v:2`；
  - `restorePersistedReview` 调 `documents.reviewGroups`（传 groupIds + path），`chainOk === false` 或任一组 `undoneAt` → `clearPersistedReview()` + toast“之前的 AI 修改审阅已过期”；`chainOk === undefined` 只兼容旧宿主，按旧 `undoneAt` 判定；
  - 保留“干净打开不立即删、等 recovery 探测”的现有顺序。
- 测试：连续链、断链、末组内容不是当前正文、旧格式无 revision、已撤销组、并发 epoch 变化。
- 真机：单组/双组关闭→重开→恢复→撤销→保留并保存；磁盘 hash 不变；清理 `agent_group`/`append_recovery`/localStorage。
- **闸门 G0**：`npm test` 全绿；双组真机通过（截图/日志）；`README` 恢复 `835bff35…`、7825 B；无测试残留。
- **P0 非阻塞 backlog（对抗 Round 2 登记）**：① `chainReason:'authority-error'` 时 client 目前也清 review（文本不丢，只丢 UI）——后续可改为“权威暂不可用则保留，仅语义断链才清”；② 断链且已有新组时陈旧组仍可能展示，reviewDiff 不看 chainOk；③ reviewGroups 每次 ≤20 次只读 SQLite 连接 + 全读，后续可合并为一次 `listAgentGroupsByIds`；④ 可把链校验抽成纯函数 `validateGroupChain(groups,currentTextSha)` 便于单测；⑤ `agent_group` 无清理策略，登记 housekeeping（不在 2.0 关键路径）。
- **真机 Round 1 新发现（B4.3-UI）已修**：新建文件首次保存后不 join live，导致 AI/冲突增量看不到。落地为 `startLive` 去 `firstOpen` 门、`doc.needLiveJoin` + `joinLiveIfNeeded()`（只拿票 bind，不 `setValue`、不移动光标）、`handleLiveError` 先 `stopLive(true)` 再清票；`runSave` 里不再全量 reload。复测断言见 `documents-api` B4.3-ADV4 与下一步真机。

#### P1 · `DocumentSession` 影子（3–5 人日）

- 新建 `lib/document-sessions.js`（约 600–900 行）：
  - `resolveAuthority` 从 `documents-service.js` 抽出（纯读，返回现有 authority 快照）；
  - `SessionManager.forPath(payload)`：缓存 canonical→session，TTL 30 分钟；不持久化、不写；
  - `snapshot()`：`{state,source,revisionId,dirty,conflict,orphanDraft,external,unsavedElsewhere,room,reviewGroups,recovery,allowed}`；
  - `allowedActions()`：由状态推导（openConflict/recover/discard/saveAs/retry...）。
- `lib/index.js`：新增 `documents.session`（编辑面只读）；`KNOWN_ENDPOINTS`；路由仍走 fenceStatus。
- **影子对比**：同一路径连续调用 `documents.state`（模型）与 `documents.session`（编辑面），记录差异；不改变任何写路径。
- 测试：状态机表驱动（11 状态 × 允许/禁止动作）；session 不创建房间/不写盘；TTL/缓存回收；`MODEL_TOOL` 调用被拒。
- **闸门 G1**：脚本化 30 个场景 0 差异；无副作用；全绿。

#### P2 · B4.3 冲突界面（4–6 人日）

- 新建 `lib/conflict-service.js`（约 300–450 行）：
  - `open`：`authority()` 必须 `conflict:true`；`room.savedTextAvailable` 为真才取 base（否则返回 `MP_CONFLICT_NO_BASE`，不猜）；`ours=room.text`；`other=provider.text`；**base/ours/other 先做 EOL 归一再 diff**（buffer 是 LF；resolve 结果写回 buffer 也用 LF，保存时由 textCodec 恢复原 EOL）；`merge3Text` → hunks；`conflictId` UUID、TTL 10 分钟、`currentRevision`；
  - `resolve3Text(base, ours, other, resolutions)`（纯函数，与 `merge3Text` 同库）：**非冲突改动全部保留**；冲突块按 `ours/theirs/both/manual` 物化；`both` 用分隔符；manual 只替换该块；行尾归一；`truncated` 只影响 UI，不影响 resolution 输入；全组合单测；
  - `resolve`：重跑 `authority()`；校验 session/TTL/path/baseRevision/`conflict` 仍成立；按 resolutions 物化最终文本；**注意 1：不能直接调 `applyEdits`**——它在 `a.conflict === true` 时会立刻返回 `MP_DOC_EXTERNAL_CONFLICT`（`documents-service.js` 542）。**不抽 `applyEditsCore`**（对抗 Round 2 裁决）；把冲突写路径内联在 `conflictResolve`：归档 tag `conflict-before` → `appendResolvedConflict` → `recordAgentGroup(kind:'conflict-resolve')`，不改变 `applyEdits` 的模型工具语义。**注意 2：解决后必须能保存**——`live.save` 在 `(await readDisk).hash !== room.disk` 时会抛冲突（`host/live-documents.js` 589–598）。因此不要“先 append 后 mark”两步走；计划采用**原子 `live.appendResolvedConflict`**：在同一个 `withFileCommit`/事务里校验 `epoch+version+materialize==baseText`、`expectedDiskHash`（conflictOpen 时用只读 `live.readDiskIdentity` 取得的磁盘字节 hash），再 append、把 `rooms.disk` 推进到本次磁盘 hash，并在同一事务 `INSERT OR REPLACE room_resolved(epoch,disk,resolved_at)`（独立表，不改 rooms 列）。`authority()` 在 `room_resolved.disk === 当前磁盘 hash` 时不再报 conflict；下一次保存按当前磁盘版本 CAS 覆盖（用户明确选择）；任何再次外部变化都会使 hash 不匹配，重新进入 conflict。成功后删 session；失败保留 session 且零变化；
  - `cancel`：只删 session；
  - 大文本：>2MB 或 >2000 行只回 hunk 摘要 + `truncated:true`；**resolution 的 manual 文本不截断**。
- `lib/index.js`：三个端点 + `KNOWN_ENDPOINTS`；编辑面权限；`MODEL_TOOL` 拒绝。
- `lib/client.js`：
  - 冲突横幅增加 `查看冲突`（保留“重载磁盘版本/复制我的内容”作为快捷路径）；
  - 新增**冲突面板**（覆盖层，不塞 28px rail）：标题“第 i/n 处冲突”、base 灰/ours 绿/theirs 蓝、每段四选一（用我的/用磁盘/两边保留/手动编辑）、未解决计数、应用/取消；结果预览；
  - 键盘：Tab/Shift+Tab、Esc 取消、Ctrl+Enter 应用；焦点管理；`aria`；
  - 应用后进入 review 横幅（若产生 group），不自动保存；取消后双方文本仍在。
- 测试：`merge3Text` 纯函数（独立改动/重叠/插入删除/首尾/CRLF）；session 过期/revision 变化/path 不一致/重复 resolve/cancel 零写入；所有 choice 组合；manual 文本边界；**resolve→保存能通过 live.save 的 diskHash 校验；resolve 后再次外部修改→重新 conflict；resolve 后重启（room_resolved 持久化）不回退成脏写**。
- 真机：编辑器改一段不保存 → 外部程序改同一段 → 冲突横幅 → 面板选择三种 choice → 应用后正文正确、磁盘未自动写 → 保存后磁盘更新；取消后双方文本在。
- **闸门 G2**：零静默覆盖；三 choice + manual 真机通过；截图（视觉代理 DeepSeek 看图）；磁盘字节断言。

#### P3 · B3.3b 草稿索引（3–4 人日）

- `MarkPilot-CM6/shell/live-documents.js`（源，改后 `node scripts/sync-host.mjs` 同步到插件 `host/`）：`draft_index` 表 + `putDraft/getDraft/clearDraft/listDrafts/pruneDrafts`；与 rooms 同库、独立事务；不读房间。
- `lib/index.js`：`documents.draftMirror/draftRead/draftClear`；编辑面权限；大小/条数/保留上限；**untitled 只读可见性**（`source` 用 `untitled:<docToken>`，不进 `documents.read` 的路径解析、不可 AI 写，flag `untitledDraftIndex` 默认关，验证后开）。
- `documents.read` 无 room 时：先 provider/disk，再查 mirror；base 匹配 → `source:'mirror',draft:true,writable:false`；不匹配 → `draftStale:true`，不回正文。
- **写路径必须认 mirror**：`applyEdits`/`authority()` 在无 room 时必须查 draft_index；若存在 base 匹配且 `text !== disk text` 的 mirror，按“有未保存草稿”处理（`unsavedElsewhere:true` / `mirrorDraft:true`），`applyEdits` 拒绝（`MP_DOC_UNSAVED_ELSEWHERE` 或新码 `MP_DOC_MIRROR_READONLY`），否则模型工具会绕过编辑器直接写盘、覆盖未保存草稿。mirror 绝不成为写权威。
- `lib/client.js`：`doc.liveUnsupported` 时编辑后 debounce（1.5s）发 mirror；保存成功/丢弃/关闭时 clear；AI 读到的 mirror 只用于展示/引用，不自动应用。
- 测试：facade 禁用/缺省；8MB 上限；base 不匹配；重启后定位；清理不影响 rooms/recovery；并发 mirror/clear；**mirror 存在时 `applyEdits` 必须拒绝且磁盘不变**。
- 真机：禁用 facade → 改一段不保存 → AI `read` 看到当前正文、`edit` 返回 `writable:false`；重启后草稿可定位；清理后房间/恢复不受影响。
- **闸门 G3**：AI 只读可见；零写盘；镜像不成为第五个真相（过期不返回正文）。

#### P4 · 文件生命周期完善（4–6 人日）

> **状态（2026-11-11）**：host 切片 `cdaba73` + 客户端 missing 横幅 `60aee5b`：watch `missing:true` latch/恢复帧/首挂流补帧、save `reason:'missing'`、客户端 missing latch（打字/apply/live 不顶横幅）、重试/复制、自动保存停写与错误分类；7 条新测试；全量 517/516/1。fileState/locate/saveAs/readonly 已接，恢复中心未接。

- `host/index.js` watch：**`tickWatch` 已有 missing 分支**（`fs.stat` undefined → `missing=true`、version=''、不更新 lastVersion，`index.js:839-861`）；真正缺的是**没有把 missing 传给客户端**：`broadcastChange` 只发 `version:''`（`index.js:823-837`）。2.0 在 SSE `change` 里增加 `missing:true`（保持 version 兼容），并 **latch missing 状态**：只在“存在→missing”或“missing→存在”的跃迁时广播一次，避免 missing 期间每轮 tick 重播；文件重新出现时清 latch。
- `lib/client.js` 外部事件：`onExternalEvent`（约 6402-6436）现在把 missing 当通用外部变更——干净文档会 `loadFromDisk({silent:true})` **静默失败**（旧内容仍显示、无提示；非 silent 路径才显示“打开失败”）；脏文档会显示泛化的“文件已在磁盘上更新”冲突横幅。2.0 必须在最前面分支 `data.missing`：干净 → “文件已不存在（可能被删除或改名）”，给 `另存为/重试/关闭`；脏 → “文件已不存在；草稿保留”，给 `另存为/复制内容/关闭并保留草稿`；**不调用 `loadFromDisk` 冒充冲突**。
- `runSave` 的错误分类：`apiSave` 的 `file no longer exists` 目前是 `FS_STALE_VERSION`（`index.js:1103-1104`），客户端 6179-6184 会归入“文件已在别处被修改”的冲突横幅；2.0 在 host 的 `FS_STALE_VERSION` 上附 `reason:'missing'`（**不改变 code，兼容旧客户端**），客户端按 `reason` 走 missing 横幅，而不是仅凭错误文案归入 conflict。
- `lib/file-lifecycle.js`：
  - `fileState`：`stat` 存在性/可写性；`missing` 时用上一次 identity（dev/ino/size/mtimeNs）在父目录扫描候选（改名检测，最多 4096 项，只读）；**仅本地 NTFS 且 ino>0 才做候选**；多个候选（硬链接/克隆）只列给用户选，绝不自动重绑；
  - `saveAs`：新路径 `wx` 独占创建（或目标不存在才允许）；不覆盖；更新 recents；不改旧文件；**2.0 先覆盖三种逃生场景**（missing / readonly·locked / 冲突后保留），普通文档的“另存为”若涉及 live 房间重绑，必须单独验证 unbind→bind→新房间，未通过就标 2.1；
  - recovery/archive 列表：`append_recovery`/`recovery` 行 + `draft-archive` sidecar，按 sourcePath 过滤，只回元数据；`recoveryRead` 做路径白名单 + sha 校验 + 大小上限。
- `lib/index.js`：`documents.fileState/locate`、`docs/saveAs`、`documents.recoveryList/recoveryRead/archiveList`。
- `lib/client.js`：
  - 删除横幅：`磁盘上的文件已不存在（被删除或改名）` + `另存为` / `复制我的内容` / `关闭并保留草稿`；
  - 改名横幅：`检测到文件可能已改名为 X` + `继续编辑新路径` / `另存为` / `忽略`；**重绑前必须比较新路径正文与旧 `savedText`：相同才允许带 dirty 重绑；不同则先另存为或进入冲突，不得把旧 buffer 直接套到新文件上**；
  - 只读/占用：错误 + `另存为`；
  - 恢复中心：rail 入口打开覆盖层，列 append/parked/archive，支持查看/复制路径/恢复/丢弃；不自动恢复；大文本预览截断。
- 测试：删除（干净/脏）、改名（同目录/跨目录）、只读、saveAs 不覆盖、recoveryRead 路径穿越/伪造 sha、恢复中心空/多/过期；**改名后 watcher 只报一次/失效时，2s 探测仍能给出 missing 结论**。
- 真机：外部 `Rename-Item` / `Remove-Item` 后横幅动作；字节级断言旧文件不被重建、新路径内容正确；截图。
- **闸门 G4**：四种外部变更不丢稿；旧路径不静默重建；saveAs 永不覆盖。

#### P5 · 会话权威接管与 fs 守卫收敛（5–8 人日）

- `documents.read/applyEdits/state` 全部经 `SessionManager.snapshot()`；行为与 1.8.1 等价（先影子/对照）。
- **补 disk-authority AI 写的归档缺口**：现有 `applyEdits` 只在 `a.source === 'buffer'` 时 `checkpoint()`；对未打开的磁盘文件走 `edit`/`save` 直接写，**没有改前副本**（与 HANDOFF §8.4“所有写端点必须有归档”不一致）。2.0 把 checkpoint 提升为 `checkpointAny(a)`：buffer 与 disk 都先 `docs/archive`（`tag:'agent-before'`，带 baseVersion），失败 → `MP_ARCHIVE_FAILED` fail-closed；超过 64MB 保持 fail-closed 并给明确错误。
- `createWriteGuard`：
  - 保留“脏文档拒绝 + 干净 CAS”；
  - **lookup 覆盖 draft_index**：无房间的 liveUnsupported 草稿也要被守卫看见；mirror base 与磁盘一致且 text 不同 → 拒绝 fs 写（`MP_DOC_DIRTY` 或 `MP_DOC_MIRROR_READONLY`），避免通用 fs 工具绕过编辑器覆盖草稿；
  - 错误文案改为可操作：`MP_DOC_DIRTY` 提示“该文件在 MarkPilot 中打开且有未保存修改；请先用 markdown 工具或先在编辑器中处理”；
  - **lookup 异常改为有界 fail-closed**（数据安全优先，采用规划搭档建议）：`stateOf` 单次失败 → `warn` + 计数 + 放行（保住临时 DB 锁时的可用性）；**连续 3 次失败 → 写路径抛 `MP_DOC_LOOKUP_FAILED`**，拒绝 fs 写；成功一次清零；阈值可配（`guardFailClosed: {threshold:3}`）。1.9.x 先观察计数，2.0 默认开；现有 “lookup failure fails open” 测试改为“单次放行/连续 3 次拒绝”两态；旧宿主兼容由启动自检和真实 DB-lock 探针验证；
  - 增加 `fs/observed` 监听（若内核提供）用于 session 对账/watch 刷新；不存在则降级；
  - 可选（flag `fsSessionIntents`，默认关）：**包装 `ctx.fs` 的 `writeText/editText/patchText/deleteFile/moveFile`**，在调用前查 session；打开且有未保存 → 拒绝或转 review；关闭 → 先归档再放行；必须可还原、版本检测、重入保护、沙箱策略不变；不改 DSH 包。这是“让通用 fs 写受会话约束”的可行路径，但风险高于 intent，先实验再默认；
  - 可选（flag `fsArchiveAll`，默认关）：对 `.md` 的 `fs/delete-intent` / `fs/write-intent` / `fs/edit-intent` 先归档改前正文；必须带重入保护（归档自身写入不触发）、大小上限、仅本地 `.md`。默认关的原因：intent 不带操作正文，`edit-intent` 无法区分 patch 与 move，且每次 AI 写会多读一次文件；先做实验再决定是否默认开。
- **编辑器 `runSave` 不强行接管**：先做“session 保存票据”原型（capability flag 默认关），验证不死锁、不双重租约、不与 live.save 冲突；不通过就不进 2.0.0。
- 测试：三种 intent（write/edit/delete）现有测试 + 模拟 patch/move/delete 的守卫用例；guard lookup 异常；session 与 authority 0 差异；flag 关=1.8.1 行为；disk-authority AI 写必须产生 agent-before 归档；归档失败必须零写入。
- **闸门 G5**：AI 写全部经 session；disk-authority 也有改前副本；flag on/off 行为对照；`npm test`、`sync-host/core` 绿；无新死锁/双重写。

#### P6 · 2.0.0 发布（3–4 人日）

- 版本 `2.0.0`；`README`/`RELEASE-2.0.0.md`/`LOG-2.0.0-FILE-MANAGEMENT.md`。
- `npm test` → `npm pack --json` → 安装（junction 不变）→ 真机回归全矩阵 → GitHub Release → npm publish（WebAuthn 2FA）→ 市场条目。
- 回滚验证：关 capability flag → 1.8.1 语义；`npm i` 回 1.8.1 包；rooms/draft_index/归档不删（向后兼容）。
- **闸门 G6**：全矩阵绿；安装边界验证；回滚演练通过；无测试数据残留。

### 4.7 文件级改动清单（估算）

| 文件 | 改动 | 规模 |
|---|---|---|
| `lib/document-sessions.js`（新） | SessionManager、状态机、快照、allowed actions | 600–900 行 |
| `lib/conflict-service.js`（新） | conflict session、hunks、resolve/cancel | 300–450 行 |
| `lib/file-lifecycle.js`（新） | fileState/locate/saveAs/recovery/archive 列表与读取 | 350–500 行 |
| `lib/draft-index.js`（新，或并入 host） | draft_index CRUD/上限/清理 | 150–250 行 |
| `lib/index.js` | 端点、路由、watch missing、guard 文案、fs/observed | +400–600 行 |
| `lib/documents-service.js` | revision sha 归一、`resolve3Text`、`changesFromTextDiff`、`conflictOpen/Resolve/Cancel`、`checkpointAny`、reviewGroups 字段 + `chainOk`、undoGroup kind 过滤 | +300–450 行 |
| `lib/client.js` | 冲突面板、改名/删除横幅、恢复中心、draft mirror、review 链 | +900–1400 行 |
| `MarkPilot-CM6/shell/live-documents.js`（源）→ `scripts/sync-host.mjs` → `host/live-documents.js`（生成物） | `draft_index` 表与 CRUD；`room_resolved` 表 + `appendResolvedConflict`；`readDiskIdentity`；watch/file identity 辅助；`host.json` 同步 | +250–400 行 |
| `test/*.test.mjs`（新/扩） | session/conflict/draft/file-lifecycle/review-chain | +1000–1600 行 |
| `docs/*` | 设计/日志/发布说明 | — |

### 4.8 测试矩阵

| 层 | 必测 |
|---|---|
| 单元 | `merge3Text` 全分支；状态机 11 状态；review 链；draft 上限/stale；saveAs 不覆盖；locate 同 dev/ino；recoveryRead 路径穿越/sha |
| 宿主 API | 每个新端点的成功/权限/过期/零写入；`MODEL_TOOL` 拒绝；`documents.read` 不写 |
| 客户端纯逻辑 | conflict 选择物化；review 链丢弃；missing/renamed 动作；draft mirror 节流 |
| 真机 | 冲突三 choice+manual；删除/改名/只读；恢复中心；review 单/双组；facade 禁用草稿；大文件 |
| 五通道 | 冲突面板/恢复中心：键盘、鼠标、组合键、键鼠配合；拖拽不适用时标 N/A 并说明 |
| 视觉 | 冲突三栏、review 横幅、改名/删除横幅、恢复中心截图；由 DeepSeek 视觉代理复核 |
| 突变 | 每个关键修复“注掉必红”（链校验、conflict stale、draft base 校验、saveAs 覆盖保护） |

### 4.9 回滚

1. 三个 capability flag 关闭 → 1.8.1 路径（端点保留但客户端不调用）。
2. `draft_index`/conflict/session 数据不删，旧版本忽略；rooms/recovery/archive 不变。
3. 回装 1.8.1 tarball（`npm i` 或 GitHub Release）。
4. 回滚验收：打开/保存/review/undo/recovery/冲突横幅五条链路回到旧行为，且不丢草稿。
5. 任何阶段失败：停在该阶段，保留已落地阶段的测试与功能；不“为了收尾”压缩验收。

### 4.10 风险与最坏情况

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 冲突 resolve 的 TOCTOU（用户/磁盘又变） | 中 | 覆盖或丢文本 | 每次 resolve 重跑 authority；任一 revision 变 → `MP_DOC_STALE` 零写入 |
| resolve 后无法保存（`live.save` diskHash 不匹配） | 高 | 冲突解决白做 | `room_resolved` 表 + 原子 `live.appendResolvedConflict`；事务内 `readDisk` 取磁盘字节 hash 并校验 `expectedDiskHash`；resolve 后保存必须真机验证；再次外部变化重新 conflict |
| merge3 hunk 与用户编辑错位 | 中 | 应用错位 | base/result revision + 全文替换前校验；不自动合并 |
| rename 扫描误判（硬链接/克隆） | 中 | 绑错路径 | dev/ino+size+mtimeNs 三项；用户确认；只扫父目录 |
| watch missing 误报（保存飞行） | 中 | 误横幅 | debounce + `stat` 二次确认 + 保存中不判定 |
| draft_index 成为“第五真相” | 中 | AI 读旧稿 | 只读投影；base 不匹配不回正文；保存/丢弃即清；TTL |
| guard lookup 异常 | 中 | 数据安全 vs 可用性 | 有界 fail-closed（连续 3 次拒绝，`MP_DOC_LOOKUP_FAILED`）；单次放行+计数；阈值可配；真实 DB-lock 探针验证 |
| 客户端 UI 回归（rail/iframe 尺寸） | 中 | 布局坏 | 不碰 iframe 字节；覆盖层独立定位；视觉+五通道 |
| 旧 EXE/多实例 | 低 | 房间被删 | 保留 non-local member 防线；不改 live 协议 |
| 大文件（>64MB）归档失败 | 低 | AI 写失败 | fail-closed + 明确错误；2.0 不分块（记 TODO） |

### 4.11 工作量

P0 2–3 + P1 3–5 + P2 4–6 + P3 3–4 + P4 4–6 + P5 5–8 + P6 3–4 = **24–36 人日**（约 5–7 周，含评审/真机/视觉），不含 Track E。

> 规划搭档的 A0–A4 估算为 **21–30 人日**；它没有把 P4（另存为/改名删除/只读/恢复中心，4–6 人日）单独列项，而是并入“文件管理缺口”描述。把 P4 计入后两边一致：**24–36 人日**是含完整文件生命周期的口径。若只做 A0–A4（不做 P4 的完整 UI），可按 21–30 人日排期，但“另存为/改名删除/只读”仍是 2.0 的验收项，不能删。

---

## 5. 计划 B（备选）：引擎原生文档会话

### 5.1 它多买到什么

1. AI 修改作为**一个 CM6 原生 undo group**进入历史；Ctrl+Z 整组撤销，不靠 host 文本 inverse。
2. review 状态由**事务 annotation** 表达；关闭/重开由引擎 session 恢复，不再只靠 localStorage。
3. diff 可用 CM6 装饰渲染在编辑器内，而不是客户端文本面板。
4. 真正把“buffer 权威”落到引擎：`sessionVersion`、`beginIntent/applyIntent/undoGroup` 是内核 API，host 只做持久化/审计。
5. 与 B4.2b-full 的行业范式（VS Code model + pushStackElement / CM6 annotation）一致。

### 5.2 代价与硬约束

- `renderer-cm6/` 任何字节变化 → 重新构建、`sync-core`、`coreHash` 变更、五通道 + 视觉验收；1.7.6 已证明 iframe/预热类改动可直接打坏 Markdown 显示。参考 3.6.17 的引擎批次：**完整 GUI 回归 40 套 / 424 项 + 单元/契约 606 项**，再加五通道与截图；这是 B 必须预留的预算。
- `history-guard.mjs` 已经用 foreignSpans/eventGen 保护“远端写入后旧 undo 事件重插”；原生 review 的 `addToHistory:true` 必须与它兼容，否则会把“撤销 AI 组”变成“撤销对端内容”或反之。这不是加 annotation 能解决的，需要独立设计对抗。
- **bridge API 是新增**：`src-cm6` 当前没有 `reviewBegin/reviewCommit/reviewUndo/reviewDiff`（全仓 grep 零命中），B4.2b-full 不是改造现有函数，工作量按新增算。
- 旧 EXE/旧 renderer 的 capability 降级；双写（renderer undo 与 host undoGroups）只能一个写者，另一个必须幂等跟随。
- review 期间不自动保存、冲突仍走 B4.3、CAS/归档/fail-closed 全部保留。

### 5.3 阶段

| 阶段 | 内容 | 人日 |
|---|---|---|
| B0 | 引擎基线重建（不改行为）证明 build/sync/coreHash/五通道/视觉链可跑 | 3–5 |
| B1 | 原生 review：annotation/undo group/reviewBegin-Commit-Undo-Diff bridge；history-guard 兼容；fallback | 5–8 |
| B2 | 引擎 session：sessionVersion/beginIntent/applyIntent/undoGroup；host 消费与双写校验 | 5–8 |
| B3 | 冲突 UI（引擎 diff 装饰）+ 文件生命周期（可复用 A 的 P2–P4） | 6–10 |
| B4 | 2.0.0 发布/全量验收/回滚 | 4–5 |
| 合计 | | **23–36 人日**（不含 A 的 P0/P3/P4 复用成本；若加上 A 的前置批次约 +9–13 人日，总计 **32–49 人日**） |

### 5.4 何时才值得选 B

- 用户明确要求“Ctrl+Z 一次撤销整组 AI 修改 / 编辑器内装饰 diff / 不再依赖 localStorage 的 review 状态”；
- 接受 coreHash 变更、完整构建与五通道/视觉预算；
- 接受“原生 undo 与 history-guard/IME/表格/多窗口”的联合验收；
- A 已稳定运行至少一个发布周期，或用户愿意承担 B 的延期风险。

### 5.5 风险

1.7.6 型显示事故；undo 语义与 foreignSpans 冲突；旧 renderer/旧 EXE 降级；review 双写；构建链/包身份漂移；回滚只能回 1.8.1 包（不能“关 flag 回旧引擎”，因为引擎字节已变）。

---

## 6. A/B 对比与我的选择

### 6.1 对比表

| 维度 | A · 宿主文档会话 | B · 引擎原生会话 |
|---|---|---|
| 用户价值（文件管理） | 冲突可选择、改名/删除不丢稿、恢复中心、草稿 AI 可见、写不静默覆盖 | 同 A + 原生 Ctrl+Z 整组撤销 AI、编辑器内 diff |
| 数据风险 | 低–中（全部复用现有 CAS/归档/fail-closed） | 中–高（undo 语义 × history-guard × 多窗口） |
| 实现风险 | 中（新端点/新 UI，但不碰 renderer） | 高（coreHash/构建/五通道/显示事故史） |
| 发布风险 | 低（可拆 1.9/2.0，flag 回退） | 高（引擎字节变，回滚只能回包） |
| 验证预算 | 单测/API/真机 + 冲突 UI 五通道/视觉 | 上述全部 + 引擎全量重建/五通道/视觉/回归（参考 40 套/424 项 + 606 单测） |
| 可逆性 | 高（flag 关、回装 1.8.1） | 低（引擎版本绑定） |
| 与 1.8.1 兼容 | 高（协议不变） | 中（旧 renderer 需降级） |
| 旧 EXE/多实例 | 保持现有防线 | 需新增 capability 降级矩阵 |
| 触碰 coreHash | 否 | 是 |
| 触碰 DSH 内核 | 否（不改 app.asar） | 否（但需确认内核事件/服务契约） |
| 适合的 2.0 叙事 | “文件管理彻底完善” | “原生 AI 审阅内核” |

> 注：A 的“不触碰 coreHash”指**文件管理架构批次**；Track E（引用区 Shift+Enter/Ctrl+B）是独立的引擎 bugfix 批次，单独构建/验收，不计入 A 的架构成本，也不改变 A/B 的选择。

### 6.2 我的选择：**A**

理由按权重：

1. **目标匹配**：用户说的是“文件管理彻底完善”。F3/F5/F7/F9/F11/F12/F13 都在宿主/客户端；B 的额外能力是 AI review/undo 的**交互形态**，不是文件管理。
2. **数据安全**：A 的所有写路径复用现有 CAS/归档/fail-closed；B 要改 undo 语义，直接碰“撤销可能删掉对端/他人内容”的历史保护，事故面大。
3. **可逆性**：A 可以 flag 关闭、回装 1.8.1；B 一旦 coreHash 变更，回滚只能回旧包，且旧包与新房间/草稿数据的兼容需要额外验证。
4. **既有研究结论**：HANDOFF §2.7.11 明确建议“宿主 DocumentSession + 单一 intent 入口（方案 A），保留 CM6 作为 view，不把权威放进 renderer”；§8.3 也写“先 A，B 只在 A 被证明不够时启动”。
5. **交付确定性**：A 可以拆成 1.9（P0+B4.3+B3.3b）与 2.0（session+生命周期），每步都能真机验收；B 是一个大爆炸，任何一步失败都阻塞整个 2.0。
6. **“动内核”的成本已被证明**：1.7.6 的预热实验让 Markdown 显示坏掉，项目已有“不要为收尾压缩验收”的红线；A 不需要付这笔成本。

**这不是说 B 永远不做**：B 是 2.1/3.0 的候选。等 A 的 session 稳定、review 链/history-guard 语义有完整测试后，再评估“原生 review”是否值得 coreHash 变更。若用户本轮明确要“原生 Ctrl+Z 整组撤销 AI”，则改选 B，并把 A 的 P0/P3/P4 作为 B 的前置批次（否则 B 也会缺文件管理）。

### 6.3 版本叙事建议

- **1.9.0**：P0 + B4.3 冲突界面 + B3.3b 草稿索引（用户可见的文件管理第一波）。
- **2.0.0**：P1/P4/P5 完成 DocumentSession + 文件生命周期 + fs 会话语义；capability flag 默认开；作为“文件管理彻底完善”的大版本。
- **2.1.0（可选）**：Track E 引用区修复 + 恢复中心/周期快照增强。
- **3.0（可选）**：B 的原生 review/undo，前提是 A 稳定且有明确需求。

---

## 7. 第一周可执行清单（选 A 后）

### Day 1 · 冻结与证据

```powershell
cd D:\BuyKey\markpilot-public
git rev-parse HEAD
git status --short
cd dsh-markdown-editor-typora
npm test
node scripts/sync-host.mjs --check
node scripts/sync-core.mjs --check
```

- 记录：HEAD、tests、coreHash、tarball SHA；写入 `docs/LOG-2.0.0-FILE-MANAGEMENT.md` 的“基线”一节。
- 不执行 `git add .`（未跟踪 tgz/dist 不提交）。

### Day 2–3 · P0 review 链

1. 建分支 `b4.2b-review-chain`（或复用 `b4.2b-review-persist` 只读参考，不要改它）。
2. 改 `lib/documents-service.js`：`reviewGroups` 返回 `baseRevision/resultRevision/actor` + host 计算的 `chainOk/chainReason`。
3. 改 `lib/client.js`：`normalizeReviewRecord` v2 + `restorePersistedReview` 消费 `chainOk`。
4. 不需要新端点；`documents.reviewGroups` 仍是编辑面只读调用（不新增 `KNOWN_ENDPOINTS` 项）。
5. 新增/扩测试：`test/documents-service.test.mjs`、`test/documents-api.test.mjs`、`test/client.test.mjs`。
6. 突变验证：注掉链校验 → 对应测试必红；恢复后同臂绿。
7. 真机：双组关闭→重开→恢复→撤销；截图/日志；清理测试数据。

### Day 4–5 · 设计对抗与 P1 骨架

- 写 `docs/DESIGN-2.0-DOCUMENT-SESSION.md`（session 字段/状态机/API/表结构/权限）。
- 按 AGENTS 六步：**另派一个独立子 Agent 对抗**（找反例、同族形态、破坏哪条不变量），双方收敛后再落码。
- 搭 `lib/document-sessions.js` 骨架 + `documents.session` 端点 + 状态机单测；先只读/影子，不接生产写。

### 第一周验收

- P0 全绿 + 双组真机证据；
- P1 骨架测试绿、0 副作用；
- 设计对抗记录（谁提了什么反例、如何收敛）；
- 未改动 `renderer-cm6/`、`core.json`、`dsh-markpilot/`；`sync-core --check` 仍绿。

---

## 8. 需要拍板的问题（默认建议）

| # | 问题 | 默认建议 |
|---|---|---|
| Q1 | 选 A 还是 B？ | **A**；B 放到 2.1/3.0 |
| Q2 | 2.0 是否允许拆成 1.9（P0+B4.3+B3.3b）+ 2.0（session+生命周期）？ | 允许；更早交付、更小风险 |
| Q3 | P5 是否让 session 接管编辑器 `runSave`？磁盘未打开文件的 AI 写是否先归档？ | **不接管 runSave**（先做 flag 原型）；**disk 写也必须先归档**（补 §8.4 的缺口） |
| Q4 | review 原生 undo（B4.2b-full）是否本轮做？ | 不做；A 的 P0 链校验先收口 |
| Q5 | 另存为是否进 2.0？外部改名/删除/只读的逃生动作？ | **是**：2.0 必备“另存为副本”，覆盖删除/改名/冲突/只读四个逃生场景；普通文档的常规“另存为”如 live 重绑验证通过则一并，否则 2.1；注意 AGENTS 错-18：换路径必须显式复位 `lastVersion`/lease/`draftReceipts` |
| Q6 | untitled 草稿是否进宿主索引？ | **2.0 只做只读可见性**（flag `untitledDraftIndex`）：宿主列出自建 untitled 草稿的元数据/正文快照供恢复中心展示，权威仍在浏览器 draft store；不做宿主权威写入，不参与 AI 路径解析 |
| Q7 | Track E（引用区 Shift+Enter/Ctrl+B）何时做？ | 独立 1.9.x 引擎批次，先于 2.0；不与架构批次混 |
| Q8 | 大文件 >64MB 归档？ | 2.0 fail-closed + 明确错误；分块归档放 2.1 |
| Q9 | write guard 的 lookup 异常口径？ | **有界 fail-closed**：单次放行+计数，连续 3 次拒绝（`MP_DOC_LOOKUP_FAILED`），阈值可配；1.9 观察、2.0 默认开；独立对抗 + 旧宿主兼容 |

---

## 9. 验收与证据规范（本项目强制）

1. **命令门禁**：每次改动至少 `npm test`、`node scripts/sync-host.mjs --check`、`node scripts/sync-core.mjs --check`、`node --check lib/*.js`。**`host/` 是生成物**：只能改 `MarkPilot-CM6/shell/live-documents.js`，然后跑 `node scripts/sync-host.mjs` 再 `--check`；直接改 `host/` 会 `HOST_CHECK_DRIFT`，且 EXE 与插件会分叉。
2. **真机**：不退出 DSH 模拟重启；用关闭编辑区（X）或重开文档；测试前后对目标文件做 SHA-256/字节数断言。
3. **截图**：冲突三栏/review 横幅/改名删除横幅/恢复中心必须有截图；视觉复核由 DeepSeek 视觉代理完成，GLM 不看图。
4. **五通道**：冲突面板/恢复中心至少覆盖键盘、鼠标、组合键、键鼠配合；拖拽不适用要写明 N/A 与原因。
5. **突变**：每个关键修复必须“注掉必红、恢复后同臂绿”，记录两态。
6. **清理**：测试产生的 `agent_group`、`append_recovery`、`recovery`、`draft_index`、localStorage、临时探针文件必须清；清理前列绝对路径，按字面量删。
7. **不破坏**：`renderer-cm6/`、`core.json`、`dsh-markpilot/` 在 A 的任何阶段都不改；Track E 才改，并单独验收。
8. **宿主热载**：改 `lib/`/`host/` 后不必重启整个 DSH；`plugin_manager` 对 `include:dsh-markdown-editor-typora` 执行 disable → enable（返回 `application:"applied"`）即可强制宿主重载（`LOG-1.7.0` 已实证），客户端重新打开 Markdown 标签页加载新 `client.js`。真机键鼠测试按此流程，不退出 DSH。

---

## 10. 附：对 HANDOFF-1.8.1 的纠偏/待复核清单

| 项 | 原文位置 | 结论 | 证据 |
|---|---|---|---|
| C1 fs patch/move 缺口 | §8.2 #3 | **已过时**：当前桌面内核 intent 覆盖 add/update/delete/move | 本机 `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js` 734–880；`dsh-fs-local/lib/index.js` 917–1017；DSH 桌面运行时 0.2.2-rc.1 |
| C2 documents HTTP 边界 | §8.2 #4 | **字面不准**：部分编辑面端点可经插件 HTTP 路由调用；模型专用端点仍拒绝 | `lib/index.js` 1562–1624；`KNOWN_ENDPOINTS` 323 |
| C3 review 链缺口 | §4.2 | **仍存在** | `documents-service.js` 857–871；`client.js` 5892–5927 |
| C4 原生 review 与 history-guard | §7 未提 | **新增风险**：B 必须与 `history-guard.mjs` 的 foreignSpans/eventGen 联合设计 | `history-guard.mjs` 1–80 |
| C5 引用区缺陷 | §2.8 | **仍存在**；需 Track E 独立引擎批次 | `src-cm6/main.js` Shift-Enter 路径；`toolbar.js` wrap |
| C6 `documents.state` 权限 | §2.3/§5 | 模型专用，编辑面冲突 UI 不能直接复用；需新 `documents.session`/`conflictOpen` | `lib/index.js` 1587–1590 |
| C7 性能预热 | §9 | 不重试 1.7.6 方案；A 不涉及启动性能 | HANDOFF §9；`perf-prewarm-skeleton` 隔离 |
| C8 “所有写端点必须有归档” | §8.4 | **未完全成立**：`applyEdits` 在 `source==='disk'`（未打开文件）时直接 `edit`/`save`，没有 checkpoint；只有 buffer 写归档 | `documents-service.js` 435–447、606–609、653–687 |
| C9 “tickWatch 缺 missing 分支” | 本计划初稿 | **纠正**：`tickWatch` 有 missing 分支（`index.js:839-861`）；缺口是 `broadcastChange` 不传 missing、客户端 `onExternalEvent` 把 missing 当通用外部变更、`runSave` 把 missing 归入 `FS_STALE_VERSION`/conflict 横幅 | `index.js:823-861`；`client.js:6179-6184、6402-6436` |
| C10 数据位置表遗漏 | §1.6 | 缺 `recents.json`/`workspace-recents.json`、untitled IndexedDB 草稿、`draftReceipts` 内存回执 | `index.js:1399-1408/1448/1165`；`client.js:5969-5992` |
| C11 错误码表遗漏 | §13.2 | 缺 20+ 个实际码（`MP_FILE_MISSING`/`MP_LIVE_NO_ROOM`/`MP_RECOVERY_*`/`MP_DRAFT_*`/`MP_SAVE_BUSY` 等），接管人会对不上真机 | `host/live-documents.js`、`lib/documents-service.js`、`lib/index.js` 实际抛出点 |
| C12 bridge API 是新增 | §7.2 | `src-cm6` 当前**没有** `reviewBegin/reviewCommit/reviewUndo/reviewDiff`（全仓零命中）；B4.2b-full 是新增能力，按新增估算 | `dsh-markpilot/src-cm6/main.js:6824-6834`；`live-document.js:15-16` |
| C13 模型工具可达性 | ROADMAP §2 | `documents.recover` dispatch 无 MODEL_TOOL 守卫，但 `markdown` 工具参数表不含 recover ⇒ 模型实际不可达；2.0 保持“工具面白名单”防线 | `index.js:1591-1592、2133-2214` |

### 10.1 错误码补齐（HANDOFF §13.2 未列，2.0 落地前补进文档）

`MP_DOC_EDIT_INVALID`、`MP_BLOCK_NOT_FOUND`、`FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`、`MP_LIVE_NO_ROOM`、`MP_LIVE_NO_MEMBER`、`MP_LIVE_APPEND`、`MP_FILE_MISSING`、`MP_RECOVERY_NOT_FOUND`、`MP_RECOVERY_INVALID`、`MP_RECOVERY_CORRUPT`、`MP_RECOVERY_TOO_LARGE`、`MP_RECOVERY_FAILED`、`MP_DRAFT_REUSED`、`MP_DRAFT_LIMIT`、`MP_SAVE_BUSY`、`MP_MERGE_LIMIT`、`FS_SANDBOX_DENIED`、`MP_LIVE_LEASE`、`MP_LIVE_BUSY`、`MP_HOST_CLOSED`、`FS_NOT_REGULAR_FILE`。2.0 新增：`MP_CONFLICT_NO_BASE`、`MP_DOC_LOOKUP_FAILED`、`MP_DOC_MIRROR_READONLY`（如采用）。

### 10.2 规划搭档补充（E5–E9，已核对）

- **E5 数据位置**：最近文档 `%APPDATA%\MarkPilot\recents.json` + `workspace-recents.json`；untitled 首次保存草稿在浏览器 IndexedDB/workspace draft；`draftReceipts` 是内存回执（2048 上限），重启后靠固定 UUID 名 + 字节复核保证幂等。
- **E6 错误码**：见 §10.1。
- **E7 bridge API**：B4.2b-full 是**新增**能力，不是改造现有函数；工作量按新增算。
- **E8 conflict base**：必须复用 `room.savedTextAvailable`（`saved >= floor`）判定；`saved < floor` 时不能拿 `savedText` 当共同祖先，否则 base 是错误的历史 checkpoint。
- **E9 模型工具白名单**：模型可达性有两层——dispatch 的 `MODEL_TOOL` 守卫 + `markdown` 工具 action 白名单；2.0 新增端点不得进入工具参数表。

---

*本文为计划稿。落码前必须先完成：① 主控对 A/B 的选择（已选 A）；② 独立子 Agent 的设计对抗（partner.md 已完成 A0–A4 审阅）；③ P0 的基线冻结与真机证据。*

> **P4（2026-11-11）**：host missing latch（`cdaba73`）+ 客户端 missing 横幅（`60aee5b`）已落；headless Web 真机：新建/保存→外部删除→横幅「文件已不存在」+重试/复制→写回→横幅消失、旧路径未重建；全量 517/516/1。脏稿复制/重试、saveAs、locate、readonly 已真机；恢复中心未接。

> **P4 真机（2026-11-11）**：干净文件删除→横幅→写回恢复；脏稿删除→「当前编辑内容保留、未写盘」→Ctrl+S 零重建→写回进入冲突；两条均用隔离 headless Edge。复制按钮剪贴板、saveAs/locate/恢复中心未测。

> **P4 saveAs（2026-11-11）**：`4308ba4` host `docs/saveAs` 走 `ctx.fs.writeText(kind:'createIfAbsent')`，契约 `{path源,targetPath目标,text}`；严格绝对路径/.md/拒绝 ADS/保留名/`\\?\`/尾点空格/`..`；editor-only；测试覆盖创建/不覆盖/不安全名/provider 调用/模型拒绝。客户端动作、recents、live 重绑未接。

> **P4 saveAs 真机（2026-11-11）**：missing 横幅「另存为…」模态输入允许 workspace 路径，成功创建副本，正文正确，原路径未重建；跨 workspace 同目录默认路径会被 `FS_SANDBOX_DENIED`，模态要求用户选允许路径。
