import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;

function opened(text = 'base', version = 'v1') {
  return { ok: true, value: { text, version, displayPath: 'D:/probe/a.md', size: text.length } };
}

test('P4-client missing latch survives typing and stops autosave', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'save') return { ok: false, error: { code: 'FS_STALE_VERSION', reason: 'missing', message: 'file no longer exists' } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  h.edit('typed');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  assert.equal(doc.missing, true);
  assert.equal(h.ui().phase, 'missing', 'save missing must surface the missing banner');
  const saves = h.requests.filter((r) => r.endpoint === 'save').length;

  h.edit('more');
  await h.advance(2000);
  assert.equal(h.ui().phase, 'missing', 'typing must not replace the missing latch with plain dirty');
  assert.equal(doc.missing, true);
  assert.equal(h.requests.filter((r) => r.endpoint === 'save').length, saves, 'missing must stop autosave');
  h.cleanup();
});

test('P4-client retry does not overwrite a dirty missing buffer', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'stat') return { ok: true, value: { version: 'v2', missing: false } };
    if (req.endpoint === 'save') return { ok: false, error: { code: 'FS_STALE_VERSION', reason: 'missing', message: 'file no longer exists' } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  h.edit('dirty');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  assert.equal(doc.missing, true);
  await h.st.actions.retryMissing();
  await drain();
  assert.equal(doc.missing, true, 'dirty retry must keep missing until the user resolves the draft');
  assert.equal(doc.dirty, true);
  h.cleanup();
});

test('P4 client saveAs modal submits the chosen target path', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'save') return { ok: false, error: { code: 'FS_STALE_VERSION', reason: 'missing', message: 'file no longer exists' } };
    if (req.endpoint === 'saveAs') return { ok: true, value: { path: req.payload.targetPath, version: 'v-copy', size: 4 } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  h.edit('dirty');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  assert.equal(doc.missing, true);
  assert.equal(typeof h.st.actions.submitSaveAs, 'function');
  doc.saving = false; doc.pendingApply = false; doc.applyUnknown = false;
  h.st.actions.openSaveAs();
  assert.equal(h.ui().saveAsOpen, true);
  assert.match(doc.saveAsValue, /-恢复-.*\.md$/);
  doc.saveAsValue = 'D:/probe/copy.md';
  await h.st.actions.submitSaveAs();
  await drain();
  const request = h.requests.find((r) => r.endpoint === 'saveAs');
  assert.ok(request);
  assert.equal(request.payload.targetPath, 'D:/probe/copy.md');
  assert.equal(request.payload.text, 'dirty');
  assert.equal(request.payload.path, doc.absPath);
  assert.equal(h.ui().saveAsOpen, false);
  h.cleanup();
});






test('P4 client saveAs refuses a stale editor text instead of copying the old mirror', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'save') return { ok: false, error: { code: 'FS_STALE_VERSION', reason: 'missing', message: 'file no longer exists' } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  h.edit('dirty');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  doc.composing = true;
  h.st.actions.openSaveAs();
  await h.st.actions.submitSaveAs();
  await drain();
  assert.equal(h.requests.filter((r) => r.endpoint === 'saveAs').length, 0);
  assert.equal(doc.saveAsBusy, false);
  assert.match(h.ui().saveAsError, /完整正文/);
  h.cleanup();
});

test('P4 client missing banner reports a rename candidate', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'save') return { ok: false, error: { code: 'FS_STALE_VERSION', reason: 'missing', message: 'gone' } };
    if (req.endpoint === 'documents.locate') return { ok: true, value: { missing: true, candidates: [{ path: 'D:/probe/renamed.md', version: 'v2', size: 4 }] } };
    return { ok: true, value: {} };
  });
  await h.boot();
  h.edit('dirty');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  assert.equal(h.ui().phase, 'missing');
  assert.match(h.ui().detail, /可能已改名/);
  assert.match(h.ui().detail, /renamed\.md/);
  h.cleanup();
});

test('P4 client readonly save error surfaces a save-as escape', async () => {
  const h = make();
  let saved = 0;
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'save') return { ok: false, error: { code: 'EACCES', message: 'denied' } };
    if (req.endpoint === 'saveAs') { saved += 1; return { ok: true, value: { path: 'D:/probe/copy.md', version: 'v-copy', size: 4 } }; }
    return { ok: true, value: {} };
  });
  await h.boot();
  h.edit('dirty');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  assert.equal(h.st.doc.readonly, true);
  assert.equal(h.ui().phase, 'readonly');
  h.st.actions.openSaveAs();
  assert.equal(h.ui().saveAsOpen, true);
  h.st.doc.saveAsValue = 'D:/probe/copy.md';
  await h.st.actions.submitSaveAs();
  await drain();
  assert.equal(saved, 1);
  assert.equal(h.ui().saveAsOpen, false);
  h.cleanup();
});
