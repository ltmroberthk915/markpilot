/** 探针 · 空白带点击的逐步光标：mousePressed → 读 → mouseReleased → 读 →（click）→ 读。
 *  文档：md 图独占一段在末尾（右缘 450；点 490=右外40 与 480=右外30）。
 *  用法：node scripts/acceptance/probe-image-blankband-steps.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-blankband-steps');
const IF = hi.IF;
const BODY = ['# 形状', '', '正文一行。', '', '![图](shot-blue.png)', ''].join('\n');

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  if (!sel || !sel.rangeCount) return { 选区: null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  let 块 = -1; if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; 块 = [...s.children].indexOf(top); }
  return { 块, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed,
    原生落点: (() => { const fr = document.getElementById('editor').getBoundingClientRect(); return null; })() }; })()`;

const GEO = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const 点 = { x: Math.round(frame.x + r.right + 30), y: Math.round(frame.y + r.top + r.height / 2) };
  const 局 = { x: 点.x - frame.x, y: 点.y - frame.y };
  const native = d.caretRangeFromPoint ? d.caretRangeFromPoint(局.x, 局.y) : null;
  return { ok: true, 点, 局,
    图右缘: Math.round(frame.x + r.right),
    命中: (() => { const el = d.elementFromPoint(局.x, 局.y); return el ? el.nodeName + '.' + String(el.className || '').slice(0, 30) : null; })(),
    原生落点: native ? { 容器: native.startContainer.nodeType === 3 ? 'TEXT' : native.startContainer.nodeName, 偏移: native.startOffset } : null }; })()`;

const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const file = path.join(OUT, 'steps.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-blankband-steps', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1400 });
  try {
    const geom = await session.js(GEO);
    console.log(JSON.stringify(geom));
    const tp = await session.js(textPointOf('正文一行'));
    await session.click(tp.x, tp.y); await harness.sleep(260);
    const 起点 = await session.js(READ);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom.点.x, y: geom.点.y, button: 'left', buttons: 1, clickCount: 1 });
    await harness.sleep(120);
    const 按下后 = await session.js(READ);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom.点.x, y: geom.点.y, button: 'left', buttons: 0, clickCount: 1 });
    await harness.sleep(160);
    const 抬起后 = await session.js(READ);
    await harness.sleep(300);
    const 稳定后 = await session.js(READ);
    console.log(JSON.stringify({ 起点, 按下后, 抬起后, 稳定后 }, null, 1));
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify({ geom, 起点, 按下后, 抬起后, 稳定后 }, null, 2));
  } finally {
    await ctx.release(session);
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
