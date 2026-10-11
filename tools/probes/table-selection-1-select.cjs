/** table-selection 族 · 探针 1：**选中通道普查**（用户"怎么把表格选起来"）
 *
 *  用例：
 *   S0 夹具自证 + 系统剪贴板环境事实（锁屏 ⇒ 跨进程剪贴板不可用）
 *   S1 点一下格子：起点状态（覆盖层/焦点/CM 选区/文档）
 *   S2 Ctrl+E 选格：DOM 选区文本是否==该格**源码**（含格内前后空格）
 *   S3 点格 → Ctrl+E → Ctrl+A ×3：格→行→列→整表 阶梯（每一拍读**看得见的高亮**）
 *   S3c 行/列/整表三级各拍一张局部图（看高亮真的亮没亮）
 *   S4 整表层级再按 Ctrl+A ×2：应保持全选（不循环回格）
 *   S5 "点击边栏"（表格左缘外侧 14px）到底选中什么 + 有没有行/列手柄这类 DOM
 *   S6 在渲染表格上**拖拽**（真实按下→多次移动→抬起）跨两行
 *   S7 从表格上方段落**拖到**下方段落（跨表拖拽）：表格那几行在屏幕上有没有被选中
 *   S8 表外段落点一下再 Ctrl+A：全文档选中且**不出现**表格层级高亮
 *   S9 ⚠ 全选之后点格再按 Ctrl+A：阶梯还能不能重启（源码里 cycleTableSelection 对"已是全文档"
 *      直接 return false）
 *
 *  用法：node table-selection-1-select.cjs "<exe>"
 */
