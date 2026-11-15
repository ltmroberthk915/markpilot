// 永久回归（产品路径）：dsh-markpilot/test/public-markdown.test.mjs
// 运行（从 dsh-markpilot 根目录）：node --test test/public-markdown.test.mjs
// 被测文件：../src-cm6/public-markdown.js；产品 package.json 已是 type=module，
// node_modules 已有 @lezer/markdown，无需任何测试桩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePublic, commentRanges, publicMarkdown } from '../src-cm6/public-markdown.js';

test('range semantics: one contiguous range, end-exclusive, covers delimiters', () => {
  const source = 'a\n<!--\nb\n-->\nTAIL';
  const ranges = commentRanges(source);
  assert.equal(ranges.length, 1);
  assert.deepEqual({ ...ranges[0] }, { from: 2, to: 12, block: true, closed: true });
  assert.equal(source.slice(ranges[0].from, ranges[0].to), '<!--\nb\n-->');
});

test('range is read-only', () => {
  const ranges = commentRanges('a <!--x--> b');
  assert.equal(Object.isFrozen(ranges), true);
  assert.equal(Object.isFrozen(ranges[0]), true);
});

test('no comment: fast path returns the same text', () => {
  const source = '# plain\n\nno comments here';
  assert.equal(publicMarkdown(source), source);
  assert.equal(commentRanges(source).length, 0);
});

test('inline comment is removed; code and escape are preserved', () => {
  assert.equal(publicMarkdown('a <!--x--> b'), 'a  b');
  assert.equal(publicMarkdown('a*<!--x-->*b'), 'a* *b');
  const code = '```txt\n<!--x-->\n```';
  assert.equal(publicMarkdown(code), code);
  const inline = '`<!--x-->` and \\<!--y-->';
  assert.equal(publicMarkdown(inline), inline);
  const indented = '    <!--x-->\ntail';
  assert.equal(publicMarkdown(indented), indented);
});

test('cross-line inline code keeps <!-- literal', () => {
  const source = 'Before `line\ninside <!-- literal sample`\nTAIL';
  assert.equal(publicMarkdown(source), source);
});

test('math ranges are opaque (explicit and default)', () => {
  const source = 'a $x <!--y--> z$ b';
  assert.equal(publicMarkdown(source, { mathRanges: [{ from: 2, to: source.length - 2 }] }), source);
  assert.equal(publicMarkdown(source), source); // 默认保守扫描也识别紧贴 $…$
});

test('unclosed inline <!-- is literal; unclosed line-start block comment goes to EOF', () => {
  assert.equal(publicMarkdown('a <!-- secret'), 'a <!-- secret');
  assert.equal(publicMarkdown('<!--\nsecret'), '\n');
  const unclosed = commentRanges('<!--\nsecret');
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].block, true);
  assert.equal(unclosed[0].closed, false);
});

test('empty comment and HTMLBlock-inner comment are covered', () => {
  assert.equal(publicMarkdown('a <!----> b'), 'a  b');
  assert.equal(publicMarkdown('<div><!--x--></div>'), '<div></div>');
});

test('line-leading removal does not create 4-space indented code or new block syntax', () => {
  assert.equal(publicMarkdown('  <!--x-->  text'), '   text');
  assert.equal(publicMarkdown('<!--x-->    text'), '   text');
  assert.equal(publicMarkdown('<!--\nx\n-->    text'), '\n\n   text');
  assert.equal(publicMarkdown('<!--x--># h'), '\\# h');
  assert.equal(publicMarkdown('<!--x-->```js\ncode\n```'), '\\`\\`\\`js\ncode\n```');
  assert.equal(publicMarkdown('<!--x-->1. item'), '1\\. item');
  assert.equal(publicMarkdown('<!--x-->| a | b |'), '\\| a | b |');
  assert.equal(publicMarkdown('<!--x-->- - -'), '\\- - -');
  assert.equal(publicMarkdown('<!--x--># h', { mode: 'text' }), '# h');
});

test('text after a block comment close stays visible; normal next line is untouched', () => {
  assert.equal(publicMarkdown('<!--x-->tail'), 'tail');
  assert.equal(publicMarkdown('<!--x-->\n# h'), '\n# h');
  assert.equal(publicMarkdown('> <!--x-->  text'), '>   text');
});

