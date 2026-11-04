// 冷路径单助手（两段资格验证、一次 PowerShell 进程）原生测试。
// 运行：node test/live-lease-cold.test.mjs（仅 Windows；需真实 spawn 权限）
// 夹具不依赖旁边历史仓、不假定首个 base 候选：C0 用当前 classic vs handshake
// 自比（可选 MP_OLD_PS1 指向已验证正本才做逐字比对）；C4 先从真实 base report
// 取得通过校验的 base 再在其下建合法唯一租约目录；C5 用 junction（免提升、同为
// reparse 拒绝路径）。C7 用确定性 stub 助手覆盖 parser 同 chunk 多帧/早到帧。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, '../../MarkPilot-CM6/shell');
const win32 = process.platform === 'win32';
const ps1New = path.join(shellDir, 'native-worker-path.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const encoded = script => Buffer.from(script, 'utf16le').toString('base64');
const runClassic = envLease => cp.spawnSync(powershell,
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(fsSync.readFileSync(ps1New, 'utf8'))],
  { windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, MP_NATIVE_LEASE_PATH: envLease || '', MP_NATIVE_LEASE_HANDSHAKE: '' } });
const runHandshake = input => cp.spawnSync(powershell,
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(fsSync.readFileSync(ps1New, 'utf8'))],
  { windowsHide: true, input, encoding: 'utf8', timeout: 20000, env: { ...process.env, MP_NATIVE_LEASE_HANDSHAKE: '1', MP_NATIVE_LEASE_PATH: '' } });
const frameFor = dir => 'LEASE\t' + Buffer.from(dir, 'utf16le').toString('base64') + '\n';
// 真实通过校验的 base（不假定首个候选；探针环境的 LOCALAPPDATA 可能是私有批次根）
async function verifiedBase() {
  const r = runClassic('');
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout.replace(/^\ufeff/, ''));
  assert.match(report.base, /^[A-Za-z]:\\/);
  return report;
}
async function leaseDirUnder(base) {
  return fsp.mkdtemp(path.join(base, 'MarkPilot-file-' + process.pid + '-'));
}
const waitExited = async (child, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return child.exitCode !== null || child.signalCode !== null;
};

test('C0 classic 与 handshake Q1 自比（base/sid/checks 一致；可选正本逐字比对）', { skip: !win32, timeout: 30000 }, async () => {
  const classic = await verifiedBase();
  const hs = runHandshake('');
  assert.equal(hs.status, 0, hs.stderr);
  const lines = hs.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines[0].slice(0, 3), 'Q1 ');
  assert.equal(lines[lines.length - 1], 'END');
  const q1 = JSON.parse(lines[0].slice(3));
  assert.equal(q1.base, classic.base, 'handshake Q1 与 classic 的 base 一致（本机真实验证过的 base）');
  assert.equal(q1.sid, classic.sid, 'SID 即当前进程真实 SID');
  assert.deepEqual(q1.checks.map(c => c.path), classic.checks.map(c => c.path), 'ACL 检查路径序列一致');
  const old = process.env.MP_OLD_PS1;
  if (old && fsSync.existsSync(old)) {
    const r = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(fsSync.readFileSync(old, 'utf8'))],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, MP_NATIVE_LEASE_PATH: '', MP_NATIVE_LEASE_HANDSHAKE: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.replace(/^\ufeff/, ''), runClassic('').stdout.replace(/^\ufeff/, ''), '显式指定的正本逐字等价');
  }
});

test('C1 真冷阶段恰好一个 PowerShell：身份一致、清理无残留、助手退出', { skip: !win32, timeout: 45000 }, async () => {
  const realSpawn = cp.spawn;
  const psChildren = [];
  cp.spawn = (exe, args, opts) => {
    const child = realSpawn(exe, args, opts);
    if (path.basename(String(exe)).toLowerCase() === 'powershell.exe') psChildren.push(child);
    return child;
  };
  try {
    const { createNativeWorkerLease } = require(path.join(shellDir, 'native-worker-lease.js'));
    const lease = await createNativeWorkerLease();
    assert.equal(psChildren.length, 1, '冷启动必须只拉起一个 PowerShell（两段同助手）');
    assert.ok(lease.qualification && typeof lease.qualification.base === 'string' && lease.qualification.sid);
    assert.equal(path.resolve(lease.qualification.lease).toLowerCase(), path.resolve(lease.directory).toLowerCase(), '第二段报告的 lease 即真实租约目录');
    assert.ok(lease.qualification.checks.some(entry => path.resolve(entry.path).toLowerCase() === path.resolve(lease.directory).toLowerCase()), '第二段检查覆盖租约目录本身');
    await lease.cleanup();
    assert.equal(await fsp.stat(lease.directory).then(() => true, () => false), false, '清理后无租约目录残留');
    for (const child of psChildren) assert(child.exitCode !== null || child.signalCode !== null, '助手必须已退出');
  } finally { cp.spawn = realSpawn; }
});

