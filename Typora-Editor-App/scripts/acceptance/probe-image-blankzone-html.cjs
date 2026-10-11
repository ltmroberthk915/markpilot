/** 探针 · 裸 HTML 图块（`<img …>` 独占一段）的空白带体检：
 *  点在图片右侧 40px 时，把"命中链 / caretRangeFromPoint / 几何 / 我的判据每一步"都打出来，
 *  再打字看字落哪。
 *  用法：node scripts/acceptance/probe-image-blankzone-html.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-blankzone-html');
const IF = hi.IF;
const BODY = ['# 形状', '', '正文一行。', '', '<img src="shot-blue.png" alt="html图" width="160">', ''].join('\n');

const GEO = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect(); const s = d.querySelector('${hi.SURFACE}');
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  const ob = owner.getBoundingClientRect();
  const 点 = { x: Math.round(fr.x + r.right + 40), y: Math.round(fr.y + r.top + r.height / 2) };
  const 局点 = { x: 点.x - fr.x, y: 点.y - fr.y };
  const el = d.elementFromPoint(局点.x, 局点.y);
  const chain = []; let node = el; while (node && chain.length < 6) { chain.push(node.nodeName + '.' + String(node.className || '').split(' ').slice(0, 2).join('.') + (node.isContentEditable ? '[ed]' : '[!ed]')); node = node.parentElement; }
  const native = d.caretRangeFromPoint ? d.caretRangeFromPoint(局点.x, 局点.y) : null;
  const 原生 = native ? { 容器: native.startContainer.nodeType === 3 ? 'TEXT(' + native.startContainer.data.length + ')' : native.startContainer.nodeName,
    偏移: native.startOffset, 父链: (() => { const a = native.startContainer.nodeType === 3 ? native.startContainer.parentElement : native.startContainer;
      const out = []; let n = a; while (n && out.length < 4) { out.push(n.nodeName + '.' + String(n.className || '').split(' ').slice(0, 2).join('.')); n = n.parentElement; } return out.join('<'); })() } : null;
  return { ok: true,
    点, 局点,
    图盒: { l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), t: Math.round(fr.y + r.top), b: Math.round(fr.y + r.bottom) },
    节点盒: { l: Math.round(fr.x + ob.left), r: Math.round(fr.x + ob.right), t: Math.round(fr.y + ob.top), b: Math.round(fr.y + ob.bottom) },
    块标签: owner.parentElement === s ? '节点即块' : owner.parentElement.tagName,
    命中链: chain, 原生落点: 原生,
    展开态: owner.classList.contains('vditor-ir__node--expand'),
    target_closest_owner: el && el.closest ? (el.closest('.vditor-ir__node[data-type="img"],.vditor-ir__node[data-type="html-block"]') ? '找到了' : 'null') : '(无)' }; })()`;

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  const exp = d.querySelector('.vditor-ir__node--expand');
  if (!sel || !sel.rangeCount) return { 选区: null, 展开: !!exp };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  return { 展开: !!exp, 在编辑面内: inEditor, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed,
    层: at.closest('code') ? '源码' : at.closest('.vditor-ir__preview') ? '岛' : '正文' }; })()`;

async function clickAt(session, x, y, clickCount = 1) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}
const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const file = path.join(OUT, 'html-img.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-blankzone-html', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1400 });
  try {
    const geom = await session.js(GEO);
    console.log(JSON.stringify({ 体检: geom }, null, 1));
    const tp = await session.js(textPointOf('正文一行'));
    await clickAt(session, tp.x, tp.y); await harness.sleep(250);
    await clickAt(session, geom.点.x, geom.点.y); await harness.sleep(400);
    const 落 = await session.js(READ);
    await session.type('Z'); await harness.sleep(400);
    const md = String(await hi.mdNow(session));
    console.log(JSON.stringify({ 点击后: 落, 打Z: md.slice(0, 120), 尾: md.slice(-60) }, null, 1));
    await session.shot('html-img-点右侧打Z');
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify({ 体检: geom, 落 }, null, 2));
  } finally {
    await ctx.release(session);
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
