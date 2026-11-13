// B3 documents service: the host-side authority for the model `markdown` tool.
//
// This module deliberately owns no storage. It resolves one authority per call:
//   - a live room with at least one online editor  -> shared buffer (unsaved text)
//   - a clean room whose disk changed externally   -> disk
//   - a dirty room with no online editor           -> orphan, writes refused
//   - no room                                      -> disk
// A live edit is appended to the room log (never written to disk by this
// service); the editor applies it as a remote change and its normal save path
// persists it. A disk edit delegates to the existing guarded endpoints.
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const LIVE_REVISION = /^rev1:live:([^:]+):(\d+):([0-9a-f]{64})$/;
const DISK_PREFIX = 'rev1:disk:';
const MIRROR_PREFIX = 'rev1:mirror:';
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_REPLACE_ALL = 1000;
// Line-addressed reads/edits. A "line" is a maximal run without CR/LF plus the
// terminator that follows it; the empty line after a final newline (and the
// single empty line of an empty file) counts, matching CodeMirror/Typora line
// numbers. Offsets are UTF-16 code units into the authoritative text.
export const MAX_LINE_READ_LINES = 2000;
export const MAX_LINE_READ_BYTES = 256 * 1024;
export const MAX_LINE_READ_BYTES_CAP = 1024 * 1024;
const MAX_LINE_PREVIEW = 200;
const EOL_RE = /\r\n|\n|\r/;

const coded = (code, message, extra) => Object.assign(new Error(String(message)), { code, ...(extra || {}) });

export function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

export function normalizeEol(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

// Comparison-only normalization: provider text may carry a BOM and CRLF while
// the room stores decoded LF text (text-codec strips BOM + normalizes EOL).
export function normalizeCompare(text) {
  return normalizeEol(String(text)).replace(/^\uFEFF/, '');
}

// Revision identity must not depend on CRLF/BOM representation: a disk edit's
// token is built from provider text while a buffer edit's token is built from
// the decoded LF room text. Both sides use this normalized sha so a legitimate
// review chain survives crossing the disk/buffer boundary.
export function revisionTextSha(text) {
  return sha256Text(normalizeCompare(text));
}

export function makeLiveRevisionId(epoch, version, textSha) {
  if (typeof epoch !== 'string' || !epoch || !Number.isSafeInteger(version) || !SHA256_RE.test(String(textSha)))
    throw new Error('invalid live revision components');
  return `rev1:live:${epoch}:${version}:${textSha}`;
}

export function makeDiskRevisionId(version, textSha) {
  if (typeof version !== 'string' || !version || !SHA256_RE.test(String(textSha)))
    throw new Error('invalid disk revision components');
  return DISK_PREFIX + version + ':' + textSha;
}

export function makeMirrorRevisionId(textSha) {
  if (!SHA256_RE.test(String(textSha))) throw new Error('invalid mirror revision components');
  return MIRROR_PREFIX + textSha;
}

export function parseRevisionId(value) {
  if (typeof value !== 'string' || !value) return null;
  const live = LIVE_REVISION.exec(value);
  if (live) return { kind: 'live', epoch: live[1], version: Number(live[2]), textSha: live[3] };
  if (value.startsWith(MIRROR_PREFIX)) {
    const textSha = value.slice(MIRROR_PREFIX.length);
    return SHA256_RE.test(textSha) ? { kind: 'mirror', textSha } : null;
  }
  if (value.startsWith(DISK_PREFIX)) {
    const rest = value.slice(DISK_PREFIX.length);
    const at = rest.lastIndexOf(':');
    if (at < 1) return null;
    const version = rest.slice(0, at), textSha = rest.slice(at + 1);
    if (!SHA256_RE.test(textSha)) return null;
    return { kind: 'disk', version, textSha };
  }
  return null;
}

// Windows path containment used only for the self-written buffer-write policy.
// Both inputs must already be canonical (realpath) paths. The DSH sandbox also
// allows platform temp roots; B3 is deliberately stricter (see design §9.5).
export function isCanonicalUnder(target, root) {
  if (typeof target !== 'string' || !target || typeof root !== 'string' || !root || !isAbsolute(root)) return false;
  const strip = (p) => String(p)
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/^\\\\\.\\/, '');
  const fold = (p) => {
    let v = strip(p);
    if (process.platform === 'win32') v = v.replace(/\//g, '\\').toLowerCase();
    return v.replace(/[\\/]+$/, '');
  };
  const t = fold(target);
  const r = fold(root);
  if (!r) return false;
  if (t === r) return true;
  return t.startsWith(r + sep);
}

export function validateEdits(text, edits, options = {}) {
  if (!Array.isArray(edits) || edits.length === 0)
    throw coded('MP_DOC_EDIT_INVALID', 'at least one edit is required');
  // Buffer text is always LF. Disk authority may preserve CRLF/CR verbatim, so
  // a whole-line replacement (and its inverse undo) must be allowed to carry
  // the document's own separator; the line planner derives it from the file.
  const allowCr = options?.allowCr === true;
  const out = [];
  let end = 0;
  for (const edit of edits) {
    if (!edit || !Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to))
      throw coded('MP_DOC_EDIT_INVALID', 'edit offsets must be integers');
    if (edit.from < end || edit.to < edit.from || edit.to > text.length)
      throw coded('MP_DOC_EDIT_INVALID', 'edit ranges must be ordered, non-overlapping and in bounds');
    if (typeof edit.insert !== 'string' || (!allowCr && edit.insert.includes('\r')))
      throw coded('MP_DOC_EDIT_INVALID', 'edit insert must be LF-only text');
    if (edit.oldText !== undefined && text.slice(edit.from, edit.to) !== edit.oldText)
      throw coded('MP_DOC_EDIT_INVALID', 'edit oldText does not match the document text');
    out.push({ from: edit.from, to: edit.to, insert: edit.insert });
    end = edit.to;
  }
  return out;
}

export function applyChanges(text, changes) {
  let end = 0;
  const parts = [];
  for (const change of changes) {
    parts.push(text.slice(end, change.from), change.insert);
    end = change.to;
  }
  parts.push(text.slice(end));
  return parts.join('');
}

// Undo audit records keep `from`/`to` in the coordinates of the group's BASE
// text, not of the text after the edit. Replaying those offsets against the
// post-edit text is wrong as soon as an earlier change in the SAME group
// changed the length: every later change then reads a shifted slice. Empty
// inserted text (a pure deletion) makes the old anchor check pass anywhere, so
// that mistake could silently restore different bytes instead of failing.
//
// Convert each change to result coordinates with the accumulated delta of the
// earlier changes in this group, and apply the inverse on the result text. The
// returned baseText is the exact preimage implied by the audit record; callers
// must still prove its identity against baseRevision before writing.
export function invertAgentGroup(resultText, changes) {
  if (typeof resultText !== 'string')
    throw coded('MP_GROUP_STALE', 'agent group result text is unavailable', { reason: 'result-unavailable' });
  if (!Array.isArray(changes) || changes.length === 0)
    throw coded('MP_GROUP_STALE', 'agent group has no inverse changes', { reason: 'changes-empty' });
  const ordered = changes.map((change, index) => ({
    index,
    from: Number(change?.from), to: Number(change?.to),
    insert: String(change?.insert ?? ''),
    removed: change && Object.prototype.hasOwnProperty.call(change, 'removed')
      ? String(change.removed ?? '') : null,
  })).sort((a, b) => a.from - b.from || a.index - b.index);
  const inverse = [];
  let delta = 0, previousTo = 0;
  for (const change of ordered) {
    if (!Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to) || change.to < change.from)
      throw coded('MP_GROUP_STALE', 'agent group change offsets are invalid', { reason: 'changes-invalid' });
    if (change.from < previousTo)
      throw coded('MP_GROUP_STALE', 'agent group changes overlap or are out of order', { reason: 'changes-overlap' });
    // A legacy record that did not persist `removed` cannot restore a replaced
    // slice. A pure insertion (to === from) has nothing to restore and is safe.
    if (change.removed === null && change.to > change.from)
      throw coded('MP_GROUP_STALE', 'agent group change has no removed text', { reason: 'removed-unavailable' });
    const from = change.from + delta;
    const to = from + change.insert.length;
    if (from < 0 || to > resultText.length || resultText.slice(from, to) !== change.insert)
      throw coded('MP_GROUP_STALE', 'document no longer matches this edit group', { reason: 'insert-mismatch' });
    inverse.push({ from, to, insert: change.removed ?? '', expect: change.insert });
    delta += change.insert.length - (change.to - change.from);
    previousTo = change.to;
  }
  const baseText = applyChanges(resultText, inverse);
  for (const change of ordered) {
    if (change.from < 0 || change.to > baseText.length)
      throw coded('MP_GROUP_STALE', 'document no longer matches this edit group', { reason: 'base-bounds' });
    if (change.removed === null) continue;
    if (baseText.slice(change.from, change.to) !== change.removed)
      throw coded('MP_GROUP_STALE', 'document no longer matches this edit group', { reason: 'removed-mismatch' });
  }
  const replay = applyChanges(baseText, ordered.map(({ from, to, insert }) => ({ from, to, insert })));
  if (replay !== resultText)
    throw coded('MP_GROUP_STALE', 'agent group changes do not reconstruct the document', { reason: 'replay-mismatch' });
  return { inverse, baseText };
}

function revisionTokenTextSha(value) {
  const parsed = parseRevisionId(value);
  return parsed && parsed.textSha ? parsed.textSha : null;
}

// baseRevision is the proof that the reconstructed preimage is the real
// pre-edit document. When it carries a content sha (every current writer records
// a rev1 live/disk/mirror token) the match is mandatory. Only an older token
// that carries no sha may fall back to the exact replay proof performed by
// invertAgentGroup; it is never enough to merely slice the current text.
function requireGroupBaseIdentity(group, baseText) {
  const sha = revisionTokenTextSha(group?.baseRevision);
  if (!sha) return 'legacy-replay';
  if (revisionTextSha(baseText) !== sha)
    throw coded('MP_GROUP_STALE', 'document no longer matches this edit group base', { reason: 'base-mismatch' });
  return 'sha256';
}

function requireGroupResultIdentity(group, resultText) {
  const sha = revisionTokenTextSha(group?.resultRevision);
  if (!sha) return 'legacy-replay';
  if (revisionTextSha(resultText) !== sha)
    throw coded('MP_GROUP_STALE', 'document no longer matches this edit group result', { reason: 'result-mismatch' });
  return 'sha256';
}

// ── B5 line addressing ──────────────────────────────────────────────────────
// A document is split into lines at CRLF/LF/CR. `totalLines` is separators + 1
// (empty file = one empty line; a trailing newline creates a final empty line),
// matching the editor's line numbers. A leading BOM is not part of line 1:
// line addresses start after it, so replacing line 1 never deletes the BOM.
export function detectDocumentEol(text) {
  const match = EOL_RE.exec(String(text ?? ''));
  return match ? match[0] : '';
}

