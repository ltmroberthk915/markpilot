'use strict';
// Long-term regression for the acceptance store isolation launcher.
// Run from the repository root: node --test tools/quality/tests/store-isolation.test.cjs
// It imports the real helper and the real desktop/plugin host modules; no
// .mp-verify staging paths are hardcoded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../../..');
const store = require('../store-isolation.cjs');
const { LiveDocuments: DesktopLiveDocuments } = require(path.join(REPO, 'MarkPilot-CM6/shell/live-documents.js'));
const { LiveDocuments: PluginLiveDocuments } = require(path.join(REPO, 'dsh-markdown-editor-typora/host/live-documents.js'));
const DESKTOP = path.join(REPO, 'MarkPilot-CM6/shell/live-documents.js');
const PLUGIN = path.join(REPO, 'dsh-markdown-editor-typora/host/live-documents.js');
const KEY = process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME';
const roots = [];

// Child modes: require(argv[1]); hold joins and parks a room, read returns it.
const CHILD = `
const fs = require('node:fs');
const { LiveDocuments } = require(process.argv[1]);
const mode = process.argv[2], file = process.argv[3], text = process.argv[4], ready = process.argv[5];
(async () => {
  const live = new LiveDocuments();
  if (mode === 'read') {
    const room = await live.readRoom(file);
    process.stdout.write(JSON.stringify({ directory: live.directory, room }));
    return;
  }
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const joined = await live.join(file, text);
  fs.writeFileSync(ready, JSON.stringify({ directory: live.directory, epoch: joined.epoch }));
  await new Promise(resolve => setTimeout(resolve, 15000));
})().catch(error => { console.error(error); process.exit(3); });
`;

function runDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-store-regression-'));
  roots.push(dir);
  return dir;
}
function waitFile(file, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* still writing */ }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error('timed out waiting for ' + file);
}
function runToFile(env, cwd, args) {
  const out = path.join(cwd, 'child-' + crypto.randomUUID() + '.out');
  const err = path.join(cwd, 'child-' + crypto.randomUUID() + '.err');
  const outFd = fs.openSync(out, 'w'), errFd = fs.openSync(err, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, ['-e', CHILD, ...args], {
      env, cwd, stdio: ['ignore', outFd, errFd], timeout: 20000, windowsHide: true,
    });
  } finally { fs.closeSync(outFd); fs.closeSync(errFd); }
  const lines = fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  let json = null;
  for (let i = lines.length - 1; i >= 0; i--) { try { json = JSON.parse(lines[i]); break; } catch { /* keep looking */ } }
  return { status: result.status, json, stderr: fs.readFileSync(err, 'utf8') };
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* best effort */ }
  }
  await new Promise(resolve => { const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* child may still hold a handle */ }
  }
});

test('different runs get different live stores; one run reuses its base', () => {
  const runA = runDir(), runB = runDir();
  const a = store.prepareStoreEnv(runA), b = store.prepareStoreEnv(runB);
  assert.ok(a.metadata.base.startsWith(path.join(runA, '.mp-store-')));
  assert.ok(b.metadata.base.startsWith(path.join(runB, '.mp-store-')));
  assert.notEqual(a.metadata.base, b.metadata.base);
  assert.notEqual(a.metadata.liveDir, b.metadata.liveDir);
  const again = store.prepareStoreEnv(runA);
  assert.equal(again.metadata.base, a.metadata.base);
  assert.equal(new DesktopLiveDocuments({ directory: a.metadata.liveDir }).directory, a.metadata.liveDir);
  assert.equal(new PluginLiveDocuments({ directory: a.metadata.liveDir }).directory, a.metadata.liveDir);
});

test('desktop and plugin hosts in separate processes share one rooms.sqlite', async () => {
  const run = runDir(), work = runDir();
  const prepared = store.prepareStoreEnv(run);
  const file = path.join(work, 'shared.md'), ready = path.join(work, 'ready.json');
  const env = store.mergeEnv(process.env, prepared.env);
  const holder = spawn(process.execPath, ['-e', CHILD, DESKTOP, 'hold', file, 'SAME\n', ready], {
    env, cwd: work, stdio: 'ignore', windowsHide: true,
  });
  try {
    const held = waitFile(ready);
    const read = runToFile(env, work, [PLUGIN, 'read', file]);
    assert.equal(read.status, 0, read.stderr);
    assert.ok(read.json, 'plugin child returned JSON');
    assert.equal(held.directory, read.json.directory);
    assert.equal(read.json.directory, prepared.metadata.liveDir);
    assert.equal(read.json.room.epoch, held.epoch);
    assert.equal(fs.existsSync(path.join(prepared.metadata.liveDir, 'rooms.sqlite')), true);
  } finally {
    await stop(holder);
  }
});

test('hard-linked SQLite journal is rejected, and an escaping base is rejected', () => {
  const run = runDir();
  const prepared = store.prepareStoreEnv(run);
  const journal = path.join(prepared.metadata.liveDir, 'rooms.sqlite-journal');
  fs.writeFileSync(journal, 'x');
  fs.linkSync(journal, journal + '.hardlink');
  assert.throws(() => store.prepareStoreEnv(run), /hard-linked/);
  assert.throws(() => store.prepareStoreEnv(run, { [KEY]: path.join(run, '..', 'outside') }), /independent child|escapes/);
  assert.throws(() => store.prepareStoreEnv(run, { [KEY]: path.join(run, 'second') }), /another store base/);
});
