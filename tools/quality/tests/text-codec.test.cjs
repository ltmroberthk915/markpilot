'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeDocument, encodeDocument } = require('../../../MarkPilot-CM6/shell/text-codec');
for (const encoding of ['utf8', 'utf16le', 'utf16be']) for (const eol of ['\n', '\r\n']) {
  test(encoding + ' ' + JSON.stringify(eol) + ' preserves byte order, BOM, CJK, ASCII, emoji and a content FEFF', () => {
    const text = '中文 English 😀\n\ufeff正文\n';
    const bytes = encodeDocument(text, { encoding, bom: true, eol });
    assert.equal(bytes.subarray(0, encoding === 'utf8' ? 3 : 2).toString('hex'), { utf8: 'efbbbf', utf16le: 'fffe', utf16be: 'feff' }[encoding]);
    const doc = decodeDocument(bytes); assert.equal(doc.text, text); assert.equal(doc.encoding, encoding); assert.equal(doc.bom, true); assert.equal(doc.eol, eol);
    assert(encodeDocument(doc.text, doc).equals(bytes));
  });
}
test('empty BOM-only UTF-16 files are valid, rather than binary', () => {
  for (const hex of ['fffe', 'feff']) { const d = decodeDocument(Buffer.from(hex, 'hex')); assert.equal(d.text, ''); assert(encodeDocument('', d).equals(Buffer.from(hex, 'hex'))); }
});
test('UTF-8 without BOM, occasional NUL and literal U+FFFD remain valid', () => {
  const text = '合法 text\0 with literal �\n'; const d = decodeDocument(Buffer.from(text)); assert.equal(d.text, text); assert(!d.bom); assert(encodeDocument(text, d).equals(Buffer.from(text)));
});
test('odd UTF-16, unpaired surrogates, UTF-32 and invalid UTF-8 are refused', () => {
  for (const hex of ['fffe61', 'feff61', 'fffe00d8', 'feffd800', 'fffe00dc', 'feffdc00', 'fffe000041000000', '0000feff00000041', 'c328', 'eda080', 'efbbbf80']) assert.throws(() => decodeDocument(Buffer.from(hex, 'hex')), e => e.code === 'MP_ENCODING');
});
test('binary signatures and mostly NUL bytes are refused', () => {
  for (const hex of ['89504e470d0a', 'ffd8ff', '474946383961', '424d0000', '255044462d', '504b0304', '7f454c46', '52494646', '00000100', '000000000000']) assert.throws(() => decodeDocument(Buffer.from(hex, 'hex')), e => e.code === 'MP_BINARY');
});
test('an unpaired in-memory surrogate is refused in every writer encoding', () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be']) for (const text of ['before\ud800after', '\udc00', 'tail\ud800']) assert.throws(() => encodeDocument(text, { encoding }), e => e.code === 'MP_ENCODING');
});
test('mixed EOL retains the existing majority policy; unsupported encoding cannot save', () => {
  const d = decodeDocument(Buffer.from('one\r\ntwo\nthree\r\n')); assert.equal(d.text, 'one\ntwo\nthree\n'); assert.equal(d.eol, '\r\n');
  assert.throws(() => encodeDocument('text', { encoding: 'utf32le' }), e => e.code === 'MP_ENCODING');
});
