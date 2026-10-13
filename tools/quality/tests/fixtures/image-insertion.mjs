// Actual CM6 EditorState/history transactions; fake view is only a dispatch
// container. These are state-level tests, not GUI/clipboard/disk evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorSelection, EditorState, StateEffect, Transaction } from '../../../../dsh-markpilot/node_modules/@codemirror/state/dist/index.js';
import { history, redo, undo, undoDepth, redoDepth } from '../../../../dsh-markpilot/node_modules/@codemirror/commands/dist/index.js';
import { imageInsertions, cancelImageInsertions, reserveImageInsertion, captureImageDocument } from '../../../../dsh-markpilot/src-cm6/image-insertion.js';

function makeView(doc = '', anchor = 0, head = anchor) {
  const view = { state: EditorState.create({ doc, selection: { anchor, head }, extensions: [imageInsertions, history(), EditorState.allowMultipleSelections.of(true)] }), transactions: [] };
  view.dispatch = (...specs) => {
    const tr = specs.length === 1 && specs[0] instanceof Transaction ? specs[0] : view.state.update(...specs);
    assert.equal(tr.startState, view.state);
    view.transactions.push(tr);
    view.state = tr.state;
  };
  return view;
}
const text = view => view.state.doc.toString();
const point = (view, anchor, head = anchor) => view.dispatch({ selection: { anchor, head } });
const reset = view => view.dispatch({ effects: cancelImageInsertions.of(null) });

test('image command ownership survives selection and background effects', () => {
  const v = makeView('abc'), current = captureImageDocument(v);
  point(v, 2);
  assert.equal(current(), true);
  const parserResult = StateEffect.define();
  v.dispatch({ effects: parserResult.of({ revision: 1 }) });
  assert.equal(current(), true);
  const pending = reserveImageInsertion(v);
  assert.equal(current(), true);
  pending.cancel();
  assert.equal(current(), true);
});

test('identical-text reset and ordinary edits invalidate image commands', () => {
  const v = makeView('abc'), beforeReset = captureImageDocument(v);
  reset(v);
  assert.equal(text(v), 'abc');
  assert.equal(beforeReset(), false);
  const beforeEdit = captureImageDocument(v);
  v.dispatch({ changes: { from: 1, insert: 'x' } });
  assert.equal(beforeEdit(), false);
});

test('reserve and cancel are effect-only, isolated from history', () => {
  const v = makeView('abc', 1), t = reserveImageInsertion(v);
  assert.deepEqual(t.current(), { from: 1, to: 1 });
  assert.equal(undoDepth(v.state), 0);
  assert.equal(t.cancel(), true);
  assert.equal(t.current(), null);
  assert.equal(t.cancel(), false);
  assert.equal(t.commit('I'), false);
  assert.equal(text(v), 'abc');
  assert.equal(undoDepth(v.state), 0);
  assert.ok(v.transactions.every(tr => !tr.docChanged && tr.annotation(Transaction.addToHistory) === false));
});

test('multiple selections explicitly reject without dispatch or collapse', () => {
  const v = makeView('abcd');
  v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.range(2, 3)]) });
  const before = v.state;
  assert.equal(reserveImageInsertion(v), null);
  assert.equal(v.state, before);
  assert.equal(v.state.selection.ranges.length, 2);
});

test('ordinary insertion before the reservation maps both offsets', () => {
  const v = makeView('abCDxy', 2, 4), t = reserveImageInsertion(v);
  v.dispatch({ changes: { from: 0, insert: 'Q' }, selection: { anchor: 1 } });
  assert.deepEqual(t.current(), { from: 3, to: 5 });
  assert.equal(t.commit('I'), true);
  assert.equal(text(v), 'QabIxy');
  assert.equal(v.state.selection.main.head, 1);
});

test('ordinary typing at an empty reservation stays after the pending image', () => {
  const v = makeView('tail'), t = reserveImageInsertion(v);
  v.dispatch({ changes: { from: 0, insert: 'ABC' }, selection: { anchor: 3 }, userEvent: 'input.type' });
  assert.deepEqual(t.current(), { from: 0, to: 0 });
  t.commit('I');
  assert.equal(text(v), 'IABCtail');
  assert.equal(v.state.selection.main.head, 4);
});

test('ordinary change inside a reserved selection cancels instead of deleting new text', () => {
  for (const change of [{ from: 3, insert: 'NEW' }, { from: 2, to: 3 }, { from: 1, to: 5, insert: 'R' }]) {
    const v = makeView('abCDxy', 2, 4), t = reserveImageInsertion(v);
    v.dispatch({ changes: change });
    const afterUserEdit = text(v);
    assert.equal(t.current(), null);
    assert.equal(t.commit('I'), false);
    assert.equal(text(v), afterUserEdit);
  }
});

test('insertion at selection boundaries is outside the captured text', () => {
  const v = makeView('abcdef', 2, 4), t = reserveImageInsertion(v);
  v.dispatch({ changes: [{ from: 2, insert: 'X' }, { from: 4, insert: 'Y' }], selection: { anchor: 3, head: 5 } });
  assert.deepEqual(t.current(), { from: 3, to: 5 });
  t.commit('I');
  assert.equal(text(v), 'abXIYef');
  assert.equal(v.state.selection.main.head, 4);
});

test('same-point tickets A then B commit in request order in one transaction each', () => {
  const v = makeView('x'), a = reserveImageInsertion(v), b = reserveImageInsertion(v);
  assert.equal(a.commit('A'), true);
  assert.equal(a.current(), null);
  assert.deepEqual(b.current(), { from: 1, to: 1 });
  assert.equal(b.commit('B'), true);
  assert.equal(text(v), 'ABx');
  assert.equal(v.state.field(imageInsertions).tickets.length, 0);
  assert.equal(v.transactions.filter(tr => tr.docChanged).length, 2);
});

