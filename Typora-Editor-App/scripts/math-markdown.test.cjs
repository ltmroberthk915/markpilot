const {test}=require('node:test'),assert=require('node:assert/strict');
require('../../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');
const modulePromise=import('../../Typora-Editor/extension-src/render/js/math-markdown.js');
const decode=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const formula=String.raw`\underbrace{\begin{array}{cc}a&b\\c&d\end{array}}_{n\times n}`;
for(const [label,input,expected] of [
  ['plain',`$$${formula}$$, body $x$\n`,formula],
  ['quote',`> $$${formula}$$，中文 $x$\n> next\n`,formula],
  ['nested quote',`> > $$${formula}$$; next $x$\n`,formula],
  ['list',`- $$${formula}$$, body $x$\n  next\n`,formula],
  ['quoted list',`> 1. $$${formula}$$, body $x$\n`,formula],
  ['separate closing',`> $$\n> ${formula}\n> $$, body $x$\n`,formula],
  ['body closing',`$$\n${formula}$$, body $x$\n`,formula],
  ['escaped dollar',String.raw`$$\text{price \$\$}+x$$, body $x$`+'\n',String.raw`\text{price \$\$}+x`],
])test(label+' closes formula before prose and preserves every TeX byte',async()=>{
  const {normalizeMathFences}=await modulePromise,normalized=normalizeMathFences(input),l=global.Lute.New();
  l.SetInlineMathAllowDigitAfterOpenMarker(true);
  const html=l.Md2VditorIRDOM(normalized),source=/<code data-type="math-block"[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1];
  assert.equal(decode(source),expected);assert.ok(html.includes('math-inline'));
  assert.ok(!source.includes('body')&&!source.includes('中文'));
  assert.equal(normalizeMathFences(normalized),normalized);
  const saved=l.VditorIRDOM2Md(html);assert.ok(saved.includes(expected));
});
for(const [label,md] of [
  ['canonical block','> $$\n> a+b\n> $$\n> body\n'],
  ['canonical single line','$$a+b$$\n'],
  ['inline code','`$$x$$, body`\n'],
  ['code fence','```tex\n$$x$$, body\n```\n'],
  ['quoted code fence','> ~~~tex\n> $$x$$, body\n> ~~~\n'],
  ['indented code','    $$x$$, body\n'],
  ['raw HTML','<pre>\n$$x$$, body\n</pre>\n'],
  ['HTML block','<div>\n$$x$$, body\n</div>\n'],
  ['custom HTML','<widget>\n$$x$$, body\n</widget>\n'],
  ['CDATA','<![CDATA[\n$$x$$, body\n]]>\n'],
  ['HTML comment','<!--\n$$x$$, body\n-->\n'],
  ['escaped opener',String.raw`\$\$x$$, body`],
  ['unfinished block','> $$\n> a+b\n'],
])test(label+' remains byte-identical',async()=>{
  const {normalizeMathFences}=await modulePromise;assert.equal(normalizeMathFences(md),md);
});
test('CRLF and paragraph punctuation survive normalization',async()=>{
  const {normalizeMathFences}=await modulePromise,s=normalizeMathFences('> $$x$$，正文\r\n> 下一行\r\n');
  assert.ok(s.includes('> ，正文\r\n> 下一行'));assert.ok(!s.replaceAll('\r\n','').includes('\n'));
});
test('library hook preserves ordinary input and source history while rendering table line breaks',async()=>{
  const {prepareMathMarkdown}=await modulePromise;
  const native=global.Lute.New(),target={Lute:global.Lute};prepareMathMarkdown(target);
  const wrapped=target.Lute.New(),md='> $$x$$, prose\n';
  assert.ok(!wrapped.Md2VditorIRDOM(md).match(/<code[^>]*>[^<]*prose/));
  assert.ok(wrapped.Md2VditorDOM(md).includes('<p data-block="0">, prose'));
  assert.equal(wrapped.VditorIRDOM2Md.toString(),native.VditorIRDOM2Md.toString());
  const prose=native.Md2VditorIRDOM('body $x+1$\n');
  assert.equal(wrapped.SpinVditorIRDOM(prose),native.SpinVditorIRDOM(prose));
  const table='| a | b |\n| - | - |\n| one<br />two | $x+1$ |\n';
  const rendered=wrapped.Md2VditorIRDOM(table);
  assert.ok(rendered.includes('one<br>two'));
  assert.ok(!rendered.includes('&lt;br'));
  const edited=wrapped.SpinVditorIRDOM(rendered.replace('one','changed'));
  assert.ok(edited.includes('<table')&&edited.includes('changed<br>two'));
  assert.ok(wrapped.VditorIRDOM2Md(edited).includes('changed<br />two'));
});
