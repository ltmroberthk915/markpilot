'use strict';
/*
 * Lightweight real-handler regression for the desktop save-failure family.
 *
 * What is real:
 *   - the file:save handler + classifyStoreError extracted from the checked
 *     worktree MarkPilot-CM6/main.js (or MP_MAIN override);
 *   - saveFailure/saveAsFailure extracted from the checked
 *     worktree MarkPilot-CM6/renderer/host.js (or MP_HOST override);
 *   - node:sqlite itself: pre-write CORRUPT/NOTADB errors are produced by a
 *     real corrupt rooms.sqlite opened through the real LiveDocuments; the
 *     post-write error object is captured from a real corrupt SQLite database
 *     and thrown by the test's controlled writer after it wrote the file.
 *
 * What is stubbed / mutated (test only, never in product):
 *   - main-process dependencies (sessions, documents, dbg, window helpers);
 *   - the writer itself: it writes the file, then optionally throws the real
 *     captured SQLite error, to exercise the real catch's writeStarted branch.
 *
 * Run (no staging dependency; temp is a fresh owned os.tmpdir dir, falling
 * back to .mp-verify/store-isolation/test-tmp):
 *   node tools/quality/tests/file-save-store-regression.test.cjs
 *   node --test tools/quality/tests/file-save-store-regression.test.cjs
 * Before applying the candidate, override the source paths explicitly:
 *   MP_MAIN=.mp-verify/store-isolation/display/stage/MarkPilot-CM6/main.js \
 *   MP_HOST=.mp-verify/store-isolation/display/stage/MarkPilot-CM6/renderer/host.js \
 *   node tools/quality/tests/file-save-store-regression.test.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

function findRoot(from) {
  let dir = path.resolve(from);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'tools', 'quality', 'lifecycle.cjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found from ' + from);
}
const ROOT = findRoot(__dirname);
const MAIN = path.resolve(process.env.MP_MAIN || path.join(ROOT, 'MarkPilot-CM6/main.js'));
const HOST = path.resolve(process.env.MP_HOST || path.join(ROOT, 'MarkPilot-CM6/renderer/host.js'));
const LIVE_MODULE = path.join(ROOT, 'MarkPilot-CM6/shell/live-documents.js');
function ownedTmpRoot() {
  const base = os.tmpdir();
  try { fs.accessSync(base, fs.constants.W_OK); return base; }
  catch {
    const dir = path.join(ROOT, '.mp-verify/store-isolation/test-tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
const RUN = fs.mkdtempSync(path.join(ownedTmpRoot(), 'markpilot-store-regression-'));

function makeDir(name) {
  const dir = path.join(RUN, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function makeMalformed(liveDir) {
  fs.mkdirSync(liveDir, { recursive: true });
  const file = path.join(liveDir, 'rooms.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE seed(x INTEGER); INSERT INTO seed VALUES (1);');
  db.close();
  fs.truncateSync(file, 100);
}
function makeNotadb(liveDir) {
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'rooms.sqlite'), 'this is not a sqlite database\n'.repeat(32));
}
function captureRealSqliteCorrupt(base) {
  makeMalformed(base);
  const file = path.join(base, 'rooms.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE after_corruption(a INTEGER)');
  } catch (error) {
    return error;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  throw new Error('expected a real SQLITE_CORRUPT error');
}

// ── real file:save handler from staged main.js ───────────────────────────
function loadSaveHandler() {
  const source = fs.readFileSync(MAIN, 'utf8');
  const start = source.indexOf("handle('file:save'");
  const end = source.indexOf("\nhandle('file:stat'", start);
  if (start < 0 || end < 0) throw new Error('file:save handler markers not found in ' + MAIN);
  const headStart = source.lastIndexOf('const MP_STORE_UNAVAILABLE', start);
  if (headStart < 0) throw new Error('classifier markers not found in ' + MAIN);
  const code = source.slice(headStart, start) + '\n' + source.slice(start, end);
  return (context) => {
    let captured = null;
    vm.runInNewContext(code, { ...context, handle: (name, fn) => { if (name === 'file:save') captured = fn; } });
    if (!captured) throw new Error('file:save handler was not registered');
    return captured;
  };
}

function makeMainContext({ filePath, liveDir, afterWriteError = null }) {
  const S = { documentId: 'doc-1', filePath, saveAsGrant: null, revision: 1, baseline: null, diskMtime: 0 };
  const sessions = new Map([[1, S]]);
  const dbg = [];
  let writeCalls = 0;
  const writes = [];
  const { LiveDocuments } = require(LIVE_MODULE);
  const svc = new LiveDocuments({ directory: liveDir });
  const context = {
    state: { settings: { autosaveEnabled: true, autosaveIntervalMs: 1000 } },
    sessionOf: () => S,
    sessions,
    documents: { key: p => String(p).toLowerCase(), canonical: async p => p },
    liveLeaseFor: () => null,
    liveService: () => svc,
    liveMainFrameOk: () => true,
    LIVE_UNAVAILABLE: { ok: false, code: 'MP_LIVE_UNAVAILABLE' },
    liveEntryFor: () => null,
    dbg: (...args) => dbg.push(args),
    writeDoc: async (fp, text) => {
      writeCalls++;
      writes.push({ filePath: fp, text });
      fs.writeFileSync(fp, text);
      if (afterWriteError) throw afterWriteError;
      return { ok: true, bytes: Buffer.byteLength(text), current: true, filePath: fp };
    },
    liveNoteHead: () => {},
    syncPathUi: () => {},
    windowOf: () => ({}),
    liveLeaveOwned: () => {},
    liveRoomActive: () => false,
    liveAlignSiblingSessions: () => {},
  };
  return { context, dbg, svc, state: S, get writeCalls() { return writeCalls; }, writes };
}

// ── real host saveFailure/saveAsFailure from staged host.js ──────────────
function loadHostHandlers() {
  const source = fs.readFileSync(HOST, 'utf8');
  const helperStart = source.indexOf('const MP_STORE_UNAVAILABLE');
  const helperEnd = source.indexOf('\nconst bus = Object.create(null);', helperStart);
  if (helperStart < 0 || helperEnd < 0) throw new Error('host helper markers not found in ' + HOST);
  const helpers = new Function(source.slice(helperStart, helperEnd) +
    '\n; return { MP_STORE_UNAVAILABLE, storeBaseName, storeNameSuffix, storeUnavailableText, mergedStoreUnavailableText };')();
  const saveStart = source.indexOf('function saveAsFailure');
  const saveEnd = source.indexOf('\nasync function keepMine', saveStart);
  if (saveStart < 0 || saveEnd < 0) throw new Error('host save handlers not found in ' + HOST);
  const saveBlock = source.slice(saveStart, saveEnd);
  return function factory({ showBanner, showSourceRecovery, saveTrace, doSave = () => {}, saveAsFlow = () => {}, reloadDocument = () => {}, keepMine = () => {} }) {
    const fn = new Function(
      'MP_STORE_UNAVAILABLE', 'storeUnavailableText', 'mergedStoreUnavailableText',
      'showBanner', 'showSourceRecovery', 'saveTrace', 'doSave', 'saveAsFlow', 'reloadDocument', 'keepMine',
      `let sourceRecovery = null, documentId = 'doc-1', saveBlocked = false, lastSaveError = null;
       ${saveBlock}
       return {
         saveFailure, saveAsFailure,
         setRecovery(value) { sourceRecovery = value; lastSaveError = value ? 'source failure' : null; },
         getState() { return { sourceRecovery, lastSaveError, saveBlocked }; }
       };`
    );
    return fn(helpers.MP_STORE_UNAVAILABLE, helpers.storeUnavailableText, helpers.mergedStoreUnavailableText,
      showBanner, showSourceRecovery, saveTrace, doSave, saveAsFlow, reloadDocument, keepMine);
  };
}

function labels(actions) { return (actions || []).map(a => a.label); }

test('main file:save: real corrupt store fails before writer -> writeStarted:false', async () => {
  const dir = makeDir('main-prewrite-11');
  const liveDir = path.join(dir, 'live');
  makeMalformed(liveDir);
  const doc = path.join(dir, 'doc.md');
  const initial = '# initial\n';
  fs.writeFileSync(doc, initial);
  const h = makeMainContext({ filePath: doc, liveDir });
  const handler = loadSaveHandler()(h.context);
  const response = await handler({ sender: { id: 1, isDestroyed: () => false } }, { filePath: doc, text: '# changed\n' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'MP_STORE_UNAVAILABLE');
  assert.equal(response.storePrimary, 11);
  assert.equal(response.errcode, 11);
  assert.equal(response.writeStarted, false);
  assert.match(response.error, /database disk image is malformed/);
  assert.equal(response.sqliteCode, 'ERR_SQLITE_ERROR');
  assert.equal(fs.readFileSync(doc, 'utf8'), initial, 'pre-write: disk unchanged');
  assert.equal(h.writeCalls, 0, 'pre-write: writer not entered');
  assert(h.dbg.some(args => String(args[0]) === 'file:save:store-unavailable' && args[1].prewrite === true));
});

test('main file:save: real NOTADB fails before writer -> storePrimary:26', async () => {
  const dir = makeDir('main-prewrite-26');
  const liveDir = path.join(dir, 'live');
  makeNotadb(liveDir);
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, 'initial\n');
  const h = makeMainContext({ filePath: doc, liveDir });
  const handler = loadSaveHandler()(h.context);
  const response = await handler({ sender: { id: 1, isDestroyed: () => false } }, { filePath: doc, text: 'changed\n' });
  assert.equal(response.code, 'MP_STORE_UNAVAILABLE');
  assert.equal(response.storePrimary, 26);
  assert.equal(response.writeStarted, false);
  assert.match(response.error, /file is not a database/);
  assert.equal(h.writeCalls, 0);
});

test('main file:save: real SQLite post-write error -> writeStarted:true and disk changed', async () => {
  const dir = makeDir('main-postwrite-11');
  const liveDir = path.join(dir, 'live');
  const realError = captureRealSqliteCorrupt(makeDir('capture-11'));
  assert.equal(realError.errcode, 11);
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, 'initial\n');
  const h = makeMainContext({ filePath: doc, liveDir, afterWriteError: realError });
  const handler = loadSaveHandler()(h.context);
  const text = 'after-write 修改\n';
  const response = await handler({ sender: { id: 1, isDestroyed: () => false } }, { filePath: doc, text });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'MP_STORE_UNAVAILABLE');
  assert.equal(response.storePrimary, 11);
  assert.equal(response.writeStarted, true, 'writer entered -> unconfirmed');
  assert.equal(fs.readFileSync(doc, 'utf8'), text, 'writer really changed the disk');
  assert.equal(h.writeCalls, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].text, text);
  assert(h.dbg.some(args => String(args[0]) === 'file:save:store-unavailable' && args[1].prewrite === false));
});

test('main file:save: non-family SQLite code (BUSY) keeps old response shape', async () => {
  const dir = makeDir('main-nonfamily-busy');
  const liveDir = path.join(dir, 'live');
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, 'initial\n');
  const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
  const h = makeMainContext({ filePath: doc, liveDir, afterWriteError: busy });
  const handler = loadSaveHandler()(h.context);
  const response = await handler({ sender: { id: 1, isDestroyed: () => false } }, { filePath: doc, text: 'busy text\n' });
  assert.equal(response.code, 'ERR_SQLITE_ERROR', 'non-family code unchanged');
  assert.equal(response.writeStarted, undefined, 'non-family does not leak phase');
  assert.match(response.error, /database is locked/);
  assert.equal(fs.readFileSync(doc, 'utf8'), 'busy text\n');
});

test('main file:save: healthy store succeeds and writes the text', async () => {
  const dir = makeDir('main-success');
  const liveDir = path.join(dir, 'live');
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, 'initial\n');
  const h = makeMainContext({ filePath: doc, liveDir });
  const handler = loadSaveHandler()(h.context);
  const response = await handler({ sender: { id: 1, isDestroyed: () => false } }, { filePath: doc, text: 'success\n' });
  assert.equal(response.ok, true);
  assert.equal(fs.readFileSync(doc, 'utf8'), 'success\n');
  assert.equal(h.writeCalls, 1);
});

function hostHarness() {
  const calls = [];
  const traces = [];
  const factory = loadHostHandlers();
  const api = factory({
    showBanner: (text, actions, info) => { calls.push({ type: 'banner', text, actions, info }); return calls.length; },
    showSourceRecovery: (text, actions, meta) => { calls.push({ type: 'recovery', text, actions, meta }); return calls.length; },
    saveTrace: (step, detail) => traces.push({ step, detail }),
  });
  return { api, calls, traces, FAMILY: 'MP_STORE_UNAVAILABLE' };
}

test('host saveFailure: prewrite auto copy + 3 actions, no raw/full path', () => {
  const h = hostHarness();
  h.api.saveFailure({ code: h.FAMILY, error: 'database disk image is malformed', errcode: 11, storePrimary: 11, writeStarted: false },
    'C:\\very\\long\\dir\\a.md', { automatic: true });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.type, 'recovery');
  assert.match(call.text, /自动保存未完成/);
  assert.match(call.text, /协同存储暂不可用/);
  assert.match(call.text, /本次未保存/);
  assert.match(call.text, /修改仍在当前窗口/);
  assert.match(call.text, /请保留窗口并重试/);
  assert.doesNotMatch(call.text, /database disk image is malformed|C:\\very\\long\\dir/);
  assert.match(call.text, /（a\.md）/);
  assert.deepEqual(labels(call.actions), ['另存为…', '重新加载', '重试']);
  assert.equal(call.meta.family, h.FAMILY);
  assert.equal(call.meta.writeStarted, false);
  assert.equal(h.traces[0].detail.raw, 'database disk image is malformed');
  assert.equal(h.traces[0].detail.writeStarted, false);
  assert.equal(h.api.getState().lastSaveError, 'database disk image is malformed');
});

test('host saveFailure: manual and unconfirmed wording differ', () => {
  const h = hostHarness();
  h.api.saveFailure({ code: h.FAMILY, error: 'database disk image is malformed', writeStarted: false }, 'C:\\x\\a.md');
  assert.match(h.calls[0].text, /保存失败/);
  assert.doesNotMatch(h.calls[0].text, /自动保存未完成/);
  const h2 = hostHarness();
  h2.api.saveFailure({ code: h2.FAMILY, error: 'database disk image is malformed', writeStarted: true }, 'C:\\x\\a.md');
  assert.match(h2.calls[0].text, /保存结果未确认/);
  assert.match(h2.calls[0].text, /核对磁盘内容后再重试/);
  assert.doesNotMatch(h2.calls[0].text, /本次未保存/);
  assert.doesNotMatch(h2.calls[0].text, /C:\\x/);
});

test('host saveFailure: non-family keeps raw error + full path + existing actions', () => {
  const h = hostHarness();
  h.api.saveFailure({ code: 'MP_FILE_CONFLICT', error: '文件已被其他窗口或程序修改，请重新加载', writeStarted: true }, 'C:\\x\\a.md');
  const call = h.calls[0];
  assert.equal(call.type, 'recovery');
  assert.equal(call.text, '保存失败：文件已被其他窗口或程序修改，请重新加载（C:\\x\\a.md）');
  assert.deepEqual(labels(call.actions), ['另存为…', '重新加载', '保留我的修改']);
  assert.equal(h.api.getState().saveBlocked, true);
});

test('host saveAsFailure: same-family merge is one short line and keeps recovery actions', () => {
  const h = hostHarness();
  const actions = [{ label: '另存为…' }, { label: '重新加载' }, { label: '重试' }];
  h.api.setRecovery({ documentId: 'doc-1', family: h.FAMILY, path: 'C:\\x\\a.md', writeStarted: false, actions, text: 'old' });
  h.api.saveAsFailure({ code: h.FAMILY, error: 'database disk image is malformed', writeStarted: false }, 'C:\\x\\b.md');
  const call = h.calls[0];
  assert.equal(call.type, 'banner');
  assert.match(call.text, /保存与另存为均未完成/);
  assert.match(call.text, /本次未保存/);
  assert.match(call.text, /原文件 a\.md；另存为 b\.md/);
  assert.equal((call.text.match(/协同存储暂不可用/g) || []).length, 1);
  assert.doesNotMatch(call.text, /database disk image is malformed|C:\\x/);
  assert.deepEqual(labels(call.actions), ['另存为…', '重新加载', '重试']);
});

test('host saveAsFailure: one uncertain phase -> unconfirmed merge', () => {
  const h = hostHarness();
  const actions = [{ label: '另存为…' }, { label: '重新加载' }, { label: '重试' }];
  h.api.setRecovery({ documentId: 'doc-1', family: h.FAMILY, path: 'C:\\x\\a.md', writeStarted: true, actions, text: 'old' });
  h.api.saveAsFailure({ code: h.FAMILY, error: 'database disk image is malformed', writeStarted: false }, 'C:\\x\\b.md');
  assert.match(h.calls[0].text, /保存结果未确认/);
  assert.match(h.calls[0].text, /核对原文件与目标文件后再重试/);
  assert.doesNotMatch(h.calls[0].text, /本次未保存/);
});

test('host saveAsFailure: other-cause recovery is preserved verbatim', () => {
  const h = hostHarness();
  h.api.setRecovery({ documentId: 'doc-1', family: null, path: 'C:\\x\\a.md', writeStarted: true, actions: [{ label: '载入磁盘版本' }], text: '读取期间继续编辑，已保留当前内容。' });
  h.api.saveAsFailure({ error: 'ENOSPC: no space left on device' }, 'C:\\x\\b.md');
  assert.equal(h.calls[0].text, '另存为失败：ENOSPC: no space left on device（C:\\x\\b.md）。读取期间继续编辑，已保留当前内容。');
  assert.deepEqual(labels(h.calls[0].actions), ['载入磁盘版本']);
});

console.log('test-runs:', RUN);
