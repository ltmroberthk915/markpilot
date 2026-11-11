# LOG-1.8.1 · B4.3 Web 端实机测试记录

> 环境：DSH Web（独立测试 profile `mp-web-test`），浏览器 Agent Window；**未启动、未操作 DSH Desktop**
> 目的：在不碰生产 `desktop` profile 的前提下验证 MarkPilot B4.3 冲突界面与 live 行为
> 结论：Web 端已确认 MarkPilot 可加载、冲突面板/「用我的」/Ctrl+S 写盘、AI append 进引擎、review「保留并保存」写盘；修复 no-op resolve dirty、review phase、live 保存误用镜像三个客户端 bug；前一轮“review keep 未落盘”已确认是测试点击未命中，不是产品 blocking

## 1. 测试 profile

```text
C:\Users\Ming\.dsh\profiles\mp-web-test
  dependencies:
    dsh-markdown-editor-typora: link:D:/BuyKey/markpilot-public/dsh-markdown-editor-typora
  dsh.profile.bundles:
    @deepseek-ai/dsh-base
    @deepseek-ai/dsh-web-app
    dsh-markdown-editor-typora
```

启动（端口 0，token 已省略）：

```powershell
dsh --profile mp-web-test --port 0 --no-open
# dsh web: http://127.0.0.1:<ephemeral-port>/?token=<redacted>
```

Web boot 有 1 条与 MarkPilot 无关的 `schedule` storage 版本告警；MarkPilot 本身加载成功。

## 2. 已确认（Web 端）

1. MarkPilot client 在**干净 Web profile** 中正常 import：侧栏出现 Markdown，工作台、文件列表、iframe 编辑器均可用。此前 `import failed` 是 Desktop profile 配置损坏/重载导致，不是当前 client 代码必然坏。
2. 新建文件（`conflict-ui-web2.md`）→ 缓冲区正文 `base` → 外部写入磁盘 `theirs`：
   - 顶部出现冲突横幅；
   - 「查看冲突」打开冲突面板；
   - 面板显示 base / 我的 `base` / 磁盘 `theirs`，默认选中「用我的」；
   - 点击「应用选择」后面板关闭。
3. host 端 `room_resolved` 在“用我的”零正文解决后写入，`rooms.disk` 推进到当前外部 hash，磁盘文件本身未被 resolve 改写。
4. 关闭后 UI 不再显示冲突横幅，说明 `markResolved` 的 no-op 分支可达。

## 3. 本轮发现并已修：no-op resolve 后客户端误判为 clean

现象：

- 全部选「用我的」时，host 返回 `changed:false, resolved:true`；
- 客户端 `applyConflict` 的 `changed:false` 分支只更新了 `lastVersion/resolvedDisk/conflict`，**没有把 `doc.dirty` 置 true**；
- 结果：面板关闭后状态显示「就绪」，按 Ctrl+S 被 clean gate 当成无改动，host 的 `rooms.saved` 仍停在旧版本，磁盘仍是外部内容；
- 用户看到“已保留我的版本”，但实际没有保存。

修法（`dsh-markdown-editor-typora/lib/client.js`）：

```js
if (value.resolved === true) {
  doc.lastVersion = ...;
  doc.resolvedDisk = ...;
  // 保留我的版本不改正文，但缓冲区仍与磁盘不同，必须标脏
  doc.dirty = true;
}
```

验证：

- `npm test`：496 / 495 pass / 1 skip / 0 fail；新增 `test/client-conflict-ui.test.mjs` 覆盖 no-op resolve 必须标脏、review 存在时必须保持 review phase、live 保存必须取引擎正文、reviewKeep 必须发出带引擎正文的 live save、manual 选择必须带 text 并进入 review；`documents-api` 增加 theirs/both 两种 resolve 选择不写盘测试、mirror read/apply 与编辑面端点测试；`live-transport` 增加 sealed keep-mine 必须清 `room_resolved` 的负控；`live-draft-index` 新增 12 条镜像数据层测试；`client-draft-mirror` 新增 8 条客户端上报/清理/生命周期/conflict/ live 清理测试。
- Web 端（`b43-keepmine.md`，room 仅 1 个 Web client）复测：
  - apply 后 UI 显示「未保存」，`room_resolved.disk = H(other)`，`rooms.version=1 saved=0`，磁盘仍是 `other`；
  - 编辑器内 Ctrl+S 发出 `MP_LIVE_STALE`，最终 UI 显示「保存暂停：对端持续编辑中」；
  - 用同一 engine live 票直接调 host `/api/save` **成功**：磁盘写入 `mine`，`rooms.saved=1`，`room_resolved` 清空。
- 根因（独立诊断确认）：`pullText` 在 live 保存时取父窗口 `doc.mirror`；但 `mpEngine.setValue`/整篇替换走引擎 `_o` 旁路，**不会发 `document-delta`**，镜像停在旧 seed，而 room 正文已是 `mine`。`live.save` 校验 `materialize(room)===text` 永远失败，被有界退避放大成“对端持续编辑中”。
- 修法（客户端，host 不改）：
  1. `pullText` 在 `doc.live` 时一律 `requestSnapshot('save')` 向引擎要当前正文；镜像只作 recovery，不再当 live 保存权威。
  2. `runSave` 的 `manualThisRun` 分支重置 `liveStaleRounds/liveStaleBlocked`，覆盖“manual 排在前一次 in-flight save 后”的恢复路径。
  3. 回归测试：live 保存请求必须带引擎正文 `mine`，而不是 seed；`live.version=1`；保存成功后 `dirty=false`。
