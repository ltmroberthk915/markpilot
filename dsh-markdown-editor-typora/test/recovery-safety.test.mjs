import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]);
const text = (n) => (typeof n === 'string' ? n : !n || typeof n !== 'object' ? '' : (n.children || []).map(text).join(''));
const button = (h, label) => nodes(h.render()).find((n) => n.type === 'button' && text(n) === label);
const pill = (h) => nodes(h.render()).find((n) => n.props?.['data-mp-save-status']);

test('stale recovery slot is archived instead of offered for restore', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'OLD-DRAFT', baseVersion: 'v2', ts: 1, docToken: 'old-token', session: { epoch: 1, sourceRevision: 1 },
  });
  await h.boot();
  await drain();
  assert.notEqual(h.ui().phase, 'recovery');
  assert.equal(button(h, '恢复'), undefined);
  const archive = h.requests.filter((r) => r.endpoint === 'archive');
  assert.equal(archive.length, 1);
  assert.equal(archive[0].payload.tag, 'stale-draft');
  assert.equal(archive[0].payload.text, 'OLD-DRAFT');
  assert.ok(h.posts.some((p) => p.type === 'toast' && String(p.content).includes('已归档旧草稿副本')));
  h.cleanup();
});

test('restore refuses a slot that was based on an older disk version', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'OLD-DRAFT', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  assert.equal(h.ui().phase, 'recovery');
  assert(button(h, '恢复'));
  // The disk moves on after the slot was captured: applying it must be refused.
  h.st.doc.lastVersion = 'v2';
  await h.st.actions.restoreRecovery();
  await drain();
  assert.notEqual(h.engine.text, 'OLD-DRAFT');
  assert.equal(h.st.doc.recovery, null);
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'stale-draft'));
  assert.notEqual(h.ui().phase, 'recovery');
  h.cleanup();
});

test('restore snapshots the current text before applying and never auto-saves it', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  assert.equal(h.ui().phase, 'recovery');
  await h.st.actions.restoreRecovery();
  await drain();
  assert.equal(h.engine.text, 'RESTORE-ME');
  assert(h.st.doc.dirty);
  const backup = h.requests.filter((r) => r.endpoint === 'archive' && r.payload.tag === 'pre-restore');
  assert.equal(backup.length, 1);
  assert.equal(backup[0].payload.text, 'disk-v1');
  await h.advance(5000);
  assert.equal(h.requests.filter((r) => r.endpoint === 'save').length, 0, 'restore must not write itself to disk');
  assert.equal(h.ui().saveStatus, 'unsaved');
  h.cleanup();
});

test('a recovery slot identical to the disk text is cleared without a banner', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'disk-v1', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  await drain();
  assert.notEqual(h.ui().phase, 'recovery');
  assert.equal(h.requests.filter((r) => r.endpoint === 'archive').length, 0);
  h.cleanup();
});

test('archiving a stale slot never clears it without a durable path', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'OLD-DRAFT', baseVersion: 'v2', ts: 1, docToken: 'old-token',
  });
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: true, value: {} }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  await h.boot();
  await drain();
  assert.equal(h.ui().phase, 'error');
  assert(button(h, '重试'));
  assert.equal(h.engine.text, 'disk-v1');
  h.cleanup();
});

test('archive failure keeps the stale draft retryable and never restores it', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'OLD-DRAFT', baseVersion: 'v2', ts: 1, docToken: 'old-token',
  });
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: false, error: { code: 'EACCES', message: 'archive denied' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  await h.boot();
  await drain();
  assert.equal(h.ui().phase, 'error');
  assert(button(h, '重试'));
  assert.equal(h.engine.text, 'disk-v1');
  assert.notEqual(h.engine.text, 'OLD-DRAFT');
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: true, value: { archivePath: 'D:/probe/.archive/stale.md' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.st.actions.retry();
  await drain();
  await drain();
  assert.notEqual(h.ui().phase, 'error');
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'stale-draft'));
  assert.equal(h.st.doc.staleDraftPending, null);
  h.cleanup();
});

test('edits arriving while the recovery mark is pending stay dirty', async () => {
  const h = make();
  await h.boot();
  let release;
  h.draftStore.markSaved = () => new Promise((resolve) => { release = resolve; });
  h.setFetch((req) => (req.endpoint === 'save'
    ? { ok: true, value: { version: 'v2' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.edit('FIRST');
  h.message('manual-save');
  await drain();
  assert(h.st.doc.saving, 'save is waiting on the recovery mark');
  h.edit('FIRST-TAIL');
  release({ ok: true, durable: true });
  await drain();
  assert(h.st.doc.dirty, 'an edit during markSaved must keep the document dirty');
  assert.equal(h.ui().saveStatus, 'unsaved');
  h.cleanup();
});

test('Ctrl+S while the recovery banner is visible is refused with a notice', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  assert.equal(h.ui().phase, 'recovery');
  assert.equal(h.st.doc.phase, 'recovery');
  h.message('manual-save');
  await drain();
  assert.equal(h.requests.filter((r) => r.endpoint === 'save').length, 0);
  assert.ok(h.posts.some((p) => p.type === 'toast' && String(p.content).includes('未保存的恢复内容')));
  assert.notEqual(h.ui().saveStatus, 'saved');
  await h.st.actions.discardRecovery();
  await drain();
  assert.equal(h.st.doc.phase, 'ready');
  h.cleanup();
});

test('restore stops when the pre-restore backup has no verifiable path', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  assert.equal(h.ui().phase, 'recovery');
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: true, value: {} }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  await h.st.actions.restoreRecovery();
  await drain();
  assert.notEqual(h.engine.text, 'RESTORE-ME');
  assert.equal(h.ui().phase, 'error');
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'pre-restore'));
  h.cleanup();
});

