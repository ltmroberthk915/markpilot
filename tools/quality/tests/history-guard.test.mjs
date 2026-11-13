// history-guard 纯模型测试（node --test；无 DOM / GUI / 服务 / 私有路径）。
// 在公开仓的位置：tools/quality/tests/history-guard.test.mjs
// 运行：node --test tools/quality/tests/history-guard.test.mjs（也可直接 node 该文件）
// 依赖注入：@codemirror/* 经 createRequire 定位到 dsh-markpilot/node_modules
// （从测试文件向上找最近含该目录的祖先，产品仓与私有 overlay 同一份代码直接跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let root = here;
while (root !== path.dirname(root) && !existsSync(path.join(root, 'dsh-markpilot', 'node_modules'))) root = path.dirname(root);
assert.ok(existsSync(path.join(root, 'dsh-markpilot', 'node_modules')), 'locate dsh-markpilot/node_modules by walking up');
const cmRequire = createRequire(path.join(root, 'dsh-markpilot', 'src-cm6', 'main.js'));
const cmState = cmRequire('@codemirror/state');
const cmCommands = cmRequire('@codemirror/commands');
const { createHistoryGuard } = await import('../../../dsh-markpilot/src-cm6/history-guard.mjs');
const guard = createHistoryGuard({ state: cmState, commands: cmCommands });
const { EditorState, Transaction } = cmState;
const { history, undoDepth, redoDepth } = cmCommands;

const old = '讲义\n\n证明 A\n同一公式 $p$。\n\n证明 B\n同一公式 $p$。\n\n结尾\n';
const outside = '讲义\n\n证明 B\n同一公式 $p$。\n\n证明 A\n同一公式 $y$（外部修订）。\n\n结尾\n';
const base = 'Key A paragraph\n\nSame proof $P$\n\nKey B paragraph\n\nSame proof $P$\n\nFinal anchor\n';
const tiny = 'alpha\nomega\n';           // 长度 12（5+1+5+1），追加位置 12

function makeView(doc, guarded) {
  let state = EditorState.create({ doc, extensions: guarded ? [history(), guard.historyGuard()] : [history()] });
  const updates = [];
  const view = {
    get state() { return state; },
    dispatch(input) {
      const trs = Array.isArray(input) ? input : [input instanceof Transaction ? input : state.update(input)];
      for (const tr of trs) { assert.equal(tr.startState, state, 'sequential transaction chain'); state = tr.state; }
      updates.push(trs);
    },
    updates,
  };
  return view;
}
const text = v => v.state.doc.toString();
const ledger = v => v.state.field(guard.foreignSpans, false);
function type(view, pos, s) { view.dispatch({ changes: { from: pos, to: pos, insert: s }, selection: { anchor: pos + s.length }, userEvent: 'input.type' }); }
function replace1(view, from, to, s) { view.dispatch({ changes: { from, to, insert: s }, selection: { anchor: from + s.length }, userEvent: 'input.type.replace' }); }
/** 模拟引擎 setValue 的外部最小 diff（origin:'external'：附带 foreignMark，含覆盖区 zone）。 */
function external(view, target) {
  const cur = text(view), minLen = Math.min(cur.length, target.length);
  let start = 0;
  while (start < minLen && cur.charCodeAt(start) === target.charCodeAt(start)) start++;
  let endCur = cur.length, endNew = target.length;
  while (endCur > start && endNew > start && cur.charCodeAt(endCur - 1) === target.charCodeAt(endNew - 1)) { endCur--; endNew--; }
  const insert = target.slice(start, endNew);
  if (start === endCur && insert === '') return false;
  view.dispatch({
    changes: { from: start, to: endCur, insert },
    effects: [guard.foreignMark.of({ from: start, to: start + insert.length, zoneTo: endCur > start ? start + insert.length : null })],
    annotations: Transaction.addToHistory.of(false),
  });
  return true;
}
const run = (view, kind, notes) => guard.guardedHistory(view, kind, { notify: w => notes.push(w) });