- **修复后 Web 复测（`b43-keepmine2.md`，单 client room）通过**：
  - apply「用我的」后 UI「未保存」，`room_resolved.disk=H(other)`，磁盘 `other`；
  - 编辑器内触发 `mpHost.__save()`（Ctrl+S 同一入口）后：磁盘写入 `mine`，`rooms.saved=1`，`room_resolved` 清空，UI 回到「就绪」；
  - 说明 `pullText` 改用引擎快照后，live 保存不再永久 `MP_LIVE_STALE`。

审查后补充：若 no-op resolve 时 `doc.review` 仍存在，不能只进 `dirty` phase——`manualSaveGate` 会因 review 拒绝保存，而 review 按钮只在 `phase=review` 渲染，形成“无法保存也没有审阅按钮”的死路。已改为：保留 review、`persistReviewState()` 用新 `lastVersion` 持久化，并 `showPhase('review', …)`；回归测试覆盖。

## 4. 本轮发现：多成员房间会让 authority 回到 disk

在 `conflict-ui-web.md` 上测试时，Web 端与一个残留的 Desktop host client 同处一个 room：

```text
rooms: version 4, saved 3, disk hash = theirs
clients: 两个 pid（web + desktop）
```

此时 `documents.conflictOpen` 返回：

```json
{"ok":true,"value":{"conflict":false,"revisionId":"rev1:disk:...","source":"disk"}}
```

原因在 `documents-service.authority`：

```js
if (room.members > 0 && room.members > localMembers) {
  source = 'disk'; bufferOwnedElsewhere = true;
  ...
}
```

这不是 B4.3 面板的 bug，而是**多实例共享 room 的既有安全语义**：非本地成员在房间里时，本 host 不把 room 当权威。后果：

- Web 测试必须使用**干净 room**（只含本次 Web client）或先清理残留 client；
- 看到冲突横幅但「查看冲突」返回 `conflict:false` 时，先查 `clients` 表/pid，不要先怀疑面板；
- 生产多开场景下，B4.3 冲突解决应只在一个 host 实例上操作。

## 4.1 AI append / review 复测

在 `b43-keepmine2.md`（已 clean 保存、单 Web client、engine version=1）上，用独立 `LiveDocuments.append` 模拟一次 agent append：

- 初始：room version=1/saved=1，文件 `mine`；
- 外部 append：`{from:0,to:4,insert:'ai'}`，agent group，room version→2；
- Web 端：
  - engine `liveDocument.status()` → `version:2,savedVersion:1,pending:0,error:null`；
  - `mpEngine.getValue()` → `ai`；
  - 出现「AI 修改待确认：AI 修改了 1 处，保存前请确认」和「撤销本次/保留并保存/查看差异」按钮。

结论：**AI append 能进引擎，未再出现 `Position 22 is out of range`**；首次保存后的 live join + clean reload 方向有效。

随后点击「保留并保存」的第一次 Web 操作可能未命中按钮，曾出现“review 消失、UI ready、磁盘未变”的假象。改用按按钮文本定位并先启动抓包后复测：

- `POST /dsh-markdown-editor-typora/api/save` 确实发出，HTTP 200；
- 磁盘写入 `ai2`；
- `rooms.version=3,saved=3`；
- `rooms.disk=SHA256(ai2)`；
- UI 就绪。

结论：reviewKeep 保存路径在 Web 端通过；前次失败是测试点击未命中，不是产品 blocking。为防御 dirty 位被误清，`reviewKeep` 仍保留 `doc.dirty=true` 并新增 fixture 回归测试（`doc.dirty` 初始 false 时也必须发 save）。

## 4.2 「用磁盘 / 两边保留」UI 复测

文件 `b4choices.md`，单 Web client：

- 冲突 1（base=`# b4choices`，我的 `ours`，磁盘 `theirs`）：
  - 选择「用磁盘」→ 应用；
  - buffer 变为 `theirs`，进入 review；review「保留并保存」后磁盘 `theirs`，`rooms.saved=2`。
- 冲突 2（base=`theirs`，我的 `ours2`，磁盘 `disk2`）：
  - 选择「两边保留」→ 应用；
  - buffer 合并为 `ours2\ndisk2`，进入 review；「保留并保存」后磁盘写入合并结果，`rooms.saved=4`，`room_resolved` 无残留。

结论：「用磁盘」「两边保留」两条 UI 路径已通过；「手动编辑」的 host resolve 已在 `B4.3-API1` 覆盖，UI textarea 仍缺一条端到端复测。

发布前审查修复：
- N1（P1，桌面 sealed keep-mine 路径）：`live-documents.external` 的 sealed 分支推进 `rooms.disk/saved` 后未清 `room_resolved`，会让后续 `live.save` 永久 `MP_FILE_CONFLICT`。已在该事务内 `DELETE FROM room_resolved WHERE epoch=?`，并加 `live-transport` 负控（T04b）；`sync-host` 已同步。
- N4（P3，防御）：`applyConflict` changed 分支强制 `doc.dirty=true`，避免旧 host 不回 groupId 时出现“phase=dirty 但 Ctrl+S 被 clean gate 忽略”。

