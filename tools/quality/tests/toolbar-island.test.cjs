'use strict';
/*
 * 工具岛信息架构回归（2026-11-16）。
 *
 * 覆盖面：
 *  1. 真跑 toolbar.js 的 installToolbar（最小 DOM 桩）：可见按钮集合、脚注按钮位置/图标/提示、
 *     创建期间零 toolbarClick（重开文档不得触发点击副作用）、脚注按钮路由到扩展包；
 *  2. 四个被撤下可见槽位的编辑命令仍在 TOOLBAR_ACTIONS（右键菜单/快捷键/外部调用可用）；
 *  3. extras.js 的入口收敛：更多菜单只剩文档操作 + 唯一「编辑器设置」+ 帮助/关于；
 *     设置页七个域按定稿顺序排列；阅读配色与快捷键在设置页内直接可操作；
 *     主题/页面/界面/阅读配色/快捷键不再各开弹层；旧 id 的 toolbarClick 路由保留。
 *
 * 这是 source + model 级回归，不启动宿主、不安装。视觉观感另由装机验收覆盖。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const ENGINE = path.join(ROOT, 'dsh-markpilot');
const EXTRAS = path.join(ENGINE, 'src-cm6/extras.js');

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const name of names) if (name) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.attributes = {};
    this.listeners = Object.create(null);
    this.style = {
      props: Object.create(null),
      setProperty: (key, value) => { this.style.props[key] = String(value); },
      removeProperty: (key) => { delete this.style.props[key]; },
      getPropertyValue: (key) => this.style.props[key] || '',
    };
    this.title = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.type = '';
    this.tabIndex = -1;
    this.clientWidth = 1200;
    this.clientHeight = 800;
  }
  set className(value) { this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.set].join(' '); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child) { child.parentNode = this; this.children.unshift(child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  fire(type, props = {}) {
    const event = { type, target: this, button: 0, detail: 0, key: '', preventDefault() { }, stopPropagation() { }, ...props };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
    return event;
  }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  contains(node) {
    for (let cursor = node; cursor; cursor = cursor.parentNode) if (cursor === this) return true;
    return false;
  }
  getBoundingClientRect() {
    return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight };
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  matches(selector) {
    const text = String(selector || '').trim();
    const withAttr = /^([.#]?[\w-]+)?\[([\w-]+)="([^"]*)"\]$/.exec(text);
    if (withAttr) {
      if (withAttr[1] && withAttr[1].startsWith('.') && !this.classList.contains(withAttr[1].slice(1))) return false;
      const key = withAttr[2].replace(/^data-/, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      return String(this.dataset[key]) === withAttr[3] || this.attributes[withAttr[2]] === withAttr[3];
    }
    if (text.startsWith('.')) return this.classList.contains(text.slice(1));
    if (text.startsWith('#')) return this.attributes.id === text.slice(1);
    return this.tagName === text.toUpperCase();
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function makeDom() {
  const root = new FakeElement('html');
  const body = new FakeElement('body');
  const documentStub = {
    documentElement: root,
    body,
    activeElement: body,
    createElement: (tag) => new FakeElement(tag),
    addEventListener() { },
    removeEventListener() { },
    querySelector() { return null; },
    getElementById() { return null; },
    hasFocus() { return true; },
  };
  return { root, body, documentStub };
}

function installGlobals(dom, windowStub) {
  const previous = {
    window: global.window,
    document: global.document,
    localStorage: global.localStorage,
    getComputedStyle: global.getComputedStyle,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    ResizeObserver: global.ResizeObserver,
    MutationObserver: global.MutationObserver,
  };
  global.window = windowStub;
  global.document = dom.documentStub;
  global.localStorage = { getItem() { return null; }, setItem() { }, removeItem() { } };
  global.getComputedStyle = () => ({
    columnGap: '6px', paddingLeft: '6px', paddingRight: '33px', marginLeft: '0px', marginRight: '0px',
    getPropertyValue() { return ''; },
  });
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => { };
  global.ResizeObserver = class { observe() { } disconnect() { } };
  global.MutationObserver = class { observe() { } disconnect() { } };
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };
}

test('工具岛：只保留编辑/单次动作，脚注 x¹ 占插空行位，创建期零点击副作用', async (t) => {
  const dom = makeDom();
  const calls = [];
  const intents = [];
  const windowStub = {
    addEventListener() { }, removeEventListener() { },
    innerWidth: 1200, innerHeight: 800,
    mpExtras: {
      toolbarClick(id, anchor, opts) {
        calls.push(id);
        intents.push(opts?.keyboard === true);
        return id === 'footnote';
      },
    },
  };
  const restore = installGlobals(dom, windowStub);
  t.after(restore);
  const toolbar = await import(pathToFileURL(path.join(ENGINE, 'src-cm6/toolbar.js')).href);
  const uninstall = toolbar.installToolbar({});
  t.after(() => { try { uninstall(); } catch { /* 已卸载 */ } });

  const bar = dom.body.children.find((el) => el.classList.contains('mp-toolbar'));
  assert.ok(bar, '工具栏应挂到 body');
  const buttons = bar.children.filter((el) => el.classList.contains('mp-tb-item'));
  const ids = buttons.map((el) => el.dataset.mpId);
  assert.equal(new Set(ids).size, ids.length, '按钮 id 不得重复');
  for (const gone of ['insert-before', 'insert-after', 'undo', 'redo']) {
    assert.equal(ids.includes(gone), false, `可见槽位不应再有 ${gone}`);
  }
  for (const gone of ['theme-settings', 'theme-toggle']) {
    assert.equal(ids.includes(gone), false, `持续性偏好/明暗不应常驻岛上：${gone}`);
  }
  assert.equal(ids.includes('footnote'), true, '脚注按钮必须存在');
  assert.equal(ids.indexOf('footnote'), ids.indexOf('inline-code') + 1, '脚注占原先插空行两颗按钮的位置');
  assert.equal(ids.indexOf('upload'), ids.indexOf('footnote') + 1, '脚注与图片之间不再夹其它按钮');

  const footnote = buttons.find((el) => el.dataset.mpId === 'footnote');
  assert.equal(footnote.title, '脚注：插入、跳转或返回');
  assert.equal(footnote.getAttribute('aria-label'), '脚注：插入、跳转或返回');
  assert.equal(footnote.disabled, false);
  const iconPath = /<path d="([^"]+)"/.exec(footnote.innerHTML)?.[1] || '';
  assert.equal((footnote.innerHTML.match(/<svg /g) || []).length, 1, '脚注按钮只用一枚原生 SVG 图标');
  assert.equal((iconPath.match(/M/g) || []).length, 3, 'x¹ = x 两笔 + 上标 1 一笔');
  assert.match(iconPath, /V/, '上标 1 必须有竖向笔画');

  // 【热路径】安装期间不得调用 toolbarClick（它执行用户命令，重开文档会误触）。
  assert.deepEqual(calls, [], 'installToolbar 创建按钮时不得调用 toolbarClick');

  // 鼠标与键盘两条激活路径都必须只路由一次，并带上“是否键盘激活”的来源。
  footnote.fire('mousedown', { button: 0 });
  assert.deepEqual(calls, ['footnote'], '鼠标点击应走到扩展包的脚注命令');
  assert.deepEqual(intents, [false], '鼠标激活不得标记为键盘来源');
  footnote.fire('click', { detail: 0 });
  assert.deepEqual(calls, ['footnote', 'footnote'], '键盘激活同样走到脚注命令');
  assert.deepEqual(intents, [false, true], '键盘激活必须标记来源，供弹层决定是否接焦点');

  // 撤下可见槽位的编辑命令仍在动作表（右键菜单/快捷键/外部调用继续可用）。
  for (const id of ['undo', 'redo', 'insert-before', 'insert-after', 'theme-toggle']) {
    assert.equal(typeof toolbar.TOOLBAR_ACTIONS[id], 'function', `${id} 命令必须保留`);
  }
  assert.equal(ids.includes('document-export'), true, '导出保留唯一岛上入口');
  assert.equal(ids.includes('reading-mode'), true, '阅读模式保留');
  assert.equal(ids.includes('more'), true);
});

