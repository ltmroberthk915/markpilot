// Adversarial integration test for external-change refresh (real filesystem, real HTTP/SSE).
// Run: node --test test/external-refresh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { watch as fsWatch } from 'node:fs';
import { mkdtemp, writeFile, readFile, stat, rename, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, normalize, isAbsolute, basename } from 'node:path';
import { createHost } from '../lib/index.js';

const SILENT_LOG = { info() {}, warn() {} };
const ALLOW_CONNECTION = { requestRejection: () => undefined };
const ALLOW_PROVIDER = () => ALLOW_CONNECTION;

/** Real-filesystem adapter with the same shape as ctx.fs: watch fires for the target path only. */
function createRealFs() {
  const closes = new Set();
  async function versionOf(path) {
    const info = await stat(path, { bigint: true }).catch(() => undefined);
    if (!info) return undefined;
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  }
  return {
    closes,
    async resolve(path) {
      const target = isAbsolute(String(path)) ? String(path) : normalize(String(path));
      return { targetKey: normalize(target), displayPath: normalize(target) };
    },
    async stat(target) {
      const info = await stat(target.targetKey).catch(() => undefined);
      if (!info) return undefined;
      return { version: await versionOf(target.targetKey), size: info.size, type: info.isDirectory() ? 'directory' : 'file' };
    },
    async readText(target) {
      return readFile(target.targetKey, 'utf8');
    },
    async writeText(target, text) {
      await writeFile(target.targetKey, String(text), 'utf8');
      const info = await stat(target.targetKey);
      return { operation: 'update', version: await versionOf(target.targetKey), after: String(text), size: info.size };
    },
    async watch(target, changed) {
      const dir = dirname(target.targetKey);
      const name = basename(target.targetKey);
      const watcher = fsWatch(dir, { persistent: false }, (event, filename) => {
        if (filename && String(filename) !== name) return;
        changed();
      });
      const close = () => { try { watcher.close(); } catch { /* closed */ } closes.add(close); };
      closes.add(close);
      return close;
    },
  };
}

function createService(fsAdapter) {
  const layer = { fs: fsAdapter };
  const service = {
    fs: fsAdapter,
    async route(req, res, pathname, url) {
      return layer.dispatch?.(req, res, pathname, url);
    },
  };
  return { service, layer };
}

/** Start the plugin HTTP host on an ephemeral port; returns { port, host, close }. */
async function startHost(fsAdapter) {
  const ctx = {
    fs: fsAdapter,
    logger: () => SILENT_LOG,
    inject: (names, fn) => { if (typeof fn === 'function') fn({}); },
    get: (name) => {
      if (name === 'connection') return ALLOW_CONNECTION;
      return undefined;
    },
    effect: (fn) => { const stop = fn(); return () => { try { stop?.(); } catch { /* ignore */ } }; },
    on: () => () => {},
    slots: { register: () => () => {}, inject: () => () => {} },
    tools: { register: () => () => {} },
    server: { register: () => () => {} },
    settings: { register: () => () => {} },
  };
  const host = createHost({ fs: fsAdapter, rootDir: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), log: SILENT_LOG, connectionProvider: ALLOW_PROVIDER });
  const server = http.createServer((req, res) => { host.route.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    host,
    close: async () => { await new Promise((r) => server.close(r)); host.close?.(); },
  };
}

async function openSse(port, absPath, timeoutMs = 6000) {
  const url = `http://127.0.0.1:${port}/dsh-markdown-typora/api/watch?path=${encodeURIComponent(absPath)}`;
  const res = await fetch(url);
  assert.equal(res.status, 200, 'SSE watch must be accepted');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  const events = [];
  let notify = null;
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const ev = /event: ([^\n]+)/.exec(frame);
          const data = /data: ([^\n]*)/.exec(frame);
          if (ev) {
            events.push({ name: ev[1], at: Date.now(), data: data ? data[1] : '' });
            if (notify) notify();
          }
        }
      }
    } catch { /* closed */ }
  })();
  const handle = {
    events,
    async waitFor(name, since, ms) {
      return new Promise((resolve) => {
        const deadline = Date.now() + ms;
        const check = () => {
          const hit = events.find((e) => e.name === name && e.at >= since);
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return resolve(null);
          setTimeout(check, 40);
        };
        check();
      });
    },
    close() { try { reader.cancel(); } catch { /* ignore */ } },
  };
  await handle.waitFor('ready', 0, timeoutMs);
  return handle;
}

