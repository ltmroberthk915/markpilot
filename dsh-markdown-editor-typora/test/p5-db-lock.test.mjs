import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteGuard } from '../lib/index.js';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { LiveDocuments, retireLiveStorage } = require('../host/live-documents.js');
const BASE = { kind: 'createIfAbsent' };
const TARGET = { targetKey: 'D:/probe/locked.md', displayPath: 'D:/probe/locked.md' };

function makeCtx() {
  const listeners = new Map();
  return {
    ctx: { on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); } },
    listeners,
  };
}

function lockedChild(dbFile) {
  const ready = dbFile + '.locked-' + process.pid;
  const failure = ready + '.err';
  const code = `const fs=require('node:fs');const { DatabaseSync } = require('node:sqlite');
try { const db = new DatabaseSync(${JSON.stringify(dbFile)});
db.exec('PRAGMA locking_mode=EXCLUSIVE');
db.exec('BEGIN EXCLUSIVE');
fs.writeFileSync(${JSON.stringify(ready)}, 'locked'); }
catch (error) { fs.writeFileSync(${JSON.stringify(failure)}, String(error && error.stack || error)); process.exit(1); }
setInterval(() => {}, 1000);`;
  // stdio:ignore works under sandboxes that refuse piped child stdio; the lock
  // file is the readiness proof, and a failed child leaves its error behind.
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true });
  return (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fsSync.existsSync(ready)) return child;
      if (fsSync.existsSync(failure)) throw new Error('lock child failed: ' + fsSync.readFileSync(failure, 'utf8'));
      if (child.exitCode !== null) throw new Error('lock child exited ' + child.exitCode);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill();
    throw new Error('lock child timeout');
  })();
}

test('P5-G5 real SQLite lock makes the write guard fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-lock-'));
  const file = path.join(root, 'locked.md');
  const dbFile = path.join(root, 'live', 'rooms.sqlite');
  let child;
  try {
    await fs.writeFile(file, 'locked\n', 'utf8');
    const live = new LiveDocuments({ directory: path.join(root, 'live') });
    const joined = await live.join(file, 'locked\n');
    live.leave(joined.client);
    retireLiveStorage();
    child = await lockedChild(dbFile);
    const h = makeCtx();
    const guard = createWriteGuard({
      fs: { stat: async () => ({ version: 'v1' }) },
      lookup: async () => {
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try { db.prepare("SELECT value FROM meta WHERE key='host'").get(); return null; }
        finally { db.close(); }
      },
      log: { warn() {} },
    });
    guard.install(h.ctx);
    const writeIntent = h.listeners.get('fs/write-intent');
    let nextCalls = 0;
    const next = async () => { nextCalls += 1; return BASE; };
    // A real SQLite lock proves the draft state is unknown. The guard refuses
    // the first intent: no fail-open warm-up and no retry counter.
    await assert.rejects(
      () => writeIntent(TARGET, {}, next),
      (error) => {
        assert.equal(error.code, 'MP_DOC_LOOKUP_FAILED');
        assert.equal(error.path, TARGET.displayPath);
        assert.match(error.message, /无法读取未保存状态/);
        return true;
      },
    );
    assert.equal(nextCalls, 1, 'intent handlers run next() first; the guard still refuses the write');
    await assert.rejects(() => writeIntent(TARGET, {}, next), (error) => error.code === 'MP_DOC_LOOKUP_FAILED');
    assert.equal(nextCalls, 2);

    // Releasing the real lock must release the guard immediately: there is no
    // sticky failure budget left behind.
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    const recovered = await (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { return await writeIntent(TARGET, {}, next); }
        catch (error) {
          if (error.code !== 'MP_DOC_LOOKUP_FAILED') throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error('real SQLite lock did not release within 2s');
    })();
    assert.deepEqual(recovered, BASE);
    assert.equal(nextCalls > 2, true);
  } finally {
    if (child) child.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