const extrasSource = fs.readFileSync(EXTRAS, 'utf8');
const slice = (start, end) => {
  const from = extrasSource.indexOf(start);
  assert.ok(from >= 0, `缺少锚点：${start}`);
  const to = extrasSource.indexOf(end, from + start.length);
  assert.ok(to > from, `缺少结束锚点：${end}`);
  return extrasSource.slice(from, to);
};

test('更多菜单：文档操作 + 唯一编辑器设置 + 帮助/关于，不再有重复入口', () => {
  const openMore = slice('  function openMore(anchor, opts = {}) {', '  function openImageActions(anchor, opts = {}) {');
  assert.match(openMore, /add\('编辑器设置…'/);
  assert.equal((openMore.match(/add\('编辑器设置…'/g) || []).length, 1, '设置入口只能有一个');
  const ordered = ["add('重新加载'", "add('图片操作…'", "add('编辑器设置…'", "add('帮助'", "add('关于'"];
  let cursor = -1;
  for (const token of ordered) {
    const at = openMore.indexOf(token);
    assert.ok(at > cursor, `${token} 的位置/存在性不符合定稿`);
    cursor = at;
  }
  for (const gone of [
    "add('脚注'", "add('导出…'", "add('主题…'", "add('字体…'", "add('页面与缩放…'",
    "add('界面与大纲…'", "add('设置'", "add('快捷键设置…'", "add('阅读配色与排版…'",
    "add(readingOn()",
  ]) {
    assert.equal(openMore.includes(gone), false, `更多菜单不应再有重复入口：${gone}`);
  }
  assert.match(openMore, /setAttribute\('role', 'menu'\)/);
  assert.match(openMore, /bindMenuKeyboard\(p, el\)/);
  assert.match(openMore, /const sep = /);
  assert.equal((openMore.match(/sep\(\);/g) || []).length, 2, '设置组与帮助组各用一条分隔线，不再写小标题');
  assert.equal(openMore.includes("heading('设置')"), false, '单入口的“设置”不再写同名小标题');
  assert.equal(openMore.includes("heading('帮助')"), false, '帮助项不再写重复小标题');
  assert.match(openMore, /if \(opts\.keyboard\) focusFirstMenuItem\(p\)/);
  assert.equal(/^\s*focusFirstMenuItem\(p\);/m.test(openMore), false, '不得无条件抢首项焦点');

  // 「更多」专属密度：只认 mp-pop-more 这个稳定类名，且四条规则齐全（不按结构/文案挑面板）。
  assert.match(openMore, /p\.classList\.add\('mp-pop-more'\)/, '「更多」面板必须挂专属类名');
  assert.match(openMore, /p\.classList\.add\('mp-pop-keep'\)/, '阅读态放行类名仍保留');
  for (const rule of [
    '.mp-pop.mp-pop-more { padding-bottom: 2px; }',
    '.mp-pop.mp-pop-more .mp-pop-title { padding-top: 2px; padding-bottom: 4px; line-height: 1.4; }',
    '.mp-pop.mp-pop-more .mp-pop-item { line-height: 1.45; }',
    '.mp-pop.mp-pop-more .mp-pop-sep { margin: 3px 4px; }',
  ]) {
    assert.equal(extrasSource.includes(rule), true, `缺少「更多」密度规则：${rule}`);
  }
  // 通用口径必须原样保留：证据是「更多」以外的弹层尺寸与本轮改动无关。
  for (const generic of [
    '.mp-pop-item { display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  padding: 5px 10px;',
    '.mp-pop-title { padding: 4px 10px 6px; color: var(--mp-muted); font-size: 12px; }',
    '.mp-pop-sep { height: 1px; background: var(--mp-border); margin: 5px 4px; }',
  ]) {
    assert.equal(extrasSource.includes(generic), true, `通用弹层基准被改动：${generic.slice(0, 24)}`);
  }
  const density = [...extrasSource.matchAll(/^\.mp-pop\.mp-pop-more[^{]*\{[^}]*\}/gm)].map((m) => m[0]);
  assert.equal(density.length, 4, '「更多」密度规则只能是这四条，避免扩散到其它选择器');

  const openPop = slice('  function openPop(anchor, build) {', '  /* ── 快捷键设置');
  assert.match(openPop, /pop\.style\.bottom = 'auto'/, '面板不得同时受 top/bottom 拉伸');
  assert.match(openPop, /pop\.style\.height = 'auto'/, '面板高度必须由内容决定');
  assert.match(openPop, /pop\.style\.maxHeight = Math\.max/, 'max-height 只在落点空间不足时兜底');
  assert.match(extrasSource, /html\[data-mp-statusbar="1"\] \.mp-pop \{ bottom: auto; \}/,
    '状态栏规则不得再把所有 top 定位弹层拉满');

  const imageActions = slice('  function openImageActions(anchor, opts = {}) {', '  function insertText(text) {');
  assert.equal(imageActions.includes("图片保存设置"), false, '图片操作不得重复设置入口');
  assert.equal(imageActions.includes("settingsDialog('images')"), false, '图片设置只在编辑器设置里');
  assert.equal((imageActions.match(/closePop\(\); action\(\)/g) || []).length, 1, '图片操作只剩真正的文档命令');
});

test('编辑器设置：七个域按定稿顺序，阅读配色与快捷键在本页直接可操作', () => {
  const block = /const sections = \[([\s\S]*?)\n    \];/.exec(extrasSource)?.[1] || '';
  const labels = [...block.matchAll(/\['(\w+)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepEqual(labels, ['常规与保存', '主题与字体', '页面', '界面与大纲', '阅读', '图片', '快捷键']);

  assert.match(extrasSource, /name="mp-theme-mode"/, '明暗是主题域内的持久设置');
  assert.match(extrasSource, /id="mp-settings-palette"/, '原有配色列表保留');
  const readingSection = slice("    const readingSec = `<table>`", "    const keysSec");
  assert.match(readingSection, /name="mp-reading-palette"/, '阅读配色必须直接内联在设置页');
  assert.match(readingSection, /READING_PALETTES\.map/, '阅读配色使用原有登记表');
  assert.equal(extrasSource.includes('function readingPaletteDialog('), false, '阅读配色不得再是独立弹层');
  assert.equal(extrasSource.includes('function openTheme('), false, '主题调色不得再是独立弹层');
  assert.match(extrasSource, /const keysSec = `<table id="mp-keys"/, '快捷键表格直接内联在设置页');
  assert.match(extrasSource, /bindShortcutTable\(d\);/, '设置页内直接绑定快捷键录入');
  assert.equal(extrasSource.includes('data-act="keys"'), false, '不再保留“打开快捷键弹层”的中间按钮');
  assert.match(extrasSource, /SETTINGS_SECTION_ALIAS = \{ fonts: 'theme' \}/, '旧 fonts 分区调用仍可用');
});

test('外部契约：旧 toolbarClick id 与脚注快捷键/命令继续可用', () => {
  const command = slice('  function toolbarCommand(id, anchor, opts = {}) {', '  /* 【菜单键盘走位');
  for (const legacy of ['theme-settings', 'theme-toggle', 'surface-settings', 'reading-palette', 'shortcut-settings', 'footnote']) {
    assert.match(command, new RegExp(`case '${legacy}':`), `${legacy} 路由必须保留`);
  }
  assert.match(extrasSource, /footnote: 'Mod-Alt-n'/, '脚注快捷键保留');
  assert.match(extrasSource, /footnote: \(\) => runFootnote\(\)/, '脚注快捷键动作保留');
  assert.match(extrasSource, /快捷键可在「编辑器设置 → 快捷键」里点键位直接改/, '帮助提示同步到新入口');
  assert.equal(extrasSource.includes('更多 → 快捷键设置'), false, '帮助提示不得再指向旧入口');
});
