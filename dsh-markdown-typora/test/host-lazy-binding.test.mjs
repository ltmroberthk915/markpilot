// dsh-markdown-typora/test/host-lazy-binding.test.mjs
// Public portable regression for the host-graph **local require ownership** (issue: request-time
// lazy `require('./document-store')` from live-documents.readDisk picking up a drifted global
// cache entry after HMR; symptom: `liveCommitDirectory is not a function` on open/live).
//
// Runs the REAL loader of the package this file lives in (`../lib/index.js`) and verifies:
//  - warm: each captured host Module's wrapped require resolves its host members to the graph's
//    own exports (identity, not global cache);
//  - cache poisoning AFTER load and DURING an async await: the graph's own Member still returns
//    its own exports, and the global require.cache remains drifted (no per-request writeback);
//  - whole-process `node:module._load` identity is unchanged;
//  - two generations coexist (old pending while new is current), each with its own binding,
//    and retirement restores the original mod.require;
//  - a legacy same-digest slot without the loader ABI is rebuilt (fresh mutation reproduced).
//
// Portable: discovers the package root from this file; no private/baseline paths, no personal
// dirs (temp staging only), no browser/GUI, no DSH service. The real dual-page browser run
// remains a separate manual step.
//
// Run: node test/host-lazy-binding.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_LOAD = Module._load; // whole-process loader reference, captured before any plugin import
const GRAPH_KEY = Symbol.for('dsh-markdown-typora:host-graph');
const ABI = 2;

function findPackageRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'lib', 'index.js')) && fs.existsSync(path.join(dir, 'host.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate package root (lib/index.js + host.json) from ' + start);
}
const ROOT = findPackageRoot(HERE);
const HOST_DIR = fs.realpathSync(path.join(ROOT, 'host'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const graphOf = (hostDir) => {
  const map = globalThis[GRAPH_KEY];
  return map ? map.get(hostDir) : undefined;
};
const currentGraph = (hostDir) => graphOf(hostDir)?.current;

function digestOf(manifest, hostDir) {
  const members = manifest.files.map((f) => ({ rel: f.path, bytes: fs.readFileSync(path.join(hostDir, f.path)) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const g = crypto.createHash('sha256');
  for (const m of members) { g.update(m.rel); g.update('\0'); g.update(crypto.createHash('sha256').update(m.bytes).digest()); }
  return g.digest('hex');
}

let loadSeq = 0;
async function loadReal(pluginRoot) {
  // 每次装载使用唯一查询串：强制真实的 ESM 模块求值（而不是命中模块缓存），
  // 与 DSH 热载时 lib/index.js 重新求值的行为一致。查询串原样保留在 import.meta.url。
  loadSeq += 1;
  return import(pathToFileURL(path.join(pluginRoot, 'lib', 'index.js')).href + '?hostlazy=' + loadSeq);
}

/** Copy the adjacent package (loader + host members + manifest) into a temp dir for mutation tests. */
function stageCopy() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-host-bind-'));
  fs.cpSync(path.join(ROOT, 'host'), path.join(dst, 'host'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'lib', 'index.js'), path.join(dst, 'lib', 'index.js'));
  fs.copyFileSync(path.join(ROOT, 'host.json'), path.join(dst, 'host.json'));
  if (fs.existsSync(path.join(ROOT, 'package.json'))) fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dst, 'package.json'));
  return dst;
}

/** Append a marker to one host member and rewrite the manifest (simulates a real sync-host generation bump). */
function bumpMember(pluginRoot, rel = 'text-codec.js', marker = '\n// generation bump\n') {
  const memberPath = path.join(pluginRoot, 'host', rel);
  fs.appendFileSync(memberPath, marker);
  const manifestPath = path.join(pluginRoot, 'host.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.files.find((f) => f.path === rel);
  const bytes = fs.readFileSync(memberPath);
  entry.bytes = bytes.length;
  entry.sha256 = sha(bytes);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Simulate post-registration HMR drift: document-store cache entry evaluated against a
 *  live-documents instance that lacks defaultDirectory; live-documents cache restored. */
function poisonGraphCaches(pluginRoot) {
  const hostDir = fs.realpathSync(path.join(pluginRoot, 'host'));
  const docStorePath = fs.realpathSync(path.join(hostDir, 'document-store.js'));
  const livePath = fs.realpathSync(path.join(hostDir, 'live-documents.js'));
  const graphLive = require.cache[livePath];
  const brokenLive = { id: livePath, filename: livePath, loaded: true, exports: {} };  // 缓存条目只需 exports 形状
  require.cache[livePath] = brokenLive;
  delete require.cache[docStorePath];
  try { require(docStorePath); } catch { /* drifted instance stays cached */ }
  if (graphLive) require.cache[livePath] = graphLive;
  return { hostDir, docStorePath, livePath };
}

const requireOf = (graph, name) => graph.cjs.get(name).require;
const exportsOf = (graph, name) => graph.modules.get(name);

test('warm: captured host modules resolve their host members to the graph own exports', async () => {
  await loadReal(ROOT);
  const graph = currentGraph(HOST_DIR);
  assert.ok(graph, 'graph published for the real package host dir');
  assert.equal(graph.abi, ABI);
  for (const name of ['document-store.js', 'live-documents.js', 'text-codec.js', 'safe-file.js']) {
    const mod = graph.cjs.get(name);
    assert.ok(mod && mod.exports === exportsOf(graph, name), 'captured Module for ' + name);
  }
  // live-documents readDisk does `require('./document-store')`; the wrapped instance require must
  // return this graph's own document-store exports (pure binding, no host/live session needed).
  const fromLive = requireOf(graph, 'live-documents.js').call(graph.cjs.get('live-documents.js'), './document-store.js');
  assert.equal(fromLive, exportsOf(graph, 'document-store.js'), 'live-documents -> document-store bound to graph');
  const fromDisk = requireOf(graph, 'document-store.js').call(graph.cjs.get('document-store.js'), './live-documents.js');
  assert.equal(fromDisk, exportsOf(graph, 'live-documents.js'), 'document-store -> live-documents bound to graph');
});

test('cache poisoning AFTER warm does not change the graph binding (global cache stays drifted)', async () => {
  const graph = currentGraph(HOST_DIR);
  const { docStorePath } = poisonGraphCaches(ROOT);
  const fromLive = requireOf(graph, 'live-documents.js').call(graph.cjs.get('live-documents.js'), './document-store.js');
  assert.equal(fromLive, exportsOf(graph, 'document-store.js'), 'binding survives poisoning');
  assert.ok(require.cache[docStorePath], 'a drifted document-store is still cached globally (not rewritten)');
});

test('poisoning DURING an async await window does not change the graph binding', async () => {
  const graph = currentGraph(HOST_DIR);
  const answer = await (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5)); // request would already be in flight here
    poisonGraphCaches(ROOT);
    return requireOf(graph, 'live-documents.js').call(graph.cjs.get('live-documents.js'), './document-store.js');
  })();
  assert.equal(answer, exportsOf(graph, 'document-store.js'));
});

test('whole-process node:module._load identity is unchanged', async () => {
  await loadReal(ROOT);
  assert.equal(Module._load, MODULE_LOAD, 'loader must not wrap Module._load');
});

test('two generations coexist: old pending with its own binding, retirement restores original require', async () => {
  const staged = stageCopy();
  try {
    const hostDir = fs.realpathSync(path.join(staged, 'host'));
    const libUrl = (q) => pathToFileURL(path.join(staged, 'lib', 'index.js')).href + '?q=' + q;
    const g1 = await import(libUrl(1));
    const graph1 = currentGraph(hostDir);
    assert.ok(graph1 && graph1.abi === ABI);
    // A host token keeps generation 1 alive (injected liveDocuments stub: no real kernel/worker).
    const fsStub = { resolve: async (p) => ({ displayPath: p, targetKey: p }), writeText: async () => ({}) };
    const hostA = g1.createHost({ fs: fsStub, liveDocuments: {}, rootDir: staged, log: { info() {}, warn() {}, error() {} } });
    bumpMember(staged);
    const g2 = await import(libUrl(2));
    const graph2 = currentGraph(hostDir);
    assert.ok(graph2 && graph2 !== graph1, 'new generation published by fresh mutation (no same-digest reuse)');
    const retired = graphOf(hostDir).retiredList.find((r) => r === graph1);
    assert.ok(retired && retired.retired === 'pending' && retired.hosts.size === 1, 'old generation pending with one owner');
    poisonGraphCaches(staged);
    const oldFromLive = requireOf(graph1, 'live-documents.js').call(graph1.cjs.get('live-documents.js'), './document-store.js');
    const newFromLive = requireOf(graph2, 'live-documents.js').call(graph2.cjs.get('live-documents.js'), './document-store.js');
    assert.equal(oldFromLive, exportsOf(graph1, 'document-store.js'), 'old generation keeps its own binding');
    assert.equal(newFromLive, exportsOf(graph2, 'document-store.js'), 'new generation keeps its own binding');
    assert.notEqual(oldFromLive, newFromLive, 'generations are distinct module instances');
    hostA.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(graph1.retired, 'done', 'old generation retired after last owner leaves');
    assert.equal(graph1.cjs.get('document-store.js').require, Module.prototype.require, 'original mod.require restored');
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
});

test('legacy same-digest slot without loader ABI is rebuilt; same bytes afterwards reuse stably', async () => {
  const staged = stageCopy();
  try {
    const hostDir = fs.realpathSync(path.join(staged, 'host'));
    const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'host.json'), 'utf8'));
    const digest = digestOf(manifest, hostDir);
    const fake = { digest, modules: new Map(), hosts: new Set(), retired: 'active', generation: 1 };
    (globalThis[GRAPH_KEY] ??= new Map()).set(hostDir, { current: fake, retiredList: [] });
    const g1 = await loadReal(staged);
    const graph1 = currentGraph(hostDir);
    assert.ok(graph1 && graph1 !== fake && graph1.abi === ABI, 'legacy same-digest slot rebuilt instead of reused');
    assert.equal(fake.retired, 'done', 'legacy record not left active');
    const docStoreModule = graph1.cjs.get('document-store.js');
    await loadReal(staged);
    const graph2 = currentGraph(hostDir);
    assert.equal(graph2, graph1, 'same bytes + same ABI reuse the same graph');
    assert.equal(graph2.cjs.get('document-store.js'), docStoreModule, 'same module instances reused');
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
});
