/** 127 · 拖拽图片：拖动图片本体（挪位）、图上起手拖选、图块内小抖动。
 *
 *  产品对"拖图挪位"的支持程度先记录在案；硬判据是数据安全不变量：
 *  图片引用不丢不重（保存后磁盘里恰好一次）、Ctrl+Z 能回到拖之前的源码、
 *  图上起手的拖拽不会误删内容。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = [
  '段落甲开头文字。',
  '',
  '![被拖图片](shot-blue.png)',
  '',
  '段落乙中间落脚点文字。',
  '',
].join('\n');

const IMG_POINT = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '').includes('被拖图片'));
  if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = img.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + rect.left + rect.width / 2), y: Math.round(fr.y + rect.top + rect.height / 2) }; })()`;
const TEXT_POINT = word => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  for (const block of s.children) {
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      const at = node.data.indexOf('${word}');
      if (at < 0) continue;
      const r = d.createRange(); r.setStart(node, at); r.setEnd(node, at + ${word.length});
      const rect = r.getBoundingClientRect();
      if (rect.width > 0) return { ok: true, x: Math.round(fr.x + rect.left + rect.width / 2), y: Math.round(fr.y + rect.top + rect.height / 2) };
    }
  }
  return { ok: false }; })()`;

module.exports = {
  id: '127-hi-drag-image',
  title: '拖拽图片：拖动挪位后引用恰好一次、Ctrl+Z 可回、图上起手拖选不误删',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
    const file = hi.writeDoc('drag-image.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 3 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开（图片在）', md0.includes('被拖图片'), md0.slice(0, 50));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① 把图片拖到"落脚点"文字上：记录行为，判引用不丢不重 ═══════════════════
      const img = await session.js(IMG_POINT);
      const target = await session.js(TEXT_POINT('落脚点'));
      ctx.assert('① 拿到图片与目标坐标（前置）', img.ok && target.ok, JSON.stringify({ img, target }));
      if (img.ok && target.ok) {
        await hi.drag(session, img, target, { steps: 10, after: 600 });
        const mdDrag = String(await hi.mdNow(session));
        const refs = (mdDrag.match(/被拖图片/g) || []).length;
        const domImg = await session.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelectorAll('${hi.SURFACE} img').length; })()`);
        ctx.witness('几何：拖图后的 DOM/源码', { img数: domImg, 引用数: refs, md: mdDrag.slice(0, 90) }, 'geometry');
        ctx.assert('① 拖图后引用恰好一次（不丢不重）', refs === 1 && domImg === 1, `引用=${refs} img=${domImg}`);
        ctx.assert('① 拖图后正文文字一字不少', mdDrag.includes('段落甲开头文字。') && mdDrag.includes('落脚点文字。'), mdDrag.slice(0, 90));
        await session.shot('127-after-drag');
        // Ctrl+Z：回到拖之前
        await hi.combo(session, 'Ctrl+Z');
        await hi.sleep(600);
        const mdUndo = String(await hi.mdNow(session));
        ctx.assert('① Ctrl+Z 回到拖拽前源码', mdUndo === md0, JSON.stringify(mdUndo.slice(0, 80)));
      }

      // ══ ② 图上起手拖选到文字：不许误删/误改 ════════════════════════════════════
      const img2 = await session.js(IMG_POINT);
      const text2 = await session.js(TEXT_POINT('段落甲'));
      if (img2.ok && text2.ok) {
        const mdBefore = String(await hi.mdNow(session));
        await hi.dragPath(session, [img2, { x: Math.round((img2.x + text2.x) / 2), y: Math.round((img2.y + text2.y) / 2) }, text2], { stepsPerLeg: 5, after: 500 });
        const sel = await hi.caret(session);
        ctx.witness('几何：图→文字拖选', { 选区: sel.选区.slice(0, 50), 长: sel.选区长, 折叠: sel.折叠 }, 'geometry');
        ctx.assert('② 拖选得到非折叠选区', !sel.折叠 && sel.选区长 > 0, JSON.stringify(sel));
        const mdAfter = String(await hi.mdNow(session));
        ctx.assert('② 拖选没有改动文档（图与文字原样）', mdAfter === mdBefore, JSON.stringify(mdAfter.slice(0, 80)));
        await hi.press(session, 'Escape');
        await hi.sleep(200);
      } else {
        ctx.assert('② 拖选端点坐标（前置）', false, JSON.stringify({ img2, text2 }));
      }

      // ══ ③ 图块内小抖动拖拽：图片不出块、不误删 ═════════════════════════════════
      const img3 = await session.js(IMG_POINT);
      if (img3.ok) {
        const mdBefore = String(await hi.mdNow(session));
        await hi.drag(session, img3, { x: img3.x + 12, y: img3.y + 4 }, { steps: 4, after: 400 });
        const mdAfter = String(await hi.mdNow(session));
        ctx.assert('③ 块内小拖动不改文档', mdAfter === mdBefore, JSON.stringify(mdAfter.slice(0, 80)));
        const imgNow = await session.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelectorAll('${hi.SURFACE} img').length; })()`);
        ctx.assert('③ 图片还在（img=1）', imgNow === 1, `img=${imgNow}`);
      }

      // ══ ④ 磁盘证人 ═════════════════════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      const refsDisk = (disk.match(/被拖图片/g) || []).length;
      ctx.witness('磁盘：保存', { 磁盘: disk.slice(0, 70), 引用数: refsDisk }, 'disk');
      ctx.assert('④ 磁盘 == 原文（图片引用恰好一次）',
        disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, '') && refsDisk === 1, disk.slice(0, 80));
    } finally {
      await ctx.release(session);
    }
  },
};
