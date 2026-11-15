// Real createHost + real SQLite regression for reading positions.
// Drop into dsh-markdown-editor-typora/test and run:
//   node --test test/reading-position.test.mjs
//
// The test only uses relative package imports and os.tmpdir(); it never reads
// or writes cwd, a user profile, or the real %LOCALAPPDATA% store.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../lib/index.js';
import { ReadingPositionStore } from '../host/reading-position-store.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reading-api-test-'));
const ALLOW = { requestRejection: () => undefined };
const LOG = { info() {}, warn() {}, error() {} };
let serial = 0;

after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp only */ }
});

function mockFs() {
  return {
    async resolve(target) {
      return { targetKey: path.normalize(target), displayPath: path.normalize(target) };
    },
    async stat(target) {
      try {
        const info = fs.statSync(target.targetKey);
        return { version: 'v1', size: info.size, type: 'file' };
      } catch { return undefined; }
    },
    async readText(target) { return fs.readFileSync(target.targetKey, 'utf8'); },
    async writeText() { throw new Error('not used by reading tests'); },
    async editText() { throw new Error('not used by reading tests'); },
    watch() { throw new Error('not used by reading tests'); },
  };
}

function fixture(name) {
  const dir = path.join(ROOT, `${name}-${++serial}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'document.md');
  fs.writeFileSync(file, '# fixture\n\nbody\n', 'utf8');
  const storeDir = path.join(dir, 'reading-v1');
  return { dir, file, storeDir };
}
function makeHost(dir, storeDir) {
  return createHost({
    fs: mockFs(),
    rootDir: dir,
    log: LOG,
    connectionProvider: () => ALLOW,
    readingDirectory: storeDir,
  });
}

async function open(host, file) {
  const result = await host.dispatch('open', { path: file }, 'editor');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function reading(host, payload) {
  return host.dispatch('reading', payload, 'editor');
}
async function register(host, file, sessionId) {
  const result = await reading(host, { op: 'register', path: file, sessionId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function save(host, file, sessionId, anchor, seq, sampleAt) {
  return reading(host, { op: 'save', path: file, sessionId, anchor, seq, sampleAt });
}
async function get(host, file, sessionId) {
  return reading(host, { op: 'get', path: file, sessionId });
}
async function release(host, sessionId) {
  return reading(host, { op: 'release', sessionId });
}
const anchor = line => ({ line, ch: 0, fraction: 0 });

test('createHost success path: open, register, save, get, close', async () => {
  const { dir, file, storeDir } = fixture('success');
  const host = makeHost(dir, storeDir);
  try {
    await open(host, file);
    await register(host, file, 'success-session');
    const t = Date.now();
    const saved = await save(host, file, 'success-session', anchor(7), 1, t);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.value.stored, true, JSON.stringify(saved.value));
    const loaded = await get(host, file, 'success-session');
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.deepEqual(loaded.value.anchor, anchor(7));
    assert.equal(loaded.value.writer, 'plugin');
  } finally {
    host.close();
  }
});

test('cross reopen: a new incarnation may start at seq 1; old seq in the same incarnation is rejected', async () => {
  const { dir, file, storeDir } = fixture('seq');
  const first = makeHost(dir, storeDir);
  const t = Date.now();
  try {
    await open(first, file);
    await register(first, file, 'gen-1');
    const high = await save(first, file, 'gen-1', anchor(10), 99, t);
    assert.equal(high.value?.stored, true, JSON.stringify(high));
    await release(first, 'gen-1');
  } finally {
    first.close();
  }

  const second = makeHost(dir, storeDir);
  try {
    await open(second, file);
    await register(second, file, 'gen-2');
    const lowAt = Date.now() + 1000;
    const low = await save(second, file, 'gen-2', anchor(20), 1, lowAt);
    assert.equal(low.ok, true, JSON.stringify(low));
    assert.equal(low.value?.stored, true, 'fresh incarnation seq 1 must be accepted');
    const backward = await save(second, file, 'gen-2', anchor(21), 0, lowAt + 1000);
    assert.equal(backward.ok, true, JSON.stringify(backward));
    assert.equal(backward.value?.stored, false, 'same incarnation must not go backwards');
    const loaded = await get(second, file, 'gen-2');
    assert.equal(loaded.value?.anchor?.line, 20);
  } finally {
    second.close();
  }
});

test('abandoned lease cannot revive; desktop takes over after release', async () => {
  const { dir, file, storeDir } = fixture('abandon');
  const host = makeHost(dir, storeDir);
  const store = new ReadingPositionStore({ directory: storeDir });
  const t = Date.now();
  try {
    await open(host, file);
    await register(host, file, 'old-lease');
    const p1 = await save(host, file, 'old-lease', anchor(10), 1, t);
    assert.equal(p1.value?.stored, true, JSON.stringify(p1));
    await release(host, 'old-lease');

    const lateSave = await save(host, file, 'old-lease', anchor(11), 2, t + 50);
    assert.equal(lateSave.ok, false, 'late save must not resurrect the released session');
    const lateTouch = await reading(host, { op: 'touch', path: file, sessionId: 'old-lease' });
    assert.equal(lateTouch.ok, false, 'late touch must not resurrect the released session');
    const lateGet = await get(host, file, 'old-lease');
    assert.equal(lateGet.ok, false, 'late get must not reopen the released session');

    const desktopAt = Date.now() + 1000;
    const desktop = store.save({ path: file, role: 'desktop', sessionId: 'desktop-1',
      anchor: anchor(200), seq: 1, sampleAt: desktopAt, now: desktopAt });
    assert.equal(desktop.stored, true, JSON.stringify(desktop));
    const loaded = store.load({ path: file, now: desktopAt + 1 });
    assert.equal(loaded.writer, 'desktop');
    assert.equal(loaded.anchor?.line, 200);
  } finally {
    host.close();
    store.close();
  }
});

test('after desktop takeover the next plugin read returns the newer desktop anchor', async () => {
  const { dir, file, storeDir } = fixture('next-read');
  const store = new ReadingPositionStore({ directory: storeDir });
  const t = Date.now();
  const first = makeHost(dir, storeDir);
  try {
    await open(first, file);
    await register(first, file, 'old-plugin');
    const p1 = await save(first, file, 'old-plugin', anchor(100), 1, t);
    assert.equal(p1.value?.stored, true, JSON.stringify(p1));
    await release(first, 'old-plugin');
    const desktopAt = Date.now() + 1000;
    const desktop = store.save({ path: file, role: 'desktop', sessionId: 'desktop-2',
      anchor: anchor(200), seq: 1, sampleAt: desktopAt, now: desktopAt });
    assert.equal(desktop.stored, true, JSON.stringify(desktop));
  } finally {
    first.close();
  }

  const second = makeHost(dir, storeDir);
  try {
    await open(second, file);
    await register(second, file, 'new-plugin');
    const loaded = await get(second, file, 'new-plugin');
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.equal(loaded.value?.anchor?.line, 200,
      'a new plugin session must not restore the older plugin row');
    assert.equal(loaded.value?.writer, 'desktop');
  } finally {
    second.close();
    store.close();
  }
});
