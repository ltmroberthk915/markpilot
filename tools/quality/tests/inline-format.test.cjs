'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const renderer=import('../../../dsh-markpilot/src-cm6/inline-format.js');

test('cell formats use balanced CommonMark/GFM projection with literal source preserved',async()=>{
  const {renderInline}=await renderer;
  for(const [source,html] of [
    ['**不采**，保留下标修正与开篇声明','<strong>不采</strong>，保留下标修正与开篇声明'],
    ['*斜体* <u>下划线</u> ~~删除线~~','<em>斜体</em> <u>下划线</u> <s>删除线</s>'],
    ['***粗斜***','<em><strong>粗斜</strong></em>'],
    ['**粗 *斜* 尾**','<strong>粗 <em>斜</em> 尾</strong>'],
    ['~~删 **粗**~~','<s>删 <strong>粗</strong></s>'],
    ['<u>线 *斜* </u>','<u>线 <em>斜</em> </u>'],
    ['**粗 <u>线</u>**','<strong>粗 <u>线</u></strong>'],
    ['甲**乙**丙','甲<strong>乙</strong>丙'],
    ['word_with_underscores','word_with_underscores'],
    ['\\*字\\*','*字*'],
    ['**未闭合 <u>未闭合','**未闭合 &lt;u&gt;未闭合'],
    ['<script>**粗**</script>','&lt;script&gt;<strong>粗</strong>&lt;/script&gt;'],
    ['<u onclick="bad()">字</u>','&lt;u onclick="bad()"&gt;字&lt;/u&gt;'],
    ['**粗**<br>~~删~~','<strong>粗</strong><br><s>删</s>'],
  ]) assert.equal(renderInline(source),html,source);
});

test('code, TeX and image source atoms are protected from text formatting',async()=>{
  const {renderInline}=await renderer;
  assert.equal(renderInline('`**粗** ~~删~~ <u>线</u> $x$`'),'<code>**粗** ~~删~~ &lt;u&gt;线&lt;/u&gt; $x$</code>');
  assert.equal(renderInline('``a ` **b**``'),'<code>a ` **b**</code>');
  assert.equal(renderInline('$x_i*y$ **$x_i$**',{math:tex=>'<math>'+tex+'</math>'}),'<math>x_i*y</math> <strong><math>x_i</math></strong>');
  assert.equal(renderInline('$bad_*tex$',{math:()=>null}),'$bad_*tex$');
  const seen=[];
  assert.equal(renderInline('**![*alt*](image_with_*_marks.png)**',{image:x=>{seen.push(x);return '<img>';}}),'<strong><img></strong>');
  assert.equal(seen[0].alt,'*alt*');assert.equal(seen[0].src,'image_with_*_marks.png');
  assert.equal(renderInline('$a<br>b$'),'$a<br>b$');
  assert.equal(renderInline('\\$x* y$'),'$x* y$');
});

test('cached source trees do not cache document-specific image or math HTML',async()=>{
  const {renderInline}=await renderer;
  const source='**![x](same.png)** $x$';
  for(const owner of ['first','second'])assert.equal(renderInline(source,{image:()=>'<img src="'+owner+'">',math:()=>'<math>'+owner+'</math>'}),'<strong><img src="'+owner+'"></strong> <math>'+owner+'</math>');
  assert.equal(renderInline('[**粗**](a?x=1&y=2)',{link:()=>'<a href="safe">'}),'<a href="safe"><strong>粗</strong></a>');
});

test('a source-style cell link preserves code, math and image projection inside its label',async()=>{
  const {renderInline}=await renderer;
  const options={math:tex=>'<math>'+tex+'</math>',image:()=>'<img>'};
  assert.equal(renderInline('[**标签** $z_i$ `literal_**` ![a](p.png)](#target)',options),'[<strong>标签</strong> <math>z_i</math> <code>literal_**</code> <img>](#target)');
  assert.equal(renderInline('[plain](a_b?x=1&y=2)',options),'[plain](a_b?x=1&amp;y=2)');
});
