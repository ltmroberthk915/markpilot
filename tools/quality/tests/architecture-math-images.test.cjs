'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const inline = import(pathToFileURL(path.join(root, 'dsh-markpilot/src-cm6/inline-format.js')).href);
const { imageExtension, planDataImages, planAssetDataImages } = require('../../../dsh-markpilot/src-cm6/data-images.cjs');
const { dataImageChunks } = require('../../../MarkPilot-CM6/shell/data-image-bytes');
const { readCappedResponse } = require('../../../MarkPilot-CM6/shell/capped-read');

test('adjacent inline formulas have distinct, non-overlapping source spans', async () => {
  const { inlineMathSpans } = await inline;
  for (const source of ['$A$$B$$C$', 'before $A$$B$$C$ after']) {
    const spans = inlineMathSpans(source);
    assert.deepEqual(spans.map(s => s.tex), ['A', 'B', 'C']);
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      assert.equal(source.slice(span.from, span.to), '$' + span.tex + '$');
      if (i) assert(spans[i - 1].to <= span.from);
    }
  }
});

test('malformed double-dollar atoms do not capture a later formula or ordinary text', async () => {
  const { inlineMathSpans } = await inline;
  for (const source of ['$$a$ $B$', '$$a$ **bold** $B$ suffix', '$$a$ <u>$B$</u> suffix']) {
    const spans = inlineMathSpans(source);
    assert.deepEqual(spans.map(s => s.tex), ['B']);
    assert.equal(source.slice(spans[0].from, spans[0].to), '$B$');
  }
  for (const source of ['$$', '$$$$', '$ $', '$$a$']) assert.deepEqual(inlineMathSpans(source), []);
});

test('math recognition preserves code/image opacity and escape parity', async () => {
  const { inlineMathSpans, hasUnescapedDollar } = await inline;
  for (const source of ['`$A$` $B$', '``$A$`` $B$', '![x](https://x/$A$) $B$', '<img alt="$A$" src="x"> $B$', '\\$A$ $B$'])
    assert.deepEqual(inlineMathSpans(source).map(s => s.tex), ['B'], source);
  assert.deepEqual(inlineMathSpans('\\\\$A$ $B$').map(s => s.tex), ['A', 'B']);
  for (let slashes = 0; slashes < 6; slashes++)
    assert.equal(hasUnescapedDollar('\\'.repeat(slashes) + '$'), slashes % 2 === 0);
  assert.equal(hasUnescapedDollar('\\$ then $'), true);
  assert.equal(hasUnescapedDollar('ordinary text'), false);
});

test('canonical image extensions exclude prototype properties', () => {
  assert.equal(imageExtension('image/svg+xml'), '.svg');
  assert.equal(imageExtension('IMAGE/SVG+XML; charset=utf-8'), '.svg');
  assert.equal(imageExtension('image/jpeg'), '.jpg');
  for (const mime of ['constructor', '__proto__', 'text/plain', '']) assert.equal(imageExtension(mime), null);
  assert.throws(() => planAssetDataImages(['data:constructor;base64,QQ==']), { code: 'MP_EXPORT_DATA_IMAGE' });
});

test('asset preflight and the actual decoder preserve percent bytes and literal UTF-8', () => {
  const binary = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>汉😀</text></svg>';
  const cases = [
    ['data:image/png,%89PNG%0D%0A%1A%0A%00%FF', binary, '.png'],
    ['data:image/png;base64,' + binary.toString('base64'), binary, '.png'],
    ['data:image/svg+xml,' + encodeURIComponent(svg), Buffer.from(svg), '.svg'],
    ['data:image/svg+xml,' + svg, Buffer.from(svg), '.svg'],
  ];
  for (const [source, expected, ext] of cases) {
    const plan = planAssetDataImages([source]).get(source);
    assert.equal(plan.ext, ext); assert.equal(plan.bytes, expected.length);
    assert.deepEqual(Buffer.concat([...dataImageChunks(plan)]), expected);
  }
  const source = cases[0][0];
  for (const planner of [planDataImages, planAssetDataImages]) {
    assert.throws(() => planner([source], { imageBytes: binary.length - 1 }), { code: 'MP_EXPORT_DATA_IMAGE' });
    assert.equal(planner([source], { imageBytes: binary.length }).get(source).bytes, binary.length);
  }
  for (const source of ['data:image/png,%GG', 'data:image/png;base64,A', 'data:image/png,'])
    assert.throws(() => planAssetDataImages([source]), { code: 'MP_EXPORT_DATA_IMAGE' });
});

function response(chunks, { declared = null, errorAt = -1 } = {}) {
  let at = 0;
  const trace = { reads: 0, cancellations: 0, releases: 0, consumed: 0 };
  return { trace, response: {
    headers: { get: () => declared },
    body: {
      async cancel() { trace.cancellations++; },
      getReader() { return {
        async read() {
          trace.reads++;
          if (at === errorAt) throw new Error('injected stream error');
          if (at === chunks.length) return { done: true };
          const value = Uint8Array.from(chunks[at++]); trace.consumed += value.length;
          return { done: false, value };
        },
        async cancel() { trace.cancellations++; },
        releaseLock() { trace.releases++; },
      }; },
    },
    arrayBuffer() { assert.fail('bounded readers must not request the entire response'); },
  } };
}

test('stream budget rejects the extra byte and lying headers before trailing chunks', async () => {
  for (const declared of [null, '1']) {
    const fixture = response([[1, 2], [3, 4], [5], [6, 7, 8]], { declared });
    await assert.rejects(readCappedResponse(fixture.response, 4), { code: 'E_TOO_LARGE' });
    assert.equal(fixture.trace.consumed, 5);
    assert.equal(fixture.trace.cancellations, 1); assert.equal(fixture.trace.releases, 1);
  }
});

test('header overflow cancels without reading; exact cap and read errors settle correctly', async () => {
  const oversized = response([[1]], { declared: '5' });
  await assert.rejects(readCappedResponse(oversized.response, 4), { code: 'E_TOO_LARGE' });
  assert.equal(oversized.trace.reads, 0); assert.equal(oversized.trace.cancellations, 1);
  const exact = response([[1, 2], [3, 4]]);
  assert.deepEqual(await readCappedResponse(exact.response, 4), Buffer.from([1, 2, 3, 4]));
  assert.equal(exact.trace.cancellations, 0); assert.equal(exact.trace.releases, 1);
  const broken = response([[1], [2]], { errorAt: 1 });
  await assert.rejects(readCappedResponse(broken.response, 4), /injected stream error/);
  assert.equal(broken.trace.cancellations, 1); assert.equal(broken.trace.releases, 1);
});
