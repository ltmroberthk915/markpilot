'use strict';
/* Explicit Markdown fence projection: recognition bytes, source/preview policy,
 * and the region identity/presentation contract. Run from the repository root:
 *   node --test tools/quality/tests/markdown-fence.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const local = name => pathToFileURL(path.join(root, 'dsh-markpilot/src-cm6', name)).href;
const cm = name => pathToFileURL(path.join(root, 'dsh-markpilot/node_modules/@codemirror', name, 'dist/index.js')).href;

test('only explicit markdown and md aliases opt in, case-insensitively', async () => {
  const { isMarkdownFence, markdownFenceAlias } = await import(local('markdown-fence.js'));
  for (const info of ['md', 'MD', 'Md', 'markdown', 'Markdown', 'MARKDOWN', 'markdown title=doc', 'md {.compact}']) {
    assert.equal(isMarkdownFence(info), true, info);
    assert(markdownFenceAlias(info));
  }
  // Everything else is an existing source block and must not change behavior.
  for (const info of ['', 'js', 'javascript', 'ts', 'python', 'text', 'mermaid', 'mdx',
    'gfm', 'commonmark', 'mdown', 'mkd', 'md.js']) {
    assert.equal(isMarkdownFence(info), false, info);
    assert.equal(markdownFenceAlias(info), null, info);
  }
});

test('closed markdown fences keep their exact body and container handling', async () => {
  const { Text } = await import(cm('state'));
  const { scanMarkdownFenceBlocks } = await import(local('markdown-fence.js'));
  const doc = [
    'P0',
    '',
    '```md',
    '# T',
    '',
    '- a',
    '```',
    '',
    'P1',
    '',
    '~~~Markdown',
    'tilde body',
    '~~~~',
    '',
    '> ```markdown',
    '> # Quoted',
    '> ```',
    '',
  ].join('\n');
  const blocks = scanMarkdownFenceBlocks(Text.of(doc.split('\n')));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].lang, 'md');
  assert.equal(blocks[0].src, '# T\n\n- a');
  assert.equal(blocks[1].lang, 'markdown');
  assert.equal(blocks[1].src, 'tilde body');
  assert.equal(blocks[2].src, '# Quoted');
});

test('four backticks can wrap ordinary triple fences without recursion', async () => {
  const { Text } = await import(cm('state'));
  const { scanMarkdownFenceBlocks, fragmentMermaidSources } = await import(local('markdown-fence.js'));
  const body = ['~~~js', 'const a = 1;', '~~~', '', '```mermaid', 'graph TD', 'A-->B', '```'].join('\n');
  const doc = ['P', '', '````markdown', body, '````', ''].join('\n');
  const blocks = scanMarkdownFenceBlocks(Text.of(doc.split('\n')));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].src, body);
  // Only the inner Mermaid block is handed to the diagram queue; the JS fence
  // stays a code block for the fragment renderer, and the Markdown wrapper is
  // never scanned again as a nested preview.
  assert.deepEqual(fragmentMermaidSources(blocks[0].src), ['graph TD\nA-->B']);
});

test('unclosed, bare and programming-language fences stay source blocks', async () => {
  const { Text } = await import(cm('state'));
  const { scanMarkdownFenceBlocks, isMarkdownFence } = await import(local('markdown-fence.js'));
  const cases = [
    ['```md\n# open\n', 0],
    ['```\n# bare\n```\n', 0],
    ['```js\n# code\n```\n', 0],
    ['```mermaid\ngraph TD\n```\n', 0],
    ['```Markdown\nclosed\n```\n', 1],
  ];
  for (const [doc, want] of cases) {
    assert.equal(scanMarkdownFenceBlocks(Text.of(doc.split('\n'))).length, want, doc);
  }
  assert.equal(isMarkdownFence('mermaid'), false);
});

test('all selection ranges must leave the block before the preview is used', async () => {
  const { selectionTouchesRegion } = await import(local('region-index.js'));
  const region = { from: 10, to: 20 };
  const ranges = [
    { from: 0, to: 3, head: 3, empty: false },
    { from: 14, to: 14, head: 14, empty: true },
    { from: 30, to: 31, head: 31, empty: false },
  ];
  assert.equal(ranges.some(range => selectionTouchesRegion(region, range)), true,
    'one inner caret keeps the source visible');
  const outside = [
    { from: 0, to: 3, head: 3, empty: false },
    { from: 20, to: 21, head: 21, empty: false },
    { from: 9, to: 10, head: 9, empty: false },
  ];
  assert.equal(outside.some(range => selectionTouchesRegion(region, range)), false,
    'half-open endpoints remain outside, as in the Mermaid projection');
});

test('the fragment renderer emits clickable source-line anchors only on request', async () => {
  const fs = require('node:fs');
  const extras = fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6/extras.js'), 'utf8');
  const cut = (text, start, end) => {
    const a = text.indexOf(start), b = text.indexOf(end, a);
    assert(a >= 0 && b > a, start);
    return text.slice(a, b);
  };
  const load = name => import(local(name));
  const [md, table, inf, foot, pub] = await Promise.all([
    load('markdown-context.js'), load('tables.js'), load('inline-format.js'),
    load('footnote-export.js'), load('public-markdown.js'),
  ]);
  const helper = new Function(cut(infSource(), 'function singleLineDisplayTex(', 'const inlineParser') + ';return singleLineDisplayTex;')();
  const keys = ['scanFenceLines', 'tableLead', 'quoteLead', 'isSeparatorBody', 'codeBody', 'hasUnescapedDollar',
    'singleLineDisplayTex', 'CHUNK_CHARS', 'MATH_TEX_MAX', 'inlineMd', 'isHrLine', 'esc',
    'activeFootnotes', 'footnoteExportPlan', 'publicMarkdown'];
  const ctx = { ...md, ...table, ...inf, singleLineDisplayTex: helper, CHUNK_CHARS: 65536, MATH_TEX_MAX: 32768,
    activeFootnotes: { plan: null }, footnoteExportPlan: foot.footnoteExportPlan, publicMarkdown: pub.publicMarkdown,
    inlineMd: s => inf.renderInline(s, { math: t => '<i>' + t + '</i>' }),
    isHrLine: s => /^---$/.test(s), esc: s => s.replaceAll('<', '&lt;') };
  const body = new Function(...keys, cut(extras, 'function* mdBodyChunks(', '  function mdToHtml') + ';return mdBodyChunks;')(...keys.map(k => ctx[k]));
  const doc = ['# H', '', 'para one', '| a | b |', '| --- | --- |', '| 1 | 2 |', '```mermaid', 'graph TD', '```', '', 'tail',
    '> ## Q', '> para q', '> | q | r |', '> | --- | --- |', '> | 1 | 2 |'].join('\n');
  const html = [...body(doc, { lineAnchors: true })].join('');
  assert.match(html, /<h1 data-mp-src-line="0">H<\/h1>/);
  assert.match(html, /<p data-mp-src-line="2">para one<\/p>/);
  assert.match(html, /<table data-mp-src-line="3"><thead><tr data-mp-src-line="3">/);
  assert.match(html, /<tr data-mp-src-line="5">/);
  assert.match(html, /<pre data-mp-src-line="6"><code>/);
  assert.match(html, /<p data-mp-src-line="10">tail<\/p>/);
  assert.match(html, /<blockquote data-mp-src-line="11">\s*<h2 data-mp-src-line="11">Q<\/h2>\s*<p data-mp-src-line="12">para q<\/p>/);
  assert.match(html, /<table data-mp-src-line="13"><thead><tr data-mp-src-line="13">/);
  assert.match(html, /<tr data-mp-src-line="15">/);
  const plain = [...body(doc, {})].join('');
  assert.equal(plain.includes('data-mp-src-line'), false, 'export callers keep byte-identical output');
  function infSource() { return fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6/inline-format.js'), 'utf8'); }
});

test('the region index keeps markdown identity across selection and edits only content revisions', async () => {
  const { EditorState, StateField } = await import(cm('state'));
  const { scanFencedBlocks } = await import(local('markdown-context.js'));
  const { scanMarkdownFenceBlocks } = await import(local('markdown-fence.js'));
  const { createRegionIndex } = await import(local('region-index.js'));
  const read = state => scanMarkdownFenceBlocks(state.doc, scanFencedBlocks(state.doc)).map(block => ({
    kind: 'markdown', form: block.char, from: block.from, to: block.to,
    data: block, sourceOwned: false, content: block.src, context: { key: 'md' },
  }));
  const source = StateField.define({ create: read, update: (value, tr) => tr.docChanged ? read(tr.state) : value });
  const index = createRegionIndex(state => state.field(source), [source]);
  const doc = 'P0\n\n```md\n# T\n```\n\nP1\n';
  let state = EditorState.create({ doc, extensions: [source, index] });
  const first = state.field(index).byKind.get('markdown')[0];
  assert(first);
  assert.equal(state.doc.toString(), doc);

  state = state.update({ selection: { anchor: first.from + 2 }, userEvent: 'select' }).state;
  assert.equal(state.field(index).byKind.get('markdown')[0].id, first.id);
  assert.equal(state.doc.toString(), doc, 'selection never rewrites the document');

  state = state.update({ changes: { from: first.from + 6, insert: '!' }, userEvent: 'input.type' }).state;
  const edited = state.field(index).byKind.get('markdown')[0];
  assert.equal(edited.id, first.id, 'the same fence keeps its mounted owner while its body changes');
  assert.equal(edited.revision, 1);
  assert(state.doc.sliceString(edited.from, edited.to).includes('!'));

  state = state.update({ selection: { anchor: state.doc.length }, userEvent: 'select' }).state;
  assert.equal(state.field(index).byKind.get('markdown')[0].id, first.id);
});
