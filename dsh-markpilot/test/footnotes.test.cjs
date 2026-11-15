'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectFootnotes, isFootnoteOpaque, isFootnoteTailOpaque, hasStructuralChars, resolveBackTarget,
} = require('../src-cm6/footnotes.cjs');

/* 与产品同一个 @lezer/markdown（dsh-markpilot/node_modules），配置与
   @codemirror/lang-markdown 的 markdownLanguage 一致（GFM + Subscript/Superscript/Emoji）。
   candidate 本身不导入 parser；测试只把 parser 本体作为可选第二参传入。 */
const { parser, GFM, Subscript, Superscript, Emoji } = require('@lezer/markdown');
const codeParser = parser.configure([GFM, Subscript, Superscript, Emoji]);

const slices = (text, ranges) => ranges.map(range => text.slice(range.from, range.to));
const counts = index => ({
  refs: index.refs.length,
  resolved: index.refs.filter(ref => ref.resolved).length,
  backs: index.notes.reduce((sum, note) => sum + note.refs.length, 0),
});
function codeRangesOf(md) {
  const ranges = [];
  codeParser.parse(md).iterate({
    enter(ref) {
      if (ref.name === 'InlineCode' || ref.name === 'CodeBlock') {
        ranges.push({ from: ref.from, to: ref.to, kind: ref.name });
        return false;
      }
      return undefined;
    },
  });
  return ranges;
}

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

/* ───────────── 2026-11-14 literal-foot：跨行 InlineCode / 4 空格 CodeBlock ───────────── */

const CROSS_LINE = 'start `abc\ninside [^demo] end`\n\nnormal [^demo]\n\n[^demo]: note\n';
const INDENT_CODE = '    literal [^demo]\n\nnormal [^demo]\n\n[^demo]: note\n';
const CONTROL = 'normal [^demo]\n\n[^demo]: note\n';

test('literal-foot: parser code ranges exclude cross-line InlineCode and 4-space CodeBlock', () => {
  for (const md of [CROSS_LINE, INDENT_CODE]) {
    const result = collectFootnotes(md, codeParser.parse(md));
    assert.deepEqual(counts(result), { refs: 1, resolved: 1, backs: 1 });
    assert.deepEqual(slices(md, result.refs), ['[^demo]']);
    assert.deepEqual(result.notes.map(note => [note.label, note.text]), [['demo', 'note']]);
  }
  const control = collectFootnotes(CONTROL, codeParser.parse(CONTROL));
  assert.deepEqual(counts(control), { refs: 1, resolved: 1, backs: 1 });
});

test('literal-foot: real parser nodes are InlineCode(6..30) / CodeBlock(4..19) and five input forms agree', () => {
  assert.deepEqual(codeRangesOf(CROSS_LINE), [{ from: 6, to: 30, kind: 'InlineCode' }]);
  assert.deepEqual(codeRangesOf(INDENT_CODE), [{ from: 4, to: 19, kind: 'CodeBlock' }]);
  const ranges = codeRangesOf(CROSS_LINE);
  const tree = codeParser.parse(CROSS_LINE);
  const forms = [
    ['tree', tree],
    ['ranges', ranges],
    ['analyzePublic-like {code}', { code: ranges }],
    ['{tree}', { tree }],
    ['{parser}', { parser: codeParser }],
  ];
  for (const [name, input] of forms) {
    assert.deepEqual(counts(collectFootnotes(CROSS_LINE, input)), { refs: 1, resolved: 1, backs: 1 }, name);
  }
});

test('literal-foot: definition inside cross-line InlineCode is not a definition', () => {
  const md = 'start `abc\n[^demo]: fake\nend`\n\nnormal [^demo]\n\n[^demo]: real\n';
  const result = collectFootnotes(md, codeParser.parse(md));
  assert.deepEqual(result.notes.map(note => [note.label, note.text]), [['demo', 'real']]);
  assert.deepEqual(counts(result), { refs: 1, resolved: 1, backs: 1 });
});

