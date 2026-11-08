# DSH 插件 1.3.1 → 1.3.2 内部记录

2026-11-08。用户报告：另一个会话改写 `北交所面试材料.md`（128KB）后，编辑器仍显示旧内容，重开才好；raw 文件本身正确。

## 定位过程

- 先排除「旧 host 未重启」：运行中的 25460 是 9:47 启动，但 watch 代码自 0.3.1 起没变，重启不会改变 watch 行为。
- 真实文件系统 + 真实 HTTP/SSE 的对抗测试（`test/external-refresh.test.mjs`）证明宿主侧链路健康：直接写、追加、原子 rename、128KB/1500 行、中文+空格路径、连续快速写、双写者竞争，7/7 都能在 ~200–500ms 内广播 `change` 事件并带新版本。
- 于是问题在客户端/协同房间：编辑器打开本地文件时默认 `live:true` 入房；`onExternalEvent` 在 `doc.live` 分支只 `post("live-refresh")`，iframe facade 的 refresh 只做 exchange 拉房间增量，而**宿主的 `LiveDocuments.refresh()`（会把磁盘内容 adopt 进房间）没有任何入口**——HTTP `/api/live` 只接受 `leave`/`exchange`。结果：外部写入永远进不了 live 房间，编辑区保持旧内容，直到重开（重开会重新 join 并 adopt 磁盘）。

## 改动

- `MarkPilot-CM6/shell/live-documents.js`（并同步 `dsh-markdown-typora/host/live-documents.js`，`scripts/sync-host.mjs` 重算 `host.json`）：`refresh(client, epoch, options)` 支持 `discard`；`adoptDisk(..., force)` 供用户确认的「重载磁盘版本」使用。
- `lib/index.js`：`/api/live` 新增 `action:"refresh"` → `live.refresh(client, epoch, { discard })`。
- `lib/client.js`：新增 `refreshLiveRoom()`，在 SSE 外部变更、窗口重新可见、保存后对账三处调用；干净时房间采纳磁盘并下发 delta（自动 1–2s 刷新）；有草稿时显示冲突横幅（既有「重载磁盘版本」按钮走 `forceReload()` = 退房 + 以磁盘重载）。非 live 且 dirty 时同样改为横幅，不再只写状态行。

## 验证

- 新增 `test/external-refresh.test.mjs` 9 项：7 项宿主文件/SSE 场景 + 2 项 live 房间（干净自动采纳、草稿冲突与 discard 采纳）。全部通过。
- 全量：342 项，341 通过、1 项 POSIX 跳过、0 失败。
- 实机：需要重启桌面端加载 1.3.2 后复测（profile 指向的 `D:\BuyKey\markpilot-public` 已同步到本版本）。
