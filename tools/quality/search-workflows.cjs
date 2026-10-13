'use strict';
// Actual body, toolbar and active-cell search entries plus query/return/edit/history.
// Renderer-CDP keys and mouse; no OS menu or native accelerator coverage is claimed.
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
function repositoryRoot(start) {
  let current = fs.realpathSync(start);
  for (;;) {
    if (fs.existsSync(path.join(current, 'tools/quality/lifecycle.cjs')) &&
        fs.existsSync(path.join(current, 'MarkPilot-CM6/main.js'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate MarkPilot checkout');
    current = parent;
  }
}
const ROOT = repositoryRoot(__dirname);
const { args, launch, acquireSlot, sleep } = require(path.join(ROOT, 'tools/quality/lifecycle.cjs'));
const { outputDir, frame, recorder, waitUntil, newWindow } = require(path.join(ROOT, 'tools/quality/harness.cjs'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ids = {
  body: 'body-ctrl-f-search-focus-positive-control',
  toolbar: 'toolbar-find-replace-search-focus-positive-control',
  cell: 'active-cell-ctrl-f-opens-search-without-document-edit',
  replace: 'search-cell-match-direct-replacement-history',
  encoded: 'search-escaped-pipe-emoji-math-cell-return-history',
  ordinary: 'search-ordinary-body-return-history-positive-control',
  cross: 'search-cross-cell-return-does-not-clamp-owner',
  separator: 'search-separator-return-does-not-clamp-owner',
  escape: 'search-partial-escape-return-preserves-native-range',
  immediate: 'search-cell-immediate-return-type-history',
};
async function state(page) {
  return page.evaluate(() => {
    const v = window.mpEngine._view(), ae = document.activeElement, s = getSelection();
    const cell = document.querySelector('.mp-cell-overlay-text');
    const search = document.querySelector('.cm-search input[name="search"]');
    const rect = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const cellOffset = (node, offset) => {
      if (!cell || !node || !cell.contains(node)) return null;
      const range = document.createRange();
      range.selectNodeContents(cell); range.setEnd(node, offset);
      return range.toString().length;
    };
    return {
      text: v.state.doc.toString(), title: document.title,
      sourceSelection: { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head },
      editorFocus: v.hasFocus && document.hasFocus(), documentFocus: document.hasFocus(),
      activeElement: { tag: ae?.tagName, class: ae?.className, name: ae?.getAttribute('name'), type: ae?.getAttribute('type') },
      cell: {
        text: cell?.textContent, focus: document.hasFocus() && ae === cell,
        visible: !!cell && cell.getBoundingClientRect().height > 0,
        anchor: s?.anchorOffset, head: s?.focusOffset,
        anchorInCell: !!cell && !!s?.anchorNode && cell.contains(s.anchorNode),
        headInCell: !!cell && !!s?.focusNode && cell.contains(s.focusNode),
        textAnchor: cellOffset(s?.anchorNode, s?.anchorOffset),
        textHead: cellOffset(s?.focusNode, s?.focusOffset),
      },
      search: {
        exists: !!search, focus: document.hasFocus() && ae === search,
        rect: rect(search), value: search?.value,
        inputSelection: search ? { start: search.selectionStart, end: search.selectionEnd, direction: search.selectionDirection } : null,
      },
      keys: (window.__qualityCommonKeys || []).slice(-16),
      clicks: (window.__qualityCommonClicks || []).slice(-12),
      menus: (window.__qualityCommonMenus || []).slice(),
      focuses: (window.__qualityCommonFocuses || []).slice(-16),
      inputs: (window.__qualityCommonInputs || []).slice(-16),
    };
  });
}
async function main() {
  const o = args(process.argv.slice(2)), dir = outputDir(o.out, 'search-workflows');
  // This lease is acquired only when the parent intentionally RUNS this draft.
  const release = acquireSlot();
  const result = {
    schema: 1, suite: 'search-workflows', startedAt: new Date().toISOString(),
    scope: 'body/toolbar/cell search entry, query, Escape return, source edit and Undo/Redo',
    transport: 'renderer-CDP keys and mouse; native menu accelerators not covered',
    clipboard: { touched: false }, cases: [], errors: [],
    probe:{file:'tools/quality/search-workflows.cjs',sha256:digest(fs.readFileSync(__filename))},
    limitations: [
      'No OS menu was clicked by this draft.',
      'Native INPUT caret geometry is not measured. Search screenshots have caret:null; 2x is field-box context.',
      'CM source selection is recorded separately and is never represented as the focused search-input caret.',
    ],
  };
  const record = recorder(dir, result), filter = process.env.MP_QUALITY_CASES;
  const included = id => !filter || new RegExp(filter).test(id);
  // A selected cell arm always includes its two controls.
  const wantsCell = included(ids.cell);
  const test = async (id, body, force = false) => {
    if (!included(id) && !force) return;
    await record(id, body);
    const entry=result.cases.at(-1);
    if(entry.status==='fail' && /ENTRY_NOT_CONFIRMED/.test(entry.error||''))entry.status='entry-unconfirmed';
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  };
  let run, bodyControl = false, toolbarControl = false;
  try {
    const owner = path.join(dir, 'owner.md');
    fs.writeFileSync(owner, 'Owned common workflow probe\n');
    run = await launch(o, owner, dir);
    result.artifact = run.metadata;
    const fresh = async (name, initial) => {
      const file = path.join(dir, name + '.md');
      fs.writeFileSync(file, initial);
      const p = await newWindow(run, run.page, file);
      p.on('pageerror', e => result.errors.push({ page: name, error: e.message }));
      await p.bringToFront();
      await p.evaluate(() => {
        window.__qualityCommonKeys = [];
        window.__qualityCommonClicks = [];
        window.__qualityCommonMenus = [];
        window.__qualityCommonFocuses = [];
        window.__qualityCommonInputs = [];
        document.addEventListener('beforeinput', e => {
          const v=window.mpEngine._view(), sel=v.state.selection.main;
          window.__qualityCommonInputs.push({trusted:e.isTrusted,at:performance.now(),type:e.inputType,data:e.data,
            target:{tag:e.target?.tagName,class:e.target?.className},sourceSelection:{anchor:sel.anchor,head:sel.head}});
        },{capture:true});
        document.addEventListener('focus', e => window.__qualityCommonFocuses.push({
          trusted:e.isTrusted,at:performance.now(),
          target:{tag:e.target?.tagName,class:e.target?.className,name:e.target?.getAttribute('name')},
          related:{tag:e.relatedTarget?.tagName,class:e.relatedTarget?.className,name:e.relatedTarget?.getAttribute('name'),inSearch:!!e.relatedTarget?.closest?.('.cm-search')},
        }),{capture:true});
        document.addEventListener('keydown', e => {
          window.__qualityCommonKeys.push({
            key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey,
            alt: e.altKey, shift: e.shiftKey, trusted: e.isTrusted,
            target: { tag: e.target?.tagName, class: e.target?.className }, at: performance.now(),
          });
        }, { capture: true });
        document.addEventListener('click', e => {
          const button = e.target?.closest?.('[data-mp-id]');
          window.__qualityCommonClicks.push({
            trusted: e.isTrusted, action: button?.dataset.mpId || null,
            target: { tag: e.target?.tagName, class: e.target?.className }, at: performance.now(),
          });
        }, { capture: true });
        // Passive observation only: the product's existing host consumer still runs.
        window.mpHost.onMenu(cmd => window.__qualityCommonMenus.push({ cmd, at: performance.now() }));
        window.mpEngine.focus();
      });
      const s = await state(p);
      assert(s.editorFocus, 'fresh actual document editor focus');
      assert.equal(s.text, initial, 'fresh complete document');
      return { p, file };
    };
    const capture = async (p, file, trace, name) => {
      const s = await state(p);
      const channel = s.cell.focus ? 'cell-dom' : s.search.focus ? 'search-input' : s.editorFocus ? 'cm-source' : 'unfocused';
      const entry = { name, ...s, fixtureFile: file, focusChannel: channel, diskText: fs.readFileSync(file, 'utf8') };
      trace.push(entry);
      entry.screenshot = await frame(p, dir, name,
        channel === 'cm-source' ? {} : { caret: 'dom', allowMissingCaret: true });
      if (channel === 'search-input') {
        assert.equal(entry.screenshot.caret, null, 'search INPUT must not borrow a CM/DOM cell caret');
        entry.screenshot.caretKind = null;
        entry.screenshot.caretLimitation = 'native INPUT caret not measured; source selection is separate';
        const viewport = p.viewportSize() || await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const r = s.search.rect, width = Math.min(360, viewport.width), height = Math.min(100, viewport.height);
        if (r && r.width > 0 && r.height > 0) {
          const clip = {
            x: Math.max(0, Math.min(r.left - 20, viewport.width - width)),
            y: Math.max(0, Math.min(r.top - 20, viewport.height - height)),
            width, height, scale: 2,
          };
          const cdp = await p.context().newCDPSession(p);
          let bytes;
          try {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
            bytes = Buffer.from(shot.data, 'base64');
          } finally { await cdp.detach(); }
          // Keep the standard full/2x filenames while explicitly marking this as context.
          fs.writeFileSync(path.join(dir, entry.screenshot.zoom.file), bytes);
          entry.screenshot.zoom = {
            file: entry.screenshot.zoom.file, sha256: digest(bytes), clip,
            contextKind: 'focused-search-field-box-not-caret', inputRect: r,
          };
        }
      }
      return s;
    };
    const trustedControlKey = (s, key, after = 0) => s.keys.some(e =>
      e.at >= after && e.trusted && e.ctrl && !e.meta && !e.alt && !e.shift &&
      e.key.toLowerCase() === key && e.code === 'Key' + key.toUpperCase());
    const settleText = async (p, expected, label) => {
      await waitUntil(async () => (await state(p)).text === expected, label, 3000);
    };
    const settleDisk = (file, expected) => waitUntil(() => fs.readFileSync(file, 'utf8') === expected, 'complete expected bytes saved', 6000);
    const table = 'PRE_GUARD\n\n|H|K|\n|---|---|\n|ab|KEEP|\n\nPOST_GUARD\n';
    const searchArm = async (kind, trace, arm = {}) => {
      const initial = arm.initial || table, query = arm.query || 'KEEP';
      const name = arm.name || kind;
      const { p, file } = await fresh('search-' + name, initial);
      if (kind === 'cell') {
        await sleep(900);
        const target = p.locator('.mp-row td[data-mp-row]').first();
        trace.push({ name: 'actual-cell-target', cell: await target.evaluate(el => ({ text: el.textContent, row: el.dataset.mpRow, col: el.dataset.mpCol })) });
        await target.click({ delay: 65 });
        await waitUntil(async () => (await state(p)).cell.focus, 'actual cell overlay focus');
        assert.equal((await state(p)).cell.text, 'ab');
        await p.keyboard.press('Home');
        await p.keyboard.press('ArrowRight');
        const cell = await state(p);
        assert(cell.cell.focus && cell.cell.headInCell && cell.cell.anchorInCell, 'real DOM cell selection and focus');
        assert.equal(cell.cell.head, 1);
        assert.equal(cell.text, initial);
      }
      const before = await capture(p, file, trace, 'search-' + name + '-01-before');
      assert.equal(before.text, initial);
      if (kind === 'cell') assert(before.cell.focus, 'CtrlF begins in actual active cell');
      else assert(before.editorFocus, 'positive control starts in actual editor');
      const inputStart = await p.evaluate(() => performance.now());
      if (kind === 'toolbar') {
        await p.locator('.mp-toolbar [data-mp-id="find-replace"]').click({ delay: 65 });
      } else {
        await p.keyboard.press('Control+f');
      }
      let opened = false;
      try {
        await waitUntil(async () => (await state(p)).search.focus, 'actual search INPUT focus', 2000);
        opened = true;
      } catch { /* Do not type a query into the unchanged cell/editor. */ }
      const after = await capture(p, file, trace, 'search-' + name + '-02-after');
      if (kind === 'toolbar') {
        assert(after.clicks.some(e => e.at >= inputStart && e.trusted && e.action === 'find-replace'), 'trusted actual find-replace toolbar click');
      } else {
        assert(trustedControlKey(after, 'f', inputStart), 'trusted CtrlF with physical KeyF reaches the intended page');
      }
      assert.equal(after.text, initial, 'opening search must not change the complete source');
      trace.push({
        name: 'search-entry-gate', kind, opened, searchFocus: after.search.focus,
        queryTyped: false, stoppedBeforeQuery: !opened || !after.search.focus,
        controls: kind === 'cell' ? { body: bodyControl, toolbar: toolbarControl } : null,
      });
      // These assertions are the final actions: never enter query text on a failed focus gate.
      assert(opened && after.search.exists && after.search.focus, 'CtrlF or toolbar must open and focus the actual search input before any query');
      await settleDisk(file, initial);
      if (kind === 'cell') assert(bodyControl && toolbarControl, 'active-cell diagnosis requires both independent positive controls');
      await p.keyboard.press('Control+a');
      // The stock search panel commits on real keyup/change. insertText alone
      // has no keyup; use actual typed keys before testing the first Enter.
      await p.keyboard.type(query,{delay:45});
      const queried=await capture(p,file,trace,'search-'+name+'-03-query');
      assert(queried.search.focus && queried.search.value===query,'query goes into the actual search INPUT');
      assert.equal(queried.text,initial,'typing a query does not edit Markdown');
      const enterStart=await p.evaluate(()=>performance.now());
      await p.keyboard.press('Enter');
      const matchFrom=initial.indexOf(query), matchTo=matchFrom+query.length;
      let matched=false;
      try{await waitUntil(async()=>{const s=await state(p);return Math.min(s.sourceSelection.anchor,s.sourceSelection.head)===matchFrom && Math.max(s.sourceSelection.anchor,s.sourceSelection.head)===matchTo;},'Enter locates exact source token');matched=true;}
      catch{/* Capture actual final source, query, focus and input before verdict. */}
      const found=await capture(p,file,trace,'search-'+name+'-04-found');
      assert(found.keys.some(e=>e.at>=enterStart&&e.trusted&&e.key==='Enter'&&e.target.tag==='INPUT'),'ENTRY_NOT_CONFIRMED: real Enter reached the search INPUT');
      assert(matched,'Enter in the focused query must select the exact source token');
      await p.keyboard.press('Escape');
      if (!arm.immediate) await waitUntil(async()=>{const s=await state(p);return !s.search.exists && (s.editorFocus||s.cell.focus);},'Escape closes search and returns the actual document editing surface');
      if (arm.guard) {
        const resumed=await capture(p,file,trace,'search-'+name+'-05-returned');
        assert(resumed.editorFocus && !resumed.cell.focus,'a non-cell source range keeps native editor ownership');
        assert.deepEqual(resumed.sourceSelection,found.sourceSelection,'owner guard preserves the entire source range');
        assert.equal(resumed.text,initial,'owner guard preserves complete Markdown');
        await settleDisk(file,initial);
        return {kind,query,opened:true,guard:arm.guard,continuedEditCovered:false};
      }
      if (!arm.replace) await p.keyboard.press('ArrowRight');
      const from=arm.replace?matchFrom:matchTo;
      const expected=initial.slice(0,from)+'R'+initial.slice(matchTo);
      // The overlay's native Right updates DOM selection. The next beforeinput
      // mirrors that selection to source; do not repair or require a premature mirror.
      if (!arm.immediate) {
      const resumed=await capture(p,file,trace,'search-'+name+'-05-returned');
      if(resumed.cell.focus) {
        const prefix=arm.visiblePrefix||'';
        assert(resumed.cell.anchorInCell&&resumed.cell.headInCell,'returned owner has a real DOM selection in the cell');
        assert.deepEqual({anchor:resumed.cell.textAnchor,head:resumed.cell.textHead},
          {anchor:prefix.length+(arm.replace?0:query.length),head:prefix.length+query.length},'actual cell selection represents the found range or its real Right collapse');
      } else {
        assert(resumed.editorFocus,'continued typing starts in an actual editing surface');
        assert.deepEqual(resumed.sourceSelection,arm.replace?found.sourceSelection:{anchor:matchTo,head:matchTo},'native result selection or real Right collapse');
      }
      }
      // The immediate arm has no read, frame, wait, synthetic focus or
      // selection dispatch between Escape, Right and the actual R input.
      await p.keyboard.insertText('R');
      const edited=await capture(p,file,trace,'search-'+name+'-06-edited');
      assert.equal(edited.text,expected,'return-to-edit changes only the matched cell token');
      if (arm.immediate) assert(edited.inputs.some(e=>e.trusted && e.data==='R' && e.target.class==='mp-cell-overlay-text'),
        'immediate trusted input reached the actual returned cell owner');
      await p.keyboard.press('Control+z');
      const undone=await capture(p,file,trace,'search-'+name+'-07-undo');
      assert.equal(undone.text,initial,'one source Undo restores exact pre-search source');
      await p.keyboard.press('Control+y');
      const redone=await capture(p,file,trace,'search-'+name+'-08-redo');
      assert.equal(redone.text,expected,'native renderer Redo restores only the continued edit');
      assert((undone.editorFocus||undone.cell.focus) && (redone.editorFocus||redone.cell.focus),'history preserves actual editing surface focus');
      await settleDisk(file,expected);
      if (arm.closeCell) {
        assert(redone.cell.focus,'Escape control begins in the actual returned cell');
        await p.keyboard.press('Escape');
        await sleep(80);
        const closed=await capture(p,file,trace,'search-'+name+'-09-cell-escape');
        assert(closed.editorFocus && !closed.cell.focus && !closed.cell.visible,'cell Escape closes the overlay without a delayed reopen');
        assert.equal(closed.text,expected,'cell Escape keeps the full source unchanged');
      }
      return {kind,query,opened:true,queryTyped:true,sourceUnchangedDuringSearch:true,returnAndHistory:true,replace:!!arm.replace,expected,caretGeometry:'actual focused editing surface; INPUT caret not measured'};
    };
    await test(ids.body, async trace => { const detail = await searchArm('body', trace); bodyControl = true; return detail; }, wantsCell);
    await test(ids.toolbar, async trace => { const detail = await searchArm('toolbar', trace); toolbarControl = true; return detail; }, wantsCell);
    await test(ids.cell, trace => searchArm('cell', trace));
    await test(ids.replace, trace => searchArm('body',trace,{name:'direct-replace',replace:true}));
    await test(ids.encoded, trace => searchArm('body',trace,{name:'encoded',initial:'PRE_GUARD\n\n|H|K|\n|---|---|\n|a\\|b😀 $x+y$ KEEP|TAIL|\n\nPOST_GUARD\n',visiblePrefix:'a|b😀 $x+y$ ',closeCell:true}));
    await test(ids.ordinary, trace => searchArm('body',trace,{name:'ordinary',query:'POST_GUARD'}));
    await test(ids.cross, trace => searchArm('body',trace,{name:'cross',query:'H|K',guard:'cross-cell'}));
    await test(ids.separator, trace => searchArm('body',trace,{name:'separator',query:'---',guard:'separator'}));
    await test(ids.escape, trace => searchArm('body',trace,{name:'partial-escape',initial:'PRE_GUARD\n\n|H|K|\n|---|---|\n|a\\|b😀 $x+y$ KEEP|TAIL|\n\nPOST_GUARD\n',query:'\\',guard:'non-roundtripping-escape-endpoint'}));
    await test(ids.immediate, trace => searchArm('body',trace,{name:'immediate',immediate:true}));
  } catch (e) {
    result.fatal = e.message;
    throw e;
  } finally {
    try { if (run) result.cleanup = await run.cleanup(); }
    catch (e) { result.cleanupError = e.message; throw e; }
    finally {
      release();
      result.finishedAt = new Date().toISOString();
      result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') &&
        !!result.cleanup && !result.cleanup.residual?.length && result.errors.length === 0 &&
        !result.fatal && !result.cleanupError;
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    }
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
