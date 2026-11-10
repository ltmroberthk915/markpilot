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
import { createHash } from 'node:crypto';
import { isAbsolute, sep } from 'node:path';

const LIVE_REVISION = /^rev1:live:([^:]+):(\d+):([0-9a-f]{64})$/;
const DISK_PREFIX = 'rev1:disk:';
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

export function parseRevisionId(value) {
  if (typeof value !== 'string' || !value) return null;
  const live = LIVE_REVISION.exec(value);
  if (live) return { kind: 'live', epoch: live[1], version: Number(live[2]), textSha: live[3] };
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
      let diskChanged = false;
      if (room) {
        const roomDirty = room.version !== room.savedVersion;
        diskChanged = room.savedTextAvailable ? (normalizeCompare(providerText) !== room.savedText) : null;
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
            if (diskChanged === true) conflict = true;
          }
        } else if (roomDirty) {
          source = 'disk'; orphanDraft = true;
        }
      }
      const textSha = sha256Text(text);
      const revisionId = source === 'buffer'
        ? makeLiveRevisionId(room.epoch, room.version, textSha)
        : makeDiskRevisionId(providerVersion, source === 'disk' ? providerSha : textSha);
      const revision = source === 'buffer'
        ? { kind: 'live', epoch: room.epoch, version: room.version, savedVersion: room.savedVersion, diskHash: room.diskHash }
        : { kind: 'disk', version: providerVersion, diskHash: null };
      return {
        target, opened, canonical: canonicalPath, room, providerText, providerVersion, providerSha,
        source, text, dirty, conflict, orphanDraft, external, diskChanged, textSha, revisionId, revision,
        bufferOwnedElsewhere, unsavedElsewhere,
      };
    }
    throw coded('FS_STALE_VERSION', 'file changed during read; retry after the external write finishes');
  }

  function requireBufferBase(a, raw) {
    const token = parseRevisionId(raw);
    if (!token || token.kind !== 'live') throw stale(a);
    if (token.epoch !== a.room.epoch || token.version !== a.room.version || token.textSha !== a.textSha)
      throw stale(a);
  }

  function requireDiskBase(a, raw, { required }) {
    if (!raw) {
      if (required) throw stale(a);
      return null;
    }
    const token = parseRevisionId(raw);
    if (token?.kind === 'disk') {
      if (token.version !== a.providerVersion || token.textSha !== a.providerSha) throw stale(a);
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
    // Every buffer edit is checkpointed, including a clean buffer: the editor's
    // normal auto-save follows a remote change and overwrites the disk copy, so
    // the disk is NOT a durable "pre-edit" copy by the time the user notices.
    // Deliberately no off switch: the model tool must never be able to disable it.
    if (a.source !== 'buffer') return null;
    if (typeof archive !== 'function') throw coded('MP_ARCHIVE_FAILED', 'checkpoint is unavailable');
    let result;
    try { result = await archive({ path: a.canonical || a.opened.value.displayPath || payloadPath(a), text: a.text, tag: 'agent-before', baseVersion: a.providerVersion }); }
    catch (error) { throw coded('MP_ARCHIVE_FAILED', 'checkpoint failed: ' + String(error?.message || error), { cause: error }); }
    if (!result || result.ok !== true) throw coded('MP_ARCHIVE_FAILED', 'checkpoint failed');
    return result.value || null;
  }

  function payloadPath(a) { return a?.opened?.value?.displayPath || ''; }

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
        textSha256: a.textSha,
        dirty: a.dirty,
        diskChanged: a.diskChanged,
        conflict: a.conflict,
        orphanDraft: a.orphanDraft,
        external: a.external,
        bufferOwnedElsewhere: a.bufferOwnedElsewhere,
        unsavedElsewhere: a.unsavedElsewhere,
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
    catch (error) { return fail(error, null); }
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
      },
    };
  }

  async function applyEdits(payload, invocation, policy) {
    let a;
    try { a = await authority(payload, invocation); }
    catch (error) { return fail(error, null); }
    if (a.error) return a.error;
    if (a.unsavedElsewhere) return fail(coded('MP_DOC_UNSAVED_ELSEWHERE', 'another window has unsaved edits in this document; save or resolve them there first', { source: a.source }), a);
    if (a.orphanDraft) return fail(coded('MP_DOC_ORPHAN_DRAFT', 'this document has an unsaved draft from a closed editor; open it and resolve the draft first', { source: a.source }), a);
    if (a.conflict) return fail(coded('MP_DOC_EXTERNAL_CONFLICT', 'the buffer has unsaved edits and the file changed on disk; resolve the conflict in the editor first', { source: a.source, dirty: a.dirty, diskChanged: a.diskChanged }), a);

    const rawBase = typeof payload?.baseRevisionId === 'string' ? payload.baseRevisionId
      : (typeof payload?.baseVersion === 'string' ? payload.baseVersion : '');
    const isOldString = typeof payload?.oldString === 'string';
    const isEdits = Array.isArray(payload?.edits);

    try {
      let changes, newText, diskBase = null;
      if (isOldString) {
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

      if (newText === a.text) return { ok: true, value: resultValue(a, changes, null, false) };

      if (a.source === 'buffer') {
        await checkWritePolicy(a, policy);
        let archived = null;
        try { archived = await checkpoint(a); }
        catch (error) { return fail(error, a); }
        let result;
        try {
          result = await (enqueue || ((_key, action) => action()))(a.canonical, () => live.append(a.canonical, {
            epoch: a.room.epoch, baseVersion: a.room.version, baseText: a.text, changes, actor: 'agent',
          }));
        } catch (error) {
          if (error?.code === 'MP_LIVE_STALE') {
            let currentRevisionId = null;
            try {
              const now = await live.readRoom(a.canonical);
              if (now && now.epoch === a.room.epoch)
                currentRevisionId = makeLiveRevisionId(now.epoch, now.version, now.textSha256);
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
        const revisionId = makeLiveRevisionId(result.epoch, result.version, result.textSha256);
        return {
          ok: true,
          value: {
            changed: true, source: 'buffer', revisionId, displayPath: a.opened.value.displayPath,
            revision: { kind: 'live', epoch: result.epoch, version: result.version, savedVersion: result.savedVersion, diskHash: result.diskHash },
            version: revisionId,
            textSha256: result.textSha256, dirty: true, saved: false,
            applied: appliedOf(changes), checkpoint: archived, textLength: result.text.length,
            ...(typeof result.recoveryPath === 'string' && result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
          },
        };
      }

      // Disk authority: reuse the existing guarded endpoints. Never wrap this in
      // enqueue: apiEdit/apiSave already enter the same per-path queue.
      // apiEdit carries the policy itself; apiSave does not for the local native
      // branch, so enforce the same policy once here for both shapes.
      await checkWritePolicy(a, policy);
      if (isOldString) {
        const result = await edit({
          path: payload.path, cwd: payload.cwd, oldString: payload.oldString,
          newString: payload.newString, replaceAll: payload.replaceAll === true,
          baseVersion: diskBase ?? a.providerVersion,
        }, invocation);
        if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'edit failed'), a);
        const version = String(result.value.version);
        const actual = await rereadDiskText(payload, invocation, version, newText);
        return { ok: true, value: diskResult(a, version, sha256Text(actual), changes, actual) };
      }
      const result = await save({ path: payload.path, cwd: payload.cwd ?? invocation?.cwd, text: newText, baseVersion: diskBase });
      if (!result || result.ok !== true) return result || fail(coded('FS_IO_ERROR', 'save failed'), a);
      const version = String(result.value.version);
      const actual = await rereadDiskText(payload, invocation, version, newText);
      return { ok: true, value: diskResult(a, version, sha256Text(actual), changes, actual) };
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
    const revisionId = makeDiskRevisionId(version, sha);
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
    if (a && code === 'MP_DOC_STALE') {
      value.currentRevisionId = a.revisionId;
      value.source = a.source;
      value.dirty = a.dirty;
      if (typeof a.diskChanged === 'boolean') value.diskChanged = a.diskChanged;
    }
    try { log?.warn?.('documents: %s: %s', code, value.message); } catch { /* best effort */ }
    return { ok: false, error: value };
  }

  return { read, applyEdits, state };
}
