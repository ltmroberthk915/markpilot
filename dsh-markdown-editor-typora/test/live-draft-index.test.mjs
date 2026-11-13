import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LiveDocuments, retireLiveStorage } = require('../../MarkPilot-CM6/shell/live-documents.js');
const sha = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const BASE = 'a'.repeat(64);
const TOKEN = 'draft-token-1';

async function world(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mp-draft-${name}-`));
  const live = path.join(root, 'live');
  const file = path.join(root, 'a.md');
  await fs.writeFile(file, 'disk\n', 'utf8');
  return { root, live, file, cleanup: async () => { retireLiveStorage(); await fs.rm(root, { recursive: true, force: true }); } };
}

const put = (live, file, text, extra = {}) => live.putDraft(file, {
  text, baseVersion: 'v1', baseSha256: BASE, docToken: TOKEN, ...extra,
});

test('D1 round-trip normalizes text, hides body from list, detects corruption', async () => {
  const w = await world('roundtrip');
  try {
    const live = new LiveDocuments({ directory: w.live });
    const saved = await put(live, w.file, 'line1\r\nline2');
    assert.equal(saved.kind, 'file');
    assert.equal(saved.bytes, 11);
    assert.equal(saved.created, true);
    const got = await live.getDraft(w.file, { docToken: TOKEN });
    assert.equal(got.text, 'line1\nline2');
    assert.equal(got.textSha256, sha('line1\nline2'));
    const list = await live.listDrafts();
    assert.equal(list.length, 1);
    assert.equal('text' in list[0], false);
    const db = new (await import('node:sqlite')).DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    db.prepare("UPDATE draft_index SET text_sha=? WHERE source LIKE '%a.md'").run('0'.repeat(64));
    db.close();
    await assert.rejects(live.getDraft(w.file, { docToken: TOKEN }), (e) => e.code === 'MP_DRAFT_CORRUPT');
    await live.clearDraft(w.file, { docToken: TOKEN });
  } finally { await w.cleanup(); }
});

test('D2 8 MiB accepted and 8 MiB + 1 rejected without a row', async () => {
  const w = await world('size');
  try {
    const live = new LiveDocuments({ directory: w.live });
    const max = 8 * 1024 * 1024;
    const ok = await put(live, w.file, 'a'.repeat(max));
    assert.equal(ok.bytes, max);
    await assert.rejects(put(live, w.file, 'a'.repeat(max + 1)), (e) => e.code === 'MP_DRAFT_TOO_LARGE');
    const got = await live.getDraft(w.file, { docToken: TOKEN });
    assert.equal(got.bytes, max);
  } finally { await w.cleanup(); }
});

test('D3 item and total-byte limits reject new rows without evicting old ones', async () => {
  const w = await world('limits');
  try {
    const live = new LiveDocuments({ directory: w.live, draftLimits: { maxRows: 1, maxTotalBytes: 16, maxBytes: 1024 } });
    await put(live, w.file, 'one');
    const other = path.join(w.root, 'b.md');
    await fs.writeFile(other, 'disk\n', 'utf8');
    await assert.rejects(put(live, other, 'two', { docToken: 'other' }), (e) => e.code === 'MP_DRAFT_LIMIT');
    await assert.rejects(put(live, w.file, '0123456789abcdefg'), (e) => e.code === 'MP_DRAFT_LIMIT');
    const got = await live.getDraft(w.file, { docToken: TOKEN });
    assert.equal(got.text, 'one');
  } finally { await w.cleanup(); }
});

test('D4 expired rows are hidden and prune removes only expired rows', async () => {
  const w = await world('expiry');
  try {
    const live = new LiveDocuments({ directory: w.live, draftLimits: { ttlMs: 1000 } });
    await put(live, w.file, 'expired');
    assert.equal((await live.getDraft(w.file, { docToken: TOKEN })).text, 'expired');
    const future = Date.now() + 5000;
    assert.equal(await live.getDraft(w.file, { docToken: TOKEN, now: future }), null);
    const pruned = await live.pruneDrafts({ now: future });
    assert.equal(pruned.removed, 1);
    assert.equal((await live.listDrafts({ now: future })).length, 0);
  } finally { await w.cleanup(); }
});

test('D5 clear is docToken-scoped and leaves rooms/recovery untouched', async () => {
  const w = await world('clear');
  try {
    const live = new LiveDocuments({ directory: w.live });
    const joined = await live.join(w.file, 'disk\n');
    await put(live, w.file, 'draft');
    const db = new (await import('node:sqlite')).DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    const rooms = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
    const recovery = db.prepare('SELECT COUNT(*) AS n FROM recovery').get().n;
    assert.equal((await live.clearDraft(w.file, { docToken: 'wrong' })).removed, 0);
    assert.equal((await live.clearDraft(w.file, { docToken: TOKEN })).removed, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, rooms);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery').get().n, recovery);
    db.close();
    await live.leave(joined.client);
  } finally { await w.cleanup(); }
});

test('D6 untitled mirror is gated and excluded from the default list', async () => {
  const w = await world('untitled');
  try {
    const off = new LiveDocuments({ directory: w.live });
    await assert.rejects(off.putDraft(undefined, { text: 'x', docToken: TOKEN, untitled: true }),
      (e) => e.code === 'MP_DRAFT_UNTITLED_DISABLED');
    assert.equal(fsSync.existsSync(path.join(w.live, 'rooms.sqlite')), false);
    const on = new LiveDocuments({ directory: w.live, untitledDraftIndex: true });
    const saved = await on.putDraft(undefined, { text: 'untitled', docToken: TOKEN, untitled: true });
    assert.equal(saved.kind, 'untitled');
    assert.equal((await on.listDrafts()).length, 0);
    assert.equal((await on.listDrafts({ includeUntitled: true })).length, 1);
    assert.equal((await on.getDraft(undefined, { docToken: TOKEN, untitled: true })).text, 'untitled');
  } finally { await w.cleanup(); }
});

test('D7 no-store reads never create the database; restart and foreign store are safe', async () => {
  const w = await world('restart');
  try {
    const live = new LiveDocuments({ directory: w.live });
    assert.equal(await live.getDraft(w.file, { docToken: TOKEN }), null);
    assert.deepEqual(await live.listDrafts(), []);
    assert.equal((await live.clearDraft(w.file, { docToken: TOKEN })).removed, 0);
    assert.equal((await live.pruneDrafts()).removed, 0);
    assert.equal(fsSync.existsSync(path.join(w.live, 'rooms.sqlite')), false);
    await put(live, w.file, 'restarted');
    retireLiveStorage();
    const again = new LiveDocuments({ directory: w.live });
    assert.equal((await again.getDraft(w.file, { docToken: TOKEN })).text, 'restarted');

    const foreign = await world('foreign');
    const { DatabaseSync } = await import('node:sqlite');
    fsSync.mkdirSync(foreign.live, { recursive: true });
    const db = new DatabaseSync(path.join(foreign.live, 'rooms.sqlite'));
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('host','other'); CREATE TABLE rooms(file TEXT PRIMARY KEY,epoch TEXT,version INTEGER,saved INTEGER,disk TEXT,length INTEGER,floor INTEGER,checkpoint BLOB)");
    db.close();
    await assert.rejects(put(new LiveDocuments({ directory: foreign.live }), foreign.file, 'x'),
      (e) => e.code === 'MP_DRAFT_STORE_FOREIGN');
    await foreign.cleanup();
  } finally { await w.cleanup(); }
});

test('D9 legacy store without draft_index fails closed and keeps rooms', async () => {
  const w = await world('legacy');
  try {
    const live = new LiveDocuments({ directory: w.live });
    const joined = await live.join(w.file, 'disk\n');
    await live.leave(joined.client);
    retireLiveStorage();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    db.exec('DROP TABLE draft_index');
    const rooms = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
    db.close();
    const again = new LiveDocuments({ directory: w.live });
    assert.equal(await again.getDraft(w.file, { docToken: TOKEN }), null);
    assert.deepEqual(await again.listDrafts(), []);
    assert.equal((await again.clearDraft(w.file, { docToken: TOKEN })).removed, 0);
    const check = new DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, rooms);
    check.close();
    assert.ok(joined.client);
  } finally { await w.cleanup(); }
});

test('D10 stale token, empty sha, raw-CRLF sha, and exact sha clear semantics', async () => {
  const w = await world('clear-sha');
  try {
    const live = new LiveDocuments({ directory: w.live });
    await put(live, w.file, 'one\r\ntwo', { docToken: 'old-token' });
    await put(live, w.file, 'new', { docToken: 'new-token' });
    assert.equal((await live.clearDraft(w.file, { docToken: 'old-token' })).removed, 0);
    await assert.rejects(live.clearDraft(w.file, { textSha256: '' }), (e) => e.code === 'MP_DRAFT_INVALID');
    assert.equal((await live.clearDraft(w.file, { textSha256: sha('one\r\ntwo') })).removed, 0);
    assert.equal((await live.getDraft(w.file, { docToken: 'new-token' })).text, 'new');
    assert.equal((await live.clearDraft(w.file, { textSha256: sha('new') })).removed, 1);
    assert.equal(await live.getDraft(w.file, { docToken: 'new-token' }), null);
  } finally { await w.cleanup(); }
});

test('D11 NUL and lone-surrogate text are rejected before replacing a mirror', async () => {
  const w = await world('invalid-text');
  try {
    const live = new LiveDocuments({ directory: w.live });
    await put(live, w.file, 'good');
    await assert.rejects(put(live, w.file, 'a\u0000b'), (e) => e.code === 'MP_DRAFT_INVALID');
    await assert.rejects(put(live, w.file, 'x\ud800y'), (e) => e.code === 'MP_DRAFT_INVALID');
    assert.equal((await live.getDraft(w.file, { docToken: TOKEN })).text, 'good');
  } finally { await w.cleanup(); }
});

test('D12 invalid prune TTL cannot silently wipe the index', async () => {
  const w = await world('prune-ttl');
  try {
    const live = new LiveDocuments({ directory: w.live });
    await put(live, w.file, 'keep');
    await assert.rejects(live.pruneDrafts({ ttlMs: 0 }), (e) => e.code === 'MP_DRAFT_INVALID');
    await assert.rejects(live.pruneDrafts({ ttlMs: 'abc' }), (e) => e.code === 'MP_DRAFT_INVALID');
    assert.equal((await live.getDraft(w.file, { docToken: TOKEN })).text, 'keep');
  } finally { await w.cleanup(); }
});

test('D8 concurrent puts keep one checksum-consistent row and clear respects docToken', async () => {
  const w = await world('concurrency');
  try {
    const live = new LiveDocuments({ directory: w.live });
    await Promise.all([
      put(live, w.file, 'first'),
      put(live, w.file, 'second'),
      put(live, w.file, 'third'),
    ]);
    const got = await live.getDraft(w.file, { docToken: TOKEN });
    assert.equal(got.textSha256, sha(got.text));
    assert.equal((await live.listDrafts()).length, 1);
    assert.equal((await live.clearDraft(w.file, { docToken: 'wrong' })).removed, 0);
    assert.equal((await live.clearDraft(w.file, { docToken: TOKEN, textSha256: 'f'.repeat(64) })).removed, 0);
    assert.equal((await live.clearDraft(w.file, { docToken: TOKEN })).removed, 1);
  } finally { await w.cleanup(); }
});
