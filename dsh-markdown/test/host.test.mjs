// dsh-markdown 宿主半边：纯函数 + mock ctx + 真实 node:http 集成测试。
// 运行：node --test test/host.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, isAbsolute } from 'node:path';
import {
  apply,
  createHost,
  createMarkdownToolDefinition,
  resolveStaticTarget,
  makeEtag,
  isNotModified,
  cacheControlFor,
  mimeFor,
  isTrustedLoopbackRequest,
  errorCode,
  BODY_MAX_BYTES,
} from '../lib/index.js';

const SILENT_LOG = { info() {}, warn() {} };

/** 统一成普通 JSON 值，避免不同来源对象原型差异影响 deepEqual。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class MockFsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FsError';
    this.code = code;
  }
}

function createMockFs(initialFiles) {
  const files = new Map();
  let serial = 0;
  for (const [filePath, text] of Object.entries(initialFiles || {})) {
    files.set(normalize(filePath), { text: String(text), version: `v${++serial}`, type: 'file' });
  }
  const fs = {
    files,
    watchers: [],
    watchMode: 'ok',
    async resolve(path, opts) {
      let target = String(path);
      if (!isAbsolute(target)) target = join(opts?.cwd ?? 'D:/workspace', target);
      return { targetKey: normalize(target), displayPath: normalize(target) };
    },
    async stat(target) {
      const file = files.get(target.targetKey);
      if (!file) return undefined;
      return { version: file.version, size: Buffer.byteLength(file.text, 'utf8'), type: file.type };
    },
    async readText(target) {
      const file = files.get(target.targetKey);
      if (!file) throw new MockFsError('not found', 'FS_NOT_FOUND');
      return file.text;
    },
    async writeText(target, text, expected) {
      const file = files.get(target.targetKey);
      if (expected && expected.kind === 'replaceIfVersion') {
        if (!file) throw new MockFsError('file no longer exists', 'FS_STALE_VERSION');
        if (file.version !== expected.version) throw new MockFsError('file changed since read', 'FS_STALE_VERSION');
      }
      if (!file) throw new MockFsError('not found', 'FS_NOT_FOUND');
      const before = file.text;
      file.text = String(text);
      file.version = `v${++serial}`;
      return { operation: 'update', version: file.version, before, after: file.text };
    },
    async editText(target, edit, expected) {
      const file = files.get(target.targetKey);
      if (!file) throw new MockFsError('file no longer exists', 'FS_STALE_VERSION');
      if (expected && file.version !== expected.version) throw new MockFsError('file changed since read', 'FS_STALE_VERSION');
      const before = file.text;
      const occurrences = before.split(edit.oldString).length - 1;
      if (occurrences === 0) throw new MockFsError('old_string was not found', 'FS_EDIT_NOT_FOUND');
      if (occurrences > 1 && !edit.replaceAll) throw new MockFsError('ambiguous edit', 'FS_AMBIGUOUS_EDIT');
      file.text = before.split(edit.oldString).join(edit.newString);
      file.version = `v${++serial}`;
      return { version: file.version, before, after: file.text };
    },
    async watch(target, changed) {
      if (fs.watchMode === 'reject') throw new MockFsError('watching not supported', 'FS_IO_ERROR');
      const record = { target, changed, closed: false };
      fs.watchers.push(record);
      return async () => { record.closed = true; };
    },
    bump(filePath) {
      const file = files.get(normalize(filePath));
      file.version = `v${++serial}`;
      return file.version;
    },
    trigger(filePath) {
      const key = normalize(filePath);
      for (const watcher of fs.watchers) {
        if (watcher.target.targetKey === key) watcher.changed();
      }
    },
  };
  return fs;
}

function createMockContext(fs, options = {}) {
  const routes = [];
  const ctx = {
    fs,
    get(name) {
      if (name === 'fs') return fs;
      if (name === 'connection') return options.connection;
      return undefined;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, routes };
}

function startServer(route) {
  const server = http.createServer((req, res) => { route.handler(req, res); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rawRequest(port, options) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && headers['content-type'] === undefined) {
      headers['content-type'] = 'application/json';
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: text, buffer, json });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function postJson(port, path, payload, headers) {
  return rawRequest(port, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(payload),
  });
}

function openSse(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      res.setEncoding('utf8');
      const events = [];
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (raw.trim().length > 0) events.push(raw);
        }
      });
      resolve({
        req,
        res,
        events,
        countChangeEvents() { return events.filter((raw) => raw.includes('event: change')).length; },
        waitFor(predicate, timeoutMs = 3000) {
          const started = Date.now();
          return new Promise((resolveWait, rejectWait) => {
            const tick = () => {
              for (const raw of events) {
                if (predicate(raw)) { resolveWait(raw); return; }
              }
              if (Date.now() - started > timeoutMs) {
                rejectWait(new Error('SSE wait timeout; events=' + JSON.stringify(events)));
                return;
              }
              setTimeout(tick, 10);
            };
            tick();
          });
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function eventData(raw) {
  const line = raw.split('\n').find((candidate) => candidate.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : null;
}

function waitUntil(check, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try { value = check(); } catch { value = false; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('waitUntil timeout')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function destroySse(handle) {
  try { handle.res.destroy(); } catch { /* 已断 */ }
  try { handle.req.destroy(); } catch { /* 已断 */ }
}

