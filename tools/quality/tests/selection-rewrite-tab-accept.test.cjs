'use strict';
/*
 * 主控复验口径的**真机形态**模拟：ready → 原生 Tab（不手工切焦点）→ 正文变化 → Ctrl+Z 撤销。
 *
 * 与 selection-rewrite.test.cjs 的区别：那一支验内核分支；这一支把
 * 「默认焦点 → 一次 Tab → 一次撤销」当成一条**端到端用户动作序列**来验，
 * 并且焦点完全由内核决定（本文件**从不调用 .focus()**），对应主控"用真正的 ready 默认焦点，
 * 不要手工替测试切焦点"的要求。
 *
 * 同时验 Esc 放弃、Shift+Tab 可达性、以及"Tab 采纳后一次撤销逐字节回到原文"。
 *
 * 运行：node tools/quality/tests/selection-rewrite-tab-accept.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const SOURCE = '这个方案很好，可以用了。';
const REPLY = '这个方案不错，可以直接用了。';

/* ───────── 最小 DOM（与其它支同形态；本文件只依赖它派发 keydown） ───────── */
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
    this.childNodes = [];
    const s = String(v ?? ''); if (s) this.appendChild(new T(s));
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
function createDocument() {
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
}

/** 真实键盘事件：派发到 document 的捕获监听（面板装的就是这一层）。 */
function pressKey(doc, key, init = {}) {
  const target = init.target || doc.activeElement;
  const event = {
    type: 'keydown', key, keyCode: init.keyCode ?? (key === 'Tab' ? 9 : key === 'Escape' ? 27 : 13),
    shiftKey: !!init.shiftKey, isComposing: !!init.isComposing, repeat: !!init.repeat,
    target, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
  };
  for (const fn of [...(doc.listeners.keydown || [])]) fn(event);
  return event;
}

const flush = () => new Promise(r => setTimeout(r, 0));

async function harness({ text = SOURCE, reply = REPLY } = {}) {
  const [kernel, stateMod, cmdMod] = await Promise.all([
    load('dsh-markpilot/src-cm6/selection-rewrite.js'),
    load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'),
    load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js'),
  ]);
  const doc = createDocument();
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = doc;
  globalThis.window = {};
  let state = stateMod.EditorState.create({
    doc: text, selection: { anchor: 0, head: text.length }, extensions: [cmdMod.history()],
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
    request: async () => ({ ok: true, text: reply }),
  });
  return {
    doc, view, api, toasts, cmdMod,
    get text() { return state.doc.toString(); },
    undo() { return h_ref.cmdMod.undo({ state, dispatch: (tr) => { state = state.update(tr).state; } }); },
    restore() {
      api._internals.dispose();
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
    },
  };
}
/* undo 需要闭包里的 cmdMod；用一个小垫片让上面的对象字面量能引用到。 */
let h_ref = null;

/* ═════════════════════ 主控复验序列 ═════════════════════ */

test('主控序列：ready → 一次原生 Tab → 正文变 → 一次 Ctrl+Z 回到原文', async () => {
  const h = await harness();
  h_ref = h;
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');

    /* ① 焦点完全由内核决定 —— 本测试**从不调用 .focus()** */
    const active = h.doc.activeElement;
    assert.ok(active && active !== h.doc.body, '就绪态必须有面板内的默认焦点');

    /* ② 一次原生 Tab */
    const e = pressKey(h.doc, 'Tab');
    assert.equal(e.defaultPrevented, true);
    assert.equal(h.api.state().phase, 'idle', '一次 Tab 必须完成采纳');
    assert.equal(h.text, REPLY);

    /* ③ 一次 Ctrl+Z */
    assert.equal(h.undo(), true);
    assert.equal(h.text, SOURCE, '一次撤销必须逐字节回到润色前');
  } finally { h.restore(); h_ref = null; }
});

test('主控序列：Esc 放弃 ⇒ 正文不变、面板收起', async () => {
  const h = await harness();
  h_ref = h;
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const before = h.text;
    const e = pressKey(h.doc, 'Escape');
    assert.equal(e.defaultPrevented, true);
    assert.equal(h.api.state().phase, 'idle');
    assert.equal(h.text, before);
  } finally { h.restore(); h_ref = null; }
});

test('Shift+Tab 可达性：默认焦点 → Shift+Tab 走到按钮 → Enter 激活该按钮', async () => {
  const h = await harness();
  h_ref = h;
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const before = h.text;
    pressKey(h.doc, 'Tab', { shiftKey: true });
    const onButton = h.doc.activeElement;
    assert.equal(!!(onButton.dataset && onButton.dataset.mpRewriteAction), true,
      'Shift+Tab 必须能把焦点送到按钮上（可达性）');
    assert.equal(h.text, before, 'Shift+Tab 不许采纳');
    const enter = pressKey(h.doc, 'Enter');
    assert.equal(enter.defaultPrevented, true);
    assert.equal(h.api.state().phase, 'idle', 'Enter 在按钮上要激活它');
  } finally { h.restore(); h_ref = null; }
});

test('输入法组字中的 Tab/Esc 不采纳也不放弃（让路给输入法）', async () => {
  const h = await harness();
  h_ref = h;
  try {
    h.api.open();
    await flush();
    assert.equal(h.api.state().phase, 'ready');
    const before = h.text;
    const e1 = pressKey(h.doc, 'Tab', { isComposing: true, keyCode: 229 });
    assert.equal(e1.defaultPrevented, false, '组字中的 Tab 归输入法');
    assert.equal(h.api.state().phase, 'ready', '组字中不许采纳');
    const e2 = pressKey(h.doc, 'Escape', { isComposing: true, keyCode: 229 });
    assert.equal(e2.defaultPrevented, false, '组字中的 Esc 归输入法');
    assert.equal(h.api.state().phase, 'ready', '组字中不许放弃');
    assert.equal(h.text, before);
  } finally { h.restore(); h_ref = null; }
});

test('采纳后立刻打字，一次撤销只撤刚打的字（润色结果仍在）', async () => {
  const h = await harness();
  h_ref = h;
  try {
    h.api.open();
    await flush();
    pressKey(h.doc, 'Tab');
    assert.equal(h.text, REPLY);
    /* 真人在采纳后最常见的下一步 */
    h.view.dispatch({ changes: { from: 0, insert: 'Z' }, userEvent: 'input.type' });
    assert.equal(h.text, 'Z' + REPLY);
    assert.equal(h.undo(), true);
    assert.equal(h.text, REPLY, '一次撤销只撤 Z，润色结果必须还在');
  } finally { h.restore(); h_ref = null; }
});
