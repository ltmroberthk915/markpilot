'use strict';
// Real renderer-CDP input, source/history/disk assertions and full/2x frames.
// Use --exe <MarkPilot.exe> --expected-sha256 <hash> --out <empty owned dir>.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const quality = file => require(path.join(root, 'tools/quality', file));
const { args, launch, acquireSlot, sleep, sha256 } = quality('lifecycle.cjs');
const { outputDir, snapshot, frame, recorder, waitUntil, newWindow } = quality('harness.cjs');
const clipboard = quality('clipboard.cjs');
const SEED = 32917, SETTLE_MS = 150, HISTORY_MS = 650, DRAG_STEPS = 16, DRAG_MS = 20;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireEntry = (ok, message) => { if (!ok) throw new Error('ENTRY_UNCONFIRMED: ' + message); };
function diskState(file) {
  try { const bytes = fs.readFileSync(file); return { text: bytes.toString('utf8'), byteLength: bytes.length, sha256: hash(bytes) }; }
  catch (e) { return { readError: e.code || e.message }; }
}
function fixture(kind) {
  if (kind === 'keyboard') {
    let seed = SEED;
    const paragraphs = Array.from({ length: 48 }, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 'Paragraph ' + String(i).padStart(2, '0') + ' value ' + seed + ' with $p_' + i + '+1$ and ordinary words.\n\n';
    }).join('');
    const text = 'MIXED_BEGIN_32917\n\nOrdinary α $x+y$ between words.\n\n$$\na+b\n$$\n\n> Quoted words\n> $$\n> q+r\n> $$\n\n> > Nested words\n> > $$\n> > u+v\n> > $$\n\n' + paragraphs + 'READING_TAIL_32917\n';
    return { text, spans: [
      ['ordinary-inline', '$x+y$', 'x+y'], ['ordinary-block', '$$\na+b\n$$', 'a+b'],
      ['quoted-block', '> $$\n> q+r\n> $$', 'q+r'], ['nested-block', '> > $$\n> > u+v\n> > $$', 'u+v']
    ], anchor: 0, head: text.length, action: 'cut', direction: 'forward' };
  }
  const text = 'OUTER_HEAD_32917\n\nM_BEGIN $x+y$ M_MID $a+b$ M_END\n> Q_BEGIN $q+r$ Q_END\n\nOUTER_TAIL_32917\nPASTE_TARGET';
  return { text, spans: [['ordinary-inline-one', '$x+y$', 'x+y'], ['ordinary-inline-two', '$a+b$', 'a+b'], ['quoted-inline', '$q+r$', 'q+r']],
    anchor: text.indexOf('Q_END') + 'Q_END'.length, head: text.indexOf('M_BEGIN'), action: 'copy', direction: 'reverse' };
}