test('literal-foot: 4-space definition continuation is not CodeBlock; an indented code block is opaque', () => {
  const cont = '正文[^a]\n\n[^a]: note\n    续行 [^inner]\n\n后文[^a]\n';
  // CommonMark 把 `[^a]: note` 当 LinkReference，紧随 4 空格行算 CodeBlock；
  // 脚注文法里它是定义续行 ⇒ candidate 把这类 CodeBlock 从 opaque 剔除。
  assert.equal(codeRangesOf(cont).filter(range => range.kind === 'CodeBlock').length, 1, 'raw parser sees CodeBlock');
  const contResult = collectFootnotes(cont, codeParser.parse(cont));
  assert.deepEqual(contResult.refs.map(ref => ref.label), ['a', 'a']);
  assert.equal(contResult.notes[0].text, 'note\n续行 [^inner]');
  assert.equal(isFootnoteOpaque(cont, cont.indexOf('续行'), codeParser), false);

  const code = '正文[^a]\n\n    [^b]\n\n后文[^a]\n\n[^a]: A\n';
  assert.equal(codeRangesOf(code).filter(range => range.kind === 'CodeBlock').length, 1);
  const codeResult = collectFootnotes(code, codeParser.parse(code));
  assert.deepEqual(codeResult.refs.map(ref => ref.label), ['a', 'a']);
  assert.equal(isFootnoteOpaque(code, code.indexOf('[^b]'), codeParser), true);

  // 引用区里的缩进代码紧跟定义：第一行不是 4 空格续行 ⇒ 不能当定义续行剔除。
  const quoted = '正文[^a]\n\n[^a]: note\n>     [^b]\n\n[^b]: B\n';
  const quotedResult = collectFootnotes(quoted, codeParser.parse(quoted));
  assert.deepEqual(quotedResult.refs.map(ref => ref.label), ['a']);
  assert.equal(isFootnoteOpaque(quoted, quoted.indexOf('[^b]'), codeParser), true);
});

test('literal-foot: rangeAt ordered premise — earlier link-def destination cannot be missed after a later fence', () => {
  const md = [
    '[x]: https://e/<!--',
    '',
    'real [^demo]',
    '',
    '-->',
    '',
    '```',
    'code',
    '```',
    '',
    '[^demo]: note',
    '',
  ].join('\n');
  assert.deepEqual(collectFootnotes(md).refs.map(ref => ref.label), ['demo']);
  assert.deepEqual(collectFootnotes(md, codeParser).refs.map(ref => ref.label), ['demo']);
});

test('literal-foot: no "[^" fast path never builds a parse tree', () => {
  const throwingParser = { parse() { throw new Error('parser must not run'); } };
  assert.deepEqual(collectFootnotes('普通段落 `code` 与 $$x$$，没有脚注\n', throwingParser), { refs: [], notes: [] });
});

test('literal-foot: isFootnoteOpaque / isFootnoteTailOpaque accept the same parser input', () => {
  const crossPos = CROSS_LINE.indexOf('[^demo]');
  assert.equal(isFootnoteOpaque(CROSS_LINE, crossPos, codeParser), true);
  assert.equal(isFootnoteOpaque(CROSS_LINE, CROSS_LINE.lastIndexOf('[^demo]'), codeParser), false);
  assert.equal(isFootnoteOpaque(INDENT_CODE, INDENT_CODE.indexOf('[^demo]'), codeParser), true);
  const indentReal = INDENT_CODE.indexOf('[^demo]', INDENT_CODE.indexOf('normal'));
  assert.equal(isFootnoteOpaque(INDENT_CODE, indentReal, codeParser), false);
  assert.equal(isFootnoteTailOpaque('```\ncode\n', codeParser), true);
  assert.equal(isFootnoteTailOpaque('```\ncode\n```\n', codeParser), false);
});

