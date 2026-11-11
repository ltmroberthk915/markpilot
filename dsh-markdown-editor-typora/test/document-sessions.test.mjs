import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager, allowedActions } from '../lib/document-sessions.js';

test('P1 session manager caches read-only snapshots with TTL and a hard cap', async () => {
  let clock = 1000;
  let loads = 0;
  const manager = createSessionManager({ ttlMs: 100, now: () => clock, limit: 2 });
  const load = async () => ({ state: 'clean', n: ++loads });
  assert.deepEqual(await manager.resolve('a', load), { state: 'clean', n: 1 });
  assert.deepEqual(await manager.resolve('a', load), { state: 'clean', n: 1 });
  assert.equal(loads, 1);
  clock = 1200;
  assert.deepEqual(await manager.resolve('a', load), { state: 'clean', n: 2 });
  assert.equal(loads, 2);
  await manager.resolve('b', load);
  await manager.resolve('c', load);
  assert.equal(manager.size, 2);
  manager.clear();
  assert.equal(manager.size, 0);
});

test('P1 allowedActions derives editor actions without granting missing a conflict entry', () => {
  assert.deepEqual(allowedActions({ state: 'missing' }), ['retry', 'saveAs', 'locate']);
  assert.equal(allowedActions({ state: 'conflict' }).includes('openConflict'), true);
  assert.equal(allowedActions({ state: 'clean' }).includes('save'), false);
  assert.deepEqual(allowedActions({}), []);
});

test('P1 session module is included in the published package files list', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  assert.equal(files.some((entry) => entry === 'lib' || entry === 'lib/document-sessions.js'), true);
});

test('P1 allowedActions includes recovery and review capabilities from the snapshot', () => {
  const recovery = allowedActions({ state: 'clean', recovery: [{ recoveryPath: 'x' }] });
  assert.equal(recovery.includes('recover'), true);
  assert.equal(recovery.includes('discardRecovery'), true);
  const review = allowedActions({ state: 'dirty', groups: [{ groupId: 'g' }] });
  assert.equal(review.includes('reviewUndo'), true);
  assert.equal(review.includes('reviewKeep'), true);
  assert.equal(review.includes('reviewDiff'), true);
  const orphan = allowedActions({ state: 'orphan' });
  assert.equal(orphan.includes('recover'), false);
});
