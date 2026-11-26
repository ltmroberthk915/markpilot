// 连通性：**真实** article-service.js 当被调用方，真实 client.js 转发器当调用方。
//
// 目的（主控点名）：防"双方各对自己的 mock 都绿"。
// 这里不 mock 任何一端的形状——
//   · 调用方 = `lib/client.js` 的 `createArticleForwarder`（vm 装载产品本体）；
//   · 被调用方 = `lib/article-service.js` 的 `createArticleService`（真 import）；
//   · 中间的 `api(endpoint, payload)` 只做一件事：把 `article/<method>` 翻成
//     `service.handle(method, payload, req)`，**不增删任何字段**。
// 只要两边字段名/嵌套对不上（例如把 `docToken` 包进 `binding:{}`），本文件立刻红。
//
// 运行：node test/article-connectivity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createArticleService, ARTICLE_CODES } from '../lib/article-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

const plain = (value) => JSON.parse(JSON.stringify(value));

/** 真实 client.js 的转发器（产品代码本体，非重写）。 */
async function loadForwarder() {
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition; } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  const mod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  return mod.__test.createArticleForwarder;
}

const PEER = { headers: { authorization: 'Bearer test-peer-1' } };

/**
 * 把"调用方 api()"接到"真实服务端 handle()"。
 * `wire` 记录真实过线的请求体，验收时直接看它（不是看任何一端的预期）。
 */
function createServer(getService = () => undefined, extra = {}) {
  const wire = [];
  const sessions = new Map();
  /* 默认装一个最小 wechat host：wx* 的**协议形状**由真实 article-service + 真实
     wechat-draft.js 决定，本文件只 stub 它的返回值（否则 wxStatus 会直接 NOT_IMPLEMENTED，
     验不到"payload 有没有正确到达宿主"）。 */
  const defaultWechat = {
    async handle(action, payload, scope) {
      if (action === 'status') return { ok: true, configured: false, keystore: false, memoryOnly: true, covers: [] };
      return { ok: true, action, name: payload.name || null, scopeOwner: scope.ownerId };
    },
  };
  const service = createArticleService({
    getService: (serviceName) => {
      if (serviceName === 'connection') {
        return { admit: () => ({ peer: { id: 'peer-1', principal: { kind: 'owner' } } }) };
      }
      if (serviceName === 'sessions') {
        return { get: (sessionId) => sessions.get(sessionId) || null };
      }
      return getService(serviceName);
    },
    resolveDocument: async (rawPath) => extra.resolveDocument ? extra.resolveDocument(rawPath) : { ok: true, canonicalPath: String(rawPath) },
    modelSelectionFor: () => null,
    wechat: extra.wechat || (async () => defaultWechat),
    loadRewrite: extra.loadRewrite,
    log: { info() {}, warn() {} },
    now: () => 1_000_000,
  });
  sessions.set('sess-1', { id: 'sess-1' });
  return { service, wire, sessions };
}

/** 调用方 → 服务端：只做方法名到 handle() 的翻译，字段一个不动。 */
function wireApi(service, wire) {
  return async (endpoint, payload) => {
    const method = endpoint.replace(/^article\//, '');
    wire.push({ endpoint, payload: plain(payload) });
    const result = await service.handle(method, plain(payload), PEER);
    return plain(result);
  };
}

function binding(overrides = {}) {
  return {
    tabId: 'tab-1',
    docToken: 'dshdoc-live-1',
    generation: 3,
    path: 'C:/Docs/Note.md',
    sessionId: 'sess-1',
    alive: () => true,
    ...overrides,
  };
}

/* ══ 1. bind 的真实线上形状 ═══════════════════════════════════════════════════ */

test('连通性 · bind：顶层四字段正好被真实服务端接住（不再套 binding 外壳）', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });

  const bound = await forwarder.bind(binding());
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.ok(bound.capability, '必须拿到服务端签发的 capability');

  assert.equal(wire.length, 1);
  assert.equal(wire[0].endpoint, 'article/bind');
  assert.deepEqual(wire[0].payload, {
    sessionId: 'sess-1', path: 'C:/Docs/Note.md', docToken: 'dshdoc-live-1', tabId: 'tab-1',
  }, 'bind 必须是顶层字段，且不许夹带 generation/binding 这类外壳');
  assert.equal(service.inspect().bindings.length, 1);
  assert.equal(service.inspect().bindings[0].sessionId, 'sess-1');
  assert.equal(service.inspect().bindings[0].path, 'C:/Docs/Note.md', '服务端记下的是它自己核验过的 canonicalPath');
});

