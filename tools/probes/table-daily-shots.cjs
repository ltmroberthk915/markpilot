/** table-daily 族 · 视觉证据（整块编辑面，不裁到单行）
 *
 *  上一版截图裁的是 `document.querySelector('.mp-row')` = **第一行 widget**，只能看到表头 ⇒ 看不到"补行"。
 *  这里改成裁 `.cm-content`（整个编辑面），三张图：
 *   ① 基线（3 行表）② 末行末格 Tab 之后（应 4 行）③ 一次 Ctrl+Z 之后（应回到 3 行）
 *  用法：node table-daily-shots.cjs "<exe>"
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

(async () => {
  const S = await L.boot({ probe: 'table-daily-shots.cjs', dir: 'shots', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);
  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const docBase = base.doc;
    add('V0 基线', { 渲染表: base.rows.map((r) => r.cells.join('·')), 文档行数: base.docLines, 图: await S.shot('v0-baseline', '.cm-content') });

    await S.clickCell(2, 2);                        // 末数据行末格
    const b1 = await S.snap();
    await S.key('Tab', 700);                        // 应补一行
    const a1 = await S.snap();
    add('V1 末行末格 Tab', {
      前: b1.rows.map((r) => r.cells.join('·')), 后: a1.rows.map((r) => r.cells.join('·')),
      判据_行数加一: a1.docLines === b1.docLines + 1,
      新行: a1.doc.split('\n')[8],
      活动格: a1.active && { 行: a1.active.lineNo, 列: a1.active.col },
      图: await S.shot('v1-after-append', '.cm-content'),
    });
    await S.key('Control+z', 800);
    const a2 = await S.snap();
    add('V2 一次撤销', {
      渲染表: a2.rows.map((r) => r.cells.join('·')),
      判据_回原状: a2.doc === docBase,
      图: await S.shot('v2-after-undo', '.cm-content'),
    });
    add('V99 收尾', { pageerror: S.errs.slice(0, 6), consoleError: S.cerrs.slice(0, 6) });
  } catch (e) {
    add('V-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
