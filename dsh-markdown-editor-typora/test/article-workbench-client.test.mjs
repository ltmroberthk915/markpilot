// 父工作台（lib/client.js）· 文章 / AI / 公众号上行转发 + 编辑框下载放行。
//
// 这些判据只跑**产品代码本体**：用 vm 按装载器形态加载 client.js，取 factory 暴露的
// `__test.createArticleForwarder`（与运行时同一个函数），注入一个假的 `api` 服务。
// 不启宿主、不连网络、不碰 DOM、不需要权限。
//
// 运行：node test/article-workbench-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

/** 按 dsh-client-modules 装载契约执行 client.js，拿回 factory 暴露的 __test。 */
async function loadClientTest() {
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition; } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'window.__ModuleLoader__.load was not called');
  const mod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  assert.ok(mod.__test, 'factory must expose __test helpers');
  return mod.__test;
}

/** 本 realm 的普通值（vm 子 realm 的原型不同，deepEqual 之前统一）。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 记录每次服务端调用的假 api；`answers` 决定每一跳回什么。 */
function fakeApi(handler) {
  const calls = [];
  const api = async (endpoint, payload) => {
    const record = { endpoint, payload: plain(payload) };
    calls.push(record);
    return handler(endpoint, payload, calls.length);
  };
  api.calls = calls;
  api.endpoints = () => calls.map((call) => call.endpoint);
  return api;
}

/** 一次父层绑定的真值快照（与 client.js 里 hostInvokeBinding() 同形）。 */
function binding(overrides = {}) {
  return {
    tabId: 'tab-1',
    docToken: 'dshdoc-abc-1',
    generation: 7,
    path: 'C:\\Docs\\Note.md',
    sessionId: 'sess-live-1',
    alive: () => true,
    ...overrides,
  };
}

const ALL_METHODS = [
  'aiRewrite', 'aiRewriteCancel', 'aiStatus', 'aiDiag',
  'wxStatus', 'wxConfigure', 'wxClear', 'wxVerify', 'wxPickCover', 'wxCreateDraft', 'wxAcknowledge',
];

/* ══ 1. 白名单与转发形状 ══════════════════════════════════════════════════════ */

test('cmd 就是公共方法名：11 个方法各自转发到 article/<cmd>，没有别的转发面', async () => {
  const T = await loadClientTest();
  assert.deepEqual(plain(T.articleMethods()), ALL_METHODS);

  const api = fakeApi(() => ({ ok: true, echo: 'pong' }));
  const forwarder = T.createArticleForwarder({ api });
  for (const method of ALL_METHODS) {
    assert.equal(forwarder.handles(method), true, method);
    const result = await forwarder.call(method, { probe: method }, binding());
    assert.equal(result.ok, true, method);
    assert.equal(result.echo, 'pong');
  }
  assert.deepEqual(api.endpoints(), ALL_METHODS.map((method) => 'article/' + method));

  /* 白名单之外一律不接管（父层仍旧回 null，不做通用转发）。 */
  for (const cmd of ['export-pdf', 'clipboard-read-text', 'article/bind', 'aiRewrite__proto__', 'articleDelete', 'wxPublish', '']) {
    assert.equal(forwarder.handles(cmd), false, cmd);
  }
  for (const cmd of [null, undefined, 42, {}, []]) assert.equal(forwarder.handles(cmd), false, String(cmd));
});

test('绑定的五个字段全部来自父层真值；子层自报的身份/位置一个字节都进不去', async () => {
  const T = await loadClientTest();
  const api = fakeApi(() => ({ ok: true }));
  const forwarder = T.createArticleForwarder({ api });

  const forged = {
    title: '真标题',
    selection: '选中的文字',
    ownerId: 'attacker-owner',
    owner: { id: 'attacker' },
    sessionId: 'attacker-session',
    docToken: 'attacker-token',
    generation: 999,
    tabId: 'attacker-tab',
    path: 'C:\\Windows\\win.ini',
    docPath: 'C:\\Windows\\win.ini',
    dir: 'C:\\Windows',
    workspace: 'C:\\',
    current: true,
    isCurrent: () => true,
    binding: { docToken: 'attacker-token' },
    capability: 'attacker-capability',
  };
  await forwarder.call('aiRewrite', forged, binding());

  const sent = api.calls[0];
  assert.equal(sent.endpoint, 'article/aiRewrite');
  /* 子层自报的身份/位置**一个都不许原样过线**：要么字段不存在，要么值来自父层而不是伪造值。 */
  const forgedValues = {
    ownerId: 'attacker-owner', sessionId: 'attacker-session', docToken: 'attacker-token',
    tabId: 'attacker-tab', path: 'C:\\Windows\\win.ini', docPath: 'C:\\Windows\\win.ini',
    dir: 'C:\\Windows', workspace: 'C:\\', current: true, isCurrent: 'function', capability: 'attacker-capability',
  };
  for (const [key, forgedValue] of Object.entries(forgedValues)) {
    if (!Object.hasOwn(sent.payload, key)) continue;                    // 没带 = 安全
    assert.notEqual(sent.payload[key], forgedValue, '子层伪造值过线了：' + key);
  }
  for (const key of ['owner', 'generation', 'binding', 'generation']) {
    assert.equal(Object.hasOwn(sent.payload, key), false, '子层字段不该被转发：' + key);
  }
  /* 绑定是父层自己那一份，且按契约 §2 **平铺在顶层**（不套 binding 外壳）。 */
  assert.equal(Object.hasOwn(sent.payload, 'binding'), false, '不许套 binding 外壳');
  assert.equal(sent.payload.docToken, 'dshdoc-abc-1', 'docToken 必须是父层真值');
  /* aiRewrite 已展平：iframe 的 payload.selection → 顶层 text；业务 instruction 保留。 */
  assert.equal(sent.payload.text, '选中的文字');
  assert.equal(Object.hasOwn(sent.payload, 'selection'), false, 'selection 必须展平成 text');
  assert.equal(Object.hasOwn(sent.payload, 'payload'), false, '不许套 iframe payload 外壳');
});

