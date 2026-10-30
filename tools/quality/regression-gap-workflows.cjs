'use strict';
/*
 * remediation-363/remaining-workflows.cjs - bounded arms for the remaining ledger contracts.
 * Adapts the maintained harness (lifecycle/harness/recorder/clipboard) and the
 * selection/rich/images/stability family-probe patterns. Run by Main:
 *   node .mp-verify/remediation-363/remaining-workflows.cjs --exe <MarkPilot.exe> --expected-sha256 <sha> --out <empty dir>
 *   optional: MP_QUALITY_CASES=<regex>, MP_TOKEN11_SHAPE_JSON=<path> (verified CAND-IMAGE-TOKEN-11 shape; NOT invented here)
 * Behavior actions are real CDP keyboard/mouse only; page.evaluate is used solely for
 * passive reads, fixture preparation (reset) and the host clipboard arm API, exactly as in
 * the maintained suites. Disk readback via autosave (group A) and native Ctrl+S body save
 * (group B, autosave off). Channel note (correction r2): CDP Ctrl+Alt+Delete DOES reach the
 * app (invokes delete-column); the failing channel elsewhere is CDP Ctrl+S on the active
 * cell overlay not hitting the native menu accelerator - this probe therefore never relies
 * on Ctrl+S inside a cell overlay.
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
function repositoryRoot(start) {
  let current = fs.realpathSync(start);
  for (;;) {
    if (fs.existsSync(path.join(current, 'tools/quality/lifecycle.cjs')) &&
        fs.existsSync(path.join(current, 'MarkPilot-CM6/main.js')) &&
        fs.existsSync(path.join(current, 'dsh-markpilot/src-cm6/main.js'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate the source checkout');
    current = parent;
  }
}
const ROOT = repositoryRoot(__dirname);
const { args, launch, acquireSlot, sleep } = require(path.join(ROOT, 'tools/quality/lifecycle.cjs'));
const { outputDir, snapshot, reset, frame, recorder, waitUntil, newWindow } = require(path.join(ROOT, 'tools/quality/harness.cjs'));
const clipboard = require(path.join(ROOT, 'tools/quality/clipboard.cjs'));
const ICON = path.join(ROOT, 'MarkPilot-CM6/build/icon-preview.png'); // verified real PNG (stability-workflows uses it)
const table = 'Before\n\n|H|K|\n|---|---|\n|ab|KEEP|\n\nAfter\n';   // selection-workflows table fixture
const cellState = p => p.evaluate(() => { const el = document.querySelector('.mp-cell-overlay-text'), s = getSelection(), ae = document.activeElement, source = window.mpEngine._view().state.selection.main; return { text: window.mpEngine.getValue(), sourceSelection: { anchor: source.anchor, head: source.head }, cellText: el?.textContent, focus: document.hasFocus() && ae === el, documentFocus: document.hasFocus(), activeElement: { tag: ae?.tagName, class: ae?.className }, overlayVisible: !!el && el.getBoundingClientRect().height > 0, anchor: s?.anchorOffset, head: s?.focusOffset, focusNode: { type: s?.focusNode?.nodeType, text: s?.focusNode?.textContent, withinOverlay: !!el && el.contains(s?.focusNode) } }; });
(async () => {
  const o = args(process.argv.slice(2)), dir = outputDir(o.out, 'remaining-workflows'), release = acquireSlot();
  const result = { schema: 1, suite: 'remaining-workflows', startedAt: new Date().toISOString(), cases: [], errors: [], clipboard: { touched: false, restored: null }, token11: { provided: !!process.env.MP_TOKEN11_SHAPE_JSON, located: null } };
  const record = recorder(dir, result), filter = process.env.MP_QUALITY_CASES;
  const test = (id, body) => !filter || new RegExp(filter).test(id) ? record(id, body) : Promise.resolve();
  let runA = null, runB = null, clip = null; const residuals = [];
  const fresh = async (run, name, text) => { const file = path.join(dir, name + '.md'); fs.writeFileSync(file, text); const p = await newWindow(run, run.page, file); p.on('pageerror', e => result.errors.push(e.message)); await p.bringToFront(); await waitUntil(async () => (await snapshot(p)).focus, 'fixture boot focus'); return { p, file }; };
  const openCell = async (p, trace, expected = 'ab') => { await sleep(900); await p.locator('.mp-row td[data-mp-row]').first().click({ delay: 65 }); await waitUntil(async () => (await cellState(p)).focus, 'actual cell overlay focus'); const s = await cellState(p); trace.push({ name: 'cell-click', ...s }); assert.equal(s.cellText, expected); await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight'); const k = await cellState(p); assert.equal(k.head, Math.min(1, expected.length), 'cell caret after first glyph'); assert(k.focus); };
  const lineClasses = p => p.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.className));
  const imgStates = p => p.evaluate(() => [...document.querySelectorAll('.cm-content .mp-img img')].map(i => ({ src: i.getAttribute('src')?.slice(0, 160), complete: i.complete, naturalWidth: i.naturalWidth, failed: !!i.closest('.is-failed') })));
  try {
    /* ---------------- group A: autosave-on launch (selection/rich family patterns) ---------------- */
    const ownerA = path.join(dir, 'owner-a.md'); fs.writeFileSync(ownerA, 'Remaining workflows A\n');
    runA = await launch(o, ownerA, dir); result.artifact = runA.metadata; clip = await clipboard.hold(); result.clipboard.touched = true;

    await test('cell-formula-source-insert-exact-history', async trace => {           // GAP-60-SOURCES arm 1
      const { p, file } = await fresh(runA, 'gap60-formula', table); await openCell(p, trace);
      await p.keyboard.insertText('$$x$$');
      const edited = table.replace('|ab|KEEP|', () => '|a$$x$$b|KEEP|'), s = await cellState(p);
      trace.push({ name: 'inserted', ...s, screenshot: await frame(p, dir, 'gap60-formula-01', { caret: 'dom', allowMissingCaret: true }) });
      assert.equal(s.text, edited, 'in-cell $$ insertion is a pure single-cell source change'); assert.equal(s.cellText, 'a$$x$$b'); assert(s.focus);
      assert.equal(await p.locator('.mp-row td[data-mp-row]').count(), 2, 'no new columns or rows');
      await p.keyboard.press('Control+z'); const u = await cellState(p);
      assert.equal(u.text, table, 'undo restores exact fixture'); assert.equal(u.cellText, 'ab');
      await p.keyboard.press('Control+y'); assert.equal((await cellState(p)).text, edited, 'redo restores exact insertion');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === edited, 'autosave disk readback equals edited source');
      return { source: '$$x$$', undoRedo: true, disk: true };
    });

    await test('cell-linebreak-source-insert-exact-history', async trace => {         // GAP-60-SOURCES arm 2
      const { p, file } = await fresh(runA, 'gap60-linebreak', table); await openCell(p, trace);
      await p.keyboard.insertText('<br>');
      const edited = table.replace('|ab|KEEP|', '|a<br>b|KEEP|'), s = await cellState(p);
      trace.push({ name: 'inserted', ...s, screenshot: await frame(p, dir, 'gap60-linebreak-01', { caret: 'dom', allowMissingCaret: true }) });
      assert.equal(s.text, edited, 'in-cell <br> insertion is a pure single-cell source change'); assert(s.focus);
      assert.equal(await p.locator('.mp-row td[data-mp-row]').count(), 2, 'no new columns or rows');
      await p.keyboard.press('Control+z'); assert.equal((await cellState(p)).text, table, 'undo restores exact fixture');
      await p.keyboard.press('Control+y'); assert.equal((await cellState(p)).text, edited, 'redo restores exact insertion');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === edited, 'autosave disk readback equals edited source');
      return { source: '<br>', undoRedo: true, disk: true };
    });

    await test('single-cell-cfhtml-paste-into-active-cell', async trace => {           // OLD-TBL8 missing arm
      const { p, file } = await fresh(runA, 'tbl8-single-cell', table); await openCell(p, trace);
      const plain = 'SOLE_CELL', html = '<table><tr><td>SOLE_CELL</td></tr></table>';
      const ack = await p.evaluate(payload => window.mpHost.writeClipboard(payload, window.mpHost.beginClipboardIntent('copy')), { text: plain, html });
      const before = { text: clipboard.verifyText(plain), html: clipboard.verifyHtml(html) }; trace.push({ name: 'clipboard-armed', ack, ...before });
      assert(ack?.ok && before.text.matches && before.html.matches, 'independent clipboard armed and read back');
      await p.evaluate(() => { window.__qualityPaste = null; document.addEventListener('paste', e => { const h = e.clipboardData?.getData('text/html') || ''; window.__qualityPaste = { trusted: e.isTrusted, format: h ? 'html' : 'plain' }; }, { capture: true, once: true }); });
      await p.keyboard.press('Control+v'); await sleep(300);
      const pasted = await cellState(p), paste = await p.evaluate(() => window.__qualityPaste);
      const after = { text: clipboard.verifyText(plain), html: clipboard.verifyHtml(html) }; trace.push({ name: 'pasted', ...pasted, paste, clipboardAfter: after, screenshot: await frame(p, dir, 'tbl8-01', { caret: 'dom', allowMissingCaret: true }) });
      assert(paste?.trusted, 'real trusted paste event reached the editor');
      const expected = table.replace('|ab|KEEP|', '|aSOLE_CELLb|KEEP|');
      assert.equal(pasted.text, expected, 'single-cell CF_HTML lands inside the active cell as a pure insertion');
      assert.equal(pasted.cellText, 'aSOLE_CELLb'); assert(pasted.focus);
      assert.equal(await p.locator('.mp-row td[data-mp-row]').count(), 2, 'single-cell paste never builds a table');
      assert(after.text.matches && after.html.matches, 'clipboard payload retained after paste');
      await p.keyboard.press('Control+z'); assert.equal((await cellState(p)).text, table, 'undo restores exact fixture');
      await p.keyboard.press('Control+y'); assert.equal((await cellState(p)).text, expected, 'redo restores exact paste');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === expected, 'autosave disk readback equals pasted source');
      return { plain, html, undoRedo: true, clipboardRetained: true, disk: true };
    });

    await test('no-selection-cut-preserves-document-and-clipboard', async trace => {   // OBS-CUT-NOSELECTION one real arm
      const text = 'CUT NO-SELECTION BASE\n', { p, file } = await fresh(runA, 'nosel-cut', text);
      await p.keyboard.press('Control+Home'); for(let n=0;n<5;n++) await p.keyboard.press('ArrowRight'); const s = await snapshot(p);
      assert.deepEqual({ a: s.selection.anchor, h: s.selection.head }, { a: 5, h: 5 }, 'collapsed caret, no selection (passive read)');
      const sentinel = 'QUALITY_NOSEL_SENTINEL';
      const ack = await p.evaluate(t => window.mpHost.writeClipboard({ text: t }, window.mpHost.beginClipboardIntent('copy')), sentinel);
      assert(ack?.ok && clipboard.verifyText(sentinel).matches, 'sentinel armed with independent readback');
      const errorsBefore = result.errors.length;
      await p.keyboard.press('Control+x'); await sleep(200);
      const after = await snapshot(p), kept = clipboard.verifyText(sentinel);
      trace.push({ name: 'after-cut', ...after, clipboard: kept, screenshot: await frame(p, dir, 'nosel-01') });
      assert.equal(after.text, text, 'no-selection cut leaves the document unchanged');
      assert(kept.matches, 'no-selection cut leaves the armed clipboard payload unchanged');
      assert.equal(result.errors.length, errorsBefore, 'no page errors from no-selection cut');
      await p.keyboard.press('Control+Home'); for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowRight');
      assert.equal((await snapshot(p)).selection.head, 3, 'positive-control selection of CUT');
      await p.keyboard.press('Control+x');
      const pos = await snapshot(p), taken = clipboard.verifyText('CUT');
      trace.push({ name: 'positive-control', ...pos, clipboard: taken });
      assert.equal(pos.text, text.slice(3), 'real selection cut removes exactly the selection (channel discriminability)');
      assert(taken.matches, 'real selection cut writes the selection to the clipboard');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === text.slice(3), 'autosave disk readback');
      return { noOp: true, clipboardPreserved: true, positiveControl: true };
    });

    await test('literal-html-image-empty-src-adjacent-edit-undo', async trace => {     // CAND-LITERAL-HTML-IMAGE-EMPTY
      const docDir = dir; fs.mkdirSync(path.join(docDir, 'assets'), { recursive: true });
      fs.copyFileSync(ICON, path.join(docDir, 'assets', 'probe-icon.png'));
      const text = '![valid](assets/probe-icon.png) <img src=""> tail\n\nBODY\n', { p, file } = await fresh(runA, 'img-empty-src', text);
      await waitUntil(async () => (await imgStates(p)).some(i => i.complete && i.naturalWidth > 0 && !i.failed), 'valid adjacent image decodes', 15000);
      const caret = text.indexOf(' tail') + 1; await reset(p, text, caret);
      const before = { lines: await lineClasses(p), imgs: await imgStates(p) }; trace.push({ name: 'before', ...before });
      await p.keyboard.insertText('K');
      const expected = text.slice(0, caret) + 'K' + text.slice(caret);
      const edited = await snapshot(p); assert.equal(edited.text, expected, 'adjacent edit inserts exactly one glyph');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === expected, 'autosave disk readback equals edited source');
      await p.keyboard.press('Control+z');
      const undone = await snapshot(p), after = { lines: await lineClasses(p), imgs: await imgStates(p) };
      trace.push({ name: 'after-undo', ...after, screenshot: await frame(p, dir, 'img-empty-01') });
      assert.equal(undone.text, text, 'undo restores the paragraph source byte-exactly (empty-src img intact)');
      assert.deepEqual(after.lines, before.lines, 'line grammar (engine-rendered classes) preserved through edit+undo');
      assert.equal(after.imgs.filter(i => !i.failed && i.naturalWidth > 0).length, before.imgs.filter(i => !i.failed && i.naturalWidth > 0).length, 'valid image survives identically');
      await p.keyboard.press('Control+y'); assert.equal((await snapshot(p)).text, expected, 'redo restores the edited source');
      return { sourceExact: true, grammarStable: true, emptySrcCount: before.imgs.length };
    });

    if (process.env.MP_TOKEN11_SHAPE_JSON) {                                           // CAND-IMAGE-TOKEN-11: only with a located original shape
      const shape = JSON.parse(fs.readFileSync(process.env.MP_TOKEN11_SHAPE_JSON, 'utf8'));
      assert(shape.syntax && shape.expected, 'shape file needs {syntax, expected}'); result.token11.located = true; result.token11.source = process.env.MP_TOKEN11_SHAPE_JSON;
      await test('cand-image-token-11-exact-shape', async trace => {
        const docDir = path.join(dir, 'token11doc'); fs.mkdirSync(path.join(docDir, 'assets'), { recursive: true });
        for (const m of shape.syntax.matchAll(/src="([^"]+)"/g)) if (!m[1].startsWith('data:')) try { fs.copyFileSync(ICON, path.join(docDir, m[1].replace(/^[.\/]*/, ''))); } catch { }
        const text = shape.syntax + '\n\nBODY\n', { p } = await fresh(runA, 'token11', text);
        await reset(p, text, text.length); const before = await imgStates(p); trace.push({ name: 'before', imgs: before });
        await p.keyboard.insertText('K'); await p.keyboard.press('Control+z');
        const undone = await snapshot(p), after = await imgStates(p);
        assert.equal(undone.text, text, 'exact-shape source preserved through adjacent edit+undo');
        const plain = await p.evaluate(t => new DOMParser().parseFromString(t, 'text/html').body.textContent.trim(), undone.text);
        assert.equal(plain, 'BODY', 'no stray attributes or URL suffix leak from the token shape');
        trace.push({ name: 'after', imgs: after });
        return { shapeApplied: true, imgsBefore: before.length, imgsAfter: after.length };
      });
    } else { result.token11.located = false; result.token11.reason = 'original token-11 shape absent from ledger/private archive (title-only entries, root null); not invented'; }

    Object.assign(result.clipboard, await clip.restore()); clip = null;
    const cleanA = await runA.cleanup(); residuals.push(...cleanA.residual); runA = null;

    /* ---------------- group B: autosave-off launch for the dirty-flag contract ---------------- */
    const ownerB = path.join(dir, 'owner-b.md'); fs.writeFileSync(ownerB, 'DIRTY BASE\n');
    runB = await launch({ ...o, settings: { autosaveEnabled: false, restoreLast: false, theme: 'light' } }, ownerB, dir);
    result.artifactDirtyRun = runB.metadata;
    await test('dirty-revision-remains-until-save-after-undo', async trace => {       // OBS-DIRTY-UNDO accepted revision contract
      const p = runB.page, file = ownerB; await p.bringToFront();
      await waitUntil(async () => (await snapshot(p)).focus, 'editor focus');
      const probe = await p.evaluate(() => ({ dirty: typeof dirty === 'undefined' ? null : !!dirty, saveInFlight: typeof saveInFlight === 'undefined' ? null : !!saveInFlight }));
      trace.push({ name: 'debug-globals', ...probe });
      assert(probe.dirty !== null && probe.saveInFlight !== null, 'product dirty/saveInFlight debug globals exposed (passive precondition)');
      assert(probe.dirty === false, 'clean start is not dirty');
      await p.keyboard.press('Control+End'); await p.keyboard.insertText('EDITED');
      await waitUntil(() => p.evaluate(() => dirty === true), 'real edit marks the document dirty');
      await p.keyboard.press('Control+s');                                            // body-context Ctrl+S (verified channel; never inside a cell overlay here)
      await waitUntil(() => p.evaluate(() => !dirty && !saveInFlight), 'body Ctrl+S completes the native save path');
      const saved = 'DIRTY BASE\nEDITED';
      await waitUntil(() => fs.readFileSync(file, 'utf8') === saved, 'disk readback equals saved bytes');
      await sleep(650); // Real pause isolates the saved edit from subsequent typing history.
      await p.keyboard.insertText('MORE'); await waitUntil(() => p.evaluate(() => dirty === true), 'second edit marks dirty again');
      await p.keyboard.press('Control+z');
      assert.equal((await snapshot(p)).text, saved, 'undo returns the exact saved bytes');
      trace.push({name:'undo-to-saved',text:(await snapshot(p)).text,dirty:await p.evaluate(()=>dirty),screenshot:await frame(p,dir,'dirty-undo-to-saved')});
      assert.equal(await p.evaluate(() => dirty),true,'accepted contract: Undo is a new revision until explicitly saved');
      await p.keyboard.press('Control+s');await waitUntil(()=>p.evaluate(()=>!dirty&&!saveInFlight),'explicit save clears revision dirty');
      assert.equal(fs.readFileSync(file,'utf8'),saved,'save preserves exact restored bytes');
      await p.keyboard.press('Control+z');                                            // one step past saved content
      const past = await snapshot(p), pastDirty = await p.evaluate(() => dirty);
      trace.push({ name: 'past-saved', text: past.text, dirty: pastDirty });
      assert.equal(past.text, 'DIRTY BASE\n', 'second undo reaches the original base'); assert(pastDirty === true, 'content below saved bytes stays dirty');
      await p.keyboard.press('Control+y');await waitUntil(()=>p.evaluate(()=>dirty===true),'Redo is also a new unsaved revision');
      assert.equal((await snapshot(p)).text,saved);await p.keyboard.press('Control+s');await waitUntil(()=>p.evaluate(()=>!dirty&&!saveInFlight),'save after Redo clears dirty');
      return { oracle: 'accepted monotonic revision contract; Save clears dirty', disk: fs.readFileSync(file, 'utf8') };
    });
    const cleanB = await runB.cleanup(); residuals.push(...cleanB.residual); runB = null;
  } catch (e) { result.fatal = e.stack; process.exitCode = 1; } finally {
    if (clip) { try { Object.assign(result.clipboard, await clip.restore()); } catch (e) { result.clipboard.restored = false; result.clipboard.error = e.message; } }
    for (const r of [runA, runB]) if (r) { try { const c = await r.cleanup(); residuals.push(...c.residual); } catch (e) { residuals.push('cleanup-error: ' + e.message); } }
    release();
    result.cleanup = { residual: residuals };
    result.finishedAt = new Date().toISOString();
    result.passed = !result.fatal && !result.errors.length && result.cases.length > 0 && result.cases.every(c => c.status === 'pass') && result.clipboard.restored === true && residuals.length === 0;
    if (filter && result.cases.length === 0) { result.passed = false; result.zeroSelected = true; }
    if (!result.passed) process.exitCode = 1;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, cases: result.cases.length, fatal: result.fatal || null, clipboard: result.clipboard, cleanup: result.cleanup }));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