test('C2 伪造租约被原规则拒绝；Node 中途失败不留子进程、无残留', { skip: !win32, timeout: 45000 }, async () => {
  const base = (await verifiedBase()).base;
  const forged = path.join(base, 'MarkPilot-file-eviltag');
  await fsp.mkdir(forged, { recursive: true }).catch(() => {});
  try {
    const r = runHandshake(frameFor(forged));
    assert.notEqual(r.status, 0, '伪造租约必须以非零码失败');
    assert.ok(!/^Q2 /m.test(r.stdout), '不得输出第二段报告');
  } finally { await fsp.rm(forged, { recursive: true, force: true }).catch(() => {}); }

  const realSpawn = cp.spawn;
  const psChildren = [];
  cp.spawn = (exe, args, opts) => {
    const child = realSpawn(exe, args, opts);
    if (path.basename(String(exe)).toLowerCase() === 'powershell.exe') psChildren.push(child);
    return child;
  };
  const realMkdtemp = fsp.mkdtemp;
  fsp.mkdtemp = async () => { throw Object.assign(new Error('injected mkdtemp failure'), { code: 'EACCES' }); };
  try {
    const leaseModule = path.join(shellDir, 'native-worker-lease.js');
    delete require.cache[require.resolve(leaseModule)];
    const { createNativeWorkerLease } = require(leaseModule);
    await assert.rejects(createNativeWorkerLease(), error => error.code === 'MP_NATIVE_WORKER_PATH' || /injected mkdtemp failure/.test(error.message));
    for (const child of psChildren) assert(await waitExited(child), '中途失败不得遗留 PowerShell 子进程');
  } finally {
    fsp.mkdtemp = realMkdtemp;
    cp.spawn = realSpawn;
    delete require.cache[require.resolve(path.join(shellDir, 'native-worker-lease.js'))];
  }
});

test('C3 stdin EOF（父进程退出语义）→ 助手输出 Q1+END 后立即退出', { skip: !win32, timeout: 30000 }, () => {
  const r = runHandshake('');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines[0].slice(0, 3), 'Q1 ');
  assert.equal(lines[lines.length - 1], 'END');
  assert.equal(lines.length, 2, 'EOF 后不得产生第二段报告');
});

test('C4 旱到/合并帧：LEASE 帧先于 Q1 读取写入，输出仍严格 Q1→Q2→END（真实验证 base 下建租约）', { skip: !win32, timeout: 30000 }, async () => {
  const base = (await verifiedBase()).base;
  const dir = await leaseDirUnder(base);
  try {
    const child = cp.spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(fsSync.readFileSync(ps1New, 'utf8'))],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MP_NATIVE_LEASE_HANDSHAKE: '1', MP_NATIVE_LEASE_PATH: '' } });
    // 帧早到：不等 Q1，立即写入租约帧（助手会先完成 Q1 再读取 stdin）
    child.stdin.write(frameFor(dir));
    const [code, transcript] = await new Promise(resolve => {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('close', c => resolve([c, out]));
    });
    assert.equal(code, 0);
    const lines = transcript.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 3, '恰好三帧：' + JSON.stringify(lines));
    assert.ok(lines[0].startsWith('Q1 ') && lines[1].startsWith('Q2 ') && lines[2] === 'END', '顺序严格 Q1→Q2→END');
    const q2 = JSON.parse(lines[1].slice(3));
    assert.equal(path.resolve(q2.lease).toLowerCase(), path.resolve(dir).toLowerCase());
  } finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