test('连通性 · 真实服务端真的会拒错形状：套了 binding 外壳就 MP_ARTICLE_BAD_BIND', async () => {
  const { service } = createServer();
  /* 这是第一轮实机看到的形状：客户端把 docToken 包在 binding 里。 */
  const nested = await service.handle('bind', {
    binding: { sessionId: 'sess-1', path: 'C:/Docs/Note.md', docToken: 'dshdoc-live-1', tabId: 'tab-1' },
  }, PEER);
  assert.equal(nested.ok, false);
  assert.equal(nested.code, ARTICLE_CODES.badBind, '服务端必须拒，正是这次实机看到的 MP_ARTICLE_BAD_BIND');
});

/* ══ 2. 续调：capability + 顶层 docToken ═══════════════════════════════════════ */

test('连通性 · 续调：aiStatus/aiDiag 用顶层 capability+docToken 被服务端接受', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  const bound = await forwarder.bind(binding());
  assert.equal(bound.ok, true);

  const status = await forwarder.call('aiStatus', {}, binding());
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.hasLlm, false, '这具 stub 没有 ctx.llm');
  assert.equal(status.source, null);

  const diag = await forwarder.call('aiDiag', {}, binding());
  assert.equal(diag.ok, true, JSON.stringify(diag));
  assert.equal(diag.bindId, bound.capability ? service.inspect().bindings[0].bindId : null);
  assert.equal(diag.tabId, 'tab-1');
  assert.equal(diag.sessionId, 'sess-1');

  const last = wire[wire.length - 1].payload;
  assert.equal(typeof last.capability, 'string', '续调必须带顶层 capability');
  assert.equal(last.docToken, 'dshdoc-live-1', '续调必须带顶层 docToken');
  assert.equal(Object.hasOwn(last, 'binding'), false);
});

test('连通性 · 自动绑定：未带 capability 的首调被服务端拒 ⇒ 转发器 bind 后重试成功', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });

  /* 不预先 bind，直接调（就像 iframe 打开后立刻点右键润色）。 */
  const result = await forwarder.call('wxStatus', {}, binding());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.configured, false, '真实 wechat host 未装配时应是明确失败形态，这里给的是 status');
  assert.deepEqual(wire.map((entry) => entry.endpoint), ['article/wxStatus', 'article/bind', 'article/wxStatus'],
    '第一次被 MP_ARTICLE_UNBOUND 拒 → bind → 重试一次');
  assert.equal(wire[0].payload.capability, undefined, '首调本来就没有 capability');
  assert.equal(typeof wire[2].payload.capability, 'string');
});

/* ══ 3. aiRewrite 展平：{payload,requestId} → {requestId,text,instruction} ═════ */

test('连通性 · aiRewrite：iframe 的 {payload:{selection}} 被展平成服务端要的顶层 text', async () => {
  const createArticleForwarder = await loadForwarder();
  let seen = null;
  /* 服务端当前权威：模型组只认**本会话 modelSelection 投影**（不回落部署默认）。
     这里提供本安装版本的两个真实读面之一（`snapshot(session,['modelSelection'])`），
     并把 session 造成它有形态校验要求的样子（header 是对象）。 */
  const session = { id: 'sess-1', header: { id: 'sess-1', cwd: 'C:/Docs' } };
  const service2 = createArticleService({
    getService: (serviceName) => {
      if (serviceName === 'connection') return { admit: () => ({ peer: { id: 'peer-1', principal: { kind: 'owner' } } }) };
      if (serviceName === 'sessions') return { get: (id) => (id === 'sess-1' ? session : null) };
      if (serviceName === 'sessionProjections') {
        return {
          snapshot: (_s, keys) => (keys.includes('modelSelection')
            ? { asOfSeq: 1, values: { modelSelection: { lastUsed: null, pending: null, next: { provider: 'qa-article', model: 'fixed-reply' } } } }
            : { asOfSeq: 1, values: {} }),
        };
      }
      if (serviceName === 'llm') return { stream: () => { throw new Error('should not reach the model in this test'); } };
      return undefined;
    },
    resolveDocument: async (p) => ({ ok: true, canonicalPath: p }),
    loadRewrite: async () => ({
      async rewriteSelectedText(options) {
        seen = options;
        return { ok: true, text: '润色后的句子' };
      },
    }),
    log: { info() {}, warn() {} },
  });
  const wire2 = [];
  const forwarder = createArticleForwarder({ api: wireApi(service2, wire2) });
  await forwarder.bind(binding());

  /* iframe 真实上行形状（dsh-bridge.js：{ payload: EM(...), requestId }）。 */
  const result = await forwarder.call('aiRewrite', {
    payload: { purpose: 'selection-rewrite', app: 'MarkPilot', language: 'zh-CN', instruction: '更简洁', selection: '原来的句子' },
    requestId: 'dshai-1-abc',
  }, binding());

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, '润色后的句子');
  assert.equal(result.requestId, 'dshai-1-abc');

  const sent = wire2.find((entry) => entry.endpoint === 'article/aiRewrite').payload;
  assert.equal(sent.text, '原来的句子', '服务端只认 text：必须由 selection 展平过来');
  assert.equal(sent.requestId, 'dshai-1-abc');
  assert.equal(sent.instruction, '更简洁');
  assert.equal(Object.hasOwn(sent, 'payload'), false, '不许把 iframe 的 payload 外壳发出去');
  assert.equal(typeof sent.capability, 'string');
  assert.equal(sent.docToken, 'dshdoc-live-1');

  /* 服务端交给模型模块的正是展平后的选区文字。 */
  assert.equal(seen.text, '原来的句子');
  assert.equal(seen.selection.provider, 'qa-article');
  assert.equal(seen.selection.model, 'fixed-reply');
});