test('front matter, table cell, link label and emphasis comments stay correct', () => {
  const front = '---\ntitle: <!--x-->\n---\n# H';
  assert.equal(publicMarkdown(front), front);
  assert.equal(publicMarkdown('| a <!--x--> b | c |\n| --- | --- |'), '| a  b | c |\n| --- | --- |');
  assert.equal(publicMarkdown('[a <!--x--> b](https://e)'), '[a  b](https://e)');
  assert.equal(publicMarkdown('*a <!--x--> b*'), '*a  b*');
  assert.equal(commentRanges(front).length, 0);
});

test('main four arms: CommentBlock close, same-line B, quote tail, raw attribute', () => {
  const arms = [
    {
      input: '<!-- Hide --> trailing public',
      expect: (out) => out.includes('trailing public') && !out.includes('<!-- Hide -->'),
    },
    {
      input: '<!-- A --> PUBLIC <!-- B --> tail',
      expect: (out) => out.includes('PUBLIC') && out.includes('tail') && !out.includes('<!--'),
    },
    {
      input: '> <!-- hidden\n> secret --> tail',
      expect: (out) => out === '>  tail',
    },
    {
      input: '<div title="<!-- attribute literal -->">shown <!-- hidden --></div>',
      expect: (out) => out === '<div title="<!-- attribute literal -->">shown </div>',
    },
  ];
  for (const arm of arms) {
    const ranges = commentRanges(arm.input);
    for (let i = 1; i < ranges.length; i++) {
      assert.ok(ranges[i - 1].to <= ranges[i].from, 'comment ranges overlap: ' + arm.input);
    }
    const out = publicMarkdown(arm.input);
    assert.ok(arm.expect(out), arm.input + ' => ' + JSON.stringify(out));
  }
});

test('raw HTML quoted attribute keeps <!-- literal', () => {
  const cases = [
    '<div title="<!-- x -->">hello</div>',
    "<div title='<!-- x -->'>hello</div>",
    '<div title="a <!-- b --> c">hello</div>',
    '<div\n  title="<!-- x -->"\n>hello</div>',
    'before <span title="<!-- x -->">inline</span> after',
    '<script>var x = "<!--";</script>',
  ];
  for (const text of cases) {
    assert.equal(commentRanges(text).length, 0, text);
    assert.equal(publicMarkdown(text), text, text);
  }
  const mixed = '<div title="<!-- attr -->"><!--secret--></div>';
  assert.equal(commentRanges(mixed).length, 1);
  assert.equal(mixed.slice(commentRanges(mixed)[0].from, commentRanges(mixed)[0].to), '<!--secret-->');
  assert.equal(publicMarkdown(mixed), '<div title="<!-- attr -->"></div>');

  const nested = '<div><script>var x = "<!--";</script><!--secret--></div>';
  assert.equal(commentRanges(nested).length, 1);
  assert.equal(nested.slice(commentRanges(nested)[0].from, commentRanges(nested)[0].to), '<!--secret-->');
  assert.equal(publicMarkdown(nested), '<div><script>var x = "<!--";</script></div>');

  const emptyInAttr = [
    '<div title="<!---->">hello</div>',
    '<span title="<!---->">x</span>',
    '<script>var x = "<!---->";</script>',
  ];
  for (const text of emptyInAttr) {
    assert.equal(commentRanges(text).length, 0, text);
    assert.equal(publicMarkdown(text), text, text);
  }
  assert.equal(publicMarkdown('a <!----> b'), 'a  b');

  const tagInterior = '<div <!--in-tag--> >shown</div>';
  assert.equal(commentRanges(tagInterior).length, 0);
  assert.equal(publicMarkdown(tagInterior), tagInterior);
  const unquotedAttr = '<div data-x=<!--in-tag-->>shown</div>';
  assert.equal(commentRanges(unquotedAttr).length, 0);
  assert.equal(publicMarkdown(unquotedAttr), unquotedAttr);

  const scriptTextInAttr = '<div title="<script>">shown <!--secret--></div>';
  assert.equal(commentRanges(scriptTextInAttr).length, 1);
  assert.equal(publicMarkdown(scriptTextInAttr), '<div title="<script>">shown </div>');
});

test('HTMLBlock comment keeps same-line visible tail', () => {
  assert.equal(publicMarkdown('<div><!--x-->tail</div>'), '<div>tail</div>');
  const r = commentRanges('<div><!--x-->tail</div>');
  assert.equal(r.length, 1);
  assert.equal('<div><!--x-->tail</div>'.slice(r[0].from, r[0].to), '<!--x-->');
});

