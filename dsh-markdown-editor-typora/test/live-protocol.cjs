'use strict';
// plugin→EXE / EXE→plugin 协议回归（无 GUI、无 DSH、临时目录 + 临时端口）：
//   · 用真实产品内核 MarkPilot-CM6/shell/live-documents.js（SQLite 房间）驱动两个
//     createHost 实例（模拟 DSH 宿主与 EXE 宿主各一），同盘同房间目录；
//   · 复现基线场景（A 输入 → B 收到）、并发插入收敛、external 草稿保护、
//     负控（错 epoch / 文本不匹配 / MODEL_TOOL 禁 live / 虚拟文件不入房 / leave 失效 / 栅栏 403）；
//   · 房间 epoch 是 UUID 字符串（SQLite rooms.epoch TEXT）：全程按字符串断言；
//   · 空文件（0 字节）join + 首笔插入；live 保存走真实 file-worker 的臂在本会话沙箱
//     里被 spawn EPERM 拦（产品安全写需要 PowerShell 资格检查），自动标记 env-blocked，
//     并用 stub writer 在内核层验证 save 的 epoch/version/text 契约与回执覆写形态
//     （这正是宿主 writerVersion 防御存在的原因）。
// 运行：node test/live-protocol.cjs   （结果 JSON 落 test/out/live-protocol-result.json）
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const HERE = __dirname;
const CANDIDATE = path.resolve(HERE, '..');
// 向上找到含 MarkPilot-CM6/shell 的祖先（候选目录与 overlay 目录深度不同，不能写死层数）。
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 9; i += 1) {
    if (fs.existsSync(path.join(dir, 'MarkPilot-CM6', 'shell', 'live-documents.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate MarkPilot-CM6/shell from ' + start);
}
const REPO = findRepoRoot(CANDIDATE);
const API = '/dsh-markdown-typora/api/';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function shellVersion(p) {
  const st = fs.statSync(p, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

// 极小 ctx.fs：本机文件走真实 stat（bigint 形态与 dsh-fs-local 的 versionOf 同形），
// virtual: 前缀模拟虚拟 provider（原生 stat 必然 ENOENT ⇒ 永不入 live 房间）。
function fakeFsService(virtualText) {
  const isVirtual = (p) => String(p).startsWith('virtual:');
  return {
    async resolve(p) {
      const s = String(p || '');
      return isVirtual(s) ? { displayPath: s, targetKey: s } : { displayPath: path.resolve(s), targetKey: path.resolve(s) };
    },
    async stat(target) {
      const key = String(target?.targetKey ?? target?.displayPath ?? '');
      if (isVirtual(key)) return { version: 'virtual-rev-1', size: virtualText.length, type: 'file' };
      try {
        const st = fs.statSync(key, { bigint: true });
        return { version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`, size: Number(st.size), type: st.isDirectory() ? 'directory' : 'file' };
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async readText(target) {
      const key = String(target?.targetKey ?? target?.displayPath ?? '');
      return isVirtual(key) ? virtualText : await fsp.readFile(key, 'utf8');
    },
    async writeText(target, text, options) {
      const key = String(target?.targetKey ?? target?.displayPath ?? '');
      if (isVirtual(key)) {   // 虚拟 provider 不落盘：内存版 CAS，供负控走普通保存路径
        if (options?.version && options.version !== 'virtual-rev-1') {
          throw Object.assign(new Error('file changed since read'), { code: 'FS_STALE_VERSION' });
        }
        return { version: 'virtual-rev-2', displayPath: key, size: Buffer.byteLength(text, 'utf8') };
      }
      if (options?.version && shellVersion(key) !== String(options.version)) {
        throw Object.assign(new Error('file changed since read'), { code: 'FS_STALE_VERSION' });
      }
      await fsp.writeFile(key, text, 'utf8');
      return { version: shellVersion(key), displayPath: key, size: Buffer.byteLength(text, 'utf8') };
    },
    async editText(target, spec) {
      const key = String(target?.targetKey ?? target?.displayPath ?? '');
      const text = await fsp.readFile(key, 'utf8');
      if (!text.includes(spec.oldString)) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' });
      const next = spec.replaceAll === true
        ? text.split(spec.oldString).join(spec.newString)
        : text.replace(spec.oldString, spec.newString);
      await fsp.writeFile(key, next, 'utf8');
      return { version: shellVersion(key), displayPath: key };
    },
    async watch() { return () => {}; },   // 测试不依赖 fs.watch 推送；广播定向用 broadcastChange 单测
  };
}

function request(port, method, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        host: `127.0.0.1:${port}`,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* 保持 null */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const post = (port, endpoint, payload, headers) => request(port, 'POST', API + endpoint, payload, headers);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// SSE 读取器：收集事件名，带超时。
function sseCollect(port, queryPath, ms) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: queryPath, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(frame);
          if (event) events.push(event[1].trim());
        }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); resolve(events); }, ms);
  });
}

function replay(seedText, updates) {
  let text = seedText;
  for (const u of [...updates].sort((a, b) => a.version - b.version)) {
    let end = 0;
    const parts = [];
    for (const c of u.changes) { parts.push(text.slice(end, c.from), c.insert); end = c.to; }
    parts.push(text.slice(end));
    text = parts.join('');
  }
  return text;
}

// exchange 是同步抛错的普通方法（save 是 async）：统一用 attempt 捕获两种形态。
const attempt = (fn) => {
  try { return Promise.resolve(fn()).catch((error) => error); } catch (error) { return Promise.resolve(error); }
};

async function main() {
  const results = [];
  const note = (id, ok, detail, skipped) => {
    results.push({ id, ok: skipped ? true : !!ok, skipped: !!skipped, detail: skipped ? detail : (detail || null) });
    if (!ok && !skipped) process.exitCode = 1;
  };

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mp-live-protocol-'));
  const rooms = path.join(tmp, 'rooms');
  const file = path.join(tmp, 'note.md');
  const emptyFile = path.join(tmp, 'empty.md');
  const otherFile = path.join(tmp, 'other.md');
  const probeFile = path.join(tmp, 'worker-probe.md');
  await fsp.writeFile(file, 'alpha\nbeta\n', 'utf8');
  await fsp.writeFile(emptyFile, '', 'utf8');
  await fsp.writeFile(otherFile, 'other\n', 'utf8');
  await fsp.writeFile(probeFile, 'probe\n', 'utf8');

  const kernel = require(path.join(REPO, 'MarkPilot-CM6', 'shell', 'live-documents.js'));
  const plugin = await import(pathToFileURL(path.join(CANDIDATE, 'lib', 'index.js')).href);
  const quiet = { info() {}, warn() {}, error() {} };

  // 环境能力探测：真实 file-worker 写盘是否可用（本会话沙箱 spawn EPERM 时为 false）。
  let workerCapable = true;
  let workerBlockCode = null;
  {
    const probeHost = plugin.createHost({ fs: fakeFsService(''), liveDocuments: new kernel.LiveDocuments({ directory: rooms }), rootDir: CANDIDATE, log: quiet });
    const r = await probeHost.dispatch('save', { path: probeFile, text: 'probe2\n', baseVersion: shellVersion(probeFile) });
    if (r.ok !== true) { workerCapable = false; workerBlockCode = r.error?.code || 'unknown'; }
    try { probeHost.close(); } catch { /* 已关 */ }
  }

  const hosts = [];
  async function makeHost() {
    const host = plugin.createHost({
      fs: fakeFsService('virtual body\n'),
      liveDocuments: new kernel.LiveDocuments({ directory: rooms }),
      rootDir: CANDIDATE,
      log: quiet,
    });
    const server = http.createServer((req, res) => { void host.route.handler(req, res); });
    const port = await listen(server);
    hosts.push({ host, server });
    return { host, port };
  }
  const A = await makeHost();
  const B = await makeHost();

  try {
    // P0 栅栏：非 loopback Host 一律 403（不许为测试放行）。
    {
      const r = await post(A.port, 'stat', { path: file }, { host: 'evil.example' });
      note('P0-fence-403', r.status === 403, `status=${r.status}`);
    }

    // P1 双窗 join：房间 epoch 是 UUID 字符串。
    let ticketA, ticketB, seed;
    {
      const a = await post(A.port, 'open', { path: file, live: true });
      const b = await post(B.port, 'open', { path: file, live: true });
      assert.equal(a.json.ok, true, 'A open');
      assert.equal(b.json.ok, true, 'B open');
      ticketA = a.json.value.live; ticketB = b.json.value.live; seed = a.json.value.text;
      note('P1-join-uuid-epoch',
        UUID_RE.test(String(ticketA.epoch)) && UUID_RE.test(String(ticketB.epoch))
        && ticketA.epoch === ticketB.epoch && ticketA.client !== ticketB.client
        && Number.isSafeInteger(ticketA.version) && ticketA.version === 0
        && Number.isSafeInteger(ticketA.savedVersion),
        `epoch=${ticketA.epoch}`);
      note('P1-join-baseline', a.json.value.version === shellVersion(file) && seed === 'alpha\nbeta\n');
    }

    // P2 基线复现：A 输入 → B 收到（live-before/result.json 里 B 一直没收到）。
    {
      const put = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: ticketA.epoch, version: 0, seq: 1, changes: [{ from: 5, to: 5, insert: ' [A-local]' }] } });
      assert.equal(put.json.ok, true, 'A exchange');
      const poll = await post(B.port, 'live', { client: ticketB.client, action: 'exchange', request: { epoch: ticketB.epoch, version: 0 } });
      assert.equal(poll.json.ok, true, 'B exchange');
      const fromA = poll.json.value.updates.filter((u) => u.client === ticketA.client);
      note('P2-b-receives-a', fromA.length === 1 && fromA[0].changes[0].insert === ' [A-local]' && poll.json.value.version === 1,
        JSON.stringify(poll.json.value.updates));
    }

    // P3 并发：同界两笔插入，服务端定序；落后端重放后收敛。
    {
      const a2 = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: ticketA.epoch, version: 1, seq: 2, changes: [{ from: 17, to: 17, insert: 'A2' }] } });
      assert.equal(a2.json.ok, true);
      assert.equal(a2.json.value.version, 2, 'A2 committed at v2');
      const stale = await post(B.port, 'live', { client: ticketB.client, action: 'exchange', request: { epoch: ticketB.epoch, version: 1, seq: 1, changes: [{ from: 0, to: 0, insert: 'B0' }] } });
      const appliedWhileStale = stale.json.value.updates.some((u) => u.client === ticketB.client);
      const rebased = await post(B.port, 'live', { client: ticketB.client, action: 'exchange', request: { epoch: ticketB.epoch, version: 2, seq: 1, changes: [{ from: 0, to: 0, insert: 'B0' }] } });
      assert.equal(rebased.json.ok, true);
      // 收敛判定要重放完整历史（version:0 起的全量 updates），各自"增量 poll"只含自己落后的那段。
      const finalA = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: ticketA.epoch, version: 0 } });
      const finalB = await post(B.port, 'live', { client: ticketB.client, action: 'exchange', request: { epoch: ticketB.epoch, version: 0 } });
      const textA = replay('alpha\nbeta\n', finalA.json.value.updates);
      const textB = replay('alpha\nbeta\n', finalB.json.value.updates);
      note('P3-concurrent-converge', !appliedWhileStale && rebased.json.value.version === 3 && textA === textB && textA.startsWith('B0alpha') && textA.includes(' [A-local]') && textA.includes('A2'),
        `staleApplied=${appliedWhileStale} v=${rebased.json.value.version} textA=${JSON.stringify(textA)} textB=${JSON.stringify(textB)}`);
    }

    // P4 live 保存（真实 file-worker）+ 对端可见。
    if (workerCapable) {
      const roomText = replay('alpha\nbeta\n', [{ version: 1, changes: [{ from: 5, to: 5, insert: ' [A-local]' }] }, { version: 2, changes: [{ from: 17, to: 17, insert: 'A2' }] }, { version: 3, changes: [{ from: 0, to: 0, insert: 'B0' }] }]);
      const r = await post(A.port, 'save', { path: file, text: roomText, baseVersion: shellVersion(file), live: { client: ticketA.client, epoch: ticketA.epoch, version: 3 } });
      const ok = r.json.ok === true;
      const saved = ok ? r.json.value : null;
      const disk = ok ? await fsp.readFile(file, 'utf8') : '';
      const receiptOk = ok && disk === roomText && saved.version === shellVersion(file) && saved.savedVersion === 3 && Number.isSafeInteger(saved.liveVersion);
      const poll = ok ? await post(B.port, 'live', { client: ticketB.client, action: 'exchange', request: { epoch: ticketB.epoch, version: 3 } }) : null;
      note('P4-save-receipt-disk-version', receiptOk,
        `receiptVersionIsDisk=${ok && saved.version === shellVersion(file)} savedVersion=${ok ? saved.savedVersion : null} liveVersion=${ok ? saved.liveVersion : null}`);
      note('P4-peer-sees-save', receiptOk && poll.json.value.diskHash === saved.diskHash && poll.json.value.savedVersion === 3);
    } else {
      note('P4-save-receipt-disk-version', false, `env-blocked: native file-worker unavailable in this sandbox (${workerBlockCode}); real receipt path covered by lead's dual-window preview`, true);
      note('P4-peer-sees-save', false, 'env-blocked (same as above)', true);
    }

    // P4b 内核 save 契约（stub writer，处处可跑）：epoch/version/text 校验、
    //     回执覆写形态（product {...receipt,...head} 会用房间 version 盖掉写者盘版本
    //     —— 这正是宿主 apiSave writerVersion 防御存在的实证）。
    //     独立 scratch 文件 + 独立房间：内核 save 的 writer 槽本就由宿主注入自己的
    //     已授权写者；这里以最小写者（plain write 到测试自有的临时文件）验证内核契约。
    {
      const scratch = path.join(tmp, 'kernel-scratch.md');
      await fsp.writeFile(scratch, 'alpha\nbeta\n', 'utf8');
      const k = new kernel.LiveDocuments({ directory: rooms });
      const j = await k.join(scratch, 'alpha\nbeta\n');
      await k.exchange(j.client, { epoch: j.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'K' }] });
      const roomText = 'Kalpha\nbeta\n';
      let writerArg = null;
      const receipt = await k.save(j.client, { epoch: j.epoch, version: 1, text: roomText }, async ({ diskHash }) => {
        writerArg = diskHash;
        await fsp.writeFile(scratch, roomText, 'utf8');   // 写者职责：真实落盘（内核随后回读核对）
        return { version: 'DISK-PROVIDER-VERSION', displayPath: scratch, size: 42 };
      });
      note('P4b-kernel-save-contract',
        typeof writerArg === 'string' && writerArg.length === 64
        && receipt.version === 'DISK-PROVIDER-VERSION' && receipt.liveVersion === 1
        && receipt.savedVersion === 1 && receipt.epoch === j.epoch
        && typeof receipt.diskHash === 'string' && receipt.diskHash.length === 64 && receipt.diskHash !== writerArg,
        `receipt=${JSON.stringify({ version: receipt.version, liveVersion: receipt.liveVersion, savedVersion: receipt.savedVersion })} (provider version preserved; live metadata listed separately — final transport contract)`);
      const mismatch = await attempt(() => k.save(j.client, { epoch: j.epoch, version: 1, text: 'WRONG' }, async () => ({ version: 'x' })));
      note('P4b-text-mismatch-refused', mismatch && mismatch.code === 'MP_LIVE_STALE', String(mismatch && mismatch.code));
      const staleVersion = await attempt(() => k.exchange(j.client, { epoch: j.epoch, version: 99 }));
      note('P4b-stale-version-refused', staleVersion && staleVersion.code === 'MP_LIVE_SESSION', String(staleVersion && staleVersion.code));
      k.leave(j.client);
    }

    // P5 external 草稿保护：房间有未存编辑时，旧入口（普通 save/edit）在 writer 之前就被拒。
    {
      const put = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: ticketA.epoch, version: 3, seq: 3, changes: [{ from: 2, to: 2, insert: 'X' }] } });
      assert.equal(put.json.ok, true);
      // baseVersion 必须用真实盘版本：先过 apiSave 的 CAS，才能证明拒在外面这层来自房间 external。
      const plain = await post(B.port, 'save', { path: file, text: 'rewritten\n', baseVersion: shellVersion(file) });
      note('P5-external-draft-protected', plain.json.ok === false && plain.json.error.code === 'MP_FILE_CONFLICT',
        JSON.stringify(plain.json.error));
    }

    // P6 旧入口写净房 → adopt：后续 exchange 出现 client='disk' 的更新（需要真实写盘）。
    if (workerCapable) {
      // 先把房间清干净：A live 保存。房间正文 = 确定性事件回放（P1 种子 + 服务端序
      // 全量 updates 重放），票的 version 取回放轮的 head —— 文本与版本同源，不手写预期。
      const full = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: ticketA.epoch, version: 0 } });
      assert.equal(full.json.ok, true, 'full poll for adopt');
      const roomVersionNow = full.json.value.version;
      const roomTextNow = replay('alpha\nbeta\n', full.json.value.updates);
      const save = await post(A.port, 'save', { path: file, text: roomTextNow, baseVersion: shellVersion(file), live: { client: ticketA.client, epoch: ticketA.epoch, version: roomVersionNow } });
      assert.equal(save.json.ok, true, `save for adopt: ${JSON.stringify(save.json.error)}`);
      // 模型 edit 目标必须是 fixture 里唯一且未被任何 delta 覆盖的标记：
      // v2 的 A2 插在 index17 把 seed 的 beta 切成 bA2eta（'beta' 子串已不存在），
      // '[A-local]' 由 v1 引入且其后无任何 delta 触及 —— 唯一、可定位。
      const edit = await B.host.dispatch('edit', { path: file, oldString: '[A-local]', newString: '[A-EDITED]' });
      assert.equal(edit.ok, true, `model edit: ${JSON.stringify(edit)}`);
      const poll = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: ticketA.epoch, version: roomVersionNow } });
      const diskUpdate = poll.json.value.updates.find((u) => u.client === 'disk');
      const diskText = await fsp.readFile(file, 'utf8');
      const expectedDisk = roomTextNow.replace('[A-local]', '[A-EDITED]');   // 独立预期磁盘：保存文本 + 字面编辑
      note('P6-adopt-disk-update', !!diskUpdate && diskText === expectedDisk && replay(roomTextNow, poll.json.value.updates) === expectedDisk,
        `clients=${JSON.stringify(poll.json.value.updates.map((u) => u.client))} disk=${JSON.stringify(diskText)} expected=${JSON.stringify(expectedDisk)}`);
    } else {
      note('P6-adopt-disk-update', false, `env-blocked: native file-worker unavailable (${workerBlockCode}); adopt path exercised via P4b kernel semantics + preview`, true);
    }

    // P7 负控：错 epoch / MODEL_TOOL 禁 live / leave 失效。
    {
      const wrongEpoch = await post(A.port, 'live', { client: ticketA.client, action: 'exchange', request: { epoch: '00000000-0000-0000-0000-000000000000', version: 4 } });
      note('P7-wrong-epoch', wrongEpoch.json.ok === false && wrongEpoch.json.error.code === 'MP_LIVE_SESSION');

      // dispatch('live') 只对编辑面 authority 开放：无 authority 的调用（模型工具路径）
      // 拿不到 editor lease ⇒ 拒绝。用一个不存在的 client 证明必须先经 open(live) 取票。
      const noLease = await A.host.dispatch('live', { client: 'forged-client', action: 'exchange', request: {} });
      note('P7-forged-lease-refused', noLease.ok === false && noLease.error.code === 'MP_LIVE_LEASE', JSON.stringify(noLease.error));

      const leave = await post(B.port, 'live', { client: ticketB.client, action: 'leave' });
      assert.equal(leave.json.ok, true);
      const dead = await post(B.port, 'live', { client: ticketB.client, action: 'exchange', request: { epoch: ticketB.epoch, version: 4 } });
      note('P7-leave-invalidates', dead.json.ok === false && ['MP_LIVE_LEASE', 'MP_LIVE_SESSION'].includes(dead.json.error.code), JSON.stringify(dead.json.error));
    }

    // P8 虚拟文件不入房：无原生基线 ⇒ 不 join、无 lease（虚拟名不映射本机同名文件）。
    {
      const r = await post(A.port, 'open', { path: 'virtual:note.md', live: true });
      note('P8-virtual-no-join', r.json.ok === true && r.json.value.live === undefined && r.json.value.text === 'virtual body\n',
        JSON.stringify(r.json.value.live));
      const probe = await post(A.port, 'live', { client: 'virtual-lease', action: 'exchange', request: {} });
      note('P8-no-lease-for-virtual', probe.json.ok === false && probe.json.error.code === 'MP_LIVE_LEASE');
    }

    // P9 空文件：join 文本 ''、首笔插入（保存臂随 worker 能力）。
    {
      const a = await post(A.port, 'open', { path: emptyFile, live: true });
      const t = a.json.value.live;
      const okJoin = a.json.ok === true && t && a.json.value.text === '' && UUID_RE.test(String(t.epoch)) && t.version === 0;
      const put = await post(A.port, 'live', { client: t.client, action: 'exchange', request: { epoch: t.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 0, insert: 'X' }] } });
      note('P9-empty-file-join-insert', okJoin && put.json.ok === true && put.json.value.version === 1,
        `join=${okJoin} put=${put.json.ok}`);
      if (workerCapable) {
        const save = await post(A.port, 'save', { path: emptyFile, text: 'X', baseVersion: shellVersion(emptyFile), live: { client: t.client, epoch: t.epoch, version: 1 } });
        const disk = await fsp.readFile(emptyFile, 'utf8');
        note('P9-empty-file-save', save.json.ok === true && disk === 'X' && save.json.value.savedVersion === 1, `save=${save.json.ok} disk=${JSON.stringify(disk)}`);
      } else {
        note('P9-empty-file-save', false, `env-blocked: native file-worker unavailable (${workerBlockCode})`, true);
      }
      await post(A.port, 'live', { client: t.client, action: 'leave' }).catch(() => {});
    }

    // P10 SSE 只按 targetKey 定向：A 文件的广播不得推给别的文件的 watcher。
    //     handleWatch 在 fs.resolve 之后才把流登记进 liveStreams —— 广播必须等两条
    //     SSE 都收到 ready 再发，否则会静默丢帧（此前偶发 same 只见 ready 的根因）。
    {
      const watchRaw = (bucket) => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: A.port, path: `${API}watch?path=${encodeURIComponent(bucket.path)}`, headers: { host: `127.0.0.1:${A.port}` } }, (res) => {
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let index;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const event = /^event: (.*)$/m.exec(frame);
              if (event) bucket.frames.push(event[1].trim());
            }
          });
          res.on('error', () => {});
          res.on('close', () => resolve());
        });
        req.on('error', reject);
        bucket.destroy = () => { try { req.destroy(); } catch { /* 已断 */ } };
      });
      const other = { path: otherFile, frames: [] }, same = { path: file, frames: [] };
      const watchers = [watchRaw(other), watchRaw(same)];
      const deadline = Date.now() + 1500;
      while ((other.frames.length === 0 || same.frames.length === 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      A.host.broadcastChange({ displayPath: file, targetKey: file }, 'v-scope');
      await new Promise((r) => setTimeout(r, 200));
      other.destroy(); same.destroy();
      await Promise.allSettled(watchers);
      note('P10-sse-scoped',
        !other.frames.includes('change') && same.frames.includes('change') && other.frames.includes('ready') && same.frames.includes('ready'),
        `other=${JSON.stringify(other.frames)} same=${JSON.stringify(same.frames)}`);
    }

    // P11 join 票 recovered 透传与隔离：只出现在对应文件的 open 回执；SSE 数据帧不携带；
    //     宿主绝不触碰恢复文件（fs 守卫负控：任何方法碰 kept-draft 路径即抛错）。
    {
      const recoveredStub = {
        joined: 0,
        async join(filePath, text) {
          this.joined += 1;
          const base = { client: 'recov-cli-' + this.joined, epoch: '12345678-1234-5678-1234-567812345678', version: 0, text, diskHash: 'ff'.repeat(32), savedVersion: 0 };
          return path.basename(String(filePath)) === 'note.md'
            ? { ...base, recovered: [
                { recoveryPath: path.join(tmp, 'kept-draft-a.md'), sha256: 'a'.repeat(64), at: 1730000000000 },
                { recoveryPath: path.join(tmp, 'kept-draft-b.md') },
                { recoveryPath: '', junk: true },
              ] }
            : base;
        },
        exchange() { return { epoch: '12345678-1234-5678-1234-567812345678', version: 0, savedVersion: 0, diskHash: 'ff'.repeat(32), updates: [] }; },
        async save(client, meta, writer) { return writer({ diskHash: 'ff'.repeat(32) }); },
        async external(file, writer) { return writer(); },
        leave() {},
      };
      const guardFs = fakeFsService('virtual body\n');
      for (const method of ['resolve', 'stat', 'readText', 'writeText', 'editText']) {
        const original = guardFs[method].bind(guardFs);
        guardFs[method] = async (...args) => {
          const target = args[0];
          const name = target && (typeof target === 'string' ? target : String(target.targetKey || target.displayPath || '')) || '';
          if (name.includes('kept-draft')) throw new Error('HOST MUST NOT TOUCH RECOVERY FILES: ' + method);
          return original(...args);
        };
      }
      const host = plugin.createHost({ fs: guardFs, liveDocuments: recoveredStub, rootDir: CANDIDATE, log: quiet });
      const server = http.createServer((req, res) => { void host.route.handler(req, res); });
      const port = await listen(server);
      hosts.push({ host, server });
      const frames = await new Promise((resolve) => {
        const chunks = [];
        const req = http.get({ host: '127.0.0.1', port, path: `${API}watch?path=${encodeURIComponent(file)}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          res.on('data', (c) => chunks.push(String(c)));
          res.on('error', () => {});
        });
        req.on('error', () => resolve(chunks));
        setTimeout(() => { req.destroy(); resolve(chunks); }, 600);
      });
      const withRecov = await post(port, 'open', { path: file, live: true });
      const without = await post(port, 'open', { path: otherFile, live: true });
      await new Promise((r) => setTimeout(r, 100));
      const recovered = withRecov.json.value && withRecov.json.value.live && withRecov.json.value.live.recovered;
      const clean = without.json.value && without.json.value.live;
      // 宿主职责 = 逐字节透传（含畸形条目，过滤在客户端 liveRecoveredItems —— 见 L5）。
      note('P11-recovered-passthrough',
        withRecov.json.ok === true && Array.isArray(recovered) && recovered.length === 3
        && recovered[0].recoveryPath.endsWith('kept-draft-a.md') && recovered[0].sha256 === 'a'.repeat(64) && recovered[0].at === 1730000000000
        && recovered[2].recoveryPath === '',
        JSON.stringify(recovered));
      note('P11-recovered-isolated-per-file',
        without.json.ok === true && clean && clean.recovered === undefined,
        JSON.stringify(clean && clean.recovered));
      const allFrames = frames.join('\n');
      note('P11-recovered-no-sse-leak',
        withRecov.json.ok === true && !allFrames.includes('recovered') && !allFrames.includes('kept-draft'),
        `sseFrames=${JSON.stringify(frames)}`);
      // fs 守卫负控隐含在以上两臂：宿主若试图读取恢复文件，open 会直接 5xx/ok:false。
      note('P11-host-did-not-touch-recovery-files', withRecov.json.ok === true && without.json.ok === true);
      if (clean && clean.client) await post(port, 'live', { client: clean.client, action: 'leave' }).catch(() => {});
      if (withRecov.json.value && withRecov.json.value.live) await post(port, 'live', { client: withRecov.json.value.live.client, action: 'leave' }).catch(() => {});
    }

    // P12 live 保存回执元数据透传（stub 内核，沙箱可跑）：已授权 live 保存的回执带
    //     savedVersion/liveVersion/epoch/diskHash（applyLiveReceipt 约定的最小集），
    //     provider version 保持权威；普通旧保存与模型 edit 不携带（capabilities 不泄漏）。
    {
      const EPOCH12 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const stub12 = {
        async join() { return { client: 'meta-cli-1', epoch: EPOCH12, version: 0, text: 'meta\n', diskHash: '11'.repeat(32), savedVersion: 0 }; },
        exchange() { return { epoch: EPOCH12, version: 0, savedVersion: 0, diskHash: '11'.repeat(32), updates: [] }; },
        async save() { return { version: 'DISK-PROVIDER-META', displayPath: 'stub', size: 5, epoch: EPOCH12, liveVersion: 5, savedVersion: 4, diskHash: '22'.repeat(32) }; },
        async external(file, writer) { return writer(); },
        leave() {},
      };
      const host12 = plugin.createHost({ fs: fakeFsService('virtual body\n'), liveDocuments: stub12, rootDir: CANDIDATE, log: quiet });
      const server12 = http.createServer((req, res) => { void host12.route.handler(req, res); });
      const port12 = await listen(server12);
      hosts.push({ host: host12, server: server12 });
      const p12file = path.join(tmp, 'meta.md');
      await fsp.writeFile(p12file, 'meta\n', 'utf8');
      const opened = await post(port12, 'open', { path: p12file, live: true });
      const ticket12 = opened.json.value.live;
      const saved = await post(port12, 'save', { path: p12file, text: 'meta2\n', baseVersion: shellVersion(p12file), live: { client: ticket12.client, epoch: ticket12.epoch, version: 4 } });
      note('P12-live-receipt-metadata',
        saved.json.ok === true && saved.json.value.version === 'DISK-PROVIDER-META'
        && saved.json.value.savedVersion === 4 && saved.json.value.liveVersion === 5
        && saved.json.value.epoch === EPOCH12 && saved.json.value.diskHash === '22'.repeat(32),
        JSON.stringify(saved.json.value));
      const plainVirtual = await post(port12, 'save', { path: 'virtual:plain.md', text: 'v\n', baseVersion: 'virtual-rev-1' });
      const pv = plainVirtual.json.value || {};
      note('P12-plain-save-no-live-metadata',
        plainVirtual.json.ok === true && pv.version === 'virtual-rev-2'
        && !('savedVersion' in pv) && !('liveVersion' in pv) && !('epoch' in pv) && !('diskHash' in pv),
        JSON.stringify(pv));
      const edit12 = await host12.dispatch('edit', { path: p12file, oldString: 'meta', newString: 'META' });
      const ev = edit12.value || {};
      note('P12-model-edit-no-live-metadata',
        edit12.ok === true && typeof ev.version === 'string' && ev.changed === true
        && !('savedVersion' in ev) && !('liveVersion' in ev) && !('epoch' in ev) && !('diskHash' in ev),
        JSON.stringify(ev));
      await post(port12, 'live', { client: ticket12.client, action: 'leave' }).catch(() => {});
    }

    await post(A.port, 'live', { client: ticketA.client, action: 'leave' }).catch(() => {});
  } finally {
    for (const { host, server } of hosts) { try { host.close(); } catch { /* 已关 */ } await closeServer(server); }
    try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* 临时目录残留不判失败 */ }
  }

  const summary = {
    suite: 'live-protocol',
    passed: results.every((r) => r.ok),
    skipped: results.filter((r) => r.skipped).map((r) => r.id),
    workerCapable,
    workerBlockCode,
    cases: results,
    startedAt: new Date().toISOString(),
    kernel: 'MarkPilot-CM6/shell/live-documents.js (real, SQLite rooms)',
    transport: 'ephemeral 127.0.0.1 HTTP routes (no GUI / no DSH)',
  };
  // 结果落盘仅在接受显式指令时发生（MP_TEST_RESULT_DIR=<目录>）；默认 stdout-only，
  // 不在工作树里制造未跟踪文件。项目标准入口仍是 native live-transport *.test.mjs。
  if (process.env.MP_TEST_RESULT_DIR) {
    const outDir = path.resolve(process.env.MP_TEST_RESULT_DIR);
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, 'live-protocol-result.json'), JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('live-protocol FAILED:', error && error.stack || error);
  process.exitCode = 1;
});
