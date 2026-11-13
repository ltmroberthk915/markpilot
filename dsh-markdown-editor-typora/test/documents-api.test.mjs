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
import { makeLiveRevisionId, makeMirrorRevisionId, parseRevisionId, revisionTextSha, sha256Text } from '../lib/documents-service.js';
import { DatabaseSync } from 'node:sqlite';
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
      const temp = file + '.replace-' + process.pid + '-' + (++version);
      await fs.writeFile(temp, text, 'utf8');
      await fs.rename(temp, file);
      version += 1;
      return { version: v() };
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

test('B4.3b-API1 markdown merge3 writes a clean merge and refuses conflicts', async () => {
  const text = 'A\nb\nc\n';
  const w = await makeWorld('merge3', text);
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, text);
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const tool = createMarkdownToolDefinition(host.dispatch);
    const read = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    const merged = await tool.execute({
      action: 'merge3', path: w.file, baseText: 'a\nb\nc\n', otherText: 'a\nb\nC\n', baseVersion: read.readToken,
    }, execution(w.root));
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.equal(merged.clean, true);
    const after = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    assert.equal(after.text, 'A\nb\nC\n');
    const conflict = await tool.execute({
      action: 'merge3', path: w.file, baseText: 'a\nb\nc\n', otherText: 'a\nb\nX\n', baseVersion: after.readToken,
    }, execution(w.root));
    assert.equal(conflict.ok, true, JSON.stringify(conflict));
    assert.equal(conflict.clean, false);
    assert.equal(conflict.conflicts.length > 0, true);
    assert.equal((await tool.execute({ action: 'read', path: w.file }, execution(w.root))).text, 'A\nb\nC\n');
    host.close();
  } finally { w.restore(); }
});

test('B4.3-API1 markdown batch applies multiple edits with one group and one append', async () => {
  const text = '# A\nalpha\n\n# B\nbeta\n';
  const w = await makeWorld('batch', text);
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, text);
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const tool = createMarkdownToolDefinition(host.dispatch);
    const read = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    const a = text.indexOf('alpha'), b = text.indexOf('beta');
    const result = await tool.execute({
      action: 'batch', path: w.file, baseVersion: read.readToken,
      edits: [
        { from: a, to: a + 5, insert: 'ALPHA' },
        { from: b, to: b + 4, insert: 'BETA' },
      ],
    }, execution(w.root));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied.length, 2);
    assert.match(result.groupId, /^[0-9a-f-]{36}$/);
    const after = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    assert.equal(after.text, '# A\nALPHA\n\n# B\nBETA\n');
    host.close();
  } finally { w.restore(); }
});

test('B4.2A-API2 undo resolves the same sandbox policy as edit', async () => {
  const w = await makeWorld('undo-policy', '# A\nalpha\n\n# B\nbeta\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, '# A\nalpha\n\n# B\nbeta\n');
    const sandboxed = provider(w.file);
    sandboxed.sandboxMode = 'workspace-write';
    const host = createHost({
      fs: sandboxed, liveDocuments: liveDocs, log: { warn() {} },
      sandboxPolicy: () => ({ resolve: () => ({ mode: 'workspace-write', workspaceRoot: w.root }) }),
    });
    const tool = createMarkdownToolDefinition(host.dispatch);
    const blocks = await tool.execute({ action: 'blocks', path: w.file }, execution(w.root));
    const edit = await tool.execute({
      action: 'edit', path: w.file, blockId: blocks.blocks[1].id,
      newString: '# B\nBETA\n', baseVersion: blocks.readToken,
    }, execution(w.root));
    assert.equal(edit.ok, true, JSON.stringify(edit));
    const undo = await tool.execute({ action: 'undo', path: w.file, groupId: edit.groupId }, execution(w.root));
    assert.equal(undo.ok, true, JSON.stringify(undo));
    const after = await tool.execute({ action: 'read', path: w.file }, execution(w.root));
    assert.equal(after.text, '# A\nalpha\n\n# B\nbeta\n');
    host.close();
  } finally { w.restore(); }
});

test('B4.2B-API1 trusted UI can review and undo an AI group without model authority', async () => {
  const w = await makeWorld('review-ui', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, 'hello\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    const applied = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, oldString: 'hello', newString: 'WORLD',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const reviewed = await host.dispatch('documents.reviewGroup', { path: w.file, groupId: applied.value.groupId });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    assert.equal(reviewed.value.groupId, applied.value.groupId);
    assert.equal(Array.isArray(reviewed.value.changes), true);
    const undone = await host.dispatch('documents.undoGroup', { path: w.file, groupId: applied.value.groupId });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.text, 'hello\n');
    host.close();
  } finally { w.restore(); }
});

