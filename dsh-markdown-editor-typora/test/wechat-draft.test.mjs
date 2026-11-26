// 公众号草稿 · DSH 可信宿主（lib/wechat-draft.js）行为测试。
//
// 纪律（与产品边界一致，逐条被下面的判据盯住）：
//   · **只用本机假传输**：transport 是注入的函数，测试进程不发任何真实网络请求；
//     并断言每一次调用的 URL 都落在 loopback 假基址上。
//   · **不读盘**：正文图/封面只接受随调用带入的 `data:` 字节；路径 / UNC / file: / http(s) 一律拒。
//   · **调用方自报位置不算授权**：payload 里的 dir/path/workspace/sessionId 一律被忽略。
//   · **只建草稿**：全程不能出现 freepublish / mass / delete / update 之类的端点。
//   · 结果不明确（超时 / 坏回包）⇒ 保留 pending，**未确认前不发请求、绝不自动重试**。
//   · 凭据只在宿主：有系统密钥库则加密落盘；没有则仅本进程内存并明确提示。
//
// 运行：node test/wechat-draft.test.mjs（= node --test 的等价本进程形态）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginWechatHost, imageInfoOf } from '../lib/wechat-draft.js';

/* 临时目录建在包内（test/.wx-test-tmp/）：受限沙箱下系统 temp 未必可写，包目录一定在会话语义内。
   整组目录在全部用例结束时删掉（含 write 工具建的占位），不留残留。 */
const TMP_ROOT = fileURLToPath(new URL('./.wx-test-tmp', import.meta.url));
async function makeTempDir(prefix) {
  await mkdir(TMP_ROOT, { recursive: true });
  return mkdtemp(join(TMP_ROOT, prefix));
}
after(async () => { await rm(TMP_ROOT, { recursive: true, force: true }); });

const MOCK_BASE = 'http://127.0.0.1:18081';     // loopback 假基址（永远不真的连上去）
const MOCK_ENV = { MP_TEST_HOOKS: '1', MP_WX_BASE_URL: MOCK_BASE };
const APP_ID = 'wx1234567890abcdef';
const SECRET = 'abcdef0123456789abcdef0123456789';
const FORBIDDEN = /freepublish|mass\/|delete|update|del_material|sendall/i;

/* ── 真 PNG / JPEG 字节（不是随机填充：尺寸要从 IHDR / SOF 里读出来）──────────── */

function makePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.from([0, 0, 0, 0x0d]);
  const ihdr = Buffer.from('IHDR', 'ascii');
  const w = Buffer.alloc(4); w.writeUInt32BE(width, 0);
  const h = Buffer.alloc(4); h.writeUInt32BE(height, 0);
  const depth = Buffer.from([8, 2, 0, 0, 0]);
  const tail = Buffer.alloc(24, 0x11);           // 占位的 IDAT/CRC 字节（判据只看头部）
  return Buffer.concat([signature, length, ihdr, w, h, depth, tail]);
}
function makeJpeg(width, height) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([soi, app0, sof, Buffer.from([0xff, 0xd9])]);
}
const dataUrlOf = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;
const PNG = makePng(320, 200);
const PNG_COVER = makePng(900, 500);
const JPEG_COVER = makeJpeg(640, 360);

/* ── 本机假微信（注入式传输：一个字节都不出网）────────────────────────────────── */

function createFakeWechat({ draftReply = 'ok' } = {}) {
  const calls = [];
  const transport = async (request) => {
    const url = new URL(request.url);
    const entry = {
      origin: url.origin, path: url.pathname, method: request.method,
      body: request.body, headers: request.headers || {},
    };
    calls.push(entry);
    const json = (value, status = 200) => ({ status, text: JSON.stringify(value) });
    switch (url.pathname) {
      case '/cgi-bin/stable_token': return json({ access_token: 'TOKEN-STABLE', expires_in: 7200 });
      case '/cgi-bin/token': return json({ access_token: 'TOKEN-LEGACY', expires_in: 7200 });
      case '/cgi-bin/draft/count': return json({ total: 7 });
      case '/cgi-bin/media/uploadimg': return json({ url: `https://mmbiz.qpic.cn/fake/${calls.length}.png` });
      case '/cgi-bin/material/add_material': return json({ media_id: 'COVER-MEDIA-1' });
      case '/cgi-bin/draft/add': {
        if (draftReply === 'timeout') throw Object.assign(new Error('connect timeout'), { code: 'MP_WX_TIMEOUT', timedOut: true });
        if (draftReply === 'network') throw Object.assign(new Error('socket hang up'), { code: 'MP_WX_NETWORK' });
        if (draftReply === 'badjson') return { status: 200, text: '<html>gateway</html>' };
        if (draftReply === 'reject') return json({ errcode: 45002, errmsg: 'content size out of limit' });
        return json({ media_id: 'DRAFT-MEDIA-1' });
      }
      default:
        // 未登记端点：直接失败，并让测试能看到"谁试图出格"。
        throw Object.assign(new Error('unregistered endpoint: ' + url.pathname), { code: 'MP_WX_ENDPOINT' });
    }
  };
  transport.calls = calls;
  return transport;
}

