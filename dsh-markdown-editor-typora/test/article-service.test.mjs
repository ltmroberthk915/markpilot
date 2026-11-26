// 工作台 article/*（服务端）：真 HTTP 路由 + 真 article-service + 本地假模型。
//
// 鉴别力声明（每条都对应一个真实会坏的行为；注掉修复必须变红）：
//   A1 bind 只认编辑器 open 过的文档 —— 未打开过的路径必须 MP_ARTICLE_NO_DOC；
//   A2 同目录换文件 / 换稿 ⇒ docToken 变 ⇒ 后续请求 MP_ARTICLE_STALE；
//   A3 capability 与连接同伴绑定 —— 另一个连接的 capability 不能冒充；
//   A4 body 自报的 provider/model 一律不采信；
//   A5 **[审阅点1]** agents.get().model.current() 空时必须读 session 的 modelSelection 投影；
//      投影也空 ⇒ MP_ARTICLE_NO_MODEL，且**一次模型调用都不发生**；即使部署默认存在也不用它；
//   A6 只发选中文字：假模型收到的 messages 里不含文档其它内容；
//   A7 取消是真的停流（模型侧观察到 abort），不是只丢回包；
//   A8 TTL 过期后 capability 拒绝；A9 unbind 后失效；
//   A10 wx 的 scope 由服务端构造：body 里的 dir/path/ownerId 不参与授权；
//   A11 wx createDraft 前按文档权威复核；
//   A12 未知方法 404、非 JSON 415、无连接身份 503；
//   A13 **[审阅点2]** capability 来自 CSPRNG（uuid 形态、两次不同、无序号）；
//   A14 **[审阅点2]** 同 tabId 重绑只驱逐**同 peer** 的旧绑定，不误伤别的连接；
//   A15 **[审阅点3]** principal 缺项/非 owner 一律拒绝；
//   A16 **[审阅点3]** 文档必须在会话工作区内才算绑定成功；
//   A17 **[审阅点4]** wx 只有六个动作、无发布/群发，且不接收路径读盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, isAbsolute } from 'node:path';
import { createHost, createArticleService } from '../lib/index.js';

const SILENT_LOG = { info() {}, warn() {} };
/**
 * 本版本宿主形态：同一个 connection 服务**同时**有
 *   · `requestRejection` —— 路由入口的信任栅栏（既有端点与 article/* 共用）；
 *   · `admit`            —— 给出带 principal 的 peer（article/* 的连接身份）。
 * 真实 DSH 就是这样；只给 admit 会让路由先被栅栏 503 掉，测不到 article 层。
 */
const makeAdmitConnection = (peerId = 'peer-A', principal = { kind: 'owner' }) => ({
  requestRejection: () => undefined,
  admit: () => ({ peer: { id: peerId, principal } }),
});
/** 只有 requestRejection（旧宿主形态，没有 admit）。 */
const LEGACY_CONNECTION = { requestRejection: () => undefined };

function createMockFs(initialFiles) {
  const files = new Map();
  let serial = 0;
  for (const [filePath, text] of Object.entries(initialFiles || {})) {
    files.set(normalize(filePath), { text: String(text), version: `v${++serial}`, type: 'file' });
  }
  return {
    files,
    async resolve(path, opts) {
      let target = String(path);
      if (!isAbsolute(target)) target = join(opts?.cwd ?? 'D:/workspace', target);
      return { targetKey: normalize(target), displayPath: normalize(target) };
    },
    async stat(target) {
      const file = files.get(target.targetKey);
      if (!file) return undefined;
      return { version: file.version, size: Buffer.byteLength(file.text, 'utf8'), type: file.type };
    },
    async readText(target) {
      const file = files.get(target.targetKey);
      if (!file) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
      return file.text;
    },
    async writeText(target, text, expected) {
      const file = files.get(target.targetKey);
      if (!file) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
      if (expected?.version && file.version !== expected.version) {
        throw Object.assign(new Error('file changed'), { code: 'FS_STALE_VERSION' });
      }
      file.text = String(text);
      file.version = `v${++serial}`;
      return { version: file.version, before: file.text, after: file.text };
    },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
}

/** 本地假模型：真 async generator；能观察取消、记录收到的消息。 */
function createFakeLlm(options = {}) {
  const calls = [];
  const state = { abortSeen: false, aborted: false };
  return {
    calls,
    state,
    stream(request) {
      calls.push({
        provider: request?.provider,
        model: request?.model,
        reasoningEffort: request?.reasoningEffort,
        system: request?.system,
        messages: JSON.parse(JSON.stringify(request?.messages ?? [])),
        tools: request?.tools,
        hasSignal: !!request?.signal,
      });
      const reply = typeof options.reply === 'function' ? options.reply(request, calls.length) : (options.reply ?? '润色后的文字');
      const signal = request?.signal;
      async function* run() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        if (options.hold === true) {
          await new Promise((resolve) => {
            if (signal?.aborted) { state.abortSeen = true; resolve(); return; }
            signal?.addEventListener('abort', () => { state.abortSeen = true; resolve(); }, { once: true });
            setTimeout(resolve, options.holdMs ?? 5000);
          });
          if (signal?.aborted) {
            state.aborted = true;
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } };
            return;
          }
        }
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return run();
    },
  };
}