## 5. G3 草稿镜像真机（部分通过）

使用**隔离 headless Edge + CDP**（不是用户窗口，也不是 Desktop）：

- 打开 `mp-web-test` 的 `b43-keepmine2.md`；
- `__mpTestUnsupported()` 强制单窗口模式，`__mpDocDebug()` 确认 `liveUnsupported=true`、`baseSha256` 有值；
- 聚焦 `.cm-content`，用 CDP `Input.insertText('G3REAL')` 真实输入：
  - 父窗口 `dirty=true`；
  - `draftMirror` 出现，`textSha256=722da6…`；
  - `rooms.sqlite.draft_index` 出现一行：`source=b43-keepmine2.md`、`bytes=38`、`doc_token=dshdoc-mwb1lxkg…`。
- 随后 host `documents.read`：
  - `source=disk`、`writable=false`、`draftStale=true`（磁盘在 1.5s autosave 后已前进，镜像 base 落后）；
  - `applyEdits` 返回 `MP_DOC_MIRROR_READONLY`，磁盘未被 AI 覆盖。

补测 fresh 窗口（隔离 headless Edge，重新开始）：
- 输入后 250ms 查库：`draft_index` 行 base_sha256 与磁盘 sha 完全一致（`baseFresh:true`），`dirty=true`、`draftMirror` 已设；
- 删除测试房间模拟真正 no-room unsupported 后，host `documents.read` 返回：
  - `source='mirror'`
  - 正文包含刚输入的 `FRESH`
  - `writable=false`、`draft=true`、`draftStale=false`
  - `version='rev1:mirror:...'`
- `documents.applyEdits` 仍返回 `MP_DOC_MIRROR_READONLY`。
- 该 host 是独立进程，证明 mirror 行跨进程/重启可见。

结论：**G3 的核心数据路径已真机通过**（AI 读 mirror 正文、写被拒、跨进程可见）；但仍是用 `__mpTestUnsupported`+删除测试房间模拟无 room，不是完整真实 facade 失败后的自动 leave，正式发布前需补一次真实 `MP_LIVE_FACADE_MISSING` 流程。

真实 facade 失败已通过 bridge 控制路径触发：
- 删除 `mpEngine.liveDocument` 后向 iframe 下发合法 `live-bind`；
- bridge 返回 `MP_LIVE_FACADE_MISSING`；
- 客户端 `liveUnsupported=true`、`live=false`。

但该路径同时把 `doc.conflict` 置为 `true`（`facadetest.md` 房间/磁盘状态与 fake bind 不一致），`draftMirrorEligible` 因 conflict 未生成 mirror；真实输入后 `dirty=true` 但 `draft_index` 无行。说明“facade 失败恰好伴随 conflict”时，mirror 不会上报；这是 G3 的剩余分支，需决定冲突态是否允许 mirror（当前 fail-closed，不写盘但 AI 也看不到正文）。

修复后复测：
- `draftMirrorEligible` 不再排除 `conflict`；
- 同样 bridge `MP_LIVE_FACADE_MISSING` + conflict + 真实输入：
  - `dirty=true`
  - `draftMirror` 出现
  - `draft_index` 写入 `facadetest.md` 行（bytes=34）
- 新增 `client-draft-mirror` 冲突态测试，全量 495/494。

最终 host 验证（清理所有遗留测试 host 进程后）：
- `documents.read` 返回 `source='mirror'`、正文含刚输入 `BRIDGEREAL...`、`writable=false`、`draft=true`、`draftStale=false`；
- `applyEdits` 返回 `MP_DOC_MIRROR_READONLY`；
- 独立进程读取成功，跨进程可见。

结论：**G3 核心路径已通过**；真实 facade 失败由 bridge 控制路径触发，冲突态 mirror 已修复。

## 6. 尚未验证（下一轮 Web）

复测必须用**全新文件**（例如 `b43-keepmine.md`），并在打开后确认目标 epoch 的 `clients` 只有本次 Web 一个，避免多成员 room 走 `source:disk`：

1. 文件 seed → 编辑器打字 `mine` → 自动保存前外部写 `other`，出现冲突横幅；
2. 记录基线：`rooms.version>saved`、`rooms.disk=H0`、`room_resolved` 无；
3. 「查看冲突」→ 默认「用我的」→「应用选择」：phase=`dirty`/「未保存」、面板关闭；DB `version/saved` 不变、`room_resolved.disk=H(other)`、磁盘仍是 `other`；
4. 编辑器内 Ctrl+S：save 请求发出；之后 `rooms.saved=version`、`rooms.disk=SHA256(文件)`、`room_resolved` 清空；文件严格等于 `mine`（UTF-8 无 BOM、无尾换行）；UI 已保存。

