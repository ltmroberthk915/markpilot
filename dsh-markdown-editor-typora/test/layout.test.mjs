// test/layout.test.mjs — M0 布局引擎纯逻辑验收（Node + 假 DOM，不启浏览器、不启宿主）
//
// 覆盖：几何钳制（绝不产负 margin）、锚点解析、比较再写、幂等、还原、让位、
//       以及本设计最关键的一条 —— 宽度变量必须写在**会话内容区**上，不能写在会话根上。
// 不覆盖：真实宿主 DOM、真实 ResizeObserver/MutationObserver 时序、视觉（属六步流程第 5 步）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

let cachedLayout = null;

/** 复用既有 client.test.mjs 的装载形态：vm 里跑 loader，捕获 factory，取 __test。 */
async function getLayout() {
  if (cachedLayout) return cachedLayout;
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { captured = def; } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, '未捕获到 ModuleLoader 定义');
  const mod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  assert.ok(mod.__test && mod.__test.layout, '__test.layout 未暴露');
  cachedLayout = mod.__test.layout;
  return cachedLayout;
}

/* ── 假 DOM ──────────────────────────────────────────────────────── */

function makeStyle() {
  const map = new Map();
  return {
    getPropertyValue(p) { return map.has(p) ? map.get(p) : ''; },
    setProperty(p, v) { map.set(p, String(v)); },
    removeProperty(p) { map.delete(p); },
    _dump() { return Object.fromEntries(map); },
  };
}

