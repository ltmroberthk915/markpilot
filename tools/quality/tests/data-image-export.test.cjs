'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { planDataImages } = require('../../../dsh-markpilot/src-cm6/data-images.cjs');
const { prepareAssets } = require('../../../MarkPilot-CM6/export-folder.js');
assert.equal(fs.readFileSync(path.resolve(__dirname, '../../../MarkPilot-CM6/shell/data-images.cjs'), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../../../dsh-markpilot/src-cm6/data-images.cjs'), 'utf8'), 'host and renderer share the exact built budget parser');
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
const b64 = 'data:image/png;base64,' + bytes.toString('base64');
const percent = 'data:image/png,' + [...bytes].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const temp = () => fsp.mkdtemp(path.resolve(__dirname, '../../../.mp-verify/v340/inline-unit-'));
test('shared preflight validates exact decoded sizes, whitespace, unpadded base64 and raw percent bytes', () => {
  for (const url of [b64, percent, b64.replace(/=+$/, ''), b64.replace('base64,', 'base64,\n ')]) assert.equal([...planDataImages([url]).values()][0].bytes, bytes.length);
  const svg = 'data:image/svg+xml,<svg>汉😀</svg>';
  assert.equal(planDataImages([svg]).get(svg).bytes, Buffer.byteLength('<svg>汉😀</svg>'));
});
test('shared preflight rejects malformed encodings before decoding and never raises hard budgets', () => {
  for (const url of ['data:image/png;base64,A', 'data:image/png;base64,AA=A', 'data:image/png;base64,AA===', 'data:image/png,%Q1', 'data:image/png,', 'data:text/plain;base64,QQ==', 'data:constructor;base64,QQ==']) assert.throws(() => planDataImages([url]), { code: 'MP_EXPORT_DATA_IMAGE' });
  assert.throws(() => planDataImages([b64], { imageBytes: bytes.length - 1 }), /超过/);
  assert.equal(planDataImages([b64], { imageBytes: bytes.length }).size, 1);
  assert.throws(() => planDataImages([b64], { imageChars: b64.length - 1 }), /超过/);
  assert.throws(() => planDataImages([b64, percent], { totalBytes: bytes.length * 2 - 1 }), /超过/);
  assert.equal(planDataImages([b64, b64], { totalBytes: bytes.length }).size, 1);
});
test('staging streams exact base64 and percent bytes, deduplicates payloads and leaves no temporary file', async () => {
  const dir = await temp(), result = await prepareAssets({ dir, refs: [b64, percent, b64], dataImages: true });
  assert.equal(result.ok, true); assert.equal(result.failed, 0); assert.equal(result.entries.length, 3);
  assert.equal(result.copied, 1); assert.equal(result.bytes, bytes.length);
  for (const entry of result.entries) { assert.equal(entry.ok, true); assert.equal(digest(fs.readFileSync(path.join(dir, decodeURIComponent(entry.rel)))), digest(bytes)); }
  assert.deepEqual(fs.readdirSync(result.assetsDir).filter(f => f.startsWith('.mp-asset-')), []);
});
test('staging retains literal UTF-8 SVG bytes including its final greater-than character', async () => {
  const dir = await temp(), svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>汉😀</text></svg>', src = 'data:image/svg+xml,' + svg;
  const result = await prepareAssets({ dir, refs: [src], dataImages: true });
  assert.equal(result.entries[0].ok, true);
  assert.equal(fs.readFileSync(path.join(dir, decodeURIComponent(result.entries[0].rel)), 'utf8'), svg);
});
test('a mixed local/data document rejects invalid data before creating or copying anything', async () => {
  const dir = await temp(), local = path.join(dir, 'local.png'); fs.writeFileSync(local, bytes);
  await assert.rejects(prepareAssets({ dir, docPath: path.join(dir, 'doc.md'), refs: ['local.png', 'data:image/png;base64,A'], dataImages: true }), /base64/);
  assert.equal(fs.existsSync(path.join(dir, 'assets')), false);
});
test('failed data asset publication keeps an existing mismatched asset and cleans only its temporary file', async () => {
  const dir = await temp(), assets = path.join(dir, 'assets'); fs.mkdirSync(assets);
  const target = path.join(assets, 'image-' + digest(bytes) + '.png'); fs.writeFileSync(target, 'existing unrelated bytes');
  const result = await prepareAssets({ dir, refs: [b64], dataImages: true });
  assert.equal(result.entries[0].ok, false); assert.equal(result.entries[0].kind, 'data');
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing unrelated bytes'); assert.equal(fs.readdirSync(assets).length, 1);
});
test('ordinary folder mode retains its existing data URL policy and cancellation publishes nothing', async () => {
  const dir = await temp(), normal = await prepareAssets({ dir, refs: [b64] });
  assert.equal(normal.skipped, 1); assert.equal(normal.copied, 0);
  const canceled = await prepareAssets({ dir, refs: [b64], dataImages: true, isCanceled: () => true });
  assert.equal(canceled.canceled, true); assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')), []);
});
