// HMR 代际收尾 kernel 配套测试（纯本地，无 spawn）：retireLiveStorage 语义 +
// safe-file beforeExit 具名 handler 生命周期。运行：node test/live-retire.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, '../../MarkPilot-CM6/shell');
const { LiveDocuments, retireLiveStorage } = require(path.join(shellDir, 'live-documents.js'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const worlds = [];
async function makeWorld(name, initial = 'retire\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-retire-' + name + '-'));
  const file = path.join(root, 'doc.md');
  const dir = path.join(root, 'live');
  await fs.writeFile(file, initial, 'utf8');
  worlds.push(root);
  return { root, file, dir, base: initial };
}
async function writeText(file, text) {
  const tmp = path.join(path.dirname(file), '.r-' + crypto.randomUUID());
  await fs.writeFile(tmp, Buffer.from(text, 'utf8'));
  await fs.rename(tmp, file);
}

test('R1 retireLiveStorage：成员在场拒绝；全离场 close；幂等；数据库文件与数据原样保留', async () => {
  const w = await makeWorld('basic');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  assert.throws(() => retireLiveStorage(), error => error.code === 'MP_LIVE_ACTIVE');
  A.leave(a.client);
  // 未加入的空实例不占强引用：不得阻塞退休（hosts 只登记仍有成员的 host）
  const idle = new LiveDocuments({ directory: w.dir });
  const result = retireLiveStorage();
  assert.equal(result.ok, true);
  assert.equal(result.closed.length, 1, '恰好关闭本代一个连接');
  const again = retireLiveStorage();
  assert.deepEqual(again, { ok: true, closed: [] }, '重复调用幂等');
  assert.equal(fsSync.existsSync(path.join(w.dir, 'rooms.sqlite')), true, '不删除数据库文件');
  const { DatabaseSync } = await import('node:sqlite');
  const probe = new DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
  probe.exec('PRAGMA busy_timeout=2000');
  assert.equal(probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('rooms','clients','changes','recovery','meta')").get().n, 5, '表结构原样');
  probe.close();
});

test('R2 在途租约操作期间拒绝；drain 后允许', async () => {
  const w = await makeWorld('inflight');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 6, to: 6, insert: 'X' }] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = A.save(a.client, { epoch: a.epoch, version: 1, text: 'retireX\n' }, async () => {
    await gate;
    await writeText(w.file, 'retireX\n');
    return { ok: true, version: 'prov' };
  });
  await pause(80); // 写者已进入租约作用域
  assert.throws(() => retireLiveStorage(), error => error.code === 'MP_LIVE_ACTIVE', '在途操作期间不得关闭');
  release();
  const receipt = await saving;
  assert.equal(receipt.ok, true);
  A.leave(a.client);
  assert.equal(retireLiveStorage().ok, true);
});

test('R3 退休后同目录可重开：新一代实例正常 join/编辑/保存', async () => {
  const w = await makeWorld('reopen', 're-open\n');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.leave(a.client);
  retireLiveStorage();
  const B = new LiveDocuments({ directory: w.dir });
  const b = await B.join(w.file, w.base);
  B.exchange(b.client, { epoch: b.epoch, version: 0, seq: 1, changes: [{ from: 7, to: 7, insert: '!' }] });
  const text = 're-open!\n';
  const receipt = await B.save(b.client, { epoch: b.epoch, version: 1, text }, async () => {
    await writeText(w.file, text);
    return { ok: true, version: 'prov2' };
  });
  assert.equal(receipt.ok, true);
  assert.equal(await fs.readFile(w.file, 'utf8'), text);
  B.leave(b.client);
  assert.equal(retireLiveStorage().ok, true);
});

test('R4 safe-file beforeExit 具名 handler：加载 +1、显式 shutdown 成功后 -1、重复 shutdown 不再加', async () => {
  const safePath = path.join(shellDir, 'safe-file.js');
  const before = process.listenerCount('beforeExit');
  delete require.cache[require.resolve(safePath)];
  const safe = require(safePath); // 全新模块实例：登记自己的具名 handler（旧实例的不受影响）
  assert.equal(process.listenerCount('beforeExit'), before + 1, '加载恰好登记一个 handler');
  await safe.shutdownFileWorker();
  assert.equal(process.listenerCount('beforeExit'), before, '显式 shutdown 成功后移除同一 handler');
  await safe.shutdownFileWorker();
  assert.equal(process.listenerCount('beforeExit'), before, '重复 shutdown 幂等、不新增监听');
});

test('R99 收尾：retire 关库后清理临时目录', async () => {
  try { retireLiveStorage(); } catch { /* 尚有成员时留给 OS 临时清理 */ }
  for (const root of worlds.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      .catch(error => { if (!['EBUSY', 'EPERM'].includes(error.code)) throw error; });
  }
});