function makeEl(tagName, opts = {}) {
  const el = {
    tagName: tagName.toUpperCase(),
    className: opts.className || '',
    children: opts.children || [],
    dataset: opts.dataset || {},
    style: makeStyle(),
    _attrs: {},
    _rect: opts.rect || { width: 1600, height: 900, top: 60, left: 280 },
    _query: opts.query || {},
    getBoundingClientRect() { return { ...this._rect }; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    querySelector(sel) { return this._query[sel] || null; },
  };
  return el;
}

/** 造一个仿真宿主结构：root[data-phase] > [header, body[data-conversation-content]] */
function makeHost({ phase = 'active', width = 1600, height = 900, useAttr = true, chatW = 0 } = {}) {
  const body = makeEl('div', {
    className: 'body',
    rect: { width, height, top: 60, left: 280 },
    dataset: useAttr ? { 'conversation-content': '' } : {},
  });
  if (chatW > 0) body.style.setProperty('margin-left', chatW + 'px'); // 预置外部值
  const header = makeEl('div', { className: 'header' });
  const root = makeEl('div', {
    className: 'root',
    dataset: { phase },
    children: [header, body],
    rect: { width, height, top: 40, left: 280 },
    query: useAttr ? { ':scope > [data-conversation-content]': body } : {},
  });
  const doc = {
    body: makeEl('div'),
    querySelectorAll(sel) { return sel === '[data-phase]' ? [root] : []; },
    querySelector() { return null; },
  };
  return { doc, root, body, header };
}

const CFG = { enabled: true, mode: 'center', chatWidth: 420 };

test('嵌套输入区：不把整个正文高度写成滚动区留白，关闭后保留宿主样式', async () => {
  const L = await getLayout();
  const { doc, root, body } = makeHost();
  const scroll = makeEl('div', { className: 'host_scrollBody' });
  const seat = makeEl('div', { className: 'host_composerSeat', rect: { height: 136 } });
  const editable = makeEl('textarea');
  const main = makeEl('main');
  body._rect.height = 637;
  root.parentElement = main;
  body.parentElement = root;
  scroll.parentElement = body;
  seat.parentElement = scroll;
  editable.parentElement = seat;
  body.children = [scroll]; scroll.children = [seat]; seat.children = [editable];
  root._query['[class*="_scroll"]'] = scroll;
  root._query['[data-conversation-scroll]'] = scroll;
  root._query['[data-composer-seat]'] = seat;
  root._query['textarea'] = editable;
  root._query['[contenteditable="true"]'] = editable;
  main._query['textarea'] = editable;
  main._query['[contenteditable="true"]'] = editable;
  scroll.style.setProperty('padding-bottom', '7px');
  L.setSqueezeForTests(true);
  const engine = L.createLayoutEngine({ doc, win: { innerWidth: 1600 }, cfg: CFG });
  assert.equal(engine.apply(), true);
  assert.equal(scroll.style.getPropertyValue('padding-bottom'), '7px');
  engine.restore();
  assert.equal(scroll.style.getPropertyValue('padding-bottom'), '7px');
});

/* ── 几何 ────────────────────────────────────────────────────────── */

test('几何：居中时对话贴右 → 左 margin = 列宽 − 对话宽', async () => {
  const L = await getLayout();
  const g = L.computeLayout('center', { chatWidth: 420 }, 1600, 900);
  assert.equal(g.ok, true);
  assert.equal(g.chatW, 420);
  assert.equal(g.marginLeft, '1180px');
  assert.equal(g.marginRight, '');
});

test('几何：mode=right 时对话贴左 → 右 margin', async () => {
  const L = await getLayout();
  const g = L.computeLayout('right', { chatWidth: 420 }, 1600, 900);
  assert.equal(g.marginLeft, '');
  assert.equal(g.marginRight, '1180px');
});

test('几何：窄列不产出负 margin（阻断项 3 回归）', async () => {
  const L = await getLayout();
  // 设计里给过的实测算例：1280 视口 + 侧栏 264 + 右栏 500 ⇒ 中心列 516
  const g = L.computeLayout('center', { chatWidth: 900 }, 516, 800);
  assert.equal(g.ok, true);
  assert.ok(g.chatW <= 516, `chatW ${g.chatW} 不得超过列宽`);
  assert.ok(parseInt(g.marginLeft, 10) >= 0, 'marginLeft 不得为负');
  assert.ok(g.chatW >= 300, 'chatW 不得低于最小宽');
});

test('几何：列宽非法时 ok=false', async () => {
  const L = await getLayout();
  for (const w of [0, -10, NaN, undefined]) {
    const g = L.computeLayout('center', { chatWidth: 420 }, w, 800);
    assert.equal(g.ok, false, `width=${w} 应判不可用`);
  }
});

test('几何：chatWidth 超上限被钳到 900', async () => {
  const L = await getLayout();
  const g = L.computeLayout('center', { chatWidth: 5000 }, 4000, 800);
  assert.ok(g.chatW <= 900, `chatW ${g.chatW} 应 ≤ 900`);
});

/* ── 锚点 ────────────────────────────────────────────────────────── */

test('锚点：session 根优先取 active', async () => {
  const L = await getLayout();
  const hero = makeEl('div', { dataset: { phase: 'hero' }, children: [makeEl('div')] });
  const active = makeEl('div', { dataset: { phase: 'active' }, children: [makeEl('div')] });
  const doc = { querySelectorAll: () => [hero, active] };
  assert.equal(L.findConversationRoot(doc), active);
});

test('锚点：排除 TEXTAREA 与无子元素的候选', async () => {
  const L = await getLayout();
  const ta = makeEl('textarea', { dataset: { phase: 'active' }, children: [makeEl('div')] });
  const empty = makeEl('div', { dataset: { phase: 'active' }, children: [] });
  const ok = makeEl('div', { dataset: { phase: 'settling' }, children: [makeEl('div')] });
  const doc = { querySelectorAll: () => [ta, empty, ok] };
  assert.equal(L.findConversationRoot(doc), ok);
});

test('锚点：没有候选时返回 null', async () => {
  const L = await getLayout();
  assert.equal(L.findConversationRoot({ querySelectorAll: () => [] }), null);
  assert.equal(L.findConversationRoot(null), null);
});

test('锚点：内容区优先用 data-conversation-content', async () => {
  const L = await getLayout();
  const { root, body } = makeHost({ useAttr: true });
  assert.equal(L.findConversationBody(root), body);
});

test('锚点：没有语义属性时退回 children[1]', async () => {
  const L = await getLayout();
  const { root, body } = makeHost({ useAttr: false });
  assert.equal(L.findConversationBody(root), body);
});

/* ── 比较再写 ────────────────────────────────────────────────────── */

test('writeStyle：同值不写（幂等的地基）', async () => {
  const L = await getLayout();
  const el = makeEl('div');
  assert.equal(L.writeStyle(el, 'margin-left', '10px'), true, '首次应写');
  assert.equal(L.writeStyle(el, 'margin-left', '10px'), false, '同值不应再写');
  assert.equal(el.style.getPropertyValue('margin-left'), '10px');
});

test('writeStyle：空值等于 removeProperty', async () => {
  const L = await getLayout();
  const el = makeEl('div');
  el.style.setProperty('margin-left', '10px');
  assert.equal(L.writeStyle(el, 'margin-left', ''), true);
  assert.equal(el.style.getPropertyValue('margin-left'), '');
});

/* ── 引擎 ────────────────────────────────────────────────────────── */

test('引擎：宽度变量写在【会话内容区】而不是会话根（§3.6 核心回归）', async () => {
  const L = await getLayout();
  const { doc, root, body } = makeHost();
  L.setSqueezeForTests(true);
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  assert.equal(engine.apply(), true);
  assert.equal(body.style.getPropertyValue('--dsh-chat-user-width'), '420px',
    '内容区应被钉到 420px');
  assert.equal(root.style.getPropertyValue('--dsh-chat-user-width'), '',
    '会话根上不得写该变量（写了会被宿主 publishWidths 覆盖）');
});

test('引擎：挤压写在会话内容区的 margin-left（照抄 worktable 的 applyMargin）', async () => {
  const L = await getLayout();
  const { doc, root, body } = makeHost({ width: 1600 });
  L.setSqueezeForTests(true);
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  engine.apply();
  assert.equal(body.style.getPropertyValue('margin-left'), '1180px', '内容区应有左 margin');
  assert.equal(body.style.getPropertyValue('margin-right'), '');
  assert.equal(root.style.getPropertyValue('padding-left'), '', '会话根不得再被加内边距（padding 会连带压坏搜索栏/头部布局）');
});

test('引擎：二次 apply 幂等（写入次数不增）', async () => {
  const L = await getLayout();
  const { doc } = makeHost();
  L.setSqueezeForTests(true);
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  engine.apply();
  const after1 = engine.snapshot().writes;
  engine.apply();
  engine.apply();
  const after3 = engine.snapshot().writes;
  assert.equal(after3, after1, `重复 apply 不应产生新写入（${after1} → ${after3}）`);
});

test('引擎：restore 只还原自己动过的项', async () => {
  const L = await getLayout();
  const { doc, body, root } = makeHost({ chatW: 300 });
  // 预置一个外部值，验证还原会回到它而不是清空
  body.style.setProperty('margin-right', '7px');
  L.setSqueezeForTests(true);
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  engine.apply();
  assert.notEqual(body.style.getPropertyValue('margin-left'), '', '挤压后应有 margin-left');
  engine.restore();
  assert.equal(body.style.getPropertyValue('--dsh-chat-user-width'), '', '变量应清空');
  assert.equal(body.style.getPropertyValue('margin-left'), '300px', 'margin-left 应还原成打开前的原值');
  assert.equal(body.style.getPropertyValue('margin-right'), '7px', '未动过的项保持原值');
  assert.equal(root.getAttribute('data-mp-layout'), null, '标记属性应移除');
});

test('引擎：外部改写 margin 时让位并还原', async () => {
  const L = await getLayout();
  const { doc, body } = makeHost();
  L.setSqueezeForTests(true);
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  engine.apply();
  assert.equal(engine.checkYield(), false, '没被改写时不该让位');
  // 模拟另一个插件接管：改写我们写过的会话内容区 margin
  const liveBody = doc.querySelectorAll('[data-phase]')[0].children[1];
  liveBody.style.setProperty('margin-left', '999px');
  assert.equal(engine.checkYield(), true, '被改写应让位');
  assert.equal(engine.snapshot().active, false, '让位后应失活');
  assert.equal(body.style.getPropertyValue('margin-left'), '', '让位时应还原');
});

test('引擎：没有 root 时 apply 返回 false 且不写', async () => {
  const L = await getLayout();
  const doc = { querySelectorAll: () => [], body: makeEl('div') };
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  assert.equal(engine.apply(), false);
  assert.equal(engine.snapshot().writes, 0);
});

test('引擎：给根打上 data-mp-layout 标记（供 CSS 隐藏宿主宽度手柄）', async () => {
  const L = await getLayout();
  const { doc, root } = makeHost();
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  engine.apply();
  assert.equal(root.getAttribute('data-mp-layout'), 'on');
});

/* ── 配置 ────────────────────────────────────────────────────────── */

test('配置：缺省关闭（不影响现有用户）', async () => {
  const L = await getLayout();
  const cfg = L.readLayoutConfig(null);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, 'center');
  assert.equal(cfg.chatWidth, 420);
});

