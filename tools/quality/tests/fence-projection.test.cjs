'use strict';
/* Persistent model test for the shared CM6 fence/Mermaid source projection.
 *
 * Run from the project root:
 *   node --test tools/quality/tests/fence-projection.test.cjs
 *
 * Import targets are the shipped engine sources, not a mirror. The first test
 * is the contract for the new helper; the rest pin the half-open boundaries,
 * reverse ranges, multi-ranges, and the fenced-block shapes the visual probe
 * exercises (closed/unclosed/tilde/long close/quoted).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const local = n => pathToFileURL(path.join(root, 'dsh-markpilot/src-cm6', n)).href;
const cm = n => pathToFileURL(path.join(root, 'dsh-markpilot/node_modules/@codemirror', n, 'dist/index.js')).href;
const range = (from, to = from) => ({ from, to, head: to, empty: from === to });

test('exports the half-open source-display predicates', async () => {
  const mod = await import(local('region-index.js'));
  assert.equal(typeof mod.selectionTouchesRegion, 'function');
  assert.equal(typeof mod.hiddenFenceLines, 'function');
});

test('selectionTouchesRegion keeps non-empty ends half-open and collapsed ends inclusive', async () => {
  const { selectionTouchesRegion } = await import(local('region-index.js'));
  const region = { from: 10, to: 20 };
  const cases = [
    ['selection ends exactly at block head', range(9, 10), false],
    ['selection starts one char before and enters', range(9, 11), true],
    ['selection starts exactly at block head', range(10, 10), true],
    ['selection starts exactly at block tail', range(20, 21), false],
    ['selection touches the last source character', range(19, 21), true],
    ['whole block selected', range(10, 20), true],
    ['cursor at block head', range(10), true],
    ['cursor at block tail', range(20), true],
    ['cursor before block', range(9), false],
    ['cursor after block', range(21), false],
  ];
  for (const [name, r, want] of cases) assert.equal(selectionTouchesRegion(region, r), want, name);
});

test('forward and reverse non-empty selections cannot flip a boundary', async () => {
  const { selectionTouchesRegion } = await import(local('region-index.js'));
  const region = { from: 10, to: 20 };
  const fwd = range(9, 10);
  const rev = { from: 9, to: 10, head: 9, empty: false };
  assert.equal(selectionTouchesRegion(region, fwd), false);
  assert.equal(selectionTouchesRegion(region, rev), false, 'reverse direction must not open a half-open boundary');
  const fwdIn = range(19, 21);
  const revIn = { from: 19, to: 21, head: 19, empty: false };
  assert.equal(selectionTouchesRegion(region, fwdIn), true);
  assert.equal(selectionTouchesRegion(region, revIn), true);
});

test('hiddenFenceLines shows both fences only for the touched block', async () => {
  const { hiddenFenceLines } = await import(local('region-index.js'));
  const blocks = [
    { from: 10, to: 20, closeFrom: 18 },
    { from: 30, to: 40, closeFrom: null },
  ];
  assert.deepEqual(hiddenFenceLines(blocks, []), [10, 18, 30]);
  assert.deepEqual(hiddenFenceLines(blocks, [range(15)]), [30]);
  assert.deepEqual(hiddenFenceLines(blocks, [range(35)]), [10, 18]);
  assert.deepEqual(hiddenFenceLines(blocks, [range(9, 10)]), [10, 18, 30]);
  assert.deepEqual(hiddenFenceLines(blocks, [range(20, 21)]), [10, 18, 30]);
  assert.deepEqual(hiddenFenceLines(blocks, [range(20)]), [30]);
  assert.deepEqual(hiddenFenceLines(blocks, [range(0), range(15)]), [30]);
  assert.deepEqual(hiddenFenceLines(blocks, [{ from: 15, to: 35, head: 15, empty: false }]), []);
});

test('real scanner: closed, unclosed, tilde long-close, quoted fences', async () => {
  const { Text } = await import(cm('state'));
  const { scanFencedBlocks } = await import(local('markdown-context.js'));
  const { hiddenFenceLines } = await import(local('region-index.js'));
  const cases = [
    { name: 'backtick closed', doc: 'P0\n\n```js\nalpha\n```\n', cursor: 'alpha', fences: 2 },
    { name: 'tilde with longer close', doc: 'P0\n\n~~~txt\ntilde\n~~~~\n', cursor: 'tilde', fences: 2 },
    { name: 'backtick with longer close', doc: 'P0\n\n````md\nlong\n`````\n', cursor: 'long', fences: 2 },
    { name: 'unclosed at EOF', doc: 'P0\n\n~~~txt\nonly\n', cursor: 'only', fences: 1 },
    { name: 'quoted fence', doc: 'P0\n\n> ~~~txt\n> quoted\n> ~~~\n', cursor: 'quoted', fences: 2 },
  ];
  for (const c of cases) {
    const text = Text.of(c.doc.split('\n'));
    const blocks = scanFencedBlocks(text);
    const inside = c.doc.indexOf(c.cursor) + 1;
    assert.equal(hiddenFenceLines(blocks, [range(inside)]).length, 0, c.name + ' touched block hides no fence');
    const outside = hiddenFenceLines(blocks, []);
    assert.equal(outside.length, c.fences, c.name + ' untouched fence count');
    for (const from of outside) assert(blocks.find(b => b.from === from || b.closeFrom === from), c.name + ' hidden line belongs to a block');
  }
});
