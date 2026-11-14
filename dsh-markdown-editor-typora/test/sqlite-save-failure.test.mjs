// Targeted plugin-side tests for SQLITE_CORRUPT(11)/NOTADB(26) save failures.
// Runs against the staged source copies only; fake HOME/LOCALAPPDATA are set by
// the invoking command, never by this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';
import {
  classifyStorageFailure,
  isLocalLiveCorruption,
  isProviderWriterError,
  localLiveSaveFailure,
  markLiveBoundaryFailure,
  markLocalLiveSaveFailure,
  markProviderWriterError,
} from '../lib/save-failure.js';

const { make, drain } = fixture;

function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.children || []).flatMap(nodes)];
}
function text(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(text).join('');
}
function button(h, label) {
  return nodes(h.render()).find((node) => node.type === 'button' && text(node) === label);
}

test('local-live marker is required; remote SQLite 11/26 is not promoted', () => {
  const remote = Object.freeze({
    code: 'ERR_SQLITE_ERROR', errcode: 11, message: 'database disk image is malformed',
  });
  assert.equal(isLocalLiveCorruption(remote), false);
  assert.equal(classifyStorageFailure(remote).storageFamily, undefined);
  assert.notEqual(classifyStorageFailure(remote).code, 'MP_STORE_CORRUPT');

  const local = Object.freeze({
    code: 'ERR_SQLITE_ERROR', errcode: 11 | (1 << 8), message: 'database disk image is malformed',
  });
  assert.equal(markLocalLiveSaveFailure(local, 'prewrite'), local);
  assert.equal(Object.isFrozen(local), true);
  assert.deepEqual({ ...localLiveSaveFailure(local) }, {
    family: 'local-live', primary: 11, phase: 'prewrite',
  });
  assert.equal(classifyStorageFailure(local).code, 'MP_STORE_CORRUPT');
  assert.equal(classifyStorageFailure(local).storageFamily, 'local-live');
  assert.equal(classifyStorageFailure(local).sqliteCode, 11);
  assert.equal(classifyStorageFailure(local).prewrite, true);

  const written = Object.freeze({ code: 'ERR_SQLITE_ERROR', errcode: 26 });
  markLocalLiveSaveFailure(written, 'written');
  assert.equal(classifyStorageFailure(written).storageFamily, 'local-live');
  assert.equal(classifyStorageFailure(written).writePhase, 'written');
  assert.equal(classifyStorageFailure(written).prewrite, undefined);
});

test('writer/provider errors cannot claim the local-live family', () => {
  const provider = Object.freeze({ code: 'ERR_SQLITE_ERROR', errcode: 11, message: 'remote malformed' });
  assert.equal(markProviderWriterError(provider), provider);
  assert.equal(isProviderWriterError(provider), true);
  assert.equal(localLiveSaveFailure(provider), null);
  assert.notEqual(classifyStorageFailure(provider).code, 'MP_STORE_CORRUPT');
  assert.equal(classifyStorageFailure(provider).storageFamily, undefined);

  const wrapped = Object.freeze({ code: 'MP_LIVE_SAVE', cause: provider });
  assert.equal(isProviderWriterError(wrapped), true);
  assert.equal(localLiveSaveFailure(wrapped), null);
  assert.notEqual(classifyStorageFailure(wrapped).code, 'MP_STORE_CORRUPT');

  // The actual apiSave boundary uses this helper: provider errors are skipped;
  // local live errors (outside the writer callback) are marked.
  markLiveBoundaryFailure(provider, 'prewrite');
  assert.equal(localLiveSaveFailure(provider), null);

  const boundaryLocal = Object.freeze({ code: 'ERR_SQLITE_ERROR', errcode: 26 });
  markLiveBoundaryFailure(boundaryLocal, 'writing');
  assert.deepEqual({ ...localLiveSaveFailure(boundaryLocal) }, {
    family: 'local-live', primary: 26, phase: 'writing',
  });
});

test('prewrite local-live CORRUPT shows 本次未保存, keeps dirty/retry, hides raw SQLite text', async () => {
  const h = make();
  await h.boot();
  h.edit('CORRUPT-DRAFT');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: {
      code: 'MP_STORE_CORRUPT', storageFamily: 'local-live', sqliteCode: 11, prewrite: true,
      message: 'database disk image is malformed',
    } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();

  assert.equal(h.ui().phase, 'error');
  assert.match(h.ui().detail, /^本次未保存：协同存储暂不可用/);
  assert.equal(h.ui().detail.includes('database disk image is malformed'), false);
  assert.equal(h.ui().saveStatus, 'unsaved');
  assert.equal(h.st.doc.dirty, true);
  assert.equal(h.engine.text, 'CORRUPT-DRAFT');
  assert.ok(button(h, '重试'), 'existing retry action must remain');
  h.cleanup();
});

