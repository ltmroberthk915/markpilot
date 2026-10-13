// 表格三键（CM6 文本级——Tab 在单元格间跳，Shift-Tab 回跳，表格行尾 Enter 续出一行同列数空行）
//
// 判据：当前行是表格行（以 | 分隔，且上下文存在分隔行 |---|）。纯文本操作：跳格＝把光标
// 移到下一单元格内容的起点；行尾 Enter＝按当前行列数生成 "| | |" 空行。无 DOM 结构魔法。

import { EditorSelection, Prec } from "@codemirror/state";
import { codeBlockAt } from './markdown-context.js';
export { fenceAt, isFenceAt } from './markdown-context.js';
import { keymap } from "@codemirror/view";

/* 【引用区表格·2026-10-08】**表块前缀**（`> ` / `>> ` / `> >` / 前导缩进）的唯一判定点。
 *  所有"哪一段算表格"的判据（渲染层 scanTables、本文件的块/格、扩展包的行列命令）都必须先跳它，
 *  否则引用区里的表格在每一层都被当成普通段落（用户报障：整段裸源码）。
 *  返回 `{ off, q }`：off ＝ 前缀字符数；q ＝ 前缀原文（相邻行必须逐字相同才算同一张表/同一个引用层级）。
 *  ⚠️ 前缀**不含表头行首那根管道**：`> | a | b |` 与 `>|a|b|` 必须得到同一组格。
 *  旧写法 `(?:>[ \t]?)+` 会把 `> ` 之后的 `|` 一起吃掉（off=3）⇒ 首格区间整体左移一位、
 *  首格凭空多出一个 `>`（3.0.4 装机实测：引用区表格首列印着 `>`）。 */
export function tableLead(t) {
  const m = /^[ \t]*>+(?:[ \t]+>+)*[ \t]?/.exec(t);
  return m ? { off: m[0].length, q: m[0] } : { off: 0, q: "" };
}
/** 把前缀原样拼回一行（改写表格时必须保留，否则一保存就把引用层级删了）。 */
export const withTableLead = (q, body) => (q || "") + body;

/* 【ARCH §3-① 唯一围栏判据·2026-10-08】围栏判定**只此一处**。
 *  来由：`scanLineStyles`（行级 class：mp-code / mp-fence）与 `scanInlineMarks`（"围栏内不投影" + 隐藏引用前缀）
 *  各写了一份 `/^\s*(```|~~~)/` 与**各自的翻转状态**。两处独立翻转 ⇒ 迟早漂移；
 *  历史症状：只改了行样式那一处，围栏行仍走 `if (inFence) continue` 把整行跳过 ⇒
 *  引用区代码块里的字面 `> ` 留在屏幕上（E 那批踩过）。现在两处**只消费这一个函数**。
 *
 *  入参口径：**已去引用前缀的内容行**（调用方先过 `tableLead()`）。
 *  前缀必须由调用方剥掉，因为 `> ```js ` 里的围栏只有剥掉前缀之后才看得见（这正是 E 的第二处根因）。 */

/* 【分隔行·2026-10-08】短横三种写法都认：ASCII `-`、en dash `–`(U+2013)、em dash `—`(U+2014)。
 *  来由：用户手写表格常用全角破折号写分隔行（`| —— | —— |`），旧判据只认 ASCII 短横
 *  ⇒ 整张表被判成普通段落、**整段裸源码**（3.0.5 装机实测复现，见 LOG-3.0.5 §2）。
 *  放宽方向与 A4c 一致：多认一种分隔行只会让"本来就该是表"的东西渲染成表，
 *  不会把普通段落误判成表（判据仍要求行内有**裸管道**、且与表头行相邻、前缀逐字相同）。 */
const DASHES = "\\-\\u2013\\u2014";
export const SEPARATOR_BODY_RE = new RegExp("^\\s*\\|?[\\s:|" + DASHES + "]*[" + DASHES + "][\\s:|" + DASHES + "]*\\|?\\s*$");
export const isSeparatorBody = (body) => SEPARATOR_BODY_RE.test(body) && new RegExp("[" + DASHES + "]").test(body);

