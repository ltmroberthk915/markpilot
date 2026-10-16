'use strict';

// modelOnly: evaluates the current product protocol functions in a VM with
// deferred host replies. It does not launch MarkPilot or prove GUI behavior.
// The guards are mutated only in the in-memory extracted source, never on disk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const sourcePath = path.resolve(__dirname, '../../../dsh-markpilot/src-cm6/extras.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceHash = sha256(source);
const extract = (name, endAnchor) => {
  const anchor = `  async function ${name}(`;
  const start = source.indexOf(anchor);
  assert(start >= 0, `actual function missing: ${name}`);
  assert.equal(source.indexOf(anchor, start + anchor.length), -1, `ambiguous function: ${name}`);
  const end = source.indexOf(endAnchor, start + anchor.length);
  assert(end > start, `actual function end missing: ${name}`);
  return source.slice(start, end).trim();
};
const functions = {
  refreshAppearance: extract('refreshAppearance', '  async function installTyporaThemeFromText('),
  installTyporaThemeFromText: extract('installTyporaThemeFromText', '  async function installTyporaTheme('),
  removeTyporaTheme: extract('removeTyporaTheme', '  async function setFontPreference('),
  setFontPreference: extract('setFontPreference', '  const userThemeInfo ='),
};
const actualFunctions = Object.values(functions).join('\n');
const extractedHash = sha256(actualFunctions);

function replaceExactly(text, needle, replacement, expectedCount) {
  const pieces = text.split(needle);
  assert.equal(pieces.length - 1, expectedCount, `mutation anchor changed: ${needle}`);
  return pieces.join(replacement);
}
function mutantSource(kind) {
  if (kind === 'generation') {
    let mutated = replaceExactly(actualFunctions, 'epoch !== appearanceRequest', 'false', 2);
    return replaceExactly(mutated, 'epoch === appearanceRequest', 'true', 1);
  }
  if (kind === 'removeRevision') return replaceExactly(actualFunctions, 'r.revision >= themeRevision', 'true', 1);
  if (kind === 'fontRevision') return replaceExactly(actualFunctions, 'fonts.revision < fontRevision', 'false', 1);
  throw new Error('unknown mutation: ' + kind);
}

function makeHost() {
  const queues = Object.fromEntries(['themeRead', 'fontRead', 'themeSave', 'themeRemove', 'fontSave'].map(name => [name, []]));
  const host = {};
  for (const name of Object.keys(queues)) {
    host[name] = (...args) => new Promise((resolve, reject) => queues[name].push({ args, resolve, reject }));
  }
  return {
    host,
    take(name) {
      const pending = queues[name].shift();
      assert(pending, `deferred ${name} was not called`);
      return pending;
    },
    assertDrained() {
      for (const [name, queue] of Object.entries(queues)) assert.equal(queue.length, 0, `unconsumed ${name}`);
    },
  };
}

