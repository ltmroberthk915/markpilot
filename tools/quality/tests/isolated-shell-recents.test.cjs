'use strict';
/* 最近文件/跳转列表「测试隔离」回归（source-based，可直接 node --test 运行）。
 * 用 acorn 从现行 MarkPilot-CM6/main.js 提取真实的 mpTestIsolated / mpSetAppUserModelId /
 * pushRecent / clearRecent / mpSyncJumpList 与 APP_USER_MODEL_ID / TEST_APP_USER_MODEL_ID
 * 声明（逐字节切片，不复制实现——同 tools/quality/autosave-liveness-model.cjs 的提取范式），
 * 在 vm 沙箱里以 spy 的 Electron shell 边界（app.addRecentDocument / clearRecentDocuments /
 * setJumpList / setAppUserModelId / commandLine.getSwitchValue）驱动三态：
 *   正常（含正控）：无 MP_TEST_HOOKS ⇒ 正式 AUMID + OS 最近文件/跳转列表照常；
 *   不构成隔离：仅 MP_TEST_HOOKS、仅非空 --user-data-dir、或 hooks+空值 ⇒ 均按正常；
 *   隔离：MP_TEST_HOOKS 且非空 --user-data-dir ⇒ 测试 AUMID，OS 三口零调用，
 *   profile 自身 recents 落盘与菜单/回执保留、跳过回执如实标 skipped。
 * 逐 guard 断言：产品里删掉任一守卫（或谓词任一半）本文件必须变红；
 * 守卫整体从产品移除 ⇒ anchor-missing 直接 fatal。 */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..', '..', '..');                 // 采纳位 tools/quality/tests → 仓根
const acorn = require(path.join(ROOT, 'tools', 'quality', 'node_modules', 'acorn'));
const MAIN = path.join(ROOT, 'MarkPilot-CM6', 'main.js');
const recents = require(path.join(ROOT, 'MarkPilot-CM6', 'shell', 'recents.js'));

const NAMES = ['mpTestIsolated', 'mpSetAppUserModelId', 'pushRecent', 'clearRecent', 'mpSyncJumpList'];
const DECLS = ['APP_USER_MODEL_ID', 'TEST_APP_USER_MODEL_ID'];
const src = fs.readFileSync(MAIN, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true }); // CJS：main.js 顶层有 pdf-worker 早退 return
const found = {};
for (const n of ast.body) {
  if (n.type === 'FunctionDeclaration' && NAMES.includes(n.id.name)) found[n.id.name] = n;
  if (n.type === 'VariableDeclaration' && n.declarations.length === 1) {
    const d = n.declarations[0];
    if (DECLS.includes(d.id.name) && d.init) found[d.id.name] = n;
  }
}
const missing = [...NAMES, ...DECLS].filter(n => !found[n]);
if (missing.length) { console.error(JSON.stringify({ fatal: 'anchor-missing', file: MAIN, missing })); process.exit(3); }
const extracted = [...NAMES, ...DECLS].map(n => src.slice(found[n].start, found[n].end));

