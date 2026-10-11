'use strict';
// node --test test/portable-markdown.test.cjs
// Boundary coverage for the portable-Markdown embedder: reference-style
// images, file names with spaces/parens/'#', code literals, duplicate
// sources, and remote failures (fail whole, keep original untouched).
const test = require('node:test');
const after = require('node:test').after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {imageSources, portableMarkdown} = require('../extension-src/render/js/portable-markdown.cjs');
const {imageBytes} = require('../extension-src/render/js/media-host.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-md-'));
const tinyPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const writeImage = name => {const file = path.join(root, name); fs.writeFileSync(file, tinyPng); return file;};

test('imageSources finds inline, angle-bracket, html and reference-style images but not code', () => {
  const text = [
    '# 标题 #1',
    '',
    '![a](pic1.png)',
    '',
    '![b](<my pic (2).png>)',
    '',
    '<img src="pic3.png" alt="c" />',
    '',
    '![d][ref]',
    '',
    '[ref]: pics/ref.png',
    '',
    '```',
    '![code](fenced.png)',
    '```',
    '',
    'inline `![code2](quoted.png)` stays text',
  ].join('\n');
  const sources = imageSources(text).map(item => item.src);
  assert.deepEqual(sources, ['pic1.png', 'my pic (2).png', 'pic3.png', 'pics/ref.png']);
});

test('imageBytes resolves names with spaces, parentheses, # and literal %', async () => {
  writeImage('my pic (2).png');
  writeImage('hash #1.png');
  writeImage('100%.png');
  writeImage('encoded name.png');
  const doc = path.join(root, 'doc.md');
  for (const src of ['my%20pic%20(2).png', 'my pic (2).png', 'hash%20%231.png', 'hash #1.png', '100%.png', 'encoded%20name.png']) {
    const image = await imageBytes(src, doc);
    assert.equal(image.mime, 'image/png');
    assert.ok(image.bytes.equals(tinyPng), src);
  }
});

test('portableMarkdown embeds duplicates once and keeps total ordering', async () => {
  writeImage('dup.png');
  const doc = path.join(root, 'dup.md');
  const text = 'before ![x](dup.png) mid ![x](dup.png) after';
  const result = await portableMarkdown(text, {file: doc});
  assert.equal(result.images, 2);
  assert.equal(result.embedded, 1);
  const marker = 'data:image/png;base64,' + tinyPng.toString('base64');
  assert.equal(result.text, `before ![x](${marker}) mid ![x](${marker}) after`);
});

test('remote failure fails the whole export with an error list and no partial output', async () => {
  writeImage('ok.png');
  const doc = path.join(root, 'fail.md');
  const text = '![ok](ok.png) ![bad](http://127.0.0.1:9/unreachable.png)';
  await assert.rejects(portableMarkdown(text, {file: doc}), error => {
    assert.match(error.message, /无法生成完整的便携 Markdown/);
    assert.match(error.message, /unreachable\.png/);
    return true;
  });
});

test('reference-style and data URIs pass through untouched', async () => {
  writeImage('ref.png');
  const data = 'data:image/png;base64,' + tinyPng.toString('base64');
  const doc = path.join(root, 'ref.md');
  const text = '![d][r]\n\n[r]: ref.png\n\n![inline](' + data + ')';
  const result = await portableMarkdown(text, {file: doc});
  assert.ok(result.text.includes('data:image/png;base64,'));
  assert.ok(!result.text.includes('ref.png'));
  // The data URI already embedded must not be re-read or duplicated.
  assert.equal(result.embedded, 1);
});

after(() => fs.rmSync(root, {recursive: true, force: true}));
