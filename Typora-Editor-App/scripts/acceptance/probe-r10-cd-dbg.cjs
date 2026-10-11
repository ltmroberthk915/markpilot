'use strict';
/** R10 诊断（不入证据链）：观测修后 quit 状态机为何不退出。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md');
  fs.writeFileSync(A, '# 诊断\n\n靶点段：字尾在此。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    console.log('ready');
    const fire = session.main.js(`(() => { require('electron').app.quit(); return 'fired'; })()`).catch(e => 'eval-err:' + String(e).slice(0, 60));
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      let state = null;
      try {
        state = await Promise.race([
          session.main.js(`JSON.stringify({ qc: (()=>{try{return quitChecking}catch(e){return '?'}})(), qf: (()=>{try{return quitConfirmed}catch(e){return '?'}})(), q: (()=>{try{return quitting}catch(e){return '?'}})(), wins: global.windows.length, closing: global.windows.map(r=>!!r.closing), dirty: global.windows.map(r=>!!r.doc.dirty) })`),
          sleep(1200).then(() => 'EVAL-HANG'),
        ]);
      } catch (e) { state = 'eval-err:' + String(e).slice(0, 60); }
      const alive = session.child.exitCode === null;
      console.log(`t+${(i + 1) * 500}ms alive=${alive} ${state}`);
      if (!alive) break;
    }
    console.log('fire result:', await fire);
    // 断开调试器后再等退出
    try { session.main.close(); } catch {}
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (session.child.exitCode !== null) { console.log(`exited after inspector-close +${(i + 1) * 500}ms`); break; }
    }
    console.log('final alive:', session.child.exitCode === null);
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('dbg fail:', e); process.exit(1); });