test('B4.2B-API2 multi-group review undo restores the whole sequence', async () => {
  const w = await makeWorld('review-multi', 'one\ntwo\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.join(w.file, 'one\ntwo\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const firstRead = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    const first = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: firstRead.value.version, oldString: 'one', newString: 'ONE',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(first.ok, true, JSON.stringify(first));
    const secondRead = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    const second = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: secondRead.value.version, oldString: 'two', newString: 'TWO',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(second.ok, true, JSON.stringify(second));
    const reviewed = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [first.value.groupId, second.value.groupId] });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    assert.equal(reviewed.value.groups.length, 2);
    assert.equal(reviewed.value.chainOk, true, JSON.stringify(reviewed.value));
    assert.equal(typeof reviewed.value.groups[0].baseRevision, 'string');
    assert.equal(typeof reviewed.value.groups[1].resultRevision, 'string');
    assert.equal(reviewed.value.groups[0].changes[0].insert, 'ONE');
    assert.equal(reviewed.value.groups[1].changes[0].insert, 'TWO');
    const partial = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [first.value.groupId] });
    assert.equal(partial.ok, true, JSON.stringify(partial));
    assert.equal(partial.value.chainOk, false, 'the last group must be the current document');
    const undone = await host.dispatch('documents.undoGroups', { path: w.file, groupIds: [first.value.groupId, second.value.groupId] });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const afterUndo = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [first.value.groupId, second.value.groupId] });
    assert.equal(afterUndo.ok, true, JSON.stringify(afterUndo));
    assert.equal(afterUndo.value.chainOk, false, 'undone groups cannot be restored');
    assert.equal(afterUndo.value.chainReason, 'undone');
    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.text, 'one\ntwo\n');
    const groups = await liveDocs.listAgentGroups(w.file, 20);
    assert.equal(groups.find((g) => g.groupId === first.value.groupId)?.undoneAt > 0, true);
    assert.equal(groups.find((g) => g.groupId === second.value.groupId)?.undoneAt > 0, true);
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

test('B4.4-API6 recovery center lists/reads/discards append recovery, editor-only', async () => {
  const w = await makeWorld('recovery-center', 'hello\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const joined = await liveDocs.join(w.file, 'hello\n');
    const appended = await liveDocs.append(w.file, {
      epoch: joined.epoch, baseVersion: 0, baseText: 'hello\n', actor: 'agent',
      changes: [{ from: 5, to: 5, insert: ' world' }],
    });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const listed = await host.dispatch('documents.recoveryList', { path: w.file });
    assert.equal(listed.ok, true);
    assert.equal(listed.value.items.some((item) => item.recoveryPath === appended.recoveryPath), true);
    assert.equal('text' in listed.value.items[0], false);
    const read = await host.dispatch('documents.recoveryRead', { path: w.file, recoveryPath: appended.recoveryPath });
    assert.equal(read.ok, true);
    assert.equal(read.value.text, 'hello world\n');
    const model = await host.dispatch('documents.recoveryRead', { path: w.file, recoveryPath: appended.recoveryPath }, MODEL_TOOL, execution(w.root));
    assert.equal(model.ok, false);
    const discarded = await host.dispatch('documents.recoveryDiscard', { path: w.file, recoveryPath: appended.recoveryPath });
    assert.equal(discarded.ok, true);
    assert.equal((await liveDocs.listAppendRecovery(w.file)).length, 0);
    host.close();
  } finally { w.restore(); }
});

test('P1-API documents.session is a read-only editor snapshot', async () => {
  const w = await makeWorld('session-shadow', 'body\n');
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const session = await host.dispatch('documents.session', { path: w.file });
    assert.equal(session.ok, true);
    assert.equal(session.value.state, 'disk');
    assert.equal(Array.isArray(session.value.allowedActions), true);
    assert.equal(session.value.allowedActions.includes('save'), false);
    assert.equal(await fs.access(path.join(w.live, 'rooms.sqlite')).then(() => true, () => false), false, 'session must not create a live room');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'body\n');
    const model = await host.dispatch('documents.session', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(model.ok, false);
    host.close();
  } finally { w.restore(); }
});

test('P1-API documents.session normalizes missing and refreshes after creation', async () => {
  const w = await makeWorld('session-missing', 'body\n');
  const missingPath = path.join(w.root, 'later.md');
  const tiny = {
    async resolve(value) { return { targetKey: value, displayPath: value }; },
    async stat(value) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      try { const info = await fs.stat(p); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: 'v' + info.mtimeMs }; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async readText(value) { return fs.readFile(typeof value === 'string' ? value : value?.targetKey, 'utf8'); },
    async writeText() { throw new Error('not used'); },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
  try {
    const host = createHost({ fs: tiny, log: { warn() {} } });
    const first = await host.dispatch('documents.session', { path: missingPath });
    assert.equal(first.ok, true);
    assert.equal(first.value.state, 'missing');
    assert.equal(first.value.allowedActions.includes('retry'), true);
    await fs.writeFile(missingPath, 'now\n', 'utf8');
    const second = await host.dispatch('documents.session', { path: missingPath });
    assert.equal(second.ok, true);
    assert.equal(second.value.state, 'disk');
    host.close();
  } finally { w.restore(); }
});

test('P1-API session cache refreshes after save and rename', async () => {
  const w = await makeWorld('session-refresh', 'body\n');
  const renamed = w.file + '-renamed.md';
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const first = await host.dispatch('documents.session', { path: w.file });
    const opened = await host.dispatch('open', { path: w.file });
    const saved = await host.dispatch('save', { path: w.file, text: 'changed\n', baseVersion: opened.value.version });
    assert.equal(saved.ok, true);
    const second = await host.dispatch('documents.session', { path: w.file });
    assert.equal(second.ok, true);
    assert.notEqual(second.value.version, first.value.version);
    await fs.rename(w.file, renamed);
    const third = await host.dispatch('documents.session', { path: w.file });
    assert.equal(third.ok, true);
    assert.equal(third.value.state, 'missing');
    host.close();
  } finally { await fs.rename(renamed, w.file).catch(() => {}); w.restore(); }
});