function createFakeWechat() {
  const calls = [];
  const currentOf = (scope) => (typeof scope?.isCurrent === 'function' ? scope.isCurrent() : null);
  return {
    calls,
    handle(action, payload, scope) {
      calls.push({
        action,
        payload: JSON.parse(JSON.stringify(payload ?? {})),
        ownerId: scope?.ownerId,
        tabId: scope?.tabId,
        documentId: scope?.documentId,
        path: scope?.path,
        isCurrent: currentOf(scope),
        alive: typeof scope?.alive === 'function' ? scope.alive() : null,
      });
      if (action === 'createDraft') {
        /* 与真实 wechat-draft.js 同口径：建稿前调 scope.isCurrent()，假就停。 */
        if (currentOf(scope) !== true) {
          return { ok: false, stage: 'owner', code: 'MP_WX_DOC_CHANGED', error: 'changed', draftCreated: false, mediaId: null };
        }
        return { ok: true, stage: 'done', mediaId: 'media-1', title: payload?.title };
      }
      if (action === 'status') return { ok: true, configured: false, appId: null, keystore: false, pending: null };
      return { ok: true };
    },
  };
}

/** 一个 host + 真路由（HTTP）；services 表可中途替换（模拟会话/模型变化）。 */
async function makeHost({ connection = makeAdmitConnection(), services: initial = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mp-article-'));
  const filePath = join(dir, 'doc.md');
  await writeFile(filePath, '# 标题\n\n正文第一段。\n\n另一段不该发给模型。\n', 'utf8');
  const fs = createMockFs({ [filePath]: '# 标题\n\n正文第一段。\n\n另一段不该发给模型。\n' });
  const services = new Map(Object.entries(initial));
  if (connection) services.set('connection', connection);
  const host = createHost({
    fs,
    log: SILENT_LOG,
    connectionProvider: () => services.get('connection'),
    getService: (name) => services.get(name),
  });
  const server = http.createServer((req, res) => host.route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = async (method, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-markdown-editor-typora/api/article/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    return { status: res.status, json };
  };
  return {
    host, fs, dir, filePath, port, call, server, services, connection,
    async openDocument() {
      const opened = await host.dispatch('open', { path: filePath });
      assert.equal(opened.ok, true, 'open 必须成功');
      return opened.value;
    },
    async done() {
      await new Promise((resolve) => server.close(resolve));
      host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 直连 article 服务（绕过 HTTP，用于注入 resolveDocument/wechat/clock）。 */
function makeService(env, overrides = {}) {
  /* 默认文档权威与真 host 的 readingTarget 同口径：**只有这份被编辑器 open 过的文件**算数。
     别的路径一律 ok:false —— 否则"没打开过的路径也能绑定"这类回归就测不出来。 */
  const opened = normalize(env.filePath);
  return createArticleService({
    getService: (name) => env.services.get(name),
    resolveDocument: overrides.resolveDocument
      ?? (async (rawPath) => (normalize(String(rawPath)) === opened
        ? { ok: true, canonicalPath: opened }
        : { ok: false })),
    wechat: overrides.wechat ?? (async () => null),
    loadRewrite: overrides.loadRewrite ?? (async () => import('../lib/selection-rewrite-model.js')),
    now: overrides.now,
    log: SILENT_LOG,
    ...(overrides.modelSelectionFor ? { modelSelectionFor: overrides.modelSelectionFor } : {}),
  });
}

const OWNER = { headers: {} };

/** 装一个"用户已选路由"的会话投影（本安装版本的 wire 读面）。 */
function selectRoute(env, provider = 'p', model = 'm', reasoningEffort = null) {
  env.services.set('sessionProjections', {
    snapshot: () => ({
      asOfSeq: 1,
      values: {
        modelSelection: {
          lastUsed: null,
          next: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
        },
      },
    }),
  });
}

/* ═════════════════════════ A1–A3：绑定与代次 ═════════════════════════ */

test('A1/A2 绑定只认编辑器打开过的文档；换稿后同 capability 立即失效', async () => {
  const env = await makeHost({
    services: {
      sessions: { get: (id) => (id === 'S1' ? { id: 'S1', header: { cwd: 'D:/workspace' } } : undefined) },
      agents: { get: () => undefined },
      llm: createFakeLlm(),
    },
  });
  try {
    await env.openDocument();
    /* 让会话工作区包含该文档（这里是 host 的真实目录）。 */
    env.services.set('sessions', { get: (id) => (id === 'S1' ? { id: 'S1', header: { cwd: env.dir } } : undefined) });

    const notOpened = await env.call('bind', {
      sessionId: 'S1', path: join(env.dir, 'never-opened.md'), docToken: 't1',
    });
    assert.equal(notOpened.json.ok, false);
    assert.equal(notOpened.json.code, 'MP_ARTICLE_NO_DOC');

    const noSession = await env.call('bind', { sessionId: 'S-missing', path: env.filePath, docToken: 't1' });
    assert.equal(noSession.json.code, 'MP_ARTICLE_NO_SESSION');

    const bound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1', tabId: 'tab-1' });
    assert.equal(bound.json.ok, true, JSON.stringify(bound.json));

    const stale = await env.call('aiStatus', { capability: bound.json.capability, docToken: 't2' });
    assert.equal(stale.json.ok, false);
    assert.equal(stale.json.code, 'MP_ARTICLE_STALE');

    const noToken = await env.call('aiStatus', { capability: bound.json.capability });
    assert.equal(noToken.json.code, 'MP_ARTICLE_STALE');

    const rebound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't9', tabId: 'tab-1' });
    assert.equal(rebound.json.ok, true);
    const old = await env.call('aiStatus', { capability: bound.json.capability, docToken: 't1' });
    assert.equal(old.json.code, 'MP_ARTICLE_UNBOUND');
  } finally {
    await env.done();
  }
});

test('A3 capability 与连接同伴绑定：别人的 capability 不能冒充', async () => {
  const env = await makeHost({
    services: { sessions: { get: () => undefined }, agents: { get: () => undefined }, llm: createFakeLlm() },
  });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });

    const bound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(bound.json.ok, true);

    const mine = await env.call('aiStatus', { capability: bound.json.capability, docToken: 't1' });
    assert.equal(mine.json.ok, true);

    /* 另一个连接（admit 给出不同 peer）⇒ UNBOUND */
    env.services.set('connection', makeAdmitConnection('peer-OTHER'));
    const other = await env.call('aiStatus', { capability: bound.json.capability, docToken: 't1' });
    assert.equal(other.json.ok, false);
    assert.equal(other.json.code, 'MP_ARTICLE_UNBOUND');
  } finally {
    await env.done();
  }
});