/* 【列宽估算·2026-10-08】表格列宽按"**看得见的宽度**"分配，不按 markdown 源码字符数。
 *  旧口径直接数源码长度 ⇒ `$v_t=P\,v_{t+1}$`（15 字符）被当成 15 个拉丁字宽，而它渲染出来只有 9 个；
 *  引用区表格里这种格子扎堆时中文列被压到 **89px**、表头「名称」竖排成两行
 *  （用户 3.0.5 装机截图：第一列被压成一字宽）。这里先剥掉不显示的字形（`$`、`**`、反引号），
 *  再把 CJK/全角算 2 个单位宽（≈ 两个拉丁字符），与真实排版比例基本一致。 */
export function displayWidth(s) {
  let t = String(s == null ? "" : s);
  t = t.replace(/\$+/g, "");                     // 数学定界符不显示
  t = t.replace(/\]\(\s*<[^>]*>\s*\)/g, "]");    // 图片/长链接的 URL 折算掉
  t = t.replace(/\]\([^)]*\)/g, "]");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/[*_~]{1,3}/g, "");
  t = t.replace(/\\([A-Za-z]+)/g, "$1");         // `\partial` → `partial`（渲染后是 ∂，取保守值）
  let n = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;   // ZWJ / 变体选择符
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000;
    n += wide ? 2 : 1;
  }
  return n;
}
/** 按显示宽度分配列宽（百分比，和为 100）。
 *  `minPercent` 是每列的**下限**（防止窄窗口下中文列被压成"一字一行"）；
 *  下限吃掉的部分按剩余权重从宽列里扣——宽列（TeX 长格）本来就富余。 */
export function fitWidths(weights, minPercent = 0) {
  const w = weights.map((x) => Math.max(1, Number(x) || 1));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let pct = w.map((x) => (x / total) * 100);
  const floor = Math.max(0, Math.min(40, minPercent));
  for (let pass = 0; pass < 4; pass++) {
    const deficit = pct.reduce((a, p) => a + Math.max(0, floor - p), 0);
    if (deficit <= 0.01) break;
    const spare = pct.reduce((a, p) => a + Math.max(0, p - floor), 0);
    if (spare <= 0.01) break;
    pct = pct.map((p) => (p >= floor ? p - (deficit * (p - floor)) / spare : floor));
  }
  return pct.map((p) => Math.round(p * 10) / 10);
}

/* 【A4c】与渲染层同一条分隔行判据（`main.js` scanTables 的 isSep）：首尾管道可选、短横 ≥1 即可
 *  （2026-10-08 起短横含 en/em dash，见上）。 */
const isSeparatorText = (t) => isSeparatorBody(t);
/* （原 `CELL_RE` 随 P0 口径收口删除：新算法内联扫描，不再需要正则） */

/** 当前行所属的**整张表块**（向后/向前把连续的含 `|` 行收进来，块内有分隔行才算表）。
 *  【A1 修正】改前 `isTableContext` 只看上下各一行 ⇒ **只有表头行与第一数据行**算"表内"：
 *  第 2 数据行起 Tab 不换格（对抗复核点名），我新加的"表内回车由我们消费"也覆盖不到后面的行
 *  ⇒ 那些行按 Enter 仍会被默认键位劈开。现在按**整块**判定。
 *  【引用区·2026-10-08】收块时必须**同引用前缀**：`> | a |` 与表外 `| b |` 不是同一张表；
 *  跨层级收块会让"分隔行在上一层、数据行在下一层"的伪块被认成表，Enter/Tab 就作用错地方。 */
export function tableBlockOf(state, lineNumber) {
  if (codeBlockAt(state, state.doc.line(lineNumber).from)) return null;
  const base = tableLead(state.doc.line(lineNumber).text);
  const rowOf = (n) => {
    const line = state.doc.line(n);
    if (codeBlockAt(state, line.from)) return null;
    const ld = tableLead(line.text);
    return ld.q === base.q && line.text.slice(ld.off).includes("|") ? { text: line.text.slice(ld.off) } : null;
  };
  let a = lineNumber, b = lineNumber;
  while (a > 1 && rowOf(a - 1)) a--;
  while (b < state.doc.lines && rowOf(b + 1)) b++;
  let sep = -1;
  for (let n = a; n <= b; n++) { const r = rowOf(n); if (r && isSeparatorText(r.text)) { sep = n; break; } }
  if (sep < 0) return null;                    // 块里没有分隔行 ⇒ 不是表格
  return { from: a, to: b, sep };
}