test('P5-API disk-authority applyEdits creates an agent-before archive', async () => {
  const w = await makeWorld('disk-archive', 'before\n');
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.ok, true);
    const applied = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, edits: [{ from: 0, to: 6, insert: 'after' }],
    }, MODEL_TOOL, execution(w.root));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(await fs.readFile(w.file, 'utf8'), 'after\n');
    const archivePath = applied.value.checkpoint?.archivePath;
    assert.equal(typeof archivePath, 'string');
    assert.equal(await fs.readFile(archivePath, 'utf8'), 'before\n');
    host.close();
  } finally { w.restore(); }
});

test('P5-API virtual provider disk writes archive through a stable synthetic path', async () => {
  const w = await makeWorld('virtual-archive', 'before\n');
  const providerForVirtual = {
    async resolve() { return { targetKey: 'dsh://vault/note.md', displayPath: 'dsh://vault/note.md' }; },
    async stat() { const text = await fs.readFile(w.file, 'utf8'); return { type: 'file', size: Buffer.byteLength(text), version: 'v1' }; },
    async readText() { return fs.readFile(w.file, 'utf8'); },
    async writeText(_target, text) { await fs.writeFile(w.file, text, 'utf8'); return { version: 'v2' }; },
    async editText(_target, edit) { const text = await fs.readFile(w.file, 'utf8'); await fs.writeFile(w.file, text.replace(edit.oldString, edit.newString), 'utf8'); return { version: 'v2' }; },
    async watch() { return async () => {}; },
  };
  try {
    const host = createHost({ fs: providerForVirtual, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: 'dsh://vault/note.md' }, MODEL_TOOL, execution(w.root));
    assert.equal(read.ok, true);
    const applied = await host.dispatch('documents.applyEdits', {
      path: 'dsh://vault/note.md', baseRevisionId: read.value.version, edits: [{ from: 0, to: 6, insert: 'after' }],
    }, MODEL_TOOL, execution(w.root));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(await fs.readFile(w.file, 'utf8'), 'after\n');
    assert.equal(typeof applied.value.checkpoint?.archivePath, 'string');
    host.close();
  } finally { w.restore(); }
});

test('P5-API write guard lookup sees a mirror without a live room', async () => {
  const w = await makeWorld('guard-mirror', 'body\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.putDraft(w.file, {
      text: 'draft\n', baseVersion: 'v0', baseSha256: sha256Text('body\n'), docToken: 'dshdoc-guard-test',
    });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const state = await host._internals.lookupDocument({ targetKey: w.file, displayPath: w.file });
    assert.equal(state.dirty, true);
    assert.equal(state.source, 'mirror');
    host.close();
  } finally { w.restore(); }
});

test('P5-API archive failure is fail-closed with zero disk write', async () => {
  const w = await makeWorld('archive-failure', 'before\n');
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    const old = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = w.file; // a file, so mkdir of .markpilot fails
    try {
      const applied = await host.dispatch('documents.applyEdits', {
        path: w.file, baseRevisionId: read.value.version, edits: [{ from: 0, to: 6, insert: 'after' }],
      }, MODEL_TOOL, execution(w.root));
      assert.equal(applied.ok, false);
      assert.equal(applied.error.code, 'MP_ARCHIVE_FAILED');
      assert.equal(await fs.readFile(w.file, 'utf8'), 'before\n');
    } finally { process.env.LOCALAPPDATA = old; }
    host.close();
  } finally { w.restore(); }
});

