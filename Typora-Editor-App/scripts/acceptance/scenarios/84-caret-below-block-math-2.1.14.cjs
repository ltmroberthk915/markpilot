/** 2.1.14 回归：紧贴在块公式下面的那一行正文，点它的**上半截**不许把光标扔到行首。
 *
 *  用户报告（2026-09-14 第 5 条）：
 *    「点这个最后一个"计"字中心偏上会触发! 实测任何字的偏上都会触发, 应该是点击在行内
 *      相对高度判定的问题」
 *
 *  根因（探针 probe-paren13 在真产物 + 用户文档上逐帧取证）：`math-edit.js` 的 `blankLanding`
 *  负责把"贴着折叠块公式的空白留白"翻译成公式前/后的插入点（否则 Chromium 会把那个点解析成
 *  隐藏源码里的位置，接着一次退格就吃掉公式里一个字符）。它的纵向容差是公式盒 ±10px，
 *  而**上一块的块公式与下一段正文的盒子是紧贴的**（实测：块公式盒 y=257..387，正文盒
 *  y=387..412），于是"正文第一行字的上半截"（字形盒大约从 y=386/391 起）整段落进容差里，
 *  被当成留白 → 光标被搬到公式之后那个插入点 `(编辑器根, 92)` = **这一行的最开始**。
 *  与用户描述一字不差；也解释了他说的"跟行内相对高度有关"。
 *
 *  修法：留白在几何上就是"任何块的盒子之外"，所以 `blankLanding` 在给出结论前先看落点有没有
 *  压在**别的块**的盒子里——压着就认定是正文，交回给浏览器。
 *
 *  这个场景就把那个几何条件造出来（块公式紧贴正文），然后按**字形几何**取点断言。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '84-caret-below-block-math-2.1.14',
  title: '紧贴块公式的正文：点字的上半截不许把光标扔到行首',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '84-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const fixture = ['# 块公式下面的正文', '',
      '$$', 'a+b=c', '$$', '',
      '压在正文上的点击：这一行紧贴在块公式下面。', '',
      '$$', 'd+e=f', '$$', '',
      '第二段也紧贴在一条块公式下面。', ''].join('\n');
    const file = path.join(dir, '块公式下面的正文.md');
    fs.writeFileSync(file, fixture);
    const before = fs.readFileSync(file);

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}; const doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        const katex = [...doc.querySelectorAll('.vditor-ir .language-math')].filter(n => n.querySelector('.katex'));
        return !!leaf && katex.length >= 2; })()`, {timeout: 60000, interval: 60});
      ctx.assert('两条块公式都渲染好了（有盒子可量）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(800);

      // 先证"几何条件真的造出来了"：块公式的盒子和下一段正文的盒子是紧贴的
      const geo = await session.js(`(() => { const w = ${IF}, doc = w.document, frame = document.getElementById('editor');
        const root = doc.querySelector('.vditor-ir .vditor-reset');
        const kids = [...root.children];
        const blocks = kids.map((b, i) => ({i: i, tag: b.tagName, type: b.dataset ? (b.dataset.type || null) : null,
          top: b.getBoundingClientRect().top, bottom: b.getBoundingClientRect().bottom}));
        const para = kids.find(b => b.textContent.indexOf('压在正文上的点击') >= 0);
        const pi = kids.indexOf(para);
        const above = kids[pi - 1];
        const pr = para.getBoundingClientRect(), ar = above.getBoundingClientRect();
        const fr = frame.getBoundingClientRect();
        // 正文第一行里几个字符的字形盒（按可见字符铺）
        const flat = [], cells = [];
        const walker = doc.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        let t;
        while ((t = walker.nextNode())) {
          const par = t.parentElement; if (!par) continue;
          if (par.closest('.vditor-ir__marker') && !par.closest('code')) continue;
          if (!t.data.length) continue;
          const whole = doc.createRange(); whole.selectNodeContents(t);
          if (!whole.getClientRects().length) continue;
          for (let i = 0; i < t.data.length; i++) {
            const r = doc.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
            const b = r.getBoundingClientRect();
            if (!b || (!b.width && !b.height)) continue;
            flat.push(t.data[i]);
            cells.push({ch: t.data[i], x: b.left, y: b.top, w: b.width, h: b.height});
          }
        }
        return {paraIndex: pi, aboveType: above.dataset ? (above.dataset.type || above.tagName) : above.tagName,
          gap: Math.round(pr.top - ar.bottom), paraBox: {x: Math.round(pr.left), y: Math.round(pr.top), h: Math.round(pr.height)},
          aboveBox: {y: Math.round(ar.top), bottom: Math.round(ar.bottom)},
          frameX: fr.x, frameY: fr.y, flat: flat.join(''), cells: cells.map(c => ({ch: c.ch, x: c.x, y: c.y, w: c.w, h: c.h}))}; })()`);
      ctx.witness('段落与上一块（块公式）的纵向关系（这是 bug 咬人的几何前提）',
        {above: geo.aboveType, aboveBox: geo.aboveBox, paraBox: geo.paraBox, gapPx: geo.gap, paraIndex: geo.paraIndex});
      ctx.assert('前提成立：块公式盒子与正文盒子紧贴（间隙 ≤ 2px）', Math.abs(geo.gap) <= 2, {gap: geo.gap, above: geo.aboveType});
      ctx.assert('段落里量得出字形', geo.cells.length >= 8, {chars: geo.cells.length});

      const CARET = `(() => { const w = ${IF}, doc = w.document;
        const para = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(b => b.textContent.indexOf('压在正文上的点击') >= 0);
        const s = w.getSelection(); if (!s.rangeCount) return {ok: false, why: 'no-range'};
        const r = s.getRangeAt(0);
        const name = n => n ? (n.nodeType === 3 ? 'TEXT(' + n.data.slice(0, 12) + ')' : n.tagName + '.' + String(n.className).slice(0, 20)) : null;
        if (!para || !para.contains(r.startContainer)) return {ok: false, why: 'caret outside paragraph', at: name(r.startContainer)};
        const pref = doc.createRange(); pref.selectNodeContents(para); pref.setEnd(r.startContainer, r.startOffset);
        return {ok: true, inText: r.startContainer.nodeType === 3, at: name(r.startContainer), offset: pref.toString().replace(/\\u200b/g, '').length}; })()`;
      const neutral = () => session.js(`(() => { const w = ${IF}, doc = w.document;
        const para = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(b => b.textContent.indexOf('压在正文上的点击') >= 0);
        const walker = doc.createTreeWalker(para, NodeFilter.SHOW_TEXT); let n;
        while ((n = walker.nextNode())) if (n.data.trim().length) break;
        if (!n) return false;
        const r = doc.createRange(); r.setStart(n, 0); r.collapse(true);
        const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r); para.scrollIntoView({block: 'center'}); return true; })()`);

      const rows = [];
      // 取第 1..8 个可见字符，每个按"字的上半截"四个高度点一遍
      for (let i = 0; i < Math.min(8, geo.cells.length); i++) {
        for (const dy of [1, 2, 3, 4]) {
          await neutral();
          await sleep(110);
          const c = geo.cells[i];
          const X = Math.round(geo.frameX + c.x + c.w / 2);
          const Y = Math.round(geo.frameY + c.y + dy);
          await session.click(X, Y);
          await sleep(240);
          const at = await session.js(CARET);
          const near = at.ok && at.inText && Math.abs(at.offset - i) <= 2;
          rows.push({i, ch: c.ch, dy, px: X, py: Y, ...at, near});
        }
      }
      ctx.witness('字的上半截各高度点击后的光标（几何取点）',
        rows.map(r => `「${r.ch}」dy=${r.dy} → ${r.ok ? (r.inText ? '正文 offset ' + r.offset : '元素级位置 ' + r.at) : r.why}`));

      const texted = rows.filter(r => r.ok && r.inText);
      const elementLevel = rows.filter(r => !(r.ok && r.inText));
      ctx.assert('点正文第一行字的上半截：光标必须落在**正文的文字**里（不是元素级位置 = 行的边界）',
        elementLevel.length === 0, JSON.stringify(elementLevel.map(r => `「${r.ch}」@y=${r.py} → ${r.ok ? r.at : r.why}`)));
      const stray = texted.filter(r => Math.abs(r.offset - r.i) > 2);
      ctx.assert('光标落在**点的那个字**附近（偏移和点到的字相差 ≤2）',
        stray.length === 0, JSON.stringify(stray.map(r => `「${r.ch}」@y=${r.py} → offset ${r.offset}`)));
      ctx.assert('自证：这些落点确实覆盖了"字的上半截"（dy 1..4 都点过）',
        new Set(rows.map(r => r.dy)).size === 4, JSON.stringify([...new Set(rows.map(r => r.dy))]));

      await session.shot('after-upper-clicks');
      await sleep(2400);
      const onDisk = fs.readFileSync(file);
      ctx.witness('点完之后磁盘上的源文件（独立通道）', {bytes: onDisk.length, identical: onDisk.equals(before)});
      ctx.assert('一路点下来一个字节都没改文档', onDisk.equals(before), {before: before.length, after: onDisk.length});

      // ---------- B 组：这次修复**没有**拿走"紧贴公式插入" ----------
      // 用户追问："为何不能紧贴公式插入?"。答案是：**紧贴公式的那条路原样保留**，
      // 改掉的只是"落点其实压在正文那一行上"的情况。留白在几何上就是"任何块的盒子之外"，
      // 最典型的就是文档首块公式**上方**那条页边距（原始注释里的用例）。这里把它钉住。
      const gapFile = path.join(dir, '公式上方.md');
      fs.writeFileSync(gapFile, ['$$', 'a+b=c', '$$', '', '正文。', ''].join('\n'));
      const second = await ctx.launch({args: [gapFile]});
      try {
        const ok = await second.until(`(() => { const w = ${IF}; const doc = w && w.document; if (!doc) return false;
          const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
            .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
          return !!leaf; })()`, {timeout: 60000, interval: 60});
        ctx.assert('B：第一条块公式渲染就位', ok, 'timeout 60s');
        if (ok) {
          await sleep(700);
          const spot = await second.js(`(() => { const w = ${IF}, doc = w.document, frame = document.getElementById('editor');
            const root = doc.querySelector('.vditor-ir .vditor-reset');
            const first = root.children[0], box = first.getBoundingClientRect(), fr = frame.getBoundingClientRect();
            // 段落末尾做中立位：这样"光标有没有被搬到公式边界"看得出来
            const para = [...root.querySelectorAll('p')].find(p => p.textContent.indexOf('正文') >= 0);
            const t = (() => { const walker = doc.createTreeWalker(para, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) if (n.data.trim().length) return n; })();
            const r = doc.createRange(); r.setStart(t, t.data.length); r.collapse(true);
            const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
            return {firstType: first.dataset ? (first.dataset.type || first.tagName) : first.tagName,
              box: {top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right)},
              px: Math.round(fr.x + box.left + 40), py: Math.round(fr.y + box.top - 5)}; })()`);
          ctx.witness('B：首块公式上方那条页边距的落点', spot);
          await second.click(spot.px, spot.py);
          await sleep(300);
          const landed = await second.js(`(() => { const w = ${IF}, doc = w.document;
            const root = doc.querySelector('.vditor-ir .vditor-reset');
            const s = w.getSelection(); if (!s.rangeCount) return {none: true};
            const r = s.getRangeAt(0);
            return {isRoot: r.startContainer === root, offset: r.startOffset,
              beforeFirstBlock: r.startContainer === root && r.startOffset === 0,
              container: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.tagName}; })()`);
          ctx.witness('B：点页边距之后的光标', landed);
          ctx.assert('B：点文档首块公式**上方**的页边距，光标仍然被放到公式之前（"紧贴公式插入"这条路没被拿走）',
            landed.beforeFirstBlock === true, JSON.stringify(landed));
        }
      } finally {
        await second.close();
      }
    } finally {
      await session.close();
    }
  },
};
