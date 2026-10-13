// Run: node tools/quality/host-startup.mjs [--artifact <manifest>] [--out <empty directory>]
// Exact current source, headless only. No Electron, clipboard, GUI, or document IO.
// DocumentStore.load/reset and the complete renderer host are real. DOM, timers,
// disk snapshots, and IPC delivery are controlled. No candidate source rewrites.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const {DocumentStore, createSession} = require(path.join(root, 'MarkPilot-CM6/shell/document-store.js'));
const read = file => fs.readFileSync(path.join(root, 'MarkPilot-CM6', file), 'utf8');
const hostSource = read('renderer/host.js');
const mainSource = read('main.js');
const files = ['main.js', 'renderer/host.js', 'shell/document-store.js', 'shell/text-codec.js'];
const hashes = Object.fromEntries(files.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'MarkPilot-CM6', file))).digest('hex')]));
const options={};
for(let i=2;i<process.argv.length;i+=2){
  if(!['--artifact','--out'].includes(process.argv[i])||!process.argv[i+1])throw new Error('Use --artifact <manifest> --out <empty directory>');
  options[process.argv[i].slice(2)]=path.resolve(process.argv[i+1]);
}
const artifactFile = options.artifact;
let artifactMatches = null;
if (artifactFile) {
  const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  for (const file of files) assert.equal(hashes[file], artifact.files.find(entry => entry.file === file)?.sha256.toLowerCase(), 'canonical artifact hash: ' + file);
  artifactMatches = true;
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function exactHandler(name) {
  const start = mainSource.indexOf(`handle('${name}',`);
  assert(start >= 0, 'handler exists: ' + name);
  const end = mainSource.indexOf('\n});', start);
  assert(end > start, 'handler terminator: ' + name);
  return mainSource.slice(start, end + 4);
}

function fixture({holdReady = false, holdPath = false, themeReady = false} = {}) {
  const store = new DocumentStore(), S = createSession(), W = {__pendingClose: null};
  const e = {sender: {id: 1}}, events = {}, calls = [], errors = [], readyReplies = [], pathReplies = [];
  const snapshots = new Map(), currentReply = deferred(), themeReply = deferred();
  const mainHandlers = {};
  let resetCount = 0, currentCalls = 0, docPathCalls = 0, readyCalls = 0, text = null;
  const originalReset = store.reset.bind(store);
  store.reset = session => { resetCount++; return originalReset(session); };
  store.canonical = async file => file;
  store.snapshot = async file => {
    assert(snapshots.has(file), 'no real file IO allowed: ' + file);
    return snapshots.get(file).promise;
  };
  const sendTo = (_window, channel, payload) => {
    if (channel === 'doc' && events.onDoc) events.onDoc(payload);
    return true;
  };
  // Only these current main handlers are evaluated; importing main would launch Electron.
  new Function('handle', 'documents', 'sessionOf', 'windowOf', 'sendTo', 'syncPathUi', 'pdfActive',
    exactHandler('doc:ready') + '\n' + exactHandler('doc:path'))(
    (name, fn) => { mainHandlers[name] = fn; }, store, () => S, () => W, sendTo, () => {}, null);
  const mpHost = {
    themeGet: () => themeReply.promise,
    currentDoc: () => { currentCalls++; return currentReply.promise; },
    docReady: () => {
      readyCalls++;
      const result = mainHandlers['doc:ready'](e);
      if (!holdReady) return Promise.resolve(result);
      const d = deferred(); readyReplies.push({d, result}); return d.promise;
    },
    docPath: (file, metadata) => {
      docPathCalls++;
      const result = mainHandlers['doc:path'](e, file, metadata);
      if (!holdPath) return Promise.resolve(result);
      const d = deferred(); pathReplies.push({d, result}); return d.promise;
    },
    docDirty: (dirty, metadata) => store.markDirty(S, {...metadata, dirty}),
    onDoc: fn => { events.onDoc = fn; },
    onMenu: fn => { events.onMenu = fn; },
    onTheme: fn => { events.onTheme = fn; },
    onExportProgress: fn => { events.onExportProgress = fn; },
    onExportMakeHtml: fn => { events.onExportMakeHtml = fn; },
  };
  const window = {mpHost, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, confirm: () => true};
  const context = vm.createContext({
    window,
    document: {getElementById: () => null, title: '', createElement: () => ({}),
      addEventListener() {}, removeEventListener() {}, hasFocus: () => true},
    localStorage: {getItem: () => null}, CustomEvent: class {},
    console: {log() {}, error: (...args) => errors.push(args)},
    setTimeout: () => 0, clearTimeout() {}, Date,
  });
  // This suffix only exposes read-only state and the existing command to tests.
  vm.runInContext(hostSource + '\nglobalThis.inspect = () => ({booted,pendingDoc,filePath,documentId,revision,dirty,charCount}); globalThis.newDoc = newDocument;', context);
  if (themeReady) themeReply.resolve({dark: false});
  function register() {
    window.handler.on('open', ({content}) => {
      text = content; calls.push({kind: 'open', text});
      window.mpEngine = {focus() {}, getValue: () => text};
    }).on('setValue', value => {
      if (window.mpEngine) { text = value; calls.push({kind: 'setValue', text}); }
    }).on('replaceDocument', value => {
      if (window.mpEngine) { text = value; calls.push({kind: 'replaceDocument', text}); }
    });
  }
  function startLoad(file, body) {
    const d = deferred(); assert(!snapshots.has(file)); snapshots.set(file, d);
    const job = store.load(S, file).then(doc => {
      sendTo(W, 'doc', doc); return {ok: true, doc};
    }, err => ({ok: false, code: err.code}));
    return {
      finish: () => d.resolve({bytes: Buffer.from(body), baseline: {
        mtimeMs: 0, sha256: 'controlled-memory', size: Buffer.byteLength(body), nlink: 1,
      }}), job,
    };
  }
  return {
    store, S, e, W, events, mpHost, calls, errors, register, startLoad, currentReply, themeReply, readyReplies, pathReplies,
    init: () => window.handler.emit('init'), receive: doc => events.onDoc(doc), inspect: context.inspect,
    newDoc: context.newDoc, confirm: fn => { window.confirm = fn; },
    edit: value => { text = value; window.handler.emit('change', {len: value.length}); },
    get text() { return text; }, get resets() { return resetCount; },
    get currentCalls() { return currentCalls; }, get docPathCalls() { return docPathCalls; },
    get readyCalls() { return readyCalls; },
  };
}

const results = [];
async function test(name, run) {
  const h = fixture(run.options);
  await run(h);
  await flush();
  assert.equal(h.errors.length, 0, 'host must not swallow exceptions: ' + name);
  results.push({name, passed: true});
}

await test('blank startup reads its real identity with zero reset or doc:path', async h => {
  h.register(); const id = h.S.documentId; h.init(); await flush();
  assert.equal(h.text, ''); assert.equal(h.inspect().documentId, id);
  assert.equal(h.resets, 0); assert.equal(h.docPathCalls, 0); assert.equal(h.readyCalls, 1);
});
await test('ready first keeps a pending real load alive, then applies loaded id/text', async h => {
  h.register(); const id = h.S.documentId;
  const load = h.startLoad('D:/controlled/A.md', 'A body'); await flush();
  h.init(); await flush(); assert.equal(h.S.loadRequest, 1); assert.equal(h.resets, 0);
  assert.equal(h.text, ''); assert.equal(h.inspect().documentId, id);
  load.finish(); assert((await load.job).ok); assert.equal(h.text, 'A body');
  assert.equal(h.inspect().documentId, h.S.documentId); assert.notEqual(h.S.documentId, id);
});
const lateReadyTest = async h => {
  h.register(); h.init(); await flush(); assert.equal(h.readyReplies.length, 1);
  const load = h.startLoad('D:/controlled/A.md', 'A body'); await flush(); load.finish();
  assert((await load.job).ok); h.readyReplies[0].d.resolve(h.readyReplies[0].result); await flush();
  assert.equal(h.text, 'A body'); assert.equal(h.inspect().documentId, h.S.documentId); assert.equal(h.resets, 0);
};
lateReadyTest.options = {holdReady: true};
await test('loaded first ignores an already captured late blank ready reply', lateReadyTest);
await test('pre-engine doc remains pending until init creates engine once', async h => {
  const load = h.startLoad('D:/controlled/A.md', 'A body'); await flush(); load.finish(); assert((await load.job).ok);
  assert.equal(h.inspect().booted, false); assert.equal(h.inspect().pendingDoc.text, 'A body'); assert.equal(h.calls.length, 0);
  h.register(); h.init(); await flush(); assert.equal(h.text, 'A body');
  assert.equal(h.calls.filter(c => c.kind === 'open').length, 1); assert.equal(h.readyCalls, 0);
});
await test('latest pre-engine authoritative push wins over previous pending push', async h => {
  h.receive({...h.store.metadata(h.S), documentId: 'old-A', text: 'A'});
  h.S.documentId = 'new-B'; h.S.filePath = 'D:/controlled/B.md'; h.S.savedText = 'B';
  h.receive(h.store.metadata(h.S)); h.register(); h.init();
  assert.equal(h.text, 'B'); assert.equal(h.inspect().documentId, 'new-B'); assert.equal(h.readyCalls, 0);
});
const noPullTest = async h => {
  await flush(); assert.equal(h.currentCalls, 0);
  h.S.documentId = 'new-B'; h.S.filePath = 'D:/controlled/B.md'; h.S.savedText = 'B newer';
  h.receive(h.store.metadata(h.S));
  h.currentReply.resolve({documentId: 'old-A', text: 'A old', filePath: 'D:/controlled/A.md'}); await flush();
  h.register(); h.init(); assert.equal(h.text, 'B newer'); assert.equal(h.inspect().documentId, 'new-B');
  assert.equal(h.currentCalls, 0);
};
noPullTest.options = {themeReady: true};
await test('theme initialization has no second currentDoc pull or stale pending overwrite', noPullTest);
const newCancelsTest = async h => {
  h.register(); h.init(); const ready = h.readyReplies[0];
  h.receive(h.store.metadata(h.S));
  const load = h.startLoad('D:/controlled/A.md', 'A body'); await flush(); assert.equal(h.S.loadRequest, 1);
  assert.equal(await h.newDoc(), true); assert.equal(h.resets, 1); assert.equal(h.S.loadRequest, 2);
  const newId = h.inspect().documentId; ready.d.resolve(ready.result); load.finish();
  assert.equal((await load.job).code, 'MP_DOC_MISMATCH'); await flush();
  assert.equal(h.text, ''); assert.equal(h.inspect().documentId, newId);
};
newCancelsTest.options = {holdReady: true};
await test('explicit new cancels old load while late blank ready cannot overwrite new id', newCancelsTest);
await test('stale discard confirmation cannot reset a subsequently pushed document', async h => {
  h.register(); h.receive(h.store.metadata(h.S)); h.edit('dirty A');
  const c = deferred(); h.confirm(() => c.promise); const run = h.newDoc();
  h.store.reset(h.S); h.S.filePath = 'D:/controlled/B.md'; h.S.savedText = 'B'; h.receive(h.store.metadata(h.S));
  c.resolve(true); assert.equal(await run, false); assert.equal(h.text, 'B');
  assert.equal(h.resets, 1); assert.equal(h.docPathCalls, 0);
});
await test('main null reset rejects missing/old id even with explicit=true', async h => {
  const id = h.S.documentId;
  for (const metadata of [undefined, {}, {documentId: null}, {documentId: 'old', explicit: true}, {explicit: true}]) {
    const result = await h.mpHost.docPath(null, metadata);
    assert.equal(result.ok, false); assert.equal(result.code, 'MP_DOC_MISMATCH'); assert.equal(h.S.documentId, id);
  }
  assert.equal(h.resets, 0);
});
const delayedNewTest = async h => {
  h.register(); h.receive(h.store.metadata(h.S)); const run = h.newDoc(); await flush();
  assert.equal(h.pathReplies.length, 1);
  h.store.reset(h.S); h.S.filePath = 'D:/controlled/B.md'; h.S.savedText = 'B newer'; h.receive(h.store.metadata(h.S));
  h.pathReplies[0].d.resolve(h.pathReplies[0].result);
  assert.equal(await run, false); assert.equal(h.text, 'B newer'); assert.equal(h.inspect().documentId, h.S.documentId);
};
delayedNewTest.options = {holdPath: true};
await test('delayed successful new reply cannot apply its blank content over newer B', delayedNewTest);
await test('clean file ready still pushes and returns complete owner metadata', async h => {
  h.S.filePath = 'D:/controlled/A.md'; h.S.savedText = 'A saved'; h.S.revision = 7; h.S.lastSavedRevision = 7;
  const id = h.S.documentId; h.register(); h.init(); await flush();
  assert.equal(h.text, 'A saved'); assert.equal(h.inspect().documentId, id); assert.equal(h.inspect().revision, 7);
  assert.equal(h.calls.filter(c => c.kind === 'open').length, 1);
  assert.equal(h.resets, 0); assert.equal(h.docPathCalls, 0);
  h.S.dirty = true; const count = h.calls.length, doc = await h.mpHost.docReady();
  assert.equal(h.calls.length, count, 'dirty file must not push saved text');
  assert.equal(doc.documentId, id); assert.equal(doc.revision, 7); assert.equal(doc.text, 'A saved');
});
await test('A-to-B loadRequest protection still cancels A and allows B', async h => {
  h.register(); const a = h.startLoad('D:/controlled/A.md', 'A'); await flush();
  const b = h.startLoad('D:/controlled/B.md', 'B'); await flush(); h.init(); await flush();
  assert.equal(h.S.loadRequest, 2); assert.equal(h.resets, 0);
  b.finish(); assert((await b.job).ok); a.finish(); assert.equal((await a.job).code, 'MP_DOC_MISMATCH');
  assert.equal(h.text, 'B'); assert.equal(h.inspect().documentId, h.S.documentId);
});
await test('post-boot authoritative opens replace even identical bytes without booting again', async h => {
  h.register(); h.init(); await flush();
  for(const documentId of ['A','B','B-reopen']){
    h.receive({...h.store.metadata(h.S),documentId,filePath:'D:/controlled/same.md',text:'same body'});
    assert.equal(h.calls.at(-1).kind,'replaceDocument');assert.equal(h.text,'same body');
    assert.equal(h.inspect().documentId,documentId);
  }
  assert.equal(h.calls.filter(c=>c.kind==='open').length,1);
});
await test('only explicit reload keeps the incremental setValue protocol despite a fresh identity', async h => {
  h.register(); h.init(); await flush();
  h.receive({...h.store.metadata(h.S),documentId:'reloaded-id',text:'reloaded body',loadKind:'reload'});
  assert.equal(h.calls.at(-1).kind,'setValue');assert.equal(h.text,'reloaded body');
  assert.equal(h.inspect().documentId,'reloaded-id');
  h.receive({...h.store.metadata(h.S),documentId:'new-id',text:'reloaded body'});
  assert.equal(h.calls.at(-1).kind,'replaceDocument');
});

const report = { schema:1, at:new Date().toISOString(),
  scope: 'exact disk host and main handlers; real DocumentStore.load/reset; controlled IO/IPC/DOM; no source rewrites or GUI',
  hashes, artifactMatches, passed: results.length === 14 && results.every(r=>r.passed), total: results.length, results,
};
if(options.out){const dir=require('./harness.cjs').outputDir(options.out,'host-startup');fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed?0:1;