/* ═════════════════ A4–A6：模型路由与只发选区 ═════════════════ */

test('A4/A5/A6 模型路由只来自 modelSelection 投影；无选择不发请求；只发选中文字', async () => {
  const llm = createFakeLlm({ reply: '润色后的句子。' });
  const env = await makeHost({
    services: {
      sessions: { get: () => ({ id: 'S1', header: { cwd: 'D:/workspace' } }) },
      agents: { get: () => undefined },
      llm,
      /* 部署默认**存在**，但它绝不能替会话做选择（审阅点1）。 */
      agentDefaultModel: { currentSelection: () => ({ provider: 'other-provider', model: 'other-model' }) },
    },
  });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    const bound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    const capability = bound.json.capability;

    /* 投影 next=null、无 pending/lastUsed ⇒ NO_MODEL（**不**用部署默认、不调用模型） */
    env.services.set('sessionProjections', {
      snapshot: () => ({ asOfSeq: 1, values: { modelSelection: { lastUsed: null, next: null } } }),
    });
    const noModel = await env.call('aiRewrite', {
      capability, docToken: 't1', requestId: 'r0', text: '正文第一段。',
      provider: 'attacker', model: 'attacker-model',
    });
    assert.equal(noModel.json.ok, false);
    assert.equal(noModel.json.code, 'MP_ARTICLE_NO_MODEL');
    assert.match(noModel.json.error, /请先在当前对话选择模型/);
    assert.equal(llm.calls.length, 0, '没有会话模型时不许发起任何模型调用（更不许用部署默认）');

    /* 用户已选路由（wire next 有值）⇒ 用它 */
    env.services.set('sessionProjections', {
      snapshot: () => ({ asOfSeq: 2, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'low' } } } }),
    });
    const ok = await env.call('aiRewrite', {
      capability, docToken: 't1', requestId: 'r1', text: '正文第一段。',
      provider: 'attacker', model: 'attacker-model',
    });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    assert.equal(ok.json.text, '润色后的句子。');
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].provider, 'deepseek-official');
    assert.equal(llm.calls[0].model, 'deepseek-v4');
    assert.equal(llm.calls[0].reasoningEffort, 'low');
    assert.equal(ok.json.source, 'session-projection');

    /* 兼容读面 stateOf(session,'modelSelection') 的 pending 优先于 lastUsed */
    env.services.set('sessionProjections', {
      stateOf: (session, key) => (key === 'modelSelection'
        ? { lastUsed: { provider: 'old-p', model: 'old-m' }, pending: { provider: 'new-p', model: 'new-m', reasoningEffort: 'high' } }
        : undefined),
    });
    const pending = await env.call('aiRewrite', { capability, docToken: 't1', requestId: 'r3', text: '正文第一段。' });
    assert.equal(pending.json.ok, true, JSON.stringify(pending.json));
    assert.equal(pending.json.provider, 'new-p');
    assert.equal(pending.json.model, 'new-m');
    assert.equal(llm.calls.at(-1).reasoningEffort, 'high');

    /* 只有 lastUsed（没有 pending）⇒ 用 lastUsed */
    env.services.set('sessionProjections', {
      stateOf: (_s, key) => (key === 'modelSelection'
        ? { lastUsed: { provider: 'used-p', model: 'used-m' }, pending: null }
        : undefined),
    });
    const lastUsed = await env.call('aiRewrite', { capability, docToken: 't1', requestId: 'r4', text: '正文第一段。' });
    assert.equal(lastUsed.json.provider, 'used-p');
    assert.equal(lastUsed.json.model, 'used-m');

    /* A6：只发选中文字，没有工具 */
    const body = JSON.stringify(llm.calls[0].messages);
    assert.ok(body.includes('正文第一段。'), '选中的文字必须发出去');
    assert.ok(!body.includes('另一段不该发给模型'), '选区之外的内容一个字都不许发');
    assert.ok(!body.includes(env.filePath), '路径不许出现在模型可见输入里');
    assert.equal(llm.calls[0].tools, undefined);
    assert.equal(llm.calls[0].hasSignal, true, '模型调用必须带 AbortSignal（取消要能真停流）');
  } finally {
    await env.done();
  }
});

