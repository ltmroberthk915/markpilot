// The cell editor shows literal pipes; Markdown stores each as \|.
// All offsets are UTF-16 boundaries, matching EditorState and DOM Range.
export function mappedCellSource(source) {
  let text = '';
  const offsets = [0];
  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && source[i + 1] === '|') {
      text += '|'; i += 2;
    } else {
      text += source[i++];
    }
    offsets.push(i);
  }
  return { text, offsets };
}

export function encodeCellText(text) { return text.replace(/\|/g, '\\|'); }

export function cellSourceOffset(mapped, offset) {
  return mapped.offsets[Math.max(0, Math.min(mapped.text.length, Math.round(offset)))];
}

export function cellTextOffset(mapped, offset, assoc = 1) {
  const offsets = mapped.offsets;
  let lo = 0, hi = offsets.length - 1;
  offset = Math.max(0, Math.min(offsets[hi], offset));
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < offset) lo = mid + 1; else hi = mid;
  }
  return offsets[lo] === offset || assoc > 0 ? lo : Math.max(0, lo - 1);
}

export function cellTextChange(source, text) {
  const next = encodeCellText(text);
  if (next === source) return null;
  let from = 0, suffix = 0;
  while (from < source.length && from < next.length && source[from] === next[from]) from++;
  while (suffix < source.length - from && suffix < next.length - from &&
    source[source.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  return { from, to: source.length - suffix, insert: next.slice(from, next.length - suffix), source: next };
}

/* 【editing-3616·可见内容边界】格源码段（cellRangesOf 的 [from,to]）两端带着 Markdown 填充空白，
   WYSIWYG 格与覆盖层里都不可见（渲染口径 parseTableRow 是 trim 后的文本）。Home/End 若按原生
   contenteditable 语义走到原始末端，退格吃掉的就是填充空白而不是可见尾字符（真人实测
   dblclick→End→Backspace→输入 3 落盘 `| … | 7423|`，本意 743）。这里给出可见内容两侧的
   文本坐标（与 cellDOMSelection/setCellDOMSelection 同一套覆盖层文本坐标系）：
     · 正常格：start=去前导空白后首字符、end=去尾空白后末字符（内部空白是内容，不动）；
     · 全空白/空格：退化为原始两端 —— 没有可见内容可越界，保持原生可达，不制造"按 End 没反应"。
   口径与产品既有约定同源：tables.js cellAnchor/gotoCell 跳前导空白、main.js 格内格式键
   （Ctrl+B/I/U）收窄选区用的正是 trimStart/trimEnd 这一对边界。 */
export function cellContentSpan(text) {
  const t = String(text == null ? '' : text);
  const lead = t.length - t.trimStart().length;
  const tail = t.length - t.trimEnd().length;
  const last = t.length - tail;
  return { start: Math.min(lead, last), end: Math.max(lead, last) };
}

/** 覆盖层内 Home/End 的光标落点：extend=true（Shift）保留 DOM 锚点、只把 head 移到可见边界，
    伸缩方向由既有锚点自然决定（anchor 在前/在后都对）；否则折叠到边界。IME 组字键由调用方
    （keydown 的 isComposing/229 分支）先行拦截，不会走到这里。 */
export function cellCaretEdge(text, key, extend, anchor) {
  const span = cellContentSpan(text);
  const head = key === 'End' ? span.end : span.start;
  return { anchor: extend ? anchor : head, head };
}
