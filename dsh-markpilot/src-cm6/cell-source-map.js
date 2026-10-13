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