test('P5-API documents.state cache notices a draft-index mirror', async () => {
  const w = await makeWorld('state-mirror', 'body\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const first = await host.dispatch('documents.state', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(first.ok, true);
    assert.notEqual(first.value.source, 'mirror');
    await liveDocs.putDraft(w.file, {
      text: 'mirror\n', baseVersion: 'v0', baseSha256: sha256Text('body\n'), docToken: 'dshdoc-state-mirror',
    });
    const second = await host.dispatch('documents.state', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(second.ok, true);
    assert.equal(second.value.source, 'mirror');
    host.close();
  } finally { w.restore(); }
});

test('P5-API documents.state cache notices discarded recovery copies', async () => {
  const w = await makeWorld('state-recovery', 'body\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const joined = await liveDocs.join(w.file, 'body\n');
    await liveDocs.append(w.file, { epoch: joined.epoch, baseVersion: 0, baseText: 'body\n', actor: 'agent', changes: [{ from: 4, to: 4, insert: 'R' }] });
    const room = await liveDocs.readRoom(w.file);
    await liveDocs.append(w.file, { epoch: room.epoch, baseVersion: room.version, baseText: room.text, actor: 'agent', changes: [{ from: room.text.length, to: room.text.length, insert: 'S' }] });
    const first = await host.dispatch('documents.state', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(first.ok, true);
    assert.equal(first.value.recovery.length >= 1, true);
    for (const entry of first.value.recovery) await liveDocs.discardAppendRecovery(w.file, entry.recoveryPath);
    const second = await host.dispatch('documents.state', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(second.ok, true);
    assert.equal(second.value.recovery.length, 0);
    host.close();
  } finally { w.restore(); }
});

test('P1-API documents.session never creates a room or writes disk', async () => {
  const w = await makeWorld('session-readonly', 'body\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const snapshot = await host.dispatch('documents.session', { path: w.file });
    assert.equal(snapshot.ok, true);
    assert.equal(await liveDocs.readRoom(w.file), null);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'body\n');
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

test('B4.2B-API3 review chain survives the disk→buffer boundary on a CRLF file', async () => {
  const w = await makeWorld('review-crlf', 'one\r\ntwo\r\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    // First AI edit happens on the disk (no room yet). Its revision token must
    // use the comparison-normalized sha, not the raw CRLF provider bytes.
    const diskRead = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(diskRead.value.source, 'disk');
    const first = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: diskRead.value.version, oldString: 'one', newString: 'ONE',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(first.ok, true, JSON.stringify(first));
    // Open the editor on the same file, then make the second AI edit in the buffer.
    await liveDocs.join(w.file, 'ONE\ntwo\n');
    const bufferRead = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(bufferRead.value.source, 'buffer');
    const second = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: bufferRead.value.version, oldString: 'two', newString: 'TWO',
    }, MODEL_TOOL, execution(w.root));
    assert.equal(second.ok, true, JSON.stringify(second));
    const reviewed = await host.dispatch('documents.reviewGroups', {
      path: w.file, groupIds: [first.value.groupId, second.value.groupId],
    });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    assert.equal(reviewed.value.chainOk, true, JSON.stringify(reviewed.value));
    assert.equal(reviewed.value.chainReason, 'ok');
    host.close();
  } finally { w.restore(); }
});

test('B4.2B-API4 review chain rejects broken/missing/undone groups and accepts epoch changes', async () => {
  const w = await makeWorld('review-chain', 'final\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const g1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const g2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const g3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const base = makeLiveRevisionId('e1', 0, sha256Text('base\n'));
    const mid = makeLiveRevisionId('e1', 1, sha256Text('mid\n'));
    const midOtherEpoch = makeLiveRevisionId('e2', 0, sha256Text('mid\n'));
    const final = makeLiveRevisionId('e2', 1, sha256Text('final\n'));
    await liveDocs.recordAgentGroup(w.file, { groupId: g1, kind: 'edit', baseRevision: base, resultRevision: mid, changes: [{ from: 0, to: 0, insert: 'x' }] });
    await liveDocs.recordAgentGroup(w.file, { groupId: g2, kind: 'edit', baseRevision: midOtherEpoch, resultRevision: final, changes: [{ from: 0, to: 0, insert: 'y' }] });
    const ok = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [g1, g2] });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.value.chainOk, true, 'adjacent groups with the same content sha but different epochs are contiguous');
    const reversed = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [g2, g1] });
    assert.equal(reversed.value.chainOk, false);
    assert.equal(reversed.value.chainReason, 'broken-chain');
    await liveDocs.recordAgentGroup(w.file, { groupId: g3, kind: 'edit', baseRevision: '', resultRevision: '', changes: [] });
    const missing = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [g3] });
    assert.equal(missing.value.chainOk, false);
    assert.equal(missing.value.chainReason, 'missing-revision');
    await liveDocs.markAgentGroupUndone(w.file, g2);
    const undone = await host.dispatch('documents.reviewGroups', { path: w.file, groupIds: [g2] });
    assert.equal(undone.value.chainOk, false);
    assert.equal(undone.value.chainReason, 'undone');
    host.close();
  } finally { w.restore(); }
});

test('B4.2B-API5 multi-group undo accepts a result revision from another epoch', async () => {
  const w = await makeWorld('undo-epoch', 'world\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const g1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const g2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await liveDocs.recordAgentGroup(w.file, {
      groupId: g1, kind: 'edit',
      baseRevision: makeLiveRevisionId('old-epoch', 0, sha256Text('hello\n')),
      resultRevision: makeLiveRevisionId('old-epoch', 1, sha256Text('mid\n')),
      changes: [{ from: 0, to: 5, insert: 'mid', removed: 'hello' }],
    });
    await liveDocs.recordAgentGroup(w.file, {
      groupId: g2, kind: 'edit',
      baseRevision: makeLiveRevisionId('new-epoch', 0, sha256Text('mid\n')),
      resultRevision: makeLiveRevisionId('new-epoch', 1, sha256Text('world\n')),
      changes: [{ from: 0, to: 3, insert: 'world', removed: 'mid' }],
    });
    const undone = await host.dispatch('documents.undoGroups', { path: w.file, groupIds: [g1, g2] });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.equal(await fs.readFile(w.file, 'utf8'), 'hello\n');
    host.close();
  } finally { w.restore(); }
});

