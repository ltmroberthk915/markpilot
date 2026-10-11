'use strict';
/** R10 诊断3（不入证据链）：键入后 pending/getValue 何时可见；随后 cancel-quit 是否留窗。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg3');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const PULL = `(() => { const frame = document.getElementById('editor'); const editor = frame && frame.contentWindow && frame.contentWindow.vditor;
  if (!editor) return { no: 'editor' };
  const w = frame.contentWindow;
  return { pending: !!w.__mpInputSeen, tail: String(editor.getValue()).slice(-8) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md');
  fs.writeFileSync(A, '# 诊断3\n\n靶点段：字尾在此。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg3', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    // 点击编辑器放好光标
    await session.click(300, 300);
    await sleep(300);
    await session.key({ key: 'End', code: 'End', vk: 35 });
    await sleep(200);
    const t0 = Date.now();
    await session.send('Input.insertText', { text: '甲乙丙' });
    const ack = Date.now();
    console.log('ack at', ack - t0, 'ms');
    for (const delay of [0, 30, 80, 160, 400]) {
      while (Date.now() - ack < delay) await sleep(5);
      const r = await Promise.race([session.js(PULL), sleep(1500).then(() => 'HANG')]).catch(e => 'ERR:' + String(e).slice(0, 50));
      console.log('+' + delay + 'ms→ +' + (Date.now() - ack) + 'ms 实读 pull=', JSON.stringify(r));
    }
    // cancel-quit
    await session.main.script([{ dialog: 'message', response: 2 }]);
    try { await session.main.js(`require('electron').app.quit(); 'fired'`); } catch (e) { console.log('fire err', String(e).slice(0, 80)); }
    await sleep(2500);
    let pages = '?'; try { pages = (await session.pages()).length; } catch {}
    console.log('after cancel-quit: alive=' + (session.child.exitCode === null) + ' pages=' + pages
      + ' disk含新字=' + fs.readFileSync(A, 'utf8').includes('甲乙丙'));
    try { session.main.close(); } catch {}
    await sleep(1500);
    console.log('final alive:', session.child.exitCode === null);
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
