/** 表格内的公式编辑 + 行列增删 + 复制表格（用户点名的"表格里编辑复制粘贴删减增"）。
 *
 *  为什么单列一条：表格单元格里的行内公式走的是"IR 内联节点的展开/收回 + 表格源码
 *  归一化"这条复合路径（math-edit 对 td/th 有专门的 tableSource 处理），与正文里的
 *  公式不是同一条代码路径；而它同时又是最容易被结构调整弄坏的地方。
 *
 *  行列增删这一段的判据特意做成"加了再删 → 磁盘字节必须回到加之前"：只数行数的断言
 *  会被"删掉的其实是另一行"这种错误蒙混过去（本场景第一版就是这么假通过的）。
 *
 *  全部判据都是代码之外的东西：真实 DOM 的几何/属性、磁盘字节、独立进程读回的剪贴板。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const SURFACE_SEL = JSON.stringify(edge.SURFACE);
const doc = side => `document.getElementById('editor').contentWindow.document`;

// 第一个表格里带公式的那一格（用"含公式源码"定位，不靠索引——索引会随插行漂移）
const FORMULA_CELL = `(() => {
  const D = ${doc()};
  const surface = D.querySelector(${SURFACE_SEL});
  return [...surface.querySelectorAll('td,th')].find(cell => cell.querySelector('code[data-type="math-inline"]')) || null;
})()`;
const FORMULA_PREVIEW = `(() => {
  const cell = (${FORMULA_CELL});
  return cell ? (cell.querySelector('.vditor-ir__preview') || cell) : null;
})()`;
// 结构操作的空行/空列锚点：插进来的那一行/列是空的，正好用它做"删掉刚插的"这一步
const FIRST_EMPTY_BODY_CELL = `(() => {
  const D = ${doc()};
  const surface = D.querySelector(${SURFACE_SEL});
  const table = surface.querySelector('table');
  if (!table) return null;
  const rows = [...table.querySelectorAll('tr')];
  const row = rows.slice(1).find(item => !item.textContent.trim());
  return row ? (row.querySelector('td,th') || row) : null;
})()`;
const FIRST_EMPTY_HEADER_CELL = `(() => {
  const D = ${doc()};
  const surface = D.querySelector(${SURFACE_SEL});
  const table = surface.querySelector('table');
  if (!table) return null;
  const header = table.querySelector('tr');
  return header ? [...header.querySelectorAll('td,th')].find(cell => !cell.textContent.trim()) || null : null;
})()`;

/** 单元格里那个行内公式的全部可见事实。 */
const FORMULA = `(() => {
  const D = ${doc()};
  const surface = D.querySelector(${SURFACE_SEL});
  const cell = (${FORMULA_CELL});
  if (!cell) return {found: false};
  const owner = cell.querySelector('.vditor-ir__node');
  const code = cell.querySelector('code[data-type="math-inline"]');
  const lang = cell.querySelector('.language-math');
  const codeRect = code ? code.getBoundingClientRect() : null;
  const selection = document.getElementById('editor').contentWindow.getSelection();
  const anchor = selection && selection.rangeCount ? selection.anchorNode : null;
  return {
    found: true,
    cellText: cell.textContent.replace(/\\s+/g, ' ').trim(),
    expanded: !!(owner && owner.classList.contains('vditor-ir__node--expand')),
    codeText: code ? code.textContent : null,
    codeWidth: codeRect ? Math.round(codeRect.width) : 0,
    sourceVisible: !!codeRect && codeRect.width > 4 && codeRect.height > 4,
    render: (() => { const p = cell.querySelector('.vditor-ir__preview'); return p ? p.dataset.render : null; })(),
    math: lang ? lang.getAttribute('data-math') : null,
    katex: !!cell.querySelector('.katex'),
    caretInCode: !!(anchor && (anchor.closest ? anchor.closest('code') : anchor.parentElement && anchor.parentElement.closest('code'))),
  };
})()`;

