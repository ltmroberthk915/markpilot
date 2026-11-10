// B3.2: append writes an independent post-edit recovery copy, join surfaces it
// when the room is gone and the disk does not already contain that revision,
// and retention keeps the copies bounded without touching parked drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { LiveDocuments } = require(path.resolve(here, '../../MarkPilot-CM6/shell/live-documents.js'));

async function world(initial = 'hello\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-b32-recovery-'));
  const file = path.join(root, 'doc.md');
  const dir = path.join(root, 'live');
  await fs.writeFile(file, initial, 'utf8');
  return { root, file, dir };
}
async function dropRoom(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rooms.sqlite'));
  try { db.exec('DELETE FROM clients; DELETE FROM rooms;'); } finally { db.close(); }
}
async function appendAtEnd(live, file, epoch, base) {
  return live.append(file, {
    epoch, baseVersion: base.version, baseText: base.text, actor: 'agent',
    changes: [{ from: base.text.length, to: base.text.length, insert: 'x' }],
  });
}

test('B3.2-R1 append writes a post-edit recovery copy with metadata', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const appended = await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' world' }],
  });
  assert.equal(appended.text, 'hello world\n');
  assert.equal(typeof appended.recoveryPath, 'string');
  assert.match(appended.recoveryPath, /agent-append/);
  assert.equal(await fs.readFile(appended.recoveryPath, 'utf8'), 'hello world\n');
  const meta = JSON.parse(await fs.readFile(appended.recoveryPath + '.json', 'utf8'));
  assert.equal(meta.kind, 'agent-append');
  assert.equal(meta.epoch, joined.epoch);
  assert.equal(meta.version, 1);
  assert.equal(meta.bytes, Buffer.byteLength(appended.text));
  assert.equal(meta.sha256.length, 64);
});

test('B3.2-R2 join surfaces an append copy after the room was deleted; disk already containing it is not surfaced', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const appended = await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' world' }],
  });
  assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n', 'append must not write disk');
  await dropRoom(w.dir);

  const reopened = new LiveDocuments({ directory: w.dir });
  const ticket = await reopened.join(w.file, 'hello\n');
  assert.ok(Array.isArray(ticket.recovered), 'join must surface the append copy after room loss');
  const entry = ticket.recovered.find((item) => item.kind === 'agent-append');
  assert.ok(entry, JSON.stringify(ticket.recovered));
  assert.equal(entry.recoveryPath, appended.recoveryPath);
  assert.equal(await fs.readFile(entry.recoveryPath, 'utf8'), 'hello world\n');

  // The editor saved the AI revision to disk before the room was lost: the
  // recovery copy is now identical to disk and must not be offered again.
  await fs.writeFile(w.file, appended.text, 'utf8');
  await dropRoom(w.dir);
  const afterSave = new LiveDocuments({ directory: w.dir });
  const clean = await afterSave.join(w.file, appended.text);
  assert.ok(!clean.recovered || !clean.recovered.some((item) => item.kind === 'agent-append'));
});

test('B3.2-R3 stale append does not publish a recovery copy', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const first = await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: '!' }],
  });
  const before = await live.listAppendRecovery(w.file);
  await assert.rejects(
    () => live.append(w.file, {
      epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
      changes: [{ from: 5, to: 5, insert: '?' }],
    }),
    (error) => error.code === 'MP_LIVE_STALE',
  );
  const after = await live.listAppendRecovery(w.file);
  assert.deepEqual(after.map((item) => item.recoveryPath), before.map((item) => item.recoveryPath));
  assert.equal(first.recoveryPath, before[0].recoveryPath);
});

test('B3.2-R4 retention keeps the newest 20 append copies and removes only owned sidecars', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const paths = [];
  for (let i = 0; i < 25; i++) {
    const base = await live.readRoom(w.file);
    const appended = await appendAtEnd(live, w.file, joined.epoch, base);
    paths.push(appended.recoveryPath);
  }
  const listed = await live.listAppendRecovery(w.file);
  assert.equal(listed.length, 20);
  for (const old of paths.slice(0, 5)) {
    await assert.rejects(fs.stat(old), (error) => error.code === 'ENOENT');
  }
  for (const kept of paths.slice(5)) {
    assert.equal((await fs.stat(kept)).isFile(), true);
  }
  // A recovery file without a sidecar is not owned and must never be deleted.
  const orphan = path.join(path.dirname(paths[0]), 'user-copy.agent-append.1.deadbeef.md');
  await fs.writeFile(orphan, 'DO NOT DELETE', 'utf8');
  const room = await live.readRoom(w.file);
  await appendAtEnd(live, w.file, joined.epoch, room);
  assert.equal(await fs.readFile(orphan, 'utf8'), 'DO NOT DELETE');
});

test('B3.2-R5 a failed commit rolls back and removes the just-written recovery copy', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
  try { db.exec("CREATE TRIGGER b32_fail BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'B32_FAULT'); END;"); } finally { db.close(); }
  const before = (await fs.readdir(path.join(w.dir, 'recovery', 'agent-append')).catch(() => [])).filter((n) => n.endsWith('.md'));
  await assert.rejects(
    () => live.append(w.file, {
      epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
      changes: [{ from: 5, to: 5, insert: ' world' }],
    }),
    (error) => /B32_FAULT|constraint|abort/i.test(String(error.message)),
  );
  const room = await live.readRoom(w.file);
  assert.equal(room.version, 0);
  assert.equal(room.text, 'hello\n');
  const after = (await fs.readdir(path.join(w.dir, 'recovery', 'agent-append')).catch(() => [])).filter((n) => n.endsWith('.md'));
  assert.deepEqual(after, before);
});

