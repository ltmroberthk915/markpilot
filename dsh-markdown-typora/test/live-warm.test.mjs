// 安全写者预热（编辑期 warm-up）测试。运行：node test/live-warm.test.mjs
// MP_LIVE_IMPL 指向被测 live-documents.js（默认仓内 MarkPilot-CM6/shell 副本）。
// 全部用例与宿主机是否允许 spawn 无关：W1 只断言传输层不变量；W2 用 require.cache
// 私有 stub 验证触发语义；W3 在既有边界（native-worker-lease 的 createNativeWorkerLease）
// 注入确定性失败，裁决真实 prepareFileWorker/prepareFile/shutdownFileWorker 路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, '../../MarkPilot-CM6/shell');
const livePath = process.env.MP_LIVE_IMPL ? path.resolve(process.env.MP_LIVE_IMPL) : path.join(shellDir, 'live-documents.js');
const safePath = path.join(shellDir, 'safe-file.js');
const leasePath = path.join(shellDir, 'native-worker-lease.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const worlds = [];
const liveInstances = new Set(); // 本轮创建的 LiveDocuments：测试后关其 sqlite 连接（每目录一个）
async function makeWorld(name, initial = 'warm\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-warm-' + name + '-'));
  const file = path.join(root, 'doc.md');
  const dir = path.join(root, 'live');
  await fs.writeFile(file, initial, 'utf8');
  worlds.push(root);
  return { root, file, dir, base: initial };
}
async function writeText(file, text) {
  const tmp = path.join(path.dirname(file), '.w-' + crypto.randomUUID());
  await fs.writeFile(tmp, Buffer.from(text, 'utf8'));
  await fs.rename(tmp, file);
}

test('W1 传输层不变量：首个接受编辑触发预热后，后续编辑与真实保存不受预热成败影响', async () => {
  const { LiveDocuments } = require(livePath);
  const w = await makeWorld('real');
  const A = new LiveDocuments({ directory: w.dir });
  liveInstances.add(A);
  const a = await A.join(w.file, w.base);
  assert.equal(A.exchange(a.client, { epoch: a.epoch, version: 0 }).version, 0);
  // 首个真正接受的非空编辑：后台预热（成败随宿主环境，均不得影响本表断言）
  assert.equal(A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 4, to: 4, insert: 'X' }] }).version, 1);
  await pause(80);
  assert.equal(A.exchange(a.client, { epoch: a.epoch, version: 1, seq: 2, changes: [{ from: 5, to: 5, insert: 'Y' }] }).version, 2, '后续编辑照常接受');
  const text = 'warmXY\n';
  const receipt = await A.save(a.client, { epoch: a.epoch, version: 2, text }, async () => {
    await writeText(w.file, text);
    return { ok: true, version: 'prov-warm' };
  });
  assert.equal(receipt.ok, true, '预热结果不得影响真实保存');
  assert.equal(await fs.readFile(w.file, 'utf8'), text);
  A.leave(a.client);
});

test('W2 触发语义（stub）：仅“真正接受且含实际字符操作的新 seq”触发一次', async () => {
  delete require.cache[require.resolve(livePath)];
  const calls = [];
  require.cache[require.resolve(safePath)] = {
    id: safePath, filename: safePath, loaded: true,
    exports: {
      prepareFileWorker() { calls.push(Date.now()); },
      prepareFile: async () => { throw Error('stub: no native write in this arm'); },
      shutdownFileWorker: async () => null,
    },
  };
  const { LiveDocuments } = require(livePath); // 全新模块实例 ⇒ writerWarm 复位
  const w = await makeWorld('stub');
  const A = new LiveDocuments({ directory: w.dir });
  liveInstances.add(A);
  const a = await A.join(w.file, w.base);
  assert.equal(calls.length, 0, 'join（纯打开）不触发');
  A.exchange(a.client, { epoch: a.epoch, version: 0 });
  assert.equal(calls.length, 0, '空轮询不触发');
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 4, to: 4, insert: 'A' }] });
  assert.equal(calls.length, 1, '首个接受的新 seq（含实际字符操作）触发恰好一次');
  A.exchange(a.client, { epoch: a.epoch, version: 0, seq: 1, changes: [{ from: 4, to: 4, insert: 'A' }] });
  assert.equal(calls.length, 1, '重发的旧 seq（幂等去重）不触发');
  A.exchange(a.client, { epoch: a.epoch, version: 1 });
  assert.equal(calls.length, 1, '后续轮询不触发');
  A.exchange(a.client, { epoch: a.epoch, version: 1, seq: 2, changes: [{ from: 5, to: 5, insert: 'B' }] });
  assert.equal(calls.length, 1, '每进程至多一次，后续编辑不重复启动');
  // 协议合法但全为空 splice 的 no-op：seq/version/ack 行为不变，但不触发预热
  const noop = A.exchange(a.client, { epoch: a.epoch, version: 2, seq: 3, changes: [{ from: 4, to: 4, insert: '' }] });
  assert.equal(noop.version, 3, 'no-op 编辑照常入账');
  assert.equal(calls.length, 1, '全空 splice 不做字符操作，不启动原生写者');
  assert.throws(() => A.exchange(a.client, { epoch: a.epoch, version: 3, seq: 4, changes: [{ from: 999, to: 999, insert: '!' }] }),
    error => error.code === 'MP_LIVE_CHANGE');
  assert.equal(calls.length, 1, '被拒绝的无效变更（事务回滚）不触发');
  A.leave(a.client);
  delete require.cache[require.resolve(livePath)];
  delete require.cache[require.resolve(safePath)];
});

