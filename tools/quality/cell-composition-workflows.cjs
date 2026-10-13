'use strict';
// Chromium-CDP probe; no OS IME candidate/229/native accelerator claim.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const quality = name => require(path.join(__dirname, name));
const { ROOT, args, launch, acquireSlot, sleep, sha256 } = quality('lifecycle.cjs');
const { outputDir, frame, recorder, waitUntil, newWindow } = quality('harness.cjs');
const INITIAL = 'Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n';
const COMMITTED = INITIAL.replace('|a\\|b|KEEP|', '|a\\|中文b|KEEP|');
const FINAL = INITIAL.replace('|a\\|b|KEEP|', '|a\\|中文1b|KEEP|');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const entry = (ok, message) => { if (!ok) throw new Error('ENTRY_UNCONFIRMED: ' + message); };
function disk(file) { try { const b = fs.readFileSync(file); return { text: b.toString('utf8'), sha256: hash(b), bytes: b.length }; } catch (e) { return { error: e.code || e.message }; } }
async function main() {
  const options = args(process.argv.slice(2)); entry(options['expected-sha256'], 'explicit executable SHA required');
  const ids = { ordinary: 'cell-unicode-positive-history-continue', composition: 'cell-cdp-composition-commit-history-continue' };
  const filter = process.env.MP_QUALITY_CASES, wanted = kind => !filter || new RegExp(filter).test(ids[kind]);
  // Unicode is the default. An explicit matching case filter opts into the strict CDP composition arm.
  const wantComposition = !!filter && wanted('composition'); entry(wantComposition || wanted('ordinary'), 'filter selects a known case');
  const dir = outputDir(options.out || path.join(ROOT, '.mp-verify/quality/cell-composition-' + Date.now()), 'cell-composition');
  const result = { schema: 1, suite: 'cell-composition-workflow', kind: 'actual-ui-probe', startedAt: new Date().toISOString(),
    cases: [], errors: [], diagnostics: [], cleanupErrors: [], clipboard: { touched: false }, expectedCases: wantComposition ? 2 : 1,
    transport: 'Chromium renderer CDP only; OS IME candidates/229/native accelerators unverified', compositionRequested: wantComposition, forcedPositive: wantComposition && !wanted('ordinary'),
    sourceFiles: ['dsh-markpilot/src-cm6/main.js', 'dsh-markpilot/src-cm6/cell-source-map.js', 'MarkPilot-CM6/renderer/host.js']
      .map(file => ({ file, sha256: sha256(path.join(ROOT, file)) })), probe: { file: path.relative(ROOT, __filename).replaceAll('\\', '/'), sha256: sha256(__filename) } };
  const record = recorder(dir, result); let release, run;
  try {
    release = acquireSlot(ROOT); const owner = path.join(dir, 'owner.md'); fs.writeFileSync(owner, 'Owned cell composition probe\n');
    run = await launch(options, owner, dir); result.artifact = run.metadata;
    for (const kind of wantComposition ? ['ordinary', 'composition'] : ['ordinary']) {
      await record(ids[kind], async trace => {
        const item = result.cases.at(-1); item.stage = 'fixture'; item.productReached = false;
        const file = path.join(dir, kind + '.md'); fs.writeFileSync(file, INITIAL);
        const p = await newWindow(run, run.page, file); let cdp;
        p.on('pageerror', e => result.errors.push({ kind, message: e.message }));
        p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') result.diagnostics.push({ kind, type: m.type(), text: m.text().slice(0, 1600) }); });
        const capture = async name => {
          const s = await p.evaluate(() => ({ ...window.__qualityCellComposition.read(), events: window.__qualityCellComposition.events }));
          const row = { name, ...s, disk: disk(file) }; trace.push(row);
          row.screenshot = await frame(p, dir, kind + '-' + name, { caret: 'dom', allowMissingCaret: true, contextBox: s.overlayBox }); return row;
        };
        const received = (s, type, from = 0) => s.events.slice(from).filter(e => e.type === type && e.trusted && e.inOverlay);
        const keyReceived = (s, from, key, ctrl = false) => received(s, 'keydown', from).some(e => e.key?.toLowerCase() === key.toLowerCase() && e.ctrl === ctrl && !e.isComposing);
        const exact = (s, source, visible, domAt, sourceAt, stage) => {
          assert.equal(s.text, source, stage + ' exact source'); assert.equal(s.cellText, visible, stage + ' visible text');
          assert.deepEqual(s.domSelection, { anchor: domAt, head: domAt }, stage + ' actual DOM caret');
          assert.deepEqual(s.sourceSelection, { anchor: sourceAt, head: sourceAt }, stage + ' mapped source caret'); assert(s.focus, stage + ' overlay focus');
        };
        try {
          await p.bringToFront();
          await waitUntil(() => p.evaluate(() => window.mpEngine.getValue() === 'Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n' && document.hasFocus()), 'owned fixture window focus');
          await p.evaluate(() => {
            const events = [], map = new WeakMap();
            const read = () => {
              const v = window.mpEngine._view(), el = document.querySelector('.mp-cell-overlay-text'), s = getSelection(), ae = document.activeElement;
              const offset = (node, at) => { if (!el?.contains(node)) return null; try { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, at); return r.toString().length; } catch { return null; } };
              const r = el?.getBoundingClientRect(); return { text: v.state.doc.toString(), cellText: el?.textContent,
                sourceSelection: { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head },
                domSelection: { anchor: offset(s?.anchorNode, s?.anchorOffset), head: offset(s?.focusNode, s?.focusOffset) },
                focus: document.hasFocus() && !!el && ae === el, activeElement: { tag: ae?.tagName, class: ae?.className },
                overlayBox: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null, visible: !!r && r.width > 0 && r.height > 0 };
            };
            window.__qualityCellComposition = { events, read };
            for (const type of ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'focusin', 'focusout', 'mousedown', 'mouseup', 'click']) {
              document.addEventListener(type, e => {
                const el = document.querySelector('.mp-cell-overlay-text'); const row = { type, trusted: e.isTrusted, inOverlay: !!el?.contains(e.target),
                  key: e.key, code: e.code, keyCode: e.keyCode, ctrl: !!e.ctrlKey, shift: !!e.shiftKey, isComposing: e.isComposing ?? null,
                  inputType: e.inputType, data: e.data, defaultPrevented: e.defaultPrevented, bubbleSeen: false, at: performance.now(), before: read() };
                map.set(e, row); events.push(row);
              }, { capture: true });
              document.addEventListener(type, e => { const row = map.get(e); if (row) Object.assign(row, { bubbleSeen: true, defaultPreventedAfter: e.defaultPrevented, after: read() }); });
            }
          }); // Passive observers/read-only Range measurements; never change source, DOM selection or focus.
          item.stage = 'cell-entry'; await p.locator('.mp-row td[data-mp-row="24"][data-mp-col="0"]').click({ delay: 65 });
          await waitUntil(() => p.evaluate(() => window.__qualityCellComposition.read().focus), 'real clicked cell focus');
          await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await sleep(100);
          const start = await capture('01-entry');
          start.entryMapping = item.entryMapping = { expectedDOM: 2, expectedMappedSource: 28, observedSourceSelection: start.sourceSelection,
            observedLag: start.sourceSelection.anchor !== 28 || start.sourceSelection.head !== 28, cellSourceRange: [25, 29] };
          entry(start.text === INITIAL && start.focus && start.visible && start.screenshot.caret && start.cellText === 'a|b' && start.domSelection.anchor === 2 && start.domSelection.head === 2 &&
            Math.min(start.sourceSelection.anchor, start.sourceSelection.head) >= 25 && Math.max(start.sourceSelection.anchor, start.sourceSelection.head) <= 29 &&
            keyReceived(start, 0, 'Home') && received(start, 'keydown').filter(e => e.key === 'ArrowRight').length === 2,
            'real row1/col0 Home/Right twice reach DOM2; conceptual source28, observed CM selection may legally lag within this cell');
          assert.equal(start.text, INITIAL, 'entry changes no source'); item.stage = kind + '-input';
          if (kind === 'ordinary') {
            await p.keyboard.insertText('中文'); await sleep(120); const s = await capture('02-ordinary-unicode');
            entry(received(s, 'input', start.events.length).some(e => e.data === '中文' && !e.isComposing), 'ordinary trusted Unicode input reached overlay');
            const boundary = received(s, 'beforeinput', start.events.length).find(e => e.data === '中文' && !e.isComposing && e.bubbleSeen && e.after);
            entry(boundary, 'trusted ordinary beforeinput bubble snapshot'); item.productReached = true; item.inputBoundary = boundary;
            assert.equal(boundary.before.text, INITIAL, 'ordinary input boundary starts with unchanged source');
            exact(boundary.after, INITIAL, 'a|b', 2, 28, 'ordinary beforeinput after target selection sync');
            exact(s, COMMITTED, 'a|中文b', 4, 30, 'ordinary commit');
          } else {
            cdp = await p.context().newCDPSession(p); trace.push({ name: 'protocol-sequence', calls: ['Input.imeSetComposition(zhong,5,5)', 'Input.imeSetComposition(中文,2,2)', 'Input.insertText(中文)'] });
            await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(120);
            const first = await capture('02-composition-zhong');
            const boundary = received(first, 'compositionstart', start.events.length).find(e => e.bubbleSeen && e.after);
            entry(boundary && received(first, 'compositionupdate', start.events.length).some(e => e.data === 'zhong') &&
              received(first, 'input', start.events.length).some(e => e.isComposing && e.inputType === 'insertCompositionText'), 'trusted start/update/composing input targeted overlay');
            item.compositionEntered = true; item.inputBoundary = boundary;
            await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await sleep(120);
            const update = await capture('03-composition-chinese');
            entry(received(update, 'compositionupdate', first.events.length).some(e => e.data === '中文') && received(update, 'input', first.events.length).some(e => e.isComposing), 'second trusted overlay composition update/input');
            item.stage = 'commit-transport'; await cdp.send('Input.insertText', { text: '中文' }); await sleep(180);
            const committed = await capture('04-commit-observed'), from = update.events.length;
            const end = received(committed, 'compositionend', from).find(e => e.data === '中文');
            const commitInput = received(committed, 'input', from).find(e => e.data === '中文' && e.isComposing === false);
            item.commitEvidence = { compositionend: end || null, commitInput: commitInput || null };
            if (!end && !commitInput) throw new Error('TRANSPORT/COMMIT_UNCONFIRMED: Input.insertText produced no trusted overlay commit/end evidence; no OS bug conclusion');
            item.commitConfirmed = item.productReached = true;
            assert.equal(boundary.before.text, INITIAL, 'composition boundary starts with unchanged source');
            exact(boundary.after, INITIAL, 'a|b', 2, 28, 'compositionstart after target selection sync');
            assert.equal(first.text, INITIAL, 'preedit does not mirror into source'); assert.equal(update.text, INITIAL, 'updated preedit does not mirror into source');
            exact(committed, COMMITTED, 'a|中文b', 4, 30, 'CDP committed');
          }
          const history = async (name, key, source, visible, domAt, sourceAt) => {
            item.stage = name; const before = await p.evaluate(() => window.__qualityCellComposition.read()); entry(before.focus, 'real overlay focus before history');
            const from = await p.evaluate(() => window.__qualityCellComposition.events.length);
            await p.keyboard.press('Control+' + key); await sleep(120); const s = await capture(name);
            entry(keyReceived(s, from, key, true), 'trusted overlay history key ' + key); exact(s, source, visible, domAt, sourceAt, name); return s;
          };
          const undone = await history('05-undo', 'z', INITIAL, 'a|b', 2, 28), from = undone.events.length;
          item.stage = 'redo-immediate-continue';
          await p.keyboard.press('Control+y'); await p.keyboard.press('1'); // No read/wait/frame between native Redo and digit.
          await sleep(120); const continued = await capture('07-continue-one');
          const redo = received(continued, 'keyup', from).find(e => e.key?.toLowerCase() === 'y' && e.ctrl && !e.isComposing);
          entry(keyReceived(continued, from, 'y', true) && redo, 'trusted Redo keyup before the immediate continued digit');
          trace.push({ name: '06-passive-redo-before-one', ...redo.before, screenshot: null, limitation: 'passive actual keyup read; no screenshot or reposition between Redo and digit' });
          exact(redo.before, COMMITTED, 'a|中文b', 4, 30, 'real Redo before continued digit');
          entry(keyReceived(continued, from, '1') && received(continued, 'input', from).some(e => e.data === '1' && !e.isComposing), 'real continued digit reached overlay');
          exact(continued, FINAL, 'a|中文1b', 5, 31, 'continued digit');
          item.stage = 'disk'; await waitUntil(() => fs.readFileSync(file).equals(Buffer.from(FINAL)), 'exact UTF-8/LF autosave', 5000);
          const saved = await capture('08-saved'); assert.equal(saved.disk.sha256, hash(Buffer.from(FINAL)), 'final exact disk bytes');
          item.stage = 'complete'; return { fixture: INITIAL, committed: COMMITTED, final: FINAL, finalSha256: saved.disk.sha256, clipboardTouched: false };
        } catch (e) {
          try { await capture('failure-' + item.stage); } catch (err) { trace.push({ name: 'failure-capture-error', error: err.message }); }
          if (kind === 'composition' && item.compositionEntered && !item.commitConfirmed && !e.message.startsWith('TRANSPORT/COMMIT_UNCONFIRMED:'))
            throw new Error('TRANSPORT/COMMIT_UNCONFIRMED: ' + e.message);
          throw e; // Stop this chain at its first failure; never repair selection/focus or synthesize compositionend.
        } finally { if (cdp) try { await cdp.detach(); } catch (e) { result.cleanupErrors.push('CDP detach: ' + e.message); } }
      });
      const c = result.cases.at(-1);
      if (c.error?.startsWith('ENTRY_UNCONFIRMED:')) c.status = 'entry-unconfirmed';
      else if (c.error?.startsWith('TRANSPORT/COMMIT_UNCONFIRMED:')) c.status = 'transport/commit-unconfirmed';
      else if (c.status === 'fail') c.failureKind = c.productReached ? 'chromium-product-check' : 'harness-or-setup';
      if (kind === 'ordinary' && c.status !== 'pass') { result.skipped = [{ id: ids.composition, reason: 'ordinary fresh-window positive control not proven' }]; break; }
    }
  } catch (e) { result.fatal = e.stack || e.message; }
  finally {
    try { if (run) result.cleanup = await run.cleanup(); } catch (e) { result.cleanupErrors.push('owned run: ' + e.message); }
    try { if (release) release(); } catch (e) { result.cleanupErrors.push('slot: ' + e.message); }
    result.finishedAt = new Date().toISOString();
    result.passed = result.cases.length === result.expectedCases && result.cases.every(c => c.status === 'pass') && !result.fatal && !result.errors.length &&
      !result.cleanupErrors.length && !!result.cleanup && !result.cleanup.residual?.length;
    result.verdict = result.cases.some(c => c.status === 'transport/commit-unconfirmed') ? 'transport/commit-unconfirmed' :
      result.cases.some(c => c.status === 'entry-unconfirmed') ? 'ENTRY_UNCONFIRMED' : result.passed ? 'chromium-chain-pass' : 'chain-or-suite-failure';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
