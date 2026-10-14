'use strict';
// PREPARED, NOT EXECUTED by the read-only reviewer. Runs real product modules.
// node this-file.cjs [absolute MarkPilot-CM6 path]
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const product = path.resolve(process.argv[2] || path.join(__dirname, '../../../MarkPilot-CM6'));
const { DocumentStore, createSession } = require(path.join(product, 'shell/document-store'));
const { prepareSaveAsAssets } = require(path.join(product, 'shell/save-as-assets'));
const { collectImageRefs } = require(path.join(product, 'shell/markdown-images'));
const { classify } = require(path.join(product, 'export-folder'));
const receipts = [];
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function exists(p) { try { await fsp.access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function write(p, bytes) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, bytes); }
async function bytes(p, expected) { assert.deepEqual(await fsp.readFile(p), Buffer.from(expected)); }
async function fails(job, codes) { await assert.rejects(job, e => codes.includes(e.code)); }
async function noImageTemps(dir) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    assert(!entry.name.startsWith('.mp-image-'), `orphan staging temp ${entry.name}`);
    if (entry.isDirectory()) await noImageTemps(path.join(dir, entry.name));
  }
}
async function caseRun(name, fn) {
  const receipt={name,status:'running'};receipts.push(receipt);
  await test(name,async()=>{try{await fn();receipt.status='pass';}catch(e){receipt.status='fail';receipt.error=e.stack;throw e;}});
}
let root;
async function fixture(name, text, options = {}) {
  const dir = path.join(root, name), from = path.join(dir, 'old', 'note.md'), to = path.join(dir, 'new', 'note.md');
  await write(from, text); await fsp.mkdir(path.dirname(to), { recursive: true });
  const store = new DocumentStore({ prepareSaveAs: prepareSaveAsAssets, ...options }), S = createSession();
  await store.load(S, from); store.markDirty(S, { documentId: S.documentId, revision: 1, dirty: true });
  return { dir, from, to, store, S, text };
}
async function save(x, target = x.to, extra = {}) {
  const grant = await x.store.grantSaveAs(x.S, target);
  return x.store.save(x.S, { filePath: target, text: x.text, documentId: x.S.documentId, revision: 1, saveAsToken: grant.saveAsToken, ...extra });
}
async function main() {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mp-save-assets-test-'));
  try {
    await caseRun('reachable + pre-existing missing; resources ready at receipt; exact source', async () => {
      const text = '# 原文\n![A](<local/题 图.png>)\n![missing](local/missing.png)\n';
      const x = await fixture('success', text), image = Buffer.from([0, 1, 23, 255, 4]);
      await write(path.join(path.dirname(x.from), 'local/题 图.png'), image);
      const r = await save(x);
      assert.equal(r.ok, true); assert.equal(r.current, true); assert.equal(r.assets.copied, 1); assert.equal(r.assets.unavailable, 1);
      // Direct immediate read after receipt: no polling can conceal fire-and-forget.
      await bytes(path.join(path.dirname(x.to), 'local/题 图.png'), image);
      await bytes(x.to, text); await bytes(x.from, text);
      await bytes(path.join(path.dirname(x.from), 'local/题 图.png'), image);
      assert.equal(x.S.savedText, text); assert.equal(x.S.dirty, false);
      await noImageTemps(x.dir);
    });
    await caseRun('same directory and absolute/file/data/http resources cause no copies', async () => {
      const absolute = path.join(root, 'absolute.png'); await write(absolute, 'ABS');
      const text = `![drive](<${absolute}>)\n<img src="${pathToFileURL(absolute).href}">\n![data](data:image/png;base64,AA==)\n![remote](https://example.invalid/a.png)`;
      const x = await fixture('unchanged', text);
      assert.equal(classify(absolute, { docPath: x.from }).kind, 'local');
      assert.equal(classify('//cdn.example.invalid/a.png', { docPath: x.from }).kind, 'remote');
      assert.equal(classify('D:/notes/image.png', { docPath: x.from }).kind, 'local');
      assert.equal(classify('\\\\server\\share\\image.png', { docPath: x.from }).kind, 'local');
      const r = await save(x); assert.equal(r.assets.copied, 0);
      assert.deepEqual(await fsp.readdir(path.dirname(x.to)), ['note.md']); await bytes(absolute, 'ABS');
      const y = await fixture('same-dir', '![x](present.png)'); await write(path.join(path.dirname(y.from), 'present.png'), 'P');
      const q = await save(y, path.join(path.dirname(y.from), 'renamed.md'));
      assert.equal(q.assets.copied, 0); assert.equal(q.assets.reused, 0);
    });
    await caseRun('inline/fenced examples ignored, actual image remains dependency', async () => {
      const text = '`![code](example.png)`\n```md\n<img src="example.png">\n```\n~~~md\n![fenced](example.png)\n~~~\n![real](real.png)';
      assert.deepEqual(collectImageRefs(text), ['real.png']);
      const x = await fixture('code', text);
      await write(path.join(path.dirname(x.from), 'example.png'), 'OLD');
      await write(path.join(path.dirname(x.to), 'example.png'), 'DIFFERENT');
      await write(path.join(path.dirname(x.from), 'real.png'), 'REAL');
      const r = await save(x); assert.equal(r.assets.copied, 1);
      await bytes(path.join(path.dirname(x.to), 'example.png'), 'DIFFERENT');
      await bytes(path.join(path.dirname(x.to), 'real.png'), 'REAL');
    });
    await caseRun('parent-relative refs copy to changed resolved base; same canonical file reused', async () => {
      const x = await fixture('parent', '![x](../shared/p.png)');
      await write(path.join(x.dir, 'shared/p.png'), 'SHARED');
      const deep = path.join(x.dir, 'relocated/note/note.md');
      const r = await save(x, deep); assert.equal(r.assets.copied, 1);
      await bytes(path.join(x.dir, 'relocated/shared/p.png'), 'SHARED'); await bytes(deep, x.text);
      const y = await fixture('same-canonical', '![x](../shared/p.png)');
      await write(path.join(y.dir, 'shared/p.png'), 'SAME');
      const q = await save(y); assert.equal(q.assets.copied, 0); assert.equal(q.assets.reused, 1);
    });
    await caseRun('unequal collision fails before MD commit; equal collision reuses', async () => {
      const x = await fixture('conflict', '![x](a.png)');
      await write(path.join(path.dirname(x.from), 'a.png'), 'SOURCE');
      await write(path.join(path.dirname(x.to), 'a.png'), 'TARGET'); await write(x.to, 'TARGET-MD');
      await fails(save(x), ['MP_ASSET_CONFLICT']);
      await bytes(x.to, 'TARGET-MD'); await bytes(x.from, x.text);
      await bytes(path.join(path.dirname(x.to), 'a.png'), 'TARGET');
      assert.equal(x.S.filePath, x.from); assert.equal(x.S.dirty, true); await noImageTemps(x.dir);
      const y = await fixture('equal', '![x](a.png)');
      await write(path.join(path.dirname(y.from), 'a.png'), 'SAME'); await write(path.join(path.dirname(y.to), 'a.png'), 'SAME');
      const r = await save(y); assert.equal(r.assets.copied, 0); assert.equal(r.assets.reused, 1);
    });
    await caseRun('competitor created at publication: exclusive copy preserves competitor bytes', async () => {
      const x = await fixture('competitor', '![x](a.png)'), target = path.join(path.dirname(x.to), 'a.png');
      await write(path.join(path.dirname(x.from), 'a.png'), 'SOURCE');
      const original = fsp.copyFile; let intercepted = false;
      fsp.copyFile = async function (a, b, flags) {
        if (b === target && path.basename(a).startsWith('.mp-image-')) {
          intercepted = true; await write(target, 'COMPETITOR');
          // Assert production requested exclusivity independently of final bytes.
          assert.equal(flags, fs.constants.COPYFILE_EXCL);
        }
        return original.call(this, a, b, flags);
      };
      try { await fails(save(x), ['MP_ASSET_CONFLICT']); } finally { fsp.copyFile = original; }
      assert(intercepted); await bytes(target, 'COMPETITOR'); assert.equal(await exists(x.to), false); await noImageTemps(x.dir);
    });
    for (const mode of ['owner', 'grant', 'document', 'edit']) {
      await caseRun(`preparation barrier: ${mode}`, async () => {
        const entered = gate(), release = gate(); let alive = true;
        const x = await fixture('barrier-' + mode, '![x](a.png)', {
          prepareSaveAs: async context => { entered.resolve(); await release.promise; return prepareSaveAsAssets(context); },
        });
        await write(path.join(path.dirname(x.from), 'a.png'), 'SOURCE');
        const pending = save(x, x.to, { ownerCurrent: () => alive });
        // Attach error consumer before cancellation to avoid an unhandled rejection.
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        await entered.promise;
        assert.equal(await exists(x.to), false); assert.equal(x.S.filePath, x.from);
        if (mode === 'owner') alive = false;
        if (mode === 'grant') x.store.beginSaveAs(x.S);
        if (mode === 'document') x.store.reset(x.S);
        if (mode === 'edit') x.store.markDirty(x.S, { documentId: x.S.documentId, revision: 2, dirty: true });
        release.resolve(); const r = await outcome;
        if (mode === 'edit') { assert(r.value?.ok); assert.equal(x.S.dirty, true); assert.equal(x.S.lastSavedRevision, 1); await bytes(x.to, x.text); }
        else { assert(r.error); assert(['MP_DOC_MISMATCH', 'MP_SAVE_TARGET'].includes(r.error.code)); assert.equal(await exists(x.to), false); assert.equal(await exists(path.join(path.dirname(x.to), 'a.png')), false); }
        await noImageTemps(x.dir);
      });
    }
    await caseRun('canonical target retargeted between planning and publication fails', async () => {
      const x = await fixture('retarget', '![x](a.png)'), destination = path.join(path.dirname(x.to), 'a.png');
      await write(path.join(path.dirname(x.from), 'a.png'), 'SOURCE'); let hits = 0;
      const canonical = async p => {
        if (p === destination && ++hits >= 2) return path.join(x.dir, 'redirected/a.png');
        return x.store.canonical(p);
      };
      await fails(prepareSaveAsAssets({ sourcePath: x.from, filePath: x.to, text: x.text, canonical, current: () => true }), ['MP_ASSET_TARGET']);
      assert(hits >= 2); assert.equal(await exists(destination), false); assert.equal(await exists(path.join(x.dir, 'redirected/a.png')), false);
    });
    await caseRun('real junction/symlink parent retarget detected; both actual destinations untouched', async () => {
      const x = await fixture('real-retarget', '![x](local/a.png)');
      await write(path.join(path.dirname(x.from), 'local/a.png'), 'SOURCE');
      const base = path.dirname(x.to), one = path.join(base, 'v1'), two = path.join(base, 'v2'), link = path.join(base, 'local');
      await fsp.mkdir(one); await fsp.mkdir(two);
      await fsp.symlink(one, link, process.platform === 'win32' ? 'junction' : 'dir');
      const destination = path.join(link, 'a.png'); let hits = 0;
      const canonical = async p => {
        if (p === destination && ++hits === 2) {
          await fsp.unlink(link);
          await fsp.symlink(two, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return x.store.canonical(p);
      };
      await fails(prepareSaveAsAssets({ sourcePath: x.from, filePath: x.to, text: x.text, canonical, current: () => true }), ['MP_ASSET_TARGET']);
      assert.equal(await exists(path.join(one, 'a.png')), false); assert.equal(await exists(path.join(two, 'a.png')), false);
      await fsp.unlink(link);
    });
    await caseRun('post-preparation owner cancellation blocks MD commit; published assets retained', async () => {
      let alive = true;
      const x = await fixture('commit-owner', '![x](a.png)', { beforeReplace: async () => { alive = false; } });
      await write(path.join(path.dirname(x.from), 'a.png'), 'SOURCE');
      await fails(save(x, x.to, { ownerCurrent: () => alive }), ['MP_DOC_MISMATCH']);
      assert.equal(await exists(x.to), false); await bytes(path.join(path.dirname(x.to), 'a.png'), 'SOURCE');
      assert.equal(x.S.filePath, x.from); await noImageTemps(x.dir);
    });
    for(const targetHit of [2,4])await caseRun('owner expires during canonical await '+targetHit,async()=>{
      const x=await fixture('canonical-owner-'+targetHit,'![x](local/a.png)');
      await write(path.join(path.dirname(x.from),'local/a.png'),'SOURCE');
      const target=path.join(path.dirname(x.to),'local/a.png');let hits=0,alive=true;
      const canonical=async p=>{const value=await x.store.canonical(p);if(p===target&&++hits===targetHit)alive=false;return value;};
      await fails(prepareSaveAsAssets({sourcePath:x.from,filePath:x.to,text:x.text,canonical,current:()=>alive}),['MP_DOC_MISMATCH']);
      assert(hits>=targetHit);assert.equal(await exists(target),false,'expired owner must not publish an asset');
      if(targetHit===2)assert.equal(await exists(path.dirname(target)),false,'expired owner must not create target directory');
      await noImageTemps(x.dir);
    });
    await caseRun('HTML entity image paths and source-order protection use shared grammar',async()=>{
      assert.deepEqual(collectImageRefs('![first](a.png) `![code](c.png)` <img src="b&amp;c.png">'),['a.png','b&c.png']);
      const x=await fixture('html-entity','<img src="a&amp;b.png">');
      await write(path.join(path.dirname(x.from),'a&b.png'),'HTML');
      const r=await save(x);assert.equal(r.assets.copied,1);await bytes(path.join(path.dirname(x.to),'a&b.png'),'HTML');
    });
    await caseRun('parent retarget after preparation cancels before document commit',async()=>{
      const x=await fixture('post-prep-retarget','![x](local/a.png)');
      await write(path.join(path.dirname(x.from),'local/a.png'),'SOURCE');
      const base=path.dirname(x.to),one=path.join(base,'v1'),two=path.join(base,'v2'),link=path.join(base,'local');
      await fsp.mkdir(one);await fsp.mkdir(two);await fsp.symlink(one,link,process.platform==='win32'?'junction':'dir');
      x.store.beforeReplace=async()=>{await fsp.unlink(link);await fsp.symlink(two,link,process.platform==='win32'?'junction':'dir');};
      await fails(save(x),['MP_ASSET_TARGET']);assert.equal(await exists(x.to),false);await bytes(path.join(one,'a.png'),'SOURCE');assert.equal(await exists(path.join(two,'a.png')),false);await fsp.unlink(link);
    });
    process.stdout.write(JSON.stringify({ passed: receipts.every(r=>r.status==='pass'), cases: receipts }, null, 2) + '\n');
  } finally {
    // Only this mkdtemp-owned root. No workspace/user deletion.
    if (root) {const absolute=path.resolve(root);assert.equal(path.dirname(absolute).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert(path.basename(absolute).startsWith('mp-save-assets-test-'));await fsp.rm(absolute, { recursive: true, force: true });}
  }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