/** 一个测试用的宿主 + 临时 stateDir。 */
async function makeHost(t, { draftReply = 'ok', osProtect = null, env = MOCK_ENV } = {}) {
  const stateDir = await makeTempDir('plugin-');
  const transport = createFakeWechat({ draftReply });
  const host = createPluginWechatHost({ stateDir, env, transport, osProtect });
  t.after(async () => {
    try { host.dispose(); } catch { /* 已释放 */ }
    await rm(stateDir, { recursive: true, force: true });
  });
  return { host, stateDir, transport };
}

/** 一个"已认证用户 + 当前 tab 实例"的可信 scope 替身（真身由中心注入）。 */
function scopeOf(ownerId, overrides = {}) {
  return {
    ownerId,
    tabId: overrides.tabId ?? `${ownerId}#tab1`,
    isCurrent: overrides.isCurrent ?? (() => true),
    alive: overrides.alive ?? (() => true),
  };
}

const okJson = (value) => JSON.stringify(value);
const draftHtml = (ids) => `<h1>标题</h1><p>正文 $x^2$</p>${ids.map((id) => `<img src="mpwx:${id}">`).join('')}`;

/* ══ 1. 图片字节识别（本地纯函数）═════════════════════════════════════════════ */

test('imageInfoOf: PNG/JPEG 尺寸取自真实头部；其它一律拒', () => {
  assert.deepEqual(imageInfoOf(makePng(320, 200)), { ok: true, mime: 'image/png', width: 320, height: 200 });
  assert.deepEqual(imageInfoOf(makeJpeg(640, 360)), { ok: true, mime: 'image/jpeg', width: 640, height: 360 });
  for (const bad of [Buffer.alloc(0), Buffer.from('GIF89a'), Buffer.from('%PDF-1.7'), Buffer.from([0x89, 0x50, 0x4e, 0x47])]) {
    assert.equal(imageInfoOf(bad).ok, false, JSON.stringify(bad));
  }
  /* 畸形尺寸也要拒，而不是返回一个假的宽高。 */
  assert.equal(imageInfoOf(makePng(0, 10)).ok, false);
  assert.equal(imageInfoOf(makePng(100000, 10)).ok, false);
});

/* ══ 2. 凭据：仅内存 / 系统密钥库 ═════════════════════════════════════════════════ */

test('无系统密钥库：configure 成功但只留在内存，状态明确提示，磁盘上不留明文', async (t) => {
  const { host, stateDir } = await makeHost(t);
  const scope = scopeOf('user-memory');

  const before = await host.handle('status', {}, scope);
  assert.equal(before.configured, false);
  assert.equal(before.keystore, false);
  assert.equal(before.memoryOnly, true);

  const saved = await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope);
  assert.equal(saved.ok, true, okJson(saved));
  assert.equal(saved.secretMode, 'memory');
  assert.equal(saved.memoryOnly, true);
  assert.ok(saved.notice && /内存|记忆/.test(saved.notice), '必须明确告知"只保存在内存"');

  const after = await host.handle('status', {}, scope);
  assert.equal(after.configured, true);
  assert.equal(after.appId, APP_ID);
  assert.equal(after.memoryOnly, true);
  assert.equal(okJson(after).includes(SECRET), false, 'status 绝不能回显 secret');
  assert.ok(after.notice && after.notice.length > 0, 'status 也要带着那条提示');

  /* 磁盘上不能出现明文 secret（连凭据文件都不该存在）。 */
  const files = await listFiles(stateDir);
  assert.equal(files.some((f) => /wechat-credentials\.json$/.test(f)), false, '无密钥库时必须拒绝落盘：' + files.join(','));
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    assert.equal(text.includes(SECRET), false, '磁盘上出现了明文 secret：' + file);
  }

  const cleared = await host.handle('clear', {}, scope);
  assert.equal(cleared.ok, true);
  assert.equal((await host.handle('status', {}, scope)).configured, false);
});

