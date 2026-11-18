'use strict';
/* 表格跨选抖动候选（A′：手势冻结有效投影 + 拖动期选中色 + 释放解冻）的模型测试。
 * 从真实 main.js 抽出 sourceTableBlockRange / tableSourceRangeField(desired) /
 * tablePointerFreezeField / tableEffectiveSource / blockHasSelectedText /
 * tablePointerFreezeStyle(facet) / tablePointerFreezeLifecycle，用假 state/事务/事件复现：
 *   - 手势期 effective 不变（R1），desired 照常更新；baseline（无冻结）至少 2 次反转；
 *   - 释放解冻后 effective == desired == 既有精确规则（R3）；
 *   - tint 判据（blockHasSelectedText）闭合端点不含、空选区不选；
 *   - facet 只在真实主键按下时冻结（readOnly/活动格/表级选择/IME tail/多选区不冻结）；
 *   - 解冻微任务的 token 过期保护、mouseup/buttons=0/失焦/组字/可见性收场；
 *   - 静态锚点：desired 字段从未被冻结污染；tint 进 eq/sameGeometry/复用/DOM/CSS。
 * 运行：node <此文件>（需要 acorn；从 tools/quality 跑可解析其 node_modules） */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), test = require('node:test');
const acorn = require('acorn');

