# rich-paste 族 · 富文本粘贴互操作普查报告（2026-10-10）

**被测产物**：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe`
**sha16 = `1b4e32a2263fcbe6`**（188 784 128 B，mtime 2026-10-10T12:25:48+08:00）；四支探针每次启动都先断言产物 sha16，不一致即拒出数；报告写成时再次复核仍为同一 sha16。
**探针**：`.mp-verify/checklist/rich-paste-*.cjs`（全部只写 `.mp-verify/`，产品代码一行未改）
**规模**：4 次启动 / **21 个用例（有效 20，作废 1）** / 25 次真实 Ctrl+V / 21 张截图 / 7 项 Ctrl+Z 检查 / 4 项归因

> **产物与工作区源码的时间差（必须说明，错-1 口径）**：本族取证期间，工作区的 `dsh-markpilot/src-cm6/extras.js` 被**别的工作腿**在 12:30:38 改过一次，
> 而**被测产物**（`dist/win-unpacked/*`，12:25:44–12:25:47）**早于**这次改动。⇒ 本报告所有**行为读数**都出自被断言的产物本身（sha16 全程未变），
> 与工作区当前源码无关；所有**代码旁证**一律改从**产物自带的 `resources/app.asar`** 里取（见下），不引用工作区源码行号。

---

## 一、结论对照（按族范围的四条）

| # | 范围 | 结论 | 关键读数 |
|---|---|---|---|
| ① | 从网页复制（HTML 口味：加粗/链接/列表/表格）粘进正文 ⇒ **应转 Markdown 且不丢结构** | **不满足，且比"丢结构"更重** | 表格能转（W2/R2/D2/A2/A4）；**加粗/链接/列表一律不转**（正文场景 11 项）；**载荷含表格时，表格以外的粘贴内容整段不进文档**（6 项，含文字丢失） |
| ② | 从 Word 复制 | **同 ①** | 粗体/链接不转（正文：D1/D7；代码块内 D4 见 ③）；Word 混合片段只落表格，段落+编号列表文字丢失（D6）；Word 表格能转（D2）；Word 编号列表**偶然**存活（纯文本 `1.\t` 本身就是合法 Markdown） |
| ③ | 粘贴到代码块内应保持纯文本 | **✅ 通过（5/5）** | W6/W7/D4/D5/A3：落点在围栏内（引擎渲染类 `cm-line cm-activeLine mp-code`），插入片段与 `text/plain` **逐字相等**；带表格的载荷在围栏内**没有**建表 |
| ④ | 粘贴后 Ctrl+Z 一次还原 | **✅ 通过（7/7）** | W1、R1–R5、D1/D3 全部 `一次还原到位=true`（撤销后文档 === 按键前夹具） |

`pageerror`：**四次启动全为 `[]`**。崩溃：**无**。壳层 `userData\main-debug.log` 仅 `file:save` / `recent:addRecentDocument`，无异常分支。

---

## 二、行为不符预期的项

### RP-1（内容丢失）剪贴板里含表格时，**表格以外的粘贴内容整段不进文档**

最干净的一条（探针3 A2）：

| 项 | 读数 |
|---|---|
| 载荷 | `<p>下面是一张表：</p><table><tr><th>姓名</th><th>数量</th></tr><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></table>` |
| 装弹四步自证 | `ok(try1, 污染0)`；paste 事件 `htmlLen=208` **= CF_HTML 信封长度**（逐字到达） |
| **产品判决**（`defaultPrevented` @ document 捕获相、注册在产品之后） | **`true`** ⇒ 这一家自己接管了 |
| 插入片段 | `"\| 姓名 \| 数量 \|\n\| --- \| --- \|\n\| 甲 \| 1 \|\n\| 乙 \| 2 \|"` |
| 粘贴后文档 | `"前置段落。\n\| 姓名 \| 数量 \|…\n后置段落。\n"` |
| 内容令牌检查 | **丢失文字 = `['下面是一张表：']`** —— 那句话在文档里**一个字符都没有** |

复现 **6 次**（网页 3 次 / Word 1 次 / 归因 2 次），稳定：

| 用例 | 载荷 | 丢失的文字 |
|---|---|---|
| W5-web-all（探针1） | 网页 标题+加粗+链接+列表+表格 | `季度报告 加粗 示例链接 项目一 项目二` |
| R2-web-para-then-table（探针1b） | 网页 一句正文+表格 | `下面是一张表：` |
| R4-mid-paragraph-table（探针1b） | 同上「四件套」，落点在正文行中间 | `季度报告 加粗 示例链接 项目一 项目二` |
| D6-word-mixed（探针2） | Word 段落(粗体+链接)+编号列表+MsoTableGrid | `加粗文字 普通文字 示例链接 第一项 第二项` |
| A2-body-para-table（探针3） | 网页 一句正文+表格 | `下面是一张表：` |
| A4-body-richtext2（探针3） | 网页「四件套」第三次取样 | `季度报告 加粗 示例链接 项目一 项目二` |

**不是"把文档里已有的字删了"**（R4 里 `前置`/`段落。` 前后都在），而是**剪贴板里除表格以外的部分从未被插入**。
**代码旁证（取自被测产物自己的 bundle，不是工作区源码）**：`dist/win-unpacked/resources/app.asar` 内 `renderer/cm6/app.js`（`已建成` toast 所在处，asar 偏移 ≈1342100）的接管分支反混淆后等价于

```
if (caretOnCodeLine()) return;                       // 围栏内直接放行（实测 W7/D5 通过，与之一致）
const rows = tableFromHtml(html) || tableFromPlain(plain);
if (!rows) return;                                   // 非表格 ⇒ 不接管（实测 A1 defaultPrevented=false，与之一致）
… event.preventDefault();
const ins = headNl + rowsToMdTable(rows) + tailNl;    // ← 只插表格这一份
view.dispatch({ changes:{from,to,insert:ins}, userEvent:'input.paste' });
toast('已建成 N 行 × M 列');
```

`html` 与 `plain` 在该分支里**只被用来推导 `rows`**，`plain` 的其余内容没有任何消费者；同一 bundle 里唯一的 `htmlInlineToMd` 调用点在**表格单元格覆盖层**分支（`ll(new DOMParser()…)`）与 `tableFromHtml` 单元格取值处，正文路径没有第三个调用点。产品代码只读、未改。
**视觉证据**：[W5-web-all.png](E:\MarkPilot\.mp-verify\rich-paste\web\shots\W5-web-all.png)、[R2-web-para-then-table.png](E:\MarkPilot\.mp-verify\rich-paste\web1b\shots\R2-web-para-then-table.png)、[D6-word-mixed.png](E:\MarkPilot\.mp-verify\rich-paste\word\shots\D6-word-mixed.png)、[R4-mid-paragraph-table.png](E:\MarkPilot\.mp-verify\rich-paste\web1b\shots\R4-mid-paragraph-table.png) —— 四张图上都只剩一张表，粘贴前那句/那段字面上不存在。

### RP-2（结构保真度）加粗 / 链接 / 列表 **一律不转 Markdown**

最干净的一条（探针3 A1）：

| 项 | 读数 |
|---|---|
| 载荷 | `<h2>季度报告</h2><p>这是<b>加粗</b>与<a href="https://example.com/x">示例链接</a>。</p><ul><li>项目一</li><li>项目二</li></ul>` |
| 装弹四步自证 | `ok`；paste 事件 `types=['text/plain','text/html']`、`htmlLen=170` **= 信封**（结构标签原样到达） |
| **产品判决** | **`false`** ⇒ 产品**没有**接管（没 preventDefault、没改写） |
| 落到文档的 | `"季度报告\n\n这是加粗与示例链接。\n\n项目一\n项目二"` —— 与 `text/plain` **逐字相等**（`逐字纯文本=true`） |
| 判据 | `加粗=false 链接=false 列表=false`；`列表` 行渲染类全是 `cm-line`（没有项目符号）；`inlineMarks=[]`（引擎里没有任何加粗/链接标记） |

同形读数 **11 项（正文场景）**：W1、W5、R1、R3、R4、R5、A1、A4（网页）、D1、D6、D7（Word）。
另有 5 项（W6、W7、D4、D5、A3）落在代码块内，**那个场景本来就该逐字**，已计入第三节的通过项，不算缺陷。
单行行内格式也一样（R3：`结果：加粗，见说明。`，丢 bold+link）。

**视觉证据**：[W1-web-rich.png](E:\MarkPilot\.mp-verify\rich-paste\web\shots\W1-web-rich.png)（`季度报告` 不是标题、`加粗` 不是粗体、`示例链接` 不是链接、`项目一/项目二` 无项目符号）、[D1-word-text.png](E:\MarkPilot\.mp-verify\rich-paste\word\shots\D1-word-text.png)（Word 粗体/链接同样没了；`1. 第一项` 因为纯文本本身就合法才显示成列表）。

### 判据有没有鉴别力？（正对照，回答"红格是不是尺子卡住了"）

同一支探针、同一份产物、同一次运行里：

- 表格类载荷 → **绿**：W2（`htmlLen=194`=信封）与 D2（`htmlLen=779`=信封）都转成了真 markdown 表，`结构齐全=true`，探针1 还记到产品 toast「已建成 3 行 × 2 列」，截图上是带表格工具栏的真表格。
- 加粗/链接/列表 → **红**。

⇒ 尺子不是恒红：它对**同一个载荷里不同的结构**分别给绿/给红（W5/A4 就是"表格绿、其余红"同时出现在一条用例里）。

---

## 三、通过项（含关键读数）

| 项 | 用例 | 读数 |
|---|---|---|
| 网页 `<table>` → markdown 表 | W2 | `htmlLen=194`=信封；插入 `\| 姓名 \| 数量 \|…`；toast「已建成 3 行 × 2 列」 |
| Word `table.MsoTableGrid` → markdown 表 | D2 | `htmlLen=779`=信封；插入 `\| 项目 A \| 数值 \|\n\| --- \| --- \|\n\| 甲 \| 100 \|` |
| 代码块内粘网页富文本 ⇒ 逐字纯文本 | W6 / A3 | 落点 `cm-line cm-activeLine mp-code`；`逐字纯文本=true` |
| 代码块内粘**带表格/TSV**的载荷 ⇒ **不建表** | W7 / D5 | `逐字纯文本=true`；`表格=false` —— 这正是第二波 CF-5 修复要保的行为，本次两条都过（代码块用例共 5 条，全部逐字） |
| 代码块内粘 Word 内容 ⇒ 逐字纯文本 | D4 | `逐字纯文本=true` |
| Ctrl+Z 一次还原 | W1、R1–R5、D1/D3 | 7/7 `一次还原到位=true` |

---

## 四、作废读数（不是"通过"，也不是"失败"）

| 用例 | 原因 | 读数 |
|---|---|---|
| W3-web-para-then-table（探针1 首跑） | 剪贴板 6/6 被抢占 | 装弹 `FAILED(污染6)`；`带本载荷的按键 0/2`；按键时事件 `types=['text/plain']`、`htmlLen=0`、plainLen 5/8（**别人的载荷**）⇒ 判作废。同载荷已在 1b-R2 与 3-A2 两次拿到干净读数 |

---

## 五、未验证（不许当结论引用）

1. **载荷是构造件**：按 Chromium `StyledMarkupSerializer` / Word「另存为网页」的真实形态构造 CF_HTML，不是从真的 Chrome / Word 进程复制。自证到"paste 事件里 `text/html` 字节长度与信封完全一致（170/194/208/300/779/1494 六种全部吻合）"，但"真机 Chrome/Word 写出的字节与构造件逐字相同"**未验证**。
2. **只有 HTML、没有 text/plain** 的剪贴板（少数应用）未测。
3. `text/rtf` 口味未测（Word 实际还会写 RTF；本族按 HTML 口味口径）。
4. 富文本里的 `<img>`、脚注、批注、修订痕迹等 Word 特有块未测。
5. 阅读模式 / 源码模式下的粘贴未测。
6. **表格单元格覆盖层内**的富文本粘贴（那一路有 `htmlInlineToMd` 白名单）未复验 —— 属 `table-daily` 族范围。
7. 剪贴板抢占场景下**产品自身**的行为未作为判据（抢占只被用来判"这次读数值作废"）。

---

## 六、尺子与通道（可信度说明）

- **注入**：不借产品自己的 `mpHost.writeClipboard`（会自证循环），用仓里**已验证**的 raw-Win32 剪贴板尺子
  `cross-window-clipboard-ps.ps1`（错-14：在既有探针上加动词，不另起一支）。本族给它补了三个动词：
  `sethtml`（一次写 CF_HTML + CF_UNICODETEXT，与浏览器复制网页时同款口味）、`gethtml`、`seq`。
  **没有改动任何既有动词的行为**（改后 `get`/`img` 复跑正常）。
- **装弹四步**（错-13）：装弹 → **独立进程**回读（`gethtml` + `get` 各起一个 pwsh，落盘再读，不经 stdout）→ 按键 → 再回读。
  任一环节与载荷不符 ⇒ 判被抢占、Ctrl+Z 还原、重装重试。本族共记到 **23 次抢占**（发生在装弹前或按键前后都有）；
  最终采信的是 25 次按键里**载荷信封与本次用例逐字相符**的那些（有效 20 个用例 = 20/20 都有这样一次按键）。别的族同时在抢同一块剪贴板，实测序号在两次读之间跳 5~11。
- **两把尺子互校**（错-3）：内容尺子（`StartFragment/EndFragment` 按**字节偏移**切片，必须与载荷逐字相等）+ 序号尺子（`GetClipboardSequenceNumber`）。
- **上下文判定读引擎结果**（错-15）："光标在不在围栏内"一律读 `.cm-line` 上引擎渲染出的 `mp-code` 类（不是自己数围栏）。
- **一组读数一次 evaluate**（错-7）：文档全文 / 选区 / 每行文本 / 渲染行类 / 活动行类 / 焦点 / toast / `__inlineMarks()` / paste 事件日志，全部在 `READ_ALL` 一次返回。
- **归因通道**：产品的 paste 处理器注册在 `document` 的**捕获**相（产物 bundle 里就是紧跟在接管分支后面的 `document.addEventListener("paste",R,!0)`），CM6 默认粘贴挂在更深的 contentDOM 上；
  同 target 同相按注册顺序执行 ⇒ 我在产品**之后**注册的 document 捕获监听，其 `defaultPrevented` 就是**产品这一家的判决**。这条给出了 RP-1（`true`＝产品吞的）与 RP-2（`false`＝产品没接管）的根因分野。
- **使用中的尺子更动（如实记，错-3 第 4 条口径）**：
  1. `READ_ALL` 的 toast 可见性最初写成 `offsetParent !== null`。**错**：`position: fixed` 元素的 `offsetParent` 恒为 `null`，判出来恒不可见。
     已改为 `getComputedStyle(e).display !== 'none'`。该错**没有**影响本报告任何结论（结论不依赖 toast，toast 只在 W2 当旁证用）。
  2. `rich-paste-analyze.cjs` 第一版取 paste 日志里**第一条** capture 记录判"载荷是否到达"，在重试过的用例上会取到被抢占那一次的记录
     （W5 因此被误判为"载荷没到"）。已改为"**统计带本载荷信封长度的按键数 / 总按键数**"。
- **夹具**：正文夹具＝`前置段落。` + 空行 + `后置段落。`（落点＝2 号空行）；围栏夹具＝`正文段落。` + 空行 + 一个 js 围栏（内含 `const a = 1;`）+ 空行 + `尾部段落。`（围栏内落点＝第 4 行第 5 列）。落点用**真实鼠标点击**（先读引擎给的 `coordsAtPos` 再点），点后断言 `activeElement` 在编辑面内、`head` 等于期望位。

---

## 七、证据路径

| 类别 | 路径 |
|---|---|
| 探针 | `.mp-verify/checklist/rich-paste-lib.cjs`、`rich-paste-payloads.cjs`、`rich-paste-1-web.cjs`、`rich-paste-1b-web-rerun.cjs`、`rich-paste-2-word.cjs`、`rich-paste-3-attrib.cjs`、`rich-paste-analyze.cjs` |
| 剪贴板尺子（本族补的动词） | `.mp-verify/checklist/cross-window-clipboard-ps.ps1`（`sethtml`/`gethtml`/`seq`） |
| 原始读数 | `rich-paste/web/result.json`、`rich-paste/web1b/result.json`、`rich-paste/word/result.json`、`rich-paste/attrib/result.json`、`rich-paste-summary.json` |
| 日志 | `rich-paste-1-web.log`、`rich-paste-1b-web-rerun.log`、`rich-paste-2-word.log`、`rich-paste-3-attrib.log`、`rich-paste-analyze.log` |
| 截图（21 张） | `rich-paste/web/shots/`、`rich-paste/web1b/shots/`、`rich-paste/word/shots/`、`rich-paste/attrib/shots/` |
| 壳层 trace | `rich-paste/{web,web1b,word,attrib}/profile/main-debug.log` |
| 进程收尾 | 复查：命令行含 `rich-paste` 的残留 `MarkPilot.exe` **0 个**（其余在跑的属于别族探针） |
