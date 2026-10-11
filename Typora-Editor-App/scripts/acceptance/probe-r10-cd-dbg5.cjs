'use strict';
/** R10 诊断5（不入证据链）：cd3 绿轮保存臂（切档+保存）为何没切/没写。逐步读数。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg5');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md'), B = path.join(OUT, '乙.md');
  fs.writeFileSync(A, '# 甲\n\n切档靶点段：字尾在此。\n', 'utf8');
  fs.writeFileSync(B, '# 乙\n\n乙的内容段。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg5', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  const state = async tag => {
    const recs = await Promise.race([session.recs(), sleep(2500).then(() => null)]).catch(() => null);
    const calls = await Promise.race([session.main.calls().then(c => c.map(x => ({ kind: x.kind, msg: (x.options || {}).message || null }))), sleep(2500).then(() => null)]).catch(() => null);
    const md = await Promise.race([hi.mdNow(session), sleep(2500).then(() => null)]).catch(() => null);
    console.log(tag, JSON.stringify({ recs: recs && recs.map(r => ({ file: r.file && r.file.split('\\').pop(), dirty: r.dirty })), calls, mdTail: typeof md === 'string' ? md.slice(-24) : md }));
  };
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    await hi.ensureFocus(session);
    const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
      const root = w.document.querySelector('.vditor-ir .vditor-reset');
      const block = [...root.children].find(b => b.textContent.includes('靶点段'));
      const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
      return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
    await session.click(point.x, point.y); await sleep(240);
    await session.key({ key: 'End', code: 'End', vk: 35 }); await sleep(160);
    // 主臂（取消）：键入→立即菜单（message=2 取消 + open=B）
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 2 }, { dialog: 'open', files: [B] }]);
    await session.send('Input.insertText', { text: '甲乙丙' });
    const clicked1 = await session.main.clickMenu('文件 > 在此窗口打开文件…');
    console.log('main-arm clicked:', clicked1);
    await sleep(2200);
    await state('after main-arm(cancel):');
    // 保存臂：再键入→菜单（message=0 保存 + open=B）
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 0 }, { dialog: 'open', files: [B] }]);
    const focus = await session.js(hi.FOCUS);
    await session.send('Input.insertText', { text: '丁戊' });
    const ack = Date.now();
    const clicked2 = await session.main.clickMenu('文件 > 在此窗口打开文件…');
    console.log('save-arm clicked:', clicked2, 'gap=' + (Date.now() - ack) + 'ms focus-before-type=' + JSON.stringify(focus));
    await sleep(3000);
    await state('after save-arm(save+B):');
    console.log('disk A:', JSON.stringify(fs.readFileSync(A, 'utf8')));
    console.log('disk B:', JSON.stringify(fs.readFileSync(B, 'utf8')));
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
