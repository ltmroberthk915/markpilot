'use strict';
/* tools/quality/tests/clipboard-service.test.cjs — private unit test for the
 * api44-fix-r1 clipboard service (MarkPilot-CM6/shell/clipboard-service.js).
 * Plain Node (no Electron environment needed); factory-injected STRICT 44 fakes:
 *  - clipboard.write(ClipboardItem[]) asserts every item instanceof the injected
 *    ClipboardItem class and REJECTS plain mime-keyed objects;
 *  - items expose the public read shape types[] + getType(mime)->Promise<Blob>;
 *  - read()/readText() return Promises.
 * No removed synchronous legacy API is mocked anywhere — legacy usage must fail.
 * r2: writeText removed from service dep check (service never calls it);
 *     T3 uses a deterministic first-start gate (no sleep-based microtask race);
 *     T10/T11 added for guard/consume throw resilience (B1). */
const assert = require('node:assert/strict');
const { createClipboardService, ALLOWED_CLIPBOARD_MIME } = require('../../../MarkPilot-CM6/shell/clipboard-service.js');

class FakeBlob {
  constructor(parts, opts) {
    this.type = (opts && opts.type) || '';
    this._buf = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8'))));
    this.size = this._buf.length;
  }
  async arrayBuffer() {
    const ab = new ArrayBuffer(this._buf.length);
    Buffer.from(ab).set(this._buf);
    return ab;
  }
}
/* REAL item class (mirrors the public Electron 44 ClipboardItem contract only):
 * one item may carry multiple flavors; reading goes exclusively through
 * types + getType(mime) -> Promise<Blob>.
 * r3 fix: the READ-side item class accepts ANY syntactically valid MIME (the OS
 * clipboard can contain image/webp, CF_*, etc.); the three-MIME write allowlist
 * is enforced by buildItems and the fake write validation — NOT here. T7 uses
 * non-allowlisted MIME types to prove readInfo's image/* fallback works. */
class TestClipboardItem {
  constructor(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('ClipboardItem(data) required');
    for (const m of Object.keys(data)) {
      if (typeof m !== 'string' || !m.includes('/')) throw new TypeError('invalid MIME type: ' + String(m));
      const v = data[m];
      if (typeof v !== 'string' && !(v && typeof v.arrayBuffer === 'function' && typeof v.size === 'number'))
        throw new TypeError('value must be a string or Blob');
    }
    this._data = data;
    this.types = Object.keys(data);
  }
  async getType(mime) {
    if (!Object.prototype.hasOwnProperty.call(this._data, mime)) throw new Error('NoSuchType: ' + mime);
    const v = this._data[mime];
    return typeof v === 'string' ? new FakeBlob([v], { type: mime }) : v;
  }
}
function makeFakeClipboard() {
  const calls = [];
  const behaviors = [];
  const api = {
    async write(items) {
      if (!Array.isArray(items)) throw new TypeError('write expects ClipboardItem[]');
      for (const it of items) {
        if (!(it instanceof TestClipboardItem)) throw new TypeError('plain objects are not ClipboardItem');
        if (!Array.isArray(it.types) || typeof it.getType !== 'function') throw new TypeError('malformed item');
        for (const m of it.types) {
          if (!ALLOWED_CLIPBOARD_MIME.includes(m)) throw new TypeError('write-side MIME not in product allowlist: ' + m);
        }
      }
      const rec = { items, startedAt: Date.now(), settledAt: null, error: null };
      calls.push(rec);
      const b = behaviors.shift() || {};
      if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
      if (b.gate) await b.gate;                                            /* deterministic hold for T3 */
      rec.settledAt = Date.now();
      if (b.reject) { rec.error = b.reject; throw new Error(b.reject); }
    },
    async readText() { return api._readText; },
    async read() { return api._readItems; },
    _calls: calls, _behaviors: behaviors, _readText: 'RICH', _readItems: [],
  };
  return api;
}
const fakeNativeImage = {
  createFromBuffer(buf) {
    return { isEmpty: () => buf.length === 0, getSize: () => ({ width: 1, height: Math.min(buf.length, 4) }) };
  },
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1, 2, 3, 4, 5])]);
function makeSvc(cp) {
  return createClipboardService({ clipboard: cp, nativeImage: fakeNativeImage, ClipboardItem: TestClipboardItem, Blob: FakeBlob, dbg: () => {} });
}
const enqText = (svc, text, label, guard = () => 'ok', consume = () => true) =>
  svc.enqueueWrite({ label, items: svc.buildItems({ text }).items, guard, consume });
