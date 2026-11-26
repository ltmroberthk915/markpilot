import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, planDocumentInsertion } from '../lib/documents-service.js';
import { createMarkdownToolDefinition } from '../lib/index.js';

const insert = (text, args) => {
  const change = planDocumentInsertion(text, args);
  assert.equal(change.from, change.to);
  return applyChanges(text, [change]);
};

test('heading insertion keeps children, code examples, prefix, next heading and disk separators', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const chapter = ['  ## 附录 H：业务', '原文', '### 子节', '```md', '## 附录 H', '```', '子节尾', ''].join(eol);
    const head = '\uFEFF# 手册' + eol;
    const tail = '## 下一节' + eol + '旧正文';
    const args = { heading: '附录 H', position: 'after', newString: '## 附录 I\n新文' };
    assert.equal(insert(head + chapter + tail, args), head + chapter + '## 附录 I' + eol + '新文' + eol + eol + tail);
    assert.equal(insert(head + chapter.slice(0, -eol.length), args), head + chapter + eol + '## 附录 I' + eol + '新文');
  }
});

test('literal anchors insert on either side, repeats (including overlaps) and missing anchors cannot write', () => {
  const args = { position: 'before', anchorText: '- 甲\n- 乙', newString: '- 新\n' };
  assert.equal(insert('清单\r\n- 甲\r\n- 乙', args), '清单\r\n- 新\r\n- 甲\r\n- 乙');
  assert.equal(insert('甲乙', { position: 'after', anchorText: '甲', newString: '新' }), '甲新乙');
  assert.equal(insert('a\r\nb', { position: 'before', anchorText: '\nb', newString: '!' }), 'a!\r\nb');
  assert.equal(insert('\ufeff甲', { position: 'start', newString: '新' }), '\ufeff新甲');
  assert.equal(insert('', { position: 'end', newString: '新' }), '新');
  assert.throws(() => insert('aaa', { ...args, anchorText: 'aa' }), { code: 'MP_INSERT_AMBIGUOUS' });
  assert.throws(() => insert('甲', args), { code: 'MP_INSERT_NOT_FOUND' });
  assert.throws(() => insert('## H\n## H', { heading: 'H', position: 'after', newString: 'X' }), { code: 'MP_INSERT_AMBIGUOUS' });
  assert.equal(insert('## H\n## H extension', { heading: 'H', position: 'after', newString: 'X' }), '## H\nX\n\n## H extension');
});

test('only document-level headings delimit sections, including Setext headings after metadata', () => {
  const head = ['---', 'title: ignored', '---', '', 'G', '===', '', '<pre>', '# X', '</pre>',
    '', '- list', '  # X', '', '> # X', '', 'G last line', ''].join('\r\n');
  const doc = head + '# N\r\ntail';
  assert.equal(insert(doc, { position: 'after', heading: 'G', newString: '# H' }), head + '# H\r\n\r\n# N\r\ntail');
  for (const name of ['X', 'title: ignored']) {
    assert.throws(() => insert(doc, { position: 'before', heading: name, newString: 'new' }), { code: 'MP_INSERT_NOT_FOUND' });
  }
});

test('insert cannot smuggle replacement offsets and has a structured per-operation receipt', async () => {
  const def = createMarkdownToolDefinition(() => { throw new Error('invalid input must not dispatch'); });
  const r = await def.execute({ action: 'insert', path: 'a.md', position: 'end', fromLine: 1, newString: 'x' });
  assert.equal(r.error.code, 'MP_INSERT_INVALID');
  const value = { ok: true, action: 'insert', displayPath: 'A.md', groupId: 'id' };
  assert.deepEqual(def.output.presentationMeta({}, value).markPilotInsert, { path: 'A.md', groupId: 'id' });
});
