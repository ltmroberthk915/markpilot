import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectMarkdownFile } from '../lib/markdown-inspection.js';
import codec from '../host/text-codec.js';

async function inspect(bytes, changed = false) {
  const target = { displayPath: 'fixture.md' };
  const signal = new AbortController().signal;
  let revision = 0;
  const provider = { async stat() { return { version: changed ? ++revision : 1, size: bytes.length }; }, async readBytes(file, cancellation, limit) {
    assert.equal(file, target); assert.equal(cancellation, signal); assert(limit >= bytes.length);
    return bytes;
  } };
  return inspectMarkdownFile(provider, target, signal, codec.decodeDocument);
}

test('inspect counts physical lines, mixed endings and top-level structure from strictly decoded disk bytes', async () => {
  const text = '## A\r\n|:---|---:|\n````js\r### hidden\n```\n````\n### B\n~~~\n\uFFFD';
  for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
    const bytes = Buffer.from(text, encoding === 'utf16be' ? 'utf16le' : encoding);
    if (encoding === 'utf16be') bytes.swap16();
    const prefix = {utf8: 'efbbbf', utf16le: 'fffe', utf16be: 'feff'}[encoding];
    const raw = Buffer.concat([Buffer.from(prefix, 'hex'), bytes]);
    assert.deepEqual(await inspect(raw), { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), encoding, bom: true, crlf: 1, lf: 6, cr: 1,
      lines: 9, endsWithNewline: false, replacementCharacters: 1, h2: 1, h3: 1, tableDelimiterRows: 1,
      fencesOpened: 2, fencesClosed: 1, unclosedFenceLine: 8 });
  }
  assert.equal((await inspect(Buffer.alloc(0))).lines, 0);
  assert.equal((await inspect(Buffer.from('a\n'))).lines, 1);
  await assert.rejects(inspect(Buffer.from([0xc3, 0x28])), { code: 'MP_ENCODING' });
  await assert.rejects(inspect(Buffer.from('changed'), true), { code: 'MP_DOC_STALE' });
});