test('B4.3-API1 conflict open/resolve enters review, does not write disk, and resists model undo', async () => {
  const w = await makeWorld('conflict', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const exchanged = await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    assert.equal(exchanged.version, 1);
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const conflicted = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(conflicted.value.conflict, true, JSON.stringify(conflicted.value));
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.value.conflict, true);
    assert.equal(opened.value.baseText, undefined, 'full base text must stay host-side');
    assert.equal(opened.value.oursText, undefined);
    assert.equal(opened.value.otherText, undefined);
    assert.equal(opened.value.hunks.length, 1);
    assert.equal(opened.value.hunks[0].base, 'base');
    assert.equal(opened.value.hunks[0].ours, 'ours');
    assert.equal(opened.value.hunks[0].other, 'theirs');
    const resolved = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId,
      resolutions: [{ choice: 'manual', text: 'merged' }],
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.value.changed, true);
    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.conflict, false, JSON.stringify(after.value));
    assert.equal(after.value.text, 'merged\n');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs\n', 'resolve must not write the disk');
    const groups = await liveDocs.listAgentGroups(w.file, 20);
    assert.equal(groups[0].kind, 'conflict-resolve');
    const modelUndo = await host.dispatch('documents.undoGroup', {
      path: w.file, groupId: resolved.value.groupId,
    }, MODEL_TOOL, execution(w.root));
    assert.equal(modelUndo.ok, false, JSON.stringify(modelUndo));
    assert.equal(modelUndo.error.code, 'MP_GROUP_NOT_ALLOWED');
    const uiUndo = await host.dispatch('documents.undoGroups', {
      path: w.file, groupIds: [resolved.value.groupId],
    });
    assert.equal(uiUndo.ok, true, JSON.stringify(uiUndo));
    assert.equal(uiUndo.value.reopenedConflict, true, JSON.stringify(uiUndo.value));
    const undone = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(undone.value.text, 'ours\n');
    assert.equal(undone.value.conflict, true, 'undoing a conflict-resolution group must re-expose the original conflict');
    host.close();
  } finally { w.restore(); }
});

test('B4.3-ADV1 undoing a conflict-resolve revokes save authorization', async () => {
  const w = await makeWorld('conflict-undo-save', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const resolved = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId,
      resolutions: [{ choice: 'manual', text: 'merged\n' }],
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const undo = await host.dispatch('documents.undoGroups', { path: w.file, groupIds: [resolved.value.groupId] });
    assert.equal(undo.ok, true, JSON.stringify(undo));
    const room = await liveDocs.readRoom(w.file);
    assert.ok(room, 'room still exists');
    assert.equal(room.text, 'ours\n');
    let wrote = false;
    const save = await liveDocs.save(member.client, {
      epoch: member.epoch, version: room.version, text: room.text,
    }, async () => { wrote = true; await fs.writeFile(w.file, room.text, 'utf8'); return { ok: true }; }).catch((error) => error);
    assert.equal(save.code, 'MP_FILE_CONFLICT', 'revoked resolution must refuse the save');
    assert.equal(wrote, false, 'writer must not run');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs\n', 'external disk must remain intact');
    const db = new DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    try {
      const row = db.prepare('SELECT disk FROM room_resolved WHERE epoch=?').get(member.epoch);
      assert.equal(row?.disk, '', 'undo keeps an explicit sentinel marker');
    } finally { db.close(); }
    host.close();
  } finally { w.restore(); }
});

test('B4.3-ADV2 all-ours resolution authorizes the overwrite and writes only on save', async () => {
  const w = await makeWorld('conflict-ours', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const resolved = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId,
      resolutions: [{ choice: 'ours' }],
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.value.changed, false);
    assert.equal(resolved.value.resolved, true);
    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.conflict, false, JSON.stringify(after.value));
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs\n', 'resolve itself is zero-write');
    const room = await liveDocs.readRoom(w.file);
    assert.equal(room.text, 'ours\n');
    const saved = await liveDocs.save(member.client, {
      epoch: member.epoch, version: room.version, text: room.text,
    }, async () => { await fs.writeFile(w.file, 'ours\n', 'utf8'); return { ok: true }; });
    assert.equal(saved.savedVersion, room.version);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'ours\n');
    host.close();
  } finally { w.restore(); }
});

test('B3.3b-API1 a fresh dirty mirror is readable but never writable', async () => {
  const w = await makeWorld('mirror-read', 'disk\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.putDraft(w.file, {
      text: 'draft\n', baseVersion: 'v0', baseSha256: revisionTextSha('disk\n'), docToken: 'mirror-read-token',
    });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.value.source, 'mirror');
    assert.equal(read.value.text, 'draft\n');
    assert.equal(read.value.dirty, true);
    assert.equal(read.value.writable, false);
    assert.equal(read.value.draft, true);
    assert.match(read.value.version, /^rev1:mirror:/);
    assert.equal(parseRevisionId(read.value.version).kind, 'mirror');

    const apply = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, edits: [{ oldString: 'draft', newString: 'AI' }],
    }, MODEL_TOOL, execution(w.root));
    assert.equal(apply.ok, false);
    assert.equal(apply.error.code, 'MP_DOC_MIRROR_READONLY');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'disk\n');
    host.close();
  } finally { w.restore(); }
});

test('B3.3b-API2 a stale or unknown mirror returns disk text and closes writes', async () => {
  const w = await makeWorld('mirror-stale', 'disk\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.putDraft(w.file, {
      text: 'old draft\n', baseVersion: 'v0', baseSha256: 'b'.repeat(64), docToken: 'stale-token',
    });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const stale = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(stale.ok, true, JSON.stringify(stale));
    assert.equal(stale.value.source, 'disk');
    assert.equal(stale.value.text, 'disk\n');
    assert.equal(stale.value.writable, false);
    assert.equal(stale.value.draftStale, true);
    assert.equal(stale.value.draft, false);
    host.close();
  } finally { w.restore(); }
});

