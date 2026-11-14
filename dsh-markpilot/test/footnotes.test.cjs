'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectFootnotes, isFootnoteOpaque, hasStructuralChars, resolveBackTarget,
} = require('../src-cm6/footnotes.cjs');

const slices = (text, ranges) => ranges.map(range => text.slice(range.from, range.to));

test('basic: numbering follows first reference order, ids are ASCII-only', () => {
  const md = '甲[^b]乙[^a]丙[^b]\n\n[^a]: A 定义\n[^b]: B 定义\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['b', 'a', 'b']);
  assert.deepEqual(result.refs.map(ref => ref.number), [1, 2, 1]);
  assert.deepEqual(result.refs.map(ref => ref.refId), ['mp-fn-ref-1-1', 'mp-fn-ref-2-1', 'mp-fn-ref-1-2']);
  assert.deepEqual(result.notes.map(note => note.label), ['b', 'a']);
  assert.deepEqual(result.notes.map(note => note.noteId), ['mp-fn-note-1', 'mp-fn-note-2']);
  assert.equal(result.notes[0].refs.length, 2);
  assert.deepEqual(slices(md, result.refs), ['[^b]', '[^a]', '[^b]']);
  for (const ref of result.refs) assert.match(ref.refId, /^mp-fn-ref-[\d]+-[\d]+$/);
  for (const note of result.notes) assert.match(note.noteId, /^mp-fn-note-[\d]+$/);
});

test('labels: Chinese, numeric, duplicates and whitespace-safe slices', () => {
  const md = '一[^中文]二[^2]三[^中文]四[^a b]\n\n[^2]: 二\n[^中文]: 中文定义\n[^a b]: 带空格\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => [ref.label, ref.number, ref.occurrence]), [
    ['中文', 1, 1], ['2', 2, 1], ['中文', 1, 2], ['a b', 3, 1],
  ]);
  assert.deepEqual(result.notes.map(note => [note.label, note.text]), [
    ['中文', '中文定义'], ['2', '二'], ['a b', '带空格'],
  ]);
  assert.deepEqual(slices(md, result.refs), ['[^中文]', '[^2]', '[^中文]', '[^a b]']);
});

test('definitions: mid-document stay in place; marker/text ranges are exact', () => {
  const md = '正文[^x]\n\n中间定义：\n[^x]: 第一行\n    续行一\n    续行二\n\n后文[^x]\n';
  const result = collectFootnotes(md);
  const note = result.notes[0];
  assert.equal(md.slice(note.from, note.to), '[^x]: 第一行\n    续行一\n    续行二');
  assert.equal(md.slice(note.markerFrom, note.markerTo), '[^x]:');
  assert.equal(note.text, '第一行\n续行一\n续行二');
  assert.equal(note.referenced, true);
  assert.equal(result.refs[1].occurrence, 2);
});

test('missing definition: kept as raw text, unresolved, no live noteId', () => {
  const md = '有[^yes] 缺[^no]\n\n[^yes]: Y\n';
  const result = collectFootnotes(md);
  const missing = result.refs.find(ref => ref.label === 'no');
  assert.equal(missing.resolved, false);
  assert.equal(missing.noteId, null);
  assert.equal(missing.number, 0);
  assert.equal(missing.refId, 'mp-fn-ref-u-2');
  assert.equal(result.notes[0].refs.length, 1);
});

test('duplicate definition: first wins, second is plain text', () => {
  const md = 'x[^x]\n[^x]: first\n[^x]: second\n';
  const result = collectFootnotes(md);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].text, 'first');
});

test('nested refs inside any definition are not indexed or numbered', () => {
  const md = [
    '正文[^a]',
    '[^a]: 定义里写着 [^b]',
    '    续行里也有 [^c]',
    '[^b]: B',
    '[^c]: C',
  ].join('\n');
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['a']);
  assert.deepEqual(result.notes.map(note => [note.label, note.referenced]), [
    ['a', true], ['b', false], ['c', false],
  ]);
  // 定义正文原样保留；嵌套角标不变成活链接，也不参与编号
  assert.equal(result.notes[0].text, '定义里写着 [^b]\n续行里也有 [^c]');
});