const cfFragmentOf = text => {
  if (typeof text !== 'string') return null;
  const start = Number((/StartFragment:(\d+)/.exec(text) || [])[1] ?? NaN);
  const end = Number((/EndFragment:(\d+)/.exec(text) || [])[1] ?? NaN);
  return Number.isFinite(start) && Number.isFinite(end) ? text.slice(start, end) : null;
};
const tableRows = text => (text.match(/\n\|/g) || []).length;

module.exports = {
  id: '70-table-cell-math',
  title: '表格单元格里的公式：点进去编辑、行列增删（加完再删要回到原字节）、复制表格',
  async run(ctx) {
    const file = fixtures.mathTable();
    const clipboardDir = path.join(ctx.outDir, '70-table-cell-math');
    fs.mkdirSync(clipboardDir, { recursive: true });
    const saved = harness.saveClipboard(clipboardDir);
    const initial = fs.readFileSync(file, 'utf8');
    ctx.witness('素材（磁盘原始字节）', { file: path.basename(file), bytes: initial.length, hasFormula: initial.includes('$x^2+1$') });
    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector(${SURFACE_SEL});
        return !!(surface && surface.querySelector('table') && surface.querySelector('.katex'));
      })()`, { timeout: 90000, interval: 20 });
      ctx.assert('表格与单元格内公式都上屏（KaTeX 渲染出来了）', ready, `ready=${ready}`);
      if (!ready) return;
      await session.js(edge.WATCH_TOASTS);
      await edge.settle(session);

      const before = await session.js(FORMULA);
      const facts0 = await session.js(edge.TABLE_FACTS);
      ctx.log('上屏事实：' + JSON.stringify({formula: before, tables: facts0.tables.map(table => ({rows: table.rows, cells: table.cells}))}));
      ctx.witness('DOM：单元格内的公式（未编辑时源码应折叠）', before);
      ctx.assert('默认状态下公式是渲染态（源码折叠、有 KaTeX）',
        before.found && before.katex && !before.expanded && before.codeWidth === 0, JSON.stringify(before));

      // --- 1) 真实点击单元格里的公式 → 进入编辑态 --------------------------------
      const cellPoint = await session.js(edge.pointOf(FORMULA_PREVIEW));
      ctx.assert('能找到单元格内公式的可点坐标', cellPoint.ok && cellPoint.width > 0, JSON.stringify(cellPoint));
      if (!cellPoint.ok) return;
      await session.click(cellPoint.x, cellPoint.y);
      await harness.sleep(450);
      const editing = await session.js(FORMULA);
      ctx.log('点击后：' + JSON.stringify(editing));
      ctx.assert('点击后公式展开为可编辑源码，且光标落在源码里',
        editing.expanded && editing.sourceVisible && editing.caretInCode,
        JSON.stringify({expanded: editing.expanded, sourceVisible: editing.sourceVisible, caretInCode: editing.caretInCode}));
      if (!editing.expanded) return;

      // --- 2) 真键盘上屏：在源码里打字，公式必须跟着重排 -------------------------
      await session.type('\\cdot 2');
      await harness.sleep(700);
      const typed = await session.js(FORMULA);
      ctx.log('键入后：' + JSON.stringify(typed));
      ctx.assert('键入的源码进了这个单元格的公式', String(typed.codeText || '').includes('\\cdot 2'), JSON.stringify(typed.codeText));
      ctx.assert('公式重新渲染成渲染态（data-render=2 且 KaTeX 在）', typed.katex && typed.render === '2', JSON.stringify({render: typed.render, katex: typed.katex}));
      ctx.assert('渲染内容与源码一致（data-math 就是源码）',
        String(typed.math || '').replace(/\s+/g, '') === String(typed.codeText || '').replace(/\s+/g, ''),
        JSON.stringify({math: typed.math, code: typed.codeText}));

      // --- 3) 存盘 → 磁盘字节证人 -----------------------------------------------
      const editSave = await edge.saveAndWait(session, file);
      const edited = editSave.after;
      ctx.witness('磁盘：单元格公式编辑写入', { changed: edited !== editSave.before, row: (edited.match(/\|\s*甲\s*\|[^\n]*/) || [''])[0] });
      ctx.assert('存盘后磁盘上的这一行公式真的变了',
        edited !== editSave.before && /\\cdot\s*2/.test(edited) && /\$[^$\n]*\\cdot[^$\n]*\$/.test(edited),
        JSON.stringify((edited.match(/\|\s*甲\s*\|[^\n]*/) || [''])[0]));
      ctx.assert('存盘没有破坏表格结构（行标记数不变）', tableRows(edited) === tableRows(editSave.before),
        `${tableRows(editSave.before)} → ${tableRows(edited)}`);
      ctx.log(`存盘路径：${editSave.chordTook ? 'Ctrl+S 按键' : '按键没生效，退到主进程 save 命令'}，等待 ${editSave.waitedMs}ms`);

      // --- 4) 复制表格：编辑过的公式必须出现在剪贴板里（独立进程读回） -----------
      const copyMenu = await edge.menuClick(session, FORMULA_CELL, 'copy-table', { wait: 400 });
      // 剪贴板由 PowerShell 写入（首次 Add-Type 要 1–2s），必须**轮询**等它真的换掉：
      // 点完立刻读会读到用户原来的内容（本场景第一版就是这么假失败的）。
      const tableRead = await edge.readClipboardUntil(clipboardDir, read => typeof read.text === 'string' && /甲/.test(read.text) && /乙/.test(read.text));
      const fragment = cfFragmentOf(tableRead.htmlRawUtf8);
      const copyToasts = await session.js(edge.TOASTS);
      ctx.witness('复制表格：独立进程读回剪贴板', { formats: tableRead.formats, hasHtml: tableRead.hasHtml, htmlBytes: tableRead.htmlRawBytes,
        waitedMs: tableRead.waitedMs, timedOut: !!tableRead.timedOut,
        fragmentHead: fragment ? fragment.slice(0, 200) : null, text: String(tableRead.text || '').slice(0, 200), toasts: copyToasts });
      ctx.assert('右键菜单里可"复制表格到 Excel"', copyMenu.opened && copyMenu.label === '复制表格到 Excel',
        JSON.stringify({opened: copyMenu.opened, label: copyMenu.label, items: (copyMenu.items || []).map(item => item.action), attempts: copyMenu.attempts}));
      ctx.assert('界面回报"已复制表格"（用户看得见的效果）',
        (copyToasts.recorded || []).concat(copyToasts.live || []).some(text => /已复制表格/.test(String(text))),
        JSON.stringify(copyToasts));
      ctx.assert('剪贴板里有 CF_HTML，片段里是这张表（表头 + 中文单元格 + 编辑过的公式）',
        tableRead.hasHtml && !!fragment && /项目/.test(fragment) && /说明/.test(fragment) && /甲/.test(fragment) && /katex|\\cdot|x\^?2/.test(fragment),
        JSON.stringify({hasHtml: tableRead.hasHtml, fragment: fragment ? fragment.slice(0, 200) : null}));
      ctx.assert('剪贴板的纯文本里也有这张表，且带着编辑后的公式源码',
        typeof tableRead.text === 'string' && /甲/.test(tableRead.text) && /乙/.test(tableRead.text) && /\\cdot\s*2/.test(tableRead.text),
        JSON.stringify(String(tableRead.text || '').slice(0, 200)));

      // --- 5) 行：上方插入一行（空行）→ 断言 +1；删掉这一空行 → 断言磁盘回到编辑后字节
      const rowAdd = await edge.menuClick(session, FORMULA_CELL, 'table-row-above');
      const afterRowAdd = await session.js(edge.TABLE_FACTS);
      ctx.assert('右键菜单里可"上方插入行"', rowAdd.opened && rowAdd.label === '上方插入行',
        JSON.stringify({opened: rowAdd.opened, label: rowAdd.label, attempts: rowAdd.attempts}));
      ctx.assert('插入行后 DOM 第一张表多了一行', afterRowAdd.tables[0].rows === facts0.tables[0].rows + 1,
        `${facts0.tables[0].rows} → ${afterRowAdd.tables[0].rows}`);
      const rowSave = await edge.saveAndWait(session, file);
      const rowTable = edge.tableBlock(rowSave.after);
      ctx.log('插入行之后磁盘上的第一张表：' + JSON.stringify(rowTable));
      ctx.witness('磁盘：插入行之后', { tableLines: rowTable.length, anchorRow: (rowSave.after.match(/\|\s*甲\s*\|[^\n]*/) || [''])[0] });
      ctx.assert('插入行写进了磁盘，且"甲"这一行还在（没被顶掉）',
        edge.tableBlock(rowSave.after).length === edge.tableBlock(edited).length + 1 && /\|\s*甲\s*\|/.test(rowSave.after),
        JSON.stringify({lines: `${edge.tableBlock(edited).length} → ${edge.tableBlock(rowSave.after).length}`, row: (rowSave.after.match(/\|\s*甲\s*\|[^\n]*/) || [''])[0]}));

      const emptyRow = await session.js(edge.pointOf(FIRST_EMPTY_BODY_CELL));
      ctx.assert('能找到刚插入的那个空行（作为"删掉它"的锚点）', emptyRow.ok, JSON.stringify(emptyRow));
      if (emptyRow.ok) {
        const rowDelete = await edge.menuClick(session, FIRST_EMPTY_BODY_CELL, 'table-delete-row');
        const afterRowDelete = await session.js(edge.TABLE_FACTS);
        ctx.assert('右键菜单里可"删除当前行"', rowDelete.opened && rowDelete.label === '删除当前行', JSON.stringify({opened: rowDelete.opened, label: rowDelete.label}));
        ctx.assert('删掉空行后 DOM 行数回到编辑后的状态', afterRowDelete.tables[0].rows === facts0.tables[0].rows,
          `${afterRowAdd.tables[0].rows} → ${afterRowDelete.tables[0].rows}`);
        const rowBack = await edge.saveAndWait(session, file);
        ctx.witness('磁盘：插入再删除之后的字节（应等于编辑后的磁盘）', { sameBytes: rowBack.after === edited, bytes: Buffer.byteLength(rowBack.after, 'utf8') });
        ctx.assert('【加完再删】插入行后删除它，磁盘字节回到编辑后的状态（一字不差）',
          rowBack.after === edited, rowBack.after === edited ? '字节相同' : JSON.stringify(firstDiff(edited, rowBack.after)));
      }

      // --- 6) 列：左侧插入一列（空列）→ 断言 +1；删掉这一空列 → 断言磁盘回到编辑后字节
      const colAdd = await edge.menuClick(session, FORMULA_CELL, 'table-col-left');
      const afterColAdd = await session.js(edge.TABLE_FACTS);
      ctx.assert('右键菜单里可"左侧插入列"', colAdd.opened && colAdd.label === '左侧插入列', JSON.stringify({opened: colAdd.opened, label: colAdd.label}));
      ctx.assert('插入列后 DOM 第一张表每行多一格', afterColAdd.tables[0].cells[0] === facts0.tables[0].cells[0] + 1,
        `${JSON.stringify(facts0.tables[0].cells)} → ${JSON.stringify(afterColAdd.tables[0].cells)}`);
      const colSave = await edge.saveAndWait(session, file);
      const colTable = edge.tableBlock(colSave.after);
      const separatorBefore = edge.separatorSegments(edge.tableBlock(edited).find(line => /^\s*\|[\s:|-]+\|\s*$/.test(line)) || '');
      const separatorAfter = edge.separatorSegments(colTable.find(line => /^\s*\|[\s:|-]+\|\s*$/.test(line)) || '');
      ctx.log('插入列之后磁盘上的第一张表：' + JSON.stringify(colTable));
      ctx.witness('磁盘：插入列之后', { separatorSegments: `${separatorBefore} → ${separatorAfter}`, separator: (colTable.find(line => /^\s*\|[\s:|-]+\|\s*$/.test(line)) || '') });
      ctx.assert('插入列写进了磁盘（分隔行多一段）', separatorAfter === separatorBefore + 1,
        JSON.stringify({separatorBefore, separatorAfter, line: colTable.find(line => /^\s*\|[\s:|-]+\|\s*$/.test(line))}));
      const emptyColumn = await session.js(edge.pointOf(FIRST_EMPTY_HEADER_CELL));
      ctx.assert('能找到刚插入的那个空列（作为"删掉它"的锚点）', emptyColumn.ok, JSON.stringify(emptyColumn));
      if (emptyColumn.ok) {
        const colDelete = await edge.menuClick(session, FIRST_EMPTY_HEADER_CELL, 'table-delete-col');
        const afterColDelete = await session.js(edge.TABLE_FACTS);
        ctx.assert('右键菜单里可"删除当前列"', colDelete.opened && colDelete.label === '删除当前列', JSON.stringify({opened: colDelete.opened, label: colDelete.label}));
        ctx.assert('删掉空列后 DOM 回到编辑后的状态', afterColDelete.tables[0].cells[0] === facts0.tables[0].cells[0],
          `${JSON.stringify(afterColAdd.tables[0].cells)} → ${JSON.stringify(afterColDelete.tables[0].cells)}`);
        const colBack = await edge.saveAndWait(session, file);
        ctx.witness('磁盘：插入再删除列之后的字节（应等于编辑后的磁盘）', { sameBytes: colBack.after === edited, bytes: Buffer.byteLength(colBack.after, 'utf8') });
        ctx.assert('【加完再删】插入列后删除它，磁盘字节回到编辑后的状态（一字不差）',
          colBack.after === edited, colBack.after === edited ? '字节相同' : JSON.stringify(firstDiff(edited, colBack.after)));
      }

      // --- 7) 错误面 ------------------------------------------------------------
      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.witness('界面提示（全程观察者记录）', { toasts });
      ctx.assert('全程没有错误提示（乱码 / -File / app.asar / 失败）', problems.length === 0, JSON.stringify({problems, toasts}));

      // --- 8) 表格之外的正文一个字符都没动 --------------------------------------
      const source = fs.readFileSync(file, 'utf8');
      ctx.assert('磁盘上"表格之前的正文/之后的正文/末尾段落"三段都在且原样',
        source.includes('表格之前的正文：用来确认对单元格的编辑不会串到表格外面。') &&
        source.includes('表格之后的正文：插入/删除行列之后这一段必须原地不动。') &&
        source.includes('末尾段落：收尾。'),
        JSON.stringify({a: source.includes('表格之前的正文'), b: source.includes('表格之后的正文'), c: source.includes('末尾段落')}));
      const singleTable = edge.tableBlock(source, '单列表');
      ctx.log('磁盘尾部（单列表那张表）：' + JSON.stringify(singleTable) + ' ｜全文尾 200 字：' + JSON.stringify(source.slice(-200)));
      ctx.assert('第二张表（单列表）没被波及',
        singleTable.length === 4 && singleTable.some(line => /\$a_1\$/.test(line)) && singleTable.some(line => /\$a_2\$/.test(line)),
        JSON.stringify(singleTable));
      ctx.metric('table.rows', facts0.tables[0].rows, { unit: '行', direction: 'equal', tolerance: 0 });
      ctx.metric('table.cells', facts0.tables[0].cells[0], { unit: '格', direction: 'equal', tolerance: 0 });
      ctx.metric('table.cellFormulaCodeChars', String(typed.codeText || '').length, { unit: '字符', direction: 'equal', tolerance: 0.2 });
      await session.shot('70-table-cell-math');
    } finally {
      await ctx.release(session);
      try { harness.restoreClipboard(clipboardDir, saved.__file); } catch { /* 忽略 */ }
      try { fs.writeFileSync(file, initial); } catch { /* 忽略 */ }
    }
  },
};

/** 第一处差异（把"不一致"变成可读证据）。 */
function firstDiff(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) {
      return { at: index, expected: JSON.stringify(a.slice(Math.max(0, index - 40), index + 40)), actual: JSON.stringify(b.slice(Math.max(0, index - 40), index + 40)) };
    }
  }
  return { at: -1 };
}
