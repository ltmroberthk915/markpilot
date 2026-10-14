'use strict';
/* Actual renderer host autosave scheduling regression model.
 * Acorn extracts exact current function bytes; no copied implementation or GUI.
 * --baseline expects the historical liveness defect; default expects its repair.
 * --host <host.js> and --out <report.json> are optional. JSON report on stdout.
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const FIXED = !process.argv.includes('--baseline');
const HOST = process.argv.includes('--host') ? path.resolve(process.argv[(process.argv.indexOf('--host') + 1)]) : path.join(ROOT, 'MarkPilot-CM6', 'renderer', 'host.js');
const OUT = process.argv.includes('--out') ? path.resolve(process.argv[(process.argv.indexOf('--out') + 1)]) : null;
const acorn = require(path.join(ROOT, 'tools', 'quality', 'node_modules', 'acorn'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const NAMES = ['autoTicket', 'autoCurrent', 'retireAutosave', 'saveTrace', 'saveFailure', 'syncSource', 'scheduleSave', 'doSave', 'currentText'];
const DECLS = ['engineValue', 'SHRINK_MIN', 'SHRINK_RATIO']; // doSave references these free names; extract real declarations, never hand-copy values
const src = fs.readFileSync(HOST, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true });
const found = {};
for (const n of ast.body) {
  if (n.type === 'FunctionDeclaration' && NAMES.includes(n.id.name)) found[n.id.name] = n;
  if (n.type === 'VariableDeclaration' && n.declarations.length === 1) {
    const d = n.declarations[0];
    if (DECLS.includes(d.id.name) && d.init) found[d.id.name] = n;
  }
}
const missing = [...NAMES, ...DECLS].filter(n => !found[n]);
if (missing.length) { console.error(JSON.stringify({ fatal: 'anchor-missing', missing })); process.exit(3); }
const ALL = [...NAMES, ...DECLS];
const extracted = Object.fromEntries(ALL.map(n => [n, src.slice(found[n].start, found[n].end)]));

function makeSandbox() {
  let now = 0, seq = 0; const timers = new Map(); const saves = []; const banners = [];
  const api = { captureAllowed: true, captureCalls: 0, docSession: null, value: 'BASE\n' };
  const ctx = {
    console, Promise, Math, JSON, Number, Object, Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    crypto: { randomUUID: () => 'u' + (++seq) },
    window: {
      __mpDbg: undefined,
      mpEngine: {
        commands: { capture: () => { api.captureCalls++; return api.captureAllowed ? { ticket: true } : false; } },
        documentSession: () => api.docSession, getValue: () => api.value,
      },
      mpHost: { save: async (filePath, text, opts) => { saves.push({ at: now, filePath, text, opts }); return { ok: true, current: true, filePath }; }, docSaved: async () => ({}) },
      dispatchEvent: () => {},
    },
    showBanner: (text, actions) => { banners.push({ at: now, text, actions: (actions || []).map(a => a.label) }); },
    hideBanner: () => {}, refreshTitle: () => {}, publishDocDir: () => {},
    saveAsFlow: async () => false, reloadDocument: async () => ({ ok: false }), down: () => {}, up: () => {},
  };
  ctx.window.window = ctx.window;
  const state = `let saveTimer=0, saveInFlight=false, saveTask=null, documentId='DOC', revision=0, dirty=false, filePath='D:/x/a.md',
    saveBlocked=false, lastSaveError=null, observedSource=null, recoverySerial=0, saveAsSerial=0, autoGeneration=0,
    savePolicy={enabled:true,intervalMs:1000}, knownLen=0, charCount=0, textWaiters=[];`;
  vm.createContext(ctx);
  vm.runInContext(state + '\n' + ALL.map(n => extracted[n]).join('\n'), ctx, { filename: 'host-extract.js' });
  const io = {
    api, saves, banners, timerCount: () => timers.size,
    get: expr => vm.runInContext('(' + expr + ')', ctx),
    run: expr => vm.runInContext(expr, ctx),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { now = end; break; }
        now = due[1].at; timers.delete(due[0]);
        due[1].fn();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await new Promise(r => setImmediate(r));
        const t = io.get('saveTask'); if (t) await t.catch(() => {});
        for (let i = 0; i < 4; i++) await Promise.resolve();
      }
    },
  };
  return io;
}
const results = [];
const check = (id, expect, ok, detail) => { results.push({ id, expect, ok: !!ok, verdict: ok ? 'as-expected' : 'UNEXPECTED', detail }); };

(async () => {
  // S1 liveness: dirty with committed R, enabled/interval=1000/filePath; capture denied at first tick, then restored with NO new change.
  {
    const m = makeSandbox();
    m.api.docSession = { sourceRevision: 5, epoch: 1, len: 6 };
    m.api.value = 'BASE\nR\n';
    m.run('syncSource()');                       // committed R made doc dirty via the REAL syncSource; revision 1, observedSource stamped
    m.api.captureAllowed = false;                // commands denied (composition/cell session) — NOT a fake change, gate really closed
    m.run('scheduleSave()');
    if (m.timerCount() !== 1) throw new Error('S1 setup: pending timer not armed');
    await m.advance(1000);                       // first tick: must NOT save the denied/uncommitted path
    const afterTick = m.get('{dirty, saveTimer, revision, gen: autoGeneration}');
    const firstTickClean = (FIXED ? afterTick.saveTimer !== 0 && m.timerCount() === 1 : afterTick.saveTimer === 0) && m.saves.length === 0 && afterTick.dirty === true;
    m.api.captureAllowed = true;                 // commands allowed again; sourceRevision unchanged — no new change anywhere
    await m.advance(2500);                       // >=2 further intervals
    const saves = m.saves.length, end = m.get('{dirty, saveTimer}');
    const exact = m.saves.every(s => s.text === 'BASE\nR\n' && s.opts.automatic === true);
    if (FIXED) check('S1-fixed-liveness', 'green', firstTickClean && saves === 1 && exact && end.dirty === false && end.saveTimer === 0,
      { firstTick: afterTick, afterRestoreAndTwoIntervals: end, saves, note: 'fixed expectation: exactly one later save, clean, no poller; first denied tick still saves nothing' });
    else check('S1-baseline-liveness', 'red', firstTickClean && saves === 0 && end.dirty === true && end.saveTimer === 0,
      { firstTick: afterTick, afterRestoreAndTwoIntervals: end, saves, note: 'save() never called although enabled/dirty/filePath and capture restored; timer dead at 0' });
  }
  // S2 positive: plain committed input, capture allowed => saves once with exact bytes, automatic flag; real doSave writes knownLen.
  {
    const m = makeSandbox();
    m.api.docSession = { sourceRevision: 5, epoch: 1, len: 6 };
    m.api.value = 'BASE\nR\n';
    m.run('syncSource()'); m.run('scheduleSave()');
    await m.advance(1000);
    const end = m.get('{dirty, saveTimer, revision, knownLen}');
    check('S2-positive-plain-input', 'green', m.saves.length === 1 && m.saves[0].text === 'BASE\nR\n' && m.saves[0].opts.automatic === true && end.dirty === false && end.saveTimer === 0 && end.knownLen === 'BASE\nR\n'.length, { saves: m.saves, end });
  }
  // S3 guards — each arm first PROVES a pending timer (or proves the queue gate armed nothing), then checks the real behavior.
  {
    const g = async (id, setup, setupAsserts = false) => { const m = makeSandbox(); m.api.docSession = { sourceRevision: 5, epoch: 1, len: 6 }; m.api.value = 'BASE\nR\n'; try { m.run('syncSource()'); await setup(m); await m.advance(2600); const end = m.get('{dirty, saveTimer}'); const ok = setupAsserts ? m.get('(saveTimer)') === 0 : m.saves.length === 0; check(id, 'green', ok, { saves: m.saves.length, end }); } catch (e) { check(id, 'green', false, { setupError: String(e && e.message || e) }); } };
    await g('S3a-retire-cancels-pending-timer', async m => {
      m.run('scheduleSave()'); if (m.timerCount() !== 1) throw new Error('precondition: timer not armed');
      m.run('retireAutosave()');
      if (m.timerCount() !== 0) throw new Error('real retireAutosave left the pending timer armed');
    });
    await g('S3a2-closed-generation-blocks-stale-callback', async m => {
      m.run('scheduleSave()'); if (m.timerCount() !== 1) throw new Error('precondition: timer not armed');
      m.run('autoGeneration++'); // state isolation ONLY to keep the stale callback armed (retireAutosave also clears it); the tick's own autoCurrent generation guard is what is under test
    });
    await g('S3b-policy-off-queue-gate', async m => {
      m.run('savePolicy={...savePolicy,enabled:false}'); m.run('scheduleSave()');
      if (m.timerCount() !== 0) throw new Error('queue gate armed a timer while policy disabled');
    });
    await g('S3c-doc-replacement-blocks', async m => {
      m.run('scheduleSave()'); if (m.timerCount() !== 1) throw new Error('precondition: timer not armed');
      m.run("documentId='DOC2'");
    });
    await g('S3d-lasterror-queue-gate', async m => {
      m.run('lastSaveError="x"'); m.run('scheduleSave()');
      if (m.timerCount() !== 0) throw new Error('queue gate armed a timer while lastSaveError set');
    });
    await g('S3e-saveblocked-queue-gate', async m => {
      m.run('saveBlocked=true'); m.run('scheduleSave()');
      if (m.timerCount() !== 0) throw new Error('queue gate armed a timer while saveBlocked');
    });
    await g('S3e2-armed-then-saveblocked-blocks', async m => {
      m.run('scheduleSave()'); if (m.timerCount() !== 1) throw new Error('precondition: timer not armed');
      m.run('saveBlocked=true');  // doSave has its own saveBlocked gate (no grant) — the queued tick must refuse
    });
    await g('S3f-manual-clean-no-poller', async m => {
      m.run('scheduleSave()'); await m.advance(1000);
      const saved = m.saves.length, clean = m.get('{dirty, saveTimer}');
      if (saved !== 1 || clean.dirty !== false) throw new Error('precondition: first autosave saves=' + saved + ' state=' + JSON.stringify(clean));
      m.api.captureAllowed = false; await m.run('doSave(true)'); await m.advance(2600); // manual force while capture denied: save count must NOT grow, no retry poller
      if (m.saves.length !== saved) throw new Error('manual force saved while capture denied');
      if (m.get('(saveTimer)')) throw new Error('manual left a retry timer');
    }, true);
  }
  // S3d2 standalone: arm while clean, THEN set lastSaveError — existing contract is queue-gate only, so the queued tick saves and success clears the error.
  {
    const m = makeSandbox();
    m.api.docSession = { sourceRevision: 5, epoch: 1, len: 6 }; m.api.value = 'BASE\nR\n';
    m.run('syncSource()'); m.run('scheduleSave()');
    if (m.timerCount() !== 1) throw new Error('S3d2 setup: timer not armed');
    m.run('lastSaveError="x"');
    await m.advance(2600);
    const end = m.get('{dirty, saveTimer, lastSaveError}');
    check('S3d2-armed-then-lasterror-existing-contract-saves', 'green', m.saves.length === 1 && end.lastSaveError === null && end.dirty === false && end.saveTimer === 0,
      { saves: m.saves.length, end, note: 'existing contract: lastSaveError blocks queueing only; a tick queued while clean proceeds, saves, and success clears lastSaveError' });
  }
  // The deferred timer is bounded by the configured interval and existing policy.
  if (FIXED) {
    const denied = async () => { const m = makeSandbox(); m.api.value='BASE\nR\n'; m.api.docSession={sourceRevision:5,epoch:1,len:7}; m.run('syncSource()'); m.api.captureAllowed=false; m.run('scheduleSave()'); await m.advance(1000); if(m.timerCount()!==1||m.saves.length)throw new Error('deferred timer precondition'); return m; };
    {
      const m=await denied(); await m.advance(3000);
      check('S4-one-timer-per-interval-while-composing','green',m.timerCount()===1&&m.api.captureCalls===4&&m.saves.length===0&&m.get('revision')===1,{calls:m.api.captureCalls,timers:m.timerCount(),saves:m.saves.length});
      m.api.captureAllowed=true; await m.advance(1000); const calls=m.api.captureCalls; await m.advance(10000);
      check('S4-restored-capture-saves-once-and-stops','green',m.saves.length===1&&m.saves[0].text==='BASE\nR\n'&&m.timerCount()===0&&!m.get('dirty')&&m.api.captureCalls===calls,{saves:m.saves.length,timers:m.timerCount(),idleCaptureCalls:m.api.captureCalls-calls});
    }
    for(const [id,change] of [
      ['policy-off','savePolicy={...savePolicy,enabled:false}'],
      ['retire','retireAutosave()'],
      ['replace-doc',"documentId='DOC2'"],
      ['generation','autoGeneration++'],
      ['missing-path','filePath=null'],
      ['last-error','lastSaveError="failure"'],
      ['blocked','saveBlocked=true'],
    ]) { const m=await denied(); m.run(change); await m.advance(3000); check('S4-retry-respects-'+id,'green',m.saves.length===0&&m.timerCount()===0,{timers:m.timerCount(),saves:m.saves.length}); }
    { const m=makeSandbox(); m.api.value='BASE\nR\n'; m.run('syncSource()'); m.api.captureAllowed=false; await m.run('doSave(true)'); await m.advance(3000);check('S4-dirty-manual-denial-does-not-create-retry','green',m.saves.length===0&&m.timerCount()===0&&m.get('dirty'),{saves:m.saves.length,timers:m.timerCount()}); }
  }
  const unexpected = results.filter(r => r.verdict === 'UNEXPECTED');
  const report = {
    schema: 1, kind: 'autosave-capture-liveness-model', mode: FIXED ? 'expect-fixed' : 'baseline', at: new Date().toISOString(),
    host: { file: path.relative(ROOT, HOST), sha256: sha(fs.readFileSync(HOST)) },
    extraction: Object.fromEntries(ALL.map(n => [n, { startLine: found[n].loc.start.line, sha256: sha(extracted[n]) }])),
    scope: 'VM scheduling control-flow only; no OS IME / native compositionend / GUI claim; product not modified',
    results, summary: { asExpected: results.length - unexpected.length, unexpected: unexpected.length, liveness: FIXED ? (results[0].ok ? 'GREEN-under-fixed-expectation' : 'still-RED-under-fixed-expectation') : (results[0].ok ? 'RED-confirmed (expected)' : 'unexpectedly-green') },
  };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(unexpected.length ? 4 : 0);
})().catch(e => { console.error('model-fatal', e && e.stack || e); process.exit(3); });
