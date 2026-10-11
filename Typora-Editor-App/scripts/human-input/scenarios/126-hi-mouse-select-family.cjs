/** 126 · 鼠标选区家族：双击选词→拖拽按词扩展、三击选段→Shift+↓ 跨块扩展、
 *  Shift+点击跨块选、Ctrl+点选两张图→Delete 一起删→Ctrl+Z 一起回来、
 *  跨块拖选（标题→公式段）后 Ctrl+C。
 *
 *  五通道里的"键鼠配合"与"拖拽"集中在这一场景。判据全部用户可见：选区非空且只增、
 *  公式随选区进源码、删图删得干净、撤销拿得回来、系统剪贴板读回选区内容。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = [
  '# 选区家族标题',
  '',
  '选定词所在句子还有english42混排。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '![图一](shot-red.png)',
  '',
  '![图二](shot-green.png)',
  '',
  '段落甲含公式 $m+1$ 与文字。',
  '',
  '段落乙收尾。',
  '',
].join('\n');

/** 块里某个两字词中心的顶层页坐标。 */
const wordPoint = word => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
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
const IMG_POINT = alt => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '').includes('${alt}'));
  if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = img.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + rect.left + rect.width / 2), y: Math.round(fr.y + rect.top + rect.height / 2) }; })()`;

module.exports = {
  id: '126-hi-mouse-select-family',
  title: '鼠标选区家族：双击词+按词拖拽扩展、三击段+Shift↓、Shift+点击跨块、Ctrl+点选双图删除/撤销、跨块拖选复制',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-red.png'), hi.fixtures.png(120, 80, [220, 60, 60]));
    fs.writeFileSync(path.join(hi.ROOM, 'shot-green.png'), hi.fixtures.png(140, 90, [60, 200, 110]));
    const file = hi.writeDoc('mouse-select-family.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 8 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开（含图片引用）', md0.includes('shot-red.png') && md0.includes('选定词'), md0.slice(0, 60));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① 双击选词 → 按住拖拽按词扩展 ═════════════════════════════════════════
      const word = await session.js(wordPoint('选定词'));
      ctx.assert('① 找到"选定词"坐标（前置）', word.ok, JSON.stringify(word));
      if (word.ok) {
        await session.click(word.x, word.y, { clickCount: 2 });
        await hi.sleep(300);
        const dbl = await hi.caret(session);
        ctx.witness('几何：双击后的选区', { 选区: dbl.选区, 长: dbl.选区长 }, 'geometry');
        ctx.assert('① 双击得到非折叠选区且包含选定词', !dbl.折叠 && dbl.选区.includes('选'), JSON.stringify(dbl));
        // 双击后不松手继续拖（clickCount:2 的按下 → 移动 → 抬起 = 按词扩展拖拽）
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: word.x, y: word.y, button: 'left', buttons: 1, clickCount: 2 });
        for (let step = 1; step <= 6; step++) {
          await hi.sleep(45);
          await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1,
            x: Math.round(word.x + 14 * step), y: word.y });
        }
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: word.x + 84, y: word.y, button: 'left', buttons: 0, clickCount: 2 });
        await hi.sleep(400);
        const ext = await hi.caret(session);
        ctx.witness('几何：双击+拖拽后的选区', { 选区: ext.选区, 长: ext.选区长 }, 'geometry');
        ctx.assert('① 拖拽扩展后选区比双击更大且仍含起点词', ext.选区长 > dbl.选区长 && ext.选区.includes('选'), JSON.stringify({ 双击: dbl.选区长, 拖后: ext.选区长 }));
        await session.shot('126-dblclick-drag');
      }

      // ══ ② 三击选段 → Shift+↓ 扩到下一块 ═══════════════════════════════════════
      const sentence = await session.js(wordPoint('english42'));
      if (sentence.ok) {
        await session.click(sentence.x, sentence.y, { clickCount: 3 });
        await hi.sleep(300);
        const tri = await hi.caret(session);
        ctx.witness('几何：三击后的选区', { 长: tri.选区长, 选区: tri.选区.slice(0, 50) }, 'geometry');
        ctx.assert('② 三击选中整段（选区不短于本段可见文本）', tri.选区长 >= 15, JSON.stringify(tri));
        await hi.press(session, 'ArrowDown', { modifiers: hi.MOD.shift });
        await hi.sleep(350);
        const grown = await hi.caret(session);
        ctx.assert('② Shift+↓ 把选区扩进下一块（包含列表项）', grown.选区长 > tri.选区长 && grown.选区.includes('列表项'), JSON.stringify({ 三击: tri.选区长, 扩后: grown.选区长, 含列表: grown.选区.includes('列表项') }));
        await hi.press(session, 'Escape');
        await hi.sleep(200);
      } else {
        ctx.assert('② 找到句子坐标（前置）', false, JSON.stringify(sentence));
      }

      // ══ ③ Shift+点击：从"选定词"之前跨块选到"收尾" ════════════════════════════════
      await session.js(hi.placeCaretAt(1, 0));   // 句首（"选"字之前）
      await hi.sleep(150);
      const tail = await session.js(wordPoint('收尾'));
      if (tail.ok) {
        await session.click(tail.x, tail.y, { modifiers: hi.MOD.shift });
        await hi.sleep(400);
        const shifted = await hi.caret(session);
        ctx.witness('几何：Shift+点击后的跨块选区', { 长: shifted.选区长, 选区: shifted.选区.slice(0, 70) }, 'geometry');
        ctx.assert('③ Shift+点击得到跨块非折叠选区（从句首跨到末段、跨过公式）',
          shifted.选区长 > 30 && shifted.选区.includes('选定词') && shifted.选区.includes('段落乙'), JSON.stringify(shifted));
        ctx.assert('③ 行内公式随选区进源码（选区里有 m+1 源码）', shifted.选区.includes('m+1'), JSON.stringify(shifted.选区.slice(0, 80)));
        await session.shot('126-shift-click');
        await hi.press(session, 'Escape');
        await hi.sleep(200);
      } else {
        ctx.assert('③ 找到收尾坐标（前置）', false, JSON.stringify(tail));
      }

      // ══ ④ Ctrl+点选两张图 → Delete 一起删 → Ctrl+Z 一起回 ═════════════════════
      const imgCount = async () => (await hi.fingerprint(session)).img;
      const beforeImgs = await imgCount();
      const img1 = await session.js(IMG_POINT('图一'));
      const img2 = await session.js(IMG_POINT('图二'));
      if (img1.ok && img2.ok && beforeImgs === 2) {
        await session.click(img1.x, img1.y);
        await hi.sleep(250);
        await session.click(img2.x, img2.y, { modifiers: hi.MOD.ctrl });
        await hi.sleep(300);
        await hi.press(session, 'Delete');
        await hi.sleep(500);
        const afterDel = await imgCount();
        const mdDel = String(await hi.mdNow(session));
        ctx.witness('几何：Ctrl+点选双图 Delete 后', { img: afterDel, md: mdDel.slice(0, 100) }, 'geometry');
        ctx.assert('④ Delete 把两张图一起删掉（img 数 2→0）', afterDel === 0, `img=${afterDel}`);
        await hi.combo(session, 'Ctrl+Z');
        await hi.sleep(600);
        let afterUndo = await imgCount();
        if (afterUndo !== 2) {   // 一次没拿全：再给一次撤销并记录粒度
          await hi.combo(session, 'Ctrl+Z');
          await hi.sleep(600);
          afterUndo = await imgCount();
          ctx.witness('几何：双图删除的撤销粒度', { 第一次撤销后: afterUndo, 需要两次: true }, 'geometry');
        }
        ctx.assert('④ ≤2 次 Ctrl+Z 两张图一起回来（img 数回 2）', afterUndo === 2, `img=${afterUndo}`);
      } else {
        ctx.assert('④ 两张图都在视口里（前置）', false, JSON.stringify({ img1, img2, beforeImgs }));
      }

      // ══ ⑤ 跨块拖选（正文句 → 公式段）+ Ctrl+C ═══════════════════════════════════
      const head = await session.js(wordPoint('english42'));
      const mathPara = await session.js(wordPoint('与文字'));
      if (head.ok && mathPara.ok) {
        await hi.drag(session, head, mathPara, { steps: 10, after: 500 });
        const selDrag = await hi.caret(session);
        const stable = await hi.caret(session);
        ctx.witness('几何：正文句拖到公式段的选区', { 选区: selDrag.选区.slice(0, 70), 长: selDrag.选区长 }, 'geometry');
        ctx.assert('⑤ 拖选非空且覆盖起点与终点文字', selDrag.选区长 > 20 && selDrag.选区.includes('混排') && selDrag.选区.includes('公式'),
          JSON.stringify(selDrag));
        ctx.assert('⑤ 松手后选区稳定（不悄悄收窄）', stable.选区长 === selDrag.选区长, JSON.stringify({ 松手: selDrag.选区长, 复查: stable.选区长 }));
        await hi.combo(session, 'Ctrl+C');
        const clip = await hi.edge.readClipboardUntil(ctx.outDir, data => String(data.text || '').includes('english42'), { timeout: 12000 });
        ctx.witness('剪贴板：跨块拖选 Ctrl+C', { text: String(clip.text || '').slice(0, 60) }, 'clipboard');
        ctx.assert('⑤ 剪贴板里有拖选内容', String(clip.text || '').includes('列表项一'), JSON.stringify(String(clip.text || '').slice(0, 60)));
        await hi.press(session, 'Escape');
        await hi.sleep(200);
      } else {
        ctx.assert('⑤ 拖选端点坐标（前置）', false, JSON.stringify({ head, mathPara }));
      }

      // ══ ⑥ 磁盘证人：全程只选不改 ══════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：选区家族全程保存', { 磁盘长: disk.length }, 'disk');
      ctx.assert('⑥ 磁盘 == 原文（撤销已把删图还原）',
        disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 80));
    } finally {
      await ctx.release(session);
    }
  },
};