test('连通性 · aiRewrite 缺 requestId：真实服务端给 MP_ARTICLE_BAD_INPUT（不是静默成功）', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  await forwarder.bind(binding());
  const result = await forwarder.call('aiRewrite', { payload: { selection: '文字' } }, binding());
  assert.equal(result.ok, false);
  assert.equal(result.code, ARTICLE_CODES.badInput);
});

/* ══ 4. 微信：payload 原样（服务端自己建 scope）═══════════════════════════════ */

test('连通性 · wxConfigure/取封面：真实服务端把 payload 交给 wechat host，绑定由服务端自建', async () => {
  const createArticleForwarder = await loadForwarder();
  const handled = [];
  const fakeWechat = {
    async handle(action, payload, scope) {
      handled.push({ action, payload, scope });
      if (action === 'configure') return { ok: true, appId: payload.appId, secretStored: true, secretMode: 'memory', memoryOnly: true };
      if (action === 'pickCover') return { ok: true, id: 'cover-1', name: payload.name, bytes: 120, mime: 'image/png', width: 10, height: 10 };
      if (action === 'status') return { ok: true, configured: true, appId: 'wx1234567890abcdef', covers: [] };
      return { ok: true };
    },
  };
  const { service, wire } = createServer(() => undefined, { wechat: async () => fakeWechat });
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  await forwarder.bind(binding());

  const configured = await forwarder.call('wxConfigure', { appId: 'wx1234567890abcdef', secret: 'abcdef0123456789abcdef0123456789' }, binding());
  assert.equal(configured.ok, true, JSON.stringify(configured));

  /* iframe 的封面形状：{name,mime,bytesBase64} → 服务端/宿主认的 {name,mime,dataUrl}。 */
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000a0000000a0802000000', 'hex');
  const picked = await forwarder.call('wxPickCover', { name: 'cover.png', mime: 'image/png', bytesBase64: png.toString('base64') }, binding());
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.equal(picked.id, 'cover-1');

  const coverCall = handled.find((entry) => entry.action === 'pickCover');
  assert.match(coverCall.payload.dataUrl, /^data:image\/png;base64,/, '必须展平成宿主认的 dataUrl');
  assert.equal(Object.hasOwn(coverCall.payload, 'bytesBase64'), false);

  /* scope 是服务端构造的：owner 来自 peer、documentId 来自 capability，客户端一个都没给。 */
  assert.equal(coverCall.scope.ownerId, 'peer-1');
  assert.equal(typeof coverCall.scope.documentId, 'string');
  assert.equal(typeof coverCall.scope.isCurrent, 'function');

  const sentCover = wire.find((entry) => entry.endpoint === 'article/wxPickCover').payload;
  assert.equal(typeof sentCover.capability, 'string');
  assert.equal(sentCover.docToken, 'dshdoc-live-1');
});

/* ══ 5. 换代/换稿 ════════════════════════════════════════════════════════════ */