async function main() {
  const options = args(process.argv.slice(2)), dir = outputDir(options.out, 'next-mixed-selection-chain');
  const release = acquireSlot();
  const result = { schema: 1, suite: 'next-mixed-selection-chain', kind: 'private-actual-ui-draft', seed: SEED,
    startedAt: new Date().toISOString(), cases: [], errors: [], cleanupErrors: [],
    timing: { settleMs: SETTLE_MS, historyMs: HISTORY_MS, dragSteps: DRAG_STEPS, dragStepMs: DRAG_MS },
    transport: 'renderer-CDP; actual clipboard; Electron accelerators and physical OS input unverified',
    sourceMainSha256: sha256(path.join(root, 'dsh-markpilot/src-cm6/main.js')) };
  const record = recorder(dir, result), filter = process.env.MP_QUALITY_CASES;
  let run, clip;
  try {
    const owner = path.join(dir, 'owner.md'); fs.writeFileSync(owner, 'Mixed source chain owner\n');
    run = await launch(options, owner, dir); result.artifact = run.metadata;
    clip = await clipboard.hold();
    const capture = async (p, file, trace, name) => {
      const s = await snapshot(p), evidence = await p.evaluate(() => window.__qualityMixed || null);
      const entry = { name, ...s, disk: diskState(file), evidence };
      trace.push(entry); entry.screenshot = await frame(p, dir, name, { allowMissingCaret: true }); return entry;
    };
    const press = async (p, key) => {
      const before = await p.evaluate(() => window.__qualityMixed.keys.length);
      await p.keyboard.press(key); await sleep(SETTLE_MS);
      const parts = key.split('+'), end = parts.at(-1).toLowerCase();
      const received = await p.evaluate(from => window.__qualityMixed.keys.slice(from), before);
      return received.some(k => k.trusted && k.key.toLowerCase() === end && k.ctrl === parts.includes('Control') && k.shift === parts.includes('Shift'));
    };
    const armClipboard = async (p, trace, name) => {
      const marker = 'QUALITY_MIXED_ARM_' + SEED + '_' + name;
      const ack = await p.evaluate(text => window.mpHost.writeClipboard({ text }), marker);
      const check = clipboard.verifyText(marker); trace.push({ name: 'clipboard-arm-' + name, ack, check });
      requireEntry(ack?.ok && check.matches, 'actual native clipboard arm');
    };
    const observedTransfer = (entry, kind, afterCount) => entry.evidence?.transfers.slice(afterCount).some(e => e.kind === kind && e.trusted && e.targetInEditor);
    for (const kind of ['keyboard', 'mouse']) {
      const id = kind === 'keyboard' ? 'keyboard-page-extend-mixed-cut-replace-history' : 'mouse-reverse-drag-mixed-copy-replace-history';
      if (filter && !new RegExp(filter).test(id)) continue;
      await record(id, async trace => {
        const item = result.cases.at(-1), spec = fixture(kind), initial = spec.text;
        item.stage = 'fixture'; item.productReached = false;
        const known = spec.spans.map(([id, token, tex]) => ({ id, token, tex, from: initial.indexOf(token), to: initial.indexOf(token) + token.length }));
        assert(known.every(s => s.from >= 0 && initial.indexOf(s.token, s.from + 1) < 0), 'fixture tokens are unique');
        const file = path.join(dir, kind + '.md'); fs.writeFileSync(file, initial);
        const p = await newWindow(run, run.page, file); p.on('pageerror', e => result.errors.push({ case: kind, message: e.message }));
        try {
          await p.bringToFront();
          await waitUntil(async () => { const s = await snapshot(p); return s.text === initial && s.focus; }, 'owned fixture boot focus');
          await p.evaluate(() => {
            const v = window.mpEngine._view();
            window.__qualityMixed = { keys: [], pointers: [], transfers: [], inputs: [], scrolls: [], expected: '' };
            const targetInEditor = e => v.contentDOM.contains(e.target);
            document.addEventListener('keydown', e => window.__qualityMixed.keys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, trusted: e.isTrusted, at: performance.now() }), { capture: true });
            for (const type of ['mousedown', 'mousemove', 'mouseup']) document.addEventListener(type, e => {
              if (type === 'mousemove' && !e.buttons) return;
              window.__qualityMixed.pointers.push({ type, trusted: e.isTrusted, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, targetInEditor: targetInEditor(e), at: performance.now() });
            }, { capture: true });
            for (const type of ['copy', 'cut', 'paste']) document.addEventListener(type, e => {
              const cd = e.clipboardData, plain = type === 'paste' ? cd?.getData('text/plain') || '' : '';
              window.__qualityMixed.transfers.push({ kind: type, trusted: e.isTrusted, targetInEditor: targetInEditor(e), types: [...(cd?.types || [])],
                plainIsExpected: type === 'paste' && plain === window.__qualityMixed.expected, plainLength: plain.length, at: performance.now() });
            }, { capture: true });
            for (const type of ['beforeinput', 'input']) document.addEventListener(type, e => window.__qualityMixed.inputs.push({ type, inputType: e.inputType, trusted: e.isTrusted, targetInEditor: targetInEditor(e), at: performance.now() }), { capture: true });
            v.scrollDOM.addEventListener('scroll', e => window.__qualityMixed.scrolls.push({ trusted: e.isTrusted, top: v.scrollDOM.scrollTop, at: performance.now() }), { passive: true });
          });
          requireEntry(await press(p, 'Control+Home'), 'actual initial CtrlHome key');
          await waitUntil(() => p.locator('.cm-content .katex').count(), 'rendered formulas in the owned fixture');
          // The actual renderer uses output:"html", so it has no MathML
          // annotation. These fixtures use simple ASCII expressions: compare
          // their visible glyph text and require the existing source-map attrs.
          const rendered = await p.evaluate(() => [...document.querySelectorAll('.cm-content .katex')].map(el => {
            const r = el.getBoundingClientRect(), html = el.querySelector('.katex-html');
            return { glyphText: (html?.textContent || '').replace(/[\s\u200b]/g, ''), sourceMappedGlyphs: html?.querySelectorAll('[data-typora-source-start]').length || 0, height: r.height, width: r.width };
          }));
          trace.push({ name: 'known-formula-and-render-positive', known, rendered });
          requireEntry(known.every(s => rendered.some(r => r.glyphText === s.tex && r.sourceMappedGlyphs > 0 && r.height > 0 && r.width > 0)), 'known ordinary/quoted formulas actually rendered, not just source tokens');

          // Plain-word copy positive, independent of the formula-crossing slice.
          item.stage = 'plain-copy-positive'; const firstLine = initial.split('\n')[0];
          const selectPositive = await press(p, 'Shift+End');
          const positive = await capture(p, file, trace, kind + '-01-plain-copy-positive');
          requireEntry(selectPositive && positive.focus && positive.selection.anchor === 0 && positive.selection.head === firstLine.length, 'real first-line selection');
          await armClipboard(p, trace, kind + '-positive'); const positiveKey = await press(p, 'Control+c');
          const positiveAfter = await capture(p, file, trace, kind + '-02-plain-copy-after');
          const positiveClipboard = clipboard.verifyText(firstLine); trace.push({ name: 'plain-copy-independent-STA', ...positiveClipboard });
          requireEntry(positiveKey && observedTransfer(positiveAfter, 'copy', positive.evidence.transfers.length) && positiveClipboard.matches, 'plain copy actually overwrote the marker');
          requireEntry(await press(p, 'Control+Home'), 'real return to document start');

          item.stage = 'formula-crossing-selection';
          if (kind === 'keyboard') {
            const downKey = await press(p, 'PageDown'); const down = await capture(p, file, trace, kind + '-03-page-down');
            const upKey = await press(p, 'PageUp'); const up = await capture(p, file, trace, kind + '-04-page-up');
            requireEntry(downKey && upKey && down.focus && up.focus && down.selection.head > 0 && down.scrollTop > 0 &&
              up.selection.head < down.selection.head && up.scrollTop < down.scrollTop && down.evidence.scrolls.length > 0,
              'trusted PageDown/PageUp caused real scroll and reversed source navigation');
            assert.equal(down.text, initial, 'PageDown keeps exact mixed source'); assert.equal(up.text, initial, 'PageUp keeps exact mixed source');
            const home = await press(p, 'Control+Home'), extend = await press(p, 'Control+Shift+End');
            requireEntry(home && extend, 'trusted keyboard extension entry');
          } else {
            const points = await p.evaluate(({ anchor, head }) => {
              const v = window.mpEngine._view();
              return [anchor, head].map(pos => { const c = v.coordsAtPos(pos); return c && { x: c.left + .1, y: (c.top + c.bottom) / 2, top: c.top, bottom: c.bottom, viewport: { width: innerWidth, height: innerHeight } }; });
            }, spec);
            trace.push({ name: 'frozen-real-drag-coordinates', points, steps: DRAG_STEPS, stepMs: DRAG_MS });
            requireEntry(points.every(c => c && c.x >= 0 && c.x < c.viewport.width && c.top >= 0 && c.bottom <= c.viewport.height), 'both plain-text drag endpoints visibly exist');
            const [start, end] = points; await p.mouse.move(start.x, start.y); await p.mouse.down();
            try { for (let n = 1; n <= DRAG_STEPS; n++) { await p.mouse.move(start.x + (end.x - start.x) * n / DRAG_STEPS, start.y + (end.y - start.y) * n / DRAG_STEPS); await sleep(DRAG_MS); } }
            finally { await p.mouse.up(); }
            await sleep(SETTLE_MS);
          }
          const selected = await capture(p, file, trace, kind + '-05-crossing-selected');
          const from = Math.min(selected.selection.anchor, selected.selection.head), to = Math.max(selected.selection.anchor, selected.selection.head);
          const covered = known.filter(s => from <= s.from && to >= s.to).map(s => s.id);
          item.oracle = { direction: spec.direction, required: known.map(s => s.id), covered, intended: { anchor: spec.anchor, head: spec.head }, actual: selected.selection };
          requireEntry(selected.focus && selected.text === initial && selected.selection.anchor === spec.anchor && selected.selection.head === spec.head && covered.length === known.length,
            'actual selection has the fixed direction/endpoints and crosses every independently known formula');
          if (kind === 'mouse') {
            const events = selected.evidence.pointers;
            requireEntry(events.some(e => e.type === 'mousedown' && e.trusted && e.targetInEditor) && events.some(e => e.type === 'mouseup' && e.trusted && e.targetInEditor) &&
              events.filter(e => e.type === 'mousemove' && e.trusted && (e.buttons & 1)).length >= DRAG_STEPS,
              'actual trusted pressed-button drag traversed the fixed path');
          }
          const payload = initial.slice(from, to);
          item.oracle.payloadLength = payload.length; item.oracle.payloadSha256 = hash(Buffer.from(payload));
          await armClipboard(p, trace, kind + '-crossing');
          item.stage = spec.action + '-source';
          const transferKey = await press(p, spec.action === 'cut' ? 'Control+x' : 'Control+c');
          const transferred = await capture(p, file, trace, kind + '-06-' + spec.action);
          const readback = clipboard.verifyText(payload); trace.push({ name: 'crossing-source-independent-STA', ...readback });
          requireEntry(transferKey && observedTransfer(transferred, spec.action, selected.evidence.transfers.length), 'actual trusted source ' + spec.action + ' entry');
          item.productReached = true;
          assert(readback.matches, 'source clipboard exactly matches the proven formula-crossing range');
          const base = spec.action === 'cut' ? initial.slice(0, from) + initial.slice(to) : initial;
          assert.equal(transferred.text, base, 'copy/cut touches only the known source range');
          if (spec.action === 'cut') {
            const undoKey = await press(p, 'Control+z'), cutUndo = await capture(p, file, trace, kind + '-07-cut-undo');
            const redoKey = await press(p, 'Control+y'), cutRedo = await capture(p, file, trace, kind + '-08-cut-redo');
            requireEntry(undoKey && redoKey, 'renderer Undo/Redo keys actually reached the editor');
            assert.equal(cutUndo.text, initial, 'cut Undo restores complete source'); assert.equal(cutRedo.text, base, 'cut Redo restores exact removal');
            await p.keyboard.insertText('PASTE_TARGET'); await sleep(HISTORY_MS);
            const targetCreated = await capture(p, file, trace, kind + '-09-target-created');
            requireEntry(targetCreated.evidence.inputs.some(e => e.trusted && e.targetInEditor && e.inputType === 'insertText'), 'actual renderer insertText created the replacement target');
            assert.equal(targetCreated.text, 'PASTE_TARGET', 'typed target is the complete cut-empty document');
          }
          item.stage = 'replacement-target';
          const beforeReplace = (await snapshot(p)).text, targetFrom = beforeReplace.lastIndexOf('PASTE_TARGET');
          const endKey = await press(p, 'Control+End'), homeKey = await press(p, 'Home'), targetKey = await press(p, 'Shift+End');
          const target = await capture(p, file, trace, kind + '-10-target-selected');
          requireEntry(endKey && homeKey && targetKey && target.focus && targetFrom >= 0 && target.selection.anchor === targetFrom && target.selection.head === targetFrom + 'PASTE_TARGET'.length,
            'real keyboard selected only the fixed replacement marker');
          assert.equal(target.text, beforeReplace, 'target selection changes no source');
          await p.evaluate(text => { window.__qualityMixed.expected = text; }, payload); // diagnostic comparison only
          const beforePaste = clipboard.verifyText(payload); trace.push({ name: 'clipboard-before-paste', ...beforePaste });
          requireEntry(beforePaste.matches, 'actual source payload is still in the clipboard');
          item.stage = 'paste-entry'; const pasteKey = await press(p, 'Control+v');
          const pasted = await capture(p, file, trace, kind + '-11-pasted');
          const pasteEvent = pasted.evidence.transfers.find(e => e.kind === 'paste');
          const afterPaste = clipboard.verifyText(payload); trace.push({ name: 'clipboard-after-paste', ...afterPaste });
          requireEntry(pasteKey && pasteEvent?.trusted && pasteEvent.targetInEditor && pasteEvent.plainIsExpected && afterPaste.matches,
            'trusted actual paste delivered the independently verified source payload');
          const expectedPaste = beforeReplace.slice(0, targetFrom) + payload + beforeReplace.slice(targetFrom + 'PASTE_TARGET'.length);
          item.stage = 'paste-history-continue';
          const undoKey = await press(p, 'Control+z'), undone = await capture(p, file, trace, kind + '-12-paste-undo');
          const redoKey = await press(p, 'Control+y'), redone = await capture(p, file, trace, kind + '-13-paste-redo');
          const continueKey = await press(p, 'Control+End'), beforeContinue = await capture(p, file, trace, kind + '-14-continue-start');
          const continuation = kind === 'keyboard' ? 'CONTINUE_K_32917' : '\nCONTINUE_M_32917';
          const inputStart = beforeContinue.evidence.inputs.length;
          await p.keyboard.insertText(continuation); await sleep(SETTLE_MS);
          const continued = await capture(p, file, trace, kind + '-15-continued');
          requireEntry(undoKey && redoKey && continueKey && continued.evidence.inputs.slice(inputStart).some(e => e.type === 'beforeinput' && e.trusted && e.targetInEditor && e.inputType?.startsWith('insert')),
            'trusted history/navigation keys and real continued input observed');
          // Finish the observable history/edit chain before source verdicts.
          assert.equal(pasted.text, expectedPaste, 'replacement retains every source byte, dollar fence, quote prefix and untouched neighbor');
          assert.equal(undone.text, beforeReplace, 'one paste Undo restores the replacement marker and all neighbors');
          assert.equal(redone.text, expectedPaste, 'paste Redo restores exact source');
          assert.deepEqual(beforeContinue.selection, { anchor: expectedPaste.length, head: expectedPaste.length }, 'real CtrlEnd defines the continued-edit location');
          const final = expectedPaste + continuation;
          assert.equal(continued.text, final, 'continued input edits only the verified document end');
          assert([pasted, undone, redone, beforeContinue, continued].every(s => s.focus), 'editor actually retains focus through the complete chain');
          assert(continued.screenshot.caret, 'measurable caret plus actual focus, not coordinates alone');
          await waitUntil(() => diskState(file).text === final, 'exact final autosave', 5000);
          const saved = diskState(file); trace.push({ name: 'final-independent-disk-readback', ...saved });
          assert.equal(saved.text, final); assert.equal(saved.sha256, hash(Buffer.from(final)), 'UTF-8 disk bytes equal the fixed source oracle');
          item.stage = 'complete';
          return { seed: SEED, direction: spec.direction, action: spec.action, crossedFormulas: covered, payloadLength: payload.length, finalSha256: saved.sha256,
            transport: 'renderer-CDP; accelerators unverified', clipboardSourceExact: true, nativeHistory: true, diskExact: true };
        } catch (e) {
          // Save the actual failing state before the recorder writes the failure.
          try { await capture(p, file, trace, kind + '-failure-' + item.stage); } catch (captureError) { trace.push({ name: 'failure-capture-error', error: captureError.message }); }
          throw e;
        }
      });
      const entry = result.cases.at(-1);
      if (entry.error?.startsWith('ENTRY_UNCONFIRMED:')) entry.status = 'entry-unconfirmed';
      else if (entry.status === 'fail') entry.failureKind = entry.productReached ? 'product-check' : 'harness-or-setup';
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    }
  } finally {
    try { if (clip) result.clipboard = await clip.restore(); } catch (e) { result.cleanupErrors.push('clipboard restore: ' + e.message); }
    try { if (run) result.cleanup = await run.cleanup(); } catch (e) { result.cleanupErrors.push('owned run cleanup: ' + e.message); }
    try { release(); } catch (e) { result.cleanupErrors.push('slot release: ' + e.message); }
    result.finishedAt = new Date().toISOString();
    result.entryUnconfirmed = result.cases.filter(c => c.status === 'entry-unconfirmed').map(c => c.id);
    result.productFailures = result.cases.filter(c => c.failureKind === 'product-check').map(c => c.id);
    result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') && !result.errors.length && !result.cleanupErrors.length && !result.cleanup?.residual?.length;
    result.verdict = result.entryUnconfirmed.length ? 'incomplete-entry-unconfirmed' : result.passed ? 'renderer-chain-pass' : 'chain-or-suite-failure';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
