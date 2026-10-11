/** table-daily 族 · 撤销与结构守恒（撤销一次回到原状）
 *
 *  判据：每个"一次按键/一次输入"的操作之后，**一次 Ctrl+Z** 必须让文档逐字节回到操作前。
 *  做不到时继续按 Ctrl+Z 直到回原状，记下"要几次"（这本身就是读数，不猜）。
 *  用法：node table-daily-undo.cjs "<exe>"
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
  活动格: s.active ? { 行: s.active.lineNo, 列: s.active.col, 编辑面: s.active.domText } : null,
  文档行数: s.docLines, 文档长度: s.docLen, 焦点: s.focus, 提示: s.toast,
  渲染表: s.rows.map((r) => r.cells.join('·')),
});

(async () => {
  const S = await L.boot({ probe: 'table-daily-undo.cjs', dir: 'undo', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  /** 一次 Ctrl+Z 后回原状？回不去就继续按，记下要几次（不猜）。 */
  const undoProbe = async (id, label, before, extra) => {
    await S.key('Control+z', 750);
    let s = await S.snap(), n = 1;
    const first = s.doc === before.doc;
    while (s.doc !== before.doc && n < 4) { await S.key('Control+z', 650); s = await S.snap(); n++; }
    add(id, {
      操作: label,
      ...(extra || {}),
      一次撤销回原状: first,
      回到原状用了几次: s.doc === before.doc ? n : '未回到（' + n + ' 次后仍不同）',
      撤销后文档: s.doc.split('\n').slice(4, 11),
      撤销后活动格: P(s).活动格,
    });
    return { first, n, back: s.doc === before.doc };
  };

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |' });
    const docBase = base.doc;
    add('U0 夹具就位', { 文档行数: base.docLines, 渲染表: base.rows.map((r) => r.cells.join('·')) });

    /* ── U1 打字 → 一次撤销 ── */
    await S.guard('U1', async () => {
      await S.clickCell(1, 0);
      const before = await S.snap();
      await S.type('Z', 750);
      const after = await S.snap();
      add('U1 打字落地', { 前: P(before), 后: P(after), 判据_落地: after.doc.includes('a1Z') });
      await undoProbe('U1b 打字→撤销', '格内打一个字符 Z', before);
    });

    /* ── U2 末行 Tab 补行 → 一次撤销 ── */
    await S.guard('U2', async () => {
      await S.clickCell(2, 2);
      const before = await S.snap();
      await S.key('Tab', 650);
      const after = await S.snap();
      add('U2 补行落地', { 前: P(before), 后: P(after), 判据_行数加一: after.docLines === before.docLines + 1, 新行: after.doc.split('\n')[8] });
      await undoProbe('U2b 补行→撤销', '末行末格 Tab 补一行', before);
    });

    /* ── U3 Shift+Enter（插入 <br>）→ 一次撤销 ── */
    await S.guard('U3', async () => {
      await S.clickCell(1, 1);
      const before = await S.snap();
      await S.key('Shift+Enter', 650);
      const after = await S.snap();
      add('U3 格内换行落地', { 前: P(before), 后: P(after), 判据_出现br: after.doc.includes('<br>') });
      await undoProbe('U3b 换行→撤销', 'Shift+Enter 插 <br>', before);
    });

    /* ── U4 打字 + 补行 → 一次撤销只退最后一步 ── */
    await S.guard('U4', async () => {
      await S.clickCell(1, 0);
      const before = await S.snap();
      await S.type('Q', 1000);
      for (let i = 0; i < 4; i++) await S.key('Tab', 420);   // 走到末行末格再补行
      await S.sleep(600);
      const after = await S.snap();
      add('U4 两操作落地', { 前: P(before), 后: P(after), 行数差: after.docLines - before.docLines, 文档: after.doc.split('\n').slice(4, 11) });
      await S.key('Control+z', 800);
      const s1 = await S.snap();
      add('U4b 一次撤销', {
        文档: s1.doc.split('\n').slice(4, 11),
        判据_补行消失: s1.docLines === after.docLines - 1,
        判据_Q仍在: s1.doc.includes('a1Q'),
        判据_未回到最初: s1.doc !== before.doc,
      });
      await S.key('Control+z', 800);
      const s2 = await S.snap();
      add('U4c 二次撤销', { 判据_回到最初: s2.doc === before.doc, 文档: s2.doc.split('\n').slice(4, 11) });
    });

    /* ── U5 三个格各打一个字符 → 结构守恒 + 逐步撤销 ── */
    await S.guard('U5', async () => {
      const before = await S.snap();
      const typed = [];
      for (const [r, c, ch] of [[1, 0, '1'], [1, 1, '2'], [1, 2, '3']]) {
        await S.clickCell(r, c);
        await S.type(ch, 750);
        typed.push({ 格: r + '/' + c, 字符: ch });
      }
      const after = await S.snap();
      const pipes = after.doc.split('\n').filter((l) => /^\s*\|/.test(l)).map((l) => (l.match(/(?<!\\)\|/g) || []).length);
      add('U5 三格各打一字符', {
        typed,
        第7行: after.doc.split('\n')[6],
        每行管道数: pipes,
        判据_管道数一致: pipes.every((n) => n === pipes[0]),
        判据_行数不变: after.docLines === before.docLines,
        渲染表: after.rows.map((r) => r.cells.join('·')),
        无反应: after.doc === before.doc,
      });
      add('U5·截图', { 图: await S.shot('u5-three-cells-typed', '.mp-row') });
      const need = await undoProbe('U5b 三格打字→撤销', '三格各打一个字符', before);
      add('U5c 撤销次数', { 一次够不够: need.first, 实际次数: need.n, 回到原状: need.back });
    });

    /* ── U6 中文输入（真实 Input.insertText 通道） ── */
    await S.guard('U6', async () => {
      await S.clickCell(1, 0);
      const before = await S.snap();
      await S.page.keyboard.insertText('中文'); await S.sleep(850);
      const after = await S.snap();
      add('U6 中文输入', {
        前: P(before), 后: P(after),
        第7行: after.doc.split('\n')[6],
        判据_落地: after.doc.includes('中文'),
        判据_结构未破: after.rows.every((r, i) => r.n === before.rows[i].n),
        提示: after.toast,
      });
      await undoProbe('U6b 中文→撤销', '格内输入「中文」', before);
    });

    /* ── U7 终态：文档逐字节回到最初 ── */
    const s = await S.snap();
    add('U7 终态', {
      判据_逐字节回原状: s.doc === docBase,
      文档: s.doc.split('\n'),
      渲染表: s.rows.map((r) => r.cells.join('·')),
      pageerror: S.errs.slice(0, 6), consoleError: S.cerrs.slice(0, 6), 启动次数: S.boots,
    });
  } catch (e) {
    add('U-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