function isTableContext(state) {
  if (state.selection.ranges.length !== 1) return null;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const block = tableBlockOf(state, line.number);
  if (!block) return null;
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  return { line, prev, next, block };
}

/** 当前行内的单元格边界数组（cells[i] = [start,end) 内容区）。
 *  【β1·P0 口径收口】与渲染层 `main.js` 的 `cellRangesOf` **逐字同构**：
 *   · 前导管道**可有可无** —— 改前这里把「收集到的第一根裸管道」当首管道，
 *     于是无前导管道的行 `甲 | 乙 |` 只算出 **1 格**（正确 2 格），而渲染层/覆盖层/命令层都算 2 格；
 *     后果是 `tabNextCell` 直接 return false、焦点被浏览器 Tab 遍历带走；
 *   · 转义 `\|` 不算边界（Q9 口径）；
 *   · 末尾段**仅在非空时**成格（与渲染层一致，不再用 "行尾没有 | 就补一格" 这条旧规则）。 */
function cellRanges(line) {
  const text = line.text;
  const skip = tableLead(text).off;             // 【引用区】`> ` 不是格内容
  const m = /^\s*\|/.exec(text.slice(skip));
  let i = skip + (m ? m[0].length : 0);
  const cells = [];
  let segStart = i;
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "|") { i += 2; continue; }
    if (text[i] === "|") {
      cells.push([line.from + segStart, line.from + i]);
      segStart = i + 1;
    }
    i++;
  }
  /* 【β1·P0-①】末尾段**纯空白则丢弃**：渲染层 `parseTableRow` 的结尾 `\s*` 会把尾管道后的
     空白吃掉 ⇒ 同一行 `| a | b |␣␣` 渲染 2 格、旧算法 3 格；那个纯空白"幻影格"会让 Tab 走到不存在
     的格、Enter 补出列数不对的新行、覆盖层定位到不存在的 td 后 `display:none`（编辑面凭空消失）。 */
  const tail = text.slice(segStart);
  if (tail.trim()) cells.push([line.from + segStart, line.from + text.length]);
  return cells;
}