test('A5b 反例：投影无选择但 agent.model.current() 有隐式默认 ⇒ 仍必须 NO_MODEL 且不调用模型', async () => {
  const llm = createFakeLlm({ reply: '不该出现的结果' });
  const env = await makeHost({
    services: {
      sessions: { get: () => ({ id: 'S1', header: { cwd: 'D:/workspace' } }) },
      /* 真实 DSH 的 AgentModel.current() = recordedSelection() ?? agent.options：
         全新 profile 无凭据时它照样回默认路由 —— 这正是实测踩到的坑。 */
      agents: {
        get: () => ({
          options: { provider: 'deepseek-official', model: 'deepseek-flash' },
          model: { current: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
        }),
      },
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
      /* 投影明确为空：UI 显示"请选择模型"，modelSelection.next === null */
      sessionProjections: {
        snapshot: () => ({ asOfSeq: 9, values: { modelSelection: { lastUsed: null, next: null } } }),
        stateOf: (_s, key) => (key === 'modelSelection' ? { lastUsed: null, pending: null } : undefined),
      },
    },
  });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    const bound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    const capability = bound.json.capability;

    /* aiStatus 必须如实说"不可用"，且不回显那个隐式默认路由 */
    const status = await env.call('aiStatus', { capability, docToken: 't1' });
    assert.equal(status.json.ok, true);
    assert.equal(status.json.available, false, '没有明确选择时 available 必须是 false');
    assert.equal(status.json.provider, null, '不许把 agent.options 的隐式默认当成已选模型');
    assert.equal(status.json.model, null);
    assert.equal(status.json.source, null);

    const rewrite = await env.call('aiRewrite', { capability, docToken: 't1', requestId: 'r1', text: '正文第一段。' });
    assert.equal(rewrite.json.ok, false);
    assert.equal(rewrite.json.code, 'MP_ARTICLE_NO_MODEL');
    assert.match(rewrite.json.error, /请先在当前对话选择模型/);
    assert.equal(llm.calls.length, 0, '隐式默认绝不能触发 llm.stream（否则就是 MISSING_CREDENTIAL 那种错）');
  } finally {
    await env.done();
  }
});

