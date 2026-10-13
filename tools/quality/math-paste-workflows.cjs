'use strict';
// Real renderer-CDP input, source/history/disk assertions and full/2x frames.
// Use --exe <MarkPilot.exe> --expected-sha256 <hash> --out <empty owned dir>.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const quality = name => require(path.join(root, 'tools/quality', name));
const { args, launch, acquireSlot, sleep, sha256 } = quality('lifecycle.cjs');
const { outputDir, snapshot, frame, recorder, waitUntil, newWindow } = quality('harness.cjs');
const clipboard = quality('clipboard.cjs');

async function main() {
  const options = args(process.argv.slice(2));
  const dir = outputDir(options.out, 'math-paste-workflows');
  const release = acquireSlot();
  const result = {
    schema: 1, suite: 'math-paste-workflows', kind: 'actual-ui-probe',
    startedAt: new Date().toISOString(), cases: [], errors: [],
    transport: { keyboard: 'renderer-CDP', mouse: 'renderer-CDP', clipboard: 'host writes actual OS clipboard; separate Windows STA readback', electronAcceleratorVerified: false },
    source: Object.fromEntries(['main.js', 'extras.js'].map(file => [file, sha256(path.join(root, 'dsh-markpilot/src-cm6', file))]))
  };
  result.probe={file:'tools/quality/math-paste-workflows.cjs',sha256:sha256(__filename)};
  const record = recorder(dir, result), filter = process.env.MP_QUALITY_CASES;
  const test = async (id, body) => {
    if (filter && !new RegExp(filter).test(id)) return;
    await record(id, body);
    const entry = result.cases.at(-1);
    // The shared recorder catches failures. Distinguish an unproved action
    // from a source/history failure after the intended entry was established.
    if (entry.status === 'fail' && !entry.entryConfirmed) entry.status = 'entry-unconfirmed';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  };
  let run, clip;
  try {
    const owner = path.join(dir, 'owner.md');
    fs.writeFileSync(owner, 'Inline rich paste probe\n');
    run = await launch(options, owner, dir);
    result.artifact = run.metadata;
    clip = await clipboard.hold();
    const inlineInitial = 'PRE $x+y$ POST\nTAIL\n', html = '<p>Q</p>';
    const arms = [
      { name: 'html-ordinary', key: 'Control+v', payload: { text: 'Q', html } },
      { name: 'html-plain-shortcut', key: 'Control+Shift+V', payload: { text: 'Q', html } },
      { name: 'text-only', key: 'Control+v', payload: { text: 'Q' } },
      { name:'html-bold-collapsed',key:'Control+v',collapsed:true,payload:{text:'Q',html:'<p><strong>Q</strong></p>'} },
      { name:'block-multiline-literal',key:'Control+v',kind:'block',initial:'TOP\n$$\nx+y\n$$\nEND\n',payload:{text:'Q\nR\n',html:'<p>Q</p><p>R</p>'} },
      { name:'html-only',key:'Control+v',literal:'Q',payload:{text:'',html:'<p>Q</p>'} },
      { name:'html-only-literal-whitespace',key:'Control+v',literal:'  Q\nR  \n',payload:{text:'',html:'<pre>  Q\nR  \n</pre>'} },
      { name:'quoted-block-emphasis',key:'Control+v',kind:'block',initial:'TOP\n> $$\n> x+y\n> $$\nEND\n',payload:{text:'Q',html:'<p><em>Q</em></p>'} },
      { name:'cross-formula-rich',key:'Control+v',cross:true,glyph:'b',initial:'PRE $x+y$ MID $a+b$ POST\nTAIL\n',literal:'**Q**\n',payload:{text:'Q',html:'<p><strong>Q</strong></p>'} },
    ];
    const checkClipboard = arm => {
      const text = clipboard.verifyText(arm.payload.text), htmlCheck = clipboard.verifyHtml(arm.payload.html || '');
      return { text, html: htmlCheck, expectedHTML: !!arm.payload.html,
        matches: text.matches && (arm.payload.html ? htmlCheck.matches : htmlCheck.length === 0) };
    };
    const capture = async (p, trace, name) => {
      const state = await snapshot(p);
      const entry = { name, ...state,
        keys: await p.evaluate(() => (window.__qualityInlineRich?.keys || []).slice(-10)) };
      trace.push(entry);
      entry.screenshot = await frame(p, dir, name, { allowMissingCaret: true });
      return entry;
    };
    for (const arm of arms) await test(arm.name + '-replace-inline-y-history-continue', async trace => {
      const initial=arm.initial||inlineInitial,targetGlyph=arm.glyph||'y';
      const tokenFrom=initial.indexOf(targetGlyph),to=tokenFrom+1;
      const from=arm.cross?0:arm.collapsed?to:tokenFrom;
      const literal=arm.literal??arm.payload.text;
      const expected=initial.slice(0,from)+literal+initial.slice(arm.collapsed?from:to);
      const continuedExpected=initial.slice(0,from)+literal+'R'+initial.slice(arm.collapsed?from:to);
      const entry = result.cases.at(-1);
      entry.entryConfirmed = false; entry.stage = 'fixture';
      entry.entryTransport = 'renderer-CDP'; entry.electronAcceleratorVerified = false;
      const file = path.join(dir, arm.name + '.md');
      fs.writeFileSync(file, initial);
      const p = await newWindow(run, run.page, file);
      p.on('pageerror', e => result.errors.push({ case: arm.name, message: e.message }));
      await p.bringToFront();
      await waitUntil(async () => { const s = await snapshot(p); return s.text === initial && s.focus; }, 'actual boot focus and independent fixture');
      await p.evaluate(expectedPayload => {
        window.__qualityInlineRich = { keys: [], paste: null };
        document.addEventListener('keydown', e => window.__qualityInlineRich.keys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, trusted: e.isTrusted }), { capture: true });
        document.addEventListener('paste', e => {
          const cd = e.clipboardData, plain = cd?.getData('text/plain') || '', rich = cd?.getData('text/html') || '';
          window.__qualityInlineRich.paste = {
            trusted: e.isTrusted, defaultPreventedAtCapture: e.defaultPrevented,
            types: [...(cd?.types || [])], plainMatches: plain === expectedPayload.text, plainLength: plain.length,
            htmlHasFixture: !!expectedPayload.html && rich.includes(expectedPayload.html), htmlLength: rich.length,
            // Every payload here is an owned synthetic fixture. Never record
            // an unrelated user's clipboard or the held original clipboard.
            syntheticHTMLCarrier: rich,
            carrierBodyText: rich ? new DOMParser().parseFromString(rich,'text/html').body.textContent : '',
            targetInEditor: window.mpEngine._view().contentDOM.contains(e.target)
          };
        }, { capture: true, once: true });
      },arm.payload);
      await p.keyboard.press('Control+Home');
      entry.stage = 'glyph-selection';
      const selector=arm.kind==='block'?'.mp-cm6-math-block':'.mp-cm6-math';
      await waitUntil(() => p.locator('.cm-content '+selector+' .katex-html [data-typora-source-start]').count(), 'rendered mapped formula');
      const glyph = await p.evaluate(({selector,targetGlyph}) => {
        const el = [...document.querySelectorAll('.cm-content '+selector+' .katex-html [data-typora-source-start]')].find(e => e.textContent === targetGlyph && e.getBoundingClientRect().width > 0);
        if (!el) return null; const r = el.getBoundingClientRect();
        return { text: el.textContent, x: r.left + r.width * .8, y: r.top + r.height / 2,
          start: el.getAttribute('data-typora-source-start'), end: el.getAttribute('data-typora-source-end') };
      },{selector,targetGlyph});
      assert(glyph, 'ENTRY_UNCONFIRMED: visible mapped y glyph');
      trace.push({ name: 'glyph-target', glyph });
      await capture(p, trace, arm.name + '-01-rendered');
      if(arm.cross)await p.keyboard.down('Shift');
      await p.mouse.click(glyph.x, glyph.y, { delay: 65 });
      if(arm.cross)await p.keyboard.up('Shift');
      await sleep(150);
      const clicked = await capture(p, trace, arm.name + '-02-clicked');
      assert(clicked.focus && clicked.text === initial, 'ENTRY_UNCONFIRMED: actual glyph click preserves source and focus');
      assert.deepEqual(clicked.selection, arm.cross?{anchor:0,head:to}:{anchor:to,head:to}, 'ENTRY_UNCONFIRMED: actual mapped glyph endpoint and anchor');
      if(!arm.cross&&!arm.collapsed)await p.keyboard.press('Shift+ArrowLeft');
      const selected = await capture(p, trace, arm.name + '-03-selected');
      assert(selected.focus && selected.text === initial, 'ENTRY_UNCONFIRMED: actual selected editor focus');
      assert.deepEqual(selected.selection, arm.cross?{anchor:0,head:to}:arm.collapsed?{anchor:to,head:to}:{anchor:to,head:tokenFrom}, 'ENTRY_UNCONFIRMED: actual intended source range');

      entry.stage = 'clipboard-and-paste-entry';
      const written = await p.evaluate(payload => window.mpHost.writeClipboard(payload), arm.payload);
      const beforeClipboard = checkClipboard(arm);
      trace.push({ name: 'clipboard-before', key: arm.key, fixturePayload: arm.payload, written, ...beforeClipboard });
      assert(written?.ok && beforeClipboard.matches, 'ENTRY_UNCONFIRMED: actual OS clipboard text/HTML readback');
      await p.keyboard.press(arm.key);
      // A missing paste is an unconfirmed shortcut entry, never product-red.
      let observed = true;
      try { await waitUntil(() => p.evaluate(() => !!window.__qualityInlineRich.paste), 'trusted renderer paste entry', 2500); }
      catch { observed = false; }
      await sleep(150);
      const pasted = await capture(p, trace, arm.name + '-04-pasted');
      const evidence = await p.evaluate(() => window.__qualityInlineRich);
      const afterClipboard = checkClipboard(arm);
      trace.push({ name: 'paste-entry-and-clipboard-after', ...evidence, clipboard: afterClipboard });
      const shortcut = evidence.keys.some(k => k.trusted && k.ctrl && k.key.toLowerCase() === 'v' && k.shift === arm.key.includes('Shift'));
      const paste = evidence.paste;
      // CtrlShiftV may expose only text in its DOM paste event; the independent
      // STA readbacks still prove the two HTML arms used the same actual carrier.
      assert(observed && shortcut && paste?.trusted && paste.targetInEditor && paste.plainMatches && afterClipboard.matches,
        'ENTRY_UNCONFIRMED: intended renderer shortcut/paste payload and retained real clipboard');
      if (arm.payload.html && !arm.key.includes('Shift')) assert(paste.htmlHasFixture && paste.types.includes('text/html'), 'ENTRY_UNCONFIRMED: ordinary paste delivered the actual HTML fixture');
      if (arm.name === 'text-only') assert(paste.htmlLength === 0 && !paste.types.includes('text/html'), 'ENTRY_UNCONFIRMED: text-only paste actually has no HTML');
      entry.entryConfirmed = true; entry.stage = 'history-and-continued-edit';
      await p.keyboard.press('Control+z'); await sleep(150);
      const undone = await capture(p, trace, arm.name + '-05-undo');
      await p.keyboard.press('Control+y'); await sleep(150);
      const redone = await capture(p, trace, arm.name + '-06-redo');
      // Respect native redo: fold a nonempty restored selection using a real
      // Right key; a collapsed caret requires no extra horizontal movement.
      const foldedRedo = redone.selection.anchor !== redone.selection.head;
      if (foldedRedo) await p.keyboard.press('ArrowRight');
      const continuation = await capture(p, trace, arm.name + '-07-before-continue');
      await p.keyboard.insertText('R'); await sleep(150);
      const continued = await capture(p, trace, arm.name + '-08-continued');
      // Collect bad-source + Undo/Redo + continued-input evidence before verdict.
      assert.equal(pasted.text, expected, 'paste preserves the complete intended literal source or ordinary cross-formula rich conversion');
      assert.equal(undone.text, initial, 'one native CM Undo restores exact initial source');
      assert.equal(redone.text, expected, 'one native CM Redo restores exact replacement');
      assert.deepEqual(continuation.selection, { anchor: from + literal.length, head: from + literal.length }, 'native redo/collapse leaves the actual caret at the pasted source endpoint');
      assert.equal(continued.text, continuedExpected, 'continued R edits after Q, keeping PRE/POST/TAIL and both delimiters exact');
      assert(pasted.focus && undone.focus && redone.focus && continuation.focus && continued.focus, 'real editor retains focus through the complete chain');
      assert(continued.screenshot.caret, 'continued edit has a measurable actual editor caret');
      await waitUntil(() => fs.readFileSync(file, 'utf8') === continuedExpected, 'final exact source autosaved');
      entry.stage = 'complete';
      return { key: arm.key, tokenFrom,from,to,literal,collapsed:!!arm.collapsed,crossFormula:!!arm.cross,expectedSource: expected, continuedExpected, foldedRedo,
        entryConfirmed: true, electronAcceleratorVerified: false, undoRedo: 'CM commands through renderer keys' };
    });
  } finally {
    try { if (clip) result.clipboard = await clip.restore(); }
    finally { try { if (run) result.cleanup = await run.cleanup(); } finally { release(); } }
    result.finishedAt = new Date().toISOString();
    result.entryUnconfirmed = result.cases.filter(c => c.status === 'entry-unconfirmed').map(c => c.id);
    result.productFailures = result.cases.filter(c => c.status === 'fail' && c.entryConfirmed).map(c => c.id);
    result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') && !result.cleanup?.residual?.length && !result.errors.length;
    result.verdict = result.entryUnconfirmed.length ? 'incomplete-entry-unconfirmed' : result.passed ? 'renderer-CDP-chain-pass' : 'chain-or-suite-failure';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
