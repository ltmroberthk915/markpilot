// Targeted client regression for the save-echo false conflict.
// Runs the REAL client source through the existing client-save-status fixture.
// Harness-only additions: fake EventSource + visibility dispatch + stat/open
// handlers. The fix is read-only: no live.refresh and no disk adoption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;
const OPEN = { ok: true, value: { text: 'base', version: 'v2', displayPath: 'D:/probe/a.md', size: 4, diskRevisionSha: 'a'.repeat(64) } };

function liveDoc(doc) {
  doc.live = { client: 'fixture-live', epoch: 'fixture-epoch', version: 5, savedVersion: 5, diskHash: 'a'.repeat(64) };
  doc.lastVersion = 'v2';
  doc.baseSha256 = 'a'.repeat(64);
  doc.lastSavedText = 'base';
  doc.text = 'base+AI';
  doc.review = { groups: ['g1'], count: 1 };
  doc.phase = 'review';
  doc.dirty = true;
}
function handler(stat, diskOpen) {
  return (req) => {
    if (req.endpoint === 'open') {
      // Initial load is live:true; the repair's read-only baseline is live:false.
      if (req.payload && req.payload.live === false) {
        return typeof diskOpen === 'function' ? diskOpen(req) : (diskOpen || OPEN);
      }
      return OPEN;
    }
    if (req.endpoint === 'stat') return typeof stat === 'function' ? stat(req) : stat;
    return { ok: true, value: {} };
  };
}
async function makeLive(stat, diskOpen) {
  const h = make({ eventSource: true });
  h.setFetch(handler(stat, diskOpen));
  await h.boot();
  liveDoc(h.st.doc);
  h.setUiForRender({ phase: 'review', detail: 'AI 修改待确认：AI 修改了 1 处，保存前请确认', saveStatus: 'unsaved' });
  return h;
}
const same = { ok: true, value: { version: 'v2', size: 4, type: 'file', displayPath: 'D:/probe/a.md' } };
const external = { ok: true, value: { version: 'v3', size: 6, type: 'file', displayPath: 'D:/probe/a.md' } };
const openOwnSave = { ok: true, value: { text: 'base', version: 'v3', diskRevisionSha: 'a'.repeat(64) } };
const openExternal = { ok: true, value: { text: 'external', version: 'v3', diskRevisionSha: 'b'.repeat(64) } };
const count = (h, endpoint) => h.requests.filter((r) => r.endpoint === endpoint).length;
const countBaselineOpen = (h) => h.requests.filter((r) => r.endpoint === 'open' && r.payload && r.payload.live === false).length;

test('save echo: same-version change keeps AI review without stat/open/live/write', async () => {
  // openExternal would be a different baseline if the branch ever opened; a
  // same-version stat must neither open nor move lastVersion/baseSha256.
  const h = await makeLive(same, openExternal);
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v2' });
    await drain();
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.ui().phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(h.st.doc.dirty, true);
    assert.equal(h.st.doc.lastVersion, 'v2', 'stat same must not move the version baseline');
    assert.equal(h.st.doc.baseSha256, 'a'.repeat(64), 'stat same must not move the hash baseline');
    assert.equal(count(h, 'stat'), 1, 'one read-only stat prefilter');
    assert.equal(countBaselineOpen(h), 0, 'same version needs no baseline read');
    assert.equal(count(h, 'live'), 0, 'never call adopt-capable live.refresh');
    assert.equal(count(h, 'save'), 0, 'no write');
  } finally { h.cleanup(); }
});

