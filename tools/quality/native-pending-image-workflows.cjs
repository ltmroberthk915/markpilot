'use strict';
// Actual MenuItem.click, actual bitmap, host-write pending evidence.
// No ticket-field introspection, product bridge method replacement, fake Undo or OS-menu claim.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const quality = n => require(path.join(ROOT, 'tools/quality', n));
const { args, acquireSlot, sleep, sha256 } = quality('lifecycle.cjs');
const { outputDir, frame, recorder, waitUntil, newWindow } = quality('harness.cjs');
const { bitmap, verifyBitmap } = quality('clipboard.cjs');
const DELAY = 5000, WIDTH = 512, HEIGHT = 384, CLOCK_TOLERANCE_MS = 5;
const entry = (ok, message) => { if (!ok) throw new Error('ENTRY_UNCONFIRMED: ' + message); };
async function inspector(url) {
  const ws = new WebSocket(url), pending = new Map(); let next = 1;
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('inspector open timeout')), 8000); ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(t); reject(Error('inspector connection failed')); }, { once: true }); });
  ws.addEventListener('message', e => { const r = JSON.parse(e.data), p = pending.get(r.id); if (!p) return; pending.delete(r.id); clearTimeout(p.timer); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 8000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  return { evaluate: async expression => { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; },
    close: () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('inspector closed')); } pending.clear(); ws.close(); } };
}
function assets(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /\.png$/i.test(n)).map(n => { const file = path.join(dir, n), s = fs.statSync(file), b = fs.readFileSync(file);
    const png = b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return { file, bytes: b.length, png, width: png ? b.readUInt32BE(16) : null, height: png ? b.readUInt32BE(20) : null, mtimeMs: s.mtimeMs, sha256: sha256(file) }; });
}
async function main() {
  const o = args(process.argv.slice(2)); entry(o.exe && o['expected-sha256'], 'actual executable and explicit SHA required');
  const dir = outputDir(o.out, 'native-pending-image-workflows');
  const result = { schema: 1, suite: 'native-pending-image-workflows', startedAt: new Date().toISOString(), cases: [], errors: [], cleanupErrors: [],
    transport: 'actual main MenuItem.click; IPC or native role beforeinput; no OS-click/accelerator claim',
    pendingEvidence: 'host write only: real delay, trusted bitmap paste, unchanged source, late fresh assets/log; tickets not read',
    imageHostDelayMs: DELAY, clockToleranceMs: CLOCK_TOLERANCE_MS,
    sourceFiles: ['MarkPilot-CM6/main.js', 'dsh-markpilot/src-cm6/main.js', 'dsh-markpilot/src-cm6/extras.js', 'dsh-markpilot/src-cm6/image-insertion.js'].map(file => ({ file, sha256: sha256(path.join(ROOT, file)) })),
    probe: { file: path.relative(ROOT, __filename).replaceAll('\\', '/'), sha256: sha256(__filename) } };
  const record = recorder(dir, result); let release, run, mainDebugger, clip;
  try {
    release = acquireSlot(ROOT); const owner = path.join(dir, 'owner.md'); fs.writeFileSync(owner, 'Owned native pending image probe\n');
    let inspectorUrl = null, logs = ''; const original = cp.spawn;
    cp.spawn = function(exe, argv, options) { const owned = argv.includes('--remote-debugging-port=0') && options?.env?.MP_TEST_HOOKS === '1';
      const child = original.call(this, exe, owned ? [...argv, '--inspect=0'] : argv, options);
      if (owned) child.stderr.on('data', d => { logs = (logs + d.toString()).slice(-12000); inspectorUrl ||= logs.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+/i)?.[0] || null; }); return child; };
    const moduleFile = require.resolve(path.join(ROOT, 'tools/quality/lifecycle.cjs')); delete require.cache[moduleFile];
    try { run = await quality('lifecycle.cjs').launch(o, owner, dir, { MP_TEST_IMAGE_DELAY_MS: String(DELAY) }); } finally { cp.spawn = original; }
    result.artifact = run.metadata; await waitUntil(() => !!inspectorUrl, 'main inspector endpoint', 5000); mainDebugger = await inspector(inspectorUrl);
    result.mainDelayProof = await mainDebugger.evaluate("(()=>{const {app}=process.mainModule.require('electron');return {pid:process.pid,hooks:process.env.MP_TEST_HOOKS,delay:Number(process.env.MP_TEST_IMAGE_DELAY_MS),profile:app.getPath('userData'),utc:Date.now()};})()");
    entry(result.mainDelayProof.hooks === '1' && result.mainDelayProof.delay === DELAY && path.resolve(result.mainDelayProof.profile) === path.resolve(run.profile), 'owned main process really has 5000ms image delay');
    const fixture = path.join(dir, 'bitmap.png'), base64 = await run.page.evaluate(({ width, height }) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height; const x = c.getContext('2d');
      x.fillStyle = '#e4f3fd'; x.fillRect(0, 0, width, height); x.fillStyle = '#e45636'; x.fillRect(20, 25, 200, 150); x.fillStyle = '#39a46d'; x.fillRect(275, 185, 190, 150);
      return c.toDataURL('image/png').split(',')[1];
    }, { width: WIDTH, height: HEIGHT }); fs.writeFileSync(fixture, Buffer.from(base64, 'base64')); clip = await bitmap(fixture); result.clipboardFixture = { metadata: clip.metadata, file: fixture, sha256: sha256(fixture) };
    const filter = process.env.MP_QUALITY_CASES;
    for (const history of ['empty', 'nonempty']) {
      const id = 'native-menu-undo-pending-bitmap-' + history + '-history'; if (filter && !new RegExp(filter).test(id)) continue;
      await record(id, async trace => {
        const item = result.cases.at(-1); item.stage = 'fixture'; item.productReached = false;
        const armDir = path.join(dir, history), assetDir = path.join(armDir, 'assets'), file = path.join(armDir, 'document.md'); fs.mkdirSync(armDir);
        const initial = history.toUpperCase() + '_PENDING_BASE\n', edited = history === 'nonempty' ? 'X' + initial : initial; fs.writeFileSync(file, initial);
        const p = await newWindow(run, run.page, file); p.on('pageerror', e => result.errors.push({ id, error: e.message }));
        const read = () => p.evaluate(() => ({ ...window.__qualityNativePending.read(), events: window.__qualityNativePending.events, menus: window.__qualityNativePending.menus, pastes: window.__qualityNativePending.pastes }));
        const capture = async name => { const s = await read(), t = { name, utc: Date.now(), ...s, disk: fs.readFileSync(file, 'utf8'), assets: assets(assetDir) }; trace.push(t); t.screenshot = await frame(p, dir, history + '-' + name, { allowMissingCaret: true }); return t; };
        const hostReceipts = () => { const log = path.join(run.profile, 'main-debug.log'); return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(l => /img:saveToAssets/.test(l) && l.includes(history)).slice(-8) : []; };
        const key = (s, from, name, ctrl = false) => s.events.slice(from).some(e => e.type === 'keydown' && e.trusted && e.inEditor && e.ctrl === ctrl && e.key?.toLowerCase() === name);
        try {
          await p.bringToFront(); await waitUntil(() => p.evaluate(() => document.hasFocus() && window.mpEngine._view().hasFocus), 'actual boot editor focus');
          await p.evaluate(() => {
            const events = [], menus = [], pastes = [], read = () => { const v = window.mpEngine._view(), ae = document.activeElement; return { text: v.state.doc.toString(), selection: { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head },
              editorFocus: document.hasFocus() && v.hasFocus, activeElement: { tag: ae?.tagName, class: ae?.className }, images: document.querySelectorAll('.cm-content .mp-img img').length, toast: document.querySelector('.mp-toast')?.textContent || '' }; };
            window.__qualityNativePending = { read, events, menus, pastes };
            for (const type of ['keydown', 'keyup', 'beforeinput', 'input']) document.addEventListener(type, e => events.push({ type, key: e.key, code: e.code, ctrl: !!e.ctrlKey, trusted: e.isTrusted, inputType: e.inputType,
              inEditor: window.mpEngine._view().contentDOM.contains(e.target), defaultPrevented: e.defaultPrevented, utc: Date.now(), state: read() }), { capture: true });
            window.mpHost.onMenu(cmd => menus.push({ cmd, utc: Date.now(), state: read() }));
            document.addEventListener('paste', e => {
              const files = [...(e.clipboardData?.files || [])].map(f => ({ type: f.type, bytes: f.size, width: null, height: null }));
              pastes.push({ trusted: e.isTrusted, inEditor: window.mpEngine._view().contentDOM.contains(e.target), types: [...(e.clipboardData?.types || [])], files, utc: Date.now(), state: read() });
              [...(e.clipboardData?.files || [])].forEach((f, i) => { if (/^image\//.test(f.type)) createImageBitmap(f).then(b => { files[i].width = b.width; files[i].height = b.height; b.close(); }, err => { files[i].decodeError = err.message; }); });
            }, { capture: true });
          });
          const fresh = await capture('01-fresh'); entry(fresh.text === initial && fresh.editorFocus && fresh.assets.length === 0, 'fresh unique source/history and asset directory');
          await p.keyboard.press('Control+Home');
          if (history === 'nonempty') await p.keyboard.insertText('X');
          await p.keyboard.press('Control+z'); const undo = await read();
          entry(undo.text === initial && key(undo, fresh.events.length, 'z', true), 'actual empty/no-op or nonempty Undo positive control');
          await p.keyboard.press('Control+y'); const redo = await read();
          entry(redo.text === edited && key(redo, undo.events.length, 'y', true), 'actual Redo prepares the intended history branch');
          await p.keyboard.press('Control+End'); const ready = await capture('02-before-bitmap');
          entry(ready.editorFocus && ready.text === edited && ready.selection.anchor === edited.length && ready.selection.head === edited.length, 'real collapsed paste location');
          await waitUntil(() => fs.readFileSync(file, 'utf8') === edited, 'pre-paste exact autosave', 5000);
          const pixels = verifyBitmap(fixture); trace.push({ name: 'bitmap-independent-STA', ...pixels }); entry(pixels.matches && pixels.expectedWidth === WIDTH && pixels.expectedHeight === HEIGHT && pixels.meanDifference === 0, 'actual armed bitmap dimensions and exact pixels');
          item.stage = 'pending-entry'; const started = Date.now(); await p.keyboard.press('Control+v');
          await waitUntil(async () => (await read()).pastes.some(e => e.trusted && e.inEditor && e.files.some(f => /^image\//.test(f.type) && f.bytes > 0 && f.width === WIDTH && f.height === HEIGHT)), 'trusted actual bitmap File and dimensions', 1500);
          await sleep(250); // Allow the real async file/base64/owner handshake; no state repair.
          const pending = await read(), paste = pending.pastes.at(-1);
          trace.push({ name: 'provisional-host-write-pending', ...pending, assets: assets(assetDir), startedUtc: started, pasteUtc: paste.utc, elapsedMs: Date.now() - paste.utc, ticketFieldRead: false });
          entry(key(pending, ready.events.length, 'v', true) && paste.trusted && paste.inEditor && pending.editorFocus && pending.text === edited && pending.images === 0 && assets(assetDir).length === 0 && Date.now() - paste.utc < DELAY,
            'trusted bitmap paste is unresolved before the real delay deadline; source has no image');
          item.stage = 'native-undo';
          const ack = await mainDebugger.evaluate("(async()=>{const {Menu,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getFocusedWindow();if(!w||!w.isFocused()||!w.webContents.isFocused())throw Error('No focused owned window');const info=await w.webContents.executeJavaScript('window.mpHost.docInfo()');if(info.filePath!==" + JSON.stringify(file) + ")throw Error('Wrong document owner');const item=Menu.getApplicationMenu()?.items.find(x=>x.label==='编辑')?.submenu?.items.find(x=>x.label==='撤销');if(!item||!item.enabled||typeof item.click!=='function')throw Error('No enabled real Undo MenuItem');const identity={ok:true,label:item.label,role:item.role,accelerator:item.accelerator,window:w.id,webContents:w.webContents.id,doc:info.filePath,documentId:info.documentId,focused:true,invokedUtc:Date.now()};item.click({triggeredByAccelerator:false},w,w.webContents);return identity;})()");
          trace.push({ name: 'actual-main-MenuItem-undo', ack, sincePasteMs: ack.invokedUtc - paste.utc });
          entry(ack.ok && ack.focused && ack.invokedUtc >= paste.utc && ack.invokedUtc - paste.utc < DELAY, 'actual owned/enabled Undo runs before earliest delayed response');
          await sleep(150); const after = await capture('03-after-menu');
          const menuIPC = after.menus.slice(pending.menus.length).some(e => e.cmd === 'undo');
          const nativeEvent = after.events.slice(pending.events.length).find(e => e.type === 'beforeinput' && e.trusted && e.inEditor && e.inputType === 'historyUndo');
          item.transportEvidence = { role: ack.role || null, menuIPC, nativeBeforeinput: nativeEvent || null };
          // Continue read-only observation even if transport is absent. Never press another Undo.
          item.stage = 'late-response'; let lateSeen = false;
          try { await waitUntil(() => assets(assetDir).some(a => a.png && a.bytes > 0), 'real delayed fresh image write', 9000); lateSeen = true; } catch { /* Keep unconfirmed evidence. */ }
          await sleep(750); const late = await capture('04-late-response');
          const receipt = late.assets.find(a => a.png && a.width === WIDTH && a.height === HEIGHT), hostLog = hostReceipts();
          const timing = { delayMs: DELAY, pasteUtc: paste.utc, menuUtc: ack.invokedUtc, assetMtimeMs: receipt?.mtimeMs, observedUtc: late.utc,
            assetAfterPasteMs: receipt ? receipt.mtimeMs - paste.utc : null, hostDelayStartUpperBoundMs: receipt ? receipt.mtimeMs - DELAY : null };
          trace.push({ name: 'retrospective-host-delay-proof', lateSeen, receipt, hostLog, timing, ticketFieldRead: false,
            meaning: 'mtime minus known delay is an upper bound on host delay start; must be at/before Undo to prove the host wait covered this action' });
          entry(lateSeen && receipt && timing.assetAfterPasteMs >= DELAY - CLOCK_TOLERANCE_MS && timing.hostDelayStartUpperBoundMs <= ack.invokedUtc,
            'late real asset proves 5000ms delay and a host write already pending when Undo ran; absent/late-start proof is unconfirmed');
          const finalPixels = verifyBitmap(fixture); trace.push({ name: 'bitmap-independent-STA-after-action', ...finalPixels });
          entry(finalPixels.matches && finalPixels.meanDifference === 0, 'actual bitmap remains armed after paste and menu action; contention is unconfirmed');
          if (!(ack.role ? nativeEvent : menuIPC)) throw new Error('TRANSPORT_UNCONFIRMED: real MenuItem ran but no expected native role historyUndo/menu IPC; empty native history may emit no event');
          item.productReached = true; item.stage = 'final-source';
          assert.equal(after.text, initial, 'native Undo restores this fixture only, or leaves truly empty history unchanged');
          assert.equal(late.text, initial, 'late image response never inserts Markdown after native Undo'); assert.equal(late.images, 0, 'late image is not rendered');
          assert(after.editorFocus && late.editorFocus && !p.isClosed(), 'product remains live and actually focused throughout delay');
          const health = await p.evaluate(() => window.mpHost.health()); trace.push({ name: 'live-product-health', health }); assert.equal(health.renderGoneCount, 0, 'no renderer death masks cancellation'); assert.equal(health.unresponsiveNow, false, 'responsive product after delay');
          await waitUntil(() => fs.readFileSync(file).equals(Buffer.from(initial)), 'exact final UTF-8 disk', 5000);
          const final = await capture('05-final-disk'); assert.equal(final.disk, initial, 'disk source contains no image or other fixture history');
          item.stage = 'complete'; return { history, initial, expectedFinal: initial, pendingKind: 'host-write-only', timing, menuIPC, nativeBeforeinput: !!nativeEvent, lateAssetMayRemain: true };
        } catch (e) { try { await capture('failure-' + item.stage); } catch (x) { trace.push({ name: 'failure-capture-error', error: x.message }); } throw e; }
      });
      const c = result.cases.at(-1); if (c.error?.startsWith('ENTRY_UNCONFIRMED:')) c.status = 'entry-unconfirmed'; else if (c.error?.startsWith('TRANSPORT_UNCONFIRMED:')) c.status = 'transport-unconfirmed'; else if (c.status === 'fail') c.failureKind = c.productReached ? 'product-check' : 'harness-or-setup';
    }
    entry(result.cases.length > 0, 'filter selected an actual case');
  } catch (e) { result.fatal = e.stack || e.message; }
  finally {
    try { if (clip) result.clipboardCleanup = await clip.restore(); else result.clipboardCleanup = { touched: false }; } catch (e) { result.cleanupErrors.push('clipboard: ' + e.message); }
    try { mainDebugger?.close(); } catch (e) { result.cleanupErrors.push('inspector: ' + e.message); }
    try { if (run) result.cleanup = await run.cleanup(); } catch (e) { result.cleanupErrors.push('owned run: ' + e.message); }
    try { release?.(); } catch (e) { result.cleanupErrors.push('slot: ' + e.message); }
    result.finishedAt = new Date().toISOString(); result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') && !result.fatal && !result.errors.length && !result.cleanupErrors.length && result.clipboardCleanup?.restored === true && !!result.cleanup && !result.cleanup.residual.length;
    result.verdict = result.cases.some(c => c.status === 'transport-unconfirmed') ? 'transport-unconfirmed' : result.cases.some(c => c.status === 'entry-unconfirmed') ? 'ENTRY_UNCONFIRMED' : result.passed ? 'native-pending-chain-pass' : 'chain-or-suite-failure';
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
