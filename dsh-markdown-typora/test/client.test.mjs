// dsh-markdown-typora 客户端半边：纯逻辑 + 工厂形态测试（不启宿主、不碰 DOM）。
// 运行：node --test test/client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

/** 在 vm 沙箱里执行 loader 形态的 client.js，捕获 factory 并取出 __test 纯函数。 */
async function loadClientFactory() {
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) { captured = definition; },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'window.__ModuleLoader__.load was not called');
  assert.equal(captured.id, 'dsh-markdown-typora');
  assert.equal(typeof captured.factory, 'function');
  const mod = captured.factory((name) => {
    if (name === 'react') return null; // 纯函数测试不需要 React
    throw new Error('unexpected require: ' + name);
  });
  assert.ok(mod.__test, 'factory must expose __test helpers');
  return { definition: captured, mod, test: mod.__test };
}

/** vm 子 realm 里创建的对象/数组原型不同，deepEqual 前统一转成本 realm 的普通值。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeStorage() {  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    key(index) { return Array.from(map.keys())[index] ?? null; },
    get length() { return map.size; },
    _map: map,
  };
}

test('loader 形态与导出纪律', async () => {
  const { mod } = await loadClientFactory();
  assert.equal(mod.name, 'dsh-markdown-typora');
  assert.ok(Array.isArray(mod.inject));
  assert.ok(mod.inject.includes('slots'));
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.__test, 'object');
});

test('文件地址解析：session / absolute / 编码 / 非法', async () => {
  const { test: T } = await loadClientFactory();
  const session = T.parseFileAddress('dsh-resource://file/session/s-1/D%3A/docs/a%20b.md');
  assert.deepEqual(plain(session), { scope: 'session', sessionId: 's-1', path: 'D:/docs/a b.md' });
  const absolute = T.parseFileAddress('dsh-resource://file/absolute/C%3A/docs/x.md');
  assert.deepEqual(plain(absolute), { scope: 'absolute', path: 'C:/docs/x.md' });
  const posix = T.parseFileAddress('dsh-resource://file/absolute/home/me/x.md');
  assert.deepEqual(plain(posix), { scope: 'absolute', path: '/home/me/x.md' });
  const withQuery = T.parseFileAddress('dsh-resource://file/session/s/p.md?line=12#frag');
  assert.equal(withQuery.path, 'p.md');
  assert.equal(T.parseFileAddress('file:///tmp/a.md'), undefined);
  assert.equal(T.parseFileAddress('dsh-resource://file/session/s-1'), undefined);
  assert.equal(T.parseFileAddress('dsh-resource://file/session//x.md'), undefined);
  assert.equal(T.parseFileAddress('dsh-resource://file/session/s/%E0%A4%A'), undefined);
  assert.equal(T.parseFileAddress(null), undefined);
});

test('tab 类型定义：id / patterns / priority / keepMounted / canOpen', async () => {
  const { test: T } = await loadClientFactory();
  const def = T.buildTabDefinition();
  assert.equal(def.id, 'dsh-markdown-typora/editor');
  assert.deepEqual(plain(def.patterns), ['*.md', '*.markdown']);
  assert.equal(def.priority, 'extension');
  assert.equal(def.keepMounted, true);
  assert.equal(def.canOpen('dsh-resource://file/session/s/a.md'), true);
  assert.equal(def.canOpen('dsh-resource://file/absolute/C%3A/a.md'), true);
  assert.equal(def.canOpen('dsh-resource://terminal/1'), false);
  assert.equal(def.canOpen(undefined), false);
  assert.equal(def.title('dsh-resource://file/session/s/dir/My%20Note.md'), 'My Note.md');
  assert.equal(def.title('not-an-address'), 'Markdown');
});

test('恢复槽键与读写清理（dsh-markdown-typora:recovery:<path>）', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.recoveryKey('D:/docs/a.md'), 'dsh-markdown-typora:recovery:D:/docs/a.md');
  const storage = fakeStorage();
  const slot = { text: '未保存内容', baseVersion: 'v1', ts: 1700000000000, path: 'D:/docs/a.md' };
  assert.equal(T.writeRecoverySlot(storage, slot), true);
  assert.deepEqual(plain(T.readRecoverySlot(storage, 'D:/docs/a.md')), slot);
  // path 不一致的槽不得被认领（防串文档）
  assert.equal(T.readRecoverySlot(storage, 'D:/docs/b.md'), null);
  T.clearRecoverySlot(storage, 'D:/docs/a.md');
  assert.equal(T.readRecoverySlot(storage, 'D:/docs/a.md'), null);
  // 坏 JSON / 超大文本不得抛
  storage.setItem(T.recoveryKey('D:/docs/c.md'), '{not json');
  assert.equal(T.readRecoverySlot(storage, 'D:/docs/c.md'), null);
  assert.equal(T.writeRecoverySlot(storage, { text: 'x'.repeat(600 * 1024), path: 'D:/docs/d.md' }), false);
});

test('代际票：sessionId+path+generation 全等才算当前，旧回执被拒收', async () => {
  const { test: T } = await loadClientFactory();
  const current = T.ticketOf('s1', 'D:/docs/a.md', 7);
  assert.equal(T.isCurrentTicket(T.ticketOf('s1', 'D:/docs/a.md', 7), current), true);
  assert.equal(T.isCurrentTicket(T.ticketOf('s1', 'D:/docs/a.md', 6), current), false, '旧代际必须拒收');
  assert.equal(T.isCurrentTicket(T.ticketOf('s1', 'D:/docs/b.md', 7), current), false, 'path 变了必须拒收');
  assert.equal(T.isCurrentTicket(T.ticketOf('s2', 'D:/docs/a.md', 7), current), false, 'session 变了必须拒收');
  assert.equal(T.isCurrentTicket(null, current), false);
  // Windows 路径分隔符/大小写等价
  assert.equal(T.isCurrentTicket(T.ticketOf('s1', 'd:\\docs\\A.MD', 7), current), true);
});

test('保存闸门：串行排队 / 缺 baseVersion 拒绝 / 干净跳过', async () => {
  const { test: T } = await loadClientFactory();
  assert.deepEqual(plain(T.saveGate({ opened: true, dirty: true, saving: false, baseVersion: 'v1' })), { action: 'save', reason: 'dirty' });
  assert.deepEqual(plain(T.saveGate({ opened: true, dirty: true, saving: true, baseVersion: 'v1' })), { action: 'queue', reason: 'saving' });
  assert.equal(T.saveGate({ opened: true, dirty: true, saving: false, baseVersion: '' }).action, 'block');
  assert.equal(T.saveGate({ opened: true, dirty: true, saving: false, baseVersion: null }).code, 'missing-base-version');
  assert.equal(T.saveGate({ opened: true, dirty: false, saving: false, baseVersion: 'v1' }).action, 'skip');
  assert.equal(T.saveGate({ opened: false, dirty: true, saving: false, baseVersion: 'v1' }).action, 'skip');
  assert.equal(T.saveGate({ opened: true, dirty: true, saving: false, baseVersion: 'v1', dead: true }).action, 'skip');
});

test('保存请求体：所有 save 必带 baseVersion（含关 tab flush 形态）', async () => {
  const { test: T } = await loadClientFactory();
  const ok = T.buildSaveRequest({ path: 'D:/docs/a.md', text: 'x', baseVersion: 'v9' });
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(Object.keys(ok.body).sort()), ['baseVersion', 'path', 'text']);
  assert.equal(ok.body.baseVersion, 'v9');
  const missing = T.buildSaveRequest({ path: 'D:/docs/a.md', text: 'x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-base-version');
  assert.equal(T.buildSaveRequest({ path: '', text: 'x', baseVersion: 'v1' }).ok, false);
  assert.equal(T.buildSaveRequest({ path: 'p', text: null, baseVersion: 'v1' }).ok, false);
  // 穷举：任何不带 baseVersion 的组合都不能产生可发送请求
  for (const base of [undefined, null, '', 0, false]) {
    assert.equal(T.buildSaveRequest({ path: 'D:/x.md', text: 'y', baseVersion: base }).ok, false, String(base));
  }
});

test('外部变更策略：干净才覆盖，脏/冲突/隐藏/后台只提示', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.shouldAcceptExternal({ dirty: false, conflict: false, saving: false, hidden: false, visible: true }), true);
  assert.equal(T.shouldAcceptExternal({ dirty: true }), false);
  assert.equal(T.shouldAcceptExternal({ conflict: true }), false);
  assert.equal(T.shouldAcceptExternal({ saving: true }), false);
  assert.equal(T.shouldAcceptExternal({ hidden: true }), false);
  assert.equal(T.shouldAcceptExternal({ visible: false }), false);
});

test('轮询降级：健康/隐藏不调度；断开 2s，连续失败降到 6s', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.nextPollDelay({ healthy: true, failures: 0, hidden: false }), null);
  assert.equal(T.nextPollDelay({ healthy: false, failures: 0, hidden: true }), null);
  assert.equal(T.nextPollDelay({ healthy: false, failures: 0, hidden: false }), 2000);
  assert.equal(T.nextPollDelay({ healthy: false, failures: 2, hidden: false }), 2000);
  assert.equal(T.nextPollDelay({ healthy: false, failures: 3, hidden: false }), 6000);
  assert.equal(T.nextPollDelay({ healthy: false, failures: 99, hidden: false }), 6000);
});

test('选中文段插入：重 capture 重试一次 / 剪贴板兜底 / props 缺失', async () => {
  const { test: T } = await loadClientFactory();
  const inserted = [];
  let captures = 0;
  const flaky = {
    captureInsertion() { captures += 1; return { draftRev: captures }; },
    insertText(text, span) {
      inserted.push({ text, rev: span.draftRev });
      return span.draftRev === 2; // 第一次因版本变了被拒，重 capture 后成功
    },
  };
  const first = await T.insertSelectionToChat(flaky, '## 选中源码', {});
  assert.equal(first.ok, true);
  assert.equal(first.method, 'insert');
  assert.equal(first.attempts, 2);
  assert.equal(captures, 2);
  assert.deepEqual(inserted[1], { text: '## 选中源码', rev: 2 });

  // 两次都被拒 → 剪贴板兜底，并通知
  const notifications = [];
  const rejected = {
    captureInsertion() { return { draftRev: 1 }; },
    insertText() { return false; },
  };
  const clipboardWrites = [];
  const second = await T.insertSelectionToChat(rejected, 'x', {
    clipboard: { writeText: async (text) => { clipboardWrites.push(text); } },
    notify: (kind, info) => notifications.push({ kind, info }),
  });
  assert.equal(second.ok, false);
  assert.equal(second.method, 'clipboard');
  assert.equal(second.reason, 'insert-rejected');
  assert.deepEqual(clipboardWrites, ['x']);
  assert.equal(notifications[0].kind, 'copied');

  // props 缺失（inputActions undefined）→ 直接剪贴板
  const third = await T.insertSelectionToChat(undefined, 'y', {
    clipboard: { writeText: async () => {} },
  });
  assert.equal(third.method, 'clipboard');
  assert.equal(third.reason, 'missing-input-actions');

  // 剪贴板也失败 → 不抛异常，返回 clipboard-failed
  const fourth = await T.insertSelectionToChat(undefined, 'z', {
    clipboard: { writeText: async () => { throw new Error('denied'); } },
  });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.method, 'clipboard-failed');
  assert.match(fourth.error, /denied/);

  // 空文本 no-op
  const empty = await T.insertSelectionToChat(flaky, '', {});
  assert.equal(empty.method, 'none');
});

test('apply 防御性：tab 类型 + tab body 各自注册，服务缺失不抛', async () => {
  const { mod } = await loadClientFactory();
  const registered = { tabs: [], slots: [], effects: [] };
  const ctx = {
    slots: {
      inject(name, cb) { registered.effects.push(name); return cb(); },
      register(definition, component) {
        registered.slots.push({ definition, component });
        return () => {};
      },
    },
    get(name) {
      if (name === 'sidebarRightTabs') {
        return {
          register(definition) {
            registered.tabs.push(definition);
            return () => {};
          },
        };
      }
      return undefined;
    },
    effect(fn, label) {
      const dispose = fn();
      registered.effects.push(label);
      return dispose;
    },
    inject() { /* 测试不模拟服务晚到 */ },
    logger() { return { info() {}, warn() {} }; },
  };
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.equal(registered.tabs.length, 1);
  assert.equal(registered.tabs[0].id, 'dsh-markdown-typora/editor');
  assert.equal(registered.tabs[0].keepMounted, true);
  assert.equal(registered.slots.length, 1);
  assert.equal(registered.slots[0].definition.name, 'sidebar.right.pane.tab');
  assert.equal(registered.slots[0].definition.key, 'dsh-markdown-typora/editor');
  assert.equal(typeof registered.slots[0].component, 'function');

  // 极简 ctx（没有 sidebarRightTabs / inject）也不能抛
  assert.doesNotThrow(() => mod.apply({ slots: { inject(name, cb) { return cb(); }, register() { return () => {}; } }, effect(fn) { return fn(); } }));
});