export function countDocumentLines(text) {
  const src = String(text ?? '');
  let count = 1;
  for (let index = 0; index < src.length; index += 1) {
    const code = src.charCodeAt(index);
    if (code === 10) count += 1;
    else if (code === 13) {
      count += 1;
      if (src.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return count;
}

function* documentLineEntries(text) {
  const src = String(text ?? '');
  const bom = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let from = bom, number = 1, index = bom;
  while (index < src.length) {
    const code = src.charCodeAt(index);
    if (code !== 10 && code !== 13) { index += 1; continue; }
    const eol = code === 13 && src.charCodeAt(index + 1) === 10 ? '\r\n' : code === 13 ? '\r' : '\n';
    yield { number, from, to: index, eol, end: index + eol.length };
    number += 1;
    from = index + eol.length;
    index = from;
  }
  yield { number, from, to: src.length, eol: '', end: src.length };
}

// Absolute line lookup for callers that already hold the full text. The model
// tool uses it when a single line is larger than MAX_LINE_READ_BYTES_CAP: the
// line-window reader must refuse that read, but the model still needs to page
// through it without losing a character.
export function findDocumentLine(text, number) {
  const wanted = Number(number);
  if (!Number.isSafeInteger(wanted) || wanted < 1) return null;
  for (const entry of documentLineEntries(String(text ?? ''))) {
    if (entry.number === wanted) return entry;
    if (entry.number > wanted) break;
  }
  return null;
}

// Bounded read: `text` is the window slice; `lines[]` carries only numeric
// absolute offsets so the same content is never sent twice. A line that does
// not fit in `maxBytes` throws MP_LINE_TOO_LONG with `requiredBytes`; there is
// no zero-progress page with nextLine pointing at the same line. A window that
// returns at least one line always advances nextLine when more lines exist.
export function readLineWindow(text, options = {}) {
  const src = String(text ?? '');
  const fromLine = options.fromLine === undefined ? 1 : options.fromLine;
  const toLine = options.toLine;
  // An explicit toLine means "this range"; without lineCount the window is the
  // requested span (still capped by MAX_LINE_READ_LINES). The 200-line default
  // only applies to an open-ended read.
  const requestedLineCount = options.lineCount === undefined
    ? (toLine === undefined ? 200 : Math.max(1, toLine - fromLine + 1))
    : options.lineCount;
  const requestedBytes = options.maxBytes === undefined ? MAX_LINE_READ_BYTES : options.maxBytes;
  if (!Number.isSafeInteger(fromLine) || fromLine < 1) throw coded('MP_LINE_RANGE', 'fromLine must be a 1-based integer');
  if (toLine !== undefined && (!Number.isSafeInteger(toLine) || toLine < fromLine))
    throw coded('MP_LINE_RANGE', 'toLine must be an integer >= fromLine');
  if (!Number.isSafeInteger(requestedLineCount) || requestedLineCount < 1)
    throw coded('MP_LINE_RANGE', 'lineCount must be a positive integer');
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1)
    throw coded('MP_LINE_RANGE', 'maxBytes must be a positive integer');
  const totalLines = countDocumentLines(src);
  const lineLimit = Math.min(requestedLineCount, MAX_LINE_READ_LINES);
  const byteLimit = Math.min(requestedBytes, MAX_LINE_READ_BYTES_CAP);
  const bom = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const base = { totalLines, lineLimit, byteLimit, bom: bom === 1 };
  if (fromLine > totalLines) {
    return {
      ...base, startLine: fromLine, endLine: fromLine - 1,
      requestedToLine: toLine === undefined ? fromLine + requestedLineCount - 1 : toLine,
      lines: [], text: '', bytes: 0, eol: '', truncated: false,
      truncatedByLines: false, truncatedByBytes: false, hasMore: false,
      beyondEnd: true, nextLine: null,
    };
  }
  const explicitTo = toLine === undefined ? null : toLine;
  const requestedTo = explicitTo === null
    ? Math.min(totalLines, fromLine + requestedLineCount - 1)
    : Math.min(totalLines, explicitTo);
  const beyondEnd = explicitTo !== null && explicitTo > totalLines;
  const lines = [];
  let endOffset = 0, bytes = 0, endLine = fromLine - 1;
  let truncatedByLines = false, truncatedByBytes = false;
  for (const entry of documentLineEntries(src)) {
    if (entry.number < fromLine) continue;
    if (entry.number > requestedTo) break;
    if (entry.number - fromLine + 1 > lineLimit) { truncatedByLines = true; break; }
    const lineBytes = Buffer.byteLength(src.slice(entry.from, entry.end), 'utf8');
    if (bytes + lineBytes > byteLimit) {
      if (lines.length === 0) {
        const overCap = lineBytes > MAX_LINE_READ_BYTES_CAP;
        const hint = overCap
          ? `line ${entry.number} needs ${lineBytes} UTF-8 bytes, beyond the ${MAX_LINE_READ_BYTES_CAP}-byte line-read cap; use the default full-text read (no line parameters) or offset batch edits`
          : `line ${entry.number} needs ${lineBytes} UTF-8 bytes but this request allows ${byteLimit}; retry with maxBytes >= ${lineBytes}`;
        throw coded('MP_LINE_TOO_LONG', hint, {
          reason: 'line-too-long', lineNumber: entry.number, requiredBytes: lineBytes,
          byteLimit, maxBytesCap: MAX_LINE_READ_BYTES_CAP,
        });
      }
      truncatedByBytes = true;
      break;
    }
    lines.push({ number: entry.number, from: entry.from, to: entry.to, end: entry.end });
    bytes += lineBytes;
    endOffset = entry.end;
    endLine = entry.number;
  }
  const hasMore = lines.length > 0 && endLine < totalLines;
  const windowText = lines.length ? src.slice(lines[0].from, endOffset) : '';
  return {
    ...base, startLine: fromLine, endLine, requestedToLine: requestedTo,
    lines, text: windowText, bytes, eol: detectDocumentEol(windowText),
    truncated: truncatedByLines || truncatedByBytes,
    truncatedByLines, truncatedByBytes, hasMore, beyondEnd,
    nextLine: hasMore ? endLine + 1 : null,
  };
}

// Whole-line replacement: [fromLine..toLine] is 1-based inclusive. The domain
// includes the separators between those lines and the separator after the last
// one. That final separator is the range terminator:
//   - if the range's last line has one, the replacement's final line break is
//     that terminator (a trailing "\n" in newString is it, not an extra blank
//     line); extra blank lines in newString are preserved;
//   - if the range ends at EOF without one, newString is inserted literally and
//     no separator is invented. Explicit trailing newlines in newString are
//     preserved, so the caller can deliberately add blank lines.
// `newString` is normalized to the range's own EOL so a CRLF disk file stays
// CRLF. A stale line number is never clamped: callers must pass a base revision
// and out-of-range numbers throw MP_LINE_RANGE.
export function planLineEdit(text, { fromLine, toLine, newString } = {}) {
  const src = String(text ?? '');
  const first = fromLine, last = toLine === undefined ? fromLine : toLine;
  if (!Number.isSafeInteger(first) || first < 1)
    throw coded('MP_LINE_RANGE', 'fromLine must be a 1-based integer');
  if (!Number.isSafeInteger(last) || last < first)
    throw coded('MP_LINE_RANGE', 'toLine must be an integer >= fromLine');
  if (typeof newString !== 'string') throw coded('MP_DOC_EDIT_INVALID', 'newString must be a string');
  const totalLines = countDocumentLines(src);
  if (last > totalLines)
    throw coded('MP_LINE_RANGE', `line range ${first}..${last} exceeds the document (${totalLines} lines)`);
  let start = null, end = null, trailingEol = '', firstEol = '';
  for (const entry of documentLineEntries(src)) {
    if (entry.number === first) { start = entry.from; firstEol = entry.eol; }
    if (entry.number === last) { end = entry.end; trailingEol = entry.eol; break; }
  }
  if (start === null || end === null) throw coded('MP_LINE_RANGE', 'line range is outside the document');
  const normalized = normalizeEol(newString);
  if (hasLoneSurrogate(normalized)) throw coded('MP_DOC_EDIT_INVALID', 'newString contains an unpaired surrogate');
  const internalEol = firstEol || trailingEol || detectDocumentEol(src) || '\n';
  let insert;
  if (trailingEol) {
    // The range owned the separator after its last line. Keep exactly one such
    // separator so deleting lines removes them instead of leaving a blank line,
    // and replacing them does not glue the next line onto the replacement.
    let body = normalized, hadFinal = false;
    if (body.endsWith('\n')) { hadFinal = true; body = body.slice(0, -1); }
    body = internalEol === '\n' ? body : body.replace(/\n/g, internalEol);
    insert = body === '' && !hadFinal ? '' : body + trailingEol;
  } else {
    // The range ended at EOF without a separator (or is the final empty line).
    // Never invent a separator, but keep every line break the caller wrote:
    // stripping them would silently delete an explicitly requested blank line.
    insert = internalEol === '\n' ? normalized : normalized.replace(/\n/g, internalEol);
  }
  const changes = [{ from: start, to: end, insert }];
  const newText = applyChanges(src, changes);
  const removedText = src.slice(start, end);
  const insertedLineCount = insert === ''
    ? 0
    : trailingEol
      ? countDocumentLines(insert.slice(0, -trailingEol.length))
      : countDocumentLines(insert);
  return {
    from: start, to: end, insert, changes, newText,
    fromLine: first, toLine: last,
    newFromLine: first, newToLine: first + insertedLineCount - 1,
    removedLineCount: last - first + 1, insertedLineCount,
    newTotalLines: countDocumentLines(newText),
    trailingEol, eol: internalEol, removedText,
  };
}

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

// B4.1: top-level Markdown sections used by the `blocks` tool action. A heading
// starts a new block; fenced code is opaque so `#` inside a fence is not a
// heading. IDs combine the ordinal with the section hash, so an edit made
// against a stale read cannot silently target a different section.
export function parseDocumentBlocks(text) {
  const src = String(text);
  const lineAt = [];
  let from = 0;
  while (from <= src.length) {
    const nl = src.indexOf('\n', from);
    const end = nl < 0 ? src.length : nl;
    lineAt.push({ from, end, text: src.slice(from, end).replace(/\r$/, '') });
    if (nl < 0) break;
    from = nl + 1;
  }
  const starts = [];
  let fence = null;
  for (const line of lineAt) {
    const trimmed = line.text.replace(/^\s{0,3}/, '');
    if (fence) {
      const close = new RegExp('^\\s{0,3}' + (fence.char === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
      if (close.test(line.text)) fence = null;
      continue;
    }
    const f = /^(`{3,}|~{3,})/.exec(trimmed);
    if (f) { fence = { char: f[1][0], length: f[1].length }; continue; }
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text);
    if (m) starts.push({ from: line.from, level: m[1].length, title: m[2] });
  }
  const ranges = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].from : src.length;
    const body = src.slice(start.from, end);
    const hash = sha256Text(body).slice(0, 8);
    ranges.push({
      id: `b${i + 1}-${hash}`, ordinal: i + 1, kind: 'heading', level: start.level,
      title: start.title, from: start.from, to: end, textLength: body.length,
      preview: body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || '',
    });
  }
  if (starts.length === 0) {
    const body = src;
    if (body.length > 0) {
      ranges.push({
        id: `b0-${sha256Text(body).slice(0, 8)}`, ordinal: 0, kind: 'document', level: 0,
        title: '(document)', from: 0, to: src.length, textLength: body.length,
        preview: body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || '',
      });
    }
  } else if (starts[0].from > 0) {
    const body = src.slice(0, starts[0].from);
    ranges.unshift({
      id: `b0-${sha256Text(body).slice(0, 8)}`, ordinal: 0, kind: 'preamble', level: 0,
      title: '(preamble)', from: 0, to: starts[0].from, textLength: body.length,
      preview: body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || '',
    });
  }
  return ranges;
}

export function findDocumentBlock(text, blockId) {
  if (typeof blockId !== 'string' || !/^b\d+-[0-9a-f]{8}$/.test(blockId)) return null;
  return parseDocumentBlocks(text).find((block) => block.id === blockId) || null;
}

// Line diff shared by merge/resolve. The previous implementation allocated an
// (n+1)x(m+1) LCS matrix, so two 3.3k-line revisions already exceeded the
// 9M-cell cap and threw MP_MERGE_LIMIT. This version trims the common
// prefix/suffix and runs Myers' O(ND) shortest-edit search over the remaining
// middle, keeping only the active diagonals for backtracking. Memory is
// O(D^2) for the trace (D = number of inserted/deleted lines), not O(n*m).
//
// The work budget bounds the extreme "everything changed" case. When it trips,
// the changed middle becomes one conservative hunk. That is still an exact diff
// of this side alone, so it can only widen a conflict, never produce a clean
// merge that drops text. Nothing is silently truncated.
const DIFF_MAX_TRACE_CELLS = 6_000_000;
const DIFF_MAX_SNAKES = 12_000_000;

// The depth-d trace window has 2d+3 cells, so the cumulative budget
// sum(d=0..D) = (D+1)(D+3) already stops the search near D=2447. Size the
// frontier by that reachable depth, not by n+m: a 100k-line diff otherwise
// reserves 2*(n+m)+3 Int32 cells for a search that can never use them.
function maxTraceDepth(cells) {
  let depth = Math.max(0, Math.floor(Math.sqrt(cells + 1)) - 2);
  while (depth > 0 && (depth + 1) * (depth + 3) > cells) depth -= 1;
  while ((depth + 2) * (depth + 4) <= cells) depth += 1;
  return depth;
}

const DIFF_MAX_TRACE_DEPTH = maxTraceDepth(DIFF_MAX_TRACE_CELLS);

function diffLines(base, other) {
  const n = base.length, m = other.length;
  let prefix = 0;
  while (prefix < n && prefix < m && base[prefix] === other[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix
    && base[n - 1 - suffix] === other[m - 1 - suffix]) suffix += 1;
  const aEnd = n - suffix, bEnd = m - suffix;
  if (prefix === aEnd && prefix === bEnd) return [];
  if (prefix === aEnd) return [{ start: prefix, end: prefix, lines: other.slice(prefix, bEnd) }];
  if (prefix === bEnd) return [{ start: prefix, end: aEnd, lines: [] }];
  const ops = myersOps(base, other, prefix, aEnd, prefix, bEnd);
  if (!ops) return [{ start: prefix, end: aEnd, lines: other.slice(prefix, bEnd) }];
  return hunksFromOps(ops);
}

function myersOps(a, b, a0, a1, b0, b1) {
  const n = a1 - a0, m = b1 - b0;
  const max = n + m;
  // No reachable path can exceed the trace budget's depth; stopping there
  // returns null below, which the caller turns into one conservative hunk.
  const reach = Math.min(max, DIFF_MAX_TRACE_DEPTH);
  const offset = reach + 1;
  const v = new Int32Array(2 * reach + 3);
  const trace = [];
  let traceCells = 0, snakes = 0, found = -1;
  for (let d = 0; d <= reach; d += 1) {
    // Backtracking at depth d reads the depth d-1 frontier over diagonals
    // [-d, d], i.e. offsets [-(d+1), d+1]; only that window needs a snapshot.
    const lo = -d - 1, hi = d + 1;
    const snap = new Int32Array(hi - lo + 1);
    for (let k = lo; k <= hi; k += 1) snap[k - lo] = v[offset + k];
    trace.push({ lo, snap });
    traceCells += snap.length;
    if (traceCells > DIFF_MAX_TRACE_CELLS) return null;
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x += 1; y += 1; snakes += 1;
        if (snakes > DIFF_MAX_SNAKES) return null;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d -= 1) {
    const { lo, snap } = trace[d];
    const read = (k) => snap[k - lo];
    const k = x - y;
    const prevK = k === -d || (k !== d && read(k - 1) < read(k + 1)) ? k + 1 : k - 1;
    const prevX = read(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; }
    if (x === prevX) ops.push({ type: 'insert', at: a0 + prevX, line: b[b0 + prevY] });
    else ops.push({ type: 'delete', at: a0 + prevX });
    x = prevX; y = prevY;
  }
  ops.reverse();
  return ops;
}

function hunksFromOps(ops) {
  const out = [];
  let last = null;
  for (const op of ops) {
    if (last && op.at >= last.start && op.at <= last.end) {
      if (op.type === 'delete') last.end = op.at + 1;
      else last.lines.push(op.line);
    } else {
      last = { start: op.at, end: op.type === 'delete' ? op.at + 1 : op.at, lines: [] };
      if (op.type === 'insert') last.lines.push(op.line);
      out.push(last);
    }
  }
  return out;
}

// A live revision token embeds the client epoch/version in addition to the
// content sha. Closing/reopening may reset the epoch/version while the buffer
// content is unchanged, so undo validation compares the text sha; the inverse
// changes are still verified against the current text before applying.
export function revisionContentKey(revision) {
  const s = String(revision == null ? "" : revision);
  const m = /^rev1:(?:live|disk):(.+)$/i.exec(s);
  if (!m) return null;
  const body = m[1];
  const at = body.lastIndexOf(':');
  if (at <= 0) return null;
  const sha = body.slice(at + 1);
  if (!/^[0-9a-f]{64}$/i.test(sha)) return null;
  return sha.toLowerCase();
}
export function sameRevisionContent(a, b) {
  if (String(a) === String(b)) return true;
  const ka = revisionContentKey(a), kb = revisionContentKey(b);
  return !!(ka && kb && ka === kb);
}

export function merge3Text(baseText, oursText, otherText) {
  const base = normalizeEol(String(baseText)).split('\n');
  const ours = normalizeEol(String(oursText)).split('\n');
  const other = normalizeEol(String(otherText)).split('\n');
  const groups = diff3Groups(base, ours, other);
  const conflicts = collectConflicts(base, groups);
  if (conflicts.length) return { clean: false, conflicts, text: null };
  const out = [];
  let pos = 0;
  for (const group of groups) {
    appendBase(out, base, pos, group.start);
    // `collectConflicts` already proved both-side groups are byte-equal here.
    if (!group.hasOurs) appendLines(out, group.otherLines);
    else appendLines(out, group.oursLines);
    pos = group.end;
  }
  appendBase(out, base, pos, base.length);
  return { clean: true, conflicts: [], text: out.join('\n') };
}

// Convert a line-diff between two full texts into character edits for the
// review-group audit/inverse. Falls back to a single replacement only if the
// line mapping cannot reproduce the target text exactly.
export function changesFromTextDiff(beforeText, afterText) {
  const before = normalizeEol(String(beforeText));
  const after = normalizeEol(String(afterText));
  if (before === after) return [];
  const baseLines = before.split('\n');
  const starts = [0];
  for (let index = 0; index < baseLines.length - 1; index += 1)
    starts.push(starts[index] + baseLines[index].length + 1);
  const changes = diffLines(baseLines, after.split('\n')).map((hunk) => ({
    from: starts[hunk.start] ?? before.length,
    to: hunk.end >= baseLines.length ? before.length : (starts[hunk.end] ?? before.length),
    insert: hunk.lines.join('\n'),
  })).sort((a, b) => a.from - b.from || a.to - b.to);
  if (applyChanges(before, changes) !== after) return [{ from: 0, to: before.length, insert: after }];
  return changes;
}

function appendLines(out, lines) {
  for (let i = 0; i < lines.length; i += 1) out.push(lines[i]);
}

function appendBase(out, base, from, to) {
  for (let i = from; i < to; i += 1) out.push(base[i]);
}

function sameLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// Boundary insertions are independent of a change that starts or ends at the
// same base offset; only a point strictly inside a changed range (or the exact
// same insertion point) overlaps. `resolve3Text` and `merge3Text` share this
// rule so both entry points report the same conflict groups.
function hunkTouchesGroup(group, hunk) {
  if (hunk.start === hunk.end) {
    if (group.start === group.end) return hunk.start === group.start;
    return hunk.start > group.start && hunk.start < group.end;
  }
  return hunk.start < group.end && group.start < hunk.end;
}

// Reconstruct one side's full text over the group's base range. Unchanged base
// lines between that side's hunks are kept, so a conflict carries the complete
// both-side context that a manual/ours/theirs choice applies to.
function sideWithin(base, group, side) {
  const hunks = group.items.filter((item) => item.side === side);
  if (hunks.length === 0) return base.slice(group.start, group.end);
  const out = [];
  let pos = group.start;
  for (const hunk of hunks) {
    appendBase(out, base, pos, hunk.start);
    appendLines(out, hunk.lines);
    pos = hunk.end;
  }
  appendBase(out, base, pos, group.end);
  return out;
}

// Merge the two ascending, internally disjoint hunk lists and group only the
// hunks that actually overlap. Because hunks arrive in base order and groups
// are disjoint/ordered, a new hunk can only touch the last group, so this is
// O(hunks) rather than comparing every ours hunk with every theirs hunk.
function diff3Groups(base, ours, other) {
  const a = diffLines(base, ours);
  const b = diffLines(base, other);
  const groups = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let hunk, side;
    if (j >= b.length) { hunk = a[i]; side = 'ours'; i += 1; }
    else if (i >= a.length) { hunk = b[j]; side = 'theirs'; j += 1; }
    else if (a[i].start < b[j].start || (a[i].start === b[j].start && a[i].end <= b[j].end)) {
      hunk = a[i]; side = 'ours'; i += 1;
    } else { hunk = b[j]; side = 'theirs'; j += 1; }
    const item = { start: hunk.start, end: hunk.end, lines: hunk.lines, side };
    const last = groups[groups.length - 1];
    if (last && hunkTouchesGroup(last, item)) {
      last.items.push(item);
      if (item.start < last.start) last.start = item.start;
      if (item.end > last.end) last.end = item.end;
    } else {
      groups.push({ start: item.start, end: item.end, items: [item] });
    }
  }
  return groups.map((group) => {
    const hasOurs = group.items.some((item) => item.side === 'ours');
    const hasOther = group.items.some((item) => item.side === 'theirs');
    return {
      start: group.start, end: group.end, hasOurs, hasOther,
      oursLines: hasOurs ? sideWithin(base, group, 'ours') : null,
      otherLines: hasOther ? sideWithin(base, group, 'theirs') : null,
    };
  });
}

function conflictFromGroup(base, group) {
  return {
    baseFrom: group.start, baseTo: group.end,
    base: base.slice(group.start, group.end).join('\n'),
    ours: group.oursLines.join('\n'),
    other: group.otherLines.join('\n'),
  };
}

function collectConflicts(base, groups) {
  const conflicts = [];
  for (const group of groups) {
    if (group.hasOurs && group.hasOther && !sameLines(group.oursLines, group.otherLines))
      conflicts.push(conflictFromGroup(base, group));
  }
  return conflicts;
}

/**
 * Resolve a 3-way line conflict. `resolutions` is null/undefined for the
 * conflict-open view (returns hunks only), or an array in hunk order:
 *   {choice:'ours'|'theirs'|'both'|'manual', text?: string, separator?: string}
 * Non-overlapping changes from both sides are always preserved. Manual text is
 * normalized and may not contain CR.
 */
export function resolve3Text(baseText, oursText, otherText, resolutions) {
  const base = normalizeEol(String(baseText)).split('\n');
  const ours = normalizeEol(String(oursText)).split('\n');
  const other = normalizeEol(String(otherText)).split('\n');
  const groups = diff3Groups(base, ours, other);
  const conflicts = collectConflicts(base, groups);
  const out = [];
  let pos = 0, conflictIndex = 0;
  for (const group of groups) {
    appendBase(out, base, pos, group.start);
    if (!group.hasOurs) appendLines(out, group.otherLines);
    else if (!group.hasOther) appendLines(out, group.oursLines);
    else if (sameLines(group.oursLines, group.otherLines)) appendLines(out, group.oursLines);
    else if (!Array.isArray(resolutions)) {
      appendLines(out, group.oursLines); // text is discarded in open mode
    } else {
      const resolution = resolutions[conflictIndex];
      if (!resolution || typeof resolution !== 'object') throw coded('MP_CONFLICT_RESOLUTIONS', 'each conflict needs a resolution');
      const choice = resolution.choice;
      if (choice === 'ours') appendLines(out, group.oursLines);
      else if (choice === 'theirs') appendLines(out, group.otherLines);
      else if (choice === 'both') {
        const separator = typeof resolution.separator === 'string' ? normalizeEol(resolution.separator) : '\n';
        if (separator.includes('\r')) throw coded('MP_CONFLICT_RESOLUTIONS', 'separator must not contain CR');
        const sepLines = separator === '' ? [] : separator.split('\n');
        if (sepLines.length && sepLines[0] === '') sepLines.shift();
        if (sepLines.length && sepLines[sepLines.length - 1] === '') sepLines.pop();
        appendLines(out, group.oursLines);
        appendLines(out, sepLines);
        appendLines(out, group.otherLines);
      } else if (choice === 'manual') {
        if (typeof resolution.text !== 'string') throw coded('MP_CONFLICT_RESOLUTIONS', 'manual resolution needs text');
        const manual = normalizeEol(resolution.text);
        if (manual.includes('\r')) throw coded('MP_CONFLICT_RESOLUTIONS', 'manual text must not contain CR');
        if (manual.length > 1024 * 1024) throw coded('MP_CONFLICT_RESOLUTIONS', 'manual text exceeds 1MB');
        appendLines(out, manual.split('\n'));
      } else throw coded('MP_CONFLICT_RESOLUTIONS', 'unknown resolution choice');
      conflictIndex += 1;
    }
    pos = group.end;
  }
  appendBase(out, base, pos, base.length);
  if (Array.isArray(resolutions) && (conflictIndex !== conflicts.length || resolutions.length !== conflicts.length))
    throw coded('MP_CONFLICT_RESOLUTIONS', 'resolution count does not match conflict count');
  return { clean: conflicts.length === 0, conflicts, text: conflicts.length && !Array.isArray(resolutions) ? null : out.join('\n') };
}

// Locate a literal oldString in `text` and return the minimal splice list.
// `insert` is already normalized by the caller for the buffer branch.
export function replaceExact(text, oldString, newString, replaceAll) {
  if (typeof oldString !== 'string' || oldString.length === 0)
    throw coded('FS_EDIT_NOT_FOUND', 'oldString must not be empty');
  if (typeof newString !== 'string')
    throw coded('MP_DOC_EDIT_INVALID', 'newString must be a string');
  const first = text.indexOf(oldString);
  if (first < 0) throw coded('FS_EDIT_NOT_FOUND', 'old_string was not found');
  if (!replaceAll && text.includes(oldString, first + oldString.length))
    throw coded('FS_AMBIGUOUS_EDIT', 'ambiguous edit');
  const changes = [];
  if (!replaceAll) changes.push({ from: first, to: first + oldString.length, insert: newString });
  else {
    let from = first;
    while (from >= 0) {
      if (changes.length >= MAX_REPLACE_ALL) throw coded('MP_DOC_EDIT_INVALID', 'too many replaceAll matches');
      changes.push({ from, to: from + oldString.length, insert: newString });
      from = text.indexOf(oldString, from + oldString.length);
    }
  }
  return { changes, newText: applyChanges(text, changes) };
}

/**
 * @param {object} deps
 * @param {object} deps.live               LiveDocuments instance (readRoom/append)
 * @param {Function} deps.openModel        (payload, invocation) => apiOpen result
 * @param {Function} deps.edit             (payload, invocation) => apiEdit result
 * @param {Function} deps.save             (payload) => apiSave result
 * @param {Function} deps.archive          ({path,text,tag,baseVersion}) => docs/archive result
 * @param {Function} deps.resolve          (payload, invocation) => fs.resolve target
 * @param {Function} deps.canonical        (target) => canonical path
 * @param {Function} deps.localPath        (target) => native path or ''
 * @param {Function} deps.enqueue          (key, action) => Promise (host queueSave)
 * @param {string|undefined} deps.sandboxMode  ctx.fs.sandboxMode (undefined = no sandbox)
 * @param {object} [deps.log]
 */
export function createDocumentsService(deps) {
  const { live, openModel, edit, save, archive, resolve, stat, canonical, localPath, enqueue, sandboxMode, log } = deps;
  if (!live || typeof live.readRoom !== 'function' || typeof live.append !== 'function')
    throw new Error('documents service requires LiveDocuments.readRoom/append');
  const CONFLICT_TTL_MS = 10 * 60 * 1000;
  const CONFLICT_MAX = 32;
  const conflictSessions = new Map();
  function pruneConflictSessions() {
    const now = Date.now();
    for (const [id, session] of conflictSessions) if (session.expiresAt <= now) conflictSessions.delete(id);
    while (conflictSessions.size > CONFLICT_MAX) conflictSessions.delete(conflictSessions.keys().next().value);
  }
  if (typeof stat !== 'function') throw new Error('documents service requires a stat callback');

  // MP208 selection references. Capture is UI-only; the model tool consumes the
  // short-lived reference through the same guarded writer. No full-document
  // snapshot is retained: only the selected slices, small edge context and the
  // revision identity needed for relocation.
  const SELECTION_TTL_MS = 15 * 60 * 1000;
  const SELECTION_MAX = 64;
  const SELECTION_RANGES_MAX = 16;
  const SELECTION_CONTEXT = 64;
  const SELECTION_READ_BYTES = 32 * 1024;
  const selectionRefs = new Map();
  const selectionLocks = new Map(); // canonical key -> [{id,from,to}]

  const canonicalKey = (value) => process.platform === 'win32'
    ? String(value || '').replace(/\//g, '\\').toLowerCase() : String(value || '');

  function selectionInvalid(message) { return coded('MP_SELECTION_INVALID', message); }
  function selectionStale(message, extra) { return coded('MP_SELECTION_STALE', message, extra); }

  function pruneSelectionRefs() {
    const now = Date.now();
    for (const [id, ref] of selectionRefs) if (ref.expiresAt <= now) selectionRefs.delete(id);
  }

  function trustedSessionId(execution) {
    const session = execution?.agent?.session;
    return String(session?.id ?? session?.header?.id ?? session?.header?.sessionId ?? '');
  }

  function selectionPathMatches(ref, a) {
    return !!ref && !!a && ref.canonical && a.canonical && canonicalKey(ref.canonical) === canonicalKey(a.canonical);
  }

  function verifySelectionRanges(text, ranges, { context = true } = {}) {
    for (const range of ranges) {
      if (text.slice(range.from, range.to) !== range.text) return false;
      if (context && range.before && text.slice(Math.max(0, range.from - range.before.length), range.from) !== range.before) return false;
      if (context && range.after && text.slice(range.to, range.to + range.after.length) !== range.after) return false;
    }
    return true;
  }

  function normalizeSelectionRanges(text, input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > SELECTION_RANGES_MAX)
      throw selectionInvalid(`ranges must contain 1..${SELECTION_RANGES_MAX} entries`);
    const out = [];
    let end = 0;
    for (const raw of input) {
      if (!raw || !Number.isSafeInteger(raw.from) || !Number.isSafeInteger(raw.to))
        throw selectionInvalid('range offsets must be integers');
      const { from, to } = raw;
      if (from < end || to <= from || to > text.length)
        throw selectionInvalid('ranges must be ordered, non-overlapping, non-empty and in bounds');
      if (typeof raw.text !== 'string' || text.slice(from, to) !== raw.text)
        throw selectionStale('selected text no longer matches the current document');
      const before = raw.before === undefined ? text.slice(Math.max(0, from - SELECTION_CONTEXT), from) : raw.before;
      const after = raw.after === undefined ? text.slice(to, Math.min(text.length, to + SELECTION_CONTEXT)) : raw.after;
      if (typeof before !== 'string' || typeof after !== 'string'
        || before.length > SELECTION_CONTEXT || after.length > SELECTION_CONTEXT)
        throw selectionInvalid(`context must be strings of at most ${SELECTION_CONTEXT} code units`);
      // The renderer-supplied anchors must describe the same original text.
      // They disambiguate repeated selected strings; they are not re-required
      // after a verified relocation (typing next to the range must not fail it).
      if (raw.before !== undefined && text.slice(Math.max(0, from - before.length), from) !== before)
        throw selectionStale('selection before-anchor no longer matches the document', { reason: 'anchor-before' });
      if (raw.after !== undefined && text.slice(to, to + after.length) !== after)
        throw selectionStale('selection after-anchor no longer matches the document', { reason: 'anchor-after' });
      out.push({ from, to, text: raw.text, before, after });
      end = to;
    }
    return out;
  }

  function selectionView(ref) {
    return {
      selectionId: ref.id, path: ref.path, sessionId: ref.sessionId,
      originRevision: ref.originRevision, revision: ref.originRevision,
      expiresAt: ref.expiresAt,
      // UI capability advert: the model can inspect this reference within the
      // hard read budget; the UI must not promise more than the server enforces.
      readSelection: true,
      readSelectionMaxBytes: SELECTION_READ_BYTES,
      ranges: ref.ranges.map((range) => ({
        from: range.from, to: range.to, length: range.to - range.from,
        textSha256: sha256Text(range.text),
      })),
    };
  }

  // Map an origin offset through the retained room change rows. Changes are
  // ordered and are applied to the previous revision in sequence. A change that
  // covers the interior of the selected range is a content conflict, not a
  // "guess the text again" case. `bias > 0` keeps an insertion at the start
  // inside the moved range; `bias < 0` keeps an insertion at the end outside it.
  function mapSelectionOffset(position, changes, bias) {
    let shift = 0;
    for (const change of changes) {
      const from = change.from, to = change.to, insert = String(change.insert ?? '');
      if (position < from) break;
      if (position > to) { shift += insert.length - (to - from); continue; }
      if (position === from) {
        if (to > from) throw coded('MP_SELECTION_CONFLICT', 'a change overlaps the selected content', { reason: 'overlap' });
        return position + shift + (bias > 0 ? insert.length : 0);
      }
      if (position === to) {
        if (from < to) throw coded('MP_SELECTION_CONFLICT', 'a change overlaps the selected content', { reason: 'overlap' });
        return position + shift + (bias < 0 ? 0 : insert.length);
      }
      throw coded('MP_SELECTION_CONFLICT', 'a change overlaps the selected content', { reason: 'overlap' });
    }
    return position + shift;
  }

  async function materializeSelection(ref, a) {
    if (!selectionPathMatches(ref, a)) throw selectionStale('selection path no longer resolves to the same document', { reason: 'path' });
    if (a.revisionId === ref.originRevision) {
      // Anchors were validated at capture; a later edit outside the selected
      // text (including immediately adjacent typing) must not invalidate it.
      if (!verifySelectionRanges(a.text, ref.ranges, { context: false })) throw selectionStale('selection text no longer matches the document');
      return ref.ranges.map((range) => ({ ...range, currentFrom: range.from, currentTo: range.to, currentText: range.text }));
    }
    if (a.source !== 'buffer' || ref.originSource !== 'buffer' || a.room?.epoch !== ref.originEpoch)
      throw selectionStale('document authority changed since capture', { reason: 'authority', currentRevisionId: a.revisionId });
    if (!Number.isSafeInteger(ref.originVersion) || !a.room || a.room.version < ref.originVersion)
      throw selectionStale('selection revision is no longer available', { reason: 'history', currentRevisionId: a.revisionId });
    if (typeof live.readRoomVersion !== 'function')
      throw selectionStale('document changed and its version chain is unavailable', { reason: 'history', currentRevisionId: a.revisionId });
    const history = await live.readRoomVersion(ref.canonical, ref.originVersion);
    // readRoomVersion returns per-version rows: {version, changes:[...]}.
    // Verify epoch, origin version, current room version, row continuity and
    // the materialized text; never trust only the final string.
    if (!history || !Array.isArray(history.changes) || typeof history.text !== 'string'
      || history.epoch !== ref.originEpoch || history.version !== ref.originVersion
      || history.roomVersion !== a.room.version
      || history.changes.length !== a.room.version - ref.originVersion
      || sha256Text(history.text) !== ref.originTextSha)
      throw selectionStale('document changed and its version chain cannot be verified', { reason: 'history', currentRevisionId: a.revisionId });

    let replayText = history.text;
    let mapped = ref.ranges.map((range) => ({ ...range, currentFrom: range.from, currentTo: range.to, currentText: range.text }));
    for (let index = 0; index < history.changes.length; index += 1) {
      const row = history.changes[index];
      if (!row || row.version !== ref.originVersion + index + 1 || !Array.isArray(row.changes))
        throw selectionStale('document version chain is not continuous', { reason: 'history', currentRevisionId: a.revisionId });
      try { validateEdits(replayText, row.changes); }
      catch { throw selectionStale('document version chain contains invalid changes', { reason: 'history', currentRevisionId: a.revisionId }); }
      // Check every version against the ranges as they stood in the previous
      // version. A change followed by an equal-and-opposite change still touched
      // the selected text and must not be accepted merely because the final
      // document looks identical.
      for (const range of mapped) {
        for (const change of row.changes) {
          if (change.from < range.currentTo && change.to > range.currentFrom)
            throw coded('MP_SELECTION_CONFLICT', 'a change overlaps the selected content', { reason: 'overlap', version: row.version });
        }
      }
      mapped = mapped.map((range) => {
        const from = mapSelectionOffset(range.currentFrom, row.changes, 1);
        const to = mapSelectionOffset(range.currentTo, row.changes, -1);
        if (to <= from) throw selectionStale('selected content changed since capture', { reason: 'bounds', version: row.version });
        return { ...range, currentFrom: from, currentTo: to };
      });
      replayText = applyChanges(replayText, row.changes);
    }
    if (replayText !== a.text || sha256Text(replayText) !== a.textSha)
      throw selectionStale('document version chain does not reach the current text', { reason: 'history', currentRevisionId: a.revisionId });
    // Context is a capture-time disambiguator. After a verified relocation the
    // mapped offsets carry the proof; only the selected text itself must still
    // match, so typing before the range does not invalidate its own context.
    for (const range of mapped) {
      range.currentText = a.text.slice(range.currentFrom, range.currentTo);
      if (range.currentText !== range.text)
        throw selectionStale('selected text changed since capture', { reason: 'text' });
    }
    return mapped;
  }

  async function captureSelection(payload) {
    let a;
    try { a = await authority(payload, undefined); } catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    // A selection must belong to an open editor room. Capturing from a disk
    // authority (or a mirror/orphan) would turn a stale UI snapshot into a
    // whole-document write, which this feature explicitly forbids.
    if (a.source !== 'buffer' || !a.room || !(a.room.members > 0))
      return fail(coded('MP_SELECTION_NOT_LIVE', 'selection capture requires an open live editor room', { source: a.source }), a);
    if (a.writable === false || a.mirrorDraft || a.draftStale || a.draftUnknown)
      return fail(coded('MP_SELECTION_WRITE_CLOSED', 'the document is not writable for a model edit', { source: a.source }), a);
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (!path || !sessionId) return fail(selectionInvalid('path and sessionId are required'), a);
    const originRevision = typeof payload?.originRevision === 'string' ? payload.originRevision : '';
    if (!originRevision) return fail(selectionInvalid('originRevision is required'), a);
    if (originRevision !== a.revisionId)
      return fail(selectionStale('capture revision is not the current document revision', { currentRevisionId: a.revisionId, reason: 'revision' }), a);
    let ranges;
    try { ranges = normalizeSelectionRanges(a.text, payload?.ranges); } catch (error) { return fail(error, a); }
    pruneSelectionRefs();
    if (selectionRefs.size >= SELECTION_MAX) return fail(coded('MP_SELECTION_LIMIT', 'too many live selection references'), a);
    const parsed = parseRevisionId(a.revisionId);
    const ref = {
      id: 'sel_' + randomUUID(), path, canonical: a.canonical, sessionId,
      originRevision: a.revisionId, originSource: a.source,
      originEpoch: parsed?.kind === 'live' ? parsed.epoch : null,
      originVersion: parsed?.kind === 'live' ? parsed.version : null,
      originTextSha: sha256Text(a.text), originLength: a.text.length,
      ranges, createdAt: Date.now(), expiresAt: Date.now() + SELECTION_TTL_MS,
      state: 'pending', result: null, fingerprint: null,
    };
    selectionRefs.set(ref.id, ref);
    return { ok: true, value: selectionView(ref) };
  }

  async function selectionCurrent(payload, invocation) {
    let a;
    try { a = await authority(payload, invocation); } catch (error) { throw error; }
    if (a.error) return { a: null, error: a.error };
    return { a, error: null };
  }

  function getSelectionRef(payload) {
    pruneSelectionRefs();
    const id = typeof payload?.selectionId === 'string' ? payload.selectionId : '';
    const ref = id ? selectionRefs.get(id) : null;
    if (!ref) throw coded('MP_SELECTION_EXPIRED', 'selection reference is missing or expired');
    return ref;
  }

  async function readSelection(payload, invocation, execution) {
    let state;
    try { state = await selectionCurrent(payload, invocation); } catch (error) { return fail(error, null); }
    if (state.error) return state.error;
    const a = state.a, trusted = trustedSessionId(execution);
    let ref;
    try { ref = getSelectionRef(payload); } catch (error) { return fail(error, a); }
    if (!trusted || trusted !== ref.sessionId) return fail(coded('MP_SELECTION_SESSION', 'selection belongs to another execution session'), a);
    if (!selectionPathMatches(ref, a)) return fail(selectionStale('selection path no longer matches the document', { reason: 'path' }), a);
    let ranges;
    try { ranges = await materializeSelection(ref, a); } catch (error) { return fail(error, a); }
    const bytes = ranges.reduce((sum, range) => sum + Buffer.byteLength(range.currentText, 'utf8'), 0);
    if (bytes > SELECTION_READ_BYTES) return fail(coded('MP_SELECTION_TOO_LARGE', 'selected text exceeds the read budget', { requiredBytes: bytes, maxBytes: SELECTION_READ_BYTES }), a);
    return { ok: true, value: {
      selectionId: ref.id, path: ref.path, sessionId: ref.sessionId,
      revisionId: a.revisionId, version: a.revisionId,
      stale: false, expiresAt: ref.expiresAt,
      bytes, maxBytes: SELECTION_READ_BYTES,
      ranges: ranges.map((range) => ({ from: range.currentFrom, to: range.currentTo,
        text: range.currentText, originFrom: range.from, originTo: range.to })),
    } };
  }

  async function editSelection(payload, invocation, policy, execution) {
    let state;
    try { state = await selectionCurrent(payload, invocation); } catch (error) { return fail(error, null); }
    if (state.error) return state.error;
    const a = state.a, trusted = trustedSessionId(execution);
    let ref;
    try { ref = getSelectionRef(payload); } catch (error) { return fail(error, a); }
    if (!trusted || trusted !== ref.sessionId) return fail(coded('MP_SELECTION_SESSION', 'selection belongs to another execution session'), a);
    if (!selectionPathMatches(ref, a)) return fail(selectionStale('selection path no longer matches the document', { reason: 'path' }), a);
    // A closed room / disk authority must never be a fallback target for a
    // captured selection write.
    if (a.source !== 'buffer' || !a.room || !(a.room.members > 0))
      return fail(coded('MP_SELECTION_NOT_LIVE', 'selection write requires the original live editor room', { source: a.source }), a);
    if (a.writable === false || a.mirrorDraft || a.draftStale || a.draftUnknown)
      return fail(coded('MP_SELECTION_WRITE_CLOSED', 'the document is not writable for a model edit', { source: a.source }), a);

    const replacements = Array.isArray(payload?.replacements) ? payload.replacements
      : (typeof payload?.newString === 'string' ? [payload.newString] : null);
    if (!replacements || (ref.ranges.length === 1 ? replacements.length !== 1 : replacements.length !== ref.ranges.length)
      || replacements.some((value) => typeof value !== 'string'))
      return fail(selectionInvalid('newString is required for one range; replacements must match the captured range count'), a);
    const fingerprint = sha256Text(JSON.stringify(replacements));
    if (ref.state === 'done') {
      if (ref.fingerprint === fingerprint && ref.result && ref.result.version === a.revisionId)
        return { ok: true, value: { ...ref.result, replayed: true } };
      return fail(coded('MP_SELECTION_USED', 'selection reference was already consumed'), a);
    }
    if (ref.state === 'applying') return fail(coded('MP_SELECTION_BUSY', 'selection reference is already being written'), a);

    let ranges;
    try { ranges = await materializeSelection(ref, a); } catch (error) { return fail(error, a); }
    // materializeSelection awaits room history. A concurrent call may have
    // moved this reference to applying/done while we were waiting; re-check
    // atomically before taking the write lock.
    if (ref.state !== 'pending')
      return fail(coded(ref.state === 'applying' ? 'MP_SELECTION_BUSY' : 'MP_SELECTION_USED',
        'selection reference changed while it was being prepared'), a);
    const key = canonicalKey(ref.canonical);
    const locks = selectionLocks.get(key) || [];
    if (locks.some((lock) => lock.id !== ref.id && ranges.some((range) => range.currentFrom < lock.to && range.currentTo > lock.from)))
      return fail(coded('MP_SELECTION_BUSY', 'an overlapping selection write is in progress'), a);
    ref.state = 'applying';
    selectionLocks.set(key, locks.concat([{ id: ref.id, from: ranges[0].currentFrom, to: ranges[ranges.length - 1].currentTo }]));
    try {
      const result = await applyEdits({
        path: payload?.path, cwd: payload?.cwd,
        baseRevisionId: a.revisionId,
        edits: ranges.map((range, index) => ({ from: range.currentFrom, to: range.currentTo, insert: replacements[index] })),
      }, invocation, policy);
      if (result.ok !== true) { ref.state = 'pending'; return result; }
      const value = result.value;
      const summary = {
        selectionId: ref.id, version: value.version, revisionId: value.revisionId,
        displayPath: value.displayPath, changed: value.changed, source: value.source,
        dirty: value.dirty === true, saved: value.saved === true,
        ranges: ranges.map((range, index) => ({
          from: range.currentFrom, to: range.currentTo,
          removedLength: range.currentTo - range.currentFrom,
          insertedLength: replacements[index].length,
        })),
        ...(value.groupId ? { groupId: value.groupId } : {}),
        ...(value.groupPersisted === false ? { groupPersisted: false, groupError: value.groupError } : {}),
        ...(value.checkpoint?.archivePath ? { checkpointPath: value.checkpoint.archivePath } : {}),
      };
      ref.state = 'done'; ref.result = summary; ref.fingerprint = fingerprint;
      return { ok: true, value: { ...summary, replayed: false } };
    } catch (error) {
      ref.state = 'pending';
      return fail(error, a);
    } finally {
      const current = selectionLocks.get(key) || [];
      const remaining = current.filter((lock) => lock.id !== ref.id);
      if (remaining.length) selectionLocks.set(key, remaining);
      else selectionLocks.delete(key);
    }
  }

  function stale(a, reason) {
    return coded('MP_DOC_STALE', 'document changed since read; read it again before editing', {
      currentRevisionId: a.revisionId, source: a.source, dirty: a.dirty, diskChanged: a.diskChanged,
      ...(reason ? { reason } : {}),
    });
  }

  async function authority(payload, invocation) {
    // Provider read -> room read -> provider version re-check. The editor's own
    // save can land between any two of these; never return a mixed snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = await resolve(payload, invocation);
      const opened = await openModel({ path: payload?.path, cwd: payload?.cwd }, invocation);
      if (!opened || opened.ok !== true) return { error: opened || { ok: false, error: { code: 'FS_IO_ERROR', message: 'open failed' } } };
      const providerText = String(opened.value.text);
      const providerVersion = String(opened.value.version);
      const providerSha = sha256Text(providerText);
      const providerRevisionSha = revisionTextSha(providerText);
      let room = null, canonicalPath = null;
      const native = localPath(target);
      if (native && isAbsolute(native)) {
        canonicalPath = await canonical(target);
        try { room = await live.readRoom(canonicalPath); }
        catch (error) {
          return { error: { ok: false, error: { code: error?.code || 'MP_LIVE_READ', message: String(error?.message || error) } } };
        }
      }
      const after = await stat(target);
      if (!after || String(after.version) !== providerVersion) {
        if (attempt === 2) throw coded('FS_STALE_VERSION', 'file changed during read; retry after the external write finishes');
        continue;
      }
      // A version can be stable while a provider cache still serves the old
      // text; re-read once and require the same version AND the same bytes.
      const confirm = await openModel({ path: payload?.path, cwd: payload?.cwd }, invocation);
      if (!confirm || confirm.ok !== true) {
        if (attempt === 2) return { error: confirm || { ok: false, error: { code: 'FS_IO_ERROR', message: 'open failed' } } };
        continue;
      }
      if (String(confirm.value.version) !== providerVersion || sha256Text(String(confirm.value.text)) !== providerSha) {
        if (attempt === 2) throw coded('FS_STALE_VERSION', 'file changed during read; retry after the external write finishes');
        continue;
      }
      let source = 'disk', text = providerText, dirty = false, conflict = false, orphanDraft = false, external = false;
      let bufferOwnedElsewhere = false, unsavedElsewhere = false;
      let unsafeMembers = false;
      let writable = true, draft = false, mirrorDraft = false, draftStale = false, draftUnknown = false;
      let diskChanged = false;
      if (room) {
        const roomDirty = room.version !== room.savedVersion;
        diskChanged = room.savedTextAvailable ? (normalizeCompare(providerText) !== room.savedText) : null;
        // A resolved conflict keeps the buffer authoritative until the next save,
        // but only while the disk still has the exact hash the user resolved
        // against. Any new external write re-enters conflict.
        let conflictResolved = false;
        if (room.resolvedDisk && diskChanged === true && roomDirty && typeof live.readDiskIdentity === 'function') {
          try {
            const identity = await live.readDiskIdentity(canonicalPath);
            conflictResolved = !!(identity && identity.diskHash === room.resolvedDisk);
          } catch { conflictResolved = false; }
        }
        const localMembers = Number.isSafeInteger(room.localMembers) ? room.localMembers : 0;
        const crossMember = room.members > 0 && room.members > localMembers;
        const replaySafe = room.allReplaySafe === true;
        if (crossMember && !replaySafe) {
          // An unknown/old member may delete the room through its leave(), or
          // cannot replay an agent append. Preserve the old behavior exactly:
          // disk read, no append, dirty room reported as unsaved elsewhere.
          source = 'disk'; bufferOwnedElsewhere = true; unsavedElsewhere = roomDirty;
        } else if (room.members > 0) {
          if (diskChanged === true && !roomDirty) {
            source = 'disk'; external = true;
          } else {
            source = 'buffer'; text = room.text; dirty = roomDirty;
            if (diskChanged === true && !conflictResolved) conflict = true;
          }
        } else if (roomDirty) {
          source = 'disk'; orphanDraft = true;
        }
        // A live member without both caps makes a BUFFER append unsafe (including a
        // stale generation that shares this pid). A clean disk-authority write keeps
        // its own versioned CAS protection and stays allowed; writable must follow the
        // path that is actually blocked, not the mere presence of a legacy member.
        if (room.members > 0 && !replaySafe) {
          unsafeMembers = true;
          if (source === 'buffer') writable = false;
        }
      }
      // A mirror is independent of a live room: a clean room left behind by a
      // crashed/restarted host must never hide an unsaved mirror. Read may still
      // prefer the room text, but every dirty/stale/unknown mirror closes writes.
      if (canonicalPath && localPath(target)) {
        try {
          const mirror = typeof live.getDraft === 'function' ? await live.getDraft(canonicalPath, {}) : null;
          if (mirror) {
            if (mirror.baseSha256 !== providerRevisionSha) {
              draftStale = true; writable = false; unsavedElsewhere = true;
            } else if (mirror.textSha256 !== providerRevisionSha) {
              draft = true; mirrorDraft = true; writable = false; unsavedElsewhere = true;
              // A clean room with no live members (host restart / unsupported
              // fallback / another instance) must not hide the only unsaved
              // buffer copy. A dirty/live room keeps its own text.
              if (!room || (room.members === 0 && room.version === room.savedVersion)) {
                source = 'mirror'; text = mirror.text; dirty = true;
              }
            }
          }
        } catch {
          // A broken/unreadable mirror must not be silently treated as clean:
          // the editor may still hold unsaved bytes, so writes stay closed.
          draftUnknown = true; writable = false; unsavedElsewhere = true;
        }
      }
      if (orphanDraft || conflict || unsavedElsewhere) writable = false;
      const textSha = sha256Text(text);
      const textRevisionSha = revisionTextSha(text);
      const revisionId = source === 'buffer'
        ? makeLiveRevisionId(room.epoch, room.version, textRevisionSha)
        : source === 'mirror'
          ? makeMirrorRevisionId(textRevisionSha)
          : makeDiskRevisionId(providerVersion, source === 'disk' ? providerRevisionSha : textRevisionSha);
      const revision = source === 'buffer'
        ? { kind: 'live', epoch: room.epoch, version: room.version, savedVersion: room.savedVersion, diskHash: room.diskHash }
        : source === 'mirror'
          ? { kind: 'mirror', textSha: textRevisionSha }
          : { kind: 'disk', version: providerVersion, diskHash: null };
      return {
        target, opened, canonical: canonicalPath, room, providerText, providerVersion, providerSha, providerRevisionSha,
        source, text, dirty, conflict, orphanDraft, external, diskChanged, textSha, textRevisionSha, revisionId, revision,
        bufferOwnedElsewhere, unsavedElsewhere, writable, unsafeMembers, draft, mirrorDraft, draftStale, draftUnknown,
        crossMember: !!(room && room.members > 0 && room.members > (Number.isSafeInteger(room.localMembers) ? room.localMembers : 0)),
        replaySafe: !!(room && room.allReplaySafe === true),
        members: room && Number.isSafeInteger(room.members) ? room.members : 0,
        localMembers: room && Number.isSafeInteger(room.localMembers) ? room.localMembers : 0,
      };
    }
    throw coded('FS_STALE_VERSION', 'file changed during read; retry after the external write finishes');
  }

  function requireBufferBase(a, raw) {
    const token = parseRevisionId(raw);
    if (!token || token.kind !== 'live') throw stale(a);
    if (token.epoch !== a.room.epoch || token.version !== a.room.version || token.textSha !== a.textRevisionSha)
      throw stale(a);
  }

  function requireDiskBase(a, raw, { required }) {
    if (!raw) {
      if (required) throw stale(a);
      return null;
    }
    const token = parseRevisionId(raw);
    if (token?.kind === 'disk') {
      if (token.version !== a.providerVersion || token.textSha !== a.providerRevisionSha) throw stale(a);
      return token.version;
    }
    if (typeof raw === 'string' && raw.startsWith('rev1:')) throw stale(a);
    // Legacy: the tool's previous `version` was the provider version itself.
    // Preserve the old error code so existing callers/tests keep their branch.
    if (raw !== a.providerVersion) throw coded('FS_STALE_VERSION', 'file changed since read');
    return a.providerVersion;
  }

  async function checkWritePolicy(a, policy) {
    if (sandboxMode === undefined) return;             // same gate as apiEdit
    if (!policy || !policy.mode) throw coded('FS_SANDBOX_DENIED', 'Cannot resolve filesystem policy for this tool call');
    if (policy.mode === 'read-only')
      throw coded('FS_SANDBOX_DENIED', 'file access denied under read-only mode');
    if (policy.mode === 'danger-full-access') return;
    if (policy.mode !== 'workspace-write')
      throw coded('FS_SANDBOX_DENIED', 'file access denied under unknown sandbox mode');
    if (!a.canonical || typeof policy.workspaceRoot !== 'string' || !policy.workspaceRoot || !isAbsolute(policy.workspaceRoot))
      throw coded('FS_SANDBOX_DENIED', 'file access denied under workspace-write mode');
    const root = await canonical({ targetKey: policy.workspaceRoot, displayPath: policy.workspaceRoot });
    if (!isCanonicalUnder(a.canonical, root))
      throw coded('FS_SANDBOX_DENIED', 'file access denied under workspace-write mode');
  }

  async function checkpoint(a) {
    // Every AI edit is checkpointed, including a clean buffer and disk-authority
    // writes. The editor's normal auto-save can overwrite the disk copy after a
    // remote change, so the disk is not a durable "pre-edit" copy by the time the
    // user notices. Deliberately no off switch.
    if (typeof archive !== 'function') throw coded('MP_ARCHIVE_FAILED', 'checkpoint is unavailable');
    let archivePath = a.canonical;
    if (!archivePath) {
      const display = a.opened?.value?.displayPath || payloadPath(a);
      archivePath = display && isAbsolute(display)
        ? display
        : join(tmpdir(), 'markpilot-archive', sha256Text(String(display || 'virtual')) + '.md');
    }
    let result;
    try { result = await archive({ path: archivePath, text: a.text, tag: 'agent-before', baseVersion: a.providerVersion }); }
    catch (error) { throw coded('MP_ARCHIVE_FAILED', 'checkpoint failed: ' + String(error?.message || error), { cause: error }); }
    if (!result || result.ok !== true) throw coded('MP_ARCHIVE_FAILED', 'checkpoint failed');
    return result.value || null;
  }

  function payloadPath(a) { return a?.opened?.value?.displayPath || ''; }

  // The audit row is only as good as its inverse data: a group that is listed
  // but cannot reconstruct the pre-edit bytes is worse than no group at all.
  function sameAuditChanges(persisted, expected) {
    if (!Array.isArray(persisted) || !Array.isArray(expected) || persisted.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      const actual = persisted[index], wanted = expected[index];
      if (!actual || !wanted) return false;
      if (Number(actual.from) !== Number(wanted.from) || Number(actual.to) !== Number(wanted.to)) return false;
      if (String(actual.insert ?? '') !== String(wanted.insert ?? '')) return false;
      if (String(actual.removed ?? '') !== String(wanted.removed ?? '')) return false;
    }
    return true;
  }

  // Disk authority and the room store are separate transactions. The only
  // provable rule is: report a group id after reading back the exact group that
  // getAgentGroup/reviewGroup/undoGroup will later consume. A failed or partial
  // write is reported as "not persisted" and the caller keeps the pre-edit
  // checkpoint (the real recovery copy) instead of a dead id.
  async function persistAgentGroup(a, groupId, kind, resultRevision, auditChanges) {
    if (typeof live.recordAgentGroup !== 'function' || typeof live.getAgentGroup !== 'function')
      return { ok: false, code: 'MP_GROUP_UNSUPPORTED', message: 'agent group journal is unavailable on this host' };
    try {
      const recorded = await live.recordAgentGroup(a.canonical, {
        groupId, actor: 'agent', kind, baseRevision: a.revisionId, resultRevision, changes: auditChanges,
      });
      if (!recorded || String(recorded.groupId || '') !== String(groupId))
        return { ok: false, code: 'MP_GROUP_NOT_PERSISTED', message: 'agent group was not persisted' };
      const persisted = await live.getAgentGroup(a.canonical, groupId);
      if (!persisted)
        return { ok: false, code: 'MP_GROUP_NOT_READABLE', message: 'agent group was not readable after the write' };
      if (persisted.undoneAt)
        return { ok: false, code: 'MP_GROUP_NOT_PERSISTED', message: 'agent group is already marked undone' };
      if (String(persisted.baseRevision ?? '') !== String(a.revisionId || '')
        || String(persisted.resultRevision ?? '') !== String(resultRevision || '')) {
        try { await live.discardAgentGroup?.(a.canonical, groupId); } catch { /* best effort */ }
        return { ok: false, code: 'MP_GROUP_INCOMPLETE', message: 'agent group revisions do not match this edit' };
      }
      if (!sameAuditChanges(persisted.changes, auditChanges)) {
        try { await live.discardAgentGroup?.(a.canonical, groupId); } catch { /* best effort */ }
        return { ok: false, code: 'MP_GROUP_INCOMPLETE', message: 'agent group inverse changes are missing or truncated' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, code: String(error?.code || 'MP_GROUP_IO'), message: String(error?.message || error) };
    }
  }

  // Recovery information for a successful edit whose group could not be
  // persisted. `original` is the durable pre-edit copy (the real recovery copy);
  // `appended` is the post-edit copy the room already owns. Neither adds a new
  // copy of document text.
  function groupRecoveryOf(archived, appended) {
    const original = archived && typeof archived === 'object'
      ? { kind: 'archive', archivePath: archived.archivePath, sha256: archived.sha256, bytes: archived.bytes }
      : null;
    const result = appended && typeof appended.recoveryPath === 'string' && appended.recoveryPath
      ? { kind: 'append-recovery', recoveryPath: appended.recoveryPath, sha256: appended.textSha256 || null }
      : null;
    return { original, appended: result };
  }

  function applyGroupState(value, groupId, state, archived, appended) {
    value.groupPersisted = state.ok === true;
    if (state.ok) {
      value.groupId = groupId;
      return value;
    }
    value.groupError = { code: state.code || 'MP_GROUP_NOT_PERSISTED', message: state.message || 'agent group was not persisted' };
    value.groupRecovery = groupRecoveryOf(archived, appended);
    return value;
  }

  async function draftMirror(payload, invocation) {
    const untitled = payload?.untitled === true;
    let filePath, queueKey;
    if (!untitled) {
      const target = await resolve(payload, invocation);
      filePath = localPath(target);
      if (!filePath || !isAbsolute(filePath)) return fail(coded('bad-request', 'draft mirror requires a local file path'), null);
      queueKey = await canonical(target);
    }
    if (typeof live.putDraft !== 'function') return fail(coded('MP_DRAFT_UNSUPPORTED', 'draft index is not available in this host'), null);
    const write = async () => {
      try {
        const value = await live.putDraft(filePath, {
          text: payload?.text, baseVersion: payload?.baseVersion, baseSha256: payload?.baseSha256,
          docToken: payload?.docToken, session: payload?.session, untitled,
        });
        return { ok: true, value: { source: value.source, kind: value.kind, textSha256: value.textSha256,
          bytes: value.bytes, docToken: value.docToken, createdAt: value.createdAt, updatedAt: value.updatedAt } };
      } catch (error) { return fail(coded(error?.code || 'MP_DRAFT_IO', String(error?.message || error)), null); }
    };
    return queueKey && enqueue ? enqueue(queueKey, write) : write();
  }

  async function draftRead(payload, invocation) {
    const untitled = payload?.untitled === true;
    let filePath;
    if (!untitled) {
      const target = await resolve(payload, invocation);
      filePath = localPath(target);
      if (!filePath || !isAbsolute(filePath)) return fail(coded('bad-request', 'draft read requires a local file path'), null);
    }
    if (typeof live.getDraft !== 'function') return fail(coded('MP_DRAFT_UNSUPPORTED', 'draft index is not available in this host'), null);
    try {
      const value = await live.getDraft(filePath, { untitled, docToken: payload?.docToken });
      if (!value) return { ok: true, value: null };
      return { ok: true, value: { text: value.text, textSha256: value.textSha256, bytes: value.bytes,
        baseVersion: value.baseVersion, baseSha256: value.baseSha256, docToken: value.docToken,
        session: value.session, createdAt: value.createdAt, updatedAt: value.updatedAt } };
    } catch (error) { return fail(coded(error?.code || 'MP_DRAFT_IO', String(error?.message || error)), null); }
  }

  async function draftClear(payload, invocation) {
    const untitled = payload?.untitled === true;
    let filePath;
    if (!untitled) {
      const target = await resolve(payload, invocation);
      filePath = localPath(target);
      if (!filePath || !isAbsolute(filePath)) return fail(coded('bad-request', 'draft clear requires a local file path'), null);
    }
    if (typeof live.clearDraft !== 'function') return fail(coded('MP_DRAFT_UNSUPPORTED', 'draft index is not available in this host'), null);
    try {
      return { ok: true, value: await live.clearDraft(filePath, {
        docToken: payload?.docToken,
        textSha256: payload?.textSha256,
        // Exact cleanup: host deletes only source+kind+doc_token+text_sha in one
        // statement. Old hosts ignore the extra fields and keep legacy semantics.
        expectedTextSha256: payload?.expectedTextSha256,
        exact: payload?.exact === true,
        untitled,
      }) };
    } catch (error) { return fail(coded(error?.code || 'MP_DRAFT_IO', String(error?.message || error)), null); }
  }

  // Line parameters are opt-in: with none of them present `documents.read`
  // keeps returning the full text exactly as before.
  function lineReadOptions(payload) {
    const has = (key) => payload?.[key] !== undefined;
    if (!['fromLine', 'toLine', 'lineCount', 'maxBytes'].some(has)) return null;
    const options = {};
    for (const key of ['fromLine', 'toLine', 'lineCount', 'maxBytes'])
      if (has(key)) options[key] = payload[key];
    return options;
  }

  async function read(payload, invocation) {
    const lineOptions = lineReadOptions(payload);
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    let lineWindow = null;
    if (lineOptions) {
      try { lineWindow = readLineWindow(a.text, lineOptions); }
      catch (error) { return fail(error, a); }
    }
    return {
      ok: true,
      value: {
        path: payload?.path ?? '',
        displayPath: a.opened.value.displayPath,
        canonical: a.canonical,
        size: a.opened.value.size,
        text: a.text,
        source: a.source,
        revisionId: a.revisionId,
        revision: a.revision,
        version: a.revisionId,
        readToken: a.revisionId,
        textSha256: a.textSha,
        dirty: a.dirty,
        diskChanged: a.diskChanged,
        conflict: a.conflict,
        orphanDraft: a.orphanDraft,
        external: a.external,
        bufferOwnedElsewhere: a.bufferOwnedElsewhere,
        unsavedElsewhere: a.unsavedElsewhere,
        writable: a.writable !== false,
        unsafeMembers: a.unsafeMembers === true,
        draft: a.draft === true,
        mirrorDraft: a.mirrorDraft === true,
        draftStale: a.draftStale === true,
        draftUnknown: a.draftUnknown === true,
        crossMember: a.crossMember === true,
        replaySafe: a.replaySafe === true,
        members: a.members || 0,
        localMembers: a.localMembers || 0,
        // Line mode replaces `text` with the bounded window; without line
        // parameters the object above is returned exactly as before.
        ...(lineWindow ? {
          lineMode: true,
          text: lineWindow.text,
          lines: lineWindow.lines,
          startLine: lineWindow.startLine,
          endLine: lineWindow.endLine,
          totalLines: lineWindow.totalLines,
          requestedToLine: lineWindow.requestedToLine,
          lineLimit: lineWindow.lineLimit,
          byteLimit: lineWindow.byteLimit,
          bytes: lineWindow.bytes,
          eol: lineWindow.eol,
          bom: lineWindow.bom === true,
          truncated: lineWindow.truncated === true,
          truncatedByLines: lineWindow.truncatedByLines === true,
          truncatedByBytes: lineWindow.truncatedByBytes === true,
          hasMore: lineWindow.hasMore === true,
          beyondEnd: lineWindow.beyondEnd === true,
          ...(Number.isSafeInteger(lineWindow.nextLine) ? { nextLine: lineWindow.nextLine } : {}),
          lineNumbersValidFor: a.revisionId,
        } : {}),
      },
    };
  }

  // B3.2 read-only state/reconcile: same authority() read, no archive, no
  // append, no room creation and no disk write. The recovery list is only an
  // index of independently written post-append copies; it never overrides the
  // room/disk authority.
  async function state(payload, invocation) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) {
      if (error?.code === 'FS_NOT_FOUND' || error?.code === 'ENOENT') {
        return {
          ok: true,
          value: {
            path: payload?.path ?? '', displayPath: payload?.path ?? '', canonical: null,
            state: 'missing', source: 'disk', dirty: false, diskChanged: null,
            conflict: false, orphanDraft: false, external: false,
            bufferOwnedElsewhere: false, unsavedElsewhere: false,
            version: null, revisionId: null, head: null, recovery: [], recommended: 'none',
          },
        };
      }
      return fail(error, null);
    }
    if (a.error) {
      const code = a.error?.error?.code;
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') {
        return {
          ok: true,
          value: {
            path: payload?.path ?? '', displayPath: payload?.path ?? '', canonical: null,
            state: 'missing', source: 'disk', dirty: false, diskChanged: null,
            conflict: false, orphanDraft: false, external: false,
            bufferOwnedElsewhere: false, unsavedElsewhere: false,
            version: null, revisionId: null, head: null, recovery: [], recommended: 'none',
          },
        };
      }
      return a.error;
    }
    let recovery = [];
    try {
      if (a.canonical && typeof live.listAppendRecovery === 'function')
        recovery = await live.listAppendRecovery(a.canonical);
    } catch { /* informational only */ }
    const stateName = a.conflict ? 'conflict'
      : a.orphanDraft ? 'orphan'
        : a.bufferOwnedElsewhere ? 'owned-elsewhere'
          : a.unsavedElsewhere ? 'unsaved-elsewhere'
            : a.external ? 'external'
              : a.source === 'buffer' ? (a.dirty ? 'dirty' : 'clean') : 'disk';
    const recommended = stateName === 'conflict' || stateName === 'owned-elsewhere' || stateName === 'unsaved-elsewhere'
      ? 'resolve'
      : stateName === 'orphan' ? 'recover'
        : stateName === 'external' ? 'reload' : 'none';
    return {
      ok: true,
      value: {
        path: payload?.path ?? '', displayPath: a.opened.value.displayPath, canonical: a.canonical,
        state: stateName, source: a.source, dirty: a.dirty === true, diskChanged: a.diskChanged,
        conflict: a.conflict === true, orphanDraft: a.orphanDraft === true, external: a.external === true,
        bufferOwnedElsewhere: a.bufferOwnedElsewhere === true, unsavedElsewhere: a.unsavedElsewhere === true,
        crossMember: a.crossMember === true, replaySafe: a.replaySafe === true,
        members: a.members || 0, localMembers: a.localMembers || 0,
        version: a.revisionId, revisionId: a.revisionId,
        head: a.room ? { epoch: a.room.epoch, version: a.room.version, savedVersion: a.room.savedVersion } : null,
        recovery: recovery.filter((entry) => entry.sha256 !== a.textSha).slice(0, 5), recommended,
        groups: typeof live.listAgentGroups === 'function' ? await live.listAgentGroups(a.canonical, 5) : [],
      },
    };
  }

  // `options.allowCr` is reserved for system-generated inverse changes (undo).
  // The public documents.applyEdits payload never passes it, so batch input
  // keeps its LF-only contract; a CRLF line edit is planned internally and an
  // undo re-inserts the exact removed bytes through this internal option.
  async function applyEdits(payload, invocation, policy, options = {}) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (a.mirrorDraft || a.draftStale || a.draftUnknown)
      return fail(coded('MP_DOC_MIRROR_READONLY', 'an unsaved draft mirror exists for this document; the mirror is read-only and cannot be a write baseline', {
        source: a.source, draftStale: a.draftStale === true, draftUnknown: a.draftUnknown === true,
      }), a);
    if (a.unsavedElsewhere) return fail(coded('MP_DOC_UNSAVED_ELSEWHERE', 'another window has unsaved edits in this document; save or resolve them there first', { source: a.source }), a);
    if (a.orphanDraft) return fail(coded('MP_DOC_ORPHAN_DRAFT', 'this document has an unsaved draft from a closed editor; open it and resolve the draft first', { source: a.source }), a);
    if (a.conflict) return fail(coded('MP_DOC_EXTERNAL_CONFLICT', 'the buffer has unsaved edits and the file changed on disk; resolve the conflict in the editor first', { source: a.source, dirty: a.dirty, diskChanged: a.diskChanged }), a);
    if (a.unsafeMembers && a.source === 'buffer') return fail(coded('MP_DOC_UNSAFE_MEMBERS', 'a live member does not support durable agent edits; save or close it first', {
      source: a.source, members: a.members || 0, replaySafe: false,
    }), a);
    const clearResolved = payload?.clearResolved === true;
    if (clearResolved && invocation) return fail(coded('bad-request', 'clearResolved is editor-only'), a);

    const rawBase = typeof payload?.baseRevisionId === 'string' ? payload.baseRevisionId
      : (typeof payload?.baseVersion === 'string' ? payload.baseVersion : '');
    const isBlock = typeof payload?.blockId === 'string' && payload.blockId.length > 0;
    const isLine = payload?.fromLine !== undefined || payload?.toLine !== undefined;
    const groupId = randomUUID();
    const groupKind = isLine ? 'line-edit' : isBlock ? 'block-edit' : 'edit';
    const groupMetadata = (auditChanges) => ({ groupId, kind: groupKind, baseRevision: a.revisionId, changes: auditChanges });
    const groupStateFromAppend = async (result, resultRevision, auditChanges) => {
      // A provider that records the group in the append transaction proves it
      // durably; an older provider returns no flag and must be read back before
      // its id is advertised. A provider that explicitly skipped the group is
      // never retried into a group with no inverse data.
      if (result?.groupRecorded === true) return { ok: true };
      if (result?.groupRecorded === false)
        return { ok: false, code: 'MP_GROUP_NOT_PERSISTED', message: 'agent group was not recorded: ' + String(result.groupSkippedReason || 'host skipped it') };
      return persistAgentGroup(a, groupId, groupKind, resultRevision, auditChanges);
    };
    const isOldString = typeof payload?.oldString === 'string';
    const isEdits = Array.isArray(payload?.edits);
    if (isLine && (isBlock || isOldString || isEdits || payload?.replaceAll === true))
      return fail(coded('bad-request', 'line range edits are mutually exclusive with oldString/blockId/edits/replaceAll'), a);

    try {
      let changes, newText, diskBase = null, block = null, linePlan = null;
      if (isBlock && isOldString) return fail(coded('bad-request', 'blockId and oldString are mutually exclusive'), a);
      if (isBlock) {
        if (typeof payload.newString !== 'string') return fail(coded('bad-request', 'newString is required'), a);
        block = findDocumentBlock(a.text, payload.blockId);
        if (!block) return fail(coded('MP_BLOCK_NOT_FOUND', 'block id no longer matches this document; read blocks again'), a);
        if (a.source === 'buffer') requireBufferBase(a, rawBase);
        else {
          if (!rawBase) return fail(coded('MP_DOC_STALE', 'baseRevisionId is required for block edits'), a);
          diskBase = requireDiskBase(a, rawBase, { required: true });
        }
        let replacement = normalizeEol(payload.newString);
        // A non-last section must end on a new line or the next heading would
        // be glued to the replacement text ("BETA## C").
        if (block.to < a.text.length && !replacement.endsWith('\n')) replacement += '\n';
        changes = [{ from: block.from, to: block.to, insert: replacement }];
        newText = applyChanges(a.text, changes);
      } else if (isOldString) {
        if (typeof payload.newString !== 'string') return fail(coded('bad-request', 'newString is required'), a);
        if (a.source === 'buffer') {
          requireBufferBase(a, rawBase);
          const exact = replaceExact(a.text, payload.oldString, normalizeEol(payload.newString), payload.replaceAll === true);
          changes = exact.changes; newText = exact.newText;
        } else {
          diskBase = requireDiskBase(a, rawBase, { required: false });
          // Compute the expected new text for the revision token; apiEdit below
          // performs the real guarded write against the provider's own text.
          const exact = replaceExact(a.text, payload.oldString, payload.newString, payload.replaceAll === true);
          changes = exact.changes; newText = exact.newText;
        }
      } else if (isLine) {
        if (typeof payload.newString !== 'string') return fail(coded('bad-request', 'newString is required'), a);
        // Line numbers are only meaningful against one exact revision. Missing
        // or non-content-bound bases are refused before any range is planned;
        // an out-of-range range throws MP_LINE_RANGE instead of clamping.
        if (!rawBase)
          return fail(coded('MP_DOC_STALE', 'baseRevisionId is required for line edits', { reason: 'base-required' }), a);
        if (a.source === 'buffer') {
          requireBufferBase(a, rawBase);
        } else {
          const token = parseRevisionId(rawBase);
          if (!token || token.kind !== 'disk')
            return fail(coded('MP_DOC_STALE', 'line edits require the revision token returned by read', { reason: 'base-required' }), a);
          diskBase = requireDiskBase(a, rawBase, { required: true });
        }
        linePlan = planLineEdit(a.text, {
          fromLine: payload.fromLine, toLine: payload.toLine, newString: payload.newString,
        });
        changes = linePlan.changes;
        validateEdits(a.text, changes, { allowCr: a.source === 'disk' });
        newText = linePlan.newText;
      } else if (isEdits) {
        if (a.source === 'buffer') {
          requireBufferBase(a, rawBase);
          changes = validateEdits(a.text, payload.edits);
          newText = applyChanges(a.text, changes);
        } else {
          if (!rawBase) return fail(coded('MP_DOC_STALE', 'baseRevisionId is required for offset edits'), a);
          diskBase = requireDiskBase(a, rawBase, { required: true });
          // Public batch edits stay LF-only. Only the internal undo path opts
          // into CR, because its insert is the verbatim removed text.
          changes = validateEdits(a.text, payload.edits, { allowCr: options.allowCr === true });
          newText = applyChanges(a.text, changes);
        }
      } else {
        return fail(coded('bad-request', 'oldString/newString or edits are required'), a);
      }

      const lineInfo = linePlan
        ? {
          lineEdit: true,
          fromLine: linePlan.fromLine, toLine: linePlan.toLine,
          newFromLine: linePlan.newFromLine, newToLine: linePlan.newToLine,
          removedLineCount: linePlan.removedLineCount, insertedLineCount: linePlan.insertedLineCount,
          newTotalLines: linePlan.newTotalLines, trailingEol: linePlan.trailingEol, eol: linePlan.eol,
          removedPreview: linePlan.removedText.slice(0, MAX_LINE_PREVIEW),
          removedLength: linePlan.removedText.length,
          insertedLength: linePlan.insert.length,
        }
        : null;
      const auditChanges = changes.map((c) => ({ ...c, removed: a.text.slice(c.from, c.to) }));
      if (newText === a.text)
        return { ok: true, value: { ...resultValue(a, changes, null, false), ...(lineInfo || {}) } };

      if (a.source === 'buffer') {
        if (invocation) await checkWritePolicy(a, policy);
        let archived = null;
        try { archived = await checkpoint(a); }
        catch (error) { return fail(error, a); }
        let result;
        try {
          // The member set is re-validated inside append()'s SQLite transaction:
          // a member joining/leaving between this read and the append changes the
          // fingerprint and refuses the write instead of appending into a room
          // whose last leave() might delete it.
          const memberGuard = a.room.members > 0 && typeof a.room.memberFingerprint === 'string'
            ? { expectedMembers: a.room.memberFingerprint, requireReplaySafe: true }
            : {};
          result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.append(a.canonical, {
            epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text, changes, actor: 'agent', groupId,
            group: groupMetadata(auditChanges),
            ...memberGuard,
            ...(clearResolved ? { clearResolved: true } : {}),
          }));
        } catch (error) {
          if (error?.code === 'MP_LIVE_STALE' || error?.code === 'MP_LIVE_MEMBERS_CHANGED') {
            let currentRevisionId = null;
            try {
              const now = await live.readRoom(a.canonical);
              if (now && now.epoch === a.room.epoch)
                currentRevisionId = makeLiveRevisionId(now.epoch, now.version, revisionTextSha(now.text));
            } catch { /* current revision is optional */ }
            return {
              ok: false,
              error: {
                code: 'MP_DOC_STALE', message: 'document changed while applying; read it again before editing',
                ...(currentRevisionId ? { currentRevisionId } : {}),
                ...(archived?.archivePath ? { checkpointPath: archived.archivePath } : {}),
              },
            };
          }
          if (error?.code === 'MP_LIVE_ROOM_UNSAFE')
            return fail(coded('MP_DOC_UNSAFE_MEMBERS', 'a live member does not support durable agent edits; save or close it first', {
              source: a.source, members: a.members || 0, replaySafe: false,
            }), a);
          throw error;
        }
        const revisionId = makeLiveRevisionId(result.epoch, result.version, revisionTextSha(result.text));
        const newBlockId = block ? parseDocumentBlocks(newText).find((b) => b.ordinal === block.ordinal)?.id : null;
        const groupState = await groupStateFromAppend(result, revisionId, auditChanges);
        const value = {
          changed: true, source: 'buffer', revisionId, displayPath: a.opened.value.displayPath,
          revision: { kind: 'live', epoch: result.epoch, version: result.version, savedVersion: result.savedVersion, diskHash: result.diskHash },
          version: revisionId,
          textSha256: result.textSha256, dirty: true, saved: false,
          applied: appliedOf(changes), checkpoint: archived, textLength: result.text.length,
          ...(lineInfo ? { ...lineInfo, newTotalLines: countDocumentLines(result.text) } : {}),
          ...(isBlock ? { blockId: newBlockId, previousBlockId: block.id } : {}),
          ...(typeof result.recoveryPath === 'string' && result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
        };
        return { ok: true, value: applyGroupState(value, groupId, groupState, archived, result) };
      }

      // Disk authority: reuse the existing guarded endpoints. Never wrap this in
      // enqueue: apiEdit/apiSave already enter the same per-path queue.
      // apiEdit carries the policy itself; apiSave does not for the local native
      // branch, so enforce the same policy once here for both shapes.
      if (invocation) await checkWritePolicy(a, policy);
      let archived = null;
      try { archived = await checkpoint(a); }
      catch (error) { return fail(error, a); }
      if (isOldString) {
        const result = await edit({
          path: payload.path, cwd: payload.cwd, oldString: payload.oldString,
          newString: payload.newString, replaceAll: payload.replaceAll === true,
          baseVersion: diskBase ?? a.providerVersion,
          rejectIfMirror: true,
        }, invocation);
        if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'edit failed'), a);
        const version = String(result.value.version);
        const actual = await rereadDiskText(payload, invocation, version, newText);
        const value = diskResult(a, version, sha256Text(actual), changes, actual);
        if (lineInfo) Object.assign(value, lineInfo, { newTotalLines: countDocumentLines(actual) });
        if (isBlock) {
          value.blockId = parseDocumentBlocks(actual).find((b) => b.ordinal === block.ordinal)?.id || null;
          value.previousBlockId = block.id;
        }
        value.checkpoint = archived;
        const groupState = await persistAgentGroup(a, groupId, groupKind, value.revisionId, auditChanges);
        return { ok: true, value: applyGroupState(value, groupId, groupState, archived, null) };
      }
      const result = await save({ path: payload.path, cwd: payload.cwd ?? invocation?.cwd, text: newText, baseVersion: diskBase, rejectIfMirror: true });
      if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'save failed'), a);
      const version = String(result.value.version);
      const actual = await rereadDiskText(payload, invocation, version, newText);
      const value = diskResult(a, version, sha256Text(actual), changes, actual);
      if (lineInfo) Object.assign(value, lineInfo, { newTotalLines: countDocumentLines(actual) });
      if (isBlock) {
        value.blockId = parseDocumentBlocks(actual).find((b) => b.ordinal === block.ordinal)?.id || null;
        value.previousBlockId = block.id;
      }
      value.checkpoint = archived;
      const groupState = await persistAgentGroup(a, groupId, groupKind, value.revisionId, auditChanges);
      return { ok: true, value: applyGroupState(value, groupId, groupState, archived, null) };
    } catch (error) {
      return fail(error, a);
    }
  }

  async function rereadDiskText(payload, invocation, version, fallback) {
    try {
      const after = await openModel({ path: payload?.path, cwd: payload?.cwd }, invocation);
      if (after?.ok === true && String(after.value.version) === String(version)) return String(after.value.text);
    } catch { /* fall back to the computed text; next read will correct the token */ }
    return fallback;
  }

  function diskResult(a, version, sha, changes, newText) {
    const revisionId = makeDiskRevisionId(version, revisionTextSha(newText));
    return {
      changed: true, source: 'disk', revisionId, displayPath: a.opened.value.displayPath,
      revision: { kind: 'disk', version, diskHash: null },
      version: revisionId, textSha256: sha, dirty: false, saved: true,
      applied: appliedOf(changes), checkpoint: null, textLength: newText.length,
    };
  }

  function resultValue(a, changes, checkpointValue, changed) {
    return {
      changed, source: a.source, revisionId: a.revisionId, displayPath: a.opened.value.displayPath,
      revision: a.revision, version: a.revisionId,
      textSha256: a.textSha, dirty: a.dirty, saved: a.source === 'disk',
      applied: appliedOf(changes), checkpoint: checkpointValue, textLength: a.text.length,
    };
  }

  function appliedOf(changes) {
    return changes.map((c) => ({ from: c.from, to: c.to, insertedLength: c.insert.length }));
  }

  function fail(error, a) {
    const rawCode = error?.code || 'FS_IO_ERROR';
    const message = String(error?.message || error);
    const code = (/SQLITE_BUSY|ERR_SQLITE/i.test(String(rawCode)) || /database is locked/i.test(message))
      ? 'MP_LIVE_BUSY' : rawCode;
    const value = { code, message };
    if (error?.reason) value.reason = String(error.reason);
    if (Number.isSafeInteger(error?.max)) value.max = error.max;
    if (Number.isSafeInteger(error?.requested)) value.requested = error.requested;
    // MP_LINE_TOO_LONG carries the exact retry numbers so the caller never
    // pages in place: requiredBytes is what the line needs, maxBytesCap is the
    // absolute ceiling (past it the full-text read is the only path).
    for (const key of ['lineNumber', 'requiredBytes', 'byteLimit', 'maxBytesCap'])
      if (error?.[key] !== undefined) value[key] = error[key];
    if (a && (code === 'MP_DOC_STALE' || code === 'MP_DOC_MIRROR_READONLY')) {
      value.currentRevisionId = a.revisionId;
      value.source = a.source;
      value.dirty = a.dirty;
      if (typeof a.diskChanged === 'boolean') value.diskChanged = a.diskChanged;
      if (a.draftStale === true) value.draftStale = true;
      if (a.draftUnknown === true) value.draftUnknown = true;
    }
    try { log?.warn?.('documents: %s: %s', code, value.message); } catch { /* best effort */ }
    return { ok: false, error: value };
  }

  async function discardRecovery(payload, invocation, policy) {
    if (typeof live.discardAppendRecovery !== 'function')
      return fail(coded('MP_RECOVERY_NOT_FOUND', 'recovery discard is unavailable'), null);
    try {
      const target = await resolve(payload, invocation);
      const canonicalPath = await canonical(target);
      if (invocation) await checkWritePolicy({ canonical: canonicalPath }, policy);
      const result = await live.discardAppendRecovery(canonicalPath, payload?.recoveryPath);
      return { ok: true, value: { removed: result?.removed === true, recoveryPath: result?.recoveryPath || payload?.recoveryPath } };
    } catch (error) { return fail(error, null); }
  }

  async function recover(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (a.conflict) return fail(coded('MP_DOC_EXTERNAL_CONFLICT', 'the buffer and disk both changed; resolve the conflict before restoring a copy', { source: a.source }), a);
    if (a.orphanDraft) return fail(coded('MP_DOC_ORPHAN_DRAFT', 'open the document and resolve its draft before restoring a recovery copy', { source: a.source }), a);
    if (a.unsavedElsewhere || a.bufferOwnedElsewhere)
      return fail(coded('MP_DOC_UNSAVED_ELSEWHERE', 'another window owns unsaved edits; resolve them there first', { source: a.source }), a);
    if (a.source === 'buffer' && a.dirty)
      return fail(coded('MP_DOC_DIRTY', 'the editor has unsaved changes; save or discard them before restoring a copy', { source: a.source, dirty: true }), a);
    if (typeof live.readAppendRecovery !== 'function' || typeof archive !== 'function')
      return fail(coded('MP_RECOVERY_NOT_FOUND', 'recovery restore is unavailable'), a);
    const rawBase = typeof payload?.baseRevisionId === 'string' ? payload.baseRevisionId
      : (typeof payload?.baseVersion === 'string' ? payload.baseVersion : '');
    // The editor tab still tracks the provider/disk version in `lastVersion`
    // for clean documents. Accept it only when the room is clean; a dirty room
    // still requires the exact rev1:live token (or it is refused above).
    const legacyCleanBase = a.dirty === false && rawBase === a.providerVersion;
    if (rawBase !== a.revisionId && !legacyCleanBase) return fail(stale(a), a);
    let copy;
    try { copy = await live.readAppendRecovery(a.canonical || payload?.path, payload?.recoveryPath); }
    catch (error) { return fail(error, a); }
    if (!copy) return fail(coded('MP_RECOVERY_NOT_FOUND', 'recovery copy no longer exists'), a);
    if (copy.text === a.text)
      return { ok: true, value: { changed: false, source: a.source, revisionId: a.revisionId, version: a.revisionId, saved: a.source === 'disk', dirty: a.dirty === true, recoveryPath: copy.recoveryPath } };
    try { if (invocation) await checkWritePolicy(a, policy); }
    catch (error) { return fail(error, a); }
    let checkpointValue = null;
    try {
      const archived = await archive({ path: a.canonical || a.opened.value.displayPath, text: a.text, tag: 'pre-recovery', baseVersion: a.providerVersion });
      if (!archived || archived.ok !== true) throw coded('MP_ARCHIVE_FAILED', 'pre-recovery archive failed');
      checkpointValue = archived.value || null;
    } catch (error) { return fail(coded('MP_ARCHIVE_FAILED', 'pre-recovery archive failed: ' + String(error?.message || error)), a); }

    if (a.source === 'buffer') {
      const memberGuard = a.room.members > 0 && typeof a.room.memberFingerprint === 'string'
        ? { expectedMembers: a.room.memberFingerprint, requireReplaySafe: true } : {};
      try {
        const result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.append(a.canonical, {
          epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text, actor: 'agent',
          changes: [{ from: 0, to: a.text.length, insert: copy.text }],
          ...memberGuard,
        }));
        const revisionId = makeLiveRevisionId(result.epoch, result.version, revisionTextSha(result.text));
        return {
          ok: true,
          value: {
            changed: true, recovered: true, source: 'buffer', revisionId, version: revisionId,
            displayPath: a.opened.value.displayPath, dirty: true, saved: false,
            textSha256: result.textSha256, textLength: copy.text.length,
            checkpoint: checkpointValue, recoveryPath: copy.recoveryPath, applied: [{ from: 0, to: a.text.length, insertedLength: copy.text.length }],
          },
        };
      } catch (error) {
        if (error?.code === 'MP_LIVE_ROOM_UNSAFE')
          return fail(coded('MP_DOC_UNSAFE_MEMBERS', 'a live member does not support durable agent edits; save or close it first', {
            source: a.source, members: a.members || 0, replaySafe: false,
          }), a);
        if (error?.code === 'MP_LIVE_MEMBERS_CHANGED') return fail(stale(a), a);
        return fail(error, a);
      }
    }
    try {
      const result = await save({ path: payload.path, cwd: payload.cwd ?? invocation?.cwd, text: copy.text, baseVersion: a.providerVersion, rejectIfMirror: true });
      if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'recovery save failed'), a);
      const version = String(result.value.version);
      const actual = await rereadDiskText(payload, invocation, version, copy.text);
      const revisionId = makeDiskRevisionId(version, revisionTextSha(actual));
      return {
        ok: true,
        value: {
          changed: true, recovered: true, source: 'disk', revisionId, version,
          displayPath: a.opened.value.displayPath, dirty: false, saved: true,
          textSha256: sha256Text(actual), textLength: actual.length,
          checkpoint: checkpointValue, recoveryPath: copy.recoveryPath,
        },
      };
    } catch (error) { return fail(error, a); }
  }

  async function merge3(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (typeof payload?.baseText !== 'string' || typeof payload?.otherText !== 'string')
      return fail(coded('bad-request', 'baseText and otherText are required'), a);
    const rawBase = typeof payload?.baseRevisionId === 'string' ? payload.baseRevisionId
      : (typeof payload?.baseVersion === 'string' ? payload.baseVersion : '');
    if (rawBase !== a.revisionId) return fail(stale(a), a);
    let merged;
    try { merged = merge3Text(payload.baseText, a.text, payload.otherText); }
    catch (error) { return fail(error, a); }
    if (!merged.clean) return { ok: true, value: { clean: false, conflicts: merged.conflicts, source: a.source, version: a.revisionId } };
    if (merged.text === a.text) return { ok: true, value: { clean: true, merged: false, changed: false, source: a.source, version: a.revisionId, dirty: a.dirty } };
    const result = await applyEdits({ path: payload.path, cwd: payload.cwd, edits: [{ from: 0, to: a.text.length, insert: merged.text }], baseRevisionId: a.revisionId }, invocation, policy);
    if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'merge write failed'), a);
    return { ok: true, value: { ...result.value, clean: true, merged: true } };
  }

  async function conflictOpen(payload) {
    pruneConflictSessions();
    let a;
    try { a = await authority(payload, {}); } catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (!a.conflict) return { ok: true, value: { conflict: false, revisionId: a.revisionId, source: a.source } };
    if (!a.room || !a.room.savedTextAvailable)
      return fail(coded('MP_CONFLICT_NO_BASE', 'the common base text is unavailable; use reload/copy instead'), a);
    if (typeof live.readDiskIdentity !== 'function')
      return fail(coded('MP_CONFLICT_NO_BASE', 'disk identity is unavailable on this host'), a);
    let disk;
    try { disk = await live.readDiskIdentity(a.canonical); } catch (error) { return fail(error, a); }
    if (normalizeCompare(disk.text) !== normalizeCompare(a.providerText)) return fail(stale(a), a);
    let merged;
    try { merged = resolve3Text(a.room.savedText, a.text, a.providerText, undefined); } catch (error) { return fail(error, a); }
    const conflictId = randomUUID();
    const session = {
      conflictId, canonical: a.canonical, path: payload?.path ?? '',
      baseRevision: a.revisionId, currentRevision: a.revisionId,
      diskHash: disk.diskHash, baseText: a.room.savedText, oursText: a.text, otherText: a.providerText,
      expiresAt: Date.now() + CONFLICT_TTL_MS,
    };
    conflictSessions.set(conflictId, session);
    pruneConflictSessions();
    const truncated = Buffer.byteLength(a.text, 'utf8') > 2 * 1024 * 1024 || a.text.split('\n').length > 2000;
    return {
      ok: true,
      value: {
        conflict: true, conflictId, path: payload?.path ?? '', displayPath: a.opened.value.displayPath,
        baseRevision: session.baseRevision, currentRevision: session.currentRevision, diskHash: session.diskHash,
        hunks: merged.conflicts, clean: merged.clean,
        // The full base/ours/theirs texts stay in the host session. The client
        // renders hunks only; it must never put three full documents into React
        // state. A clean merge gets a bounded preview for the confirmation UI.
        mergedText: merged.clean && merged.text != null && merged.text.length <= 200 * 1024 ? merged.text : null,
        truncated, expiresAt: session.expiresAt,
      },
    };
  }

  async function conflictResolve(payload, invocation, policy) {
    pruneConflictSessions();
    const conflictId = typeof payload?.conflictId === 'string' ? payload.conflictId : '';
    const session = conflictSessions.get(conflictId);
    if (!session) return fail(coded('MP_CONFLICT_NOT_FOUND', 'conflict session expired or missing; open the conflict again'), null);
    if (Date.now() > session.expiresAt) {
      conflictSessions.delete(conflictId);
      return fail(coded('MP_CONFLICT_NOT_FOUND', 'conflict session expired; open the conflict again'), null);
    }
    let a;
    try { a = await authority(payload, invocation); } catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (a.canonical !== session.canonical) return fail(stale(a), a);
    if (!a.conflict) {
      conflictSessions.delete(conflictId);
      return { ok: true, value: { conflict: false, changed: false, revisionId: a.revisionId } };
    }
    if (!a.room || a.revisionId !== session.currentRevision) return fail(stale(a), a);
    if (invocation) {
      try { await checkWritePolicy(a, policy); }
      catch (error) { return fail(error, a); }
    }
    let disk;
    try { disk = await live.readDiskIdentity(a.canonical); } catch (error) { return fail(error, a); }
    if (disk.diskHash !== session.diskHash) return fail(stale(a), a);
    if (!Array.isArray(payload?.resolutions)) return fail(coded('bad-request', 'resolutions is required'), a);
    let resolved;
    try { resolved = resolve3Text(session.baseText, session.oursText, session.otherText, payload.resolutions); }
    catch (error) { return fail(error, a); }
    if (resolved.text === a.text) {
      // "Keep mine" is not a no-op from the conflict's point of view: the room
      // must remember that the current external disk is user-approved, or a
      // later save would be rejected forever. No text/version changes here.
      if (typeof live.markResolved !== 'function') return fail(coded('MP_CONFLICT_NO_BASE', 'conflict resolution is unavailable on this host'), a);
      let marked;
      try {
        marked = await live.markResolved(a.canonical, {
          epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text,
          expectedDiskHash: session.diskHash,
        });
      } catch (error) { return fail(error, a); }
      conflictSessions.delete(conflictId);
      return {
        ok: true,
        value: {
          changed: false, resolved: true, source: a.source, revisionId: a.revisionId,
          diskVersion: a.providerVersion, resolvedDisk: session.diskHash,
          revision: { kind: 'live', epoch: a.room.epoch, version: marked.version, savedVersion: marked.savedVersion, diskHash: marked.diskHash },
        },
      };
    }
    if (typeof archive !== 'function' || typeof live.appendResolvedConflict !== 'function')
      return fail(coded('MP_ARCHIVE_FAILED', 'conflict resolution is unavailable'), a);
    let archived;
    try {
      archived = await archive({ path: a.canonical || a.opened.value.displayPath, text: a.text, tag: 'conflict-before', baseVersion: a.providerVersion });
      if (!archived || archived.ok !== true) throw coded('MP_ARCHIVE_FAILED', 'pre-conflict archive failed');
    } catch (error) { return fail(coded('MP_ARCHIVE_FAILED', 'pre-conflict archive failed: ' + String(error?.message || error)), a); }
    let changes;
    try { changes = changesFromTextDiff(a.text, resolved.text); } catch (error) { return fail(error, a); }
    if (changes.length === 0) {
      if (typeof live.markResolved !== 'function') return fail(coded('MP_CONFLICT_NO_BASE', 'conflict resolution is unavailable on this host'), a);
      let marked;
      try {
        marked = await live.markResolved(a.canonical, {
          epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text,
          expectedDiskHash: session.diskHash,
        });
      } catch (error) { return fail(error, a); }
      conflictSessions.delete(conflictId);
      return {
        ok: true,
        value: {
          changed: false, resolved: true, source: a.source, revisionId: a.revisionId,
          diskVersion: a.providerVersion, resolvedDisk: session.diskHash,
          revision: { kind: 'live', epoch: a.room.epoch, version: marked.version, savedVersion: marked.savedVersion, diskHash: marked.diskHash },
        },
      };
    }
    const memberGuard = a.room.members > 0 && typeof a.room.memberFingerprint === 'string'
      ? { expectedMembers: a.room.memberFingerprint, requireReplaySafe: true } : {};
    const groupId = randomUUID();
    const auditChanges = changes.map((change) => ({ ...change, removed: a.text.slice(change.from, change.to) }));
    let result;
    try {
      result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.appendResolvedConflict(a.canonical, {
        epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text,
        expectedDiskHash: session.diskHash, changes, actor: 'agent', groupId,
        group: { groupId, kind: 'conflict-resolve', baseRevision: a.revisionId, changes: auditChanges },
        ...memberGuard,
      }));
    } catch (error) {
      if (error?.code === 'MP_LIVE_ROOM_UNSAFE')
        return fail(coded('MP_DOC_UNSAFE_MEMBERS', 'a live member does not support durable agent edits; save or close it first', {
          source: a.source, members: a.members || 0, replaySafe: false,
        }), a);
      if (error?.code === 'MP_LIVE_MEMBERS_CHANGED') return fail(stale(a), a);
      return fail(error, a);
    }
    const revisionId = makeLiveRevisionId(result.epoch, result.version, revisionTextSha(result.text));
    const groupState = result?.groupRecorded === true
      ? { ok: true }
      : result?.groupRecorded === false
        ? { ok: false, code: 'MP_GROUP_NOT_PERSISTED', message: 'agent group was not recorded: ' + String(result.groupSkippedReason || 'host skipped it') }
        : await persistAgentGroup(a, groupId, 'conflict-resolve', revisionId, auditChanges);
    conflictSessions.delete(conflictId);
    const value = {
      changed: true, source: 'buffer', revisionId, version: revisionId,
      revision: { kind: 'live', epoch: result.epoch, version: result.version, savedVersion: result.savedVersion, diskHash: result.diskHash },
      textSha256: result.textSha256, textLength: result.text.length,
      diskVersion: a.providerVersion, resolvedDisk: session.diskHash,
      checkpoint: archived?.value || null, applied: appliedOf(changes),
    };
    return { ok: true, value: applyGroupState(value, groupId, groupState, archived?.value || null, result) };
  }

  async function conflictCancel(payload) {
    const conflictId = typeof payload?.conflictId === 'string' ? payload.conflictId : '';
    const existed = conflictSessions.delete(conflictId);
    return { ok: true, value: { cancelled: true, existed } };
  }

  async function reviewGroup(payload) {
    let target;
    try { target = await resolve(payload, {}); } catch (error) { return fail(error, null); }
    const canonicalPath = await canonical(target);
    if (typeof live.getAgentGroup !== 'function') return fail(coded('MP_GROUP_NOT_FOUND', 'agent group audit is unavailable'), null);
    const group = await live.getAgentGroup(canonicalPath, payload?.groupId);
    if (!group) return fail(coded('MP_GROUP_NOT_FOUND', 'agent group is missing'), null);
    return { ok: true, value: {
      groupId: group.groupId, actor: group.actor, kind: group.kind, at: group.at,
      baseRevision: group.baseRevision, resultRevision: group.resultRevision,
      undoneAt: group.undoneAt, changes: group.changes || [],
    } };
  }

  async function reviewGroups(payload) {
    let target;
    try { target = await resolve(payload, {}); } catch (error) { return fail(error, null); }
    const canonicalPath = await canonical(target);
    if (typeof live.getAgentGroup !== 'function') return fail(coded('MP_GROUP_NOT_FOUND', 'agent group audit is unavailable'), null);
    const ids = Array.isArray(payload?.groupIds) ? payload.groupIds.slice(0, 20) : [];
    if (ids.length === 0 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(String(id))))
      return fail(coded('MP_GROUP_NOT_FOUND', 'groupIds is invalid'), null);
    const groups = [];
    for (let index = 0; index < ids.length; index += 1) {
      const group = await live.getAgentGroup(canonicalPath, String(ids[index]));
      if (!group) return fail(coded('MP_GROUP_NOT_FOUND', 'agent group is missing'), null);
      groups.push({
        index: index + 1, groupId: group.groupId, actor: group.actor, at: group.at, kind: group.kind,
        baseRevision: group.baseRevision ?? null, resultRevision: group.resultRevision ?? null,
        changes: group.changes || [], undoneAt: group.undoneAt ?? null,
      });
    }
    // Host-side chain validation (P0). The authority text is the only fact that
    // says "this group is still the current document"; the client must not
    // reimplement sha256. Any inconsistency means the persisted review record
    // is stale and must be dropped, never shown as a live review.
    let chainOk = true, chainReason = 'ok', currentRevisionId = null;
    let authorityState = null;
    try {
      const a = await authority(payload, {});
      authorityState = a;
      if (a.error) { chainOk = false; chainReason = 'authority-error'; }
      else {
        currentRevisionId = a.revisionId;
        if (groups.some((group) => group.undoneAt)) { chainOk = false; chainReason = 'undone'; }
        else if (groups.some((group) => typeof group.baseRevision !== 'string' || !group.baseRevision
          || typeof group.resultRevision !== 'string' || !group.resultRevision)) {
          chainOk = false; chainReason = 'missing-revision';
        } else {
          for (let index = 1; index < groups.length; index += 1) {
            if (!sameRevisionContent(groups[index - 1].resultRevision, groups[index].baseRevision)) {
              chainOk = false; chainReason = 'broken-chain'; break;
            }
          }
          if (chainOk && !sameRevisionContent(groups[groups.length - 1].resultRevision, a.revisionId)) {
            chainOk = false; chainReason = 'not-current';
          }
        }
      }
    } catch { chainOk = false; chainReason = 'authority-error'; }
    // chainOk answers "are these groups still the current text?" It is not the
    // same question as "may the editor show this persisted review again?" A
    // single group whose later live-history rows prove a non-overlapping user
    // edit can be safely undone selectively; the client may retain the review
    // for that case without treating the old diff as current offsets. This is
    // an additive marker; chainOk/chainReason keep their old meaning.
    let reviewRestorable = chainOk;
    let reviewRestorableReason = chainOk ? 'current' : chainReason;
    if (!chainOk && chainReason === 'not-current' && groups.length > 1) {
      reviewRestorableReason = 'multi-group-selective';
    } else if (!chainOk && chainReason === 'not-current' && groups.length === 1
      && authorityState && !authorityState.error) {
      const a = authorityState;
      try {
        if (a.source !== 'buffer' || !a.room || a.writable === false
          || a.mirrorDraft || a.draftStale || a.draftUnknown
          || a.conflict || a.orphanDraft || a.unsavedElsewhere) {
          reviewRestorableReason = a.source !== 'buffer' ? 'no-live-buffer' : 'write-unavailable';
        } else {
          const latest = await latestActiveGroup(a);
          if (!latest || latest.groupId !== groups[0].groupId) {
            reviewRestorableReason = 'not-latest';
          } else {
            const plan = await planSelectiveUndo(a, groups);
            if (plan && plan.selective === true && !plan.unproven) {
              reviewRestorable = true;
              reviewRestorableReason = 'selective-undo';
            } else {
              reviewRestorableReason = plan?.unproven || 'selective-unproven';
            }
          }
        }
      } catch { reviewRestorableReason = 'selective-plan-failed'; }
    }
    return { ok: true, value: { groups, chainOk, chainReason, currentRevisionId, reviewRestorable, reviewRestorableReason } };
  }

  // Mark the audit groups undone. Prefer the host's single-statement helper so
  // a multi-group undo never leaves a half-marked chain; fall back to the
  // per-group API for older hosts. Marking is audit-only and must not turn a
  // successful text restore into a failure; pending ids are reported truthfully.
  async function markGroupsUndone(canonical, groupIds) {
    const ids = groupIds.map(String);
    if (typeof live.markAgentGroupsUndone === 'function') {
      try {
        const result = await live.markAgentGroupsUndone(canonical, ids);
        if (result && Array.isArray(result.marked)) {
          const marked = new Set(result.marked.map(String));
          return { marked: ids.filter((id) => marked.has(id)), pending: ids.filter((id) => !marked.has(id)) };
        }
        return { marked: ids.slice(), pending: [] };
      } catch { /* fall through to the per-group method */ }
    }
    const marked = [], pending = [];
    for (const id of ids) {
      try { await live.markAgentGroupUndone(canonical, id); marked.push(id); }
      catch { pending.push(id); }
    }
    return { marked, pending };
  }

  function undoMarkFields(mark) {
    if (!mark) return {};
    return {
      ...(mark.marked && mark.marked.length ? { undoMarked: mark.marked } : {}),
      ...(mark.pending && mark.pending.length
        // Text is already restored. Retrying this groupId is not a supported
        // mark path (a later undo group is now the latest group), so report a
        // recoverable pending state instead of promising a retry.
        ? { undoMarkPending: mark.pending, undoMarkState: 'pending' }
        : {}),
    };
  }

  // Every audit change is base-relative. Rebuild the base text group by group
  // (latest first) and prove each group's result/base identity against the
  // recorded revision token. The final text is a complete pre-edit document.
  function planGroupUndo(groups, currentText) {
    let text = currentText;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      requireGroupResultIdentity(group, text);
      const inverted = invertAgentGroup(text, group.changes);
      requireGroupBaseIdentity(group, inverted.baseText);
      text = inverted.baseText;
    }
    return text;
  }

  function normalizeLiveChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return null;
    const out = [];
    let end = 0;
    for (const change of changes) {
      const from = Number(change?.from), to = Number(change?.to);
      const insert = String(change?.insert ?? '');
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || from < end) return null;
      out.push({ from, to, insert });
      end = to;
    }
    return out;
  }

  // Map an inverse edit from the group-result coordinate space through the
  // retained user changes that happened after the group. A user change that
  // intersects the inverse span (or touches a zero-width inverse point) makes
  // the ordering ambiguous: return null and let the caller keep the draft.
  function mapInverseThroughChanges(edits, rows, currentText) {
    const mapped = [];
    for (const edit of edits) {
      let from = edit.from, to = edit.to;
      for (const row of rows) {
        const changes = normalizeLiveChanges(row.changes);
        if (!changes) return null;
        const baseFrom = from, baseTo = to;
        let shiftFrom = 0, shiftTo = 0;
        for (const change of changes) {
          const delta = change.insert.length - (change.to - change.from);
          if (baseFrom === baseTo) {
            // Inserting the restored text at one point is ambiguous when the
            // user also edited that exact point.
            if (change.from <= baseFrom && baseFrom <= change.to) return null;
          }
          if (change.to <= baseFrom) { shiftFrom += delta; shiftTo += delta; }
          else if (change.from >= baseTo) { /* after the inverse span */ }
          else return null;
        }
        from += shiftFrom; to += shiftTo;
      }
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > currentText.length)
        return null;
      if (currentText.slice(from, to) !== edit.expect) return null;
      mapped.push({ from, to, insert: edit.insert });
    }
    mapped.sort((a, b) => a.from - b.from);
    let end = 0;
    for (const change of mapped) {
      if (change.from < end) return null;
      end = change.to;
    }
    return mapped;
  }

  // Selective undo: restore the last AI group while keeping later user edits.
  // It is allowed only when the retained live history proves, without guessing,
  // that (a) the current text is the group's result plus logged non-agent
  // changes, and (b) none of those changes intersects the AI inverse. Any gap,
  // compaction, later AI group or overlap means "keep the draft".
  async function planSelectiveUndo(a, groups) {
    if (groups.length !== 1) return { unproven: 'multi-group-selective' };
    if (a.source !== 'buffer' || !a.room) return { unproven: 'no-live-history' };
    if (typeof live.readRoomVersion !== 'function') return { unproven: 'history-api-unavailable' };
    const group = groups[0];
    const parsed = parseRevisionId(group.resultRevision);
    if (!parsed || parsed.kind !== 'live') return { unproven: 'group-not-live' };
    if (parsed.epoch !== a.room.epoch) return { unproven: 'epoch-changed' };
    if (!Number.isSafeInteger(parsed.version) || parsed.version < 0 || parsed.version > a.room.version)
      return { unproven: 'version-unavailable' };
    let snapshot;
    try { snapshot = await live.readRoomVersion(a.canonical, parsed.version); }
    catch { return { unproven: 'history-read-failed' }; }
    if (!snapshot || snapshot.epoch !== a.room.epoch || snapshot.version !== parsed.version)
      return { unproven: 'history-unavailable' };
    if (revisionTextSha(snapshot.text) !== parsed.textSha) return { unproven: 'result-mismatch' };
    const rows = Array.isArray(snapshot.changes) ? snapshot.changes : [];
    if (rows.length !== a.room.version - parsed.version) return { unproven: 'history-gap' };
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].version !== parsed.version + 1 + index) return { unproven: 'history-gap' };
      // A later AI group would be the real "last group"; never undo underneath it.
      if (rows[index].groupId) return { unproven: 'later-agent-group' };
      if (!Array.isArray(rows[index].changes) || rows[index].changes.length === 0) return { unproven: 'history-gap' };
    }
    const inverted = invertAgentGroup(snapshot.text, group.changes);
    requireGroupBaseIdentity(group, inverted.baseText);
    const edits = mapInverseThroughChanges(inverted.inverse, rows, a.text);
    if (!edits) return { unproven: 'intervening-overlap' };
    if (edits.length === 0) return { unproven: 'no-inverse' };
    return { edits, targetText: applyChanges(a.text, edits), selective: true, interveningEdits: rows.length };
  }

  async function latestActiveGroup(a) {
    try {
      const recent = await live.listAgentGroups(a.canonical, 50);
      return recent.find((entry) => !entry.undoneAt) || null;
    } catch { return null; }
  }

  async function undoGroups(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    // A mirror is an unsaved read-only copy: it can be reviewed but never used
    // as a write baseline, so an undo must not even plan a write against it.
    if (a.mirrorDraft || a.draftStale || a.draftUnknown)
      return fail(coded('MP_DOC_MIRROR_READONLY', 'an unsaved draft mirror exists for this document; the mirror is read-only and cannot be a write baseline', {
        source: a.source, draftStale: a.draftStale === true, draftUnknown: a.draftUnknown === true,
      }), a);
    if (typeof live.getAgentGroup !== 'function' || typeof live.markAgentGroupUndone !== 'function')
      return fail(coded('MP_GROUP_NOT_FOUND', 'agent group audit is unavailable'), a);
    const requestedIds = Array.isArray(payload?.groupIds) ? payload.groupIds : [];
    // Never truncate an undo request: undoing only the first 20 groups would be
    // a partial audit operation with no clear user consent. Reject it before
    // reading a group or writing text/metadata.
    if (requestedIds.length > 20)
      return fail(coded('MP_GROUP_LIMIT', 'at most 20 agent groups can be undone in one request', {
        max: 20, requested: requestedIds.length,
      }), a);
    const groupIds = requestedIds;
    if (groupIds.length === 0 || groupIds.some((id) => !/^[0-9a-f-]{36}$/i.test(String(id))))
      return fail(coded('MP_GROUP_NOT_FOUND', 'groupIds is invalid'), a);
    const groups = [];
    for (const groupId of groupIds) {
      let group;
      try { group = await live.getAgentGroup(a.canonical, String(groupId)); }
      catch (error) { return fail(error, a); }
      if (!group || group.undoneAt) return fail(coded('MP_GROUP_NOT_FOUND', 'agent group is already undone or missing'), a);
      groups.push(group);
    }
    for (let i = 1; i < groups.length; i += 1) {
      if (!sameRevisionContent(groups[i].baseRevision, groups[i - 1].resultRevision))
        return fail(coded('MP_GROUP_STALE', 'agent groups are not a contiguous edit sequence'), a);
    }
    // Undoing a conflict-resolution group must re-expose the original conflict.
    // The inverse append carries clearResolved so room_resolved is deleted in
    // the same room transaction; clearing before the append would make the
    // append itself refuse as a conflict.
    const hadConflictGroup = groups.some((group) => group.kind === 'conflict-resolve');
    const currentMatches = sameRevisionContent(groups[groups.length - 1].resultRevision, a.revisionId);
    let plan;
    if (currentMatches) {
      try { plan = { targetText: planGroupUndo(groups, a.text), selective: false }; }
      catch (error) { return fail(error, a); }
    } else {
      // Preserve a later user edit only on an unbroken, provable live history.
      const latest = await latestActiveGroup(a);
      if (!latest || latest.groupId !== groups[groups.length - 1].groupId)
        return fail(stale(a, 'not-latest'), a);
      plan = await planSelectiveUndo(a, groups);
      if (plan.unproven) return fail(stale(a, plan.unproven), a);
    }
    if (plan.targetText === a.text) {
      // A no-op still changes audit metadata. It must respect the same
      // read-only/sandbox policy as a text write before touching any record.
      if (invocation) {
        try { await checkWritePolicy(a, policy); }
        catch (error) { return fail(error, a); }
      }
      const marked = await markGroupsUndone(a.canonical, groupIds);
      return {
        ok: true,
        value: {
          changed: false, source: a.source, version: a.revisionId, revisionId: a.revisionId,
          undoOf: groupIds, reopenedConflict: hadConflictGroup,
          ...(plan.selective ? { selective: true } : {}), ...undoMarkFields(marked),
        },
      };
    }
    // Undo inverse inserts the verbatim removed bytes. A disk document may use
    // CRLF/CR, so the internal applyEdits option must allow CR; the public
    // documents.applyEdits payload never sets it and keeps the LF-only batch
    // contract. Buffer documents are always LF, so this does not add CR there.
    const result = await applyEdits({
      path: payload.path, cwd: payload.cwd,
      edits: plan.selective ? plan.edits : [{ from: 0, to: a.text.length, insert: plan.targetText }],
      baseRevisionId: a.revisionId,
      ...(hadConflictGroup ? { clearResolved: true } : {}),
    }, invocation, policy, { allowCr: true });
    if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'undo failed'), a);
    const marked = await markGroupsUndone(a.canonical, groupIds);
    return {
      ok: true,
      value: {
        ...result.value, undoOf: groupIds, reopenedConflict: hadConflictGroup,
        ...(plan.selective ? { selective: true, interveningEdits: plan.interveningEdits } : {}),
        ...undoMarkFields(marked),
      },
    };
  }

  async function undoGroup(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (a.mirrorDraft || a.draftStale || a.draftUnknown)
      return fail(coded('MP_DOC_MIRROR_READONLY', 'an unsaved draft mirror exists for this document; the mirror is read-only and cannot be a write baseline', {
        source: a.source, draftStale: a.draftStale === true, draftUnknown: a.draftUnknown === true,
      }), a);
    if (typeof live.getAgentGroup !== 'function' || typeof live.markAgentGroupUndone !== 'function')
      return fail(coded('MP_GROUP_NOT_FOUND', 'agent group audit is unavailable'), a);
    const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) return fail(coded('MP_GROUP_NOT_FOUND', 'groupId is invalid'), a);
    let group;
    try { group = await live.getAgentGroup(a.canonical, groupId); }
    catch (error) { return fail(error, a); }
    if (!group || group.undoneAt) return fail(coded('MP_GROUP_NOT_FOUND', 'agent group is already undone or missing'), a);
    if (group.kind === 'conflict-resolve')
      return fail(coded('MP_GROUP_NOT_ALLOWED', 'conflict resolution groups can only be undone from the editor'), a);
    const currentMatches = sameRevisionContent(group.resultRevision, a.revisionId);
    const recent = await live.listAgentGroups(a.canonical, 20);
    const latest = recent.find((entry) => !entry.undoneAt);
    if (!currentMatches && (!latest || latest.groupId !== groupId))
      return fail(stale(a, 'not-latest'), a);
    if (currentMatches && (!latest || latest.groupId !== groupId))
      return fail(coded('MP_GROUP_NOT_LATEST', 'only the latest agent edit group can be undone'), a);
    let plan;
    if (currentMatches) {
      try {
        const inverted = invertAgentGroup(a.text, group.changes);
        requireGroupBaseIdentity(group, inverted.baseText);
        plan = { targetText: inverted.baseText, edits: inverted.inverse, selective: false };
      } catch (error) { return fail(error, a); }
    } else {
      plan = await planSelectiveUndo(a, [group]);
      if (plan.unproven) return fail(stale(a, plan.unproven), a);
    }
    if (plan.targetText === a.text) {
      // Same metadata-only policy gate as undoGroups.
      if (invocation) {
        try { await checkWritePolicy(a, policy); }
        catch (error) { return fail(error, a); }
      }
      const marked = await markGroupsUndone(a.canonical, [groupId]);
      return {
        ok: true,
        value: {
          changed: false, source: a.source, version: a.revisionId, revisionId: a.revisionId,
          undoOf: groupId, ...(plan.selective ? { selective: true } : {}), ...undoMarkFields(marked),
        },
      };
    }
    // Same internal CR allowance as undoGroups: inverse bytes may be CRLF.
    const result = await applyEdits({
      path: payload.path, cwd: payload.cwd, edits: plan.edits, baseRevisionId: a.revisionId,
    }, invocation, policy, { allowCr: true });
    if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'undo failed'), a);
    const marked = await markGroupsUndone(a.canonical, [groupId]);
    return {
      ok: true,
      value: {
        ...result.value, undoOf: groupId,
        ...(plan.selective ? { selective: true, interveningEdits: plan.interveningEdits } : {}),
        ...undoMarkFields(marked),
      },
    };
  }

  return {
    read, applyEdits, state, recover, discardRecovery, undoGroup, undoGroups, merge3,
    reviewGroup, reviewGroups, conflictOpen, conflictResolve, conflictCancel,
    draftMirror, draftRead, draftClear,
    captureSelection, readSelection, editSelection,
  };
}

