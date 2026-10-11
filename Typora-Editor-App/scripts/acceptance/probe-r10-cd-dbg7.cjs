'use strict';
/** R10 诊断7（不入证据链）：主进程内代理 doc.save/writeCurrent/confirmDiscard/flushEditorText
 *  记调用轨迹，复刻 cd3 保存臂失败流程。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg7');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const A = path.join(OUT, '甲.md'), B = path.join(OUT, '乙.md');
  fs.writeFileSync(A, '# 甲\n\n切档靶点段：字尾在此。\n', 'utf8');
  fs.writeFileSync(B, '# 乙\n\n乙的内容段。\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg7', outDir: OUT, timeout: 200000, args: [A], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    // 装代理
    await session.main.js(`(() => {
      const d = global.windows[0].doc; global.__dbg = [];
      const t0 = Date.now();
      for (const name of ['save', 'writeCurrent', 'confirmDiscard', 'flushEditorText', 'saveAs']) {
        const orig = d[name].bind(d);
        d[name] = async (...args) => {
          const entry = { fn: name, at: Date.now() - t0, args: JSON.stringify(args).slice(0, 60), state: null };
          global.__dbg.push(entry);
          const p = orig(...args);
          Promise.resolve(p).then(v => { entry.done = true; entry.ret = JSON.stringify(v); }, e => { entry.done = true; entry.err = String(e && e.message).slice(0, 80); });
          return p;
        };
      }
      return 'proxied';
    })()`);
    await hi.ensureFocus(session);
    const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
      const root = w.document.querySelector('.vditor-ir .vditor-reset');
      const block = [...root.children].find(b => b.textContent.includes('靶点段'));
      const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
      return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
    await session.click(point.x, point.y); await sleep(240);
    await session.key({ key: 'End', code: 'End', vk: 35 }); await sleep(160);
    const typeThenMenu = async (text, files) => {
      await session.send('Input.insertText', { text });
      await session.main.script([{ dialog: 'open', files }]);
      return session.main.clickMenu('文件 > 在此窗口打开文件…');
    };
    // 对照臂
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 2 }, { dialog: 'open', files: [B] }]);
    await session.type('对照拍'); await sleep(1100);
    await session.main.clickMenu('文件 > 在此窗口打开文件…'); await sleep(2000);
    // 洗净
    await hi.combo(session, 'Ctrl+S'); await sleep(1000);
    // 主臂（fallback 取消）
    await session.main.clearCalls();
    await typeThenMenu('甲乙丙', [B]); await sleep(2600);
    // 保存臂
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 0 }, { dialog: 'open', files: [B] }]);
    await typeThenMenu('丁戊', [B]); await sleep(3000);
    console.log('calls:', JSON.stringify(await session.main.calls().catch(() => null)));
    console.log('dirty:', await session.main.js('global.windows[0].doc.dirty'));
    console.log('file:', await session.main.js('global.windows[0].doc.file'));
    console.log('trace:', JSON.stringify(await session.main.js('JSON.stringify(global.__dbg)'), null, 1).slice(0, 3000));
    console.log('diskA:', JSON.stringify(fs.readFileSync(A, 'utf8')));
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