test('T1 根因红臂：无台账时 reload 乱序后一次 Ctrl+Z 把 "证明 B" 写成 "证明 AB"', () => {
  const v = makeView(old, false);
  replace1(v, 7, 8, 'X');
  assert.equal(text(v), old.replace('证明 A', '证明 X'));
  external(v, outside);
  assert.equal(text(v), outside);
  let step = null;
  assert.equal(cmCommands.undo({ state: v.state, dispatch: tr => { if (!step) step = tr; } }), true);
  step.changes.iterChanges((f, t, fb, tb) => console.log('   退化事件段: delete[%d,%d) insert len=%d', f, t, tb - fb));
  assert.equal(run(v, 'undo', []), true);
  assert.equal(text(v), '讲义\n\n证明 AB\n同一公式 $p$。\n\n证明 A\n同一公式 $y$（外部修订）。\n\n结尾\n',
    '必须复现 3.6.15 实测损坏形态（判别力红臂）');
});

test('T2 守卫版 reload 乱序：单次数组 dispatch、字节不动、截断该段、新编辑仍可 Undo', () => {
  const v = makeView(old, true);
  replace1(v, 7, 8, 'X');
  external(v, outside);
  const before = text(v), notes = [], dispatches = v.updates.length;
  assert.equal(run(v, 'undo', notes), true, '按键被消费');
  assert.equal(text(v), before, 'undo 不得改动外部乱序后的字节');
  assert.equal(v.updates.length, dispatches + 1, '只发布一次视图更新');
  assert.deepEqual(v.updates.at(-1).map(tr => tr.docChanged), [true, true], '数组内两段顺序交易');
  assert.equal(notes.length, 1, '恰好提示一次');
  assert.equal(notes[0].kind, 'reinsert', '判据=旧字重插');
  assert.equal(undoDepth(v.state), 0, '该事件已从待撤销栈透明截断');
  assert.equal(redoDepth(v.state), 0, '对侧不留会复活旧字的 redo');
  assert.deepEqual(ledger(v), { gen: 1, bytes: [[7, 39, 1]], zones: [[7, 39, 1]] }, '台账自愈');
  assert.equal(v.state.selection.main.head, 7, '光标落回原处');
  type(v, 0, 'Z');
  assert.equal(run(v, 'undo', []), true);
  assert.equal(text(v), before, '截断之后用户新编辑照常 Undo');
});

test('T3 实时顺序替换：A→X 已存、远端 X→Y，A 的 undo 不得把 A 塞到 Y 旁', () => {
  const v = makeView(base, true);
  const pos = base.indexOf('Key A') + 5;
  replace1(v, pos - 1, pos, 'X');
  const target = base.replace('Key A', 'Key Y');
  external(v, target);
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), target, '实测损坏形态是 Key YA（旧字插在 Y 之后），必须拦下');
  assert.equal(notes.length, 1);
});

test('T4 same-span 对照：insert xy / 远端 y→Q / undo 只删 x、保 Q、零打扰', () => {
  const v = makeView(base, true);
  const pos = base.indexOf('Key A') + 5;
  type(v, pos, 'xy');
  external(v, base.replace('Key A', 'Key AxQ'));
  const notes = [], dispatches = v.updates.length;
  run(v, 'undo', notes);
  assert.equal(text(v), base.replace('Key A', 'Key AQ'), 'undo 只删自己的 x');
  assert.equal(notes.length, 0, '安全路径零提示');
  assert.equal(v.updates.length, dispatches + 1, '安全路径仍是普通单交易 undo');
});

test('T5 external-prefix 保留：undo 只移除本地编辑', () => {
  const v = makeView(tiny, true);
  type(v, tiny.length, 'LOCAL_EDIT');
  external(v, 'EXTERNAL_PREFIX\n' + tiny + 'LOCAL_EDIT');
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), 'EXTERNAL_PREFIX\n' + tiny);
  assert.equal(notes.length, 0);
});

test('T6 identical bytes：无外部标记、undo 原生行为', () => {
  const v = makeView(tiny, true);
  type(v, tiny.length, 'LOCAL_EDIT');
  assert.equal(external(v, tiny + 'LOCAL_EDIT'), false, '最小 diff 为空 ⇒ 不派发');
  run(v, 'undo', []);
  assert.equal(text(v), tiny);
});

test('T7 外部区间旁的本地删除：undo 照常恢复、不误杀', () => {
  const v = makeView(tiny, true);
  v.dispatch({ changes: { from: 6, to: tiny.length }, selection: { anchor: 6 }, userEvent: 'delete.content' });
  assert.equal(text(v), 'alpha\n');
  external(v, 'EXTERNAL_PREFIX\nalpha\n');
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), 'EXTERNAL_PREFIX\n' + tiny);
  assert.equal(notes.length, 0, '纯插入外部前缀不产生覆盖区 ⇒ 相邻本地撤销照常');
});