test('配置：坏 JSON / 脏值回默认并钳制', async () => {
  const L = await getLayout();
  const bad = { getItem: () => '{not json' };
  assert.equal(L.readLayoutConfig(bad).enabled, false);

  const dirty = { getItem: () => JSON.stringify({ enabled: true, mode: 'sideways', chatWidth: 99999 }) };
  const cfg = L.readLayoutConfig(dirty);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, 'center', '非法 mode 应回 center');
  assert.equal(cfg.chatWidth, 900, '超上限应钳到 900');
});

test('配置：存取往返 + 钳制', async () => {
  const L = await getLayout();
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
  };
  assert.equal(L.saveLayoutConfig(storage, { enabled: true, mode: 'right', chatWidth: 5000 }), true);
  const back = L.readLayoutConfig(storage);
  assert.equal(back.enabled, true);
  assert.equal(back.mode, 'right');
  assert.equal(back.chatWidth, 900);
});

test('mountLayout：未开启时不启动、返回 null', async () => {
  const L = await getLayout();
  // 无 window.localStorage ⇒ readLayoutConfig 回默认 enabled:false
  assert.equal(L.mountLayout({}), null);
});

/* ── 等根出现再激活（真实缺陷回归）────────────────────────────────── */

function makeFakeMO() {
  const instances = [];
  class FakeMO {
    constructor(cb) { this.cb = cb; this.disconnected = false; instances.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    fire() { if (!this.disconnected) this.cb(); }
  }
  return { FakeMO, instances };
}

test('等根：根不存在时不激活，根出现后自动激活', async () => {
  const L = await getLayout();
  const { FakeMO, instances } = makeFakeMO();
  // 一开始没有任何会话根
  const doc = { querySelectorAll: () => [], body: makeEl('div') };
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });

  const waiter = L.waitForConversationRoot(engine, { doc, win: {}, MutationObserver: FakeMO, limitMs: 1000 });
  assert.ok(waiter, '应返回 stop()');
  assert.equal(engine.snapshot().active, false, '无根时不得激活');

  // 现在把根挂上去，然后触发观察器
  const { root, body } = makeHost();
  doc.querySelectorAll = (sel) => (sel === '[data-phase]' ? [root] : []);
  instances[0].fire();

  assert.equal(engine.snapshot().active, true, '根出现后应激活');
  assert.equal(body.style.getPropertyValue('--dsh-chat-user-width'), '420px', '变量应写在内容区');
  assert.equal(instances[0].disconnected, true, '激活后观察器应自行断开');
});

