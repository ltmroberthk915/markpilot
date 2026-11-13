import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  const code = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(dbFile)});
db.exec('PRAGMA locking_mode=EXCLUSIVE');
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('lock child timeout')); }, 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('locked')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => { if (code !== null) { clearTimeout(timer); reject(new Error('lock child exited ' + code)); } });
  });
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
    const first = await writeIntent(TARGET, {}, async () => BASE);
    assert.deepEqual(first, BASE);
    const second = await writeIntent(TARGET, {}, async () => BASE);
    assert.deepEqual(second, BASE);
    await assert.rejects(
      () => writeIntent(TARGET, {}, async () => BASE),
      (error) => error.code === 'MP_DOC_LOOKUP_FAILED',
    );
  } finally {
    if (child) child.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
