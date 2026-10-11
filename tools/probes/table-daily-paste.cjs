/** table-daily 族 · 粘贴（多行 TSV / 单行 / 裸管道 / 表外建表）
 *
 *  本族任务书的期望：**粘贴多行 TSV 进表格应扩行**。
 *  产品代码（extras.js onDocPaste）的口径：格内多行 ⇒ 拒绝 + 提示；格内单行 ⇒ 交回默认；
 *  格内裸 `|` ⇒ 落成 `\|`；**表外** TSV/HTML 表 ⇒ 建 markdown 表。
 *
 *  ⚠️ 剪贴板通道（实测教训）：`navigator.clipboard.writeText` 在本机 Electron 上**静默失败** ——
 *  第一版探针用它，结果 P1 正对照回读为空、随后的 Ctrl+V 全是**空粘贴**（万幸正对照抓住了）。
 *  现在写＝壳层 `mpHost.writeClipboard`（与产品「复制表格」同一条通道），回读＝PowerShell 读系统剪贴板；
 *  **回读不匹配 ⇒ 该用例记「未验证」，不拿空剪贴板当产品行为**。
 *
 *  ⚠️⚠️ 剪贴板是**会话级全局资源**（2026-10-10 复跑实测）：多族并行时邻族会往同一个系统剪贴板写哨兵。
 *  实测邻族 `list-continuation-rerun/clip-selfproof.cjs` 在 03:48:32Z 写入
 *  `MPCLIP-SENTINEL-中文行1\r\n中文行2\ttab&"quote"`，正压在我 03:48:35Z 的 Ctrl+V 上 ⇒ 我的"粘贴 TSV"
 *  实际粘进去的是**别人的哨兵**。若只看终态，这会被读成"产品粘贴行为异常"。
 *  ⇒ 每个粘贴用例一律走 `S.pasteProof()`：装弹自证 + 按键前一瞬快读 + **paste 事件载荷必须等于预期文本**；
 *     载荷不符＝该发被污染 ⇒ 撤销还原后重试；全试完仍不符 ⇒ 记「未验证」。
 *  粘贴本身仍是真 Ctrl+V（CDP 按键 → 原生粘贴）。每个用例包 S.guard。
 *  用法：node table-daily-paste.cjs "<exe>"
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

const P = (s) => ({
  活动格: s.active ? { 行: s.active.lineNo, 列: s.active.col, 编辑面: s.active.domText, 源行: s.active.srcText } : null,
  覆盖层: s.overlay,
  文档行数: s.docLines, 文档长度: s.docLen,
  焦点: s.focus,
  CM光标: { 行: s.headLine, 列: s.headCol, 在表行: s.headLineIsTable },
  提示: s.toast,
  渲染表: s.rows.map((r) => r.cells.join('·')),
});

(async () => {
  const S = await L.boot({ probe: 'table-daily-paste.cjs', dir: 'paste', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |' });
    const docBase = base.doc;
    add('P0 夹具就位', { 文档行数: base.docLines, 渲染表: base.rows.map((r) => r.cells.join('·')) });

    /* ── P1 正对照：格内单行粘贴（通道验证用例） ── */
    await S.guard('P1', async () => {
      const before = await S.snap();
      const p = await S.pasteProof({ expect: '单行内容', click: () => S.clickCell(1, 0), docBase });
      add('P1 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p.ok ? p.尝试.length : null, 发次: p.尝试 });
      if (!p.ok) { add('P1·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是预期文本 ⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p.尝试 }); return; }
      const after = p.snap;
      add('P1 正对照·格内单行粘贴', {
        产品是否接管本次粘贴: p.prevented,
        前: P(before), 后: P(after),
        判据_落地: after.doc.includes('单行内容'),
        判据_结构未破: after.rows.length === before.rows.length && after.rows.every((r, i) => r.n === before.rows[i].n),
      });
      await S.key('Control+z', 700);
      add('P1b 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    /* ── P2 主角：格内粘多行 TSV（任务书期望"扩行"） ── */
    await S.guard('P2', async () => {
      const before = await S.snap();
      const p = await S.pasteProof({ expect: TSV, click: () => S.clickCell(1, 0), docBase });
      add('P2 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p.ok ? p.尝试.length : null, 发次: p.尝试 });
      if (!p.ok) { add('P2·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是 TSV ⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p.尝试 }); return; }
      const after = p.snap;
      add('P2 格内粘多行 TSV', {
        产品是否接管本次粘贴: p.prevented,
        前: P(before), 后: P(after),
        判据_是否扩行: after.docLines > before.docLines,
        判据_文档未变: after.doc === before.doc,
        判据_结构未破: after.rows.length === before.rows.length,
        提示: after.toast,
        截图: await S.shot('p2-tsv-in-cell', '.mp-row'),
      });
      await S.key('Control+z', 600);
    });

    /* ── P3 格内粘含裸管道的单行 ── */
    await S.guard('P3', async () => {
      const before = await S.snap();
      const p = await S.pasteProof({ expect: '左|右', click: () => S.clickCell(1, 0), docBase });
      add('P3 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p.ok ? p.尝试.length : null, 发次: p.尝试 });
      if (!p.ok) { add('P3·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是「左|右」⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p.尝试 }); return; }
      const after = p.snap;
      add('P3 格内粘含 | 的单行', {
        产品是否接管本次粘贴: p.prevented,
        前: P(before), 后: P(after),
        第7行: after.doc.split('\n')[6],
        判据_转义: after.doc.includes('\\|'),
        判据_结构未破: after.rows.every((r, i) => r.n === before.rows[i].n),
        提示: after.toast,
      });
      await S.key('Control+z', 700);
      add('P3b 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    /* ── P4 表外（正文段落）粘 TSV → 应建 markdown 表 ── */
    await S.guard('P4', async () => {
      const before = await S.snap();
      const p = await S.pasteProof({ expect: TSV, click: () => S.clickDocLine(3), docBase });
      add('P4 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p.ok ? p.尝试.length : null, 发次: p.尝试 });
      if (!p.ok) { add('P4·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是 TSV ⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p.尝试 }); return; }
      const after = p.snap;
      add('P4 表外粘 TSV', {
        产品是否接管本次粘贴: p.prevented,
        前: P(before), 后: P(after),
        判据_新建表: after.rows.length > before.rows.length && after.doc.includes('T1'),
        判据_原正文句是否还单独成行: after.doc.split('\n').some((l) => l.trim() === '前置段落。'),
        新增行: after.doc.split('\n').slice(2, 9),
        提示: after.toast,
      });
      add('P4·截图', { 图: await S.shot('p4-tsv-outside', '.mp-table-wrap') });
      await S.key('Control+z', 700);
      add('P4b 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    /* ── P5 光标在表行（无覆盖层）粘 TSV：会不会把表劈开？ ── */
    await S.guard('P5', async () => {
      let inRow = null; const tried = [];
      const clickGutterIntoRow = async () => {
        for (const dy of [0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
          const g = await S.ev((f) => {
            const t = document.querySelector('.mp-row');
            if (!t) return null;
            const r = t.getBoundingClientRect();
            return { x: Math.round(r.left - 14), y: Math.round(r.top + r.height * f) };
          }, dy);
          if (!g) break;
          await S.page.mouse.click(g.x, g.y); await S.sleep(400);
          const s = await S.snap();
          tried.push({ dy, 光标行: s.headLine, 行文本: s.headText.slice(0, 24), 在表行: s.headLineIsTable, 覆盖层: !!s.active });
          if (s.headLineIsTable && !s.active) { inRow = s; return s; }
        }
        return null;
      };
      if (!(await clickGutterIntoRow())) {
        add('P5 表行内（无覆盖层）定位', { 尝试: tried, 成功: false });
        add('P5b·未验证', { 原因: '真实点击左侧 gutter 没能把 CM 光标放进表行，本用例不成立（不猜）' }); return;
      }
      add('P5 表行内（无覆盖层）定位', { 尝试: tried, 成功: true, 光标: { 行: inRow.headLine, 列: inRow.headCol, 文本: inRow.headText } });
      const p = await S.pasteProof({ expect: TSV, click: clickGutterIntoRow, docBase });
      add('P5b 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p.ok ? p.尝试.length : null, 发次: p.尝试 });
      if (!p.ok) { add('P5b·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是 TSV ⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p.尝试 }); return; }
      const before = inRow, after = p.snap;       // before＝成功那一发按键前的读数
      const pipes = (s) => s.doc.split('\n').filter((l) => /^\s*\|/.test(l)).map((l) => (l.match(/(?<!\\)\|/g) || []).length);
      add('P5b 表行内粘 TSV', {
        产品是否接管本次粘贴: p.prevented,
        前: P(before), 后: P(after),
        每行管道数: pipes(after),
        判据_渲染表行数不变: after.rows.length === before.rows.length,
        判据_行数不变: after.docLines === before.docLines,
        提示: after.toast,
        文档行: after.doc.split('\n').map((l, i) => (i + 1) + ':' + l.slice(0, 40)),
      });
      add('P5b·截图', { 图: await S.shot('p5-tsv-in-tablerow', '.mp-row') });
      await S.key('Control+z', 800);
      add('P5c 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    /* ── P6 剪贴板 HTML 表（Excel 真身）⇒ 格内 vs 表外 ── */
    await S.guard('P6', async () => {
      const html = '<meta charset="utf-8"><table><tr><td>H1</td><td>H2</td></tr><tr><td>H3</td><td>H4</td></tr></table>';
      const HTMLTXT = 'H1\tH2\nH3\tH4';
      const b1 = await S.snap();
      const p1 = await S.pasteProof({ expect: HTMLTXT, html, click: () => S.clickCell(1, 0), docBase });
      add('P6b 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p1.ok ? p1.尝试.length : null, 发次: p1.尝试 });
      if (p1.ok) {
        const a1 = p1.snap;
        add('P6b 格内粘 HTML 表', { 产品是否接管本次粘贴: p1.prevented, 前: P(b1), 后: P(a1), 提示: a1.toast, 判据_文档未变: a1.doc === b1.doc, 判据_结构未破: a1.rows.length === b1.rows.length });
      } else {
        add('P6b·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是 H1\\tH2… ⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p1.尝试 });
      }
      const b2 = await S.snap();
      const p2 = await S.pasteProof({ expect: HTMLTXT, html, click: () => S.clickDocLine(3), docBase });
      add('P6c 粘贴通道自证（剪贴板是否被邻族抢占）', { 采用发数: p2.ok ? p2.尝试.length : null, 发次: p2.尝试 });
      if (p2.ok) {
        const a2 = p2.snap;
        add('P6c 表外粘 HTML 表', { 产品是否接管本次粘贴: p2.prevented, 前: P(b2), 后: P(a2), 判据_建表: a2.rows.length > b2.rows.length, 提示: a2.toast, 新增: a2.doc.split('\n').slice(2, 7) });
      } else {
        add('P6c·未验证', { 原因: '每一发 Ctrl+V 的载荷都不是 H1\\tH2… ⇒ 剪贴板被并发邻族抢占，不出结论', 尝试: p2.尝试 });
      }
      await S.key('Control+z', 700);
      add('P6d 撤销', { 判据_一次撤销回原状: (await S.snap()).doc === docBase });
    });

    const s = await S.snap();
    add('P99 终态', { 判据_逐字节回原状: s.doc === docBase, 文档行: s.doc.split('\n'), pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots, 壳层trace尾: S.dbgTail(6) });
  } catch (e) {
    add('P-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
