'use strict';
// Real-filesystem Save As target boundaries using synthetic, owned fixtures.
// node tools/quality/save-target-boundary-workflows.cjs --product <absolute MarkPilot-CM6> --out <fresh absolute directory>
// MP_QUALITY_CASES=1,2,3 or same_directory_alias,file_symlink_target,parent_alias_retarget
// Evidence/fixtures are deliberately retained. No recursive deletion or OS permission changes.
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const errorInfo = e => ({ name: e.name, code: e.code, message: e.message, stack: e.stack,
  ...(e.cause ? { cause: errorInfo(e.cause) } : {}) });
const ids = ['same_directory_alias', 'file_symlink_target', 'parent_alias_retarget'];
let out, realOut, ownerToken, ownerFile, DocumentStore, createSession, prepareSaveAsAssets;
const report = { proposal: 'save-target-canonical-1', startedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, cases: [] };

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function write(file, bytes) {
  assert(within(out, path.resolve(file)), 'fixture write escaped owned output');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);
}
async function evidence(file) {
  try {
    const bytes = await fsp.readFile(file), stat = await fsp.stat(file);
    return { exists: true, sha256: sha(bytes), size: bytes.length, mtimeMs: stat.mtimeMs };
  } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; }
}
async function owner() {
  assert.equal(await fsp.readFile(ownerFile, 'utf8'), ownerToken, 'owned output marker changed');
  assert.equal(key(await fsp.realpath(out)), key(realOut), 'owned output root changed');
}
async function ownedAbsolute(file) {
  await owner();
  assert(path.isAbsolute(file) && path.resolve(file) === file, 'link operation requires a normalized literal absolute path');
  assert(within(out, file) && file !== out, 'literal link path escaped owned output');
  assert(within(realOut, await fsp.realpath(path.dirname(file))), 'link parent realpath escaped owned output');
}
async function makeLink(target, link, type) {
  await ownedAbsolute(link);
  assert(path.isAbsolute(target) && within(out, target), 'literal link target escaped owned output');
  assert(within(realOut, await fsp.realpath(target)), 'link target realpath escaped owned output');
  await fsp.symlink(target, link, type);
  assert(within(realOut, await fsp.realpath(link)), 'created link realpath escaped owned output');
}
async function retargetOwnedDirectoryLink(link, previous, next) {
  // Every unlink/retarget is limited to this newly created symbolic link itself.
  // Check the literal absolute path, parent realpath, current link realpath and next target.
  await ownedAbsolute(link);
  assert((await fsp.lstat(link)).isSymbolicLink(), 'refusing to unlink a non-link');
  const actual = await fsp.realpath(link), expected = await fsp.realpath(previous);
  assert(within(realOut, actual) && within(realOut, expected), 'old link target escaped owned output');
  assert.equal(key(actual), key(expected), 'old link target changed unexpectedly');
  assert(path.isAbsolute(next) && within(out, next) && within(realOut, await fsp.realpath(next)), 'next target escaped owned output');
  await fsp.unlink(link);
  await makeLink(next, link, process.platform === 'win32' ? 'junction' : 'dir');
}
function entryUnconfirmed(e) {
  const result = new Error('file symlink entry could not be established without changing OS permissions', { cause: e });
  result.code = 'ENTRY_UNCONFIRMED';
  return result;
}
async function session(from, options = {}) {
  const store = new DocumentStore({ prepareSaveAs: prepareSaveAsAssets, ...options });
  const S = createSession();
  await store.load(S, from);
  store.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  return { store, S };
}
async function save(x, selected, text) {
  const grant = await x.store.grantSaveAs(x.S, selected);
  return x.store.save(x.S, { filePath: selected, text, documentId: x.S.documentId,
    revision: 1, saveAsToken: grant.saveAsToken });
}
async function exact(file, expected) { assert.deepEqual(await fsp.readFile(file), Buffer.from(expected)); }