test('有系统密钥库：secret 加密落盘（不是明文），status 仍不回显', async (t) => {
  let encryptions = 0;
  const osProtect = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => { encryptions += 1; return Buffer.concat([Buffer.from('PKCS11!'), Buffer.from(String(value), 'utf8').reverse()]); },
    decryptString: (buffer) => Buffer.from(buffer.subarray(7)).reverse().toString('utf8'),
  };
  const { host, stateDir } = await makeHost(t, { osProtect });
  const scope = scopeOf('user-keystore');

  const saved = await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope);
  assert.equal(saved.ok, true, okJson(saved));
  assert.equal(saved.secretMode, 'safe-storage');
  assert.equal(saved.memoryOnly, false);
  assert.equal(encryptions, 1, 'secret 必须经过系统加密，而不是直接写文件');

  const file = join(stateDir, 'accounts');
  const all = await listFiles(file);
  const credentialFile = all.find((f) => /wechat-credentials\.json$/.test(f));
  assert.ok(credentialFile, '有密钥库时应当落盘：' + all.join(','));
  const raw = await readFile(credentialFile, 'utf8');
  assert.equal(raw.includes(SECRET), false, '落盘内容不能含明文 secret');
  assert.match(raw, /"mode":\s*"safe-storage"/);

  const status = await host.handle('status', {}, scope);
  assert.equal(status.configured, true, '重启后应能读出已保存的凭据（对照臂）');
  assert.equal(status.memoryOnly, false);
  assert.equal(okJson(status).includes(SECRET), false);
});

/* ══ 3. 封面：只收本次调用带入的 JPEG/PNG 字节 ══════════════════════════════════ */

