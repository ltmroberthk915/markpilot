'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'../../..');
const code=fs.readFileSync(path.join(ROOT,'dsh-markpilot/renderer/vendor/katex/katex-sourcemap.js'),'utf8');
function renderer(){const ctx=vm.createContext({console:{warn(){},log(){}}});vm.runInContext(code,ctx,{timeout:2000});assert.equal(ctx.katex.version,'0.19.0');return ctx;}
const decode=s=>s.replace(/&#x([a-f0-9]+);/gi,(_,v)=>String.fromCodePoint(parseInt(v,16))).replace(/&#(\d+);/g,(_,v)=>String.fromCodePoint(+v)).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
function leaves(ctx,tex){ctx.tex=tex;const html=vm.runInContext('katex.renderToString(tex,{sourceMap:true,output:"html",trust:false,maxExpand:1000})',ctx,{timeout:2000}),rows=[];for(const m of html.matchAll(/<span\b([^>]*)>([^<>]+)<\/span>/g)){const a=/data-typora-source-start="(\d+)"/.exec(m[1]),b=/data-typora-source-end="(\d+)"/.exec(m[1]);if(a&&b)rows.push({glyph:decode(m[2]),from:+a[1],to:+b[1],literal:tex.slice(+a[1],+b[1])});}return rows;}
function sourceSpans(ctx,tex,displayMode=true){
  ctx.tex=tex;
  const html=vm.runInContext('katex.renderToString(tex,{sourceMap:true,output:"html",trust:false,maxExpand:1000,displayMode:'+displayMode+'})',ctx,{timeout:2000});
  const token=/<span\b([^>]*)>|<\/span>|[^<]+/g;let m,stack=[],nodes=[];
  while((m=token.exec(html))){
    if(m[0]==='</span>'){stack.pop();continue;}
    if(m[0][0]==='<'){
      const attrs=m[1]||'',cls=/class="([^"]*)"/.exec(attrs),a=/data-typora-source-start="(\d+)"/.exec(attrs),b=/data-typora-source-end="(\d+)"/.exec(attrs);
      const parent=stack.length?stack[stack.length-1]:null,node={classes:cls?decode(cls[1]):'',from:a?+a[1]:null,to:b?+b[1]:null,direct:'',children:[],parent};
      if(parent)parent.children.push(node);nodes.push(node);stack.push(node);continue;
    }
    if(stack.length)stack[stack.length-1].direct+=decode(m[0]);
  }
  const text=n=>n.direct+n.children.map(text).join('');
  for(const n of nodes)n.text=text(n);
  return{nodes};
}
const marked=(nodes,tex,literal)=>nodes.filter(n=>n.from!=null&&tex.slice(n.from,n.to)===literal);
const ownerOf=node=>{for(let n=node.parent;n;n=n.parent)if(n.from!=null)return n;return null;};
for(const [tex,glyph,literal] of [
 ['\\omega+x','ω','\\omega'],['\\frac{a}{b}','a','a'],['\\frac{a}{b}','b','b'],['\\sqrt{x}','x','x'],['x^{y}','y','y'],
 ['x₂²','2','₂'],['x₂²','2','²'],['\\text{---}','—','---'],["x''",'′',"'"],
 ['\\def\\foo{a}\\foo','a','\\foo'],['\\def\\swap#1#2{#2#1}\\swap{a}{b}','a','a'],['\\def\\swap#1#2{#2#1}\\swap{a}{b}','b','b'],
])test('literal UTF-16 mapping: '+tex+' → '+glyph+' from '+literal,()=>{const rows=leaves(renderer(),tex);assert(rows.some(r=>r.glyph===glyph&&r.literal===literal),JSON.stringify(rows));for(const r of rows)assert(r.from>=0&&r.to<=tex.length&&r.from<=r.to);});
test('edef expansion output respects the same finite budget',()=>{const c=renderer();c.tex=String.raw`\edef0{x}\edef0{00}\edef0{00}\edef0{00}\edef0{00}`;assert.throws(()=>vm.runInContext('katex.renderToString(tex,{maxExpand:10,sourceMap:true})',c,{timeout:2000}),/Too many expansions/);});
test('recursive Unicode subparse cannot reset the expansion budget',()=>{const c=renderer();c.tex=String.raw`\def0{x₀} x₀`;assert.throws(()=>vm.runInContext('katex.renderToString(tex,{maxExpand:10,sourceMap:true})',c,{timeout:2000}),/Too many expansions/);});
test('htmlData rejects invalid attribute names even with explicit trust',()=>{const c=renderer();c.tex=String.raw`\htmlData{x" onmouseover=alert(1)}{a}`;assert.throws(()=>vm.runInContext('katex.renderToString(tex,{trust:true,sourceMap:true})',c,{timeout:2000}),/Invalid|invalid/);});
test('inherited settings cannot enable JavaScript links',()=>{const c=renderer();c.tex=String.raw`\href{javascript:alert(1)}{X}`;const html=vm.runInContext('Object.prototype.trust=true;katex.renderToString(tex,{})',c,{timeout:2000});assert(!/href=/.test(html));});
test('finite policy preserves ordinary macros and Unicode',()=>{const rows=leaves(renderer(),String.raw`\def\foo{a}\foo+x₂²`);assert(rows.some(r=>r.literal==='\\foo')&&rows.some(r=>r.literal==='₂'));});
test('identical primes and swapped macro argument glyphs retain every distinct literal occurrence',()=>{
 const primes=leaves(renderer(),"x''").filter(r=>r.glyph==='′');assert.deepEqual(primes.map(r=>[r.from,r.to]),[[1,2],[2,3]]);
 const tex=String.raw`\def\swap#1#2{#2#1}\swap{x}{x}`;
 const xs=leaves(renderer(),tex).filter(r=>r.glyph==='x');
 // The two literal arguments are at UTF-16 offsets 25 and 28; visual order is reversed.
 assert.equal(tex.slice(25,26),'x');assert.equal(tex.slice(28,29),'x');
 assert.deepEqual(xs.map(r=>[r.from,r.to]),[[28,29],[25,26]]);
});
test('\\boxed keeps each display \\sum range on its own operator container',()=>{
 const tex=String.raw`\boxed{\sum_i x+\sum_j y}`,{nodes}=sourceSpans(renderer(),tex);
 assert.deepEqual(marked(nodes,tex,'\\sum').map(n=>[n.from,n.to]),[[7,11],[16,20]]);
 const boxed=marked(nodes,tex,'\\boxed');assert(boxed.length>0);assert(boxed.every(n=>n.from===0&&n.to===6));
 const glyphs=nodes.filter(n=>n.classes.split(' ').includes('op-symbol')&&n.text.trim()==='∑');
 assert.equal(glyphs.length,2);
 for(const glyph of glyphs){
  assert.equal(glyph.from,null,'display \\sum glyph has no own mapping');
  const owner=ownerOf(glyph);assert(owner);
  assert.equal(tex.slice(owner.from,owner.to),'\\sum');
  assert(owner.classes.split(' ').includes('mop'));
 }
});
test('unboxed repeated display \\sum ranges stay distinct',()=>{
 const tex=String.raw`\sum_i x+\sum_j y`,{nodes}=sourceSpans(renderer(),tex);
 assert.deepEqual(marked(nodes,tex,'\\sum').map(n=>[n.from,n.to]),[[0,4],[9,13]]);
 const glyphs=nodes.filter(n=>n.classes.split(' ').includes('op-symbol')&&n.text.trim()==='∑');
 assert.equal(glyphs.length,2);
 for(const glyph of glyphs)assert.equal(ownerOf(glyph).classes.split(' ').includes('mop'),true);
});
test('inline and bare \\sum keep their own mapping',()=>{
 for(const [tex,display] of [[String.raw`\sum_i`,false],[String.raw`\sum`,true]]){
  const {nodes}=sourceSpans(renderer(),tex,display);
  const glyphs=nodes.filter(n=>n.classes.split(' ').includes('op-symbol')&&n.text.trim()==='∑');
  assert.equal(glyphs.length,1,tex);
  assert.equal(glyphs[0].from,0,tex);assert.equal(glyphs[0].to,4,tex);
 }
});
