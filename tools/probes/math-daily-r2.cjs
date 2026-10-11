/** math-daily · r2：点公式进源码 + 源码内方向键 / 选区 / 双击 / 拖拽（全部真实鼠标键盘）
 *  用法：node math-daily-r2.cjs "<exe>"
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const R = require('./_probe-common.cjs');
const brief = (s) => ({
  headLine: s.headLine, headCol: s.headCol, lineText: s.headLineText.slice(0, 32),
  nWidgets: s.nWidgets, nKatex: s.nKatex, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats,
  selText: s.selText.slice(0, 40), empty: s.emptySel, cursorX: s.cursorRect ? s.cursorRect.x : null,
  complete: s.complete ? s.complete.items + '/' + s.complete.active : null,
  focusInContent: s.focusInContent, viewHasFocus: s.viewHasFocus,
});

(async () => {
  const S = await L.boot({ probe: 'math-daily-r2.cjs', dir: 'r2', exe: EXE });
  try {
    const base = await S.assertFixture({ minWidgets: 2 });
    // 关键偏移全部从**夹具原文**现取（不靠行号猜）
    const off = await S.ev(() => {
      const d = window.mpEngine._view().state.doc.toString();
      const at = (s) => { const i = d.indexOf(s); return { s, from: i, to: i + s.length, line: i < 0 ? null : window.mpEngine._view().state.doc.lineAt(i).number }; };
      return { inline1: at('$E=mc^2$'), inline2: at('$x+a$'), block1: at('$$'), docLen: d.length };
    });
    L.log('R2-0 偏移', { ...off, 产物sha16: R.sha16(EXE) });
    if (off.inline1.from < 0 || off.inline2.from < 0) throw new Error('夹具找不到目标公式');

    /* C1 点行内公式正中 */
    await S.guard('C1', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const pre = await S.snap();
      const hit = await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.5, 0.5);
      const s = await S.snap();
      L.log('C1 点行内公式正中', {
        点前: { nWidgets: pre.nWidgets, nKatex: pre.nKatex, line3: (pre.lines.find((l) => l.text.includes('行内公式')) || {}).text },
        命中盒: hit.box, 命中类名: hit.cls,
        点后: brief(s),
        行3DOM文本: (s.lines.find((l) => l.text.includes('行内公式')) || {}).text,
        行3是否含$$源码: /行内公式 \$E=mc\^2\$/.test((s.lines.find((l) => l.text.includes('行内公式')) || {}).text || ''),
        浮层: s.floats.map((f) => (f.display ? 'display' : 'inline') + ' from=' + f.from + ' to=' + f.to + ' "' + f.glyph.slice(0, 12) + '"'),
        落在源码区间: s.head >= off.inline1.from && s.head <= off.inline1.to,
      });
      return s;
    });

    /* C2 点行内公式左缘 / 右缘（精确落位） */
    await S.guard('C2', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const L1 = await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.06, 0.5);
      const sL = await S.snap();
      await S.key('Control+Home'); await S.sleep(300);
      const R1 = await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.96, 0.5);
      const sR = await S.snap();
      L.log('C2 点左缘/右缘', {
        期望源码区间: { from: off.inline1.from, to: off.inline1.to },
        左缘: { 盒: L1.box, head: sL.head, headCol: sL.headCol, 相对区间: sL.head - off.inline1.from },
        右缘: { 盒: R1.box, head: sR.head, headCol: sR.headCol, 相对区间: sR.head - off.inline1.from },
      });
      return { 左: sL.head, 右: sR.head };
    });

    /* C3 点块公式 → 源码展开（3 行） */
    await S.guard('C3', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const hit = await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      const s = await S.snap();
      const srcLines = s.lines.filter((l) => l.isMathSrc).map((l) => l.text.slice(0, 30));
      L.log('C3 点块公式', {
        命中盒: hit.box, headLine: s.headLine, headCol: s.headCol, headLineText: s.headLineText.slice(0, 30),
        nWidgets: s.nWidgets, nMathSrc: s.nMathSrcLine, srcLines,
        浮层: s.floats.map((f) => (f.display ? 'display' : 'inline') + ' from=' + f.from + ' to=' + f.to),
        焦点: { inContent: s.focusInContent, viewHasFocus: s.viewHasFocus }, 光标: s.cursorRect,
      });
      return s;
    });

    /* C4 点空白 → 块回渲染态 */
    await S.guard('C4', async () => {
      const p = await S.ev(() => window.mpEngine._view().state.doc.line(2).from);
      await S.clickPos(p, 2);
      const s = await S.snap();
      L.log('C4 点空白处', { headLine: s.headLine, headCol: s.headCol, nWidgets: s.nWidgets, nKatex: s.nKatex, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats, widgets: s.widgets.map((w) => w.kind + (w.katex ? '/katex' : '/NOkatex') + ' "' + w.glyph.slice(0, 14) + '"') });
      return s;
    });

    /* C5 双击行内公式 → 整段选中 */
    await S.guard('C5', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const b = await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.5, 0.5); // 先单击展开源码
      await S.sleep(300);
      await S.page.mouse.dblclick(b.box.x, b.box.y);
      await S.sleep(500);
      const s = await S.snap();
      L.log('C5 双击公式', { selText: s.selText, emptySel: s.emptySel, selFromTo: [s.selFrom, s.selTo], 期望: off.inline1, headLine: s.headLine, headCol: s.headCol, nWidgets: s.nWidgets });
      return s;
    });

    /* C6 源码内 ← / → 逐字符 + Home/End */
    await S.guard('C6', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.5, 0.5);
      await S.key('Home');
      const h = await S.snap();
      const seq = [];
      for (let i = 0; i < 4; i++) { await S.key('ArrowRight', 180); const s = await S.snap(); seq.push({ k: '→' + (i + 1), col: s.headCol, x: s.cursorRect && s.cursorRect.x, w: s.cursorRect && s.cursorRect.w }); }
      for (let i = 0; i < 3; i++) { await S.key('ArrowLeft', 180); const s = await S.snap(); seq.push({ k: '←' + (i + 1), col: s.headCol, x: s.cursorRect && s.cursorRect.x, w: s.cursorRect && s.cursorRect.w }); }
      await S.key('End'); const e = await S.snap();
      L.log('C6 源码内方向键/Home/End', {
        行文本: h.headLineText, Home列: h.headCol, 序列: seq, End列: e.headCol, 行尾列: h.headLineText.length,
        光标矩形恒有: seq.every((r) => r.w > 0),
      });
      return e;
    });

    /* C7 Shift+→ 扩选：选区文本 + 其余公式保持渲染（不整片塌成源码） */
    await S.guard('C7', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.5, 0.5);
      await S.key('Home');
      const b = await S.snap();
      await S.key('ArrowRight', 200); // 到 col 1
      const seq = [];
      for (let i = 0; i < 15; i++) { await S.key('Shift+ArrowRight', 130); const s = await S.snap(); seq.push({ col: s.headCol, sel: s.selText, nW: s.nWidgets, selBg: s.selRects.length }); }
      const s = await S.snap();
      L.log('C7 Shift+→ 逐格扩选', {
        起点: { col: b.headCol, nWidgets: b.nWidgets },
        轨迹: seq.filter((r, i) => i % 3 === 0 || r.sel.includes('$')),
        终态: { headCol: s.headCol, selText: s.selText, nWidgets: s.nWidgets, nKatex: s.nKatex, nMathSrc: s.nMathSrcLine, selectedWidgets: s.widgets.filter((w) => w.selected).map((w) => w.kind + ' "' + w.glyph.slice(0, 12) + '"'), selRects: s.selRects },
      });
      return s;
    });

    /* C8 拖拽选中整段行内公式（源码态） */
    await S.guard('C8', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickPos(off.inline1.from, 0);
      await S.dragSelect(off.inline1.from, off.inline1.to);
      const s = await S.snap();
      L.log('C8 拖拽选整段公式', {
        selText: s.selText, 期望: '$E=mc^2$', 相符: s.selText === '$E=mc^2$',
        selFromTo: [s.selFrom, s.selTo], nWidgets: s.nWidgets, nKatex: s.nKatex,
        selectedWidgets: s.widgets.filter((w) => w.selected).length, nMathSrc: s.nMathSrcLine, selRects: s.selRects.length,
        domSel: s.domSel,
      });
      return s;
    });

    /* C9 纵向目标列：行内公式行 col 5 起 ↓/↑ 往返 */
    await S.guard('C9', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickPos(off.inline1.from, 0); // 落 col 5（$ 之前）
      await S.key('Home'); for (let i = 0; i < 5; i++) await S.key('ArrowRight', 130);
      const a = await S.snap();
      await S.key('ArrowDown', 320);
      const b = await S.snap();
      await S.key('ArrowUp', 320);
      const c = await S.snap();
      await S.key('ArrowDown', 320);
      const d = await S.snap();
      L.log('C9 纵向目标列（公式行↔空行）', {
        A: { line: a.headLine, col: a.headCol, x: a.cursorRect && a.cursorRect.x },
        B_down: { line: b.headLine, col: b.headCol, x: b.cursorRect && b.cursorRect.x },
        C_up: { line: c.headLine, col: c.headCol, x: c.cursorRect && c.cursorRect.x },
        D_down2: { line: d.headLine, col: d.headCol, x: d.cursorRect && d.cursorRect.x },
        列稳定: a.headCol === c.headCol && a.headCol === d.headCol,
      });
      return d;
    });

    /* C10 源码内键入 `\` → 补全菜单；↑/↓ 归属（菜单吃掉 vs 光标移动） */
    await S.guard('C10', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.4, 0.5);
      await S.sleep(300);
      const enter = await S.snap();
      await S.key('End', 200);
      await S.type('\\f', 700);
      const menu = await S.snap();
      await S.key('ArrowDown', 300);
      const afterDown = await S.snap();
      await S.key('Escape', 300);
      const afterEsc = await S.snap();
      const before = afterEsc.head;
      await S.key('ArrowDown', 350);
      const afterFree = await S.snap();
      L.log('C10 源码内 \\ 触发补全后方向键归属', {
        进块: { line: enter.headLine, col: enter.headCol, lineText: enter.headLineText.slice(0, 26), nMathSrc: enter.nMathSrcLine },
        键入后: { line: menu.headLine, col: menu.headCol, menu: menu.complete, lineText: menu.headLineText.slice(0, 40) },
        '菜单打开后按↓': { line: afterDown.headLine, col: afterDown.headCol, menu: afterDown.complete, 光标动了吗: afterDown.head !== menu.head },
        'Esc后': { line: afterEsc.headLine, col: afterEsc.headCol, menu: afterEsc.complete, head: afterEsc.head },
        '菜单关后按↓': { line: afterFree.headLine, col: afterFree.headCol, head: afterFree.head, 位移: afterFree.head - before, menu: afterFree.complete },
      });
      return afterFree;
    });

    L.log('R2-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R2-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
