'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const acorn = require('acorn');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6/main.js'), 'utf8');
const ast = acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
function declaration(name) {
  const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(node, name);
  return source.slice(node.start, node.end);
}
const paddingOf = Function(declaration('alignedCellPadding') + '; return alignedCellPadding;')();
const modules = Promise.all(['inline-format', 'cell-source-map'].map(name =>
  import(pathToFileURL(path.join(root, 'dsh-markpilot/src-cm6', name + '.js')).href)));

test('alignment bytes stay outside the editable body, including whitespace-only cells', () => {
  for (const left of ['', ' ', '\t  ']) {
    for (const right of ['', ' ', '\t   ', ' '.repeat(133)]) {
      for (const body of ['', 'abc', '汉字', '$P_t$', 'a  b']) {
        const text = left + body + right, padding = paddingOf(text);
        const shown = text.slice(padding.left.length, text.length - padding.right.length);
        assert.equal(shown, body);
        assert.equal(padding.left + shown + padding.right, text);
      }
    }
  }
});
test('active padding keeps spaces typed after the original body', () => {
  const padding = paddingOf('\t note \t   ');
  const next = '\t note  \t   ';
  assert.equal(paddingOf(next, padding), padding);
  assert.equal(next.slice(padding.left.length, next.length-padding.right.length), 'note ');
  assert.deepEqual(paddingOf('other', padding), {left:'',right:''});
});
test('rendered formatting carries parser offsets through code, escapes and line breaks', async () => {
  const [{renderInline}] = await modules;
  const tick=String.fromCharCode(96);
  const text = '**bold** then '+tick+'code'+tick+'<br>next $x_1$ end';
  const spans = [];
  const html = renderInline(text, {cellOffsets:true,
    code:(value,from)=>{spans.push(['code',value,from]);return value;},
    math:(value,display,span)=>{spans.push(['math',value,span.from]);return value;}
  });
  assert.ok(html.includes('data-mp-text-from="2"'));
  assert.ok(html.includes('data-mp-text-from="' + text.indexOf('next') + '"'));
  assert.deepEqual(spans,[['code','code',text.indexOf('code')],['math','x_1',text.indexOf('$x_1$')]]);
});
test('alignment boundaries use the same UTF-16 and escaped-pipe mapping as the source editor', async () => {
  const [,codec] = await modules;
  const raw = ' \t a\\|b😀 $x_1$' + ' '.repeat(75), mapped=codec.mappedCellSource(raw);
  const padding=paddingOf(mapped.text);
  const end=mapped.text.length-padding.right.length;
  for(let offset=padding.left.length;offset<=end;offset++) {
    const pos=codec.cellSourceOffset(mapped,offset);
    assert.equal(codec.cellTextOffset(mapped,pos),offset);
  }
  assert.equal(raw.slice(codec.cellSourceOffset(mapped,padding.left.length),codec.cellSourceOffset(mapped,end)),'a\\|b😀 $x_1$');
});
test('pointer gesture handoffs preserve a newer selection instead of reclaiming it', () => {
  for(const name of ['continueTableSelection','beginCellPointerSelection']) {
    const code=declaration(name);
    assert.match(code,/selection\.eq\(lastSelection\)/,name);
    assert.match(code,/lastSelection = (owner|inputView)\.state\.selection/,name);
  }
  assert.match(source,/!cell && event\.target\?\.closest\('\.mp-inline-float, \.mp-cm6-math, \.mp-cm6-math-block'\)/);
});

