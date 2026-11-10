// 跨进程 transport 单测：真实子进程（EXE/DSH 双宿主形态）+ 真实磁盘字节 + 故障路径。
// 运行：node --test test/live-transport.test.mjs
// MP_LIVE_IMPL 指向被测 live-documents.js（默认取仓内 MarkPilot-CM6/shell 副本）。
// B 侧用同一 worker 会话持续保有 LiveDocuments 实例（client 能力随实例存活，
// 跨进程/跨实例盗用令牌由 T18 负控证明被拒）。子进程通信用文件协议（job/result/
// held 落在控制目录），不依赖 stdio 管道。覆盖：跨进程收敛、save 回执保留
// provider.version、CAS 拒旧写、external 写入期间新输入不误报、refresh 持锁读盘
// （不重放旧盘）、慢写者不并写、崩溃租约回收、同进程多句柄串行、重入、
// leave/close 清理、主机戳、9MB 成本与自适应 compact。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const implPath = process.env.MP_LIVE_IMPL
  ? path.resolve(process.env.MP_LIVE_IMPL)
  : path.resolve(here, '../../MarkPilot-CM6/shell/live-documents.js');
const workerPath = path.join(here, 'fixtures', 'live-worker.cjs');
const { LiveDocuments, withFileCommit } = require(implPath);
const { DocumentStore, createSession } = require(path.join(path.dirname(implPath), 'document-store.js'));

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const byteHashOf = async file => sha256(await fs.readFile(file));

async function openRoom(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rooms.sqlite'));
  db.exec('PRAGMA busy_timeout=2000');
  return {
    rooms: () => db.prepare('SELECT file,epoch,version,saved,disk,length,floor FROM rooms').all(),
    clients: epoch => db.prepare('SELECT id,pid,seq,ack FROM clients WHERE epoch=?').all(epoch).length,
    changes: epoch => db.prepare('SELECT version,client FROM changes WHERE epoch=? ORDER BY version').all(epoch),
    writers: () => db.prepare('SELECT file,owner,pid FROM writers').all(),
    recovery: () => db.prepare('SELECT source,recoveryPath,epoch,version,saved,at,bytes,sha256 FROM recovery').all(),
    meta: () => db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value ?? null,
    close: () => db.close(),
  };
}
function applyChanges(text, changes) {
  let end = 0; const parts = [];
  for (const c of changes) { parts.push(text.slice(end, c.from), c.insert); end = c.to; }
  parts.push(text.slice(end));
  return parts.join('');
}
async function writeText(file, text) {
  const bytes = Buffer.from(text, 'utf8');
  const tmp = path.join(path.dirname(file), '.t-' + crypto.randomUUID());
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, file);
  return bytes;
}
// B 侧会话：同一子进程、同一 LiveDocuments 实例跨调用存活。文件协议：父写
// job-<n>.json，子回 result-<n>.json，写者持锁时先写 held-<n> 标记文件。
const sessions = new Set(); // 失败测试遗留的会话由末尾 T99 清扫，避免孤儿子进程拖住进程
function workerSession() {
  const control = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mp-live-ctl-'));
  const child = spawn(process.execPath, [workerPath, control], { stdio: 'ignore' });
  let seq = 0, exited = false;
  const self = {};
  const finish = () => sessions.delete(self);
  child.on('close', () => { exited = true; finish(); });
  child.on('error', () => { exited = true; finish(); });
  const pollFile = (file, timeoutMs) => new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    const tick = () => {
      if (fsSync.existsSync(file)) return resolve();
      if (exited) return reject(Error('worker exited'));
      if (Date.now() > until) return reject(Error('poll timeout: ' + path.basename(file)));
      setTimeout(tick, 12);
    };
    tick();
  });
  const call = (job, timeoutMs = 20000) => {
    const n = ++seq;
    const held = job.held || job.op === 'holdLease' || job.dsHoldGate
      ? pollFile(path.join(control, 'held-' + n + '.json'), timeoutMs).catch(() => {})
      : Promise.resolve();
    const result = (async () => {
      // 原子落 job 文件：直写会被子进程轮询读到半截 JSON（Windows 共享读）
      const tmp = path.join(control, 'job-' + n + '.json.tmp');
      fsSync.writeFileSync(tmp, JSON.stringify(job));
      fsSync.renameSync(tmp, path.join(control, 'job-' + n + '.json'));
      await pollFile(path.join(control, 'result-' + n + '.json'), timeoutMs);
      return JSON.parse(fsSync.readFileSync(path.join(control, 'result-' + n + '.json'), 'utf8'));
    })();
    result.catch(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } });
    return { result, held };
  };
  const close = async () => {
    sessions.delete(self);
    try { fsSync.writeFileSync(path.join(control, 'job-' + (++seq) + '.json'), JSON.stringify({op: 'exit'})); } catch { /* 已断 */ }
    const until = Date.now() + 2000;
    while (!exited && Date.now() < until) await pause(20);
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }
  };
  const api = { child, call, close, get exited() { return exited; } };
  sessions.add(api);
  return api;
}
// 一次性任务（无需会话：外部写、探针、按进程生命周期设计的 join 等）。
async function oneShot(job, { timeoutMs = 20000 } = {}) {
  const session = workerSession();
  const result = await session.call(job, timeoutMs).result;
  await session.close();
  return result;
}
const withTimeout = (promise, ms, label) => Promise.race([promise, pause(ms).then(() => { throw Error('timeout: ' + label); })]);
async function waitWriters(dir, count, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (fsSync.existsSync(path.join(dir, 'rooms.sqlite'))) {
      let room = null;
      try { room = await openRoom(dir); } catch { /* 子进程建库中，稍后重试 */ }
      if (room) {
        try { if (room.writers().length === count) return; } finally { room.close(); }
      }
    }
    if (Date.now() > until) throw Error('writers table never reached ' + count);
    await pause(15);
  }
}
async function makeWorld(name, initial = 'line\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-live-' + name + '-'));
  const file = path.join(root, 'doc.md');
  const dir = path.join(root, 'live');
  if (initial !== null) await fs.writeFile(file, initial, 'utf8');
  return { root, file, dir, base: initial };
}
// 临时目录里的 DB 句柄随进程存续，world 不回收删除（由系统临时目录清理）。

