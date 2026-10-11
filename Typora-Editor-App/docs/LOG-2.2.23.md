# LOG-2.2.23（第 9 轮：补验 + 挂起复审 → 5 项修复 + Typora 实机对照）

电池：4 猎手并行（H1 剪贴板 GUI 补验、H2 挂起项复审、H3 导出 UX 与分块预研、H4 覆盖缺口盘点）→ E9 辩论裁决 → 修复 → V 验收员 9 门串行（GUI 独占）→ 主会话 17 图视觉复核全过。

## 落地 5

1. **C 快 Ctrl+S 落盘**（doc.js）：save/saveAs 前拉活值 flushEditorText（executeJavaScript getValue，3s 超时降级；帧身份守卫防错帧落账），修「快速 Ctrl+S 存不到刚打的字/干净文档完全不保存」。验收中补 pending 门柱 `__mpInputSeen`（渲染层捕获相 input 监听）：未编辑的手动 Ctrl+S 不再把 Lute 归一化结果写盘（111/134 由红转绿的自伤自愈）。
2. **K1 Word 粘贴图片归档**（media-tools/images/doc.js/export-assets）：CF_HTML `file:///` 临时路径图片走 IPC 归档（20MB 白名单管线，与截图管线同形态：base64 内嵌 + userData 缓存），删源临时目录后重开图仍在；纯文本/公式内/文件载荷三红线不碰。
3. **K2 Excel 跨格粘贴**（media-tools pasteCellText）：门槛从「焦点在格内」扩为「anchor 与 focus 同表」，2×2 TSV 落 min 角矩形落位，修字面 `\t` 进格、矩形外数据丢失、行错乱。
4. **D printToPDF 竞速**（export.js）：打印分支 Promise.race(controller.signal)，取消/超时后 job 不再泄漏（destroy 后 printToPDF 永不 settle 的病理形由强突变证明，electron#29485 自然形如实记录不可复现）；超时缩短突变 8828ms 终态送达且可再导出。
5. **E 导出计时**（export-status.js）：对话框「已耗时 Ns」逐秒走字（后台任务起算，done/error/canceled 清除），打印阶段「正在打印 PDF…」消息。

## 验收中追加修复

- **F Shift+End 塌缩**（typora-patches.js，红→本轮修）：标题行正文起点按 Shift+End 选区当拍塌空、双端点掉进 `## ` marker（比 H2 预言更重）。修法：Shift+Home/End 事后校正分支——focus 落坏位置（标记/预览）时按行盒纵向相交判同线、自扫该行可用行端，focus 挪过去、anchor 用按下时快照还原（~45 行）。绿=Typora 终态语义；突变红；键盘回归 110/111/112/134 全绿。

## Typora 实机对照（CDP over pipe）

- 跨格选区粘 TSV：**Typora=线性替换丢数据**（甲1 塞 4 行字面文本、乙1/甲2/乙2 被清空）——正是我们旧病灶同款；我们的矩形落位优于 Typora。
- 单格文本→跨格选区：同语义（线性替换）。单格+TSV：Typora 字面插入 vs 我们矩形落位（既有能力，差异记 R10 口径）。
- 通道发现：Typora 表格内拖拽不扩选区，跨格选区需点击+Shift+点击。

## 回归

run.cjs r9-final：**57 场景 0 失败**（R8 的 112/114/73 三红全转绿，1 不适用=dev 树无 asar 固有）；human-input 19 场景失败集与 R8 既有红 9 项逐项相同（零新增）；快速五支探针（r1/r2/r4/r7/r8-export-crash）绿。PDF 产物剥时间戳后与 HEAD 逐字节一致。

## 观察哨（挂 R10）

F11 全屏无任何绑定（CDP/OS 真键均无效，全仓 grep 零命中）；Typora③单格+TSV 差异口径；K1b cid:（真 Outlook 取证）；confirmDiscard 四早退族；electron#29485 自然形复测（升级时）。

## 证据

`.perf/probe-r9-{save,extend,k1,k2,clipboard,selsave,export,typora,cover,verify}/`；突变备份 `.zcode-tmp/r9/mutant-backup/`；V-验收报告 `.zcode-tmp/r9/V-验收报告.md`；主会话视觉复核 17/17（analyze_image 通道，Read-PNG 仍只回 CDN URL）。
