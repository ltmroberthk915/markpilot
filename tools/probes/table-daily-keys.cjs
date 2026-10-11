/** table-daily 族 · 键位与打字（表格日常操作）
 *
 *  覆盖：光标在表中按 Tab（格间前进）/ Shift+Tab / Enter / Shift+Enter /
 *        方向键跨格 / 格内打字不破坏结构 / 末行 Tab 新增一行。
 *  输入一律真实通道：page.mouse（真实点击进格）+ page.keyboard（真实按键）。
 *  每个用例包在 S.guard 里：页面被**外部 taskkill** 杀掉时换 profile 重启并重跑（见 lib 头注）。
 *  用法：node table-daily-keys.cjs "<exe>"
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

/** 读数瘦身：只留判据用得到的字段（原始读数已落盘 result.json） */
const P = (s) => ({
  活动格: s.active ? { 行: s.active.lineNo, 列: s.active.col, 编辑面: s.active.domText, 源行: s.active.srcText } : null,
  覆盖层: s.overlay,
  文档行数: s.docLines, 文档长度: s.docLen,
  焦点: s.focus, 有窗口焦点: s.hasFocus,
  CM光标: { 行: s.headLine, 列: s.headCol, 行文本: s.headText },
  提示: s.toast,
  渲染表: s.rows.map((r) => r.cells.join('·')),
  行源偏移: s.rows.map((r) => r.rowFrom),
});

