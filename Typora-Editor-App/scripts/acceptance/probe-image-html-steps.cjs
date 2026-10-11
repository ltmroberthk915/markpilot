/** 探针 · 裸 HTML 图块点右侧空白：事件是否被我们的 click 守卫拦住 + 光标逐步读数。
 *  用法：node scripts/acceptance/probe-image-html-steps.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-html-steps');
const IF = hi.IF;
const BODY = ['# 形状', '', '正文一行。', '', '<img src="shot-blue.png" alt="html图" width="160">', ''].join('\n');

const ARM = `(() => { const w = ${IF}, d = w.document;
  const log = w.__st = { events: [] }; const t0 = w.performance.now();
  const name = el => el ? el.nodeName + (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : '') : 'null';
  for (const type of ['mousedown', 'mouseup', 'click']) {
    w.addEventListener(type, e => log.events.push({ t: +(w.performance.now() - t0).toFixed(1), 级: 'win', type, 拦: e.defaultPrevented, target: name(e.target) }), true);
    d.addEventListener(type, e => log.events.push({ t: +(w.performance.now() - t0).toFixed(1), 级: 'doc', type, 拦: e.defaultPrevented, target: name(e.target) }), true);
  }
  const island = d.querySelector('.vditor-ir__node[data-type="html-block"] pre.vditor-ir__preview');
  if (island) island.addEventListener('click', () => log.events.push({ t: +(w.performance.now() - t0).toFixed(1), 级: '岛', type: 'click到达渲染岛', 拦: null, target: 'island' }), false);
  const irEl = d.querySelector('.vditor-ir');
  if (irEl) irEl.addEventListener('click', e => log.events.push({ t: +(w.performance.now() - t0).toFixed(1), 级: 'IR', type: 'click到达IR元素', 拦: e.defaultPrevented, target: name(e.target) }), false);
  return { ok: true }; })()`;
const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 选区: null };
  const r = sel.getRangeAt(0);
  const exp = d.querySelector('.vditor-ir__node[data-type="html-block"].vditor-ir__node--expand');
  return { 展开: !!exp, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed }; })()`;
const READLOG = `(() => { const w = ${IF}; return w.__st ? w.__st.events.map(e => e.t + ' ' + e.级 + '/' + e.type + ' 拦=' + e.拦 + ' ' + e.target) : null; })()`;

const GEO = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.right + 40), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;
const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const file = path.join(OUT, 'html-steps.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-html-steps', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1400 });
  try {
    const geom = await session.js(GEO);
    const tp = await session.js(textPointOf('正文一行'));
    await session.click(tp.x, tp.y); await harness.sleep(250);
    await session.js(ARM);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom.x, y: geom.y, button: 'left', buttons: 1, clickCount: 1 });
    await harness.sleep(100);
    const 按下后 = await session.js(READ);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom.x, y: geom.y, button: 'left', buttons: 0, clickCount: 1 });
    await harness.sleep(80);
    const 抬起后 = await session.js(READ);
    await harness.sleep(400);
    const 稳定后 = await session.js(READ);
    const 日志 = await session.js(READLOG);
    console.log(JSON.stringify({ 几何: geom, 按下后, 抬起后, 稳定后, 日志 }, null, 1));
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify({ 几何: geom, 按下后, 抬起后, 稳定后, 日志 }, null, 2));
  } finally {
    await ctx.release(session);
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
