/** 探针 · 图片交互的**真屏 2 倍放大**验收图（用户口径四条里的"看图为证"）。
 *
 *  拍三张（每张都带真屏原图 + 2x 放大）：
 *    A 连点 3 次之后：源码必须展开（截图里能看见 `![靶图](shot-blue.png)` 那一行）；
 *    B 点图片右侧空白之后：光标在图片之后（真屏能拍到原生光标，贴在图片右缘）；
 *    C 截图粘贴（整栏宽）→ 点图下方空白 → 回车 → 光标停在新行。
 *  用法：node scripts/acceptance/probe-image-accept-shots.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-accept-shots');
const IF = hi.IF;
const BODY = ['# 图片交互验收', '', '前文甲。', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const PS = (script, args) => execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args], { encoding: 'utf8', windowsHide: true });

const GEO = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  const 区 = { x: Math.max(0, Math.round(frame.x + r.left) - 40), y: Math.max(0, Math.round(frame.y + r.top) - 40),
    w: Math.round(r.width) + 320, h: Math.round(r.height) + 140 };
  return { ok: true, 中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
    右外30: { x: Math.round(frame.x + r.right + 30), y: Math.round(frame.y + r.top + r.height / 2) },
    图下12: { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.bottom + 12) },
    展开: !!owner && owner.classList.contains('vditor-ir__node--expand'), 区 }; })()`;

const 文本点 = 词 => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

const 读 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}'); const sel = w.getSelection();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  const 展开 = !!owner && owner.classList.contains('vditor-ir__node--expand');
  if (!sel || !sel.rangeCount) return { 展开, 光标: null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const ib = r.getBoundingClientRect();
  return { 展开, 光标: { 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName, 偏移: r.startOffset,
    在节点内: !!(at && owner && owner.contains(at)), 盒: [Math.round(ib.left), Math.round(ib.top), Math.round(ib.width), Math.round(ib.height)] } }; })()`;

async function 真屏(session, 标签, 区) {
  const info = await session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    return {content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor}; })()`);
  const 真 = path.join(OUT, 标签 + '-真屏.png');
  await session.main.js(`(() => { const {BrowserWindow} = require('electron');
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
  await hi.sleep(420);
  PS('win-screen-crop-xy.ps1', ['-Out', 真,
    '-X', String(Math.round((info.content.x + 区.x) * info.scale)), '-Y', String(Math.round((info.content.y + 区.y) * info.scale)),
    '-W', String(Math.round(区.w * info.scale)), '-H', String(Math.round(区.h * info.scale))]);
  await session.main.js(`(() => { const {BrowserWindow} = require('electron');
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    win.setAlwaysOnTop(false); return 1; })()`);
  const 真2 = 真.replace('-真屏.png', '-真屏-2x.png');
  PS('win-png-zoom.ps1', ['-In', 真, '-Out', 真2, '-Factor', '2']);
  return 真2;
}

async function 连点(session, 点, 次数) {
  for (let i = 1; i <= 次数; i++) {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: i });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: i });
    if (i < 次数) await hi.sleep(50);
  }
  await hi.sleep(400);
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const file = path.join(OUT, 'accept-shots.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-accept-shots', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1400, inspect: true });
  try {
    await hi.ensureFocus(session);
    const 文 = await session.js(文本点('前文甲'));
    const g = await session.js(GEO);
    console.log('几何', JSON.stringify({ 中心: g.中心, 右外30: g.右外30, 图下12: g.图下12, 区: g.区 }));
    console.log('A 图（连点 3 次后）', await 真屏(session, 'A-连点3次', g.区), JSON.stringify(await session.js(读)));
    await 连点(session, g.中心, 3);
    console.log('A 拍（连点 3 次后）', await 真屏(session, 'A-连点3次', g.区), JSON.stringify(await session.js(读)));
    await session.click(文.x, 文.y); await hi.sleep(320);
    await session.click(g.右外30.x, g.右外30.y); await hi.sleep(520);
    console.log('B 拍（点右空白后）', await 真屏(session, 'B-右空白', g.区), JSON.stringify(await session.js(读)));
    await session.click(文.x, 文.y); await hi.sleep(300);
    await session.click(g.图下12.x, g.图下12.y); await hi.sleep(520);
    console.log('C 拍（点图下空白后）', await 真屏(session, 'C-图下空白', g.区), JSON.stringify(await session.js(读)));
  } finally {
    await ctx.release(session);
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
