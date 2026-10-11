# 复跑报告 · code-fence-daily（工作站解锁、剪贴板可用之后）

- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
  **sha16 = `db7613632e37d99e`**（188,784,128 B，mtime 2026-10-10 11:43:39）
  ⚠️ 与原 r5 报告的 `81b39273efae31e5` **不是同一份二进制**（同尺寸、不同哈希）⇒ 本轮结论只对该 sha 生效。
- 权威轮次：**r9**（2026-10-10 11:55，完整跑完 20 用例，pageErrors=0，粘贴类**零争用重试**）；
  **r10** 为复现轮（21 用例，读数与 r9 逐条一致）。探针版本 `v3-clip-unblocked`。
- 复跑范围：原报告"环境阻断"一节列的 **4 条**（ENV-CLIP / CF-5 / CF-5b / CF-5c）逐条给真结论；
  同轮把整族一并复跑（新增 CF-2b 无条件臂、CF-5e 对照臂、CF-6c 系统剪贴板臂）。

## 〇、先自证：剪贴板真的可用（纪律 #3，先证后用）

| 取证 | 读数 |
|---|---|
| 宿主两进程、**完全不碰产品**（CLIP-PRE） | `chcp65001+clip.exe` 写 28 字符哨兵 → **独立 pwsh 进程**回读两次 = 逐字相等（r10 第 1 轮被别的腿改写、第 2 轮成功 ⇒ 记"争用"而非"阻断"） |
| 产品侧对照 | 壳层写 39 字符哨兵 → **主进程自读 `textLen=39`**、页内 `navigator.clipboard.readText` 读到、独立 pwsh 读到 |
| 判定 | `通道可用=true`（宿主往返 ✓ 且 产品侧往返 ✓）⇒ **环境已不阻断**，粘贴用例可出真结论 |

对比 r5：当时主进程自读 `textLen=0`、pwsh 读空、`clip.exe` Access denied。

## 一、原「环境阻断」用例：逐条真结论

| 编号 | 用例 | r5 | **本轮真结论** | 关键读数（r9，r10 一致） |
|---|---|---|---|---|
| ENV-CLIP | 剪贴板通道可用性 | unverified | **ok（可用）** | 宿主两进程往返 ✓；主进程自读 39/39；页内+独立 pwsh 都读到哨兵 |
| **CF-5** | 代码块内粘贴多行（纯代码 3 行） | unverified | **ok（通过）** | 载荷 41 字符；注入后 60ms 页内回读**逐字相等**；paste 事件 `len=43 换行=3 TAB=0 prevented=true`（真粘贴通道）；文档 `153→194`（Δ41）；插入片段 === 载荷（`includes=true` `切片相等=true`）；插入区 L16..L18 **全部是代码行**（`mp-code`，行号 1/2/3）；文档无 `\r` |
| **CF-5b** | 代码块内粘贴多行（每行含 Tab） | unverified | **off（真缺陷，r9/r10 双轮复现）** | payload 25 字符含 3 个 TAB；paste 事件确实带着 TAB（`len=27 TAB=3`）⇒ 载荷没问题；但文档 `153→211`（Δ**58**），插入片段 = `"\n\| name \| value \|\n\| --- \| --- \|\n\| alpha \| 1 \|\n\| beta \| 2 \|"` ⇒ **TSV 被改写成长 58 的 markdown 表格**；插入的 4 行 `mp-code=false`、`data-mp-n=null`（代码块行号从 1 直接跳到 2）；截图里有表格工具条与提示「**已建成 3 行 × 2 列**」 |
| **CF-5c** | 代码块内粘贴多行（markdown 表格片段） | unverified | **off（真缺陷，同族；r9/r10 双轮复现）** | 中文注入已校验（剪贴板与 paste 事件都是 `\| 列一 \| 列二 \|…`）；文档 `153→189`（Δ36）；插入片段 = 载荷 **+ 1 个前导换行**（`切片相等=false`、`includes=true`）；3 行 `mp-code=false`、`mp-n=null`；截图提示「**已建成 2 行 × 2 列**」 |
| CF-5d | 粘贴清理：Ctrl+Z 回基准 | r5 未跑 | **ok** | 三例撤销后 `文档===基准`、`len 153===153`，无残留 |

