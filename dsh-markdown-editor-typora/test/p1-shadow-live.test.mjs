import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
  const state = await host.dispatch('documents.state', { path: file }, MODEL_TOOL, execution(path.dirname(file)));
  const session = await host.dispatch('documents.session', { path: file });
  assert.equal(session.ok, state.ok, `${scenario} ok`);
  if (state.ok) for (const key of CORE) assert.deepEqual(session.value[key], state.value[key], `${scenario} ${key}`);
  return state;
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
    assert.equal(scenarios, 35);
    host.close();
  } finally {
    host.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