test('a stale restore whose archive fails keeps a retryable error banner', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'OLD-DRAFT', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  h.st.doc.lastVersion = 'v2';
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: false, error: { code: 'EACCES', message: 'archive denied' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  await h.st.actions.restoreRecovery();
  await drain();
  assert.notEqual(h.engine.text, 'OLD-DRAFT');
  assert.equal(h.ui().phase, 'error');
  assert(h.st.doc.staleDraftPending);
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: true, value: { archivePath: 'D:/probe/.archive/stale.md' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.st.actions.retry();
  await drain();
  await drain();
  assert.equal(h.st.doc.staleDraftPending, null);
  assert.notEqual(h.ui().phase, 'error');
  h.cleanup();
});

test('the draft store refuses to clear with an empty token', async () => {
  const h = make();
  const store = h.test.createDraftStore();
  const missing = await store.clear('D:/probe/a.md', undefined, undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'RECOVERY_OWNER');
  const empty = await store.clear('D:/probe/a.md', '', undefined);
  assert.equal(empty.ok, false);
  h.cleanup();
});

test('archiving a legacy slot never calls store.clear with an empty token', async () => {
  const h = make();
  const path = h.st.doc.absPath;
  const legacyKey = 'dsh-markdown-editor-typora:recovery:' + path;
  h.storage.set(legacyKey, JSON.stringify({ text: 'LEGACY-ONLY', path, ts: 1 }));
  const calls = [];
  const original = h.draftStore.clear;
  h.draftStore.clear = (...args) => { calls.push(args); return original(...args); };
  await h.boot();
  await drain();
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'stale-draft'));
  assert.ok(calls.every((args) => typeof args[1] === 'string' && args[1].length > 0), 'no empty token may reach store.clear');
  assert.equal(h.storage.has(legacyKey), false);
  h.cleanup();
});

test('typing during the pre-restore backup aborts the restore', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  let release;
  h.setFetch((req) => (req.endpoint === 'archive'
    ? new Promise((resolve) => { release = resolve; })
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  const pending = h.st.actions.restoreRecovery();
  await drain();
  assert.equal(typeof release, 'function');
  h.edit('TYPED');
  release({ ok: true, value: { archivePath: 'D:/probe/.archive/pre-restore.md' } });
  await pending;
  await drain();
  assert.equal(h.engine.text, 'TYPED');
  assert(h.st.doc.dirty);
  assert.notEqual(h.st.doc.recovery, null);
  h.cleanup();
});

test('a disk version change during the pre-restore backup re-routes to stale archive', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  let release;
  let archiveCalls = 0;
  h.setFetch((req) => {
    if (req.endpoint !== 'archive') return { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } };
    archiveCalls += 1;
    if (archiveCalls === 1) return new Promise((resolve) => { release = resolve; });
    return { ok: true, value: { archivePath: 'D:/probe/.archive/stale.md' } };
  });
  const pending = h.st.actions.restoreRecovery();
  await drain();
  h.st.doc.lastVersion = 'v2';
  release({ ok: true, value: { archivePath: 'D:/probe/.archive/pre-restore.md' } });
  await pending;
  await drain();
  assert.notEqual(h.engine.text, 'RESTORE-ME');
  assert.equal(h.st.doc.recovery, null);
  assert.equal(archiveCalls, 2);
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'stale-draft'));
  h.cleanup();
});

test('the restored-but-unsaved pill tells the user to press Ctrl+S', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  await h.st.actions.restoreRecovery();
  await drain();
  assert.equal(text(pill(h)), '未保存 · 按 Ctrl+S 保存');
  assert.match(String(pill(h)?.props?.title || ''), /未写盘/);
  h.cleanup();
});

test('a failed pre-restore backup keeps the draft discardable', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: false, error: { code: 'EACCES', message: 'denied' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  await h.st.actions.restoreRecovery();
  await drain();
  assert.equal(h.ui().phase, 'error');
  assert(button(h, '重试'));
  assert(button(h, '丢弃恢复内容'));
  await h.st.actions.discardRecovery();
  await drain();
  assert.equal(h.ui().phase, 'ready');
  assert.equal(h.st.doc.recovery, null);
  h.cleanup();
});