test('C5 重绑定不写入：junction 租约 → 写前拒绝，目标保持为空且清理不穿 junction', { skip: !win32, timeout: 45000 }, async () => {
  const base = (await verifiedBase()).base;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mp-lease-c5-'));
  const dest = path.join(root, 'redirect-dest');
  await fsp.mkdir(dest);
  const realMkdtemp = fsp.mkdtemp;
  fsp.mkdtemp = async prefix => {
    const dir = await realMkdtemp(path.join(base, path.basename(prefix)));
    await fsp.rmdir(dir);
    // junction 同为 reparse point：无需提升权限即触发原重解析拒绝路径
    await fsp.symlink(dest, dir, 'junction');
    return dir;
  };
  try {
    const leaseModule = path.join(shellDir, 'native-worker-lease.js');
    delete require.cache[require.resolve(leaseModule)];
    const { createNativeWorkerLease } = require(leaseModule);
    await assert.rejects(createNativeWorkerLease(), error => /Worker lease redirected/.test(error.message));
    assert.deepEqual(await fsp.readdir(dest), [], '重绑定目标不得被写入任何内容（含辅助程序）');
    assert.equal(await fsp.stat(dest).then(() => true, () => false), true, '清理绝不递归穿过 junction 删除目标');
  } finally {
    fsp.mkdtemp = realMkdtemp;
    delete require.cache[require.resolve(path.join(shellDir, 'native-worker-lease.js'))];
    // 移除可能的残留 junction（本身），再清 root
    for (const entry of await fsp.readdir(base).catch(() => [])) {
      if (entry.startsWith('MarkPilot-file-' + process.pid + '-')) {
        const p = path.join(base, entry);
        const st = await fsp.lstat(p).catch(() => null);
        if (st?.isSymbolicLink()) await fsp.rm(p, { force: true }).catch(() => {});
      }
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('C6 第二段拒绝（命名不合规）：失败前目录为空且被清理，不产生 EXE', { skip: !win32, timeout: 45000 }, async () => {
  const base = (await verifiedBase()).base;
  const realMkdtemp = fsp.mkdtemp;
  let badDir = null;
  fsp.mkdtemp = async prefix => {
    badDir = path.join(path.dirname(prefix), 'MarkPilot-file-bad');
    await fsp.mkdir(badDir);
    return badDir;
  };
  try {
    const leaseModule = path.join(shellDir, 'native-worker-lease.js');
    delete require.cache[require.resolve(leaseModule)];
    const { createNativeWorkerLease } = require(leaseModule);
    await assert.rejects(createNativeWorkerLease(), error => error.code === 'MP_NATIVE_WORKER_PATH');
    assert.ok(badDir);
    assert.equal(await fsp.stat(badDir).then(() => true, () => false), false, '空目录在失败清理后移除');
  } finally {
    fsp.mkdtemp = realMkdtemp;
    delete require.cache[require.resolve(path.join(shellDir, 'native-worker-lease.js'))];
    if (badDir) await fsp.rm(badDir, { recursive: true, force: true }).catch(() => {});
  }
});

// C7 parser 确定性 stub：假助手（node -e）Q1 立即写出；收到 LEASE 帧后把
// Q2+END 用**同一次 stdout 写出**（同 chunk 多帧，确定性），或按延迟写出
// （readLine waiter 挂起路径）。产品 parser 与顺序核验全程真实运行。
const FAKE_HELPER = `
const base = process.env.MP_FAKE_BASE, sid = 'S-fake';
process.stdout.write('Q1 ' + JSON.stringify({base, lease: null, sid, checks: [{path: base}]}) + '\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  const m = input.match(/^LEASE\\t([A-Za-z0-9+/=]+)\\r?\\n/);
  if (m && !process.env.MP_FAKE_DONE) {
    process.env.MP_FAKE_DONE = '1';
    const dir = Buffer.from(m[1], 'base64').toString('utf16le');
    const q2 = 'Q2 ' + JSON.stringify({base, lease: dir, sid, checks: [{path: base}, {path: dir}]}) + '\\n';
    const emit = () => { process.stdout.write(q2 + 'END\\n'); process.exit(0); };
    const delay = Number(process.env.MP_FAKE_DELAY_MS || 0);
    if (delay > 0) setTimeout(emit, delay); else process.nextTick(emit);
  }
});
process.stdin.on('end', () => { if (!process.env.MP_FAKE_DONE) process.exit(0); });
`;
async function fakeLeaseRun(delayMs) {
  const realSpawn = cp.spawn;
  const leaseModule = path.join(shellDir, 'native-worker-lease.js');
  delete require.cache[require.resolve(leaseModule)];
  const fakeBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'mp-lease-c7-'));
  cp.spawn = (exe, args, opts) => realSpawn(process.execPath, ['-e', FAKE_HELPER], {
    ...opts,
    env: { ...opts?.env, MP_FAKE_BASE: fakeBase, MP_FAKE_DELAY_MS: String(delayMs) },
  });
  try {
    const { createNativeWorkerLease } = require(leaseModule);
    const lease = await createNativeWorkerLease();
    return { lease, fakeBase };
  } finally {
    cp.spawn = realSpawn;
    delete require.cache[require.resolve(leaseModule)];
  }
}

test('C7a parser 同 chunk 多帧：Q2+END 同一次写出，按序消费并通过全部核验', { skip: !win32, timeout: 30000 }, async () => {
  const { lease, fakeBase } = await fakeLeaseRun(0);
  try {
    assert.ok(lease.qualification && lease.qualification.lease, '完整租约返回（合并帧被按序消费）');
    await lease.cleanup();
  } finally { await fsp.rm(fakeBase, { recursive: true, force: true }).catch(() => {}); }
});

test('C7b parser 延迟帧：输出在 readLine 挂起后到达', { skip: !win32, timeout: 30000 }, async () => {
  const { lease, fakeBase } = await fakeLeaseRun(400);
  try {
    assert.ok(lease.qualification && lease.qualification.lease, '延迟帧经 waiter 路径正常消费');
    await lease.cleanup();
  } finally { await fsp.rm(fakeBase, { recursive: true, force: true }).catch(() => {}); }
});
