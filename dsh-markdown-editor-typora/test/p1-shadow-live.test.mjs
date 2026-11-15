import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHost, MODEL_TOOL } from '../lib/index.js';

const require = createRequire(import.meta.url);
const { LiveDocuments } = require('../host/live-documents.js');
const CORE = ['state', 'source', 'dirty', 'conflict', 'version', 'revisionId', 'orphanDraft', 'external', 'unsavedElsewhere'];

function execution(cwd) { return { agent: { session: { header: { cwd } } } }; }
function sha(text) { return createHash('sha256').update(String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')).digest('hex'); }

function dynamicProvider() {
  let serial = 0;
  return {
    async resolve(value) { return { targetKey: value, displayPath: value }; },
    async stat(value) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      try { const info = await fs.stat(p); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `v${info.mtimeMs}-${info.size}-${serial}` }; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async readText(value) { return fs.readFile(typeof value === 'string' ? value : value?.targetKey, 'utf8'); },
    async writeText(value, text) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      const temp = p + '.tmp-' + process.pid + '-' + (++serial);
      await fs.writeFile(temp, text, 'utf8');
      await fs.rename(temp, p);
      serial += 1;
      return { version: `v${Date.now()}-${Buffer.byteLength(text)}-${serial}` };
    },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
}

async function compareShadow(host, file, scenario) {
  const direct = await host.dispatch('documents.reconcile', { path: file }, MODEL_TOOL, execution(path.dirname(file)));
  const state = await host.dispatch('documents.state', { path: file }, MODEL_TOOL, execution(path.dirname(file)));
  const session = await host.dispatch('documents.session', { path: file });
  assert.equal(session.ok, direct.ok, `${scenario} ok`);
  if (direct.ok) for (const key of CORE) assert.deepEqual(session.value[key], direct.value[key], `${scenario} session/${key}`);
  assert.equal(state.ok, direct.ok, `${scenario} state ok`);
  if (direct.ok) for (const key of CORE) assert.deepEqual(state.value[key], direct.value[key], `${scenario} state/${key}`);
  return direct;
}

function remoteJoin(liveDir, file, base) {
  const modulePath = require.resolve('../host/live-documents.js');
  const ready = path.join(path.dirname(file), `.remote-ready-${process.pid}-${Date.now()}`);
  const failure = ready + '.err';
  const script = `const fs=require('node:fs');const {LiveDocuments}=require(${JSON.stringify(modulePath)});(async()=>{const l=new LiveDocuments({directory:${JSON.stringify(liveDir)}});await l.join(${JSON.stringify(file)},${JSON.stringify(base)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);})().catch(e=>{try{fs.writeFileSync(${JSON.stringify(failure)},String(e&&e.stack||e));}catch{}process.exit(1)});`;
  // stdio:ignore works under sandboxes that refuse piped child stdio; readiness
  // is proved by the ready file and a failed child leaves its error behind.
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
  return (async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (fsSync.existsSync(ready)) return child;
      if (fsSync.existsSync(failure)) throw new Error('remote join failed: ' + fsSync.readFileSync(failure, 'utf8'));
      if (child.exitCode !== null) throw new Error('remote join exited ' + child.exitCode);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill();
    throw new Error('remote join timeout');
  })();
}

test('P1-G1 live room states: dirty, conflict, orphan, mirror match state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-p1-live-'));
  const live = new LiveDocuments({ directory: path.join(root, 'live') });
  const host = createHost({ fs: dynamicProvider(), liveDocuments: live, log: { warn() {} } });
  try {
    let scenarios = 0;
    for (let index = 0; index < 5; index += 1) {
      const base = `live ${index}\n`;
      const file = path.join(root, `live-${index}.md`);
      await fs.writeFile(file, base, 'utf8');
      const joined = await live.join(file, base);
      await live.exchange(joined.client, { epoch: joined.epoch, version: joined.version, seq: 1, changes: [{ from: 5, to: 5, insert: 'X' }] });
      const dirty = await compareShadow(host, file, `dirty-${index}`);
      assert.equal(dirty.value.state, 'dirty');
      scenarios += 1;

      await fs.writeFile(file, `external ${index}\n`, 'utf8');
      const conflict = await compareShadow(host, file, `conflict-${index}`);
      assert.equal(conflict.value.conflict, true);
      scenarios += 1;

      const orphanFile = path.join(root, `orphan-${index}.md`);
      await fs.writeFile(orphanFile, base, 'utf8');
      const orphanJoin = await live.join(orphanFile, base);
      await live.exchange(orphanJoin.client, { epoch: orphanJoin.epoch, version: orphanJoin.version, seq: 1, changes: [{ from: 5, to: 5, insert: 'Y' }] });
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(root, 'live', 'rooms.sqlite'));
      try { db.prepare('DELETE FROM clients WHERE epoch=?').run(orphanJoin.epoch); } finally { db.close(); }
      const orphan = await compareShadow(host, orphanFile, `orphan-${index}`);
      assert.equal(orphan.value.orphanDraft, true);
      scenarios += 1;

      const mirrorFile = path.join(root, `mirror-${index}.md`);
      await fs.writeFile(mirrorFile, base, 'utf8');
      const version = (await fs.stat(mirrorFile)).mtimeMs;
      await live.putDraft(mirrorFile, { text: 'mirror draft\n', baseVersion: String(version), baseSha256: sha(base), docToken: `dshdoc-test-${index}` });
      const mirror = await compareShadow(host, mirrorFile, `mirror-${index}`);
      assert.equal(mirror.value.source, 'mirror');
      scenarios += 1;

      const recoveryFile = path.join(root, `recovery-${index}.md`);
      await fs.writeFile(recoveryFile, base, 'utf8');
      const recoveryJoin = await live.join(recoveryFile, base);
      await live.append(recoveryFile, { epoch: recoveryJoin.epoch, baseVersion: 0, baseText: base, actor: 'agent', changes: [{ from: 5, to: 5, insert: 'R' }] });
      const recoveryRoom = await live.readRoom(recoveryFile);
      await live.append(recoveryFile, { epoch: recoveryRoom.epoch, baseVersion: recoveryRoom.version, baseText: recoveryRoom.text, actor: 'agent', changes: [{ from: recoveryRoom.text.length, to: recoveryRoom.text.length, insert: 'S' }] });
      const recovery = await compareShadow(host, recoveryFile, `recovery-${index}`);
      assert.equal(recovery.value.recovery.length >= 1, true);
      scenarios += 1;

      const reviewFile = path.join(root, `review-${index}.md`);
      await fs.writeFile(reviewFile, base, 'utf8');
      await live.recordAgentGroup(reviewFile, {
        groupId: randomUUID(), actor: 'agent', kind: 'edit',
        changes: [{ from: 5, to: 5, insert: 'Q' }], baseRevision: 'base', resultRevision: 'result',
      });
      const review = await compareShadow(host, reviewFile, `review-${index}`);
      assert.equal(review.value.groups.length >= 1, true);
      scenarios += 1;

      const externalFile = path.join(root, `external-${index}.md`);
      await fs.writeFile(externalFile, base, 'utf8');
      await live.join(externalFile, base);
      await fs.writeFile(externalFile, `changed ${index}\n`, 'utf8');
      const external = await compareShadow(host, externalFile, `external-${index}`);
      assert.equal(external.value.state, 'external');
      scenarios += 1;
    }
    const ownedFile = path.join(root, 'owned-remote.md');
    await fs.writeFile(ownedFile, 'remote base\n', 'utf8');
    const beforeOwned = await compareShadow(host, ownedFile, 'owned-before');
    assert.equal(beforeOwned.value.state, 'disk');
    const remote = await remoteJoin(path.join(root, 'live'), ownedFile, 'remote base\n');
    try {
      const owned = await compareShadow(host, ownedFile, 'owned-remote');
      assert.equal(owned.value.state, 'clean');
      assert.equal(owned.value.source, 'buffer');
      assert.equal(owned.value.dirty, false);
      assert.equal(owned.value.crossMember, true);
      assert.equal(owned.value.replaySafe, true);
      assert.equal(owned.value.localMembers, 0);
      assert.equal(owned.value.bufferOwnedElsewhere, false);
      scenarios += 1;

      // The same room seen by a legacy member (no replay caps) must fall back to
      // disk authority and report the buffer as owned elsewhere. Use a fresh
      // host generation so the test observes the legacy room instead of the
      // previous generation's 30-minute session cache.
      const { DatabaseSync } = await import('node:sqlite');
      const capsDb = new DatabaseSync(path.join(root, 'live', 'rooms.sqlite'));
      try { capsDb.prepare('DELETE FROM client_caps').run(); } finally { capsDb.close(); }
      const legacyHost = createHost({ fs: dynamicProvider(), liveDocuments: live, log: { warn() {} } });
      try {
        const legacy = await compareShadow(legacyHost, ownedFile, 'owned-remote-legacy');
        assert.equal(legacy.value.state, 'owned-elsewhere');
        assert.equal(legacy.value.source, 'disk');
        assert.equal(legacy.value.bufferOwnedElsewhere, true);
        assert.equal(legacy.value.replaySafe, false);
        assert.equal(legacy.value.unsavedElsewhere, false);
      } finally { legacyHost.close(); }
      scenarios += 1;
    } finally {
      remote.kill();
    }

    assert.equal(scenarios, 37);
    host.close();
  } finally {
    host.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
