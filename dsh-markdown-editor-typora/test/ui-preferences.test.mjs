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

/* ── 纸面双态契约：透明开＝编辑面完全透明；透明关＝配方原纸色（静态 CSS 契约）──
 * 背景：配方 paper 由 articleEditorCss（article-recipes.js）唯一提供，它把纸色写在
 * html / html body / .cm-editor / .cm-scroller / .cm-gutters / .cm-content 六处，
 * 且**不带 !important**。产品语义是二选一：
 *   · 透明开（book / report / plain，明暗两档，阅读/编辑）⇒ 编辑整面必须**完全**透出
 *     宿主背景，不允许任何纸色、底纹或半透明混合层；
 *   · 透明关 ⇒ 配方原纸色逐位保留（#FBF6EC / #FFFFFF / #171411 / #10151B）。
 * 因此本条既禁止"配方被永久遮住"（旧断言的问题），也禁止"任何形式的着色层"（veil 的问题）。 */
test('transparency makes every paper layer fully clear, and "off" keeps the recipe paper', () => {
  /* 仓库布局：壳页固定为 ROOT/renderer-cm6/index.html（ROOT 是插件包根）。
   * 本测试只读这一个文件，不依赖 lib/ 与 dsh-bridge.js。 */
  const html = readFileSync(resolve(ROOT, 'renderer-cm6/index.html'), 'utf8');
  /* 取**真正的** style 元素：head 的 meta 注释里也写着 "<style>"，用 indexOf 会切到注释里
   * （那样选择器里会混进整段 head 文本，判定全部失真）。用 lastIndexOf 定位真实标签。 */
  const styleBlock = html.slice(html.lastIndexOf('<style>') + 7, html.lastIndexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '');           // 去注释，避免干扰选择器提取

  /* 逐条提取 "选择器 { 声明 }"，只抓编辑面/root 上的背景类规则。 */
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(styleBlock))) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const body = m[2];
    if (!selectors.some((s) => s.includes('[data-mp-transparent'))) continue;
    if (!/background/.test(body)) continue;
    rules.push({ selectors, body: body.trim() });
  }
  assert.ok(rules.length > 0, 'expected background rules under [data-mp-transparent]');

  const allSelectors = rules.flatMap((r) => r.selectors);
  const isSurface = (s) => /\.cm-|\.mp-zoom-wrap|#editor|^html|(^|\s)body($|\s|,)/.test(s);

  /* ── 判据 1（全透明）：透明开时，凡命中编辑面的规则都只许"清空"──
   * 具体到声明层面：background-color 只能是 transparent，且**不得出现任何**着色，
   * 包括 color-mix()、rgba()、hex、以及任何 opacity/backdrop/blur 之类的滤镜层。 */
  const onRules = rules.filter((r) => r.selectors.every((s) => s.includes('[data-mp-transparent="on"]')));
  assert.ok(onRules.length > 0, 'the "on" state must clear the editor background');
  for (const rule of onRules) {
    assert.match(rule.body, /background-color\s*:\s*transparent\s*!important/,
      'every "on" background rule must clear with !important: ' + rule.body);
    assert.doesNotMatch(rule.body, /color-mix\(/,
      'no colour mixing may survive while transparency is on (veil): ' + rule.body);
    assert.doesNotMatch(rule.body, /background\s*:\s*(?!color-mix-)(?:#|rgba?\(|hsla?\()/,
      'no opaque/tinted background may survive while transparency is on: ' + rule.body);
    assert.doesNotMatch(rule.body, /(backdrop-filter|-webkit-backdrop-filter|filter\s*:|opacity\s*:)/,
      'no mask/blur layer may be added while transparency is on: ' + rule.body);
  }

  /* ── 判据 2（覆盖全部纸层）：配方写纸色的每一层都必须被清到，且**不分** recipe 状态 ──
   * 书页/研报/plain 都要透明，所以这里不允许出现 :not([data-mp-article-recipe]) 之类的
   * 排除式——那正是"有配方就不透"的老毛病。 */
  const mustClear = ['html', 'body', '.cm-editor', '.cm-scroller', '.cm-content', '.cm-gutters'];
  const onSelectors = onRules.flatMap((r) => r.selectors);
  for (const layer of mustClear) {
    const hit = onSelectors.some((s) => {
      if (!s.includes('[data-mp-transparent="on"]')) return false;
      if (layer === 'html') return /^html\[data-mp-transparent="on"\]$/.test(s);
      if (layer === 'body') return new RegExp('\\[data-mp-transparent="on"\\]\\s+body$').test(s);
      return new RegExp('\\[data-mp-transparent="on"\\]\\s+\\' + layer + '$').test(s);
    });
    assert.ok(hit, 'every recipe paper layer must be cleared while transparency is on: ' + layer);
  }
  for (const selector of onSelectors) {
    assert.doesNotMatch(selector, /:not\(\[data-mp-article-recipe\]\)/,
      'the "on" clearing must apply to recipes too, not only to plain: ' + selector);
  }

  /* ── 判据 3（无着色残留）：整块样式里不许再有"配方色 + 透明度"的混合，
   * 也不许再出现为 veil 而引入的 min-height 校正。 */
  assert.doesNotMatch(styleBlock, /color-mix\(in srgb\s*,\s*var\(--mp-article-bg/,
    'the recipe-paper veil must be gone entirely');
  assert.doesNotMatch(styleBlock, /min-height:\s*calc\(100%\s*\/\s*var\(--mp-zoom/,
    'the veil-only min-height compensation must be gone');

  /* ── 判据 4（关闭透明）：清空规则只挂在 data-mp-transparent="on" 下，
   * 所以 off 时一条都不命中 ⇒ 配方原纸色逐位保留。 */
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (!isSurface(selector)) continue;
      assert.match(selector, /\[data-mp-transparent="on"\]/,
        'paper-layer transparency must be gated on the "on" state: ' + selector);
    }
  }
});