test('封面只接受 data: PNG/JPEG；路径、URL、伪类型、超限一律拒', async (t) => {
  const { host, transport } = await makeHost(t);
  const scope = scopeOf('user-cover');

  const png = await host.handle('pickCover', { name: 'cover.png', dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
  assert.equal(png.ok, true, okJson(png));
  assert.equal(png.mime, 'image/png');
  assert.equal(png.width, 900);
  assert.equal(png.height, 500);
  assert.ok(png.id && /^cover-/.test(png.id));

  const jpeg = await host.handle('pickCover', { name: 'cover.jpg', dataUrl: dataUrlOf('image/jpeg', JPEG_COVER) }, scope);
  assert.equal(jpeg.ok, true, okJson(jpeg));
  assert.equal(jpeg.mime, 'image/jpeg');
  assert.equal(jpeg.width, 640);

  const refused = [
    [{ dataUrl: 'C:\\Users\\someone\\cover.png' }, 'MP_WX_IMAGE_PATH'],
    [{ dataUrl: 'file:///C:/Users/someone/cover.png' }, 'MP_WX_IMAGE_PATH'],
    [{ dataUrl: 'https://example.com/cover.png' }, 'MP_WX_IMAGE_REMOTE'],
    [{ dataUrl: dataUrlOf('image/gif', Buffer.from('GIF89a....')) }, 'MP_WX_IMAGE_TYPE'],
    [{ dataUrl: dataUrlOf('image/png', Buffer.from('not really a png')) }, 'MP_WX_IMAGE_DECODE'],
    /* 真 JPEG 字节却声明成 PNG：魔数与声明类型不符，必须在解码/上传前拒绝。 */
    [{ dataUrl: dataUrlOf('image/png', JPEG_COVER) }, 'MP_WX_IMAGE_TYPE'],
    [{ dataUrl: 'data:image/png;base64,' + Buffer.alloc(11 * 1024 * 1024, 0x41).toString('base64') }, 'MP_WX_COVER_LARGE'],
    [{}, 'MP_WX_COVER_MISSING'],
  ];
  for (const [payload, code] of refused) {
    const r = await host.handle('pickCover', payload, scope);
    assert.equal(r.ok, false, `${code}: ${okJson(r).slice(0, 160)}`);
    assert.equal(r.code, code, `期望 ${code}，实际 ${r.code}`);
  }
  assert.deepEqual(transport.calls, [], '选封面阶段一个网络请求都不许发');
});

/* ══ 4. 正常链路：auth → 正文图 → 封面 → draft/add（只建草稿）══════════════════ */

test('正常链路：验证配置 → 正文图/公式图/封面 → 只发 draft/add，回执带真实 media_id', async (t) => {
  const { host, transport, stateDir } = await makeHost(t);
  const scope = scopeOf('user-happy');
  assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope)).ok, true);

  const verified = await host.handle('verify', {}, scope);
  assert.equal(verified.ok, true, okJson(verified));
  assert.equal(verified.total, 7);

  const cover = await host.handle('pickCover', { name: 'cover.png', dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
  assert.equal(cover.ok, true);

  /* images 里两项：一张正文图、一张公式/图表已栅格化的 PNG —— 都是随本次发送带入的字节。 */
  const formulaPng = dataUrlOf('image/png', makePng(251, 70));
  const images = [
    { id: 'img1', src: dataUrlOf('image/png', PNG) },
    { id: 'img2', src: formulaPng },
  ];
  const html = draftHtml(['img1', 'img2']);
  const r = await host.handle('createDraft', {
    title: '端到端标题', html, images, coverId: cover.id, author: '作者',
  }, scope);

  assert.equal(r.ok, true, okJson(r).slice(0, 300));
  assert.equal(r.stage, 'done');
  assert.equal(r.mediaId, 'DRAFT-MEDIA-1', '必须回传真实草稿 media_id');
  assert.deepEqual(r.uploaded, { images: 2, of: 2, cover: true });

  const paths = transport.calls.map((call) => call.path);
  assert.equal(paths.filter((p) => p === '/cgi-bin/media/uploadimg').length, 2, '两张正文图各上传一次');
  assert.equal(paths.filter((p) => p === '/cgi-bin/material/add_material').length, 1, '封面只上传一次');
  assert.equal(paths.filter((p) => p === '/cgi-bin/draft/add').length, 1, '只建一篇草稿');
  assert.equal(transport.calls.some((call) => FORBIDDEN.test(call.path)), false, '绝不调用发布/群发/删除/修改');
  assert.equal(transport.calls.every((call) => call.origin === MOCK_BASE), true, '所有请求只落在假基址上');

  const upload = transport.calls.filter((c) => c.path === '/cgi-bin/media/uploadimg');
  assert.ok(upload[0].body.includes(PNG.subarray(0, 16)), '正文图字节必须原样进 multipart');
  assert.match(String(upload[0].headers['Content-Type'] || ''), /multipart\/form-data; boundary=/);
  const material = transport.calls.filter((c) => c.path === '/cgi-bin/material/add_material');
  assert.ok(material[0].body.includes(PNG_COVER.subarray(0, 16)), '封面字节必须原样进 multipart');

  const draftCall = transport.calls.find((c) => c.path === '/cgi-bin/draft/add');
  const article = JSON.parse(draftCall.body.toString('utf8')).articles[0];
  assert.equal(article.title, '端到端标题');
  assert.equal(article.thumb_media_id, 'COVER-MEDIA-1');
  assert.equal(article.author, '作者');
  assert.equal(article.content.includes('mpwx:'), false, '正文里不许残留图片占位');
  assert.match(article.content, /https:\/\/mmbiz\.qpic\.cn\/fake\//);

  const status = await host.handle('status', {}, scope);
  assert.equal(status.pending, null, '成功之后不能留 pending');
  assert.equal(status.lastDraft.mediaId, 'DRAFT-MEDIA-1');
  assert.equal(okJson(status).includes(SECRET), false);
  assert.equal(okJson(status).includes('TOKEN-STABLE'), false, 'token 不能出宿主');

  const files = await listFiles(stateDir);
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    assert.equal(text.includes(SECRET), false, '磁盘/状态文件里出现了明文 secret：' + file);
  }
});

/* ══ 5. 结果不明确：pending + 不自动重发 ═══════════════════════════════════════ */

for (const [kind, code] of [['timeout', 'MP_WX_DRAFT_UNCERTAIN'], ['badjson', 'MP_WX_DRAFT_UNCERTAIN'], ['network', 'MP_WX_DRAFT_UNCERTAIN']]) {
  test(`结果不明确（${kind}）⇒ ${code} + pending，未确认前一个请求都不发`, async (t) => {
    const { host, transport } = await makeHost(t, { draftReply: kind });
    const scope = scopeOf(`user-${kind}`);
    assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope)).ok, true);
    const cover = await host.handle('pickCover', { dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
    assert.equal(cover.ok, true);

    const payload = { title: 't', html: draftHtml(['img1']), coverId: cover.id, images: [{ id: 'img1', src: dataUrlOf('image/png', PNG) }] };
    const first = await host.handle('createDraft', payload, scope);
    assert.equal(first.ok, false);
    assert.equal(first.code, code, okJson(first).slice(0, 200));
    assert.equal(first.uncertain, true);
    assert.equal(first.draftCreated, null, '不确定时不许声称"没建"');
    assert.match(first.error, /可能已经建好|结果不明确/);

    const status = await host.handle('status', {}, scope);
    assert.ok(status.pending, '必须留下 pending 供下次打开提示');

    const before = transport.calls.length;
    const second = await host.handle('createDraft', payload, scope);
    assert.equal(second.code, 'MP_WX_PENDING_UNCERTAIN', okJson(second).slice(0, 200));
    assert.equal(transport.calls.length, before, '未确认前不许再发任何请求（尤其不许重发 draft/add）');
    assert.equal(transport.calls.filter((c) => c.path === '/cgi-bin/draft/add').length, 1, '建稿请求只出现过一次');
  });
}