/* ═════════════════ A7–A9：取消 / 过期 / 解绑 ═════════════════ */

test('A7 取消是真停流；A9 unbind 后失效', async () => {
  const llm = createFakeLlm({ hold: true });
  const env = await makeHost({
    services: {
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      llm,
    },
  });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    selectRoute(env, 'p', 'm');
    const bound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    const capability = bound.json.capability;

    const pending = env.call('aiRewrite', { capability, docToken: 't1', requestId: 'r1', text: '要润色的句子。' });
    for (let i = 0; i < 400 && llm.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(llm.calls.length, 1, '模型调用应当已发起');

    const canceled = await env.call('aiRewriteCancel', { capability, docToken: 't1', requestId: 'r1' });
    assert.equal(canceled.json.ok, true);
    assert.equal(canceled.json.canceled, true);

    const result = await pending;
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, 'MP_REWRITE_ABORTED');
    assert.equal(llm.state.abortSeen, true, '取消必须真的让模型侧观察到 abort（不是只丢回包）');

    const noFlight = await env.call('aiRewriteCancel', { capability, docToken: 't1', requestId: 'nope' });
    assert.equal(noFlight.json.canceled, false);

    const released = await env.call('unbind', { capability, docToken: 't1' });
    assert.equal(released.json.ok, true);
    const afterUnbind = await env.call('aiStatus', { capability, docToken: 't1' });
    assert.equal(afterUnbind.json.code, 'MP_ARTICLE_UNBOUND');
  } finally {
    await env.done();
  }
});

test('A8 TTL 过期后 capability 拒绝（注入时钟，不真等）', async () => {
  let clock = 1_000_000;
  const wechat = createFakeWechat();
  const llm = createFakeLlm();
  const article = createArticleService({
    getService: (name) => {
      if (name === 'connection') return makeAdmitConnection('peer-x');
      if (name === 'sessions') return { get: () => ({ id: 'S1', header: { cwd: 'D:/workspace' } }) };
      if (name === 'agents') return { get: () => ({ model: { current: () => ({ provider: 'p', model: 'm' }) } }) };
      if (name === 'llm') return llm;
      return undefined;
    },
    resolveDocument: async () => ({ ok: true, canonicalPath: 'D:/workspace/doc.md' }),
    wechat: async () => wechat,
    now: () => clock,
    log: SILENT_LOG,
  });
  const bound = await article.handle('bind', { sessionId: 'S1', path: 'D:/workspace/doc.md', docToken: 't1' }, OWNER);
  assert.equal(bound.ok, true, JSON.stringify(bound));

  const alive = await article.handle('aiStatus', { capability: bound.capability, docToken: 't1' }, OWNER);
  assert.equal(alive.ok, true);

  clock += 13 * 60 * 60 * 1000;
  const expired = await article.handle('aiStatus', { capability: bound.capability, docToken: 't1' }, OWNER);
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'MP_ARTICLE_UNBOUND');
});