const cases = {
  async same_directory_alias(r) {
    const base = path.join(out, ids[0]), actual = path.join(base, 'actual'), alias = path.join(base, 'alias');
    const from = path.join(actual, 'source.md'), image = path.join(actual, 'image.png');
    const text = '# SAME DIRECTORY\n![x](image.png)\n', imageBytes = Buffer.from([0, 17, 23, 255]);
    await write(from, text); await write(image, imageBytes);
    await makeLink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await evidence(image), x = await session(from), selected = path.join(alias, 'renamed.md');
    r.observations = { selected, source: await fsp.realpath(from), imageBefore: before };
    const result = await save(x, selected, text), canonicalTarget = await fsp.realpath(path.join(actual, 'renamed.md'));
    const after = await evidence(image);
    Object.assign(r.observations, { result, canonicalTarget, sessionPath: x.S.filePath, imageAfter: after });
    await exact(from, text); await exact(selected, text); await exact(image, imageBytes);
    assert.equal(after.mtimeMs, before.mtimeMs, 'same-directory image mtime changed');
    assert.equal(after.sha256, before.sha256, 'same-directory image bytes changed');
    assert.equal(result.ok, true); assert.equal(result.current, true);
    assert.equal(result.filePath, canonicalTarget); assert.equal(x.S.filePath, canonicalTarget);
    assert.equal(x.S.savedText, text); assert.equal(x.S.dirty, false);
    assert.equal(result.assets.copied, 0);
    // Intentionally strict: old caller's lexical alias produces reused=1 and must fail here.
    assert.equal(result.assets.reused, 0);
    assert.equal(result.assets.unavailable, 0);
  },
  async file_symlink_target(r) {
    const base = path.join(out, ids[1]), a = path.join(base, 'A'), b = path.join(base, 'B');
    const from = path.join(a, 'source.md'), selected = path.join(a, 'link.md'), actual = path.join(b, 'real.md');
    const image = path.join(a, 'image.png'), targetImage = path.join(b, 'image.png');
    const text = '# FILE SYMLINK\n![x](image.png)\n', imageBytes = Buffer.from([7, 0, 99, 255]);
    await write(from, text); await write(image, imageBytes); await write(actual, 'TARGET BASELINE\n');
    try { await makeLink(actual, selected, 'file'); }
    catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(e.code)) throw entryUnconfirmed(e); throw e; }
    const before = await evidence(image), x = await session(from);
    r.observations = { selected, canonicalTarget: await fsp.realpath(actual), imageBefore: before };
    const result = await save(x, selected, text), after = await evidence(image);
    Object.assign(r.observations, { result, sessionPath: x.S.filePath, imageAfter: after,
      targetImage: await evidence(targetImage), actualMd: await evidence(actual), sourceMd: await evidence(from) });
    await exact(from, text); await exact(image, imageBytes); await exact(actual, text); await exact(selected, text);
    assert((await fsp.lstat(selected)).isSymbolicLink(), 'selected file symlink was replaced');
    assert.equal(after.mtimeMs, before.mtimeMs, 'source image mtime changed');
    assert.equal(after.sha256, before.sha256);
    assert.equal(result.ok, true); assert.equal(result.current, true);
    assert.equal(result.filePath, r.observations.canonicalTarget); assert.equal(x.S.filePath, r.observations.canonicalTarget);
    assert.equal(x.S.savedText, text); assert.equal(x.S.dirty, false);
    // Old caller skips preparation because selected link.md and source.md share lexical A.
    assert.equal(r.observations.targetImage.exists, true, 'relative image missing beside actual MD target B/real.md');
    await exact(targetImage, imageBytes);
    assert.equal(result.assets.copied, 1); assert.equal(result.assets.reused, 0); assert.equal(result.assets.unavailable, 0);
  },
  async parent_alias_retarget(r) {
    const base = path.join(out, ids[2]), a = path.join(base, 'source'), one = path.join(base, 'one'), two = path.join(base, 'two');
    const link = path.join(base, 'chosen'), selected = path.join(link, 'note.md'), from = path.join(a, 'source.md');
    const text = '# PARENT RETARGET\n![new](new.png)\n![existing](existing.png)\n';
    const fresh = Buffer.from('NEW RESOURCE'), common = Buffer.from('SOURCE AND FIRST COMPETITOR');
    const competitorTwo = Buffer.from('SECOND COMPETITOR MUST SURVIVE');
    await write(from, text); await write(path.join(a, 'new.png'), fresh); await write(path.join(a, 'existing.png'), common);
    await write(path.join(one, 'note.md'), 'MD ONE\n'); await write(path.join(two, 'note.md'), 'MD TWO\n');
    await write(path.join(one, 'existing.png'), common); await write(path.join(two, 'existing.png'), competitorTwo);
    await makeLink(one, link, process.platform === 'win32' ? 'junction' : 'dir');
    const competitorBefore = [await evidence(path.join(one, 'existing.png')), await evidence(path.join(two, 'existing.png'))];
    let entered = false, replacementReached = false;
    const x = await session(from, { prepareSaveAs: async context => {
      entered = true; r.hook = { filePath: context.filePath, sourcePath: context.sourcePath };
      await retargetOwnedDirectoryLink(link, one, two);
      return prepareSaveAsAssets(context);
    }, beforeReplace: async () => { replacementReached = true; } });
    let rejection, value;
    try { value = await save(x, selected, text); } catch (e) { rejection = e; }
    // Preserve the save's original failure even if a later evidence read also fails.
    r.observations = { entered, replacementReached, ...(rejection ? { originalRejection: errorInfo(rejection) } : { unexpectedResult: value }) };
    Object.assign(r.observations, {
      selectedRealpath: await fsp.realpath(selected), sessionPath: x.S.filePath,
      originalPreparedAsset: await evidence(path.join(one, 'new.png')), changedPreparedAsset: await evidence(path.join(two, 'new.png')),
      competitorsBefore: competitorBefore, competitorsAfter: [await evidence(path.join(one, 'existing.png')), await evidence(path.join(two, 'existing.png'))] });
    assert.equal(entered, true, 'retarget hook was not entered');
    assert(rejection, 'MD save unexpectedly succeeded after selected parent retarget');
    assert(['MP_FILE_CONFLICT', 'MP_ASSET_TARGET', 'MP_ASSET_CONFLICT'].includes(rejection.code), 'unexpected rejection; inspect originalRejection');
    await exact(path.join(one, 'note.md'), 'MD ONE\n'); await exact(path.join(two, 'note.md'), 'MD TWO\n');
    await exact(path.join(one, 'existing.png'), common); await exact(path.join(two, 'existing.png'), competitorTwo);
    assert.deepEqual(r.observations.competitorsAfter, competitorBefore, 'competitor bytes or mtime changed');
    await exact(from, text); await exact(path.join(a, 'new.png'), fresh); await exact(path.join(a, 'existing.png'), common);
    assert.equal(x.S.filePath, await fsp.realpath(from)); assert.equal(x.S.dirty, true);
    // The existing contract retains already published assets in the original canonical target.
    if (r.observations.originalPreparedAsset.exists) await exact(path.join(one, 'new.png'), fresh);
    assert.equal(r.observations.changedPreparedAsset.exists, false, 'resource published into the newly redirected, ungranted target');
  }
};