/* ───────────────────────── 纯函数 ───────────────────────── */

test('ETag 由 size-mtime 组成；If-None-Match（含弱标签/列表/*）命中 304', () => {
  const etag = makeEtag(1234, 1699999999123);
  assert.equal(etag, '"1234-1699999999123"');
  assert.equal(isNotModified(etag, etag), true);
  assert.equal(isNotModified(`W/${etag}`, etag), true);
  assert.equal(isNotModified(`"1-2", ${etag}`, etag), true);
  assert.equal(isNotModified('"other"', etag), false);
  assert.equal(isNotModified(undefined, etag), false);
  assert.equal(isNotModified('*', etag), true);
});

test('缓存策略：入口/app/dsh-* no-cache；字体长缓存', () => {
  assert.equal(cacheControlFor('/p/renderer-cm6/index.html'), 'no-cache');
  assert.equal(cacheControlFor('/p/renderer-cm6/app.js'), 'no-cache');
  assert.equal(cacheControlFor('/p/renderer-cm6/app.css'), 'no-cache');
  assert.equal(cacheControlFor('/p/renderer-cm6/dsh-bridge.js'), 'no-cache');
  assert.equal(cacheControlFor('/p/renderer-cm6/dsh-selection.js'), 'no-cache');
  assert.equal(cacheControlFor('/p/renderer-cm6/cm6/fonts/KaTeX.woff2'), 'public, max-age=604800');
  assert.equal(cacheControlFor('/p/renderer-cm6/cm6/fonts/KaTeX.ttf'), 'public, max-age=604800');
  assert.equal(cacheControlFor('/p/renderer-cm6/cm6/markdown-worker.js'), 'no-cache');
});

test('MIME 覆盖 html/js/mjs/css/json/svg/png/woff/woff2/ttf/wasm/map', () => {
  const expected = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
  };
  for (const [ext, mime] of Object.entries(expected)) assert.equal(mimeFor('x' + ext), mime, ext);
  assert.equal(mimeFor('noext'), 'application/octet-stream');
});

test('路径穿越防护：../、编码 ..、绝对路径、盘符、NUL、坏编码全部拒绝', () => {
  const root = 'C:\\plugin\\renderer-cm6';
  assert.equal(resolveStaticTarget(root, 'index.html'), normalize(join(root, 'index.html')));
  assert.ok(resolveStaticTarget(root, 'cm6/app.js'));
  assert.ok(resolveStaticTarget(root, ''));
  const bad = [
    '../package.json',
    '..%2f..%2fsecret',
    '%2e%2e/%2e%2e/package.json',
    '..\\..\\package.json',
    'cm6/%2e%2e/%2e%2e/package.json',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'C:\\Windows\\win.ini',
    '%00evil.js',
    '%E0%A4%A',
    null,
  ];
  for (const candidate of bad) assert.equal(resolveStaticTarget(root, candidate), null, String(candidate));
});

