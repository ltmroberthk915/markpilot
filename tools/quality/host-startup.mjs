// Run: node tools/quality/host-startup.mjs [--artifact <manifest>] [--out <empty directory>]
// Exact current source, headless only. No Electron, clipboard, GUI, or document IO.
// The complete renderer, main open transaction, synchronous receipt handler and
// DocumentStore are real. Disk, engine view, user choices and IPC are controlled.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const {DocumentStore, createSession} = require(path.join(root, 'MarkPilot-CM6/shell/document-store.js'));
const read = file => fs.readFileSync(path.join(root, 'MarkPilot-CM6', file), 'utf8');
const hostSource = read('renderer/host.js');
const mainSource = read('main.js');
const files = ['main.js', 'renderer/host.js', 'shell/document-store.js', 'shell/text-codec.js', 'shell/save-policy.js'];
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
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

function exactHandler(name) {
  const start = mainSource.indexOf(`handle('${name}',`);
  assert(start >= 0, 'handler exists: ' + name);
  const end = mainSource.indexOf('\n});', start);
  assert(end > start, 'handler terminator: ' + name);
  return mainSource.slice(start, end + 4);
}

function fixture({holdReady = false, holdPath = false, holdCandidate = false, themeReady = false} = {}) {
  const store = new DocumentStore(), S = createSession(), W = new EventEmitter();
  W.webContents = new EventEmitter(); W.webContents.id = 1; W.isDestroyed = W.webContents.isDestroyed = () => false;
  const e = {sender:W.webContents}, events = {}, calls = [], errors = [], readyReplies = [], pathReplies = [], candidates = [];
  const snapshots = new Map(), currentReply = deferred(), themeReply = deferred();
  const mainHandlers = {};
  let confirmChoice = () => true, composing = false, rejectReplace = false, epoch = 0, sourceRevision = 0;
  let resetCount = 0, currentCalls = 0, docPathCalls = 0, readyCalls = 0, text = null;
  const originalReset = store.reset.bind(store);
  store.reset = session => { resetCount++; return originalReset(session); };
  store.canonical = async file => file;
  store.snapshot = async file => {
    assert(snapshots.has(file), 'no real file IO allowed: ' + file);
    return snapshots.get(file).promise;
  };
  const sendTo = (_window, channel, payload) => {
    if (channel === 'doc' && events.onDoc) {
      if (holdCandidate && payload.loadKind === 'open') candidates.push(payload);
      else events.onDoc(payload);
    }
    return true;
  };
  // Execute the actual main prepare/accept/rollback transaction in a VM. The
  // document travels through the renderer's real onDoc handler; no stub calls
  // store.reset to simulate a successful acknowledgement.
  const registerMain = (name, fn) => { mainHandlers[name] = fn; };
  const mainContext=vm.createContext({documents:store, createSession, crypto, path, state:S, dbg(){}, handle:registerMain,
    require:createRequire(path.join(root,'MarkPilot-CM6/main.js')),
    ipcMain:{on:registerMain}, sessionOf:()=>S, windowOf:()=>W, activeWindow:()=>W, sendTo,
    syncPathUi(){}, pushRecent(){}, pdfActive:null, setTimeout, clearTimeout,
    process:{env:{}}, dialog:{showMessageBox:async()=>({response:await confirmChoice()?0:1}),showErrorBox:(...args)=>errors.push(args)},
    failure:(code,message)=>Object.assign(Error(message),{code})});
  const begin=mainSource.indexOf('async function confirmReplace('),end=mainSource.indexOf('/* ── IPC：file:reload',begin);
  assert(begin>=0&&end>begin,'actual main open transaction exists');
  vm.runInContext(mainSource.slice(begin,end)+'\n'+exactHandler('doc:ready')+'\n'+exactHandler('doc:path'),mainContext);
  const mpHost = {
    settingGet: key => Promise.resolve({ value: key === 'autosaveEnabled' ? false : 30000 }),
    themeGet: () => themeReply.promise,
    currentDoc: () => { currentCalls++; return currentReply.promise; },
    docReady: () => {
      readyCalls++;
      const result = mainHandlers['doc:ready'](e);
      if (!holdReady) return Promise.resolve(result);
      const d = deferred(); readyReplies.push({d, result}); return d.promise;
    },
    docPath: async (file, metadata) => {
      docPathCalls++;
      const result = await mainHandlers['doc:path'](e, file, metadata);
      if (!holdPath) return Promise.resolve(result);
      const d = deferred(); pathReplies.push({d, result}); return d.promise;
    },
    docDirty: (dirty, metadata) => ({ok:store.markDirty(S, {...metadata, dirty}),documentId:S.documentId,revision:S.revision,dirty:S.dirty}),
    commitOpen: request => {const event={sender:e.sender};mainHandlers['doc:commit-open'](event,request);return event.returnValue;},
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
  W.webContents.executeJavaScript = expression => Promise.resolve(vm.runInContext(expression,context));
  // This suffix only exposes read-only state and the existing command to tests.
  vm.runInContext(read('shell/save-policy.js'), context);
  vm.runInContext(hostSource + '\nglobalThis.inspect = () => ({booted,pendingDoc,filePath,documentId,revision,dirty,charCount}); globalThis.newDoc = newDocument;', context);
  if (themeReady) themeReply.resolve({dark: false});
  function register() {
    window.handler.on('open', ({content}) => {
      text = content; epoch++; sourceRevision=0; calls.push({kind: 'open', text});
      window.mpEngine = {focus() {}, getValue: () => text,
        commands:{capture:()=>composing?null:{epoch,sourceRevision},valid:ticket=>!!ticket&&ticket.epoch===epoch&&ticket.sourceRevision===sourceRevision,resume(){}},
        _view:()=>({composing}),isComposing:()=>composing,documentSession:()=>({epoch,sourceRevision}),
        checkpointDocument: () => { const previous={text,epoch,sourceRevision};let active=true;return {commit(){if(!active)return false;active=false;return true;},rollback(){if(!active)return false;active=false;({text,epoch,sourceRevision}=previous);return true;}}; }};
    }).on('setValue', value => {
      if (window.mpEngine) { text = value; sourceRevision++; calls.push({kind: 'setValue', text}); }
    }).on('replaceDocument', value => {
      if (window.mpEngine) { if(rejectReplace)return false;text = value; epoch++;sourceRevision=0;calls.push({kind: 'replaceDocument', text}); }
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
    newDoc: context.newDoc, confirm: fn => { confirmChoice=fn;window.confirm = fn; },candidates,
    deliver:()=>{assert.equal(candidates.length,1);events.onDoc(candidates.shift());}, setComposing:value=>{composing=value;},rejectReplacement:()=>{rejectReplace=true;},
    edit: value => { text = value; sourceRevision++;window.handler.emit('change', {len:value.length,epoch,sourceRevision}); },
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
  assert.equal(await h.newDoc(), true); assert.equal(h.resets, 0); assert.equal(h.S.loadRequest, 2);
  const newId = h.inspect().documentId; ready.d.resolve(ready.result); load.finish();
  assert.equal((await load.job).code, 'MP_DOC_MISMATCH'); await flush();
  assert.equal(h.text, ''); assert.equal(h.inspect().documentId, newId);
};
newCancelsTest.options = {holdReady: true};
await test('explicit new cancels old load while late blank ready cannot overwrite new id', newCancelsTest);
await test('stale discard confirmation cannot reset a subsequently pushed document', async h => {
  h.register(); h.receive(h.store.metadata(h.S)); h.edit('dirty A');
  const c = deferred();let asked=false;h.confirm(() => {asked=true;return c.promise;});const run = h.newDoc({replace:true});await flush();assert(asked,'entered actual main discard confirmation before changing owners');
  h.store.reset(h.S); h.S.filePath = 'D:/controlled/B.md'; h.S.savedText = 'B'; h.receive(h.store.metadata(h.S));
  c.resolve(true); assert.equal(await run, false); assert.equal(h.text, 'B');
  assert.equal(h.resets, 1); assert.equal(h.docPathCalls, 1);
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
const lateEditTest = async h => {
  h.register(); h.S.filePath='D:/controlled/A.md';h.S.savedText='A';h.receive(h.store.metadata(h.S));const id=h.S.documentId;
  const close=h.newDoc({replace:true});await flush();assert.equal(h.candidates.length,1,'candidate sent after prepare and confirmation');
  assert.equal(h.S.documentId,id,'preparation cannot reset the active session');
  h.edit('A newer');h.deliver();assert.equal(await close,false);assert.equal(h.S.documentId,id);assert.equal(h.inspect().documentId,id);
  assert.equal(h.text,'A newer');assert(h.S.dirty);assert(h.inspect().dirty);
};
lateEditTest.options={holdCandidate:true};
await test('new input after candidate send survives close-file handoff',lateEditTest);
const lateImeTest = async h => {
  h.register();h.receive(h.store.metadata(h.S));const id=h.S.documentId;
  const close=h.newDoc({replace:true});await flush();assert.equal(h.candidates.length,1);
  h.setComposing(true);h.deliver();assert.equal(await close,false);assert.equal(h.S.documentId,id);assert.equal(h.inspect().documentId,id);
};
lateImeTest.options={holdCandidate:true};
await test('composition beginning during blank handoff vetoes adoption',lateImeTest);
await test('canceling discard of an unnamed draft retains its owner and source',async h=>{
  h.register();h.receive(h.store.metadata(h.S));h.edit('untitled draft');const id=h.S.documentId;h.confirm(()=>false);
  assert.equal(await h.newDoc({replace:true}),false);assert.equal(h.S.documentId,id);assert.equal(h.inspect().documentId,id);assert.equal(h.text,'untitled draft');assert(h.S.dirty);
});
await test('failed blank apply rolls main and renderer back to the old document',async h=>{
  h.register();h.S.filePath='D:/controlled/A.md';h.S.savedText='A';h.receive(h.store.metadata(h.S));const id=h.S.documentId;
  h.rejectReplacement();assert.equal(await h.newDoc({replace:true}),false);assert.equal(h.S.documentId,id);assert.equal(h.inspect().documentId,id);assert.equal(h.text,'A');
});
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
  scope: 'exact renderer, main document transaction and DocumentStore; controlled IO/IPC/DOM; no product source rewrites or GUI',
  hashes, artifactMatches, passed: results.length === 18 && results.every(r=>r.passed), total: results.length, results,
};
if(options.out){const dir=require('./harness.cjs').outputDir(options.out,'host-startup');fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed?0:1;
