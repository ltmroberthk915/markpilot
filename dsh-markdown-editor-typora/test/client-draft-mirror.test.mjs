import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;

function opened(text = 'base', version = 'v1') {
  return { ok: true, value: { text, version, displayPath: 'D:/probe/a.md', size: text.length } };
}

test('B3.3b-client liveUnsupported dirty edit posts a read-only mirror', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return { ok: true, value: { ...opened('base', 'v1').value, diskRevisionSha: 'a'.repeat(64) } };
    if (req.endpoint === 'documents.draftMirror') {
      return { ok: true, value: { textSha256: 'b'.repeat(64), bytes: 9, docToken: 'dshdoc-fixture' } };
    }
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.liveUnsupported = true;
  assert.equal(doc.baseSha256, 'a'.repeat(64));
  h.edit('typed');
  await drain();

  const request = h.requests.find((r) => r.endpoint === 'documents.draftMirror');
  assert.ok(request, 'a dirty unsupported edit must reach the mirror endpoint');
  assert.equal(request.payload.text, 'typed');
  assert.equal(request.payload.baseSha256, 'a'.repeat(64));
  assert.equal(request.payload.baseVersion, 'v1');
  assert.match(request.payload.docToken, /^dshdoc-/);
  assert.equal(doc.draftMirror.textSha256, 'b'.repeat(64));
  h.cleanup();
});

test('B3.3b-client successful save clears the mirror', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.draftMirror') return { ok: true, value: { textSha256: 'b'.repeat(64), docToken: 'tok' } };
    if (req.endpoint === 'documents.draftClear') return { ok: true, value: { removed: 1 } };
    if (req.endpoint === 'save') return { ok: true, value: { version: 'v2', diskRevisionSha: 'c'.repeat(64) } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.liveUnsupported = true;
  doc.baseSha256 = 'a'.repeat(64);
  h.edit('typed');
  await drain();
  assert.ok(doc.draftMirror);
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  const clear = h.requests.find((r) => r.endpoint === 'documents.draftClear');
  assert.ok(clear, 'save success must clear the mirror');
  const mirror = h.requests.find((r) => r.endpoint === 'documents.draftMirror');
  assert.equal(clear.payload.docToken, mirror.payload.docToken);
  assert.equal(doc.baseSha256, 'c'.repeat(64));
  assert.equal(doc.draftMirror, null);
  h.cleanup();
});

test('B3.3b-client discard clears a mirror even without a local handle', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.draftRead') return { ok: true, value: { docToken: 'old-token', textSha256: 'b'.repeat(64) } };
    if (req.endpoint === 'documents.draftClear') return { ok: true, value: { removed: 1 } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.liveUnsupported = true;
  doc.recovery = { text: 'old', docToken: 'old-token' };
  h.st.actions.discardRecovery();
  await drain();
  const clear = h.requests.find((r) => r.endpoint === 'documents.draftClear');
  assert.ok(clear, 'discard must clear the server mirror even in a new generation');
  assert.equal(clear.payload.docToken, 'old-token');
  h.cleanup();
});

test('B3.3b-client cleanup cancels the pending mirror timer', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.draftMirror') return { ok: true, value: { textSha256: 'b'.repeat(64) } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.liveUnsupported = true;
  doc.baseSha256 = 'a'.repeat(64);
  h.edit('typed');
  await drain();
  const before = h.requests.filter((r) => r.endpoint === 'documents.draftMirror').length;
  h.cleanup();
  await h.advance(1600);
  assert.equal(h.requests.filter((r) => r.endpoint === 'documents.draftMirror').length, before);
  h.cleanup();
});

test('B3.3b-client open adopts an existing mirror handle for later cleanup', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.draftRead') return { ok: true, value: { docToken: 'old-token', textSha256: 'b'.repeat(64) } };
    if (req.endpoint === 'documents.draftClear') return { ok: true, value: { removed: 1 } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  assert.equal(doc.draftMirror.textSha256, 'b'.repeat(64));
  doc.recovery = { text: 'old', docToken: 'old-token' };
  h.st.actions.discardRecovery();
  await drain();
  const clear = h.requests.find((r) => r.endpoint === 'documents.draftClear');
  assert.ok(clear);
  assert.equal(clear.payload.docToken, 'old-token');
  h.cleanup();
});

test('B3.3b-client conflict state still mirrors a dirty unsupported buffer', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.draftMirror') return { ok: true, value: { textSha256: 'b'.repeat(64) } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.liveUnsupported = true;
  doc.baseSha256 = 'a'.repeat(64);
  doc.conflict = true;
  h.edit('typed during conflict');
  await drain();
  const request = h.requests.find((r) => r.endpoint === 'documents.draftMirror');
  assert.ok(request, 'conflict must not hide the editor buffer from the read-only mirror');
  assert.equal(request.payload.text.includes('typed during conflict'), true);
  h.cleanup();
});

test('B3.3b-client live-mode save clears an adopted residual mirror', async () => {
  const h = make();
  let mirrored = true;
  h.setFetch((req) => {
    if (req.endpoint === 'open') return { ok: true, value: { ...opened('base', 'v1').value, diskRevisionSha: 'a'.repeat(64) } };
    if (req.endpoint === 'documents.draftRead') return mirrored ? { ok: true, value: { docToken: 'old-token', textSha256: 'b'.repeat(64) } } : { ok: true, value: null };
    if (req.endpoint === 'documents.draftClear') { mirrored = false; return { ok: true, value: { removed: 1 } }; }
    if (req.endpoint === 'save') return { ok: true, value: { version: 'v2', diskRevisionSha: 'c'.repeat(64) } };
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  assert.ok(doc.draftMirror, 'open must adopt the residual mirror');
  doc.liveUnsupported = false;
  h.edit('typed');
  h.message('manual-save', { source: 'ctrl-s' });
  await drain();
  const clear = h.requests.filter((r) => r.endpoint === 'documents.draftClear');
  assert.ok(clear.length >= 1, 'live-mode save must clear the residual mirror');
  assert.equal(doc.draftMirror, null);
  h.cleanup();
});

test('B3.3b-client mirror is not sent while a live room owns the buffer', async () => {
  const h = make();
  await h.boot();
  const doc = h.st.doc;
  doc.liveUnsupported = false;
  h.edit('typed');
  await drain();
  assert.equal(h.requests.filter((r) => r.endpoint === 'documents.draftMirror').length, 0);
  h.cleanup();
});
