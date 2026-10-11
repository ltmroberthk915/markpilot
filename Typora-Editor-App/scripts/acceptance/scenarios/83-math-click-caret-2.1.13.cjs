/** 2.1.13 回归：点行内公式渲染结果的光标落点。
 *
 *  用户报告（2026-09-14）：「这句话点在最后一个 `）` 像素上，也会导致光标跑到这行的最开始」
 *  并强调「只是数学公式的问题」。逐字扫描、8 种选区状态、真键鼠注入都没能在 `）` 上复现；
 *  但在**公式自身的渲染结果**上复现了同一形状的缺陷，而且它是**确定性的**：
 *
 *  根因（scripts/acceptance/probe-paren10.cjs 在同一事件序列上取证）：
 *    · 落在 `.vditor-ir__preview`（KaTeX 渲染结果）上的点击由 math-source-map.js 接管；
 *    · 按下之后 refreshMathEditing 立刻把这条公式翻成展开态，渲染结果随即量不出字形矩形
 *      ——同一个点：mousedown 时算出 offset=1，mouseup/click 时算出 **null**；
 *    · 旧实现的兜底是 `placeCaret(code, 0)`：**一律**把光标扔到这条公式源码的第 0 位。
 *  量测（用户文档第 227 行的 `$f=f^+-f^-$`，沿渲染框每 4px 取一点、共 23 点）：
 *    修前 offset 序列 [0,0,0,0,1,1,1,0,2,2,2,4,4,0,5,5,5,5,6,6,6,8,8]——6 点落在 offset 0
 *    （**右半也有 1 点**），两次回退；修后 [0,0,0,1,1,1,1,1,2,…] 零回退、右半零落点。
 *  修法：按下那一刻就把落点映射成源码偏移（那时版面正是用户瞄准的版面），click 时不再重算。
 *
 *  判据（用户可见）：点公式渲染结果的哪一带，光标就该落在那一带。这里按**几何**取点
 *  ——每个字形矩形的中心 + 相邻字形之间那道缝的中点（用户点的就是这两类地方），
 *  然后断言"光标偏移随落点 x 单调不减"且右半绝不允许回到公式最前面。
 *  独立证人：点完之后磁盘上的源文件必须一个字节没动（点击不许改文档）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '83-math-click-caret-2.1.13',
  title: '点行内公式渲染结果：光标落在点的那一带（不许跑到公式最前面）',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '83-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const fixture = ['# 公式点击落点', '', '行内公式 $f=f^+-f^-$ 在句子中间，后面还有字。', ''].join('\n');
    const file = path.join(dir, '公式点击落点.md');
    fs.writeFileSync(file, fixture);
    const before = fs.readFileSync(file);

    const session = await ctx.launch({args: [file]});
    try {
      // 必须等**我们这份 KaTeX 构建**把字形位置映射打上（没有它就没有可点的字形）
      const ready = await session.until(`(() => { const w = ${IF}; const doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]'))
          .find(n => n.getBoundingClientRect().width > 1);
        return !!leaf; })()`, {timeout: 60000, interval: 60});
      ctx.assert('公式的字形已经渲染出可点的盒子（源码位置映射就位）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(800);

      // 取点：字形中心 + 字形之间的缝；同时记下每个字形对应的源码起点
      const plan = await session.js(`(() => { const w = ${IF}, doc = w.document, frame = document.getElementById('editor');
        const code = doc.querySelector('code[data-type="math-inline"]');
        const preview = code.closest('.vditor-ir__node').querySelector(':scope > .vditor-ir__preview');
        const leaves = [...preview.querySelectorAll('[data-typora-source-start]')].filter(n => !n.querySelector('[data-typora-source-start]'));
        const fr = frame.getBoundingClientRect();
        const glyphs = leaves.map(n => { const r = n.getBoundingClientRect();
          return {text: n.textContent, start: Number(n.getAttribute('data-typora-source-start')),
            end: Number(n.getAttribute('data-typora-source-end')),
            cx: r.left + r.width / 2, cy: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom}; })
          .filter(g => g.right - g.left > 1);
        const items = glyphs.map(g => ({kind: 'glyph', text: g.text, start: g.start, end: g.end, x: g.cx, y: g.cy}));
        const sorted = glyphs.slice().sort((a, b) => a.left - b.left);
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1], b = sorted[i];
          if (b.left - a.right > 1.5) items.push({kind: 'gap', after: a.text, before: b.text, leftStart: a.start, rightStart: b.start,
            gap: Number((b.left - a.right).toFixed(1)), x: (a.right + b.left) / 2, y: (a.top + a.bottom) / 2});
        }
        items.sort((a, b) => a.x - b.x);
        return {src: code.textContent, rendered: preview.querySelector('.language-math').getAttribute('data-math'),
          box: {x: Math.round(fr.x + preview.getBoundingClientRect().left), w: Math.round(preview.getBoundingClientRect().width)},
          items: items.map(it => ({kind: it.kind, text: it.text, start: it.start, end: it.end, gap: it.gap, leftStart: it.leftStart, rightStart: it.rightStart,
            px: Math.round(fr.x + it.x), py: Math.round(fr.y + it.y)}))}; })()`);
      ctx.witness('公式渲染结果的字形与缝隙（几何量测，落点由它决定）', {src: plan.src, rendered: plan.rendered, box: plan.box, count: plan.items.length});
      ctx.assert('渲染结果里量得出字形与缝隙（点不到字形就没法做这个断言）',
        plan.items.filter(i => i.kind === 'glyph').length >= 3, JSON.stringify(plan.items));

      const OFFSET = `(() => { const w = ${IF}, doc = w.document;
        const code = doc.querySelector('code[data-type="math-inline"]');
        const s = w.getSelection(); if (!s.rangeCount) return {inCode: false, why: 'no-range'};
        const r = s.getRangeAt(0);
        if (!code || !code.contains(r.startContainer)) return {inCode: false, where: r.startContainer.nodeType === 3 ? String(r.startContainer.data).slice(0, 12) : r.startContainer.tagName};
        const pref = doc.createRange(); pref.selectNodeContents(code); pref.setEnd(r.startContainer, r.startOffset);
        return {inCode: true, offset: pref.toString().length, collapsed: r.collapsed}; })()`;
      // 中立位：把光标放回公式**之前**的正文里，并把公式收起来——这样"没动"与"跑到别处"
      // 分得开，而且每次点击都在同一个起始状态上。
      const neutral = () => session.js(`(() => { const w = ${IF}, doc = w.document;
        const code = doc.querySelector('code[data-type="math-inline"]');
        const owner = code.closest('.vditor-ir__node');
        owner.classList.remove('vditor-ir__node--expand');
        const p = owner.parentElement;
        const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n;
        while ((n = walker.nextNode())) if (n.data.includes('行内公式')) break;
        if (!n) return false;
        const r = doc.createRange(); r.setStart(n, 0); r.collapse(true);
        const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        p.scrollIntoView({block: 'center'}); return true; })()`);

      const sweep = [];
      // 先热身点一下：验收窗口自始至终没有拿到系统焦点（harness 是后台窗口，实测
      // 编辑面 document.hasFocus() === false），**第一次**点击会先把焦点交给编辑面，
      // 这一拍的落点不由产品的映射逻辑决定（实测它停在渲染结果里）。用户手里窗口是
      // 聚焦的，不会遇到这一拍；热身把它剔除，后面每一拍才是"用户真的在点公式"。
      await neutral();
      await sleep(200);
      await session.click(plan.items[Math.floor(plan.items.length / 2)].px, plan.items[Math.floor(plan.items.length / 2)].py);
      await sleep(400);
      ctx.witness('热身点之后的落点（不算数，只为把焦点交给编辑面）', await session.js(OFFSET));
      for (const item of plan.items) {
        await neutral();
        await sleep(160);
        await session.click(item.px, item.py);
        await sleep(280);
        sweep.push({...item, ...(await session.js(OFFSET))});
      }
      ctx.witness('每个落点与它换来的光标位置', sweep.map(s => `${s.kind === 'glyph' ? '字形' + JSON.stringify(s.text) : '缝'}@x=${s.px} → 源码 offset ${s.inCode ? s.offset : '（不在源码里：' + s.where + '）'}`));

      const inCode = sweep.filter(s => s.inCode);
      ctx.assert('每个落点都把光标放进了公式源码（没有落到别处）', inCode.length === sweep.length,
        JSON.stringify(sweep.filter(s => !s.inCode)));

      // 1) 单调不减：点得越靠右，光标必须越靠后（修前有两处回退）
      const offsets = sweep.map(s => (s.inCode ? s.offset : null));
      let backslide = null;
      for (let i = 1; i < offsets.length; i++) if (offsets[i] !== null && offsets[i - 1] !== null && offsets[i] < offsets[i - 1]) backslide = {i, from: offsets[i - 1], to: offsets[i], px: sweep[i].px};
      ctx.assert('沿公式从左点到右，光标偏移**单调不减**（回退＝中途被扔回了前面，用户报的"跑到最开始"）',
        backslide === null, {backslide, offsets});

      // 2) 点字形：光标落在**这一格**上。左半边→字形之前，右半边→字形之后
      //   （2026-09-15 第 6 轮起：光标跟着落点的左右半边走，不再一律停在字形起点——
      //    用户报告"点行末，光标跑到了要点的字符再往前一格"就是这个形状）。
      const glyphs = sweep.filter(s => s.kind === 'glyph' && s.inCode);
      const wrongGlyph = glyphs.filter(s => s.offset !== s.start && s.offset !== s.end);
      ctx.assert('点某个字形：光标落在**这个字形**那一格上（字形前或字形后，不越过相邻格）', wrongGlyph.length === 0,
        JSON.stringify(wrongGlyph.map(s => s.text + '（该格 ' + s.start + '..' + s.end + '，实际 ' + s.offset + '）')));

      // 3) 点缝：只允许停在缝的两侧（前一个字形的起点或后一个字形的起点），
      //    **绝不允许**越过前面的字形跑回公式最前面。
      const gaps = sweep.filter(s => s.kind === 'gap' && s.inCode);
      const strayed = gaps.filter(s => Math.min(Math.abs(s.offset - s.leftStart), Math.abs(s.offset - s.rightStart)) > 1);
      ctx.assert('点字形之间的缝：光标停在缝边上（不再一律跑回公式源码第 0 位）', strayed.length === 0,
        JSON.stringify(strayed.map(s => '缝(' + s.leftStart + '|' + s.rightStart + ')@x=' + s.px + '→' + s.offset)));

      // 4) 右半区绝不允许回到公式最前面（用户"跑到最开始"的直接判据）+ 自证：整条扫下来真的走到底
      const box = plan.box;
      const rightHalf = sweep.filter(s => s.inCode && s.px > box.x + box.w / 2);
      ctx.assert('点公式**右半**：一次都不许把光标扔回公式最前面（offset>0）',
        rightHalf.length > 0 && rightHalf.every(s => s.offset > 0), JSON.stringify(rightHalf.map(s => s.px + '→' + s.offset)));
      const maxOffset = Math.max(...offsets.filter(o => o !== null));
      ctx.assert('自证：整条扫下来光标确实走到了公式靠后的位置（否则这个断言等于没测）',
        maxOffset >= plan.src.length - 2, {maxOffset, src: plan.src});

      await session.shot('after-sweep');
      // 独立证人：点击不许改动文档（磁盘通道）
      await sleep(2600);
      const onDisk = fs.readFileSync(file);
      ctx.witness('点完之后磁盘上的源文件（独立通道）', {bytes: onDisk.length, identical: onDisk.equals(before)});
      ctx.assert('一路点下来一个字节都没改文档（点公式只是移动光标）', onDisk.equals(before),
        {before: before.length, after: onDisk.length});
    } finally {
      await session.close();
    }
  },
};