test('确认之后才允许再发（显式 acknowledgeUncertain），且成功会清掉 pending', async (t) => {
  const { host, stateDir } = await makeHost(t, { draftReply: 'timeout' });
  const scope = scopeOf('user-ack');
  assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope)).ok, true);
  const cover = await host.handle('pickCover', { dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
  const payload = { title: 't', html: draftHtml([]), coverId: cover.id, images: [] };

  const first = await host.handle('createDraft', payload, scope);
  assert.equal(first.code, 'MP_WX_DRAFT_UNCERTAIN');
  assert.ok(await readFile(join(await pendingFile(stateDir), 'wechat-pending.json'), 'utf8').catch(() => null), 'pending 必须已落盘');

  /* 换一台"这次会成功"的宿主会丢 pending；这里用同一台的确认闸门验证放行语义。 */
  const acknowledged = await host.handle('createDraft', { ...payload, acknowledgeUncertain: true }, scope);
  assert.equal(acknowledged.ok, false, '假传输仍按 timeout 回，所以这次依旧是不确定');
  assert.equal(acknowledged.code, 'MP_WX_DRAFT_UNCERTAIN', '确认放行后真的又发了一次（而不是被 pending 挡住）');
});

test('确定失败（微信 errcode）⇒ MP_WX_DRAFT_REJECTED，且不留 pending', async (t) => {
  const { host } = await makeHost(t, { draftReply: 'reject' });
  const scope = scopeOf('user-reject');
  assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope)).ok, true);
  const cover = await host.handle('pickCover', { dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
  const r = await host.handle('createDraft', { title: 't', html: draftHtml([]), coverId: cover.id, images: [] }, scope);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MP_WX_DRAFT_REJECTED');
  assert.equal(r.errcode, 45002, '必须带回微信真实 errcode');
  assert.equal(r.draftCreated, false);
  const status = await host.handle('status', {}, scope);
  assert.equal(status.pending, null, '确定失败说明服务端没留草稿 ⇒ 不该留 pending');
});

/* ══ 6. 绑定：调用方自报位置不算授权；scope 才可信 ════════════════════════════ */