test('T01 真实跨进程：A(本进程)与 B(子进程会话)同文件实时收敛，未保存不落盘', async () => {
  const w = await makeWorld('conv', 'line-one\nline-two\n');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const B = workerSession();
  const joinB = await B.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result;
  assert.equal(joinB.ok, true, joinB.message);
  const b = joinB.value;
  assert.equal(b.epoch, a.epoch, '同一房间');
  assert.equal(b.version, 0);
  const change = [{ from: 8, to: 8, insert: ' [B]' }];
  const exB = await B.call({ op: 'exchange', dir: w.dir, client: b.client, epoch: a.epoch, version: 0, seq: 1, changes: change }).result;
  assert.equal(exB.ok, true, exB.message);
  assert.equal(exB.value.version, 1);
  const ax = A.exchange(a.client, { epoch: a.epoch, version: 0 });
  assert.equal(ax.version, 1);
  assert.equal(ax.updates.length, 1);
  assert.equal(ax.updates[0].client, b.client);
  assert.equal(ax.updates[0].changes.length, 1);
  const text = applyChanges(w.base, ax.updates[0].changes);
  assert.equal(text, applyChanges(w.base, change));
  assert.equal(text, 'line-one [B]\nline-two\n');
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base, '未保存不得写盘');
  await B.call({ op: 'leave', client: b.client }).result;
  await B.close();
  A.leave(a.client);
});

test('T02 save 回执保留 provider.version；diskHash 与真实字节一致', async () => {
  const w = await makeWorld('receipt');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const v1 = A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'GOOD' }] });
  const text = 'GOOD\n';
  assert.equal(applyChanges(w.base, [{ from: 0, to: 4, insert: 'GOOD' }]), text);
  let diskHashArg;
  const receipt = await A.save(a.client, { epoch: a.epoch, version: v1.version, text }, async ({ diskHash }) => {
    diskHashArg = diskHash;
    await writeText(w.file, text);
    return { ok: true, version: 'prov-9', label: 'keep' };
  });
  assert.equal(receipt.version, 'prov-9', 'provider 的 version 字段不得被 live 元数据覆盖');
  assert.equal(receipt.label, 'keep');
  assert.equal(receipt.liveVersion, 1);
  assert.equal(receipt.savedVersion, 1);
  assert.equal(receipt.epoch, a.epoch);
  const bytes = await fs.readFile(w.file);
  assert.equal(receipt.diskHash, sha256(bytes), '回执 diskHash 必须是盘上真实字节哈希');
  assert.equal(bytes.toString('utf8'), text);
  assert.equal(diskHashArg, a.diskHash, 'writer 收到房间已知的磁盘哈希');
  const head = A.exchange(a.client, { epoch: a.epoch, version: 1 });
  assert.equal(head.savedVersion, 1);
  A.leave(a.client);
});

test('T03 CAS：滞后版本的保存被拒，磁盘字节不被旧写破坏', async () => {
  const w = await makeWorld('cas');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const B = workerSession();
  const b = (await B.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result).value;
  const ex = await B.call({ op: 'exchange', dir: w.dir, client: b.client, epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 5, to: 5, insert: 'B' }] }).result;
  assert.equal(ex.ok, true, ex.message);
  let called = false;
  await assert.rejects(A.save(a.client, { epoch: a.epoch, version: 0, text: w.base }, async () => { called = true; }),
    error => error.code === 'MP_LIVE_STALE');
  assert.equal(called, false, '滞后保存不得调用写者');
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base, '旧写不得破坏原件');
  await B.call({ op: 'leave', client: b.client }).result;
  await B.close();
  A.leave(a.client);
});

test('T04 external：有未保存草稿时拒绝，写者不运行，原文件不动', async () => {
  const w = await makeWorld('ext-dirty');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'D' }] });
  let called = false;
  await assert.rejects(A.external(w.file, async () => { called = true; await writeText(w.file, 'EXT\n'); }),
    error => error.code === 'MP_FILE_CONFLICT');
  assert.equal(called, false);
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base);
  A.leave(a.client);
});

test('T04b sealed keep-mine clears room_resolved so later saves are not blocked', async () => {
  const w = await makeWorld('sealed-marker');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: w.base.length, insert: 'MINE' }] });
  await fs.writeFile(w.file, 'THEIRS\n');
  const diskHash = await byteHashOf(w.file);
  await A.markResolved(w.file, { epoch: a.epoch, baseVersion: 1, baseText: 'MINE', expectedDiskHash: diskHash });
  const db = new (await import('node:sqlite')).DatabaseSync(path.join(w.dir, 'rooms.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_resolved WHERE epoch=?').get(a.epoch).n, 1);
  try {
    const receipt = await A.external(w.file, async () => {
      await fs.writeFile(w.file, 'MINE');
      return { version: 'prov-sealed' };
    }, { client: a.client, keepMineText: 'MINE' });
    assert.equal(receipt.clean, true);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'MINE');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_resolved WHERE epoch=?').get(a.epoch).n, 0,
      'sealed keep-mine must not leave a stale resolved marker blocking future saves');
  } finally { db.close(); A.leave(a.client); }
});

test('T05 external 写入期间有新输入：落盘照实上报不误报，草稿保护（a 分叉 / b 恰同文）', async () => {
  // (a) 外部内容与草稿分叉：写成功、草稿保留、refresh 报告盘变
  const wa = await makeWorld('ext-mid-a');
  const Aa = new LiveDocuments({ directory: wa.dir });
  const aa = await Aa.join(wa.file, wa.base);
  const Ba = workerSession();
  const ba = (await Ba.call({ op: 'join', impl: implPath, dir: wa.dir, file: wa.file, text: wa.base }).result).value;
  const gateA = path.join(wa.root, 'gate-a');
  await fs.writeFile(gateA, '1');
  const extJob = oneShot({ op: 'external', impl: implPath, dir: wa.dir, file: wa.file, text: 'EXT-NEW\n', gate: gateA }, { timeoutMs: 30000 });
  await waitWriters(wa.dir, 1);
  const exMid = await Ba.call({ op: 'exchange', dir: wa.dir, client: ba.client, epoch: aa.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: '[B]' }] }).result;
  assert.equal(exMid.ok, true, 'B 在 external 写入期间的新输入必须成功');
  await fs.rm(gateA);
  const ext = await extJob;
  assert.equal(ext.ok, true, '写入已完成，不得因期间新输入误报失败');
  assert.equal(await fs.readFile(wa.file, 'utf8'), 'EXT-NEW\n', '外部写真实落盘');
  const ra = await Aa.refresh(aa.client, aa.epoch);
  assert.equal(ra.changed, true);
  assert.equal(ra.unsavedDraft, true, '有未保存草稿：只报告，不合并');
  const ax = Aa.exchange(aa.client, { epoch: aa.epoch, version: 0 });
  assert.equal(ax.updates.length, 1, '外部内容不得混入房间日志');
  assert.equal(ax.updates[0].client, ba.client);
  assert.equal(applyChanges(wa.base, ax.updates[0].changes), '[B]line\n', '草稿完整保留');
  await Ba.call({ op: 'leave', client: ba.client }).result;
  await Ba.close();
  Aa.leave(aa.client);

  // (b) 外部写恰好写出当前草稿：按已保存记账，不冲突
  const wb = await makeWorld('ext-mid-b');
  const Ab = new LiveDocuments({ directory: wb.dir });
  const ab = await Ab.join(wb.file, wb.base);
  const Bb = workerSession();
  const bb = (await Bb.call({ op: 'join', impl: implPath, dir: wb.dir, file: wb.file, text: wb.base }).result).value;
  const gateB = path.join(wb.root, 'gate-b');
  await fs.writeFile(gateB, '1');
  const extJobB = oneShot({ op: 'external', impl: implPath, dir: wb.dir, file: wb.file, text: '[B]line\n', gate: gateB }, { timeoutMs: 30000 });
  await waitWriters(wb.dir, 1);
  const exMidB = await Bb.call({ op: 'exchange', dir: wb.dir, client: bb.client, epoch: ab.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: '[B]' }] }).result;
  assert.equal(exMidB.ok, true);
  await fs.rm(gateB);
  const extB = await extJobB;
  assert.equal(extB.ok, true, '外部写出的正是当前草稿：不得报冲突');
  const rb = await Ab.refresh(ab.client, ab.epoch);
  assert.equal(rb.changed, false, '盘上即草稿，房间视为已保存');
  assert.equal(rb.savedVersion, 1);
  assert.equal(rb.version, 1);
  assert.equal(await fs.readFile(wb.file, 'utf8'), '[B]line\n');
  await Bb.call({ op: 'leave', client: bb.client }).result;
  await Bb.close();
  Ab.leave(ab.client);
});

