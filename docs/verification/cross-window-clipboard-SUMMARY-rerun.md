# cross-window-clipboard 族 · 复跑结论（2026-10-10 工作站解锁后）

- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`，188784128 B，**sha16=`db7613632e37d99e`**
  （探针启动即断言 sha，不符则 exit(9) 拒绝出数）
- 复跑用例：**11**（X1–X11）
- 判决分布：**符合预期 11 / 环境阻断 0 / 不符预期 0 / 无法判定 0**
  （其中 X4 在第二轮主跑里是**假绿灯**，已用可鉴别口径重判，见 §3）
- 渲染侧 `pageerror`：`[]`
- 本文件不覆盖旧记录：上一轮「环境阻断」的原报告仍在 `cross-window-clipboard-SUMMARY.md`（结论已被本文件取代，原文保留）

## 1. 先自证剪贴板可用（纪律 3）

| 尺子 | 读数 |
|---|---|
| 一个 pwsh 进程 `Set-Clipboard` 写哨兵 → **另一个独立 pwsh 进程**回读 | `XWPROOF-OMKZG9XD` 回读一致（第 2 轮；第 1 轮被并发写者覆盖，脚本自带重试） |
| 应用壳层 `mpHost.writeClipboard({text,html})` → **独立进程**回读 | `{ok:true,bytes:15,hasHtml:true}`，独立进程读到 `ENVCHECK-ni6sza`（一致） |
| 应用壳层读 `clipboardHasImage().textLen` | 15（旧报告的"恒 0"已不复现） |

⇒ 剪贴板**真的可用**，跨窗口复制/粘贴用例本轮按真实剪贴板判，不再有「环境阻断」。

## 2. 两把必须先修好的尺子（否则读数是假的）

1. **编码**：旧写法 `pwsh -Command "Get-Clipboard -Raw"` 子进程按控制台代码页(GBK)输出、父进程按 UTF-8 解码
   ⇒ 中文变 `��һ�б��`，`includes()` 判据全灭（第一轮 X1/X2/X3 因此误报"不符预期"）。
   现在读走 `ps1 get <file>`（Win32 读 + 显式 UTF-8 落盘），图/格式走 `ps1 img`。
2. **并发争用**：剪贴板是全局单例，同期 4 个族的会话都在写（实测读到 `MP-SENTINEL-A-*`、`MPUHOSTA-*`、`MPUCPY*`、
   `DECOY3-*`、`CFD-SENT-*`、`def add(a, b):…`、`MPUTL-W3ADVN-*`）。点采样会把别人的内容读成"产品没复制"。
   现在加了**独立进程录像机**（`cross-window-clipboard-ps.ps1 watch`，80ms/次，每行记 `len/sha16/格式串/头部`），
   判据用 **sha16 对齐**；用例在"剪贴板里不是本次内容"时整条重做（最多 4 次），并把每次读数留档。
   （跨会话协调被拒：`session_telecom send` 返回 `session/agent-busy — owned by subagent routing`，
   所以只能靠探针自身抗争用；录像窗口 602 行里 36 行是别的族的内容。）

## 3. 逐用例新结论（关键读数）

| # | 用例（真实通道） | 新结论 | 关键读数（判据都读最终状态） |
|---|---|---|---|
| X1 | A 拖拽选中一行 → Ctrl+C → B 末尾 Ctrl+V | **符合预期** | 拖拽选中 `第一行标记 …-T1`；Ctrl+C 后**三重尺子全中**（渲染侧即时读 len16 命中 / 独立进程读命中 / 录像机 sha16 命中）；B 文档 29→45，paste 事件 `types:[text/plain] text=第一行标记 …-T1` |
| X2 | B → A 反向同一套 | **符合预期** | 第 1、2 次 attempt 被别的族覆盖（`MPUTL-W3ADVN-quick-3-*`、`hold180-1-*`），守卫判"放弃、重做"；第 3 次三重尺子全中，A 文档 218→234，粘贴内容一致 |
| X3 | A 复制 → A 自己粘贴 | **符合预期** | 三重尺子全中（`第二行标记 …-T2`），A 文档 218→234 —— 同窗口自粘与跨窗口同一条通路 |
| X4 | A 复制整表 → B 粘贴（attempt1 拖拽；attempt2 浮动条 ▦→「复制表格（可粘 Excel）」） | **符合预期（重判后）** | attempt1 拖拽选 block widget **仍选不中**（`拖拽没选中`，settle 在 234）——探针手势限制，非产品缺陷；attempt2 真通道：录像机 **13 行** sha16 命中期望 TSV（`fmt=HTML Format,CF_UNICODETEXT,…`，正是 `头A\t头B\n…a\t11\n…b\t22`），B **表块数 0→1、该数据行 0→1**，toast `已建成 3 行 × 2 列` |
| X5 | A 右键「复制图片」→ B 粘贴 | **符合预期** | 壳层 `clipboardHasImage={hasImage:true,width:96,height:64}`；录像机 **43 行**带图片格式；按 Ctrl+V 前渲染侧 `navigator.clipboard.read()` 报 `image/png`；B 图片引用 1→2，新增 `![](data:image/png;base64,…)` 且渲染 96×64 |
| X6 | 两行文字 → B（**真通道**：独立进程写剪贴板 + 真实 Ctrl+V） | **符合预期** | 写后即时读命中；B 文档全文含两行，paste 事件 `inEditor:true` |
| X7 | 表格 HTML（`<meta charset><table>`，**合成注入**）→ B | **符合预期** | B 表块数 1→2；表头/`\| --- \|`/两条数据行齐全；toast `已建成 3 行 × 2 列` |
| X8 | 表格 TSV（**真通道**）→ B | **符合预期** | 写后即时读 = `头A\t头B⏎…a\t11⏎…b\t22`；B 表块数 2→3，转成 Markdown 表格，toast 同上 |
| X9 | PNG File 进 `clipboardData.items`（合成注入）→ B | **符合预期** | 图片引用 2→3，新增的是 `![](data:image/png;base64,…)`，渲染 96×64；`assets/` 未落盘（inline 口径） |
| X10 | 对照臂·同一注入打到 A | **符合预期** | A 图片引用 1→2 ⇒ X9 不是「B 窗口特有」 |
| X11 | 浮动条 →「复制为 Markdown 源码」 | **符合预期** | toast `已复制表格源码（Markdown）`；**独立进程录像 9 行**读到源码 `head=\| 头A \| 头B \|\n\| --- \| --- \|…`（len=61, sha16=`a658630784ded54c`）⇒ 真的写进了系统剪贴板 |

### 3.1 X4 的"假绿灯"修正（诚实记账）

主跑第二轮里 X4 记成"符合预期"，但它的判据（"B 文档里有 `| 头A | 头B |` 与数据行"）**没有鉴别力**：
那一轮 B 窗口已被 §4 的异常灌成 **A 的文档**，而 A 的夹具里本来就有那张表；同时 `Ctrl+V之前剪贴板仍是本表=false`
（此刻剪贴板是别的族的 `MPUTL-W3ADVN-hold400-1-*`），即那次粘贴其实粘进去的是**别人的内容**。
⇒ 已另写定点探针用**可鉴别口径**重判（表块数增量 + 目标行增量 + 录像机 sha16 认领），两轮重判**都通过**。

## 4. 「B 窗口变成 A 的文件」：**无并发下照样复现**，成因已定位（推翻了"并发实例干扰"的推测）

### 4.1 复现（最小手法、与剪贴板无关）

`xwclip-rerun2.cjs` 第三段：开 A=clipA.md、B=clipB.md（`openInNewWindow`）→ **只把 clipA.md 的 mtime 改一下**
（模拟"文件被别的程序改过"）→ 点 B 让焦点离开、再点 A 让 A 获焦 → 等 2.5 s：

| | 复现前 | 复现后 |
|---|---|---|
| 窗口 A 身份 | `clipA.md`，213 字，`# A 文档 …` | 不变 |
| **窗口 B 身份** | `clipB.md`，95 字，`# B 文档 …` | **`clipA.md`，213 字，`# A 文档 …`，标题栏 `clipA.md · 213 字`** |