test('table rows: full-doc commentRanges crop by source offsets; code literal unchanged', () => {
  const doc = '| a | c |\n| --- | --- |\n| b <!--x--> d | e |\n| `<!--keep-->` | f |';
  const lines = doc.split('\n');
  const rowIndex = 2;
  const rowStart = lines.slice(0, rowIndex).reduce((n, line) => n + line.length + 1, 0);
  const row = lines[rowIndex];

  const ranges = commentRanges(doc); // 原文坐标，不是公开快照坐标
  assert.equal(ranges.length, 1);
  assert.equal(doc.slice(ranges[0].from, ranges[0].to), '<!--x-->');
  assert.ok(ranges[0].from > rowStart && ranges[0].to < rowStart + row.length);

  // 表格分行：用全文 ranges 映射到本行局部坐标再裁，不在行片段上重新找注释。
  const local = { from: ranges[0].from - rowStart, to: ranges[0].to - rowStart };
  const cropped = row.slice(0, local.from) + row.slice(local.to);
  assert.equal(cropped, '| b  d | e |');

  const pub = publicMarkdown(doc);
  assert.equal(pub.includes('<!--x-->'), false);
  assert.ok(pub.includes('`<!--keep-->`'));
  assert.equal(pub.split('\n').length, lines.length);

  const codeRow = lines[3];
  assert.equal(publicMarkdown(codeRow), codeRow);
});

test('R1: table structure/pipes preserved; cross-cell comment is literal per GFM cell parsing', () => {
  const pipes = (text) => (text.match(/(?<!\\)\|/g) || []).length;

  // 表头注释跨到数据行：GFM 按行/格解析，行内未闭合注释不是 Comment；公开原文与表结构原样。
  const cross = '| a | <!-- c\n| --- | --- |\n| d --> | b |';
  assert.equal(commentRanges(cross).length, 0);
  assert.equal(publicMarkdown(cross), cross);
  assert.deepEqual(cross.split('\n').map(pipes), [2, 3, 3]);
  assert.deepEqual(publicMarkdown(cross).split('\n').map(pipes), [2, 3, 3]);

  // 同一格内的闭合注释：删注释但不删格/行，列数与源表一致，不塌成空表。
  const cell = '| a | <!-- c --> |\n| --- | --- |\n| d | e |';
  assert.equal(analyzePublic(cell).tables.length, 1);
  const cellOut = publicMarkdown(cell);
  assert.equal(cellOut, '| a |  |\n| --- | --- |\n| d | e |');
  assert.deepEqual(cellOut.split('\n').map(pipes), [3, 3, 3]);
  assert.ok(cellOut.includes('| d | e |'));

  // 表头整格只有注释、但下面还有数据行：只丢注释，不删表/列，仍不是空表。
  const headCell = '| <!-- c --> |\n| --- |\n| d |';
  const headOut = publicMarkdown(headCell);
  assert.equal(headOut, '|  |\n| --- |\n| d |');
  assert.deepEqual(headOut.split('\n').map(pipes), [2, 2, 2]);
  assert.ok(headOut.includes('| d |'));

  // 注释里出现未转义管道会把 GFM 格切开 ⇒ 不是 Comment；不得为了“删注释”改列数。
  const pipeTable = '| a | <!-- x | y --> b |\n| --- | --- | --- |\n| d | e | f |';
  assert.equal(commentRanges(pipeTable).length, 0);
  assert.equal(publicMarkdown(pipeTable), pipeTable);
  assert.deepEqual(pipeTable.split('\n').map(pipes), [4, 4, 4]);

  // 表格 cell 内的行内代码：代码字面保护优先。
  const codeCell = '| `<!-- keep -->` | b |\n| --- | --- |';
  assert.equal(commentRanges(codeCell).length, 0);
  assert.equal(publicMarkdown(codeCell), codeCell);

  // 注释自身成块且位于表头/分隔行之间：保留空行，不能把两段拼成一张新表。
  const gap = '| a | b |\n<!-- c -->\n| --- | --- |';
  assert.equal(publicMarkdown(gap), '| a | b |\n\n| --- | --- |');
});

