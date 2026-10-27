'use strict';
// Native table interaction and ownership workflows. No focus/selection repair.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { args, launch, acquireSlot, sleep } = require('./lifecycle.cjs');
const { outputDir, frame, waitUntil, newWindow } = require('./harness.cjs');
// Import the shared rulers without starting the source-layout CLI.
const sharedFile = path.join(__dirname, 'source-layout-workflows.cjs');
assert(/\bif\s*\(\s*require\.main\s*===\s*module\s*\)/.test(fs.readFileSync(sharedFile, 'utf8')),
  'Source-layout support must expose a guarded CLI entry');
const {
  TABLE, TAIL, read, listen, phase, keys, insert, zoom, enter, geometry,
  point, visiblePoint, clickOffset, visibleCaret, fixtureMap, codepointBoundaries,
} = require('./source-layout-workflows.cjs');

async function main() {
  const o = args(process.argv.slice(2));
  assert(o.exe && o['expected-sha256'], 'packaged --exe and --expected-sha256 required');
  const dir = outputDir(o.out, 'table-interaction-workflows'), release = acquireSlot();
  let run, activePage = null;
  const caseFilter = process.env.MP_QUALITY_CASES ? new RegExp(process.env.MP_QUALITY_CASES) : null;
  const result = {
    schema: 1, suite: 'table-interaction-workflows', expectedFullCases: 8,
    filter: caseFilter?.source || null, startedAt: new Date().toISOString(),
    cases: [], errors: [], cleanup: null,
    notes: [
      'Synthetic fixtures only; no clipboard. All actual frames require Root visual review.',
      'Every case uses a separately opened file in the owned manual-save profile.',
      'Public reading-mode and asynchronous document transactions are explicit fixtures; they do not qualify physical UI or native clipboard entries.',
      'Failure capture reads the failed state and actual pixels, with no focus/selection repair.',
    ],
  };
  const write = () => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  const check = async (id, body) => {
    if (caseFilter && !caseFilter.test(id)) return;
    const c = { id, status: 'running', frames: [], trace: [] };
    activePage = null; result.cases.push(c); write();
    try { await body(c); c.status = 'pass'; }
    catch (e) {
      c.status = 'fail'; c.error = e.stack; write();
      if (activePage) {
        try { c.failureState = await read(activePage); }
        catch (snapshotError) { c.failureStateError = snapshotError.stack; }
        try {
          const file = id + '-failure-raw.png';
          const bytes = await activePage.screenshot({ path: path.join(dir, file), animations: 'disabled' });
          c.rawFailureFrame = { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        } catch (imageError) { c.rawFailureFrameError = imageError.stack; }
        try { c.frames.push(await frame(activePage, dir, id + '-failure', { caret: 'dom', allowMissingCaret: true })); }
        catch (frameError) { c.failureFrameError = frameError.stack; }
      }
      write(); throw e;
    } finally {
      write(); console.log(c.status.toUpperCase() + ' ' + id + (c.error ? ': ' + c.error.split('\n')[0] : ''));
    }
  };
  const capture = async (p, c, name, cell = true) => {
    const s = await read(p); c.trace.push({ step: name, ...s });
    c.frames.push(await frame(p, dir, c.id + '-' + name, { caret: cell ? 'dom' : undefined }));
    return s;
  };
  const fresh = async (id, text) => {
    const file = path.join(dir, id + '.md'); fs.writeFileSync(file, text);
    const p = await newWindow(run, run.page, file); activePage = p;
    await listen(p, result); await p.bringToFront();
    await waitUntil(async () => { const s = await read(p); return s.text === text && s.focus; }, 'new exact source and native focus');
    return { p, file };
  };
  try {
    const owner = path.join(dir, 'owner.md'); fs.writeFileSync(owner, 'Synthetic table interaction owner\n');
    run = await launch({ ...o, settings: { autosaveEnabled: false, restoreLast: false, theme: 'light' } }, owner, dir);
    result.metadata = run.metadata; await listen(run.page, result);

  await check('cell-first-press-drag',async c=>{
   const E0=TABLE('alpha bravo charlie delta echo foxtrot','KEEP'),{p}=await fresh(c.id,E0);await zoom(p,145);
   const b=await p.locator('.mp-row td[data-mp-col="0"]').first().boundingBox(),v=(await read(p)).scrollViewport;assert(b&&b.y>=v.top&&b.y+b.height<=v.bottom,'first drag starts in a visible untouched rendered cell');
   const start={x:b.x+55,y:b.y+b.height/2},end={x:b.x+210,y:start.y};await phase(p,'first-press-drag');await p.mouse.move(start.x,start.y);await p.mouse.down({clickCount:1});for(let n=1;n<=9;n++){await p.mouse.move(start.x+(end.x-start.x)*n/9,start.y);await sleep(25);}await p.mouse.up();await sleep(120);
   let s=await capture(p,c,'first-drag-selected');assert(s.cellFocus&&s.owner.matched);assert.equal(s.text,E0);assert(Math.abs(s.domSelection.head-s.domSelection.anchor)>5,'first mouse press immediately selects several characters');const raw=E0.slice(s.cellFrom,s.cellTo);assert.equal(s.selection.anchor,s.cellFrom+fixtureMap(raw,s.domSelection.anchor));assert.equal(s.selection.head,s.cellFrom+fixtureMap(raw,s.domSelection.head));assert(s.events.filter(e=>e.phase==='first-press-drag'&&e.type==='mousedown'&&e.trusted).length===1,'no second click repairs first entry');
   const lo=Math.min(s.selection.anchor,s.selection.head),hi=Math.max(s.selection.anchor,s.selection.head),E1=E0.slice(0,lo)+'Q'+E0.slice(hi);await insert(p,'Q',true);assert.equal((await read(p)).text,E1);await keys(p,'Control+z',true);assert.equal((await read(p)).text,E0);await keys(p,'Control+y',true);assert.equal((await read(p)).text,E1);
  });
  await check('cell-padding-shift-selection',async c=>{
   const E0=TABLE('alpha bravo charlie delta echo foxtrot','KEEP'),{p}=await fresh(c.id,E0);await zoom(p,145);await enter(p);await clickOffset(p,5);const before=await read(p);assert.deepEqual(before.domSelection,{anchor:5,head:5});
   const target=await p.evaluate(()=>{const td=document.querySelector('.mp-cell-editing'),r=td.getBoundingClientRect(),v=window.mpEngine._view().scrollDOM,s=v.getBoundingClientRect(),scale=s.height/v.offsetHeight,border=parseFloat(getComputedStyle(td).borderTopWidth)*scale;return{x:r.left+r.width*.65,y:r.top+Math.max(border+.5,2.5),r:r.toJSON(),border};});assert(target.y>target.r.top+target.border&&target.y<target.r.bottom,'strict inner top padding');await phase(p,'shift-padding');await p.keyboard.down('Shift');try{await p.mouse.click(target.x,target.y,{delay:65});}finally{await p.keyboard.up('Shift');}await sleep(120);
   const s=await capture(p,c,'shift-padding-selected');assert(s.cellFocus&&s.owner.matched);assert.equal(s.text,E0);assert.equal(s.domSelection.anchor,5,'Shift click in same cell padding retains the native anchor');assert.notEqual(s.domSelection.head,5,'Shift click extends selection into the same source block');const raw=E0.slice(s.cellFrom,s.cellTo);assert.equal(s.selection.anchor,s.cellFrom+fixtureMap(raw,5));assert.equal(s.selection.head,s.cellFrom+fixtureMap(raw,s.domSelection.head));c.target=target;
  });
  await check('cell-async-offset-fixture',async c=>{
   const E0=TABLE('alpha bravo charlie delta','KEEP'),prefix='Synthetic asynchronous external insertion\n\n',{p}=await fresh(c.id,E0);await enter(p);const before=await read(p);c.fixtureStimulus='Explicit delayed source transaction, not a claimed native clipboard entry; subsequent input and history use native keys.';
   await p.evaluate(prefix=>new Promise(resolve=>setTimeout(()=>{window.mpEngine._view().dispatch({changes:{from:0,insert:prefix},userEvent:'input.paste'});resolve();},40)),prefix);await sleep(150);const moved=await capture(p,c,'after-external-insertion');assert.equal(moved.text,prefix+E0);assert(moved.cellFocus&&moved.owner.matched);assert.equal(moved.cellFrom,before.cellFrom+prefix.length);assert.equal(moved.cellText,before.cellText);await keys(p,'End',true);const s=await read(p),E1=s.text.slice(0,s.selection.head)+'Q'+s.text.slice(s.selection.head);await insert(p,'Q',true);assert.equal((await read(p)).text,E1);await keys(p,'Control+z',true);assert.equal((await read(p)).text,prefix+E0);await keys(p,'Control+z',true);assert.equal((await read(p)).text,E0);
  });

// Reveal a not-yet-entered target exclusively through real wheel input.
const cbVisibleBox = async (p, target, name) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const box = await target.boundingBox(), s = await read(p), vp = s.scrollViewport;
    assert(box, name + ': target must be present in the live DOM');
    const y = box.y + Math.min(box.height / 2, 16);
    if (y > vp.top + 8 && y < vp.bottom - 8 && box.x < vp.right - 8 && box.x + box.width > vp.left + 8) return box;
    await phase(p, name + '-reveal');
    await p.mouse.move(vp.left + 12, (vp.top + vp.bottom) / 2);
    await p.mouse.wheel(0, y - (vp.top + 60)); await sleep(120);
    const after = await read(p);
    assert.notEqual(after.scroll.top, s.scroll.top, name + ': reveal wheel must actually move the viewport');
  }
  throw new Error(name + ': could not reveal target using native wheel');
};

const cbNoWritableOverlay = async p => p.evaluate(() => {
  const edit = document.querySelector('.mp-cell-overlay-text');
  const r = edit?.getBoundingClientRect(), cs = edit && getComputedStyle(edit);
  const visible = !!edit?.isConnected && !!r && r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' &&
    getComputedStyle(edit.parentElement).display !== 'none';
  return { visible, writable: visible && edit.isContentEditable, focused: document.activeElement === edit,
    readOnly: window.mpEngine._view().state.readOnly, owner: window.mpEngine.__cellLayout?.() };
});

for (const z of [145, 300]) await check('cell-first-top-padding-' + z, async c => {
  const E0 = TABLE('FIRST WORD 中文🙂\\|tail ' + 'narrow '.repeat(8), 'KEEP');
  const { p } = await fresh(c.id, E0); await zoom(p, z);
  const target = p.locator('.mp-row td[data-mp-col="0"]').first();
  await cbVisibleBox(p, target, c.id);
  const untouched = await read(p);
  assert(!untouched.owner?.owner && !untouched.cellFocus, 'this cell has never been entered');
  const hit = await target.evaluate((td, scale) => {
    const r = td.getBoundingClientRect(), cs = getComputedStyle(td);
    const border = parseFloat(cs.borderTopWidth) * scale, pad = parseFloat(cs.paddingTop) * scale;
    const inset = border + Math.min(pad * .4, 3);
    const left = (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) * scale;
    return { x: r.left + left + 2, y: r.top + inset, border, pad, inset,
      rowFrom: Number(td.dataset.mpRow), col: Number(td.dataset.mpCol), cell: r.toJSON() };
  }, z / 100);
  const vp = untouched.scrollViewport;
  assert(hit.pad > 0 && hit.inset > hit.border + .2 && hit.inset < hit.border + hit.pad,
    'the first click must be strictly past the physical border and inside top padding');
  assert(hit.x > vp.left && hit.x < vp.right && hit.y > vp.top && hit.y < vp.bottom,
    'the padding hit is physically visible');
  await phase(p, 'never-entered-top-padding');
  await p.mouse.click(hit.x, hit.y, { delay: 65 }); await sleep(120);
  const s = await read(p); c.trace.push({ step: 'first-padding-entry', hit, ...s });
  assert.equal(s.text, E0); assert(s.cellFocus && s.owner?.matched, 'first padding click owns native editable focus');
  assert.deepEqual({ rowFrom: s.owner.owner.rowFrom, col: s.owner.owner.col }, { rowFrom: hit.rowFrom, col: hit.col });
  const ruler = await p.evaluate(({ x, y }) => {
    const edit = document.querySelector('.mp-cell-overlay-text'), td = document.querySelector('.mp-cell-editing');
    const event = window.__sourceLayoutEvents.findLast(e => e.phase === 'never-entered-top-padding' && e.type === 'mousedown' && e.trusted);
    if (!event) throw new Error('First padding click has no trusted pointer receipt');
    x = event.x; y = event.y;
    const r = edit?.getBoundingClientRect();
    if (!edit || !td || !(x > r.left && x < r.right && y > r.top && y < r.bottom)) throw new Error('Original padding point is outside the live editing surface');
    const native = document.caretRangeFromPoint(x, y);
    if (!native || !edit.contains(native.startContainer)) throw new Error('Independent native hit did not resolve into the editable source');
    const prefix = document.createRange(); prefix.selectNodeContents(edit); prefix.setEnd(native.startContainer, native.startOffset);
    const fragment = prefix.cloneContents(), walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    let n, offset = 0; while (n = walker.nextNode()) offset += n.textContent.length;
    return { x, y, offset, length: edit.textContent.length, from: Number(td.dataset.mpFrom), to: Number(td.dataset.mpTo),
      events: window.__sourceLayoutEvents.filter(e => e.phase === 'never-entered-top-padding' && e.type === 'mousedown') };
  }, hit);
  c.entryRuler = ruler;
  assert(ruler.events.some(e => e.trusted && e.detail === 1), 'actual first pointer receipt');
  assert(ruler.y > hit.cell.top + hit.border && ruler.y < hit.cell.top + hit.border + hit.pad,
    'the actual delivered pointer, after platform rounding, is still strictly inside top padding');
  assert(ruler.offset < ruler.length, 'this specific padding arm must discriminate native entry from default-to-end');
  assert.deepEqual(s.domSelection, { anchor: ruler.offset, head: ruler.offset }, 'initial padding caret matches independent caretRangeFromPoint');
  const raw = E0.slice(ruler.from, ruler.to), at = ruler.from + fixtureMap(raw, ruler.offset);
  assert.deepEqual(s.selection, { anchor: at, head: at }, 'initial padding caret has exact independent raw mapping');
  await capture(p, c, 'first-padding-native-caret');
  await phase(p, 'padding-native-type'); await insert(p, 'P', true);
  const typed = await capture(p, c, 'padding-typed');
  assert.equal(typed.text, E0.slice(0, at) + 'P' + E0.slice(at));
  assert(typed.cellFocus && typed.owner?.matched);
  assert(typed.events.some(e => e.phase === 'padding-native-type' && e.type === 'input' && e.trusted && e.inCell));
});

await check('cell-public-reading-fixture-145', async c => {
  const E0 = TABLE('READING WORD 中文🙂\\|tail', 'KEEP'), { p } = await fresh(c.id, E0);
  await zoom(p, 145); await enter(p); const entered = await capture(p, c, 'editable-before-reading');
  assert.equal(entered.text, E0); assert(entered.cellFocus && entered.owner?.matched);
  c.fixtureContract = 'Public mpEngine.setReadingMode fixture switch; this arm does NOT qualify the physical reading-mode UI entry.';
  c.enableReading = await p.evaluate(() => ({ ok: window.mpEngine.setReadingMode(true), readOnly: window.mpEngine._view().state.readOnly }));
  assert(c.enableReading.ok && c.enableReading.readOnly); await sleep(120);
  const target = p.locator('.mp-row td[data-mp-col="0"]').first();
  const box = await cbVisibleBox(p, target, c.id);
  await phase(p, 'reading-native-cell-click');
  await p.mouse.click(box.x + box.width * .4, box.y + Math.min(box.height / 2, 16), { delay: 65 }); await sleep(100);
  const clicked = await read(p); c.trace.push({ step: 'reading-native-cell-click', ...clicked });
  assert(clicked.events.some(e => e.phase === 'reading-native-cell-click' && e.type === 'mousedown' && e.trusted && e.inEditor));
  await phase(p, 'reading-native-insert-attempt');
  // Intentional input attempt against the actually clicked read-only owner.
  // Do not use insert(), which correctly requires an editable focused owner.
  await p.keyboard.insertText('READONLY_MUST_NOT_LAND'); await sleep(120);
  const refused = await capture(p, c, 'reading-refused-input', false);
  c.readingSurface = await cbNoWritableOverlay(p);
  assert.equal(refused.text, E0, 'read-only click and real insertText attempt preserve every source byte');
  assert(c.readingSurface.readOnly && !c.readingSurface.writable && !c.readingSurface.focused,
    'reading mode leaves no visible writable or focused cell overlay');
  assert(!refused.owner?.owner, 'reading mode retires the mutable cell owner');
  c.disableReading = await p.evaluate(() => ({ ok: window.mpEngine.setReadingMode(false), readOnly: window.mpEngine._view().state.readOnly }));
  assert(c.disableReading.ok && !c.disableReading.readOnly); await sleep(100);
  await enter(p); const resumed = await capture(p, c, 'reading-disabled-real-reentry');
  assert.equal(resumed.text, E0); assert(resumed.cellFocus && resumed.owner?.matched);
  const at = resumed.selection.head; assert.equal(resumed.selection.anchor, at);
  await phase(p, 'post-reading-native-type'); await insert(p, 'R', true);
  const typed = await capture(p, c, 'post-reading-typed');
  assert.equal(typed.text, E0.slice(0, at) + 'R' + E0.slice(at)); assert(typed.cellFocus && typed.owner?.matched);
  assert(typed.events.some(e => e.phase === 'post-reading-native-type' && e.type === 'input' && e.trusted && e.inCell));
});

await check('cell-async-delete-only-data-row-145', async c => {
  const E0 = TABLE('DELETE WORD 中文🙂\\|tail', 'KEEP'), { p } = await fresh(c.id, E0);
  await zoom(p, 145); await enter(p); const entered = await capture(p, c, 'before-async-row-delete');
  assert.equal(entered.text, E0); assert(entered.cellFocus && entered.owner?.matched);
  const cut = await p.evaluate(() => {
    const td = document.querySelector('.mp-cell-editing'), v = window.mpEngine._view();
    const row = v.state.doc.lineAt(Number(td.dataset.mpRow));
    return { from: row.from, to: Math.min(v.state.doc.length, row.to + 1), text: v.state.doc.sliceString(row.from, Math.min(v.state.doc.length, row.to + 1)),
      dataRowCount: new Set(Array.from(v.contentDOM.querySelectorAll('.mp-row td[data-mp-row]'), e => e.dataset.mpRow)).size };
  });
  assert.equal(cut.dataRowCount, 1, 'fixture has exactly one data row; AFTER remains outside the table');
  assert.equal(E0.slice(cut.from, cut.to), cut.text);
  const E1 = E0.slice(0, cut.from) + E0.slice(cut.to);
  c.fixtureContract = 'A separately labelled asynchronous document transaction deletes the active row; it is fixture setup, not a claimed native row-delete entry.';
  c.asyncDelete = await p.evaluate(cut => new Promise((resolve, reject) => setTimeout(() => {
    try {
      const v = window.mpEngine._view();
      if (v.state.doc.sliceString(cut.from, cut.to) !== cut.text) throw new Error('Async row-delete fixture no longer matches');
      v.dispatch({ changes: { from: cut.from, to: cut.to } });
      resolve({ applied: true, from: cut.from, to: cut.to, docLength: v.state.doc.length });
    } catch (e) { reject(e); }
  }, 20)), cut);
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await sleep(100);
  const deleted = await capture(p, c, 'after-async-row-delete', false);
  c.afterDeleteSurface = await cbNoWritableOverlay(p);
  assert.equal(deleted.text, E1); assert(!deleted.owner?.active && !deleted.owner?.owner, 'deleted final data row retires both active and editable owner');
  assert(!c.afterDeleteSurface.writable && !c.afterDeleteSurface.focused, 'deleted row leaves no writable/focused stale overlay');
  const after = p.locator('.cm-line').filter({ hasText: /^AFTER$/ });
  assert.equal(await after.count(), 1, 'the independent AFTER body target is mounted');
  const box = await cbVisibleBox(p, after, 'after-row-delete-body');
  await phase(p, 'after-row-delete-native-body-click');
  await p.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2, { delay: 65 }); await sleep(100);
  const body = await read(p); c.trace.push({ step: 'body-click-after-row-delete', ...body });
  assert(body.focus && !body.cellFocus && !body.owner?.owner, 'real AFTER click owns the normal source editor');
  assert(body.events.some(e => e.phase === 'after-row-delete-native-body-click' && e.type === 'mousedown' && e.trusted && e.inEditor && !e.inCell));
  const afterFrom = E1.indexOf('\nAFTER') + 1;
  assert(afterFrom > 0 && body.selection.anchor >= afterFrom && body.selection.anchor <= afterFrom + 5 && body.selection.head >= afterFrom && body.selection.head <= afterFrom + 5,
    'actual click selection belongs to AFTER, never the retired table cell');
  await keys(p, 'End'); const beforeType = await read(p), at = beforeType.selection.head;
  assert.equal(at, afterFrom + 5, 'native End reaches AFTER body end');
  await phase(p, 'after-row-delete-native-body-type'); await insert(p, ' BODY_OK');
  const typed = await capture(p, c, 'body-typed-after-row-delete', false);
  assert.equal(typed.text, E1.slice(0, at) + ' BODY_OK' + E1.slice(at));
  assert(typed.text.startsWith(E0.slice(0, cut.from)), 'original table header/separator stay byte-exact');
  assert(typed.focus && !typed.cellFocus && !typed.owner?.owner);
  assert(typed.events.some(e => e.phase === 'after-row-delete-native-body-type' && e.type === 'input' && e.trusted && e.inEditor && !e.inCell));
});

