'use strict';
/** R10 诊断6（不入证据链）：逐臂复刻 probe cd3 绿轮全流程（对照→洗净→主臂→保存臂）。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg6');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md'), B = path.join(OUT, '乙.md');
  fs.writeFileSync(A, '# 甲\n\n切档靶点段：字尾在此。\n', 'utf8');
  fs.writeFileSync(B, '# 乙\n\n乙的内容段。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg6', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  const state = async tag => {
    const recs = await Promise.race([session.recs(), sleep(2500).then(() => null)]).catch(() => null);
    const calls = await Promise.race([session.main.calls().then(c => c.map(x => ({ kind: x.kind, msg: ((x.options || {}).message || '').slice(0, 18) }))), sleep(2500).then(() => null)]).catch(() => null);
    const dirty = await Promise.race([session.main.js('global.windows[0].doc.dirty'), sleep(2500).then(() => null)]).catch(() => null);
    console.log(tag, JSON.stringify({ file: recs && recs[0] && String(recs[0].file).slice(-6), dirty, calls, disk尾: fs.readFileSync(A, 'utf8').slice(-14) }));
  };
  const typeThenMenu = async (text, files) => {
    const t0 = Date.now();
    await session.send('Input.insertText', { text });
    const ack = Date.now();
    await session.main.script([{ dialog: 'open', files }]);
    const clicked = await session.main.clickMenu('文件 > 在此窗口打开文件…');
    return { ackMs: ack - t0, gapMs: Date.now() - ack, clicked };
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
    // —— 对照臂 ——
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 2 }, { dialog: 'open', files: [B] }]);
    await session.type('对照拍'); await sleep(1100);
    console.log('contrast clicked:', await session.main.clickMenu('文件 > 在此窗口打开文件…'));
    await sleep(2000); await state('after contrast:');
    // —— 洗净 ——
    await hi.combo(session, 'Ctrl+S'); await sleep(1000);
    await state('after clean Ctrl+S:');
    // —— 主臂（立即，fallback 取消）——
    await session.main.clearCalls();
    const main = await typeThenMenu('甲乙丙', [B]);
    console.log('main:', JSON.stringify(main));
    await sleep(2600); await state('after main-arm:');
    // —— 保存臂 ——
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 0 }, { dialog: 'open', files: [B] }]);
    const save = await typeThenMenu('丁戊', [B]);
    console.log('save:', JSON.stringify(save));
    await sleep(2800); await state('after save-arm:');
    console.log('diskA:', JSON.stringify(fs.readFileSync(A, 'utf8')));
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