/* Yield one microtask so a chained .then() callback (the lane head) can actually start. */
const yieldMicrotask = () => new Promise((r) => setImmediate(r));

const results = [];
async function case_(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: String((e && e.message) || e) }); }
}

(async () => {
  await case_('T1 ONE ClipboardItem with all flavors, atomic write, ack after completion', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    const built = svc.buildItems({ text: 'RICH', html: '<strong>RICH</strong>', png: PNG });
    assert.equal(built.ok, true);
    assert.equal(built.items.length, 1);
    assert.ok(built.items[0] instanceof TestClipboardItem);
    assert.deepEqual([...built.items[0].types].sort(), ['image/png', 'text/html', 'text/plain']);
    const out = await svc.enqueueWrite({ items: built.items, guard: () => 'ok', consume: () => true, label: 'T1' });
    assert.equal(out.status, 'committed');
    assert.equal(cp._calls.length, 1);
    const item = cp._calls[0].items[0];
    const pngBlob = await item.getType('image/png');
    assert.ok(Buffer.from(await pngBlob.arrayBuffer()).equals(PNG));
    const textBlob = await item.getType('text/plain');
    assert.equal(Buffer.from(await textBlob.arrayBuffer()).toString('utf8'), 'RICH');
    assert.ok(cp._calls[0].settledAt !== null);
  });

  await case_('T2 rejection: failed (never success), no retry, lane not poisoned', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    cp._behaviors.push({ reject: 'E_ABANDONED_BY_TEST' });
    const out1 = await enqText(svc, 'A', 'T2a');
    assert.equal(out1.status, 'failed');
    assert.equal(cp._calls.length, 1);
    const out2 = await enqText(svc, 'B', 'T2b');
    assert.equal(out2.status, 'committed');
    assert.equal(cp._calls.length, 2);
  });

  await case_('T3 submission order: deterministic gate — late A cannot overwrite B', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    /* Deterministic: A's write holds on a gate we control, so we KNOW A started
     * before B is enqueued — no sleep-based microtask race. */
    let resolveGate;
    const gate = new Promise((r) => { resolveGate = r; });
    cp._behaviors.push({ gate });
    const pA = enqText(svc, 'A', 'T3a');
    await yieldMicrotask();                                              /* let A actually reach the fake write */
    assert.equal(cp._calls.length, 1);                                   /* A started; B not yet enqueued */
    const pB = enqText(svc, 'B', 'T3b');
    await yieldMicrotask();                                              /* B's .then fires but blocks on tail (A pending) */
    assert.equal(cp._calls.length, 1);                                   /* B still waiting behind A */
    resolveGate();                                                        /* release A */
    assert.equal((await pA).status, 'committed');
    assert.equal((await pB).status, 'committed');
    assert.equal(cp._calls.length, 2);
    const texts = [];
    for (const c of cp._calls) {
      const tb = await c.items[0].getType('text/plain');
      texts.push(Buffer.from(await tb.arrayBuffer()).toString('utf8'));
    }
    assert.deepEqual(texts, ['A', 'B']);
    assert.ok(cp._calls[1].startedAt >= cp._calls[0].settledAt);         /* B started only after A settled */
  });

  await case_('T4 head-guard stale: no write, no consume, lane free for next', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    let consumed = false;
    const out = await enqText(svc, 'A', 'T4', () => 'stale', () => { consumed = true; return true; });
    assert.equal(out.status, 'skipped'); assert.equal(out.reason, 'stale');
    assert.equal(cp._calls.length, 0); assert.equal(consumed, false);
    assert.equal((await enqText(svc, 'B', 'T4b')).status, 'committed');
  });

  await case_('T5 head-guard adopted: lane released, settle outside, retry commits', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    let gate = 'adopted';
    const first = enqText(svc, 'A', 'T5', () => gate);
    assert.equal(cp._calls.length, 0);
    assert.equal((await enqText(svc, 'OTHER', 'T5-other')).status, 'committed');
    const out1 = await first;
    assert.equal(out1.status, 'skipped'); assert.equal(out1.reason, 'adopted');
    gate = 'ok';
    const out2 = await enqText(svc, 'A', 'T5-retry', () => gate);
    assert.equal(out2.status, 'committed');
    assert.equal(cp._calls.length, 2);
  });

  await case_('T6 head consume() false: canceled, no write', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    const out = await enqText(svc, 'A', 'T6', () => 'ok', () => false);
    assert.equal(out.status, 'canceled');
    assert.equal(cp._calls.length, 0);
  });

  await case_('T7 readInfo: types/getType only, image/png preferred, unknown payloads ignored', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    cp._readText = 'RICH';
    cp._readItems = [
      new TestClipboardItem({ 'text/html': '<b>x</b>' }),
      new TestClipboardItem({ 'image/png': new FakeBlob([PNG], { type: 'image/png' }) }),
      { CF_PRIVATE_LOCAL: 'x' },
    ];
    const info = await svc.readInfo();
    assert.equal(info.ok, true);
    assert.equal(info.hasImage, true);
    assert.equal(info.width, 1);
    assert.equal(info.height, Math.min(PNG.length, 4));
    assert.equal(info.textLen, 4);
    cp._readItems = [new TestClipboardItem({ 'text/html': 'no-image' })];
    assert.equal((await svc.readInfo()).hasImage, false);
    cp._readItems = [new TestClipboardItem({ 'image/webp': new FakeBlob([PNG], { type: 'image/webp' }) })];
    assert.equal((await svc.readInfo()).hasImage, true);
  });

  await case_('T8 buildItems rejects unknown keys / bad PNG / empty', async () => {
    const svc = makeSvc(makeFakeClipboard());
    assert.equal(svc.buildItems({ text: 'a', wef: 'x' }).error, 'unknown-key:wef');
    assert.equal(svc.buildItems({ png: Buffer.from('not-png') }).error, 'bad-png');
    assert.equal(svc.buildItems({ text: '' }).error, 'empty');
  });

  await case_('T9 strictness: factory requires ClipboardItem ctor; fake write rejects plain objects', async () => {
    assert.throws(() => createClipboardService({ clipboard: makeFakeClipboard(), nativeImage: fakeNativeImage, Blob: FakeBlob }),
      /ClipboardItem constructor required/);
    const cp = makeFakeClipboard();
    await assert.rejects(() => cp.write([{ 'text/plain': 'legacy' }]), /plain objects are not ClipboardItem/);
  });

  await case_('T10 B1: guard() throws -> failed (not rejection), lane recovers for next write', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    const out1 = await enqText(svc, 'A', 'T10a', () => { throw new Error('guard-crash-test'); });
    assert.equal(out1.status, 'failed');
    assert.ok(out1.error.includes('guard-crash-test'));
    assert.equal(cp._calls.length, 0);                                  /* no native write happened */
    const out2 = await enqText(svc, 'B', 'T10b');
    assert.equal(out2.status, 'committed');                              /* lane fully recovered */
    assert.equal(cp._calls.length, 1);
  });

  await case_('T11 B1: consume() throws -> failed (not rejection), lane recovers for next write', async () => {
    const cp = makeFakeClipboard();
    const svc = makeSvc(cp);
    const out1 = await enqText(svc, 'A', 'T11a', () => 'ok', () => { throw new Error('consume-crash-test'); });
    assert.equal(out1.status, 'failed');
    assert.ok(out1.error.includes('consume-crash-test'));
    assert.equal(cp._calls.length, 0);                                  /* no native write happened */
    const out2 = await enqText(svc, 'B', 'T11b');
    assert.equal(out2.status, 'committed');                              /* lane fully recovered */
    assert.equal(cp._calls.length, 1);
  });

  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ suite: 'clipboard-service.test', passed: results.length - failed.length, failed: failed.length,
    cases: results.map((r) => ({ name: r.name, pass: r.pass, error: r.error || null })) }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exitCode = 1; });
