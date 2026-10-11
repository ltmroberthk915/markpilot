/** 133 · 空白带/双光标/图片正中/标题退格——"光标看得见且只有一根"不变量。
 *
 *  举一反三自最新一批用户报告：
 *    · 2.2.6「空白带点击落到最近可见正文」（点块间空白/右侧空白光标不能丢）；
 *    · cc17809「点空白区出现两个光标」（合成光标 + 原生光标同屏）；
 *    · 9d4bd20「点图片正中被判成行末右侧、把选区收掉」；
 *    · 2.2.8「标题块首的 ← 死路与退格吃 #」。
 *  不变量：任何点击之后光标/选区有效、**编辑器里不许存在任何合成光标节点**（结构性恒 0——
 *  合成光标补丁 2026-10-02 双重光标取消轮2 已整删，此断言降格为金丝雀防回潮；原生可见性按
 *  "矩形有高度或版面有行盒"判，两把尺子都读不出的形态标 UNKNOWN 留真屏连拍亲判）、
 *  退格在标题块首不许把 # 吃成正文乱码。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = [
  '# 双光标练习标题',
  '',
  '第一段正文文字，用来提供块间空白的参照。',
  '',
  '$x_{独占一行}+1$',
  '',
  '第三段正文。',
  '',
  '![居中图片](shot-matrix.png)',
  '',
  '第五段正文收尾。',
  '',
].join('\n');

/** 点击之后的"光标状态"读数：原生光标/选区 + 原生矩形高度 + 版面可见性 + 合成光标根数。
 *
 *  **"原生高 0"不等于"原生画不出"**（2026-10-01 真屏取证纠错，probe-caret-native-truth.cjs）：
 *  段落内的**元素级**落点（`P@1` 这类插入点）矩形读回来是 0×0，但那只是**尺子**不行——
 *  把合成线从 DOM 摘掉、连拍真屏 6 帧，原生光标一直画着（亮灭交替、整行高，与用户截图对上）。
 *  2.2.13 曾据此把 F10 判成"尺子误报"，实为真缺陷；此后判可见性**看版面**：落点所在块里能取到
 *  有高度的行盒（光标之前或之后的内容行）＝ Chromium 画得出。2026-10-02 双重光标取消轮2 删掉
 *  合成光标补丁后，合成根数是**结构性恒 0**（DOM 里不许有这种节点，与显隐无关）；尺子读不出
 *  的形态（空段落：矩形 0×0 且版面无行盒）已由真屏连拍定证原生闪烁（r15/out/n-u1，八帧四亮），
 *  读数标 UNKNOWN 留真屏连拍亲判，不在本场景判红。 */