const theme = name => ({ name, text: '/* protocol fixture */ #write { color: #844323; }', css: '.cm-content { color: #844323; }', bytes: 53, vars: {}, legacyAdapted: false });
const themeReply = (revision, name) => ({ ok: true, exists: true, revision, theme: theme(name) });
const fontReply = (revision, body) => ({ ok: true, revision, value: { body } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function makeRuntime(extracted = actualFunctions) {
  const deferred = makeHost();
  const context = vm.createContext({ host: deferred.host, seedTheme: theme('initial-theme') });
  const api = vm.runInContext(`(() => {
    let appearanceRequest = 0, themeRevision = 6, fontRevision = 6;
    let currentUserTheme = seedTheme;
    let fontPreferences = { body: 'initial-font' }, lastThemeReport = null;
    const events = [], FONT_CACHE = 'modelOnly-font-cache';
    const window = { mpHost: host, CSS: { supports: () => true } };
    const localStorage = { setItem() {} };
    const clone = value => JSON.parse(JSON.stringify(value));
    const fontsLocked = () => false;
    const normalizeFontPreferences = value => ({ ...value });
    const refreshAppearanceControls = () => {};
    const applyFontPreferences = () => {};
    const toast = message => events.push({ kind: 'toast', message });
    // Presentation/normalization dependencies are controlled stand-ins. The
    // extracted async functions and their freshness comparisons are unchanged.
    function prepareUserTheme(text, name) {
      return { ok: true, theme: { text, name, css: text, vars: {}, bytes: text.length, legacyAdapted: false }, report: { rules: 1 } };
    }
    function cacheUserTheme(value) {
      currentUserTheme = value;
      events.push({ kind: 'cache', name: value?.name || null });
    }
    function renderAppearance() {
      events.push({ kind: 'render', name: currentUserTheme?.name || null, fonts: clone(fontPreferences) });
    }
    ${extracted}
    return {
      refreshAppearance, installTyporaThemeFromText, removeTyporaTheme, setFontPreference,
      snapshot: () => clone({ name: currentUserTheme?.name || null, fonts: fontPreferences,
        themeRevision, fontRevision, appearanceRequest, events })
    };
  })()`, context, { filename: sourcePath + ':modelOnly-extracted', timeout: 1000 });
  return { api, deferred };
}

function takeRead(deferred) {
  return { theme: deferred.take('themeRead'), fonts: deferred.take('fontRead') };
}
function replyRead(pending, themeRev, name, fontRev, body) {
  pending.theme.resolve(themeReply(themeRev, name));
  pending.fonts.resolve(fontReply(fontRev, body));
}

async function lateOldRead(extracted) {
  const { api, deferred } = makeRuntime(extracted);
  const oldPromise = api.refreshAppearance();
  const oldRead = takeRead(deferred);
  const newPromise = api.refreshAppearance();
  const newRead = takeRead(deferred);
  replyRead(newRead, 8, 'new-theme', 8, 'new-font');
  await newPromise;
  const boundary = api.snapshot().events.length;
  // Failure is realistic for an old in-flight read (e.g. interrupted disk/IPC).
  // It distinguishes generation from revision: an error has no usable revision.
  oldRead.theme.resolve({ ok: false, error: 'STALE_OLD_READ_FAILURE' });
  oldRead.fonts.resolve(fontReply(6, 'old-font'));
  const oldResult = await oldPromise;
  deferred.assertDrained();
  return { ...api.snapshot(), boundary, oldResult };
}
function verifyLateOldRead(result) {
  assert.equal(result.name, 'new-theme', 'GENERATION: delayed old read must not clear the new theme');
  assert.equal(result.fonts.body, 'new-font', 'GENERATION: delayed old read must not restore the old font');
  assert.equal(result.oldResult.stale, true, 'GENERATION: old read must be classified as stale');
  assert(!result.events.slice(result.boundary).some(event => event.name === null || event.kind === 'toast'),
    'GENERATION: no transient clearing or obsolete error notification');
}

async function lateRemoveAfterInstall(extracted) {
  const { api, deferred } = makeRuntime(extracted);
  const removePromise = api.removeTyporaTheme();
  const remove = deferred.take('themeRemove');
  const installPromise = api.installTyporaThemeFromText('/* new raw */ #write{color:red}', 'new-theme');
  const install = deferred.take('themeSave');
  assert.equal(install.args[0].name, 'new-theme', 'actual install sent the new candidate');
  install.resolve({ ok: true, revision: 8 });
  await flush();
  replyRead(takeRead(deferred), 8, 'new-theme', 6, 'initial-font');
  await installPromise;
  assert.equal(api.snapshot().name, 'new-theme', 'setup: revision 8 must actually render');
  const boundary = api.snapshot().events.length;
  remove.resolve({ ok: true, revision: 7 });
  await flush();
  // Capture before the following authoritative read can hide a transient null.
  const interim = api.snapshot();
  replyRead(takeRead(deferred), 8, 'new-theme', 6, 'initial-font');
  await removePromise;
  deferred.assertDrained();
  return { ...api.snapshot(), boundary, interim };
}
function verifyLateRemove(result) {
  assert.equal(result.interim.name, 'new-theme', 'REMOVE_REVISION: revision 7 must not transiently clear revision 8');
  assert.equal(result.themeRevision, 8, 'REMOVE_REVISION: latest revision must remain 8');
  assert.equal(result.name, 'new-theme', 'REMOVE_REVISION: latest theme must remain rendered');
  assert(!result.events.slice(result.boundary).some(event => event.name === null),
    'REMOVE_REVISION: cache/render history must contain no transient tombstone');
}

async function lateFontSaveAndOldRead(extracted) {
  const { api, deferred } = makeRuntime(extracted);
  const savePromise = api.setFontPreference({ body: 'pending-old-font' });
  const save = deferred.take('fontSave');
  assert.equal(save.args[0].body, 'pending-old-font', 'actual font setter sent its patch');
  const authorityPromise = api.refreshAppearance();
  replyRead(takeRead(deferred), 8, 'new-theme', 8, 'new-font');
  await authorityPromise;
  const boundary = api.snapshot().events.length;
  save.resolve({ ok: true, revision: 7 });
  await flush();
  // Theme is current but the independent font read is stale. This specifically
  // exercises fontRevision rather than allowing themeRevision to mask the bug.
  replyRead(takeRead(deferred), 8, 'new-theme', 7, 'pending-old-font');
  await savePromise;
  deferred.assertDrained();
  return { ...api.snapshot(), boundary };
}
function verifyLateFont(result) {
  assert.equal(result.fonts.body, 'new-font', 'FONT_REVISION: stale font read after late save must not roll back the font');
  assert.equal(result.fontRevision, 8, 'FONT_REVISION: committed font revision must not decrease');
  assert.equal(result.name, 'new-theme', 'FONT_REVISION: theme remains current');
  assert(!result.events.slice(result.boundary).some(event => event.fonts?.body === 'pending-old-font'),
    'FONT_REVISION: no transient obsolete font render');
}

async function proveGuard(t, scenario, verify, mutation, expectedMarker) {
  const baseline = await scenario(actualFunctions);
  verify(baseline);
  const mutated = await scenario(mutantSource(mutation));
  let detected;
  try { verify(mutated); } catch (error) { detected = error; }
  assert(detected, `mutation ${mutation} was not detected by the same invariant`);
  assert.match(detected.message, expectedMarker);
  // Restore the exact extracted functions and run the same scenario once more.
  const restored = await scenario(actualFunctions);
  verify(restored);
  t.diagnostic(JSON.stringify({ modelOnly: true, sourcePath, sourceSha256: sourceHash,
    extractedSha256: extractedHash, mutation, baseline: 'green', mutant: 'red', restored: 'green',
    mutantFailure: detected.message.split('\n')[0], finalThemeRevision: restored.themeRevision,
    finalFontRevision: restored.fontRevision }));
}

test('modelOnly: generation rejects an old failed read after a new authoritative read', async t => {
  await proveGuard(t, lateOldRead, verifyLateOldRead, 'generation', /GENERATION:/);
});
test('modelOnly: late remove rev 7 cannot transiently clear imported/read-back rev 8', async t => {
  await proveGuard(t, lateRemoveAfterInstall, verifyLateRemove, 'removeRevision', /REMOVE_REVISION:/);
});
test('modelOnly: late font save cannot accept an older font revision', async t => {
  await proveGuard(t, lateFontSaveAndOldRead, verifyLateFont, 'fontRevision', /FONT_REVISION:/);
});