/* 沙箱：spy 实际 Electron shell 边界；recents 用真实纯 Node 模块；其余自由名以最小 stub 提供。 */
function makeShell({ mpTestHooks, userDataDir }) {
  const os = { addRecentDocument: [], clearRecentDocuments: 0, setJumpList: 0, aumid: [], dbg: [] };
  const saved = { lists: [], menuBuilds: 0 };
  const ctx = {
    Object, Array, JSON, Number, String, Boolean, Error,
    MP_TEST_HOOKS: mpTestHooks === '1',
    app: {
      commandLine: { getSwitchValue: s => (s === 'user-data-dir' ? userDataDir : '') },
      setAppUserModelId: id => { os.aumid.push(id); },
      addRecentDocument: p => { os.addRecentDocument.push(p); },
      clearRecentDocuments: () => { os.clearRecentDocuments++; },
      setJumpList: () => { os.setJumpList++; return 'ok'; },
      isPackaged: false,
    },
    dbg: (...parts) => { os.dbg.push(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')); },
    state: { settings: { recentFiles: [] } },
    /* recents 模块按设计由壳层注入「文件在不在」的判据（模块头注释明示）；这里沿用该缝
       注入恒真判据，其余口令（normalize/去重/上限/clear/key）全用真实模块本体。 */
    recents: { ...recents, push: (current, filePath, _exists, limit) => recents.push(current, filePath, () => true, limit) },
    RECENT_LIMIT: recents.LIMIT,
    mpSaveRecents: list => { saved.lists.push([...list]); },
    saveSettings: () => ({ ok: true }),
    buildMenu: () => { saved.menuBuilds++; },
    win: null,
  };
  vm.createContext(ctx);
  vm.runInContext(extracted.join('\n'), ctx, { filename: 'main-extract.js' });
  const run = expr => vm.runInContext(expr, ctx);
  const exercise = () => ({
    aumid: run('mpSetAppUserModelId()'),
    addCount: (run('pushRecent("C:\\\\suite\\\\fixture.md")'), os.addRecentDocument.length),
    jump: run('mpSyncJumpList()'),
    clear: run('clearRecent()'),
  });
  return { os, saved, run, exercise };
}

test('normal launch keeps production identity and calls OS recents/jumplist (positive control)', () => {
  const s = makeShell({ mpTestHooks: undefined, userDataDir: '' });
  const r = s.exercise();
  assert.equal(r.aumid, 'app.personal.markpilot.cm6');
  assert.deepEqual(s.os.aumid, ['app.personal.markpilot.cm6']);
  assert.equal(r.addCount, 1);                                   // guard(addRecentDocument) 删除即红
  assert.equal(s.os.setJumpList, 1);                             // guard(setJumpList) 删除即红
  assert.equal(r.jump, 'ok');
  assert.equal(s.os.clearRecentDocuments, 1);                    // guard(clear) 删除即红
  assert.equal(r.clear.ok, true);
  assert.ok(s.saved.lists.length >= 1 && s.saved.menuBuilds >= 2); // profile recents + 菜单保留
});

test('hooks without a private profile stays normal', () => {
  const s = makeShell({ mpTestHooks: '1', userDataDir: '' });
  const r = s.exercise();
  assert.equal(r.aumid, 'app.personal.markpilot.cm6');            // 谓词去掉 MP_TEST_HOOKS 半边即红
  assert.equal(r.addCount, 1);
  assert.equal(s.os.setJumpList, 1);
});

test('private profile without the test flag stays normal', () => {
  const s = makeShell({ mpTestHooks: undefined, userDataDir: 'D:\\some-profile' });
  const r = s.exercise();
  assert.equal(r.aumid, 'app.personal.markpilot.cm6');            // 谓词去掉 getSwitchValue 半边即红
  assert.equal(r.addCount, 1);
  assert.equal(s.os.setJumpList, 1);
});

test('hooks plus an explicitly EMPTY user-data-dir value stays normal', () => {
  const s = makeShell({ mpTestHooks: '1', userDataDir: '' });
  const r = s.exercise();
  assert.equal(r.aumid, 'app.personal.markpilot.cm6');            // !== '' 改为存在性判断即红
  assert.equal(r.addCount, 1);
  assert.equal(s.os.clearRecentDocuments, 1);
});

test('isolated automation window uses the test AUMID and never touches OS lists', () => {
  const s = makeShell({ mpTestHooks: '1', userDataDir: 'D:\\suite-profile-01' });
  const aumid = s.run('mpSetAppUserModelId()');
  s.run('pushRecent("C:\\\\suite\\\\synthetic.md")');
  const jump = s.run('mpSyncJumpList()');
  const clear = s.run('clearRecent()');
  s.run('pushRecent("C:\\\\suite\\\\second.md")');
  assert.equal(aumid, 'app.personal.markpilot.cm6.test');         // AUMID guard 删除即红
  assert.deepEqual(s.os.aumid, ['app.personal.markpilot.cm6.test']);
  assert.equal(s.os.addRecentDocument.length, 0);                 // add guard 删除即红
  assert.equal(s.os.setJumpList, 0);                              // jumplist guard 删除即红
  assert.equal(s.os.clearRecentDocuments, 0);                     // clear guard 删除即红
  assert.equal(jump.skipped, 'test-isolated');                   // 跨 realm 逐字段断言，不比原型
  assert.equal(jump.aumid, 'app.personal.markpilot.cm6.test');
  assert.notEqual(jump, 'ok');                                    // 不伪称系统操作成功
  assert.equal(clear.ok, true);                                   // 真实产品回执保留
  assert.ok(s.saved.lists.length >= 1 && s.saved.menuBuilds >= 3); // profile recents.json + 菜单照常
});
