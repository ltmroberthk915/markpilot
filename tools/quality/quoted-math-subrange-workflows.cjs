'use strict';
// Run with --exe, --expected-sha256 and a fresh --out; synthetic fixtures only.
// Renderer-CDP trusted input; physical OS input and native menu accelerators are unverified.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const quality = name => require(path.join(__dirname, name));
const { ROOT, args, launch, acquireSlot, sleep, sha256 } = quality('lifecycle.cjs');
const { outputDir, snapshot, frame, recorder, waitUntil } = quality('harness.cjs');
const clipboard = quality('clipboard.cjs');
const INITIAL = 'PRE\n\n> $$\n> x+\n> y\n> $$\n\nPOST\n';
const PAYLOAD = 'x+\n> y', CUT = 'PRE\n\n> $$\n> \n> $$\n\nPOST\n';
const FINAL = 'PRE\n\n> $$\n> x+\n> yR\n> $$\n\nPOST\n';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireEntry = (ok, text) => { if (!ok) throw new Error('ENTRY_UNCONFIRMED: ' + text); };
function disk(file) {
  try { const b = fs.readFileSync(file); return { text: b.toString('utf8'), bytes: b.length, sha256: hash(b) }; }
  catch (e) { return { readError: e.code || e.message }; }
}
async function main() {
  const options = args(process.argv.slice(2));
  requireEntry(options['expected-sha256'], 'explicit executable identity is required');
  const dir = outputDir(options.out || path.join(ROOT, '.mp-verify/quality/quoted-subrange-' + Date.now()), 'quoted-subrange');
  const file = path.join(dir, 'quoted-subrange.md');
  const result = { schema: 1, suite: 'quoted-math-subrange-workflow', kind: 'actual-ui-probe',
    startedAt: new Date().toISOString(), cases: [], errors: [], diagnostics: [], cleanupErrors: [],
    transport: 'renderer-CDP; real clipboard STA readback; physical OS input/menu accelerators unverified',
    sourceFiles: ['dsh-markpilot/src-cm6/main.js', 'dsh-markpilot/src-cm6/math-source-map.js', 'MarkPilot-CM6/renderer/host.js']
      .map(name => ({ file: name, sha256: sha256(path.join(ROOT, name)) })),
    probe: { file: path.relative(ROOT, __filename).replaceAll('\\', '/'), sha256: sha256(__filename) } };
  const record = recorder(dir, result); let release, run, clip;
  try {
    release = acquireSlot(ROOT); fs.writeFileSync(file, INITIAL);
    run = await launch(options, file, dir); result.artifact = run.metadata;
    const p = run.page;
    p.on('pageerror', e => result.errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') result.diagnostics.push({ type: m.type(), text: m.text().slice(0, 1800) }); });
    clip = await clipboard.hold();
    await record('quoted-multiline-reverse-subrange-copy-cut-paste-history-continue', async trace => {
      const item = result.cases.at(-1); item.stage = 'boot'; item.productReached = false;
      const capture = async name => {
        const s = await snapshot(p), evidence = await p.evaluate(() => window.__qualityQuotedSubrange || null);
        const entry = { name, ...s, disk: disk(file), evidence }; trace.push(entry);
        entry.screenshot = await frame(p, dir, name, { allowMissingCaret: true }); return entry;
      };
      try {
        await p.bringToFront();
        await waitUntil(async () => { const s = await snapshot(p); return s.text === INITIAL && s.focus; }, 'actual fixture boot focus');
        await waitUntil(() => p.locator('.cm-content .mp-cm6-math-block .katex').count(), 'rendered quoted formula');
        await p.evaluate(expected => {
          const v = window.mpEngine._view(), log = { keys: [], pointers: [], transfers: [], inputs: [], focus: [], expected };
          window.__qualityQuotedSubrange = log;
          const state = () => { const s = v.state.selection.main, ae = document.activeElement; return {
            text: v.state.doc.toString(), selection: { anchor: s.anchor, head: s.head },
            focus: v.hasFocus && document.hasFocus(), activeElement: { tag: ae?.tagName, class: ae?.className } }; };
          const target = e => ({ inEditor: v.contentDOM.contains(e.target),
            block: !!e.target?.closest?.('.mp-cm6-math-block'), floating: !!e.target?.closest?.('.mp-inline-float') });
          for (const type of ['keydown', 'keyup']) document.addEventListener(type, e => log.keys.push({ type, key: e.key, code: e.code,
            ctrl: e.ctrlKey, shift: e.shiftKey, trusted: e.isTrusted, at: performance.now(), ...target(e), ...state() }), { capture: true });
          for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) document.addEventListener(type, e => log.pointers.push({
            type, trusted: e.isTrusted, x: e.clientX, y: e.clientY, shift: e.shiftKey, button: e.button, at: performance.now(), ...target(e), ...state() }), { capture: true });
          for (const kind of ['copy', 'cut', 'paste']) document.addEventListener(kind, e => {
            const plain = kind === 'paste' ? e.clipboardData?.getData('text/plain') || '' : '';
            log.transfers.push({ kind, trusted: e.isTrusted, types: [...(e.clipboardData?.types || [])], plainLength: plain.length,
              plainMatches: kind === 'paste' && plain === log.expected, at: performance.now(), ...target(e), ...state() });
          }, { capture: true });
          for (const type of ['beforeinput', 'input']) document.addEventListener(type, e => log.inputs.push({ type,
            inputType: e.inputType, data: e.data, trusted: e.isTrusted, at: performance.now(), ...target(e), ...state() }), { capture: true });
          for (const type of ['focusin', 'focusout']) document.addEventListener(type, e => log.focus.push({ type,
            trusted: e.isTrusted, at: performance.now(), ...target(e), ...state() }), { capture: true });
        }, PAYLOAD); // Only passive observers and a diagnostic comparison value; no document/selection/focus mutation.
        const glyph = async (scope, char, side) => {
          const g = await p.evaluate(({ scope, char, side }) => {
            const el = [...document.querySelectorAll(scope + ' .katex-html [data-typora-source-start]')]
              .find(e => e.textContent === char && e.getBoundingClientRect().width > 0);
            if (!el) return null; const r = el.getBoundingClientRect();
            return { x: r.left + r.width * side, y: r.top + r.height / 2, text: el.textContent,
              start: el.getAttribute('data-typora-source-start'), end: el.getAttribute('data-typora-source-end'),
              visible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
          }, { scope, char, side }); requireEntry(g?.visible, 'visible mapped ' + char + ' glyph in ' + scope); return g;
        };
        const keyReceived = (s, from, key) => {
          const parts = key.split('+'), end = parts.at(-1).toLowerCase();
          return s.evidence.keys.slice(from).some(e => e.type === 'keydown' && e.trusted && e.inEditor &&
            e.key.toLowerCase() === end && e.ctrl === parts.includes('Control') && e.shift === parts.includes('Shift'));
        };
        const keyStep = async (name, key, expected, transfer) => {
          item.stage = name; const before = await snapshot(p);
          requireEntry(before.focus, 'actual editor focus before ' + key);
          const counts = await p.evaluate(() => ({ keys: window.__qualityQuotedSubrange.keys.length, transfers: window.__qualityQuotedSubrange.transfers.length }));
          await p.keyboard.press(key); await sleep(120); const s = await capture(name);
          requireEntry(keyReceived(s, counts.keys, key), 'trusted editor key received: ' + key);
          if (transfer) requireEntry(s.evidence.transfers.slice(counts.transfers).some(e => e.kind === transfer && e.trusted && e.inEditor &&
            (transfer !== 'paste' || e.plainMatches)), 'actual trusted ' + transfer + ' reached the editor with its required payload');
          if (expected !== undefined) assert.equal(s.text, expected, name + ' exact source');
          assert(s.focus, name + ' retains actual editor focus'); return s;
        };
        const arm = async name => {
          const marker = 'QUALITY_QUOTED_SUBRANGE_ARM_' + name + '_' + path.basename(dir);
          const ack = await p.evaluate(text => window.mpHost.writeClipboard({ text }), marker), check = clipboard.verifyText(marker);
          trace.push({ name: name + '-sentinel-STA', ack, ...check }); requireEntry(ack?.ok && check.matches, 'native clipboard sentinel armed for ' + name);
        };
        item.stage = 'rendered-y-click'; await capture('01-rendered');
        const y = await glyph('.cm-content .mp-cm6-math-block', 'y', .8); trace.push({ name: 'rendered-y-target', target: y });
        await p.mouse.click(y.x, y.y, { delay: 65 }); await sleep(150); const clicked = await capture('02-clicked-y');
        requireEntry(clicked.focus && clicked.selection.anchor === 18 && clicked.selection.head === 18 &&
          clicked.evidence.pointers.some(e => e.type === 'mousedown' && e.trusted && e.block && !e.shift), 'real rendered y click produced source endpoint 18');
        const x = await glyph('.mp-inline-float', 'x', .2), pointerFrom = clicked.evidence.pointers.length;
        trace.push({ name: 'floating-x-target', target: x }); item.stage = 'shift-floating-x';
        await p.keyboard.down('Shift'); try { await p.mouse.click(x.x, x.y, { delay: 65 }); } finally { await p.keyboard.up('Shift'); }
        await sleep(150); const selected = await capture('03-reverse-selected');
        requireEntry(selected.focus && selected.selection.anchor === 18 && selected.selection.head === 12 &&
          selected.evidence.pointers.slice(pointerFrom).some(e => e.type === 'mousedown' && e.trusted && e.shift && e.floating) &&
          selected.evidence.keys.some(e => e.key === 'Shift' && e.type === 'keydown' && e.trusted), 'real Shift floating-x click formed anchor18/head12');
        item.productReached = true; item.oracle = { anchor: 18, head: 12, initial: INITIAL, payload: PAYLOAD, afterCut: CUT, final: FINAL };
        assert.equal(clicked.text, INITIAL, 'rendered click preserved exact source'); assert.equal(selected.text, INITIAL, 'Shift selection preserved exact source');
        await arm('copy'); const copied = await keyStep('04-copy', 'Control+c', undefined, 'copy');
        const copyCheck = clipboard.verifyText(PAYLOAD); trace.push({ name: 'copy-payload-independent-STA', ...copyCheck });
        assert(copyCheck.matches, 'Copy payload is raw x+ LF > y'); assert.equal(copied.text, INITIAL, 'Copy source unchanged');
        assert.deepEqual(copied.selection, { anchor: 18, head: 12 }, 'Copy retains proven reverse selection');
        await arm('cut'); const cut = await keyStep('05-cut', 'Control+x', undefined, 'cut');
        const cutCheck = clipboard.verifyText(PAYLOAD); trace.push({ name: 'cut-payload-independent-STA', ...cutCheck });
        assert(cutCheck.matches, 'Cut independently overwrites its sentinel with the raw source'); assert.equal(cut.text, CUT, 'Cut removes only the six source units');
        await keyStep('06-cut-undo', 'Control+z', INITIAL);
        const cutRedo = await keyStep('07-cut-redo', 'Control+y', CUT);
        assert.deepEqual(cutRedo.selection, { anchor: 12, head: 12 }, 'native Cut Redo provides the original paste insertion point');
        const retained = clipboard.verifyText(PAYLOAD); trace.push({ name: 'before-paste-independent-STA', ...retained });
        requireEntry(retained.matches, 'actual Cut payload still available before native paste');
        await keyStep('08-original-position-paste', 'Control+v', INITIAL, 'paste');
        await keyStep('09-paste-undo', 'Control+z', CUT);
        const redone = await keyStep('10-paste-redo', 'Control+y', INITIAL);
        assert(Math.min(redone.selection.anchor, redone.selection.head) >= 12 && Math.max(redone.selection.anchor, redone.selection.head) <= 18 &&
          Math.max(redone.selection.anchor, redone.selection.head) === 18, 'native Paste Redo ends at the restored source subrange');
        item.stage = 'immediate-R'; const collapse = redone.selection.anchor !== redone.selection.head;
        // Native collapse, if needed, is followed immediately by real text input; no wait/read/frame or focus/selection repair.
        if (collapse) await p.keyboard.press('ArrowRight');
        await p.keyboard.insertText('R'); await sleep(120); const continued = await capture('11-continued-R');
        if (collapse) requireEntry(keyReceived(continued, redone.evidence.keys.length, 'ArrowRight'), 'trusted native ArrowRight collapse');
        requireEntry(continued.evidence.inputs.slice(redone.evidence.inputs.length).some(e => e.trusted && e.inEditor && e.data === 'R' &&
          e.type === 'beforeinput'), 'real continued R input reached editor');
        assert.equal(continued.text, FINAL, 'continued R preserves quote prefixes, fences and both neighbors');
        assert.deepEqual(continued.selection, { anchor: 19, head: 19 }, 'continued caret is immediately after yR'); assert(continued.focus, 'continued editor focus');
        item.stage = 'disk'; await waitUntil(() => fs.readFileSync(file).equals(Buffer.from(FINAL)), 'exact UTF-8/LF final autosave', 5000);
        const saved = await capture('12-saved'); assert.equal(saved.disk.sha256, hash(Buffer.from(FINAL)), 'independent disk bytes match fixed final oracle');
        item.stage = 'complete'; return { copySTA: copyCheck, cutSTA: cutCheck, finalSha256: saved.disk.sha256, collapsedWithNativeRight: collapse };
      } catch (e) {
        try { await capture('failure-' + item.stage); } catch (err) { trace.push({ name: 'failure-capture-error', error: err.message }); }
        throw e; // Preserve the first failure. No state repair or later chain actions.
      }
    });
    const c = result.cases.at(-1);
    if (c.error?.startsWith('ENTRY_UNCONFIRMED:')) c.status = 'entry-unconfirmed';
    else if (c.status === 'fail') c.failureKind = c.productReached ? 'product-check' : 'harness-or-setup';
  } catch (e) { result.fatal = e.stack || e.message; }
  finally {
    try { if (clip) result.clipboard = await clip.restore(); } catch (e) { result.cleanupErrors.push('clipboard: ' + e.message); }
    try { if (run) result.cleanup = await run.cleanup(); } catch (e) { result.cleanupErrors.push('owned run: ' + e.message); }
    try { if (release) release(); } catch (e) { result.cleanupErrors.push('slot: ' + e.message); }
    result.finishedAt = new Date().toISOString();
    result.passed = result.cases.length === 1 && result.cases[0].status === 'pass' && !result.fatal && !result.errors.length &&
      !result.cleanupErrors.length && result.clipboard?.restored === true && !!result.cleanup && !result.cleanup.residual?.length;
    result.verdict = result.cases.some(c => c.status === 'entry-unconfirmed') ? 'ENTRY_UNCONFIRMED' : result.passed ? 'renderer-chain-pass' : 'chain-or-suite-failure';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
