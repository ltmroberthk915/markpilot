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

export function validateEdits(text, edits) {
  if (!Array.isArray(edits) || edits.length === 0)
    throw coded('MP_DOC_EDIT_INVALID', 'at least one edit is required');
  const out = [];
  let end = 0;
  for (const edit of edits) {
    if (!edit || !Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to))
      throw coded('MP_DOC_EDIT_INVALID', 'edit offsets must be integers');
    if (edit.from < end || edit.to < edit.from || edit.to > text.length)
      throw coded('MP_DOC_EDIT_INVALID', 'edit ranges must be ordered, non-overlapping and in bounds');
    if (typeof edit.insert !== 'string' || edit.insert.includes('\r'))
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

function diffLines(base, other) {
  const n = base.length, m = other.length;
  if (n * m > 9_000_000) throw Object.assign(new Error('merge input is too large'), { code: 'MP_MERGE_LIMIT' });
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = base[i] === other[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, start = -1, lines = [];
  const flush = () => { if (start >= 0) { out.push({ start, end: i, lines }); start = -1; lines = []; } };
  while (i < n && j < m) {
    if (base[i] === other[j]) { flush(); i++; j++; continue; }
    if (start < 0) start = i;
    if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
    else { lines.push(other[j]); j++; }
  }
  if (i < n || j < m) {
    if (start < 0) start = i;
    while (i < n) i++;
    while (j < m) { lines.push(other[j]); j++; }
  }
  flush();
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

export function merge3Text(baseText, oursText, otherText) {  const base = String(baseText).split('\n');
  const ours = String(oursText).split('\n');
  const other = String(otherText).split('\n');
  const a = diffLines(base, ours);
  const b = diffLines(base, other);
  const conflicts = [];
  const overlaps = (x, y) => {
    const xi = x.start === x.end, yi = y.start === y.end;
    if (xi && yi) return x.start === y.start && x.lines.join('\n') !== y.lines.join('\n');
    if (xi) return y.start < x.start && x.start < y.end;
    if (yi) return x.start < y.start && y.start < x.end;
    return x.start < y.end && y.start < x.end;
  };
  for (const x of a) for (const y of b) if (overlaps(x, y)) {
    conflicts.push({
      baseFrom: Math.min(x.start, y.start), baseTo: Math.max(x.end, y.end),
      base: base.slice(Math.min(x.start, y.start), Math.max(x.end, y.end)).join('\n'),
      ours: x.lines.join('\n'), other: y.lines.join('\n'),
    });
  }
  if (conflicts.length) return { clean: false, conflicts, text: null };
  const seen = new Set();
  const all = [...a, ...b].filter((change) => {
    const key = `${change.start}:${change.end}:${change.lines.join('\n')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [];
  let pos = 0;
  for (const change of all) {
    if (change.start < pos) return { clean: false, conflicts: [{ baseFrom: change.start, baseTo: change.end, base: '', ours: change.lines.join('\n'), other: '' }], text: null };
    out.push(...base.slice(pos, change.start), ...change.lines);
    pos = change.end;
  }
  out.push(...base.slice(pos));
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

function hunkIntersects(a, b) {
  const ai = a.start === a.end, bi = b.start === b.end;
  if (ai && bi) return a.start === b.start;
  if (ai) return b.start < a.start && a.start < b.end;
  if (bi) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

function sideWithin(base, group, side) {
  const hunks = group.items.filter((item) => item.side === side).sort((a, b) => a.start - b.start);
  if (hunks.length === 0) return base.slice(group.start, group.end);
  const out = [];
  let pos = group.start;
  for (const hunk of hunks) {
    out.push(...base.slice(pos, hunk.start), ...hunk.lines);
    pos = hunk.end;
  }
  out.push(...base.slice(pos, group.end));
  return out;
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
  const all = [
    ...diffLines(base, ours).map((hunk) => ({ ...hunk, side: 'ours' })),
    ...diffLines(base, other).map((hunk) => ({ ...hunk, side: 'theirs' })),
  ].sort((a, b) => a.start - b.start || a.end - b.end || (a.side === 'ours' ? -1 : 1));
  const groups = [];
  for (const hunk of all) {
    let group = groups[groups.length - 1];
    if (group && group.items.some((item) => hunkIntersects(item, hunk))) {
      group.items.push(hunk);
      group.start = Math.min(group.start, hunk.start);
      group.end = Math.max(group.end, hunk.end);
    } else {
      groups.push({ start: hunk.start, end: hunk.end, items: [hunk] });
    }
  }
  const conflicts = [];
  const out = [];
  let pos = 0, conflictIndex = 0;
  for (const group of groups) {
    out.push(...base.slice(pos, group.start));
    const oursLines = sideWithin(base, group, 'ours');
    const otherLines = sideWithin(base, group, 'theirs');
    const hasOurs = group.items.some((item) => item.side === 'ours');
    const hasOther = group.items.some((item) => item.side === 'theirs');
    if (!hasOurs) out.push(...otherLines);
    else if (!hasOther) out.push(...oursLines);
    else if (sameLines(oursLines, otherLines)) out.push(...oursLines);
    else {
      conflicts.push({
        baseFrom: group.start, baseTo: group.end,
        base: base.slice(group.start, group.end).join('\n'),
        ours: oursLines.join('\n'), other: otherLines.join('\n'),
      });
      if (!Array.isArray(resolutions)) {
        out.push(...oursLines); // text is discarded in open mode
      } else {
        const resolution = resolutions[conflictIndex];
        if (!resolution || typeof resolution !== 'object') throw coded('MP_CONFLICT_RESOLUTIONS', 'each conflict needs a resolution');
        const choice = resolution.choice;
        if (choice === 'ours') out.push(...oursLines);
        else if (choice === 'theirs') out.push(...otherLines);
        else if (choice === 'both') {
          const separator = typeof resolution.separator === 'string' ? normalizeEol(resolution.separator) : '\n';
          if (separator.includes('\r')) throw coded('MP_CONFLICT_RESOLUTIONS', 'separator must not contain CR');
          const sepLines = separator === '' ? [] : separator.split('\n');
          if (sepLines.length && sepLines[0] === '') sepLines.shift();
          if (sepLines.length && sepLines[sepLines.length - 1] === '') sepLines.pop();
          out.push(...oursLines, ...sepLines, ...otherLines);
        } else if (choice === 'manual') {
          if (typeof resolution.text !== 'string') throw coded('MP_CONFLICT_RESOLUTIONS', 'manual resolution needs text');
          const manual = normalizeEol(resolution.text);
          if (manual.includes('\r')) throw coded('MP_CONFLICT_RESOLUTIONS', 'manual text must not contain CR');
          if (manual.length > 1024 * 1024) throw coded('MP_CONFLICT_RESOLUTIONS', 'manual text exceeds 1MB');
          out.push(...manual.split('\n'));
        } else throw coded('MP_CONFLICT_RESOLUTIONS', 'unknown resolution choice');
        conflictIndex += 1;
      }
    }
    pos = group.end;
  }
  out.push(...base.slice(pos));
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

  function stale(a) {
    return coded('MP_DOC_STALE', 'document changed since read; read it again before editing', {
      currentRevisionId: a.revisionId, source: a.source, dirty: a.dirty, diskChanged: a.diskChanged,
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
        if (room.members > 0 && room.members > localMembers) {
          // Any non-local member (old EXE, another DSH instance) can delete the
          // room through a leave() path this host does not control. Never append
          // an agent edit to such a room: a clean room is a safe disk write
          // (the owner adopts it); a dirty room is refused as unsaved elsewhere.
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
        bufferOwnedElsewhere, unsavedElsewhere, writable, draft, mirrorDraft, draftStale, draftUnknown,
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
        docToken: payload?.docToken, textSha256: payload?.textSha256, untitled,
      }) };
    } catch (error) { return fail(coded(error?.code || 'MP_DRAFT_IO', String(error?.message || error)), null); }
  }

  async function read(payload, invocation) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
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
        draft: a.draft === true,
        mirrorDraft: a.mirrorDraft === true,
        draftStale: a.draftStale === true,
        draftUnknown: a.draftUnknown === true,
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
        version: a.revisionId, revisionId: a.revisionId,
        head: a.room ? { epoch: a.room.epoch, version: a.room.version, savedVersion: a.room.savedVersion } : null,
        recovery: recovery.filter((entry) => entry.sha256 !== a.textSha).slice(0, 5), recommended,
        groups: typeof live.listAgentGroups === 'function' ? await live.listAgentGroups(a.canonical, 5) : [],
      },
    };
  }

  async function applyEdits(payload, invocation, policy) {
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
    const clearResolved = payload?.clearResolved === true;
    if (clearResolved && invocation) return fail(coded('bad-request', 'clearResolved is editor-only'), a);

    const rawBase = typeof payload?.baseRevisionId === 'string' ? payload.baseRevisionId
      : (typeof payload?.baseVersion === 'string' ? payload.baseVersion : '');
    const isBlock = typeof payload?.blockId === 'string' && payload.blockId.length > 0;
    const groupId = randomUUID();
    const recordGroup = async (resultRevision, auditChanges) => {
      try { await live.recordAgentGroup?.(a.canonical, {
        groupId, actor: 'agent', kind: isBlock ? 'block-edit' : 'edit',
        baseRevision: a.revisionId, resultRevision, changes: auditChanges,
      }); } catch { /* audit is best effort; never fail an edit because of it */ }
    };
    const isOldString = typeof payload?.oldString === 'string';
    const isEdits = Array.isArray(payload?.edits);

    try {
      let changes, newText, diskBase = null, block = null;
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
      } else if (isEdits) {
        if (a.source === 'buffer') {
          requireBufferBase(a, rawBase);
          changes = validateEdits(a.text, payload.edits);
          newText = applyChanges(a.text, changes);
        } else {
          if (!rawBase) return fail(coded('MP_DOC_STALE', 'baseRevisionId is required for offset edits'), a);
          diskBase = requireDiskBase(a, rawBase, { required: true });
          changes = validateEdits(a.text, payload.edits);
          newText = applyChanges(a.text, changes);
        }
      } else {
        return fail(coded('bad-request', 'oldString/newString or edits are required'), a);
      }

      const auditChanges = changes.map((c) => ({ ...c, removed: a.text.slice(c.from, c.to) }));
      if (newText === a.text) return { ok: true, value: resultValue(a, changes, null, false) };

      if (a.source === 'buffer') {
        if (invocation) await checkWritePolicy(a, policy);
        let archived = null;
        try { archived = await checkpoint(a); }
        catch (error) { return fail(error, a); }
        let result;
        try {
          result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.append(a.canonical, {
            epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text, changes, actor: 'agent', groupId,
            ...(clearResolved ? { clearResolved: true } : {}),
          }));
        } catch (error) {
          if (error?.code === 'MP_LIVE_STALE') {
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
          throw error;
        }
        const revisionId = makeLiveRevisionId(result.epoch, result.version, revisionTextSha(result.text));
        const newBlockId = block ? parseDocumentBlocks(newText).find((b) => b.ordinal === block.ordinal)?.id : null;
        await recordGroup(revisionId, auditChanges);
        return {
          ok: true,
          value: {
            changed: true, source: 'buffer', revisionId, displayPath: a.opened.value.displayPath,
            revision: { kind: 'live', epoch: result.epoch, version: result.version, savedVersion: result.savedVersion, diskHash: result.diskHash },
            version: revisionId,
            textSha256: result.textSha256, dirty: true, saved: false,
            applied: appliedOf(changes), checkpoint: archived, textLength: result.text.length,
            ...(isBlock ? { blockId: newBlockId, previousBlockId: block.id } : {}),
            groupId,
            ...(typeof result.recoveryPath === 'string' && result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
          },
        };
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
        if (isBlock) {
          value.blockId = parseDocumentBlocks(actual).find((b) => b.ordinal === block.ordinal)?.id || null;
          value.previousBlockId = block.id;
        }
        value.groupId = groupId;
        value.checkpoint = archived;
        await recordGroup(value.revisionId, auditChanges);
        return { ok: true, value };
      }
      const result = await save({ path: payload.path, cwd: payload.cwd ?? invocation?.cwd, text: newText, baseVersion: diskBase, rejectIfMirror: true });
      if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'save failed'), a);
      const version = String(result.value.version);
      const actual = await rereadDiskText(payload, invocation, version, newText);
      const value = diskResult(a, version, sha256Text(actual), changes, actual);
      if (isBlock) {
        value.blockId = parseDocumentBlocks(actual).find((b) => b.ordinal === block.ordinal)?.id || null;
        value.previousBlockId = block.id;
      }
      value.groupId = groupId;
      value.checkpoint = archived;
      await recordGroup(value.revisionId, auditChanges);
      return { ok: true, value };
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
      try {
        const result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.append(a.canonical, {
          epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text, actor: 'agent',
          changes: [{ from: 0, to: a.text.length, insert: copy.text }],
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
      } catch (error) { return fail(error, a); }
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
    const groupId = randomUUID();
    let result;
    try {
      result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.appendResolvedConflict(a.canonical, {
        epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text,
        expectedDiskHash: session.diskHash, changes, actor: 'agent', groupId,
      }));
    } catch (error) { return fail(error, a); }
    const revisionId = makeLiveRevisionId(result.epoch, result.version, revisionTextSha(result.text));
    const auditChanges = changes.map((change) => ({ ...change, removed: a.text.slice(change.from, change.to) }));
    try {
      await live.recordAgentGroup?.(a.canonical, {
        groupId, actor: 'agent', kind: 'conflict-resolve',
        baseRevision: a.revisionId, resultRevision: revisionId, changes: auditChanges,
      });
    } catch { /* audit is best effort; the write already succeeded */ }
    conflictSessions.delete(conflictId);
    return {
      ok: true,
      value: {
        changed: true, source: 'buffer', revisionId, version: revisionId,
        revision: { kind: 'live', epoch: result.epoch, version: result.version, savedVersion: result.savedVersion, diskHash: result.diskHash },
        textSha256: result.textSha256, textLength: result.text.length,
        groupId, diskVersion: a.providerVersion, resolvedDisk: session.diskHash,
        checkpoint: archived?.value || null, applied: appliedOf(changes),
      },
    };
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
    try {
      const a = await authority(payload, {});
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
    return { ok: true, value: { groups, chainOk, chainReason, currentRevisionId } };
  }

  async function undoGroups(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (typeof live.getAgentGroup !== 'function' || typeof live.markAgentGroupUndone !== 'function')
      return fail(coded('MP_GROUP_NOT_FOUND', 'agent group audit is unavailable'), a);
    const groupIds = Array.isArray(payload?.groupIds) ? payload.groupIds.slice(0, 20) : [];
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
    if (!sameRevisionContent(groups[groups.length - 1].resultRevision, a.revisionId)) return fail(stale(a), a);
    // Undoing a conflict-resolution group must re-expose the original conflict.
    // The inverse append carries clearResolved so room_resolved is deleted in
    // the same room transaction; clearing before the append would make the
    // append itself refuse as a conflict.
    const hadConflictGroup = groups.some((group) => group.kind === 'conflict-resolve');
    let text = a.text;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      if (!Array.isArray(group.changes) || group.changes.length === 0)
        return fail(coded('MP_GROUP_STALE', 'agent group has no inverse changes'), a);
      const inverse = [];
      for (const change of group.changes) {
        const from = Number(change.from), to = Number(change.to);
        const inserted = String(change.insert ?? ''), removed = String(change.removed ?? '');
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from
          || text.slice(from, from + inserted.length) !== inserted)
          return fail(coded('MP_GROUP_STALE', 'document no longer matches this edit group'), a);
        inverse.push({ from, to: from + inserted.length, insert: removed });
      }
      inverse.sort((x, y) => x.from - y.from);
      text = applyChanges(text, inverse);
    }
    if (text === a.text) return { ok: true, value: { changed: false, source: a.source, version: a.revisionId, undoOf: groupIds, reopenedConflict: hadConflictGroup } };
    const result = await applyEdits({
      path: payload.path, cwd: payload.cwd,
      edits: [{ from: 0, to: a.text.length, insert: text }],
      baseRevisionId: a.revisionId,
      ...(hadConflictGroup ? { clearResolved: true } : {}),
    }, invocation, policy);
    if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'undo failed'), a);
    for (const groupId of groupIds) {
      try { await live.markAgentGroupUndone(a.canonical, String(groupId)); } catch { /* audit best effort */ }
    }
    return { ok: true, value: { ...result.value, undoOf: groupIds, reopenedConflict: hadConflictGroup } };
  }

  async function undoGroup(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
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
    if (!sameRevisionContent(group.resultRevision, a.revisionId)) return fail(stale(a), a);
    const recent = await live.listAgentGroups(a.canonical, 20);
    const latest = recent.find((entry) => !entry.undoneAt);
    if (!latest || latest.groupId !== groupId) return fail(coded('MP_GROUP_NOT_LATEST', 'only the latest agent edit group can be undone'), a);
    if (!Array.isArray(group.changes) || group.changes.length === 0)
      return fail(coded('MP_GROUP_STALE', 'agent group has no inverse changes'), a);
    const edits = [];
    for (const change of group.changes.slice().reverse()) {
      const from = Number(change.from), to = Number(change.to);
      const inserted = String(change.insert ?? ''), removed = String(change.removed ?? '');
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || a.text.slice(from, from + inserted.length) !== inserted)
        return fail(coded('MP_GROUP_STALE', 'document no longer matches this edit group'), a);
      edits.push({ from, to: from + inserted.length, insert: removed });
    }
    edits.sort((x, y) => x.from - y.from);
    const result = await applyEdits({ path: payload.path, cwd: payload.cwd, edits, baseRevisionId: a.revisionId }, invocation, policy);
    if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'undo failed'), a);
    try { await live.markAgentGroupUndone(a.canonical, groupId); } catch { /* audit best effort */ }
    return { ok: true, value: { ...result.value, undoOf: groupId } };
  }

  return {
    read, applyEdits, state, recover, discardRecovery, undoGroup, undoGroups, merge3,
    reviewGroup, reviewGroups, conflictOpen, conflictResolve, conflictCancel,
    draftMirror, draftRead, draftClear,
  };
}

