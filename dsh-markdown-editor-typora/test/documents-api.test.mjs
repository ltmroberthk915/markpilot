// B3 host endpoints: documents.read / documents.applyEdits are model-only, route
// through the live room for an open document, and never leak authority to HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHost, createMarkdownToolDefinition, MODEL_TOOL } from '../lib/index.js';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { LiveDocuments } = require(path.resolve(here, '../../MarkPilot-CM6/shell/live-documents.js'));

function provider(file) {
  let version = 0;
  const v = () => `v${version}`;
  return {
    sandboxMode: undefined,
    async resolve() { return { targetKey: file, displayPath: file }; },
    async stat() { const bytes = await fs.readFile(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; }); return bytes ? { type: 'file', size: bytes.length, version: v() } : undefined; },
    async readText() { return fs.readFile(file, 'utf8'); },
    async writeText(_target, text, expected) {
      if (expected?.version && expected.version !== v()) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      await fs.writeFile(file, text, 'utf8'); version += 1; return { version: v() };
    },
    async editText(_target, edit, expected) {
      if (expected?.version && expected.version !== v()) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      let text = await fs.readFile(file, 'utf8');
      if (!text.includes(edit.oldString)) throw Object.assign(new Error('not found'), { code: 'FS_EDIT_NOT_FOUND' });
      text = edit.replaceAll ? text.split(edit.oldString).join(edit.newString) : text.replace(edit.oldString, edit.newString);
      await fs.writeFile(file, text, 'utf8'); version += 1; return { version: v() };
    },
  };
}

async function makeWorld(name, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-b3-api-' + name + '-'));
  const file = path.join(root, 'doc.md');
  const live = path.join(root, 'live');
  const appdata = path.join(root, 'appdata');
  await fs.writeFile(file, text, 'utf8');
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = appdata;
  return { root, file, live, appdata, restore() { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; } };
}
function execution(cwd) { return { agent: { session: { header: { cwd } } } }; }

test('B3-API1 documents.read sees the live buffer and no HTTP authority can call it', async () => {
  const w = await makeWorld('read', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.join(w.file, 'hello\n');
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.ok, true);
    assert.equal(read.value.source, 'buffer');
    assert.equal(read.value.text, 'hello\n');
    assert.equal(read.value.dirty, false);
    assert.match(read.value.version, /^rev1:live:/);

    const state = await host.dispatch('documents.state', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(state.ok, true);
    assert.equal(state.value.state, 'clean');
    assert.equal(state.value.source, 'buffer');
    assert.equal(state.value.recovery.length, 0);
    const overHttpState = await host.dispatch('documents.state', { path: w.file });
    assert.equal(overHttpState.ok, false);
    assert.equal(overHttpState.error.code, 'bad-request');
    const overHttpReconcile = await host.dispatch('documents.reconcile', { path: w.file });
    assert.equal(overHttpReconcile.ok, false);
    assert.equal(overHttpReconcile.error.code, 'bad-request');

    const overHttp = await host.dispatch('documents.read', { path: w.file });
    assert.equal(overHttp.ok, false);
    assert.equal(overHttp.error.code, 'bad-request');
    const applyOverHttp = await host.dispatch('documents.applyEdits', { path: w.file, oldString: 'hello', newString: 'x' });
    assert.equal(applyOverHttp.ok, false);
    assert.equal(applyOverHttp.error.code, 'bad-request');
    host.close();
  } finally { w.restore(); }
});

test('B3-API2 applyEdits on a live buffer appends to the room, leaves disk unchanged and checkpoints', async () => {
  const w = await makeWorld('apply', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const joined = await liveDocs.join(w.file, 'hello\n');
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    const apply = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, oldString: 'hello', newString: 'bye',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(apply.ok, true);
    assert.equal(apply.value.changed, true);
    assert.equal(apply.value.source, 'buffer');
    assert.equal(apply.value.saved, false);
    assert.equal(apply.value.dirty, true);
    assert.equal(apply.value.checkpoint.archivePath.includes('agent-before'), true);
    assert.equal(typeof apply.value.recoveryPath, 'string');
    assert.match(apply.value.recoveryPath, /agent-append/);
    assert.equal(await fs.readFile(apply.value.recoveryPath, 'utf8'), 'bye\n');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n', 'buffer apply must not write disk');

    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.text, 'bye\n');
    assert.equal(after.value.dirty, true);
    const stale = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, oldString: 'bye', newString: 'x',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'MP_DOC_STALE');
    assert.equal(stale.error.currentRevisionId, after.value.version);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n');
    // The editor's normal live save is the persistence path for the buffer.
    const room = await liveDocs.readRoom(w.file);
    await liveDocs.save(joined.client, {
      epoch: room.epoch, version: room.version, text: 'bye\n',
    }, async () => { await fs.writeFile(w.file, 'bye\n', 'utf8'); return { ok: true, version: 'v2' }; });
    const clean = await liveDocs.readRoom(w.file);
    assert.equal(clean.savedVersion, clean.version);
    assert.equal(clean.text, 'bye\n');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'bye\n');
    host.close();
  } finally { w.restore(); }
});

