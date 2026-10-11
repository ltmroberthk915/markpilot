'use strict';
/** R10 诊断4（不入证据链）：cd6 负门全流程复刻（focus+Ctrl+S+quit），时间线找卡点。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg4');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md');
  fs.writeFileSync(A, '# 诊断4\n\n靶点段：字尾在此。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg4', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    // 复刻 focusTailOf：点击靶点段 + End
    await hi.ensureFocus(session);
    const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
      const root = w.document.querySelector('.vditor-ir .vditor-reset');
      const block = [...root.children].find(b => b.textContent.includes('靶点段'));
      const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
      return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
    await session.click(point.x, point.y);
    await sleep(240);
    await session.key({ key: 'End', code: 'End', vk: 35 });
    await sleep(160);
    console.log('focus ok:', JSON.stringify(await session.js(hi.FOCUS)));
    // 不键入，真键 Ctrl+S
    await hi.combo(session, 'Ctrl+S');
    await sleep(900);
    console.log('after Ctrl+S dirty:', await session.main.js('global.windows[0].doc.dirty'));
    // quit
    try { console.log('fire:', await Promise.race([session.main.js(`require('electron').app.quit(); 'fired'`), sleep(3000).then(() => 'fire-HANG')])); } catch (e) { console.log('fire err', String(e).slice(0, 80)); }
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      let pages = '?'; try { pages = (await session.pages()).length; } catch {}
      let ev = '?'; try { ev = await Promise.race([session.main.js('1+1'), sleep(900).then(() => 'HANG')]); } catch (e) { ev = 'THROW'; }
      let wins = '?'; try { wins = await Promise.race([session.main.js('global.windows.length'), sleep(900).then(() => 'HANG')]); } catch (e) { wins = 'THROW'; }
      console.log('q+' + ((i + 1) * 700) + 'ms alive=' + (session.child.exitCode === null) + ' pages=' + pages + ' eval=' + ev + ' wins=' + wins);
    }
    try { session.main.close(); } catch {}
    for (let i = 0; i < 8; i++) { await sleep(500); if (session.child.exitCode !== null) { console.log('exited +' + ((i + 1) * 500) + 'ms'); break; } }
    console.log('final alive:', session.child.exitCode === null, 'disk:', fs.readFileSync(A, 'utf8').replace(/\n/g, '\\n'));
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