**判据口径**：一律读**最终状态**（文档源码 + 每行 `mp-code`/`data-mp-n` + paste 事件里的 `clipboardData` + 独立进程读到的剪贴板内容），不读"我调用了什么"。
**对照臂 CF-5e（r10 新增，r9 无）**：同一份 TSV 粘到**普通段落**行尾 ⇒ 同样变成表格（Δ58，读数与 CF-5b 逐项相同）→ 证明「粘贴 TSV 建表」是**产品设计特性**；缺陷在于**它在围栏（代码块）内也照样建表**，把代码块内容改成表格并打断代码块渲染/行号。

**逃生通道专测（`.mp-verify\checklist\code-fence-daily-plainpaste.cjs`，p1，同一产物）**：同一锚点、同一载荷，只换组合键 ⇒

| 臂 | 组合键 | paste 事件 | 文档 | 插入片段 | 插入区 |
|---|---|---|---|---|---|
| PP-1 | `Ctrl+V` | `len=27 tabs=3 text="name\tvalue…" prevented=true` | `54→112`（Δ58） | `"\n\| name \| value \|…"` | L5..L8 `code=false mpN=null`（建成表格） |
| PP-2 | `Ctrl+Shift+V` | **与 PP-1 完全相同**（27/3/prevented=true） | `54→112`（Δ58） | **与 PP-1 相同** | **与 PP-1 相同** |

⇒ **没有"纯文本粘贴"逃生通道**：`Ctrl+Shift+V` 与 `Ctrl+V` 走同一条被产品 `prevented=true` 接管的 paste 路径，同一份 TSV 在围栏内一律被改写成表格。用户目前**无键盘路径**把 TSV 原样粘进代码块（这条同时把根因指向"产品的 paste 处理器无条件建表"，与修饰键、与是否在围栏内都无关）。

## 二、同轮复跑里由 off 转 ok 的用例（因为被测产物换了）

| 编号 | r5 | 本轮 | 读数 |
|---|---|---|---|
| CF-2 代码块内 Tab 缩进 | off（没反应、焦点被带走） | **ok** | `"const b = 2;"` → `"  const b = 2;"`，keydown `prevented=true`，焦点仍在编辑面 |
| CF-2b Shift+Tab | off | **ok** | r8 起改为**无条件臂**：`"  const b = 2;"` → `"const b = 2;"`（缩进退掉），`prevented=true`，焦点留在编辑面 |
| CF-7 工具栏「代码块」按钮 | off（caret 落在块外） | **ok** | Δ10，caret 落在块内空代码行（`mp-code=true`/`mp-fence=false`） |
| CF-7b 点完立刻打字 | off | **ok** | 打的 `X` 落在块内（`mp-code=true`） |
| CF-6c（新增尺子） | — | **ok** | 哨兵 → 拖选 → Ctrl+C → **独立 pwsh 读回 = 源码本身**（`def add(a, b):\n    return a + b`）⇒ 复制确实写进**系统**剪贴板（r5 时只能读页内 copy 事件） |

其余 CF-1 / CF-3 / CF-2c / CF-2d / CF-4 / CF-5x / CF-6 / CF-6b / PZ 双轮均 ok。

## 三、探针侧修掉的三个"假读数"（记录在案，避免把伪影当产品行为）

1. **注入通道编码**：plain `clip.exe` 把 stdin 的 UTF-8 字节按控制台代码页（CP936）解释 ⇒ 中文变 `鍒椾竴`。
   实测 3/3 乱码；改 `cmd /c chcp 65001 & clip` 后 3/3 相符（证据 `clip-chan-ab\result.json`）。
   **r7 的 CF-5c 曾因此误判 off，已作废**。
2. **读尺子自身会读坏中文**：原来用 `execFileSync('pwsh', …)` 的 **stdout 捕获**，同一份剪贴板内容被读成 `| ��һ |`；
   改成**文件落地**版（pwsh 写 UTF-8 文件 → Node 读文件）后读到 `| 列一 | 列二 |`（证据同上）。
