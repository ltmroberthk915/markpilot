// dsh-markdown-editor-typora 客户端半边：纯逻辑 + 工厂形态测试（不启宿主、不碰 DOM）。
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
  assert.equal(captured.id, 'dsh-markdown-editor-typora');
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
  assert.equal(mod.name, 'dsh-markdown-editor-typora');
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
  assert.equal(def.id, 'dsh-markdown-editor-typora/editor');
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

test('恢复槽键与读写清理（dsh-markdown-editor-typora:recovery:<path>）', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.recoveryKey('D:/docs/a.md'), 'dsh-markdown-editor-typora:recovery:D:/docs/a.md');
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

test('手动保存闸门：无改动给 clean，冲突/缺版本给 block，飞行中排队', async () => {
  const { test: T } = await loadClientFactory();
  assert.deepEqual(plain(T.manualSaveGate({ opened: true, dirty: true, saving: false, conflict: false, baseVersion: 'v1' })), { action: 'save', reason: 'dirty' });
  assert.deepEqual(plain(T.manualSaveGate({ opened: true, dirty: false, saving: false, conflict: false, baseVersion: 'v1' })), { action: 'clean', reason: 'clean' });
  assert.deepEqual(plain(T.manualSaveGate({ opened: true, dirty: true, saving: true, conflict: false, baseVersion: 'v1' })), { action: 'queue', reason: 'saving' });
  assert.equal(T.manualSaveGate({ opened: true, dirty: true, saving: false, conflict: true, baseVersion: 'v1' }).action, 'block');
  assert.equal(T.manualSaveGate({ opened: true, dirty: true, saving: false, conflict: false, baseVersion: '' }).code, 'missing-base-version');
  assert.equal(T.manualSaveGate({ opened: false, dirty: true, saving: false, conflict: false, baseVersion: 'v1' }).action, 'skip');
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
  assert.equal(registered.tabs[0].id, 'dsh-markdown-editor-typora/editor');
  assert.equal(registered.tabs[0].keepMounted, true);
  // 契约是「各座位独立注册、任一失败不影响其他」。
  // 座位数量会随功能增长（tab body / 浮层舞台 / 左栏入口 / main 页 / 设置页），
  // 所以这里按**名字**断言，不锁总数 —— 锁总数会让每加一个座位都要改这个用例。
  const byName = (n) => registered.slots.find((s) => s.definition.name === n);
  const tabSlot = byName('sidebar.right.pane.tab');
  assert.ok(tabSlot, 'tab body 必须注册');
  assert.equal(tabSlot.definition.key, 'dsh-markdown-editor-typora/editor');
  assert.equal(typeof tabSlot.component, 'function');

  const stageSlot = byName('shell.overlay');
  assert.ok(stageSlot, '浮层舞台必须注册');
  assert.equal(stageSlot.definition.id, 'dsh-markdown-editor-typora-stage');
  assert.equal(typeof stageSlot.component, 'function');

  const railSlot = byName('sidebar.panellist');
  assert.ok(railSlot, '左栏入口必须注册');
  assert.equal(railSlot.definition.label, 'Markdown');
  assert.equal(typeof railSlot.component, 'function');

  const mainSlot = byName('main');
  assert.ok(mainSlot, 'main 页面必须注册');
  assert.equal(mainSlot.definition.key, 'dsh-markdown-editor-typora-docs');

  const settingsSlot = byName('settings.section');
  assert.ok(settingsSlot, '设置页 section 必须注册');
  assert.equal(settingsSlot.definition.id, 'dsh-markdown-editor-typora');
  assert.equal(typeof settingsSlot.component, 'function');

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

test('插入对话载荷：开头永远带文档绝对路径，再空一行接选区', async () => {
  const { test: T } = await loadClientFactory();
  const path = String.raw`D:\Users\Ming\Desktop\秋招笔试\新建 Markdown 文档.md`;
  assert.equal(T.composeInsertionText(path, '**选中** 内容'), path + '\n\n**选中** 内容');
  assert.equal(T.composeInsertionText(path, ''), path);
  assert.equal(T.composeInsertionText('  ' + path + '  ', 'x'), path + '\n\nx');
  assert.equal(T.composeInsertionText('', 'x'), 'x');
  assert.equal(T.composeInsertionText(null, 'x'), 'x');
});
test('审阅状态：多组累积、只撤最近一组、审阅中禁止保存', async () => {
  const { test: T } = await loadClientFactory();
  const first = T.mergeReviewGroup(null, 'g-1', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { groups: ['g-1'], count: 2 });
  const second = T.mergeReviewGroup(first, 'g-2', 3);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), { groups: ['g-1', 'g-2'], count: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { groups: ['g-1'], count: 2 }, 'helper must not mutate the previous review');
  assert.equal(T.reviewIsMulti(second), true);
  assert.equal(T.reviewIsMulti(first), false);
  assert.equal(T.reviewUndoGroup(second), 'g-2');
  assert.equal(T.reviewUndoGroup(first), 'g-1');
  assert.equal(T.reviewUndoGroup(null), null);
  assert.equal(T.reviewSuppressesSave({ review: second }), true);
  assert.equal(T.reviewSuppressesSave({ review: null }), false);
  assert.equal(T.reviewSuppressesSave({}), false);
});

test('保存后 stat 版本变化：正文相同才采纳，正文不同仍冲突', async () => {
  const { test: T } = await loadClientFactory();
  const opened = { ok: true, value: { version: 'v2', text: '\uFEFFa\r\nb\r\n' } };
  assert.equal(T.shouldAdoptSavedVersion(opened, 'a\nb\n'), true);
  assert.equal(T.shouldAdoptSavedVersion({ ok: true, value: { version: 'v3', text: 'a\nb\n' } }, 'a\nb\n'), true);
  assert.equal(T.shouldAdoptSavedVersion({ ok: true, value: { version: 'v2', text: 'different' } }, 'a\nb\n'), false);
  assert.equal(T.shouldAdoptSavedVersion({ ok: false }, 'a\nb\n'), false);
  assert.equal(T.normalizeSavedText('\uFEFFx\r\ny'), 'x\ny');
  assert.equal(T.shouldVerifyExternalEvent({ dirty: true, savedAt: 1000 }, 1500), true);
  assert.equal(T.shouldVerifyExternalEvent({ dirty: true, savedAt: 1000 }, 3000), false);
  assert.equal(T.shouldVerifyExternalEvent({ dirty: false, savedAt: 1000 }, 1500), false);
  assert.equal(T.shouldVerifyExternalEvent({}, 3000), false);
  assert.equal(T.externalDiskVerdict('a\nb', 'a\nb', 'saved'), 'same');
  assert.equal(T.externalDiskVerdict('a\nb', 'a\nb + edit', 'a\nb'), 'own-save');
  assert.equal(T.externalDiskVerdict('external', 'a\nb', 'a\nb'), 'conflict');
});

test('审阅态持久化：严格校验路径、基准版本、组 ID 和计数', async () => {
  const { test: T } = await loadClientFactory();
  const g1 = '11111111-1111-4111-8111-111111111111';
  const g2 = '22222222-2222-4222-8222-222222222222';
  const raw = JSON.stringify({ v: 2, pathKey: T.reviewPathKey('D:\\Docs\\A.md'), baseVersion: 'v1', groups: [g1, g2], count: 3, at: 12 });
  const ok = T.normalizeReviewRecord(raw, 'd:/docs/a.md', 'v1');
  assert.equal(JSON.stringify(ok), JSON.stringify({ v: 2, pathKey: 'd:/docs/a.md', baseVersion: 'v1', groups: [g1, g2], count: 3, at: 12 }));
  assert.equal(T.normalizeReviewRecord(JSON.stringify({ ...JSON.parse(raw), v: 1 }), 'D:\\Docs\\A.md', 'v1'), null);
  assert.equal(T.normalizeReviewRecord(raw, 'D:\\Docs\\B.md', 'v1'), null);
  assert.equal(T.normalizeReviewRecord(raw, 'D:\\Docs\\A.md', 'v2'), null);
  assert.equal(T.normalizeReviewRecord('not json', 'D:\\Docs\\A.md', 'v1'), null);
  assert.equal(T.normalizeReviewRecord({ ...JSON.parse(raw), groups: [] }, 'D:\\Docs\\A.md', 'v1'), null);
  assert.equal(T.normalizeReviewRecord({ ...JSON.parse(raw), groups: [g1, g1] }, 'D:\\Docs\\A.md', 'v1'), null);
  assert.equal(T.normalizeReviewRecord({ ...JSON.parse(raw), count: 1 }, 'D:\\Docs\\A.md', 'v1'), null);
  assert.equal(T.reviewStoreKey('D:\\Docs\\A.md'), T.reviewStoreKey('d:/docs/a.md'));
});

test('冲突面板纯函数：默认选择、resolution 形状、应用门槛与审查组去重', async () => {
  const { test: T } = await loadClientFactory();
  const session = {
    hunks: [
      { baseFrom: 1, baseTo: 2, base: 'b', ours: 'o', other: 't' },
      { baseFrom: 4, baseTo: 5, base: 'd', ours: 'p', other: 'u' },
    ],
    clean: false, truncated: true,
  };
  assert.equal(JSON.stringify(T.conflictDefaultChoices(session)), JSON.stringify([
    { index: 0, choice: 'ours', text: '' },
    { index: 1, choice: 'ours', text: '' },
  ]));
  assert.equal(JSON.stringify(T.conflictResolutionsFromChoices([
    { index: 0, choice: 'ours', text: '' },
    { index: 1, choice: 'manual', text: 'M' },
  ])), JSON.stringify([{ choice: 'ours' }, { choice: 'manual', text: 'M' }]));
  assert.equal(T.conflictApplyEnabled(session, T.conflictDefaultChoices(session), false), true);
  assert.equal(T.conflictApplyEnabled(session, T.conflictDefaultChoices(session), true), false);
  assert.equal(T.conflictApplyEnabled(session, [{ index: 0, choice: 'ours', text: '' }], false), false);
  assert.equal(T.conflictApplyEnabled(session, [
    { index: 0, choice: 'manual', text: '' },
    { index: 1, choice: 'ours', text: '' },
  ], false), false);
  assert.equal(T.conflictChoiceLabel('ours'), '用我的');
  assert.equal(T.conflictChoiceLabel('theirs'), '用磁盘');
  assert.equal(T.conflictChoiceLabel('both'), '两边保留');
  assert.equal(T.conflictChoiceLabel('manual'), '手动编辑');
  assert.match(T.conflictTruncatedNotice(session), /较大/);
  assert.equal(T.liveTicketDirty({ version: 3, savedVersion: 1, dirty: false }), true);
  assert.equal(T.liveTicketDirty({ version: 3, savedVersion: 3, dirty: true }), true);
  assert.equal(T.liveTicketDirty({ version: 3, savedVersion: 3, dirty: false }), false);
  const g1 = '11111111-1111-4111-8111-111111111111';
  const g2 = '22222222-2222-4222-8222-222222222222';
  const once = T.mergeReviewGroup(null, g1, 3);
  assert.equal(once.count, 3);
  const duplicate = T.mergeReviewGroup(once, g1, 3);
  assert.equal(duplicate.count, 3, 'the same group must not double-count');
  const second = T.mergeReviewGroup(duplicate, g2, 2);
  assert.equal(second.count, 5);
  assert.equal(JSON.stringify(second.groups), JSON.stringify([g1, g2]));
});

test('P4 client saveErrorKind: missing/conflict/error 三分支', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.saveErrorKind({ code: 'FS_STALE_VERSION', reason: 'missing' }), 'missing');
  assert.equal(T.saveErrorKind({ code: 'MP_FILE_MISSING', message: 'file no longer exists' }), 'missing');
  assert.equal(T.saveErrorKind({ code: 'FS_STALE_VERSION', message: 'changed' }), 'conflict');
  assert.equal(T.saveErrorKind({ code: 'FS_IO_ERROR' }), 'error');
  assert.equal(T.saveErrorKind({ code: 'EACCES' }), 'readonly');
  assert.equal(T.saveErrorKind({ code: 'FS_PERMISSION_DENIED' }), 'readonly');
  assert.equal(T.saveErrorKind({ code: 'MP_FILE_LINKED' }), 'readonly');
  assert.equal(T.saveErrorKind(null), 'error');
});

test('P4 saveAsCandidate preserves .md casing and rejects empty input', async () => {
  const { test: T } = await loadClientFactory();
  assert.match(T.saveAsCandidate('D:/docs/a.MD', 0), /^D:\/docs\/a-恢复-1970-01-01T00-00-00-000Z\.md$/);
  assert.equal(T.saveAsCandidate(''), '');
});
