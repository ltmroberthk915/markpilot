/** table-selection 族 · 探针 4（诊断）：**层级态打字，字到底落在哪**
 *
 *  探针 3 的反常读数：
 *   · 行/列层级打字 → 文档在**表格下面**多出一行字符（选区被清掉），不是落进当前格；
 *   · 整表层级打字 → **整张表被一个字替换**。
 *  两者都不是"打字被拦"的预期形态。这里把**打字前**的
 *   CM 选区 / DOM 选区（锚点节点+偏移+矩形）/ 活动元素 一次读全（错-7①），打字后再读最终文档，
 *   并加一条对照臂：先用 Tab 把 CM 光标挪进另一格（此时 DOM 光标已同步）再打字。
 *
 *  用法：node table-selection-4-diag-type.cjs "<exe>"
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

/** 打字前的全套证据：CM 选区 + DOM 选区细节 + 活动元素（同一个函数里取完） */
function preFn() {
  const v = window.mpEngine._view();
  const st = v.state, sel = st.selection.main;
  const s = window.getSelection();
  let dom = null;
  try {
    if (s && s.rangeCount) {
      const r = s.getRangeAt(0), b = r.getBoundingClientRect();
      dom = {
        anchorNode: s.anchorNode ? (s.anchorNode.nodeName + '.' + String(s.anchorNode.parentElement && s.anchorNode.parentElement.className || '').slice(0, 24)) : null,
        anchorOffset: s.anchorOffset, focusOffset: s.focusOffset, rangeCount: s.rangeCount,
        collapsed: s.isCollapsed, text: String(s).slice(0, 40),
        rect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
      };
    }
  } catch (e) { dom = { err: String(e).slice(0, 60) }; }
  /* DOM 光标落在文档的哪个字符位置（用 CM 自己的 posAtDOM 反查 —— 一手口径） */
  let domPos = null;
  try { if (s && s.anchorNode && v.contentDOM.contains(s.anchorNode)) domPos = v.posAtDOM(s.anchorNode, s.anchorOffset); } catch (e) { domPos = 'err'; }
  const lineOf = (p) => { try { const l = st.doc.lineAt(p); return { 行: l.number, 列: p - l.from }; } catch { return null; } };
  return {
    CM选区: [sel.from, sel.to], CM锚点: lineOf(sel.anchor), CM头: lineOf(sel.head), 选区文本: st.doc.sliceString(sel.from, sel.to),
    层级高亮: {
      行: document.querySelectorAll('tr.mp-sel-row').length,
      列: document.querySelectorAll('td.mp-sel-col,th.mp-sel-col').length,
      整表: document.querySelectorAll('.mp-table-wrap.mp-sel-table').length,
    },
    覆盖层: (() => { const o = document.querySelector('.mp-cell-overlay'); return !!(o && o.style.display !== 'none'); })(),
    活动元素: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName).slice(0, 40) : null,
    DOM选区: dom, DOM光标对应文档位置: domPos, DOM光标位置: domPos == null || domPos === 'err' ? null : lineOf(domPos),
    文档: st.doc.toString(),
  };
}

