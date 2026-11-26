'use strict';
/*
 * 宿主服务 MarkPilot-CM6/shell/ai-rewrite.js 的模块级回归（真的是"模型调用"那一层）。
 *
 * 判据钉在**用户会看到的结果**与**安全边界**上，不钉"调了哪个函数"：
 *   · 凭据绑定：内置服务只认**自己的**环境变量；settings 里的明文 key / baseURL 一律不读；
 *   · 端点策略：远程必须 https，http 只允许回环；带 userinfo / 其它协议一律拒；
 *   · 自定义端点：只能由可信宿主显式注入，渲染侧无法自己配；
 *   · 回调：401/403/429/5xx/网络错/超时/取消 各自的稳定 code；message 里永不带密钥；
 *   · inflight：requestId → AbortController，取消真的中止网络；窗口销毁按 owner 收尾；
 *   · 信任：authorize 不通过 ⇒ 回绝且不建 inflight 记录。
 *
 * 不读真实密钥、不连外网：fetch 全部是假实现。
 * 运行：node tools/quality/tests/ai-rewrite-host.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const HOST = require(path.join(ROOT, 'MarkPilot-CM6/shell/ai-rewrite.js'));

const SELECTION = '这个方案很好，可以用了。';
const REPLY = '这个方案不错，可以直接用了。';
const SECRET = 'sk-secret-fixture-value-123456';

/** 假 fetch：记录请求，按脚本回包。 */
function fakeFetch(script = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const step = typeof script === 'function' ? script(url, init, calls.length) : (script[calls.length - 1] ?? script.default);
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}

const openaiReply = (text) => ({
  status: 200,
  json: async () => ({ choices: [{ message: { role: 'assistant', content: text } }] }),
});
const anthropicReply = (text) => ({
  status: 200,
  json: async () => ({ content: [{ type: 'text', text }] }),
});
const httpError = (status, message) => ({
  status,
  json: async () => ({ error: { message } }),
});

/* ═════════════════ 凭据绑定：内置服务只认自己的 env ═════════════════ */

test('未配置：既没 provider 也没密钥 ⇒ not-configured 的中文提示，不发请求', async () => {
  const fetchImpl = fakeFetch({ default: openaiReply(REPLY) });
  const result = await HOST.rewriteSelection({ selection: SELECTION }, { settings: {}, env: {}, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-configured');
  assert.match(result.message, /配置|密钥/);
  assert.equal(fetchImpl.calls.length, 0, '没配置就不该出网');
});

test('内置服务只认**自己的**环境变量：给 OpenAI 的 key 不能让 deepseek 生效', () => {
  const wrongKey = HOST.resolveConfig({ settings: {}, env: { OPENAI_API_KEY: SECRET } });
  assert.equal(wrongKey.ok, false, 'deepseek 不能借用 OPENAI_API_KEY');
  assert.equal(wrongKey.code, 'not-configured');
  const rightKey = HOST.resolveConfig({ settings: {}, env: { DEEPSEEK_API_KEY: SECRET } });
  assert.equal(rightKey.ok, true);
  assert.equal(rightKey.config.keyEnv, 'DEEPSEEK_API_KEY');
});

test('settings 里的**明文 API key 不被读取**（普通 settings.json 是渲染侧可写候选）', () => {
  const r = HOST.resolveConfig({ settings: { aiRewriteApiKey: SECRET }, env: {} });
  assert.equal(r.ok, false, '写进 settings 的明文 key 必须无效');
  assert.equal(r.code, 'not-configured');
});

test('settings 里的 aiRewriteApiKeyEnv / aiRewriteBaseURL 也不再被采信', () => {
  const r = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'deepseek', aiRewriteApiKeyEnv: 'MY_SECRET', aiRewriteBaseURL: 'https://evil.example.com' },
    env: { MY_SECRET: SECRET, DEEPSEEK_API_KEY: 'sk-good' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.baseURL, 'https://api.deepseek.com', '内置 provider 的端点不可被 settings 覆盖');
  assert.equal(r.config.keyEnv, 'DEEPSEEK_API_KEY', '读哪个 env 由内置表决定，不由 settings 决定');
});

test('provider 拼错 ⇒ 明确说认不出，并列出支持的名字', async () => {
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: { aiRewriteProvider: 'gpt-9000' }, env: {}, fetchImpl: fakeFetch({}),
  });
  assert.equal(result.code, 'not-configured');
  assert.match(result.message, /deepseek/);
  assert.match(result.message, /custom/);
});

