/** math-daily · r4：多行公式 + 中文混排的光标与列稳定
 *  用法：node math-daily-r4.cjs "<exe>"
 *  "列稳定"的口径：**文档位置（head/列）**不因公式渲染↔源码展开而漂移；像素 x 随排版变化是正常的（分开记）。
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const at = (s) => ({ line: s.headLine, col: s.headCol, x: s.cursorRect ? s.cursorRect.x : null, w: s.cursorRect ? s.cursorRect.w : null, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats, nWidgets: s.nWidgets });

(async () => {
  const S = await L.boot({ probe: 'math-daily-r4.cjs', dir: 'r4', exe: EXE });
  try {
    await S.assertFixture({ minWidgets: 2 });
    const off = await S.ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc.toString();
      const multiS = d.indexOf('$$', d.indexOf('$$', d.indexOf('$$') + 2) + 2); // 第二块的 `$$` 开围栏
      const multiE = d.indexOf('$$', multiS + 2) + 2;
      const l18 = v.state.doc.line(18);
      return {
        blockMulti: { from: multiS, to: multiE, text: d.slice(multiS, multiE) },
        l18: { from: l18.from, to: l18.to, text: l18.text, len: l18.text.length },
        l20: { from: v.state.doc.line(20).from, text: v.state.doc.line(20).text },
        docLen: d.length,
      };
    });
    L.log('R4-0 夹具', { blockMulti: { from: off.blockMulti.from, to: off.blockMulti.to, lines: off.blockMulti.text.split('\n').length, text: off.blockMulti.text }, l18: off.l18, l20: off.l20 });

    /* M1 多行块公式：渲染态是**一整块**；点进去源码展开覆盖全部 6 行 */
    await S.guard('M1', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const b = await S.snap();
      const blocks = b.widgets.filter((w) => w.kind === 'block');
      const hit = await S.clickWidget('.cm-content .mp-cm6-math-block', 1, 0.5, 0.5);
      await S.sleep(400);
      const s = await S.snap();
      const srcLines = s.lines.filter((l) => l.isMathSrc);
      L.log('M1 多行块公式', {
        渲染态: { blocks: blocks.map((w) => w.rect.h + 'px katex=' + w.katex + ' "' + w.glyph.slice(0, 16) + '"'), nWidgets: b.nWidgets },
        命中盒: hit.box,
        展开后: { headLine: s.headLine, headCol: s.headCol, nMathSrc: s.nMathSrcLine, srcLineNos: srcLines.map((l) => l.text.slice(0, 22)), nFloats: s.nFloats, floatKind: s.floats.map((f) => (f.display ? 'display' : 'inline') + ' from=' + f.from + ' to=' + f.to), nWidgets: s.nWidgets },
        展开行数等于块行数: s.nMathSrcLine === off.blockMulti.text.split('\n').length,
      });
      return s;
    });

    /* M2 源码内逐行 ↓：块内每行都能停（逐行），出块后落块外下一行 */
    await S.guard('M2', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 1, 0.5, 0.5);
      await S.key('Home');
      const seq = [at(await S.snap())];
      for (let i = 0; i < 8; i++) { await S.key('ArrowDown', 260); const s = await S.snap(); seq.push({ ...at(s), text: s.headLineText.slice(0, 26) }); }
      L.log('M2 多行块内逐行 ↓', { 序列: seq });
      return seq;
    });

    /* M3 多行公式渲染态下，块**下一行**按 ↑ 应进块内容末行（不是整块跳过） */
    await S.guard('M3', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const p = await S.ev(() => window.mpEngine._view().state.doc.line(17).from);
      await S.clickPos(p, 2);
      const a = await S.snap();
      await S.key('ArrowUp', 400);
      const b = await S.snap();
      await S.key('ArrowUp', 400);
      const c = await S.snap();
      L.log('M3 块下方向上进块', {
        起点: { line: a.headLine, col: a.headCol },
        第一跳: { line: b.headLine, col: b.headCol, text: b.headLineText.slice(0, 26), nMathSrc: b.nMathSrcLine },
        第二跳: { line: c.headLine, col: c.headCol, text: c.headLineText.slice(0, 26), nMathSrc: c.nMathSrcLine },
      });
      return c;
    });

    /* M4 多行公式内容行末回车（公式内换行）→ 结构是否守住 */
    await S.guard('M4', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 1, 0.5, 0.5);
      await S.sleep(300);
      // 走到 d &= e + f 行尾
      const cur = await S.snap();
      L.log('M4-0 点进后', at(cur));
      for (let i = 0; i < 4; i++) { const s = await S.snap(); if (s.headLineText.includes('d &=')) break; await S.key('ArrowDown', 250); }
      await S.key('End'); await S.sleep(200);
      const pre = await S.snap();
      await S.key('Enter'); await S.sleep(700);
      const s = await S.snap();
      L.log('M4 内容行末回车', {
        前: { line: pre.headLine, col: pre.headCol, text: pre.headLineText.slice(0, 24), docLines: pre.docLines, nMathSrc: pre.nMathSrcLine },
        后: { line: s.headLine, col: s.headCol, text: s.headLineText.slice(0, 24), docLines: s.docLines, nMathSrc: s.nMathSrcLine, nKatex: s.nKatex },
        块仍完整: s.doc.includes('\\end{aligned}\n$$'),
      });
      // 撤掉这刀，保持夹具干净
      await S.key('Control+z', 600);
      const back = await S.snap();
      L.log('M4b 撤销', { docLines: back.docLines, 复原: back.docLen === off.docLen });
      return s;
    });

    /* M5 中文混排：光标在公式**后面**的中文里，源码展开/收起时文档位置不漂 */
    await S.guard('M5', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const target = off.l18.from + 18;   // 「后面还有字」中的某一列（公式之后）
      await S.clickPos(target, 0);
      const rend = await S.snap();
      // 点公式 → 源码展开（同一行）
      await S.clickWidget('.cm-content .mp-cm6-math', 1, 0.5, 0.5);
      await S.sleep(500);
      const src = await S.snap();
      // 点空白 → 收起
      const p2 = await S.ev(() => window.mpEngine._view().state.doc.line(2).from);
      await S.clickPos(p2, 2);
      const back = await S.snap();
      L.log('M5 公式后中文：展开/收起时的列稳定', {
        目标文档位置: target,
        渲染态: at(rend), 渲染态head: rend.head,
        源码态: at(src), 源码态head: src.head,
        收起后: at(back), 收起后head: back.head,
        列未漂移: src.head === target && back.head === target,
        像素随排版移动: (rend.cursorRect ? rend.cursorRect.x : null) + ' → ' + (src.cursorRect ? src.cursorRect.x : null),
      });
      return back;
    });

    /* M6 中文混排：空格号行 ↔ 公式行 的纵向目标列（中间隔一个空行）往返 */
    await S.guard('M6', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const p = off.l20.from + 10;
      await S.clickPos(p, 0);
      const a = await S.snap();
      await S.key('ArrowUp', 320); const b = await S.snap();
      await S.key('ArrowUp', 320); const c = await S.snap();
      await S.key('ArrowDown', 320); const d = await S.snap();
      await S.key('ArrowDown', 320); const e = await S.snap();
      L.log('M6 纵向目标列（ASCII 行 ↔ 中文公式行）', {
        A_l20_c10: { line: a.headLine, col: a.headCol, x: a.cursorRect && a.cursorRect.x },
        B_l19: { line: b.headLine, col: b.headCol, x: b.cursorRect && b.cursorRect.x },
        C_l18: { line: c.headLine, col: c.headCol, x: c.cursorRect && c.cursorRect.x },
        D_l19: { line: d.headLine, col: d.headCol, x: d.cursorRect && d.cursorRect.x },
        E_l20: { line: e.headLine, col: e.headCol, x: e.cursorRect && e.cursorRect.x },
        往返回原列: a.headCol === e.headCol && a.head === e.head,
      });
      return e;
    });

    /* M7 中文紧贴公式：双击公式只选公式（不吞中文）；点紧贴边界落位 */
    await S.guard('M7', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const b = await S.clickWidget('.cm-content .mp-cm6-math', 1, 0.5, 0.5);
      await S.sleep(250);
      await S.page.mouse.dblclick(b.box.x, b.box.y);
      await S.sleep(400);
      const s = await S.snap();
      L.log('M7 双击中文旁的公式', { selText: s.selText, 期望: '$x+a$', 相符: s.selText === '$x+a$', headLine: s.headLine });
      return s;
    });

    /* M8 中文混排：在公式前插入一个中文字（真实键入）→ 文档正确且公式仍渲染 */
    await S.guard('M8', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const xa = await S.ev(() => window.mpEngine._view().state.doc.toString().indexOf('$x+a$'));
      await S.clickPos(xa, -1);   // 点 $ 左缘
      const before = await S.snap();
      await S.type('测');
      await S.sleep(600);
      const s = await S.snap();
      L.log('M8 公式前插一个中文字', {
        插入前: { line: before.headLine, col: before.headCol, docLen: before.docLen },
        插入后: { line: s.headLine, col: s.headCol, docLen: s.docLen, 行18: s.doc.split('\n')[17], nKatex: s.nKatex, nWidgets: s.nWidgets },
        公式仍渲染: s.widgets.some((w) => w.glyph.includes('x+a')),
      });
      await S.key('Control+z', 600);
      const back = await S.snap();
      L.log('M8b 撤销', { docLen: back.docLen, 复原: back.docLen === off.docLen });
      return s;
    });

    /* M9 破坏性：删掉多行块的闭围栏 → 只记录现象 */
    await S.guard('M9', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 1, 0.5, 0.5);
      await S.sleep(300);
      for (let i = 0; i < 8; i++) { const s = await S.snap(); if (s.headLineText.trim() === '$$' && s.headLine > 10) break; await S.key('ArrowDown', 250); }
      await S.key('End');
      const pre = await S.snap();
      for (let i = 0; i < 2; i++) await S.key('Backspace', 200);
      const s = await S.snap();
      L.log('M9 删掉闭围栏 $$', {
        前: { line: pre.headLine, text: pre.headLineText, docLines: pre.docLines },
        后: { line: s.headLine, text: s.headLineText, docLines: s.docLines, nWidgets: s.nWidgets, nKatex: s.nKatex, nMathSrc: s.nMathSrcLine, floats: s.floats.length },
        doc尾部: s.doc.split('\n').slice(9, 18),
      });
      await S.key('Control+z', 600); await S.key('Control+z', 600);
      const back = await S.snap();
      L.log('M9b 撤销', { docLen: back.docLen, 复原: back.docLen === off.docLen, nKatex: back.nKatex });
      return s;
    });

    L.log('R4-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R4-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
