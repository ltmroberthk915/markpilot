/** math-daily · r7：单行块公式 `$$…$$` 内按回车（日常动作）—— 结构后果逐项取证
 *  用法：node math-daily-r7.cjs "<exe>"
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const DOC = String.raw`前置段落。

$$\sigma(X) := \{x \mid x \in X\}$$

后置段落。
`;
const brief = (s) => ({
  docLines: s.docLines, headLine: s.headLine, headCol: s.headCol, headText: s.headLineText.slice(0, 30),
  nWidgets: s.nWidgets, nKatex: s.nKatex, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats,
  widgetKinds: s.widgets.map((w) => w.kind + (w.katex ? '/katex' : '/NOkatex') + ' "' + w.glyph.slice(0, 14) + '"'),
});

(async () => {
  const S = await L.boot({ probe: 'math-daily-r7.cjs', dir: 'r7', exe: EXE, docText: DOC });
  try {
    const base = await S.assertFixture({ marks: ['前置段落。', '\\sigma(X)', '后置段落。'], minWidgets: 1 });
    L.log('R7-0 基线', { ...brief(base), doc: base.doc });
    if (!base.doc.includes('\\sigma(X)')) throw new Error('夹具不对');

    /* R7a 单行块公式**中点**回车 */
    await S.guard('R7a', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const hit = await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(400);
      const inb = await S.snap();
      await S.key('Home'); for (let i = 0; i < 8; i++) await S.key('ArrowRight', 130);
      const pre = await S.snap();
      await S.key('Enter'); await S.sleep(800);
      const s = await S.snap();
      L.log('R7a 单行块公式中点回车', {
        命中盒: hit.box, 点进后: brief(inb), 回车前: brief(pre), 回车后: brief(s),
        doc: s.doc.split('\n'),
      });
      await S.key('Control+z', 700);
      const back = await S.snap();
      L.log('R7a-撤销', { docLen: back.docLen, 复原: back.docLen === DOC.length, doc: back.doc.split('\n') });
      return s;
    });

    /* R7b 单行块公式**行尾**回车（收笔后换行） */
    await S.guard('R7b', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(400);
      await S.key('End'); await S.sleep(250);
      const pre = await S.snap();
      await S.key('Enter'); await S.sleep(800);
      const s = await S.snap();
      L.log('R7b 单行块公式行尾回车', { 回车前: brief(pre), 回车后: brief(s), doc: s.doc.split('\n') });
      await S.key('Control+z', 700);
      const back = await S.snap();
      L.log('R7b-撤销', { docLen: back.docLen, 复原: back.docLen === DOC.length });
      return s;
    });

    /* R7c 干净段落里打 `$$` + 回车（E1 的独立复现） */
    await S.guard('R7c', async () => {
      await S.key('Control+Home'); await S.sleep(350);
      const p = await S.posXY(await S.ev(() => window.mpEngine._view().state.doc.line(1).to), 3);
      await S.page.mouse.click(p.x, p.y); await S.sleep(350);
      await S.key('End'); await S.key('Enter');
      await S.type('$$'); await S.sleep(500);
      const a = await S.snap();
      await S.key('Enter'); await S.sleep(600);
      const b = await S.snap();
      await S.type('a^2+b^2'); await S.key('Enter'); await S.sleep(500);
      await S.type('$$'); await S.sleep(700);
      const c = await S.snap();
      L.log('R7c 空行打 $$ 回车', {
        A_打完$$: { headLine: a.headLine, headCol: a.headCol, text: a.headLineText, nWidgets: a.nWidgets, nMathSrc: a.nMathSrcLine },
        B_回车后: { headLine: b.headLine, headCol: b.headCol, text: b.headLineText, nWidgets: b.nWidgets, docLines: b.docLines, tail: b.doc.slice(-14).replace(/\n/g, '\\n'), 自动补闭围栏: /(^|\n)\$\$\s*\n\$\$\s*$/.test(b.doc) },
        C_补闭围栏后: brief(c), 光标是否紧跟换行: c.doc.slice(c.head, c.head + 1) === '\n',
        doc: c.doc.split('\n'),
      });
      return c;
    });

    L.log('R7-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R7-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