test('true external change: read-only open baseline conflicts, never writes', async () => {
  const h = await makeLive(external, openExternal);
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.match(h.st.doc.detail, /文件已在磁盘上更新/);
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('same-byte different-version touch keeps AI review and takes the open version', async () => {
  const h = await makeLive({ ok: true, value: { version: 'v4' } }, { ok: true, value: { text: 'base', version: 'v3', diskRevisionSha: 'a'.repeat(64) } });
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v4' });
    await drain();
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(h.st.doc.lastVersion, 'v3', 'use the open version, not the older stat v4');
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('hash mismatch with disk text equal to the current draft never advances baseline', async () => {
  const h = await makeLive(external, { ok: true, value: { text: 'base+AI', version: 'v3', diskRevisionSha: 'b'.repeat(64) } });
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(h.st.doc.lastVersion, 'v2', 'text equality is not baseline proof');
    assert.equal(h.st.doc.baseSha256, 'a'.repeat(64), 'hash baseline unchanged');
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('hash mismatch with old empty lastSavedText never treats empty disk text as own save', async () => {
  const h = await makeLive(external, { ok: true, value: { text: '', version: 'v3', diskRevisionSha: 'c'.repeat(64) } });
  try {
    h.st.doc.lastSavedText = '';
    h.st.doc.text = '';
    h.st.doc.mirror = null;
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(h.st.doc.lastVersion, 'v2', 'empty text is not baseline proof');
    assert.equal(h.st.doc.baseSha256, 'a'.repeat(64));
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('same path new live epoch invalidates the in-flight open baseline', async () => {
  let resolveOpen;
  const pendingOpen = new Promise((resolve) => { resolveOpen = resolve; });
  const h = await makeLive(external, () => pendingOpen);
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(countBaselineOpen(h), 1, 'open baseline read started');
    h.st.doc.live.epoch = 'fixture-epoch-2';
    resolveOpen({ ok: true, value: { text: 'base', version: 'v3', diskRevisionSha: 'a'.repeat(64) } });
    await drain();
    assert.equal(h.st.doc.live.epoch, 'fixture-epoch-2');
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(h.st.doc.lastVersion, 'v2', 'stale epoch must not advance the version');
    assert.equal(h.st.doc.baseSha256, 'a'.repeat(64));
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('visibility re-entry: same disk keeps AI review (no conflict)', async () => {
  const h = await makeLive(same, openOwnSave);
  try {
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await drain();
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.ui().phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(count(h, 'stat'), 1);
    assert.equal(countBaselineOpen(h), 0);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('visibility re-entry: true external change still conflicts', async () => {
  const h = await makeLive(external, openExternal);
  try {
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.match(h.st.doc.detail, /文件已在磁盘上更新/);
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'live'), 0);
  } finally { h.cleanup(); }
});

test('saving visibility does not preempt the save with a conflict', async () => {
  const h = await makeLive(same, openOwnSave);
  try {
    h.st.doc.saving = true;
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await drain();
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(count(h, 'stat'), 0);
    assert.equal(countBaselineOpen(h), 0);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('out-of-order old change after a newer lastVersion is ignored', async () => {
  const h = await makeLive({ ok: true, value: { version: 'v5' } }, openOwnSave);
  try {
    h.st.doc.lastVersion = 'v5';
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v4' });
    await drain();
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(h.st.doc.lastVersion, 'v5');
    assert.equal(countBaselineOpen(h), 0);
    assert.equal(count(h, 'live'), 0);
  } finally { h.cleanup(); }
});

test('existing real conflict is never cleared by a same-version echo', async () => {
  const h = await makeLive(same, openOwnSave);
  try {
    h.st.doc.conflict = true;
    h.st.doc.phase = 'conflict';
    h.st.doc.externalStale = true;
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v2' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.conflict, true);
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(count(h, 'stat'), 0, 'latched conflict needs no probe');
  } finally { h.cleanup(); }
});

test('existing false externalStale is cleared after the disk identity is proven unchanged', async () => {
  const h = await makeLive(same, openOwnSave);
  try {
    h.st.doc.phase = 'conflict';
    h.st.doc.externalStale = true;
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v2' });
    await drain();
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(h.st.doc.conflict, false);
  } finally { h.cleanup(); }
});

test('ordinary dirty without review conflicts on a changed baseline without live.refresh', async () => {
  const h = await makeLive(external, openExternal);
  try {
    h.st.doc.review = null;
    h.st.doc.phase = 'dirty';
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(countBaselineOpen(h), 1, 'read-only baseline read is allowed');
    assert.equal(count(h, 'live'), 0, 'never use adopt-capable live.refresh');
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('unknown stat stays fail-closed without open/live/write', async () => {
  const h = await makeLive(() => { throw new Error('stat unavailable'); }, openOwnSave);
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v2' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(countBaselineOpen(h), 0);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('unknown open baseline stays fail-closed', async () => {
  const h = await makeLive(external, { ok: false, error: { code: 'FS_IO_ERROR' } });
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('post-save stat difference uses the read-only open version and keeps dirty edits', async () => {
  let resolveSave;
  const savePending = new Promise((resolve) => { resolveSave = resolve; });
  const h = make({ eventSource: true });
  h.setFetch((req) => {
    if (req.endpoint === 'open') {
      if (req.payload && req.payload.live === false) return openOwnSave;
      return OPEN;
    }
    if (req.endpoint === 'stat') return { ok: true, value: { version: 'v3' } };
    if (req.endpoint === 'save') return savePending;
    return { ok: true, value: {} };
  });
  try {
    await h.boot();
    const doc = h.st.doc;
    doc.live = { client: 'fixture-live', epoch: 'fixture-epoch', version: 5, savedVersion: 5, diskHash: 'a'.repeat(64) };
    doc.lastVersion = 'v2';
    doc.lastSavedText = 'base';
    doc.text = 'base';
    doc.dirty = true;
    doc.review = null;
    doc.phase = 'dirty';
    h.setUiForRender({ phase: 'dirty', detail: '', saveStatus: 'unsaved' });
    h.message('manual-save', { source: 'ctrl-s' });
    await drain();
    h.edit('base2');
    await drain();
    resolveSave({ ok: true, value: { version: 'v2', diskRevisionSha: 'a'.repeat(64), savedVersion: 5, liveVersion: 5, epoch: 'fixture-epoch' } });
    for (let i = 0; i < 8; i += 1) { await drain(); await new Promise((resolve) => setImmediate(resolve)); }
    assert.equal(doc.saving, false);
    assert.equal(doc.phase, 'dirty');
    assert.equal(doc.externalStale, false);
    assert.equal(doc.lastVersion, 'v3', 'post-save reconcile uses the opened disk version');
    assert.equal(count(h, 'save'), 1);
    assert.equal(count(h, 'live'), 0, 'post-save reconcile never calls live.refresh');
    assert.equal(countBaselineOpen(h), 1);
  } finally { h.cleanup(); }
});

test('open baseline missing enters missing instead of conflict', async () => {
  const h = await makeLive(external, { ok: false, error: { code: 'FS_NOT_FOUND' } });
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v3' });
    await drain();
    assert.equal(h.st.doc.missing, true);
    assert.equal(h.st.doc.phase, 'missing');
    assert.equal(countBaselineOpen(h), 1);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('missing file during dirty live refresh enters missing, never writes', async () => {
  const h = await makeLive({ ok: true, value: { missing: true } }, openOwnSave);
  try {
    h.eventSources[0].emit('change', { path: 'D:/probe/a.md', version: 'v2' });
    await drain();
    assert.equal(h.st.doc.missing, true);
    assert.equal(h.st.doc.phase, 'missing');
    assert.equal(countBaselineOpen(h), 0);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('late older stat cannot clear a newer conflict (sequence guard)', async () => {
  const pending = [];
  const stat = () => new Promise((resolve) => pending.push(resolve));
  const h = await makeLive(stat, openExternal);
  try {
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await Promise.resolve();
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await Promise.resolve();
    assert.equal(pending.length, 2);
    pending[1](external);
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    pending[0](same);
    await drain();
    assert.equal(h.st.doc.phase, 'conflict', 'late same-version stat must not clear the newer conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('late older stat rejection cannot clear a newer conflict', async () => {
  const pending = [];
  const stat = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const h = await makeLive(stat, openExternal);
  try {
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await Promise.resolve();
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await Promise.resolve();
    assert.equal(pending.length, 2);
    pending[1].resolve(external);
    await drain();
    assert.equal(h.st.doc.phase, 'conflict');
    pending[0].reject(new Error('late stat failed'));
    await drain();
    assert.equal(h.st.doc.phase, 'conflict', 'late rejected stat must not clear the newer conflict');
    assert.equal(h.st.doc.externalStale, true);
    assert.equal(h.st.doc.lastVersion, 'v2');
    assert.equal(h.st.doc.baseSha256, 'a'.repeat(64));
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});

test('stale async stat after document switch cannot touch the new document', async () => {
  let resolveStat;
  const pending = new Promise((resolve) => { resolveStat = resolve; });
  const h = await makeLive(() => pending, openOwnSave);
  try {
    h.setVisibility('hidden');
    h.setVisibility('visible');
    await Promise.resolve();
    h.st.doc.absPath = 'D:/probe/b.md';
    resolveStat(external);
    await drain();
    assert.equal(h.st.doc.absPath, 'D:/probe/b.md');
    assert.equal(h.st.doc.phase, 'review');
    assert.equal(h.st.doc.externalStale, false);
    assert.equal(h.st.doc.dirty, true);
    assert.equal(countBaselineOpen(h), 0);
    assert.equal(count(h, 'live'), 0);
    assert.equal(count(h, 'save'), 0);
  } finally { h.cleanup(); }
});