test('a failed pre-restore backup can be retried successfully', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  let archiveFails = true;
  h.setFetch((req) => (req.endpoint === 'archive'
    ? (archiveFails ? { ok: false, error: { code: 'EACCES', message: 'denied' } } : { ok: true, value: { archivePath: 'D:/probe/.archive/pre.md' } })
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  await h.st.actions.restoreRecovery();
  await drain();
  assert.equal(h.ui().phase, 'error');
  archiveFails = false;
  h.st.actions.retry();
  await drain();
  await drain();
  assert.equal(h.engine.text, 'RESTORE-ME');
  assert.equal(h.st.doc.recoveryBackupFailed, false);
  h.cleanup();
});

test('retry after an unrelated save failure does not hijack a sleeping recovery slot', async () => {
  const h = make();
  h.draftStore.readLatest = () => Promise.resolve({
    text: 'RESTORE-ME', baseVersion: 'v1', ts: 1, docToken: 'old-token',
  });
  await h.boot();
  assert.equal(h.ui().phase, 'recovery');
  h.edit('USER-EDIT');
  await drain();
  assert.equal(h.st.doc.phase, 'dirty');
  assert.notEqual(h.st.doc.recovery, null);
  h.setFetch((req) => (req.endpoint === 'save'
    ? { ok: false, error: { code: 'FS_IO_ERROR', message: 'disk full' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.message('manual-save');
  await drain();
  assert.equal(h.ui().phase, 'error');
  const before = h.requests.filter((r) => r.endpoint === 'archive' && r.payload.tag === 'pre-restore').length;
  h.st.actions.retry();
  await drain();
  const after = h.requests.filter((r) => r.endpoint === 'archive' && r.payload.tag === 'pre-restore').length;
  assert.equal(after, before, 'retry must not attempt a recovery restore');
  assert.equal(h.st.doc.recoveryBackupFailed, false);
  assert.notEqual(h.engine.text, 'RESTORE-ME');
  h.cleanup();
});

test('reloading the disk version archives the editor text first', async () => {
  const h = make();
  await h.boot();
  h.edit('LOCAL');
  h.st.doc.conflict = true;
  h.st.doc.recovery = { text: 'RECOVERY-TEXT', baseVersion: 'v1' };
  const opens = () => h.requests.filter((r) => r.endpoint === 'open').length;
  const before = opens();
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: false, error: { code: 'EACCES', message: 'denied' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.st.actions.reloadDisk();
  await drain();
  await drain();
  assert.equal(opens(), before, 'a failed archive must abort the reload');
  assert.equal(h.st.doc.conflict, true);
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: true, value: { archivePath: 'D:/probe/.archive/pre-reload.md' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.st.actions.reloadDisk();
  await drain();
  await drain();
  assert.equal(opens(), before + 1);
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'pre-reload-recovery'));
  assert.ok(h.requests.some((r) => r.endpoint === 'archive' && r.payload.tag === 'pre-reload'));
  h.cleanup();
});

test('reload is refused while the editor is applying or saving', async () => {
  const h = make();
  await h.boot();
  h.edit('LOCAL');
  h.st.doc.conflict = true;
  h.st.doc.saving = true;
  const opens = () => h.requests.filter((r) => r.endpoint === 'open').length;
  const before = opens();
  h.setFetch((req) => (req.endpoint === 'archive'
    ? { ok: true, value: { archivePath: 'D:/probe/.archive/pre-reload.md' } }
    : { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } }));
  h.st.actions.reloadDisk();
  await drain();
  assert.equal(opens(), before);
  assert.equal(h.requests.filter((r) => r.endpoint === 'archive').length, 0);
  h.st.doc.saving = false;
  h.cleanup();
});

test('a recovery archive success followed by a dirty archive failure aborts the reload', async () => {
  const h = make();
  await h.boot();
  h.edit('LOCAL');
  h.st.doc.conflict = true;
  h.st.doc.recovery = { text: 'RECOVERY-TEXT', baseVersion: 'v1' };
  const opens = () => h.requests.filter((r) => r.endpoint === 'open').length;
  const before = opens();
  h.setFetch((req) => {
    if (req.endpoint !== 'archive') return { ok: true, value: { text: 'disk-v1', version: 'v1', displayPath: 'D:/probe/a.md', size: 7 } };
    if (req.payload.tag === 'pre-reload-recovery') return { ok: true, value: { archivePath: 'D:/probe/.archive/recovery.md' } };
    return { ok: false, error: { code: 'EACCES', message: 'denied' } };
  });
  h.st.actions.reloadDisk();
  await drain();
  await drain();
  assert.equal(opens(), before, 'the dirty archive failure must abort the reload');
  assert(h.st.doc.dirty);
  assert(h.st.doc.recovery, 'the recovery slot is kept when the dirty archive fails');
  assert.equal(h.ui().phase, 'conflict');
  h.cleanup();
});