/* ═════════════════ 端点策略 ═════════════════ */

test('端点协议：远程 https 放行；http 只允许回环；其它协议与 userinfo 一律拒', () => {
  const ok = (u) => HOST.validateBaseURL(u).ok;
  assert.equal(ok('https://api.deepseek.com'), true);
  assert.equal(ok('https://gw.example.com/v1'), true, '远程 https 的第三方网关合法');
  assert.equal(ok('http://127.0.0.1:11434'), true, '本机假 provider 走 http 回环');
  assert.equal(ok('http://localhost:8080/v1'), true);
  assert.equal(ok('http://[::1]:9000'), true);
  assert.equal(ok('http://192.168.1.5:9000'), false, '内网明文 http 拒绝');
  assert.equal(ok('http://api.deepseek.com'), false, '远程明文 http 拒绝（密钥会裸奔）');
  assert.equal(ok('file:///etc/passwd'), false);
  assert.equal(ok('ws://127.0.0.1/x'), false);
  assert.equal(ok('https://user:pass@api.example.com'), false, 'userinfo 会把凭据写进日志');
  assert.equal(ok(''), false);
});

test('自定义端点必须由可信宿主显式注入；渲染侧改 settings 没用', async () => {
  const viaSettings = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'custom', aiRewriteBaseURL: 'http://127.0.0.1:9999', aiRewriteModel: 'x' },
    env: {},
  });
  assert.equal(viaSettings.ok, false, 'settings 里的 baseURL 不构成"显式配置"');
  assert.match(viaSettings.message, /显式配置/);

  const injected = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'custom' },
    env: {},
    customEndpoint: { baseURL: 'http://127.0.0.1:9999/v1', model: 'local-model' },
  });
  assert.equal(injected.ok, true);
  assert.equal(injected.config.source, 'host-injected');
  assert.equal(injected.config.baseURL, 'http://127.0.0.1:9999/v1');

  const badInjected = HOST.resolveConfig({
    settings: { aiRewriteProvider: 'custom' }, env: {},
    customEndpoint: { baseURL: 'http://10.0.0.5:9999/v1', model: 'm' },
  });
  assert.equal(badInjected.ok, false, '注入的端点同样要过协议策略');
});

test('端点拼接：deepseek / 自建 /v1 网关 / 已写全路径 / Anthropic 各就各位', () => {
  const ds = HOST.resolveConfig({ settings: {}, env: { DEEPSEEK_API_KEY: 'k' } }).config;
  assert.equal(HOST.endpointOf(ds), 'https://api.deepseek.com/v1/chat/completions');
  const local = { kind: 'openai', baseURL: 'http://127.0.0.1:11434/v1' };
  assert.equal(HOST.endpointOf(local), 'http://127.0.0.1:11434/v1/chat/completions');
  const full = { kind: 'openai', baseURL: 'https://gw.example.com/v1/chat/completions' };
  assert.equal(HOST.endpointOf(full), 'https://gw.example.com/v1/chat/completions');
  const claude = HOST.resolveConfig({ settings: { aiRewriteProvider: 'anthropic' }, env: { ANTHROPIC_API_KEY: 'k' } }).config;
  assert.equal(HOST.endpointOf(claude), 'https://api.anthropic.com/v1/messages');
  assert.equal(HOST.headersOf(claude)['x-api-key'], 'k');
  assert.equal(HOST.headersOf(claude).authorization, undefined, 'Anthropic 不吃 Bearer');
});

/* ═════════════════ 请求体只含选区 ═════════════════ */

test('出网请求体只含选区：密钥在 header 不在 body，正文其余部分没有出口', async () => {
  const fetchImpl = fakeFetch({ default: openaiReply(REPLY) });
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: {}, env: { DEEPSEEK_API_KEY: SECRET }, fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, REPLY);
  const call = fetchImpl.calls[0];
  assert.match(call.init.headers.authorization, /^Bearer sk-secret/);
  const flat = JSON.stringify(call.body);
  assert.equal(flat.includes(SECRET), false, '密钥绝不能出现在请求体里');
  const userMessage = call.body.messages.find(m => m.role === 'user').content;
  assert.ok(userMessage.includes(SELECTION), '请求里必须有选区');
  assert.deepEqual(Object.keys(call.body).sort(), ['messages', 'model', 'stream', 'temperature']);
});