3. **插入区窗口**：原用 `lnA+5` 固定窗口，越过闭合围栏把"闭合后正文"算进来 ⇒ 把 CF-5 的"逐字落地"误判成 off；
   改成按**实际插入范围**（插入末字符所在行）计算。

## 四、仍未验证 / 限制

- **跨产物不可比**：r5 的粘贴用例在 `81b39273efae31e5` 上永远无法验证（当时环境阻断）；本轮的 ok/off 只属于 `db7613632e37d99e`。
  同轮出现的 CF-2/CF-2b/CF-7/CF-7b「off→ok」也说明**产物本身变了**，不能与 r5 直接比。
- **缺陷根因未定位**：本轮只做行为取证（不改产品代码）。已可确定的行为事实：paste 事件被产品 `prevented=true` 接管，且**与修饰键、与是否在围栏内都无关**（PP-1/PP-2 逐项相同）。
  静态线索（**旁证，非结论**）：产物自带 `resources/app.asar` 内可见 `mp-table`（渲染侧表格实现），
  但未找到 `insertTable`/`pasteAsTable` 之类标识符，且 toast 文案「已建成 N 行 × M 列」不在 asar 明文中（可能在渲染包内以其它形式存在）⇒ 交给修复腿定位。
- **"应当怎样"未定**：围栏内粘表格形状文本，正确语义究竟是"原样插入代码"还是"提示并拒绝"（Typora 直觉是前者），需产品决策；本轮只证明**现状与"逐字进代码块"不符**。
- **环境天生共享**：系统剪贴板是全局单例，本刻别的验收腿也在写（实测 churn≈7%/150ms，观测到外来值
  `MPULONG-…`/`MPUCOPY…`/`DECOY-…`/`MPURMB-…`/`XWPROOF-…`）。本轮已带防争用（注入后 60ms 回读校验 + paste 事件即"Ctrl+V 那一刻的真实内容"），r9/r10 **零争用重试**；
  但若别的腿将来长时间高频抢占，粘贴类读数需重跑确认。
- 未做的：CF-5b/5c 的**突变验证**（本轮无产品改动，不适用）；`\r\n` 尾换行是否该被丢弃（CF-5 Δ41 少 2 字节 = clip.exe 补的尾 CRLF，属通道常识，未判产品差异）。

## 五、证据路径

- 权威读数：`.mp-verify\checklist\code-fence-daily\r9\result.json`（20 用例）、`…\r10\result.json`（21 用例）
- 粘贴后**文档源码**（判断"改写"看源码）：`r9\CF-5-doc-after-paste.md`、`r9\CF-5b-doc-after-paste.md`、`r9\CF-5c-doc-after-paste.md`
- 截图：`r9\shots\CF-5-paste.png`（逐字进块）、`CF-5b-paste.png`（块内建表 + 「已建成 3 行 × 2 列」+ 行号跳号）、`CF-5c-paste.png`（「已建成 2 行 × 2 列」）、`CF-6c-system-clipboard.png`、`02b-shifttab.png`
- 运行日志：`.mp-verify\checklist\code-fence-daily-r9.log`、`…-r10.log`（r6/r7/r8 亦保留，含两次伪影的现场）
- 通道/尺子自证：`.mp-verify\checklist\clip-chan-ab\result.json`（A 3/3 乱码 vs B 3/3 相符）、`clip-channels-unicode\result.json`、`clip-inject-enc\result.json`、`clip-contention.log`（churn 采样）
- 逃生通道专测：`.mp-verify\checklist\code-fence-daily-plainpaste\p1\result.json`（PP-1/PP-2）、`…-plainpaste-p1.log`、`p1\PP-1-doc.md`、`p1\PP-2-doc.md`、`p1\shots\PP-1.png`/`PP-2.png`
- 探针：`.mp-verify\checklist\code-fence-daily.cjs`（v3；改前原件留档 `code-fence-daily.pre-r6.cjs.bak`）、`code-fence-daily-plainpaste.cjs`