test('T06 refresh：干净房 adopt 非协同外写，exchange 拉到 disk 变更且收敛；再刷新无变化', async () => {
  const w = await makeWorld('adopt');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  await oneShot({ op: 'writeRaw', impl: implPath, dir: w.dir, file: w.file, text: 'NEW-DISK\n' });
  const r1 = await A.refresh(a.client, a.epoch);
  assert.equal(r1.changed, true);
  assert.equal(r1.version, 1);
  const ax = A.exchange(a.client, { epoch: a.epoch, version: 0 });
  assert.equal(ax.updates.length, 1);
  assert.equal(ax.updates[0].client, 'disk');
  assert.equal(applyChanges(w.base, ax.updates[0].changes), 'NEW-DISK\n');
  assert.equal(await fs.readFile(w.file, 'utf8'), 'NEW-DISK\n', 'refresh 不得写盘');
  const r2 = await A.refresh(a.client, a.epoch);
  assert.equal(r2.changed, false);
  A.leave(a.client);
});

test('T07 refresh 与并发 save：他人持锁时必须悬停，不得读盘记账（防旧盘重放）', async () => {
  const w = await makeWorld('refresh-lease');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const B = workerSession();
  const b = (await B.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result).value;
  const bx = await B.call({ op: 'exchange', dir: w.dir, client: b.client, epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 5, insert: 'SAVED-B\n' }] }).result;
  assert.equal(bx.ok, true, bx.message);
  assert.equal(bx.value.version, 1);
  A.exchange(a.client, { epoch: a.epoch, version: 0 });
  const gate = path.join(w.root, 'gate');
  await fs.writeFile(gate, '1');
  const saveCall = B.call({ op: 'save', dir: w.dir, file: w.file, client: b.client, epoch: a.epoch, version: 1, text: 'SAVED-B\n', providerVersion: 'prov-B', held: true, gate }, 30000);
  await withTimeout(saveCall.held, 5000, 'B 未持锁');
  let settled = false, aResult, aError;
  const refreshPromise = A.refresh(a.client, a.epoch).then(r => { aResult = r; settled = true; }, e => { aError = e; settled = true; });
  await pause(300);
  assert.equal(settled, false, '写租约被持有时 refresh 不得读盘/记账（否则会跨保存重放旧盘）');
  await writeText(w.file, 'INTERLOPER\n'); // 持锁期间的非协同写入，保存提交会覆盖它
  await fs.rm(gate);
  const saved = await saveCall.result;
  assert.equal(saved.ok, true, saved.message);
  await refreshPromise;
  assert.equal(aError, undefined);
  assert.deepEqual({ changed: aResult.changed, version: aResult.version }, { changed: false, version: 1 });
  assert.equal(await fs.readFile(w.file, 'utf8'), 'SAVED-B\n');
  const room = await openRoom(w.dir);
  const log = room.changes(a.epoch);
  assert.equal(log.length, 1, '不得产生额外的 disk 重放变更');
  assert.equal(log[0].client, b.client);
  assert.equal(room.rooms()[0].disk, await byteHashOf(w.file), '房间 disk 与真实字节一致');
  assert.equal(room.rooms()[0].saved, 1);
  room.close();
  await B.call({ op: 'leave', client: b.client }).result;
  await B.close();
  A.leave(a.client);
});

test('T08 慢写者持锁超阈值：另一方超时拒写、绝不并写，释放后重试成功', async () => {
  const w = await makeWorld('slow');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const B = workerSession();
  const b = (await B.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result).value;
  const bx = await B.call({ op: 'exchange', dir: w.dir, client: b.client, epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 5, insert: 'SLOW\n' }] }).result;
  assert.equal(bx.ok, true);
  A.exchange(a.client, { epoch: a.epoch, version: 0 });
  // join 也要拿文件写租约：第二个句柄必须在慢保存开始前加入
  const A2 = new LiveDocuments({ directory: w.dir, busyTimeoutMs: 700 });
  const a2 = await A2.join(w.file, w.base); // join 校验磁盘正文；脏房间返回房间文本
  assert.equal(a2.version, 1);
  assert.equal(a2.text, 'SLOW\n');
  const gate = path.join(w.root, 'gate');
  await fs.writeFile(gate, '1');
  const slowCall = B.call({ op: 'save', dir: w.dir, file: w.file, client: b.client, epoch: a.epoch, version: bx.value.version, text: 'SLOW\n', held: true, gate }, 30000);
  await withTimeout(slowCall.held, 5000, '慢写者未持锁');
  let called = false;
  await assert.rejects(A2.save(a2.client, { epoch: a2.epoch, version: 1, text: 'SLOW\n' }, async () => { called = true; }),
    error => error.code === 'MP_SAVE_BUSY');
  assert.equal(called, false, '活着的持锁者面前绝不并写');
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base, '拒绝期间磁盘保持原状');
  const room = await openRoom(w.dir);
  assert.equal(room.writers().length, 1, '只有慢写者一条租约');
  room.close();
  await fs.rm(gate);
  assert.equal((await slowCall.result).ok, true);
  const retry = await A2.save(a2.client, { epoch: a2.epoch, version: 1, text: 'SLOW\n' }, async () => {
    await writeText(w.file, 'SLOW\n');
    return { ok: true, version: 'prov-A2' };
  });
  assert.equal(retry.ok, true, '释放后重试必须成功');
  assert.equal(await fs.readFile(w.file, 'utf8'), 'SLOW\n');
  await B.call({ op: 'leave', client: b.client }).result;
  await B.close();
  A.leave(a.client); A2.leave(a2.client);
});