/* ═════════════════ 回包解析 ═════════════════ */

test('OpenAI 兼容回包：字符串、分块数组两种形态都读得出来', async () => {
  const env = { DEEPSEEK_API_KEY: 'k' };
  const asString = await HOST.rewriteSelection({ selection: SELECTION }, { settings: {}, env, fetchImpl: fakeFetch({ default: openaiReply(REPLY) }) });
  assert.equal(asString.text, REPLY);
  const asParts = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: {}, env,
    fetchImpl: fakeFetch({ default: { status: 200, json: async () => ({ choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }] }) } }),
  });
  assert.equal(asParts.text, '甲乙');
});

test('Anthropic 回包：只取 text 块，其它块忽略', async () => {
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: { aiRewriteProvider: 'anthropic' }, env: { ANTHROPIC_API_KEY: 'k' },
    fetchImpl: fakeFetch({ default: anthropicReply(REPLY) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, REPLY);
});

test('回包结构不符 ⇒ 失败而不是返回半截（负例）', async () => {
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: {}, env: { DEEPSEEK_API_KEY: 'k' },
    fetchImpl: fakeFetch({ default: { status: 200, json: async () => ({ unexpected: true }) } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad-response');
  assert.equal(result.text, undefined);
});

/* ═════════════════ 失败分支 ═════════════════ */

test('401/403 ⇒ invalid-key；429 ⇒ rate-limit；500 ⇒ http，各带状态码', async () => {
  const env = { DEEPSEEK_API_KEY: 'k' };
  const run = (script) => HOST.rewriteSelection({ selection: SELECTION }, { settings: {}, env, fetchImpl: fakeFetch(script) });
  const unauth = await run({ default: httpError(401, 'bad key') });
  assert.equal(unauth.code, 'invalid-key');
  assert.equal(unauth.status, 401);
  const forbidden = await run({ default: httpError(403, 'forbidden') });
  assert.equal(forbidden.code, 'invalid-key');
  const limited = await run({ default: httpError(429, 'slow down') });
  assert.equal(limited.code, 'rate-limit');
  const boom = await run({ default: httpError(500, 'upstream broke') });
  assert.equal(boom.code, 'http');
  assert.match(boom.message, /500/);
  assert.match(boom.message, /upstream broke/, '厂商的原始错误要透出来，否则用户没法排查');
});

test('网络错误 ⇒ network code，message 带原因', async () => {
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: {}, env: { DEEPSEEK_API_KEY: 'k' },
    fetchImpl: fakeFetch({ default: new Error('getaddrinfo ENOTFOUND api.deepseek.com') }),
  });
  assert.equal(result.code, 'network');
  assert.match(result.message, /ENOTFOUND/);
});

test('超时 ⇒ timeout code（3s 上限压到最短，且必须真的等到了超时点）', async () => {
  const started = Date.now();
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: { aiRewriteTimeoutMs: '3000' }, env: { DEEPSEEK_API_KEY: 'k' },
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 'timeout', `实际 ${result.code} / ${result.message}`);
  assert.match(result.message, /超时/);
  assert.ok(elapsed >= 2500, `必须真的等到了超时点（实测 ${elapsed}ms）`);
});

test('取消：外部 signal 中止 ⇒ cancelled，且回包被丢弃', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
    setTimeout(() => controller.abort(), 5);
  });
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: {}, env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl, signal: controller.signal,
  });
  assert.equal(result.code, 'cancelled');
});

test('空选区 / 超长选区：本地就拒，绝不发请求（负例）', async () => {
  const fetchImpl = fakeFetch({ default: openaiReply(REPLY) });
  const env = { DEEPSEEK_API_KEY: 'k' };
  const empty = await HOST.rewriteSelection({ selection: '   ' }, { settings: {}, env, fetchImpl });
  assert.equal(empty.code, 'empty');
  const huge = await HOST.rewriteSelection({ selection: 'x'.repeat(HOST.MAX_SELECTION_CHARS + 1) }, { settings: {}, env, fetchImpl });
  assert.equal(huge.code, 'too-long');
  assert.equal(fetchImpl.calls.length, 0);
});

/* ═════════════════ 密钥不外泄 ═════════════════ */

test('配置摘要里密钥始终被遮蔽', () => {
  const resolved = HOST.resolveConfig({ settings: {}, env: { DEEPSEEK_API_KEY: SECRET } });
  const described = HOST.describeConfig(resolved.config);
  assert.equal(described.key.includes(SECRET), false, '摘要里不许有完整密钥');
  assert.match(described.key, /^.{3}\*{3}/);
  assert.equal(HOST.redact('short'), '***');
  assert.equal(HOST.redact(''), '');
});

