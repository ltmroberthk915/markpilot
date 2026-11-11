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
