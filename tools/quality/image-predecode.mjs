// Run: node tools/quality/image-predecode.mjs [--artifact <artifact.json>] [--out <empty directory>]
// Prerequisite: install the locked editor dependencies, without running scripts:
// npm ci --prefix dsh-markpilot --ignore-scripts --legacy-peer-deps --no-audit --no-fund
// Exact source/helper extraction and real CM6 State/history; controlled model only.
// Image, FileReader, clock, host replies and saved-file records are test doubles.
// No Electron, DOM view, clipboard, browser image decode, services or file save.
// This checks cancellation/commit/cleanup contracts, not image pixels or viewport
// visibility. Model checks must not be added to actual GUI acceptance counts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const usage = 'node tools/quality/image-predecode.mjs [--artifact <artifact.json>] [--out <empty directory>]';
function parseOptions(args) {
  const parsed = {};
  if (args.length === 1 && args[0] === '--help') return {help: true};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--artifact', '--out'].includes(flag) || !value || value.startsWith('--')) throw new Error('Usage: ' + usage);
    const key = flag.slice(2);
    if (parsed[key]) throw new Error('Duplicate option: ' + flag);
    parsed[key] = path.resolve(value);
  }
  return parsed;
}
function checkOutputEmpty(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length) throw new Error('Output directory must be empty');
}
function writeOutput(dir, report) {
  fs.mkdirSync(dir, {recursive: true});
  checkOutputEmpty(dir);
  fs.writeFileSync(path.join(dir, 'quality-run.json'), JSON.stringify({owner: 'markpilot-quality', schema: 1}), {flag: 'wx'});
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
}
const options = parseOptions(process.argv.slice(2));
if (options.help) {
  console.log(usage + '\nInstall locked editor dependencies first. Headless state model only; no GUI or clipboard.');
  process.exit(0);
}
checkOutputEmpty(options.out);
for (const name of ['state', 'commands']) {
  assert(fs.existsSync(path.join(root, 'dsh-markpilot/node_modules/@codemirror', name, 'dist/index.js')),
    'Install locked editor dependencies first: npm ci --prefix dsh-markpilot --ignore-scripts --legacy-peer-deps --no-audit --no-fund');
}
const {EditorState, StateEffect, Transaction} = await load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js');
const {history, undo} = await load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js');
const {imageInsertions, reserveImageInsertion, cancelImageInsertions} = await load('dsh-markpilot/src-cm6/image-insertion.js');
const {resolveImageSource} = await load('dsh-markpilot/src-cm6/image-path.js');
const extras = fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6/extras.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
const start = extras.indexOf('  const fileToBase64 =');
const end = extras.indexOf('\n  /** 位图粘贴入口', start);
assert(start >= 0 && end > start, 'exact helper/function source boundaries');
const insertionSource = extras.slice(start, end);
assert(insertionSource.includes('async function insertImageFile('));
assert(insertionSource.includes('image.src = imageSource(src)'));
assert(/imageSource:\s*mpImgSrc/.test(main), 'widget source resolver injected into extras');
const resolverSource = main.match(/function mpImgSrc\(src\) \{[\s\S]*?\n\}/)?.[0];
assert(resolverSource, 'exact main image resolver');
const sourceHashes = Object.fromEntries(['main.js', 'extras.js', 'image-insertion.js', 'image-path.js'].map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6', file))).digest('hex')]));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const product = JSON.parse(fs.readFileSync(path.join(root, 'MarkPilot-CM6/package.json'), 'utf8'));
const dependencies = Object.fromEntries(['state', 'commands'].map(name => [name,
  JSON.parse(fs.readFileSync(path.join(root, 'dsh-markpilot/node_modules/@codemirror', name, 'package.json'), 'utf8')).version]));
const lockFile = path.join(root, 'dsh-markpilot/package-lock.json');
const lockSha256 = fs.existsSync(lockFile) ? digest(lockFile) : null;
const coreFiles = ['main.js', 'preload.js', 'renderer/host.js', 'shell/document-store.js',
  'shell/text-codec.js', 'renderer/cm6/app.js', 'renderer/cm6/markdown-worker.js'];
const coreHashes = Object.fromEntries(coreFiles.map(file => {
  const target = path.join(root, 'MarkPilot-CM6', file);
  return [file, fs.existsSync(target) ? digest(target) : null];
}));
const bundleHash = coreHashes['renderer/cm6/app.js'];
let artifactMatches = null, artifactIdentity = null;
if (options.artifact) {
  const manifest = JSON.parse(fs.readFileSync(options.artifact, 'utf8'));
  assert(Array.isArray(manifest.files), 'Artifact manifest must contain a files array');
  for (const file of coreFiles) {
    const rows = manifest.files.filter(entry => entry?.file === file);
    assert.equal(rows.length, 1, 'Artifact must identify exactly one core file: ' + file);
    assert.match(rows[0].sha256 || '', /^[a-f0-9]{64}$/i, 'Artifact SHA256: ' + file);
    assert(coreHashes[file], 'Artifact comparison requires the existing core file: ' + file);
    assert.equal(coreHashes[file], rows[0].sha256.toLowerCase(), 'Artifact core file differs: ' + file);
  }
  if (manifest.version != null) assert.equal(manifest.version, product.version, 'Artifact and source app versions differ');
  for (const key of ['exeSha256', 'asarSha256']) {
    if (manifest[key] != null) assert.match(manifest[key], /^[a-f0-9]{64}$/i, 'Artifact identity: ' + key);
  }
  // Deliberately omit executable/manifest absolute paths. EXE/ASAR hashes are
  // declarations here; only the enumerated checkout core files are rehashed.
  artifactIdentity = {
    manifestSha256: digest(options.artifact),
    version: manifest.version ?? null,
    exeSha256: manifest.exeSha256?.toLowerCase() ?? null,
    asarSha256: manifest.asarSha256?.toLowerCase() ?? null,
    checkedCoreFiles: coreFiles,
    nativeBinaryHashesVerified: false,
  };
  artifactMatches = true;
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const fixture = (mode = 'assets') => {
  const documentDir = 'C:/model-docs/\u6587\u6863 #%()';
  const now = {filePath: documentDir + '/note.md', documentId: 'A'};
  const images = [], messages = [], saved = [], resolvedSources = [], timerRecords = [], clearRecords = [], transactions = [];
  const timers = new Map(); let nextTimer = 1;
  const setTimeout = (fn, ms) => { const id = nextTimer++; const record = {id, ms, fn}; timers.set(id, record); timerRecords.push(record); return id; };
  const clearTimeout = id => { clearRecords.push(id); timers.delete(id); };
  function makeView(doc = 'head') {
    const view = {state: EditorState.create({doc, selection: {anchor: doc.length}, extensions: [imageInsertions, history()]}), transactions: []};
    view.dispatch = spec => { const tr = view.state.update(spec); view.state = tr.state; view.transactions.push(tr); transactions.push({view, tr}); };
    return view;
  }
  const view = makeView(); let activeView = view;
  class Image {
    constructor() { this.assignments = []; this.gate = deferred(); images.push(this); }
    set src(value) { this.assignments.push(value); this.value = value; }
    get src() { return this.value; }
    decode() { return this.gate.promise; }
  }
  class FileReader {
    readAsDataURL(file) {
      this.result = 'data:' + file.type + ';base64,' + file.base64;
      Promise.resolve().then(() => this.onload());
    }
    abort() { this.onabort?.(); }
  }
  const imageSource = new Function('resolveImageSource', 'directory', 'let mpDocDir = directory;\n' + resolverSource + '\nreturn mpImgSrc;')(resolveImageSource, documentDir);
  const host = {
    docInfo: () => Promise.resolve({...now}),
    saveImageToAssets: payload => {
      const bytes = Buffer.from(payload.base64, 'base64').length;
      const relPath = 'assets/' + (saved.length ? 'second.png' : 'pasted-image.png');
      saved.push({relPath, bytes, documentId: now.documentId});
      return Promise.resolve({ok: true, relPath, bytes});
    },
  };
  const insertImageFile = new Function('reserveImageInsertion', 'getView', 'window', 'document', 'toast', 'inFrontMatter', 'imageModeOf', 'Image', 'FileReader', 'setTimeout', 'clearTimeout', 'imageSource',
    insertionSource + '\nreturn insertImageFile;')(
    reserveImageInsertion, () => activeView, {mpHost: host}, {activeElement: null}, text => messages.push(text),
    () => false, () => mode, Image, FileReader, setTimeout, clearTimeout,
    src => { const resolved = imageSource(src); resolvedSources.push({src, resolved}); return resolved; });
  const file = (label = 'A') => ({type: 'image/png', base64: Buffer.from('controlled-' + label).toString('base64')});
  return {
    view, now, images, messages, saved, resolvedSources, timers, timerRecords, clearRecords, transactions, insert: (label = 'A') => insertImageFile(file(label)),
    switchView: () => { activeView = makeView('B'); return activeView; },
    reset: () => view.dispatch({effects: cancelImageInsertions.of(null), annotations: Transaction.addToHistory.of(false)}),
    fireDecodeTimeout: () => {
      const matches = [...timers.values()].filter(timer => timer.ms === 10000);
      assert.equal(matches.length, 1, 'exactly one live 10-second decode timer');
      const timer = matches[0]; timers.delete(timer.id); timer.fn(); return timer.id;
    },
    commits: () => transactions.filter(({tr}) => tr.docChanged && tr.isUserEvent('input.paste')),
  };
};
function checkCleanup(h) {
  assert.equal(h.timers.size, 0, 'all reader/host/decode timers cleared');
  for (const image of h.images) assert.equal(image.src, '', 'temporary probe source released');
  for (const timer of h.timerRecords.filter(timer => timer.ms === 10000)) assert(h.clearRecords.includes(timer.id), 'decode timer explicitly cleared');
  assert(!h.messages.some(message => message.startsWith('\u63d2\u5165\u56fe\u7247\u5931\u8d25\uff1a')), 'no swallowed unexpected insertion exception');
}
const results = [];
async function test(name, mode, run) {
  const h = fixture(mode); await run(h); await flush(); checkCleanup(h); results.push({name, passed: true});
}
await test('successful assets decode uses actual resolver and commits exactly once', 'assets', async h => {
  const work = h.insert(); await flush(); assert.equal(h.images.length, 1);
  assert.equal(h.images[0].src, resolveImageSource('assets/pasted-image.png', 'C:/model-docs/\u6587\u6863 #%()'));
  h.images[0].gate.resolve(); await work;
  assert.equal(h.view.state.doc.toString(), 'head![](assets/pasted-image.png)'); assert.equal(h.commits().length, 1);
});
await test('assets decode rejection still commits unchanged real path', 'assets', async h => {
  const work = h.insert(); await flush(); h.images[0].gate.reject(new Error('controlled decode failure')); await work;
  assert.equal(h.view.state.doc.toString(), 'head![](assets/pasted-image.png)'); assert.equal(h.commits().length, 1); assert.equal(h.saved.length, 1);
});
await test('assets 10-second timeout commits once and late success cannot commit again', 'assets', async h => {
  const work = h.insert(); await flush(); h.fireDecodeTimeout(); await work;
  assert.equal(h.view.state.doc.toString(), 'head![](assets/pasted-image.png)'); assert.equal(h.commits().length, 1);
  h.images[0].gate.resolve(); await flush(); assert.equal(h.commits().length, 1);
});
await test('inline decode rejection preserves exact data URI', 'inline', async h => {
  const work = h.insert(); await flush(); const uri = h.images[0].src;
  assert(uri.startsWith('data:image/png;base64,')); h.images[0].gate.reject(new Error('controlled decode failure')); await work;
  assert.equal(h.view.state.doc.toString(), 'head![](' + uri + ')'); assert.equal(h.commits().length, 1); assert.equal(h.saved.length, 0);
});
await test('inline timeout preserves exact data URI and clears timer', 'inline', async h => {
  const work = h.insert(); await flush(); const uri = h.images[0].src; h.fireDecodeTimeout(); await work;
  assert.equal(h.view.state.doc.toString(), 'head![](' + uri + ')'); assert.equal(h.commits().length, 1); h.images[0].gate.reject(new Error('late')); await flush();
});
await test('doc id change while decoding rejects commit but keeps saved file record', 'assets', async h => {
  const work = h.insert(); await flush(); h.now.documentId = 'B'; h.images[0].gate.resolve(); await work;
  assert.equal(h.view.state.doc.toString(), 'head'); assert.equal(h.commits().length, 0); assert.equal(h.saved.length, 1);
});
await test('directory change while decoding rejects commit', 'assets', async h => {
  const work = h.insert(); await flush(); h.now.filePath = 'C:/model-docs/other/note.md'; h.images[0].gate.resolve(); await work;
  assert.equal(h.commits().length, 0); assert.equal(h.view.state.doc.toString(), 'head');
});
await test('same-Text reset while decoding rejects commit', 'assets', async h => {
  const work = h.insert(); await flush(); const doc = h.view.state.doc; h.reset(); assert.equal(h.view.state.doc, doc);
  h.images[0].gate.resolve(); await work; assert.equal(h.commits().length, 0);
});
await test('view switch while decoding modifies neither old nor new view', 'assets', async h => {
  const work = h.insert(); await flush(); const next = h.switchView(); h.images[0].gate.resolve(); await work;
  assert.equal(h.commits().length, 0); assert.equal(h.view.state.doc.toString(), 'head'); assert.equal(next.state.doc.toString(), 'B');
});
await test('real undo while decoding cancels insertion ticket', 'assets', async h => {
  h.view.dispatch({changes: {from: 4, insert: 'x'}, selection: {anchor: 5}, userEvent: 'input.type'});
  const work = h.insert(); await flush(); assert(undo(h.view)); h.images[0].gate.resolve(); await work;
  assert.equal(h.commits().length, 0); assert.equal(h.view.state.doc.toString(), 'head');
});
await test('moved caret stays moved; commit does not add scroll request', 'assets', async h => {
  const work = h.insert(); await flush(); h.view.dispatch({selection: {anchor: 0}, userEvent: 'select'});
  h.images[0].gate.resolve(); await work; assert.equal(h.commits().length, 1);
  assert.equal(h.commits()[0].tr.scrollIntoView, false); assert.equal(h.view.state.selection.main.head, 0);
});
await test('pure effect during decode preserves insertion', 'assets', async h => {
  const work = h.insert(); await flush(); const effect = StateEffect.define(); h.view.dispatch({effects: effect.of(1)});
  h.images[0].gate.resolve(); await work; assert.equal(h.commits().length, 1);
});
await test('two adjacent image requests remain serial, ordered, and independently undoable', 'assets', async h => {
  const first = h.insert('A'), second = h.insert('B'); await flush(); assert.equal(h.images.length, 1);
  h.images[0].gate.resolve(); await first; await flush(); assert.equal(h.images.length, 2);
  h.images[1].gate.resolve(); await second;
  assert.equal(h.view.state.doc.toString(), 'head![](assets/pasted-image.png)![](assets/second.png)'); assert.equal(h.commits().length, 2);
  assert(undo(h.view)); assert.equal(h.view.state.doc.toString(), 'head![](assets/pasted-image.png)');
});
const report = {
  schema: 1,
  at: new Date().toISOString(),
  kind: 'model',
  scope: 'exact source insertion/helpers and actual resolver; real CM6 State/history; controlled Image/FileReader/clock/host; no browser/GUI/clipboard/file save',
  metadata: {productName: product.productName ?? product.name, version: product.version,
    node: process.version, dependencies, lockSha256},
  sourceHashes, coreHashes, bundleHash, artifactMatches, artifactIdentity,
  passed: results.length === 13 && results.every(result => result.passed),
  total: results.length, results,
};
if (options.out) writeOutput(options.out, report);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