/* ═════════════════ A10/A11/A17：公众号 ═════════════════ */

test('A10/A11/A17 公众号：scope 由服务端构造；文档必须在；只有六个动作', async () => {
  const wechat = createFakeWechat();
  const env = await makeHost({
    services: {
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
    },
  });
  const article = makeService(env, { wechat: async () => wechat });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    selectRoute(env, 'p', 'm');

    /* 编辑器没打开过的路径不能绑定 */
    const notOpened = await article.handle('bind', {
      sessionId: 'S1', path: join(env.dir, 'elsewhere.md'), docToken: 't1',
    }, OWNER);
    assert.equal(notOpened.ok, false);
    assert.equal(notOpened.code, 'MP_ARTICLE_NO_DOC');

    const bound = await article.handle('bind', {
      sessionId: 'S1', path: env.filePath, docToken: 't1', tabId: 'tab-9',
    }, OWNER);
    assert.equal(bound.ok, true, JSON.stringify(bound));

    const status = await article.handle('wxStatus', {
      capability: bound.capability, docToken: 't1',
      /* A10：这些自报字段必须被忽略 */
      dir: 'C:/attacker', path: 'C:/attacker/x.md', ownerId: 'attacker-owner',
      workspace: 'C:/attacker', sessionId: 'S-evil',
    }, OWNER);
    assert.equal(status.ok, true, JSON.stringify(status));
    const statusCall = wechat.calls.at(-1);
    assert.equal(statusCall.action, 'status');
    assert.notEqual(statusCall.ownerId, 'attacker-owner', 'owner 必须来自连接身份，不是 body');
    assert.equal(statusCall.tabId, 'tab-9');
    assert.equal(normalize(statusCall.path), normalize(env.filePath), 'path 必须来自绑定时核验过的规范路径');
    assert.equal(statusCall.isCurrent, true);

    const created = await article.handle('wxCreateDraft', {
      capability: bound.capability, docToken: 't1', title: 'T', html: '<p>x</p>', images: [], coverId: 'c1',
    }, OWNER);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(wechat.calls.at(-1).action, 'createDraft');

    /* A17：只有六个动作；发布/群发这类名字根本不存在 */
    for (const forbidden of ['wxPublish', 'wxMass', 'wxDeleteDraft']) {
      const r = await article.handle(forbidden, { capability: bound.capability, docToken: 't1' }, OWNER);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'MP_ARTICLE_UNKNOWN_METHOD');
    }
  } finally {
    await env.done();
  }
});

test('A11 wx createDraft 前文档离开编辑器 ⇒ MP_WX_DOC_CHANGED 且不发 draft/add', async () => {
  const wechat = createFakeWechat();
  let documentPresent = true;
  const article = createArticleService({
    getService: (name) => {
      if (name === 'connection') return makeAdmitConnection('peer-z');
      if (name === 'sessions') return { get: () => ({ id: 'S1', header: { cwd: 'D:/workspace' } }) };
      return undefined;
    },
    resolveDocument: async () => (documentPresent
      ? { ok: true, canonicalPath: 'D:/workspace/doc.md' }
      : { ok: false }),
    wechat: async () => wechat,
    log: SILENT_LOG,
  });
  const bound = await article.handle('bind', {
    sessionId: 'S1', path: 'D:/workspace/doc.md', docToken: 't1',
  }, OWNER);
  assert.equal(bound.ok, true, JSON.stringify(bound));

  documentPresent = false;
  const before = wechat.calls.length;
  const created = await article.handle('wxCreateDraft', {
    capability: bound.capability, docToken: 't1', title: 'T', html: '<p>x</p>', images: [], coverId: 'c1',
  }, OWNER);
  assert.equal(created.ok, false);
  assert.equal(created.code, 'MP_WX_DOC_CHANGED');
  assert.equal(wechat.calls.length, before, '文档已离开时**不得**调到微信模块（不发 draft/add）');
});