(async () => {
  const S = await L.boot({ probe: 'table-daily-keys.cjs', dir: 'keys', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);
  /** 无反应判据：按键前后 (文档 + CM 光标 + 活动格) 三项**全同** */
  const same = (a, b) => a.doc === b.doc && a.head === b.head && !!a.active === !!b.active
    && (!a.active || (a.active.rowFrom === b.active.rowFrom && a.active.col === b.active.col));
  const needFocus = (s, id) => { if (!String(s.focus || '').includes('mp-cell-overlay-text')) add(id + '·前置', { 警告: '焦点不在格编辑面', 焦点: s.focus, 有窗口焦点: s.hasFocus }); };

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |' });
    const docBase = base.doc, baseLines = base.docLines;
    add('K0 夹具就位', { 断言: '不是回退值', 文档行数: baseLines, 渲染表: base.rows.map((r) => r.cells.join('·')), 表格数: base.tables });

    /* ── K1–K5：点表头首格 → Tab 前进 → 跨行 → Shift+Tab 回跳 → 顶停 ── */
    await S.guard('K1-K5', async () => {
      const g0 = await S.clickCell(0, 0);
      let s = await S.snap(); needFocus(s, 'K1');
      add('K1 点表头首格', { 点在哪: g0, 读数: P(s), 判据_覆盖层激活: !!s.active && s.overlay.visible, 判据_格内文本对: s.overlay.text !== null && s.overlay.text.trim() === '甲' });
      add('K1·截图', { 图: await S.shot('k1-click-header', '.mp-row') });

      for (const i of [1, 2]) {
        const before = await S.snap();
        await S.key('Tab', 420);
        const after = await S.snap();
        add('K2 Tab→第' + (i + 1) + '格', {
          读数: P(after),
          判据_列前进: !!after.active && after.active.col === i,
          判据_格内文本对: ['乙', '丙'][i - 1] === String(after.overlay.text || '').trim(),
          判据_文档未变: after.doc === docBase,
          无反应: same(before, after),
        });
      }
      {
        const before = await S.snap();
        await S.key('Tab', 450);
        const after = await S.snap();
        add('K3 表头末格 Tab（跨行）', {
          读数: P(after),
          判据_首格: !!after.active && after.active.col === 0,
          判据_进数据行: !!after.active && after.active.lineNo === 7,
          判据_文档未变: after.doc === docBase,
          无反应: same(before, after),
        });
      }
      {
        const before = await S.snap();
        await S.key('Shift+Tab', 450);
        const after = await S.snap();
        add('K4 Shift+Tab 回跳', {
          读数: P(after),
          判据_回表头末格: !!after.active && after.active.lineNo === 5 && after.active.col === 2,
          判据_文档未变: after.doc === docBase,
          无反应: same(before, after),
        });
      }
      {
        await S.key('Shift+Tab', 400);
        await S.key('Shift+Tab', 400);
        const before = await S.snap(); needFocus(before, 'K5');
        await S.key('Shift+Tab', 450);
        const after = await S.snap();
        add('K5 表头首格 Shift+Tab（顶停）', {
          读数: P(after),
          判据_停在原格: !!after.active && after.active.lineNo === 5 && after.active.col === 0,
          判据_焦点未跑: String(after.focus || '').includes('mp-cell-overlay-text'),
          判据_文档未变: after.doc === docBase,
          无反应: same(before, after),
        });
      }
    });

    /* ── K6：Enter 三态（下移一格 / 末行补行 / 撤销） ── */
    await S.guard('K6', async () => {
      await S.clickCell(0, 0);
      const b0 = await S.snap();
      await S.key('Enter', 450);
      const a0 = await S.snap();
      add('K6 Enter 下移一格', { 前: P(b0), 后: P(a0), 判据_下一行同列: !!a0.active && a0.active.lineNo === 7 && a0.active.col === 0, 判据_文档未变: a0.doc === docBase, 无反应: same(b0, a0) });
      const b1 = await S.snap();
      await S.key('Enter', 450);
      const a1 = await S.snap();
      add('K6b Enter 到末数据行', { 读数: P(a1), 判据_末数据行: !!a1.active && a1.active.lineNo === 8, 判据_文档未变: a1.doc === docBase, 无反应: same(b1, a1) });
      const b2 = await S.snap();
      await S.key('Enter', 650);
      const a2 = await S.snap();
      add('K6c 末行 Enter 补行', { 读数: P(a2), 判据_行数加一: a2.docLines === b2.docLines + 1, 新行文本: a2.doc.split('\n')[8], 无反应: same(b2, a2) });
      add('K6c·截图', { 图: await S.shot('k6c-enter-append', '.mp-row') });
      await S.key('Control+z', 700);
      const back = await S.snap();
      add('K6d 撤销补行', { 判据_一次撤销回原状: back.doc === docBase, 文档行数: back.docLines, 活动格: back.active && { 行: back.active.lineNo, 列: back.active.col } });
    });

    /* ── K7：Shift+Enter 格内换行 ── */
    await S.guard('K7', async () => {
      await S.clickCell(1, 0);
      const before = await S.snap();
      await S.key('Shift+Enter', 550);
      const after = await S.snap();
      add('K7 Shift+Enter 格内换行', {
        读数: P(after),
        判据_源码出现br: after.doc.includes('<br>'),
        判据_结构未破: after.rows.length === before.rows.length && after.rows.every((r, i) => r.n === before.rows[i].n),
        无反应: same(before, after),
      });
      await S.key('Control+z', 700);
      const back = await S.snap();
      add('K7b 撤销换行', { 判据_一次撤销回原状: back.doc === docBase });
    });

    /* ── K8：方向键（格内 / 末行↓出表 / 表头↑出表） ── */
    await S.guard('K8', async () => {
      await S.clickCell(1, 1);
      const b0 = await S.snap();
      await S.key('ArrowRight', 350);
      const b1 = await S.snap();
      await S.key('ArrowRight', 350);
      const b2 = await S.snap();
      await S.key('ArrowDown', 350);
      const b3 = await S.snap();
      await S.key('ArrowUp', 350);
      const b4 = await S.snap();
      add('K8 格内方向键', {
        点格后: P(b0),
        按右1: { 活动格: b1.active && { 行: b1.active.lineNo, 列: b1.active.col }, DOM选区: b1.domSel, 文档未变: b1.doc === b0.doc },
        按右2: { 活动格: b2.active && { 行: b2.active.lineNo, 列: b2.active.col }, DOM选区: b2.domSel, 文档未变: b2.doc === b0.doc },
        按下: { 活动格: b3.active && { 行: b3.active.lineNo, 列: b3.active.col }, 文档未变: b3.doc === b0.doc, 焦点: b3.focus },
        按上: { 活动格: b4.active && { 行: b4.active.lineNo, 列: b4.active.col }, 文档未变: b4.doc === b0.doc, 焦点: b4.focus },
        判据_右移跨格: [b1, b2].some((x) => x.active && x.active.col !== 1),
        判据_下移跨格: b3.active ? (b3.active.lineNo !== 7) : '已退出表格',
      });
    });
    await S.guard('K8b', async () => {
      await S.clickCell(2, 1);
      const b0 = await S.snap();
      await S.key('ArrowDown', 500);
      const b1 = await S.snap();
      add('K8b 末行 ↓ 出表', { 前: P(b0), 后: P(b1), 判据_光标到表后: b1.headLine === 9, 判据_覆盖层收起: !b1.active });
    });
    await S.guard('K8c', async () => {
      await S.clickCell(0, 1);
      const b0 = await S.snap();
      await S.key('ArrowUp', 500);
      const b1 = await S.snap();
      add('K8c 表头 ↑ 出表', { 前: P(b0), 后: P(b1), 判据_光标到表前: b1.headLine === 4, 判据_覆盖层收起: !b1.active });
    });

    /* ── K9：格内打字 ── */
    await S.guard('K9', async () => {
      await S.clickCell(1, 2);
      const before = await S.snap();
      await S.type('XY', 650);
      const after = await S.snap();
      add('K9 格内打字 XY', {
        读数: P(after),
        判据_源码含XY: after.doc.includes('c1XY'),
        判据_列数不变: after.rows.every((r, i) => r.n === before.rows[i].n),
        判据_行数不变: after.docLines === before.docLines,
        无反应: same(before, after),
      });
      add('K9·截图', { 图: await S.shot('k9-typed', '.mp-row') });
      await S.key('Control+z', 700);
      const back = await S.snap();
      add('K9b 撤销打字', { 判据_一次撤销回原状: back.doc === docBase, 第7行: back.doc.split('\n')[6] });
    });

    /* ── K10：格内打裸管道 ── */
    await S.guard('K10', async () => {
      await S.clickCell(1, 2);
      const before = await S.snap();
      await S.type('|', 650);
      const after = await S.snap();
      add('K10 格内打 |', {
        读数: P(after),
        判据_转义: after.doc.includes('\\|'),
        判据_列数不变: after.rows.every((r, i) => r.n === before.rows[i].n),
        第7行: after.doc.split('\n')[6],
        提示: after.toast,
        无反应: same(before, after),
      });
      await S.key('Control+z', 700);
      add('K10b 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    /* ── K11：末行末格 Tab 补行 ── */
    await S.guard('K11', async () => {
      await S.clickCell(2, 2);
      const before = await S.snap();
      await S.key('Tab', 550);
      const after = await S.snap();
      add('K11 末行末格 Tab 补行', {
        前: P(before), 后: P(after),
        判据_行数加一: after.docLines === baseLines + 1,
        新行文本: after.doc.split('\n')[8],
        判据_三列: ((after.doc.split('\n')[8] || '').match(/(?<!\\)\|/g) || []).length === 4,
        判据_落新行首格: !!after.active && after.active.lineNo === 9 && after.active.col === 0,
        渲染表: after.rows.map((r) => r.cells.join('·')),
      });
      add('K11·截图', { 图: await S.shot('k11-tab-append', '.mp-row') });
      await S.key('Control+z', 800);
      const back = await S.snap();
      add('K11b 撤销补行', { 判据_一次撤销回原状: back.doc === docBase, 文档行数: back.docLines, 渲染表: back.rows.map((r) => r.cells.join('·')) });
      add('K11b·截图', { 图: await S.shot('k11b-after-undo', '.mp-row') });
    });

    /* ── K12：结构完整性总检 ── */
    await S.guard('K12', async () => {
      const s2 = await S.snap();
      const pipes = s2.doc.split('\n').filter((l) => /^\s*\|/.test(l)).map((l) => (l.match(/(?<!\\)\|/g) || []).length);
      add('K12 结构总检', {
        判据_回到原状: s2.doc === docBase,
        每行管道数: pipes,
        判据_管道数一致: pipes.every((n) => n === pipes[0]),
        渲染表: s2.rows.map((r) => r.cells.join('·')),
        pageerror: S.errs.slice(0, 5),
      });
    });
    add('K99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots, 壳层trace尾: S.dbgTail(6) });
  } catch (e) {
    add('K-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
