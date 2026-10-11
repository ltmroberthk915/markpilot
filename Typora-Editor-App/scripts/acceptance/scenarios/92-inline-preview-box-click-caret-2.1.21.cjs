/** 2.1.21 回归：行内公式的**预渲染浮框**（展开态下浮在源码下方那片 .vditor-ir__preview）
 *  里点一个像素，光标必须落到源码的对应字符上——与"点折叠态渲染结果"同一条映射。
 *
 *  用户（2026-09-15）：
 *    「能否在inline math的预渲染框也同样建立像素级到光标的映射链接，链接的逻辑可以复用在
 *      渲染好的 in ma 的地方对于代码的映射逻辑」
 *
 *  修前实测（scripts/acceptance/probe-inline-box-map.cjs，展开后沿浮框宽度取 5 个点）：
 *    折叠态 offset 序列 [0,3,6,7,10]（那条路本来就通）
 *    浮框内 offset 序列 [null,0,0,0,null]——点公式中段光标跑到源码第 0 位；点浮框的内边距
 *    更会**把公式当场收回去**（逐帧采到 展开=false），松手再弹回来，一次点击跳两下。
 *  成因：展开态按下时我们没接（旧注释："原生选区留在只读预览里，别抢第一次点击"），落点交给
 *  浏览器自己夹——预览是 user-select:text，光标于是解进 katex 子树（映射自然读出偏移 0）；
 *  点在内边距上更被夹到框外的正文里，refreshMathEditing 见"光标不在公式里"就把 --expand 收回。
 *  修法（render/js/math-source-map.js 的 mousedown）：展开态的浮框上按下＝"在这条公式的源码里
 *  落光标"，按**按下那一刻**的版面算好映射、自己 placeCaret 并吃掉这次按下。
 *
 *  采样口径：**不按宽度比例取点**（比例的落点会正好压在字形缝上，dpr=1.5 下亚像素取整会让
 *  相邻两条路各读到缝的一侧，差 1 个偏移——那是采样的差别，不是映射的差别）。这里改成照
 *  渲染出来的**字形盒子**取点：每个被选中的字形取它左起 1/4 处（稳在左半边），两条路取的是
 *  同一个字形上的同一个相对像素 ⇒ 偏移必须逐点相等。
 *
 *  反假通过：
 *    · 自证两条路都真的点到了东西（落点对象、公式宽度与字形宽度逐点相同）；
 *    · 按下期间逐帧采样（rAF 回调之后紧接着就是绘制）：**每一帧光标都在源码里、公式都是展开态**。
 *      修前这两条都红（按住中 inCode=false / 展开=false）；
 *    · 对照：方向键在源码里移动照旧只动光标（键盘那条路不许被带坏）；
 *    · 独立证人：真实文件落盘字节不变 + 产品自己的 __typoraMathRecover 记录（拖拽那条路）；
 *    · 断言不依赖"我们复述映射规则"：主断言是**两条路逐点相同**，另加"落点必须落在它瞄的那个
 *      字形的源码区间内""最后一个字形按行末规则给源码末尾"。
 *  A/B（关掉这一版的接管必须让这个场景变红）：
 *    node -e "const fs=require('fs');const f='app/renderer/js/math-source-map.js';const t=fs.readFileSync(f,'utf8');fs.writeFileSync(f,t.replace('      event.preventDefault();\n      placeCaret(root, code, pointer.offset);',''))"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '92-inline-preview-box-click-caret-2.1.21',
  title: '行内公式预渲染浮框内的像素→光标映射：与折叠态渲染结果逐点相同、按下期间不收回',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '92-round');
    fs.mkdirSync(dir, { recursive: true });
    const IF = `document.getElementById('editor').contentWindow`;

    const FORMULA = 'a^2+b^2=c^2';
    // 第三段的公式源码长到一行的宽度装不下（实测装不下就一定跨行：开头的 $ 落在上一行行尾、
    // 源码落到下一行行首），用来钉 v2.1.22 的两条：浮框的落位基准、按下期间不许被折起来。
    const LONG_FORMULA = '\\mathbb{E}_{\\mathbb{P}}[\\mathbf{1}_{E}]=\\int \\mathbf{1}_{E}\\,d\\mathbb{P}'
      + '=\\int_{E} d\\mathbb{P}=\\mathbb{P}(E)+\\mathbb{P}(E^{c})-\\mathbb{P}(E\\cap E^{c})'
      + '+\\sum_{i=1}^{n}\\alpha_{i}\\beta_{i}\\gamma_{i}';
    const file = path.join(dir, '浮框点击映射.md');
    const source = ['# 浮框点击映射', '',
      '上面一段文字，中间夹一个行内公式 $' + FORMULA + '$ ，后面继续写点文字把版面撑开。', '',
      '下面一段也写点文字，再来一个 $\\frac{x}{2}+1$ 结尾。', '',
      '第三段：' + '用来撑满一整行的中文文字'.repeat(3).slice(0, 40) + ' $' + LONG_FORMULA + '$ 后面继续写。', ''].join('\n');
    fs.writeFileSync(file, source);
    const bytesBefore = fs.readFileSync(file);

    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
        const leaves = [...doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"] .vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]'));
        return leaves.length >= 4 && leaves.some(n => n.getBoundingClientRect().width > 1); })()`,
        { timeout: 60000, interval: 80 });
      ctx.assert('行内公式渲染出了可点的字形（有真几何才谈得上"像素到光标"）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(1200);
      ctx.assert('被测窗口在前台（否则点击送不到编辑器）', await session.foreground() === true, await session.foreground());
      if (!(await session.foreground())) return;

      // ---- 0 结构：映射属性确实挂在**预渲染框**身上 ----
      const structure = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const o = doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"]')[0];
        const preview = o.querySelector(':scope > .vditor-ir__preview'), code = o.querySelector('code[data-type="math-inline"]');
        const nm = n => n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : '');
        return {kids: [...o.children].map(n => nm(n) + (n.dataset.type ? '[' + n.dataset.type + ']' : '')),
          previewPrevIsCode: preview.previousElementSibling === code,
          locs: preview.querySelectorAll('[data-typora-source-start]').length,
          src: code.textContent, dataMath: preview.querySelector('.language-math').getAttribute('data-math')}; })()`);
      ctx.witness('结构：owner 的子元素、预览的映射属性个数', structure);
      ctx.assert('预渲染框就是这条公式的渲染结果、并且带着源码映射属性（映射与折叠态是同一份数据）',
        structure.previewPrevIsCode === true && structure.locs >= 4 && structure.dataMath === structure.src, structure);

      // ---- 仪表：逐帧采样（光标在不在源码里、公式有没有被收回去、**画面**有没有被压回渲染态）----
      // 只看 `--expand` 类是不够的：`.typora-ir-pointer` 那组 CSS 会在按下期间把展开态"只从视觉上"
      // 压回渲染态——源码 display:none、浮框 position:static，类一次都不变。所以这里同时记录
      // computed style（v2.1.22 的两条断言就钉在这上面）。
      await session.js(`(() => { const w = ${IF}, doc = w.document;
        const R = w.__ib = {on: false, frames: [], index: 0};
        const owner = () => doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"]')[R.index];
        R.arm = index => { R.index = index || 0; R.on = true; R.frames = []; return true; };
        R.stop = () => { R.on = false; return {frames: R.frames.length,
          notExpandedFrames: R.frames.filter(f => !f.expand).length,
          outsideCodeFrames: R.frames.filter(f => !f.inCode).length,
          outlineFrames: R.frames.filter(f => !f.inOwner).length,
          hiddenSrcFrames: R.frames.filter(f => f.codeDisp === 'none').length,
          staticBoxFrames: R.frames.filter(f => f.boxPos === 'static').length,
          codeDisps: [...new Set(R.frames.map(f => f.codeDisp))],
          boxPoss: [...new Set(R.frames.map(f => f.boxPos))],
          offsets: [...new Set(R.frames.map(f => f.offset))]}; };
        const tick = () => { const o = owner();
          if (R.on && o) { const code = o.querySelector('code[data-type="math-inline"]');
            const preview = o.querySelector(':scope > .vditor-ir__preview');
            const sel = w.getSelection(), rg = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
            const node = rg ? rg.startContainer : null;
            const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
            let offset = null;
            if (rg && code.contains(node)) { const p = doc.createRange(); p.selectNodeContents(code); p.setEnd(node, rg.startOffset); offset = p.toString().length; }
            R.frames.push({expand: o.classList.contains('vditor-ir__node--expand'),
              inCode: !!(rg && code.contains(node)),
              inOwner: !!(el && el.closest && el.closest('.vditor-ir__node[data-type="inline-node"]')),
              codeDisp: code ? w.getComputedStyle(code).display : 'none',
              boxPos: preview ? w.getComputedStyle(preview).position : 'none',
              offset}); }
          w.requestAnimationFrame(tick); };
        w.requestAnimationFrame(tick);
        return true; })()`);

      /** 几何：外壳视口坐标（CDP 认它）+ iframe 内坐标两套都留一份；字形按渲染出来的盒子挑。 */
      const geom = async (index = 0) => session.js(`(() => { const w = ${IF}, doc = w.document, fr = w.frameElement.getBoundingClientRect();
        const o = doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"]')[${index}];
        const preview = o.querySelector(':scope > .vditor-ir__preview');
        const code = o.querySelector('code[data-type="math-inline"]');
        const math = preview.querySelector('.language-math');
        const para = o.closest('p');
        const box = r => ({left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
          shellLeft: Math.round(fr.x + r.left), shellTop: Math.round(fr.y + r.top)});
        const leaves = [...preview.querySelectorAll('[data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]'))
          .map(n => { const r = n.getBoundingClientRect(); const b = box(r);
            return {start: Number(n.getAttribute('data-typora-source-start')), end: Number(n.getAttribute('data-typora-source-end')),
              char: code.textContent.slice(Number(n.getAttribute('data-typora-source-start')), Number(n.getAttribute('data-typora-source-end'))),
              left: b.left, top: b.top, w: b.w, h: b.h, shellLeft: b.shellLeft, shellTop: b.shellTop}; })
          .filter(x => x.w > 1 && x.h > 1);
        const paraBox = para.getBoundingClientRect();
        const fragments = [...o.getClientRects()].map(r => box(r));
        return {expand: o.classList.contains('vditor-ir__node--expand'),
          mathW: Math.round(math.getBoundingClientRect().width),
          preview: box(preview.getBoundingClientRect()), code: box(code.getBoundingClientRect()),
          fragments, firstFrag: fragments[0] || null,
          anchorStyle: {left: preview.style.left || '', top: preview.style.top || ''},
          leaves, srcLen: code.textContent.length,
          paraPoint: {x: Math.round(fr.x + paraBox.left + 20), y: Math.round(fr.y + paraBox.top + paraBox.height / 2)}}; })()`);

      const caret = async (index = 0) => session.js(`(() => { const w = ${IF}, doc = w.document;
        const o = doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="inline-node"]')[${index}];
        const code = o.querySelector('code[data-type="math-inline"]');
        const sel = w.getSelection(), rg = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        const inCode = !!(rg && code.contains(rg.startContainer));
        let offset = null;
        if (inCode) { const p = doc.createRange(); p.selectNodeContents(code); p.setEnd(rg.startContainer, rg.startOffset); offset = p.toString().length; }
        return {expand: o.classList.contains('vditor-ir__node--expand'), inCode, offset,
          selectionText: String(sel).slice(0, 40), collapsed: rg ? rg.collapsed : null}; })()`);

      /** 人手按下：按下 → 按住 250ms（这期间逐帧采样）→ 松开 → 等稳定。 */
      const pressHold = async (point, holdMs = 250, index = 0) => {
        await session.js(`(() => { return ${IF}.__ib.arm(${index}); })()`);
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(holdMs);
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(450);
        return { frames: await session.js(`(() => { return ${IF}.__ib.stop(); })()`), after: await caret(index) };
      };
      const collapseAway = async () => { const g = await geom(); await pressHold(g.paraPoint, 80); return (await geom()).expand; };
      const expandFormula = async () => {
        let g = await geom();
        if (g.expand) return g;
        await pressHold({ x: g.leaves[0].shellLeft + 2, y: g.leaves[0].shellTop + Math.round(g.leaves[0].h / 2) }, 80);
        g = await geom();
        return g.expand ? g : null;
      };

      /** 照字形盒子取点：被选中的字形取它左起 1/4 处（稳在左半边）。
       *  **行末那条字形单独算**：它按产品口径"点在最后一个字形上 → 光标落到源码末尾"给 after，
       *  与"左半边给 start"是两条不同的规则，混在一起比就没意义了。 */
      const pointAt = (g, index) => {
        const leaf = g.leaves[index];
        return {index, char: leaf.char, start: leaf.start, end: leaf.end, isTail: index === g.leaves.length - 1,
          x: Math.round(leaf.shellLeft + leaf.w * 0.25), y: Math.round(leaf.shellTop + leaf.h / 2), glyphW: leaf.w};
      };
      /** 非行末字形里等距取 4 个（行末字形由 tailRound 单独测）。 */
      const innerPoints = g => {
        const last = g.leaves.length - 2, out = [];
        const seen = new Set();
        for (let i = 0; i < 4; i++) {
          const index = Math.round(i * last / 3);
          if (seen.has(index)) continue;
          seen.add(index);
          out.push(pointAt(g, index));
        }
        return out;
      };
      /** 行末字形：点它左起 1/4 处，按口径应给**源码末尾**。 */
      const tailRound = async (label) => {
        const g = await geom();
        if (!g.expand) await expandFormula();
        const now = await geom();
        const point = pointAt(now, now.leaves.length - 1);
        const run = await pressHold({x: point.x, y: point.y}, 250);
        return {label, point, run, srcLen: now.srcLen};
      };

      // ---------- A：参照路径——折叠态点渲染结果（现成的、已知可用的那条路） ----------
      const refRuns = [];
      let refGeom = null;
      await collapseAway();
      refGeom = await geom();
      const points = innerPoints(refGeom);
      ctx.witness('A：折叠态下挑出的字形落点（左起 1/4，不含行末字形）', points);
      for (const p of points) {
        await collapseAway();
        const now = await geom();
        const here = innerPoints(now)[points.indexOf(p)];
        const run = await pressHold({x: here.x, y: here.y}, 120);
        refRuns.push(Object.assign({}, here, {offset: run.after.offset, inCode: run.after.inCode, expand: run.after.expand}));
      }
      ctx.assert('A：折叠态那条路本身通（每个落点都落在它瞄的那个字形的源码区间里）',
        refRuns.length === points.length &&
        refRuns.every(r => Number.isInteger(r.offset) && r.offset >= r.start && r.offset <= r.end) &&
        refRuns.every(r => r.inCode && r.expand),
        refRuns.map(r => ({字形: r.char, 偏移: r.offset, 区间: [r.start, r.end]})));

      // ---------- B：被测路径——展开态浮框里点**同一个字形上的同一个相对像素** ----------
      const boxRuns = [];
      const gOpen = await expandFormula();
      ctx.assert('B：点开公式后处于展开态（源码 + 浮框同时可见）', !!gOpen,
        gOpen ? {expand: gOpen.expand, box: gOpen.preview} : '没能展开');
      if (gOpen) {
        const boxPoints = innerPoints(gOpen);
        ctx.witness('B：展开态浮框里挑出的字形落点（与 A 同一个字形）', boxPoints);
        for (const p of boxPoints) {
          const now = await expandFormula();
          if (!now) { ctx.assert('B：每一轮点之前公式都应处于展开态', false, '没能展开'); break; }
          const here = innerPoints(now)[boxPoints.indexOf(p)];
          const run = await pressHold({x: here.x, y: here.y}, 250);
          boxRuns.push(Object.assign({}, here, {offset: run.after.offset, inCode: run.after.inCode, expand: run.after.expand,
            frames: run.frames, mathW: now.mathW, boxW: now.preview.w}));
          ctx.witness('B 字形「' + here.char + '」左起 1/4 处：按下期间逐帧采样与松开后的落点', {
            采样帧数: run.frames.frames, 非展开帧: run.frames.notExpandedFrames,
            光标不在源码里的帧: run.frames.outsideCodeFrames, 光标不在公式里的帧: run.frames.outlineFrames,
            帧内偏移取值: run.frames.offsets,
            松开后: {offset: run.after.offset, expand: run.after.expand, inCode: run.after.inCode}});
          ctx.assert('B「' + here.char + '」：自证——按住期间采到足够多帧（rAF 之后的绘制就是用户看到的画面）',
            run.frames.frames >= 8, {采样帧数: run.frames.frames});
          const ref = refRuns[boxPoints.indexOf(p)];
          ctx.assert('B「' + here.char + '」：浮框内的落点与折叠态同字形的落点给出**同一个源码偏移**',
            !!ref && run.after.offset === ref.offset,
            {浮框内: run.after.offset, 折叠态: ref && ref.offset, 字形: here.char, 源码区间: [here.start, here.end], 字形宽: here.glyphW});
          ctx.assert('B「' + here.char + '」：松手后光标在公式源码里、公式仍是展开态',
            run.after.inCode === true && run.after.expand === true, run.after);
          ctx.assert('B「' + here.char + '」：按下期间每一帧光标都在源码里、公式都没有被收回去',
            run.frames.notExpandedFrames === 0 && run.frames.outsideCodeFrames === 0 && run.frames.outlineFrames === 0,
            {非展开帧: run.frames.notExpandedFrames, 光标不在源码里的帧: run.frames.outsideCodeFrames, 光标不在公式里的帧: run.frames.outlineFrames});
        }
        ctx.assert('B：浮框内的落点也落在它瞄的那个字形的源码区间里（不只是"和参照一样"）',
          boxRuns.length === points.length && boxRuns.every(r => Number.isInteger(r.offset) && r.offset >= r.start && r.offset <= r.end),
          boxRuns.map(r => ({字形: r.char, 偏移: r.offset, 区间: [r.start, r.end]})));
        ctx.assert('B：四个落点的偏移序列与折叠态参照逐点相同',
          boxRuns.length === refRuns.length && JSON.stringify(boxRuns.map(r => r.offset)) === JSON.stringify(refRuns.map(r => r.offset)),
          {浮框内: boxRuns.map(r => r.offset), 折叠态: refRuns.map(r => r.offset)});
        ctx.assert('A/B：折叠态与展开态下这条渲染公式的宽度一致、同一字形的宽度也一致（取同相对像素＝取同像素）',
          new Set([refGeom.mathW, gOpen.mathW]).size === 1 &&
          JSON.stringify(boxRuns.map(r => r.glyphW)) === JSON.stringify(refRuns.map(r => r.glyphW)),
          {公式宽: [refGeom.mathW, gOpen.mathW], 字形宽: [refRuns.map(r => r.glyphW), boxRuns.map(r => r.glyphW)]});

        // ---------- B2：行末字形——点最后一个字形的左半边，按口径给源码末尾 ----------
        const tail = await tailRound('B2');
        ctx.witness('B2 行末字形：展开态点上最后一个字形的左半边', {
          字形: tail.point.char, 源码区间: [tail.point.start, tail.point.end], 源码长度: tail.srcLen,
          松开后: tail.run.after, 采样帧数: tail.run.frames.frames,
          非展开帧: tail.run.frames.notExpandedFrames, 光标不在公式里的帧: tail.run.frames.outlineFrames});
        ctx.assert('B2：点最后一个字形的左半边 → 光标落到源码**末尾**（行末口径：最后一个字形整格都算行末）',
          tail.run.after.offset === tail.srcLen && tail.run.after.inCode === true,
          {落点偏移: tail.run.after.offset, 源码长度: tail.srcLen});
        ctx.assert('B2：这一下同样不许把公式收回去', tail.run.frames.notExpandedFrames === 0 && tail.run.after.expand === true,
          {非展开帧: tail.run.frames.notExpandedFrames, 松开后展开: tail.run.after.expand});
        // 对照：折叠态那条路对行末字形给的是 start（它按"松手那一刻"的版面重算，展开后落点已经
        // 移到浮框上去了）。这里只留证人、不判红——口径差别写在交付说明里。
        await collapseAway();
        const refTailGeom = await geom();
        const refTailPoint = pointAt(refTailGeom, refTailGeom.leaves.length - 1);
        const refTailRun = await pressHold({x: refTailPoint.x, y: refTailPoint.y}, 120);
        ctx.witness('B2 对照：折叠态点行末字形（同一像素）', {字形: refTailPoint.char, 偏移: refTailRun.after.offset, 源码长度: refTailGeom.srcLen});
      }

      // ---------- C：浮框的**内边距**上按下（修前这一下会把公式收回去） ----------
      const gC = await expandFormula();
      if (gC) {
        const padPoint = { x: gC.preview.shellLeft + 3, y: gC.preview.shellTop + Math.round(gC.preview.h / 2) };
        const run = await pressHold(padPoint, 250);
        ctx.witness('C 内边距落点：按下期间逐帧采样与松开后的落点', {
          落点: padPoint, 浮框: gC.preview, 采样帧数: run.frames.frames,
          非展开帧: run.frames.notExpandedFrames, 光标不在公式里的帧: run.frames.outlineFrames,
          帧内偏移取值: run.frames.offsets, 松开后: run.after});
        ctx.assert('C：自证——按住期间采到足够多帧', run.frames.frames >= 8, {采样帧数: run.frames.frames});
        ctx.assert('C：内边距上按下也落进源码（那个像素右侧最近的字形就是第一个字形 → 偏移 0）',
          run.after.inCode === true && run.after.offset === 0, run.after);
        ctx.assert('C：内边距上按下公式**不许被收回去**（修前逐帧采到 展开=false，松手又弹回来）',
          run.frames.notExpandedFrames === 0 && run.frames.outlineFrames === 0 && run.after.expand === true,
          {非展开帧: run.frames.notExpandedFrames, 光标不在公式里的帧: run.frames.outlineFrames, 松开后展开: run.after.expand});
      }

      // ---------- D：对照——键盘在源码里移动照旧只动光标 ----------
      const gD = await expandFormula();
      if (gD) {
        const points = innerPoints(gD);
        const mid = points[Math.floor(points.length / 2)];
        await pressHold({ x: mid.x, y: mid.y }, 120);        // 先把光标放到公式中段
        const before = await caret();
        await session.key({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 });
        await sleep(300);
        const right = await caret();
        await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
        await sleep(300);
        const left = await caret();
        ctx.witness('D 键盘对照：右移一格再左移一格', {前: before, 右: right, 左: left});
        ctx.assert('D：方向键在源码里移动，公式全程保持展开、光标不出源码（键盘那条路不许被这一版带坏）',
          right.inCode === true && right.expand === true && left.inCode === true && left.expand === true, {右: right, 左: left});
        ctx.assert('D：右移一格确实把光标推进了一个字符，左移又退回来（前后偏移可见）',
          Number.isInteger(before.offset) && right.offset === before.offset + 1 && left.offset === before.offset,
          {前: before.offset, 右: right.offset, 左: left.offset});
      }

      // ---------- E：读选手势——从浮框里往右拖，仍要起得出选区 ----------
      const gE = await expandFormula();
      if (gE) {
        const from = { x: gE.leaves[0].shellLeft + Math.round(gE.leaves[0].w * 0.5), y: gE.leaves[0].shellTop + Math.round(gE.leaves[0].h / 2) };
        const to = { x: from.x + 220, y: from.y };
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 30, y: from.y, button: 'left', buttons: 1 });
        await sleep(80);
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 });
        await sleep(80);
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(500);
        const dragged = await caret();
        const recover = await session.js(`(() => { const w = ${IF}; return w.__typoraMathRecover ? JSON.parse(JSON.stringify(w.__typoraMathRecover)) : null; })()`);
        ctx.witness('E 从浮框里往右拖：选区与产品自己的 recover 记录', {选区: dragged, recover});
        ctx.assert('E：从浮框里拖拽仍然起得出选区（读选手势没被这一版弄丢）',
          dragged.collapsed === false && dragged.selectionText.length > 0, dragged);
      }

      // ---------- G：跨行公式的浮框落位（v2.1.22） ----------
      // 用户 2026-09-15 第二轮：「f^*\in[f^{\inf},f^{\sup}] 这里公式区的浮框怎么给挤到右边去了?」
      // 根因：绝对定位的包含块是 owner 的**第一个行盒片段**——源码跨行时它就是上一行行尾那个 $。
      const LONG = 2;                                  // 第三段那条长公式
      let gG = await geom(LONG);
      ctx.witness('G 跨行公式：owner 的行盒片段、源码盒、浮框盒', {
        片段数: gG.fragments.length, 片段: gG.fragments, 首片段: gG.firstFrag, 源码: gG.code, 浮框: gG.preview,
        源码长度: gG.srcLen, 内联落位样式: gG.anchorStyle});
      ctx.assert('G：前提成立——这条公式的源码确实跨了行（片段数 > 1，浮框落位才谈得上基准问题）',
        gG.fragments.length > 1, {片段数: gG.fragments.length, 片段: gG.fragments});
      if (gG.fragments.length > 1) {
        // 先点开它（点它的渲染结果）
        if (!gG.expand) await pressHold({x: gG.preview.shellLeft + 10, y: gG.preview.shellTop + Math.round(gG.preview.h / 2)}, 120, LONG);
        gG = await geom(LONG);
        ctx.assert('G：长公式点开后处于展开态', gG.expand === true, {expand: gG.expand});
        const leftGap = Math.abs(gG.preview.left - gG.code.left);
        const topGap = Math.abs(gG.preview.top - (gG.code.bottom + 4));
        ctx.witness('G 展开后：浮框 vs 源码（基准）vs 首片段（修前的基准）', {
          浮框: gG.preview, 源码: gG.code, 首片段: gG.firstFrag,
          到源码左边界差: leftGap, 到源码下沿差: topGap,
          到首片段左边界差: Math.abs(gG.preview.left - gG.firstFrag.left)});
        ctx.assert('G：浮框贴着**源码**左边界（跨行时也不许跑去上一行行尾那个 $ 的位置）',
          leftGap <= 2, {浮框left: gG.preview.left, 源码left: gG.code.left, 首片段left: gG.firstFrag.left});
        // 2026-09-19 起浮框多了一条落位规则（用户口径："只在会遮住正文时翻到源码上方"）：
        // 默认仍在源码下方（下沿 + 4px）；**会盖住下一行正文时**翻到源码上方（上沿 − 4px）。
        // 这条断言要守的仍是最初那个基准问题——浮框必须挂在**源码**自己的边上，
        // 不许跑回"上一行行尾那个 $ "（owner 的首片段）上去；所以判据改成"贴着源码上沿或下沿"。
        // 修前那种"挂在首片段下面"与两条边都差得远，照样红。
        const 上方差 = Math.abs((gG.preview.top + gG.preview.h) - (gG.code.top - 4));
        ctx.assert('G：浮框贴着**源码**自己的边（默认下沿 + 4px；会盖住正文时上沿 − 4px），不是挂在上一行下面',
          topGap <= 3 || 上方差 <= 3,
          {浮框top: gG.preview.top, 浮框bottom: gG.preview.top + gG.preview.h, 源码top: gG.code.top, 源码bottom: gG.code.bottom,
            到源码下沿差: topGap, 到源码上沿差: 上方差, 首片段bottom: gG.firstFrag.bottom});

        // ---------- H：按住这条已展开的公式，画面不许被折起来（v2.1.22） ----------
        // 「是inline math 新改的预渲染框出现了闪烁 修法和前几轮block math 类似!」
        const roundsH = [
          ['H1', '浮框里', {x: gG.preview.shellLeft + 20, y: gG.preview.shellTop + Math.round(gG.preview.h / 2)}],
          ['H2', '源码上', {x: gG.code.shellLeft + Math.round(gG.code.w * 0.3), y: gG.code.shellTop + Math.round(gG.code.h / 2)}],
        ];
        for (const [tag, label, point] of roundsH) {
          const now = await geom(LONG);
          if (!now.expand) { ctx.assert(tag + '：按下前这条公式应处于展开态', false, {expand: now.expand}); break; }
          const run = await pressHold(point, 250, LONG);
          ctx.witness(tag + '：' + label + '按住 250ms 的逐帧采样', {
            采样帧数: run.frames.frames, 非展开帧: run.frames.notExpandedFrames,
            源码被藏起来的帧: run.frames.hiddenSrcFrames, 浮框被摊回行内的帧: run.frames.staticBoxFrames,
            帧内源码display取值: run.frames.codeDisps, 帧内浮框position取值: run.frames.boxPoss,
            松开后: {expand: run.after.expand, inCode: run.after.inCode, offset: run.after.offset}});
          ctx.assert(tag + '：自证——按住期间采到足够多帧', run.frames.frames >= 8, {采样帧数: run.frames.frames});
          ctx.assert(tag + '：按下期间**一帧都没被折起来**——源码没被藏、浮框没被摊回行内（修前 43 帧里 16 帧）',
            run.frames.hiddenSrcFrames === 0 && run.frames.staticBoxFrames === 0 &&
            run.frames.notExpandedFrames === 0, {源码被藏起来的帧: run.frames.hiddenSrcFrames,
              浮框被摊回行内的帧: run.frames.staticBoxFrames, 非展开帧: run.frames.notExpandedFrames,
              源码display取值: run.frames.codeDisps, 浮框position取值: run.frames.boxPoss});
          ctx.assert(tag + '：' + label + '按完仍在展开态、光标在源码里',
            run.after.expand === true && run.after.inCode === true, run.after);
        }
      }

      // ---------- F：独立证人——真实文件落盘字节不变 ----------
      await sleep(1500);
      const bytesAfter = fs.readFileSync(file);
      ctx.witness('F 独立证人：磁盘文件的字节数与哈希', { 前: bytesBefore.length, 后: bytesAfter.length, 相同: bytesBefore.equals(bytesAfter) });
      ctx.assert('F：真实文件逐字节不变（点击只是落光标，没有改文档）', bytesBefore.equals(bytesAfter),
        { 前: bytesBefore.length, 后: bytesAfter.length });

      if (refRuns.length && boxRuns.length) {
        ctx.metric('inline-box.click-offsets-match', boxRuns.filter((r, i) => r.offset === refRuns[i].offset).length,
          { unit: '点', direction: 'higher' });
        ctx.metric('inline-box.press-frames-outside-source', boxRuns.reduce((n, r) => n + r.frames.outsideCodeFrames, 0),
          { unit: '帧', direction: 'lower' });
      }
    } finally {
      try { await session.close(); } catch {}
    }
  },
};
