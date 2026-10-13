'use strict';
// Actual MenuItem.click via the main V8 inspector. No OS menu click/accelerator claim.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const quality = n => require(path.join(ROOT, 'tools/quality', n));
const { args, acquireSlot, sleep, sha256 } = quality('lifecycle.cjs');
const { outputDir, frame, recorder, waitUntil, newWindow } = quality('harness.cjs');
const CELL = 'Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n';
const BODY = 'MENU_BASE\n', SEARCH = 'Before abc after\n';
const entry = (ok, message) => { if (!ok) throw new Error('ENTRY_UNCONFIRMED: ' + message); };
async function inspector(url) {
  const ws = new WebSocket(url), pending = new Map(); let next = 1;
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('inspector open timeout')), 8000); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('inspector connection failed')); }, { once: true }); });
  ws.addEventListener('message', e => { const r = JSON.parse(e.data), item = pending.get(r.id); if (!item) return; pending.delete(r.id); clearTimeout(item.timer); r.error ? item.reject(Error(JSON.stringify(r.error))) : item.resolve(r.result); });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 8000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  return { evaluate: async expression => { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }, close: () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Inspector closed')); } pending.clear(); ws.close(); } };
}
async function main() {
  const o = args(process.argv.slice(2)); entry(o['expected-sha256'], 'mandatory executable SHA');
  const dir = outputDir(o.out, 'native-menu-workflow');
  const result = { schema: 1, suite: 'native-menu-workflow', startedAt: new Date().toISOString(), cases: [], errors: [], diagnostics: [], cleanupErrors: [], clipboard: { touched: false },
    transport: 'Installed actual MenuItem.click(event, focusedWindow, focusedWebContents) through local main V8 inspector; not OS menu clicks or physical accelerators',
    probe: { file: path.relative(ROOT, __filename).replaceAll('\\', '/'), sha256: sha256(__filename) } };
  const record = recorder(dir, result); let release, run, mainDebugger;
  try {
    release = acquireSlot(ROOT); const owner = path.join(dir, 'owner.md'); fs.writeFileSync(owner, 'Native menu owned probe\n');
    // Add a documented Node inspector switch to this one owned launch. No product mutation.
    let inspectorUrl = null, logs = ''; const original = cp.spawn;
    cp.spawn = function(exe, argv, options) {
      const owned = argv.includes('--remote-debugging-port=0') && options?.env?.MP_TEST_HOOKS === '1';
      const child = original.call(this, exe, owned ? [...argv, '--inspect=0'] : argv, options);
      if (owned) child.stderr.on('data', d => { logs = (logs + d.toString()).slice(-12000); inspectorUrl ||= logs.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+/i)?.[0] || null; });
      return child;
    };
    // Reload only the lifecycle module's spawn binding. Existing public helpers remain byte exact.
    const moduleFile = require.resolve(path.join(ROOT, 'tools/quality/lifecycle.cjs')); delete require.cache[moduleFile];
    try { run = await quality('lifecycle.cjs').launch(o, owner, dir); } finally { cp.spawn = original; }
    result.artifact = run.metadata; await waitUntil(() => !!inspectorUrl, 'main inspector endpoint', 5000); mainDebugger = await inspector(inspectorUrl);
    const filter = process.env.MP_QUALITY_CASES, wanted = id => !filter || new RegExp(filter).test(id);
    for (const surface of ['body', 'cell', 'search', 'body-empty', 'cell-empty']) for (const command of ['undo', 'redo']) {
      const kind = surface.split('-')[0], empty = surface.endsWith('-empty');
      const id = 'native-menu-' + surface + '-' + command + '-history-continue'; if (!wanted(id)) continue;
      await record(id, async trace => {
        const item = result.cases.at(-1); item.stage = 'fixture'; item.productReached = false;
        const initial = kind === 'cell' ? CELL : kind === 'search' ? SEARCH : BODY;
        const file = path.join(dir, surface + '-' + command + '.md'); fs.writeFileSync(file, initial);
        const p = await newWindow(run, run.page, file); p.on('pageerror', e => result.errors.push({ id, error: e.message }));
        const capture = async name => { const s = await p.evaluate(() => window.__qualityNativeMenu.read()); const t = { name, ...s, events: await p.evaluate(() => window.__qualityNativeMenu.events), menus: await p.evaluate(() => window.__qualityNativeMenu.menus), disk: fs.readFileSync(file, 'utf8') }; trace.push(t); t.screenshot = await frame(p, dir, surface + '-' + command + '-' + name, s.cellFocus ? { caret: 'dom', allowMissingCaret: true } : s.searchFocus ? { caret: 'dom', allowMissingCaret: true, contextBox: s.searchBox } : {}); return t; };
        try {
          await p.bringToFront(); await waitUntil(() => p.evaluate(() => document.hasFocus() && !!window.mpEngine?._view()), 'actual window focus');
          await p.evaluate(() => {
            const events = [], menus = [], read = () => { const v = window.mpEngine._view(), el = document.querySelector('.mp-cell-overlay-text'), ae = document.activeElement, search = document.querySelector('.cm-search input[name="search"]'), s = getSelection();
              const at = (node, n) => { if (!el?.contains(node)) return null; const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, n); return r.toString().length; };
              const r = search?.getBoundingClientRect(); return { text: v.state.doc.toString(), selection: { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head }, focus: document.hasFocus(), editorFocus: v.hasFocus && document.hasFocus(),
                cellFocus: !!el && ae === el && document.hasFocus(), cellText: el?.textContent, domSelection: { anchor: at(s?.anchorNode, s?.anchorOffset), head: at(s?.focusNode, s?.focusOffset) },
                searchFocus: !!search && ae === search && document.hasFocus(), searchValue: search?.value, searchSelection: search ? { anchor: search.selectionStart, head: search.selectionEnd } : null,
                searchBox: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null, activeElement: { tag: ae?.tagName, class: ae?.className, name: ae?.getAttribute('name') } }; };
            window.__qualityNativeMenu = { events, menus, read };
            for (const type of ['keydown', 'keyup', 'beforeinput', 'input']) document.addEventListener(type, e => events.push({ type, key: e.key, ctrl: e.ctrlKey, inputType: e.inputType, data: e.data, trusted: e.isTrusted, target: { tag: e.target?.tagName, class: e.target?.className, name: e.target?.getAttribute('name') }, state: read(), at: performance.now() }), { capture: true });
            window.mpHost.onMenu(cmd => menus.push({ cmd, at: performance.now() }));
          });
          entry((await capture('01-initial')).text === initial, 'exact fresh source');
          let edited, beforeValue, afterValue;
          if (kind === 'cell') {
            await p.locator('.mp-row td[data-mp-row="24"][data-mp-col="0"]').click({ delay: 65 });
            await waitUntil(() => p.evaluate(() => window.__qualityNativeMenu.read().cellFocus), 'actual clicked cell');
            await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); if (!empty) await p.keyboard.insertText('中文'); edited = empty ? CELL : CELL.replace('|a\\|b|KEEP|', '|a\\|中文b|KEEP|');
          } else if (kind === 'search') {
            await p.keyboard.press('Control+f'); await waitUntil(() => p.evaluate(() => window.__qualityNativeMenu.read().searchFocus), 'real search field');
            await p.keyboard.type('abc', { delay: 45 }); edited = initial;
          } else { await p.keyboard.press('Control+Home'); if (!empty) await p.keyboard.insertText('X'); edited = empty ? initial : 'X' + initial; }
          await sleep(180); const typed = await capture('02-typed');
          entry(typed.text === edited && (kind === 'cell' ? typed.cellFocus && typed.cellText === (empty ? 'a|b' : 'a|中文b') : kind === 'search' ? typed.searchFocus && typed.searchValue === 'abc' : typed.editorFocus), 'real edit or fresh no-op and correct surface before positive history');
          await p.keyboard.press('Control+z'); await sleep(120); const undone = await capture('03-renderer-undo-positive');
          entry(undone.text === initial && undone.events.slice(typed.events.length).some(e => e.type === 'keydown' && e.trusted && e.ctrl && /^z$/i.test(e.key)) && (kind !== 'search' || undone.searchValue === 'ab') && (kind !== 'cell' || undone.cellText === 'a|b'), 'renderer Undo positive control');
          await p.keyboard.press('Control+y'); await sleep(120); const redone = await capture('04-renderer-redo-positive');
          entry(redone.text === edited && redone.events.slice(undone.events.length).some(e => e.type === 'keydown' && e.trusted && e.ctrl && /^y$/i.test(e.key)) && (kind !== 'search' || redone.searchValue === 'abc') && (kind !== 'cell' || redone.cellText === (empty ? 'a|b' : 'a|中文b')), 'renderer Redo positive control');
          if (command === 'redo') { await p.keyboard.press('Control+z'); await sleep(120); }
          const ready = await capture('05-menu-ready'); entry(kind === 'cell' ? ready.cellFocus : kind === 'search' ? ready.searchFocus : ready.editorFocus, 'focused correct surface before actual menu callback');
          beforeValue = command === 'undo' ? edited : initial; afterValue = command === 'undo' ? initial : edited; entry(ready.text === beforeValue, 'history event ready');
          const ack = await mainDebugger.evaluate(`(async()=>{const {Menu,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getFocusedWindow();if(!w||!w.isFocused()||!w.webContents.isFocused())throw Error('No focused owned window');const info=await w.webContents.executeJavaScript('window.mpHost.docInfo()');if(info.filePath!==${JSON.stringify(file)})throw Error('Wrong document owner');const edit=Menu.getApplicationMenu()?.items.find(x=>x.label==='编辑');const item=edit?.submenu?.items.find(x=>x.label===${JSON.stringify(command === 'undo' ? '撤销' : '重做')});if(!item||!item.enabled||typeof item.click!=='function')throw Error('No enabled real MenuItem');const identity={label:item.label,role:item.role,accelerator:item.accelerator,window:w.id,webContents:w.webContents.id,doc:info.filePath,focused:true};item.click({triggeredByAccelerator:false},w,w.webContents);return {ok:true,...identity};})()`);
          trace.push({ name: 'actual-main-MenuItem-click', command, ack }); entry(ack?.ok && ack.focused, 'actual enabled menu callback');
          await sleep(220); const after = await capture('06-menu-after');
          const historyTarget = e => kind === 'search' ? e.target.tag === 'INPUT' && e.target.name === 'search' : kind === 'cell' ? e.target.class === 'mp-cell-overlay-text' : /(?:^|\s)cm-content(?:\s|$)/.test(e.target.class);
          entry(ack.role ? after.events.slice(ready.events.length).some(e => e.type === 'beforeinput' && e.trusted && historyTarget(e) && e.inputType === (command === 'undo' ? 'historyUndo' : 'historyRedo')) : after.menus.slice(ready.menus.length).some(e => e.cmd === command), 'real menu IPC or native role history event reaches the proven surface');
          item.productReached = true; item.stage = 'menu-' + command;
          if (kind === 'search') assert(after.events.slice(ready.events.length).some(e => e.type === 'beforeinput' && e.trusted && historyTarget(e) && e.inputType === (command === 'undo' ? 'historyUndo' : 'historyRedo')), 'search native fallback emits trusted history input on the actual search field');
          assert.equal(after.text, afterValue, 'actual menu ' + command + ' preserves expected document history');
          if (kind === 'search') { assert.equal(after.searchValue, command === 'undo' ? 'ab' : 'abc', 'actual menu input history matches the independently proven native input unit'); assert(after.searchFocus, 'search keeps input focus'); }
          else if (kind === 'cell') { assert.equal(after.cellText, empty || command === 'undo' ? 'a|b' : 'a|中文b'); assert(after.cellFocus, 'cell keeps its focus'); assert.deepEqual(after.domSelection, { anchor: empty || command === 'undo' ? 2 : 4, head: empty || command === 'undo' ? 2 : 4 }); }
          else assert(after.editorFocus, 'body keeps editor focus');
          if (empty) {
            assert(!after.events.slice(ready.events.length).some(e => e.type === 'beforeinput' && e.trusted && /history(?:Undo|Redo)/.test(e.inputType || '')), 'empty actual menu leaves no native history input');
            // Additional real-function contract, separate from the actual menu action.
            // No input events are fabricated; the independently fresh history is a no-op.
            entry(await p.evaluate(() => typeof window.mpEngine.menuHistory === 'function'), 'empty owner contract requires the implemented engine facade');
            const handled = await p.evaluate(cmd => window.mpEngine.menuHistory(cmd), command);
            trace.push({ name: 'empty-owner-handled-API-contract', handled, scope: 'real engine no-op return contract; not a native fallback invocation counter' });
            assert.equal(handled, true, 'empty document owner remains handled rather than falling through on false/undefined command result');
            const contract = await capture('06b-empty-owner-contract'); assert.equal(contract.text, initial); assert(kind === 'cell' ? contract.cellFocus : contract.editorFocus);
          }
          // Real continuation after verified menu result. This is not an immediate callback race arm.
          await p.keyboard.insertText('R'); await sleep(150); const continued = await capture('07-continue');
          const final = kind === 'search' ? initial : kind === 'cell' ? afterValue.replace(empty || command === 'undo' ? '|a\\|b|KEEP|' : '|a\\|中文b|KEEP|', empty || command === 'undo' ? '|a\\|Rb|KEEP|' : '|a\\|中文Rb|KEEP|') : (empty || command === 'undo' ? 'R' : 'XR') + BODY;
          assert.equal(continued.text, final); if (kind === 'search') assert.equal(continued.searchValue, (command === 'undo' ? 'ab' : 'abc') + 'R');
          await waitUntil(() => fs.readFileSync(file).equals(Buffer.from(final)), 'exact final UTF-8 disk', 5000); await capture('08-saved'); item.stage = 'complete'; return { menuCallbackConfirmed: true, rendererPositiveControls: true, command, kind };
        } catch (e) { try { await capture('failure'); } catch (x) { trace.push({ name: 'failure-frame-error', error: x.message }); } throw e; }
      });
      const c = result.cases.at(-1); if (c.error?.startsWith('ENTRY_UNCONFIRMED:')) c.status = 'entry-unconfirmed'; else if (c.status === 'fail') c.failureKind = c.productReached ? 'product-check' : 'harness-or-setup';
    }
    entry(result.cases.length > 0, 'filter selects at least one known case');
  } catch (e) { result.fatal = e.stack || e.message; }
  finally {
    try { mainDebugger?.close(); } catch (e) { result.cleanupErrors.push(e.message); }
    try { if (run) result.cleanup = await run.cleanup(); } catch (e) { result.cleanupErrors.push(e.message); }
    try { release?.(); } catch (e) { result.cleanupErrors.push(e.message); }
    result.finishedAt = new Date().toISOString(); result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') && !result.fatal && !result.errors.length && !result.cleanupErrors.length && !!result.cleanup && !result.cleanup.residual.length;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
