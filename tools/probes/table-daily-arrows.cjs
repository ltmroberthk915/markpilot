/** table-daily 族 · 方向键跨格 + 打字落点（补齐 K8/K9 的口径）
 *
 *  为什么要单独一发：
 *   · K8 只按了两次右键（格子文本 " b1 " 只有 4 字符），没到"格尾再按"这一拍 —— 而"跨格"恰恰
 *     只在那一拍才看得出来；
 *   · K9 点的是格子**正中**，落点按点击比例算到文本中间（"c1" → "cXY1"），断言写成"含 c1XY"是**我的判据错**，
 *     不是产品错。这里把"点右缘 / 按 End 再打字 = 追加到格尾"单独量一遍。
 *  用法：node table-daily-arrows.cjs "<exe>"
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
  活动格: s.active ? { 行: s.active.lineNo, 列: s.active.col, 编辑面: s.active.domText, 源行: s.active.srcText } : null,
  CM光标: { 行: s.headLine, 列: s.headCol },
  DOM选区: s.domSel,
  焦点: s.focus, 提示: s.toast,
  文档行数: s.docLines,
});

(async () => {
  const S = await L.boot({ probe: 'table-daily-arrows.cjs', dir: 'arrows', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |' });
    const docBase = base.doc;

    /* ── A1 光标推到格尾（真实点格子右缘）再连按 → / ← ── */
    await S.guard('A1', async () => {
      const g = await S.ev(() => {
        const t = document.querySelectorAll('.mp-row')[1];
        const cell = t.querySelectorAll('th,td')[1];              // 数据行 1 第 2 格（源文本 " b1 "）
        const b = cell.getBoundingClientRect();
        return { x: Math.round(b.right - 4), y: Math.round(b.top + b.height / 2), text: String(cell.textContent).trim() };
      });
      await S.page.mouse.click(g.x, g.y); await S.sleep(600);
      const s0 = await S.snap();
      add('A1 点格子右缘', { 点在哪: g, 读数: P(s0) });
      const seq = [s0];
      for (let i = 1; i <= 3; i++) { await S.key('ArrowRight', 350); seq.push(await S.snap()); }
      add('A1b 格尾连按 →×3', {
        每拍: seq.map((s) => ({ 活动格: s.active && { 行: s.active.lineNo, 列: s.active.col }, DOM偏移: s.domSel && s.domSel.off, 焦点: s.focus, 文档未变: s.doc === docBase })),
        判据_是否跨到下一格: seq.some((s) => s.active && s.active.col === 2),
      });
      const left = [];
      for (let i = 1; i <= 3; i++) { await S.key('ArrowLeft', 350); left.push(await S.snap()); }
      add('A1c 连按 ←×3', {
        每拍: left.map((s) => ({ 活动格: s.active && { 行: s.active.lineNo, 列: s.active.col }, DOM偏移: s.domSel && s.domSel.off, 文档未变: s.doc === docBase })),
        判据_是否跨回上一格: left.some((s) => s.active && s.active.col === 0),
      });
    });

    /* ── A2 格内 ↓/↑ 是否跨行 ── */
    await S.guard('A2', async () => {
      await S.clickCell(1, 1);
      const s0 = await S.snap();
      await S.key('ArrowDown', 400);
      const s1 = await S.snap();
      await S.key('ArrowUp', 400);
      const s2 = await S.snap();
      add('A2 格内 ↓/↑（中间行）', {
        起: P(s0), '按↓': P(s1), '按↑': P(s2),
        判据_是否跨行: !!(s1.active && s1.active.lineNo !== 7) || !!(s2.active && s2.active.lineNo !== 7),
      });
    });

    /* ── A3 打字落点：格尾追加（对照 K9 的点中部落点） ── */
    await S.guard('A3', async () => {
      const g = await S.ev(() => {
        const t = document.querySelectorAll('.mp-row')[1];
        const cell = t.querySelectorAll('th,td')[2];              // 数据行 1 第 3 格 c1
        const b = cell.getBoundingClientRect();
        return { x: Math.round(b.right - 3), y: Math.round(b.top + b.height / 2), left: Math.round(b.left), right: Math.round(b.right) };
      });
      await S.page.mouse.click(g.x, g.y); await S.sleep(600);
      const s0 = await S.snap();
      await S.type('XY', 650);
      const s1 = await S.snap();
      add('A3 点格子右缘后打字', {
        格子几何: g, 落点: P(s0), 打字后: P(s1),
        第7行: s1.doc.split('\n')[6],
        判据_追加到格尾: s1.doc.includes('c1XY'),
        判据_结构未破: s1.rows.every((r, i) => r.n === base.rows[i].n),
      });
      await S.key('Control+z', 700);
      add('A3b 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    /* ── A4 End 键 + 打字（键盘路径的落点） ── */
    await S.guard('A4', async () => {
      await S.clickCell(1, 2);
      await S.key('End', 300);
      const s0 = await S.snap();
      await S.type('Q', 650);
      const s1 = await S.snap();
      add('A4 点格中部 + End + 打字', {
        End后: P(s0), 打字后: P(s1),
        第7行: s1.doc.split('\n')[6],
        判据_追加到格尾: s1.doc.includes('c1Q'),
      });
      await S.key('Control+z', 700);
      add('A4b 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    add('A99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots });
  } catch (e) {
    add('A-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
