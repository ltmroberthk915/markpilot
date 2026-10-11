/** math-daily · r3：选中公式复制 —— 剪贴板里应该是**文档源码**（`$…$` / `$$…$$`），不是 KaTeX 字形
 *  用法：node math-daily-r3.cjs "<exe>"
 *  两级尺子：
 *   ① 页内 copy 事件载荷（document 冒泡相读 clipboardData）＝**产品确实写进去的东西**；
 *   ② 渲染侧 navigator.clipboard.readText() 与主进程外 Get-Clipboard ＝跨系统剪贴板（本机锁屏态，预期不可用）。
 */
'use strict';
const L = require('./math-daily-lib.cjs');
const EXE = process.argv[2];
const R = require('./_probe-common.cjs');

(async () => {
  const S = await L.boot({ probe: 'math-daily-r3.cjs', dir: 'r3', exe: EXE });
  const dragXY = async (a, b, steps = 8) => {
    await S.page.mouse.move(a.x, a.y);
    await S.page.mouse.down();
    for (let i = 1; i <= steps; i++) { await S.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / steps), Math.round(a.y + (b.y - a.y) * i / steps)); await S.sleep(45); }
    await S.page.mouse.up();
    await S.sleep(450);
  };
  /** 一次 Ctrl+C 并读全（载荷 + 选区 + 剪贴板三级） */
  const copyOnce = async (tag) => {
    await S.clearCopyLog();
    await S.key('Control+c', 700);
    const ev = await S.copyLog();
    const s = await S.snap();
    const clip = await S.clipReadAll();
    const bubble = ev.filter((e) => e.phase === 'bubble');
    const payload = bubble.length ? bubble[bubble.length - 1].plain : null;
    L.log(tag, {
      选区: { from: s.selFrom, to: s.selTo, empty: s.emptySel, text: s.selText.slice(0, 60) },
      事件: ev.map((e) => ({ phase: e.phase, prevented: e.prevented, types: e.types, plain: e.plain === undefined ? undefined : String(e.plain).slice(0, 80) })),
      剪贴板载荷: payload === null ? null : String(payload).slice(0, 120),
      载荷等于选区源码: payload !== null && payload === s.selText,
      剪贴板: clip,
      nWidgets: s.nWidgets, nKatex: s.nKatex, selectedWidgets: s.widgets.filter((w) => w.selected).length,
    });
    return { payload, sel: s.selText, ev };
  };

  try {
    await S.assertFixture({ minWidgets: 2 });
    const off = await S.ev(() => {
      const d = window.mpEngine._view().state.doc.toString();
      const i1 = d.indexOf('$E=mc^2$'), i2 = d.indexOf('$x+a$');
      const b1s = d.indexOf('$$');
      const b1e = d.indexOf('$$', b1s + 2) + 2;            // 第一个块：闭围栏之后
      const bms = d.indexOf('$$', b1e);                    // 第二个块：开围栏
      const bme = d.indexOf('$$', bms + 2) + 2;            // 第二个块：闭围栏之后
      const seg = '中文紧贴$x+a$紧贴中文';
      const sgs = d.indexOf(seg);
      return {
        inline: { from: i1, to: i1 + 8 }, cjkInline: { from: i2, to: i2 + 5 },
        block1: { from: b1s, to: b1e }, block1Text: d.slice(b1s, b1e),
        blockMulti: { from: bms, to: bme }, blockMultiText: d.slice(bms, bme),
        cjkSeg: { from: sgs, to: sgs + seg.length }, cjkSegText: seg,
        docLen: d.length,
      };
    });
    L.log('R3-0 区间', { ...off, 产物sha16: R.sha16(EXE) });
    if (off.inline.from < 0 || off.blockMulti.from < 0) throw new Error('夹具区间算不出来');

    /* D0 对照：无选区 Ctrl+C —— 产品不该拦截 */
    await S.guard('D0', async () => {
      await S.key('Control+Home'); await S.sleep(400);
      await S.clearCopyLog();
      await S.key('Control+c', 600);
      const ev = await S.copyLog();
      const s = await S.snap();
      L.log('D0 无选区 Ctrl+C（对照）', { 事件: ev.map((e) => ({ phase: e.phase, prevented: e.prevented })), 选区空: s.emptySel, head: s.head });
      return ev;
    });

    /* D1 拖拽选中整段行内公式 → Ctrl+C */
    await S.guard('D1', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickPos(off.inline.from, 0);
      await S.dragSelect(off.inline.from, off.inline.to);
      const r = await copyOnce('D1 行内公式 $E=mc^2$');
      return r;
    });

    /* D2 拖拽选中整块块公式（3 行）→ Ctrl+C */
    await S.guard('D2', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      // 块公式渲染态：直接按 widget 盒拖
      const box = await S.ev(() => {
        const el = document.querySelector('.cm-content .mp-cm6-math-block');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left + 2), r: Math.round(r.right - 2), t: Math.round(r.top + 2), b: Math.round(r.bottom - 2), w: Math.round(r.width), h: Math.round(r.height) };
      });
      if (!box) throw new Error('没有块公式 widget 可拖');
      await dragXY({ x: box.l, y: box.t }, { x: box.r, y: box.b });
      const r = await copyOnce('D2 块公式（拖 widget 盒）');
      L.log('D2-盒', box);
      return r;
    });

    /* D3 键盘扩选整块（点进源码 → Home → Shift+↓×2 → Shift+End）→ Ctrl+C */
    await S.guard('D3', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math-block', 0, 0.5, 0.5);
      await S.sleep(300);
      await S.key('Home');
      await S.key('Shift+ArrowDown'); await S.key('Shift+ArrowDown'); await S.key('Shift+End');
      const s0 = await S.snap();
      const r = await copyOnce('D3 键盘扩选块公式');
      L.log('D3-扩选', { from: s0.selFrom, to: s0.selTo, text: s0.selText.slice(0, 60), 期望区间: off.block1 });
      return r;
    });

    /* D4 中文 + 行内公式混排片段 → Ctrl+C（源码，不是转写字形） */
    await S.guard('D4', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickPos(off.cjkSeg.from, 0);
      await S.dragSelect(off.cjkSeg.from, off.cjkSeg.to);
      const r = await copyOnce('D4 中文混排片段');
      L.log('D4-期望', { 期望区间: off.cjkSeg, 期望文本: await S.ev(({ a, b }) => window.mpEngine._view().state.doc.sliceString(a, b), { a: off.cjkSeg.from, b: off.cjkSeg.to }) });
      return r;
    });

    /* D5 多行块公式（aligned）→ Ctrl+C */
    await S.guard('D5', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      const boxes = await S.ev(() => [...document.querySelectorAll('.cm-content .mp-cm6-math-block')].map((el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left + 2), r: Math.round(r.right - 2), t: Math.round(r.top + 2), b: Math.round(r.bottom - 2), h: Math.round(r.height), glyph: String(el.textContent || '').slice(0, 20) }; }));
      const multi = boxes.find((b) => b.h > 50) || boxes[1];
      if (!multi) throw new Error('找不到多行块公式');
      await dragXY({ x: multi.l, y: multi.t }, { x: multi.r, y: multi.b }, 10);
      const s0 = await S.snap();
      const r = await copyOnce('D5 多行块公式');
      L.log('D5-盒', { 所有块盒: boxes, 选中: multi, 选区: s0.selText.slice(0, 90), 期望区间: off.blockMulti });
      return r;
    });

    /* D6 选区 head 在公式内（源码展开态）→ 载荷仍是源码 */
    await S.guard('D6', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickWidget('.cm-content .mp-cm6-math', 0, 0.5, 0.5);   // 点行内公式 → 源码展开
      await S.sleep(250);
      await S.key('Home');
      for (let i = 0; i < 5; i++) await S.key('ArrowRight', 120);
      const a = await S.snap();
      await S.key('Shift+End');
      const b = await S.snap();
      const r = await copyOnce('D6 源码展开态下选整行');
      L.log('D6-前态', { 起点: { line: a.headLine, col: a.headCol, nMathSrc: a.nMathSrc, nFloats: a.nFloats }, 终选: b.selText });
      return r;
    });

    /* D7 剪切（Ctrl+X）：载荷应为源码；粘贴腿因系统剪贴板不可用 → 环境阻断 */
    await S.guard('D7', async () => {
      await S.key('Control+Home'); await S.sleep(300);
      await S.clickPos(off.inline.from, 0);
      await S.dragSelect(off.inline.from, off.inline.to);
      await S.clearCopyLog();
      await S.key('Control+x', 800);
      const ev = await S.copyLog();
      const s = await S.snap();
      L.log('D7 剪切行内公式', {
        事件: ev.map((e) => ({ phase: e.phase, prevented: e.prevented, plain: e.plain === undefined ? undefined : String(e.plain).slice(0, 60) })),
        文档变短: s.docLen, 原docLen: off.docLen, 差: off.docLen - s.docLen,
        第3行: s.doc.split('\n')[2], 仍渲染: s.nKatex,
      });
      // 撤销还原
      await S.key('Control+z', 600);
      const s2 = await S.snap();
      L.log('D7b 撤销还原', { docLen: s2.docLen, 复原: s2.docLen === off.docLen, 第3行: s2.doc.split('\n')[2] });
      return { ev, s };
    });

    /* D8 系统剪贴板腿（本机锁屏态）：直接问，不推断 */
    await S.guard('D8', async () => {
      const before = await S.ev(async () => { try { return String(await navigator.clipboard.readText()).slice(0, 60); } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 60); } });
      const write = await S.ev(async () => { try { await navigator.clipboard.writeText('MATHDAILY-PROBE-7'); return 'ok'; } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 60); } });
      const sysAfter = S.psGetClip().slice(0, 80);
      L.log('D8 系统剪贴板可用性', { 渲染侧读: before, 渲染侧写: write, 写后系统剪贴板: sysAfter, 自证成功: sysAfter.includes('MATHDAILY-PROBE-7') });
      return { write, sysAfter };
    });

    L.log('R3-汇总', { pageerrors: S.errs, consoleErrors: S.cerrs, boots: S.boots });
  } catch (e) {
    L.log('R3-致命', { err: String((e && e.message) || e).slice(0, 300) });
    console.error(e && e.stack);
  } finally {
    await S.finish(0);
  }
})();
