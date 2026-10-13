#!/usr/bin/env node
/* MODEL TESTS ONLY — not native/GUI evidence. Public production protocol checks.
 * Exercises the REAL production command-context.js (via file URL) against a real
 * CM6 EditorState, and the REAL host.js saveAsFlow extracted verbatim from the
 * current source by exact anchor + brace matching (never a copied implementation).
 * Free variables of the extracted function are supplied by a controlled scope. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'dsh-markpilot', 'src-cm6');
const HOST = path.join(ROOT, 'MarkPilot-CM6', 'renderer', 'host.js');
const CM = (p) => pathToFileURL(path.join(ROOT, 'dsh-markpilot', 'node_modules', '@codemirror', p)).href;

/* Minimal owner/document controls (test-owned, product untouched). */
let focusOn = true, activeEl = null;
const originalDocument = globalThis.document;
after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document=originalDocument; });

async function main() {
  const { EditorState } = await import(CM('state/dist/index.js'));
  const { history, undoDepth, redoDepth } = await import(CM('commands/dist/index.js'));
  const { createCommandContext, applySourceHistory } = await import(pathToFileURL(path.join(SRC, 'command-context.js')).href);
  // Let CM's modules initialize in their supported non-DOM environment first.
  globalThis.document = { hasFocus: () => focusOn, get activeElement() { return activeEl; }, addEventListener() {} };

  const newView = (doc) => {
    let st = EditorState.create({ doc, extensions: [history()] });
    const dispatches = [];
    return { dispatches, reset() { st = EditorState.create({ doc, extensions: [history()] }); },
      get state() { return st; }, dispatch(tr) { dispatches.push(tr); st = tr.state; },
      scrollDOM: { scrollTop: 0 } };
  };
  const rig = (view) => {
    let epoch = 1, ownerKind = 'cm', composingFlag = false, viewOn = true;
    const flushes = [], resumes = [];
    const cc = createCommandContext({
      getView: () => (viewOn ? view : null),
      epochOf: () => epoch,
      owner: () => ({ kind: ownerKind }),
      flushOwner: (o) => flushes.push(o.kind),
      resumeOwner: (o) => { resumes.push(o.kind); return true; },
      composing: () => composingFlag,
      cancelViewport: () => {},
    });
    const set = (patch) => { if ('epoch' in patch) epoch = patch.epoch;
      if ('ownerKind' in patch) ownerKind = patch.ownerKind;
      if ('composingFlag' in patch) composingFlag = patch.composingFlag;
      if ('viewOn' in patch) viewOn = patch.viewOn; };
    return { cc, flushes, resumes, set };
  };

  test('MODEL suspended cm/cell borrowed only same epoch+doc', () => {
    const v = newView('abc def'); const r = rig(v); const { cc } = r;
    r.set({ ownerKind: 'cm' }); cc.suspend();
    r.set({ ownerKind: 'none' });
    assert.equal(cc.capture({ flush: false }).owner.kind, 'cm', 'same epoch+doc borrows suspended cm');
    r.set({ ownerKind: 'cell' }); cc.suspend();
    r.set({ ownerKind: 'none' });
    assert.equal(cc.capture({ flush: false }).owner.kind, 'cell', 'suspended cell borrowed');
    v.dispatch(v.state.update({ changes: { from: 0, insert: 'X' } }));
    cc.changed({ docChanged: true, selectionSet: false });
    assert.equal(cc.capture({ flush: false }).owner.kind, 'none', 'doc change clears suspension');
    r.set({ ownerKind: 'cm' }); cc.suspend(); r.set({ ownerKind: 'none', epoch: 2 });
    assert.equal(cc.capture({ flush: false }).owner.kind, 'none', 'epoch change blocks borrow');
  });

  test('MODEL allowSuspended:false cannot resurrect', () => {
    const v = newView('abc'); const r = rig(v); const { cc } = r;
    r.set({ ownerKind: 'cm' }); cc.suspend(); r.set({ ownerKind: 'none' });
    assert.equal(cc.capture({ allowSuspended: false }).owner.kind, 'none');
  });

  test('MODEL composition capture denies destructive commands', () => {
    const v = newView('abc'); const r = rig(v); const { cc } = r;
    let ran = 0;
    r.set({ composingFlag: true });
    assert.equal(cc.capture(), null);
    assert.equal(cc.run(() => { ran++; return true; }), false);
    assert.equal(ran, 0, 'destructive action never ran');
  });

  test('MODEL resume guards: foreground/native INPUT/new intent/epoch', () => {
    const v = newView('abc'); const r = rig(v); const { cc } = r;
    r.set({ ownerKind: 'cm' });
    const t = cc.capture({ flush: false });
    focusOn = false; assert.equal(cc.resume(t), false); focusOn = true;
    activeEl = { tagName: 'INPUT' }; assert.equal(cc.resume(t), false); activeEl = null;
    cc.invalidate(); assert.equal(cc.resume(t), false, 'serial bump (trusted intent) blocks old ticket');
    const t2 = cc.capture({ flush: false });
    r.set({ epoch: 2 }); assert.equal(cc.resume(t2), false, 'doc/engine epoch replacement blocks old resume');
    r.set({ epoch: 1 });
    assert.equal(cc.resume(t2), true); assert.deepEqual(r.resumes, ['cm']);
    assert.equal(cc.resume({ ...t2, owner: { kind: 'native' } }), false, 'native owner never resumed');
  });

  test('MODEL command focus creates no content/history', () => {
    const v = newView('hello region world'); const r = rig(v); const { cc } = r;
    const doc0 = v.state.doc, d0 = undoDepth(v.state);
    let focused = 0;
    cc.run(() => { focused++; });
    assert.ok(focused === 1 && v.dispatches.length === 0 && v.state.doc === doc0 && undoDepth(v.state) === d0,
      'run+resume dispatched nothing; doc/history untouched');
    v.dispatch(v.state.update({ changes: { from: 6, to: 12, insert: 'image' }, userEvent: 'input.type' }));
    assert.equal(undoDepth(v.state), 1);
    assert.equal(applySourceHistory(v, 'undo'), true);
    assert.equal(v.state.doc.toString(), 'hello region world');
    assert.equal(undoDepth(v.state), 0); assert.equal(redoDepth(v.state), 1);
    const docChanging = v.dispatches.filter((tr) => tr.docChanged);
    assert.equal(docChanging.length, 2, 'only the edit and the undo changed the doc');
  });

  test('MODEL cell owner flushes on capture', () => {
    const v = newView('abc'); const r = rig(v); const { cc } = r;
    r.set({ ownerKind: 'cell' });
    const t = cc.capture();
    assert.equal(t.owner.kind, 'cell'); assert.deepEqual(r.flushes, ['cell']);
    assert.equal(cc.resume(t), true); assert.deepEqual(r.resumes, ['cell']);
  });

  /* ── REAL saveAsFlow, extracted by exact anchor from current host.js ── */
  const hostSrc = fs.readFileSync(HOST, 'utf8');
  const anchor = 'async function saveAsFlow() {';
  const start = hostSrc.indexOf(anchor);
  assert.ok(start > 0, 'saveAsFlow anchor found');
  let depth = 0, end = -1;
  for (let i = start; i < hostSrc.length; i++) {
    if (hostSrc[i] === '{') depth++;
    else if (hostSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const fnSrc = hostSrc.slice(start, end + 1);
  assert.ok(/operation === saveAsSerial/.test(fnSrc) && /document\.hasFocus\(\)/.test(fnSrc)
    && /commands\.capture\(\{allowSuspended:false\}\)/.test(fnSrc), 'extraction sanity markers');

  function makeHost(env) {
    return new Function('env', '"use strict";\n' +
      'let saveAsSerial = 0, documentId = env.documentId, filePath = env.filePath, saveTask = null;\n' +
      'const window = env.window, document = env.document, saveTrace = env.saveTrace, saveFailure = env.saveFailure;\n' +
      'const doSave = env.doSave;\n' +
      'const saveAsFlow = ' + fnSrc + ';\n' +
      'return { saveAsFlow, snapshot: () => ({ saveAsSerial, documentId }),' +
      ' bumpDoc: (v) => { documentId = v; }, setSaveTask: (p) => { saveTask = p; } };')(env);
  }
  const makeEnv = () => {
    const v = newView('doc body'); const r = rig(v); r.set({ ownerKind: 'cm' });
    const failures = [];
    const env = { documentId: 'd1', filePath: null, window: { mpEngine: { commands: r.cc }, mpHost: {} },
      document: globalThis.document, saveTrace: () => {}, saveFailure: (e) => failures.push(e), doSave: async () => true };
    return { env, failures, ...r, view: v };
  };

  test('MODEL saveAsFlow success/cancel/grant-reject/save-failure/throw -> exactly one finally resume', async () => {
    const cases = [
      { name: 'success', saveAs: { ok: true, filePath: 'C:/a.md' }, doSave: async () => true, expect: true, failures: 0 },
      { name: 'cancel', saveAs: { ok: false }, doSave: async () => true, expect: false, failures: 0 },
      { name: 'grant reject', saveAs: { ok: false, error: 'denied' }, doSave: async () => true, expect: false, failures: 1 },
      { name: 'save failure', saveAs: { ok: true, filePath: 'C:/a.md' }, doSave: async () => false, expect: false, failures: 0 },
      { name: 'throw', saveAs: null, doSave: async () => true, expect: false, failures: 1 },
    ];
    for (const c of cases) {
      const m = makeEnv();
      m.env.window.mpHost.saveAs = c.saveAs ? async () => c.saveAs : async () => { throw new Error('boom'); };
      m.env.doSave = c.doSave;
      focusOn = true; activeEl = null;
      const h = makeHost(m.env);
      assert.equal(await h.saveAsFlow(), c.expect, c.name);
      assert.equal(m.resumes.length, 1, c.name + ': exactly one resume attempt');
      assert.deepEqual(m.resumes, ['cm'], c.name);
      assert.equal(m.failures.length, c.failures, c.name + ' failure count');
      assert.equal(h.snapshot().saveAsSerial, 1, c.name + ' serial advanced once');
    }
  });

  test('MODEL capture at ENTRY before pending save awaits', async () => {
    const m = makeEnv();
    const order = [];
    const proxyCommands = new Proxy(m.cc, { get(t, k) {
      if (k === 'capture') return (...a) => { order.push('capture'); return t.capture(...a); };
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    m.env.window.mpEngine = { commands: proxyCommands };
    let resolvePending; const pending = new Promise((res) => { resolvePending = res; });
    let gate; const gatedSaveAs = new Promise((res) => { gate = res; });
    m.env.window.mpHost.saveAs = async () => { order.push('saveAs-enter'); await gatedSaveAs; return { ok: true, filePath: 'C:/b.md' }; };
    const h = makeHost(m.env);
    h.setSaveTask(pending);
    const p = h.saveAsFlow();
    assert.deepEqual(order, ['capture'], 'capture is strictly first, before saveTask/saveAs awaits');
    gate({}); resolvePending();
    await p;
    assert.equal(m.resumes.length, 1);
  });

  test('MODEL replacement or newer focus intent prevents a stale Save As resume', async () => {
    // doc replacement mid-flight
    {
      const m = makeEnv();
      let gate; m.env.window.mpHost.saveAs = () => new Promise((res) => { gate = res; });
      const h = makeHost(m.env);
      const a = h.saveAsFlow();
      h.bumpDoc('d2');                                   // replaceDocument: new doc identity
      gate({ ok: true, filePath: 'C:/c.md' });
      assert.equal(await a, false);
      assert.equal(m.resumes.length, 0, 'replaced document: no resume');
    }
    // engine replacement mid-flight
    {
      const m = makeEnv();
      let gate; m.env.window.mpHost.saveAs = () => new Promise((res) => { gate = res; });
      const h = makeHost(m.env);
      const a = h.saveAsFlow();
      m.env.window.mpEngine = {};                        // engine swapped under us
      gate({ ok: true, filePath: 'C:/d.md' });
      assert.equal(await a, true, 'save itself completed; only the resume is suppressed');
      assert.equal(m.resumes.length, 0, 'engine replaced: no resume');
    }
    // foreground loss at finally
    {
      const m = makeEnv();
      m.env.window.mpHost.saveAs = async () => ({ ok: true, filePath: 'C:/e.md' });
      focusOn = false;
      await makeHost(m.env).saveAsFlow();
      assert.equal(m.resumes.length, 0, 'foreground lost: no resume');
      focusOn = true;
    }
    // newer trusted intent (serial bump) -> finally re-captures CURRENT owner; native kept
    {
      const m = makeEnv();
      m.env.window.mpHost.saveAs = async () => ({ ok: true, filePath: 'C:/f.md' });
      const h = makeHost(m.env);
      const p = h.saveAsFlow();
      m.cc.invalidate();                                 // trusted beforeinput-equivalent
      m.set({ ownerKind: 'native' });                    // current real owner is a native INPUT
      await p;
      assert.equal(m.resumes.length, 0, 'current native owner kept, never resumed into cm');
    }
    // serial bump but current owner still cm -> fresh ticket resumes once
    {
      const m = makeEnv();
      m.env.window.mpHost.saveAs = async () => ({ ok: true, filePath: 'C:/g.md' });
      const h = makeHost(m.env);
      const p = h.saveAsFlow();
      m.cc.invalidate();
      await p;
      assert.equal(m.resumes.length, 1, 'fresh capture({allowSuspended:false}) resumes current cm owner');
    }
  });
  test('MODEL two overlapping Save As calls keep the newer path and suppress an older late grant', async () => {
    const m=makeEnv(),pending=[],saved=[];
    m.env.window.mpHost.saveAs=()=>new Promise(resolve=>pending.push(resolve));
    m.env.doSave=async (_force,grant)=>{saved.push(grant.filePath);return true;};
    const h=makeHost(m.env),older=h.saveAsFlow(),newer=h.saveAsFlow();assert.equal(pending.length,2);
    pending[1]({ok:true,filePath:'newer.md'});assert.equal(await newer,true);
    pending[0]({ok:true,filePath:'older.md'});const oldResult=await older;
    assert.deepEqual(saved,['newer.md'],'a late older grant cannot redirect the current document');
    assert.equal(oldResult,false);assert.deepEqual(m.resumes,['cm'],'only the current operation resumes');
  });
  test('MODEL a newer geometry intent with BODY cannot resurrect a suspended Save As owner',async()=>{
    const m=makeEnv();m.cc.suspend();m.set({ownerKind:'none'});
    let finish;m.env.window.mpHost.saveAs=()=>new Promise(resolve=>finish=resolve);
    const h=makeHost(m.env),pending=h.saveAsFlow();m.cc.geometryIntent();
    finish({ok:true,filePath:'current.md'});await pending;assert.deepEqual(m.resumes,[]);
  });
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
