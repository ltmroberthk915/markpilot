import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;

function opened(text = 'base', version = 'v1') {
  return { ok: true, value: { text, version, displayPath: 'D:/probe/a.md', size: text.length } };
}

test('B4.3-UI a no-op "keep mine" resolution marks the document dirty', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.conflictResolve') {
      return {
        ok: true,
        value: {
          changed: false,
          resolved: true,
          diskVersion: 'v2',
          resolvedDisk: 'a'.repeat(64),
        },
      };
    }
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  assert.equal(doc.opened, true);
  doc.dirty = false;
  // The host session is normally produced by conflictOpen; this test only
  // needs its shape because applyConflict reads the choices it was given.
  doc.conflict = true;
  doc.conflictSession = {
    conflictId: '11111111-1111-4111-8111-111111111111',
    diskHash: 'a'.repeat(64),
    hunks: [{ base: 'old', ours: 'base', other: 'theirs' }],
  };
  doc.conflictChoices = [{ index: 0, choice: 'ours', text: '' }];

  await h.st.actions.applyConflict();
  await drain();

  assert.equal(doc.conflict, false, 'the conflict panel must close after a resolved no-op');
  assert.equal(doc.lastVersion, 'v2');
  assert.equal(doc.resolvedDisk, 'a'.repeat(64));
  assert.equal(doc.dirty, true, 'keep-mine must be dirty so Ctrl+S is not a clean no-op');
  assert.equal(h.ui().phase, 'dirty');
  assert.equal(h.requests.filter((r) => r.endpoint === 'documents.conflictResolve').length, 1);
  h.cleanup();
});

test('B4.3-UI live save reads the engine text, not a lagging parent mirror', async () => {
  const h = make();
  h.setLiveVersion(1);
  h.setFetch((req) => {
    if (req.endpoint === 'open') {
      return {
        ok: true,
        value: {
          text: '# b43-keepmine\n\n', version: 'v1',
          live: { client: 'fixture-live', epoch: 'fixture-epoch', version: 0, savedVersion: 0, diskHash: 'a'.repeat(64) },
        },
      };
    }
    if (req.endpoint === 'save') {
      return req.payload.text === 'mine'
        ? { ok: true, value: { version: 'v2' } }
        : { ok: false, error: { code: 'MP_LIVE_STALE', message: 'room text differs' } };
    }
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.dirty = true;
  // Engine-side whole-document replacement deliberately does not publish a
  // document-delta (the engine's `_o` bypass). The room is mine; the mirror is
  // still the 16-char seed. Save must ask the engine, or live.save stays STALE.
  h.engine.text = 'mine';

  h.message('manual-save', { source: 'ctrl-s' });
  await drain();

  const saves = h.requests.filter((r) => r.endpoint === 'save');
  assert.ok(saves.length >= 1, 'manual save must reach /api/save');
  assert.equal(saves.at(-1).payload.text, 'mine');
  assert.equal(saves.at(-1).payload.live.version, 1);
  assert.equal(doc.dirty, false);
  h.cleanup();
});

test('B4.3-UI review keep-save issues a live save with the engine text', async () => {
  const h = make();
  h.setLiveVersion(2);
  h.setFetch((req) => {
    if (req.endpoint === 'open') {
      return {
        ok: true,
        value: {
          text: '# seed\n\n', version: 'v1',
          live: { client: 'fixture-live', epoch: 'fixture-epoch', version: 1, savedVersion: 1, diskHash: 'a'.repeat(64) },
        },
      };
    }
    if (req.endpoint === 'save') {
      return req.payload.text === 'ai'
        ? { ok: true, value: { version: 'v2' } }
        : { ok: false, error: { code: 'MP_LIVE_STALE', message: 'room text differs' } };
    }
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.review = { groups: ['33333333-3333-4333-8333-333333333333'], count: 1 };
  doc.dirty = false;   // a stale/cleared dirty bit must not turn keep into a clean no-op
  h.engine.text = 'ai';

  h.st.actions.reviewKeep();
  await h.advance(0);
  await drain();

  const saves = h.requests.filter((r) => r.endpoint === 'save');
  assert.ok(saves.length >= 1, 'reviewKeep must issue a save');
  assert.equal(saves.at(-1).payload.text, 'ai');
  assert.equal(doc.review, null);
  assert.equal(doc.dirty, false);
  h.cleanup();
});

test('B4.3-UI manual conflict choice sends its text and enters review', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.conflictResolve') {
      return { ok: true, value: { changed: true, groupId: '44444444-4444-4444-8444-444444444444', diskVersion: 'v2', resolvedDisk: 'a'.repeat(64) } };
    }
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.conflict = true;
  doc.conflictSession = {
    conflictId: '11111111-1111-4111-8111-111111111111',
    diskHash: 'a'.repeat(64),
    hunks: [{ base: 'old', ours: 'base', other: 'theirs' }],
  };
  doc.conflictChoices = [{ index: 0, choice: 'manual', text: 'merged text' }];

  await h.st.actions.applyConflict();
  await drain();

  const request = h.requests.find((r) => r.endpoint === 'documents.conflictResolve');
  assert.ok(request);
  assert.equal(JSON.stringify(request.payload.resolutions), JSON.stringify([{ choice: 'manual', text: 'merged text' }]));
  assert.equal(doc.dirty, true);
  assert.equal(doc.review !== null, true);
  assert.equal(h.ui().phase, 'review');
  h.cleanup();
});

test('B4.3-UI a no-op "keep mine" keeps a pending review visible', async () => {
  const h = make();
  h.setFetch((req) => {
    if (req.endpoint === 'open') return opened('base', 'v1');
    if (req.endpoint === 'documents.conflictResolve') {
      return { ok: true, value: { changed: false, resolved: true, diskVersion: 'v2', resolvedDisk: 'a'.repeat(64) } };
    }
    return { ok: true, value: {} };
  });
  await h.boot();
  const doc = h.st.doc;
  doc.dirty = false;
  doc.review = { groups: ['22222222-2222-4222-8222-222222222222'], count: 1 };
  doc.conflict = true;
  doc.conflictSession = {
    conflictId: '11111111-1111-4111-8111-111111111111',
    diskHash: 'a'.repeat(64),
    hunks: [{ base: 'old', ours: 'base', other: 'theirs' }],
  };
  doc.conflictChoices = [{ index: 0, choice: 'ours', text: '' }];

  await h.st.actions.applyConflict();
  await drain();

  assert.equal(doc.review !== null, true, 'review must not be silently cleared');
  assert.equal(doc.dirty, true);
  assert.equal(h.ui().phase, 'review', 'review phase must expose 保留并保存/撤销本次');
  assert.equal(h.requests.filter((r) => r.endpoint === 'save').length, 0, 'a pending review suppresses save');
  h.cleanup();
});
