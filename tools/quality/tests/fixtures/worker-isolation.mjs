import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription, LanguageSupport, StreamLanguage, forceParsing, syntaxTreeAvailable, syntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/legacy-modes/mode/javascript';
import { Tree, TreeBuffer, NodeProp } from '@lezer/common';
import { markdownContext } from '../../../../dsh-markpilot/src-cm6/markdown-context.js';
import { createRawTreeCodec } from '../../../../dsh-markpilot/src-cm6/worker-tree-codec.js';
import { createAsyncMarkdown } from '../../../../dsh-markpilot/src-cm6/async-markdown.js';

const prefix = 'plain paragraph\n\n'.repeat(230), fence = '`'.repeat(3);
const codec = createRawTreeCodec({ Tree, TreeBuffer, NodeProp });
const codeLanguages = [LanguageDescription.of({ name: 'javascript', alias: ['js'],
  support: new LanguageSupport(StreamLanguage.define(javascript)) })];
class MockWorker {
  constructor(url) { this.url = String(url); this.messages = []; this.terminated = false; }
  postMessage(data) { this.messages.push(structuredClone(data)); }
  terminate() { this.terminated = true; }
}
const live = new Set();
function make(tail = 'old tail') {
  const async = createAsyncMarkdown(markdownLanguage, { threshold: prefix.length + 2 });
  const state = EditorState.create({ doc: prefix + tail,
    extensions: [markdownContext, async.extension, basicSetup, markdown({ base: async.language, addKeymap: false, codeLanguages })] });
  const view = { state, viewport: { from: 0, to: state.doc.length } };
  let plugin;
  view.dispatch = item => {
    const before = view.state, tr = item?.state ? item : view.state.update(item);
    view.state = tr.state; view.viewport = { from: 0, to: view.state.doc.length };
    plugin?.update({ state: view.state, startState: before, docChanged: !tr.changes.empty, changes: tr.changes });
  };
  // Test-only access to the real ViewPlugin constructor; no EditorView/DOM/app is instantiated.
  plugin = async.extension[1].create(view);
  const h = { view, plugin, async, inspect: () => async.inspect(view.state),
    retire() { plugin.destroy(); live.delete(h); } };
  live.add(h); return h;
}
function replaceWorker(h) {
  const old = h.plugin.worker;
  h.view.dispatch({ changes: { from: 0, to: h.view.state.doc.length, insert: 'x' } });
  assert.equal(old.terminated, true); assert.equal(h.plugin.worker, null);
  h.view.dispatch({ changes: { from: 0, to: 1, insert: prefix + fence + 'js\nconst fresh = 1;\n' + fence } });
  const next = h.plugin.worker;
  assert.ok(next); assert.notEqual(next, old); assert.equal(next.terminated, false);
  return { old, next };
}
function treeMessage(h) {
  const field = h.view.state.field(h.async.extension[0]);
  const wire = codec.encode(markdownLanguage.parser.parse(h.view.state.doc.toString()), markdownLanguage.parser.nodeSet);
  return { type: 'tree', revision: field.revision, length: field.doc.length, wire };
}
function queued(fn, payload) {
  return new Promise((resolve, reject) => queueMicrotask(() => {
    try { fn(payload); resolve(); } catch (error) { reject(error); }
  }));
}
function text(h) { return h.view.state.doc.toString(); }
export async function runTests({ identityRemoved, minify }) {
  globalThis.Worker = MockWorker; globalThis.location = { href: 'file:///private-proof/renderer/index.html' };
  const cases = [];
  const run = async (name, fn, scope = 'actual_source_headless_callback') => {
    try { cases.push({ name, scope, pass: true, evidence: await fn() }); }
    catch (error) { cases.push({ name, scope, pass: false, error: error.stack }); }
    finally { for (const h of [...live]) h.retire(); }
  };
  for (const method of ['onerror', 'onmessageerror']) await run('queued retired ' + method + ' is isolated from its replacement', async () => {
    const h = make(), old = h.plugin.worker, callback = old[method];
    const pending = queued(callback, { message: 'queued retired failure' });
    const { next } = replaceWorker(h), before = text(h), statusBefore = h.inspect();
    await pending; const statusAfter = h.inspect();
    assert.equal(text(h), before);
    if (identityRemoved) {
      assert.equal(statusAfter.status, 'failed'); assert.equal(next.terminated, true); assert.equal(h.plugin.failed, true);
      assert.ok(statusAfter.error); assert.equal(h.plugin.worker, null);
    } else {
      assert.deepEqual(statusAfter, statusBefore); assert.equal(next.terminated, false);
      assert.equal(h.plugin.worker, next); assert.equal(h.plugin.failed, false);
    }
    return { callbackQueuedBeforeReplacement: true, deliveredAfterReplacement: true, oldTerminated: old.terminated,
      replacementTerminated: next.terminated, before: statusBefore.status, after: statusAfter.status,
      error: statusAfter.error, exactText: true };
  });
  await run('queued old onmessage with its genuine old revision never publishes a stale tree', async () => {
    const h = make(), old = h.plugin.worker, oldMessage = treeMessage(h), callback = old.onmessage;
    const pending = queued(callback, { data: oldMessage });
    const { next } = replaceWorker(h), before = text(h), afterRevision = h.inspect().revision;
    await pending; const status = h.inspect();
    assert.equal(status.status, 'pending'); assert.equal(status.completed, 0); assert.equal(status.error, null);
    assert.equal(status.discarded, identityRemoved ? 1 : 0); assert.equal(next.terminated, false);
    assert.equal(text(h), before); assert.notEqual(oldMessage.revision, afterRevision);
    return { actualOldRevision: oldMessage.revision, currentRevision: afterRevision, status: status.status,
      completed: 0, discarded: status.discarded, exactText: true };
  });
  await run('old onmessage cannot fail a replacement even with an adversarial current-revision packet', async () => {
    const h = make(), old = h.plugin.worker, callback = old.onmessage;
    let data; const pending = queued(payload => callback({ data: payload() }), () => data);
    const { next } = replaceWorker(h), before = text(h);
    data = { type: 'error', revision: h.inspect().revision, error: 'foreign current-revision error' };
    await pending; const status = h.inspect();
    assert.equal(status.status, identityRemoved ? 'failed' : 'pending');
    assert.equal(next.terminated, identityRemoved); assert.equal(text(h), before);
    return { deliberatelyForgedRevision: true, oldWorkerCouldNotKnowReplacementRevisionInNormalProtocol: true,
      status: status.status, replacementTerminated: next.terminated, exactText: true };
  }, 'adversarial_packet_model');
  await run('old onmessage cannot publish replacement data through a saved foreign callback', async () => {
    const h = make(), old = h.plugin.worker, callback = old.onmessage;
    let data; const pending = queued(payload => callback({ data: payload() }), () => data);
    const { next } = replaceWorker(h), before = text(h); data = treeMessage(h);
    await pending; const status = h.inspect();
    assert.equal(status.status, identityRemoved ? 'ready' : 'pending');
    assert.equal(status.completed, identityRemoved ? 1 : 0); assert.equal(status.available, identityRemoved);
    assert.equal(next.terminated, false); assert.equal(text(h), before);
    return { deliberatelySuppliedReplacementWireToForeignCallback: true,
      status: status.status, completed: status.completed, available: status.available, exactText: true };
  }, 'adversarial_packet_model');
  for (const method of ['onerror', 'onmessageerror']) await run('active ' + method + ' still fails and safely enables native fallback', async () => {
    const h = make(), worker = h.plugin.worker, before = text(h);
    await queued(worker[method], { message: 'active Worker failure' });
    assert.equal(h.inspect().status, 'failed'); assert.equal(worker.terminated, true); assert.ok(h.inspect().error);
    forceParsing(h.view, h.view.state.doc.length, 1000);
    assert.equal(syntaxTreeAvailable(h.view.state), true); assert.ok(h.inspect().nativeFallback > 0); assert.equal(text(h), before);
    return { status: 'failed', workerTerminated: true, nativeFallback: h.inspect().nativeFallback, available: true, exactText: true };
  });
  await run('active valid onmessage publishes a complete independently mounted JavaScript tree', async () => {
    const h = make(fence + 'js\nconst value = 1;\n' + fence), worker = h.plugin.worker, before = text(h);
    await queued(worker.onmessage, { data: treeMessage(h) });
    assert.equal(h.inspect().status, 'ready'); assert.equal(h.inspect().completed, 1); assert.equal(syntaxTreeAvailable(h.view.state), true);
    const field = h.view.state.field(h.async.extension[0]);
    assert.doesNotThrow(() => codec.encode(field.fragments[0].tree, markdownLanguage.parser.nodeSet));
    assert.throws(() => codec.encode(syntaxTree(h.view.state), markdownLanguage.parser.nodeSet));
    assert.equal(worker.terminated, false); assert.equal(text(h), before);
    return { status: 'ready', complete: true, rawFragments: true, publishedMixedTreeIsIndependent: true, exactText: true };
  });
  await run('same live Worker stale revision is rejected while its next valid result remains accepted', async () => {
    const h = make(), worker = h.plugin.worker, message = treeMessage(h);
    const stale = queued(worker.onmessage, { data: message });
    h.view.dispatch({ changes: { from: h.view.state.doc.length, insert: '😀é' } });
    await stale; assert.equal(h.inspect().status, 'pending'); assert.equal(h.inspect().discarded, 1);
    assert.equal(h.plugin.worker, worker); const before = text(h);
    await queued(worker.onmessage, { data: treeMessage(h) });
    assert.equal(h.inspect().status, 'ready'); assert.equal(h.inspect().completed, 1); assert.equal(text(h), before);
    return { workerReused: true, staleDiscarded: 1, validCompleted: 1, exactUtf16Text: true };
  });
  await run('all three callbacks queued before destroy have no effects after destroy', async () => {
    const h = make(), worker = h.plugin.worker, message = treeMessage(h);
    const pending = [queued(worker.onerror, { message: 'after destroy' }), queued(worker.onmessageerror, {}),
      queued(worker.onmessage, { data: message })];
    h.retire(); const status = h.inspect(), before = text(h);
    await Promise.all(pending); assert.deepEqual(h.inspect(), status); assert.equal(text(h), before);
    assert.equal(worker.terminated, true); assert.equal(h.plugin.worker, null); assert.equal(h.plugin.closed, true);
    return { closed: true, workerTerminated: true, status: status.status, error: status.error, allCallbacksInert: true };
  });
  return { identityRemoved, minify, passed: cases.filter(c => c.pass).length, total: cases.length,
    scope: 'Actual source ViewPlugin callbacks queued as Node microtasks with a MockWorker and real CM6 state/parser; no browser Worker delivery, GUI or app start', cases };
}