/* ═════════════════ A12/A13：路由与凭据 ═════════════════ */

test('A12 未知方法 404 / 非 JSON 415 / 无连接身份 503', async () => {
  const env = await makeHost({ services: { sessions: { get: () => undefined } } });
  try {
    const unknown = await env.call('dropDatabase', {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'MP_ARTICLE_UNKNOWN_METHOD');

    const badType = await fetch(`http://127.0.0.1:${env.port}/dsh-markdown-editor-typora/api/article/aiStatus`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    });
    assert.equal(badType.status, 415);

    env.services.delete('connection');
    const noFence = await env.call('aiStatus', { capability: 'x', docToken: 'y' });
    assert.equal(noFence.status, 503);
    assert.equal(noFence.json.error.code, 'host-auth-unavailable');
  } finally {
    await env.done();
  }
});

test('A13 capability 来自 CSPRNG：uuid 形态、两次不同、无序号/时间前缀', async () => {
  const env = await makeHost({ services: { sessions: { get: () => undefined } } });
  const article = makeService(env);
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    const one = await article.handle('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' }, OWNER);
    const two = await article.handle('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1', tabId: 'tab-b' }, OWNER);
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.equal(two.ok, true, JSON.stringify(two));
    assert.notEqual(one.capability, two.capability);
    /* uuid v4 形态：8-4-4-4-12，version nibble 4 */
    assert.match(one.capability, /^art-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(one.bindId, /^artb-[0-9a-f]{8}-/i);
    /* 不含 Math.random 那类短序号痕迹：整串够长（uuid 36 字符 + 前缀） */
    assert.ok(one.capability.length >= 36 + 4, `capability 必须足够长（实际 ${one.capability.length}），不能是可猜的短序号`);
    assert.ok(!/^art-[0-9a-z]{1,6}-/.test(one.capability), '不许出现短序号前缀');
    /* 两次都成功、且旧的不因"另一个 tabId"被驱逐 */
    const stillThere = await article.handle('aiStatus', { capability: one.capability, docToken: 't1' }, OWNER);
    assert.equal(stillThere.ok, true);
  } finally {
    await env.done();
  }
});

test('A14 同 tabId 重绑只驱逐同 peer 的旧绑定（不误伤别的连接）', async () => {
  const env = await makeHost({ services: { sessions: { get: () => undefined } } });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });

    /* 同伴 A 用 tab-1 绑定 */
    const a1 = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1', tabId: 'tab-1' });
    assert.equal(a1.json.ok, true);

    /* 同伴 B（不同 peer）用**同名** tab-1 绑定：不许驱逐 A 的 */
    env.services.set('connection', makeAdmitConnection('peer-B'));
    const b1 = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1', tabId: 'tab-1' });
    assert.equal(b1.json.ok, true);

    env.services.set('connection', makeAdmitConnection('peer-A'));
    const aStill = await env.call('aiStatus', { capability: a1.json.capability, docToken: 't1' });
    assert.equal(aStill.json.ok, true, '别的同伴用同名 tabId 重绑，不得驱逐 A 的 capability');

    env.services.set('connection', makeAdmitConnection('peer-B'));
    const bStill = await env.call('aiStatus', { capability: b1.json.capability, docToken: 't1' });
    assert.equal(bStill.json.ok, true);

    /* A 自己再用 tab-1 重绑 ⇒ A 的旧 capability 作废，B 的不受影响 */
    env.services.set('connection', makeAdmitConnection('peer-A'));
    const a2 = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't2', tabId: 'tab-1' });
    assert.equal(a2.json.ok, true);
    const aOld = await env.call('aiStatus', { capability: a1.json.capability, docToken: 't1' });
    assert.equal(aOld.json.code, 'MP_ARTICLE_UNBOUND');

    env.services.set('connection', makeAdmitConnection('peer-B'));
    const bIntact = await env.call('aiStatus', { capability: b1.json.capability, docToken: 't1' });
    assert.equal(bIntact.json.ok, true, 'A 的重绑不得驱逐 B 的绑定');
  } finally {
    await env.done();
  }
});

/* ═════════════════ A15/A16：principal 与工作区归属 ═════════════════ */