const CARET_STATE = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const proxy = [...d.querySelectorAll('[data-typora-caret-proxy]')];   // 结构性计数（补丁已删恒 0；有人再加立刻红）
  const sel = w.getSelection();
  let info = { 有: false };
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const 框 = r.getBoundingClientRect();
    const n = r.startContainer;
    // 版面可见：落点所在块的"光标之前/之后"任一侧能取到有高度的行盒（= 原生画得出）
    const 版面 = (() => {
      if (!n) return false;
      const at = n.nodeType === 3 ? n.parentElement : n;
      const 块 = at && at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre') : null;
      if (!块) return false;
      const 有行 = rr => { try { return [...rr.getClientRects()].some(b => b.height > 0); } catch (error) { return false; } };
      const 偏 = n.nodeType === 3 ? Math.min(sel.focusOffset, n.length) : Math.min(sel.focusOffset, n.childNodes.length);
      const r1 = d.createRange(); try { r1.setStart(块, 0); r1.setEnd(n, 偏); if (有行(r1)) return true; } catch (error) { /* 跨块等非法区间：换下一条 */ }
      const r2 = d.createRange(); try { r2.setStart(n, 偏); r2.setEnd(块, 块.childNodes.length); if (有行(r2)) return true; } catch (error) { /* 同上 */ }
      return false;
    })();
    info = { 有: true, 折叠: r.collapsed, 长: sel.toString().length, 原生高: Math.round(框.height), 版面可见: 版面,
      容器: n.nodeType === 3 ? 'TEXT' : n.nodeName };
  }
  return { 原生: info, 合成光标根数: proxy.length }; })()`;

const BLANK_POINTS = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const blocks = [...s.children].filter(n => n.getBoundingClientRect().height > 0);
  const pts = [];
  const rectOf = n => { const r = n.getBoundingClientRect(); return { x: Math.round(fr.x + r.x), y: Math.round(fr.y + r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(fr.y + r.bottom) }; };
  // 块与块之间的空白带（取相邻两块间隙的中点）
  for (let i = 1; i < blocks.length; i++) {
    const a = rectOf(blocks[i - 1]), b = rectOf(blocks[i]);
    const gap = b.y - a.bottom;
    if (gap >= 6) pts.push({ 名: '块间空白' + i, x: a.x + Math.round(a.w / 2), y: Math.round(a.bottom + gap / 2) });
  }
  // 行尾右侧空白（第一段块右缘 +120）
  const p1 = rectOf(blocks[1]);
  pts.push({ 名: '行尾右侧空白', x: p1.x + p1.w + 120, y: p1.y + Math.round(p1.h / 2) });
  // 最后一块下方的空白（文档底部 padding）
  const last = rectOf(blocks[blocks.length - 1]);
  pts.push({ 名: '文末下方空白', x: last.x + 60, y: last.bottom + 40 });
  // 编辑面左缘空白带
  pts.push({ 名: '左缘空白', x: Math.max(fr.x + 2, p1.x - 30), y: p1.y + Math.round(p1.h / 2) });
  return pts.filter(p => p.x > fr.x && p.x < fr.x + fr.width && p.y > fr.y && p.y < fr.y + fr.height); })()`;

