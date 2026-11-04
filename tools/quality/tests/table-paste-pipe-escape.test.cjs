'use strict';
/* 纯 Markdown 表粘贴保真（editing-3616）：二次转义 `\|` 与对齐冒号丢失的纯复现/回归。
 * 双臂用法（红＝extras.js 候选未并入；绿＝指向 overlay 候选副本，并入产品后默认即绿）：
 *   node --test tools/quality/tests/table-paste-pipe-escape.test.cjs
 *   MP_EXTRAS_SRC=".mp-verify/editing-3616/dsh/table/overlay/dsh-markpilot/src-cm6/extras.js" \
 *     node --test tools/quality/tests/table-paste-pipe-escape.test.cjs
 * 真实 GUI 入口：纯 text/plain（无 HTML 侧）粘贴 → extras.js 粘贴处理器 tableFromPlain(plain)
 * → rowsToMdTable(rows) 再编码；装机 A/B 由 .mp-verify/editing-3616/visual/table-plain.cjs 负责
 * （table-plain-before/result.json：`P(A|B)` 渲染成 `P(A∥B)`、代码多 `\`、`:--- | :---: | ---:` 全失）。 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const extrasPath = path.resolve(repo, process.env.MP_EXTRAS_SRC || 'dsh-markpilot/src-cm6/extras.js');
const extrasSrc = fs.readFileSync(extrasPath, 'utf8');
const HINT = '红＝extras.js 修复未并入；用 MP_EXTRAS_SRC 指向 overlay 候选副本运行应转绿';

/* 从真实 extras.js 文本按花括号配平提取整函数（测试的是产品代码本身，不是复刻）。 */
function extractFn(name) {
  const at = extrasSrc.indexOf('function ' + name + '(');
  if (at < 0) return null;
  const open = extrasSrc.indexOf('{', at);
  for (let i = open, depth = 0; i < extrasSrc.length; i++) {
    if (extrasSrc[i] === '{') depth++;
    else if (extrasSrc[i] === '}' && --depth === 0) return extrasSrc.slice(at, i + 1);
  }
  return null;
}
const tableFromPlainSrc = extractFn('tableFromPlain');
const rowsToMdTableSrc = extractFn('rowsToMdTable');
const verbatimSrc = extractFn('markdownTableVerbatim');
const fns = tableFromPlainSrc && rowsToMdTableSrc
  ? new Function(tableFromPlainSrc + '\n' + (verbatimSrc ? verbatimSrc + '\n' : '') + rowsToMdTableSrc +
      '\nreturn { tableFromPlain: tableFromPlain, rowsToMdTable: rowsToMdTable,' +
      ' markdownTableVerbatim: typeof markdownTableVerbatim === "function" ? markdownTableVerbatim : null };')()
  : null;

/* 粘贴管线＝extras.js 调用点同一决策（mdVerbatim 优先，rows 为空交回原生）。 */
function paste(plain, opts) {
  if (!fns) return null;
  const internal = !!(opts && opts.sourceClipboard);
  const rows = internal ? null : fns.tableFromPlain(plain);
  if (!rows) return null;
  const verbatim = !internal && fns.markdownTableVerbatim ? fns.markdownTableVerbatim(plain) : null;
  return verbatim || fns.rowsToMdTable(rows);
}

/* 与 visual/table-plain.cjs 同一夹具（含左/中/右对齐分隔行、公式与代码格）。 */
const SOURCE = [
  '| 题 | 概率 | 代码 |',
  '| :--- | :---: | ---: |',
  '| Q17 | $P(A\\|B)$ | `x \\| y` |',
];

test('候选函数可从真实 extras.js 提取', () => {
  assert.ok(fns, HINT);
  assert.ok(tableFromPlainSrc.startsWith('function tableFromPlain(plain) {'), '锚点漂移：函数头与产品不一致');
  assert.ok(rowsToMdTableSrc.startsWith('function rowsToMdTable(rows) {'), '锚点漂移：函数头与产品不一致');
});

test('调用点接线：mdVerbatim 优先于再编码（extras.js 真实文本）', () => {
  assert.equal(extrasSrc.split('text = mdVerbatim || rowsToMdTable(rows);').length - 1, 1, HINT);
  assert.equal(extrasSrc.split('function markdownTableVerbatim(plain) {').length - 1, 1, HINT + '（定义恰 1 处）');
  assert.equal(extrasSrc.split('markdownTableVerbatim(plain)) || null;').length - 1, 1, HINT + '（调用恰 1 处）');
  assert.ok(extrasSrc.includes(String.raw`.trim().replace(/\\\|/g, '|')`), HINT + '（无分隔行路径的解转义）');
});

test('成形 markdown 表逐字保真：对齐冒号与单次管道转义一个不动', () => {
  assert.ok(fns.markdownTableVerbatim, HINT);
  const out = paste(SOURCE.join('\n'));
  assert.equal(out, SOURCE.join('\n'));
  assert.ok(/^\| :--- \| :---: \| ---: \|$/m.test(out), '左/中/右对齐分隔行必须原样保留');
  assert.equal(out.split(String.raw`$P(A\|B)$`).length - 1, 1, '公式格转义恰好一次');
  assert.equal(out.split('`x \\| y`').length - 1, 1, '代码格转义恰好一次');
});

test('CRLF 剪贴板只归一行尾，其余逐字不变', () => {
  assert.ok(fns.markdownTableVerbatim, HINT);
  assert.equal(paste(SOURCE.join('\r\n')), SOURCE.join('\n'));
});

test('无分隔行的管道行仍自动成表，且不再二次转义', () => {
  const out = paste('| a \\| b |\n| c \\| d |');
  assert.equal(out, '| a \\| b |\n| --- |\n| c \\| d |');
});

test('TSV 路径不受影响（含字面反斜杠管道的格）', () => {
  assert.ok(fns.markdownTableVerbatim, HINT);
  assert.equal(fns.markdownTableVerbatim('A\\|B\tC\nD\tE'), null, 'TSV 形态不走逐字保真');
  assert.equal(paste('A\\|B\tC\nD\tE'), '| A\\\\|B | C |\n| --- | --- |\n| D | E |');
});

test('引用区表与混合文本不触发（rows=null ⇒ 交回原生粘贴，源码零改动）', () => {
  assert.ok(fns.markdownTableVerbatim, HINT);
  const quoted = '> | a \\| b |\n> | --- |\n> | c |';
  assert.equal(fns.tableFromPlain(quoted), null);
  assert.equal(fns.markdownTableVerbatim(quoted), null);
});

test('应用内部剪贴板（sourceClipboard）不触发', () => {
  assert.ok(fns.markdownTableVerbatim, HINT);
  assert.equal(paste(SOURCE.join('\n'), { sourceClipboard: true }), null);
});

test('双分隔行等不成表形态不误触发（rows 门在调用点之前）', () => {
  const odd = '| a | b |\n| --- | --- |\n| --- | --- |';
  assert.equal(fns.tableFromPlain(odd), null);
  assert.equal(paste(odd), null);
});

if (!verbatimSrc) {
  test('【红侧证据·原版 extras.js】再编码洗掉对齐并二次转义（并入候选后本条消失）', () => {
    const out = fns.rowsToMdTable(fns.tableFromPlain(SOURCE.join('\n')));
    assert.ok(out.includes('| --- | --- | --- |'), '对齐冒号被洗成无对齐（table-plain-before 实测同形态）');
    assert.ok(out.includes('$P(A\\\\|B)$'), String.raw`管道被二次转义（\| → \\|，重开渲染 P(A∥B)）`);
  });
}