test('B3.3b-API3 editor mirror endpoints write/read/clear without model authority', async () => {
  const w = await makeWorld('mirror-api', 'disk\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const write = await host.dispatch('documents.draftMirror', {
      path: w.file, text: 'draft\n', baseVersion: 'v0', baseSha256: revisionTextSha('disk\n'), docToken: 'mirror-api-token',
    });
    assert.equal(write.ok, true, JSON.stringify(write));
    assert.match(write.value.textSha256, /^[0-9a-f]{64}$/);
    const read = await host.dispatch('documents.draftRead', { path: w.file, docToken: 'mirror-api-token' });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.value.text, 'draft\n');
    const clear = await host.dispatch('documents.draftClear', { path: w.file, docToken: 'mirror-api-token' });
    assert.equal(clear.ok, true, JSON.stringify(clear));
    assert.equal(clear.value.removed, 1);
    const modelRead = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(modelRead.ok, true, JSON.stringify(modelRead));
    assert.equal(modelRead.value.source, 'disk');
    assert.equal(modelRead.value.text, 'disk\n');
    assert.equal(modelRead.value.writable, true);
    const denied = await host.dispatch('documents.draftMirror', { path: w.file, text: 'x', docToken: 'x' }, MODEL_TOOL, execution(w.root));
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'bad-request');
    host.close();
  } finally { w.restore(); }
});

test('B3.3b-API4 a clean room cannot mask an unsaved mirror', async () => {
  const w = await makeWorld('mirror-clean-room', 'disk\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const joined = await liveDocs.join(w.file, 'disk\n');
    const db = new DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    db.prepare('DELETE FROM clients WHERE epoch=?').run(joined.epoch);
    db.close();
    await liveDocs.putDraft(w.file, {
      text: 'typed by user\n', baseVersion: 'v0', baseSha256: revisionTextSha('disk\n'), docToken: 'clean-room-token',
    });
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.value.writable, false);
    assert.equal(read.value.mirrorDraft, true);
    assert.equal(read.value.source, 'mirror');
    assert.equal(read.value.text, 'typed by user\n');
    assert.equal(read.value.draft, true);
    const apply = await host.dispatch('documents.applyEdits', {
      path: w.file, baseRevisionId: read.value.version, edits: [{ oldString: 'disk', newString: 'AI' }],
    }, MODEL_TOOL, execution(w.root));
    assert.equal(apply.ok, false);
    assert.equal(apply.error.code, 'MP_DOC_MIRROR_READONLY');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'disk\n');
    host.close();
  } finally { w.restore(); }
});

test('B3.3b-API5 a corrupt mirror is unknown, not clean', async () => {
  const w = await makeWorld('mirror-corrupt', 'disk\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    await liveDocs.putDraft(w.file, {
      text: 'corrupt me\n', baseVersion: 'v0', baseSha256: revisionTextSha('disk\n'), docToken: 'corrupt-token',
    });
    const db = new DatabaseSync(path.join(w.live, 'rooms.sqlite'));
    db.prepare("UPDATE draft_index SET text_sha=? WHERE source LIKE '%doc.md'").run('0'.repeat(64));
    db.close();
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    const read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.value.source, 'disk');
    assert.equal(read.value.text, 'disk\n');
    assert.equal(read.value.writable, false);
    assert.equal(read.value.draftUnknown, true);
    host.close();
  } finally { w.restore(); }
});

test('B4.4-API1 save of a deleted file keeps FS_STALE_VERSION and adds reason=missing', async () => {
  const w = await makeWorld('save-missing', 'disk\n');
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const opened = await host.dispatch('open', { path: w.file });
    await fs.unlink(w.file);
    const saved = await host.dispatch('save', { path: w.file, text: 'draft\n', baseVersion: opened.value.version });
    assert.equal(saved.ok, false);
    assert.equal(saved.error.code, 'FS_STALE_VERSION');
    assert.equal(saved.error.reason, 'missing');
    assert.equal(await fs.readFile(w.file, 'utf8').catch(() => null), null, 'must not recreate the deleted file');
    host.close();
  } finally { w.restore(); }
});

test('B4.4-API2 normal save errors do not carry reason', async () => {
  const w = await makeWorld('save-normal', 'disk\n');
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const opened = await host.dispatch('open', { path: w.file });
    const saved = await host.dispatch('save', { path: w.file, text: 'draft\n', baseVersion: opened.value.version + '-stale' });
    assert.equal(saved.ok, false);
    assert.equal(saved.error.code, 'FS_STALE_VERSION');
    assert.equal('reason' in saved.error, false);
    host.close();
  } finally { w.restore(); }
});

test('B4.4-API3 stat reports missing after external deletion', async () => {
  const w = await makeWorld('stat-missing', 'disk\n');
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    await fs.unlink(w.file);
    const stat = await host.dispatch('stat', { path: w.file });
    assert.equal(stat.ok, true);
    assert.equal(stat.value.missing, true);
    host.close();
  } finally { w.restore(); }
});

