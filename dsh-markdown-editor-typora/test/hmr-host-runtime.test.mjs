// dsh-markdown-editor-typora 宿主半边：HMR/多宿主运行时回归。
// 运行：node --test test/hmr-host-runtime.test.mjs
//
// 覆盖（功能断言全部走公开 createHost/dispatch 面；热导使用 lib/index.js 公开
// 支持的模块查询串重导（?g=N，见 loadHostModules 注释），不触碰任何 DSH 内部）：
//  1) 同代多宿主：一笔异端读写（A 保存 → B 读取再保存 → A 读回），关闭一个宿主
//     不影响其余宿主继续读写。
//  2) 只改真实 native lease 文件字节，并按 scripts/sync-host.mjs 的公开清单格式
//     更新包根 host.json（不动 lib/），热导后新一代 createHost 的 open/live 交换
//     （seq 连续）/live 保存全链路正常，且旧一代宿主不被破坏。
//  3) host 成员损坏/缺失时模块导入直接拒绝（公开语义：装载失败即失败，无兜底）；
//     旧一代宿主继续可用；恢复字节后可再次导入。
//
// 清理契约（对应 host/live-documents.js:482-494 的内核顺序约定）：先关闭本测试
// 创建的全部宿主（close 幂等，释放租约）并排空已接纳写，再对每个已创建代按
// 「先 retireLiveStorage()，后 safeFile.shutdownFileWorker()」定点关停，最后删除
// 测试自建根目录。清理失败逐项打印并如实上抛（不吞、不用重试掩盖）。
// host.json 哈希核验属打包/DSH 侧门禁（sync-host 生成、package 阶段核验），
// 本测试覆盖公开 lib 的运行时装载语义，不伪造 DSH HMR 内部流程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SILENT_LOG = { info() {}, warn() {}, error() {} };
const TEST_TIMEOUT_MS = 30000;

/** 从真实包布局复制一个独立实例（lib/、host/、package.json、包根 host.json）。 */
async function makeInstance(label) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-md-hmr-' + label + '-'));
  await cp(join(PACKAGE_ROOT, 'lib'), join(root, 'lib'), { recursive: true });
  await cp(join(PACKAGE_ROOT, 'host'), join(root, 'host'), { recursive: true });
  await cp(join(PACKAGE_ROOT, 'package.json'), join(root, 'package.json'));
  await cp(join(PACKAGE_ROOT, 'host.json'), join(root, 'host.json'));
  // LiveDocuments 默认目录取自 LOCALAPPDATA（按调用时读取）；测试进程内重定向到
  // 实例私有临时区，既不触碰真实用户目录，也保持 createHost 的默认形态。
  await mkdir(join(root, 'localappdata'), { recursive: true });
  return root;
}

let generation = 0;
/** 公开热导入口：同一实例的新一代模块，并捕获该代实际装载的内核清理导出
 * （require 命中的就是 lib 本代 loadHostModules 装入的同一批实例）。 */
async function importGeneration(root) {
  process.env.LOCALAPPDATA = join(root, 'localappdata');
  generation += 1;
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?g=' + generation);
  const req = createRequire(join(root, 'lib', 'index.js'));
  const live = req('../host/live-documents.js');
  const safeFile = req('../host/safe-file.js');
  assert.equal(typeof live.retireLiveStorage, 'function', 'live-documents exports retireLiveStorage');
  assert.equal(typeof safeFile.shutdownFileWorker, 'function', 'safe-file exports shutdownFileWorker');
  return { mod, live, safeFile };
}

/** 每个用例的统一收尾：关宿主 → 按内核顺序逐代退休 → 删根。失败逐项打印并上抛。 */
async function teardown(root, hosts, gens) {
  const problems = [];
  for (const host of hosts) {
    try { host.close(); } catch (error) { problems.push(`close: ${error}`); }
  }
  for (const gen of gens.slice().reverse()) {
    try {
      const retired = gen.live.retireLiveStorage();
      if (retired?.ok !== true) problems.push(`retire: ${JSON.stringify(retired)}`);
    } catch (error) { problems.push(`retire: ${error}`); }
    try { await gen.safeFile.shutdownFileWorker(); } catch (error) { problems.push(`worker: ${error}`); }
  }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { problems.push(`rm: ${error}`); }
  for (const problem of problems) console.error('cleanup-failure:', problem);
  if (problems.length) throw new Error(`cleanup failed (${problems.length}): ${problems.join(' | ')}`);
}

