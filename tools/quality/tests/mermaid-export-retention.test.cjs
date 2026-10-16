'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../dsh-markpilot/src-cm6/main.js'), 'utf8');
const from = source.indexOf('window.mpMermaid = {'), to = source.indexOf('\nfunction mathWidget', from);
assert(from >= 0 && to > from);
function setup({ warm = [], bad = null, makeSvg = src => '<svg>' + src + '</svg>', changeTheme = false } = {}) {
  const cache = new Map(), calls = []; let theme = 'light';
  const key = (src, t) => t + ':' + src;
  for (const src of warm) cache.set(key(src, theme), { svg: makeSvg(src) });
  const sandbox = { window: {}, Text: { of: lines => lines }, TextEncoder,
    scanMermaidBlocks: lines => JSON.parse(lines.join('\n')).map(src => ({ src })),
    exportDiagramTheme: () => theme, mermaidTheme: () => theme, svgKey: key, svgCache: cache,
    requestMermaid(src, t, _view, done) {
      calls.push({ src, theme: t }); if (changeTheme) theme = 'dark';
      if (src === bad) return done(null, 'owned invalid fixture');
      const svg = makeSvg(src); cache.delete(key(src, t)); cache.set(key(src, t), { svg });
      while (cache.size > 64) cache.delete(cache.keys().next().value);
      done(svg, null);
    } };
  vm.runInNewContext(source.slice(from, to), sandbox);
  return { api: sandbox.window.mpMermaid, cache, calls, render: blocks => sandbox.window.mpMermaid.prerender(JSON.stringify(blocks)) };
}
for (const warm of [false, true]) test('actual export retains all 65 SVGs with ' + (warm ? '64 warm hits' : 'a cold LRU'), async () => {
  const blocks = Array.from({ length: 65 }, (_, i) => 'graph-' + i);
  const x = setup({ warm: warm ? blocks.slice(0, 64) : [] }), result = await x.render(blocks);
  assert.equal(result.svgs.size, 65); assert.equal(result.成功, 65); assert.equal(result.失败.length, 0);
  for (const src of blocks) assert.equal(result.svgs.get(src), '<svg>' + src + '</svg>');
  assert.equal(x.cache.size, 64); assert.equal(x.calls.length, warm ? 1 : 65);
  result.svgs.clear(); assert.equal(result.svgs.size, 0); assert.equal(x.cache.size, 64);
});
test('actual export deduplicates repeated source and freezes its theme while rendering', async () => {
  const x = setup({ changeTheme: true }), result = await x.render(['one', 'two', 'one', 'two']);
  assert.equal(result.总数, 4); assert.equal(result.成功, 4); assert.equal(result.svgs.size, 2);
  assert.deepEqual(x.calls, [{ src: 'one', theme: 'light' }, { src: 'two', theme: 'light' }]);
});
test('one invalid diagram leaves both valid neighbors and reports its failure', async () => {
  const x = setup({ bad: 'bad' }), result = await x.render(['one', 'bad', 'two']);
  assert.equal(result.成功, 2); assert.equal(result.失败.length, 1); assert.equal(result.失败[0].src, 'bad');
  assert.equal(result.svgs.has('one'), true); assert.equal(result.svgs.has('two'), true);
  assert.equal(result.svgs.has('bad'), false);
});
test('operation budget rejects oversized ASCII before UTF-8 allocation', async () => {
  const x = setup({ makeSvg: () => 'x'.repeat(32 * 1024 * 1024 + 1) });
  await assert.rejects(x.render(['large']), /32 MB/);
});
test('operation budget counts UTF-8 bytes across diagrams', async () => {
  const x = setup({ makeSvg: () => '字'.repeat(6 * 1024 * 1024) });
  await assert.rejects(x.render(['one', 'two']), /32 MB/);
});
