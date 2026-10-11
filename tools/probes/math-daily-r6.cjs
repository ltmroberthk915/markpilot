/** math-daily · r6：穿过块公式的目标列（实验臂 + 同形状对照臂）/ 围栏行可点性 / 补一张选区视觉图
 *  用法：node math-daily-r6.cjs "<exe>"
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const at = (s) => ({ line: s.headLine, col: s.headCol, x: s.cursorRect ? s.cursorRect.x : null, w: s.cursorRect ? s.cursorRect.w : null, nMathSrc: s.nMathSrcLine });
const marks = async (S, label, sel) => {
  await S.ev((q) => {
    document.querySelectorAll('.mp-probe-mark').forEach((e) => e.remove());
    const mk = (r, css) => { const d = document.createElement('div'); d.className = 'mp-probe-mark'; d.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;box-sizing:border-box;' + css + ';left:' + r.left + 'px;top:' + r.top + 'px;width:' + Math.max(2, r.width) + 'px;height:' + Math.max(2, r.height) + 'px'; document.body.appendChild(d); };
    const cur = document.querySelector('.cm-cursor-primary') || document.querySelector('.cm-cursor');
    if (cur) { const r = cur.getBoundingClientRect(); if (r.height > 0) mk(r, 'border:2px solid #ff2d2d;'); }
    for (const e of document.querySelectorAll('.cm-selectionBackground')) mk(e.getBoundingClientRect(), 'border:1px dashed #ffb020;background:rgba(255,176,32,.18)');
    for (const e of document.querySelectorAll('.mp-math-selected')) mk(e.getBoundingClientRect(), 'border:1px dashed #00c2d1;');
    return true;
  }, sel).catch(() => { });
  const f = await S.shot(label, sel);
  return f;
};

(async () => {
  const S = await L.boot({ probe: 'math-daily-r6.cjs', dir: 'r6', exe: EXE });
  try {
    await S.assertFixture({ minWidgets: 2 });
    const off = await S.ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc.toString();
      const l = (n) => { const x = v.state.doc.line(n); return { n, from: x.from, to: x.to, text: x.text }; };
      return { l1: l(1), l2: l(2), l3: l(3), l8: l(8), l9: l(9), l17: l(17), l18: l(18), l20: l(20), docLen: d.length };
    });
    L.log('R6-0 夹具行', { l1: off.l1.text, l3: off.l3.text, l9: off.l9.text, l18: off.l18.text, l20: off.l20.text });

    /* P1 实验臂：隔一个空行，向上穿过块公式再原路返回 —— 目标列是否守住 */
    await S.guard('P1', async () => {
      await S.key('Control+Home'); await S.sleep(350);
      const p = await S.posXY(off.l9.from + 3, 0);
      await S.page.mouse.click(p.x, p.y); await S.sleep(400);
      await S.key('Home'); for (let i = 0; i < 3; i++) await S.key('ArrowRight', 140);
      const a = await S.snap();
      await S.key('ArrowUp', 320); const b = await S.snap();
      await S.key('ArrowUp', 320); const c = await S.snap();
      await S.key('ArrowDown', 320); const d = await S.snap();
      await S.key('ArrowDown', 320); const e = await S.snap();
      L.log('P1 实验臂：穿过块公式往返', {
        起点: at(a), 上1: at(b), 上2进块: { ...at(c), text: c.headLineText.slice(0, 24) }, 下1出块: at(d), 下2: at(e),
        回到原列: a.headCol === e.headCol, 原col: a.headCol, 终col: e.headCol,
      });
      return e;
    });

    /* P1c 同形状对照臂：同样的"空行夹一层"，但中间那层是普通标题行（无块） */
    await S.guard('P1c', async () => {
      await S.key('Control+Home'); await S.sleep(350);
      const p = await S.posXY(off.l3.from + 12, 0);
      await S.page.mouse.click(p.x, p.y); await S.sleep(400);
      await S.key('Home'); for (let i = 0; i < 12; i++) await S.key('ArrowRight', 110);
      const a = await S.snap();
      await S.key('ArrowUp', 320); const b = await S.snap();
      await S.key('ArrowUp', 320); const c = await S.snap();
      await S.key('ArrowDown', 320); const d = await S.snap();
      await S.key('ArrowDown', 320); const e = await S.snap();
      L.log('P1c 对照臂：穿过普通标题行往返', {
        起点: at(a), 上1: at(b), 上2: { ...at(c), text: c.headLineText.slice(0, 24) }, 下1: at(d), 下2: at(e),
        回到原列: a.headCol === e.headCol, 原col: a.headCol, 终col: e.headCol,
      });
      return e;
    });

    /* P1b 第二次测量（同一次启动内）：从块下一行出发穿过块再回来 */
    await S.guard('P1b', async () => {
      await S.key('Control+Home'); await S.sleep(350);
      const p = await S.posXY(off.l18.from, 0);
      await S.page.mouse.click(p.x, p.y); await S.sleep(350);
      await S.key('Home'); for (let i = 0; i < 12; i++) await S.key('ArrowRight', 100);
      const a = await S.snap();
      await S.key('ArrowUp', 320); const b = await S.snap();
      await S.key('ArrowUp', 320); const c = await S.snap();
      await S.key('ArrowDown', 320); const d = await S.snap();
      await S.key('ArrowDown', 320); const e = await S.snap();
      L.log('P1b 块紧邻行往返', {
        起点: at(a), 上1: at(b), 上2进块: { ...at(c), text: c.headLineText.slice(0, 24) }, 下1出块: at(d), 下2: at(e),
        回到原列: a.headCol === e.headCol, 原col: a.headCol, 终col: e.headCol,
      });
      return e;
    });

    /* P2 围栏行可点性：块源码展开态下，闭围栏 `$$` 行能否用鼠标落位；`$$` 是否当普通字符删 */
    await S.guard('P2', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(500);
      const exp = await S.snap();
      // 直接点闭围栏行（源码展开态，行 7）
      const p = await S.posXY(65, 0);
      await S.page.mouse.click(p.x, p.y); await S.sleep(450);
      const s = await S.snap();
      L.log('P2 点闭围栏行', {
        展开态: at(exp), 点坐标: p,
        落点: { line: s.headLine, col: s.headCol, text: s.headLineText, nMathSrc: s.nMathSrcLine },
        落在围栏行: s.headLineText.trim() === '$$',
      });
      await S.key('End'); await S.sleep(200);
      const pre = await S.snap();
      for (let i = 0; i < 2; i++) await S.key('Backspace', 260);
      await S.sleep(600);
      const after = await S.snap();
      L.log('P2b 退格删掉闭围栏 $$', {
        前: { line: pre.headLine, text: pre.headLineText, docLines: pre.docLines },
        后: { line: after.headLine, text: after.headLineText, docLines: after.docLines, nWidgets: after.nWidgets, nKatex: after.nKatex, nMathSrc: after.nMathSrcLine },
        doc行4到10: after.doc.split('\n').slice(3, 10),
      });
      for (let i = 0; i < 2; i++) await S.key('Control+z', 500);
      const back = await S.snap();
      L.log('P2c 撤销还原', { docLen: back.docLen, 复原: back.docLen === off.docLen, nKatex: back.nKatex });
      return after;
    });

    /* P3 块公式源码内的选区（键盘 + 拖拽） */
    await S.guard('P3', async () => {
      await S.key('Control+Home'); await S.sleep(350);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(350);
      await S.key('Home');
      await S.key('Shift+ArrowDown'); await S.key('Shift+ArrowDown'); await S.key('Shift+End');
      const k = await S.snap();
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(300);
      const a = await S.posXY(29, 0), b = await S.posXY(65, 0);
      await S.page.mouse.move(a.x, a.y); await S.page.mouse.down();
      for (let i = 1; i <= 8; i++) { await S.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / 8), Math.round(a.y + (b.y - a.y) * i / 8)); await S.sleep(50); }
      await S.page.mouse.up(); await S.sleep(450);
      const m = await S.snap();
      L.log('P3 块源码内选区', {
        键盘扩选: { from: k.selFrom, to: k.selTo, text: k.selText.slice(0, 60), nMathSrc: k.nMathSrcLine },
        拖拽选中: { from: m.selFrom, to: m.selTo, text: m.selText.slice(0, 60), empty: m.emptySel, selRects: m.selRects.length },
      });
      return m;
    });

    /* P4 视觉图补拍：选区里的公式（保持渲染 + 选中底色） */
    await S.guard('P4', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const a = await S.posXY(off.l18.from, 0), b = await S.posXY(off.l18.to - 1, 0);
      await S.page.mouse.move(a.x, a.y); await S.page.mouse.down();
      for (let i = 1; i <= 8; i++) { await S.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / 8), a.y); await S.sleep(50); }
      await S.page.mouse.up(); await S.sleep(600);
      const s = await S.snap();
      const f = await marks(S, 'v4-selection', '.cm-content');
      L.log('P4 选区视觉', {
        文件: f, 选区: { from: s.selFrom, to: s.selTo, text: s.selText }, head: at(s),
        selectedWidgets: s.widgets.filter((w) => w.selected).map((w) => w.kind + ' "' + w.glyph.slice(0, 10) + '"'),
        nWidgets: s.nWidgets, nKatex: s.nKatex, selRects: s.selRects.length,
      });
      await S.ev(() => { document.querySelectorAll('.mp-probe-mark').forEach((e) => e.remove()); return true; }).catch(() => { });
      return s;
    });

    L.log('R6-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R6-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