test('B3.2-R6 an uncommitted recovery copy is never surfaced', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const appended = await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' world' }],
  });
  const phantomPath = appended.recoveryPath.replace('.agent-append.1.', '.agent-append.2.');
  const phantomText = 'hello PHANTOM\n';
  await fs.writeFile(phantomPath, phantomText, 'utf8');
  const phantomSha = (await import('node:crypto')).createHash('sha256').update(phantomText).digest('hex');
  await fs.writeFile(phantomPath + '.json', JSON.stringify({
    schema: 1, kind: 'agent-append', sourcePath: w.file, epoch: joined.epoch, version: 2,
    at: Date.now() + 1000, bytes: Buffer.byteLength(phantomText), sha256: phantomSha,
    textLength: phantomText.length, committed: false,
  }), 'utf8');
  assert.equal((await live.listAppendRecovery(w.file)).some((item) => item.recoveryPath === phantomPath), false);
  await dropRoom(w.dir);
  const reopened = new LiveDocuments({ directory: w.dir });
  const ticket = await reopened.join(w.file, 'hello\n');
  assert.equal((ticket.recovered || []).some((item) => item.recoveryPath === phantomPath), false);
});

test('B3.2-R7 BOM/CRLF disk content matches the recovery copy by normalized text, not raw bytes', async () => {
  const w = await world('\uFEFFhello\r\n');
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const appended = await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' world' }],
  });
  assert.equal(appended.text, 'hello world\n');
  // Keep the copy newer than the disk mtime so the mtime history guard cannot
  // mask the normalized-text comparison this arm is testing.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
    try { db.prepare('UPDATE append_recovery SET at=?').run(Date.now() + 60000); } finally { db.close(); }
  }
  // Editor save encodes the original BOM/CRLF; raw disk hash differs from the
  // recovery copy's LF-text sha, but the text authority already contains it.
  await fs.writeFile(w.file, '\uFEFFhello world\r\n', 'utf8');
  await dropRoom(w.dir);
  const reopened = new LiveDocuments({ directory: w.dir });
  const ticket = await reopened.join(w.file, 'hello world\n');
  assert.equal((ticket.recovered || []).some((item) => item.recoveryPath === appended.recoveryPath), false);
});

test('B3.2-R8 parked drafts keep their UI slots ahead of newer append copies', async () => {  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const parkedText = 'parked draft\n';
  const parkedPath = path.join(w.dir, 'recovery', 'parked.md');
  await fs.mkdir(path.dirname(parkedPath), { recursive: true });
  await fs.writeFile(parkedPath, parkedText, 'utf8');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
  try {
    db.prepare('INSERT OR REPLACE INTO recovery VALUES(?,?,?,?,?,?,?,?)')
      .run(process.platform === 'win32' ? w.file.toLowerCase() : w.file, parkedPath, joined.epoch, 0, 0, 100, Buffer.byteLength(parkedText), (await import('node:crypto')).createHash('sha256').update(parkedText).digest('hex'));
  } finally { db.close(); }
  for (let i = 0; i < 5; i++) {
    const base = await live.readRoom(w.file);
    await appendAtEnd(live, w.file, joined.epoch, base);
  }
  // The room is dirty now, so append copies are intentionally not surfaced;
  // this arm still verifies the parked row is not dropped by the merge.
  const ticket = await live.join(w.file, 'hello\n');
  assert.ok((ticket.recovered || []).some((item) => item.recoveryPath === parkedPath));
});

test('B3.3-R1 UI recovery rejects paths outside the controlled directory', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const appended = await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' world' }],
  });
  await assert.rejects(
    () => live.readAppendRecovery(w.file, 'C:\\Windows\\System32\\not-a-recovery.md'),
    (error) => error.code === 'MP_RECOVERY_INVALID',
  );
  await assert.rejects(
    () => live.discardAppendRecovery(w.file, 'C:\\Windows\\System32\\not-a-recovery.md'),
    (error) => error.code === 'MP_RECOVERY_INVALID',
  );
  const copy = await live.readAppendRecovery(w.file, appended.recoveryPath);
  assert.equal(copy.text, 'hello world\n');
  const discarded = await live.discardAppendRecovery(w.file, appended.recoveryPath);
  assert.equal(discarded.removed, true);
  await assert.rejects(() => live.readAppendRecovery(w.file, appended.recoveryPath), (error) => error.code === 'MP_RECOVERY_NOT_FOUND');
});

test('B4.2B-R1 append carries group_id into exchange updates for the UI review', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const joined = await live.join(w.file, 'hello\n');
  const groupId = '11111111-1111-4111-8111-111111111111';
  await live.append(w.file, {
    epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent', groupId,
    changes: [{ from: 5, to: 5, insert: '!' }],
  });
  const exchanged = await live.exchange(joined.client, { epoch: joined.epoch, version: 0 });
  assert.equal(exchanged.updates.length, 1);
  assert.equal(exchanged.updates[0].groupId, groupId);
  assert.equal(exchanged.updates[0].changes[0].insert, '!');
});
