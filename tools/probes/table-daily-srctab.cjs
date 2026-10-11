/** table-daily 族 · 第二通道：光标在表行但**没有格覆盖层**时的 Tab/Shift+Tab/Enter
 *
 *  为什么必须单列：格覆盖层（点格进入）与源码键位（CM keymap）是**两条实现**，
 *  用户从覆盖层按 Esc 就会掉到这条路上。日常形态："点一下格子 → Esc → 按 Tab"。
 *  判据：CM 光标（head）是否逐格前进 / 跨行 / 末行补行；文档在 Tab 期间不得改变。
 *  用法：node table-daily-srctab.cjs "<exe>"
 */
'use strict';
const L = require('./table-daily-lib.cjs');
const EXE = process.argv[2];
const DOC = [
  '# 表格日常',
  '',
  '前置段落。',
  '',
  '| 甲 | 乙 | 丙 |',
  '| --- | --- | --- |',
  '| a1 | b1 | c1 |',
  '| a2 | b2 | c2 |',
  '',
  '末尾段落。',
  '',
].join('\n');

const P = (s) => ({
  活动格: s.active ? { 行: s.active.lineNo, 列: s.active.col } : null,
  覆盖层可见: s.overlay.visible,
  CM光标: { 行: s.headLine, 列: s.headCol, 在表行: s.headLineIsTable, 行文本: s.headText },
  焦点: s.focus, 文档行数: s.docLines, 文档未变: null, 提示: s.toast,
});