function cellIndexAt(cells, pos) {
  /* 【β1·P0-②】三段判定。旧写法是"±1 容差一次过 + 兜底写死末格"，两个毛病：
      · 兜底把"pos 在所有格之前"（缩进行的行首）和"在所有格之后"（真在末格）判成同一个答案
        ⇒ 缩进行行首按 Tab 被当成"已在末格"⇒ return false ⇒ **焦点被浏览器 Tab 遍历带走**；
      · 空格的 ±1 容差窗口会**先于**下一格的起点命中（`| 甲 || 乙 |` 的 pos=6 命中空格的窗口）
        ⇒ 反复停在同一个锚点、到不了第 3 格。
     顺序：① 格内容区间**严格**命中 → ② 格边界 ±1（光标贴着管道） → ③ **离 pos 最近的那一格**。 */
  for (let i = 0; i < cells.length; i++) {
    if (pos >= cells[i][0] && pos <= cells[i][1]) return i;
  }
  for (let i = 0; i < cells.length; i++) {
    if (pos >= cells[i][0] - 1 && pos <= cells[i][1] + 1) return i;
  }
  let best = 0, bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const d = pos < cells[i][0] ? cells[i][0] - pos : (pos > cells[i][1] ? pos - cells[i][1] : 0);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 跳到第 idx 个单元格内容起点（跳过空白）。 */
function cellAnchor(state, cells, idx) {
  idx = Math.max(0, Math.min(idx, cells.length - 1));
  const [from, to] = cells[idx];
  const text = state.doc.sliceString(from, to);
  const lead = text.length - text.trimStart().length;
  return EditorSelection.cursor(from + lead);
}

/* ══ β1 键位层：表行区间 / Enter 三态 / Tab 跨行 ═══════════════════════════
 *  下面这几个函数是**唯一**的三态与跨行实现：源码行路径（本文件的 keymap）与覆盖层路径
 *  （main.js 的 keydown 分支）都调 applyEnter / applyEnterBr / applyTab，不许各写一份。 */

/** 表行区间：**与渲染层 scanTables 同口径** —— 一张表＝分隔行及其上一行（表头）到块尾。
 *  块里位于表头之上的行（`--- | ---` 打头的那种块、引用层级不同的行）在渲染层是普通段落，
 *  键位层也必须不算表内（否则"屏幕上是段落、Tab 却按表格跳格"）。 */
function tableSpanOf(state, lineNumber) {
  const block = tableBlockOf(state, lineNumber);
  if (!block) return null;
  const headerNum = block.sep - 1;
  if (headerNum < block.from) return null;              // 块首就是分隔行 ⇒ 渲染层认不出这张表
  if (lineNumber < headerNum || lineNumber > block.to) return null;
  const headerLine = state.doc.line(headerNum);
  const headerCells = cellRanges(headerLine);
  if (headerCells.length < 2) return null;              // GFM：只有一格的"表"不存在
  return { block, headerNum, headerCells, cols: headerCells.length, lead: tableLead(headerLine.text).q };
}

/** 表内所有"格行"的行号：表头行 + 分隔行之后的每一行。**分隔行自己不是格行**（它没有 td）。 */
function rowsOfSpan(span) {
  const out = [span.headerNum];
  for (let n = span.block.sep + 1; n <= span.block.to; n++) out.push(n);
  return out;
}

/** 新建一行的源码文本：列数＝**表头列数**（Q10），引用前缀原样拼回。 */
function newRowText(span) {
  return withTableLead(span.lead, "|" + Array.from({ length: span.cols }, () => "  ").join("|") + "|");
}

/** 跳到某行第 n 格的内容起点（跳过前导空白）；返回落点读数。 */
function gotoCell(view, lineNumber, col) {
  const state = view.state;
  const line = state.doc.line(lineNumber);
  const ranges = cellRanges(line);
  if (!ranges.length) return null;
  const idx = col === "last" ? ranges.length - 1 : Math.max(0, Math.min(col, ranges.length - 1));
  const [a, b] = ranges[idx];
  const seg = line.text.slice(a - line.from, b - line.from);
  const pos = a + (seg.length - seg.trimStart().length);
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
  return { rowFrom: line.from, col: idx, cols: ranges.length, moved: true, pos };
}

/** 在表尾**追加一行**（只动表尾那一处，其它行逐字节不变 —— 不许走 rewriteTable，否则触发 Q8 整表重排）。 */
function appendRowAtEnd(view, col, extraChanges) {
  const state = view.state;
  const head = extraChanges ? extraChanges.head : state.selection.main.head;
  const span = tableSpanOf(state, state.doc.lineAt(head).number);
  if (!span) return null;
  const lastLine = state.doc.line(span.block.to);
  const text = newRowText(span);
  const newFrom = lastLine.to + 1;
  /* 落点用**与 cellRanges 同一套扫描**算（不写死 +3）：把新行当作一条"虚拟行"喂进去。 */
  const ranges = cellRanges({ text, from: newFrom });
  const idx = Math.max(0, Math.min(col, ranges.length - 1));
  const [a, b] = ranges[idx];
  const seg = text.slice(a - newFrom, b - newFrom);
  const pos = a + (seg.length - seg.trimStart().length);
  const changes = extraChanges && extraChanges.changes
    ? [...extraChanges.changes, { from: lastLine.to, insert: "\n" + text }]
    : { from: lastLine.to, insert: "\n" + text };
  view.dispatch({ changes, selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "input.table" });
  return { rowFrom: newFrom, col: idx, cols: ranges.length, appended: true, pos };
}

/** 裸 Enter 的落点解析（纯函数）：站到某格 / 追加一行 / null 表外。 */
function enterPlan(state, lineNumber, col) {
  const span = tableSpanOf(state, lineNumber);
  if (!span) return null;
  const rows = rowsOfSpan(span);
  if (lineNumber === span.block.sep) {                       // 分隔行 ⇒ 第一条数据行第 1 格
    const tgt = rows[1];
    if (tgt == null) return { append: true, col: 0, span };
    return { line: tgt, col: 0, span };
  }
  const at = rows.indexOf(lineNumber);
  if (at < 0) return null;
  if (at === rows.length - 1) return { append: true, col, span };   // 末条格行 ⇒ 追加一行
  const next = rows[at + 1];
  const cells = cellRanges(state.doc.line(next));
  return { line: next, col: Math.max(0, Math.min(col, cells.length - 1)), span };
}

/** 执行落点（必要时带一次删除/插入的 changes，**同一事务**）⇒ 落点读数。 */
function runEnterPlan(view, plan, extraChanges) {
  if (!plan) return null;
  if (plan.append) return appendRowAtEnd(view, plan.col, extraChanges);
  const state = view.state;
  const line = state.doc.line(plan.line);
  const ranges = cellRanges(line);
  const idx = Math.max(0, Math.min(plan.col, ranges.length - 1));
  const [a, b] = ranges[idx];
  const seg = line.text.slice(a - line.from, b - line.from);
  const pos = a + (seg.length - seg.trimStart().length);
  const spec = { selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "input.table" };
  if (extraChanges && extraChanges.changes) spec.changes = extraChanges.changes;
  view.dispatch(spec);
  return { rowFrom: line.from, col: idx, cols: ranges.length, moved: true, pos };
}

/** 【裸 Enter】表内下移一格 / 末条格行补行；表外返回 null（调用方把键让回默认键位）。
 *  选区（Q17 已定案）：完全落在本格内 ⇒ 删掉它，落点按删后的文档算；跨格/跨行 ⇒ **只折叠到 head**，
 *  一次按键绝不改管道数（结构安全优先于逐字对齐 Typora）。 */
export function applyEnter(view) {
  const state = view.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const span = tableSpanOf(state, line.number);
  if (!span) return null;
  const cells = cellRanges(line);
  const idx = cellIndexAt(cells, sel.head);
  if (!sel.empty) {
    const c = cells[idx];
    if (c && sel.from >= c[0] && sel.to <= c[1]) {
      const changes = { from: sel.from, to: sel.to, insert: "" };
      const st2 = state.update({ changes }).state;
      const plan = enterPlan(st2, line.number, idx);
      if (plan) return runEnterPlan(view, plan, { changes: [changes], head: sel.from });
      view.dispatch({ changes, selection: EditorSelection.cursor(sel.from) });
      return { rowFrom: line.from, col: idx, cols: cells.length, moved: false };
    }
    view.dispatch({ selection: EditorSelection.cursor(sel.head), scrollIntoView: true });
    return { rowFrom: line.from, col: idx, cols: cells.length, moved: false };
  }
  return runEnterPlan(view, enterPlan(state, line.number, idx), null);
}

/** 【Shift+Enter】格内换行：插入**字面四个字符** `<br>`（渲染白名单负责显示成换行）。
 *  分隔行上**拒绝**（消费掉、零改动）：往 `| --- |` 里插 `<br>` 会破坏分隔行判据 ⇒ 一次按键塌表。
 *  拒绝是**静默**的（用户按了没反应 ＝ 像坏了）⇒ 拒绝分支调一次 `tableHint()` 给一句提示。
 *  提示通道由引擎注入（`setTableHint`），本文件不认识状态栏——避免 tables.js ↔ main.js 循环依赖。 */
let tableHint = null;
/** 由 main.js 注入"给用户一句话提示"的实现（状态栏复用；未注入时静默，不影响功能）。 */
export function setTableHint(fn) { tableHint = typeof fn === "function" ? fn : null; }
export function applyEnterBr(view) {
  const state = view.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const span = tableSpanOf(state, line.number);
  if (!span) return null;
  if (line.number === span.block.sep) {
    try { if (tableHint) tableHint("分隔行不能插入换行"); } catch { /* 提示失败不影响拒绝本身 */ }
    return { rowFrom: line.from, rejected: true };
  }
  const cells = cellRanges(line);
  const idx = cellIndexAt(cells, sel.head);
  const insert = "<br>";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.cursor(sel.from + insert.length),
    scrollIntoView: true, userEvent: "input.table",
  });
  return { rowFrom: line.from, col: idx, cols: cells.length, moved: true, pos: sel.from + insert.length };
}