test('T09 崩溃写者：杀死持锁进程后租约即时回收，保存立刻成功', async () => {
  const w = await makeWorld('crash');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const gate = path.join(w.root, 'gate');
  await fs.writeFile(gate, '1');
  const C = workerSession();
  const holdCall = C.call({ op: 'holdLease', impl: implPath, dir: w.dir, file: w.file, gate }, 30000);
  await withTimeout(holdCall.held, 5000, '崩溃者未持锁');
  C.child.kill('SIGKILL');
  holdCall.result.catch(() => {});
  await pause(150);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'AFTER' }] });
  const t0 = Date.now();
  const receipt = await A.save(a.client, { epoch: a.epoch, version: 1, text: 'AFTER\n' }, async () => {
    await writeText(w.file, 'AFTER\n');
    return { ok: true, version: 'prov-after' };
  });
  const elapsed = Date.now() - t0;
  assert.equal(receipt.ok, true);
  assert.ok(elapsed < 5000, '死进程租约应即时回收，实测 ' + elapsed + 'ms');
  assert.equal(await fs.readFile(w.file, 'utf8'), 'AFTER\n');
  await fs.rm(gate);
  A.leave(a.client);
});

test('T10 同进程多句柄：并发保存写区间串行，字节终态正确', async () => {
  const w = await makeWorld('serial', 'base-ten\n');
  const A1 = new LiveDocuments({ directory: w.dir });
  const A2 = new LiveDocuments({ directory: w.dir });
  const a1 = await A1.join(w.file, w.base);
  const a2 = await A2.join(w.file, w.base);
  A1.exchange(a1.client, { epoch: a1.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 9, insert: 'T1\n' }] });
  A2.exchange(a2.client, { epoch: a2.epoch, version: 0 });
  const text = 'T1\n';
  const track = [];
  const writer = tag => async () => {
    const start = performance.now();
    await pause(120 + Math.random() * 80);
    await writeText(w.file, text);
    track.push({ tag, start, end: performance.now() });
    return { ok: true, version: 'prov-' + tag };
  };
  const [r1, r2] = await Promise.all([
    A1.save(a1.client, { epoch: a1.epoch, version: 1, text }, writer('1')),
    A2.save(a2.client, { epoch: a2.epoch, version: 1, text }, writer('2')),
  ]);
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.equal(r1.version, 'prov-1'); assert.equal(r2.version, 'prov-2');
  assert.equal(track.length, 2);
  const [x, y] = track;
  assert.ok(Math.max(x.start, y.start) >= Math.min(x.end, y.end) - 5, '两个写者的执行区间不得重叠');
  assert.equal(await fs.readFile(w.file, 'utf8'), text);
  A1.leave(a1.client); A2.leave(a2.client);
});

test('T11 withFileCommit 重入：同文件嵌套不死锁', async () => {
  const w = await makeWorld('reenter');
  const value = await withTimeout(withFileCommit(w.file, () => withFileCommit(w.file, async () => 42, w.dir), w.dir), 4000, '重入死锁');
  assert.equal(value, 42);
});

test('T12 leave/close 清理：全员离开房间回收，重进是新 epoch', async () => {
  const w = await makeWorld('leave');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const B = workerSession();
  const joinB = await B.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result;
  assert.equal(joinB.ok, true);
  const b = joinB.value;
  let room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1);
  assert.equal(room.clients(a.epoch), 2);
  A.leave(a.client);
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1, '仍有成员时房间保留');
  assert.equal(room.clients(a.epoch), 1);
  room.close();
  const left = await B.call({ op: 'leave', client: b.client }).result;
  assert.equal(left.ok, true);
  await B.close();
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 0, '全员离开后房间与增量日志清理');
  assert.equal(room.changes(a.epoch).length, 0);
  room.close();
  const again = await A.join(w.file, w.base);
  assert.notEqual(again.epoch, a.epoch);
  A.leave(again.client);
});

test('T13 主机戳：外来 rooms 库开局清空并重写本机戳；正常路径跨进程保留房间', async () => {
  const w = await makeWorld('stamp');
  const first = (await oneShot({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base })).value;
  let room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1);
  const before = room.meta();
  assert.ok(before && before !== 'FOREIGN-HOST');
  room.close();
  await oneShot({ op: 'stamp', impl: implPath, dir: w.dir, value: 'FOREIGN-HOST' });
  // 清空是惰性的：发生在下一个进程打开 rooms 库时（重置与本机戳写入同事务）
  const second = (await oneShot({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base })).value;
  assert.notEqual(second.epoch, first.epoch);
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1);
  assert.equal(room.rooms().some(row => row.epoch === first.epoch), false, '外来库的旧房间必须被清空');
  assert.equal(room.changes(first.epoch).length, 0, '外来库的增量日志必须被清空');
  assert.notEqual(room.meta(), 'FOREIGN-HOST', '开局重写本机主机戳');
  room.close();
});

test('T14 9MB 文档：join/exchange/save 成本预算与字节保真', async () => {
  const w = await makeWorld('big', null);
  const para = '同文件多窗口实时协同的容量基线段落，mixed latin 与中文混排、$x^2$ 与 `code`。'.repeat(24) + '\n';
  let base = '';
  while (base.length < 9_000_000) base += para;
  base = base.slice(0, 9_000_000);
  await writeText(w.file, base);
  const A = new LiveDocuments({ directory: w.dir });
  const t0 = performance.now();
  const a = await A.join(w.file, base);
  const tJoin = performance.now() - t0;
  let version = a.version, maxExchange = 0;
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const r = A.exchange(a.client, { epoch: a.epoch, version, seq: i + 1, changes: [{ from: base.length + i, to: base.length + i, insert: 'x' }] });
    maxExchange = Math.max(maxExchange, performance.now() - start);
    version = r.version;
  }
  const text = base + 'x'.repeat(30);
  const t1 = performance.now();
  const receipt = await A.save(a.client, { epoch: a.epoch, version, text }, async () => {
    await writeText(w.file, text);
    return { ok: true, version: 'prov-9mb' };
  });
  const tSave = performance.now() - t1;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.version, 'prov-9mb');
  assert.equal(await byteHashOf(w.file), receipt.diskHash, '9MB 保存后 diskHash 与真实字节一致');
  assert.equal((await fs.stat(w.file)).size, Buffer.byteLength(text));
  assert.ok(tJoin < 15000, 'join ' + Math.round(tJoin) + 'ms 超预算');
  assert.ok(maxExchange < 1500, '单次 exchange ' + Math.round(maxExchange) + 'ms 超预算');
  assert.ok(tSave < 15000, 'save ' + Math.round(tSave) + 'ms 超预算');
  console.log(JSON.stringify({ cost9MB: { joinMs: Math.round(tJoin), maxExchangeMs: Math.round(maxExchange), saveMs: Math.round(tSave), chars: text.length } }));
  A.leave(a.client);
});

