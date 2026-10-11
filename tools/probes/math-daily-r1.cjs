/** math-daily · r1：进块 / 离开块（日常：打 `$$` 回车、块公式后回车走人、行中段收笔换行）
 *  用法：node math-daily-r1.cjs "<exe>"
 *  判据一律读**最终状态**：文档全文（尾部）+ 选区 + head 行列 + DOM 行文本 + widget/浮层计数 + 光标矩形。
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const tail = (s, n = 60) => String(s).slice(-n).replace(/\n/g, '\\n');

(async () => {
  const S = await L.boot({ probe: 'math-daily-r1.cjs', dir: 'r1', exe: EXE });
  try {
    const base = await S.assertFixture({ minWidgets: 2 });
    L.log('R1-0 基线', {
      产物sha16: require('./_probe-common.cjs').sha16(EXE),
      docLen: base.docLen, docLines: base.docLines, nWidgets: base.nWidgets, nKatex: base.nKatex,
      headLine: base.headLine, headCol: base.headCol, headLineText: base.headLineText.slice(0, 30),
      widgetKinds: base.widgets.map((w) => w.kind + (w.live ? '/live' : '') + (w.katex ? '/katex' : '') + '@' + w.rect.w + 'x' + w.rect.h),
      floats: base.nFloats,
    });
    if (!(base.nKatex >= 3)) throw new Error('基线不像"公式已渲染"：nKatex=' + base.nKatex);

    /* ── E1：文末新起一行，打 `$$` 回车 → 是不是进了块公式环境？ ───────────────── */
    await S.guard('E1a', async () => {
      const end = await S.ev(() => { const v = window.mpEngine._view(); const l = v.state.doc.line(v.state.doc.lines); return { pos: l.to, line: l.number, text: l.text }; });
      const xy = await S.posXY(end.pos, 3);
      await S.page.mouse.click(xy.x, xy.y); await S.sleep(400);
      await S.key('End'); await S.key('Enter');
      const s = await S.snap();
      L.log('E1a 新起一行', { 原末行: end, docLines: s.docLines, headLine: s.headLine, headCol: s.headCol, tail: tail(s.doc), focusInContent: s.focusInContent, viewHasFocus: s.viewHasFocus, cursorRect: s.cursorRect });
    });

    await S.guard('E1b', async () => {
      await S.type('$$');
      const s = await S.snap();
      L.log('E1b 打了 $$', { docLines: s.docLines, headLine: s.headLine, headCol: s.headCol, headLineText: s.headLineText, tail: tail(s.doc), nWidgets: s.nWidgets, nMathSrcLine: s.nMathSrcLine, mathSrcLines: s.lines.filter((l) => l.isMathSrc).map((l) => l.text.slice(0, 20)) });
      return s;
    });

    await S.guard('E1c', async () => {
      await S.key('Enter'); await S.sleep(500);
      const s = await S.snap();
      L.log('E1c $$ 后回车', {
        docLines: s.docLines, headLine: s.headLine, headCol: s.headCol, headLineText: s.headLineText,
        tail: tail(s.doc, 40), 是否自动补了闭围栏: /(^|\n)\$\$\s*\n\$\$\s*$/.test(s.doc), nWidgets: s.nWidgets,
        mathSrcLines: s.lines.filter((l) => l.isMathSrc).map((l) => l.text.slice(0, 20)),
      });
      return s;
    });

    await S.guard('E1d', async () => {
      await S.type('x^2'); await S.key('Enter');
      const s = await S.snap();
      L.log('E1d 键入 x^2 再回车', { docLines: s.docLines, headLine: s.headLine, headCol: s.headCol, headLineText: s.headLineText, tail: tail(s.doc, 40), nWidgets: s.nWidgets });
      return s;
    });

    await S.guard('E1e', async () => {
      await S.type('$$'); await S.sleep(600);
      const s = await S.snap();
      L.log('E1e 补上闭围栏 $$', {
        docLines: s.docLines, headLine: s.headLine, headCol: s.headCol, headLineText: s.headLineText, tail: tail(s.doc, 40),
        nWidgets: s.nWidgets, nKatex: s.nKatex,
        widgetKinds: s.widgets.map((w) => w.kind + (w.live ? '/live' : '') + '@' + w.rect.w + 'x' + w.rect.h + ' "' + w.glyph.slice(0, 14) + '"'),
        floats: s.floats.map((f) => (f.display ? 'display' : 'inline') + ' "' + f.glyph.slice(0, 14) + '"'),
        mathSrcLines: s.lines.filter((l) => l.isMathSrc).map((l) => l.text.slice(0, 20)),
      });
      return s;
    });

    await S.guard('E1f', async () => {
      const before = await S.snap();
      await S.key('Enter'); await S.sleep(700);
      const s = await S.snap();
      L.log('E1f 闭围栏后回车（离开公式）', {
        前: { headLine: before.headLine, headCol: before.headCol, nWidgets: before.nWidgets, docLines: before.docLines },
        后: { headLine: s.headLine, headCol: s.headCol, headLineText: s.headLineText, nWidgets: s.nWidgets, nKatex: s.nKatex, docLines: s.docLines, tail: tail(s.doc, 30), cursorRect: s.cursorRect, focusInContent: s.focusInContent },
        新块已渲染: s.widgets.some((w) => w.kind === 'block' && w.katex && w.glyph.includes('x')),
      });
      return s;
    });

    /* ── E2：行中段 `$$…$$` 收笔即独占一行（中文混排典型日常） ───────────────── */
    await S.guard('E2', async () => {
      const l3 = await S.ev(() => { const v = window.mpEngine._view(); const l = v.state.doc.line(3); return { from: l.from, to: l.to, text: l.text }; });
      const xy = await S.posXY(l3.to, 3);
      await S.page.mouse.click(xy.x, xy.y); await S.sleep(400);
      await S.key('End');
      const b = await S.snap();
      await S.type(' $$x+1$$');
      await S.sleep(900);
      const s = await S.snap();
      L.log('E2 行尾打 $$x+1$$', {
        第3行原文: l3.text, 打前: { headLine: b.headLine, headCol: b.headCol, docLines: b.docLines },
        打后: { headLine: s.headLine, headCol: s.headCol, docLines: s.docLines, line3: s.lines.find((l) => l.text.includes('行内公式')) ? s.lines.find((l) => l.text.includes('行内公式')).text : null },
        doc行3到5: s.doc.split('\n').slice(2, 6),
        nWidgets: s.nWidgets,
        widgetKinds: s.widgets.map((w) => w.kind + (w.live ? '/live' : '') + ' "' + w.glyph.slice(0, 12) + '"'),
        floats: s.floats.map((f) => (f.display ? 'display' : 'inline') + ' "' + f.glyph.slice(0, 12) + '"'),
        光标后是否紧跟换行: s.doc.slice(s.head, s.head + 1) === '\n',
        公式后无逗号等尾随字: /x\+1\$\$\n/.test(s.doc),
      });
      return s;
    });

    /* ── E3：点进已渲染的块公式 → 源码展开 → 在闭围栏后回车离开 ─────────────── */
    await S.guard('E3', async () => {
      // 先把光标弄出所有公式（Ctrl+Home）
      await S.key('Control+Home'); await S.sleep(500);
      const b = await S.snap();
      const blk = b.widgets.filter((w) => w.kind === 'block');
      L.log('E3-0 光标回文首', { headLine: b.headLine, headCol: b.headCol, nWidgets: b.nWidgets, blocks: blk.map((w) => w.rect.y + '/' + w.rect.h + ' "' + w.glyph.slice(0, 16) + '"') });
      if (!blk.length) throw new Error('文首态下没有块公式 widget');
      // 真鼠标点第 1 个块公式（单行块 ∫）
      const hit = await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      const s1 = await S.snap();
      L.log('E3-1 点块公式', {
        命中: { cls: hit.cls, box: hit.box },
        后: { headLine: s1.headLine, headCol: s1.headCol, headLineText: s1.headLineText, nWidgets: s1.nWidgets, nMathSrcLine: s1.nMathSrcLine, floats: s1.floats.map((f) => (f.display ? 'display' : 'inline') + ' from=' + f.from + ' to=' + f.to), selText: s1.selText },
      });
      // 走到闭围栏行尾：End 后按 ↓ 直到 head 行文本是 $$
      const hist = [];
      await S.key('End'); hist.push((await S.measure((await S.snap()).head)));
      for (let i = 0; i < 4; i++) {
        const cur = await S.snap();
        if (cur.headLineText.trim() === '$$') break;
        await S.key('ArrowDown'); await S.sleep(200);
        const n = await S.snap();
        hist.push({ i, line: n.headLine, col: n.headCol, text: n.headLineText.slice(0, 20) });
      }
      const atClose = await S.snap();
      L.log('E3-2 落到闭围栏', { headLine: atClose.headLine, headCol: atClose.headCol, headLineText: atClose.headLineText, hist });
      await S.key('End'); await S.sleep(200);
      const pre = await S.snap();
      await S.key('Enter'); await S.sleep(800);
      const s2 = await S.snap();
      L.log('E3-3 闭围栏后回车', {
        前: { headLine: pre.headLine, headCol: pre.headCol, docLines: pre.docLines, nWidgets: pre.nWidgets },
        后: { headLine: s2.headLine, headCol: s2.headCol, headLineText: s2.headLineText, docLines: s2.docLines, nWidgets: s2.nWidgets, nKatex: s2.nKatex, nMathSrcLine: s2.nMathSrcLine, cursorRect: s2.cursorRect },
        块是否回到渲染态: s2.widgets.some((w) => w.kind === 'block' && w.katex),
        doc行4到9: s2.doc.split('\n').slice(3, 9),
      });
      return s2;
    });

    /* ── E4：块公式**上方/下方**回车，检查块不被吞 ─────────────────────────── */
    await S.guard('E4', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      // 光标放到第 4 行（块公式上一行空行）行首，回车
      const p = await S.ev(() => { const v = window.mpEngine._view(); return v.state.doc.line(4).from; });
      await S.clickPos(p, 2);
      const b = await S.snap();
      await S.key('Enter'); await S.sleep(600);
      const s = await S.snap();
      L.log('E4 块公式上一行回车', {
        前: { headLine: b.headLine, headCol: b.headCol, docLines: b.docLines, nWidgets: b.nWidgets },
        后: { headLine: s.headLine, headCol: s.headCol, docLines: s.docLines, nWidgets: s.nWidgets, nKatex: s.nKatex },
        doc行4到10: s.doc.split('\n').slice(3, 10),
      });
      return s;
    });

    L.log('R1-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots, 外部中断: 0 });
  } catch (e) {
    L.log('R1-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
