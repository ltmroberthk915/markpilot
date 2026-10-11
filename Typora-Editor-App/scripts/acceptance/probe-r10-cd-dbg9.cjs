'use strict';
/** R10 诊断9（不入证据链）：完整复刻场景 72 的切换段（inspect+对话框桩），
 *  抓 open-in-window 瞬间的 dirty 成因与弹框参数。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const fixtures = require('./fixtures.cjs');
const edge = require('./edge-helpers.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-cd-dbg9');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const large = fixtures.large(), small = fixtures.small();
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-cd-dbg9', outDir: OUT, timeout: 240000, args: [large], inspect: true });
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, { timeout: 120000 });
    await sleep(2000);
    // 滚到文末（同 72）
    for (let i = 0; i < 40; i++) { await session.wheel(400, 400, 600); await sleep(50); }
    await sleep(500);
    // 同 72：Range 放到末段末尾 + 逐字键入（不保存——72 的 saveAndWait 在键入之前）
    await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
      const surface = w.document.querySelector(${JSON.stringify(edge.SURFACE)});
      const target = [...surface.children].reverse().find(block => block.textContent.trim().length > 20);
      const range = w.document.createRange(); range.selectNodeContents(target); range.collapse(false);
      const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      surface.focus({ preventScroll: true }); return true; })()`);
    for (const character of 'abcdefghij') {
      await session.js(`(() => { document.getElementById('editor').contentWindow.__type = 1; return 1; })()`);
      await session.type(character);
      await session.js('(async () => { await new Promise(r => requestAnimationFrame(r)); return 1; })()');
    }
    const snaps = [];
    for (let i = 0; i < 14; i++) {
      await sleep(500);
      const st = await session.main.js(`(() => { const c = global.windows[0].doc.current; return JSON.stringify({ t: ${'${i}'}, dirty: c.dirty, textLen: c.text.length, savedLen: c.savedText.length }); })()`.replace('${i}', i));
      snaps.push(st);
    }
    console.log('键入后 dirty 时间线（0.5s 步进）:');
    for (const s of snaps) console.log(' ', s);
    console.log('--- 触发 open-in-window（切到 small）---');
    await session.main.clearCalls();
    // 不脚本 message——桩 fallback=取消；若有框则记录其参数
    await session.jsSoft(`hostApi.invoke('open-in-window', {path: ${JSON.stringify(small)}})`).catch(e => console.log('invoke 异常:', String(e && e.message).slice(0, 80)));
    await sleep(3000);
    const st2 = await session.main.js(`JSON.stringify({dirty: global.windows[0].doc.dirty, file: global.windows[0].doc.file})`);
    const calls = await session.main.calls().catch(() => null);
    console.log('切换后主进程态:', st2);
    console.log('对话框桩记录:', JSON.stringify((calls || []).map(c => ({ kind: c.kind, title: c.options && c.options.title, msg: c.options && c.options.message }))).slice(0, 400));
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