(async () => {
  const S = await L.boot({ probe: 'table-daily-srctab.cjs', dir: 'srctab', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  /** 真实点击表格**左侧 gutter** 把 CM 光标放进表行（实测"点格 → Esc"做不到：点格不动 CM 选区、
   *  Esc 之后 head 还在文档第 1 行 ⇒ 那条路 Tab 根本不在表内）。逐个 y 试，直到 head 真在表行。 */
  const enterRow = async () => {
    const tried = [];
    for (const dy of [0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const g = await S.ev((f) => {
        const t = document.querySelector('.mp-row');
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left - 14), y: Math.round(r.top + r.height * f) };
      }, dy);
      if (!g) break;
      await S.page.mouse.click(g.x, g.y); await S.sleep(420);
      const s = await S.snap();
      tried.push({ dy, 光标行: s.headLine, 列: s.headCol, 在表行: s.headLineIsTable, 覆盖层: !!s.active, 行文本: s.headText.slice(0, 20) });
      if (s.headLineIsTable && !s.active) return { s, tried };
    }
    return { s: null, tried };
  };

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const docBase = base.doc, baseLines = base.docLines;

    /* ── S0 走入这条路：真实点表格左侧 gutter ── */
    await S.guard('S0', async () => {
      const r = await enterRow();
      add('S0 点 gutter 把 CM 光标放进表行', {
        尝试: r.tried,
        成功: !!r.s,
        落点: r.s ? { 行: r.s.headLine, 列: r.s.headCol, 在表行: r.s.headLineIsTable, 焦点: r.s.focus, 覆盖层: !!r.s.active } : null,
      });
      if (!r.s) add('S0·未验证', { 原因: 'gutter 点击没能把 CM 光标放进表行 ⇒ 本探针的这条路走不通（不猜）' });
    });

    /* ── S1 Tab 逐格前进（源码键位路径） ── */
    await S.guard('S1', async () => {
      const r = await enterRow();
      if (!r.s) { add('S1·未验证', { 原因: '进不了表行（同 S0）', 尝试: r.tried }); return; }
      const before = r.s;
      const shots = [];
      for (let i = 1; i <= 3; i++) {
        await S.key('Tab', 420);
        const s = await S.snap();
        shots.push({ 第i次: i, CM光标: { 行: s.headLine, 列: s.headCol }, 在表行: s.headLineIsTable, 活动格: s.active && { 行: s.active.lineNo, 列: s.active.col }, 焦点: s.focus, 文档未变: s.doc === before.doc });
      }
      add('S1 表行内 Tab×3（无覆盖层）', { 起点: { 行: before.headLine, 列: before.headCol }, 每拍: shots, 判据_光标是否真的动了: shots.some((x, i) => i === 0 ? (x.CM光标.行 !== before.headLine || x.CM光标.列 !== before.headCol) : (x.CM光标.列 !== shots[i - 1].CM光标.列 || x.CM光标.行 !== shots[i - 1].CM光标.行)) });
      add('S1·截图', { 图: await S.shot('s1-tab-src', '.mp-row') });
    });

    /* ── S2 Tab 走到末行末格 → 应补行 ── */
    await S.guard('S2', async () => {
      const r0 = await enterRow();
      if (!r0.s) { add('S2·未验证', { 原因: '进不了表行（同 S0）' }); return; }
      let appended = null;
      const trail = [];
      for (let i = 0; i < 10; i++) {
        const before = await S.snap();
        await S.key('Tab', 400);
        const after = await S.snap();
        trail.push({ 第i次: i + 1, 前: { 行: before.headLine, 列: before.headCol }, 后: { 行: after.headLine, 列: after.headCol }, 行数: after.docLines, 焦点: after.focus });
        if (after.docLines > baseLines) { appended = after; break; }
        if (!after.headLineIsTable) break;          // 掉出表格
      }
      add('S2 连续 Tab 到末行', {
        轨迹: trail,
        判据_补行: !!appended,
        新行: appended ? appended.doc.split('\n')[8] : null,
        补行后活动格: appended && appended.active ? { 行: appended.active.lineNo, 列: appended.active.col } : null,
        补行后文档行数: appended ? appended.docLines : null,
      });
      if (appended) {
        await S.key('Control+z', 700);
        add('S2b 撤销补行', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
      }
    });

    /* ── S3 Shift+Tab 反向 ── */
    await S.guard('S3', async () => {
      const r0 = await enterRow();
      if (!r0.s) { add('S3·未验证', { 原因: '进不了表行（同 S0）' }); return; }
      /* 先向右走两格，再反向走两格（否则起点就在第 1 格，反向本来就是"顶停"） */
      await S.key('Tab', 400); await S.key('Tab', 400);
      const before = await S.snap();
      await S.key('Shift+Tab', 450);
      const s1 = await S.snap();
      await S.key('Shift+Tab', 450);
      const s2 = await S.snap();
      add('S3 表行内 Shift+Tab×2', {
        起: { 行: before.headLine, 列: before.headCol },
        一: { 行: s1.headLine, 列: s1.headCol, 在表行: s1.headLineIsTable, 文档未变: s1.doc === docBase },
        二: { 行: s2.headLine, 列: s2.headCol, 在表行: s2.headLineIsTable, 文档未变: s2.doc === docBase },
        判据_逐格后退: s1.headCol < before.headCol || s1.headLine < before.headLine,
      });
    });

    /* ── S4 Enter（源码键位路径）：下移一格 / 末行补行 ── */
    await S.guard('S4', async () => {
      const r0 = await enterRow();
      if (!r0.s) { add('S4·未验证', { 原因: '进不了表行（同 S0）' }); return; }
      const b = await S.snap();
      await S.key('Enter', 500);
      const a1 = await S.snap();
      add('S4 表行内 Enter', {
        前: { 行: b.headLine, 列: b.headCol },
        后: { 行: a1.headLine, 列: a1.headCol, 在表行: a1.headLineIsTable },
        判据_下移一格: a1.headLine > b.headLine || a1.headCol > b.headCol,
        判据_文档未变: a1.doc === docBase,
        提示: a1.toast,
      });
      await S.key('Control+z', 600);
      add('S4b 撤销后', { 判据_文档回原状: (await S.snap()).doc === docBase });
    });

    add('S99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots });
  } catch (e) {
    add('S-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
