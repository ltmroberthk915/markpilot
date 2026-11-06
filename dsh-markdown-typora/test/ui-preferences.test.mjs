// MP_TRIAL_ROOT may point at an isolated checkout. These check bridge/storage contracts,
// not browser layout, pixels, native input, or CM6 rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = process.env.MP_TRIAL_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientSource = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8');
const bridgeSource = readFileSync(resolve(ROOT, 'renderer-cm6/dsh-bridge.js'), 'utf8');
const SETTINGS_KEY = 'dsh.markpilot.settings.v1';
const PAGE_KEY = 'mp-pref-pageWidth';
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function settingsFixture() {
  let definition;
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) };
  const sandbox = { window: { __ModuleLoader__: { load: d => { definition = d; } } }, console };
  vm.runInNewContext(clientSource, sandbox);
  const mod = definition.factory(name => { assert.equal(name, 'react'); return null; });
  return { api: mod.__test.layout, storage, values };
}

function bridgeFixture(initial = []) {
  const values = new Map(initial), listeners = new Map(), observers = [], messages = [];
  const styles = new Map(), prefCalls = [], themeCalls = [], attrWrites = [];
  let denyStorage = false;
  const keyOf = n => n.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const root = {
    dataset: {},
    style: { colorScheme: '', setProperty: (k, v) => styles.set(k, String(v)), getPropertyValue: k => styles.get(k) || '' },
    getAttribute: n => root.dataset[keyOf(n)] ?? null,
    setAttribute(n, v) { root.dataset[keyOf(n)] = String(v); attrWrites.push([n, String(v)]); },
    insertBefore() {},
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(target, options) { assert.equal(target, root); this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  const win = {
    document: { documentElement: root, body: null, head: null, baseURI: 'https://test/renderer-cm6/',
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
      createElement: () => ({ setAttribute() {}, getAttribute: () => null }), addEventListener() {} },
    location: { href: 'https://test/renderer-cm6/index.html', pathname: '/renderer-cm6/index.html' },
    localStorage: {
      getItem(k) { if (denyStorage) throw Error('storage denied'); return values.get(k) ?? null; },
      setItem(k, v) { if (denyStorage) throw Error('storage denied'); values.set(k, String(v)); },
    },
    parent: { postMessage: message => messages.push(message) },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true; },
    MutationObserver: Observer,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    console: { error() {}, warn() {} }, queueMicrotask,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  };
  win.window = win;
  vm.runInNewContext(bridgeSource, win, { filename: 'dsh-bridge.js' });
  const send = (type, content, source = win.parent) => win.dispatchEvent({ type: 'message', source,
    data: { __dshmd: true, dir: 'down', type, content } });
  const engine = {
    setPref(key, value) { prefCalls.push([key, value]); win.localStorage.setItem('mp-pref-' + key, value); },
    setTheme(id) { themeCalls.push(id); pickTheme(id.includes('light') ? 'light' : 'dark', id); },
    documentSession: () => ({ epoch: 1, sourceRevision: 0 }),
  };
  function changed(...attributes) {
    for (const observer of observers) if (observer.active && attributes.some(n => observer.options.attributeFilter.includes(n))) {
      observer.callback(attributes.map(attributeName => ({ attributeName, target: root })));
    }
  }
  function pickTheme(mode, id = 'custom-paper') {
    root.dataset.mode = mode; root.dataset.editorTheme = id;
    styles.set('--mp-bg', mode === 'light' ? '#fafafa' : '#202020');
    styles.set('--mp-fg', mode === 'light' ? '#242424' : '#eaeaea');
    changed('data-mode', 'data-editor-theme');
  }
  async function boot(protocol = 1) {
    win.handler.on('open', () => { win.mpEngine = engine; });
    send('open', protocol === 2
      ? { protocol: 2, docToken: 'document-1', applyId: 'open-1', serial: 1, content: 'text', expected: null }
      : { content: 'text' });
    await drain();
  }
  return { win, values, root, styles, messages, prefCalls, themeCalls, attrWrites, observers,
    send, pickTheme, changed, boot, denyStorage: () => { denyStorage = true; } };
}

test('keepResizeHandlesAfterClose defaults false and requires an actual boolean', () => {
  const { api, storage, values } = settingsFixture();
  assert.equal(api.readSettings(storage).keepResizeHandlesAfterClose, false);
  assert.equal(api.readSettings(null).keepResizeHandlesAfterClose, false);
  for (const value of ['true', 'false', 1, 0, null, [], {}]) {
    values.set(SETTINGS_KEY, JSON.stringify({ keepResizeHandlesAfterClose: value }));
    assert.equal(api.readSettings(storage).keepResizeHandlesAfterClose, false);
    assert.equal(api.writeSettings(storage, { keepResizeHandlesAfterClose: value }).keepResizeHandlesAfterClose, false);
  }
  for (const value of [true, false]) {
    api.writeSettings(storage, { keepResizeHandlesAfterClose: value, docsFolder: 'D:/Notes' });
    api.writeSettings(storage, { transparent: false });
    assert.equal(api.readSettings(storage).keepResizeHandlesAfterClose, value);
    assert.equal(api.readSettings(storage).docsFolder, 'D:/Notes');
  }
});

test('appearance is authenticated, strictly typed, idempotent, and preserves the selected editor theme', async () => {
  const f = bridgeFixture(); await f.boot();
  f.send('theme', { dark: true }); f.pickTheme('light', 'custom-paper');
  const selected = f.root.dataset.editorTheme, palette = [...f.styles], calls = f.themeCalls.length;
  f.send('appearance', { transparent: false }, {});
  assert.equal(f.root.getAttribute('data-mp-transparent'), null);
  f.send('appearance', { transparent: false });
  assert.equal(f.root.getAttribute('data-mp-transparent'), 'off');
  const writes = f.attrWrites.length;
  f.send('appearance', { transparent: false });
  f.send('appearance', { transparent: 'true' });
  assert.equal(f.attrWrites.length, writes);
  f.send('appearance', { transparent: true });
  assert.equal(f.root.getAttribute('data-mp-transparent'), 'on');
  assert.equal(f.root.dataset.editorTheme, selected);
  assert.deepEqual([...f.styles], palette);
  assert.equal(f.themeCalls.length, calls);
});

test('skin follows native theme mode with one root-only observer and disposes on real page exit', () => {
  const f = bridgeFixture();
  assert.equal(f.observers.length, 1);
  const observer = f.observers[0];
  assert.deepEqual(Array.from(observer.options.attributeFilter), ['data-mode', 'data-editor-theme']);
  assert.equal(observer.options.subtree, undefined);
  f.pickTheme('light'); assert.equal(f.root.dataset.dshTheme, 'light'); assert.equal(f.root.style.colorScheme, 'light');
  f.pickTheme('dark'); assert.equal(f.root.dataset.dshTheme, 'dark'); assert.equal(f.root.style.colorScheme, 'dark');
  f.win.dispatchEvent({ type: 'pagehide', persisted: true }); assert.equal(observer.active, true);
  f.win.dispatchEvent({ type: 'pagehide', persisted: false }); assert.equal(observer.active, false);
});

for (const protocol of [1, 2]) test(`new embedded editor defaults pageWidth to 100 through its facade (protocol ${protocol})`, async () => {
  const f = bridgeFixture();
  assert.equal(f.prefCalls.length, 0, 'not before engine boot');
  await f.boot(protocol);
  assert.deepEqual(f.prefCalls, [['pageWidth', 100]]);
  assert.equal(f.values.get(PAGE_KEY), '100');
  if (protocol === 2) assert.equal(f.messages.find(m => m.type === 'apply-result')?.content.applied, true);
  f.win.mpEngine.setPref('pageWidth', 61);
  f.send('open', { content: 'repeated v1 delivery' }); await drain();
  assert.equal(f.values.get(PAGE_KEY), '61');
  assert.equal(f.prefCalls.length, 2, 'repeated handshake must not reset the user preference');
});

test('stored page width and independent zoom preferences are preserved byte-for-byte', async () => {
  for (const width of ['40', '74', '100', '73.5', '', 'invalid']) {
    const f = bridgeFixture([[PAGE_KEY, width], ['mp-pref-zoom', '125']]);
    await f.boot(2);
    assert.equal(f.prefCalls.length, 0, 'existing preference belongs to engine validation');
    assert.equal(f.values.get(PAGE_KEY), width);
    assert.equal(f.values.get('mp-pref-zoom'), '125');
  }
});

test('unavailable preference storage leaves the engine preference alone', async () => {
  const f = bridgeFixture(); f.denyStorage(); await f.boot(2);
  assert.equal(f.prefCalls.length, 0);
  assert.equal(f.messages.find(m => m.type === 'apply-result')?.content.applied, true);
});