- [x] 新代码下「用我的」→ Ctrl+S：写盘覆盖 `theirs`，`rooms.saved` 推进，`room_resolved` 清空（Web `b43-keepmine2.md` 已通过）。
- [x] 新代码下「用磁盘」/「两边保留」Web UI 路径已通过（见 4.2）。
- [x] 「手动编辑」host resolve（`B4.3-API1`）与客户端 manual 选择带 text 的 fixture 测试已通过。
- [ ] 「手动编辑」textarea 的真实 Web 面板点击（非产品 bug；上一轮打开面板点击未命中）。
- [ ] 真实键盘 Ctrl+S（OS 级按键）：目前成功证据是 `mpHost.__save()`，与 Ctrl+S 同一入口但不等价于键盘焦点路由；bsk 对 iframe 内 CM6 的按键焦点尚未稳定建立，发布前需补一次真实按键。
- [x] 新建文件首次保存后 live join + AI append：append 已进引擎（value=`ai`, version=2），未再出现 `Position out of range`。
- [x] AI review「保留并保存」：按按钮文本定位 + 先开抓包后复测，`/api/save` 发出，磁盘写 `ai2`，`rooms.saved=3`，`room_resolved` 无；前次失败为点击未命中。
- [ ] 多客户端：第二窗口 join 票带 `resolvedDisk`，R1 不弹假冲突。
- [ ] 撤销冲突组后 `room_resolved` 空哨兵阻断自动保存（host 已有 API 测试）。

## 6. 测试文件与清理

本轮 Web 测试创建：

```text
D:\BuyKey\Typora-Editor-App\conflict-ui-web.md
D:\BuyKey\Typora-Editor-App\conflict-ui-web2.md
```

均为临时文件，未删除；清理需按项目清理规则单独确认。`mp-web-test` profile 保留，作为后续 **唯一** 实机测试入口。

## 7. 硬规则

1. **任何实机测试只用 DSH Web 端 + 独立测试 profile**；不启动、不操作 DSH Desktop。
2. Web 测试前确认目标 room 只有本次 Web client；有残留 pid 时先清理/换新文件。
3. 冲突面板动作后要看 host 的 `rooms`/`room_resolved` 与磁盘字节，不能只看 UI 文案。
4. 不在生产 `desktop` profile 上做 DevTools reload、批量插件开关或冲突实验。

## 8. P4 missing 文件真机（隔离 headless Edge）

- 新建并真实 Ctrl+S 保存 `D:\BuyKey\deepseek harness 探索任务\p4-missing-real.md`；
- 外部删除该文件，2.5s 后 Web 出现：
  - `⚠ 磁盘上的文件已不存在（可能被删除或改名）`
  - 按钮「重试」「复制我的内容」
  - 旧路径未被重建；
- 原内容写回同一路径后，横幅自动消失，状态回到「就绪」；
- 测试文件已删除，未碰用户文档；headless Edge 与测试服务器已停止。

这验证了 P4 host missing latch + 客户端横幅的干净文件路径；脏稿/复制内容分支仍需补测。

## 9. P4 脏稿删除真机

- 新建并保存 `p4-dirty-real.md`，真实输入 `DIRTY` 后 150ms 外部删除；
- 2.8s 后 Web 显示：
  - 状态「未保存 · 按 Ctrl+S 保存」
  - `⚠ 磁盘上的文件已不存在；当前编辑内容保留、未写盘`
  - 按钮「重试」「复制我的内容」
- 真实 Ctrl+S：磁盘未重建（文件保持不存在），未静默写回旧路径；
- 原内容写回：missing 横幅消失，进入“文件已在磁盘上更新”的冲突态，脏稿保留；
- 测试文件已删除，未碰用户文档；headless Edge/测试服务器已停止。

## 10. P4 saveAs 初测（未通过）

- host `docs/saveAs` 已落地（provider createIfAbsent，editor-only）。
- 客户端“另存为副本”初版尝试在 missing 横幅点击；真实 Web 返回：
  - HTTP 200 `{ok:false,error:{code:"FS_SANDBOX_DENIED"}}`
  - 目标在 `D:\BuyKey\deepseek harness 探索任务\...-恢复-....md`
  - 当前 Web session 的 workspace-write 不允许写该目录
- 未生成副本，未绕过沙箱；该客户端动作为未提交草稿，需改“目标路径选择/允许目录”后再测。

## 11. P4 另存为模态真机（通过）

- 新建并保存 `p4-modal-real.md`，外部删除后 missing 横幅出现；
- 点击「另存为…」打开路径输入模态，改目标为 `D:\BuyKey\Typora-Editor-App\p4-modal-copy.md`；
- 点击保存：副本创建成功，正文 `# p4-modal-real`，原路径未重建；
- 目标在允许 workspace 内，未绕过沙箱；测试文件已清理。

## 12. Desktop rc.6 实装（2026-11-11）

- 安装前备份 `cordis.patch.yml`/`package.json`/`pnpm-lock.yaml` 到 `D:\BuyKey\desktop-profile-backup-20261111-1207`，SHA256 校验一致；`backup-core.ps1` 已跑。
- 桌面 profile 原为 `link:D:\BuyKey\markpilot-public\dsh-markdown-editor-typora`，node_modules 是 junction；插件管理器 install 后 junction 残留，pnpm 仍判 linked。
- 将旧 junction 改名为 `dsh-markdown-editor-typora.link-bak-20261111`（未删除），再用应用内插件管理器从绝对路径 tarball 安装。
- 结果：
  - `package.json` spec=`file:...rc.6.tgz`
  - node_modules 为实体目录，version `1.9.0-rc.6`
  - `cordis.patch.yml` 的 TEMP `disabled: true` 已移除
  - `plugin_manager list_bundles` source=`file:...rc.6.tgz`，enabled=true
  - Markdown 模型工具在 Desktop 会话中可调用并读到 mirror 正文