test('reversed ready/commit order still places A before B, without a payload queue', () => {
  const v = makeView('x'), a = reserveImageInsertion(v), b = reserveImageInsertion(v);
  b.commit('B');
  assert.deepEqual(a.current(), { from: 0, to: 0 });
  a.commit('A');
  assert.equal(text(v), 'ABx');
  assert.equal(v.state.selection.main.head, 2);
});

test('three same-point tickets keep request order under every completion permutation', () => {
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const v = makeView('x'), tickets = [reserveImageInsertion(v), reserveImageInsertion(v), reserveImageInsertion(v)];
    for (const index of order) assert.equal(tickets[index].commit('ABC'[index]), true);
    assert.equal(text(v), 'ABCx', order.join(','));
  }
});

test('same reserved nonempty selection is replaced once when two images arrive', () => {
  for (const reverse of [false, true]) {
    const v = makeView('abCDxy', 2, 4), a = reserveImageInsertion(v), b = reserveImageInsertion(v);
    if (reverse) { b.commit('B'); a.commit('A'); }
    else { a.commit('A'); b.commit('B'); }
    assert.equal(text(v), 'abABxy');
    assert.equal(v.state.field(imageInsertions).tickets.length, 0);
  }
});

test('different-point tickets retain their actual document positions', () => {
  const v = makeView('abcd', 1), a = reserveImageInsertion(v);
  point(v, 3);
  const b = reserveImageInsertion(v);
  a.commit('A');
  assert.deepEqual(b.current(), { from: 4, to: 4 });
  b.commit('B');
  assert.equal(text(v), 'aAbcBd');
});

test('a moved caret is naturally mapped and never explicitly moved to image end', () => {
  const v = makeView('abc'), t = reserveImageInsertion(v);
  point(v, 2);
  t.commit('LONG');
  assert.equal(text(v), 'LONGabc');
  assert.equal(v.state.selection.main.head, 6);
  assert.equal(v.transactions.at(-1).selection, undefined);
});

test('matching current selection moves to image end, including a backwards selection', () => {
  for (const backwards of [false, true]) {
    const v = makeView('abCDxy', backwards ? 4 : 2, backwards ? 2 : 4), t = reserveImageInsertion(v);
    t.commit('IMG');
    assert.equal(text(v), 'abIMGxy');
    assert.equal(v.state.selection.main.anchor, 5);
    assert.equal(v.state.selection.main.head, 5);
  }
});

test('epoch reset without text changes invalidates old tickets and keeps history intact', () => {
  const v = makeView('abc', 1), a = reserveImageInsertion(v), b = reserveImageInsertion(v);
  reset(v);
  assert.equal(a.current(), null);
  assert.equal(b.current(), null);
  assert.equal(a.commit('A'), false);
  assert.equal(text(v), 'abc');
  assert.equal(undoDepth(v.state), 0);
  const newDocumentTicket = reserveImageInsertion(v);
  assert.equal(newDocumentTicket.commit('N'), true);
  assert.equal(text(v), 'aNbc');
});

test('undo and redo transactions invalidate pending tickets, which never reappear', () => {
  const v = makeView('x');
  v.dispatch({ changes: { from: 0, insert: 'T' }, userEvent: 'input.type' });
  const beforeUndo = reserveImageInsertion(v);
  assert.equal(undo(v), true);
  assert.equal(beforeUndo.current(), null);
  assert.equal(beforeUndo.commit('I'), false);
  const beforeRedo = reserveImageInsertion(v);
  assert.equal(redo(v), true);
  assert.equal(beforeRedo.current(), null);
  assert.equal(text(v), 'Tx');
  assert.equal(v.state.field(imageInsertions).tickets.length, 0);
});

test('each image is one isolated undo; redo restores exact document without tickets', () => {
  const v = makeView('x'), a = reserveImageInsertion(v), b = reserveImageInsertion(v);
  a.commit('A'); b.commit('B');
  assert.equal(undoDepth(v.state), 2);
  assert.equal(undo(v), true); assert.equal(text(v), 'Ax');
  assert.equal(undo(v), true); assert.equal(text(v), 'x');
  assert.equal(redoDepth(v.state), 2);
  assert.equal(redo(v), true); assert.equal(text(v), 'Ax');
  assert.equal(redo(v), true); assert.equal(text(v), 'ABx');
  assert.equal(a.current(), null); assert.equal(b.current(), null);
  assert.equal(v.state.field(imageInsertions).tickets.length, 0);
});

test('typing before and after image commits does not merge with image undo', () => {
  const v = makeView('x'), a = reserveImageInsertion(v);
  v.dispatch({ changes: { from: 0, insert: 'T' }, selection: { anchor: 1 }, userEvent: 'input.type' });
  a.commit('I');
  v.dispatch({ changes: { from: 2, insert: 'U' }, selection: { anchor: 3 }, userEvent: 'input.type' });
  assert.equal(undoDepth(v.state), 3);
  undo(v); assert.equal(text(v), 'ITx');
  undo(v); assert.equal(text(v), 'Tx');
  undo(v); assert.equal(text(v), 'x');
});

test('no-op undo has no transaction: host must send reset if it means cancel-pending', () => {
  const v = makeView('x'), t = reserveImageInsertion(v);
  assert.equal(undo(v), false);
  assert.deepEqual(t.current(), { from: 0, to: 0 });
  reset(v);
  assert.equal(t.current(), null);
});
