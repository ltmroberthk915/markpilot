'use strict';
/*
 * 主控验收路径：**隔离的本机假 provider + 普通入口**。
 *
 * 这一支与其它测试的区别：它真的起一个 **127.0.0.1 上的 HTTP 服务**（不是假 fetch），
 * 让整条链路走真网络栈：内核 → mpHost.aiRewrite → 主进程 registerAiRewrite →
 * （真 http 请求）→ 本机假 provider。这样就同时验证了：
 *   · 回环 http 端点被允许（validateBaseURL 的正确一侧）；
 *   · 请求真的发出、header/body 形态正确；
 *   · 真实网络响应能被解析回文本；
 *   · 取消与超时在**真 socket** 上也能收住。
 *
 * 不连外网、不读真实密钥：provider 是本进程起的临时服务，密钥是夹具值。
 * 运行：node tools/quality/tests/ai-rewrite-local-provider.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const HOST = require(path.join(ROOT, 'MarkPilot-CM6/shell/ai-rewrite.js'));

const SELECTION = '这个方案很好，可以用了。';
const REPLY = '这个方案不错，可以直接用了。';
const FIXTURE_KEY = 'sk-fixture-local-not-real';

/** 起一个本机假 provider。返回 { baseURL, port, close, requests, mode }。 */
async function startProvider() {
  const requests = [];
  const state = { mode: 'ok', delayMs: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = () => {
        if (state.mode === 'error500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '本地假 provider 故意报错' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: REPLY } }] }));
      };
      if (state.delayMs > 0) setTimeout(reply, state.delayMs);
      else reply();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${port}`,
    port,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error('dup ' + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

test('真·本机假 provider：普通入口（菜单形态）走通整条链路并拿到真响应', async () => {
  const provider = await startProvider();
  const ipc = makeIpc();
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc,
    authorize: async () => ({ ok: true, owner: { id: '1' } }),
    readSettings: () => ({ aiRewriteProvider: 'custom', aiRewriteTimeoutMs: '8000' }),
    /* 可信宿主显式注入的定制端点（这是唯一合法来源） */
    customEndpoint: { baseURL: provider.baseURL, model: 'local-fixture', apiKey: FIXTURE_KEY },
    env: {},
    /* 真 fetch：走 Node 的网络栈，不注入假实现 */
    fetchImpl: (url, init) => globalThis.fetch(url, init),
  });
  const mpHost = {
    aiRewrite: (payload, options = {}) => ipc.handlers.get('ai:rewrite')(
      { sender: { id: 1 } }, payload || {}, { requestId: String(options.requestId || '') }),
  };

  const [kernel, stateMod, cmdMod] = await Promise.all([
    load('dsh-markpilot/src-cm6/selection-rewrite.js'),
    load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'),
    load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js'),
  ]);
  /* 最小 DOM（内核面板要挂 DOM；与其它支同形态） */
  const { DocumentFactory } = makeDocumentFactory();
  const doc = DocumentFactory();
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { mpHost };

  let state = stateMod.EditorState.create({
    doc: SELECTION, selection: { anchor: 0, head: SELECTION.length }, extensions: [cmdMod.history()],
  });
  const view = {
    dom: { isConnected: true }, contentDOM: null,
    get state() { return state; },
    dispatch(spec) { state = state.update(spec).state; },
    focus() { }, coordsAtPos() { return null; }, posAtDOM() { return 0; },
  };
  const toasts = [];
  const api = kernel.installSelectionRewrite({
    getView: () => view,
    toast: (m) => toasts.push(String(m)),
  });

  try {
    assert.equal(api.open(), 'started');
    /* 真网络：给足时间让它往返 */
    for (let i = 0; i < 100 && api.state().phase === 'pending'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(api.state().phase, 'ready', `必须是 ready（提示：${toasts.join('|')}）`);

    /* 假 provider 真的被访问到，且形态正确 */
    assert.equal(provider.requests.length, 1, '本机 provider 必须真的收到一次请求');
    const req = provider.requests[0];
    assert.equal(req.method, 'POST');
    assert.match(req.url, /\/v1\/chat\/completions$/);
    assert.equal(req.headers.authorization, `Bearer ${FIXTURE_KEY}`);
    assert.equal(JSON.stringify(req.body).includes(FIXTURE_KEY), false, '密钥不进 body');
    assert.ok(JSON.stringify(req.body).includes(SELECTION), '请求里必须有选区');

    assert.equal(api.accept(), true);
    assert.equal(state.doc.toString(), REPLY, '正文变成 provider 真回的内容');
    /* 一次撤销回到原文 */
    const spec = () => ({ state, dispatch: (tr) => { state = state.update(tr).state; } });
    assert.equal(cmdMod.undo(spec()), true);
    assert.equal(state.doc.toString(), SELECTION);
  } finally {
    api._internals.dispose();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    svc.dispose();
    await provider.close();
  }
});

test('真·本机假 provider + 取消：socket 上的在途请求真的被中止', async () => {
  const provider = await startProvider();
  provider.state.delayMs = 5000;             // 让请求悬着
  const ipc = makeIpc();
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc,
    authorize: async () => ({ ok: true, owner: { id: '1' } }),
    readSettings: () => ({ aiRewriteProvider: 'custom', aiRewriteTimeoutMs: '20000' }),
    customEndpoint: { baseURL: provider.baseURL, model: 'local-fixture', apiKey: FIXTURE_KEY },
    env: {},
    fetchImpl: (url, init) => globalThis.fetch(url, init),
  });
  const event = { sender: { id: 1 } };
  try {
    const pending = ipc.handlers.get('ai:rewrite')(event, { selection: SELECTION }, { requestId: 'live-1' });
    await new Promise(r => setTimeout(r, 120));           // 等请求真的发出去
    assert.equal(svc.inflightSize(), 1);
    const cancel = await ipc.handlers.get('ai:rewrite-cancel')(event, { requestId: 'live-1' });
    assert.equal(cancel.cancelled, true);
    const result = await pending;
    assert.equal(result.code, 'cancelled', '真网络下的取消要给出 cancelled');
    assert.equal(svc.inflightSize(), 0);
  } finally {
    svc.dispose();
    await provider.close();
  }
});

test('真·本机假 provider + 500：错误如实透出且不带密钥', async () => {
  const provider = await startProvider();
  provider.state.mode = 'error500';
  const ipc = makeIpc();
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc,
    authorize: async () => ({ ok: true, owner: { id: '1' } }),
    readSettings: () => ({ aiRewriteProvider: 'custom', aiRewriteTimeoutMs: '8000' }),
    customEndpoint: { baseURL: provider.baseURL, model: 'local-fixture', apiKey: FIXTURE_KEY },
    env: {},
    fetchImpl: (url, init) => globalThis.fetch(url, init),
  });
  try {
    const result = await ipc.handlers.get('ai:rewrite')({ sender: { id: 1 } }, { selection: SELECTION }, { requestId: 'e1' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'http');
    assert.match(result.message, /500/);
    assert.match(result.message, /本地假 provider 故意报错/);
    assert.equal(JSON.stringify(result).includes(FIXTURE_KEY), false);
  } finally {
    svc.dispose();
    await provider.close();
  }
});

test('真·本机假 provider + 窗口销毁：sweepOwner 收住真 socket 上的请求', async () => {
  const provider = await startProvider();
  provider.state.delayMs = 5000;
  const ipc = makeIpc();
  const svc = HOST.registerAiRewrite({
    ipcMain: ipc,
    authorize: async () => ({ ok: true, owner: { id: '9' } }),
    readSettings: () => ({ aiRewriteProvider: 'custom', aiRewriteTimeoutMs: '20000' }),
    customEndpoint: { baseURL: provider.baseURL, model: 'local-fixture', apiKey: FIXTURE_KEY },
    env: {},
    fetchImpl: (url, init) => globalThis.fetch(url, init),
  });
  try {
    const pending = ipc.handlers.get('ai:rewrite')({ sender: { id: 9 } }, { selection: SELECTION }, { requestId: 'w1' });
    await new Promise(r => setTimeout(r, 120));
    const swept = svc.sweepOwner('9');
    assert.equal(swept, 1);
    const result = await pending;
    assert.equal(result.code, 'cancelled');
  } finally {
    svc.dispose();
    await provider.close();
  }
});

/* ───────── 极简 DOM（复制自其它支，只为让面板能挂） ───────── */
function makeDocumentFactory() {
  class ClassList {
    constructor() { this.set = new Set(); }
    add(...n) { for (const x of n) if (x) this.set.add(x); }
    remove(...n) { for (const x of n) this.set.delete(x); }
    toggle(n, f) { const on = f === undefined ? !this.set.has(n) : !!f; if (on) this.set.add(n); else this.set.delete(n); return on; }
    contains(n) { return this.set.has(n); }
  }
  class N {
    constructor(t) { this.nodeType = t; this.childNodes = []; this.parentNode = null; }
    get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : n.textContent).join(''); }
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = []; const s = String(v ?? ''); if (s) this.appendChild(new T(s));
    }
    appendChild(c) {
      if (!c) return c;
      if (c.nodeType === 11) { for (const g of [...c.childNodes]) this.appendChild(g); c.childNodes = []; return c; }
      c.parentNode = this; c.ownerDocument = this.ownerDocument; this.childNodes.push(c); return c;
    }
    append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? new T(n) : n); }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(n) { for (let c = n; c; c = c.parentNode) if (c === this) return true; return false; }
  }
  class T extends N { constructor(d) { super(3); this.data = String(d); } get textContent() { return this.data; } set textContent(v) { this.data = String(v); } }
  class E extends N {
    constructor(tag) {
      super(1); this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName;
      this.classList = new ClassList(); this.dataset = {}; this.attributes = {}; this.style = {};
      this.listeners = Object.create(null); this.disabled = false; this.id = ''; this.type = ''; this.tabIndex = -1;
    }
    get className() { return [...this.classList.set].join(' '); }
    set className(v) { this.classList.set.clear(); for (const n of String(v ?? '').split(/\s+/)) if (n) this.classList.add(n); }
    setAttribute(n, v) { this.attributes[n] = String(v); if (n === 'class') this.className = v; }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener(t, f) { const l = this.listeners[t]; if (!l) return; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
    dispatchEvent(e) { e.target ||= this; for (const f of [...(this.listeners[e.type] || [])]) f(e); return true; }
    focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; return true; }
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() { }, stopPropagation() { } }); return true; }
  }
  return {
    DocumentFactory() {
      const doc = {
        createElement: (t) => { const e = new E(t); e.ownerDocument = doc; return e; },
        createTextNode: (t) => { const n = new T(t); n.ownerDocument = doc; return n; },
        createDocumentFragment: () => { const f = new N(11); f.ownerDocument = doc; return f; },
        getElementById: (id) => {
          const walk = (n) => {
            for (const c of n.childNodes) {
              if (c.nodeType !== 1) continue;
              if (c.id === id) return c;
              const f = walk(c); if (f) return f;
            } return null;
          };
          return walk(doc.documentElement);
        },
        listeners: Object.create(null),
        addEventListener(t, f) { (doc.listeners[t] ||= []).push(f); },
        removeEventListener(t, f) { const l = doc.listeners[t]; if (!l) return; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
        hasFocus: () => true,
        activeElement: null,
      };
      doc.documentElement = doc.createElement('html');
      doc.head = doc.createElement('head');
      doc.body = doc.createElement('body');
      doc.documentElement.append(doc.head, doc.body);
      doc.activeElement = doc.body;
      return doc;
    },
  };
}