- 未重启 Desktop；插件管理器已热应用。建议用户正常重启做最终 UI 验收。

## 13. P4 改名检测（host + 提示）

- `documents.fileState` / `documents.locate` 已落（`c007884`）：open/save/edit 后刷新 dev/ino/size/mtime identity；missing 时父目录扫描同 inode + size + mtime，只返回 `.md`，拒绝 `.mp-tmp-`；`ino=0` 不扫描。
- missing 横幅会异步调用 locate，候选显示「检测到可能已改名为：…；可重试或另存为副本」（`0cf670b`）。
- 测试：save→rename 真替换语义、open→rename、MODEL_TOOL 拒绝；全量 513/512/1。
- 未完成：真实 Web 改名横幅测试（headless 脚本挂起，无结论）；候选只提示，不自动重绑。

## 14. P4 只读/占用逃生（客户端，单测）

- save 返回 `EACCES/EPERM/EBUSY/EROFS` 时进入 `readonly` 横幅：
  - 「文件只读或被占用；当前编辑内容保留、未写盘」
  - 重试保存 / 另存为… / 复制我的内容
- `scheduleSave`/`runSave` 在 readonly 期间停写；另存为成功保留 readonly 提示。
- 新增 client 测试：EACCES → readonly、modal 可提交 saveAs、autosave 停止。
- 未做真实 Web 只读文件真机（仅单测）；全量 514/513/1。

## 15. P4 改名横幅真机（通过）

- 新建/保存 `p4-rename-real.md`，外部改名为 `p4-rename-real-renamed.md`；
- 3.5s 后 Web 显示：
  - `⚠ 检测到可能已改名为：p4-rename-real-renamed.md；可重试或另存为副本`
  - 按钮「重试」「另存为…」「复制我的内容」
- 文件改回原名后测试结束；旧路径未被静默重建，测试文件已清理。
- 之前记录“headless 挂起”是脚本输出缓冲导致，实际通过。

## 16. Desktop rc.7 更新（2026-11-11）

- 更新前备份 `package.json`/`pnpm-lock.yaml`/`cordis.patch.yml` 到 `D:\BuyKey\desktop-profile-backup-20261111-1300`，SHA 校验一致。
- 应用内插件管理器从绝对路径 `...rc.7.tgz` 更新：
  - Desktop 依赖 `file:...rc.7.tgz`
  - node_modules 仍为实体目录
  - version `1.9.0-rc.7`
  - `plugin_manager` source `file:...rc.7.tgz`，enabled=true
  - Markdown 模型工具可调用并读到磁盘正文
- TEMP disable 已不存在；未重启 Desktop，客户端 UI 需正常重启验收。

## 17. P4 只读/占用真机（通过）

- 新建/保存 `p4-readonly-real.md`，外部设置只读；
- 真实输入 `RO` 后 Ctrl+S：
  - 文件内容仍为 `# p4-readonly-real`（未写盘）
  - Web 显示 `⚠ 文件只读或被占用；当前编辑内容保留、未写盘，可另存为副本`
  - 按钮「重试保存」「另存为…」「复制我的内容」
- 测试文件已恢复权限并删除；headless Edge/测试服务器已停止。

## 18. P4 恢复中心（host + 客户端）

- 新增 editor-only：
  - `documents.recoveryList`（metadata only）
  - `documents.recoveryRead`（4 MiB 上限，超出 `MP_RECOVERY_TOO_LARGE`）
  - `documents.recoveryDiscard`
- 客户端 missing/readonly 横幅新增「历史副本」：
  - 覆盖层列出时间/version/bytes
  - 查看预览（20k 截断提示）、复制路径
  - 空列表、加载中、错误分离；Escape 关闭；窄侧栏按钮有 data-icon/title
- 测试：host list/read/discard/MODEL_TOOL、客户端列表/预览；全量 517/516/1。
- 未接 discard 确认/恢复写入；恢复中心尚未打包。

## 19. Desktop rc.8 更新（2026-11-11）

- 更新前备份 `package.json`/`pnpm-lock.yaml`/`cordis.patch.yml` 到 `D:\BuyKey\desktop-profile-backup-20261111-1320`。
- 应用内插件管理器从 `...rc.8.tgz` 更新：
  - Desktop 依赖 `file:...rc.8.tgz`
  - node_modules 实体目录
  - version `1.9.0-rc.8`
  - TEMP disable 不存在
  - Markdown 模型工具可调用并读到磁盘正文
- 未重启 Desktop；客户端 UI 需正常重启验收。

## 20. P1 DocumentSession 影子第一切片（未打包）

