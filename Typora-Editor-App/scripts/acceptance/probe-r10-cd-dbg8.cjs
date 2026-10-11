'use strict';
/** R10 诊断8（不入证据链）：复刻 72 素材（fixtures.large），键入+保存后，
 *  对比主进程 cur.text 与渲染层 getValue()，找出 flush 会落账的差异是什么。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const fixtures = require('./fixtures.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg8');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const large = fixtures.large();
  const largeSource = fs.readFileSync(large, 'utf8');
  const small = fixtures.small();
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg8', outDir: OUT, timeout: 240000, args: [large], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 120000 });
    await sleep(2500);
    // 滚到文末（同 72 的滚轮）并点进末段键入（同 72）
    for (let i = 0; i < 40; i++) { await session.wheel(400, 400, 600); await sleep(60); }
    await sleep(600);
    await hi.ensureFocus(session);
    await hi.combo(session, 'Ctrl+End');
    await sleep(400);
    await session.type('abcdefghij'); await sleep(2500); // 等 change 推送 + 自动保存（默认开）
    const state1 = await session.main.js(`(() => { const c = global.windows[0].doc.current; return JSON.stringify({ dirty: c.dirty, textLen: c.text.length, savedLen: c.savedText.length, textEqSaved: c.text === c.savedText }); })()`);
    console.log('键入+2.5s 后主进程态:', state1);
    const pull = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const editor = w.vditor;
      return JSON.stringify({ pending: !!w.__mpInputSeen, len: editor.getValue().length }); })()`);
    console.log('渲染层 pull 读数:', pull);
    const curText = await session.main.js('global.windows[0].doc.current.text');
    const liveText = await session.js(`document.getElementById('editor').contentWindow.vditor.getValue()`);
    let at = -1; for (let i = 0; i < Math.min(curText.length, liveText.length); i++) { if (curText[i] !== liveText[i]) { at = i; break; } }
    console.log('len(cur)=' + curText.length, 'len(live)=' + liveText.length, '首个差异@' + at);
    if (at >= 0) console.log('cur : ' + JSON.stringify(curText.slice(Math.max(0, at - 30), at + 50)));
    if (at >= 0) console.log('live: ' + JSON.stringify(liveText.slice(Math.max(0, at - 30), at + 50)));
    console.log('cur尾 : ' + JSON.stringify(curText.slice(-40)));
    console.log('live尾: ' + JSON.stringify(liveText.slice(-40)));
    console.log('磁盘尾: ' + JSON.stringify(fs.readFileSync(large, 'utf8').slice(-40)));
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