test('上行信封：__dshmd（桥）与 __dshmp（引擎直发）都接受，down/非法拒绝', async () => {
  const { test: T } = await loadClientFactory();
  // 插件桥的三种上行
  assert.equal(T.isUpEnvelope({ __dshmd: true, dir: 'up', type: 'bridge-ready' }), true);
  assert.equal(T.isUpEnvelope({ __dshmd: true, dir: 'up', type: 'insert-to-chat', content: { text: 'x' } }), true);
  // 引擎自身 shell 通道的两种上行（3.6.2 起就是这样 post 的；漏判会让脏标/回执全丢）
  assert.equal(T.isUpEnvelope({ __dshmp: true, dir: 'up', type: 'change', content: { len: 12, epoch: 1, sourceRevision: 1 } }), true);
  assert.equal(T.isUpEnvelope({ __dshmp: true, dir: 'up', type: 'text', content: 'abc' }), true);
  // 下行与非法形态一律拒绝
  assert.equal(T.isUpEnvelope({ __dshmd: true, dir: 'down', type: 'theme' }), false);
  assert.equal(T.isUpEnvelope({ dir: 'up', type: 'change' }), false);
  assert.equal(T.isUpEnvelope({ __dshmd: 'yes', dir: 'up' }), false);
  assert.equal(T.isUpEnvelope({ __dshmd: true }), false);
  assert.equal(T.isUpEnvelope(null), false);
  assert.equal(T.isUpEnvelope(undefined), false);
});