- 新增 `lib/document-sessions.js`：只读 SessionManager（TTL 30m、cap 256）、allowedActions。
- 新增 `documents.session`（editor-only）：
  - 复用 `documents.state`
  - 返回快照 + allowedActions
  - 错误不缓存；FS_NOT_FOUND 归一为 `state:'missing'`
  - cache key = canonical + provider version/missing
- 打包 `files` 收为 `lib`，修复 `document-sessions.js` 漏打包。
- 测试：TTL/cap、allowedActions、missing→创建刷新、MODEL_TOOL、包文件清单。
- 全量 522/521/1。
- 尚未接客户端/P5；30 场景对比未做。

## 21. P1 影子缓存修正

- session cache key 加 provider version/missing，保存后/改名后不再 30 分钟 stale。
- 错误不缓存；`documents.state` 把 FS_NOT_FOUND 归一为 `state:'missing'`。
- 打包 `files` 已收为 `lib`，`document-sessions.js` 确认进包。
- 新增测试：save 后 session 版本刷新、rename 后 missing、调用不建 rooms.sqlite/不改正文。
- 全量 523/522/1；30 场景 G1 对比未做。

## 22. Desktop rc.9 更新（2026-11-11）

- 更新前备份 `package.json`/`pnpm-lock.yaml`/`cordis.patch.yml` 到 `D:\BuyKey\desktop-profile-backup-20261111-1340`。
- Desktop 更新到 `file:...rc.9.tgz`，version `1.9.0-rc.9`，node_modules 实体目录，`lib/document-sessions.js` 已存在；Markdown 工具可调用。未重启 Desktop。

## 23. P1 G1 30 场景影子对比（第一版）

- `p1-shadow.test.mjs`：10 个文件 × 磁盘 / 保存后 / 改名后 = 30 场景；
- 对比 `documents.session` 与 `documents.state` 的 state/source/dirty/conflict/version/revisionId/orphanDraft/external/unsavedElsewhere，0 差异；
- 覆盖保存后 cache 刷新、改名后 missing；尚未覆盖 dirty/conflict/orphan/mirror/review/recovery 组合，故不能宣称 G1 全绿。
- 全量 525/524/1。

## 24. 1.9.0 正式打包与 Desktop 实装（2026-11-11）

- 最终包 `dsh-markdown-editor-typora-1.9.0.tgz`，150 files，SHA256 `848C845D988A37A8D31FD6404EDD36358C4E370CCDD6CF6273F3805182058C60`。
- 隔离 profile `mp-pkg-test` 安装成功。
- Desktop 从 rc.9 更新到 `file:...1.9.0.tgz`：
  - node_modules 实体目录
  - version 1.9.0
  - Markdown 模型工具可调用
  - 未重启 Desktop；UI 最终验收待做
- 更新前备份：`D:\BuyKey\desktop-profile-backup-20261111-1400`。
- 全量 525/524/1。

## 25. Desktop 1.9.0 重启验收（2026-11-11）

- 用户重启 Desktop 后，实际激活 DeepSeek Harness 窗口并点击左侧 **Markdown**；
- Markdown 工作台成功打开，左侧文件树/文档/编辑区正常渲染，无插件加载错误；
- 未在 UI 中重复执行删除/改名/只读真机（已在隔离 Web 通过）；这些行为的 Desktop 端到端仍建议后续做一次。

## 26. Desktop P4 逐项验收（用户重启后，键鼠实测）

- 环境：Desktop 1.9.0，窗口 hwnd 7474914，`Markpilot 1.8.1 接管与内核升级计划` 工作区；测试文档 `b43-keepmine2.md`（测试文件，验收后已恢复原文）。
- **删除**：外部删除文件后，Markdown 顶部出现 `⚠ 磁盘上的文件已不存在（可能被删除或改名）`，按钮「重试」「另存为…」「历史副本」「复制我的内容」；文件内容仍在编辑器。
- **恢复**：原文件写回后横幅自动消失，状态回到「就绪」。
- **只读**：文件设只读，编辑器输入 `X` 后 Ctrl+S，出现 `⚠ 文件只读或被占用；当前编辑内容保留、未写盘，可另存为副本`；磁盘正文未改变。
- **改名**：保存刷新 identity 后外部改名，出现 `⚠ 检测到可能已改名为：b43-keepmine2-ui-renamed.md；可重试或另存为副本`；改回后横幅消失。
- 截图：`C:\Users\Ming\.dsh\data\computer-use\shots\shot-2026-11-11_05-58-45-388-*.jpg`（删除）、`..._06-00-18-798-*.jpg`（只读）、`..._06-01-24-413-*.jpg`（改名）。
- 未在 Desktop 测恢复中心/另存为模态；这两项已在隔离 Web 真机通过。

## 27. P1 G1 扩展到 live room 状态

- 新增 `p1-shadow-live.test.mjs`：5 文件 × dirty / conflict / orphan / mirror = 20 场景；
- 与 `documents.state` 对比 state/source/dirty/conflict/version/revisionId/orphanDraft/external/unsavedElsewhere，0 差异；
- 与之前的 30 个磁盘/保存/改名场景合计 **50 场景 0 差异**；
- 仍未覆盖 review/recovery 组合与真正 11 状态表，不能按完整 G1 宣称。
- 全量 526/525/1。

## 28. P1 G1 扩展到 recovery/review

