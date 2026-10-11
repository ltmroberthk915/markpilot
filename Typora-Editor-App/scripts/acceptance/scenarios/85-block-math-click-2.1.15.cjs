/** 2.1.16 回归：块公式（$$）点击的两条反馈（用户 2026-09-14 第 6 轮 ①②，第 7 轮补口径）。
 *
 *  ① 第 6 轮原话「点渲染行的最后，光标跳过末尾逗号、跑到它再往前一个字符之前」；
 *     第 7 轮把要的效果说明白了：**「点在最后一个逗号及之后的任何本行元素处，光标都要被映射到
 *     逗号之后」**——也就是行末语义 = 落点越靠右越往后，末尾那一格连同它右侧的空白带一律
 *     落到这条公式源码的**末尾**。
 *  ② 「以 \sum、\int 开头的段落公式，点求和符/积分符号，inline math 下应该插到 \ 和 s 之间，
 *     目前段落公式却插到 \sum_{} 第一个参数的位置」
 *
 *  取证（scripts/acceptance/probe-math6/9，在**用户原文档第 195 行**那条公式上）：
 *    · 显示模式的 `\sum`/`\lim` 这类大运算符在 KaTeX 里**自己没有源码映射**：映射挂在外层
 *      `mop` 上（`<span class="mop op-limits" data-typora-source-start="0">`），字形本体是
 *      里面那个没有属性的 `span.mop.op-symbol`。旧实现用"离落点最近的**映射字形**"兜底，
 *      于是点 ∑ 时选中了下标里的 `=`（B 组实测映射值 7），光标落进 `\sum_{i|=1}`。
 *    · 字形盒是整格（`0` 的盒子 589..598 有 9px 宽），旧实现"一律停在字形起点"，
 *      于是点在 `0` 的右半边也停在 `0` 之前——用户看到的"跳过逗号、跑到再前一格"。
 *  修法（render/js/math-source-map.js）：
 *    · 落点压在"自己没有映射、但确实画着字"的元素上时，用**外层映射元素**的源码位置
 *      （命令一律进到反斜杠之后，与行内公式的既有语义一致）；
 *    · 字形与字形之间的缝里也认左右半边，光标跟着落点走、不再回退一格；
 *    · **公式最后一个字形整格 + 它右侧的空白带 → 源码末尾**（第 7 轮口径）。
 *  这个场景把两条都按**几何取点**钉住，并与**行内公式同一操作**对照（用户说行内是对的）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const BLOCK_A = '1=\\lim_{n\\to\\infty}\\int f_n\\,d\\mu\\neq\\int\\Big(\\lim_{n\\to\\infty}f_n\\Big)d\\mu=0,';
const BLOCK_B = '\\sum_{i=1}^{n} a_i + \\int_0^1 x\\,dx = S';

module.exports = {
  id: '85-block-math-click-2.1.15',
  title: '块公式点击：点 ∑ 进到反斜杠之后、点行末停在最后一个字符之前',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '85-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const fixture = ['# 块公式点击映射', '',
      '$$', BLOCK_A, '$$', '',
      '$$', BLOCK_B, '$$', '',
      '行内对照 $\\sum_{i=1}^{n} a_i$ 结束。', ''].join('\n');
    const file = path.join(dir, '块公式点击映射.md');
    fs.writeFileSync(file, fixture);
    const before = fs.readFileSync(file);

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}; const doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        const blocks = doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="math-block"]');
        return !!leaf && blocks.length >= 2; })()`, {timeout: 60000, interval: 60});
      ctx.assert('两条块公式都渲染出了可点的字形（源码映射就位）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(800);

      const HELPER = `w.__m85 = (function(){
        const doc = w.document, ZW = String.fromCharCode(8203);
        const strip = t => String(t).split(ZW).join('');
        const piece = h => { const preview = h.querySelector(':scope > .vditor-ir__preview');
          let code = preview ? preview.previousElementSibling : null;
          if (code && code.tagName !== 'CODE') code = code.querySelector('code');
          return {preview: preview, code: code}; };
        w.__host = needle => [...doc.querySelectorAll('.vditor-ir .vditor-ir__node[data-type="math-block"]')]
          .find(h => { const c = piece(h).code; return c && strip(c.textContent).indexOf(needle) >= 0; }) || null;
        w.__src = needle => { const h = w.__host(needle); return h ? strip(piece(h).code.textContent) : null; };
        w.__leaves = needle => { const h = w.__host(needle); if (!h) return [];
          return [...piece(h).preview.querySelectorAll('[data-typora-source-start]')]
            .filter(n => !n.querySelector('[data-typora-source-start]') && n.getBoundingClientRect().width > 0.4)
            .map(n => { const r = n.getBoundingClientRect();
              return {text: n.textContent, start: +n.getAttribute('data-typora-source-start'), end: +n.getAttribute('data-typora-source-end'),
                left: r.left, top: r.top, w: r.width, h: r.height}; }); };
        /** 显示模式的大运算符字形（自己没有映射，外面那层才有） */
        w.__glyph = (needle, ch) => { const h = w.__host(needle); if (!h) return null;
          const preview = piece(h).preview;
          const all = [...preview.querySelectorAll('*')].filter(n => n.textContent.indexOf(ch) >= 0);
          for (let i = all.length - 1; i >= 0; i--) {
            const n = all[i];
            if ([...n.children].some(c => c.textContent.indexOf(ch) >= 0)) continue;
            const r = n.getBoundingClientRect();
            if (r.width < 0.5 || r.height < 0.5) continue;
            const loc = n.closest('[data-typora-source-start]');
            return {own: n.getAttribute('data-typora-source-start'), box: [r.left, r.top, r.width, r.height],
              up: loc ? {start: +loc.getAttribute('data-typora-source-start'), end: +loc.getAttribute('data-typora-source-end'), cls: String(loc.className).slice(0, 24)} : null};
          }
          return null; };
        w.__caret = needle => { const h = w.__host(needle); const code = h ? piece(h).code : null;
          const s = w.getSelection(); if (!s || !s.rangeCount) return {inCode: false, why: 'no-range'};
          const r = s.getRangeAt(0);
          if (!code || !code.contains(r.startContainer)) return {inCode: false,
            where: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.tagName, isRoot: r.startContainer === doc.querySelector('.vditor-ir .vditor-reset')};
          const pref = doc.createRange(); pref.selectNodeContents(code); pref.setEnd(r.startContainer, r.startOffset);
          const idx = strip(pref.toString()).length, src = strip(code.textContent);
          return {inCode: true, idx: idx, marked: src.slice(0, idx) + '|' + src.slice(idx)}; };
        /** 中立位：光标放到"行内对照"那段开头，让所有公式收回折叠态 */
        w.__neutral = () => { const p = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')]
            .find(x => x.textContent.indexOf('行内对照') >= 0); if (!p) return false;
          const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n = null;
          while (walker.nextNode()) if (walker.currentNode.data.trim().length) { n = walker.currentNode; break; }
          if (!n) return false;
          const r = doc.createRange(); r.setStart(n, 0); r.collapse(true);
          const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; };
        /** 行内公式的光标读数（按源码文本找那条行内公式的 code） */
        w.__inlineCaret = src => { const doc2 = w.document, ZW2 = String.fromCharCode(8203);
          const strip2 = t => String(t).split(ZW2).join('');
          const code = [...doc2.querySelectorAll('code[data-type="math-inline"]')].find(c => strip2(c.textContent) === src);
          const s = w.getSelection(); if (!s || !s.rangeCount) return {inCode: false, why: 'no-range'};
          const r = s.getRangeAt(0);
          if (!code || !code.contains(r.startContainer)) return {inCode: false, where: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.tagName};
          const pref = doc2.createRange(); pref.selectNodeContents(code); pref.setEnd(r.startContainer, r.startOffset);
          const idx = strip2(pref.toString()).length;
          return {inCode: true, idx: idx, marked: src.slice(0, idx) + '|' + src.slice(idx)}; };
        return true; })();`;
      await session.js(`(() => { const w = ${IF}; ${HELPER} return true; })()`);
      const frame = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()`);

      /** 每次点击前都重量几何（点一下公式会展开、整段上下移动），并先把光标放回中立位 */
      const clickAt = async (needle, maker, reader) => {
        await session.js(`(() => { const w = ${IF}; w.__neutral(); return true; })()`);
        await sleep(240);
        const spot = await session.js(`(() => { const w = ${IF}; return (${maker})(); })()`);
        if (!spot) return null;
        await session.click(Math.round(frame.x + spot.x), Math.round(frame.y + spot.y));
        await sleep(340);
        const care = await session.js(`(() => { const w = ${IF}; return ${reader || `w.__caret(${JSON.stringify(needle)})`}; })()`);
        return {...spot, care};
      };

      // ================= A 组：问题① —— 行末那个逗号 =================
      const glyphsA = await session.js(`(() => { const w = ${IF}; return w.__leaves(${JSON.stringify(BLOCK_A)}); })()`);
      ctx.witness('用户那条公式的字形盒（几何量测）', {src: await session.js(`(() => { const w = ${IF}; return w.__src(${JSON.stringify(BLOCK_A)}); })()`),
        last: glyphsA.slice(-4).map(g => g.text + '@' + g.start + '-' + g.end + ' x=' + Math.round(g.left) + '..' + Math.round(g.left + g.w))});
      const last = glyphsA[glyphsA.length - 1], prev = glyphsA[glyphsA.length - 2];
      ctx.assert('量到末尾两个字（`0` 与 `,`）——没有它们这个断言等于没测',
        last.text === ',' && prev.text === '0' && last.w > 1 && prev.w > 1, JSON.stringify({last, prev}));

      // 用户 2026-09-14 第 7 轮把口径说明白了：**"点在最后一个逗号及之后的任何本行元素处，
      // 光标都要映射到逗号之后"**。所以末尾那个字形整格（左右半边都算）连同它右侧的空白带
      // 一律给"源码末尾"；它前面那个字形仍然按半格（左半→它之前、右半→它之后）。
      const AFTER_TAIL = await session.js(`(() => { const w = ${IF}; return w.__src(${JSON.stringify(BLOCK_A)}).length; })()`);
      const LAST = `w.__leaves(${JSON.stringify(BLOCK_A)}).slice(-1)[0]`;
      const PREV = `w.__leaves(${JSON.stringify(BLOCK_A)}).slice(-2)[0]`;
      const rows = [];
      rows.push(await clickAt(BLOCK_A, `() => { const g = ${LAST}; return {x: g.left + g.w * 0.2, y: g.top + g.h / 2, desc: '末尾逗号的左半边'}; }`));
      rows.push(await clickAt(BLOCK_A, `() => { const g = ${LAST}; return {x: g.left + g.w * 0.8, y: g.top + g.h / 2, desc: '末尾逗号的右半边'}; }`));
      rows.push(await clickAt(BLOCK_A, `() => { const g = ${LAST}; return {x: g.left + g.w + 30, y: g.top + g.h / 2, desc: '逗号右缘 +30px（行末空白带）'}; }`));
      rows.push(await clickAt(BLOCK_A, `() => { const g = ${LAST}; return {x: g.left + g.w + 200, y: g.top + g.h / 2, desc: '行末空白带再往右 200px'}; }`));
      rows.push(await clickAt(BLOCK_A, `() => { const g = ${PREV}; return {x: g.left + g.w * 0.75, y: g.top + g.h / 2, desc: '0 的右半边'}; }`));
      rows.push(await clickAt(BLOCK_A, `() => { const g = ${PREV}; return {x: g.left + g.w * 0.2, y: g.top + g.h / 2, desc: '0 的左半边'}; }`));
      ctx.witness('A 组：行末各落点换来的光标（源码里插 `|` 标出位置）',
        rows.map(r => r ? r.desc + ' → ' + (r.care.inCode ? r.care.marked : '（不在源码里：' + JSON.stringify(r.care) + '）') : '（取不到几何）'));

      const tail = rows.slice(0, 4).filter(r => r && r.care.inCode);
      ctx.assert('A：点末尾逗号（左右半边都算）+ 它右侧的空白带 → 光标一律落到**逗号之后**（用户第 7 轮的口径）',
        tail.length === 4 && tail.every(r => r.care.idx === AFTER_TAIL),
        JSON.stringify(tail.map(r => r.desc + ' → ' + r.care.idx + '（期望 ' + AFTER_TAIL + '）')));
      const half = rows[4], leftHalf = rows[5];
      ctx.assert('A：自证半格规则在末尾之前那个字形上仍然成立——点 `0` 左半边停在它之前，右半边停在它之后',
        !!leftHalf && leftHalf.care.inCode && leftHalf.care.idx === prev.start &&
        !!half && half.care.inCode && half.care.idx === last.start,
        JSON.stringify({左半: leftHalf && leftHalf.care, 右半: half && half.care, prevStart: prev.start, 逗号起点: last.start}));

      // 行末 60px 逐 3px：光标偏移单调不减（末尾不许回退）
      const sweep = [];
      for (let dx = -6; dx <= 54; dx += 3) {
        const r = await clickAt(BLOCK_A, `() => { const g = ${LAST}; return {x: g.left + g.w + ${dx}, y: g.top + g.h / 2, desc: 'x+${dx}'}; }`);
        if (r && r.care.inCode) sweep.push({dx, idx: r.care.idx});
      }
      ctx.witness('A：行末 60px 逐 3px 扫一遍的光标偏移', sweep);
      let slide = null;
      for (let i = 1; i < sweep.length; i++) if (sweep[i].idx < sweep[i - 1].idx) slide = {from: sweep[i - 1], to: sweep[i]};
      ctx.assert('A：沿行末一张一张往右点，光标偏移单调不减（一次都不许往回跳）', slide === null, {slide, sweep});

      // ================= B 组：问题② —— \sum / \int / \lim =================
      const sumGlyph = await session.js(`(() => { const w = ${IF}; return w.__glyph(${JSON.stringify(BLOCK_B)}, '∑'); })()`);
      const intGlyph = await session.js(`(() => { const w = ${IF}; return w.__glyph(${JSON.stringify(BLOCK_B)}, '∫'); })()`);
      const srcB = await session.js(`(() => { const w = ${IF}; return w.__src(${JSON.stringify(BLOCK_B)}); })()`);
      ctx.witness('显示模式大运算符的映射归属（字形自己没有映射，外层容器才有）', {sum: sumGlyph, int: intGlyph, src: srcB});
      ctx.assert('自证：显示模式的 ∑ 字形**自己没有**源码映射（这正是旧实现选错字形的根因）',
        !!sumGlyph && sumGlyph.own === null && !!sumGlyph.up, JSON.stringify(sumGlyph));

      const rowsB = [];
      rowsB.push(await clickAt(BLOCK_B, `() => { const g = w.__glyph(${JSON.stringify(BLOCK_B)}, '∑'); return {x: g.box[0] + g.box[2] / 2, y: g.box[1] + g.box[3] / 2, desc: '点 ∑ 字形正中'}; }`));
      rowsB.push(await clickAt(BLOCK_B, `() => { const g = w.__glyph(${JSON.stringify(BLOCK_B)}, '∫'); return {x: g.box[0] + g.box[2] / 2, y: g.box[1] + g.box[3] / 2, desc: '点 ∫ 字形正中'}; }`));
      ctx.witness('B 组：点大运算符字形换来的光标', rowsB.map(r => r ? r.desc + ' → ' + (r.care.inCode ? r.care.marked : JSON.stringify(r.care)) : '（取不到几何）'));

      const sumRow = rowsB[0], intRow = rowsB[1];
      const sumExpect = sumGlyph && sumGlyph.up ? sumGlyph.up.start + 1 : null;   // `\` 与 `s` 之间
      const intStart = srcB.indexOf('\\int');
      ctx.assert('B：点显示模式的 ∑，光标落在 `\\` 与 `s` 之间（不是 `\\sum_{}` 的第一个参数里）',
        sumRow && sumRow.care.inCode && sumRow.care.idx === sumExpect,
        JSON.stringify({期望: sumExpect, 实际: sumRow && sumRow.care, src: srcB}));
      ctx.assert('B：点显示模式的 ∫，光标落在 `\\` 与 `i` 之间',
        intRow && intRow.care.inCode && intRow.care.idx === intStart + 1,
        JSON.stringify({期望: intStart + 1, 实际: intRow && intRow.care, src: srcB}));

      // B′：同一操作在**行内**公式上的结果（用户说行内是对的）——两边的落点必须一致
      const inline = await clickAt('\\sum_{i=1}^{n} a_i', `() => { const doc = w.document;
        const p = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(x => x.textContent.indexOf('行内对照') >= 0);
        for (const h of p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
          const code = h.querySelector(':scope > code'); if (!code || code.textContent !== '\\\\sum_{i=1}^{n} a_i') continue;
          const leaves = [...h.querySelector(':scope > .vditor-ir__preview').querySelectorAll('[data-typora-source-start]')]
            .filter(n => !n.querySelector('[data-typora-source-start]') && n.textContent.indexOf('∑') >= 0);
          if (!leaves.length) continue;
          const r = leaves[0].getBoundingClientRect();
          return {x: r.left + r.width / 2, y: r.top + r.height / 2, desc: '行内点 ∑'};
        }
        return null; }`, `w.__inlineCaret('\\\\sum_{i=1}^{n} a_i')`);
      ctx.witness('B′：行内公式点 ∑ 的落点（用户说这条是对的，块公式必须与它一致）', inline);
      const inlineDelta = inline && inline.care && inline.care.inCode ? inline.care.idx : null;
      ctx.assert('B′：块公式点 ∑ 与行内公式点 ∑ 得到**同一个源码偏移**（两边语义一致）',
        inlineDelta !== null && inlineDelta === 1 && sumRow && sumRow.care.idx === inlineDelta,
        JSON.stringify({行内: inline && inline.care, 块: sumRow && sumRow.care}));

      await session.shot('after-clicks');
      await sleep(2400);
      const onDisk = fs.readFileSync(file);
      ctx.witness('点完之后磁盘上的源文件（独立通道）', {bytes: onDisk.length, identical: onDisk.equals(before)});
      ctx.assert('一路点下来一个字节都没改文档（点公式只移动光标）', onDisk.equals(before),
        {before: before.length, after: onDisk.length});
    } finally {
      await session.close();
    }
  },
};