test('T8 删除段吃外部字节（严格相交）：保住外部字节', () => {
  const v = makeView('k', true);
  type(v, 1, 'xy');
  external(v, 'kxEXT');
  const notes = [];
  run(v, 'undo', notes);
  assert.ok(text(v).includes('EXT'), '外部 EXT 必须幸存');
  assert.ok(text(v) === 'kxEXT' || text(v) === 'kEXT', '原生安全步或截断保字节: ' + JSON.stringify(text(v)));
  console.log('   T8 branch:', notes.length ? 'truncated+notify' : 'native-safe-step', '->', JSON.stringify(text(v)));
});

test('T9 更旧的不相交事件仍可 Undo（非全局清史）', () => {
  const v = makeView(old, true);
  type(v, 0, 'OLD');
  replace1(v, 10, 11, 'X');
  const target = 'OLD' + outside;
  external(v, target);
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), target, '只截断被覆盖的事件');
  run(v, 'undo', []);
  assert.equal(text(v), outside, '更旧事件正常撤销');
  assert.equal(notes.length, 1);
});

test('T10 危险 redo 截断：b→X 已撤销、远端 b→Y，Ctrl+Y 不得把 X 塞到 Y 后', () => {
  const v = makeView('ab', true);
  replace1(v, 1, 2, 'X');
  run(v, 'undo', []);
  assert.equal(text(v), 'ab');
  external(v, 'aY');
  const notes = [];
  assert.equal(run(v, 'redo', notes), true);
  assert.equal(text(v), 'aY', '实测损坏形态是 aYX（旧字插在 Y 之后），必须拦下');
  assert.equal(notes.length, 1);
  type(v, 2, 'Z');
  run(v, 'undo', []);
  assert.equal(text(v), 'aY', '之后新编辑可 Undo');
});

test('T11 pendingDanger 只读探针', () => {
  const v = makeView(base, true);
  const pos = base.indexOf('Key A') + 5;
  replace1(v, pos - 1, pos, 'X');
  external(v, base.replace('Key A', 'Key Y'));
  const d = guard.pendingDanger(v.state);
  assert.equal(d.undo?.kind, 'reinsert', '探针报出重插危险');
  assert.equal(text(v), base.replace('Key A', 'Key Y'), '探针不改变状态');
});

test('T12 无间隙删除：远端删掉 replacement 的全部 X，undo 不得复活旧字 A', () => {
  const v = makeView(old, true);
  replace1(v, 7, 8, 'X');
  const deleted = old.replace('证明 A', '证明 ');
  assert.equal(external(v, deleted), true, '纯删除 diff 派发');
  assert.deepEqual(ledger(v), { gen: 1, bytes: [], zones: [[7, 7, 1]] }, '纯删除留下覆盖点 zone');
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), deleted, '不得把 A 塞回被清空的位置');
  assert.equal(notes.length, 1);
  assert.equal(redoDepth(v.state), 0, 'redo 侧同样不复活');
});

test('T13 redo 对称（无间隙删除）：远端删掉 b，Ctrl+Y 不得复活 X', () => {
  const v = makeView('ab', true);
  replace1(v, 1, 2, 'X');
  run(v, 'undo', []);
  external(v, 'a');
  const notes = [];
  assert.equal(run(v, 'redo', notes), true);
  assert.equal(text(v), 'a', '不得把 X 塞回');
  assert.equal(notes.length, 1);
  type(v, 1, 'Z');
  run(v, 'undo', []);
  assert.equal(text(v), 'a', '之后新编辑可 Undo');
});

test('T14 用户在外部区间内部打字：区间劈开、该打字的 undo 照常（不误杀）', () => {
  const v = makeView('ab', true);
  external(v, 'aQQ');                       // 真替换：b → QQ（非纯插入）
  assert.deepEqual(ledger(v), { gen: 1, bytes: [[1, 3, 1]], zones: [[1, 3, 1]] });
  type(v, 2, 'Z');
  assert.equal(text(v), 'aQZQ');
  assert.deepEqual(ledger(v).bytes, [[1, 2, 1], [3, 4, 1]], '用户字节从台账剔除');
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), 'aQQ');
  assert.equal(notes.length, 0);
  assert.deepEqual(ledger(v).bytes, [[1, 3, 1]], '撤销后区间重新愈合');
});