async function scenario(t, { name, mutate, timeoutMs = 3500 }) {
  const dir = await mkdtemp(join(tmpdir(), 'mp-refresh-'));
  const file = join(dir, name);
  await writeFile(file, '# initial\n' + 'x'.repeat(400) + '\n', 'utf8');
  const fsAdapter = createRealFs();
  const { port, close } = await startHost(fsAdapter);
  const sse = await openSse(port, file);
  try {
    const since = Date.now();
    await mutate(file);
    const change = await sse.waitFor('change', since, timeoutMs);
    assert.ok(change, `${name}: expected an SSE change event within ${timeoutMs}ms`);
    const payload = JSON.parse(change.data);
    assert.equal(normalize(payload.path), normalize(file), 'event path matches the watched file');
    const diskVersion = await (async () => {
      const info = await stat(file, { bigint: true });
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
    })();
    assert.equal(String(payload.version), String(diskVersion), 'event carries the fresh disk version');
    return true;
  } finally {
    sse.close();
    await close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('external direct write refreshes through SSE', async (t) => {
  await scenario(t, { name: 'direct.md', mutate: async (f) => { await writeFile(f, '# changed\n' + 'y'.repeat(400) + '\n'); } });
});

test('external append refreshes through SSE', async (t) => {
  await scenario(t, { name: 'append.md', mutate: async (f) => { await appendFile(f, '\n> 各位老师好\n'); } });
});

test('atomic rename replace refreshes through SSE', async (t) => {
  await scenario(t, {
    name: 'atomic.md',
    mutate: async (f) => {
      const tmp = f + '.tmp';
      await writeFile(tmp, '# replaced\n' + 'z'.repeat(400) + '\n');
      await rename(tmp, f);
    },
  });
});

test('128KB / 1500-line file refreshes through SSE', async (t) => {
  await scenario(t, {
    name: 'large.md',
    mutate: async (f) => { await writeFile(f, ('行内容 '.repeat(20) + '\n').repeat(1500)); },
  });
});

test('unicode path with spaces refreshes through SSE', async (t) => {
  await scenario(t, {
    name: '秋招 面试 材料.md',
    mutate: async (f) => { await writeFile(f, '# 中文\n' + '中'.repeat(400) + '\n'); },
  });
});

test('rapid consecutive writes refresh through SSE', async (t) => {
  await scenario(t, {
    name: 'rapid.md',
    mutate: async (f) => {
      for (let i = 0; i < 5; i++) { await writeFile(f, '# rapid ' + i + '\n'); await new Promise((r) => setTimeout(r, 60)); }
    },
  });
});

test('two racing writers still deliver a refresh', async (t) => {
  await scenario(t, {
    name: 'race.md',
    mutate: async (f) => {
      await Promise.all([
        (async () => { for (let i = 0; i < 3; i++) { await writeFile(f, 'A' + i + '\n'); await new Promise((r) => setTimeout(r, 40)); } })(),
        (async () => { for (let i = 0; i < 3; i++) { await writeFile(f, 'B' + i + '\n'); await new Promise((r) => setTimeout(r, 40)); } })(),
      ]);
    },
  });
});

/** Apply live deltas to a base text (exchange returns updates, not text). */
function applyUpdates(base, updates) {
  let out = String(base);
  for (const update of updates) for (const change of update.changes || []) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/** POST JSON to the plugin API. */
async function postApi(port, path, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/dsh-markdown-typora/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

test('a live editing room adopts an external disk write on refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp-refresh-live-'));
  const file = join(dir, 'live.md');
  await writeFile(file, '# live\nalpha\n', 'utf8');
  const fsAdapter = createRealFs();
  const { port, close } = await startHost(fsAdapter);
  try {
    const opened = await postApi(port, 'open', { path: file, live: true });
    assert.equal(opened.ok, true, 'open must succeed: ' + JSON.stringify(opened));
    assert.ok(opened.value.live && opened.value.live.client, 'open returns a live ticket');
    const ticket = opened.value.live;
    // External write while the room is clean.
    await writeFile(file, '# live\nbeta\n', 'utf8');
    const refreshed = await postApi(port, 'live', { client: ticket.client, action: 'refresh', request: { epoch: ticket.epoch } });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.value.changed, true, 'refresh reports the disk change');
    assert.ok(!refreshed.value.unsavedDraft, 'clean room has no unsaved draft');
    const pulled = await postApi(port, 'live', { client: ticket.client, action: 'exchange', request: { epoch: ticket.epoch, version: ticket.version } });
    assert.equal(pulled.ok, true);
    const adoptedText = applyUpdates(opened.value.text, pulled.value.updates || []);
    assert.match(adoptedText, /beta/, 'room text follows the disk');
    const again = await postApi(port, 'live', { client: ticket.client, action: 'refresh', request: { epoch: ticket.epoch } });
    assert.equal(again.value.changed, false, 'second refresh is a no-op');
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a live room with an unsaved draft reports a conflict; discard adopts the disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp-refresh-live-draft-'));
  const file = join(dir, 'draft.md');
  await writeFile(file, '# draft\nbase\n', 'utf8');
  const fsAdapter = createRealFs();
  const { port, close } = await startHost(fsAdapter);
  try {
    const opened = await postApi(port, 'open', { path: file, live: true });
    assert.equal(opened.ok, true);
    const ticket = opened.value.live;
    assert.ok(ticket && ticket.client);
    const edited = await postApi(port, 'live', { client: ticket.client, action: 'exchange', request: { epoch: ticket.epoch, version: ticket.version, seq: 1, changes: [{ from: 8, to: 8, insert: 'LOCAL' }] } });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const draftVersion = edited.value.version;
    await writeFile(file, '# draft\nEXTERNAL\n', 'utf8');
    const blocked = await postApi(port, 'live', { client: ticket.client, action: 'refresh', request: { epoch: ticket.epoch } });
    assert.equal(blocked.value.changed, true);
    assert.equal(blocked.value.unsavedDraft, true, 'unsaved draft blocks automatic adoption');
    const forced = await postApi(port, 'live', { client: ticket.client, action: 'refresh', request: { epoch: ticket.epoch, discard: true } });
    assert.equal(forced.ok, true);
    assert.equal(forced.value.unsavedDraft, undefined, 'discard adopts the disk');
    const pulled = await postApi(port, 'live', { client: ticket.client, action: 'exchange', request: { epoch: ticket.epoch, version: draftVersion } });
    const draftText = '# draft\nLOCALbase\n';
    const adopted = applyUpdates(draftText, pulled.value.updates || []);
    assert.match(adopted, /EXTERNAL/, 'room text becomes the disk text');
    assert.ok(!/LOCAL/.test(adopted), 'the discarded draft is gone');
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
