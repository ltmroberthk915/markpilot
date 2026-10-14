'use strict';
// Import this helper into the PUBLIC export-source-workflows suite, then call
// await inlineExportCases(page, report). The actual configured mpExtras closure
// is exercised. No app, profile, product, selection or focus is mutated here.
const assert=require('node:assert/strict');
const fixtures=[
 {id:'angle-space-map',md:'![space](<folder/a b.png>)',map:[['folder/a b.png','assets/space.png']],images:[['assets/space.png','space']]},
 {id:'amp-src-alt',md:'![A&B](a&b.png)',images:[['a&b.png','A&B']]},
 {id:'raw-entity-map',md:'<img src="a&amp;b.png" alt="A&amp;B">',map:[['a&b.png','assets/raw.png']],images:[['assets/raw.png','A&B']]},
 {id:'sanitize-image-attrs-styles',md:'<img src="safe.png" alt="ok" onerror="boom()" onclick="bad()" style="position:fixed;z-index:999;zoom:120%;width:12px;height:2em;background:url(evil)" width="12" data-typora-align="left">',images:[['safe.png','ok']],sanitize:true},
 {id:'quotes-alt',md:'![He said "yes" & more](q.png)',images:[['q.png','He said "yes" & more']]},
 {id:'image-before-after-code',md:'![first](first.png) `![literal](fake.png)` ![last](last.png)',images:[['first.png','first'],['last.png','last']],code:['![literal](fake.png)'],order:['IMG','CODE','IMG']},
 {id:'leftmost-raw-and-markdown-atoms',md:'<img src="raw.png" alt="R"> ![M](md.png) `<img src="fake.png">`',images:[['raw.png','R'],['md.png','M']],code:['<img src="fake.png">'],order:['IMG','IMG','CODE']},
 {id:'code-literal-math-link-image-strong',md:'`$a$ [x](url) ![y](img.png) **bold**`',math:true,images:[],code:['$a$ [x](url) ![y](img.png) **bold**'],katex:0,links:0,strong:0},
 {id:'bold-wrapper-image',md:'**![bold](b.png)**',images:[['b.png','bold']],strong:1,strongImage:true},
 {id:'math-toggle-with-code',md:'$a+b$ `$x$`',math:true,images:[],code:['$x$'],katex:1,toggleMath:true},
 {id:'invalid-tex-fallback',md:'$\\frac{a$',math:true,images:[],katex:0,error:1},
 {id:'angle-parenthesized-url',md:'![parens](<folder/a(b) c.png>)',map:[['folder/a(b) c.png','assets/parens.png']],images:[['assets/parens.png','parens']],absentText:['c.png>)']},
 {id:'markdown-title-consumed',md:'![title](image.png "old title")',images:[['image.png','title']],absentText:['old title','")']},
 {id:'user-nul-token-collision',md:'\u0000M0\u0000 ![real](real.png) `literal`',images:[['real.png','real']],code:['literal'],userNul:true},
 {id:'malformed-literal',md:'![broken]( and <img src="unterminated',images:[],literal:'![broken]( and <img src="unterminated'},
 {id:'table-image-and-code-once',md:'| A | B |\n| --- | --- |\n| ![cell](cell.png) | `![literal](fake.png)` |',images:[['cell.png','cell']],code:['![literal](fake.png)'],table:1}
];
async function inlineExportCases(page,report){
 report.inlineExpectedCases=16;
 for(const f of fixtures){
  const c={id:'inline-export-'+f.id,status:'running',fixture:f};report.cases.push(c);
  try{
   const evaluate=f=>page.evaluate(f=>{
    if(typeof window.mpExtras?.mdToHtml!=='function')throw new Error('Actual mdToHtml unavailable');
    const html=window.mpExtras.mdToHtml(f.md,{math:!!f.math,srcMap:new Map(f.map||[])}),d=new DOMParser().parseFromString(html,'text/html');
    return {html,text:d.body.textContent,images:[...d.images].map(e=>({src:e.getAttribute('src'),alt:e.getAttribute('alt'),attributes:[...e.attributes].map(a=>[a.name,a.value]),style:e.getAttribute('style')})),code:[...d.querySelectorAll('code')].map(e=>e.textContent),katex:d.querySelectorAll('.katex').length,error:d.querySelectorAll('.katex-error').length,links:d.querySelectorAll('a').length,strong:d.querySelectorAll('strong').length,strongImage:!!d.querySelector('strong > img'),table:d.querySelectorAll('table').length,order:[...d.querySelectorAll('img,code')].map(e=>e.tagName)};
   },f);const actual=await evaluate(f);c.actual=actual;
   assert.deepEqual(actual.images.map(e=>[e.src,e.alt]),f.images,'source address and alt survive once');
   for(const key of ['code','katex','error','links','strong','strongImage','table','order'])if(key in f)assert.deepEqual(actual[key],f[key],key+' exact');
   if(f.error)assert(actual.text.includes('\\frac{a'),'invalid TeX stays visible in renderer fallback');
   if(f.toggleMath){c.mathFalse=await evaluate({...f,math:false});assert.equal(c.mathFalse.katex,0,'actual configured renderer honors math:false');assert.deepEqual(c.mathFalse.code,['a+b','$x$'],'math false retains legacy formula code and literal code atom');assert.deepEqual(c.mathFalse.images,[]);}
   for(const text of f.absentText||[])assert(!actual.text.includes(text),'URL/title tail fully consumed');
   if(f.literal)assert(actual.text.includes(f.literal),'malformed Markdown remains literal');
   if(f.sanitize){const im=actual.images[0];assert(im.attributes.every(([name])=>!/^on/i.test(name)),'event handlers absent');assert.equal(im.style,'zoom:120%; width:12px; height:2em','safe declarations preserved, injection declarations removed');assert(im.attributes.some(([name,value])=>name==='data-typora-align'&&value==='left'));}
   // HTML parsing replaces NUL characters with U+FFFD. Assert source-level NUL
   // survival in the returned HTML plus DOM replacement, never fake raw DOM NUL.
   if(f.userNul){assert(actual.html.includes('\u0000M0\u0000'),'user token retained verbatim before DOM parsing');assert(actual.text.includes('M0'),'user token not expanded into an atom');assert.equal(actual.images.length,1);}
   c.status='pass';
  }catch(e){c.status='fail';c.error=e.stack;console.log('FAIL '+c.id+': '+e.message);throw e;}
  console.log('PASS '+c.id);
 }
}
module.exports={inlineExportCases,fixtures};
