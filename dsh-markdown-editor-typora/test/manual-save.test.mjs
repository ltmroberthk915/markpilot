// dsh-markdown-typora 桥：手动保存宿主面的最小契约测试。
// 运行：node --test test/manual-save.test.mjs
//
// 背景：引擎把 Ctrl+S 绑定到 actions.save，而该动作只认 window.mpHost.__save。
// DSH 皮此前没有定义 window.mpHost，Ctrl+S 被 keymap 吃掉后什么都不发生。
// 本测试只锁桥的宿主面：__save 必须存在、只发一条 manual-save 上行、不覆盖既有宿主。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_FILE = join(HERE, '..', 'renderer-cm6', 'dsh-bridge.js');
const SOURCE = await readFile(BRIDGE_FILE, 'utf8');

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function loadBridge(options = {}) {
  const messages = [];
  const listeners = Object.create(null);
  const storage = fakeStorage(options.storage || {});
  const window = {
    __dshBridgeInstalled: false,
    parent: { postMessage(message) { messages.push(message); } },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    dispatchEvent() { return true; },
  };
  if (options.mpHost !== undefined) window.mpHost = options.mpHost;
  const document = {
    body: null,
    documentElement: { dataset: {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { setAttribute() {}, style: {} }; },
    head: { firstChild: null, insertBefore() {} },
    baseURI: 'http://127.0.0.1/dsh-markdown-typora/renderer-cm6/index.html',
  };
  const location = {
    pathname: '/dsh-markdown-typora/renderer-cm6/index.html',
    href: 'http://127.0.0.1/dsh-markdown-typora/renderer-cm6/index.html',
  };
  const sandbox = {
    window,
    document,
    location,
    localStorage: storage,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    fetch: options.fetch || (() => Promise.reject(new Error('fetch not available in bridge unit test'))),
    AbortController: options.AbortController || class AbortController { abort() {} },
    URL,
    Promise,
    Map,
    Date,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Boolean,
    Error,
    TypeError,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'dsh-bridge.js' });
  return { window, messages, listeners, storage };
}

test('bridge installs window.mpHost.__save and emits one manual-save message', () => {
  const { window, messages } = loadBridge();
  assert.equal(typeof window.mpHost, 'object');
  assert.equal(typeof window.mpHost.__save, 'function');
  const before = messages.length;
  const result = window.mpHost.__save();
  assert.equal(result, true);
  const saves = messages.slice(before).filter((m) => m && m.__dshmd === true && m.dir === 'up' && m.type === 'manual-save');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].content.source, 'ctrl-s');
  assert.equal(typeof saves[0].content.at, 'number');
  // The bridge also announces itself at load; that must not be mistaken for a save.
  assert.equal(messages.some((m) => m && m.type === 'bridge-ready'), true);
});

test('bridge does not overwrite a host that already provides __save', () => {
  const custom = () => 'app-provided';
  const { window, messages } = loadBridge({ mpHost: { __save: custom, keep: 1 } });
  assert.equal(window.mpHost.__save, custom);
  assert.equal(window.mpHost.keep, 1);
  const before = messages.filter((m) => m && m.type === 'manual-save').length;
  window.mpHost.__save();
  const after = messages.filter((m) => m && m.type === 'manual-save').length;
  assert.equal(after, before);
});

test('every __save call is a separate manual-save request (no latency/queue in the bridge)', () => {
  const { window, messages } = loadBridge();
  const before = messages.filter((m) => m && m.type === 'manual-save').length;
  window.mpHost.__save();
  window.mpHost.__save();
  const saves = messages.filter((m) => m && m.type === 'manual-save');
  assert.equal(saves.length, before + 2);
});
