'use strict';
/*
 * 端到端：**普通菜单那条路**（`installSelectionRewrite({getView, toast})`，不传 request）
 * 必须真的走到宿主 provider，而不是停在"未配置"桩上。
 *
 * 为什么单列这一支：内核有 `request` 注入点，方便单测；但产品里菜单就是只传两个参数。
 * 若 `hostTransport()` 认不出宿主桥（或通道名对不上），用户看到的就是"还没配置"——
 * 功能等于没做。所以这里用**真实的三段链路**验一遍：
 *
 *   内核 hostTransport() → preload 的 mpHost.aiRewrite 形态（假 ipcRenderer）
 *   → 主进程侧 registerAiRewrite（假 ipcMain + 真 shell/ai-rewrite.js）→ 假 fetch（真 provider 协议）
 *
 * 判据全在"出网的请求长什么样"与"用户最终看到的正文"上：
 *   · 请求体里**只有选区**，密钥只在 header；
 *   · 采纳后正文变成模型给的内容，一次撤销回到原文；
 *   · 未配置时给的是"还没配置"而不是崩溃，且一个字都不发。
 *
 * 不读真实密钥、不连外网。运行：node tools/quality/tests/selection-rewrite-host-chain.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const HOST = require(path.join(ROOT, 'MarkPilot-CM6/shell/ai-rewrite.js'));

/* ───────── 最小 DOM（与内核那支测试同一形态，只留需要的部分） ───────── */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { for (const x of n) if (x) this.set.add(x); }
  remove(...n) { for (const x of n) this.set.delete(x); }
  toggle(n, f) { const on = f === undefined ? !this.set.has(n) : !!f; if (on) this.set.add(n); else this.set.delete(n); return on; }
  contains(n) { return this.set.has(n); }
}
class FakeNode {
  constructor(type) { this.nodeType = type; this.childNodes = []; this.parentNode = null; }
  get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : n.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = String(v ?? '');
    if (s) this.appendChild(new FakeText(s));
  }
  appendChild(c) {
    if (!c) return c;
    if (c.nodeType === 11) { for (const g of [...c.childNodes]) this.appendChild(g); c.childNodes = []; return c; }
    c.parentNode = this; c.ownerDocument = this.ownerDocument; this.childNodes.push(c); return c;
  }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? new FakeText(n) : n); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let c = n; c; c = c.parentNode) if (c === this) return true; return false; }
}
class FakeText extends FakeNode { constructor(d) { super(3); this.data = String(d); } get textContent() { return this.data; } set textContent(v) { this.data = String(v); } }
class FakeElement extends FakeNode {
  constructor(tag) {
    super(1); this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName;
    this.classList = new ClassList(); this.dataset = {}; this.attributes = {};
    this.style = {}; this.listeners = Object.create(null); this.disabled = false;
    this.id = ''; this.type = ''; this.tabIndex = -1;
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
function createDocument() {
  const doc = {
    createElement: (t) => { const e = new FakeElement(t); e.ownerDocument = doc; return e; },
    createTextNode: (t) => { const n = new FakeText(t); n.ownerDocument = doc; return n; },
    createDocumentFragment: () => { const f = new FakeNode(11); f.ownerDocument = doc; return f; },
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
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ───────── 真实三段链路 ───────── */

/**
 * 搭一条与产品同形的链路：
 *   ① preload 的 `mpHost.aiRewrite` —— 用真的 ipcRenderer.invoke 语义（转发给主进程 handler）
 *   ② 主进程侧 —— 用真的 `registerAiRewrite`（真 authorize/真 resolveConfig/真 rewriteSelection）
 *   ③ provider —— 假 fetch，但走**真实的 OpenAI 兼容协议形态**
 *
 * 信任校验用 `authorize` 注入（产品里由 main.js 按 wxTrust 同口径实现），
 * 这里给一个可切换的假实现，用来验"不可信来源一律回绝"。
 */
function buildChain({ settings, env = {}, reply = '这个方案不错，可以直接用了。', onRequest, trusted = true } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { if (handlers.has(channel)) throw new Error('dup ' + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    onRequest?.({ url, init, body });
    return {
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: reply } }] }),
    };
  };
  const svc = HOST.registerAiRewrite({
    ipcMain,
    authorize: async () => (trusted
      ? { ok: true, owner: { id: '1' } }
      : { ok: false, code: 'MP_AI_FRAME', error: '只接受编辑器主框架发起的请求' }),
    readSettings: () => settings,
    env,
    fetchImpl,
  });

