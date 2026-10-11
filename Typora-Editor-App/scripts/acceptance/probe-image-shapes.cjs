/** 探针 · 图片交互第四批：文档形状矩阵。
 *
 *  用户场景"文档最后是一个图片，点它右侧空白，回车新起一行"——把可能的形状都摆出来：
 *    m1 纯 Markdown 图在末尾（尾随换行）
 *    m2 同上但文件无尾随换行
 *    m3 带标题的 Markdown 图 ![图](x.png "t")
 *    m4 原文 HTML 图片块 <img ...>（裸 HTML 块，非可编辑岛）
 *    m5 图与文字同段的段落末尾：正文 ![图](x.png)
 *    m6 引用块里的图：> ![图](x.png)
 *    m7 列表项里的图：- ![图](x.png)
 *    m8 长文档（前面 60 段）末尾的图
 *  每个形状：点图右侧 40px → 读落点 → 回车 → 打字 Z → 读源码 → 存盘读磁盘。
 *  另 dump 图片节点的完整 DOM 与子盒，供实现参考。
 *
 *  用法：node scripts/acceptance/probe-image-shapes.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-shapes');
const IF = hi.IF;
const PAD = Array.from({ length: 60 }, (_, i) => `第${i + 1}段填充文字，用于把图片推到长文档后段。`).join('\n\n');

const SHAPES = [
  { 名: 'm1-纯md图末尾', body: ['# 形状', '', '正文一行。', '', '![图](shot-blue.png)', ''].join('\n') },
  { 名: 'm2-无尾随换行', body: ['# 形状', '', '正文一行。', '', '![图](shot-blue.png)'].join('\n') },
  { 名: 'm3-带标题图', body: ['# 形状', '', '正文一行。', '', '![图](shot-blue.png "标题字")', ''].join('\n') },
  { 名: 'm4-原始HTML图', body: ['# 形状', '', '正文一行。', '', '<img src="shot-blue.png" alt="html图" width="160">', ''].join('\n') },
  { 名: 'm5-图文同段', body: ['# 形状', '', '正文一行。', '', '正文末尾 ![图](shot-blue.png)', ''].join('\n') },
  { 名: 'm6-引用块图', body: ['# 形状', '', '正文一行。', '', '> ![图](shot-blue.png)', ''].join('\n') },
  { 名: 'm7-列表项图', body: ['# 形状', '', '正文一行。', '', '- ![图](shot-blue.png)', ''].join('\n') },
  { 名: 'm8-长文档尾图', body: ['# 形状', '', PAD, '', '![图](shot-blue.png)', ''].join('\n') },
];

const PICK = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const imgs = [...d.querySelectorAll('${hi.SURFACE} img')];
  const img = imgs[imgs.length - 1];
  if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  let top = img; while (top.parentElement && top.parentElement !== s) top = top.parentElement;
  const owner = img.closest('.vditor-ir__node[data-type]');
  return { ok: true,
    点: { x: Math.round(fr.x + r.right + 40), y: Math.round(fr.y + r.top + r.height / 2) },
    图下: { x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.bottom + 20) },
    块索引: [...s.children].indexOf(top), 块数: s.children.length, 节点类: owner ? owner.className : null,
    ownerHTML: owner ? owner.outerHTML.slice(0, 700) : null,
    子盒: owner ? [...owner.children].map(c => { const b = c.getBoundingClientRect(); return { tag: c.tagName, cls: String(c.className || '').slice(0, 40), w: Math.round(b.width), h: Math.round(b.height), editable: c.isContentEditable }; }) : null }; })()`;

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  if (!sel || !sel.rangeCount) return { 选区: null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  let 块 = -1; if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; 块 = [...s.children].indexOf(top); }
  const imgAt = at.closest ? at.closest('img') : null;
  const 层 = !inEditor ? '外' : (at.closest('code') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文');
  const h = r.getBoundingClientRect().height;
  return { 块, 层, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed, 在图上: !!imgAt, 光标高: Math.round(h) }; })()`;

async function clickAt(session, x, y, clickCount = 1) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}
async function enter(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await session.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-shapes', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); log.push(line); };

  for (const shape of SHAPES) {
    const file = path.join(OUT, shape.名 + '.md');
    fs.writeFileSync(file, shape.body, 'utf8');
    const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1300 });
    try {
      const geom = await session.js(PICK);
      if (!geom.ok) { say({ [shape.名]: '没有图片元素' }); continue; }
      // 复位：点正文（m8 的正文在很远的上方，改用第一个可见块）
      const textPoint = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const p = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('正文一行')) || d.querySelector('${hi.SURFACE} p');
        const r = p.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + Math.min(r.height / 2, 10)) }; })()`);
      await clickAt(session, textPoint.x, textPoint.y); await harness.sleep(260);
      const 前 = String(await hi.mdNow(session));
      await clickAt(session, geom.点.x, geom.点.y); await harness.sleep(320);
      const 落 = await session.js(READ);
      await enter(session); await harness.sleep(420);
      const 回车后 = String(await hi.mdNow(session));
      await session.type('Z'); await harness.sleep(420);
      const 打Z = String(await hi.mdNow(session));
      await session.shot(shape.名);
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      say({ [shape.名]: { 节点类: geom.节点类, ownerHTML: (geom.ownerHTML || '').slice(0, 150), 子盒: geom.子盒,
        落点: 落, 回车新增块: 回车后 !== 前, 打Z后尾: 打Z.slice(-60), 磁盘尾: String(saved.after).replace(/\r/g, '').slice(-60) } });
    } finally { await ctx.release(session); }
  }
  fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
