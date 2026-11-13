// B3 authority primitives: readRoom/append and the leave() protection for an
// agent edit that no editor acknowledged. Real SQLite rooms in a private temp
// directory; no product instance is started.
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-b3-authority-'));
  const file = path.join(root, 'doc.md');
  const dir = path.join(root, 'live');
  await fs.writeFile(file, initial, 'utf8');
  return { root, file, dir };
}
function apply(text, changes) {
  let end = 0; const parts = [];
  for (const c of changes) { parts.push(text.slice(end, c.from), c.insert); end = c.to; }
  parts.push(text.slice(end)); return parts.join('');
}
async function roomRows(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rooms.sqlite'));
  try { return db.prepare('SELECT file,epoch,version,saved,floor,length FROM rooms').all(); }
  finally { db.close(); }
}
async function clientRows(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rooms.sqlite'));
  try { return db.prepare('SELECT id,pid,seq,ack FROM clients').all(); }
  finally { db.close(); }
}

test('B3-A1 readRoom never creates the rooms store and returns null without a room', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  assert.equal(await live.readRoom(w.file), null);
  await assert.rejects(() => fs.stat(path.join(w.dir, 'rooms.sqlite')), (e) => e.code === 'ENOENT');
});

test('B3-A1b a corrupt rooms store is a read fallback, and append refuses instead of throwing', async () => {
  const w = await world();
  await fs.mkdir(w.dir, { recursive: true });
  await fs.writeFile(path.join(w.dir, 'rooms.sqlite'), 'not a sqlite database', 'utf8');
  const live = new LiveDocuments({ directory: w.dir });
  assert.equal(await live.readRoom(w.file), null);
  await assert.rejects(
    () => live.append(w.file, { epoch: 'e', baseVersion: 0, baseText: 'hello\n', changes: [{ from: 0, to: 0, insert: 'x' }], actor: 'agent' }),
    (e) => e.code === 'MP_LIVE_NO_ROOM');
});

test('B3-A2 readRoom reports clean/dirty text, saved version and live members', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const a = await live.join(w.file, 'hello\n');
  const b = await live.join(w.file, 'hello\n');
  const clean = await live.readRoom(w.file);
  assert.equal(clean.epoch, a.epoch);
  assert.equal(clean.version, 0);
  assert.equal(clean.savedVersion, 0);
  assert.equal(clean.members, 2);
  assert.equal(clean.savedTextAvailable, true);
  assert.equal(clean.text, 'hello\n');
  assert.equal(clean.savedText, 'hello\n');
  const appended = await live.append(w.file, {
    epoch: a.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' world' }],
  });
  assert.equal(appended.version, 1);
  assert.equal(appended.savedVersion, 0);
  assert.equal(appended.text, 'hello world\n');
  const dirty = await live.readRoom(w.file);
  assert.equal(dirty.version, 1);
  assert.equal(dirty.savedVersion, 0);
  assert.equal(dirty.text, 'hello world\n');
  assert.equal(dirty.savedText, 'hello\n');
  assert.equal(dirty.members, 2);
  const exchanged = await live.exchange(b.client, { epoch: b.epoch, version: 0 });
  assert.deepEqual(exchanged.updates.map((u) => ({ version: u.version, client: u.client, seq: u.seq })),
    [{ version: 1, client: 'agent', seq: 0 }]);
});

test('B3-A3 append rejects stale bases, invalid changes, CR inserts and no members', async () => {
  const w = await world();
  const live = new LiveDocuments({ directory: w.dir });
  const a = await live.join(w.file, 'hello\n');
  const good = { from: 5, to: 5, insert: '!' };
  await live.append(w.file, { epoch: a.epoch, baseVersion: 0, baseText: 'hello\n', changes: [good], actor: 'agent' });
  await assert.rejects(
    () => live.append(w.file, { epoch: a.epoch, baseVersion: 0, baseText: 'hello\n', changes: [good], actor: 'agent' }),
    (e) => e.code === 'MP_LIVE_STALE');
  await assert.rejects(
    () => live.append(w.file, { epoch: a.epoch, baseVersion: 1, baseText: 'hello!\n', changes: [{ from: 6, to: 5, insert: 'x' }], actor: 'agent' }),
    (e) => e.code === 'MP_LIVE_CHANGE');
  await assert.rejects(
    () => live.append(w.file, { epoch: a.epoch, baseVersion: 1, baseText: 'hello!\n', changes: [{ from: 6, to: 6, insert: '\r' }], actor: 'agent' }),
    (e) => e.code === 'MP_LIVE_CHANGE');
  // Remove the only client but keep the room: append must refuse rather than
  // create an unwatched dirty room.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
  db.exec('DELETE FROM clients');
  db.close();
  const room = (await roomRows(w.dir))[0];
  assert.equal(room.version, 1);
  await assert.rejects(
    () => live.append(w.file, { epoch: a.epoch, baseVersion: 1, baseText: 'hello!\n', changes: [{ from: 6, to: 6, insert: '?' }], actor: 'agent' }),
    (e) => e.code === 'MP_LIVE_NO_MEMBER');
});