test('T15 自适应 compact：小文档 128 跨度、大文档 512 跨度，压缩后日志收敛', async () => {
  const small = await makeWorld('compact-small', 's'.repeat(200) + '\n');
  const As = new LiveDocuments({ directory: small.dir });
  const as = await As.join(small.file, small.base);
  let version = 0;
  for (let i = 0; i < 140; i++) {
    const r = As.exchange(as.client, { epoch: as.epoch, version, seq: i + 1, changes: [{ from: i, to: i, insert: 'y' }] });
    version = r.version;
  }
  let room = await openRoom(small.dir);
  assert.ok(room.rooms()[0].floor > 0, '小文档 140 次编辑应已压缩');
  room.close();
  As.leave(as.client);

  const big = await makeWorld('compact-big', null);
  const base = 'b'.repeat(1_200_000) + '\n';
  await writeText(big.file, base);
  const Ab = new LiveDocuments({ directory: big.dir });
  const ab = await Ab.join(big.file, base);
  version = 0;
  let seqNo = 0; // seq 必须跨调用连续：已确认的旧 seq 会被幂等去重（重发容忍）而不落账
  const type = async n => {
    for (let i = 0; i < n; i++) {
      const r = Ab.exchange(ab.client, { epoch: ab.epoch, version, seq: ++seqNo, changes: [{ from: base.length, to: base.length, insert: 'z' }] });
      version = r.version;
    }
  };
  await type(200);
  room = await openRoom(big.dir);
  assert.equal(room.rooms()[0].floor, 0, '大文档 200 次编辑不得触发全量压缩（512 跨度）');
  room.close();
  await type(320);
  room = await openRoom(big.dir);
  const row = room.rooms()[0];
  console.log(JSON.stringify({ compactBig: { version: row.version, floor: row.floor, changes: room.changes(ab.epoch).length } }));
  assert.ok(row.floor >= 500, '520 次编辑后应已完成一次压缩，floor=' + row.floor);
  assert.ok(room.changes(ab.epoch).length < 64, '压缩后增量日志应收敛');
  assert.equal(row.disk, await byteHashOf(big.file));
  room.close();
  Ab.leave(ab.client);
});

test('T16 join 防护：正文或期望哈希不符拒绝加入，磁盘不动', async () => {
  const w = await makeWorld('join-guard');
  await assert.rejects((async () => new LiveDocuments({ directory: w.dir }).join(w.file, 'TAMPERED\n'))(),
    error => error.code === 'MP_FILE_CONFLICT');
  const A = new LiveDocuments({ directory: w.dir });
  await assert.rejects(A.join(w.file, w.base, 'deadbeef'), error => error.code === 'MP_FILE_CONFLICT');
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base);
});

test('T17 写者写出的字节与正文不符：保存不得记为成功，房间保持旧盘哈希', async () => {
  const w = await makeWorld('rogue');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 5, insert: 'GOOD\n' }] });
  await assert.rejects(A.save(a.client, { epoch: a.epoch, version: 1, text: 'GOOD\n' }, async () => {
    await writeText(w.file, 'ROGUE\n');
    return { ok: true, version: 'prov-rogue' };
  }), error => error.code === 'MP_FILE_CONFLICT');
  const head = A.exchange(a.client, { epoch: a.epoch, version: 1 });
  assert.equal(head.savedVersion, 0, 'Rogue 写不得记账为已保存');
  const room = await openRoom(w.dir);
  assert.equal(room.rooms()[0].disk, sha256(Buffer.from(w.base)), '房间 disk 保持旧值');
  room.close();
  const r = await A.refresh(a.client, a.epoch);
  assert.equal(r.changed, true);
  assert.equal(r.unsavedDraft, true);
  assert.equal(await fs.readFile(w.file, 'utf8'), 'ROGUE\n');
  A.leave(a.client);
});

test('T18 令牌盗用：别的进程、别的实例拿同一 client 必须被拒，原会话不受影响', async () => {
  const w = await makeWorld('theft');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  const B = workerSession();
  const joinB = await B.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result;
  assert.equal(joinB.ok, true);
  const b = joinB.value;
  // B 的进程仍活着、租约在；第三个进程拿 b.client 冒充
  const thief = await oneShot({ op: 'exchange', impl: implPath, dir: w.dir, client: b.client, epoch: b.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'STOLEN' }] });
  assert.equal(thief.ok, false);
  assert.equal(thief.code, 'MP_LIVE_SESSION');
  // 同进程另一实例同样没有能力
  const A2 = new LiveDocuments({ directory: w.dir });
  assert.throws(() => A2.exchange(a.client, { epoch: a.epoch, version: 0 }), error => error.code === 'MP_LIVE_SESSION');
  // 原会话不受影响
  const ex = await B.call({ op: 'exchange', dir: w.dir, client: b.client, epoch: b.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'REAL' }] }).result;
  assert.equal(ex.ok, true);
  const ax = A.exchange(a.client, { epoch: a.epoch, version: 0 });
  assert.equal(ax.updates[0].client, b.client);
  assert.equal(applyChanges(w.base, ax.updates[0].changes), 'REALline\n');
  await B.call({ op: 'leave', client: b.client }).result;
  await B.close();
  A.leave(a.client);
});

test('T19 LiveDocuments.save 的 writer 内嵌 DocumentStore.save：同锁重入不死锁，真实字节落盘', async () => {
  const w = await makeWorld('reentry', 're-entry\n');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 9, insert: 'REENTERED\n' }] });
  const text = 'REENTERED\n';
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  await ds.load(S, w.file);
  ds.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  const receipt = await withTimeout(A.save(a.client, { epoch: a.epoch, version: 1, text }, async () =>
    ds.save(S, { filePath: S.filePath, text, documentId: S.documentId, revision: 1 })), 8000, '重入死锁或超时');
  assert.equal(receipt.ok, true);
  assert.ok(receipt.saveId, 'DocumentStore 回执原样透传');
  assert.equal(receipt.bytes, Buffer.byteLength(text));
  assert.equal(receipt.liveVersion, 1);
  assert.equal(receipt.savedVersion, 1);
  assert.equal(await fs.readFile(w.file, 'utf8'), text);
  assert.equal(await byteHashOf(w.file), receipt.diskHash, 'live diskHash 与 DocumentStore 提交的真实字节一致');
  A.leave(a.client);
});

