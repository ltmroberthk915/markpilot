'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parse}=require('node:module').createRequire(path.join(__dirname,'../package.json'))('acorn');
const extras=fs.readFileSync(path.resolve(__dirname,'../../../dsh-markpilot/src-cm6/extras.js'),'utf8');
const body=parse(extras,{ecmaVersion:'latest',sourceType:'module'}).body.find(node=>node.declaration?.id?.name==='installExtras').declaration.body.body;
const decl=name=>{const n=body.find(n=>n.id?.name===name||n.declarations?.some(d=>d.id.name===name));assert(n,name);return extras.slice(n.start,n.end);};
const mark=Function('getView',decl('sourceFlavor')+'\nreturn '+decl('markNativeSource'))(()=>({contentDOM:{contains:target=>target==='master'}}));
function event(kind,types=['text/plain']){
  const data=new Map(types.map(type=>[type,type==='text/plain'?'left\tright':'<table></table>']));
  return {type:kind,target:'master',defaultPrevented:true,isTrusted:true,clipboardData:{
    get types(){return [...data.keys()];},setData:(k,v)=>data.set(k,v),getData:k=>data.get(k)||''
  }};
}
test('trusted handled copy and cut mark the native plain source while preserving the text',()=>{
  for(const kind of ['copy','cut']){
    const e=event(kind);mark(e);
    assert.equal(e.clipboardData.getData('text/plain'),'left\tright');
    assert.equal(e.clipboardData.getData('application/x-markpilot-markdown'),'1');
  }
});
test('an identical external text, an unhandled event and a rich representation are never relabeled',()=>{
  const unrelated=event('copy');unrelated.target='other';
  const unhandled=event('cut');unhandled.defaultPrevented=false;
  const synthetic=event('copy');synthetic.isTrusted=false;
  const rich=event('copy',['text/plain','text/html']);
  for(const e of [unrelated,unhandled,synthetic,rich]){
    mark(e);assert.equal(e.clipboardData.getData('application/x-markpilot-markdown'),'');
  }
  assert.equal(rich.clipboardData.getData('text/html'),'<table></table>');
});
test('host menu source writes retain complete escaped HTML only for ambiguous content',()=>{
  const payload=Function(decl('esc')+'\nreturn '+decl('sourceTextPayload'))();
  assert.deepEqual(payload('ordinary text'),{text:'ordinary text'});
  const text='a\t</pre><x>&\nb\t$x$';
  assert.deepEqual(payload(text),{text,html:'<pre data-markpilot-source="markdown">a\t&lt;/pre&gt;&lt;x&gt;&amp;\nb\t$x$</pre>'});
});
