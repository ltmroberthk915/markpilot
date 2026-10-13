'use strict';
// Mandatory: --exe, --expected-sha256 (EXE), --out (empty).
// Renderer CDP real input; physical OS input/Electron accelerators unverified.
// Only passive event observers and read-only source measurements; no repair.
// Fixed seed and held-wheel path [300,300]; no adaptive retries.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const { args, launch, acquireSlot, sleep, sha256 } = require(path.join(ROOT, 'tools/quality/lifecycle.cjs'));
const { outputDir, snapshot, frame, newWindow, recorder, waitUntil } = require(path.join(ROOT, 'tools/quality/harness.cjs'));
const clipboard = require(path.join(ROOT, 'tools/quality/clipboard.cjs'));
const SEED = 32923, STEPS = 16, STEP_MS = 20, SETTLE = 120;
const WHEELS = [300, 300];
const DEST = 'DEST_SENTINEL_32923', PLAIN_POS = 8;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bounds = r => ({ from: Math.min(r.anchor, r.head), to: Math.max(r.anchor, r.head) });
const entry = (ok, why) => { if (!ok) throw new Error('ENTRY_UNCONFIRMED: ' + why); };
function fixture() {
  const tokens = { A: '$$\na+b\n$$', B: '$$\nu+v\n$$', C: '> $$\n> q+r\n> $$' };
  let text = 'DRAG_BEGIN_32923\n\n' + tokens.A + '\n\n', seed = SEED;
  for (let i = 0; i < 24; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    text += 'P' + String(i).padStart(2, '0') + ' ordinary seed ' + seed + ' words.\n\n';
    if (i === 3) text += tokens.B + '\n\n';
    if (i === 6) text += tokens.C + '\n\n';
  }
  text += DEST + '\n';
  const spans = Object.fromEntries(Object.entries(tokens).map(([id, token]) => {
    const from = text.indexOf(token); assert(from >= 0 && text.indexOf(token, from + 1) < 0, 'unique formula fixture');
    return [id, { token, from, to: from + token.length }];
  }));
  return { text, spans, destFrom: text.indexOf(DEST), sha256: hash(Buffer.from(text)) };
}
function disk(file) {
  try { const bytes = fs.readFileSync(file); return { text: bytes.toString('utf8'), bytes: bytes.length, sha256: hash(bytes) }; }
  catch (e) { return { readError: e.code || e.message }; }
}
async function main() {
  const options = args(process.argv.slice(2));
  if (!options.exe || options.electron || options.app || !options.out || !/^[a-f0-9]{64}$/i.test(options['expected-sha256'] || ''))
    throw new Error('Require --exe <installed EXE> --expected-sha256 <EXE SHA256> --out <empty directory>');
  options['expected-sha256'] = options['expected-sha256'].toLowerCase();
  const dir = outputDir(options.out, 'cross-page-drag-v2'), spec = fixture();
  const result = { schema: 1, suite: 'cross-page-drag-workflows', pathVersion: 2, startedAt: new Date().toISOString(), seed: SEED,
    previousPath: { wheels: [260, 260], probeSha256: 'a3ee52cc7f656cc745a040becca7b74f87a0c7dffe4f6dd53a81d58f39050d9e',
      reason: 'The fixed 600px path avoids a post-formula empty-line endpoint; an ordinary ASCII endpoint remains mandatory.' },
    cases: [], errors: [], cleanupErrors: [], fixture: spec, probeSha256: sha256(__filename),
    sourceMainSha256: sha256(path.join(ROOT, 'dsh-markpilot/src-cm6/main.js')),
    transport: 'renderer-CDP; actual Windows STA clipboard; OS/Electron accelerators unverified',
    timing: { steps: STEPS, stepMs: STEP_MS, wheel: WHEELS, preUpSettleMs: 80 },
    oracle: 'Frozen fixture slice from independently proven pre-up range; known B/C coverage, direction and real events are mandatory.' };
  const record = recorder(dir, result); let run, clip, release;
  const capture = async (p, file, trace, name) => {
    const s = await snapshot(p), observation = await p.evaluate(() => {
      const v = window.mpEngine._view(), line = v.state.doc.lineAt(v.state.selection.main.head);
      return { evidence: window.__crossDrag, line: { from: line.from, to: line.to, text: line.text },
        rangeCount: v.state.selection.ranges.length, viewportHeight: v.scrollDOM.clientHeight };
    });
    const rec = { name, ...s, ...observation, disk: disk(file) }; trace.push(rec);
    rec.screenshot = await frame(p, dir, name, { allowMissingCaret: true }); return rec;
  };
  const press = async (p, key) => {
    const start = await p.evaluate(() => ({ count: window.__crossDrag.keys.length, focus: window.mpEngine._view().hasFocus && document.hasFocus() }));
    entry(start.focus, 'actual editor focus before ' + key);
    await p.keyboard.press(key); await sleep(SETTLE);
    const parts = key.split('+'), received = await p.evaluate(i => window.__crossDrag.keys.slice(i), start.count);
    entry(received.some(e => e.trusted && e.inEditor && e.key.toLowerCase() === parts.at(-1).toLowerCase() &&
      e.ctrl === parts.includes('Control') && e.shift === parts.includes('Shift')), 'trusted key ' + key);
  };
  try {
    release = acquireSlot(ROOT);
    const owner = path.join(dir, 'owner.md'); fs.writeFileSync(owner, 'Cross-page drag owner 32923\n');
    run = await launch(options, owner, dir); result.artifact = run.metadata;
    clip = await clipboard.hold();
    for (const kind of ['plain', 'formula']) {
      if (kind === 'formula' && result.cases[0]?.status !== 'pass') {
        result.cases.push({ id: 'formula-held-wheel-loop', status: 'skipped', reason: 'plain positive did not pass; no main-arm input' }); break;
      }
      await record(kind + '-held-wheel-loop', async trace => {
        const item = result.cases.at(-1); item.stage = 'fresh-window'; item.productReached = false;
        const file = path.join(dir, kind + '.md'); fs.writeFileSync(file, spec.text);
        let p, held = false;
        try {
          p = await newWindow(run, run.page, file); p.on('pageerror', e => result.errors.push({ case: kind, error: e.message }));
          await p.bringToFront();
          await waitUntil(async () => { const s = await snapshot(p); return s.focus && s.text === spec.text; }, 'fresh fixture actual boot focus');
          await p.evaluate(() => {
            const v = window.mpEngine._view(), d = window.__crossDrag = { keys: [], pointers: [], wheels: [], scrolls: [], transfers: [], inputs: [], expected: '' };
            const inEditor = e => v.contentDOM.contains(e.target), sel = () => {
              const r = v.state.selection.main; return { anchor: r.anchor, head: r.head };
            };
            document.addEventListener('keydown', e => d.keys.push({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey,
              trusted: e.isTrusted, inEditor: inEditor(e), at: performance.now() }), { capture: true, passive: true });
            for (const type of ['mousedown', 'mousemove', 'mouseup']) document.addEventListener(type, e => {
              if (type === 'mousemove' && !e.buttons) return;
              d.pointers.push({ type, trusted: e.isTrusted, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, detail: e.detail,
                inEditor: inEditor(e), math: !!e.target.closest?.('.mp-cm6-math, .mp-cm6-math-block'), selection: sel(), at: performance.now() });
            }, { capture: true, passive: true });
            document.addEventListener('wheel', e => d.wheels.push({ trusted: e.isTrusted, buttons: e.buttons,
              deltaY: e.deltaY, inEditor: inEditor(e), at: performance.now() }), { capture: true, passive: true });
            v.scrollDOM.addEventListener('scroll', e => d.scrolls.push({ trusted: e.isTrusted, top: v.scrollDOM.scrollTop, at: performance.now() }), { passive: true });
            for (const type of ['copy', 'paste']) document.addEventListener(type, e => {
              const text = type === 'paste' ? e.clipboardData?.getData('text/plain') || '' : '';
              d.transfers.push({ type, trusted: e.isTrusted, inEditor: inEditor(e), types: [...(e.clipboardData?.types || [])],
                plainMatches: type === 'paste' && text === d.expected, length: text.length, at: performance.now() });
            }, { capture: true, passive: true });
            for (const type of ['beforeinput', 'input']) document.addEventListener(type, e => d.inputs.push({ type,
              inputType: e.inputType, isR: e.data === 'R', trusted: e.isTrusted, inEditor: inEditor(e), focus: v.hasFocus && document.hasFocus(), selection: sel(), at: performance.now() }), { capture: true, passive: true });
          });
          await press(p, 'Control+Home'); item.stage = 'frozen-entry';
          const before = await capture(p, file, trace, kind + '-01-before');
          entry(before.focus && before.rangeCount === 1 && before.selection.head === 0, 'real initial editor position');
          assert.equal(before.text, spec.text); assert.equal(before.disk.sha256, spec.sha256);
          const point = await p.evaluate(({ kind, plainPos }) => {
            const v = window.mpEngine._view(), sc = v.scrollDOM.getBoundingClientRect(); let c, glyph;
            if (kind === 'plain') c = v.coordsAtPos(plainPos);
            else {
              glyph = [...v.contentDOM.querySelectorAll('.mp-cm6-math-block .katex-html [data-typora-source-start]')]
                .find(e => e.textContent === 'a' && e.getBoundingClientRect().width > 0);
              c = glyph?.getBoundingClientRect();
            }
            return c && { x: kind === 'plain' ? c.left + .1 : c.left + c.width / 2, y: (c.top + c.bottom) / 2,
              glyph: glyph?.textContent, sc: { left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom } };
          }, { kind, plainPos: PLAIN_POS });
          entry(point && point.x > point.sc.left && point.x + 20 < point.sc.right && point.y > point.sc.top && point.y + 160 < point.sc.bottom,
            'fixed path remains in the actual editor viewport');
          entry(kind === 'plain' || point.glyph === 'a', 'true rendered A glyph, not already expanded source');
          trace.push({ name: 'frozen-coordinates', start: point, end: { x: point.x + 20, y: point.y + 160 }, seed: SEED });
          item.stage = 'held-gesture'; await p.mouse.move(point.x, point.y); await p.mouse.down({ clickCount: 1 }); held = true;
          for (let i = 1; i <= STEPS; i++) { await p.mouse.move(point.x + 20 * i / STEPS, point.y + 160 * i / STEPS); await sleep(STEP_MS); }
          for (const delta of WHEELS) { await p.mouse.wheel(0, delta); await sleep(60); }
          for (let i = 1; i <= STEPS; i++) { await p.mouse.move(point.x + 20 * (1 - i / STEPS), point.y + 160 * (1 - i / STEPS)); await sleep(STEP_MS); }
          await sleep(80); item.stage = 'pre-up-entry';
          const pre = await capture(p, file, trace, kind + '-02-pre-up'), stable = await snapshot(p);
          // Shared frame only adds/removes a noneditable, pointer-events:none marker.
          // Verify that pre-up evidence did not change text, focus, selection or scroll.
          entry(stable.text === pre.text && stable.focus === pre.focus && stable.scrollTop === pre.scrollTop &&
            stable.selection.anchor === pre.selection.anchor && stable.selection.head === pre.selection.head, 'pre-up evidence is observational and range is stable');
          const ev = pre.evidence, down = ev.pointers.find(e => e.type === 'mousedown'), r = bounds(pre.selection);
          const covered = ['B', 'C'].filter(id => r.from <= spec.spans[id].from && r.to >= spec.spans[id].to);
          // Preserve raw wheel.buttons (v1 measured 0). Holding is independently
          // proven by trusted down, pressed moves on both sides and no early up.
          const pressed = ev.pointers.filter(e => e.type === 'mousemove' && e.trusted && (e.buttons & 1));
          const wheelHeld = e => e.trusted && e.inEditor && e.deltaY === WHEELS[0] && down && down.at < e.at &&
            pressed.some(m => m.at < e.at) && pressed.some(m => m.at > e.at) &&
            !ev.pointers.some(m => m.type === 'mouseup' && m.at >= down.at && m.at <= e.at);
          trace.push({ name: 'transport-gate-components', down: down && { trusted: down.trusted, button: down.button, buttons: down.buttons },
            pressedMoves: pressed.length, maxPressedDistance: down && Math.max(...pressed.map(m => Math.abs(m.x - down.x) + Math.abs(m.y - down.y))),
            rawWheelButtons: ev.wheels.map(e => e.buttons), wheelBetweenPressedMoves: ev.wheels.map(wheelHeld),
            scrollDelta: pre.scrollTop - before.scrollTop, requiredScrollDelta: pre.viewportHeight / 2,
            preUp: pre.selection, covered, line: pre.line, previousSourceUnit: spec.text.charCodeAt(pre.selection.head - 1) });
          entry(down?.trusted && down.button === 0 && (down.buttons & 1) && down.inEditor && !!down.math === (kind === 'formula') && down.detail === 1 &&
            ev.pointers.filter(e => e.type === 'mousemove' && e.trusted && (e.buttons & 1)).length >= STEPS * 2 &&
            ev.pointers.some(e => e.type === 'mousemove' && e.trusted && (e.buttons & 1) && Math.abs(e.x - down.x) + Math.abs(e.y - down.y) >= 160) &&
            ev.wheels.length === WHEELS.length && ev.wheels.every(wheelHeld) &&
            ev.scrolls.some(e => e.trusted) && pre.scrollTop - before.scrollTop >= pre.viewportHeight / 2, 'trusted held cross-page gesture actually occurred');
          assert.equal(pre.text, spec.text, 'gesture never edits fixture source');
          entry(pre.focus && pre.rangeCount === 1 && pre.selection.head > pre.selection.anchor && covered.length === 2 &&
            (kind === 'plain' ? pre.selection.anchor === PLAIN_POS : pre.selection.anchor >= spec.spans.A.from && pre.selection.anchor <= spec.spans.A.to) &&
            pre.selection.head > spec.spans.C.to && /^P\d{2} ordinary /.test(pre.line.text) && pre.selection.head > pre.line.from &&
            /^[\x20-\x7e]$/.test(spec.text[pre.selection.head - 1]), 'forward native range covers B/C and ends inside later ordinary ASCII');
          item.oracle = { preUp: pre.selection, covered, fixtureSha256: spec.sha256 }; item.productReached = true;
          await p.mouse.up({ clickCount: 1 }); held = false; await sleep(SETTLE); item.stage = 'mouseup-fidelity';
          const released = await capture(p, file, trace, kind + '-03-released');
          const up = released.evidence.pointers.find(e => e.type === 'mouseup');
          entry(up?.trusted && up.button === 0 && !(up.buttons & 1) && up.inEditor && up.detail === 1 && Math.abs(up.x - down.x) + Math.abs(up.y - down.y) <= 4, 'actual release returned to fixed screen origin');
          assert.equal(released.text, spec.text); assert(released.focus); assert.deepEqual(released.selection, pre.selection, 'mouseup preserves the established cross-page native range');
          await press(p, 'Shift+ArrowLeft'); item.stage = 'keyboard-shrink';
          const shortened = await capture(p, file, trace, kind + '-04-shortened');
          assert.equal(shortened.text, spec.text); assert(shortened.focus);
          assert.deepEqual(shortened.selection, { anchor: pre.selection.anchor, head: pre.selection.head - 1 }, 'ShiftLeft shrinks one proven ordinary ASCII source unit');
          const sr = bounds(shortened.selection), payload = spec.text.slice(sr.from, sr.to);
          assert(payload.length > 0); item.oracle.payloadSha256 = hash(Buffer.from(payload));
          item.stage = 'source-copy'; const poison = 'CROSS_PAGE_ARM_' + SEED + '_' + kind;
          const ack = await p.evaluate(text => window.mpHost.writeClipboard({ text }), poison), armed = clipboard.verifyText(poison);
          trace.push({ name: 'STA-poison-arm', ack, armed }); entry(ack?.ok && armed.matches, 'real poison clipboard arm');
          await p.evaluate(text => { window.__crossDrag.expected = text; }, payload); // Diagnostic comparison only.
          await press(p, 'Control+c'); const copied = await capture(p, file, trace, kind + '-05-copied'), read = clipboard.verifyText(payload);
          trace.push({ name: 'STA-source-copy', ...read });
          entry(copied.evidence.transfers.slice(shortened.evidence.transfers.length).some(e => e.type === 'copy' && e.trusted && e.inEditor), 'new actual copy event');
          assert(read.matches, 'clipboard contains frozen-fixture source, including both known complete formulas'); assert.equal(copied.text, spec.text);
          item.stage = 'destination';
          for (const key of ['Control+End', 'ArrowUp', 'Home', 'Shift+End']) await press(p, key);
          const target = await capture(p, file, trace, kind + '-06-target');
          assert.equal(target.text, spec.text); assert(target.focus);
          assert.deepEqual(target.selection, { anchor: spec.destFrom, head: spec.destFrom + DEST.length }, 'real keyboard selects DEST above the retained final LF');
          const beforePaste = clipboard.verifyText(payload); trace.push({ name: 'STA-before-paste', ...beforePaste }); entry(beforePaste.matches, 'source payload remains armed');
          item.stage = 'native-paste'; await press(p, 'Control+v');
          const pasted = await capture(p, file, trace, kind + '-07-pasted'), afterPaste = clipboard.verifyText(payload);
          trace.push({ name: 'STA-after-paste', ...afterPaste });
          entry(afterPaste.matches && pasted.evidence.transfers.slice(target.evidence.transfers.length).some(e => e.type === 'paste' && e.trusted && e.inEditor && e.plainMatches), 'actual native paste delivered the independently verified payload');
          const expectedPaste = spec.text.slice(0, spec.destFrom) + payload + spec.text.slice(spec.destFrom + DEST.length), pasteEnd = spec.destFrom + payload.length;
          assert.equal(pasted.text, expectedPaste); assert.deepEqual(pasted.selection, { anchor: pasteEnd, head: pasteEnd }); assert(pasted.focus);
          item.stage = 'native-history'; await press(p, 'Control+z');
          const undone = await capture(p, file, trace, kind + '-08-undo');
          assert.equal(undone.text, spec.text); assert.deepEqual(undone.selection, target.selection); assert(undone.focus);
          await press(p, 'Control+y'); const redone = await capture(p, file, trace, kind + '-09-redo'), rb = bounds(redone.selection);
          assert.equal(redone.text, expectedPaste); assert(redone.focus && redone.rangeCount === 1);
          const needRight = redone.selection.anchor !== redone.selection.head;
          assert(needRight ? rb.from === spec.destFrom && rb.to === pasteEnd : rb.to === pasteEnd, 'native redo range is exact or already collapsed at payload end');
          trace.push({ name: 'native-continuation-decision', actualRedo: redone.selection, rightNeeded: needRight }); item.stage = 'immediate-continue';
          // No snapshot, wait or repair between native Right and real R.
          if (needRight) await p.keyboard.press('ArrowRight');
          await p.keyboard.insertText('R'); await sleep(SETTLE);
          const continued = await capture(p, file, trace, kind + '-10-continued');
          entry(!needRight || continued.evidence.keys.slice(redone.evidence.keys.length).some(e => e.trusted && e.key === 'ArrowRight' && e.inEditor), 'actual native Right when needed');
          entry(continued.evidence.inputs.slice(redone.evidence.inputs.length).some(e => e.type === 'beforeinput' && e.trusted && e.inEditor && e.focus && e.isR &&
            e.selection.anchor === pasteEnd && e.selection.head === pasteEnd), 'real R arrived at the verified collapsed source position');
          const final = expectedPaste.slice(0, pasteEnd) + 'R' + expectedPaste.slice(pasteEnd);
          assert.equal(continued.text, final); assert.deepEqual(continued.selection, { anchor: pasteEnd + 1, head: pasteEnd + 1 });
          assert(continued.focus && continued.screenshot.caret, 'actual editor focus and visible measured continuation caret');
          await waitUntil(() => disk(file).text === final, 'exact final autosave', 5000);
          const saved = disk(file); trace.push({ name: 'independent-UTF8-disk', ...saved });
          assert.equal(saved.sha256, hash(Buffer.from(final))); item.stage = 'complete';
          return { preUp: pre.selection, afterUp: released.selection, crossed: covered, payloadLength: payload.length, finalSha256: saved.sha256 };
        } catch (e) {
          if (p) try { await capture(p, file, trace, kind + '-failure-' + item.stage); } catch (ce) { trace.push({ name: 'failure-capture-error', error: ce.message }); }
          throw e;
        } finally { if (held) {
          await p.mouse.up({ clickCount: 1 }).catch(e => result.cleanupErrors.push('held mouse release: ' + e.message));
          // Cleanup-only release is recorded, never substituted for a qualified main-arm up.
          try { trace.push({ name: 'cleanup-release-passive-events', evidence: await p.evaluate(() => ({ pointers: window.__crossDrag.pointers, wheels: window.__crossDrag.wheels })) }); }
          catch (e) { result.cleanupErrors.push('cleanup release evidence: ' + e.message); }
        } }
      });
      const item = result.cases.at(-1);
      if (item.error?.startsWith('ENTRY_UNCONFIRMED:')) item.status = 'entry-unconfirmed';
      else if (item.status === 'fail') item.failureKind = item.productReached ? 'product-check' : 'harness-or-setup';
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
      if (item.status !== 'pass' && kind === 'formula') break;
    }
  } catch (e) { result.errors.push({ stage: 'suite', error: e.message }); }
  finally {
    try { if (clip) result.clipboard = await clip.restore(); } catch (e) { result.cleanupErrors.push('clipboard restore: ' + e.message); }
    try { if (run) result.cleanup = await run.cleanup(); } catch (e) { result.cleanupErrors.push('owned cleanup: ' + e.message); }
    try { release?.(); } catch (e) { result.cleanupErrors.push('slot release: ' + e.message); }
    result.finishedAt = new Date().toISOString();
    result.passed = result.cases.length === 2 && result.cases.every(c => c.status === 'pass') && !result.errors.length && !result.cleanupErrors.length && result.clipboard?.restored === true && result.cleanup?.residual?.length === 0;
    result.verdict = result.cases.some(c => c.status === 'entry-unconfirmed') ? 'incomplete-entry-unconfirmed' : result.passed ? 'renderer-chain-pass' : 'chain-or-suite-failure';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