  /* preload 形态：真正 invoke 主进程 handler，并 await 它的 promise（与 Electron 一致） */
  const ipcRenderer = {
    invoke(channel, payload, options) {
      const handler = handlers.get(channel);
      if (!handler) return Promise.resolve(undefined);
      const event = { sender: { id: 1 } };
      return Promise.resolve(handler(event, payload, options));
    },
  };
  const mpHost = {
    aiRewrite: (payload, options = {}) => ipcRenderer.invoke('ai:rewrite', payload || {},
      { requestId: String(options.requestId || '') }),
    aiRewriteCancel: (requestId) => ipcRenderer.invoke('ai:rewrite-cancel', { requestId }),
    aiStatus: () => ipcRenderer.invoke('ai:status'),
  };
  return { handlers, calls, fetchImpl, mpHost, ipcMain, svc };
}

async function runProductPath({ settings, env, reply, text = '这个方案很好，可以用了。', anchor = 0, head = null } = {}) {
  const [kernel, stateMod, cmdMod] = await Promise.all([
    load('dsh-markpilot/src-cm6/selection-rewrite.js'),
    load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'),
    load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js'),
  ]);
  const chain = buildChain({ settings, env, reply });

  const doc = createDocument();
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { mpHost: chain.mpHost };       // ← 宿主桥，产品里由 preload 提供

  let state = stateMod.EditorState.create({
    doc: text,
    selection: { anchor, head: head == null ? text.length : head },
    extensions: [cmdMod.history()],
  });
  const view = {
    dom: { isConnected: true }, contentDOM: null,
    get state() { return state; },
    dispatch(spec) { state = state.update(spec).state; },
    focus() { }, coordsAtPos() { return null; }, posAtDOM() { return 0; },
  };

  const toasts = [];
  const events = [];
  /* ★ 产品菜单的调用形态：**只传 getView 与 toast**（不传 request） */
  const api = kernel.installSelectionRewrite({
    getView: () => view,
    toast: (m) => { toasts.push(String(m)); },
    onState: (e) => { events.push(e); },
  });

  return {
    api, view, doc, toasts, events, chain,
    get text() { return state.doc.toString(); },
    restore() {
      api._internals.dispose();
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
    },
  };
}

/* ═════════════════════ 主判据 ═════════════════════ */

test('菜单形态（只传 getView/toast）真的走到宿主 provider，正文按回包改写', async () => {
  const h = await runProductPath({
    settings: { aiRewriteProvider: 'deepseek' }, env: { DEEPSEEK_API_KEY: 'sk-fixture-not-a-real-key' },
  });
  try {
    assert.equal(h.api.open(), 'started');
    await flush();
    assert.equal(h.api.state().phase, 'ready', '必须是 ready，不能是"未配置"桩');
    assert.equal(h.chain.calls.length, 1, '必须真的发了一次请求');

    /* 出网请求的形态：真实 OpenAI 兼容协议，只带选区 */
    const call = h.chain.calls[0];
    assert.match(call.url, /^https:\/\/api\.deepseek\.com\/v1\/chat\/completions$/);
    assert.match(call.init.headers.authorization, /^Bearer sk-fixture/);
    assert.equal(JSON.stringify(call.body).includes('sk-fixture-not-a-real-key'), false, '密钥不许进请求体');
    assert.deepEqual(Object.keys(call.body).sort(), ['messages', 'model', 'stream', 'temperature']);
    const userText = call.body.messages.find(m => m.role === 'user').content;
    assert.ok(userText.includes('这个方案很好，可以用了。'), '请求里必须有选区文本');

    /* 采纳 ⇒ 正文真的变了，且一次撤销回得去 */
    assert.equal(h.api.accept(), true);
    assert.equal(h.text, '这个方案不错，可以直接用了。');
    const spec = () => ({ state: h.view.state, dispatch: (tr) => h.view.dispatch(tr) });
    assert.equal(load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js') && true, true);
    const { undo } = await load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js');
    assert.equal(undo(spec()), true);
    assert.equal(h.text, '这个方案很好，可以用了。', '一次撤销回到润色前');
  } finally { h.restore(); }
});

test('菜单形态 + 未配置：给"还没配置"提示，一个字都不出网', async () => {
  const h = await runProductPath({ settings: {}, env: {} });
  try {
    const before = h.text;
    assert.equal(h.api.open(), 'started');
    await flush();
    assert.equal(h.api.state().phase, 'failed');
    assert.equal(h.chain.calls.length, 0, '未配置就不许出网');
    assert.ok(h.toasts.length > 0 || h.doc.body.textContent.includes('配置'), '必须给用户明确提示');
    assert.equal(h.doc.body.textContent.includes('还没有配置'), true,
      '提示要直接说没配置，实际：' + h.doc.body.textContent.slice(0, 160));
    assert.equal(h.api.accept(), false);
    assert.equal(h.text, before, '正文一字不动');
  } finally { h.restore(); }
});

test('菜单形态 + 环境变量配好：同样能走通（不要求用户先改 settings.json）', async () => {
  const h = await runProductPath({
    settings: {},
    env: { DEEPSEEK_API_KEY: 'sk-from-env-fixture' },
    reply: '环境变量这条路也能用。',
  });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    assert.equal(h.chain.calls.length, 1);
    assert.match(h.chain.calls[0].init.headers.authorization, /sk-from-env-fixture/);
    assert.equal(h.api.accept(), true);
    assert.equal(h.text, '环境变量这条路也能用。');
  } finally { h.restore(); }
});