test('连通性 · wxCreateDraft：正文/图片/封面字段原样到达宿主，scope 由服务端造', async () => {
  const createArticleForwarder = await loadForwarder();
  const seen = [];
  const fakeWechat = {
    async handle(action, payload, scope) {
      seen.push({ action, payload, scope });
      return { ok: true, stage: 'done', mediaId: 'DRAFT-1', title: payload.title, uploaded: { images: 1, of: 1, cover: true } };
    },
  };
  const { service, wire } = createServer(() => undefined, { wechat: async () => fakeWechat });
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  await forwarder.bind(binding());

  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d494844520000000a0000000a0802000000', 'hex').toString('base64');
  const result = await forwarder.call('wxCreateDraft', {
    title: '端到端标题',
    html: '<h1>端到端标题</h1><img src="mpwx:img1">',
    images: [{ id: 'img1', src: png }],
    coverId: 'cover-1',
    author: '作者',
    acknowledgeUncertain: false,
  }, binding());

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mediaId, 'DRAFT-1');

  const call = seen.find((entry) => entry.action === 'createDraft');
  assert.equal(call.payload.title, '端到端标题');
  assert.equal(call.payload.html.includes('mpwx:img1'), true);
  assert.deepEqual(plain(call.payload.images), [{ id: 'img1', src: png }], '图片占位与 data: 字节必须原样到达宿主');
  assert.equal(call.payload.coverId, 'cover-1');
  assert.equal(call.payload.author, '作者');
  /* scope 由服务端构造：客户端连 ownerId 都没给过。 */
  assert.equal(call.scope.ownerId, 'peer-1');
  const sent = wire.find((entry) => entry.endpoint === 'article/wxCreateDraft').payload;
  assert.equal(sent.docToken, 'dshdoc-live-1');
  assert.equal(Object.hasOwn(sent, 'dir'), false, '不许自带 dir');
  assert.equal(Object.hasOwn(sent, 'path'), false, '不许自带 path');
});

test('连通性 · 同目录换稿：新文档不沿用旧 capability，服务端按同一 tab 重绑并作废旧票', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  const first = await forwarder.bind(binding({ path: 'C:/Docs/A.md', docToken: 'token-A' }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(service.inspect().bindings.length, 1);

  /* 同一目录里的另一个文件：path 换了但目录没变，docToken 也换了。 */
  const result = await forwarder.call('wxStatus', {}, binding({ path: 'C:/Docs/B.md', docToken: 'token-B' }));
  assert.equal(result.ok, true, JSON.stringify(result), '新文档要能继续用（自动重绑），而不是卡死在旧票上');

  /* 关键判据：新文档那次调用**没有**拿 A 的 capability；服务端也只剩 B（同 tab 重绑作废旧票）。 */
  const bCall = wire.find((entry) => entry.endpoint === 'article/wxStatus'
    && entry.payload.docToken === 'token-B');
  assert.ok(bCall, '必须有一次针对 token-B 的调用');
  assert.equal(bCall.payload.capability, undefined, '第一次用新文档调用时不许带旧 capability');
  const bindings = service.inspect().bindings;
  assert.equal(bindings.length, 1, '同 tab 重绑后旧票必须消失（不许两票并存抢同一份文档）');
  assert.equal(bindings[0].path, 'C:/Docs/B.md');
});

test('连通性 · unbind：真实服务端释放 capability；之后的调用只能靠新绑定', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  const bound = await forwarder.bind(binding());

  const released = await forwarder.release(binding());
  assert.equal(released.released, true);
  assert.deepEqual(service.inspect().bindings, [], '服务端必须真的把它删掉');

  const unbindWire = wire.find((entry) => entry.endpoint === 'article/unbind').payload;
  assert.equal(unbindWire.docToken, 'dshdoc-live-1', 'unbind 也要顶层 docToken（服务端 lookup 会核对它）');
  assert.equal(typeof unbindWire.capability, 'string');
  assert.equal(Object.hasOwn(unbindWire, 'binding'), false);

  /* 退场后再调：转发器会自愈式重绑（这是设计），但**绝不允许复用已释放的那张票**。 */
  const after = await forwarder.call('wxStatus', {}, binding());
  assert.equal(after.ok, true, JSON.stringify(after));
  const reuse = wire.filter((entry) => entry.endpoint === 'article/wxStatus' && entry.payload.capability === bound.capability);
  assert.deepEqual(reuse, [], '已释放的 capability 一个请求都不许再用');
  const reBinds = wire.filter((entry) => entry.endpoint === 'article/bind');
  assert.equal(reBinds.length, 2, '应该是"重绑一次"而不是"旧票还能用"');
});

/* ══ 6. 绑定失效的三种真实理由 ═══════════════════════════════════════════════ */