const MAIN = process.env.MP_MAIN_JS || path.resolve(__dirname, '../../../dsh-markpilot/src-cm6/main.js');
const source = fs.readFileSync(MAIN, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function fnCode(name) {
  const n = ast.body.find(x => x.type === 'FunctionDeclaration' && x.id.name === name);
  assert(n, 'missing function ' + name); return source.slice(n.start, n.end);
}
function declCode(name) {
  const n = ast.body.find(x => x.type === 'VariableDeclaration' && x.declarations.some(d => d.id.name === name));
  assert(n, 'missing declaration ' + name); return source.slice(n.start, n.end);
}

const F = { active: {}, tableSel: {}, tables: {}, imeTail: {}, src: {}, freeze: {} };
const holdEffect = { of: v => ({ __freeze: true, value: v, is: e => e === holdEffect }) };
holdEffect.is = e => e === holdEffect;
const effect = holdEffect;

const scope = {
  activeCellField: F.active, tableSelectionField: F.tableSel, tableDataField: F.tables,
  tableImeTailField: F.imeTail, tableSourceRangeField: F.src, tablePointerFreezeField: F.freeze,
  setTablePointerFreeze: effect, StateField: { define: c => c }, StateEffect: { define: () => effect },
  Transaction: { addToHistory: { of: () => null } }, ViewPlugin: { fromClass: c => c },
  EditorView: { mouseSelectionStyle: { of: fn => fn } }, window: null,
};
const api = Function('scope', 'with(scope){' + fnCode('sourceTableBlockRange') + '\n' +
  declCode('tableSourceRangeField') + '\n' +
  declCode('tablePointerFreezeField') + '\n' +
  declCode('tableFreezeToken') + '\n' +
  fnCode('tableEffectiveSource') + '\n' +
  fnCode('blockHasSelectedText') + '\n' +
  declCode('tablePointerFreezeStyle') + '\n' +
  declCode('tablePointerFreezeLifecycle') + '\n' +
  'return {sourceTableBlockRange, tableSourceRangeField, tablePointerFreezeField, tableEffectiveSource, blockHasSelectedText, tablePointerFreezeStyle, tablePointerFreezeLifecycle};}')(scope);
F.src = api.tableSourceRangeField; F.freeze = api.tablePointerFreezeField;
const desiredCfg = api.tableSourceRangeField, freezeCfg = api.tablePointerFreezeField;

function tablesOne() {
  return [{ from: 1000, to: 1080, headerBlock: { from: 1000, to: 1010 },
    rows: [{ from: 1011, to: 1020 }, { from: 1021, to: 1030 }, { from: 1031, to: 1040 }, { from: 1041, to: 1080 }] }];
}
function stateOf({ from, to, ranges, active = null, tableSel = null, imeTail = null, desired = null,
  frozen = null, readOnly = false, tables = tablesOne() }) {
  return {
    readOnly, selection: { main: { from, to }, ranges: ranges || [{ from, to }] },
    field(field, required) {
      if (required) throw new Error('unexpected unguarded field read');
      if (field === F.active) return active;
      if (field === F.tableSel) return tableSel;
      if (field === F.tables) return tables;
      if (field === F.imeTail) return imeTail;
      if (field === F.src) return desired;
      if (field === F.freeze) return frozen;
      return null;
    },
  };
}
function pointerTx(start, next) {
  return { docChanged: false, selection: next.selection, startState: start, state: next, effects: [] };
}
function freezeTx(start, next, value) {
  return { docChanged: false, selection: null, startState: start, state: next, effects: [effect.of(value)] };
}

/* ── R1：反向拖入末行的 selection 序列（与真实副本同形状） ─────────────── */
const SEQ = [{ from: 1080, to: 1090 }, { from: 1081, to: 1090 }, { from: 1080, to: 1090 }, { from: 1031, to: 1090 }];
function baselineToggles() {
  let value = null, toggles = 0, prev = stateOf({ from: 1090, to: 1090 });
  for (const sel of SEQ) {
    const next = stateOf({ ...sel });
    const v = desiredCfg.update(value, pointerTx(prev, next));
    if ((v === null) !== (value === null)) toggles++;
    else if (v && value && (v.from !== value.from || v.to !== value.to)) toggles++;
    value = v; prev = next;
  }
  return toggles;
}
test('R1 baseline (no freeze) toggles the source projection, so the arm discriminates', () => {
  assert.ok(baselineToggles() >= 2, 'desired field must show the old reversal');
});

test('R1 freeze keeps effective identical across the whole drag while desired keeps moving', () => {
  const baseline = { token: 7, range: null };    // 手势从“全渲染”开始
  let desired = null, effectiveSeen = new Set();
  let prev = stateOf({ from: 1090, to: 1090, frozen: baseline });
  for (const sel of SEQ) {
    const next = stateOf({ ...sel, frozen: baseline });
    desired = desiredCfg.update(desired, pointerTx(prev, next));   // desired 照常更新（不冻结）
    effectiveSeen.add(api.tableEffectiveSource(next));
    prev = next;
  }
  assert.equal(effectiveSeen.size, 1, 'effective must stay one value during the gesture');
  assert.equal([...effectiveSeen][0], null, 'gesture started with no revealed rows');
  assert.notEqual(desired, null, 'desired did move (the final selection covers the last row)');
});

test('R3 release: effective falls back to exactly the existing sourceTableBlockRange', () => {
  const start = stateOf({ from: 1031, to: 1090, frozen: { token: 8, range: { from: 1031, to: 1040 } } });
  const desired = desiredCfg.update(null, pointerTx(stateOf({ from: 1090, to: 1090 }), start));
  assert.deepEqual({ from: desired.from, to: desired.to }, { from: 1031, to: 1080 });
  const released = stateOf({ from: 1031, to: 1090, frozen: null, desired });
  assert.deepEqual(api.tableEffectiveSource(released), desired, 'after unfreeze effective == desired');
  const fieldAfter = freezeCfg.update({ token: 8, range: null }, freezeTx(start, released, null));
  assert.equal(fieldAfter, null, 'unfreeze effect clears the field');
});

test('desired selection is not mutated by freeze; cross-table coverage unchanged', () => {
  const tables = [
    { from: 1000, to: 1040, headerBlock: { from: 1000, to: 1010 }, rows: [{ from: 1011, to: 1020 }, { from: 1021, to: 1040 }] },
    { from: 2000, to: 2080, headerBlock: { from: 2000, to: 2010 }, rows: [{ from: 2011, to: 2020 }, { from: 2021, to: 2080 }] },
  ];
  const st = stateOf({ from: 1015, to: 2050, tables });
  const exact = desiredCfg.create(st);
  assert.deepEqual({ from: exact.from, to: exact.to }, { from: 1011, to: 2080 });
  const frozen = stateOf({ from: 1015, to: 2050, tables, frozen: { token: 1, range: exact } });
  assert.equal(api.tableEffectiveSource(frozen), exact);
  assert.equal(st.selection.main.from, 1015, 'selection untouched');
});

/* ── tint 判据（闭合端点不含；空选区不选） ─────────────────────────────── */
test('tint covers only blocks with at least one selected character', () => {
  const block = { from: 1031, to: 1040 };
  assert.equal(api.blockHasSelectedText(stateOf({ from: 1040, to: 1090 }), block), false, 'endpoint only is not a selected character');
  assert.equal(api.blockHasSelectedText(stateOf({ from: 1031, to: 1031 }), block), false, 'empty selection never tints');
  assert.equal(api.blockHasSelectedText(stateOf({ from: 1039, to: 1050 }), block), true, 'one character inside');
  assert.equal(api.blockHasSelectedText(stateOf({ from: 1020, to: 1032 }), block), true, 'crossing from the left');
  assert.equal(api.blockHasSelectedText(stateOf({ from: 1039, to: 1040 }), block), true, 'last character of the block');
});

test('end-to-end: the facet freeze holds effective through the drag and release restores desired', () => {
  const first = facetOwner(stateOf({ from: 1090, to: 1090 }));
  api.tablePointerFreezeStyle(first.owner, { button: 0 });
  assert.equal(first.dispatches.length, 1, 'real primary press must dispatch the freeze');
  const frozenTx = { docChanged: false, selection: null, startState: stateOf({ from: 1090, to: 1090 }), state: stateOf({ from: 1090, to: 1090 }), effects: [first.dispatches[0].effects] };
  let frozen = freezeCfg.update(null, frozenTx);
  assert.ok(frozen && frozen.range === null, 'freeze snapshots the pre-gesture desired value');
  let desired = null, seen = new Set(), prev = stateOf({ from: 1090, to: 1090, frozen });
  for (const sel of SEQ) {
    const next = stateOf({ ...sel, frozen });
    const tx = pointerTx(prev, next);
    frozen = freezeCfg.update(frozen, tx);
    desired = desiredCfg.update(desired, tx);
    seen.add(api.tableEffectiveSource(next));
    prev = next;
  }
  assert.equal(seen.size, 1, 'one effective value for the whole gesture');
  assert.equal(frozen.range, null, 'freeze keeps the snapshot range');
  assert.notEqual(desired, null, 'desired moved to cover the last row');
  const released = stateOf({ from: 1031, to: 1090, frozen: null, desired });
  assert.equal(freezeCfg.update(frozen, freezeTx(prev, released, null)), null);
  assert.deepEqual(api.tableEffectiveSource(released), desired, 'release shows the existing precise range');
});
/* ── 冻结字段守卫 ───────────────────────────────────────────────────────── */
test('freeze field drops on doc change/read-only and whenever a guard appears', () => {
  const base = { readOnly: false, selection: { ranges: [1] }, field: () => null };
  const frozen = { token: 3, range: null };
  const on = freezeCfg.update(null, freezeTx(base, base, frozen));
  assert.equal(on, frozen);
  for (const [state, why] of [
    [{ readOnly: true, selection: { ranges: [1] }, field: () => null }, 'read-only'],
    [{ readOnly: false, selection: { ranges: [1] }, field: f => f === F.active ? { rowFrom: 1041 } : null }, 'active cell'],
    [{ readOnly: false, selection: { ranges: [1] }, field: f => f === F.tableSel ? { kind: 'row' } : null }, 'table selection'],
    [{ readOnly: false, selection: { ranges: [1] }, field: f => f === F.imeTail ? { from: 1 } : null }, 'IME tail'],
    [{ readOnly: false, selection: { ranges: [{}, {}] }, field: () => null }, 'multi-range'],
  ]) {
    assert.equal(freezeCfg.update(frozen, { effects: [], docChanged: false, state }), null, why);
  }
  assert.equal(freezeCfg.update(frozen, { effects: [], docChanged: true, state: base }), null, 'doc change');
});

/* ── facet 入口 ─────────────────────────────────────────────────────────── */
function facetOwner(state) {
  const dispatches = [];
  return { owner: { state, dispatch: spec => dispatches.push(spec) }, dispatches };
}
test('facet freezes before the first selection dispatch and only for a real primary press', () => {
  const st = stateOf({ from: 1090, to: 1090 });
  const a = facetOwner(st);
  assert.equal(api.tablePointerFreezeStyle(a.owner, { button: 0 }), null, 'falls through to the normal selection style');
  assert.equal(a.dispatches.length, 1);
  const spec = a.dispatches[0];
  assert.equal(spec.effects.value.range, null, 'freeze snapshots desired (null at start)');
  assert.equal(spec.effects.value.token > 0, true);
  // 第二次冻结 token 必须单调增长
  api.tablePointerFreezeStyle(a.owner, { button: 0 });
  assert.ok(a.dispatches[1].effects.value.token > spec.effects.value.token, 'token monotonic');
  // 守卫与修饰键路径
  for (const state of [
    stateOf({ from: 1090, to: 1090, readOnly: true }),
    stateOf({ from: 1090, to: 1090, active: { rowFrom: 1041 } }),
    stateOf({ from: 1090, to: 1090, tableSel: { kind: 'row' } }),
    stateOf({ from: 1090, to: 1090, imeTail: { from: 1 } }),
    stateOf({ from: 1090, to: 1090, ranges: [{ from: 1, to: 1 }, { from: 2, to: 2 }] }),
  ]) {
    const o = facetOwner(state);
    assert.equal(api.tablePointerFreezeStyle(o.owner, { button: 0 }), null);
    assert.equal(o.dispatches.length, 0, 'guarded state must not freeze');
  }
  const right = facetOwner(st);
  assert.equal(api.tablePointerFreezeStyle(right.owner, { button: 2 }), null);
  assert.equal(right.dispatches.length, 0, 'secondary button never freezes');
});

/* ── 解冻生命周期 ───────────────────────────────────────────────────────── */
function makeDom() {
  const removed = [];
  const docMap = new Map(), winMap = new Map();
  const add = (prefix, list) => (type, fn, capture) => list.set(prefix + ':' + type + ':' + !!capture, fn);
  const del = prefix => (type, fn, capture) => removed.push(prefix + ':' + type + ':' + !!capture);
  const doc = { visibilityState: 'visible', addEventListener: add('doc', docMap), removeEventListener: del('doc') };
  const win = { addEventListener: add('win', winMap), removeEventListener: del('win') };
  return { doc, win, docMap, winMap, removed };
}
function lifecycleClass(win) {
  const sc = Object.assign({}, scope, { window: win });
  return Function('scope', 'with(scope){' + declCode('tablePointerFreezeLifecycle') + '\nreturn {C: tablePointerFreezeLifecycle};}')(sc).C;
}
function lifecycleOwner(holdRef) {
  const dispatches = [];
  const D = makeDom();
  const owner = { state: { field: () => holdRef.value }, dom: { isConnected: true, ownerDocument: D.doc },
    dispatch: spec => { dispatches.push(spec); for (const e of [].concat(spec.effects || [])) if (e.__freeze) holdRef.value = e.value; } };
  return { owner, D, dispatches };
}
test('lifecycle unfreezes in a microtask, is token-safe, and covers every termination event', async () => {
  const holdRef = { value: { token: 5, range: null } };
  const { owner, D, dispatches } = lifecycleOwner(holdRef);
  const plugin = new (lifecycleClass(D.win))(owner);
  const keys = [...D.docMap.keys()].join(',');
  for (const type of ['mouseup', 'pointercancel', 'contextmenu', 'compositionstart', 'mousemove', 'visibilitychange']) {
    assert.match(keys, new RegExp('doc:' + type + ':true'), type);
  }
  assert.ok(D.winMap.get('win:blur:false'), 'window blur capture');
  assert.equal([...D.docMap.keys()].some(k => k.startsWith('doc:keydown')), false, 'Escape must NOT end the gesture');
  // 微任务：token 校验通过才清
  plugin.release();
  assert.equal(dispatches.length, 0, 'release is deferred to a microtask');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(holdRef.value, null, 'released');
  assert.equal(dispatches.length, 1);
  // token 过期保护：旧手势的微任务不得清掉新冻结
  holdRef.value = { token: 9, range: null };
  plugin.release();
  holdRef.value = { token: 10, range: null };
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(holdRef.value, { token: 10, range: null }, 'stale token must not unfreeze the new gesture');
  // buttons===0 的 mousemove 兜底
  holdRef.value = { token: 10, range: null };
  plugin.move({ isTrusted: true, buttons: 0 });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(holdRef.value, null, 'missed mouseup recovers on buttons=0');
  plugin.move({ isTrusted: true, buttons: 1 });
  assert.equal(holdRef.value, null);
  holdRef.value = { token: 11, range: null };
  D.doc.visibilityState = "hidden";
  plugin.visibility();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(holdRef.value, null, 'hidden document ends the gesture');
  plugin.destroy();
  assert.ok(D.removed.includes('doc:mouseup:true'));
  assert.ok(D.removed.includes('win:blur:false'));
});

/* ── 静态锚点：desired 不被污染；effective 覆盖所有消费者；tint 三处同步 ── */
test('desired field is not frozen; every visible consumer reads effective; tint is wired through reuse', () => {
  const desiredDecl = declCode('tableSourceRangeField');
  assert.doesNotMatch(desiredDecl, /tablePointerFreeze/, 'desired must keep today semantics');
  assert.match(source, /const source = tableEffectiveSource\(state\);/);
  assert.match(source, /const tableSource = tableEffectiveSource\(state\);/);
  assert.match(source, /tableSource = tableEffectiveSource\(view\.state\)/);
  assert.match(source, /const value = tableEffectiveSource\(view\.state\);/);
  assert.ok(source.indexOf('        tablePointerFreezeStyle,') < source.indexOf('        floatingSelectionStyle,'),
    'freeze facet must precede floatingSelectionStyle');
  assert.match(source, /tablePointerFreezeField, \/\/ 手势期冻结值/);
  assert.match(source, /tablePointerFreezeLifecycle, \/\/ 手势解冻/);
  assert.match(source, /__tableProjection: \(\) =>/);
  // 错-11：tint 必须进 eq / sameGeometry / 复用 DOM 复核 / toDOM / CSS
  assert.match(source, /if \(!!other\.srcSel !== !!this\.srcSel\) return false;/);
  assert.match(source, /a\.widths\.length === b\.widths\.length && !!a\.srcSel === !!b\.srcSel/);
  assert.match(source, /tr\.classList\.contains\("mp-src-sel"\) !== !!previous\.srcSel/);
  assert.match(source, /tr\.classList\.toggle\("mp-src-sel", !!this\.srcSel\)/);
  assert.match(source, /tr\.mp-src-sel > th, table\.mp-row tr\.mp-src-sel > td/);
});