test('T19b 重入能力（本地可完整验证）：live writer 内嵌 ds.save，内层 raw baseline 拒绝原样透传而非 MP_SAVE_BUSY', async () => {
  const w = await makeWorld('reentry-b', 'live-file\n');
  const other = path.join(w.root, 'other.md');
  await fs.writeFile(other, 'other\n');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 10, insert: 'LIVE-1\n' }] });
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  await ds.load(S, other);
  await writeText(other, 'CHANGED\n'); // 另一文件 raw baseline 失配：内层在 compare 处拒绝
  ds.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  let inner = null;
  await assert.rejects(withTimeout(A.save(a.client, { epoch: a.epoch, version: 1, text: 'LIVE-1\n' }, async () => {
    try { return await ds.save(S, { filePath: S.filePath, text: 'MINE\n', documentId: S.documentId, revision: 1 }); }
    catch (error) { inner = error.code; throw error; }
  }), 8000, '重入死锁'), error => {
    assert.notEqual(error.code, 'MP_SAVE_BUSY', '重入不得退化为抢锁超时');
    assert.equal(error.code, 'MP_FILE_CONFLICT');
    return true;
  });
  assert.equal(inner, 'MP_FILE_CONFLICT', '内层确实进入 DocumentStore 的 raw baseline 比对');
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base, 'live 文件未被写');
  assert.equal(await fs.readFile(other, 'utf8'), 'CHANGED\n', '外部字节保留');
  A.leave(a.client);
});

test('T20 两个独立 DocumentStore 进程同基线写同路径：租约串行、恰一次成功另一次拒绝', async () => {
  const w = await makeWorld('dual-ds', 'dual\n');
  const P1 = workerSession();
  const l1 = await P1.call({ op: 'dsLoad', impl: implPath, dir: w.dir, file: w.file }).result;
  assert.equal(l1.ok, true, l1.message);
  const P2 = workerSession();
  const l2 = await P2.call({ op: 'dsLoad', impl: implPath, dir: w.dir, file: w.file }).result;
  assert.equal(l2.ok, true, l2.message);
  const gate = path.join(w.root, 'gate');
  await fs.writeFile(gate, '1');
  // P1 在 beforeReplace（compare 之后、替换之前）持锁等待，制造确定性窗口。
  // held 等待与结果回执竞速：P1 若在进入持锁提交前出错/结束，错误原样显露而非泛化超时。
  const s1 = P1.call({ op: 'dsSave', dir: w.dir, text: 'FROM-P1\n', dsHoldGate: gate }, 30000);
  const outcome = await withTimeout(Promise.race([
    s1.held.then(() => 'held'),
    s1.result.then(r => 'early-result: ' + JSON.stringify(r).slice(0, 300)),
  ]), 8000, 'P1 未进入持锁提交');
  assert.equal(outcome, 'held', 'P1 未到达 beforeReplace：' + outcome);
  let room = await openRoom(w.dir);
  assert.equal(room.writers().length, 1, 'ds 保存路径必须占跨进程文件写租约');
  room.close();
  let p2Settled = false;
  const s2 = P2.call({ op: 'dsSave', dir: w.dir, text: 'FROM-P2\n' }, 30000);
  s2.result.then(() => { p2Settled = true; }, () => { p2Settled = true; });
  await pause(300);
  assert.equal(p2Settled, false, '持锁期间另一进程的 ds 保存不得完成（绝不并写）');
  await fs.rm(gate);
  const r1 = await s1.result, r2 = await s2.result;
  assert.equal([r1, r2].filter(r => r.ok).length, 1, '同一基线只允许一次提交，实测 ' + JSON.stringify({ r1: r1.code || 'ok', r2: r2.code || 'ok' }));
  assert.equal([r1, r2].find(r => !r.ok).code, 'MP_FILE_CONFLICT', '落败方必须是 raw baseline 比对拒绝');
  assert.equal(await fs.readFile(w.file, 'utf8'), r1.ok ? 'FROM-P1\n' : 'FROM-P2\n', '盘上是获胜方字节');
  await P1.close(); await P2.close();
});

test('T21 未命名另存新路径与另存旧目标：授权流在锁内完成，字节正确', async () => {
  const w = await makeWorld('saveas', null);
  const target = path.join(w.root, 'fresh.md');
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  const grant = await ds.grantSaveAs(S, target, ds.beginSaveAs(S));
  ds.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  const receipt = await ds.save(S, { filePath: target, text: 'FRESH\n', documentId: S.documentId, revision: 1, saveAsToken: grant.saveAsToken });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.filePath, target);
  assert.equal(await fs.readFile(target, 'utf8'), 'FRESH\n');
  // 另存到已存在的旧目标（基线一致）同样在锁内提交
  const grant2 = await ds.grantSaveAs(S, target, ds.beginSaveAs(S));
  const again = await ds.save(S, { filePath: target, text: 'FRESH-2\n', documentId: S.documentId, revision: 2, saveAsToken: grant2.saveAsToken });
  assert.equal(again.ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'FRESH-2\n');
});

test('T22 真实 raw baseline：load 后外改，保存拒绝且外部字节保留', async () => {
  const w = await makeWorld('baseline', 'base\n');
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  await ds.load(S, w.file);
  await writeText(w.file, 'EXTERNAL\n');
  ds.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  await assert.rejects(ds.save(S, { filePath: S.filePath, text: 'MINE\n', documentId: S.documentId, revision: 1 }),
    error => error.code === 'MP_FILE_CONFLICT');
  assert.equal(await fs.readFile(w.file, 'utf8'), 'EXTERNAL\n', '外部字节必须保留');
});

test('T23 崩溃清理：clean 孤儿房间按短事务回收，不碰活会话、不产生恢复副本', async () => {
  const w = await makeWorld('sweep-clean', 'sweep\n');
  const keep = path.join(w.root, 'keep.md');
  await fs.writeFile(keep, 'keep\n');
  for (const [name, text] of [['gone1.md', 'g1\n'], ['gone2.md', 'g2\n']]) {
    const file = path.join(w.root, name);
    await fs.writeFile(file, text);
    const P = workerSession();
    const j = await P.call({ op: 'join', impl: implPath, dir: w.dir, file, text }).result;
    assert.equal(j.ok, true, j.message);
    await P.close(); // 正常退出但不 leave：模拟异常退出留下的 clean 孤儿
  }
  let room = await openRoom(w.dir);
  assert.ok(room.rooms().length >= 1, '清扫前孤儿房间仍在（后续进程的 join 可能已顺带清扫部分）');
  room.close();
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(keep, 'keep\n'); // 任意 join 触发有界清扫
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1, 'clean 孤儿回收，只留活会话');
  room.close();
  assert.equal(fsSync.existsSync(path.join(w.dir, 'recovery')), false, 'clean 孤儿不产生恢复副本');
  A.leave(a.client);
});

