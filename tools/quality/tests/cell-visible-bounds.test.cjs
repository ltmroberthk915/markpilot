'use strict';
/* 覆盖层可见 Home/End 边界（editing-3616）：cell-source-map.js 的 cellContentSpan / cellCaretEdge。
 * 根因：格源码段两端的 Markdown 填充空白在覆盖层里不可见，原生 End 越过它，Backspace 吃掉的是
 * 填充空白（真人实测 dblclick→End→Backspace→3 落盘 `| … | 7423|`，本意 743）。
 * 双臂用法（红＝候选未并入；绿＝指向 overlay 候选副本，并入产品后默认即绿）：
 *   node --test tools/quality/tests/cell-visible-bounds.test.cjs
 *   MP_CELL_SOURCE_MAP=".mp-verify/editing-3616/dsh/table/overlay/dsh-markpilot/src-cm6/cell-source-map.js" \
 *     node --test tools/quality/tests/cell-visible-bounds.test.cjs
 * 主路径已由主控实机验证：742→743 落盘、重开、Shift+End/Shift+Home 双向精确选中 743、
 * 替换 008 不改其它字节。 */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '../../..');
const source = import(pathToFileURL(path.resolve(repo,
  process.env.MP_CELL_SOURCE_MAP || 'dsh-markpilot/src-cm6/cell-source-map.js')).href);
const HINT = '红＝cell-source-map.js 候选（cellContentSpan/cellCaretEdge）未并入；用 MP_CELL_SOURCE_MAP 指向 overlay 候选副本运行应转绿';

test('候选导出存在', async () => {
  const m = await source;
  assert.equal(typeof m.cellContentSpan, 'function', HINT);
  assert.equal(typeof m.cellCaretEdge, 'function', HINT);
});

test('cellContentSpan：常规填充（空格/制表符，前后各 1~2 个）', async () => {
  const { cellContentSpan } = await source;
  assert.deepEqual(cellContentSpan(' 742 '), { start: 1, end: 4 });
  assert.deepEqual(cellContentSpan('742'), { start: 0, end: 3 });
  assert.deepEqual(cellContentSpan('  742  '), { start: 2, end: 5 });
  assert.deepEqual(cellContentSpan('\t742 '), { start: 1, end: 4 });
});

test('cellContentSpan：空串/全空白退化为原始两端（空格TAB空格 实长 3，table-independent.log 纠正版）', async () => {
  const { cellContentSpan } = await source;
  assert.equal(' \t '.length, 3, '夹具自证：空格+TAB+空格 共 3 字符');
  assert.deepEqual(cellContentSpan(''), { start: 0, end: 0 });
  assert.deepEqual(cellContentSpan('   '), { start: 0, end: 3 });
  assert.deepEqual(cellContentSpan(' \t '), { start: 0, end: 3 });
});

test('cellContentSpan：内容内部空白是内容不折叠；代码/公式/引号格照常', async () => {
  const { cellContentSpan } = await source;
  assert.deepEqual(cellContentSpan(' a  b '), { start: 1, end: 5 });
  assert.deepEqual(cellContentSpan(' `x | y` '), { start: 1, end: 8 });
  assert.deepEqual(cellContentSpan(' $P(A|B)$ '), { start: 1, end: 9 });
  assert.deepEqual(cellContentSpan(' “题” '), { start: 1, end: 4 });
});

test('cellCaretEdge：裸 End/Home 折叠到可见边界（742→743 缺陷主路径）', async () => {
  const { cellCaretEdge } = await source;
  assert.deepEqual(cellCaretEdge(' 742 ', 'End', false, 5), { anchor: 4, head: 4 });
  assert.deepEqual(cellCaretEdge(' 742 ', 'Home', false, 0), { anchor: 1, head: 1 });
  assert.deepEqual(cellCaretEdge(' `x | y` ', 'End', false, 9), { anchor: 8, head: 8 });
});

test('cellCaretEdge：Shift 伸缩保留锚点，正反两个方向都只动 head', async () => {
  const { cellCaretEdge } = await source;
  assert.deepEqual(cellCaretEdge(' 742 ', 'End', true, 2), { anchor: 2, head: 4 });
  assert.deepEqual(cellCaretEdge(' 742 ', 'End', true, 5), { anchor: 5, head: 4 });
  assert.deepEqual(cellCaretEdge(' 742 ', 'Home', true, 4), { anchor: 4, head: 1 });
  assert.deepEqual(cellCaretEdge(' 742 ', 'Home', true, 0), { anchor: 0, head: 1 });
});

test('cellCaretEdge：全空白格维持原生两端（不产生按键没反应）', async () => {
  const { cellCaretEdge } = await source;
  assert.deepEqual(cellCaretEdge('   ', 'End', false, 3), { anchor: 3, head: 3 });
  assert.deepEqual(cellCaretEdge('   ', 'Home', false, 0), { anchor: 0, head: 0 });
  assert.deepEqual(cellCaretEdge('', 'End', false, 0), { anchor: 0, head: 0 });
});

test('事故归因：742→743 与旧路径 7423 都是最小 diff（损坏在光标位置，不在映射层）', async () => {
  const { cellTextChange } = await source;
  assert.deepEqual(cellTextChange(' 742 ', ' 743 '), { from: 3, to: 4, insert: '3', source: ' 743 ' });
  assert.deepEqual(cellTextChange(' 742 ', ' 7423'), { from: 4, to: 5, insert: '3', source: ' 7423' });
});
