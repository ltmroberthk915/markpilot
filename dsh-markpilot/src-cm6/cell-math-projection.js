// 【活动格混排投影】活动格里"文字照源码、公式照排版"，只打开光标/点击命中的那一条。
//
// 为什么需要它：旧实现把整格源码一把写进 contenteditable（`div.textContent = 格文本`），
// 混排格（前文 $a_1$ 中间 $b^2$ 尾文）里每条公式都只能以 `$…$` 字面出现。而直接把 KaTeX
// DOM 混进同一个 contenteditable，`textContent` 就会掺进渲染出来的字形 ⇒ 镜像 diff、sizer、
// 覆盖率判定全部被污染、源码被写坏。所以 atom 必须是**可识别的叶子**：
//   · 未打开的公式在编辑面里是一个 `span.mp-cell-atom`（contenteditable=false），
//     `dataset.mpCellSrc` 保存它原来的 Markdown（`$…$` / `$$…$$`），KaTeX DOM 只住在里面；
//   · 读文本一律走 main.js 的 cellEditPlainText：文字按字符、atom 按它自己的源码长度 ⇒
//     **纯文本坐标与旧实现的 `textContent` 逐字节一致**，选区/镜像/撤销/IME 不用第二套坐标；
//   · 打开的那一条以纯文本源码出现（可编辑、原生 IME/撤销），其余保持排版。
//
// 本文件是纯逻辑（不碰 DOM、不碰 KaTeX）：落码、单测与探针共用同一份规则。
import { inlineMathSpans } from './inline-format.js';

/** 已排版公式在 DOM 里的识别类名（atom 叶子）。 */
export const CELL_ATOM_CLASS = 'mp-cell-atom';

/** "整格显示源码、一个 atom 都不留"（Ctrl+E 全选的既有契约：getSelection().toString() 必须是
 *  该格源码）。与"没有公式打开"(-1) 是两件事，故用独立值。 */
export const CELL_OPEN_ALL = -2;

/** 把格文本切成文字段与公式段。
 *  · `renderable(tex, display)` 由调用方注入（真实渲染器的成功判定）；省略时一律可排版。
 *    解析失败的公式不排版、按字面源码留在文字流里（与正文"宁可显示源码"同口径）。
 *  · display 口径与 cellMathTarget 同源：只有**整格** `$$…$$` 才是块级；
 *    混在文字里的 `$$…$$` 在格内与正文行中一样保持行内。
 *  · `lead` 记下整格 display 被 trim 掉的前导空白，供 tex 偏移回映射。 */
export function cellMathParts(text, renderable = null) {
  const source = String(text ?? '');
  const parts = [];
  let pos = 0;
  const first = source.length - source.trimStart().length;
  const last = first + source.trim().length;
  if (source.includes('$')) {
    for (const span of inlineMathSpans(source)) {
      if (!span.tex || !span.tex.trim()) continue;                // `$$` / `$ $`：只有定界符，按字面文字
      if (span.from < pos || span.to > source.length) continue;   // 防御：重叠/越界不切
      if (span.from > pos) parts.push({ kind: 'text', from: pos, to: span.from });
      const display = span.width === 2 && span.from === first && span.to === last;
      const lead = display ? span.tex.length - span.tex.trimStart().length : 0;
      const tex = display ? span.tex.trim() : span.tex;
      parts.push({ kind: 'math', from: span.from, to: span.to, width: span.width,
        lead, tex, display, renderable: !renderable || renderable(tex, display) !== false });
      pos = span.to;
    }
  }
  if (pos < source.length) parts.push({ kind: 'text', from: pos, to: source.length });
  return parts;
}

/** 本次绘制哪些公式收成 atom。
 *  openIndex＝要打开的那一条（parts 下标；-1＝一条都不打开）；CELL_OPEN_ALL＝全部摊成源码。 */
export function atomizedParts(parts, openIndex) {
  return parts.map((part, index) => ({
    ...part,
    atom: part.kind === 'math' && part.renderable !== false &&
      openIndex !== CELL_OPEN_ALL && index !== openIndex &&
      !(Array.isArray(openIndex) && openIndex.includes(index)),
  }));
}

/** 光标应打开哪一条公式（parts 下标；-1＝全部保持排版）。
 *  · 严格在公式源码内部 ⇒ 打开（正在写它）；
 *  · 正好在开定界符之前（caret === from）⇒ 打开：这是"方向键走进公式"的入口，
 *    与正文 region-session 的 ownsMathHead 同一条直觉；
 *  · 正好在收尾 `$` 之后（caret === to）⇒ **不**打开：点公式右侧的文字不该把公式摊开；
 *    整块 display 例外（它独占一格、光标只有两端，摊开才是可编辑的）；
 *  · caret 非数字 ⇒ -1（调用方在"有选区/拖选"时也不打开，与既有"选区中不叠卡片"同源）。 */
export function openMathIndex(parts, caret, { includeStart = true } = {}) {
  const c = Number(caret);
  if (!Number.isFinite(c)) return -1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind !== 'math' || part.renderable === false) continue;
    if (c > part.from && c < part.to) return i;
    if (includeStart && c === part.from) return i;
    if (part.display && c === part.to) return i;
  }
  return -1;
}

