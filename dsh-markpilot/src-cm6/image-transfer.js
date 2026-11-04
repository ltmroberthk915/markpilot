// Copy sources are normalized to LF for the clipboard. Source positions are
// UTF-16 positions in the original document and point at rendered image marks
// or at relative Markdown link/reference spans (same plain-text coordinate
// system: offset + absolute position - range start).
import {regionsBetween} from './region-index.js';
import {inlineCodeSpans} from './inline-format.js';
export const imageTransferFlavor = 'application/x-markpilot-image-transfer';
const nativeTickets = new WeakMap();
const normalized = value => value.replace(/\r\n?/g, '\n');
const relativeTarget = target => !!target && !/^(?:[a-z][a-z0-9+.-]*:|[/\\]{2}|[#?])/i.test(target);
// Reference labels fold case and internal whitespace (CommonMark matching).
const foldLabel = label => label.trim().replace(/\s+/g, ' ').toLowerCase();
// Blockquote prefixes and fence markers, shared by every definition scanner.
const quoteLead = /^ {0,3}(?:> ?)+/;
const fenceMarker = /^ {0,3}(`{3,}|~{3,})/;
// Only external destinations the product already understands become
// self-contained on relocation: http(s) links and network images, mailto
// links. Any other scheme (file:, data:, javascript:, OS handlers), UNC
// paths and control characters keep their usages untouched — nothing
// auto-effective crosses notes, and explicit inline markup never changes.
const inlineableExternal = (target, isImage) =>
  (isImage ? /^https?:/i : /^https?:|^mailto:/i).test(target) && !/[\u0000-\u001f\u007f]/.test(target);
// The DSH bridge knows the document this iframe opened, but cannot vouch for
// paths in a different project. Keep one local receipt; never send the base,
// document token or a path to another frame or onto the clipboard.
let iframeCopy = null;
function dshBridge() {
  return window.__dshHost === true && window.__dshBridge?.protocolState ? window.__dshBridge : null;
}
function localOwner(bridge) {
  const state = bridge?.protocolState();
  return state?.docToken && !state.applying ? {doc:state.docToken, base:bridge.docBase()} : null;
}

// ── Relative Markdown links and reference-style images/links ────────────────
// Inline links, `![alt][key]` / `[text][key]` (full), `![alt][]` / `[text][]`
// (collapsed), `![alt]` / `[text]` (shorthand) and `[key]: dest` definition
// destinations are not engine image regions, so the selected lines are scanned
// directly. Usages bind to the first legal definition in the SOURCE document;
// fenced code, mermaid blocks, math spans and inline code never participate.
// Footnote labels (`[^…]`) are never treated as reference links.
function overlapsRegion(regions, from, to) {
  let lo = 0, hi = regions.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (regions[mid].to < from) lo = mid + 1; else hi = mid; }
  return lo < regions.length && regions[lo].from <= to;
}

// Destination plus optional title after `[label]:`. Returns null for anything
// that would not parse as a definition line, so first-legal-definition wins.
function parseDefinitionTail(text, pos) {
  const n = text.length;
  let i = pos;
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  let dest, destFrom, destTo;
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    if (end < 0) return null;
    dest = text.slice(i + 1, end); destFrom = i + 1; destTo = end;
    i = end + 1;
  } else {
    const start = i;
    while (i < n && text[i] !== ' ' && text[i] !== '\t') i++;
    if (i === start) return null;
    dest = text.slice(start, i); destFrom = start; destTo = i;
  }
  let title = '';
  let j = i;
  while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  if (j < n) {
    const quote = text[j];
    let end = -1;
    if (quote === '"' || quote === "'") {
      end = text.indexOf(quote, j + 1);
      if (end < 0) return null;
      title = text.slice(j + 1, end);
      end += 1;
    } else if (quote === '(') {
      let k = j + 1, depth = 0;
      while (k < n) {
        const ch = text[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        k++;
      }
      if (k >= n) return null;
      title = text.slice(j + 1, k);
      end = k + 1;
    } else return null; // Trailing prose invalidates the definition line.
    j = end;
  }
  while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  if (j < n) return null;
  return {dest, destFrom, destTo, title};
}

// Balanced-paren destination after `[text](`, mirroring the engine image scan.
function parseInlineDest(text, pos) {
  const n = text.length;
  let j = pos, depth = 0, end = -1;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '(') { depth++; j++; continue; }
    if (ch === ')') { if (depth === 0) { end = j; break; } depth--; j++; continue; }
    j++;
  }
  if (end < 0) return null;
  const literal = text.slice(pos, end);
  const leading = literal.length - literal.trimStart().length;
  let raw = literal.trim();
  const titled = /^(<[^>]*>|\S+)[ \t]+["']([^"']*)["'][ \t]*$/.exec(raw);
  if (titled) raw = titled[1];
  const angled = raw.length >= 2 && raw.startsWith('<') && raw.endsWith('>');
  const destFrom = pos + leading + (angled ? 1 : 0);
  const destTo = pos + leading + raw.length - (angled ? 1 : 0);
  return {end, dest: angled ? raw.slice(1, -1) : raw, destFrom, destTo};
}

// One full document line → candidate spans (line-local offsets). `ref`
// entries are usages whose label still needs a source definition; def/inline
// entries already know their relative destination and only need it relocated.
// defAt is where a definition label may start (after a blockquote prefix);
// the caller always passes complete original lines, so line-start context is
// real and a slice can never fake or truncate a token of its own.
function scanUsageLine(text, defAt = 0) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const open = text.indexOf('[', i);
    if (open < 0) break;
    if (open > 0 && text[open - 1] === '\\') { i = open + 1; continue; }
    const close = text.indexOf(']', open + 1);
    if (close < 0) break;
    const alt = text.slice(open + 1, close);
    if (alt.includes('[')) { i = open + 1; continue; } // Nested labels stay literal.
    const bang = open > 0 && text[open - 1] === '!' && (open < 2 || text[open - 2] !== '\\');
    if (!bang && close + 1 < n && text[close + 1] === ':') {
      // A definition relocates only its destination span; its label is not a
      // usage. Footnote definitions never carry resource destinations.
      if (open >= defAt && open <= defAt + 3 && text.slice(defAt, open).trim() === '') {
        const def = parseDefinitionTail(text, close + 2);
        if (def && !alt.startsWith('^')) out.push({kind: 'def', from: def.destFrom, to: def.destTo, dest: def.dest});
      }
      i = close + 1;
      continue;
    }
    const next = close + 1 < n ? text[close + 1] : '';
    if (next === '(') {
      const parsed = parseInlineDest(text, close + 2);
      if (!parsed) { i = close + 1; continue; }
      // Inline image destinations belong to the engine's image regions.
      if (!bang) out.push({kind: 'inline', from: parsed.destFrom, to: parsed.destTo, dest: parsed.dest});
      i = parsed.end + 1;
      continue;
    }
    if (next === '[') {
      const close2 = text.indexOf(']', close + 2);
      if (close2 < 0) { i = close + 1; continue; }
      const label = text.slice(close + 2, close2).trim() || alt.trim();
      out.push({kind: 'ref', from: bang ? open - 1 : open, to: close2 + 1, label,
        head: (bang ? '!' : '') + '[' + alt + ']'});
      i = close2 + 1;
      continue;
    }
    const label = alt.trim();
    if (label) out.push({kind: 'ref', from: bang ? open - 1 : open, to: close + 1, label,
      head: (bang ? '!' : '') + '[' + alt + ']'});
    i = close + 1;
  }
  return out;
}

// First legal definition per needed folded label, in document order. Fenced
// code, mermaid and math (including multi-line $$…$$) blocks never define;
// definitions behind blockquote prefixes (`> [key]: dest`) do bind — study
// notes keep their sources there — and each carries its line span so callers
// can tell whether it travels with the selection.
function collectDefinitions(state, index, needed) {
  const found = new Map();
  if (!needed.size) return found;
  const codeRegions = index?.byKind.get('code') || [];
  const diagramRegions = index?.byKind.get('mermaid') || [];
  const mathRegions = index?.byKind.get('math') || [];
  let from = 0;
  for (const text of state.doc.iterLines()) {
    const lineFrom = from, lineTo = from + text.length;
    from = lineTo + 1;
    if (!text.includes(']:')) continue;
    if (overlapsRegion(codeRegions, lineFrom, lineTo) || overlapsRegion(diagramRegions, lineFrom, lineTo) ||
        overlapsRegion(mathRegions, lineFrom, lineTo)) continue;
    const lead = quoteLead.exec(text);
    const body = lead ? text.slice(lead[0].length) : text;
    if (fenceMarker.test(body)) continue;
    const open = body.indexOf('[');
    const close = open >= 0 ? body.indexOf(']', open + 1) : -1;
    if (open < 0 || close < 0 || open > 3 || body.slice(0, open).trim() !== '' || body[close + 1] !== ':') continue;
    const label = body.slice(open + 1, close);
    if (!label || label.startsWith('^') || label.includes('[')) continue;
    const key = foldLabel(label);
    if (!needed.has(key) || found.has(key)) continue;
    const def = parseDefinitionTail(body, close + 2);
    if (!def) continue;
    found.set(key, {...def, lineFrom, lineTo});
    if (found.size === needed.size) return found;
  }
  return found;
}

function collectLinkRefs(state, index, range, offset, refs, pending) {
  const codeRegions = index?.byKind.get('code') || [];
  const diagramRegions = index?.byKind.get('mermaid') || [];
  const imageRegions = index?.byKind.get('image') || [];
  const doc = state.doc;
  // The character right after the range, in document coordinates: a usage
  // whose delimiters continue past the selection edge is not fully selected.
  const tail = state.sliceDoc(range.to, Math.min(range.to + 1, doc.length));
  let fence = null;
  // Tokens are parsed from the FULL original lines and admitted only when
  // they fall completely inside the selection, by real document positions. A
  // slice that starts or ends inside a token — a partial image cut that
  // happens to look like a plain `[a](fig.png)` link — never reconstructs a
  // token of its own, and engine-indexed image marks (remote included) keep
  // owning their brackets through the region path alone.
  for (let pos = range.from; pos < range.to; pos = doc.lineAt(pos).to + 1) {
    const docLine = doc.lineAt(pos), lineText = docLine.text;
    // Fences opened inside the selection (plain or behind blockquote
    // prefixes, where the region index may not model them) make their
    // content literal.
    const lead = quoteLead.exec(lineText);
    const marker = fenceMarker.exec(lead ? lineText.slice(lead[0].length) : lineText);
    if (!fence && marker) { fence = {char: marker[1][0], len: marker[1].length}; continue; }
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len) fence = null;
      continue;
    }
    if (!lineText.includes('[')) continue;
    if (overlapsRegion(codeRegions, docLine.from, docLine.to) ||
        overlapsRegion(diagramRegions, docLine.from, docLine.to)) continue;
    const codeSpans = inlineCodeSpans(lineText);
    for (const m of scanUsageLine(lineText, lead ? lead[0].length : 0)) {
      const absFrom = docLine.from + m.from, absTo = docLine.from + m.to;
      // Complete containment in the selection, by real positions.
      if (absFrom < range.from || absTo > range.to) continue;
      if (codeSpans.some(s => m.from < s.to && m.to > s.from)) continue;
      if (regionsBetween(index, absFrom, absTo, 'math').length) continue;
      // Engine-indexed image marks own their brackets; the region path is
      // the only writer for them, remote included.
      if (overlapsRegion(imageRegions, absFrom, absTo)) continue;
      if (absTo === range.to && (tail === '(' || tail === '[')) continue;
      const from = offset + absFrom - range.from, to = offset + absTo - range.from;
      const raw = state.sliceDoc(absFrom, absTo);
      if (m.kind === 'ref') {
        if (!m.label || m.label.startsWith('^')) continue;
        pending.push({from, to, raw, key: foldLabel(m.label), head: m.head});
      } else if (relativeTarget(m.dest)) {
        refs.push({from, to, raw: m.dest, target: m.dest});
      } else if (m.kind === 'def' && /^[?#]/.test(m.dest)) {
        // A traveling fragment-only definition gains the source note's own
        // file, so its anchors cannot be stolen by the destination's.
        refs.push({from, to, raw: m.dest, target: '', anchor: m.dest});
      }
    }
  }
}

// ── Destination-side label reconciliation ──────────────────────────────────
// A paste that carries definition lines must not shadow the destination's own
// same-label references: with first-definition-wins, an incoming `[fig]:`
// pasted above the destination's `[fig]:` silently rebinds every existing
// usage. Conflicting incoming definitions therefore get a fresh unused label
// (blockquote prefixes intact), their full/collapsed usages inside the pasted
// text follow the first renamed definition, and shorthand usages keep their
// text. Destination content outside the replaced ranges is never touched.
function rowsOfText(text) {
  const rows = [];
  let from = 0;
  for (const t of text.split('\n')) { rows.push({text: t, from}); from += t.length + 1; }
  return rows;
}
function unfencedRows(rows) {
  const out = [];
  let fence = null;
  for (const row of rows) {
    const lead = quoteLead.exec(row.text);
    const marker = fenceMarker.exec(lead ? row.text.slice(lead[0].length) : row.text);
    if (!fence && marker) { fence = {char: marker[1][0], len: marker[1].length}; continue; }
    if (fence) { if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len) fence = null; continue; }
    out.push(row);
  }
  return out;
}
function definitionRows(rows) {
  const out = [];
  for (const row of unfencedRows(rows)) {
    const lead = quoteLead.exec(row.text);
    const body = lead ? row.text.slice(lead[0].length) : row.text;
    const open = body.indexOf('[');
    const close = open >= 0 ? body.indexOf(']', open + 1) : -1;
    if (open < 0 || close < 0 || open > 3 || body.slice(0, open).trim() !== '' || body[close + 1] !== ':') continue;
    const label = body.slice(open + 1, close);
    if (!label || label.startsWith('^') || label.includes('[')) continue;
    const at = row.from + (lead ? lead[0].length : 0);
    out.push({key: foldLabel(label), label, labelStart: at + open, labelEnd: at + close + 1});
  }
  return out;
}
function usedLabelKeys(rows, into) {
  for (const row of unfencedRows(rows))
    for (const m of row.text.matchAll(/\[([^\]^[\n]*)\]/g)) { const key = foldLabel(m[1]); if (key) into.add(key); }
}
export function reconcilePastedDefinitions(text, destDoc, ranges = []) {
  const pastedRows = rowsOfText(text);
  const pastedDefs = definitionRows(pastedRows);
  if (!pastedDefs.length) return text;
  const destText = typeof destDoc === 'string' ? destDoc
    : destDoc.sliceString ? destDoc.sliceString(0, destDoc.length) : [...destDoc.iterLines()].join('\n');
  const destRows = rowsOfText(destText).map(row => ({...row,
    excluded: ranges.some(r => row.from < r.to && row.from + row.text.length > r.from)}));
  const destDefKeys = new Set();
  for (const row of unfencedRows(destRows)) {
    if (row.excluded) continue;
    for (const def of definitionRows([row])) destDefKeys.add(def.key);
  }
  const conflicts = [...new Set(pastedDefs.filter(d => destDefKeys.has(d.key)).map(d => d.key))];
  if (!conflicts.length) return text;
  const used = new Set(destDefKeys);
  usedLabelKeys(pastedRows, used);
  usedLabelKeys(rowsOfText(destText), used);
  const edits = [];
  for (const key of conflicts) {
    const own = pastedDefs.filter(d => d.key === key);
    let primary = null;
    for (const def of own) {
      let next = null;
      for (let n = 1; n <= 999 && !next; n++) {
        const candidate = def.label + '-' + n;
        if (!used.has(foldLabel(candidate))) next = candidate;
      }
      if (!next) continue; // Pathological label space: keep this one verbatim.
      used.add(foldLabel(next));
      edits.push({from: def.labelStart, to: def.labelEnd, insert: '[' + next + ']'});
      if (!primary) primary = next;
    }
    if (!primary) continue;
    for (const row of unfencedRows(pastedRows)) {
      for (const m of row.text.matchAll(/(!?)\[([^\]^[\n]*)\]\[([^\]\n]*)\]/g)) {
        const label = m[3].trim() || m[2].trim();
        if (!label || label.startsWith('^') || foldLabel(label) !== key) continue;
        const innerFrom = row.from + m.index + m[1].length + m[2].length + 3; // just after `][`
        const innerTo = innerFrom + m[3].length;
        edits.push({from: innerFrom, to: innerTo, insert: primary});
      }
    }
  }
  if (!edits.length) return text;
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  let at = 0;
  for (const e of edits) { if (e.from < at) continue; out.push(text.slice(at, e.from), e.insert); at = e.to; }
  out.push(text.slice(at));
  return out.join('');
}

export function sourceImageTicket(state, index, ranges, token, linewise = false) {
  const host = globalThis.window?.mpHost;
  const bridge = dshBridge();
  if (!(host?.rememberImageSource && window.__mpDocDir) && !bridge) return null;
  if (!ranges.length) return null;
  const images = index?.byKind.get('image') || [];
  let linkish = false;
  for (const range of ranges) if (state.sliceDoc(range.from, range.to).includes('[')) { linkish = true; break; }
  if (!images.length && !linkish) return null;
  const refs = [], pending = [];
  let offset = 0;
  for (const range of ranges) {
    const text = state.sliceDoc(range.from, range.to);
    if (images.length) for (const region of regionsBetween(index, range.from, range.to, 'image')) {
      const mark = region.data;
      if (!mark.image || !mark.payload || range.from > mark.from || range.to < mark.to ||
          !relativeTarget(mark.image.src)) continue;
      refs.push({from: offset + mark.payload[0] - range.from, to: offset + mark.payload[1] - range.from,
        raw: state.sliceDoc(...mark.payload), target: mark.image.src});
    }
    if (linkish && text.includes('[')) collectLinkRefs(state, index, range, offset, refs, pending);
    offset += range.to - range.from + 1;
  }
  if (pending.length) {
    const needed = new Set(pending.map(p => p.key));
    const defs = collectDefinitions(state, index, needed);
    for (const p of pending) {
      const def = defs.get(p.key);
      // A dangling label keeps its exact source text.
      if (!def) continue;
      // A definition that travels inside the selection keeps its reference
      // usages: only the definition's destination span relocates, and the
      // destination side renames conflicting labels so nothing rebinds.
      if (ranges.some(r => def.lineFrom >= r.from && def.lineTo <= r.to)) continue;
      if (relativeTarget(def.dest)) {
        refs.push({from: p.from, to: p.to, raw: p.raw, target: def.dest, head: p.head, title: def.title || ''});
      } else if (inlineableExternal(def.dest, p.head.startsWith('!'))) {
        // Remote and mailto destinations are never rewritten or fetched, but
        // their usages must not fall onto a same-label definition of another
        // note: they inline with the exact original URI, no network involved.
        // The scheme allowlist pairs with the shell receipt validation.
        refs.push({from: p.from, to: p.to, raw: p.raw, target: def.dest, head: p.head, title: def.title || '', verbatim: true});
      } else if (/^[?#]/.test(def.dest)) {
        // A same-document anchor keeps its explicit origin: the source note's
        // own fragment, never a stolen anchor of the destination.
        refs.push({from: p.from, to: p.to, raw: p.raw, target: '', anchor: def.dest, head: p.head, title: def.title || ''});
      }
    }
  }
  if (!refs.length) return null;
  refs.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  let units = 0;
  for (const ref of refs) {
    // Spans never overlap; a defensive drop keeps the stored ticket valid.
    if (merged.length && ref.from < merged[merged.length - 1].to) continue;
    const size = ref.raw.length + ref.target.length + (ref.anchor || '').length + (ref.head || '').length + (ref.title || '').length;
    if (merged.length >= 4096 || units + size > 512 * 1024) return 'unavailable';
    units += size;
    merged.push(ref);
  }
  if (bridge) {
    const owner = localOwner(bridge);
    if (!owner || !globalThis.crypto?.randomUUID) return 'unavailable';
    const id = 'dsh-' + crypto.randomUUID();
    iframeCopy = {id, owner, bridge};
    return id;
  }
  try {
    // Only selected source with a relative resource is fingerprinted. The
    // preload computes the digest locally; no selected prose is sent to IPC.
    const plain = ranges.map(r => normalized(state.sliceDoc(r.from, r.to))).join('\n');
    return token && host.rememberImageSource(token, {length: offset - 1, refs: merged, linewise}, plain) || 'unavailable';
  } catch { return 'unavailable'; }
}

export function beginNativeImageTransfer(event, state, index) {
  if (!event.isTrusted || !(window.mpHost?.rememberImageSource || dshBridge())) return null;
  const selected = state.selection.ranges.filter(r => !r.empty);
  // CodeMirror copies (but MarkPilot does not cut) whole lines for empty carets.
  const ranges = selected.length ? selected : event.type === 'copy' ?
    [...new Set(state.selection.ranges.map(r => state.doc.lineAt(r.from).number))].map(n => state.doc.line(n)) : [];
  const id = sourceImageTicket(state, index, ranges, window.mpHost?.eventClipboardIntent?.(event.type), !selected.length);
  if (id) nativeTickets.set(event, id);
  return id;
}
export function finishNativeImageTransfer(event) {
  const id = nativeTickets.get(event), cd = event.clipboardData;
  if (id && event.isTrusted && event.defaultPrevented && cd?.types.includes('text/plain') && !cd.types.includes('text/html')) {
    try { cd.setData(imageTransferFlavor, id); } catch { /* Plain source remains intact. */ }
    // Web clipboard implementations may strip private MIME types on transfer.
    // Preserve the opaque id in the standard literal HTML representation too.
    if (dshBridge()) try {
      const text = cd.getData('text/plain').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      cd.setData('text/html','<pre data-markpilot-source="markdown" data-markpilot-image-transfer="' + id + '">' + text + '</pre>');
    } catch { /* The receiver can use the private MIME representation. */ }
  }
}

export function readImageTransfer(id, value) {
  const plain = normalized(value);
  if (id.startsWith('dsh-')) {
    const bridge = dshBridge(), here = localOwner(bridge);
    return here && iframeCopy?.id === id && iframeCopy.bridge === bridge && iframeCopy.owner.doc === here.doc && iframeCopy.owner.base === here.base ?
      {text:plain,linewise:false} : null;
  }
  let result;
  try { result = window.mpHost?.recoverImageSource?.(id, plain); } catch { return null; }
  if (!result?.changes) return null;
  const chunks = [];
  let start = 0;
  for (const c of result.changes) {
    if (c.from < start || plain.slice(c.from,c.to) !== c.raw) return null;
    chunks.push(plain.slice(start,c.from),c.insert);
    start = c.to;
  }
  return {text: chunks.length ? chunks.join('') + plain.slice(start) : plain, linewise: result.linewise,
    crossDocument: result.sameDocument === false};
}

// Preserve CodeMirror's line distribution for matching multiple carets and
// its whole-line destination when the source was an empty-caret line copy.
export function applyImageTransfer(view, plain, moved, literalRange, EditorSelection) {
  const st = view.state, ranges = st.selection.ranges;
  const lines = moved.text.split('\n'), originals = plain.split('\n');
  const byLine = lines.length === ranges.length;
  const linewise = moved.linewise && ranges.every(r => r.empty);
  let index = 0, lastLine = -1;
  const changes = st.changeByRange(range => {
    const insert = literalRange(range) ? (byLine ? originals[index] : plain) : (byLine ? lines[index] : moved.text);
    if (linewise) {
      const line = st.doc.lineAt(range.from); if (line.number === lastLine) return {range};
      index++;
      lastLine = line.number;
      const content = st.toText((insert + '\n').replace(/\n/g, st.lineBreak));
      return {changes:{from:line.from, insert:content},range:EditorSelection.cursor(range.from + content.length, -1)};
    }
    index++;
    const content = st.toText(insert.replace(/\n/g, st.lineBreak));
    return {changes:{from:range.from, to:range.to, insert:content}, range:EditorSelection.cursor(range.from + content.length, -1)};
  });
  view.dispatch(changes, {userEvent:'input.paste', scrollIntoView:true});
}