/** 【Tab / Shift+Tab】dir=+1 下一格、dir=-1 上一格；跨行跳过分隔行；末条格行追加一行；
 *  反向到表头 ⇒ 消费掉但不动（零改动、焦点不出编辑器）。表外返回 null（把键让回去）。 */
export function applyTab(view, dir) {
  const state = view.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const span = tableSpanOf(state, line.number);
  if (!span) return null;
  const rows = rowsOfSpan(span);
  const isSep = line.number === span.block.sep;
  const cells = cellRanges(line);
  const idx = isSep ? -1 : cellIndexAt(cells, sel.head);
  if (dir > 0) {
    if (!isSep && idx + 1 <= cells.length - 1) return gotoCell(view, line.number, idx + 1);
    const at = isSep ? 0 : rows.indexOf(line.number);
    const tgt = rows[at + 1];
    if (tgt == null) return appendRowAtEnd(view, 0, null);       // 末条格行 ⇒ 追加一行
    return gotoCell(view, tgt, 0);                                // 下一条格行第 1 格（自动跳过分隔行）
  }
  if (!isSep && idx - 1 >= 0) return gotoCell(view, line.number, idx - 1);
  if (isSep) return gotoCell(view, span.headerNum, "last");
  if (line.number === span.headerNum) return { rowFrom: line.from, col: 0, cols: cells.length, stopped: true };
  const at = rows.indexOf(line.number);
  const tgt = rows[at - 1];
  if (tgt == null) return { rowFrom: line.from, col: idx, cols: cells.length, stopped: true };
  return gotoCell(view, tgt, "last");
}