/** KaTeX 内 glyph 偏移 → 格文本坐标。tex 已按 display 口径 trim 过，`lead` 补回被 trim 掉的
 *  前导空白；越界一律钳进这条公式自己的源码区间（绝不让点击把光标甩到公式外）。 */
export function texOffsetToCell(part, texOffset) {
  const width = part.width || 1;
  const lead = part.lead || 0;
  const inner = part.tex.length;
  const t = Number.isFinite(texOffset) ? Math.max(0, Math.min(inner, Math.round(texOffset))) : 0;
  return Math.max(part.from, Math.min(part.to, part.from + width + lead + t));
}

/* ── 绘制计划与纯文本读取（与 main.js 的 DOM 适配共用同一条规则） ─────────────
 * `plan` 是编辑面内容**唯一**的说明：文字段给原文、公式段给 Markdown 与 tex。
 * 两件事因此可以被单测钉住（而不是只能靠肉眼看界面）：
 *   · 哪些公式被排版、每个原子携带的原文是哪一段；
 *   · 把计划读回纯文本必须逐字节等于格文本（镜像/选区/撤销全靠这一条）。
 * `renderable` 必须与调用方决定"打开哪一条"时用的**同一个**判定，否则计划里的原子
 * 与 tex 会错位（把不可渲染的公式拿去 KaTeX，或反过来）。 */
export function cellSurfacePlan(text, openIndex, renderable = null) {
  const source = String(text ?? '');
  return atomizedParts(cellMathParts(source, renderable), openIndex).map(part => (part.atom
    ? { kind: 'atom', src: source.slice(part.from, part.to), tex: part.tex,
      display: !!part.display, from: part.from, to: part.to }
    : { kind: 'text', src: source.slice(part.from, part.to), from: part.from, to: part.to }));
}

/** 计划 → 纯文本（atom 贡献它自己的 Markdown）。与 DOM 读取器同一口径。 */
export function surfacePlanText(plan) {
  let out = '';
  for (const segment of plan || []) out += segment.src;
  return out;
}

/* ── 复制/剪切：选区 → 原始 Markdown（copy 与 cut 共用同一条规则） ────────────
 * 规则表：纯文本坐标区间 [from,to) 与每个计划段落求交。
 *   · 文字段：取交集子串（与原字符逐字节一致）；
 *   · 原子：**交集非空就整条**给出它的源码（公式是原子，半条 `$a_` 没有意义，
 *     也不能给 KaTeX 字形 —— 那就是闭合公式原文丢失的根因）。
 * 于是"选区从公式中间开始/结束"也能得到闭合的 `$…$`。 */
export function planSlice(plan, from, to) {
  const lo = Math.max(0, Math.round(Number(from) || 0));
  const hi = Math.max(0, Math.round(Number(to) || 0));
  if (!(hi > lo)) return '';                    // 反向/空区间：没有内容可复制
  let out = '';
  for (const segment of plan || []) {
    const start = segment.from, end = start + segment.src.length;
    if (end <= lo || start >= hi) continue;
    if (segment.kind === 'atom') { out += segment.src; continue; }
    const a = Math.max(lo, start) - start, b = Math.min(hi, end) - start;
    if (b > a) out += segment.src.slice(a, b);
  }
  return out;
}
/** 纯文本坐标 → 计划内的段落位置（caret 落点；落在原子内部时按 preferAfter 贴边）。 */
export function planBoundary(plan, offset, preferAfter = true) {
  let rest = Math.max(0, Math.round(Number(offset) || 0));
  let index = 0;
  for (const segment of plan || []) {
    const len = segment.src.length;
    if (rest <= 0) return { index, offset: 0 };
    if (rest < len) return { index, offset: segment.kind === 'atom' ? (preferAfter ? 1 : 0) : rest };
    if (rest === len) return { index, offset: segment.kind === 'atom' ? 1 : len };
    rest -= len; index++;
  }
  return { index: Math.max(0, (plan || []).length - 1), offset: 0 };
}

/* ── 是否要重铺：**按原子的源码值对账**，不按缓存里的 from/to 切新文本 ─────────
 * 旧写法用上一次 parts 的 from/to 去切**新** text：只要在公式**之前**插一个普通字，
 * 所有偏移右移一位，切出来的串必然不同 ⇒ 每条键都把全部公式重建一次（KaTeX 白跑、节点全换、
 * 内存抖动）。这里只比较"当前 DOM 里每个原子携带的 Markdown"与"这一帧该有的原子列表"，
 * 与偏移无关：插字只改文字段长度，原子串逐条不变 ⇒ 保留已挂节点。 */
export function surfaceMatches(open, liveAtoms, desiredOpen, desiredAtoms) {
  if (open !== desiredOpen) return false;
  const live = Array.isArray(liveAtoms) ? liveAtoms : [];
  const want = Array.isArray(desiredAtoms) ? desiredAtoms : [];
  if (live.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) if (live[i] !== want[i]) return false;
  return true;
}
