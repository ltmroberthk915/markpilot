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

## 追加：主题与侧栏手柄（同轮用户报告）

- **主题不保持**：`renderer-cm6/dsh-bridge.js` 的 `applyHostTheme()` 在每次 iframe boot / 宿主明暗切换时把 `localStorage["editor-theme"]` 无差别改写成 `telari-dark|light` 并 `engine.setTheme(默认)`，把用户在编辑器里选的主题冲掉；切会话回来 boot 又跑一次。改为：保留用户主题，宿主明暗只切 `mpTheme.sibling()` 同族；桥不再写 `editor-theme`；boot 前只写 `dshmd-theme`。
- **透明被主题切换破坏**：主题应用会写内联背景/变量，压过透明规则。新增 `reassertTransparency()`（清内联背景 + 重新断言 `data-mp-transparent`），在 appearance、宿主主题、主题变更观察、pending 主题应用后都跑一次；父窗口下发 appearance 之前不动属性，避免首帧误判。
- **左右侧栏手柄位置不保持**：拖动结果写在 `localStorage["dsh.markpilot.handles.v1"]`，但**没有任何读取路径**。新增 `readSavedHandles()` + `reapplySavedHandles()`：安装手柄时按 0/400/1400ms 重试恢复，切会话后 420ms 再补一次；值域按手柄上下限钳位。

## 验证

- 新增 `test/external-refresh.test.mjs` 9 项：7 项宿主文件/SSE 场景 + 2 项 live 房间（干净自动采纳、草稿冲突与 discard 采纳）。全部通过。
- 全量：342 项，341 通过、1 项 POSIX 跳过、0 失败。
- 实机：需要重启桌面端加载 1.3.2 后复测（profile 指向的 `D:\BuyKey\markpilot-public` 已同步到本版本）。