test('CommentBlock same-line continuation: later comments do not leak', () => {
  const live = '<!-- A --> PUBLIC <!-- B --> tail';
  const ranges = commentRanges(live);
  assert.equal(ranges.length, 2);
  assert.equal(live.slice(ranges[0].from, ranges[0].to), '<!-- A -->');
  assert.equal(live.slice(ranges[1].from, ranges[1].to), '<!-- B -->');
  const out = publicMarkdown(live);
  assert.equal(out.includes('<!--'), false);
  assert.ok(out.includes('PUBLIC'));
  assert.ok(out.includes('tail'));

  const adjacent = '<!--A--><!--B-->tail';
  assert.equal(commentRanges(adjacent).length, 2);
  assert.equal(publicMarkdown(adjacent), 'tail');

  const code = '<!-- A --> `<!-- B -->` tail';
  assert.equal(commentRanges(code).length, 1);
  const codeOut = publicMarkdown(code);
  assert.ok(codeOut.includes('`<!-- B -->`'));
  assert.equal(codeOut.includes('<!-- A -->'), false);

  // 剩余片段里的未闭合 `<!--B` 必须保持行内字面，不能把后面的已闭合 C 一起吞掉。
  const openThenClosed = '<!--A--><!--B unclosed <!--C--> tail';
  const ocRanges = commentRanges(openThenClosed);
  assert.equal(ocRanges.length, 2);
  assert.equal(openThenClosed.slice(ocRanges[0].from, ocRanges[0].to), '<!--A-->');
  assert.equal(openThenClosed.slice(ocRanges[1].from, ocRanges[1].to), '<!--C-->');
  const ocOut = publicMarkdown(openThenClosed);
  assert.ok(ocOut.includes('<!--B unclosed'));
  assert.equal(ocOut.includes('<!--C-->'), false);
});

test('single-$ \\begin formula across lines protects comments', () => {
  const multi = '$\\begin{aligned}\na <!-- x --> b \\\\\nc\n\\end{aligned}$';
  assert.equal(commentRanges(multi).length, 0);
  assert.equal(publicMarkdown(multi), multi);
  // 显式给空 mathRanges = 调用方声明"这里没有数学"；此时同一字面必须被识别为注释，
  // 用来证明上面的 0 是数学区间保护，而不是 parser 根本没看见它。
  assert.equal(commentRanges(multi, { mathRanges: [] }).length, 1);

  const same = '$\\begin{cases} a <!--x--> b \\end{cases}$';
  assert.equal(commentRanges(same).length, 0);
  assert.equal(publicMarkdown(same), same);
  assert.equal(commentRanges(same, { mathRanges: [] }).length, 1);

  const after = '$\\begin{cases} a \\end{cases}$ <!--secret--> tail';
  const rs = commentRanges(after);
  assert.equal(rs.length, 1);
  assert.equal(after.slice(rs[0].from, rs[0].to), '<!--secret-->');
  const out = publicMarkdown(after);
  assert.equal(out.includes('<!--secret-->'), false);
  assert.ok(out.includes('tail'));

  const aborted = '$\\begin{aligned}\n\ntext <!--secret-->\n$';
  const out2 = publicMarkdown(aborted);
  assert.ok(out2.includes('text'));
  assert.equal(out2.includes('<!--secret-->'), false);
});

test('R4: math opaque covers $$ block, single-$ begin and explicit source ranges', () => {
  const block = '$$\na <!-- hidden --> b\n$$';
  assert.equal(commentRanges(block).length, 0);
  assert.equal(publicMarkdown(block), block);

  // #55 单 `$` 跨行块：尾行以 `$` 闭合，块内注释属于 TeX 源，不得删除。
  const single = '$\\begin{pmatrix}\na \\\\ b\n\\end{pmatrix} <!-- SECRET -->$';
  assert.equal(commentRanges(single).length, 0);
  assert.equal(publicMarkdown(single), single);
  assert.equal(commentRanges(single, { mathRanges: [] }).length, 1);

  const explicit = 'a <!-- x --> b';
  assert.equal(commentRanges(explicit, {
    mathRanges: [{ from: 0, to: explicit.length }],
  }).length, 0);

  const aborted = '$\\begin{aligned}\n\ntext <!--secret-->\n$';
  assert.equal(publicMarkdown(aborted).includes('<!--secret-->'), false);
});

test('inline multi-line comment does not split a paragraph; block comment keeps newlines', () => {
  assert.equal(publicMarkdown('a <!--\nb\n--> c'), 'a  c');
  assert.equal(publicMarkdown('a\n<!--\nb\n--> c'), 'a\n\n\n c');
});

test('CRLF is preserved outside comments', () => {
  assert.equal(publicMarkdown('a<!--x-->\r\nb'), 'a\r\nb');
});

test('analyzePublic returns code ranges for the editor guard', () => {
  const source = 'Before `line\ninside <!-- literal sample`\nTAIL';
  const analysis = analyzePublic(source);
  assert.equal(analysis.comments.length, 0);
  assert.equal(analysis.code.length, 1);
  assert.equal(source.slice(analysis.code[0].from, analysis.code[0].to), '`line\ninside <!-- literal sample`');
});
