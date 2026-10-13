// Coordinates use UTF-16, just like CodeMirror and KaTeX source maps.
// Parts carry the original document start of the text that survives normalization.
export function mappedMathSource(parts, fallbackFrom = parts[0]?.from ?? 0) {
  let raw = '';
  const starts = [];
  for (let i = 0; i < parts.length; i++) {
    starts.push({ offset: raw.length, docFrom: parts[i].from });
    raw += parts[i].text + (i + 1 < parts.length ? '\n' : '');
  }
  const lead = raw.length - raw.trimStart().length;
  const tex = raw.trim();
  const texMap = starts.filter(p => p.offset <= lead + tex.length)
    .map(p => ({ offset: p.offset - lead, docFrom: p.docFrom }));
  const span = { tex, texMap };
  return { ...span, texFrom: tex ? mathSourcePosition(span, 0) : fallbackFrom };
}

export function mathSourcePosition(span, offset) {
  const pos = Math.max(0, Math.min(offset, span.tex.length));
  const map = span.texMap;
  if (!map?.length) return span.texFrom + pos;
  let lo = 0, hi = map.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (map[mid].offset <= pos) lo = mid; else hi = mid;
  }
  return map[lo].docFrom + pos - map[lo].offset;
}