- `p1-shadow-live.test.mjs` 增加 5 文件 × recovery / review = 10 场景；
- 与 `documents.state` 对比核心字段 0 差异；
- 合计：磁盘/保存/改名 30 + dirty/conflict/orphan/mirror/recovery/review 30 = **60 场景 0 差异**；
- 仍未覆盖完整 11 状态表/客户端接线，不能按完整 G1 宣称。
- 全量 526/525/1。

## 29. P5 磁盘权威 AI 写归档

- `checkpoint(a)` 不再只对 buffer；disk-authority `documents.applyEdits` 写前也归档 `agent-before`；
- 归档失败 `MP_ARCHIVE_FAILED`，写前 fail-closed；
- 虚拟 provider（targetKey 非本地绝对路径）使用 `tmpdir/markpilot-archive/<sha>.md` 稳定合成路径，避免写不进；
- 测试：disk applyEdits 归档改前正文、虚拟 provider 归档、写入成功；全量 528/527/1。
- 未接 fs 守卫读取 draft_index、未做 lookup 连续失败 fail-closed；P5 继续。

## 30. P5 write guard 覆盖 draft_index

- `lookupDocument` 在无房间时查询 draft_index mirror；存在 mirror 即返回 dirty/source=mirror，通用 fs 写被 `MP_DOC_DIRTY` 拒绝；
- 新增测试：无 room 的 mirror 被 guard 看见；
- 全量 529/528/1。
- 仍未做 lookup 连续失败 fail-closed / fsSessionIntents / fsArchiveAll。

## 31. P5 write guard lookup 有界 fail-closed

- `createWriteGuard` 增加 `lookupFailures` 计数与阈值（默认 3）；连续失败第 3 次抛 `MP_DOC_LOOKUP_FAILED`，成功一次清零；
- 单次失败仍 fail-open，保持临时 DB 锁可用性；
- 新增测试：3 次失败拒绝、随后成功恢复；
- 全量 530/529/1。

## 32. 1.9.1 打包与 Desktop 更新

- 包 `dsh-markdown-editor-typora-1.9.1.tgz`，150 files，SHA256 `92DC1DCCE378848F894F916BA023FABCE592AA27517123F1699D75BA7E3720AE`。
- 隔离 profile 安装成功。
- Desktop 从 1.9.0 更新到 `file:...1.9.1.tgz`，version 1.9.1，实体目录；Markdown 工具可调用。
- 更新前备份 `D:\BuyKey\desktop-profile-backup-20261111-1430`；未重启 Desktop。
- 全量 530/529/1。

## 33. P5 archive 失败零写测试

- 将 LOCALAPPDATA 指向文件使归档目录不可建；
- disk applyEdits 返回 `MP_ARCHIVE_FAILED`，磁盘正文保持 `before`；
- 全量 531/530/1。

## 34. 1.9.2 补丁与 Desktop 更新

- 包 `dsh-markdown-editor-typora-1.9.2.tgz`，150 files，SHA256 `E2CDA2D392D369CAC335B36FFBFD84BB89309B818C153DB1A97E641C0D21F570`。
- 隔离 profile 安装成功；Desktop 从 1.9.1 更新到 `file:...1.9.2.tgz`，实体目录，version 1.9.2，Markdown 工具可调用。
- 更新前备份 `D:\BuyKey\desktop-profile-backup-20261111-1500`；未重启 Desktop。
- 全量 531/530/1。

## 35. P1 G1 扩展到 external

- 5 文件 × external = 5 场景；`documents.session` 与 `documents.state` 0 差异；
- 合计 **65 场景 0 差异**（30 磁盘/保存/改名 + 35 live）。
- 仍未覆盖 owned-elsewhere / readonly / locked 与完整 11 状态表。
- 全量 531/530/1。

## 36. Desktop P5 磁盘归档真机（通过）

- 对未打开的磁盘文件 `facadetest.md` 用 Markdown 模型工具 `edit`：
  - 成功写盘：`AIARCH# facadetest`
  - 返回 `checkpointPath`：
    `C:\Users\Ming\AppData\Local\.markpilot\draft-archive\facadetest.md.agent-before.4cddcf72a9247aab.md`
  - 归档内容为改前 `FACADEREAL# facadetest`，SHA256 `1382A202…`
- 改后测试文件已恢复原文；Desktop 1.9.2 上实际验证了 disk-authority AI 写归档。

## 37. P1 G1 owned-elsewhere

- 用独立 Node 子进程 join 同一文件，模拟远程编辑器持有 buffer；
- `documents.session` 与 `documents.state` 均返回 `owned-elsewhere`，核心字段 0 差异；
- G1 合计 **66 场景 0 差异**；仍缺 readonly/locked 与完整 11 状态表。
- 全量 531/530/1。

## 38. P5 可选 fsSessionIntents

- `apply(ctx, config)` 读取 `config.fsSessionIntents`，默认 false；
- true 时包装 `ctx.fs.writeText/editText/patchText/deleteFile/moveFile`，dirty session 拒绝 `MP_DOC_DIRTY`，disposer 还原；
- 修复 `apply` 的 free `options` 引用（否则整个 write guard 不安装）；
- 测试 dirty 拒绝/clean 放行；全量 532/531/1。