test('错误回包里绝不出现密钥（远端可能把 key 回显在错误消息里）', async () => {
  /* 这是真实会发生的形态：某些网关 401 时把收到的 Authorization 原样回显。 */
  const result = await HOST.rewriteSelection({ selection: SELECTION }, {
    settings: {}, env: { DEEPSEEK_API_KEY: SECRET },
    fetchImpl: fakeFetch({ default: httpError(401, `invalid key: Bearer ${SECRET}`) }),
  });
  assert.equal(result.code, 'invalid-key');
  assert.equal(JSON.stringify(result).includes(SECRET), false, '密钥被远端回显时必须抹掉');
  assert.match(result.message, /\*\*\*/);
  // scrub 本身也验一遍（多个 secret）
  assert.equal(HOST.scrub(`a=${SECRET} b=other`, [SECRET]).includes(SECRET), false);
  assert.equal(HOST.scrub('no secrets here', [SECRET]), 'no secrets here');
});

/* ═════════════════ inflight / 取消 / 窗口收尾 ═════════════════ */

/** 造一个最小 ipcMain：记录 handler，可手动调用。 */
function makeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error('dup ' + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}
const alwaysTrust = async () => ({ ok: true, owner: { id: '1' } });

test('取消按 requestId 真正中止网络（不是只丢弃回包）', async () => {
  const ipc = makeIpc();
  let sawAbort = false;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      sawAbort = true;
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc, authorize: alwaysTrust,
    readSettings: () => ({}), env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
  });
  const event = { sender: { id: 1 } };
  const pending = ipc.handlers.get('ai:rewrite')(event, { selection: SELECTION }, { requestId: 'r1' });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(svc.inflightSize(), 1, '在途请求必须被登记');
  const cancel = await ipc.handlers.get('ai:rewrite-cancel')(event, { requestId: 'r1' });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.cancelled, true);
  const result = await pending;
  assert.equal(result.code, 'cancelled', '回执应当是被取消');
  assert.equal(sawAbort, true, '**fetch 必须真的被 abort**，不能只是上层丢弃回包');
  assert.equal(svc.inflightSize(), 0, '取消后记录要清掉');
  svc.dispose();
});

test('取消别的窗口的请求被拒绝；取消不存在的 id 返回 not-found（不当异常）', async () => {
  const ipc = makeIpc();
  const fetchImpl = () => new Promise((resolve, reject) => {
    setTimeout(() => { const e = new Error('x'); e.name = 'AbortError'; reject(e); }, 200);
  });
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc, authorize: alwaysTrust, readSettings: () => ({}), env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
  });
  const mine = { sender: { id: 1 } }, other = { sender: { id: 2 } };
  const pending = ipc.handlers.get('ai:rewrite')(mine, { selection: SELECTION }, { requestId: 'r2' });
  await new Promise(r => setTimeout(r, 5));
  const denied = await ipc.handlers.get('ai:rewrite-cancel')(other, { requestId: 'r2' });
  assert.equal(denied.ok, false, '不能取消别的窗口的请求');
  const missing = await ipc.handlers.get('ai:rewrite-cancel')(mine, { requestId: 'nope' });
  assert.equal(missing.ok, true);
  assert.equal(missing.cancelled, false);
  assert.equal(missing.reason, 'not-found');
  await ipc.handlers.get('ai:rewrite-cancel')(mine, { requestId: 'r2' });
  await pending;
  svc.dispose();
});