test('T24 崩溃脏稿：恢复副本入私有目录且 join 可定位；旧稿绝不写入已换内容的新文件', async () => {
  const w = await makeWorld('sweep-dirty', 'draft\n');
  const P = workerSession();
  const j = await P.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result;
  assert.equal(j.ok, true, j.message);
  const ex = await P.call({ op: 'exchange', dir: w.dir, client: j.value.client, epoch: j.value.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'UNSAVED-' }] }).result;
  assert.equal(ex.ok, true, ex.message);
  P.child.kill('SIGKILL'); // 崩溃：脏稿只存在于房间
  await pause(200);
  await writeText(w.file, 'REPLACED-CONTENT\n'); // 原路径换成不同内容（改名/重写）
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, 'REPLACED-CONTENT\n');
  assert.ok(Array.isArray(a.recovered) && a.recovered.length >= 1, 'join 应带回崩溃脏稿的恢复副本位置');
  const rec = a.recovered[0];
  assert.ok(rec.recoveryPath.startsWith(path.resolve(w.dir)), '恢复副本必须限私有 live 目录');
  assert.equal(await fs.readFile(rec.recoveryPath, 'utf8'), 'UNSAVED-draft\n', '恢复副本是崩溃前的脏稿全文');
  assert.equal(rec.sha256, sha256(Buffer.from('UNSAVED-draft\n')));
  assert.equal(await fs.readFile(w.file, 'utf8'), 'REPLACED-CONTENT\n', '新文件不得被旧脏稿污染');
  assert.equal(a.text, 'REPLACED-CONTENT\n', '房间从新内容起步');
  let room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1, '崩溃房间已退役');
  assert.equal(room.changes(a.epoch).length, 0);
  room.close();
  A.leave(a.client);
});

test('T25 超批量孤儿：每趟至多回收 4 间，未处理房间保持可再发现，两趟清空', async () => {
  const w = await makeWorld('sweep-many', 'hub\n');
  // 六个会话同时存活后集体 SIGKILL：清扫永远看不到中间态，一次产生 6 间孤儿
  const sessions = [];
  for (let i = 1; i <= 6; i++) {
    const file = path.join(w.root, 'orphan-' + i + '.md');
    await fs.writeFile(file, 'o' + i + '\n');
    const P = workerSession();
    const j = await P.call({ op: 'join', impl: implPath, dir: w.dir, file, text: 'o' + i + '\n' }).result;
    assert.equal(j.ok, true, j.message);
    sessions.push(P);
  }
  for (const P of sessions) P.child.kill('SIGKILL');
  await pause(250);
  let room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 6, '六个孤儿房间都在，未被中途清扫');
  room.close();
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, 'hub\n'); // 第一趟：批量上限 4
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 3, '第一趟恰回收 4 间（剩 2 孤儿 + keep）');
  room.close();
  A.leave(a.client);
  await oneShot({ op: 'external', impl: implPath, dir: w.dir, file: path.join(w.root, 'dummy.md'), text: 'd\n' }, { timeoutMs: 30000 });
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 0, '第二趟（新进程）清空剩余孤儿：未处理房间必须保持可再发现');
  room.close();
});

test('T26 恢复文件写失败：房间与草稿原样保留（join 续用脏稿），解除阻断后下一趟补 Park', async () => {
  const w = await makeWorld('sweep-fail', 'guard\n');
  const P = workerSession();
  const j = await P.call({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base }).result;
  assert.equal(j.ok, true, j.message);
  const ex = await P.call({ op: 'exchange', dir: w.dir, client: j.value.client, epoch: j.value.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'DRAFT-' }] }).result;
  assert.equal(ex.ok, true, ex.message);
  P.child.kill('SIGKILL');
  await pause(200);
  // 阻断 recovery 目录：同名普通文件使递归建目录失败
  await fs.writeFile(path.join(w.dir, 'recovery'), 'blocker');
  const j2 = await oneShot({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base });
  assert.equal(j2.ok, true, j2.message);
  assert.equal(j2.value.text, 'DRAFT-guard\n', 'Park 失败时 join 续用房间脏稿，绝不静默丢稿');
  let room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1, 'Park 失败时房间不得被删');
  assert.equal(room.rooms()[0].version, 1, '脏稿仍在房间内');
  assert.equal(room.rooms()[0].saved, 0);
  assert.equal(room.recovery().length, 0, '无恢复记录');
  room.close();
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base, '原文不动');
  // 解除阻断后，下一趟（新进程）补 Park 并退役旧房
  await fs.rm(path.join(w.dir, 'recovery'));
  const j3 = await oneShot({ op: 'join', impl: implPath, dir: w.dir, file: w.file, text: w.base });
  assert.equal(j3.ok, true, j3.message);
  assert.ok(Array.isArray(j3.value.recovered) && j3.value.recovered.length >= 1, '补 Park 后 join 带回恢复副本位置');
  assert.equal(await fs.readFile(j3.value.recovered[0].recoveryPath, 'utf8'), 'DRAFT-guard\n', '恢复副本为崩溃前脏稿全文');
  assert.equal(j3.value.text, w.base, '新房间从当前磁盘起步');
  room = await openRoom(w.dir);
  assert.equal(room.rooms().length, 1, '旧房已退役，仅剩 j3 自身的新房（其进程退出后成 clean 孤儿）');
  room.close();
});

test('T27 原文件丢失：join/refresh/save 返回 MP_FILE_MISSING 友好语义而非裸 ENOENT，写者不运行', async () => {
  const w = await makeWorld('missing');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  await fs.rm(w.file);
  await assert.rejects(A.refresh(a.client, a.epoch), error => error.code === 'MP_FILE_MISSING');
  let called = false;
  await assert.rejects(A.save(a.client, { epoch: a.epoch, version: 0, text: w.base }, async () => { called = true; }),
    error => error.code === 'MP_FILE_MISSING');
  assert.equal(called, false, '文件已丢失时不得调用写者');
  await assert.rejects(A.join(w.file, w.base), error => error.code === 'MP_FILE_MISSING');
  await assert.rejects(A.join(w.file, w.base, 'deadbeef'), error => error.code === 'MP_FILE_MISSING');
  A.leave(a.client);
});