const tabKey = (dir) => (view) => applyTab(view, dir) != null;
const enterKey = (view) => applyEnter(view) != null;
const enterBrKey = (view) => applyEnterBr(view) != null;

/** 【A1】表尾出路：光标在表格**最后一行**时按 ↓ ⇒ 跳到表格后面那一行；表格就是文末时补一个空行。
 *  没有这条，A1 把"表内回车"消费掉之后，位于文档末尾的表格就再也出不来（对抗复核点名的陷阱）。 */
function exitTableDown(view) {
  const ctx = isTableContext(view.state);
  if (!ctx || !ctx.block) return false;
  if (ctx.line.number !== ctx.block.to) return false;   // 只在最后一行接管，其余位置让给默认
  const doc = view.state.doc;
  if (ctx.block.to < doc.lines) {
    const nextLine = doc.line(ctx.block.to + 1);
    view.dispatch({ selection: EditorSelection.cursor(Math.min(nextLine.from + nextLine.text.length, nextLine.to)), scrollIntoView: true });
    return true;
  }
  view.dispatch({ changes: { from: doc.length, insert: "\n" }, selection: EditorSelection.cursor(doc.length + 1), scrollIntoView: true });
  return true;
}

/* 【A1 优先级】必须 `Prec.high`：`basicSetup` 的默认键位（`Enter`→insertNewlineAndIndent 无条件
 * return true、`Mod-[`→indentLess…）排在扩展数组更前面，**同优先级先到先得** —— 不提优先级，
 * 这里的 `Enter` 与 `Mod-[`/`Mod-]` 就是死绑定（对抗复核用 CM6 库源码确认）。 */
export const tableKeys = Prec.high(keymap.of([
  /* 【β1】Tab / Shift+Tab 现在走同一个 applyTab（跨行 + 跳分隔行 + 末行补行 + 表头顶停住）。
     注意 shift: 必须显式给：CM6 只在给了 b.shift 时才注册 "Shift-<name>" 这条绑定
     （@codemirror/view/dist/index.js:9210-9211）—— Enter 少写 shift: 就是 Shift+Enter 劈表的根因。 */
  { key: "Tab", run: tabKey(+1), shift: tabKey(-1) },
  { key: "Mod-[", run: tabKey(-1) }, // 嵌入式替代键（Shift+Tab 可能被浏览器焦点遍历劫持，见 lists.js 注）
  { key: "Mod-]", run: tabKey(+1) },
  { key: "Enter", run: enterKey, shift: enterBrKey },
  { key: "ArrowDown", run: exitTableDown },
]));
