'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const modules = Promise.all([
  import(pathToFileURL(path.join(root, 'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href),
  import(pathToFileURL(path.join(root, 'dsh-markpilot/node_modules/@codemirror/commands/dist/index.js')).href),
  import(pathToFileURL(path.join(root, 'dsh-markpilot/src-cm6/image-removal.js')).href),
]);
const original = '![alt](data:image/png;base64,QQ==)\nKEEP\n';
const converted = '![alt](assets/image.png)\nKEEP\n';
const tick = () => new Promise(resolve => setImmediate(resolve));

// Recognition is a small fixture provider. Gate, CM transactions and history
// are actual product modules; no DOM or confirmation widget is simulated here.
async function fixture({ afterApply } = {}) {
  const [S, C, G] = await modules;
  let gate;
  const choices = [];
  const view = {
    dom: { isConnected: true }, focus() {},
    update(transactions) { for (const transaction of transactions) {
      assert.equal(transaction.startState, this.state); this.state = transaction.state;
    } },
    dispatch(...spec) {
      const transactions = spec.length === 1 && spec[0] instanceof S.Transaction ? spec : [this.state.update(...spec)];
      gate.dispatch(transactions, this);
    },
  };
  view.dispatch = view.dispatch.bind(view);
  view.state = S.EditorState.create({ doc: original, extensions: [C.history(), S.EditorState.transactionFilter.of(tr => gate.filter(tr))] });
  gate = G.createImageRemovalGate({ getView: () => view, identity: () => 1, bypass: () => false,
    images: state => [...state.doc.toString().matchAll(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g)].map(m => ({ data: { image: { src: m[1] } } })),
    path: () => 'D:/owned/note.md', host: () => ({ currentDoc: async () => ({ documentId: 'owned', filePath: 'D:/owned/note.md' }) }),
    prompt: choice => { choices.push(choice); return () => {}; }, afterApply,
  });
  return { S, C, gate, view, choices,
    convert: () => gate.dispatchWithResult({ changes: { from: 0, to: original.length, insert: converted }, userEvent: 'input.extract-images' }),
    async choice() { await tick(); assert.equal(choices.length, 1); return choices[0]; },
  };
}

test('conversion receipt waits for confirmation and reflects one real history change', async () => {
  const f = await fixture(); let settled = false;
  const promise = f.convert().then(result => { settled = true; return result; });
  const choice = await f.choice();
  assert.equal(settled, false); assert.equal(f.view.state.doc.toString(), original); assert.equal(f.C.undoDepth(f.view.state), 0);
  choice.finish(true);
  assert.equal(await promise, true); assert.equal(f.view.state.doc.toString(), converted); assert.equal(f.C.undoDepth(f.view.state), 1);
  assert(f.C.undo(f.view)); assert.equal(f.view.state.doc.toString(), original);
});

test('cancel and invalidated choices settle false without altering document/history', async () => {
  for (const invalidate of [false, true]) {
    const f = await fixture(), promise = f.convert();
    const choice = await f.choice();
    if (invalidate) f.view.dispatch({ selection: { anchor: 1 } });
    const before = f.view.state.field(f.C.historyField);
    choice.finish(invalidate);
    assert.equal(await promise, false); assert.equal(f.view.state.doc.toString(), original);
    assert.equal(f.view.state.field(f.C.historyField), before);
    assert.equal(f.C.undoDepth(f.view.state), 0);
  }
});

test('an auxiliary projection failure cannot report cancellation after source applied', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture({ afterApply() { throw new Error('injected projection failure'); } });
  const promise = f.convert(); (await f.choice()).finish(true);
  assert.equal(await promise, true); assert.equal(f.view.state.doc.toString(), converted); assert.equal(f.C.undoDepth(f.view.state), 1);
});