test('B4.4-API4 saveAs uses provider createIfAbsent and rejects unsafe names', async () => {
  const w = await makeWorld('save-as', 'old\n');
  const target = w.file + '.copy.md';
  await fs.unlink(target).catch(() => {});
  let createCalls = 0;
  const tiny = {
    async resolve(value) { return { targetKey: value, displayPath: value }; },
    async stat(value) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      try { const info = await fs.stat(p); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: 'v' + info.mtimeMs }; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async readText(value) { return fs.readFile(typeof value === 'string' ? value : value?.targetKey, 'utf8'); },
    async writeText(value, text, options) {
      if (options?.kind !== 'createIfAbsent') throw Object.assign(new Error('unexpected write mode'), { code: 'FS_IO_ERROR' });
      createCalls += 1;
      const p = typeof value === 'string' ? value : value?.targetKey;
      const handle = await fs.open(p, 'wx', 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      return { version: 'v-created' };
    },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
  try {
    const host = createHost({ fs: tiny, log: { warn() {} } });
    const first = await host.dispatch('docs/saveAs', { path: w.file, targetPath: target, text: 'copy\n' });
    assert.equal(first.ok, true);
    assert.equal(first.value.version, 'v-created');
    assert.equal(createCalls, 1, 'saveAs must call the provider createIfAbsent first');
    assert.equal(await fs.readFile(target, 'utf8'), 'copy\n');
    const second = await host.dispatch('docs/saveAs', { path: w.file, targetPath: target, text: 'overwrite\n' });
    assert.equal(second.ok, false);
    assert.equal(second.error.code, 'FS_EXISTS');
    assert.equal(createCalls, 1, 'existing target must not reach the writer');
    assert.equal(await fs.readFile(target, 'utf8'), 'copy\n');
    for (const unsafe of [
      'relative.md',
      target + ':ads',
      path.join(path.dirname(target), 'CON.md'),
      path.join(path.dirname(target), 'name.md.'),
      path.join(path.dirname(target), 'name.space.md '),
      '\\rooted.md',
      '\\\\?/C:/tmp/x.md',
      '\\\\server\\share\\dir:ads\\x.md',
    ]) {
      const result = await host.dispatch('docs/saveAs', { path: w.file, targetPath: unsafe, text: 'x' });
      assert.equal(result.ok, false, 'must reject ' + unsafe);
    }
    const model = await host.dispatch('docs/saveAs', { path: w.file, targetPath: target + '.2.md', text: 'x' }, MODEL_TOOL, { agent: { session: { header: { cwd: path.dirname(target) } } } });
    assert.equal(model.ok, false, 'model tool must not call saveAs');
    assert.equal(createCalls, 1);
    host.close();
  } finally {
    await fs.unlink(target).catch(() => {});
    await fs.unlink(target + '.2.md').catch(() => {});
    w.restore();
  }
});

test('B4.4-API4b saveAs falls back to safeFile after a sandbox denial', async () => {
  const w = await makeWorld('save-as-fallback', 'old\n');
  const target = w.file + '.sandbox-copy.md';
  await fs.unlink(target).catch(() => {});
  let attempts = 0;
  const tiny = {
    async resolve(value) { return { targetKey: value, displayPath: value }; },
    async stat(value) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      try { const info = await fs.stat(p); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: 'v' + info.mtimeMs }; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async readText(value) { return fs.readFile(typeof value === 'string' ? value : value?.targetKey, 'utf8'); },
    async writeText() { attempts += 1; throw Object.assign(new Error('denied by sandbox'), { code: 'FS_SANDBOX_DENIED' }); },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
  try {
    const host = createHost({ fs: tiny, log: { warn() {} } });
    const result = await host.dispatch('docs/saveAs', { path: w.file, targetPath: target, text: 'copy\n' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(attempts, 1);
    assert.notEqual(result.value.version, '');
    assert.equal(await fs.readFile(target, 'utf8'), 'copy\n');
    const leftovers = (await fs.readdir(path.dirname(target))).filter((name) => name.startsWith('.mp-tmp-'));
    assert.deepEqual(leftovers, []);
    host.close();
  } finally {
    await fs.unlink(target).catch(() => {});
    w.restore();
  }
});
test('B4.4-API4c saveAs does not fall back when the policy is read-only', async () => {
  const w = await makeWorld('save-as-readonly', 'old\n');
  const target = path.join(path.dirname(w.file), 'read-only', 'copy.md');
  await fs.unlink(target).catch(() => {});
  const tiny = {
    async resolve(value) { return { targetKey: value, displayPath: value }; },
    async stat(value) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      try { const info = await fs.stat(p); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: 'v' + info.mtimeMs }; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async readText(value) { return fs.readFile(typeof value === 'string' ? value : value?.targetKey, 'utf8'); },
    async writeText(value) { throw Object.assign(new Error('cannot write "' + (value?.targetKey ?? value) + '": file access denied under read-only mode'), { code: 'FS_SANDBOX_DENIED' }); },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
  try {
    const host = createHost({ fs: tiny, log: { warn() {} } });
    const result = await host.dispatch('docs/saveAs', { path: w.file, targetPath: target, text: 'copy\n' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FS_SANDBOX_DENIED');
    await assert.rejects(fs.stat(target), (error) => error.code === 'ENOENT');
    host.close();
  } finally {
    await fs.unlink(target).catch(() => {});
    w.restore();
  }
});
test('B4.4-API5 fileState and locate find a renamed file by identity', async () => {
  const w = await makeWorld('locate', 'body\n');
  const renamed = w.file + '-renamed.md';
  try {
    const host = createHost({ fs: provider(w.file), log: { warn() {} } });
    const opened = await host.dispatch('open', { path: w.file });
    const saved = await host.dispatch('save', { path: w.file, text: 'saved\n', baseVersion: opened.value.version });
    assert.equal(saved.ok, true);
    await fs.rename(w.file, renamed);
    const state = await host.dispatch('documents.fileState', { path: w.file });
    assert.equal(state.ok, true);
    assert.equal(state.value.missing, true);
    const located = await host.dispatch('documents.locate', { path: w.file });
    assert.equal(located.ok, true);
    assert.equal(located.value.missing, true);
    assert.equal(located.value.candidates.some((item) => String(item.path).endsWith('-renamed.md')), true);
    const model = await host.dispatch('documents.locate', { path: w.file }, MODEL_TOOL, { agent: { session: { header: { cwd: path.dirname(w.file) } } } });
    assert.equal(model.ok, false);
    host.close();
  } finally {
    await fs.rename(renamed, w.file).catch(() => {});
    w.restore();
  }
});

test('B4.3-ADV2b theirs and both choices resolve without writing disk', async () => {
  const w = await makeWorld('conflict-choices', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const first = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(first.ok, true, JSON.stringify(first));
    const mine = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: first.value.conflictId, resolutions: [{ choice: 'theirs' }],
    });
    assert.equal(mine.ok, true, JSON.stringify(mine));
    assert.equal(mine.value.changed, true);
    let read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(read.value.text, 'theirs\n');
    assert.equal(read.value.conflict, false);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs\n');

    await fs.writeFile(w.file, 'theirs2\n', 'utf8');
    const second = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(second.ok, true, JSON.stringify(second));
    const both = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: second.value.conflictId, resolutions: [{ choice: 'both' }],
    });
    assert.equal(both.ok, true, JSON.stringify(both));
    assert.equal(both.value.changed, true);
    read = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.match(read.value.text, /theirs2/);
    assert.match(read.value.text, /theirs/);
    assert.equal(read.value.conflict, false);
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs2\n', 'resolve must not write disk');
    host.close();
  } finally { w.restore(); }
});

test('B4.3-ADV4 a later join ticket carries the resolved disk marker', async () => {
  const w = await makeWorld('conflict-ticket', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    const resolved = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId,
      resolutions: [{ choice: 'manual', text: 'merged\n' }],
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const second = await liveDocs.join(w.file, 'theirs\n');
    assert.equal(second.resolvedDisk, resolved.value.resolvedDisk);
    assert.equal(second.resolvedDisk, opened.value.diskHash);
    const room = await liveDocs.readRoom(w.file);
    assert.equal(room.resolvedDisk, opened.value.diskHash);
    host.close();
  } finally { w.restore(); }
});

test('B4.3-API2 conflict cancel is zero-write and a stale buffer refuses resolve', async () => {
  const w = await makeWorld('conflict-cancel', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const cancelled = await host.dispatch('documents.conflictCancel', { path: w.file, conflictId: opened.value.conflictId });
    assert.equal(cancelled.ok, true);
    const missing = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId, resolutions: [{ choice: 'ours' }],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'MP_CONFLICT_NOT_FOUND');
    const openedAgain = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    assert.equal(openedAgain.ok, true, JSON.stringify(openedAgain));
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 1, seq: 2, changes: [{ from: 0, to: 4, insert: 'mine' }],
    });
    const stale = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: openedAgain.value.conflictId, resolutions: [{ choice: 'ours' }],
    });
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal(stale.error.code, 'MP_DOC_STALE');
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs\n');
    host.close();
  } finally { w.restore(); }
});