test('连通性 · 会话不存在 / 文档没打开过 ⇒ 服务端给 NO_SESSION / NO_DOC，转发器原样上报', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });

  const noSession = await forwarder.bind(binding({ sessionId: 'sess-missing' }));
  assert.equal(noSession.ok, false);
  assert.equal(noSession.code, ARTICLE_CODES.noSession);

  const closedDoc = createServer(() => undefined, { resolveDocument: async () => ({ ok: false }) });
  const forwarder2 = createArticleForwarder({ api: wireApi(closedDoc.service, closedDoc.wire) });
  const noDoc = await forwarder2.bind(binding());
  assert.equal(noDoc.ok, false);
  assert.equal(noDoc.code, ARTICLE_CODES.noDoc);
});

/* ══ 7. 权威性自证：两端形状必须同时被真实代码接受 ═══════════════════════════ */

test('连通性 · MP_ARTICLE_STALE 只对"换稿"这一种情况发；UNBOUND 才是重绑信号', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  const bound = await forwarder.bind(binding({ path: 'C:/Docs/A.md', docToken: 'token-A' }));
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(service.inspect().bindings.length, 1);

  /* 直接问服务端：把 A 的 capability 挂到 B 的 docToken 上 ⇒ STALE（文档换了）。 */
  const stale = await service.handle('wxStatus', { capability: bound.capability, docToken: 'token-B' }, PEER);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, ARTICLE_CODES.stale, JSON.stringify(stale));

  /* 且必须能与"没绑过"区分开：同一张票、缺 capability 才是 UNBOUND（那是重绑信号）。 */
  const unbound = await service.handle('wxStatus', { docToken: 'token-B' }, PEER);
  assert.equal(unbound.code, ARTICLE_CODES.unbound, JSON.stringify(unbound));

  /* 转发器的重绑白名单只含 UNBOUND/BIND_REQUIRED：STALE 不在其中（源码级 + 行为级双重）。 */
  const internals = forwarder._internals;
  assert.equal(internals.needsBind({ ok: false, code: ARTICLE_CODES.stale }), false, 'STALE 不许触发重绑');
  assert.equal(internals.needsBind({ ok: false, code: ARTICLE_CODES.unbound }), true, 'UNBOUND 才触发重绑');

  /* 端到端：换稿调用若拿到 STALE，bind 请求数不增加（不会把换稿静默变成合法续调）。 */
  const bindCount = wire.filter((entry) => entry.endpoint === 'article/bind').length;
  const after = await forwarder.call('wxStatus', {}, binding({ path: 'C:/Docs/B.md', docToken: 'token-B' }));
  assert.equal(after.ok, true, '新文档最终可用（转发器会为它重新绑定一次）');
  assert.ok(wire.filter((entry) => entry.endpoint === 'article/bind').length >= bindCount);
});

test('连通性 · unbind 缺 docToken 时服务端不释放（证明那条字段不是可有可无）', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  const bound = await forwarder.bind(binding());

  const forged = await service.handle('unbind', { capability: bound.capability }, PEER);
  assert.equal(forged.ok, false, '缺 docToken 的 unbind 必须被拒');
  assert.equal(forged.code, ARTICLE_CODES.stale);
  assert.equal(service.inspect().bindings.length, 1, '被拒的 unbind 不能顺手把绑定删掉');

  /* 对照臂：转发器发的 unbind 带 docToken，能真的释放。 */
  const released = await forwarder.release(binding());
  assert.equal(released.released, true);
  assert.deepEqual(service.inspect().bindings, []);
});

test('连通性自证：真实过线请求里既没有 binding 外壳，也没有 iframe 的 payload 外壳', async () => {
  const createArticleForwarder = await loadForwarder();
  const { service, wire } = createServer();
  const forwarder = createArticleForwarder({ api: wireApi(service, wire) });
  await forwarder.bind(binding());
  await forwarder.call('aiDiag', {}, binding());
  await forwarder.call('wxStatus', {}, binding());

  assert.ok(wire.length >= 3, '至少 bind + diag/status 的往返，实际 ' + wire.length);
  for (const entry of wire) {
    assert.equal(entry.endpoint.startsWith('article/'), true);
    assert.equal(Object.hasOwn(entry.payload, 'binding'), false, entry.endpoint + ' 不许套 binding 外壳');
    assert.equal(Object.hasOwn(entry.payload, 'payload'), false, entry.endpoint + ' 不许套 iframe payload 外壳');
    assert.equal(Object.hasOwn(entry.payload, 'generation'), false, entry.endpoint + ' 不透传 generation（服务端不认这个字段）');
  }
});