test('等根：stop() 之后不再激活', async () => {
  const L = await getLayout();
  const { FakeMO, instances } = makeFakeMO();
  const doc = { querySelectorAll: () => [], body: makeEl('div') };
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  const waiter = L.waitForConversationRoot(engine, { doc, win: {}, MutationObserver: FakeMO, limitMs: 1000 });
  waiter.stop();
  const { root } = makeHost();
  doc.querySelectorAll = (sel) => (sel === '[data-phase]' ? [root] : []);
  if (instances[0]) instances[0].fire();
  assert.equal(engine.snapshot().active, false, 'stop 之后不得激活');
});

test('mountLayout：开启但暂无会话根时返回引擎并挂上等待器', async (t) => {
  const L = await getLayout();
  const { FakeMO } = makeFakeMO();
  const store = new Map();
  store.set('dsh.markpilot.layout.v1', JSON.stringify({ enabled: true, mode: 'center', chatWidth: 420 }));
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const doc = { querySelectorAll: () => [], body: makeEl('div'), getElementById: () => null, createElement: (t) => makeEl(t), head: makeEl('head') };

  const win = {};
  t.after(() => win.__mpLayoutDispose?.());
  const engine = L.mountLayout({}, { doc, win, storage, MutationObserver: FakeMO, limitMs: 1000 });
  assert.ok(engine, '应返回引擎实例');
  assert.equal(engine.snapshot().active, false, '此时还没激活');
  assert.ok(engine.__waiter, '应挂上等待器');
});