## 39. P5 fsSessionIntents 审查修复

- 修复 `apply` 引用未定义 `options`（会导致整个 B2 guard 不安装）；改为 `apply(ctx, config={})`。
- `moveFile` 同时检查 source 与 destination，dirty 目的地拒绝。
- 包装 disposer：record own property、identity 检查、必要时 delete；赋值失败回滚已安装 wrapper。
- 新增 apply 级测试：默认关闭不包装、flag=true 包装、字符串 "true" 不包装；moveFile 目的地测试。
- 全量 534/533/1；默认关闭行为不变。

## 40. 1.9.3 打包与 Desktop 更新

- 包 `dsh-markdown-editor-typora-1.9.3.tgz`，150 files，SHA256 `4FBCF046870C80E2A72E3377E152FBA2A209C2A993E116C50E6CB71D7A5EC866`。
- 隔离 profile 安装成功；Desktop 从 1.9.2 更新到 `file:...1.9.3.tgz`，实体目录，version 1.9.3，Markdown 工具可调用。
- 更新前备份 `D:\BuyKey\desktop-profile-backup-20261111-1530`；未重启 Desktop。
- 全量 534/533/1。

## 41. Desktop 1.9.3 重启验收

- 用户重启后新宿主 pid 40324；激活 DeepSeek Harness 并点击左侧 Markdown；
- Markdown 工作台正常打开，文档树/编辑区渲染，状态「就绪」，无插件加载错误；
- `b43-keepmine2.md` 测试文档内容与属性未变；
- Desktop node_modules 确认 version 1.9.3；
- 未在本次重启后重复删除/改名/只读 UI 用例。

## 42. P5 write guard 错误文案

- `MP_DOC_LOOKUP_FAILED` 不再说“文件正在打开”，改为“连续无法读取未保存状态，已拒绝写入”。
- mirror 场景错误消息明确“存在草稿镜像”，不再误导为当前窗口打开。
- 测试覆盖两种消息；全量 535/534/1。

## 43. P5 documents.state 走 SessionManager

- `documents.state` 改走 `apiSession`，使用 SessionManager 缓存；
- key 加入 room epoch/version/savedVersion、members/localMembers、resolvedDisk、draft mirror 的 sha/base，避免 owned-elsewhere/mirror/keep-mine 被旧快照掩盖；
- 写端点 finally 统一 `documentSessions.clear()`；
- 新增 mirror 失效测试；全量 536/535/1。
- 审查确认两个缓存 BLOCKER 已修；read/applyEdits 仍未显式走 snapshot。

## 44. P5 state routing 审查修复

- key 增加 recovery 列表标记；discardAppendRecovery 后缓存失效。
- `sessionGeneration`：写端点失效后，旧 load 不再回填缓存。
- `documents.undoGroups` 加入失效端点；`open` 也加入。
- `allowedActions` 过滤 undoneAt/undone_at 的 review 组。
- 空 path 的 `documents.state` 仍走 service 原错误码。
- 测试：mirror/membership 缓存失效、undone 组无 review 动作；全量 537/536/1。
- 仍未做：read/applyEdits 显式 snapshot、G5 flag 对照、真实 DB-lock。

## 45. 1.9.4 打包与 Desktop 更新

- 包 `dsh-markdown-editor-typora-1.9.4.tgz`，150 files，SHA256 `CAA0209E9C9AEBF511D1C9B26C3257E584EBE3FFED8E511B89BC57FB121A748D`。
- 隔离 profile 安装成功；Desktop 从 1.9.3 更新到 `file:...1.9.4.tgz`，实体目录，version 1.9.4，Markdown 工具可调用。
- 更新前备份 `D:\BuyKey\desktop-profile-backup-20261112-0330`；未重启 Desktop。
- 全量 537/536/1。

## 46. P5 state/session 缓存按 authority 分离

- `apiSession(payload, invocation, authority)`；cache key 增加 authority 与 policy mode/workspaceRoot；
- model `documents.state` 与 editor `documents.session` 不再共享同一缓存项，P1 对比不再是同项自证；
- 全量 537/536/1。

## 47. P5 broadcastChange 缓存失效

- `broadcastChange` 不再按 base path 清一个不存在的 key，改为 `invalidateSessions()` 全量失效；
- 外部变更/SSE 事件后，`documents.state` 不会命中旧快照。
- 全量 537/536/1。

## 48. 1.9.5 打包与 Desktop 更新

- 包 `dsh-markdown-editor-typora-1.9.5.tgz`，150 files，SHA256 `44FBA5540672C6D7629C16136C6438A7A32973B5EF928C53013A04341B8F44DD`。
- 隔离 profile 安装成功；Desktop 从 1.9.4 更新到 `file:...1.9.5.tgz`，实体目录，version 1.9.5，Markdown 工具可调用。
- 更新前备份 `D:\BuyKey\desktop-profile-backup-20261112-0400`；未重启 Desktop。
- 全量 537/536/1。

## 49. P1 allowedActions 状态表测试

- 覆盖 missing/conflict/orphan/owned-elsewhere/unsaved-elsewhere/external/dirty/readonly/clean/disk；
- 确认 no-state 返回空、clean 无 save；全量 538/537/1。
