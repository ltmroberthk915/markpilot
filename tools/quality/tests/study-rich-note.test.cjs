'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const {parse} = require('node:module').createRequire(path.join(root, 'tools/quality/package.json'))('acorn');
const source = fs.readFileSync(path.join(root, 'dsh-markpilot/src-cm6/extras.js'), 'utf8');
const body = parse(source, {ecmaVersion:'latest',sourceType:'module'}).body
  .find(node => node.declaration?.id?.name === 'installExtras').declaration.body.body;
function declared(name) {
  const node = body.find(node => node.id?.name === name);
  assert(node, name);
  return source.slice(node.start, node.end);
}
const rowsToMdTable = Function('return ' + declared('rowsToMdTable'))();

test('caption of a copied table remains in source order before its cell values', () => {
  const table = {nodeType:1,tagName:'TABLE',matches:()=>true,
    caption:{childNodes:[{nodeType:3,nodeValue:'Measurement source'}]}};
  const convert = Function('tableRowsFromElement','rowsToMdTable','htmlInlineNodesToMd','clipboardStyle','HTML_BLOCKS',
    'return ' + declared('htmlRichToMd'))(
    node => { assert.equal(node,table); return [['Variable'],['Count']]; }, rowsToMdTable, nodes => Array.from(nodes, n => n.nodeValue || '').join(''), () => '', 'table'
  );
  assert.equal(convert({childNodes:[table]}), 'Measurement source\n\n| Variable |\n| --- |\n| Count |');
});

test('sparse pasted tables keep all cells and later wide rows without multiplying empty columns', () => {
  const rows = [['First'], Array.from({length:150}, (_,i) => 'C'+i),
    ...Array.from({length:170}, (_,i) => ['R'+i,''])];
  const source = rowsToMdTable(rows);
  assert(source.length < 16000);
  const lines = source.split('\n');
  assert.equal(lines.length, rows.length + 1);
  assert.equal(lines[0].split('|').length, 152);
  assert(lines[2].endsWith(' C149 |'));
  assert.equal(lines.at(-1), '| R169 |  |');
  assert.equal(rowsToMdTable([['A','B'],['one']]), '| A | B |\n| --- | --- |\n| one |  |');
});

// Run the real async insertion command with a controlled resource provider.
// The desktop HTML-only clipboard workflow covers DOM parsing and actual file storage.
async function pasteFixture({text = 'Preface ', sources = ['cid:x', 'data:image/png;base64,GOOD'], expire = false, alt = 'Diagram'} = {}) {
  const nodes = [text];
  for (const src of sources) {
    const img = {attrs:{src,alt:src==='cid:x'?alt:'Good'}, ownerDocument:{createElement:tag=>({tagName:tag.toUpperCase(),textContent:''})}, getAttribute(k){return this.attrs[k];},
      setAttribute(k,v){this.attrs[k]=v;}, replaceWith(s){nodes[nodes.indexOf(this)]=s;}};
    nodes.push(img);
  }
  const dom = {cloneNode(){return this;},querySelectorAll(){return nodes.filter(x=>typeof x!=='string');},
    querySelector(){return null;},get textContent(){return nodes.filter(x=>typeof x==='string').join('');}};
  const {codeSpanMarkers} = await import('../../../dsh-markpilot/src-cm6/inline-format.js');
  const htmlRichToMd = () => nodes.map(x=>{
    if(typeof x==='string')return x;
    if(x.tagName==='CODE'){const {open,close}=codeSpanMarkers(x.textContent);return open+x.textContent+close;}
    return '!['+x.attrs.alt+']('+x.attrs.src+')';
  }).join('');
  const view = {state:{doc:{toString:()=>''},selection:{ranges:[{}],main:{}}}};
  const commits = [], notices = [];
  let valid = true;
  const ticket = {current:()=>valid?{from:0,to:0,head:0}:null,commit:s=>{commits.push(s);return true;},cancel(){}};
  const f = Function('view','ticket','htmlRichToMd','read','toast',`
    let imageInsertionQueue=Promise.resolve();
    const getView=()=>view, reserveImageInsertion=()=>ticket, imageTargetError=()=>'', window={};
    const imageModeOf=()=>'inline', imageSource=src=>src, HTML_BLOCKS='table', Image=class{decode(){return Promise.resolve();}};
    const imageFileFromSource=read, prepareImageFileSource=async file=>({src:file,warning:''});
    const pasteTextAtRange=(_state,_range,text)=>text;
    return ${declared('pasteRichImages')};`)(view,ticket,htmlRichToMd,async src=>{
      if(expire)valid=false;
      if(src==='cid:x')throw Error('external attachment unavailable');
      return src;
    }, text=>notices.push(text));
  await f(view,{body:dom});
  return {commits,notices};
}
test('one unavailable image preserves alternative text and other contents in one current transaction', async () => {
  const {commits,notices} = await pasteFixture();
  assert.deepEqual(commits, ['Preface 【图片：Diagram】![Good](data:image/png;base64,GOOD)']);
  assert(notices.some(s=>s.includes('无法读取')));
  const dangerous='![alternate](other.png)';
  const recovered = (await pasteFixture({alt:dangerous})).commits[0];
  const {renderInline}=await import('../../../dsh-markpilot/src-cm6/inline-format.js');
  assert(renderInline(recovered,{image:()=>'<picture>'}).includes('<code>【图片：'+dangerous+'】</code>'));
  assert.deepEqual((await pasteFixture({expire:true})).commits, []);
  assert.deepEqual((await pasteFixture({text:'',sources:['cid:x']})).commits, []);
  assert.deepEqual((await pasteFixture({sources:['data:image/png;base64,GOOD']})).commits,
    ['Preface ![Good](data:image/png;base64,GOOD)']);
});