- 启动前 `tasklist`：**无任何 MarkPilot 实例**（`No tasks are running…`）；本实例 `second-instance`/`newwin:created` 事件数 **0**
  ⇒ 与并发实例无关（同结果复现两次：`xwrepro-ouf7u8`、`xwrepro-r5mrnb`）
- 视觉证据：`xwrepro-ouf7u8/B-final.png` —— 这就是**第二个窗口**，显示的却是 A 的文档（底栏 `行 17/17 · 213 字`）
- 壳层 trace（本实例，两次读数一致）：
  ```
  openPath:target {"hasTarget":false,"isPrimary":true,"sessionPath":"…clipA.md","tag":null,"wcId":2}   ← B 的焦点：自动重开 clipB.md
  doc:push:openPath {"to":2,"path":"clipB.md"}                                                          ← 推进最新的那个窗口(B)，同时把"主会话"路径改成 clipB.md
  openPath:target {"hasTarget":false,"isPrimary":true,"sessionPath":"…clipB.md","tag":null,"wcId":2}   ← A 的焦点：自动重开 clipA.md（主会话路径已被改）
  doc:push:openPath {"to":2,"path":"clipA.md"}                                                          ← A 的内容被推进 B 窗口 ⇒ B 变成 A 的文件
  ```

### 4.2 代码链路（只读核对，未改产品代码）

