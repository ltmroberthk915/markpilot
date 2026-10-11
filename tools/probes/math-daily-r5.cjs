/** math-daily · r5：列稳定（键盘走位，避免"点击＝移动"自伤）+ 视觉取证（按浏览器自报光标矩形画标记）
 *  用法：node math-daily-r5.cjs "<exe>"
 *  标记口径（AGENTS 交互验收§一.3）：红实线＝光标落点、琥珀虚线＝选区、青虚线＝被选中的公式 widget 盒。
 *  CDP 抓帧拍不到原生光标，故标记按 coordsAtPos / getBoundingClientRect 自报值画。
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const at = (s) => ({ line: s.headLine, col: s.headCol, x: s.cursorRect ? s.cursorRect.x : null, w: s.cursorRect ? s.cursorRect.w : null, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats, nWidgets: s.nWidgets, sel: s.selText.slice(0, 24) });

(async () => {
  const S = await L.boot({ probe: 'math-daily-r5.cjs', dir: 'r5', exe: EXE });
  const marks = async (label, clipSel) => {
    const m = await S.ev((sel) => {
      document.querySelectorAll('.mp-probe-mark').forEach((e) => e.remove());
      const mk = (r, css) => {
        const d = document.createElement('div');
        d.className = 'mp-probe-mark';
        d.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;box-sizing:border-box;' + css
          + ';left:' + r.left + 'px;top:' + r.top + 'px;width:' + Math.max(2, r.width) + 'px;height:' + Math.max(2, r.height) + 'px';
        document.body.appendChild(d);
      };
      const out = { caret: null, sel: [], widgets: [] };
      const cur = document.querySelector('.cm-cursor-primary') || document.querySelector('.cm-cursor');
      if (cur) { const r = cur.getBoundingClientRect(); out.caret = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; if (r.height > 0) mk(r, 'border:2px solid #ff2d2d;background:transparent'); }
      for (const e of document.querySelectorAll('.cm-selectionBackground')) { const r = e.getBoundingClientRect(); out.sel.push({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }); mk(r, 'border:1px dashed #ffb020;background:rgba(255,176,32,.18)'); }
      for (const e of document.querySelectorAll('.mp-math-selected')) { const r = e.getBoundingClientRect(); out.widgets.push({ cls: String(e.className), left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }); mk(r, 'border:1px dashed #00c2d1;background:transparent'); }
      return out;
    }, clipSel).catch(() => null);
    const f = await S.shot(label, clipSel);
    return { file: f, marks: m };
  };
  const clearMarks = () => S.ev(() => { document.querySelectorAll('.mp-probe-mark').forEach((e) => e.remove()); return true; }).catch(() => { });

  try {
    await S.assertFixture({ minWidgets: 2 });
    const off = await S.ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc.toString();
      const l18 = v.state.doc.line(18), l20 = v.state.doc.line(20);
      const i2 = d.indexOf('$x+a$');
      return { l18: { from: l18.from, to: l18.to, text: l18.text }, l20: { from: l20.from, text: l20.text }, inline2: { from: i2, to: i2 + 5 }, docLen: d.length };
    });
    L.log('R5-0 夹具', off);

    /* N1 行内公式逐字符穿越：→ 穿过 `$x+a$` 不许跳格、光标矩形恒在 */
    await S.guard('N1', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      // 键盘走位到行 18 行首（点第 18 行再 Home，避免点公式）
      const p = await S.posXY(off.l18.from + 8, 0);
      await S.page.mouse.click(p.x, p.y); await S.sleep(350);
      await S.key('Home');
      const seq = [at(await S.snap())];
      for (let i = 0; i < 12; i++) { await S.key('ArrowRight', 170); const s = await S.snap(); seq.push({ ...at(s), dom: (s.lines.find((l) => l.text.includes('中文紧贴')) || {}).text }); }
      L.log('N1 逐字符穿过行内公式', {
        序列: seq,
        列单调递增: seq.every((r, i) => i === 0 || r.col === seq[i - 1].col + 1),
        光标矩形恒在: seq.every((r) => r.w > 0),
        '源码↔渲染切换点': seq.map((r) => r.nWidgets).join(','),
        浮层出现于: seq.map((r, i) => (r.nFloats ? i : null)).filter((x) => x !== null),
      });
      return seq;
    });

    /* N2 ↑↓ 往返：公式行 ↔ 相邻行，回来必须回到同一 head（列稳定） */
    await S.guard('N2', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const p = await S.posXY(off.l18.from, 0);
      await S.page.mouse.click(p.x, p.y); await S.sleep(350);
      await S.key('Home'); for (let i = 0; i < 12; i++) await S.key('ArrowRight', 120);
      const a = await S.snap();
      await S.key('ArrowUp', 320); const b = await S.snap();
      await S.key('ArrowDown', 320); const c = await S.snap();
      await S.key('ArrowUp', 320); await S.key('ArrowUp', 320); const d = await S.snap();
      await S.key('ArrowDown', 320); await S.key('ArrowDown', 320); const e = await S.snap();
      L.log('N2 ↑↓ 往返列稳定', {
        A: at(a), B_up: at(b), C_down: at(c), D_up2: at(d), E_down2: at(e),
        回原head: a.head === c.head && a.head === e.head,
        目标列保卫: a.headCol === c.headCol && a.headCol === e.headCol,
      });
      return e;
    });

    /* N3 删除多行块闭围栏（带每步 trace）→ 只记录现象，随后撤销还原 */
    await S.guard('N3', async () => {
      await S.key('Control+Home'); await S.sleep(350);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 1, 0.35, 0.5);
      await S.sleep(350);
      const trace = [];
      await S.key('Home');
      for (let i = 0; i < 8; i++) {
        const s = await S.snap();
        trace.push({ i, line: s.headLine, col: s.headCol, text: s.headLineText.slice(0, 22), nMathSrc: s.nMathSrcLine, x: s.cursorRect && s.cursorRect.x });
        if (s.headLineText.trim() === '$$' && s.headLine > 12) break;
        await S.key('ArrowDown', 300);
      }
      const atClose = await S.snap();
      L.log('N3-0 走到闭围栏', { trace, 落点: { line: atClose.headLine, text: atClose.headLineText, col: atClose.headCol } });
      await S.key('End'); await S.sleep(200);
      const pre = await S.snap();
      for (let i = 0; i < 2; i++) await S.key('Backspace', 250);
      await S.sleep(500);
      const s = await S.snap();
      L.log('N3 删掉闭围栏 $$', {
        前: { line: pre.headLine, text: pre.headLineText, docLines: pre.docLines },
        后: { line: s.headLine, text: s.headLineText, docLines: s.docLines, nWidgets: s.nWidgets, nKatex: s.nKatex, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats },
        doc: s.doc.split('\n').slice(9, 18),
      });
      for (let i = 0; i < 2; i++) await S.key('Control+z', 500);
      const back = await S.snap();
      L.log('N3b 撤销还原', { docLen: back.docLen, 复原: back.docLen === off.docLen, nKatex: back.nKatex });
      return s;
    });

    /* ── 视觉取证 ─────────────────────────────────────────────────────────── */
    await S.guard('V1', async () => {
      await S.key('Control+Home'); await S.sleep(500);
      const s = await S.snap();
      const m = await marks('v1-baseline', '.cm-content');
      const st = await S.snap();
      L.log('V1 基线渲染态', { 文件: m.file, head: at(st), 标记: m.marks, nKatex: st.nKatex });
      await clearMarks();
      return st;
    });

    await S.guard('V2', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const hit = await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.5, 0.5);
      await S.sleep(600);
      const s = await S.snap();
      const m = await marks('v2-inline-source', '.cm-content');
      L.log('V2 点开行内公式（源码+浮层）', { 文件: m.file, 盒: hit.box, head: at(s), 标记: m.marks, 行3DOM: (s.lines.find((l) => l.text.includes('行内公式')) || {}).text });
      await clearMarks();
      return s;
    });

    await S.guard('V3', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const hit = await S.clickWidget('.cm-content .mp-cm6-math-block', 1, 0.5, 0.5);
      await S.sleep(700);
      const s = await S.snap();
      const m = await marks('v3-multiline-source', '.cm-content');
      L.log('V3 点开多行块公式（6 行源码居中）', { 文件: m.file, 盒: hit.box, head: at(s), 标记: m.marks, nMathSrc: s.nMathSrcLine, srcLineNo: s.lines.filter((l) => l.isMathSrc).map((l) => l.text.slice(0, 18)) });
      await clearMarks();
      return s;
    });

    await S.guard('V4', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      // 选区含两个行内公式但 head 在选区尾部（公式保持渲染＋选中底色）
      const a = await S.posXY(off.l18.from, 0), b = await S.posXY(off.l18.to + 1, 0);
      await S.page.mouse.move(a.x, a.y); await S.page.mouse.down();
      for (let i = 1; i <= 6; i++) { await S.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / 6), a.y); await S.sleep(50); }
      await S.page.mouse.up(); await S.sleep(600);
      const s = await S.snap();
      const m = await marks('v4-selection', '.cm-content');
      L.log('V4 选区里的公式（保持渲染+选中底色）', {
        文件: m.file, 选区: { from: s.selFrom, to: s.selTo, text: s.selText }, head: at(s),
        标记: m.marks, selectedWidgets: s.widgets.filter((w) => w.selected).map((w) => w.kind + '"' + w.glyph.slice(0, 10) + '"'),
        nWidgets: s.nWidgets, nKatex: s.nKatex,
      });
      await clearMarks();
      return s;
    });

    await S.guard('V5', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      const bx = await S.ev(() => { const el = document.querySelector('.cm-content .mp-cm6-math-block'); const r = el.getBoundingClientRect(); return { l: Math.round(r.left + 2), r: Math.round(r.right - 2), t: Math.round(r.top + 2), b: Math.round(r.bottom - 2) }; });
      await S.page.mouse.move(bx.l, bx.t); await S.page.mouse.down();
      for (let i = 1; i <= 8; i++) { await S.page.mouse.move(Math.round(bx.l + (bx.r - bx.l) * i / 8), Math.round(bx.t + (bx.b - bx.t) * i / 8)); await S.sleep(50); }
      await S.page.mouse.up(); await S.sleep(700);
      const s = await S.snap();
      const m = await marks('v5-block-drag-no-selection', '.cm-content');
      L.log('V5 在渲染态块公式上拖拽（预期无高亮）', {
        文件: m.file, 盒: bx,
        选区: { from: s.selFrom, to: s.selTo, empty: s.emptySel, text: s.selText },
        head: at(s), 标记: m.marks, DOM选区: s.domSel, nMathSrc: s.nMathSrcLine, nFloats: s.nFloats,
      });
      await clearMarks();
      return s;
    });

    L.log('R5-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R5-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