await check('stable-row-native-owner-and-history', async c => {
  // Plain synthetic cells only: bare-pipe offsets are an independent fixture ruler.
  // Every column maximum belongs to later rows, so R0 + Q cannot alter weights.
  const data = Array.from({length:36}, (_, i) => {
    if (!i) return '| R0 | s | t |';
    const id = 'R' + String(i).padStart(2, '0');
    const a = id + ' alpha longer value', b = id + ' beta longer value';
    // One ragged row also exercises the retained phantom-cell shape.
    return '| ' + a + ' | ' + b + (i === 7 ? ' |' : ' | ' + id + ' gamma longer value |');
  });
  const E0 = ['BEFORE', '', '| A | B | C |', '| --- | --- | --- |',
    ...data, '', 'AFTER', '', ...Array(12).fill('Native ownership tail.'), ''].join('\n');
  const bareRows = text => {
    let from = 0; const out = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('|') && line.endsWith('|')) {
        const fields = line.split('|').slice(1, -1); let at = from + 1;
        const ranges = fields.map(field => {
          const r = [at, at + field.length]; at += field.length + 1; return r;
        });
        out.push({rowFrom:from, fields, ranges});
      }
      from += line.length + 1;
    }
    return out;
  };
  const {p} = await fresh(c.id, E0);
  await zoom(p, 100); // Qualify visible-row ownership independently of inherited zoom.
  const first = bareRows(E0)[2]; // header, separator, then the first data row
  const liveRanges = async expected => {
    const models = new Map(bareRows(expected).map(r => [String(r.rowFrom), r]));
    const observed = await p.evaluate(() => {
      const v = window.mpEngine._view(), vp = v.scrollDOM.getBoundingClientRect();
      return [...v.contentDOM.querySelectorAll('.mp-row td')].filter(td => {
        const r = td.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > Math.max(0, vp.top) &&
          r.top < Math.min(innerHeight, vp.bottom) && r.right > Math.max(0, vp.left) &&
          r.left < Math.min(innerWidth, vp.right);
      }).map(td => ({row:td.dataset.mpRow, col:Number(td.dataset.mpCol),
        from:td.getAttribute('data-mp-from'), to:td.getAttribute('data-mp-to'),
        phantom:td.getAttribute('data-mp-phantom'), editing:td.classList.contains('mp-cell-editing'),
        text:td.textContent}));
    });
    assert(observed.length >= 15, 'at least five visible data rows qualified');
    for (const td of observed) {
      const model = models.get(td.row);
      assert(model, 'visible TD row offset belongs to independently split current fixture');
      const r = model.ranges[td.col];
      if (r) {
        assert.equal(td.from, String(r[0]), 'current untrimmed raw cell start');
        assert.equal(td.to, String(r[1]), 'current untrimmed raw cell end');
        assert.equal(td.phantom, null, 'real cell has no phantom flag');
        if (!td.editing) assert.equal(td.text.trim(), model.fields[td.col].trim(),
          'retained rendered row still belongs to its independently identified fixture row');
      } else {
        assert.equal(td.from, null); assert.equal(td.to, null);
        assert.equal(td.phantom, '1', 'missing raw field stays a phantom cell');
      }
    }
    return observed.length;
  };
  await liveRanges(E0);
  c.initialNodes = await p.evaluate(firstFrom => {
    const v = window.mpEngine._view(), vp = v.scrollDOM.getBoundingClientRect();
    window.__stableRowOwnershipRefs = [...v.contentDOM.querySelectorAll('.mp-table-wrap')]
      .filter(wrap => {
        const td = wrap.querySelector('td[data-mp-col="0"]'), r = td?.getBoundingClientRect();
        return r && Number(td.dataset.mpRow) !== firstFrom &&
          r.top >= Math.max(0, vp.top) + 2 && r.bottom <= Math.min(innerHeight, vp.bottom) - 2;
      }).map(wrap => {
        const table = wrap.querySelector('table'), tr = table.rows[0], cells = [...tr.cells];
        return {wrap, table, tr, parent:wrap.parentElement,
          index:[...wrap.parentElement.children].indexOf(wrap), cells,
          contents:cells.map(td => [...td.childNodes]),
          descendants:cells.map(td => [...td.querySelectorAll('*')])};
      });
    return {count:window.__stableRowOwnershipRefs.length};
  }, first.rowFrom);
  assert(c.initialNodes.count >= 5, 'five fully visible inactive rows recorded before input');
  await enter(p); await keys(p, 'End', true);
  let s = await read(p);
  assert.equal(s.selection.anchor, first.ranges[0][1]);
  assert.equal(s.selection.head, first.ranges[0][1], 'native End reaches independent raw field end');
  const qAt = first.ranges[0][1], E1 = E0.slice(0, qAt) + 'Q' + E0.slice(qAt);
  await insert(p, 'Q', true);
  s = await capture(p, c, 'first-cell-Q'); assert.equal(s.text, E1);
  c.retainedNodes = await p.evaluate(() => window.__stableRowOwnershipRefs.map(r => ({
    same:r.wrap.isConnected && r.wrap.parentElement === r.parent &&
      [...r.parent.children].indexOf(r.wrap) === r.index &&
      r.wrap.querySelector('table') === r.table && r.table.rows[0] === r.tr &&
      [...r.tr.cells].length === r.cells.length && r.cells.every((td, i) =>
        r.tr.cells[i] === td && td.childNodes.length === r.contents[i].length &&
        r.contents[i].every((n, j) => td.childNodes[j] === n) &&
        td.querySelectorAll('*').length === r.descendants[i].length &&
        r.descendants[i].every((n, j) => td.querySelectorAll('*')[j] === n))
  })));
  assert(c.retainedNodes.every(r => r.same), 'inactive wrap/table/TR/TD/content remain at original positions');
  c.visibleRangeCount = await liveRanges(E1);

  // Choose the fifth fully visible inactive data row through current real geometry.
  const target = await p.evaluate(() => {
    const v = window.mpEngine._view(), vp = v.scrollDOM.getBoundingClientRect();
    const list = [...v.contentDOM.querySelectorAll('.mp-row td[data-mp-col="0"]')].filter(td => {
      const r = td.getBoundingClientRect();
      return !td.classList.contains('mp-cell-editing') && r.height > 0 &&
        r.top >= Math.max(0, vp.top) + 2 && r.bottom <= Math.min(innerHeight, vp.bottom) - 2;
    });
    const td = list[4]; if (!td) throw new Error('fifth visible inactive row missing');
    const r = td.getBoundingClientRect();
    return {row:Number(td.dataset.mpRow), text:td.textContent,
      x:r.left + r.width * .35, y:r.top + Math.min(18, r.height / 2)};
  });
  const model = bareRows(E1).find(r => r.rowFrom === target.row);
  assert(model); assert.equal(target.text.trim(), model.fields[0].trim());
  await phase(p, 'stable-row-fifth-native-click');
  await p.mouse.click(target.x, target.y, {delay:65});
  await waitUntil(async () => {
    const q = await read(p);
    return q.cellFocus && q.owner?.matched && q.cellFrom === model.ranges[0][0] &&
      q.cellTo === model.ranges[0][1];
  }, 'fifth retained row owns its exact current native editor');
  s = await read(p); assert.equal(s.text, E1);
  assert.equal(s.cellText, E1.slice(...model.ranges[0]));
  await keys(p, 'End', true); s = await read(p);
  assert.equal(s.selection.anchor, model.ranges[0][1]);
  assert.equal(s.selection.head, model.ranges[0][1]);
  const zAt = model.ranges[0][1], E2 = E1.slice(0, zAt) + 'Z' + E1.slice(zAt);
  await insert(p, 'Z', true);
  assert.equal((await capture(p, c, 'fifth-row-Z')).text, E2);
  await keys(p, 'Control+z', true);
  assert.equal((await capture(p, c, 'fifth-row-undo-Z')).text, E1);
  await keys(p, 'Control+y', true);
  assert.equal((await capture(p, c, 'fifth-row-redo-Z')).text, E2);
  await liveRanges(E2);
});

    assert.deepEqual(result.errors, [], 'all owned windows have no pageerrors');
    if (!caseFilter) assert.equal(result.cases.length, result.expectedFullCases, 'unfiltered suite executes all eight maintained cases');
  } catch (e) {
    result.fatal = e.stack; process.exitCode = 1;
  } finally {
    if (run) try {
      result.cleanup = await run.cleanup();
      if (result.cleanup.residual.length) process.exitCode = 1;
    } catch (e) { result.cleanup = { error: e.stack }; process.exitCode = 1; }
    try { release(); } catch (e) { result.slotReleaseError = e.stack; process.exitCode = 1; }
    result.finishedAt = new Date().toISOString();
    result.fullSuite = !caseFilter && result.cases.length === result.expectedFullCases;
    result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') &&
      !result.errors.length && !result.fatal && !result.slotReleaseError &&
      !!result.cleanup && !result.cleanup.error &&
      Array.isArray(result.cleanup.residual) && result.cleanup.residual.length === 0 &&
      (!!caseFilter || result.fullSuite);
    if (!result.passed) process.exitCode = 1;
    write();
    console.log(JSON.stringify({
      suite: result.suite, passed: result.passed, fullSuite: result.fullSuite,
      cases: result.cases.length, expectedFullCases: result.expectedFullCases,
      filter: result.filter, errors: result.errors.length, cleanup: result.cleanup,
    }));
  }
}
module.exports = { main };
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
