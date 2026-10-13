'use strict';
// Real renderer-CDP input, source/history/disk assertions and full/2x frames.
// Use --exe <MarkPilot.exe> --expected-sha256 <hash> --out <empty owned dir>.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const quality = name => require(path.join(root, 'tools', 'quality', name));
const { args, launch, acquireSlot, sha256 } = quality('lifecycle.cjs');
const { outputDir, snapshot, frame, recorder, waitUntil, newWindow } = quality('harness.cjs');
const clipboard = quality('clipboard.cjs');

async function main() {
  const options = args(process.argv.slice(2));
  const dir = outputDir(options.out, 'math-entry-workflows');
  const release = acquireSlot();
  const result = {
    schema: 1, suite: 'math-entry-workflows', kind: 'actual-ui-probe',
    startedAt: new Date().toISOString(), cases: [], errors: [],
    coverage: 'Mapped block source entry in both directions, immediate input, native history, return to the preceding line and exact saved source.',
    source: { file: 'dsh-markpilot/src-cm6/main.js', sha256: sha256(path.join(root, 'dsh-markpilot/src-cm6/main.js')) }
  };
  result.probe={file:'tools/quality/math-entry-workflows.cjs',sha256:sha256(__filename)};
  const record = recorder(dir, result);
  const filter = process.env.MP_QUALITY_CASES;
  const test = async (id, body) => {
    if(filter && !new RegExp(filter).test(id))return;
    await record(id,body);
    const c=result.cases.at(-1);
    if(c.status==='fail' && /ENTRY_UNCONFIRMED/.test(c.error||''))c.status='entry-unconfirmed';
  };
  let run, clip;
  try {
    const owner = path.join(dir, 'owner.md');
    fs.writeFileSync(owner, 'Next math chain probe\n');
    run = await launch(options, owner, dir);
    result.artifact = run.metadata;
    // Use the established restoration contract. No test clipboard payload is
    // written, no clipboard contents are logged, and no copy/paste is simulated.
    clip = await clipboard.hold();
    const fresh = async (name, initial) => {
      const file = path.join(dir, name + '.md');
      fs.writeFileSync(file, initial);
      const p = await newWindow(run, run.page, file);
      p.on('pageerror', e => result.errors.push({ case: name, message: e.message }));
      await p.bringToFront();
      await waitUntil(async () => {
        const state = await snapshot(p);
        return state.text === initial && state.focus;
      }, 'loaded fixture and actual boot editor focus');
      await waitUntil(() => p.locator('.cm-content .mp-cm6-math-block .katex').count(), 'rendered block formula');
      // Read-only event evidence: keyup follows the synchronous native keydown
      // command. It records the actual Down landing without an extra CDP read,
      // screenshot, timer, synthetic selection, or focus repair before Z.
      await p.evaluate(() => {
        window.__qualityNextMath = { keys: [], entered: null };
        document.addEventListener('keydown', e => {
          window.__qualityNextMath.keys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, trusted: e.isTrusted });
        }, { capture: true });
        document.addEventListener('keyup', e => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          const v = window.mpEngine._view(), s = v.state.selection.main, ae = document.activeElement;
          window.__qualityNextMath.entered = {
            name: 'after-vertical-key-before-Z', event: { key: e.key, code: e.code, trusted: e.isTrusted },
            text: v.state.doc.toString(), selection: { anchor: s.anchor, head: s.head },
            focus: v.hasFocus && document.hasFocus(), activeElement: { tag: ae?.tagName, class: ae?.className }
          };
        }, { capture: true });
      });
      return { p, file };
    };
    const capture = async (p, trace, name) => {
      const state = await snapshot(p);
      const entry = { name, ...state, keys: await p.evaluate(() => window.__qualityNextMath.keys.slice(-8)) };
      trace.push(entry);
      // Keep failure frames even if a hidden-prefix landing has no measurable
      // caret. The shared frame captures full + caret-2x and labels a missing
      // caret honestly instead of using a fake selection or visual correction.
      entry.screenshot = await frame(p, dir, name, { allowMissingCaret: true });
      return entry;
    };
    const fixtures = [
      ...[['plain', ''], ['quoted', '> '], ['nested-quoted', '> > ']].map(([name,prefix]) => ({
        name,prefix,initial:['TOP','$$','x+y','$$','END'].map(line=>prefix+line).join('\n')+'\n',first:'x+y',last:'x+y'})),
      {name:'quoted-multiline-whitespace',prefix:'> ',initial:'> TOP\n> $$\n>   x+\n> y   \n> $$\n> END\n',first:'x+',last:'y'},
      {name:'quoted-utf16',prefix:'> ',initial:'> TOP\n> $$\n> x+\\text{😀}\n> $$\n> END\n',first:'x+\\text{😀}',last:'x+\\text{😀}'},
      {name:'single-line',prefix:'',initial:'TOP\n$$x+y$$\nEND\n',first:'x+y',last:'x+y'},
      {name:'same-line-edges',prefix:'',initial:'TOP\n$$x+\ny$$\nEND\n',first:'x+',last:'y'},
    ];
    const start = async (p,dir) => {
      if(dir==='down'){await p.keyboard.press('Control+Home');await p.keyboard.press('End');}
      else {await p.keyboard.press('Control+End');await p.keyboard.press('ArrowLeft');await p.keyboard.press('Home');}
    };
    for (const fixture of fixtures) for (const direction of ['down','up']) {
      const {prefix,initial}=fixture,name=fixture.name+'-'+direction;
      await test(fixture.name + '-'+direction+'-immediate-type-undo-redo', async trace => {
        const contentFrom = direction==='down' ? initial.indexOf(fixture.first) : initial.lastIndexOf(fixture.last)+fixture.last.length;
        const expected = initial.slice(0,contentFrom)+'Z'+initial.slice(contentFrom);
        const firstLineTo = initial.indexOf('\n');
        const openingFrom = firstLineTo + 1;
        // This fixture has exactly one LF between the preceding source line
        // and opening fence: it satisfies verticalIntoMath's adjacent-gap gate.
        assert.equal(initial.slice(firstLineTo, openingFrom), '\n');
        const { p, file } = await fresh(name, initial);
        await start(p,direction);
        const before = await capture(p, trace, name + '-01-before');
        assert.equal(before.text, initial, 'fresh fixture source');
        assert(before.focus, 'real editor owns keyboard before entry');
        // Home in a rendered quote lands at its visible text start, after the
        // hidden quote lead. Raw line.from is still used by the engine gap gate.
        const startPosition=direction==='down'?firstLineTo:initial.lastIndexOf('END');
        assert.deepEqual(before.selection, { anchor: startPosition, head: startPosition }, 'ENTRY_UNCONFIRMED: real key navigation reaches the visible preceding source text');

        const entryKey=direction==='down'?'ArrowDown':'ArrowUp';
        await p.keyboard.press(entryKey);
        await p.keyboard.insertText('Z'); // No intervening wait, assertion, frame or reposition.
        const entered = await p.evaluate(() => window.__qualityNextMath.entered);
        trace.push(entered || { name: 'after-down-before-Z', missing: true });
        const edited = await capture(p, trace, name + '-02-edited');
        await p.keyboard.press('Control+z');
        const undone = await capture(p, trace, name + '-03-undo');
        await p.keyboard.press('Control+y');
        const redone = await capture(p, trace, name + '-04-redo');
        // Collect the complete chain before asserting the suspected bad landing,
        // so a failing baseline retains actual source and history evidence.
        assert(entered?.event.trusted && entered.event.key===entryKey, 'real directional keyup recorded');
        assert(entered.focus, 'vertical entry retained actual editor focus');
        assert.equal(entered.text, initial, 'vertical entry itself changed no text');
        assert.deepEqual(entered.selection, { anchor: contentFrom, head: contentFrom }, 'vertical entry lands at the mapped formula token, past quote prefixes and delimiters');
        assert.equal(edited.text, expected, 'only the intended formula token receives Z; quote/fence/newline and neighbors remain exact');
        assert.deepEqual(edited.selection, { anchor: contentFrom + 1, head: contentFrom + 1 }, 'typing ends immediately after Z');
        assert(edited.focus && edited.screenshot.caret, 'actual edited caret and editor focus are visible');
        assert.equal(undone.text, initial, 'one native Undo restores the exact original source');
        assert.equal(redone.text, expected, 'native Redo restores the exact edited source');
        assert(undone.focus && redone.focus, 'history retains the actual editor keyboard focus');
        // Redo may select the inserted range natively; never patch its selection.
        assert(redone.selection.anchor >= contentFrom && redone.selection.anchor <= contentFrom + 1 &&
               redone.selection.head >= contentFrom && redone.selection.head <= contentFrom + 1,
               'native Redo selection remains at the inserted token');
        await waitUntil(() => fs.readFileSync(file, 'utf8') === expected, 'native autosave of the final source');
        // A same-line opening/closing fence must use the same mapped body lines
        // for the reverse exit. No JS selection or focus repair is used here.
        await start(p,direction);
        const restart=await capture(p,trace,name+'-05-restart');
        assert(restart.focus && restart.selection.anchor===restart.selection.head,'real focused restart');
        await p.keyboard.press(entryKey);
        await p.keyboard.press(direction==='down'?'ArrowUp':'ArrowDown');
        const returned=await capture(p,trace,name+'-06-returned');
        assert.deepEqual(returned.selection,restart.selection,'opposite arrow exits from the mapped first/last body line with the original goal');
        assert(returned.focus && returned.screenshot.caret,'reverse exit retains a visible actual editor caret');
        assert.equal(returned.text,expected,'entry and reverse exit do not edit source');
        return { prefix, direction, contentFrom, firstLineTo, openingFrom, adjacentGap: '\n', expectedSource: expected,
          undoRedo: 'native Control+z / Control+y', screenshotStages: ['before', 'edited', 'undo', 'redo'],
          entryEvidence: 'real keyup snapshot; intentionally no entry screenshot before immediate Z' };
      });
    }
  } finally {
    try { if (clip) result.clipboard = await clip.restore(); }
    finally { try { if (run) result.cleanup = await run.cleanup(); } finally { release(); } }
    result.finishedAt = new Date().toISOString();
    result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') &&
      !result.cleanup?.residual?.length && result.errors.length === 0;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