test('loopback 栅栏：host / sec-fetch-site / origin 三查', () => {
  assert.equal(isTrustedLoopbackRequest({ headers: { host: '127.0.0.1:8080' } }), true);
  assert.equal(isTrustedLoopbackRequest({ headers: { host: 'localhost:8080' } }), true);
  assert.equal(isTrustedLoopbackRequest({ headers: { host: 'evil.example' } }), false);
  assert.equal(isTrustedLoopbackRequest({ headers: { host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(isTrustedLoopbackRequest({ headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' } }), true);
  assert.equal(isTrustedLoopbackRequest({ headers: { host: '127.0.0.1:8080', origin: 'http://evil.example' } }), false);
  assert.equal(isTrustedLoopbackRequest({ headers: {} }), false);
});

test('错误码原样透传（含 cause.code / AbortError）', () => {
  assert.equal(errorCode({ code: 'FS_STALE_VERSION' }), 'FS_STALE_VERSION');
  assert.equal(errorCode({ cause: { code: 'FS_IO_ERROR' } }), 'FS_IO_ERROR');
  assert.equal(errorCode({ name: 'AbortError' }), 'FS_ABORTED');
  assert.equal(errorCode(new Error('plain')), 'fs-error');
});

/* ───────────────────────── 宿主 API（apply + mock ctx + 真实 HTTP） ───────────────────────── */

test('apply(ctx) 挂 prefix 路由；open/save/stat/edit 走 mock ctx.fs 与真实 HTTP', async () => {
  const fs = createMockFs({ 'D:/docs/a.md': '# A\n' });
  const { ctx, routes } = createMockContext(fs);
  apply(ctx);
  assert.equal(routes.length, 1);
  const route = routes[0];
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/dsh-markdown');
  assert.equal(BODY_MAX_BYTES, 64 * 1024 * 1024);

  const { server, port } = await startServer(route);
  const opened = await postJson(port, '/dsh-markdown/api/open', { path: 'D:/docs/a.md' });
  const v1 = opened.json.value.version;
  const sseOther = await openSse(port, '/dsh-markdown/api/watch?path=' + encodeURIComponent('D:/docs/other.md'));
  const sseMain = await openSse(port, '/dsh-markdown/api/watch?path=' + encodeURIComponent('D:/docs/a.md'));
  try {
    assert.equal(opened.status, 200);
    assert.equal(opened.json.ok, true);
    assert.equal(opened.json.value.text, '# A\n');
    assert.equal(typeof v1, 'string');
    assert.equal(opened.json.value.displayPath, normalize('D:/docs/a.md'));

    // 缺 path → 明确 bad-request
    const noPath = await postJson(port, '/dsh-markdown/api/open', {});
    assert.equal(noPath.json.ok, false);
    assert.equal(noPath.json.error.code, 'bad-request');

    // save 缺 baseVersion → 拒绝且磁盘不变（关 tab flush 也不许盲写）
    const noBase = await postJson(port, '/dsh-markdown/api/save', { path: 'D:/docs/a.md', text: '# X\n' });
    assert.equal(noBase.json.ok, false);
    assert.equal(noBase.json.error.code, 'bad-request');
    assert.equal(fs.files.get(normalize('D:/docs/a.md')).text, '# A\n');

    // 旧 baseVersion → FS_STALE_VERSION 原样返回，文件不被覆盖
    const stale = await postJson(port, '/dsh-markdown/api/save', { path: 'D:/docs/a.md', text: '# stolen\n', baseVersion: 'bogus' });
    assert.equal(stale.json.ok, false);
    assert.equal(stale.json.error.code, 'FS_STALE_VERSION');
    assert.equal(fs.files.get(normalize('D:/docs/a.md')).text, '# A\n');

    // 正确 baseVersion → 成功；向所有 SSE 连接广播 version
    const saved = await postJson(port, '/dsh-markdown/api/save', { path: 'D:/docs/a.md', text: '# B\n', baseVersion: v1 });
    assert.equal(saved.json.ok, true);
    const v2 = saved.json.value.version;
    assert.notEqual(v2, v1);
    assert.equal(fs.files.get(normalize('D:/docs/a.md')).text, '# B\n');
    const eventMain = eventData(await sseMain.waitFor((raw) => raw.includes('event: change')));
    assert.equal(eventMain.version, v2);
    assert.equal(eventMain.path, normalize('D:/docs/a.md'));
    const eventOther = eventData(await sseOther.waitFor((raw) => raw.includes('event: change')));
    assert.equal(eventOther.version, v2, '写成功后要向所有 SSE 连接广播（客户端按 path 过滤）');

    // stat 返回新版本
    const stat = await postJson(port, '/dsh-markdown/api/stat', { path: 'D:/docs/a.md' });
    assert.equal(stat.json.ok, true);
    assert.equal(stat.json.value.version, v2);

    // edit：oldString/newString + baseVersion 守卫，带 delta 广播
    const edited = await postJson(port, '/dsh-markdown/api/edit', {
      path: 'D:/docs/a.md', oldString: 'B', newString: 'C', baseVersion: v2,
    });
    assert.equal(edited.json.ok, true);
    const v3 = edited.json.value.version;
    assert.equal(edited.json.value.changed, true);
    assert.equal(fs.files.get(normalize('D:/docs/a.md')).text, '# C\n');
    const editDelta = eventData(await sseMain.waitFor((raw) => {
      const data = raw.includes('event: change') ? eventData(raw) : null;
      return data && data.version === v3 && data.delta;
    }));
    assert.equal(editDelta.delta.oldString, 'B');
    assert.equal(editDelta.delta.newString, 'C');

    // edit 旧版本 → FS_STALE_VERSION
    const editStale = await postJson(port, '/dsh-markdown/api/edit', {
      path: 'D:/docs/a.md', oldString: 'C', newString: 'D', baseVersion: v2,
    });
    assert.equal(editStale.json.error.code, 'FS_STALE_VERSION');

    // 不支持的 endpoint：明确 404，不静默
    const unknown = await postJson(port, '/dsh-markdown/api/nope', {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'not-found');

    // content-type 不对：415
    const wrongType = await rawRequest(port, {
      method: 'POST', path: '/dsh-markdown/api/open', headers: { 'content-type': 'text/plain' }, body: '{}',
    });
    assert.equal(wrongType.status, 415);

    // loopback 栅栏：外部 Host / 跨站 Origin 一律 403
    const evilHost = await postJson(port, '/dsh-markdown/api/open', { path: 'D:/docs/a.md' }, { host: 'evil.example' });
    assert.equal(evilHost.status, 403);
    const evilOrigin = await postJson(port, '/dsh-markdown/api/open', { path: 'D:/docs/a.md' }, { origin: 'http://evil.example' });
    assert.equal(evilOrigin.status, 403);
  } finally {
    destroySse(sseMain);
    destroySse(sseOther);
    await stopServer(server);
  }
});

test('requestRejection 可用时以方法调用（优先于 loopback 栅栏）', async () => {
  const fs = createMockFs({ 'D:/d/x.md': 'x' });
  const connection = {
    requestRejection(req) {
      return req.headers['x-block'] === '1' ? 403 : undefined;
    },
  };
  const { ctx, routes } = createMockContext(fs, { connection });
  apply(ctx);
  const { server, port } = await startServer(routes[0]);
  try {
    // 外部 Host 也能通过：说明栅栏交给 connection（方法形式）而不是本地 loopback 判定
    const allowed = await postJson(port, '/dsh-markdown/api/stat', { path: 'D:/d/x.md' }, { host: 'evil.example' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.ok, true);
    const blocked = await postJson(port, '/dsh-markdown/api/stat', { path: 'D:/d/x.md' }, { host: 'evil.example', 'x-block': '1' });
    assert.equal(blocked.status, 403);
  } finally {
    await stopServer(server);
  }
});

/* ───────────────────────── 静态路由 / core.json / ETag ───────────────────────── */

test('静态路由：MIME/ETag/304/no-cache/fonts 长缓存/HEAD/core.json/穿越防护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmd-static-'));
  const fs = createMockFs({});
  const host = createHost({ fs, rootDir: root, log: SILENT_LOG });
  await mkdir(join(root, 'renderer-cm6', 'cm6', 'fonts'), { recursive: true });
  await writeFile(join(root, 'renderer-cm6', 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');
  await writeFile(join(root, 'renderer-cm6', 'app.js'), 'console.log(1);\n', 'utf8');
  await writeFile(join(root, 'renderer-cm6', 'dsh-bridge.js'), '// bridge\n', 'utf8');
  await writeFile(join(root, 'renderer-cm6', 'cm6', 'fonts', 'f.woff2'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, 'core.json'), JSON.stringify({ core: 'MarkPilot CM6', version: '3.6.2' }), 'utf8');

  const { server, port } = await startServer(host.route);
  try {
    const index = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/index.html' });
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.match(index.headers.etag, /^"\d+-\d+"$/);
    assert.match(index.body, /<!doctype html>/);

    const notModified = await rawRequest(port, {
      path: '/dsh-markdown/renderer-cm6/index.html',
      headers: { 'if-none-match': index.headers.etag },
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body, '');

    const app = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/app.js' });
    assert.equal(app.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(app.headers['cache-control'], 'no-cache');

    const bridge = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/dsh-bridge.js' });
    assert.equal(bridge.headers['cache-control'], 'no-cache');

    const font = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/cm6/fonts/f.woff2' });
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal(font.headers['cache-control'], 'public, max-age=604800');
    assert.equal(font.buffer.length, 4);

    // 目录根（/renderer-cm6/ 与不带尾斜杠）落到 index.html
    const rootSlash = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/' });
    assert.equal(rootSlash.status, 200);
    assert.match(rootSlash.body, /<!doctype html>/);
    const rootNoSlash = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6' });
    assert.equal(rootNoSlash.status, 200);

    // HEAD 不返回 body
    const head = await rawRequest(port, { method: 'HEAD', path: '/dsh-markdown/renderer-cm6/app.js' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    // core.json 正常返回
    const core = await rawRequest(port, { path: '/dsh-markdown/core.json' });
    assert.equal(core.status, 200);
    assert.equal(core.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(core.headers['cache-control'], 'no-store');
    assert.equal(core.json.version, '3.6.2');

    // 路径穿越：编码斜杠必须 403；WHATWG URL 会把 %2e%2e 归一化成 ..（结果落在静态前缀之外），
    // 此时路由层 404，绝不能 200 返回包内文件。两条路径都不许把内容泄出去。
    const traversal = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/..%2f..%2fcore.json' });
    assert.equal(traversal.status, 403);
    const traversal2 = await rawRequest(port, { path: '/dsh-markdown/renderer-cm6/%2e%2e/%2e%2e/package.json' });
    assert.ok(traversal2.status === 403 || traversal2.status === 404, `expected 403/404, got ${traversal2.status}`);
    assert.equal(traversal2.body.includes('"name": "dsh-markdown"'), false, '包内文件内容不得泄露');

    // core.json 不存在 → 404 JSON，客户端不崩
    const missingRoot = await mkdtemp(join(tmpdir(), 'dshmd-nocore-'));
    const hostNoCore = createHost({ fs, rootDir: missingRoot, log: SILENT_LOG });
    const noCore = await startServer(hostNoCore.route);
    try {
      const core404 = await rawRequest(noCore.port, { path: '/dsh-markdown/core.json' });
      assert.equal(core404.status, 404);
      assert.equal(core404.json.error.code, 'not-found');
    } finally {
      await stopServer(noCore.server);
      hostNoCore.close();
      await rm(missingRoot, { recursive: true, force: true });
    }
  } finally {
    await stopServer(server);
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* ───────────────────────── SSE watch ───────────────────────── */

test('SSE watch：fs.watch 变更 120ms 防抖广播', async () => {
  const fs = createMockFs({ 'D:/d/w.md': 'one' });
  const host = createHost({ fs, log: SILENT_LOG, watchDebounceMs: 25, watchProbeMs: 30, heartbeatMs: 5000 });
  const { server, port } = await startServer(host.route);
  const sse = await openSse(port, '/dsh-markdown/api/watch?path=' + encodeURIComponent('D:/d/w.md'));
  try {
    await waitUntil(() => fs.watchers.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30)); // 等基线版本建立
    const version = fs.bump('D:/d/w.md');
    fs.trigger('D:/d/w.md');
    const first = eventData(await sse.waitFor((raw) => raw.includes('event: change')));
    assert.equal(first.version, version);

    // 连续两次写 → 防抖后只广播一帧
    fs.bump('D:/d/w.md');
    fs.trigger('D:/d/w.md');
    const latest = fs.bump('D:/d/w.md');
    fs.trigger('D:/d/w.md');
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(sse.countChangeEvents(), 2, '首次 1 帧 + 突发合并 1 帧');
    const frames = sse.events.filter((raw) => raw.includes('event: change')).map(eventData);
    assert.equal(frames[frames.length - 1].version, latest);
  } finally {
    destroySse(sse);
    await stopServer(server);
    host.close();
  }
});

test('SSE watch：fs.watch 不可用时降级为探测（2s 默认档在测试里缩短）', async () => {
  const fs = createMockFs({ 'D:/d/p.md': 'a' });
  fs.watchMode = 'reject';
  const host = createHost({ fs, log: SILENT_LOG, watchDebounceMs: 10, watchProbeMs: 30, heartbeatMs: 5000 });
  const { server, port } = await startServer(host.route);
  const sse = await openSse(port, '/dsh-markdown/api/watch?path=' + encodeURIComponent('D:/d/p.md'));
  try {
    await waitUntil(() => host._internals.watchers.size >= 1);
    await new Promise((resolve) => setTimeout(resolve, 120)); // 让探测跑几轮建立基线
    const version = fs.bump('D:/d/p.md');
    const event = eventData(await sse.waitFor((raw) => raw.includes('event: change')));
    assert.equal(event.version, version);
  } finally {
    destroySse(sse);
    await stopServer(server);
    host.close();
  }
});

test('body 上限：超过配置即 413，不静默截断', async () => {
  const fs = createMockFs({ 'D:/d/big.md': 'small' });
  const host = createHost({ fs, log: SILENT_LOG, bodyLimit: 128 });
  const { server, port } = await startServer(host.route);
  try {
    const huge = await postJson(port, '/dsh-markdown/api/save', {
      path: 'D:/d/big.md', text: 'x'.repeat(1024), baseVersion: 'v1',
    });
    assert.equal(huge.status, 413);
    assert.equal(huge.json.error.code, 'too-large');
    assert.equal(fs.files.get(normalize('D:/d/big.md')).text, 'small');
  } finally {
    await stopServer(server);
    host.close();
  }
});

test('markdown 工具定义：0.2.1 defineTool 形态（output.schema/render）+ 与保存同一守卫', async () => {
  const calls = [];
  const dispatch = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'open') return { ok: true, value: { text: '# hi', version: 'v1', displayPath: 'D:/a.md' } };
    return { ok: true, value: { version: 'v2', displayPath: 'D:/a.md', changed: true } };
  };
  const spec = createMarkdownToolDefinition(dispatch);
  assert.equal(spec.name, 'markdown');
  assert.equal(spec.parameters.action.required, true);
  assert.equal(spec.parameters.path.required, true);
  assert.ok(spec.output && spec.output.schema && typeof spec.output.render === 'function');

  const read = await spec.execute({ action: 'read', path: 'D:/a.md' });
  assert.deepEqual(plain(read), { ok: true, action: 'read', text: '# hi', version: 'v1', displayPath: 'D:/a.md' });
  assert.equal(calls[0].endpoint, 'open');

  const edited = await spec.execute({ action: 'edit', path: 'D:/a.md', oldString: 'a', newString: 'b', baseVersion: 'v1' });
  assert.equal(edited.ok, true);
  assert.equal(calls[1].endpoint, 'edit');
  assert.equal(calls[1].payload.oldString, 'a');
  assert.equal(calls[1].payload.newString, 'b');
  assert.equal(calls[1].payload.baseVersion, 'v1');

  // 错误码原样透传（不吞成 message）
  const failSpec = createMarkdownToolDefinition(async () => ({ ok: false, error: { code: 'FS_STALE_VERSION', message: 'file changed' } }));
  const failed = await failSpec.execute({ action: 'edit', path: 'D:/a.md', oldString: 'a', newString: 'b', baseVersion: 'v1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'FS_STALE_VERSION');

  const blocks = spec.output.render({ action: 'read' }, read);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /版本 v1/);
  const errorBlocks = spec.output.render({ action: 'edit' }, failed);
  assert.match(errorBlocks[0].text, /FS_STALE_VERSION/);

  // 若本机 profile 能解析 @deepseek-ai/dsh-tools，直接证明真实 defineTool 接受该定义。
  let realTools;
  try { realTools = await import('@deepseek-ai/dsh-tools'); } catch { realTools = null; }
  if (realTools && typeof realTools.defineTool === 'function') {
    const compiled = realTools.defineTool(spec);
    assert.equal(compiled.name, 'markdown');
    assert.equal(compiled.parameters.type, 'object');
    assert.deepEqual(plain(compiled.parameters.required).sort(), ['action', 'path']);
    assert.equal(compiled.output.schema.type, 'object');
    assert.equal(typeof compiled.output.render, 'function');
  } else {
    // 源码树里插件没装依赖：真实宿主安装在 profile 下时才可达，属于未验证项（见报告）。
    assert.equal(realTools, null);
  }
});

test('createHost 缺少 fs 服务时明确抛错（apply 会捕获并告警）', () => {
  assert.throws(() => createHost({}), /fs/);
});
