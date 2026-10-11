'use strict';
/** R10 诊断2（不入证据链）：取消臂→保存臂两连 quit 的时间线（pages/eval/disk/退出）。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg2');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md');
  fs.writeFileSync(A, '# 诊断2\n\n靶点段：字尾在此。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg2', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    // 键入后立即退出（复现 cd2 绿轮主臂：应弹框取消）
    await session.send('Input.insertText', { text: '甲乙丙' });
    await session.main.script([{ dialog: 'message', response: 2 }]);
    try { await session.main.js(`require('electron').app.quit(); 'fired1'`); } catch (e) { console.log('fire1 err', String(e).slice(0, 80)); }
    for (let i = 0; i < 8; i++) {
      await sleep(700);
      let pages = '?'; try { pages = (await session.pages()).length; } catch (e) { pages = 'ERR'; }
      let ev = '?'; try { ev = await Promise.race([session.main.js('1+1'), sleep(900).then(() => 'HANG')]); } catch (e) { ev = 'THROW'; }
      const calls = await Promise.race([session.main.calls().then(c => c.filter(x => x.kind === 'message').length), sleep(900).then(() => 'HANG')]).catch(() => 'ERR');
      console.log('t+' + ((i + 1) * 700) + 'ms alive=' + (session.child.exitCode === null) + ' pages=' + pages + ' eval=' + ev + ' msgCalls=' + calls);
    }
    // 第二发：选保存再退（复现保存臂）
    await session.send('Input.insertText', { text: '丁戊' });
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 0 }]);
    try {
      const r = await Promise.race([
        session.main.js(`require('electron').app.quit(); 'fired2'`),
        sleep(4000).then(() => 'fire2-HANG'),
      ]);
      console.log('fire2:', r);
    } catch (e) { console.log('fire2 err', String(e).slice(0, 80)); }
    for (let i = 0; i < 8; i++) {
      await sleep(700);
      let pages = '?'; try { pages = (await session.pages()).length; } catch (e) { pages = 'ERR'; }
      console.log('s+' + ((i + 1) * 700) + 'ms alive=' + (session.child.exitCode === null) + ' pages=' + pages + ' disk含全部=' + fs.readFileSync(A, 'utf8').includes('甲乙丙丁戊'));
    }
    try { session.main.close(); } catch {}
    for (let i = 0; i < 8; i++) { await sleep(500); if (session.child.exitCode !== null) { console.log('exited +' + ((i + 1) * 500) + 'ms'); break; } }
    console.log('final alive:', session.child.exitCode === null);
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
