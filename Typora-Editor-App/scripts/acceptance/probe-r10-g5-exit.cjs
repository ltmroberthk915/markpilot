'use strict';
/** R10 G5 收口查验（不入证据链）：阅读态的工具栏按钮几何/可见性 + 第二次点击/ESC 能否退出。 */
const path = require('node:path');
const fs = require('node:fs');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');
const sleep = harness.sleep;

const OUT = path.join(harness.project, '.perf/probe-r10-g45-dbg');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'g5.md');
  fs.writeFileSync(file, '# G5\n\n首段锚点文字。\n\n[链接](https://example.com/x)\n\n' + Array.from({ length: 24 }, (_, i) => '段' + i + ' 阅读目标文本。').join('\n\n') + '\n', 'utf8');
  const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'r10-g5-exit', outDir: OUT, timeout: 200000, args: [file], inspect: true });
  const btnPoint = () => session.js(`(() => { const w = ${IF}; const btn = w.vditor.vditor.toolbar.elements['reading-mode']?.querySelector('button');
    if (!btn) return null; const r = btn.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect();
    const style = getComputedStyle(btn); const tb = w.document.querySelector('.vditor-toolbar');
    return { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
      btnVisible: style.visibility !== 'hidden' && r.width > 0, toolbarClass: tb ? tb.className.slice(0, 60) : null,
      toolbarRect: tb ? Math.round(tb.getBoundingClientRect().y) : null }; })()`);
  const state = () => session.js(`(() => { const w = ${IF}; return { active: !!w.vditor.__typoraReading?.active, preview: !!w.document.querySelector('.vditor-preview') }; })()`);
  try {
    await session.until(hi.readyExpr(2), { timeout: 90000 });
    await sleep(1500);
    console.log('进入前 state:', JSON.stringify(await state()), '按钮:', JSON.stringify(await btnPoint()));
    let p = await btnPoint();
    await session.click(p.x, p.y);
    for (let i = 0; i < 30 && !(await state()).active; i++) await sleep(100);
    await sleep(800);
    console.log('阅读态 state:', JSON.stringify(await state()), '按钮:', JSON.stringify(await btnPoint()));
    await session.shot('g5dbg-阅读态-full');
    // 可滚元素盘点
    console.log('可滚元素:', JSON.stringify(await session.js(`(() => { const w = ${IF}; const out = [];
      for (const el of [...w.document.querySelectorAll('.vditor-reset,.vditor-preview,pre,[contenteditable]'), w.document.scrollingElement]) {
        if (el) out.push({ cls: String(el.className).slice(0, 26), sh: el.scrollHeight, ch: el.clientHeight, st: Math.round(el.scrollTop) });
      } return out; })()`)));
    // 第二次点击同按钮
    p = await btnPoint();
    await session.click(p.x, p.y);
    await sleep(1500);
    let s2 = await state();
    console.log('第二次点击后:', JSON.stringify(s2));
    if (s2.active) {
      // ESC 兜底
      await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
      await sleep(800);
      console.log('ESC 后:', JSON.stringify(await state()));
    }
    await session.shot('g5dbg-收尾-full');
  } finally { await session.close().catch(() => {}); }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
