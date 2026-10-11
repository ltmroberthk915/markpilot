/** table-daily 族 · 粘贴破损的**整屏视觉证据**（P4/P5 的读数要能一眼看见）
 *
 *  两张图（裁 `.cm-content`，整块编辑面）+ 各自的 before 图，便于人眼对照：
 *   W1 正文行里粘 TSV：若建表不补块级换行 ⇒ 该行**剩余文字被粘进新表最后一行**、屏幕上那句正文消失；
 *   W2 光标在表行（无覆盖层，真实点表格左侧 gutter）粘 TSV：若守卫只判"焦点在格覆盖层里" ⇒
 *      新表插进原表行中间、原表被劈成两截（表头被粘走、`---` 被当数据行渲染）。
 *  判据一律读**最终状态**（文档文本 / 渲染表行 / 提示），不读"我调用了什么"：
 *   两条破损在新产物上都已修 ⇒ 本探针同样能判"没破损"（W1 正文句仍单独成行、W2 行数与管道数不变）。
 *  剪贴板：壳层 mpHost.writeClipboard + **独立 pwsh 进程**回读自证（严格相等）；
 *  回读为空/不匹配即记「未验证」不出结论。
 *  用法：node table-daily-paste-visual.cjs "<exe>"
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
const TSV = 'T1\tT2\tT3\nT4\tT5\tT6';

(async () => {
  const S = await L.boot({ probe: 'table-daily-paste-visual.cjs', dir: 'pastevisual', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);
  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const docBase = base.doc;

    const c = await S.clipArm(TSV);
    add('W0 剪贴板自证', c);
    if (!c.match) { add('W·未验证', { 原因: '系统剪贴板回读不匹配 ⇒ 粘贴通道没建立，本探针不作结论', 自证: c }); await S.finish(0); return; }

    /* ── W1 正文行里粘 TSV ── */
    await S.clickDocLine(3);                                     // 前置段落。 行首
    const b1 = await S.snap();
    const shot1前 = await S.shot('w1-before', '.cm-content');
    const p1 = await S.pasteProof({ expect: TSV, click: () => S.clickDocLine(3), docBase });
    add('W1 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p1.ok ? p1.尝试.length : null, 发次: p1.尝试 });
    if (!p1.ok) {
      add('W1·未验证', { 原因: '每一发 Ctrl+V 交付的载荷都不是预期 TSV ⇒ 系统剪贴板被并发邻族抢占，本用例不出结论', 尝试: p1.尝试 });
    } else {
      const a1 = p1.snap;
      add('W1 正文行里粘 TSV', {
        前: { 光标行: b1.headLine, 文档行数: b1.docLines, 渲染表: b1.rows.map((r) => r.cells.join('·')) },
        后: { 文档行数: a1.docLines, 渲染表: a1.rows.map((r) => r.cells.join('·')), 提示: a1.toast },
        产品是否接管本次粘贴: p1.prevented,
        文档行: a1.doc.split('\n'),
        判据_建表: a1.rows.length > b1.rows.length,
        判据_原正文句是否还在文档里: a1.doc.includes('前置段落。'),
        判据_原正文句是否还单独成行: a1.doc.split('\n').some((l) => l.trim() === '前置段落。'),
        判据_正文句没被并进表格行: !a1.doc.split('\n').some((l) => l.trim().startsWith('|') && l.includes('前置段落。')),
        图_before: shot1前,
        图: await S.shot('w1-tsv-in-bodyline', '.cm-content'),
      });
    }
    await S.key('Control+z', 800);
    add('W1b 撤销', { 判据_回原状: (await S.snap()).doc === docBase });

    /* ── W2 光标在表行（无覆盖层）粘 TSV ── */
    let inRow = null;
    /** 真实点击表格左侧 gutter，直到 CM 光标落进表行且**没有**格覆盖层 */
    const clickGutterIntoRow = async () => {
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
        if (s.headLineIsTable && !s.active) { inRow = s; return s; }
      }
      return null;
    };
    if (!(await clickGutterIntoRow())) { add('W2·未验证', { 原因: '没能用真实点击把 CM 光标放进表行' }); await S.finish(0); return; }
    const shot2前 = await S.shot('w2-before', '.cm-content');
    const p2 = await S.pasteProof({ expect: TSV, click: clickGutterIntoRow, docBase });
    add('W2 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p2.ok ? p2.尝试.length : null, 发次: p2.尝试 });
    if (!p2.ok) {
      add('W2·未验证', { 原因: '每一发 Ctrl+V 交付的载荷都不是预期 TSV ⇒ 系统剪贴板被并发邻族抢占，本用例不出结论', 尝试: p2.尝试 });
    } else {
      const b2 = inRow, a2 = p2.snap;          // b2＝成功那一发**按键前**的读数；a2＝同一发按键后的终态
      const pipes = (s) => s.doc.split('\n').filter((l) => /^\s*\|/.test(l)).map((l) => (l.match(/(?<!\\)\|/g) || []).length);
      add('W2 表行内粘 TSV（无覆盖层）', {
        前: { 光标行: b2.headLine, 列: b2.headCol, 文档行数: b2.docLines, 渲染表: b2.rows.map((r) => r.cells.join('·')), 每行管道数: pipes(b2) },
        后: { 文档行数: a2.docLines, 渲染表: a2.rows.map((r) => r.cells.join('·')), 提示: a2.toast },
        产品是否接管本次粘贴: p2.prevented,
        文档行: a2.doc.split('\n'),
        每行管道数: pipes(a2),
        判据_原表头行是否被粘走: a2.doc.split('\n').some((l) => l.includes('| 甲 | 乙 | 丙 |') && l.trim().startsWith('| T4')),
        判据_文档未变: a2.doc === b2.doc,
        判据_渲染表行数不变: a2.rows.length === b2.rows.length,
        判据_每行管道数不变: JSON.stringify(pipes(a2)) === JSON.stringify(pipes(b2)),
        图_before: shot2前,
        图: await S.shot('w2-tsv-inside-tablerow', '.cm-content'),
      });
    }
    await S.key('Control+z', 800);
    add('W2b 撤销', { 判据_回原状: (await S.snap()).doc === docBase });
    add('W99 收尾', { pageerror: S.errs.slice(0, 6), consoleError: S.cerrs.slice(0, 6), 启动次数: S.boots });
  } catch (e) {
    add('W-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
