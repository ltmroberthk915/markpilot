import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-lifecycle.cjs';

const groupId = '76431f54-7334-4071-b39a-2f5c6e5f97ab';
const pathKey = 'd:/probe/a.md';
const key = 'dsh-markdown-editor-typora:review:v1:' + encodeURIComponent(pathKey);
const record = JSON.stringify({v: 1, pathKey, baseVersion: 'v1', groups: [groupId], count: 1, at: 5});

function openFixture() {
  const editor = fixture.make();
  const lookups = [], saves = [];
  let finishSlot;
  editor.storage.set(key, record);
  editor.draftStore.readLatest = () => new Promise(resolve => { finishSlot = resolve; });
  editor.setFetch(({endpoint, payload}) => {
    if (endpoint === 'open') return {ok: true, value: {text: 'A', version: 'v1', displayPath: editor.st.doc.absPath, size: 1}};
    if (endpoint === 'documents.reviewGroups') return new Promise(resolve => lookups.push({payload, resolve}));
    if (endpoint === 'save') saves.push(payload);
    return {ok: true, value: {}};
  });
  return {editor, lookups, saves, noLocalSlot: () => finishSlot(null)};
}

test('legacy review holds typing during a slow draft lookup and migrates only after host proof', async t => {
  const {editor, lookups, saves, noLocalSlot} = openFixture();
  t.after(() => editor.cleanup());
  await editor.boot();
  editor.edit('A + unsaved');
  await editor.advance(1900);
  assert.equal(saves.length, 0);
  assert.equal(editor.st.doc.review, null);
  noLocalSlot();
  await fixture.drain();
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].payload.path, editor.st.doc.absPath);
  assert.deepEqual(Array.from(lookups[0].payload.groupIds), [groupId]);
  lookups[0].resolve({ok: true, value: {providerVersion: 'v1', reviewRestorable: true, groups: [{groupId, undoneAt: null}]}});
  await fixture.drain();
  assert.deepEqual(Array.from(editor.st.doc.review.groups), [groupId]);
  assert.equal(JSON.parse(editor.storage.get(key)).v, 2);
  assert.equal(editor.engine.text, 'A + unsaved');
  assert.equal(saves.length, 0);
});

test('unavailable history retains the v1 record; an obsolete reply cannot migrate another editor’s group', async t => {
  const {editor, lookups, saves, noLocalSlot} = openFixture();
  t.after(() => editor.cleanup());
  await editor.boot();
  noLocalSlot();
  await fixture.drain();
  lookups[0].resolve({ok: true, value: {providerVersion: 'v1', groups: [{groupId}], chainOk: false,
    reviewRestorable: false, reviewRestorableReason: 'history-api-unavailable'}});
  await fixture.drain();
  editor.edit('A + draft');
  await editor.advance(1900);
  assert.equal(editor.storage.get(key), record);
  assert.equal(saves.length, 0);
  editor.message('manual-save', {});
  await fixture.drain();
  const newer = JSON.stringify({...JSON.parse(record), groups: ['1ae6c188-c69e-4ccd-b360-529cab4e8ed1']});
  editor.storage.set(key, newer);
  lookups[1].resolve({ok: true, value: {providerVersion: 'v1', groups: [{groupId}], chainOk: true}});
  await fixture.drain();
  assert.equal(editor.storage.get(key), newer);
  assert.equal(editor.st.doc.review, null);
  assert.equal(saves.length, 0);
});

const RG_A = groupId;
const RG_C = 'c1a7e5d3-8b42-4f69-9e07-2d5a8c4b6f31';
const RG_INV = 'e9b3d1c7-4a26-4f85-b0d2-6c8e1a7f9b54';
const RG_B = 'f4c8a2e6-7d13-4b59-8a0e-3f6d9c1b7e42';
const reviewV2 = (groups, at) => JSON.stringify({v: 2, pathKey, baseVersion: 'v1', groups, count: groups.length, at});