test('A15 principal 缺项 / 非 owner 一律拒绝', async () => {
  const env = await makeHost({ services: { sessions: { get: () => ({ id: 'S1', header: { cwd: 'D:/workspace' } }) } } });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });

    /* principal 整个缺失 */
    env.services.set('connection', { requestRejection: () => undefined, admit: () => ({ peer: { id: 'peer-X' } }) });
    const missing = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.code, 'MP_ARTICLE_SCOPE');

    /* principal 存在但不是 owner */
    env.services.set('connection', {
      requestRejection: () => undefined,
      admit: () => ({ peer: { id: 'peer-X', principal: { kind: 'guest' } } }),
    });
    const guest = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(guest.json.ok, false);
    assert.equal(guest.json.code, 'MP_ARTICLE_SCOPE');

    /* admit 拒绝（但仍要过路由栅栏才到 article 层） */
    env.services.set('connection', { requestRejection: () => undefined, admit: () => ({ rejection: 401 }) });
    const rejected = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(rejected.json.ok, false);
    assert.equal(rejected.json.code, 'MP_ARTICLE_SCOPE');

    /* 正确的 owner 才通过 */
    env.services.set('connection', makeAdmitConnection('peer-OK'));
    const good = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(good.json.ok, true, JSON.stringify(good.json));
  } finally {
    await env.done();
  }
});

test('A16 文档必须在会话工作区内（readingTarget + 会话 cwd 相符）', async () => {
  const env = await makeHost({ services: { sessions: { get: () => undefined } } });
  try {
    await env.openDocument();

    /* 会话工作区是**另一个**目录 ⇒ 即便文件被编辑器打开过，也不归这个会话 */
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: join(env.dir, '..', 'somewhere-else') } }) });
    const outside = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(outside.json.ok, false);
    assert.equal(outside.json.code, 'MP_ARTICLE_NO_DOC');
    assert.match(outside.json.error, /工作区/);

    /* 会话工作区就是文件所在目录 ⇒ 通过 */
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    const inside = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(inside.json.ok, true, JSON.stringify(inside.json));

    /* 会话没有声明 cwd ⇒ readingTarget 是唯一权威，仍可通过 */
    env.services.set('sessions', { get: () => ({ id: 'S1', header: {} }) });
    const noCwd = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    assert.equal(noCwd.json.ok, true, JSON.stringify(noCwd.json));
  } finally {
    await env.done();
  }
});

/* ═════════════════ A18：诊断不泄漏 ═════════════════ */

test('A18 aiStatus/aiDiag 只读且不含凭据；来源为选中的模型', async () => {
  const env = await makeHost({
    services: {
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      llm: createFakeLlm(),
    },
  });
  try {
    await env.openDocument();
    env.services.set('sessions', { get: () => ({ id: 'S1', header: { cwd: env.dir } }) });
    /* 部署默认存在也不许冒充；真正的来源是会话投影里用户选的那一条。 */
    env.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) });
    env.services.set('sessionProjections', {
      snapshot: () => ({ asOfSeq: 3, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } }),
    });

    const bound = await env.call('bind', { sessionId: 'S1', path: env.filePath, docToken: 't1' });
    const capability = bound.json.capability;

    const status = await env.call('aiStatus', { capability, docToken: 't1' });
    assert.equal(status.json.ok, true);
    assert.equal(status.json.available, true);
    assert.equal(status.json.provider, 'deepseek-official');
    assert.equal(status.json.model, 'deepseek-v4-flash');
    assert.equal(status.json.source, 'session-projection');

    const diag = await env.call('aiDiag', { capability, docToken: 't1' });
    assert.equal(diag.json.ok, true);
    assert.equal(diag.json.readOnly, true);
    /* 诊断字段名里没有 capability/token/secret 这些关键字（capability 本身也不出现在回执里）。 */
    const keys = Object.keys(diag.json).map((k) => k.toLowerCase());
    for (const forbidden of ['secret', 'apikey', 'api_key', 'capability']) {
      assert.ok(!keys.includes(forbidden), `诊断不许出现字段 ${forbidden}`);
    }
    assert.ok(!JSON.stringify(diag.json).includes('default-p'), '诊断不许把部署默认当成当前模型');
  } finally {
    await env.done();
  }
});