test('B3-A4 savedText is unavailable once compact passes the saved version', async () => {
  const w = await world('start\n');
  const live = new LiveDocuments({ directory: w.dir });
  const a = await live.join(w.file, 'start\n');
  const b = await live.join(w.file, 'start\n');
  let version = 0;
  for (let i = 0; i < 130; i++) {
    const room = (await roomRows(w.dir))[0];
    const changes = [{ from: room.length, to: room.length, insert: 'x' }];
    const client = i % 2 === 0 ? a.client : b.client;
    const seq = Math.floor(i / 2) + 1;
    const r = await live.exchange(client, { epoch: a.epoch, version, seq, changes });
    version = r.version;
  }
  const room = (await roomRows(w.dir))[0];
  assert.equal(room.version, 130);
  assert.equal(room.saved, 0);
  assert.ok(room.floor > room.saved, `floor ${room.floor} must pass saved ${room.saved}`);
  const read = await live.readRoom(w.file);
  assert.equal(read.version, 130);
  assert.equal(read.savedVersion, 0);
  assert.equal(read.savedTextAvailable, false);
  assert.equal(read.savedText, null);
  assert.equal(read.text.length, 136);
});

test('B3-A5 leave keeps an unacknowledged agent edit; an acknowledged one is retired', async () => {
  // unacked: the room survives, and the next join parks it as a recovery file
  const w1 = await world('hello\n');
  const live1 = new LiveDocuments({ directory: w1.dir });
  const a1 = await live1.join(w1.file, 'hello\n');
  await live1.append(w1.file, {
    epoch: a1.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' agent' }],
  });
  live1.leave(a1.client);
  assert.equal((await roomRows(w1.dir)).length, 1, 'unacked agent room must survive leave');
  assert.equal((await clientRows(w1.dir)).length, 0);
  const live2 = new LiveDocuments({ directory: w1.dir });
  const joined = await live2.join(w1.file, 'hello\n');
  assert.ok(Array.isArray(joined.recovered) && joined.recovered.length > 0, 'next join must surface the parked draft');
  const recovered = await fs.readFile(joined.recovered[0].recoveryPath, 'utf8');
  assert.equal(recovered, 'hello agent\n');

  // acked: the editor has applied it; the room is retired normally
  const w2 = await world('hello\n');
  const live3 = new LiveDocuments({ directory: w2.dir });
  const a3 = await live3.join(w2.file, 'hello\n');
  const appended = await live3.append(w2.file, {
    epoch: a3.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
    changes: [{ from: 5, to: 5, insert: ' agent' }],
  });
  await live3.exchange(a3.client, { epoch: a3.epoch, version: appended.version });
  live3.leave(a3.client);
  assert.equal((await roomRows(w2.dir)).length, 0, 'acknowledged agent room is retired');
});

test('B3-A6 two instances append the same base: exactly one wins', async () => {
  const w = await world('hello\n');
  const one = new LiveDocuments({ directory: w.dir });
  const two = new LiveDocuments({ directory: w.dir });
  const a = await one.join(w.file, 'hello\n');
  const b = await two.join(w.file, 'hello\n');
  const base = await one.readRoom(w.file);
  const results = await Promise.allSettled([
    one.append(w.file, { epoch: a.epoch, baseVersion: base.version, baseText: base.text, changes: [{ from: 5, to: 5, insert: '!' }], actor: 'agent' }),
    two.append(w.file, { epoch: b.epoch, baseVersion: base.version, baseText: base.text, changes: [{ from: 5, to: 5, insert: '?' }], actor: 'agent' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'MP_LIVE_STALE');
  assert.equal((await roomRows(w.dir))[0].version, 1);
});

test('B4.3-A1 rooms schema stays 8 columns; old positional INSERT still works', async () => {
  const w = await world('hello\n');
  const live = new LiveDocuments({ directory: w.dir });
  await live.join(w.file, 'hello\n');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(rooms)').all().map((column) => column.name);
    assert.deepEqual(columns, ['file', 'epoch', 'version', 'saved', 'disk', 'length', 'floor', 'checkpoint']);
    const otherFile = path.join(w.root, 'other.md');
    const otherEpoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    assert.doesNotThrow(() => db.prepare('INSERT INTO rooms VALUES(?,?,0,0,?,?,0,?)')
      .run(otherFile, otherEpoch, 'disk-hash', 0, Buffer.alloc(0)));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 2);
  } finally { db.close(); }
});