test('W3 边界注入：并发 warm+save 共用单次启动；失败被吞不缓存、保存重试如实报错；关闭后不再启动', async () => {
  // fresh safe-file 实例 + native-worker-lease 计数 spy：既有边界处确定性失败，
  // 不依赖宿主机 spawn 策略；真实 prepareFileWorker/prepareFile/shutdownFileWorker 路径裁决。
  delete require.cache[require.resolve(safePath)];
  let acquisitions = 0;
  require.cache[require.resolve(leasePath)] = {
    id: leasePath, filename: leasePath, loaded: true,
    exports: {
      // 与真实 createNativeWorkerLease 的公开失败形态一致（qualify 的包装契约）
      createNativeWorkerLease: async () => {
        acquisitions += 1;
        await pause(30); // 让并发方落到同一个 pending 启动承诺上
        const cause = Object.assign(new Error('injected lease failure'), { code: 'EACCES' });
        throw Object.assign(new Error('找不到通过权限检查的辅助程序执行目录'), { code: 'MP_NATIVE_WORKER_PATH', cause });
      },
    },
  };
  const safe = require(safePath);
  const w = await makeWorld('inject');
  const target = w.file, tmp = path.join(w.root, '.tmp-a'), tmp2 = path.join(w.root, '.tmp-b');
  try {
    // ① 并发 warm + 实际保存：pending 期间共用同一次启动（不二次 acquire）
    const warmPromise = safe.prepareFileWorker();
    const savePromise = safe.prepareFile(target, tmp, { baseline: null, output: { bytes: 1, sha256: '00' } });
    await warmPromise; // 预热失败被吞：调用方无感
    await assert.rejects(savePromise, error => error.code === 'MP_NATIVE_WORKER_PATH' && error.cause?.code === 'EACCES',
      '真实保存等待同一启动并如实报错（注入的公开失败形态原样透传）');
    assert.equal(acquisitions, 1, '并发 warm+save 只发起一次租约获取（同一 starting 承诺）');
    // ② 失败不缓存：下一次保存重新尝试启动并再次如实失败
    await assert.rejects(safe.prepareFile(target, tmp2, { baseline: null, output: { bytes: 1, sha256: '00' } }),
      error => error.code === 'MP_NATIVE_WORKER_PATH');
    assert.equal(acquisitions, 2, '失败未被缓存为成功，保存重试启动');
    // ③ 再次预热同样自吞，不抛未处理拒绝
    await safe.prepareFileWorker();
    assert.equal(acquisitions, 3);
    // ④ 关闭：无 worker 直接回收；此后预热 no-op、保存显式拒绝，均不再发起获取
    await safe.shutdownFileWorker();
    await safe.prepareFileWorker();
    await assert.rejects(safe.prepareFile(target, tmp2, { baseline: null, output: { bytes: 1, sha256: '00' } }),
      error => error.code === 'MP_FILE_WORKER_CLOSING');
    assert.equal(acquisitions, 3, '关闭后绝不复活工作进程');
  } finally {
    delete require.cache[require.resolve(safePath)];
    delete require.cache[require.resolve(leasePath)];
  }
});

test('W99 收尾：关闭本轮全部 live sqlite 连接（去重）后清理临时目录', async () => {
  // 每个实例的 db getter 指向其目录在本模块代际里的唯一连接；先关连接再删目录。
  for (const instance of [...liveInstances]) {
    liveInstances.delete(instance);
    try { instance.db.close(); } catch { /* 已关/不可关：尽力而为 */ }
  }
  for (const root of worlds.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      .catch(error => { if (!['EBUSY', 'EPERM'].includes(error.code)) throw error; });
  }
});