test('duplicate definition body is kept as source and its nested refs are not indexed', () => {
  const md = 'x[^x]\n[^x]: first\n[^x]: second [^y]\n[^y]: Y\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['x']);
  assert.deepEqual(result.notes.map(note => [note.label, note.text]), [
    ['x', 'first'], ['y', 'Y'],
  ]);
  assert.equal(md.slice(md.indexOf('[^x]: second'), md.indexOf('[^x]: second') + '[^x]: second [^y]'.length), '[^x]: second [^y]');
});

test('two-space indented paragraph after a definition is not swallowed', () => {
  const md = '正文[^a]\n[^a]: 定义\n  这是下一段普通文字\n\n后文[^b]\n[^b]: B\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.notes.map(note => [note.label, note.text]), [['a', '定义'], ['b', 'B']]);
  assert.equal(result.notes[0].to, md.indexOf('\n', md.indexOf('[^a]:')));
  assert.deepEqual(result.refs.map(ref => ref.label), ['a', 'b']);
});

test('labels are case-sensitive', () => {
  const md = 'A[^a] B[^A]\n[^a]: lower\n[^A]: upper\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => [ref.label, ref.noteId]), [
    ['a', 'mp-fn-note-1'], ['A', 'mp-fn-note-2'],
  ]);
  assert.deepEqual(result.notes.map(note => note.label), ['a', 'A']);
});

test('unreferenced definition is numbered after referenced ones and flagged', () => {
  const md = '正文[^b]\n[^a]: unused\n[^b]: used\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.notes.map(note => [note.label, note.number, note.referenced]), [
    ['b', 1, true], ['a', 2, false],
  ]);
  assert.equal(result.notes[1].refs.length, 0);
  assert.equal(result.notes[1].noteId, 'mp-fn-note-2');
});

test('isolation: fenced code (plain and blockquote), inline code, escapes', () => {
  const md = [
    '正文[^a]',
    '```',
    '代码里[^b]',
    '[^c]: 代码里的定义',
    '```',
    '> ```',
    '> 引用代码[^d]',
    '> ```',
    '行内 `[^e]` 与 ``[^f] ``',
    '转义 \\[^g] 仍是字面',
    '',
    '[^a]: A',
    '[^b]: B',
    '[^c]: C',
    '[^d]: D',
  ].join('\n');
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['a']);
  assert.deepEqual(result.notes.map(note => note.label), ['a', 'b', 'c', 'd']);
  assert.equal(isFootnoteOpaque(md, md.indexOf('[^b]')), true);
  assert.equal(isFootnoteOpaque(md, md.indexOf('[^e]')), true);
  assert.equal(isFootnoteOpaque(md, md.indexOf('[^d]')), true);
});

test('isolation: inline math, display math and multi-line $$ blocks', () => {
  const md = [
    'A[^a] $x[^b]$ B $$y [^c] z$$',
    '$$',
    '[^d]',
    '$$',
    'C[^e]',
    '',
    '[^a]: A',
    '[^e]: E',
  ].join('\n');
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['a', 'e']);
  assert.deepEqual(result.notes.map(note => note.label), ['a', 'e']);
  for (const label of ['b', 'c', 'd']) {
    const pos = md.indexOf('[^' + label + ']');
    assert.equal(isFootnoteOpaque(md, pos), true, label);
  }
});

test('ordinary links are not damaged; footnote-like link syntax is skipped', () => {
  const md = [
    '[普通链接](https://example.com/a[^x]) 文字',
    '带标签 [^y](https://example.com) 与 [文本[^z]](https://example.com)',
    '',
    '[^x]: X',
    '[^y]: Y',
    '[^z]: Z',
    '[^q]: Q',
  ].join('\n');
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['z']);
  assert.deepEqual(result.notes.map(note => note.label), ['z', 'x', 'y', 'q']);
  assert.equal(md.includes('[普通链接](https://example.com/a[^x])'), true);
});

test('HTML comments and tags do not become footnote refs', () => {
  const md = 'A <!-- [^a] --> B <span data-x="[^b]">C</span>[^c]\n[^c]: C\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => ref.label), ['c']);
});

test('CRLF: offsets stay UTF-16 and exclude the line ending', () => {
  const md = 'A[^x]\r\n\r\n[^x]: 定义\r\n    续行\r\n';
  const result = collectFootnotes(md);
  assert.equal(md.slice(result.refs[0].from, result.refs[0].to), '[^x]');
  const note = result.notes[0];
  assert.equal(md.slice(note.from, note.to), '[^x]: 定义\r\n    续行');
  assert.equal(note.text, '定义\n续行');
});