async function flush() {
  report.finishedAt = new Date().toISOString();
  report.passed = !report.fatalError && report.cases.length > 0 && report.cases.every(r => r.status === 'pass');
  report.fullSuite = report.cases.length === ids.length;
  await fsp.writeFile(path.join(out, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
}
async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    assert(['--product', '--out'].includes(name) && process.argv[i + 1] && !options[name], 'usage: --product <absolute MarkPilot-CM6> --out <fresh absolute directory>');
    options[name] = process.argv[i + 1];
  }
  assert(options['--product'] && options['--out'], 'both --product and --out are required');
  assert(path.isAbsolute(options['--product']) && path.isAbsolute(options['--out']), 'absolute paths required');
  const product = path.resolve(options['--product']); out = path.resolve(options['--out']);
  assert(!within(product, out) && !within(out, product), 'output and product must be separate directories');
  const selected = process.env.MP_QUALITY_CASES ? process.env.MP_QUALITY_CASES.split(/[\s,;|]+/).filter(Boolean).map(id => /^[123]$/.test(id) ? ids[Number(id) - 1] : id) : ids;
  assert(selected.length && selected.every(id => ids.includes(id)), 'MP_QUALITY_CASES contains an unknown case');
  assert.equal(new Set(selected).size, selected.length, 'MP_QUALITY_CASES contains duplicate cases');
  // Non-recursive creation fails on any existing --out. No existing output can be reused or erased.
  await fsp.mkdir(out);
  realOut = await fsp.realpath(out); ownerToken = crypto.randomUUID(); ownerFile = path.join(out, '.save-target-owner');
  await fsp.writeFile(ownerFile, ownerToken, { flag: 'wx' });
  report.product = await fsp.realpath(product); report.output = realOut; report.selected = selected;
  try {
    ({ DocumentStore, createSession } = require(path.join(product, 'shell/document-store.js')));
    ({ prepareSaveAsAssets } = require(path.join(product, 'shell/save-as-assets.js')));
    report.moduleSha256 = {};
    for (const name of ['document-store.js', 'save-as-assets.js']) report.moduleSha256[name] = sha(await fsp.readFile(path.join(product, 'shell', name)));
    for (const id of selected) {
      const r = { id, status: 'running', startedAt: new Date().toISOString() }; report.cases.push(r);
      try { await cases[id](r); r.status = 'pass'; }
      catch (e) { r.status = e.code === 'ENTRY_UNCONFIRMED' ? 'entry_unconfirmed' : 'fail'; r.error = errorInfo(e); }
      r.finishedAt = new Date().toISOString(); await flush();
    }
  } catch (e) { report.fatalError = errorInfo(e); }
  await flush();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}
module.exports = { main };
if (require.main === module) main().catch(e => { process.stderr.write(JSON.stringify(errorInfo(e), null, 2) + '\n'); process.exitCode = 1; });