test('窗口销毁收尾：sweepOwner 中止该窗口所有在途请求，别窗口不受影响', async () => {
  const ipc = makeIpc();
  const aborted = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted.push(url);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
    setTimeout(() => resolve(openaiReply(REPLY)), 400);   // 400ms 后自然成功
  });
  /* 超时压到 3s：窗口 8 那条会在 400ms 自然成功，不会被超时干扰。 */
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc, authorize: alwaysTrust,
    readSettings: () => ({ aiRewriteTimeoutMs: '3000' }),
    env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
  });
  const winA = { sender: { id: 7 } }, winB = { sender: { id: 8 } };
  const a1 = ipc.handlers.get('ai:rewrite')(winA, { selection: SELECTION }, { requestId: 'a1' });
  const a2 = ipc.handlers.get('ai:rewrite')(winA, { selection: SELECTION }, { requestId: 'a2' });
  const b1 = ipc.handlers.get('ai:rewrite')(winB, { selection: SELECTION }, { requestId: 'b1' });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(svc.inflightSize(), 3);
  const swept = svc.sweepOwner('7');
  assert.equal(swept, 2, '窗口 7 名下两条都要被收掉');
  assert.equal(svc.inflightSize(), 1, '窗口 8 的不受影响');
  const [ra1, ra2, rb1] = await Promise.all([a1, a2, b1]);
  assert.equal(ra1.code, 'cancelled');
  assert.equal(ra2.code, 'cancelled');
  assert.equal(rb1.ok, true, '窗口 8 那条照常成功（证明 sweep 没有误伤）');
  assert.equal(aborted.length, 2, '恰好两条被 abort');
  svc.dispose();
});

test('信任校验：authorize 不通过 ⇒ 回绝、不发请求、不建 inflight 记录', async () => {
  const ipc = makeIpc();
  const fetchImpl = fakeFetch({ default: openaiReply(REPLY) });
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc,
    authorize: async () => ({ ok: false, code: 'MP_AI_FRAME', error: '只接受编辑器主框架发起的请求' }),
    readSettings: () => ({}), env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
  });
  const res = await ipc.handlers.get('ai:rewrite')({ sender: { id: 1 } }, { selection: SELECTION }, { requestId: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MP_AI_FRAME');
  assert.equal(fetchImpl.calls.length, 0, '不可信来源不许出网');
  assert.equal(svc.inflightSize(), 0, '不可信来源不建记录');
  // status 与 cancel 也走同一道闸
  const st = await ipc.handlers.get('ai:status')({ sender: { id: 1 } });
  assert.equal(st.ok, false);
  const cc = await ipc.handlers.get('ai:rewrite-cancel')({ sender: { id: 1 } }, { requestId: 'x' });
  assert.equal(cc.ok, false);
  svc.dispose();
});

test('重复 requestId：旧的被中止，不并行两条', async () => {
  const ipc = makeIpc();
  const aborted = [];
  let n = 0;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const mine = ++n;
    init.signal.addEventListener('abort', () => {
      aborted.push(mine);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
    if (mine === 2) setTimeout(() => resolve(openaiReply(REPLY)), 5);
  });
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc, authorize: alwaysTrust, readSettings: () => ({}), env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
  });
  const ev = { sender: { id: 1 } };
  const first = ipc.handlers.get('ai:rewrite')(ev, { selection: SELECTION }, { requestId: 'dup' });
  await new Promise(r => setTimeout(r, 5));
  const second = ipc.handlers.get('ai:rewrite')(ev, { selection: SELECTION }, { requestId: 'dup' });
  const r1 = await first;
  const r2 = await second;
  assert.equal(r1.code, 'cancelled', '旧的必须被中止');
  assert.equal(r2.ok, true, '新的照常完成');
  assert.deepEqual(aborted, [1]);
  assert.equal(svc.inflightSize(), 0);
  svc.dispose();
});

test('ai:status 给的是遮蔽摘要（永不带密钥）', async () => {
  const ipc = makeIpc();
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc, authorize: alwaysTrust, readSettings: () => ({}), env: { DEEPSEEK_API_KEY: SECRET },
  });
  const st = await ipc.handlers.get('ai:status')({ sender: { id: 1 } });
  assert.equal(st.ok, true);
  assert.equal(st.configured, true);
  assert.equal(JSON.stringify(st).includes(SECRET), false);
  assert.equal(st.config.keyEnv, 'DEEPSEEK_API_KEY');
  svc.dispose();
});

test('dispose 中止所有在途请求并移除三条通道', async () => {
  const ipc = makeIpc();
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc, authorize: alwaysTrust, readSettings: () => ({}), env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl,
  });
  const pending = ipc.handlers.get('ai:rewrite')({ sender: { id: 1 } }, { selection: SELECTION }, { requestId: 'd1' });
  await new Promise(r => setTimeout(r, 5));
  svc.dispose();
  const res = await pending;
  assert.equal(res.code, 'cancelled');
  assert.equal(ipc.handlers.has('ai:rewrite'), false);
  assert.equal(ipc.handlers.has('ai:rewrite-cancel'), false);
  assert.equal(ipc.handlers.has('ai:status'), false);
});