test('同目录换稿：只有 docToken/代次变了，绑定就必须跟着变（不能让子层"看起来没变"）', async () => {
  const T = await loadClientTest();
  const api = fakeApi(() => ({ ok: true }));
  const forwarder = T.createArticleForwarder({ api });
  const sameDir = 'C:\\Docs';

  await forwarder.call('wxStatus', {}, binding({ path: sameDir + '\\A.md', docToken: 'token-A', generation: 1 }));
  await forwarder.call('wxStatus', {}, binding({ path: sameDir + '\\B.md', docToken: 'token-B', generation: 2 }));

  assert.equal(api.calls[0].payload.docToken, 'token-A');
  assert.equal(api.calls[1].payload.docToken, 'token-B');
  assert.equal(api.calls[0].payload.path, undefined, '续调只带 docToken（契约 §3），path 只在 bind 里给');
});

/* ══ 2. 文档切换 / 关闭：旧代次的回包绝不投到新稿 ══════════════════════════════ */

test('回包闸门：调用期间文档被切走 ⇒ 结果换成 MP_ARTICLE_DOC_CHANGED，真实回包不外泄', async () => {
  const T = await loadClientTest();
  let live = true;
  const api = fakeApi(async () => {
    live = false;                                    // 请求飞行中切文档
    return { ok: true, mediaId: 'DRAFT-OF-OLD-DOC', title: '旧稿标题' };
  });
  const forwarder = T.createArticleForwarder({ api });
  const result = await forwarder.call('wxCreateDraft', { title: '旧稿' }, binding({ alive: () => live }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MP_ARTICLE_DOC_CHANGED');
  assert.equal(JSON.stringify(result).includes('DRAFT-OF-OLD-DOC'), false, '旧稿回包不许流出去');
  assert.equal(JSON.stringify(result).includes('旧稿标题'), false);
});

test('回包闸门：关标签页（alive=false）后连早到的成功也按已切换处理；alive 抛错同样算失效', async () => {
  const T = await loadClientTest();
  const api = fakeApi(() => ({ ok: true, value: 1 }));

  const closed = T.createArticleForwarder({ api });
  const closedResult = await closed.call('aiStatus', {}, binding({ alive: () => false }));
  assert.equal(closedResult.error.code, 'MP_ARTICLE_DOC_CHANGED');

  const throwing = T.createArticleForwarder({ api });
  const throwingResult = await throwing.call('aiStatus', {}, binding({ alive: () => { throw new Error('boom'); } }));
  assert.equal(throwingResult.error.code, 'MP_ARTICLE_DOC_CHANGED');

  /* 对照臂：同一份代码，alive 为真时结果原样返回（证明上面拒的是闸门而不是别的）。 */
  const alive = T.createArticleForwarder({ api });
  assert.deepEqual(plain(await alive.call('aiStatus', {}, binding())), { ok: true, value: 1 });
});

/* ══ 3. 先绑定：article/bind + 内存 capability ════════════════════════════════ */

test('服务端要求先绑定：自动 bind → 带 capability 重试一次；同一个代次之后复用缓存', async () => {
  const T = await loadClientTest();
  let bound = 0;
  const api = fakeApi((endpoint, payload) => {
    if (endpoint === 'article/bind') {
      bound += 1;
      return { ok: true, capability: 'cap-1' };
    }
    if (!payload.capability) return { ok: false, error: { code: 'MP_ARTICLE_BIND_REQUIRED', message: 'bind first' } };
    return { ok: true, capabilityUsed: payload.capability };
  });
  const forwarder = T.createArticleForwarder({ api });

  const first = await forwarder.call('aiStatus', {}, binding());
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.capabilityUsed, 'cap-1');
  assert.deepEqual(api.endpoints(), ['article/aiStatus', 'article/bind', 'article/aiStatus'], '第一次：直连 → bind → 重试');
  assert.equal(bound, 1);
  assert.deepEqual(plain(api.calls[1].payload), { sessionId: 'sess-live-1', path: 'C:\\Docs\\Note.md', docToken: 'dshdoc-abc-1', tabId: 'tab-1' }, 'bind 必须是顶层四字段');

  const second = await forwarder.call('wxStatus', {}, binding());
  assert.equal(second.ok, true);
  assert.deepEqual(api.endpoints().slice(3), ['article/wxStatus'], '缓存命中后不再 bind');
  assert.equal(api.calls[3].payload.capability, 'cap-1');
  assert.equal(bound, 1, 'capability 只申请一次');
});

test('capability 只在同一代内有效：换代次/换文档必须重新绑定，旧 capability 不被沿用', async () => {
  const T = await loadClientTest();
  const api = fakeApi((endpoint, payload) => {
    if (endpoint === 'article/bind') return { ok: true, capability: 'cap-for-' + payload.docToken };
    if (!payload.capability) return { ok: false, error: { code: 'MP_ARTICLE_BIND_REQUIRED' } };
    return { ok: true, used: payload.capability };
  });
  const forwarder = T.createArticleForwarder({ api });

  const a = await forwarder.call('aiStatus', {}, binding({ docToken: 'doc-A', generation: 1 }));
  const b = await forwarder.call('aiStatus', {}, binding({ docToken: 'doc-B', generation: 2 }));
  assert.equal(a.used, 'cap-for-doc-A');
  assert.equal(b.used, 'cap-for-doc-B', '换了文档必须拿到新 capability');
  assert.equal(forwarder.inspect().held.length, 2, '两代各持一张，互不覆盖');
});

test('服务端拒绝绑定 ⇒ 原样把失败交回去，不重试、不伪造成功', async () => {
  const T = await loadClientTest();
  const api = fakeApi((endpoint) => {
    if (endpoint === 'article/bind') return { ok: false, error: { code: 'MP_ARTICLE_FORBIDDEN', message: 'no article permission' } };
    return { ok: false, error: { code: 'MP_ARTICLE_BIND_REQUIRED' } };
  });
  const forwarder = T.createArticleForwarder({ api });
  const result = await forwarder.call('wxCreateDraft', { title: 't' }, binding());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MP_ARTICLE_FORBIDDEN');
  assert.deepEqual(api.endpoints(), ['article/wxCreateDraft', 'article/bind'], '只重试一次且不绕过失败');
  assert.deepEqual(plain(forwarder.inspect().held), []);
});

test('绑定成功但没给 capability ⇒ 判为绑定失败（不把 undefined 当 capability 发出去）', async () => {
  const T = await loadClientTest();
  const api = fakeApi((endpoint) => {
    if (endpoint === 'article/bind') return { ok: true };
    return { ok: false, error: { code: 'MP_ARTICLE_UNBOUND' } };
  });
  const forwarder = T.createArticleForwarder({ api });
  const result = await forwarder.call('aiDiag', {}, binding());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MP_ARTICLE_BINDING');
  assert.deepEqual(api.endpoints(), ['article/aiDiag', 'article/bind']);
});

test('传输失败被包成 MP_ARTICLE_TRANSPORT（不把异常抛给 iframe）', async () => {
  const T = await loadClientTest();
  const forwarder = T.createArticleForwarder({ api: async () => { throw new Error('HTTP 500'); } });
  const result = await forwarder.call('aiStatus', {}, binding());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MP_ARTICLE_TRANSPORT');
  assert.match(result.error.message, /HTTP 500/);
});

/* ══ 4. 退场：article/unbind 与内存清理 ══════════════════════════════════════ */

test('退场解绑：有 capability 才发 article/unbind，同一代重复退场是幂等的', async () => {
  const T = await loadClientTest();
  const api = fakeApi((endpoint) => {
    if (endpoint === 'article/bind') return { ok: true, capability: 'cap-x' };
    if (endpoint === 'article/unbind') return { ok: true };
    return { ok: false, error: { code: 'MP_ARTICLE_BIND_REQUIRED' } };
  });
  const forwarder = T.createArticleForwarder({ api });
  await forwarder.call('aiStatus', {}, binding());

  const first = await forwarder.release(binding());
  assert.equal(first.released, true);
  assert.deepEqual(api.endpoints().slice(-1), ['article/unbind']);
  const unbind = api.calls.find((call) => call.endpoint === 'article/unbind');
  assert.equal(unbind.payload.capability, 'cap-x');
  assert.equal(unbind.payload.docToken, 'dshdoc-abc-1', 'unbind 也带顶层 docToken');
  assert.deepEqual(plain(forwarder.inspect().held), [], '内存里的 capability 必须被清掉');

  const again = await forwarder.release(binding());
  assert.equal(again.released, false, '同一代重复退场不再发请求');
  assert.equal(api.endpoints().filter((endpoint) => endpoint === 'article/unbind').length, 1);
});

test('从没绑定过就退场：不发任何请求（切换文档不该产生空请求）', async () => {
  const T = await loadClientTest();
  const api = fakeApi(() => ({ ok: true }));
  const forwarder = T.createArticleForwarder({ api });
  const result = await forwarder.release(binding());
  assert.equal(result.ok, true);
  assert.equal(result.released, false);
  assert.deepEqual(api.calls, []);
});

test('退场时服务端报错：仍然算已退场（内存已清），只带一条 warning', async () => {
  const T = await loadClientTest();
  const api = fakeApi((endpoint) => {
    if (endpoint === 'article/bind') return { ok: true, capability: 'cap-y' };
    if (endpoint === 'article/unbind') throw new Error('server gone');
    return { ok: false, error: { code: 'MP_ARTICLE_BIND_REQUIRED' } };
  });
  const forwarder = T.createArticleForwarder({ api });
  await forwarder.call('aiStatus', {}, binding());
  const result = await forwarder.release(binding());
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.match(result.warning, /server gone/);
  assert.deepEqual(plain(forwarder.inspect().held), []);
});

/* ══ 5. 构造契约 ══════════════════════════════════════════════════════════════ */

test('缺 api 直接抛错（配置期失败要早暴露，不能静默变成一个永不回应的转发器）', async () => {
  const T = await loadClientTest();
  assert.throws(() => T.createArticleForwarder({}), /api/);
  assert.throws(() => T.createArticleForwarder(), /api/);
});

/* ══ 6. 下载放行（源码级，钉住"只放开固定编辑框"这条边界）══════════════════════ */

test('固定 CM6 编辑框的 sandbox 放行 allow-downloads，且原有能力一个不少', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8');
  const matches = [...source.matchAll(/sandbox:\s*"([^"]*)"/g)].map((match) => match[1]);
  assert.ok(matches.length > 0, '必须能找到 sandbox 声明（否则这把尺子看不见任何东西）');

  const editorSandbox = matches.filter((value) => value.includes('allow-forms'));
  assert.equal(editorSandbox.length, 1, '固定编辑框应当只有一处 sandbox 声明');
  const value = editorSandbox[0];
  assert.ok(value.includes('allow-downloads'), '编辑框必须放行下载，否则单文件 HTML 导出被浏览器拒绝：' + value);
  for (const capability of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-modals']) {
    assert.ok(value.includes(capability), '原有能力不许丢：' + capability);
  }
});

