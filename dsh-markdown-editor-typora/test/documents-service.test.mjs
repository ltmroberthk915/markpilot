// B3 documents-service unit tests: authority selection, revision tokens,
// buffer append, disk delegation, and the self-written sandbox policy gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDocumentsService, parseRevisionId, makeLiveRevisionId, makeDiskRevisionId,
  sha256Text, normalizeCompare, isCanonicalUnder, replaceExact,
} from '../lib/documents-service.js';

function makeWorld(options = {}) {
  const file = options.file ?? 'D:/notes/a.md';
  let text = options.text ?? 'hello\n';
  let version = options.version ?? 'v1';
  let diskVersion = version;
  const calls = { append: [], edit: [], save: [], archive: [] };
  const room = options.room === undefined ? null : options.room;
  if (room && room.localMembers === undefined) room.localMembers = room.members;
  const live = {
    async readRoom(p) { assert.equal(p, file); return room; },
    async append(p, req) {
      assert.equal(p, file);
      calls.append.push(req);
      const next = req.baseText.replace(/x/g, '') + req.changes.map((c) => c.insert).join('');
      room.version += 1;
      room.text = next;
      room.textSha256 = sha256Text(next);
      return { epoch: room.epoch, version: room.version, savedVersion: room.savedVersion, diskHash: room.diskHash, text: next, textSha256: sha256Text(next) };
    },
  };
  const service = createDocumentsService({
    live,
    sandboxMode: options.sandboxMode,
    async openModel() { return { ok: true, value: { text, version, displayPath: file, size: text.length } }; },
    async edit(payload) {
      calls.edit.push(payload);
      if (payload.oldString !== undefined && !text.includes(payload.oldString)) return { ok: false, error: { code: 'FS_EDIT_NOT_FOUND', message: 'not found' } };
      if (payload.oldString !== undefined) text = text.replace(payload.oldString, payload.newString);
      version = 'v' + (Number(String(version).slice(1)) + 1); diskVersion = version;
      return { ok: true, value: { version, displayPath: file, changed: true } };
    },
    async save(payload) {
      calls.save.push(payload);
      assert.equal(payload.baseVersion, version);
      text = payload.text; version = 'v' + (Number(String(version).slice(1)) + 1); diskVersion = version;
      return { ok: true, value: { version, displayPath: file } };
    },
    async archive(payload) { calls.archive.push(payload); return { ok: true, value: { archivePath: 'C:/archive/a.md', sha256: sha256Text(payload.text) } }; },
    async resolve() { return { targetKey: file, displayPath: file }; },
    async stat() { return { version: diskVersion }; },
    async canonical(target) {
      const p = target?.targetKey ?? target?.displayPath ?? '';
      return String(p);
    },
    localPath() { return file; },
    enqueue(_key, action) { return action(); },
    log: { warn() {} },
  });
  return { service, live, calls, file, get state() { return { text, version, room }; }, setText(v) { text = v; }, setVersion(v) { version = v; diskVersion = v; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('B3-S1 read: no room is disk; a clean live room is buffer; disk change switches to disk', async () => {
  const w = makeWorld();
  const disk = await w.service.read({ path: w.file }, {});
  assert.equal(disk.ok, true);
  assert.equal(disk.value.source, 'disk');
  assert.equal(disk.value.text, 'hello\n');
  assert.equal(disk.value.dirty, false);
  assert.equal(disk.value.version, disk.value.revisionId);
  assert.equal(parseRevisionId(disk.value.version).kind, 'disk');

  const room = { epoch: 'e-1', version: 2, savedVersion: 2, diskHash: 'd1', text: 'buffer\n', savedText: 'hello\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('buffer\n') };
  const w2 = makeWorld({ room });
  const buffer = await w2.service.read({ path: w2.file }, {});
  assert.equal(buffer.value.source, 'buffer');
  assert.equal(buffer.value.text, 'buffer\n');
  assert.equal(buffer.value.dirty, false);
  assert.equal(parseRevisionId(buffer.value.version).kind, 'live');

  // provider text differs from the room's saved text, room is clean => disk
  room.savedText = 'old\n';
  const external = await w2.service.read({ path: w2.file }, {});
  assert.equal(external.value.source, 'disk');
  assert.equal(external.value.external, true);
  assert.equal(external.value.text, 'hello\n');
});

test('B3-S1b BOM/CRLF provider text compares equal to the room saved text', async () => {
  const room = { epoch: 'e-1', version: 2, savedVersion: 2, diskHash: 'd1', text: 'hello\n', savedText: 'hello\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('hello\n') };
  const w = makeWorld({ text: '\uFEFFhello\r\n', room });
  const r = await w.service.read({ path: w.file }, {});
  assert.equal(r.value.source, 'buffer');
  assert.equal(r.value.text, 'hello\n');
  assert.equal(r.value.diskChanged, false);
});

test('B3-S2 read: dirty room + changed disk is a conflict; dead member dirty room is an orphan', async () => {
  const room = { epoch: 'e-1', version: 3, savedVersion: 2, diskHash: 'd1', text: 'buffer\n', savedText: 'old\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('buffer\n') };
  const w = makeWorld({ room });
  const conflict = await w.service.read({ path: w.file }, {});
  assert.equal(conflict.value.source, 'buffer');
  assert.equal(conflict.value.conflict, true);
  assert.equal(conflict.value.dirty, true);

  room.members = 0;
  const orphan = await w.service.read({ path: w.file }, {});
  assert.equal(orphan.value.source, 'disk');
  assert.equal(orphan.value.orphanDraft, true);
  assert.equal(orphan.value.text, 'hello\n');
});

test('B3-S3 read: unavailable savedText means diskChanged unknown and buffer authority', async () => {
  const room = { epoch: 'e-1', version: 3, savedVersion: 1, diskHash: 'd1', text: 'buffer\n', savedText: null, savedTextAvailable: false, members: 1, textSha256: sha256Text('buffer\n') };
  const w = makeWorld({ room });
  const r = await w.service.read({ path: w.file }, {});
  assert.equal(r.value.source, 'buffer');
  assert.equal(r.value.diskChanged, null);
  assert.equal(r.value.conflict, false);
});

test('B3-S4 applyEdits buffer: stale token refuses, valid token appends and checkpoints a dirty buffer', async () => {
  const room = { epoch: 'e-1', version: 1, savedVersion: 0, diskHash: 'd1', text: 'hello\n', savedText: 'hello\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('hello\n') };
  const w = makeWorld({ room });
  const before = await w.service.read({ path: w.file }, {});
  const stale = await w.service.applyEdits({
    path: w.file, baseRevisionId: makeLiveRevisionId('e-1', 0, sha256Text('hello\n')),
    oldString: 'hello', newString: 'bye',
  }, {}, undefined);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'MP_DOC_STALE');
  assert.equal(stale.error.currentRevisionId, before.value.revisionId);
  assert.equal(w.calls.append.length, 0);
  assert.equal(w.calls.archive.length, 0);

  const ok = await w.service.applyEdits({
    path: w.file, baseRevisionId: before.value.revisionId,
    oldString: 'hello', newString: 'bye',
  }, {}, undefined);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.changed, true);
  assert.equal(ok.value.source, 'buffer');
  assert.equal(ok.value.saved, false);
  assert.equal(ok.value.dirty, true);
  assert.equal(w.calls.append.length, 1);
  assert.equal(w.calls.append[0].baseVersion, 1);
  assert.equal(w.calls.append[0].baseText, 'hello\n');
  assert.deepEqual(w.calls.append[0].changes, [{ from: 0, to: 5, insert: 'bye' }]);
  assert.equal(w.calls.archive.length, 1);
  assert.equal(w.calls.archive[0].tag, 'agent-before');
  assert.equal(ok.value.checkpoint.archivePath, 'C:/archive/a.md');
});

test('B3-S4b an append that loses a race maps to MP_DOC_STALE', async () => {
  const room = { epoch: 'e-1', version: 1, savedVersion: 1, diskHash: 'd1', text: 'hello\n', savedText: 'hello\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('hello\n') };
  const w = makeWorld({ room });
  const base = makeLiveRevisionId('e-1', 1, sha256Text('hello\n'));
  w.live.append = async () => { throw Object.assign(new Error('stale'), { code: 'MP_LIVE_STALE' }); };
  const r = await w.service.applyEdits({ path: w.file, baseRevisionId: base, oldString: 'hello', newString: 'bye' }, {}, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MP_DOC_STALE');
  assert.equal(r.error.currentRevisionId, base);
  assert.equal(r.error.checkpointPath, 'C:/archive/a.md');
  assert.equal(w.calls.archive.length, 1);
});

test('B3-S5 applyEdits buffer: clean room is still checkpointed; no-op does not append', async () => {
  const room = { epoch: 'e-1', version: 2, savedVersion: 2, diskHash: 'd1', text: 'hello\n', savedText: 'hello\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('hello\n') };
  const w = makeWorld({ room });
  const base = makeLiveRevisionId('e-1', 2, sha256Text('hello\n'));
  const noop = await w.service.applyEdits({ path: w.file, baseRevisionId: base, oldString: 'hello', newString: 'hello' }, {}, undefined);
  assert.equal(noop.ok, true);
  assert.equal(noop.value.changed, false);
  assert.equal(w.calls.append.length, 0);
  assert.equal(w.calls.archive.length, 0);

  const ok = await w.service.applyEdits({ path: w.file, baseRevisionId: base, oldString: 'hello', newString: 'bye', checkpoint: false }, {}, undefined);
  assert.equal(ok.ok, true);
  assert.equal(w.calls.archive.length, 1, 'checkpoint:false from a caller must not disable the safety copy');
  assert.equal(w.calls.append.length, 1);
});

test('B3-S6 applyEdits disk: oldString delegates to edit with the provider version; edits delegate to save', async () => {
  const w = makeWorld();
  const disk = await w.service.read({ path: w.file }, {});
  const oldString = await w.service.applyEdits({ path: w.file, baseRevisionId: disk.value.version, oldString: 'hello', newString: 'bye' }, {}, undefined);
  assert.equal(oldString.ok, true);
  assert.equal(oldString.value.saved, true);
  assert.equal(oldString.value.source, 'disk');
  assert.equal(w.calls.edit.length, 1);
  assert.equal(w.calls.edit[0].baseVersion, 'v1');
  assert.equal(parseRevisionId(oldString.value.version).kind, 'disk');

  const w2 = makeWorld();
  const disk2 = await w2.service.read({ path: w2.file }, {});
  const edits = await w2.service.applyEdits({
    path: w2.file, baseRevisionId: disk2.value.version,
    edits: [{ from: 0, to: 5, insert: 'bye' }],
  }, {}, undefined);
  assert.equal(edits.ok, true);
  assert.equal(edits.value.saved, true);
  assert.equal(w2.calls.save.length, 1);
  assert.equal(w2.calls.save[0].text, 'bye\n');
  assert.equal(w2.calls.save[0].baseVersion, 'v1');
});

test('B3-S7 applyEdits refuses orphan drafts and external conflicts without touching the room', async () => {
  const room = { epoch: 'e-1', version: 3, savedVersion: 2, diskHash: 'd1', text: 'buffer\n', savedText: 'old\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('buffer\n') };
  const w = makeWorld({ room });
  const conflict = await w.service.applyEdits({ path: w.file, oldString: 'buffer', newString: 'x' }, {}, undefined);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'MP_DOC_EXTERNAL_CONFLICT');
  assert.equal(w.calls.append.length, 0);

  room.members = 0;
  const orphan = await w.service.applyEdits({ path: w.file, oldString: 'hello', newString: 'x' }, {}, undefined);
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error.code, 'MP_DOC_ORPHAN_DRAFT');
  assert.equal(w.calls.append.length, 0);
});

test('B3-S8 the buffer write policy is fail-closed for read-only and outside the workspace', async () => {
  const baseRoom = { epoch: 'e-1', version: 2, savedVersion: 2, diskHash: 'd1', text: 'hello\n', savedText: 'hello\n', savedTextAvailable: true, members: 1, textSha256: sha256Text('hello\n') };
  const mkRoom = () => ({ ...baseRoom });
  const base = makeLiveRevisionId('e-1', 2, sha256Text('hello\n'));
  const readOnly = makeWorld({ room: mkRoom(), sandboxMode: 'workspace-write' });
  const denied = await readOnly.service.applyEdits({ path: readOnly.file, baseRevisionId: base, oldString: 'hello', newString: 'bye' }, {}, { mode: 'read-only' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'FS_SANDBOX_DENIED');
  assert.equal(readOnly.calls.append.length, 0);

  const outside = makeWorld({ room: mkRoom(), sandboxMode: 'workspace-write' });
  const out = await outside.service.applyEdits({ path: outside.file, baseRevisionId: base, oldString: 'hello', newString: 'bye' }, {}, { mode: 'workspace-write', workspaceRoot: 'D:/other' });
  assert.equal(out.error.code, 'FS_SANDBOX_DENIED');

  const inside = makeWorld({ room: mkRoom(), sandboxMode: 'workspace-write' });
  const ok = await inside.service.applyEdits({ path: inside.file, baseRevisionId: base, oldString: 'hello', newString: 'bye' }, {}, { mode: 'workspace-write', workspaceRoot: 'D:/notes' });
  assert.equal(ok.ok, true);
  assert.equal(inside.calls.append.length, 1);

  const full = makeWorld({ room: mkRoom(), sandboxMode: 'danger-full-access' });
  const allowed = await full.service.applyEdits({ path: full.file, baseRevisionId: base, oldString: 'hello', newString: 'bye' }, {}, { mode: 'danger-full-access' });
  assert.equal(allowed.ok, true);

  const unknown = makeWorld({ room: mkRoom(), sandboxMode: 'workspace-write' });
  const deniedUnknown = await unknown.service.applyEdits({ path: unknown.file, baseRevisionId: base, oldString: 'hello', newString: 'bye' }, {}, { mode: 'future-mode' });
  assert.equal(deniedUnknown.ok, false);
  assert.equal(deniedUnknown.error.code, 'FS_SANDBOX_DENIED');

  // Disk `edits[]` delegates to apiSave, which has no policy gate of its own.
  const disk = makeWorld({ sandboxMode: 'workspace-write' });
  const diskRead = await disk.service.read({ path: disk.file }, {});
  const deniedDisk = await disk.service.applyEdits({
    path: disk.file, baseRevisionId: diskRead.value.version, edits: [{ from: 0, to: 5, insert: 'bye' }],
  }, {}, { mode: 'workspace-write', workspaceRoot: 'D:/other' });
  assert.equal(deniedDisk.ok, false);
  assert.equal(deniedDisk.error.code, 'FS_SANDBOX_DENIED');
  assert.equal(disk.calls.save.length, 0);
});

test('B3-S9 revision tokens round-trip, including provider versions with colons', () => {
  const live = makeLiveRevisionId('e-1', 42, sha256Text('x'));
  assert.deepEqual(parseRevisionId(live), { kind: 'live', epoch: 'e-1', version: 42, textSha: sha256Text('x') });
  const disk = makeDiskRevisionId('dev:ino:size:mtime:ctime', sha256Text('x'));
  assert.deepEqual(parseRevisionId(disk), { kind: 'disk', version: 'dev:ino:size:mtime:ctime', textSha: sha256Text('x') });
  assert.equal(parseRevisionId('rev1:live:nope'), null);
  assert.equal(parseRevisionId(''), null);
  assert.equal(parseRevisionId('v1'), null);
});

test('B3-S10 path containment, EOL compare and exact replace semantics are stable', () => {
  assert.equal(isCanonicalUnder('D:/notes/a.md', 'D:/notes'), true);
  assert.equal(isCanonicalUnder('D:/notes/a.md', 'D:/other'), false);
  assert.equal(isCanonicalUnder('D:/notes2/a.md', 'D:/notes'), false);
  assert.equal(isCanonicalUnder('D:/notes/a.md', ''), false);
  assert.equal(isCanonicalUnder('\\\\?\\D:\\notes\\a.md', 'd:/notes'), true);
  assert.equal(isCanonicalUnder('\\\\?\\UNC\\server\\share\\a.md', '\\\\server\\share'), true);
  assert.equal(normalizeCompare('\uFEFFhello\r\nworld'), 'hello\nworld');
  const one = replaceExact('a b c', 'a', 'x', false);
  assert.deepEqual(one.changes, [{ from: 0, to: 1, insert: 'x' }]);
  assert.throws(() => replaceExact('a b a', 'a', 'x', false), (e) => e.code === 'FS_AMBIGUOUS_EDIT');
  const all = replaceExact('a b a', 'a', 'x', true);
  assert.deepEqual(all.changes, [{ from: 0, to: 1, insert: 'x' }, { from: 4, to: 5, insert: 'x' }]);
  assert.equal(all.newText, 'x b x');
});
