'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'../../..');
const code=fs.readFileSync(path.join(ROOT,'dsh-markpilot/renderer/vendor/katex/katex-sourcemap.js'),'utf8');
function renderer(){const ctx=vm.createContext({console:{warn(){},log(){}}});vm.runInContext(code,ctx,{timeout:2000});assert.equal(ctx.katex.version,'0.19.0');return ctx;}
const decode=s=>s.replace(/&#x([a-f0-9]+);/gi,(_,v)=>String.fromCodePoint(parseInt(v,16))).replace(/&#(\d+);/g,(_,v)=>String.fromCodePoint(+v)).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
function leaves(ctx,tex){ctx.tex=tex;const html=vm.runInContext('katex.renderToString(tex,{sourceMap:true,output:"html",trust:false,maxExpand:1000})',ctx,{timeout:2000}),rows=[];for(const m of html.matchAll(/<span\b([^>]*)>([^<>]+)<\/span>/g)){const a=/data-typora-source-start="(\d+)"/.exec(m[1]),b=/data-typora-source-end="(\d+)"/.exec(m[1]);if(a&&b)rows.push({glyph:decode(m[2]),from:+a[1],to:+b[1],literal:tex.slice(+a[1],+b[1])});}return rows;}
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