test('unconfirmed local-live write phase never claims the file was not touched', async () => {
  const h = make();
  await h.boot();
  h.edit('UNCONFIRMED-DRAFT');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: {
      code: 'MP_STORE_CORRUPT', storageFamily: 'local-live', sqliteCode: 26,
      prewrite: false, writePhase: 'written', message: 'file is not a database',
    } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();

  assert.equal(h.ui().phase, 'error');
  assert.match(h.ui().detail, /^保存结果未确认：协同存储不可用/);
  assert.equal(h.ui().detail.includes('本次未保存'), false);
  assert.equal(h.ui().detail.includes('file is not a database'), false);
  assert.equal(h.st.doc.dirty, true);
  assert.ok(button(h, '重试'), 'existing retry action must remain');
  h.cleanup();
});

test('missing prewrite flag with a local marker is treated conservatively', async () => {
  const h = make();
  await h.boot();
  h.edit('UNKNOWN-PHASE');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: {
      code: 'MP_STORE_CORRUPT', storageFamily: 'local-live', sqliteCode: 11,
      message: 'database disk image is malformed',
    } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();
  assert.match(h.ui().detail, /^保存结果未确认：/);
  assert.equal(h.st.doc.dirty, true);
  h.cleanup();
});

test('recovery copy notice survives the corrupt-store early return', async () => {
  const h = make();
  await h.boot();
  h.edit('RECOVERY-DRAFT');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: {
      code: 'MP_STORE_CORRUPT', storageFamily: 'local-live', sqliteCode: 11, prewrite: true,
      recoveryPath: 'D:/probe/.archive/recovery.md',
      message: 'database disk image is malformed',
    } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();

  assert.match(h.ui().detail, /^本次未保存：/);
  const notices = Array.isArray(h.ui().notices) ? h.ui().notices : [];
  assert.ok(notices.some((entry) => entry.text === '保存失败；恢复副本已保留'
    && entry.path === 'D:/probe/.archive/recovery.md'), 'recovery notice must not be bypassed');
  assert.equal(h.st.doc.dirty, true);
  assert.ok(button(h, '重试'));
  h.cleanup();
});

test('a code-only MP_STORE_CORRUPT without a local marker is not trusted', async () => {
  const h = make();
  await h.boot();
  h.edit('PROVIDER-ERROR-DRAFT');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: { code: 'MP_STORE_CORRUPT', message: 'provider said no' } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();

  assert.match(h.ui().detail, /^保存失败：MP_STORE_CORRUPT/);
  assert.equal(h.ui().detail.includes('本次未保存'), false);
  assert.equal(h.ui().detail.includes('保存结果未确认'), false);
  assert.equal(h.st.doc.dirty, true);
  h.cleanup();
});

test('remote provider SQLite 11/26 stays on the existing generic path', async () => {
  const h = make();
  await h.boot();
  h.edit('REMOTE-PROVIDER-DRAFT');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: {
      code: 'ERR_SQLITE_ERROR', sqliteCode: 11,
      message: 'database disk image is malformed',
    } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();

  assert.equal(h.ui().phase, 'error');
  assert.match(h.ui().detail, /^保存失败：ERR_SQLITE_ERROR/);
  assert.equal(h.ui().detail.includes('本次未保存'), false);
  assert.equal(h.ui().detail.includes('保存结果未确认'), false);
  assert.equal(h.st.doc.dirty, true);
  assert.ok(button(h, '重试'));
  h.cleanup();
});

test('SQLITE_BUSY and other IO errors keep the existing failure path', async () => {
  const h = make();
  await h.boot();
  h.edit('BUSY-DRAFT');
  h.setFetch((req) => req.endpoint === 'save'
    ? { ok: false, error: {
      code: 'MP_LIVE_BUSY', sqliteCode: 5, message: 'database is locked',
    } }
    : { ok: true, value: req.endpoint === 'documents.draftRead' ? null : {} });
  h.message('manual-save');
  await drain();

  assert.equal(h.ui().phase, 'error');
  assert.equal(h.ui().detail.includes('本次未保存'), false);
  assert.equal(h.ui().detail.includes('保存结果未确认'), false);
  assert.equal(h.ui().detail.includes('database is locked'), true);
  assert.equal(h.st.doc.dirty, true);
  assert.ok(button(h, '重试'));
  h.cleanup();
});