test('mountLayout：关闭时不启动', async () => {
  const L = await getLayout();
  const storage = { getItem: () => null, setItem: () => {} };
  const doc = { querySelectorAll: () => [], body: makeEl('div') };
  assert.equal(L.mountLayout({}, { doc, win: {}, storage, limitMs: 1000 }), null);
});
test('锚点：hero 态（根只有 1 个子元素且无 data-conversation-content）不得挤压头部', async () => {
  const L = await getLayout();
  // 真实宿主实测：空会话时 [data-phase] 根 kids=1，没有 [data-conversation-content]
  const only = makeEl('div', { className: 'header' });
  const root = makeEl('div', { dataset: { phase: 'hero' }, children: [only], rect: { width: 1288, height: 854, top: 90, left: 60 }, query: {} });
  assert.equal(L.findConversationBody(root), null, '不得退到 children[0]（那是头部）');

  // 引擎在这种状态下必须放弃，而不是写歪
  const doc = { querySelectorAll: (s) => (s === '[data-phase]' ? [root] : []), body: makeEl('div') };
  const engine = L.createLayoutEngine({ doc, win: {}, cfg: CFG });
  assert.equal(engine.apply(), false, 'hero 态应放弃挤压');
  assert.equal(engine.snapshot().writes, 0, '不得产生任何写入');
  assert.equal(only.style.getPropertyValue('margin-left'), '', '头部不得被写 margin');
});
/* ── M1：宿主模式（focus / dock）──────────────────────────────────── */

function makeLayoutApi() {
  const calls = [];
  return {
    calls,
    api: {
      openRightbar(track, fullscreen) { calls.push({ track, fullscreen }); },
      closeRightbar() { calls.push({ close: true }); },
      selectPanel() {},
      toggleSidebar() {},
    },
  };
}

test('模式白名单：center / right / dock / focus', async () => {
  const L = await getLayout();
  assert.deepEqual(Array.from(L.modes), ['center', 'right', 'dock', 'focus']);
});

test('配置：接受 dock / focus，非法值回 center', async () => {
  const L = await getLayout();
  const mk = (m) => ({ getItem: () => JSON.stringify({ enabled: true, mode: m, chatWidth: 420 }) });
  assert.equal(L.readLayoutConfig(mk('dock')).mode, 'dock');
  assert.equal(L.readLayoutConfig(mk('focus')).mode, 'focus');
  assert.equal(L.readLayoutConfig(mk('nope')).mode, 'center');

  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  L.saveLayoutConfig(storage, { enabled: true, mode: 'focus', chatWidth: 420 });
  assert.equal(JSON.parse(store.get('dsh.markpilot.layout.v1')).mode, 'focus');
});

test('focus 模式：调用 openRightbar(false, true)，且不做文字挤压', async () => {
  const L = await getLayout();
  const { calls, api } = makeLayoutApi();
  const ctx = { get: (n) => (n === 'layout' ? api : undefined) };
  const store = new Map([['dsh.markpilot.layout.v1', JSON.stringify({ enabled: true, mode: 'focus', chatWidth: 420 })]]);
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const { root, body } = makeHost();
  const doc = {
    querySelectorAll: (s) => (s === '[data-phase]' ? [root] : []),
    body: makeEl('div'),
    getElementById: () => null,
    createElement: (t) => makeEl(t),
    head: makeEl('head'),
  };
  const engine = L.mountLayout(ctx, { doc, win: {}, storage, limitMs: 1000 });
  assert.ok(engine, '应返回引擎/宿主句柄');
  assert.equal(engine.mode, 'focus');
  assert.equal(engine.hostApplied, true, '宿主 API 应被调用成功');
  assert.deepEqual(Array.from(calls)[0], { track: false, fullscreen: true });
  assert.equal(body.style.getPropertyValue('margin-left'), '', 'focus 模式不应挤压对话');
});

test('dock 模式：调用 openRightbar(true, false)', async () => {
  const L = await getLayout();
  const { calls, api } = makeLayoutApi();
  const ctx = { get: (n) => (n === 'layout' ? api : undefined) };
  const store = new Map([['dsh.markpilot.layout.v1', JSON.stringify({ enabled: true, mode: 'dock', chatWidth: 420 })]]);
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const { root } = makeHost();
  const doc = {
    querySelectorAll: (s) => (s === '[data-phase]' ? [root] : []),
    body: makeEl('div'), getElementById: () => null, createElement: (t) => makeEl(t), head: makeEl('head'),
  };
  const engine = L.mountLayout(ctx, { doc, win: {}, storage, limitMs: 1000 });
  assert.equal(engine.mode, 'dock');
  assert.deepEqual(Array.from(calls)[0], { track: true, fullscreen: false });
});