/** 真实磁盘文件服务：版本口径与本地 provider 一致（dev:ino:size:mtimeNs:ctimeNs）。 */
function realFsService() {
  const versionOf = async (file) => {
    const s = await stat(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  };
  return {
    async resolve(path) {
      const key = normalize(String(path));
      return { targetKey: key, displayPath: key };
    },
    async stat(target) {
      const s = await stat(target.targetKey, { bigint: true });
      return { type: 'file', size: Number(s.size), version: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` };
    },
    async readText(target) { return readFile(target.targetKey, 'utf8'); },
    async writeText(target, text) {
      await writeFile(target.targetKey, String(text), 'utf8');
      return { operation: 'update', version: await versionOf(target.targetKey), after: String(text) };
    },
  };
}

test('同代多宿主：异端读写与单宿主关闭隔离', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await makeInstance('same-gen');
  const hosts = [], gens = [];
  try {
    const gen = await importGeneration(root);
    gens.push(gen);
    const fs = realFsService();
    const file = join(root, 'shared.md');
    await writeFile(file, '# 初稿\n', 'utf8');
    const h1 = gen.mod.createHost({ fs, log: SILENT_LOG });
    const h2 = gen.mod.createHost({ fs, log: SILENT_LOG });
    hosts.push(h1, h2);
    const a1 = await h1.dispatch('open', { path: file });
    assert.equal(a1.ok, true, JSON.stringify(a1));
    const s1 = await h1.dispatch('save', { path: file, text: '# A1 写入\n', baseVersion: a1.value.version });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    const b1 = await h2.dispatch('open', { path: file });
    assert.equal(b1.ok, true, JSON.stringify(b1));
    assert.equal(b1.value.text, '# A1 写入\n');
    const s2 = await h2.dispatch('save', { path: file, text: '# B2 写入\n', baseVersion: b1.value.version });
    assert.equal(s2.ok, true, JSON.stringify(s2));
    const a2 = await h1.dispatch('open', { path: file });
    assert.equal(a2.ok, true);
    assert.equal(a2.value.text, '# B2 写入\n');
    h1.close();
    const b3 = await h2.dispatch('open', { path: file });
    assert.equal(b3.ok, true, JSON.stringify(b3));
    assert.equal(b3.value.text, '# B2 写入\n');
  } finally {
    await teardown(root, hosts, gens);
  }
});

test('native lease 换代：改字节+按 sync-host 清单更新包根 host.json 后热导可用', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await makeInstance('hot-gen');
  const hosts = [], gens = [];
  try {
    gens.push(await importGeneration(root));
    const fs = realFsService();
    const file = join(root, 'live.md');
    await writeFile(file, '种子\n', 'utf8');
    const oldHost = gens[0].mod.createHost({ fs, log: SILENT_LOG });
    hosts.push(oldHost);
    const leasePath = join(root, 'host', 'native-worker-lease.js');
    const manifestPath = join(root, 'host.json');
    const original = await readFile(leasePath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const entry = manifest.files.find(f => f.path === 'native-worker-lease.js');
    assert(entry, 'host.json lists native-worker-lease.js');
    // 只改 host 字节，并按 sync-host 的公开格式（path/bytes/sha256）更新该条目。
    const changed = Buffer.concat([original, Buffer.from('\n// hot-reload generation marker\n', 'utf8')]);
    await writeFile(leasePath, changed);
    entry.bytes = changed.length;
    entry.sha256 = createHash('sha256').update(changed).digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    gens.push(await importGeneration(root));
    assert.notEqual(gens[1].mod.createHost, gens[0].mod.createHost);
    const fresh = gens[1].mod.createHost({ fs, log: SILENT_LOG });
    hosts.push(fresh);
    const opened = await fresh.dispatch('open', { path: file, live: true });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const ticket = opened.value.live;
    assert(typeof ticket?.client === 'string' && ticket.client, 'live ticket granted');
    const ex = await fresh.dispatch('live', {
      client: ticket.client, action: 'exchange',
      request: { epoch: ticket.epoch, version: ticket.version, seq: 1, changes: [{ from: 2, to: 2, insert: '加字' }] },
    });
    assert.equal(ex.ok, true, JSON.stringify(ex));
    const saved = await fresh.dispatch('save', {
      path: file, text: '种子加字\n', baseVersion: opened.value.version,
      live: { client: ticket.client, epoch: ex.value.epoch, version: ex.value.version },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(await readFile(file, 'utf8'), '种子加字\n');
    const still = await oldHost.dispatch('open', { path: file });
    assert.equal(still.ok, true, JSON.stringify(still));
  } finally {
    await teardown(root, hosts, gens);
  }
});

test('host 成员损坏/缺失时导入拒绝，旧宿主仍可用，恢复后可重导', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await makeInstance('broken');
  const hosts = [], gens = [];
  try {
    gens.push(await importGeneration(root));
    const fs = realFsService();
    const file = join(root, 'doc.md');
    await writeFile(file, '旧代号内容\n', 'utf8');
    const host = gens[0].mod.createHost({ fs, log: SILENT_LOG });
    hosts.push(host);
    // 损坏（装载链成员 live-documents.js 语法破坏）→ 导入必须拒绝。
    const livePath = join(root, 'host', 'live-documents.js');
    const originalLive = await readFile(livePath);
    await writeFile(livePath, 'this is ( not javascript');
    await assert.rejects(() => importGeneration(root));
    // 缺失（装载链成员 document-store.js 移除）→ 导入同样拒绝。
    const diskPath = join(root, 'host', 'document-store.js');
    const originalDisk = await readFile(diskPath);
    await rm(diskPath, { force: true });
    await assert.rejects(() => importGeneration(root));
    // 旧代号宿主不受影响，仍可读写。
    const still = await host.dispatch('open', { path: file });
    assert.equal(still.ok, true, JSON.stringify(still));
    const s = await host.dispatch('save', { path: file, text: '旧代号仍在写\n', baseVersion: still.value.version });
    assert.equal(s.ok, true, JSON.stringify(s));
    // 恢复字节后可再次导入。
    await writeFile(livePath, originalLive);
    await writeFile(diskPath, originalDisk);
    gens.push(await importGeneration(root));
    const revived = gens[1].mod.createHost({ fs, log: SILENT_LOG });
    hosts.push(revived);
    const r = await revived.dispatch('open', { path: file });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.text, '旧代号仍在写\n');
  } finally {
    await teardown(root, hosts, gens);
  }
});
