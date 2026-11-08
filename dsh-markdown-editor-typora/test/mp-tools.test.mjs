// test/mp-tools.test.mjs — 数学/AI 工具层的纯逻辑验收（Node + 假 DOM，不启浏览器、不启服务）
//
// 目的：证明 dsh-mp-tools.js 在"没有引擎、没有桥"的环境里也能装起来，
//       且它的纯逻辑（模板落点、公式编号、AI 上下文打包、命令分发）确实正确。
// 明确不覆盖：CM6 真实渲染、KaTeX 输出、工具条视觉（属六步流程第 5 步的视觉复核）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'renderer-cm6', 'dsh-mp-tools.js');
const CODE = readFileSync(SRC, 'utf8');

/* ── 假 DOM ───────────────────────────────────────────────────────── */

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    _attrs: {},
    appendChild(child) { this.children.push(child); return child; },
    appendChildFragment(frag) { this.children.push(frag); return frag; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    focus() {},
  };
  return node;
}

function makeContext() {
  const emitted = [];
  const handler = {
    on(type, fn) { (handler._reg[type] = handler._reg[type] || []).push(fn); return handler; },
    emit(type, content) { emitted.push({ type, content }); return handler; },
    _reg: {},
    _fire(type, content) { (handler._reg[type] || []).forEach((fn) => fn(content)); },
  };

  const head = makeNode('head');
  const body = makeNode('body');
  const document = {
    readyState: 'complete',
    head,
    body,
    createElement: (tag) => makeNode(tag),
    createDocumentFragment: () => {
      const frag = makeNode('fragment');
      frag._isFragment = true;
      return frag;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const windowObj = {
    handler,
    mpEngine: undefined,
    addEventListener() {},
    removeEventListener() {},
    parent: { postMessage() {} },
  };
  windowObj.window = windowObj;

  const ctx = vm.createContext({
    window: windowObj,
    document,
    navigator: { platform: 'Win32' },
    console: { warn() {}, log() {}, error() {} },
    setTimeout: (fn) => { void fn; return 1; },
    clearTimeout: () => {},
    Element: class Element {},
    location: { href: 'about:blank' },
    _emitted: emitted,
    _handler: handler,
  });
  ctx.globalThis = ctx;
  return { ctx, windowObj, handler, emitted };
}

/* ── 假 CM6 view ─────────────────────────────────────────────────── */

function makeDoc(text) {
  const lines = text.split('\n');
  const starts = [];
  let p = 0;
  for (const l of lines) { starts.push(p); p += l.length + 1; }
  const idxOfLine = (pos) => {
    let n = 0;
    for (let i = 0; i < starts.length; i += 1) if (starts[i] <= pos) n = i;
    return n;
  };
  return {
    length: text.length,
    lines: lines.length,
    toString: () => text,
    sliceString: (a, b) => text.slice(a, b),
    lineAt: (pos) => {
      const n = idxOfLine(pos);
      const from = starts[n];
      return { number: n + 1, from, to: from + lines[n].length, text: lines[n] };
    },
    line: (num) => {
      const n = Math.min(Math.max(1, num), lines.length) - 1;
      return { number: n + 1, from: starts[n], to: starts[n] + lines[n].length, text: lines[n] };
    },
  };
}

function makeView(text, from, to) {
  const doc = makeDoc(text);
  const calls = [];
  const view = {
    composing: false,
    state: {
      doc,
      selection: {
        main: { from, to, empty: from === to },
        ranges: [{ from, to }],
      },
    },
    dispatch(spec) { calls.push(spec); },
    focus() { calls.push({ __focus: true }); },
  };
  return { view, calls };
}

function load({ view } = {}) {
  const env = makeContext();
  if (view) env.windowObj.mpEngine = { _view: () => view };
  vm.runInContext(CODE, env.ctx, { filename: 'dsh-mp-tools.js' });
  const api = env.windowObj.__mpTools;
  return { ...env, api };
}

/* ── 用例 ────────────────────────────────────────────────────────── */

test('装得起来：不改引擎、不改桥也能初始化', () => {
  const { api, windowObj, handler } = load();
  assert.ok(api, '__mpTools 应暴露');
  assert.equal(windowObj.__mpToolsInstalled, true);
  // 只注册了 cmd 一个下行处理器，没抢别的 type
  assert.deepEqual(Object.keys(handler._reg), ['cmd']);
});

test('模板：9 个、text 非空、@@ 落点标记最多一个', () => {
  const { api } = load();
  assert.equal(api.templates.length, 9);
  for (const t of api.templates) {
    assert.ok(t.key && t.label && t.short, `模板字段缺失: ${t.key}`);
    assert.ok(t.text.length > 0, `模板文本为空: ${t.key}`);
    const marks = (t.text.match(/@@/g) || []).length;
    assert.ok(marks <= 1, `模板 ${t.key} 有 ${marks} 个 @@ 标记`);
  }
});

test('模板插入：@@ 被剥离，光标落在标记处', () => {
  const { view, calls } = makeView('hello', 5, 5);
  const { api } = load({ view });
  assert.equal(api.insertTemplate('inline'), true);
  const spec = calls[0];
  assert.equal(spec.changes.insert, '$$', '插入文本里不应残留 @@');
  assert.equal(spec.changes.from, 5);
  // '$@@$' → 剥离后 '$$'，@@ 在索引 1
  assert.equal(spec.selection.anchor, 5 + 1);
});

test('模板插入：行间公式多行落点在空行', () => {
  const { view, calls } = makeView('', 0, 0);
  const { api } = load({ view });
  api.insertTemplate('block');
  const spec = calls[0];
  assert.equal(spec.changes.insert, '$$\n\n$$');
  assert.equal(spec.selection.anchor, '$$\n'.length); // 第 3 个字符位置
});

test('包裹：非空选区加前后缀并保住选中范围', () => {
  const { view, calls } = makeView('x^2+1', 0, 5);
  const { api } = load({ view });
  assert.equal(api.applyWrap('paren'), true);
  const spec = calls[0];
  // 注意：dispatch 的 spec 来自 vm realm，deepStrictEqual 会因子类原型不同而失败，
  // 这里用宿主侧 Array.from 归一化后再比（比的是值，不是 realm）。
  assert.deepEqual(
    Array.from(spec.changes, (c) => [c.from, c.insert]),
    [[0, '\\left('], [5, '\\right)']],
  );
  assert.equal(spec.selection.anchor, '\\left('.length);
  assert.equal(spec.selection.head, 5 + '\\left('.length);
});

test('包裹：空选区只插一对，光标居中', () => {
  const { view, calls } = makeView('abc', 3, 3);
  const { api } = load({ view });
  api.applyWrap('abs');
  const spec = calls[0];
  assert.equal(spec.changes.length, 1);
  assert.equal(spec.changes[0].insert, '||');
  assert.equal(spec.selection.anchor, 4);
});

test('公式编号：定位成对 $$ 并取下一个号', () => {
  const { api } = load();
  const text = '前\n$$\nE=mc^2\n$$\n后';
  const open = text.indexOf('$$');
  const close = text.lastIndexOf('$$');
  const inside = open + 3;
  const block = api.findDisplayMath(text, inside);
  assert.equal(block.open, open);
  assert.equal(block.close, close);
  assert.equal(api.findDisplayMath(text, 1), null, '块外不应命中');
});

test('公式编号：已有 \\tag 最大值 +1', () => {
  const { api } = load();
  assert.equal(api.maxEquationNumber('no tags'), 0);
  assert.equal(api.maxEquationNumber('a \\tag{3} b \\tag{7} c'), 7);
  assert.equal(api.maxEquationNumber('a \\tag{10}'), 10);
});

test('公式编号：写入 \\tag{n} 且返回 n', () => {
  const text = '$$\nE=mc^2\n$$';
  const close = text.lastIndexOf('$$');
  const { view, calls } = makeView(text, 3, 3);
  const { api } = load({ view });
  const n = api.numberEquation();
  assert.equal(n, 1);
  const spec = calls.find((c) => c.changes);
  assert.ok(spec, '应有一次 dispatch');
  assert.match(spec.changes.insert, /\\tag\{1\}/);
  assert.equal(spec.changes.from, close);
});

test('符号面板：分组齐全且总数 > 60', () => {
  const { api } = load();
  const total = api.symbols.reduce((n, g) => n + g.items.length, 0);
  assert.ok(total > 60, `符号总数 ${total} 应 > 60`);
  for (const g of api.symbols) {
    assert.ok(g.group && g.items.length > 0);
  }
});

test('AI：6 类意图齐全', () => {
  const { api } = load();
  assert.equal(api.intents.length, 6);
  const keys = Array.from(api.intents, (i) => i.key);
  assert.deepEqual(keys, ['explain', 'next', 'solve', 'simplify', 'check', 'ask']);
});

test('AI 上下文打包：自解释、带行号、带要求、带 LaTeX 提示', () => {
  const text = '第一行\n第二行\n\\int_0^1 x dx\n第四行\n第五行\n第六行\n第七行';
  const from = text.indexOf('\\int');
  const to = from + '\\int_0^1 x dx'.length;
  const { view } = makeView(text, from, to);
  const { api } = load({ view });
  const payload = api.buildAIPayload('explain');
  assert.ok(payload, '应产出 payload');
  const t = payload.text;
  assert.match(t, /数学请求 · 解释这一步/);
  assert.match(t, /位置：第 3–3 行（已选中）/);
  assert.match(t, /\\int_0\^1 x dx/, '应含选区原文');
  assert.match(t, /【上下文，第 1–6 行】/, '上下文应上下各 3 行');
  assert.match(t, /要求：请逐步解释/);
  assert.match(t, /LaTeX 原样书写/, '应提醒保留 LaTeX');
  assert.equal(payload.meta.hasSelection, true);
  assert.equal(payload.meta.fromLine, 3);
});

test('AI 上下文打包：自由提问为空时不产出', () => {
  const { view } = makeView('abc', 0, 0);
  const { api } = load({ view });
  assert.equal(api.buildAIPayload('ask', '   '), null);
  assert.ok(api.buildAIPayload('ask', '这一步为什么成立'), '有文字时应产出');
});

test('AI 发送：走上行 insert-to-chat（只填不发）', () => {
  const { view } = makeView('x=1', 0, 3);
  const { api, emitted } = load({ view });
  assert.equal(api.runAI('solve'), true);
  const up = emitted.find((e) => e.type === 'insert-to-chat');
  assert.ok(up, '应有 insert-to-chat 上行');
  assert.match(up.content.text, /数学请求 · 求解/);
  // 不能出现"自动发送"类命令
  assert.equal(emitted.filter((e) => /send/i.test(e.type)).length, 0);
});

test('命令分发：下行 cmd 能驱动模板/包裹/符号/编号/AI', () => {
  const { view, calls } = makeView('x', 0, 1);
  const { api, handler, emitted } = load({ view });
  handler._fire('cmd', { kind: 'template', key: 'block' });
  assert.ok(calls.some((c) => c.changes && c.changes.insert.startsWith('$$')));
  handler._fire('cmd', { kind: 'symbol', ch: '∑' });
  assert.ok(calls.some((c) => c.changes && c.changes.insert === '∑'));
  handler._fire('cmd', { kind: 'ai', intent: 'check' });
  assert.ok(emitted.some((e) => e.type === 'insert-to-chat'));
  // 未知 kind 不抛
  handler._fire('cmd', { kind: 'nope' });
  handler._fire('cmd', null);
});

test('没有引擎时不抛：所有写入返回 false', () => {
  const { api } = load(); // 不设 mpEngine
  assert.equal(api.getView(), null);
  assert.equal(api.insertTemplate('block'), false);
  assert.equal(api.applyWrap('paren'), false);
  assert.equal(api.insertSymbol('α'), false);
  assert.equal(api.numberEquation(), false);
  assert.equal(api.buildAIPayload('explain'), null);
  assert.equal(api.runAI('explain'), false);
});

test('输入法保护：composing 期间不写', () => {
  const { view, calls } = makeView('abc', 1, 1);
  view.composing = true;
  const { api } = load({ view });
  assert.equal(api.insertTemplate('block'), false);
  assert.equal(calls.length, 0, 'composing 期间不得产生任何 dispatch');
});