test('B4.3-API3 resolved conflict saves once and clears room_resolved', async () => {
  const w = await makeWorld('conflict-save', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    const resolved = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId,
      resolutions: [{ choice: 'manual', text: 'merged' }],
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const saved = await liveDocs.save(member.client, { epoch: member.epoch, version: 2, text: 'merged\n' }, async () => {
      await fs.writeFile(w.file, 'merged\n', 'utf8');
      return { ok: true, version: 'prov-merged' };
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(await fs.readFile(w.file, 'utf8'), 'merged\n');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(w.live, 'rooms.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_resolved').get().n, 0); }
    finally { db.close(); }
    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.conflict, false, JSON.stringify(after.value));
    assert.equal(after.value.dirty, false);
    host.close();
  } finally { w.restore(); }
});

test('B4.3-API4 a second external change after resolve re-enters conflict and refuses save', async () => {
  const w = await makeWorld('conflict-again', 'base\n');
  try {
    const liveDocs = new LiveDocuments({ directory: w.live });
    const member = await liveDocs.join(w.file, 'base\n');
    const host = createHost({ fs: provider(w.file), liveDocuments: liveDocs, log: { warn() {} } });
    await liveDocs.exchange(member.client, {
      epoch: member.epoch, version: 0, seq: 1, changes: [{ from: 0, to: 4, insert: 'ours' }],
    });
    await fs.writeFile(w.file, 'theirs\n', 'utf8');
    const opened = await host.dispatch('documents.conflictOpen', { path: w.file, cwd: w.root });
    const resolved = await host.dispatch('documents.conflictResolve', {
      path: w.file, cwd: w.root, conflictId: opened.value.conflictId,
      resolutions: [{ choice: 'manual', text: 'merged' }],
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    await fs.writeFile(w.file, 'theirs-again\n', 'utf8');
    const after = await host.dispatch('documents.read', { path: w.file }, MODEL_TOOL, execution(w.root));
    assert.equal(after.value.conflict, true, JSON.stringify(after.value));
    await assert.rejects(
      () => liveDocs.save(member.client, { epoch: member.epoch, version: 2, text: 'merged\n' }, async () => {
        await fs.writeFile(w.file, 'merged\n', 'utf8');
        return { ok: true, version: 'should-not-write' };
      }),
      (error) => error.code === 'MP_FILE_CONFLICT',
    );
    assert.equal(await fs.readFile(w.file, 'utf8'), 'theirs-again\n');
    host.close();
  } finally { w.restore(); }
});