test('下载放行只加在编辑框：没有第二处被顺手放开，内容预览 iframe 不受影响', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8');
  const withDownloads = [...source.matchAll(/sandbox:\s*"([^"]*allow-downloads[^"]*)"/g)];
  assert.equal(withDownloads.length, 1, 'allow-downloads 只允许出现在固定编辑框这一处');

  /* 阳性对照：这份文件里确实存在其它 sandbox（预览/打印），说明搜索本身看得见。 */
  const all = [...source.matchAll(/sandbox(?:=|:)\s*"([^"]*)"/g)].map((match) => match[1]);
  assert.ok(all.length >= 1, '至少要能看到一处 sandbox 声明');
});

test('iframe 上行转发只在受信 message 源校验之后（onMessage 的 doc 代际闸门）', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8');
  /* 三件事必须同处一段：只认当前代 iframe、host-invoke 路由、绑定取自父层。 */
  assert.match(source, /event\.source !== liveWin/, '必须比对消息来源是当前代 iframe');
  assert.match(source, /type === "host-invoke"\)\s*\{\s*handleHostInvoke\(data\.content, post, hostInvokeBinding\(\)\)/, 'host-invoke 必须带上父层绑定');
  assert.match(source, /function hostInvokeBinding\(\)/, '必须存在父层绑定取值函数');
  assert.match(source, /docToken: String\(doc\.token \|\| ""\)/, 'docToken 取自这一代的 doc');
  assert.match(source, /generation: doc\.gen/, '代次取自这一代的 doc');
  assert.match(source, /tabId: String\(\(tab && \(tab\.occurrenceId \|\| tab\.id\)\) \|\| ""\)/, 'tabId 取自 tab 实例');
  assert.match(source, /currentConversationSessionId\(\) \|\| workspaceContext\(\)\.sessionId/, 'sessionId 取当前工作台对话');
});