test('payload 里的 dir/path/workspace/sessionId 一律被忽略（同目录换稿也不改变授权）', async (t) => {
  const { host, transport } = await makeHost(t);
  const scope = scopeOf('user-binding');
  const forged = { dir: 'C:\\Windows\\System32', path: 'C:\\Windows\\win.ini', workspace: 'C:\\', sessionId: 'forged-session' };

  assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET, ...forged }, scope)).ok, true);
  const status = await host.handle('status', forged, scope);
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('win.ini'), false, '回执里不该出现调用方自报的路径');

  const cover = await host.handle('pickCover', { dataUrl: dataUrlOf('image/png', PNG_COVER), ...forged }, scope);
  assert.equal(cover.ok, true);

  /* 正文图给路径而不是字节 ⇒ 直接拒，且一个请求都不发（证明没有读盘能力）。 */
  const byPath = await host.handle('createDraft', {
    title: 't', html: draftHtml(['img1']), coverId: cover.id,
    images: [{ id: 'img1', src: 'C:\\Windows\\win.ini' }], ...forged,
  }, scope);
  assert.equal(byPath.ok, false);
  assert.equal(byPath.code, 'MP_WX_IMAGE_PATH');
  assert.equal(transport.calls.filter((c) => c.path === '/cgi-bin/draft/add').length, 0);

  /* 正文图给网络地址 ⇒ 同样拒（本工具不是下载器）。 */
  const byUrl = await host.handle('createDraft', {
    title: 't', html: draftHtml(['img1']), coverId: cover.id,
    images: [{ id: 'img1', src: 'https://example.com/a.png' }],
  }, scope);
  assert.equal(byUrl.ok, false);
  assert.equal(byUrl.code, 'MP_WX_IMAGE_REMOTE');
  assert.match(byUrl.error, /网络图片|外链|下载/i, '提示要让用户知道"不会替你下载"');
  assert.equal(transport.calls.filter((c) => c.path === '/cgi-bin/media/uploadimg').length, 0, '拒掉的图不许被上传');
  assert.equal(transport.calls.filter((c) => c.path === '/cgi-bin/draft/add').length, 0);
});

test('没有可信 scope（缺 ownerId / createDraft 缺 isCurrent）⇒ MP_WX_SCOPE，且没有任何状态被创建', async (t) => {
  const { host, stateDir } = await makeHost(t);
  for (const action of ['status', 'configure', 'clear', 'verify', 'pickCover', 'createDraft']) {
    const r = await host.handle(action, { appId: APP_ID, secret: SECRET }, null);
    assert.equal(r.ok, false, action);
    assert.equal(r.code, 'MP_WX_SCOPE', action);
  }
  const noCurrent = await host.handle('createDraft', { title: 't', html: draftHtml([]) }, { ownerId: 'u' });
  assert.equal(noCurrent.code, 'MP_WX_SCOPE', 'createDraft 必须有可复核的 isCurrent');

  /* 对照臂：同一个人给了 scope 就能读状态（证明上面拒的是 scope 而不是别的）。 */
  const ok = await host.handle('status', {}, scopeOf('user-scope'));
  assert.equal(ok.ok, true);
  assert.deepEqual(host.inspect().owners, ['user-scope'], '合法调用才会建立该账号的宿主状态');
});

test('文档切换：进入服务前就拦下（不发请求），服务内建稿前再复核一次', async (t) => {
  const { host, transport } = await makeHost(t);
  const scope = scopeOf('user-switch');

  /* ① 一开始就已切换：0 个请求。 */
  const stale = scopeOf('user-switch', { isCurrent: () => false });
  assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope)).ok, true);
  const noRequests = transport.calls.length;
  const early = await host.handle('createDraft', { title: 't', html: draftHtml([]) }, stale);
  assert.equal(early.ok, false);
  assert.equal(early.code, 'MP_WX_DOC_CHANGED');
  assert.equal(transport.calls.length, noRequests, '已切换的文档不许触发任何请求');

  /* ② 上传期间被切走：图片与封面上传会完成，但 draft/add 绝不发。 */
  let current = true;
  const cover = await host.handle('pickCover', { dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
  const switched = scopeOf('user-switch', {
    isCurrent: () => current,
    tabId: `${'user-switch'}#tab1`,
  });
  const pending = host.handle('createDraft', {
    title: 't', html: draftHtml(['img1']), coverId: cover.id,
    images: [{ id: 'img1', src: dataUrlOf('image/png', PNG) }],
  }, switched);
  current = false;                                  // 上传进行中切文档
  const late = await pending;
  assert.equal(late.ok, false);
  assert.equal(late.code, 'MP_WX_DOC_CHANGED', okJson(late).slice(0, 220));
  assert.equal(late.draftCreated, false);
  assert.equal(transport.calls.filter((c) => c.path === '/cgi-bin/draft/add').length, 0, '切换后绝不发 draft/add');
  assert.ok(transport.calls.filter((c) => c.path === '/cgi-bin/media/uploadimg').length >= 1, '上传确实发生过（对照臂）');
});