test('T28 原件被删后的保存语义：友好文案不透 ENOENT、不静默重建、草稿保留、另存新位置许可', async () => {
  const w = await makeWorld('deleted-original', 'DELETE BASE\n');
  const A = new LiveDocuments({ directory: w.dir });
  const a = await A.join(w.file, w.base);
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 12, to: 12, insert: 'LOCAL' }] });
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  await ds.load(S, w.file); // 原件还在时建立基线（r2 场景：打开后被外部删除）
  await fs.rm(w.file);
  // live 保存：readDisk 必须给 MP_FILE_MISSING + 友好中文（legacy-data-safety-r2 回归）
  let saveError, called = false;
  await assert.rejects(A.save(a.client, { epoch: a.epoch, version: 1, text: 'DELETE BASE\nLOCAL' }, async () => { called = true; }),
    error => { saveError = error; return error.code === 'MP_FILE_MISSING'; });
  assert.equal(called, false, '文件已丢失时不得调用写者');
  assert.ok(saveError.message.includes('不在'), '文案必须是友好中文：' + saveError.message);
  assert.ok(!saveError.message.includes('ENOENT'), '不得把原始 ENOENT 透给 UI');
  let refreshError;
  await assert.rejects(A.refresh(a.client, a.epoch), error => { refreshError = error; return error.code === 'MP_FILE_MISSING'; });
  assert.ok(refreshError.message.includes('不在'));
  // 失败保存不得静默重建原文件；草稿完整保留在房间
  assert.equal(fsSync.existsSync(w.file), false, 'deleted-original-is-not-silently-recreated');
  const head = A.exchange(a.client, { epoch: a.epoch, version: 1 });
  assert.equal(head.version, 1);
  assert.equal(head.savedVersion, 0, '草稿仍未保存、完整保留');
  // 直连 DocumentStore 保存（无 live）：validate 的原始 MP_FILE_MISSING 路径不受锁接入影响
  ds.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  await assert.rejects(ds.save(S, { filePath: S.filePath, text: 'MINE\n', documentId: S.documentId, revision: 1 }),
    error => error.code === 'MP_FILE_MISSING' && error.message.includes('不在'));
  // 另存到新位置仍然被许可（目标创建本身由 T21 原生写臂覆盖）
  const fresh = path.join(w.root, 'fresh-target.md');
  const grant = await ds.grantSaveAs(S, fresh, ds.beginSaveAs(S));
  await ds.validate(fresh, null);
  assert.ok(grant.saveAsToken, '新位置授权不受原文件丢失影响');
  A.leave(a.client);
});

test('T29a 多层新父目录：canonical/租约从最近现存祖先解析，另存授权与校验许可不受影响', async () => {
  const w = await makeWorld('nested', null);
  const nested = path.join(w.root, 'brand', 'new', 'deep', 'note.md');
  // 修复前：withFileCommit 对缺失多层父目录直接抛 realpath ENOENT（unit-final 同源）
  const value = await withTimeout(withFileCommit(nested, async () => 42, w.dir), 4000, '多层缺失父目录抛错/死锁');
  assert.equal(value, 42);
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  const grant = await ds.grantSaveAs(S, nested, ds.beginSaveAs(S));
  assert.ok(grant.saveAsToken, '新嵌套目录目标照常获得另存授权');
  await ds.validate(nested, null);
});

test('T29b 多层新父目录完整另存（原生写臂）：stage/prepare+SaveAs 建立目标与父目录', async () => {
  const w = await makeWorld('nested-full', 'NEST\n');
  const nested = path.join(w.root, 'brand', 'new', 'deep', 'note.md');
  const ds = new DocumentStore({ commitDirectory: w.dir });
  const S = createSession();
  await ds.load(S, w.file);
  const grant = await ds.grantSaveAs(S, nested, ds.beginSaveAs(S));
  ds.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  const receipt = await ds.save(S, { filePath: nested, text: 'NESTED\n', documentId: S.documentId, revision: 1, saveAsToken: grant.saveAsToken });
  assert.equal(receipt.ok, true);
  assert.equal(await fs.readFile(nested, 'utf8'), 'NESTED\n', '多层新父目录中建立目标');
});

test('T30 路径重绑/别名负例：旧会话的写不随别名漂移，占用路径被换新文件时 CAS 拒绝', async () => {
  const w = await makeWorld('rebind', 'REAL\n');
  const linkPath = path.join(w.root, 'alias.md');
  let viaLink = false;
  try { await fs.symlink(w.file, linkPath); viaLink = true; } catch { /* 无符号链接权限：退回占用路径式重绑 */ }
  const A = new LiveDocuments({ directory: w.dir });
  const a = viaLink ? await A.join(linkPath, w.base) : await A.join(w.file, w.base);
  assert.equal(await fs.readFile(w.file, 'utf8'), w.base);
  if (viaLink) {
    // 把别名重绑到另一个文件：房间/租约身份锚定 join 时解析出的真实路径，
    // 旧会话的保存不得经别名写到新目标
    const other = path.join(w.root, 'other.md');
    await fs.writeFile(other, 'OTHER\n');
    await fs.rm(linkPath);
    await fs.symlink(other, linkPath);
    A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 4, to: 4, insert: '+EDIT' }] });
    const text = 'REAL+EDIT\n';
    const receipt = await A.save(a.client, { epoch: a.epoch, version: 1, text }, async () => {
      await writeText(w.file, text);
      return { ok: true, version: 'prov-rebind' };
    });
    assert.equal(receipt.ok, true, '保存经真实原件完成');
    assert.equal(await fs.readFile(w.file, 'utf8'), text);
    assert.equal(await fs.readFile(other, 'utf8'), 'OTHER\n', '重绑后的新目标不得被旧会话写入');
  } else {
    // 占用路径式重绑：原件被移走、同路径出现不同内容的新文件 → 旧写被 CAS 拒绝
    const moved = path.join(w.root, 'moved.md');
    await fs.rename(w.file, moved);
    await fs.writeFile(w.file, 'REPLACED\n');
    A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 4, to: 4, insert: '+EDIT' }] });
    let called = false;
    await assert.rejects(A.save(a.client, { epoch: a.epoch, version: 1, text: 'REAL+EDIT\n' }, async () => { called = true; }),
      error => error.code === 'MP_FILE_CONFLICT');
    assert.equal(called, false, '目标已被意外替换时不得调用写者');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'REPLACED\n', '占用新文件不被覆盖');
    assert.equal(await fs.readFile(moved, 'utf8'), 'REAL\n', '被移走的原件不动');
  }
  A.leave(a.client);
});

test('T99 清扫：关闭所有遗留 worker 会话，让进程可自然退出', async () => {
  for (const session of [...sessions]) {
    try { await session.close(); } catch { /* 已退 */ }
  }
});