'use strict';
const L = require('./table-selection-lib.cjs');
const R = require('./_probe-common.cjs');
const EXE = process.argv[2];
const DOC = [
  '# 表格选择层级',
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
  const S = await L.boot({ probe: 'table-selection-1-select.cjs', dir: 'p1-select', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);
  const st = (s) => ({
    层级: L.levelOf(s), 选区: [s.selFrom, s.selTo], 选区文本: s.selText.slice(0, 20),
    高亮: { 行: s.hl.row, 列: s.hl.col, 整表: s.hl.table },
    光标: { 行: s.headLine, 列: s.headCol, 在表行: s.headIsTable },
    覆盖层: s.overlay.visible, DOM选区: s.domSel && s.domSel.text, 焦点: s.focus, 提示: s.toasts,
  });

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const doc0 = base.doc;
    const cellSrcB1 = doc0.split('\n')[6].split('|')[2];       // ' b1 '（含格内前后空格＝该格源码）

    /* ── S0 环境事实 ── */
    add('S0 夹具与产物', {
      产物SHA16: R.sha16(EXE), 夹具SHA16: R.sha16(S.DOC),
      文档: doc0, 渲染行数: base.rowCount, 表格数: base.tables,
      窗口有焦点: base.hasFocus, 焦点: base.focus,
    });
    const cd = S.clipDiag();
    add('S0b 系统剪贴板环境自检（独立于产品的尺子）', {
      'Set-Clipboard返回': cd.set, 'Get-Clipboard是否成功': cd.read_ok, '读回长度': cd.read_len, '读回值': cd.read_val,
      'clip.exe退出码': cd.clipexe_exit,
      判定: (cd.read_ok && cd.read_len > 0) ? '剪贴板可用（可做跨进程用例）' : '环境阻断：系统剪贴板不可用 ⇒ 需要跨进程剪贴板的用例不出通过/失败',
    });

    /* ── S1 点格起点 ── */
    await S.guard('S1', async () => {
      const xy = await S.clickCell(1, 1);
      const s = await S.snap();
      add('S1 点一下 b1 格', {
        点在哪: xy, ...st(s),
        活动格DOM: s.activeCellDom,
        判据_覆盖层起来: s.overlay.visible,
        判据_文档未动: s.doc === doc0,
        要点_点格不落CM选区: `CM 光标仍在 ${s.headLine}:${s.headCol}`,
      });
    });

    /* ── S2 Ctrl+E 选格 ── */
    await S.guard('S2', async () => {
      const r = await S.toLevel('cell', { rowIdx: 1, colIdx: 1 });
      const s = r.s;
      add('S2 点格 → Ctrl+E（选格层级）', {
        台阶: r.trail, 层级: r.level, 该格源码: JSON.stringify(cellSrcB1),
        DOM选区文本: JSON.stringify(s.domSel && s.domSel.text), DOM选区在覆盖层内: s.domSel && s.domSel.inOverlay,
        覆盖层文本: s.overlay.text, 文档未动: s.doc === doc0,
        判据_选中的是该格源码: !!(s.domSel && s.domSel.text === cellSrcB1),
        判据_覆盖层可见: s.overlay.visible,
        判据_文档未动: s.doc === doc0,
      });
      add('S2b 截图', { 图: await S.shot('s2-ctrlE-cell', '.mp-cell-overlay') });
    });

    /* ── S3 阶梯 ── */
    await S.guard('S3', async () => {
      const r = await S.toLevel('table', { rowIdx: 1, colIdx: 1 });
      const seq = r.trail.slice(1).map((t) => t.层级);          // 丢掉"点格后"那一拍（点格本身不改变层级语义）
      add('S3 点格 → Ctrl+E → Ctrl+A ×3 阶梯', {
        台阶: r.trail, 层级序列: seq,
        判据_单调递进: JSON.stringify(seq) === JSON.stringify(['cell', 'row', 'col', 'table']),
        判据_每一拍文档都没变: r.trail.every((t) => t.文档未变 === true),
      });
      add('S3b 截图', { 图: await S.shot('s3-table-level', '.mp-table-wrap') });
    });

    /* ── S3c 行/列/整表三张图 ── */
    await S.guard('S3c', async () => {
      const out = {};
      for (const kind of ['row', 'col', 'table']) {
        const r = await S.toLevel(kind);
        out[kind] = {
          层级: r.level, 高亮: { 行: r.s.hl.row, 列: r.s.hl.col, 整表: r.s.hl.table },
          行底色: r.s.hl.rowBg, 列底色: r.s.hl.colBg, 表格描边: r.s.hl.tableOutline,
          高亮行文本: r.s.hl.rowText, 高亮首格文本: r.s.hl.colText,
          图: await S.shot('s3c-' + kind, '.mp-table-wrap'),
        };
      }
      add('S3c 三个层级各拍一张（局部）', out);
    });

    /* ── S4 到顶再按 ── */
    await S.guard('S4', async () => {
      const r = await S.toLevel('table');
      await S.key('Control+a', 500);
      const b = await S.snap();
      await S.key('Control+a', 500);
      const c = await S.snap();
      add('S4 整表层级再按 Ctrl+A ×2', {
        整表: st(r.s),
        第五拍: { ...st(b), 文档长度: b.docLen },
        第六拍: { ...st(c), 文档长度: c.docLen },
        判据_第五拍是全文档: b.selFrom === 0 && b.selTo === b.docLen,
        判据_不循环回格: !(c.domSel && c.domSel.inOverlay && !c.domSel.collapsed),
        判据_文档未变: c.doc === doc0,
      });
    });

    /* ── S5 点击"边栏" ── */
    await S.guard('S5', async () => {
      const dom = await S.ev(() => {
        const gut = document.querySelector('.cm-gutters');
        const row = document.querySelectorAll('.mp-row')[1];
        const b = row ? row.getBoundingClientRect() : null;
        return {
          gutter存在: !!gut, gutter显示: gut ? getComputedStyle(gut).display : null,
          gutter元素数: document.querySelectorAll('[class*=gutter]').length,
          行手柄类元素数: document.querySelectorAll('[class*=handle],[class*=drag-handle],[class*=row-sel]').length,
          第二行矩形: b ? { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } : null,
        };
      });
      if (!dom.第二行矩形) { add('S5·未验证', { 原因: '取不到渲染行矩形', dom }); return; }
      const y = Math.round(dom.第二行矩形.top + dom.第二行矩形.h / 2);
      const x = dom.第二行矩形.left - 14;
      await S.page.mouse.click(x, y);
      await S.sleep(500);
      const s = await S.snap();
      add('S5 点击表格左缘外侧 14px（"边栏"位置）', {
        DOM事实: dom, 点在哪: { x, y }, 结果: st(s),
        判据_是否选中了整行: s.hl.row > 0,
        判据_是否只是放了光标: s.selEmpty === true,
      });
    });

    /* ── S6 表格上拖拽 ── */
    await S.guard('S6', async () => {
      const a = await S.cellXY(1, 1), b = await S.cellXY(2, 1);
      await S.clickDocLine(3);                       // 先离表，保证起点干净
      const before = await S.snap();
      await S.page.mouse.move(a.x, a.y);
      await S.page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await S.page.mouse.move(Math.round(a.x + (b.x - a.x) * i / 6), Math.round(a.y + (b.y - a.y) * i / 6));
        await S.sleep(60);
      }
      await S.page.mouse.up();
      await S.sleep(600);
      const s = await S.snap();
      add('S6 在渲染表格上从 b1 拖到 b2（真实按下→6 次移动→抬起）', {
        起: a, 终: b, 拖前: st(before), 拖后: st(s),
        判据_文档未变: s.doc === doc0,
        判据_产生了跨格文本选区: !s.selEmpty && s.selText.includes('\n'),
        判据_是否只把落点那格变成编辑态: s.overlay.visible,
      });
      add('S6b 截图', { 图: await S.shot('s6-drag-in-table', '.mp-table-wrap') });
    });

    /* ── S7 跨表拖拽 ── */
    await S.guard('S7', async () => {
      const pts = await S.ev(() => {
        const v = window.mpEngine._view();
        const d = v.state.doc;
        const p1 = v.coordsAtPos(d.line(3).from + 3);
        const p2 = v.coordsAtPos(d.line(10).from + 3);
        return {
          from: p1 ? { x: Math.round(p1.left + 6), y: Math.round((p1.top + p1.bottom) / 2) } : null,
          to: p2 ? { x: Math.round(p2.left + 6), y: Math.round((p2.top + p2.bottom) / 2) } : null,
        };
      });
      if (!pts.from || !pts.to) { add('S7·未验证', { 原因: '取不到段落坐标', pts }); return; }
      await S.page.mouse.move(pts.from.x, pts.from.y);
      await S.page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await S.page.mouse.move(Math.round(pts.from.x + (pts.to.x - pts.from.x) * i / 10), Math.round(pts.from.y + (pts.to.y - pts.from.y) * i / 10));
        await S.sleep(60);
      }
      await S.page.mouse.up();
      await S.sleep(700);
      const s = await S.snap();
      add('S7 从上段拖到下段（跨过整张表）', {
        起止: pts, 结果: st(s),
        判据_选区跨越了表格源码行: s.selText.includes('| 甲 |') || s.selText.includes('a1'),
        判据_表格上看得见的高亮: { 行: s.hl.row, 列: s.hl.col, 整表: s.hl.table },
        判据_文档未变: s.doc === doc0,
      });
      add('S7b 截图（看表格上有没有选中底色）', { 图: await S.shot('s7-drag-across', '.mp-table-wrap') });
    });

    /* ── S8 表外 Ctrl+A ── */
    await S.guard('S8', async () => {
      const p = await S.clickDocLine(3);
      const before = await S.snap();
      await S.key('Control+a', 600);
      const s = await S.snap();
      add('S8 表外段落点一下 → Ctrl+A', {
        点在哪: p, 点前: st(before), 点后: { ...st(s), 文档长度: s.docLen },
        判据_全文档选中: s.selFrom === 0 && s.selTo === s.docLen,
        判据_表格无层级高亮: s.hl.row === 0 && s.hl.col === 0 && s.hl.table === 0,
        判据_文档未变: s.doc === doc0,
      });
    });

    /* ── S9 全选之后点格再 Ctrl+A ── */
    await S.guard('S9', async () => {
      const r = await S.toLevel('table');
      await S.key('Control+a', 550);                 // → 全文档
      const doc = await S.snap();
      const xy = await S.clickCell(1, 1);            // 真实点回 b1 格
      const afterClick = await S.snap();
      await S.key('Control+a', 550);
      const a1 = await S.snap();
      await S.key('Control+E', 550);                 // 换确定性入口 Ctrl+E
      const e1 = await S.snap();
      await S.key('Control+a', 550);
      const a2 = await S.snap();
      add('S9 全选 → 点格 → Ctrl+A（阶梯能否重启）', {
        整表: st(r.s), 全选: { ...st(doc), 文档长度: doc.docLen },
        点格后: st(afterClick), 点在哪: xy,
        'Ctrl+A一拍': st(a1), 'Ctrl+E': st(e1), 'Ctrl+E后再Ctrl+A': st(a2),
        判据_点格后CM选区是否仍是全选: afterClick.selFrom === 0 && afterClick.selTo === afterClick.docLen,
        '判据_Ctrl+A有没有反应': !(a1.selFrom === afterClick.selFrom && a1.selTo === afterClick.selTo && L.levelOf(a1) === L.levelOf(afterClick)),
        '判据_Ctrl+E能否回到格级': L.levelOf(e1) === 'cell',
        '判据_回到格级后再Ctrl+A能否进行级': L.levelOf(a2) === 'row',
        文档未变: a2.doc === doc0,
      });
      add('S9b 截图', { 图: await S.shot('s9-stuck', '.cm-content') });
    });

    add('S99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots, 外部中断: S.log.filter((x) => x.case === 'REBOOT').length });
  } catch (e) {
    add('S-EXC', { 异常: String((e && e.message) || e).slice(0, 400), 栈: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ') });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