test('发起窗关闭：alive()=false ⇒ MP_WX_OWNER_GONE，不建草稿；关掉后封面也失效', async (t) => {
  const { host } = await makeHost(t);
  const scope = scopeOf('user-close');
  assert.equal((await host.handle('configure', { appId: APP_ID, secret: SECRET }, scope)).ok, true);
  const cover = await host.handle('pickCover', { dataUrl: dataUrlOf('image/png', PNG_COVER) }, scope);
  assert.equal(cover.ok, true);

  const gone = scopeOf('user-close', { alive: () => false });
  const r = await host.handle('createDraft', { title: 't', html: draftHtml([]), coverId: cover.id, images: [] }, gone);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MP_WX_OWNER_GONE', okJson(r).slice(0, 200));
  assert.equal(r.draftCreated, false);

  /* 另一个 tab 实例用不了这个封面（封面按发起端隔离）。 */
  const otherTab = scopeOf('user-close', { tabId: 'user-close#tab2' });
  const stolen = await host.handle('createDraft', { title: 't', html: draftHtml([]), coverId: cover.id, images: [] }, otherTab);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, 'MP_WX_COVER_FOREIGN', okJson(stolen).slice(0, 200));
});

/* ══ 7. 生命周期与传输接缝 ════════════════════════════════════════════════════ */

test('dispose 幂等；之后所有动作都是 MP_WX_DISPOSED 且不发请求', async (t) => {
  const { host, transport } = await makeHost(t);
  const scope = scopeOf('user-dispose');
  assert.equal((await host.handle('status', {}, scope)).ok, true);
  assert.equal(host.dispose().ok, true);
  assert.equal(host.dispose().ok, true, 'dispose 必须幂等');
  const before = transport.calls.length;
  for (const action of ['status', 'configure', 'clear', 'verify', 'pickCover', 'createDraft']) {
    const r = await host.handle(action, {}, scope);
    assert.equal(r.ok, false, action);
    assert.equal(r.code, 'MP_WX_DISPOSED', action);
  }
  assert.equal(transport.calls.length, before);
  assert.equal(host.inspect().disposed, true);
  assert.deepEqual(host.inspect().owners, []);
});

test('未知动作不产生任何副作用', async (t) => {
  const { host, transport } = await makeHost(t);
  const r = await host.handle('publish', { title: 't' }, scopeOf('user-action'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MP_WX_ACTION');
  assert.deepEqual(transport.calls, []);
});

test('测试接缝默认关闭：没设 MP_TEST_HOOKS 时永远官方域名（不会误打本机假服务）', async (t) => {
  const stateDir = await makeTempDir('seam-');
  t.after(async () => {
    try { host.dispose(); } catch { /* 已释放 */ }
    await rm(stateDir, { recursive: true, force: true });
  });
  const host = createPluginWechatHost({ stateDir, env: { MP_WX_BASE_URL: MOCK_BASE }, transport: async () => ({ status: 200, text: '{}' }) });
  assert.equal(host.inspect().base, 'https://api.weixin.qq.com');
  assert.equal(host.inspect().mock, false);
});

/* ══ 8. 静态边界：本模块不引入读盘能力 ═══════════════════════════════════════ */

test('lib/wechat-draft.js 不引入 fs 读盘（并给出阳性对照，证明尺子看得见）', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/wechat-draft.js', import.meta.url)), 'utf8');
  const fsPattern = /(?:from\s+['"]node:fs['"])|(?:require\(\s*['"]node:fs['"]\s*\))/;
  assert.equal(fsPattern.test(source), false, '宿主模块不该 import node:fs');

  /* 阳性对照：同一把尺子必须能在真正用 fs 的成员里命中，否则上面那句"没命中"没有意义。 */
  const control = await readFile(fileURLToPath(new URL('../host/wechat-credentials.js', import.meta.url)), 'utf8');
  assert.equal(fsPattern.test(control), true, '尺子体检失败：连明确用 fs 的文件都没命中');
});

/* ── 小工具 ─────────────────────────────────────────────────────────────────── */

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}
async function pendingFile(root) {
  const accounts = join(root, 'accounts');
  const entries = await readdir(accounts).catch(() => []);
  assert.equal(entries.length >= 1, true, '应当已有账号目录');
  return join(accounts, entries[0]);
}
async function pathExists(target) {
  try { await stat(target); return true; } catch { return false; }
}
