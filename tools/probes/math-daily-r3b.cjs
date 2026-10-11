/** math-daily · r3b：块公式"鼠标拖拽选中"为什么选不中（原生选区 vs CM 状态选区）+ 剪切载荷
 *  用法：node math-daily-r3b.cjs "<exe>"
 *  对照臂（同源同类）：同样手法在**普通中文段落**上拖一次 —— 用来排除"我的拖拽实现坏了"。
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];

(async () => {
  const S = await L.boot({ probe: 'math-daily-r3b.cjs', dir: 'r3b', exe: EXE });
  const dragXY = async (a, b, steps = 8) => {
    await S.clearCopyLog();
    await S.page.mouse.move(a.x, a.y);
    await S.page.mouse.down();
    for (let i = 1; i <= steps; i++) { await S.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / steps), Math.round(a.y + (b.y - a.y) * i / steps)); await S.sleep(50); }
    await S.page.mouse.up();
    await S.sleep(500);
  };
  const boxOf = (idx) => S.ev((i) => {
    const els = [...document.querySelectorAll('.cm-content .mp-cm6-math-block')];
    const el = els[i]; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: Math.round(r.left + 2), r: Math.round(r.right - 2), t: Math.round(r.top + 2), b: Math.round(r.bottom - 2), h: Math.round(r.height), glyph: String(el.textContent || '').slice(0, 24) };
  }, idx);

  try {
    await S.assertFixture({ minWidgets: 2 });
    const off = await S.ev(() => {
      const d = window.mpEngine._view().state.doc.toString();
      const b1s = d.indexOf('$$'); const b1e = d.indexOf('$$', b1s + 2) + 2;
      const bms = d.indexOf('$$', b1e); const bme = d.indexOf('$$', bms + 2) + 2;
      const para = '中文紧贴$x+a$紧贴中文';
      const ps = d.indexOf(para);
      return { block1: { from: b1s, to: b1e }, blockMulti: { from: bms, to: bme }, para: { from: ps, to: ps + para.length }, docLen: d.length };
    });
    L.log('R3b-0 区间', off);

    /* B0 对照臂：普通中文段落上拖拽（同手法） */
    await S.guard('B0', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const a = await S.posXY(off.para.from, 0), b = await S.posXY(off.para.to, 0);
      await dragXY(a, b, 8);
      const s = await S.snap();
      const mlog = await S.mouseLog();
      await S.clearCopyLog();
      await S.key('Control+c', 700);
      const ev = await S.copyLog();
      const bubble = ev.filter((e) => e.phase === 'bubble');
      L.log('B0 对照：普通段落拖拽', {
        选区: { from: s.selFrom, to: s.selTo, empty: s.emptySel, text: s.selText },
        鼠标轨迹: mlog.filter((m) => m.t !== 'mousemove'),
        载荷: bubble.length ? String(bubble[bubble.length - 1].plain) : null,
        载荷等于选区源码: bubble.length > 0 && bubble[bubble.length - 1].plain === s.selText,
      });
      return s;
    });

    /* B1 渲染态单行块公式上按下并拖动 */
    await S.guard('B1', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const bx = await boxOf(0);
      const pre = await S.snap();
      L.log('B1-0 拖前', { 盒: bx, nWidgets: pre.nWidgets, nMathSrc: pre.nMathSrc, domSel: pre.domSel });
      await dragXY({ x: bx.l, y: bx.t }, { x: bx.r, y: bx.b }, 8);
      const s = await S.snap();
      const mlog = await S.mouseLog();
      await S.clearCopyLog();
      await S.key('Control+c', 700);
      const ev = await S.copyLog();
      const bubble = ev.filter((e) => e.phase === 'bubble');
      const payload = bubble.length ? String(bubble[bubble.length - 1].plain) : null;
      L.log('B1 渲染态块公式上拖拽', {
        期望源码: off.block1,
        鼠标轨迹: mlog,
        选区: { from: s.selFrom, to: s.selTo, empty: s.emptySel, text: s.selText.slice(0, 60) },
        DOM选区: s.domSel, nMathSrc: s.nMathSrc, nWidgets: s.nWidgets,
        载荷: payload,
        载荷等于块源码: payload === await S.ev(({ a, b }) => window.mpEngine._view().state.doc.sliceString(a, b), { a: off.block1.from, b: off.block1.to }),
        载荷含围栏: payload != null && payload.includes('$$'),
      });
      return s;
    });

    /* B2 渲染态多行块公式上拖拽 */
    await S.guard('B2', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const bx = await boxOf(1);
      await dragXY({ x: bx.l, y: bx.t }, { x: bx.r, y: bx.b }, 10);
      const s = await S.snap();
      const mlog = await S.mouseLog();
      await S.clearCopyLog();
      await S.key('Control+c', 700);
      const ev = await S.copyLog();
      const bubble = ev.filter((e) => e.phase === 'bubble');
      const payload = bubble.length ? String(bubble[bubble.length - 1].plain) : null;
      L.log('B2 渲染态多行块公式拖拽', {
        盒: bx, 期望源码区间: off.blockMulti, 鼠标轨迹: mlog.filter((m) => m.t !== 'mousemove'),
        选区: { from: s.selFrom, to: s.selTo, empty: s.emptySel, text: s.selText.slice(0, 60) },
        DOM选区: s.domSel ? { text: s.domSel.text, collapsed: s.domSel.collapsed } : null,
        载荷: payload, 载荷含围栏: payload != null && payload.includes('$$'),
      });
      return s;
    });

    /* B3 先点进源码，再在源码上拖 整块区间 */
    await S.guard('B3', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(400);
      const mid = await S.snap();
      const a = await S.posXY(off.block1.from, 0), b = await S.posXY(off.block1.to, 0);
      await dragXY(a, b, 8);
      const s = await S.snap();
      const mlog = await S.mouseLog();
      await S.clearCopyLog();
      await S.key('Control+c', 700);
      const ev = await S.copyLog();
      const bubble = ev.filter((e) => e.phase === 'bubble');
      const payload = bubble.length ? String(bubble[bubble.length - 1].plain) : null;
      const want = await S.ev(({ a, b }) => window.mpEngine._view().state.doc.sliceString(a, b), { a: off.block1.from, b: off.block1.to });
      L.log('B3 源码态拖整块', {
        点进后: { headLine: mid.headLine, headCol: mid.headCol, nMathSrc: mid.nMathSrc, nFloats: mid.nFloats },
        端点: { a, b }, 鼠标轨迹: mlog.filter((m) => m.t !== 'mousemove'),
        选区: { from: s.selFrom, to: s.selTo, empty: s.emptySel, text: s.selText.slice(0, 60) },
        载荷: payload, 期望: want, 相符: payload === want,
      });
      return s;
    });

    /* B4 Ctrl+X 剪切行内公式：cut 事件载荷 + 文档 + 撤销 */
    await S.guard('B4', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const i1 = await S.ev(() => window.mpEngine._view().state.doc.toString().indexOf('$E=mc^2$'));
      await S.clickPos(i1, 0);
      await S.dragSelect(i1, i1 + 8);
      const pre = await S.snap();
      await S.clearCopyLog();
      await S.key('Control+x', 800);
      const cut = await S.cutLog();
      const s = await S.snap();
      L.log('B4 剪切行内公式', {
        剪前选区: { from: pre.selFrom, to: pre.selTo, text: pre.selText },
        cut事件: cut,
        剪切后: { docLen: s.docLen, 第3行: s.doc.split('\n')[2], nKatex: s.nKatex },
        剪掉字节数: off.docLen - s.docLen,
      });
      await S.key('Control+z', 700);
      const s2 = await S.snap();
      L.log('B4b 一次撤销还原', { docLen: s2.docLen, 复原: s2.docLen === off.docLen, 第3行: s2.doc.split('\n')[2] });
      return s;
    });

    L.log('R3b-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R3b-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
