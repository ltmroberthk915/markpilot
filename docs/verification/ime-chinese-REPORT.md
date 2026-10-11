# ime-chinese 族 · 普查记录

- 族名：**ime-chinese**
- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`（188784128 B，**sha16=81b39273efae31e5**，版本 3.2.0）
- 主探针：`ime-chinese-e2e.cjs`（每用例前做窗口身份体检）；诊断探针：`diag` … `diag7`
- 主报告：`ime-chinese-out\2026-10-10T01-10-26-535Z\report.json`（+ 13 张 png + main-debug.log）
- 夹具：5 行可辨文本 `TITLE-AAA / line-2-BBB / … / line-5-EEE`，写在 `.mp-verify` 下（产品代码未改动）

## 一、规模

| 项 | 数 |
|---|---|
| 用例（主探针，带判据） | 11（A1 A2 C1 C2 C3 C4 C5 C6 C7 C8 C9） |
| 诊断探针探针点 | diag/diag2/diag3/diag4/diag5/diag6/diag7 共 7 个，含 3 组对照臂 |
| 通过 | 4（A1、C4、C5、C9） |
| **没反应 / 行为不符预期** | **5（C1、C2、C3、C6、C7、C8 → 其中 C2 为"半通过"）** |
| pageerror | **0** |
| 崩溃 | 主探针全程 0；边界复现脚本里 1 次应用进程消失（见 §四） |

## 二、没反应的项 / 行为不符预期的项（逐条，带读数）

### ★1（C1）合成未提交期间，拼音串进入引擎文档 state.doc —— ① 判据不通过

- 读数（一次 evaluate 取全）：基线 `TITLE-AAA\n…`（54 字）→ 合成 `n`→`ni`→`nihao` 后
  `nihaoTITLE-AAA\n…`（**59 字**），`inputState.composing` = 1→2→3，行数不变。
- 事件流证明应用**确实**收到了合成事件：`compositionstart` → `compositionupdate(data="n")`
  → `beforeinput:insertCompositionText(ic=true,data="n")` → `input:insertCompositionText(ic=true)`，逐级到 `nihao`。
- 与"拼音只应待在 DOM 预览层、不进文档模型"的预期不符。**判据 ①：✗**

### ★2（C2）"提交"的中文不是真提交：合成一收尾就消失 —— ② 只算半通过

- 合成 `你好` 后 doc 头变 `你好`（光标 head=2、无选区残留）→ 发空合成串 = Chromium 记录的
  compositionend → doc **回到基线** `TITLE-AAA\n…`，`composing` 由 4 归 -1。
- 即中文只以"合成预览"形式借住 state.doc，**没有变成文档内容**。截图：`c2-committed-zoom2x.png`、`c2-committed.png`。

### ★3（C3）合成中按 Esc 不取消 —— ③ 判据不通过

- 合成 `quxiao` 后 doc=`quxiaoTITLE-AAA\n…`；真发 Escape（keyDown+keyUp）后 doc **一字未变**、
  `composing` 仍为 1、残字仍在。
- 可达性已单测（diag7/T2）：渲染进程**收到了** `keydown{key:"Escape", isComposing:true}`，但 `dispatch` 事务数 = **0** ⇒ 不是"按键没送到"，是"送到后没人处理"。

### ★4（C6）连续输入 20 个中文词：19 个被覆盖，最终 0 个留下

- 逐词读数：每一词在合成期间都能正确出现在 doc 头部（`苹果`→`香蕉`→…→`冬瓜`，20/20 都出现过），
  但每次收尾后 doc 头都回到 `TITLE-…`；最终 `doc长度增量 = 0`（期望 +40），`判据_20词都在 = false`。
- 形态：`imeSetComposition` 是**原地替换**上次合成范围（diag5/S1 证明：`aaa`→`bbb` 得到 `bbb`，不是 `aaabbb`）＋每次收尾清空 ⇒ 词与词互相覆盖。

### ★5（C7）中文 + 英文混输：顺序错乱

- 期望 `中MarkPilot文 v3.2.0 混输`；实测收尾后 `" v3.2.0 MarkPilotTITLE-AAA\n…"`。
- 分段读数：①中文合成中 doc=`中TITLE-AAA` → ①收尾后回到 `TITLE-AAA` → ②英文键入后 `MarkPilotTITLE`（英文留住了）
  → ③再合成中文时 `文` 又跑到最前（新合成在 offset 0 覆盖）⇒ 中文全部被顶到队首并被吞掉。

### ★6（C8）Ctrl+B 插了 **4 个星号**（命令被执行两次）—— 与 IME 无关的独立缺陷

- 干净状态对照臂（非合成、`insertText` 写入 `abcd`、光标在 offset 2）连测 3 次：
  `abcd` → `ab****cd`，**星号=4，事务数=1**，事务内容 `{from:2, insert:"****"}`，`userEvent=null`。3/3 一致。
- 代码位置（只读核查，未改产品代码）：`MarkPilot-CM6\renderer\cm6\app.js` 里存在**两处 Ctrl+B 绑定**
  —— `U9=[{key:"Ctrl-b",run:sx,shift:px,preventDefault:!0},…]`（offset ≈585565）
  与工具栏键位表 `Z={bold:"Mod-b",…}` / `E={bold:k=>D(k,"**"),…}`（offset ≈1020238）⇒ 一次按键两条命令都跑。
- 合成态下 Ctrl+B（⑧a / C9 边界）**事务数 = 0**（完全没反应）；收尾后再按则把 `****` 插在 offset 0（合成把光标带走了）。

## 三、通过的项

| 用例 | 结论 | 关键读数 |
|---|---|---|
| A1 对照臂 | `Input.insertText` 中文严格落 state.selection | 第 3 行第 5 列插入 `中文`，落点正确、光标在插入尾 |
| A2 对照臂 | `dispatchKeyEvent({isComposing:true})` **不产生** composition 事件 | 收到的是 `beforeinput:insertText ic=false`；compositionstart 数=0 |
| C4 ④ | 合成中回车**未换行** | 行数 6→6，行数增量 0，`huiche` 仍在，光标 head=6 |
| C5 ⑤ | 合成结束插入点/光标正确（在 offset 0 口径下） | doc=`中文TITLE…`、head=2、空选区、行数不变 |
| C9 对照臂 | 真汉字逐字 `char` 键入正确且不重复 | 第 3 行第 4 列插入 `对照`，无重复 |

## 四、崩溃 / pageerror

- 主探针（`ime-chinese-e2e.cjs`）全程 **pageerror = 0**，进程存活，收尾已清理。
- 一次崩溃：`ime-chinese-diag3.cjs` 跑到 Esc 变体 **E3（rawKeyDown Escape）** 时**整个应用进程消失**
  （`tasklist` 计数归 0；CDP 断连），发生在"上一轮合成清场 + 重写文档 + 立刻开新合成"之后。
  - 之后用 `ime-chinese-diag4.cjs` 做**定点复现**：X1 合成未结束就再合成 / X2 合成中改文档 /
    X3–X6 四种 Esc 手法，**6/6 全部存活**，未复现。
  - 系统侧无记录：`Get-WinEvent(Application)` 无 MarkPilot/electron 条目，WER 无当日报告，
    `%LOCALAPPDATA%\CrashDumps` 只有 10-08/10-09 的旧 dump。
  - ⇒ 记为**一次性、未复现**（保留原始现象，不当现状结论引用）。

## 五、尺子边界（哪些结论在 CDP 下测不了 —— 不许当"验证过"）

1. **合成落点不可控**：`Input.imeSetComposition` 恒从可编辑区起点（offset 0）合成，与
   `state.selection`、DOM Selection、真实鼠标坐标点击**都无关**；在**裸 contenteditable** 对照臂上同样如此
   （`CE-BASE` → `pinyinACE-BASE`）。⇒ "合成落在光标处／目标列"这类位置判据在 CDP 下**无法验证**；
   本轮所有含合成的用例统一以 offset 0 为基线（报告内已标注）。
2. **`isComposing` 通道不是合成**：`Input.dispatchKeyEvent({isComposing:true,text})` 只产生普通 `insertText`。
3. **未验证项（写明，不猜）**：真实 Windows 输入法（物理 IME）下的行为 **未验证** —— 需要 OS 级 IME 驱动，
   属侵入性手段，本轮未用。上述 ★1/★2/★3/★4/★5 均为 **CDP 合成事件**下的实测结论；
   应用确实以 `isComposing=true` 收到合成事件，但 CDP 合成的 `beforeinput` 的 `targetRanges` 为空数组、
   且合成锚点固定在 offset 0，这两点与物理 IME 是否等价**未验证**。
4. 合成中按 Enter 的"提交"语义**未能验证**：CDP 下 Enter 不结束合成（`composing` 仍为正），只能确认"未换行"。

## 六、环境纪律（本轮踩到的坑，供兄弟探针复用）

- 这台机器**并发跑着十多个 MarkPilot 实例**（兄弟探针）。`connectOverCDP` 拿到的
  `contexts()[0]` 不一定是自己那一个：只按 `window.mpEngine` 认页会**量到别人的窗口**
  （本轮 `ime-chinese-diag6.cjs` 就踩了：读到 `doc="TITLE-AA…"`、`dispatch` 记录全空，整轮作废）。
- 机械对策（已固化进主探针）：每用例前断言 `mpHost.docInfo().filePath === 本探针夹具路径`
  **且** `state.doc === 夹具原文`，不通过就拒绝出数（`exit(4)`）。

## 七、证据文件

| 内容 | 路径 |
|---|---|
| 主报告（全部读数） | [report.json](ime-chinese-out/2026-10-10T01-10-26-535Z/report.json) |
| 合成中截图（拼音在文档首） | [c1-composing.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c1-composing.png) / [c1-composing-zoom2x.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c1-composing-zoom2x.png) |
| 提交后截图 | [c2-committed-zoom2x.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c2-committed-zoom2x.png) |
| Esc 后截图 | [c3-esc.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c3-esc.png) |
| 回车后截图 | [c4-enter-zoom2x.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c4-enter-zoom2x.png) |
| 光标位置局部图 | [c5-caret-zoom2x.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c5-caret-zoom2x.png) |
| 20 词结果 | [c6-20words.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c6-20words.png) |
| 混输结果 | [c7-mixed.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c7-mixed.png) |
| Ctrl+B（4 星号） | [c8-ctrlb.png](ime-chinese-out/2026-10-10T01-10-26-535Z/c8-ctrlb.png) |
| 壳层 trace（MP_DEBUG=1） | [main-debug.log](ime-chinese-out/2026-10-10T01-10-26-535Z/main-debug.log) |
| 落点机制对照臂 | [diag2.json](ime-chinese-out/diag2-1791594204691/diag2.json) |
| 合成替换语义 + 收尾清空 | [diag5.json](ime-chinese-out/diag5-1791594462443/diag5.json) |
| Ctrl+B 3 连测 + Esc 可达性 | [diag7.json](ime-chinese-out/diag7-1791594677660/diag7.json) |
| 崩溃定点复现（6/6 存活） | [diag4.json](ime-chinese-out/diag4-1791594323793/diag4.json) |
| 一次崩溃现场（进程消失） | [diag3.json](ime-chinese-out/diag3-1791594247263/diag3.json) |