(async () => {
  const S = await L.boot({ probe: 'table-selection-4-diag-type.cjs', dir: 'p4-diag', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const doc0 = base.doc;
    add('D0 夹具与产物', { 产物SHA16: R.sha16(EXE), 夹具SHA16: R.sha16(S.DOC), 文档: doc0 });
    const pre = () => S.ev(preFn);
    /* 逐行 diff：说清"哪一行变了"，比整串文档好读 */
    const diff = (a, b) => {
      const A = a.split('\n'), B = b.split('\n');
      const out = [];
      for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) out.push({ 行: i + 1, 前: A[i] === undefined ? '(无)' : A[i], 后: B[i] === undefined ? '(无)' : B[i] });
      return out;
    };
    async function pristine(why) {
      const s = await S.snap();
      if (s.doc === doc0) return { ok: true };
      await S.key('Control+z', 600);
      const u = await S.snap();
      if (u.doc === doc0) return { ok: true, 复位: '一次撤销' };
      await S.reboot('用例 ' + why + ' 后没回到 pristine');
      return { ok: (await S.snap()).doc === doc0, 复位: 'reboot' };
    }

    for (const [id, kind, ch] of [['D1', 'row', 'x'], ['D2', 'col', 'y'], ['D3', 'table', 'z']]) {
      await S.guard(id, async () => {
        const r = await S.toLevel(kind);
        const before = await pre();
        await S.type(ch, 700);
        const after = await pre();
        add(id + ' ' + kind + ' 层级打字 "' + ch + '"：打字前/后全套证据', {
          层级: r.level, 打字前: before, 打字后: { CM选区: after.CM选区, CM头: after.CM头, 层级高亮: after.层级高亮, DOM选区: after.DOM选区, DOM光标位置: after.DOM光标位置 },
          文档diff: diff(doc0, after.文档),
          判据_字落进当前格b1: after.文档 === doc0.replace('| a1 | b1 | c1 |', '| a1 | ' + ch + 'b1 | c1 |'),
          判据_表结构没坏: after.文档.includes('| a2 | b2 | c2 |'),
        });
        add(id + 'b 复位', await pristine(id));
      });
    }

    /* D4 对照臂：先 Tab 把 CM 光标挪到下一格（DOM 光标随 CM 同步），再打字 */
    await S.guard('D4', async () => {
      const r = await S.toLevel('row');
      await S.key('Tab', 550);
      const before = await pre();
      await S.type('x', 700);
      const after = await pre();
      add('D4 行层级先按 Tab 再打字（对照臂）', {
        层级: r.level, Tab后打字前: before,
        打字后: { CM选区: after.CM选区, CM头: after.CM头, 层级高亮: after.层级高亮 },
        文档diff: diff(doc0, after.文档),
      });
      add('D4b 复位', await pristine('D4'));
    });

    /* D5 对照臂②：不用层级 —— 真实点表行左侧空白把 CM 光标放进表行，直接打字 */
    await S.guard('D5', async () => {
      const g = await S.ev(() => {
        const t = document.querySelectorAll('.mp-row')[1];
        const r0 = t.getBoundingClientRect();
        return { x: Math.round(r0.left - 14), y: Math.round(r0.top + r0.height / 2) };
      });
      await S.page.mouse.click(g.x, g.y);
      await S.sleep(450);
      const before = await pre();
      await S.type('x', 700);
      const after = await pre();
      add('D5 无层级、光标在表行（点行左侧空白）直接打字', {
        点在哪: g, 打字前: before,
        打字后: { CM选区: after.CM选区, CM头: after.CM头 }, 文档diff: diff(doc0, after.文档),
      });
      add('D5b 复位', await pristine('D5'));
    });

    /* D6 对照臂③：普通段落里打字（同尺子、同夹具、同顺序）—— 字应落在 CM 光标处 */
    await S.guard('D6', async () => {
      await S.clickDocLine(3);
      const before = await pre();
      await S.type('x', 700);
      const after = await pre();
      add('D6 对照臂：普通段落里打字', {
        打字前: before,
        打字后: { CM选区: after.CM选区, CM头: after.CM头, DOM光标位置: after.DOM光标位置 },
        文档diff: diff(doc0, after.文档),
        判据_字落在光标处: after.文档.includes('x前置段落。'),
      });
      add('D6b 复位', await pristine('D6'));
    });

    /* D7 对照臂④：走产品的"点格编辑覆盖层"通道打字（日常主路径） */
    await S.guard('D7', async () => {
      const xy = await S.clickCell(1, 1);
      const before = await pre();
      await S.type('x', 700);
      const after = await pre();
      add('D7 对照臂：点格进覆盖层后打字', {
        点在哪: xy, 打字前: before,
        打字后: { CM选区: after.CM选区, 文档: after.文档 },
        文档diff: diff(doc0, after.文档),
        判据_字落进了这一格: after.文档.split('\n')[6] !== doc0.split('\n')[6] && after.文档.includes('| a2 | b2 | c2 |'),
      });
      add('D7b 复位', await pristine('D7'));
    });

    add('D99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots, 外部中断: S.log.filter((x) => x.case === 'REBOOT').length });
  } catch (e) {
    add('D-EXC', { 异常: String((e && e.message) || e).slice(0, 400), 栈: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ') });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