test('long document without footnotes uses the no-scan fast path', () => {
  const md = ('段落 $x+y$ 与 [普通链接](https://example.com) 以及括号。\n').repeat(4000);
  const started = Date.now();
  const result = collectFootnotes(md);
  assert.deepEqual(result, { refs: [], notes: [] });
  assert.ok(Date.now() - started < 50, 'fast path should not scan a long document');
});

test('hasStructuralChars matches the incremental gate alphabet', () => {
  for (const ch of ['[', ']', '^', ':', '`', '$', '\\', '~', '(', ')', '<', '>', '\n', '\r']) {
    assert.equal(hasStructuralChars('a' + ch + 'b'), true, ch);
  }
  assert.equal(hasStructuralChars('普通段落，中文标点，34.5%'), false);
});

test('resolveBackTarget: label + mapped exact range wins over renumbered refId/noteId', () => {
  const before = '甲[^a]乙[^a]\n[^a]: A\n';
  const first = collectFootnotes(before);
  const second = first.refs[1];
  assert.equal(second.occurrence, 2);
  const oldNav = {
    label: 'a', noteId: first.notes[0].noteId, number: first.notes[0].number,
    refId: second.refId, refFrom: second.from, refTo: second.to, occurrence: 2,
  };

  // 在前文插入一个新脚注引用，再插入一个同标签引用：编号/refId 全部可能重排。
  const inserted = '新[^b]' + before;
  const shift = '新[^b]'.length;
  const after = collectFootnotes(inserted);
  const note = after.notes.find(item => item.label === 'a');
  const mappedNav = {
    ...oldNav,
    noteId: 'stale-note-id', refId: 'stale-ref-id',
    number: 99, refFrom: oldNav.refFrom + shift, refTo: oldNav.refTo + shift,
  };
  const resolved = resolveBackTarget(after, mappedNav, note);
  assert.equal(resolved.reason, null);
  assert.ok(resolved.target);
  assert.equal(inserted.slice(resolved.target.from, resolved.target.to), '[^a]');
  assert.equal(resolved.target.from, mappedNav.refFrom, 'must return to the second occurrence, not the first');
  assert.notEqual(resolved.target.from, after.refs.find(ref => ref.label === 'a').from);
});

test('resolveBackTarget: deleted original occurrence is not silently replaced by another', () => {
  const before = '甲[^a]乙[^a]\n[^a]: A\n';
  const first = collectFootnotes(before);
  const second = first.refs[1];
  const nav = { label: 'a', noteId: first.notes[0].noteId, refId: second.refId, refFrom: second.from, refTo: second.to };
  // 删掉第二处引用（保留第一处）
  const deleted = before.slice(0, second.from) + before.slice(second.to);
  const after = collectFootnotes(deleted);
  const note = after.notes.find(item => item.label === 'a');
  const mappedNav = { ...nav, refFrom: second.from, refTo: second.from };
  const resolved = resolveBackTarget(after, mappedNav, note);
  assert.equal(resolved.target, null);
  assert.equal(resolved.reason, 'target-gone');
});

test('resolveBackTarget: no state / other-note state falls back to the first reference explicitly', () => {
  const md = '甲[^a]乙[^a]\n[^a]: A\n[^b]: B\n';
  const result = collectFootnotes(md);
  const note = result.notes.find(item => item.label === 'a');
  assert.equal(resolveBackTarget(result, null, note).target.from, result.refs[0].from);
  const otherNav = { label: 'b', noteId: 'mp-fn-note-2', refFrom: 0, refTo: 0 };
  assert.equal(resolveBackTarget(result, otherNav, note).target.from, result.refs[0].from);
});

test('table refs: parser indexes them (export/numbering), editor projection owns the cell source', () => {
  const md = '| 列 |\n| --- |\n| 格内[^t] |\n\n[^t]: T\n';
  const result = collectFootnotes(md);
  assert.deepEqual(result.refs.map(ref => [ref.label, ref.resolved]), [['t', true]]);
  assert.equal(result.notes[0].text, 'T');
});

