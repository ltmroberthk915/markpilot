const {test}=require('node:test'),assert=require('node:assert/strict');
require('../.backups/2026-09-08-release100/lute-before-source-entities.min.js');const original=global.Lute.New();
require('../../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');const lute=global.Lute.New();
const modes=[['Md2VditorIRDOM','VditorIRDOM2Md','SpinVditorIRDOM'],['Md2VditorDOM','VditorDOM2Md','SpinVditorDOM']];
const body='first &amp; &lt; &#124; &#x1F642; &amp;amp; &unknown; &amp <br /> 1 < 2 & 3 > 0\n';
for(const language of ['','html','tex','math','mermaid','plantuml','echarts','mindmap','abc','js'])for(const [render,back,spin]of modes)test(render+' '+(language||'plain')+' preserves literal entities across repeated source serialization',()=>{
  const source='```'+language+'\n'+body+'```\n';let dom=lute[render](source);
  assert.equal(dom,original[render](source),'rendered initial DOM stays unchanged');
  for(let i=0;i<3;i++){assert.equal(lute[back](dom),source);dom=lute[spin](dom);}
  assert.equal(lute.Md2HTML(source),original.Md2HTML(source));
});
for(const [name,source]of [['math-block','$$\n\\text{\\&amp; \\&lt; \\&#124;}\n$$\n'],['html-block','<div data-note="&amp;">literal &lt; &#124; &amp;amp;</div>\n'],['inline-neighbors','前 `&amp; &lt;` 与 $a &amp; b$ 后\n'],['table-neighbors','| A | B |\n| - | - |\n| 首格<br />第二行 | `&amp;` 与 $a &amp; b$ |\n']])test(name+' keeps exact source on both visual DOM conversions',()=>{
  for(const [render,back,spin]of modes){const baseline=lute[back](lute[render](source));if(name!=='table-neighbors')assert.equal(baseline,source);else assert.ok(baseline.includes('`&amp;` 与 $a &amp; b$'));assert.equal(lute[back](lute[spin](lute[render](baseline))),baseline);}
});
