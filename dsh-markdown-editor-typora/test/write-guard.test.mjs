import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteGuard } from '../lib/index.js';

const LOG = { warn() {} };
const TARGET = { targetKey: 'D:/probe/a.md', displayPath: 'D:/probe/a.md' };
const BASE = { kind: 'createIfAbsent' };

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    on(name, handler, options) {
      listeners.set(name, { handler, options });
      return () => { if (listeners.get(name)?.handler === handler) listeners.delete(name); };
    },
  };
  return { ctx, listeners };
}

function makeGuard(overrides = {}) {
  return createWriteGuard({
    fs: { stat: async () => ({ version: 'V1' }) },
    lookup: async () => null,
    log: LOG,
    pluginName: 'test-guard',
    ...overrides,
  });
}

async function call(h, event, nextResult = undefined, target = TARGET) {
  const entry = h.listeners.get(event);
  assert(entry, `listener for ${event}`);
  let nextCalled = 0;
  const next = async () => { nextCalled += 1; return nextResult; };
  const result = await entry.handler(target, {}, next);
  return { result, nextCalled };
}

test('no room is fail-open and keeps the next intent', async () => {
  const h = makeCtx();
  makeGuard().install(h.ctx);
  const { result, nextCalled } = await call(h, 'fs/write-intent', BASE);
  assert.equal(nextCalled, 1);
  assert.deepEqual(result, BASE);
});

test('dirty room is refused on all three intents', async () => {
  const h = makeCtx();
  makeGuard({ lookup: async () => ({ dirty: true, path: 'D:/probe/a.md' }) }).install(h.ctx);
  for (const event of ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']) {
    await assert.rejects(() => call(h, event, undefined), (error) => {
      assert.equal(error.code, 'MP_DOC_DIRTY');
      assert.match(error.message, /MP_DOC_DIRTY/);
      assert.match(error.message, /D:\/probe\/a\.md/);
      return true;
    });
  }
});

test('clean room gets expected-version CAS on write/edit/delete', async () => {
  const h = makeCtx();
  makeGuard({ lookup: async () => ({ dirty: false, path: 'D:/probe/a.md' }) }).install(h.ctx);
  const write = await call(h, 'fs/write-intent');
  assert.deepEqual(write.result, { kind: 'replaceIfVersion', version: 'V1' });
  const edit = await call(h, 'fs/edit-intent');
  assert.deepEqual(edit.result, { version: 'V1' });
  const del = await call(h, 'fs/delete-intent');
  assert.deepEqual(del.result, { version: 'V1' });
});

test('next runs before the guard so another policy is never suppressed', async () => {
  const h = makeCtx();
  const order = [];
  makeGuard({ lookup: async () => { order.push('lookup'); return { dirty: false, path: 'D:/probe/a.md' }; } }).install(h.ctx);
  const entry = h.listeners.get('fs/write-intent');
  await entry.handler(TARGET, {}, async () => { order.push('next'); return BASE; });
  assert.deepEqual(order, ['next', 'lookup']);
});

test('a policy intent from next is never weakened by the guard', async () => {
  const h = makeCtx();
  makeGuard({ lookup: async () => ({ dirty: false, path: 'D:/probe/a.md' }) }).install(h.ctx);
  const { result } = await call(h, 'fs/write-intent', { kind: 'createIfAbsent' });
  assert.deepEqual(result, { kind: 'createIfAbsent' });
});

test('a policy intent does not bypass a dirty room', async () => {
  const h = makeCtx();
  makeGuard({ lookup: async () => ({ dirty: true, path: 'D:/probe/a.md' }) }).install(h.ctx);
  await assert.rejects(() => call(h, 'fs/write-intent', { kind: 'createIfAbsent' }), (error) => error.code === 'MP_DOC_DIRTY');
});

test('lookup failure fails open (does not block AI writes)', async () => {
  const h = makeCtx();
  makeGuard({ lookup: async () => { throw new Error('db locked'); } }).install(h.ctx);
  const { result } = await call(h, 'fs/write-intent', BASE);
  assert.deepEqual(result, BASE);
});

test('clean room whose file disappeared is fail-open for creation', async () => {
  const h = makeCtx();
  makeGuard({
    lookup: async () => ({ dirty: false, path: 'D:/probe/a.md' }),
    fs: { stat: async () => undefined },
  }).install(h.ctx);
  const { result } = await call(h, 'fs/write-intent', BASE);
  assert.deepEqual(result, BASE);
});

test('missing target or missing ctx.on does not throw', async () => {
  const h = makeCtx();
  makeGuard().install(h.ctx);
  const entry = h.listeners.get('fs/write-intent');
  const result = await entry.handler(undefined, {}, async () => BASE);
  assert.deepEqual(result, BASE);
  assert.doesNotThrow(() => makeGuard().install({}));
});

test('installing twice on the same ctx is idempotent', async () => {
  const h = makeCtx();
  const guard = makeGuard();
  guard.install(h.ctx);
  guard.install(h.ctx);
  assert.equal(h.listeners.size, 3);
});

test('lookup failure becomes fail-closed after the bounded threshold', async () => {
  const h = makeCtx();
  let calls = 0;
  makeGuard({ lookup: async () => { calls += 1; if (calls <= 3) throw new Error('db locked'); return null; } }).install(h.ctx);
  const first = await call(h, 'fs/write-intent', BASE);
  assert.deepEqual(first.result, BASE);
  const second = await call(h, 'fs/write-intent', BASE);
  assert.deepEqual(second.result, BASE);
  await assert.rejects(() => call(h, 'fs/write-intent', BASE), (error) => error.code === 'MP_DOC_LOOKUP_FAILED');
  const recovered = await call(h, 'fs/write-intent', BASE);
  assert.deepEqual(recovered.result, BASE);
  assert.equal(calls, 4);
});

test('fsSessionIntents wraps ctx.fs writes and refuses dirty sessions', async () => {
  const h = makeCtx();
  let calls = 0;
  h.ctx.fs = {
    writeText: async () => { calls += 1; return 'wrote'; },
    editText: async () => { calls += 1; return 'edited'; },
  };
  makeGuard({ fsSessionIntents: true, lookup: async () => ({ dirty: true, path: 'D:/probe/a.md' }) }).install(h.ctx);
  await assert.rejects(() => h.ctx.fs.writeText(TARGET, 'x'), (error) => error.code === 'MP_DOC_DIRTY');
  assert.equal(calls, 0);
  const clean = makeCtx();
  clean.ctx.fs = { writeText: async () => { calls += 1; return 'wrote'; } };
  makeGuard({ fsSessionIntents: true, lookup: async () => ({ dirty: false, path: 'D:/probe/a.md' }) }).install(clean.ctx);
  assert.equal(await clean.ctx.fs.writeText(TARGET, 'x'), 'wrote');
  assert.equal(calls, 1);
});