test('B3-API3 unopened file edits still write disk with the provider CAS', async () => {
  const w = await makeWorld('disk', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.value.source, 'disk');
    const apply = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, oldString: 'hello', newString: 'bye',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(apply.ok, true);
    assert.equal(apply.value.source, 'disk');
    assert.equal(apply.value.saved, true);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'bye\n');
    const again = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, oldString: 'bye', newString: 'x',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'MP_DOC_STALE');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'bye\n');
    host.close();
  } finally { w.restore(); }
});

test('B3-API4 the markdown model tool follows the same endpoints and reports saved:false', async () => {
  const w = await makeWorld('tool', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.join(w.file, 'hello\n');
    const tool = createMarkdownToolDefinition(host.dispatch);
    const read = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    assert.equal(read.ok, true);
    assert.equal(read.source, 'buffer');
    assert.equal(read.dirty, false);
    assert.match(read.version, /^rev1:live:/);
    const edit = await tool.execute({ action: 'edit', path: w.file, oldString: 'hello', newString: 'bye', baseVersion: read.version }, execution(w.root));
    assert.equal(edit.ok, true);
    assert.equal(edit.saved, false);
    assert.equal(edit.dirty, true);
    assert.ok(edit.version.startsWith('rev1:live:'));
    assert.equal(typeof edit.recoveryPath, 'string');
    assert.match(edit.recoveryPath, /agent-append/);
    assert.equal(await fs.readFile(edit.recoveryPath, 'utf8'), 'bye\n');
    const rendered = tool.output.render({ action: 'edit' }, edit);
    assert.match(rendered[0].text, /恢复副本：/);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n');
    host.close();
  } finally { w.restore(); }
});

test('B3-API6 HTTP POST to documents.* is rejected before any authority is inferred', async () => {
  const w = await makeWorld('http', 'hello\n');
  let server;
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, 'hello\n');
    const host = createHost({
      fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} },
      connectionProvider: () => ({ requestRejection: () => undefined }),
    });
    server = http.createServer(host.route.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const post = async (endpoint, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/dsh-markdown-editor-typora/api/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const read = await post('documents.read', { path: w.file });
    assert.equal(read.status, 200);
    assert.equal(read.body.ok, false);
    assert.equal(read.body.error.code, 'bad-request');
    const apply = await post('documents.applyEdits', { path: w.file, oldString: 'hello', newString: 'bye' });
    assert.equal(apply.status, 200);
    assert.equal(apply.body.ok, false);
    assert.equal(apply.body.error.code, 'bad-request');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n');
    host.close();
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    w.restore();
  }
});

async function otherProcessOwns(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rooms.sqlite'));
  try { db.prepare('UPDATE clients SET pid=?').run(process.ppid); }
  finally { db.close(); }
}

test('B3-API7 a room owned only by another process is disk authority; dirty elsewhere is refused', async () => {
  const cleanWorld = await makeWorld('elsewhere-clean', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: cleanWorld.live });
    const joined = await liveDocs.join(cleanWorld.file, 'hello\n');
    await otherProcessOwns(cleanWorld.live);
    const host = createHost({ fs: provider(cleanWorld.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: cleanWorld.file }, MODEL_TOOL, execution(cleanWorld.root));
    assert.equal(read.value.source, 'disk');
    assert.equal(read.value.bufferOwnedElsewhere, true);
    assert.equal(read.value.unsavedElsewhere, false);
    const apply = await host.dispatch('documents.applyEdits', {
      path: cleanWorld.file, baseRevisionId: read.value.version, oldString: 'hello', newString: 'bye',
    }, MODEL_TOOL, execution(cleanWorld.root));
    assert.equal(apply.ok, true);
    assert.equal(apply.value.source, 'disk');
    assert.equal(apply.value.saved, true);
    assert.equal(await fs.readFile(cleanWorld.file, 'utf8'), 'bye\n');
    host.close();
  } finally { cleanWorld.restore(); }

  const dirtyWorld = await makeWorld('elsewhere-dirty', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: dirtyWorld.live });
    const joined = await liveDocs.join(dirtyWorld.file, 'hello\n');
    await liveDocs.append(dirtyWorld.file, {
      epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
      changes: [{ from: 5, to: 5, insert: '!' }],
    });
    await otherProcessOwns(dirtyWorld.live);
    const host = createHost({ fs: provider(dirtyWorld.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: dirtyWorld.file }, MODEL_TOOL, execution(dirtyWorld.root));
    assert.equal(read.value.source, 'disk');
    assert.equal(read.value.bufferOwnedElsewhere, true);
    assert.equal(read.value.unsavedElsewhere, true);
    const apply = await host.dispatch('documents.applyEdits', {
      path: dirtyWorld.file, baseRevisionId: read.value.version, oldString: 'hello', newString: 'bye',
    }, MODEL_TOOL, execution(dirtyWorld.root));
    assert.equal(apply.ok, false);
    assert.equal(apply.error.code, 'MP_DOC_UNSAVED_ELSEWHERE');
    assert.equal(await fs.readFile(dirtyWorld.file, 'utf8'), 'hello\n');
    host.close();
  } finally { dirtyWorld.restore(); }
});