test('菜单形态 + provider 报错：失败面板可重试，正文不动', async () => {
  const h = await runProductPath({
    settings: { aiRewriteProvider: 'deepseek' }, env: { DEEPSEEK_API_KEY: 'sk-fixture' },
  });
  try {
    // 把 transport 换成一发 500，验证真实链路里的失败分支
    const before = h.text;
    h.chain.handlers.get('ai:rewrite');
    const failing = buildChain({ settings: { aiRewriteProvider: 'deepseek' }, env: { DEEPSEEK_API_KEY: 'sk' } });
    void failing;
    // 直接让当前 chain 的 fetch 失败：重装一次 handler
    HOST.registerAiRewrite({
      ipcMain: { handle: (c, f) => h.chain.handlers.set(c, f), removeHandler: (c) => h.chain.handlers.delete(c) },
      readSettings: () => ({ aiRewriteProvider: 'deepseek' }),
      env: { DEEPSEEK_API_KEY: 'sk-fixture' },
      env: {},
      fetchImpl: async () => ({ status: 500, json: async () => ({ error: { message: '上游炸了' } }) }),
    });
    h.api.open();
    await flush();
    const phase = h.api.state().phase;
    assert.equal(phase, 'failed', '500 必须是失败态');
    assert.equal(h.text, before, '失败不动正文');
    assert.ok(h.doc.body.textContent.includes('500') || h.doc.body.textContent.includes('重试'),
      '失败面板要给出可诊断信息与重试：' + h.doc.body.textContent.slice(0, 200));
  } finally { h.restore(); }
});

test('菜单形态 + 空回包：判失败，绝不当成"删掉整段"采纳', async () => {
  const h = await runProductPath({
    settings: { aiRewriteProvider: 'deepseek' }, env: { DEEPSEEK_API_KEY: 'sk-fixture' },
    reply: '',
  });
  try {
    const before = h.text;
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'failed', '空回包必须是失败态');
    assert.equal(h.chain.calls.length, 1, '确实发了请求（不是本地拒）');
    assert.equal(h.api.accept(), false);
    assert.equal(h.text, before, '整段正文必须完好');
  } finally { h.restore(); }
});

test('菜单形态 + 模型原样返回：判"没有改动"，不给采纳', async () => {
  const SOURCE = '已经很好的一段话。';
  const h = await runProductPath({
    settings: { aiRewriteProvider: 'deepseek' }, env: { DEEPSEEK_API_KEY: 'sk-fixture' },
    reply: SOURCE,
    text: SOURCE,
  });
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'failed');
    assert.equal(h.doc.body.textContent.includes('没有改动'), true,
      '提示应为"没有改动"：' + h.doc.body.textContent.slice(0, 160));
    assert.equal(h.text, SOURCE);
  } finally { h.restore(); }
});