async function migratedClosure() {
  const f = openFixture();
  await f.editor.boot();
  f.editor.edit('A + unsaved');
  await f.editor.advance(1900);
  f.noLocalSlot();
  await fixture.drain();
  assert.equal(f.lookups.length, 1);
  f.lookups[0].resolve({ok: true, value: {providerVersion: 'v1', reviewRestorable: true, groups: [{groupId, undoneAt: null}]}});
  await fixture.drain();
  assert.deepEqual(Array.from(f.editor.st.doc.review.groups), [RG_A]);
  assert.equal(JSON.parse(f.editor.storage.get(key)).v, 2);
  return f;
}

function holdHostCalls(editor, saves) {
  const held = [];
  editor.setFetch(({endpoint, payload}) => {
    if (endpoint === 'save') { saves.push(payload); return {ok: true, value: {}}; }
    return new Promise(resolve => held.push({endpoint, payload, resolve}));
  });
  return held;
}

test('a review that lands while undo A is in flight survives the receipt', async t => {
  const f = await migratedClosure();
  const {editor, saves} = f;
  t.after(() => editor.cleanup());
  const held = holdHostCalls(editor, saves);
  editor.st.actions.reviewUndo();
  await fixture.drain();
  const undo = held.find(call => call.endpoint === 'documents.undoGroups');
  assert.ok(undo, 'undo A must still be pending on the host');
  assert.deepEqual(Array.from(undo.payload.groupIds), [RG_A], 'the host must be asked to undo A');
  const seeded = reviewV2([RG_A, RG_C, RG_INV], 9);
  editor.storage.set(key, seeded);
  editor.st.doc.review = {groups: [RG_A, RG_C, RG_INV]};
  editor.st.doc.reviewRecord = seeded;
  undo.resolve({ok: true, value: {changed: true, source: 'buffer', saved: false, groupId: RG_INV, undoOf: [RG_A]}});
  await fixture.drain();
  assert.deepEqual(Array.from(editor.st.doc.review.groups), [RG_C], 'A and its inverse group must leave while C stays');
  const stored = JSON.parse(editor.storage.get(key));
  assert.equal(stored.v, 2);
  assert.deepEqual(stored.groups, [RG_C], 'C must stay the only persisted review');
  assert.equal(stored.count, stored.groups.length);
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'baseVersion', 'count', 'groups', 'pathKey', 'v']);
  assert.equal(editor.st.doc.reviewRecord, editor.storage.get(key));
  editor.message('manual-save', {});
  await fixture.drain();
  assert.equal(saves.length, 0, 'manual save must be held by the pending review');
  assert.equal(editor.engine.text, 'A + unsaved');
});

test('a late undo receipt must not rewrite a store taken over by a new mount', async t => {
  const f = await migratedClosure();
  const {editor, saves} = f;
  let closed = false;
  t.after(() => { if (!closed) editor.cleanup(); });
  const held = holdHostCalls(editor, saves);
  editor.st.actions.reviewUndo();
  await fixture.drain();
  const undo = held.find(call => call.endpoint === 'documents.undoGroups');
  assert.ok(undo, 'undo A must still be pending on the host');
  assert.deepEqual(Array.from(undo.payload.groupIds), [RG_A], 'the host must be asked to undo A');
  editor.cleanup();
  closed = true;
  const takeover = reviewV2([RG_B], 3);
  editor.storage.set(key, takeover);
  undo.resolve({ok: true, value: {changed: true, source: 'buffer', saved: false, groupId: RG_INV, undoOf: [RG_A]}});
  await fixture.drain();
  assert.equal(editor.storage.get(key), takeover, 'the new mount record must stay byte-identical');
  assert.deepEqual(JSON.parse(editor.storage.get(key)).groups, [RG_B], 'only the new mount group may remain');
  assert.equal(saves.length, 0);
});