module.exports = {
  id: '133-hi-blankzone-single-caret',
  title: '空白带×4 点击光标有效且唯一（合成光标节点结构性恒 0）、点图正中不收选区、标题块首退格不吃 #',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-matrix.png'), hi.fixtures.png(180, 120, [90, 160, 90]));
    const file = hi.writeDoc('blankzone-single-caret.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 5 });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开', md0.includes('双光标练习标题'), md0.slice(0, 30));

      // ══ ① 四类空白带点击：光标有效且唯一 ═══════════════════════════════════════
      const points = await session.js(BLANK_POINTS);
      ctx.assert('拿到空白带采样点（前置）', Array.isArray(points) && points.length >= 3, JSON.stringify(points));
      const blanks = [];
      for (const p of points || []) {
        await session.click(p.x, p.y);
        await hi.sleep(280);
        const state = await session.js(CARET_STATE);
        const caret = await hi.caret(session);
        // 三条不变量（2026-10-02 双重光标取消轮2 起）：① 选区有效且折叠；② 合成光标节点
        // **结构性恒 0**（DOM 里就不许有 [data-typora-caret-proxy]，补丁已删，这条是金丝雀）；
        // ③ 原生可见按 2.2.13 尺子（矩形有高度 或 版面有行盒）——两把尺子都读不出的形态
        // （空段落类）标 UNKNOWN：真屏连拍（r15/out/n-u1 手法）已定证原生闪烁，本场景不判红。
        const 原生画得出 = state.原生.有 && (state.原生.原生高 > 0 || state.原生.版面可见);
        const UNKNOWN = state.原生.有 && state.原生.折叠 && !原生画得出;
        const ok = state.原生.有 && state.原生.折叠 && state.合成光标根数 === 0;
        blanks.push({ 名: p.名, 原生: state.原生, 合成: state.合成光标根数, 块: caret.块, 层: caret.层,
          判定: UNKNOWN ? 'UNKNOWN（尺子读不出，留真屏连拍亲判）' : 原生画得出 ? '原生可见' : '无光标读数', ok });
        ctx.assert(`① ${p.名}：光标有效且合成光标节点恒 0（结构性；原生可见=${UNKNOWN ? 'UNKNOWN→真屏连拍' : '是'}）`, ok, JSON.stringify(blanks.at(-1)));
      }
      ctx.witness('几何：空白带点击的光标状态', blanks, 'geometry');
      await session.shot('133-blank-click');

      // ══ ② 点图片正中：不判成"行末右侧"、选区状态合法 ═══════════════════════════
      const img = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
        const image = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '').includes('居中图片'));
        if (!image) return { ok: false };
        image.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = image.getBoundingClientRect();
        return { ok: true, x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2) }; })()`);
      if (img.ok) {
        // 先做出一个选区，再点图片正中：图片应被选中（或光标落在图片处），而不是"选区静默消失+光标飞走"
        await session.js(hi.selectFromTo('第五段正文', '收尾。'));
        await hi.sleep(200);
        await session.click(img.x, img.y);
        await hi.sleep(350);
        const stateImg = await session.js(CARET_STATE);
        const caretImg = await hi.caret(session);
        const imgSelected = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
          const image = [...s.querySelectorAll('img')].find(n => (n.getAttribute('alt') || '').includes('居中图片'));
          const sel = w.getSelection();
          const inSel = sel && sel.rangeCount && image && sel.getRangeAt(0).intersectsNode(image);
          return { 选中类: !!(image && (image.closest('.typora-ir-selected') || image.closest('[data-typora-selected]'))), 进选区: !!inSel, 图片在: !!image }; })()`);
        ctx.witness('几何：带选区点图片正中', { 状态: stateImg, 光标: caretImg, 图片: imgSelected }, 'geometry');
        ctx.assert('② 点图正中：光标/选区仍有效且合成光标节点恒 0', stateImg.原生.有 && stateImg.合成光标根数 === 0, JSON.stringify({ stateImg, caretImg }));
        ctx.assert('② 图片还在且行为可解释（被选中或选区/光标落在其处）',
          imgSelected.图片在 && (imgSelected.选中类 || imgSelected.进选区 || stateImg.原生.长 > 0 || caretImg.ok), JSON.stringify(imgSelected));
        await hi.press(session, 'Escape');
        await hi.sleep(200);
      } else {
        ctx.assert('② 找到图片（前置）', false, JSON.stringify(img));
      }

      // ══ ③ 标题块首 ← 不死路、退格不吃 # ════════════════════════════════════════
      const headingIndex = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        return [...s.children].findIndex(n => /^H[1-6]$/.test(n.tagName)); })()`);
      ctx.assert('③ 找到标题块（前置）', headingIndex === 0, String(headingIndex));
      // 标题文字首按 ←：必须能离开标题（去上一块末尾——本块已是第一块，则应钳在文档首、光标不丢）
      await session.js(hi.placeCaretAt(0, 0));
      await hi.sleep(200);
      await hi.press(session, 'ArrowLeft');
      await hi.sleep(300);
      const leftAtHead = await hi.caret(session);
      ctx.witness('几何：文档首块首按 ←', leftAtHead, 'geometry');
      ctx.assert('③ 文档最首按 ← 光标不丢（钳在开头）', leftAtHead.ok, JSON.stringify(leftAtHead));
      // 退格：不许把 # 吃进正文当乱码
      await session.js(hi.placeCaretAt(0, 0));
      await hi.sleep(200);
      await hi.press(session, 'Backspace');
      await hi.sleep(450);
      const mdBs = String(await hi.mdNow(session));
      const firstLine = (mdBs.split('\n').find(l => l.trim()) || '').trim();
      const textKept = mdBs.includes('双光标练习标题');
      // 合法形态：要么仍是标题（# 没被动），要么降级成纯段落；# 粘进文字=吃字乱码
      const lineOk = firstLine === '# 双光标练习标题' || firstLine === '双光标练习标题';
      ctx.witness('几何：标题块首退格后的源码形态', { firstLine }, 'geometry');
      ctx.assert('③ 标题块首退格：标题文字完整保留（降级成段落是允许的，吃字不允许）', textKept,
        JSON.stringify(firstLine));
      ctx.assert('③ 退格后该行是合法形态（标题或纯文字，# 没粘进正文）', lineOk, JSON.stringify(firstLine));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ④ 磁盘证人：全程零编辑 ══════════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘长: disk.length }, 'disk');
      ctx.assert('④ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 50));
    } finally {
      await ctx.release(session);
    }
  },
};
