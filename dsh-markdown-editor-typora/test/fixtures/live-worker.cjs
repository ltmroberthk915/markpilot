'use strict';
// 跨进程测试夹具（文件协议版）：argv[2]=控制目录。父进程按序写 job-<n>.json，
// 本夹具轮询执行并原子写 result-<n>.json；写者持锁时先写 held-<n> 标记文件。
// 不使用 stdio 管道（受限环境下管道 spawn 会被拒绝）。整个会话复用同一个
// LiveDocuments 实例（client 能力随实例存活）；{op:'exit'} 或杀进程即结束。
// client 令牌是加入实例的私有能力：另一进程拿同一 client 会被实现拒绝。
// 该文件是测试夹具，不是产品代码。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const control = process.argv[2];
if (!control || !fs.existsSync(control)) process.exit(2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gateRemoved = gate => new Promise((resolve, reject) => {
  const until = Date.now() + 30000;
  const tick = () => {
    if (!fs.existsSync(gate)) return resolve();
    if (Date.now() > until) return reject(Error('gate timeout: ' + gate));
    setTimeout(tick, 20);
  };
  tick();
});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function atomicJson(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
async function atomicWrite(file, text) {
  const bytes = Buffer.from(text, 'utf8');
  const tmp = path.join(path.dirname(file), '.live-worker-' + process.pid + '-' + crypto.randomUUID());
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, file);
  return bytes;
}

let live = null, implModule = null, dsStore = null, dsSession = null, dsHoldGate = null, dsMarkHeld = null, idle = null;
function armIdleExit() {
  clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), 60000); // 长时间无任务自退，避免拖住父进程
  idle.unref();
}
async function handle(job, markHeld) {
  if (job.impl) implModule = require(job.impl);
  if (!implModule) throw Error('first job must carry impl');
  const {LiveDocuments, withFileCommit} = implModule;
  if (!live) live = new LiveDocuments({directory: job.dir, busyTimeoutMs: job.busyTimeoutMs});
  let value;
  switch (job.op) {
    case 'join':
      value = await live.join(job.file, job.text, job.expectedHash);
      break;
    case 'exchange':
      value = live.exchange(job.client, {epoch: job.epoch, version: job.version, seq: job.seq, changes: job.changes});
      break;
    case 'save': {
      value = await live.save(job.client, {epoch: job.epoch, version: job.version, text: job.text},
        async () => {
          if (job.held) markHeld();
          if (job.gate) await gateRemoved(job.gate);
          const bytes = await atomicWrite(job.file, job.text);
          return {ok: true, version: job.providerVersion || 'prov-1', bytes: bytes.length, writtenDiskHash: sha256(bytes)};
        });
      break;
    }
    case 'external': {
      value = await live.external(job.file, async () => {
        if (job.held) markHeld();
        if (job.gate) await gateRemoved(job.gate);
        const bytes = await atomicWrite(job.file, job.text);
        return {ok: true, written: bytes.length, writtenDiskHash: sha256(bytes)};
      });
      break;
    }
    case 'refresh':
      value = await live.refresh(job.client, job.epoch);
      break;
    case 'leave':
      live.leave(job.client);
      value = {ok: true};
      break;
    case 'holdLease':
      value = await withFileCommit(job.file, async () => {
        markHeld();
        await gateRemoved(job.gate);
        return {held: true};
      }, job.dir, {busyTimeoutMs: job.busyTimeoutMs});
      break;
    case 'writeRaw':
      await atomicWrite(job.file, job.text);
      value = {ok: true};
      break;
    case 'dsLoad': {
      const ds = require(path.join(path.dirname(job.impl), 'document-store.js'));
      if (job.dsHoldGate) { dsHoldGate = job.dsHoldGate; dsMarkHeld = markHeld; }
      if (!dsStore) dsStore = new ds.DocumentStore({
        commitDirectory: job.dir,
        // 哨兵必须绑定“进行中的那次调用”的 markHeld（held-<当前seq>.json），
        // 不能绑建库时的 dsLoad 闭包；gate 一次性消费后清理。
        beforeReplace: async () => {
          if (dsHoldGate && dsMarkHeld) {
            const gate = dsHoldGate;
            dsHoldGate = null;
            dsMarkHeld();
            await gateRemoved(gate);
          }
        },
      });
      dsSession = ds.createSession();
      const meta = await dsStore.load(dsSession, job.file);
      value = {ok: true, filePath: meta.filePath, text: meta.text.length > 4000 ? meta.text.slice(0, 4000) : meta.text};
      break;
    }
    case 'dsSave': {
      if (!dsStore || !dsSession) throw Error('dsLoad first');
      if (job.dsHoldGate) { dsHoldGate = job.dsHoldGate; dsMarkHeld = markHeld; }
      if (job.startGate) await gateRemoved(job.startGate);
      dsStore.markDirty(dsSession, {documentId: dsSession.documentId, revision: 1, dirty: true});
      value = await dsStore.save(dsSession, {filePath: dsSession.filePath, text: job.text, documentId: dsSession.documentId, revision: 1});
      break;
    }
    case 'stamp': {
      const {DatabaseSync} = require('node:sqlite');
      const db = new DatabaseSync(path.join(job.dir, 'rooms.sqlite'));
      db.exec('PRAGMA busy_timeout=2000');
      db.prepare("INSERT OR REPLACE INTO meta VALUES('host',?)").run(job.value);
      db.close();
      value = {ok: true};
      break;
    }
    default:
      throw Error('unknown op: ' + job.op);
  }
  if (value && typeof value.text === 'string' && value.text.length > 4000) value = {...value, text: value.text.slice(0, 4000), textTrimmed: true};
  return value;
}

(async () => {
  for (let seq = 1; ; seq++) {
    const jobFile = path.join(control, 'job-' + seq + '.json');
    let raw = null;
    for (;;) {
      try { raw = fs.readFileSync(jobFile, 'utf8'); break; } catch { await pause(10); }
    }
    let job;
    try { job = JSON.parse(raw); } catch (error) {
      atomicJson(path.join(control, 'result-' + seq + '.json'), {ok: false, code: 'BAD_JOB', message: error.message});
      continue;
    }
    if (job.op === 'exit') process.exit(0);
    armIdleExit();
    try {
      const value = await handle(job, () => { try { fs.writeFileSync(path.join(control, 'held-' + seq + '.json'), '1'); } catch { /* 尽力标记 */ } });
      atomicJson(path.join(control, 'result-' + seq + '.json'), {ok: true, value});
    } catch (error) {
      atomicJson(path.join(control, 'result-' + seq + '.json'), {ok: false, code: error.code || 'ERR', message: error.message});
    }
  }
})();