test('B4.1-API1 markdown blocks/edit blockId goes through the live room and returns a group id', async () => {
  const w = await makeWorld('blocks', '# A\nalpha\n\n## B\nbeta\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, '# A\nalpha\n\n## B\nbeta\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const tool = createMarkdownToolDefinition(host.dispatch);
    const blocks = await tool.execute({ action: 'blocks', path: w.file }, execution(w.root));
    assert.equal(blocks.ok, true, JSON.stringify(blocks));
    assert.equal(blocks.blocks.length, 2);
    assert.match(blocks.readToken, /^rev1:live:/);
    const target = blocks.blocks[1];
    const edit = await tool.execute({
      action: 'edit', path: w.file, blockId: target.id,
      newString: '## B\nBETA\n', baseVersion: blocks.readToken,
    }, execution(w.root));
    assert.equal(edit.ok, true, JSON.stringify(edit));
    assert.notEqual(edit.blockId, target.id);
    assert.match(edit.groupId, /^[0-9a-f-]{36}$/);
    assert.equal(edit.saved, false);
    const after = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    assert.equal(after.text, '# A\nalpha\n\n## B\nBETA\n');
    const afterBlocks = await tool.execute({ action: 'blocks', path: w.file }, execution(w.root));
    assert.equal(afterBlocks.blocks.some((b) => b.id === edit.blockId), true);
    const groups = await liveDocs.listAgentGroups(w.file);
    assert.equal(groups.some((g) => g.groupId === edit.groupId && g.kind === 'block-edit'), true);
    const undone = await tool.execute({ action: 'undo', path: w.file, groupId: edit.groupId }, execution(w.root));
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const restored = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    assert.equal(restored.text, '# A\nalpha\n\n## B\nbeta\n');
    const afterUndo = await liveDocs.listAgentGroups(w.file);
    assert.equal(afterUndo.find((g) => g.groupId === edit.groupId)?.undoneAt > 0, true);
    host.close();
  } finally { w.restore(); }
});

test('B3-API8 UI recovery restores an append copy through disk CAS and discard removes it', async () => {  const w = await makeWorld('recover', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const joined = await liveDocs.join(w.file, 'hello\n');
    const appended = await liveDocs.append(w.file, {
      epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
      changes: [{ from: 5, to: 5, insert: ' world' }],
    });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    try { db.exec('DELETE FROM clients; DELETE FROM rooms;'); } finally { db.close(); }
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.value.source, 'disk');
    const restored = await host.dispatch('documents.recover', {
      // This is the raw provider/disk version the editor tab stores in
      // doc.lastVersion, not the rev1 token returned by documents.read.
      path: w.file, recoveryPath: appended.recoveryPath, baseVersion: 'v0',
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.value.recovered, true);
    assert.equal(restored.value.saved, true);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello world\n');
    const discarded = await host.dispatch('documents.discardRecovery', { path: w.file, recoveryPath: appended.recoveryPath });
    assert.equal(discarded.ok, true);
    assert.equal(discarded.value.removed, true);
    assert.equal((await liveDocs.listAppendRecovery(w.file)).length, 0);
    host.close();
  } finally { w.restore(); }
});

test('B3-API5 a sandboxed session cannot apply a buffer edit outside its workspace', async () => {
  const w = await makeWorld('policy', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, 'hello\n');
    const sandboxed = provider(w.file);
    sandboxed.sandboxMode = 'workspace-write';
    const host = createHost({
      fs: sandboxed, liveDocuments: liveDocs, log: { warn() {} },
      sandboxPolicy: () => ({ resolve: () => ({ mode: 'workspace-write', workspaceRoot: path.join(w.root, 'other') }) }),
    });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    const apply = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, oldString: 'hello', newString: 'bye',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(apply.ok, false);
    assert.equal(apply.error.code, 'FS_SANDBOX_DENIED');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n');
    host.close();
  } finally { w.restore(); }
});