/* ══ 真实 GUI 红臂回归（peer-adjacent-h1）：远端写入之后用户自己的新撤销不得误挡 ══ */

test('R1 peer-adjacent：远端 A→Y 后用户删 Y 后的空格，Ctrl+Z 恢复空格、Ctrl+Y 再删', () => {
  const v = makeView(base, true);
  const pos = base.indexOf('Key A') + 5;      // 5：A 之后；空格在 [5,6)
  external(v, base.replace('Key A', 'Key Y')); // 远端把 A 替换为 Y（覆盖区 zone gen=1）
  assert.equal(text(v), base.replace('Key A', 'Key Y'));
  v.dispatch({ changes: { from: pos, to: pos + 1 }, selection: { anchor: pos }, userEvent: 'delete.contentBackward' });
  assert.equal(text(v), base.replace('Key A ', 'Key Y'), '两窗实测形态 Key Yparagraph');
  const notes = [];
  assert.equal(run(v, 'undo', notes), true);
  assert.equal(text(v), base.replace('Key A', 'Key Y'), '自己的新删除必须照常恢复（实测曾被 zone 误挡）');
  assert.equal(notes.length, 0, '不得提示不得截断');
  assert.equal(run(v, 'redo', notes), true);
  assert.equal(text(v), base.replace('Key A ', 'Key Y'), 'redo 对称：再删空格');
  assert.equal(notes.length, 0);
});

test('R2 远端写入后用户删掉外部字节本身，Ctrl+Z 照常恢复（bytes 起点不误挡）', () => {
  const v = makeView(base, true);
  const pos = base.indexOf('Key A') + 5;
  external(v, base.replace('Key A', 'Key Y'));
  v.dispatch({ changes: { from: pos - 1, to: pos }, selection: { anchor: pos - 1 }, userEvent: 'delete.contentBackward' });
  assert.equal(text(v), base.replace('Key A', 'Key '));
  const notes = [];
  run(v, 'undo', notes);
  assert.equal(text(v), base.replace('Key A', 'Key Y'), '恢复自己刚删的外部字节 Y');
  assert.equal(notes.length, 0);
});

test('R3 被覆盖旧动作截断后，邻 zone 的后续自己输入可独立撤销（两步独立）', () => {
  const v = makeView(base, true);
  const pos = base.indexOf('Key A') + 5;
  replace1(v, pos - 1, pos, 'X');               // 旧事件（gen=0）
  external(v, base.replace('Key A', 'Key Y'));  // 远端覆盖（gen=1）
  const notes = [];
  run(v, 'undo', notes);                        // 第一步：旧动作被透明截断
  assert.equal(notes.length, 1);
  assert.equal(text(v), base.replace('Key A', 'Key Y'));
  type(v, pos, 'Z');                            // 第二步：zone 起点旁的新输入（gen=1）
  const notes2 = [];
  run(v, 'undo', notes2);
  assert.equal(text(v), base.replace('Key A', 'Key Y'), '新输入独立可撤销');
  assert.equal(notes2.length, 0);
});

test('T15 同组连击退格后外部写入：陈旧历史锚点不得抛 RangeError（3.6.17 装机实测同族）', () => {
  const v = makeView('ABCDEFGHIJ', true);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) {
    const pos = v.state.doc.length;
    v.dispatch({
      changes: { from: pos - 1, to: pos },
      selection: { anchor: pos - 1 },
      annotations: [Transaction.time.of(t0 + i * 16), Transaction.userEvent.of('delete.backward')],
    });
  }
  assert.equal(text(v), 'ABCDEFG', '三次连击退格合并为一个历史事件');
  assert.equal(external(v, 'ABCDEFGZZZZ'), true, '外部最小 diff 派发（addToHistory:false 走 addMapping）');
  // 修复前：合并事件里更旧的锚点 8/9 越过 changeset 旧长度 7，mapPos 抛
  // RangeError（装机实测 Position 3588891 > 3588890，同一形态）。
  assert.equal(text(v), 'ABCDEFGZZZZ', '外部写入必须生效，不得被历史映射异常打断');
  const notes = [];
  assert.equal(run(v, 'undo', notes), true);
  assert.ok(text(v).includes('ZZZZ'), '外部字节必须完整');
  assert.equal(text(v).replace('ZZZZ', ''), 'ABCDEFGHIJ', '用户自己的三个字符只出现一次，不重不漏');
  assert.equal(notes.length, 0, '贴边重插不触发危险截断');
});