1. `MarkPilot-CM6/renderer/host.js:496-510` —— 「外改探测」挂在窗口 `focus` 上：`mpHost.outsideChange(filePath)`
   报 `changed` 且文档不脏时，**自动**调 `window.mpHost.openPath(filePath)`（脏时给横幅，其中「载入磁盘版本」也调同一条）。
   **这条调用没有落点参数。**
2. `MarkPilot-CM6/preload.js:11` → `ipcRenderer.invoke('file:openPath', p)`；`MarkPilot-CM6/main.js:835`
   `handle('file:openPath', (_e, p) => openPath(p))` —— 无 target。
3. `MarkPilot-CM6/main.js:552-556`：`openPath(p, target=null)` 里 `S = target?.session || state`（**主会话**）、
   `W = target?.win || win`（`main.js:753` 把全局 `win` 指向**最后创建的窗口**）⇒ 两窗在场时，"谁的文件"与"推进哪个窗口"错位。
4. `MarkPilot-CM6/main.js:1360-1366`（`doc:saved`）与 `file:save` 链路**都不更新会话的 `diskMtime`**
   （全仓只有 `readDoc` 的 `main.js:233/252` 与 `reloadDoc` 的 `622` 会写）⇒ **应用自己刚保存过的文件，
   下一次窗口获焦就被判成"外部改动"**，于是这条自动路径每次聚焦都可能再走一遍。

### 4.3 影响面（本轮实测到、但未逐项归因）

- B 窗口被灌成 A 的文档后，`doc:path:write {"wcId":2,…,"path":"clipA.md"}` ⇒ B 会话的路径也变成 A 的 ⇒
  之后再保存/自动保存有写进**另一个文件**的风险。主跑第二轮日志里确有
  `file:save {"filePath":"…clipA.md","bytes":278}`（夹具 clipA.md 原为 206 B）这样的落盘，
  **但本轮没有逐窗口归因是哪个窗口写的**，标为待验证（见 §5）。

## 5. 仍未验证 / 仍无法判定

1. **跨窗口剪贴的"真·并发"鲁棒性**：本机同时有 4 个族的会话在写剪贴板，协调被拒（`agent-busy`）。
   X2 前两次 attempt 确实被别人覆盖（已如实记录并重做）。若要在"全机独占"下复跑，需要外层排队机制。
2. **X4 attempt1（鼠标跨 block widget 拖拽选整表）**：仍选不中；本次未找到"真人从表格左侧空白起拖"的可复现手势
   ⇒ 「拖拽能不能选中表格 widget」**仍未判定**（不影响 attempt2 的真通道结论）。
3. **§4.3 的落盘归因**：异常发生后，究竟是哪个窗口把内容写进了 A 的路径 —— 未做（需要按 `webContents.id` 归因的写盘 trace）。
4. 本轮**未做突变验证**（把 §4.2 的自动 `openPath` 注掉应变绿）——产品代码只读纪律下没做；若要坐实"这条就是根因"，
   建议由持有改码权的会话做一次 `host.js` 侧突变（关闭 focus 自动重开 / 给 `mpHost.openPath` 补落点）。

## 6. 证据路径（全部在 `.mp-verify\` 下）

- 探针：`.mp-verify/checklist/cross-window-clipboard.cjs`（族主探针 v2：三重尺子 + 争用守卫 + X4 attempt2 + 逐窗身份收尾）
- 定点探针：`.mp-verify/checklist/xwclip-rerun2.cjs`（X4 可鉴别重判 + 异常最小复现）
- 外部尺子：`.mp-verify/checklist/cross-window-clipboard-ps.ps1`（`get`/`set`/`img`/`watch`，Win32 raw）
- 读数：`.mp-verify/xwclip-0ifrvb/result.json`（主跑 11 用例）、`xwclip-0ifrvb/clip-watch.log`（录像 602 行）
- 异常复现：`.mp-verify/xwrepro-ouf7u8/result.json`、`.mp-verify/xwrepro-r5mrnb/result.json`（后者启动前实例数=0）、
  `.mp-verify/xwrepro-ouf7u8/B-final.png`（B 窗口显示 A 的文档）
- 反例留档（坏尺子暴露的那一轮）：`.mp-verify/xwclip-ergd8q/result.json`
- 运行日志：`.mp-verify/xwclip-rerun/run-rerun1.log`、`run-rerun2.log`、`run-x4-and-anomaly.log`、`run-x4-and-anomaly-noconcurrency.log`、
  `proof-ok.txt`（剪贴板自证）；探针快照 `cross-window-clipboard.patched.cjs`
