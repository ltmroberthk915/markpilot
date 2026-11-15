// test/narrow-chat-style.test.mjs — 窄列输入区样式表的热升级契约（无浏览器、无宿主）
//
// 背景（桌面实装复现）：ensureNarrowChatStyle 只要找到同 id 节点就 return，于是
// 已打开的宿主页面在插件热升级后仍跑 0.14 的旧 CSS（旧版把 trailing 强制整行：
// 约 320px 时"上一行 +/权限、下一行靠左模型 + 靠右发送、中间大片空白"）。
//
// 当前契约（简洁版）：
//   1) 首次调用创建节点并写入当前 CSS；
//   2) 同一节点再次调用直接返回 ⇒ 零 DOM 写入（重复 apply/拖动不产生写操作）；
//   3) 已存在的旧节点（0.14，无标记）在同一节点上按文本就地升级一次；
//   4) 节点被删除/重建后重新核对文本（新的旧文本节点也会被升级）；
//   5) 卸载不删除节点：样式全部挂在工作台标记下，旧 controller 无从误删新样式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

let cached = null;
async function getNarrowStyleApi() {
  if (cached) return cached;
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { captured = def; } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, '未捕获到 ModuleLoader 定义');
  const mod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  assert.ok(mod.__test && mod.__test.layout && mod.__test.layout.narrowChatStyle, '__test.layout.narrowChatStyle 未暴露');
  cached = mod.__test.layout.narrowChatStyle;
  return cached;
}

/** 计数用最小 DOM：style 节点记录 textContent 写入、setAttribute、appendChild 次数。 */
function makeDoc() {
  const writes = { text: 0, attr: 0, append: 0 };
  const head = { children: [] };
  head.appendChild = (el) => {
    writes.append += 1;
    el.parentNode = head;
    el._connected = true;
    head.children.push(el);
  };
  function makeStyle() {
    const attrs = new Map();
    let text = '';
    return {
      id: '',
      parentNode: null,
      _connected: false,
      get textContent() { return text; },
      set textContent(v) { writes.text += 1; text = String(v); },
      setAttribute(k, v) { writes.attr += 1; attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      remove() {
        if (this.parentNode) {
          const i = this.parentNode.children.indexOf(this);
          if (i >= 0) this.parentNode.children.splice(i, 1);
          this.parentNode = null;
        }
        this._connected = false;
      },
    };
  }
  const doc = {
    head,
    documentElement: head,
    createElement(tag) {
      assert.equal(tag, 'style');
      return makeStyle();
    },
    getElementById(id) {
      return head.children.find((n) => n.id === id && n._connected) || null;
    },
  };
  return { doc, head, writes };
}

test('首次调用创建样式节点，写入当前 CSS', async () => {
  const api = await getNarrowStyleApi();
  api.resetCache();
  const { doc, head, writes } = makeDoc();
  const st = api.ensure(doc);
  assert.ok(st, '应返回节点');
  assert.equal(head.children.length, 1);
  assert.equal(st.id, 'mp-narrow-chat-style');
  assert.equal(st.textContent, api.css);
  assert.equal(writes.append, 1);
});

test('同一节点重复调用零 DOM 写入（重复打开/拖动不产生额外写）', async () => {
  const api = await getNarrowStyleApi();
  api.resetCache();
  const { doc, head, writes } = makeDoc();
  const st = api.ensure(doc);
  const baseline = { ...writes };
  for (let i = 0; i < 25; i += 1) assert.equal(api.ensure(doc), st);
  assert.deepEqual(writes, baseline, '重复调用不得再写 textContent/setAttribute/appendChild');
  assert.equal(head.children.length, 1, '不得追加第二个节点');
});

test('0.14 的无标记旧样式在同一节点上原地升级（热升级关键路径）', async () => {
  const api = await getNarrowStyleApi();
  api.resetCache();
  const { doc, head, writes } = makeDoc();
  const oldCss = '@container (max-width:320px){[data-mp-narrow-frame] [class*="_trailing"]{flex:1 0 100%}}';
  const old = doc.createElement('style');
  old.id = 'mp-narrow-chat-style';
  old.textContent = oldCss;
  old.setAttribute('data-probe', 'stale-014');
  head.appendChild(old);
  const before = { ...writes };
  const got = api.ensure(doc);
  assert.equal(got, old, '必须是同一个节点（原地升级，不重建）');
  assert.equal(head.children.length, 1, '不得出现重复 id 的两个节点');
  assert.equal(got.textContent, api.css);
  assert.ok(!got.textContent.includes('@container (max-width:320px)'), '旧强制整行规则必须消失');
  assert.equal(got.getAttribute('data-probe'), 'stale-014', '不得清掉节点上已有的其它属性');
  assert.equal(writes.text - before.text, 1, '只允许一次文本写入');
  assert.equal(writes.append - before.append, 0, '不得重新 append');
  assert.equal(writes.attr - before.attr, 0, '升级不需要写任何属性');
  // 升级后再调用：零写入
  const afterUpgrade = { ...writes };
  api.ensure(doc);
  assert.deepEqual(writes, afterUpgrade);
});

test('节点被删除后重新创建；重建的旧文本节点会被重新核对升级', async () => {
  const api = await getNarrowStyleApi();
  api.resetCache();
  const { doc, head } = makeDoc();
  const first = api.ensure(doc);
  first.remove();
  assert.equal(doc.getElementById('mp-narrow-chat-style'), null);
  const second = api.ensure(doc);
  assert.notEqual(second, first);
  assert.equal(second.textContent, api.css);

  // 重建场景：新节点带着旧文本出现（宿主/其它实例重建），必须重新核对并升级。
  second.remove();
  const rebuilt = doc.createElement('style');
  rebuilt.id = 'mp-narrow-chat-style';
  rebuilt.textContent = 'old css';
  head.appendChild(rebuilt);
  const got = api.ensure(doc);
  assert.equal(got, rebuilt, '重新核对的是新节点');
  assert.equal(got.textContent, api.css);
  assert.equal(head.children.length, 1);
});

test('ensure 从不删除节点（没有卸载删除路径，旧 controller 无从误删）', async () => {
  const api = await getNarrowStyleApi();
  api.resetCache();
  const { doc, head } = makeDoc();
  const st = api.ensure(doc);
  for (let i = 0; i < 10; i += 1) api.ensure(doc);
  assert.equal(doc.getElementById('mp-narrow-chat-style'), st);
  assert.equal(head.children.length, 1);
  assert.equal(typeof api.release, 'undefined', '不提供 release API（不需要卸载删除）');
});