test('宿主无 layout 服务时降级：不抛错、hostApplied=false', async () => {
  const L = await getLayout();
  const ctx = { get: () => undefined };
  const store = new Map([['dsh.markpilot.layout.v1', JSON.stringify({ enabled: true, mode: 'focus', chatWidth: 420 })]]);
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: () => {} };
  const doc = { querySelectorAll: () => [], body: makeEl('div'), getElementById: () => null, createElement: (t) => makeEl(t), head: makeEl('head') };
  const engine = L.mountLayout(ctx, { doc, win: {}, storage, limitMs: 1000 });
  assert.ok(engine, '仍应返回句柄');
  assert.equal(engine.hostApplied, false, '宿主不可用时应如实降级');
});
/* ── M1 多文档：卸载只回收自己那条（曾经的「编辑区突然消失」）──────── */

const mkTab = (id, visible = true) => ({ id, contentId: 'dsh-resource://file/' + id + '.md', visible });

test('多文档：后发布的可见文档成为活跃', async () => {
  const L = await getLayout();
  const a = mkTab('tabA'), b = mkTab('tabB');
  L.publishOverlayDoc({ tab: a });
  assert.equal(L.getOverlayDoc().tab.id, 'tabA');
  L.publishOverlayDoc({ tab: b });
  assert.equal(L.getOverlayDoc().tab.id, 'tabB');
  L.unpublishOverlayDoc(a); L.unpublishOverlayDoc(b);
});

test('多文档：卸载活跃那个 → 回落到另一个（核心回归）', async () => {
  const L = await getLayout();
  const a = mkTab('tabA2'), b = mkTab('tabB2');
  L.publishOverlayDoc({ tab: a });
  L.publishOverlayDoc({ tab: b });
  L.unpublishOverlayDoc(b);
  const cur = L.getOverlayDoc();
  assert.ok(cur, '不得因为一个 tab 卸载就清空全部');
  assert.equal(cur.tab.id, 'tabA2', '应回落到另一个仍存在的文档');
  L.unpublishOverlayDoc(a);
});

test('多文档：卸载非活跃不影响活跃', async () => {
  const L = await getLayout();
  const a = mkTab('tabA3'), b = mkTab('tabB3');
  L.publishOverlayDoc({ tab: a });
  L.publishOverlayDoc({ tab: b });
  L.unpublishOverlayDoc(a);            // a 不是活跃的那个
  assert.equal(L.getOverlayDoc().tab.id, 'tabB3');
  L.unpublishOverlayDoc(b);
});

test('多文档：不可见文档不夺取活跃位', async () => {
  const L = await getLayout();
  const a = mkTab('tabA4', true), hidden = mkTab('tabHidden4', false);
  L.publishOverlayDoc({ tab: a });
  L.publishOverlayDoc({ tab: hidden }); // 后发布但不可见
  assert.equal(L.getOverlayDoc().tab.id, 'tabA4', '不可见的不得顶替');
  L.unpublishOverlayDoc(a); L.unpublishOverlayDoc(hidden);
});

test('多文档：全部卸载后保持最后一份（sticky），显式关闭才置空', async () => {
  const L = await getLayout();
  const a = mkTab('tabA5'), b = mkTab('tabB5');
  L.publishOverlayDoc({ tab: a });
  L.publishOverlayDoc({ tab: b });
  L.unpublishOverlayDoc(a); L.unpublishOverlayDoc(b);
  // 收起右侧栏会让宿主卸载 tab —— 编辑区不能因此消失（实机复现过的缺陷）
  assert.ok(L.getOverlayDoc(), '不得因 tab 卸载而清空');
  assert.equal(L.getOverlayDoc().tab.id, 'tabB5', '应保留最后一份');
  L.clearOverlayDoc();
  assert.equal(L.getOverlayDoc(), null, '显式关闭后才置空');
});

test('多文档：关闭后忽略宿主重挂载，显式重新打开才恢复', async () => {
  const L = await getLayout();
  const a = mkTab('tabA6');
  L.publishOverlayDoc({ tab: a });
  L.clearOverlayDoc();
  assert.equal(L.getOverlayDoc(), null);
  L.publishOverlayDoc({ tab: a });
  assert.equal(L.getOverlayDoc(), null, '宿主重新挂载不能复活已关闭文档');
  L.publishOverlayDoc({ tab: a, explicit: true });
  assert.equal(L.getOverlayDoc().tab.id, 'tabA6');
  L.clearOverlayDoc();
});

test('多文档：docKeyOf 区分不同 tab 与不同文档', async () => {
  const L = await getLayout();
  const k1 = L.docKeyOf(mkTab('t1'));
  const k2 = L.docKeyOf(mkTab('t2'));
  const k3 = L.docKeyOf({ id: 't1', contentId: 'dsh-resource://file/other.md' });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.equal(L.docKeyOf(null), '');
});
