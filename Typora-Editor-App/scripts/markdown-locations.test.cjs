const {test}=require('node:test'),assert=require('node:assert/strict');
require('../../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');
const modulePromise=import('../../Typora-Editor/extension-src/render/js/markdown-locations.js');
test('large-file coarse locations retain semantic block and unit boundaries',async()=>{
  const source='## Title\n\n> first\n> second **bold**\n\n| A | B |\n| - | - |\n| escaped \\| pipe | $\\frac{x}{y}$ |\n\nplain &amp; 中文🙂\n\n~~~js\nconst n=2;\n~~~\n';
  const {markdownLocations}=await modulePromise,tree=JSON.parse(global.Lute.New().RenderJSON(source)),precise=markdownLocations(source,tree),coarse=markdownLocations(source,tree,{coarse:true});
  const boundaries=items=>items.map(b=>({kind:b.kind,start:b.start,end:b.end,units:b.units.map(u=>({kind:u.kind,text:u.text,start:u.start,end:u.end}))}));
  assert.deepEqual(boundaries(coarse),boundaries(precise));assert.ok(coarse.every(b=>b.units.every(u=>u.positions.length<=2)));
});
async function locations(source){const {markdownLocations}=await modulePromise;return markdownLocations(source,JSON.parse(global.Lute.New().RenderJSON(source)));}
test('duplicate paragraphs and cells keep their own source positions',async()=>{
  const source='same\n\nsame\n\n| same | same |\n| --- | --- |\n| same |  |\n';
  const blocks=await locations(source),starts=blocks.filter(b=>b.units[0]?.text==='same').map(b=>b.units[0].start);
  assert.deepEqual(starts,[...source.matchAll(/same/g)].map(m=>m.index));
  const empty=blocks.at(-1);assert.equal(empty.kind,'cell');assert.equal(empty.start,source.indexOf('|  |')+3);assert.equal(empty.end,empty.start);
});
test('reference definitions do not consume the following footnote definition or HTML',async()=>{
  const source='A [link][r] and note[^n].\n\n[r]: https://example.org\n\n[^n]: footBody\n\n<div>htmlTarget</div>\n\nendTarget\n';
  const blocks=await locations(source);
  for(const text of ['link','footBody','endTarget']){
    const unit=blocks.flatMap(b=>b.units).find(u=>u.text===text||u.text.includes(text));assert.equal(unit.start+unit.text.indexOf(text),source.indexOf(text));
  }
  assert.equal(blocks.find(b=>b.kind==='html').start,source.indexOf('<div>'));
  assert.equal(blocks.at(-1).units[0].text,'footBody');
});
test('quote prefixes and nested list indentation stay outside the text location',async()=>{
  const source='> first\n> second\n>\n> - list\n>   - nested\n';
  const units=(await locations(source)).flatMap(b=>b.units);
  for(const text of ['first','second','list','nested'])assert.equal(units.find(u=>u.text===text).start,source.indexOf(text));
});
test('math locations distinguish delimiters, repeated symbols and each fraction',async()=>{
  const source='plain $a+a$ and $\\frac{a}{b}$\n\n$$\n\\int a\,da\n$$\n';
  const units=(await locations(source)).flatMap(b=>b.units).filter(u=>u.kind==='math');
  assert.equal(units.length,3);
  for(const unit of units)assert.equal(source.slice(unit.start,unit.end),unit.text);
});
test('escaped entities and backslashes map displayed characters to source syntax',async()=>{
  const source='a &amp; \\*literal\\* **bold** `code`\n';
  const units=(await locations(source)).flatMap(b=>b.units);
  for(const text of ['literal','bold','code'])assert.equal(units.find(u=>u.text===text).start,source.indexOf(text));
  assert.equal(units.find(u=>u.text==='&').start,source.indexOf('&amp;'));
});
test('fenced and indented code lines retain exact offsets',async()=>{
  const source='```js\nconst first=1;\nconst second=2;\n```\n\n    indented\n    nextLine\n';
  const units=(await locations(source)).flatMap(b=>b.units);
  for(const needle of ['first','second','indented','nextLine']){
    const unit=units.find(u=>u.text.includes(needle));assert.equal(unit.positions[unit.text.indexOf(needle)],source.indexOf(needle));
  }
});
test('table cell boundaries respect escaped pipes',async()=>{
  const {tableCells}=await modulePromise,line='| a\\|b | `x` | |';
  assert.deepEqual(tableCells(line).map(r=>line.slice(r.start,r.end)),['a\\|b','`x`','']);
});
test('setext headings do not shift following paragraphs',async()=>{
  const source='Title\n=====\n\nbody\n';const blocks=await locations(source);
  assert.equal(blocks[0].kind,'heading');assert.equal(blocks[1].units[0].start,source.indexOf('body'));
});
test('Unicode offsets use the same UTF-16 units as DOM selections',async()=>{
  const source='中文🙂 **组合e\u0301** 后文\n';const units=(await locations(source)).flatMap(b=>b.units);
  assert.equal(units.find(u=>u.text==='组合e\u0301').start,source.indexOf('组合'));
});
