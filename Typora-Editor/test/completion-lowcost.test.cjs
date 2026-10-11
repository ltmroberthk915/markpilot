const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseHeadings,notationAt,StructureCache,LIMIT}=require('../extension-src/out/completion/structure.cjs');
const policy=import('../extension-src/render/js/completion-policy.mjs');

test('Relevant terminal definition comes from the same chapter and stays literal',()=>{
  const text='# Book\n## Previous\n终值 $r_T=G(x_T)$\n## Current\n定义终值收益 $\\Phi(x_T)$\n\n### Necessary condition\n> 终值条件 $r_T=$\n## Next\n终值 $r_T=H(x_T)$\n';
  const document={version:1,getText:()=>text},cache=new StructureCache(document);
  const request={needle:'> 终值条件 $r_T=$',caret:12,aiContext:{kind:'math',before:'> 终值条件 $r_T=',after:'$',mathBefore:'r_T=',mathAfter:''}};
  const result=cache.forRequest(document,request);assert.match(result,/定义终值收益 \$\\Phi\(x_T\)\$/);assert.ok(!result.includes('G(x_T)')&&!result.includes('H(x_T)'));assert.ok(result.length<=LIMIT);
  assert.ok(!cache.forRequest(document,{...request,aiContext:{kind:'prose'}}).includes('DEFINITIONS'));
  assert.equal(cache.forRequest(document,{...request,needle:'ambiguous'}),'');
});
test('Code, comments, front matter and already supplied definitions are not indexed as hints',()=>{
  const text='---\n终值 $r_T=Y$\n---\n# Book\n```tex\n终值 $r_T=C$\n```\n> ```tex\n> 终值 $r_T=Q$\n> ```\n<!--\n终值 $r_T=H$\n-->\n    终值 $r_T=I$\n定义 `终值 $r_T=J$`\n定义终值 $r_T=\\Phi(x_T)$\n现在 $r_T=$\n';
  const index=parseHeadings(text);assert.equal(index.definitions.length,1);
  assert.equal(notationAt(index,text.indexOf('现在')+7,{kind:'math',before:'定义终值 $r_T=\\Phi(x_T)$\n现在 $r_T=',mathBefore:'r_T='}), '');
});
test('Definition lookup is bounded, versioned and omits the current hole line',()=>{
  let text='# Book\n## Chapter\n'+Array.from({length:100},(_,i)=>'定义 $r_'+i+':=a_'+i+'$\n').join('')+'终值 $r_T=$\n';
  const doc={version:1,getText:()=>text},cache=new StructureCache(doc),req={needle:'终值 $r_T=$',caret:8,aiContext:{kind:'math',before:'终值 $r_T=',mathBefore:'r_T='}};
  const first=cache.forRequest(doc,req);assert.ok(first.length<=LIMIT);assert.ok(first.split('\n').filter(l=>l.startsWith('定义')).length<=2);assert.ok(!first.includes('终值 $r_T=$'));
  assert.equal(cache.builds,1);cache.forRequest(doc,req);assert.equal(cache.builds,1);
  text=text.replaceAll(':=a_',':=b_');doc.version++;assert.match(cache.forRequest(doc,req),/:=b_/);assert.equal(cache.builds,2);
});
test('Closing bold punctuation is deduplicated, while new spans, code and equations remain intact',async()=>{
  const {cleanSuggestion}=await policy;
  assert.equal(cleanSuggestion('边际价值.',{kind:'prose',before:'含义 **',after:'**.\n'}),'边际价值');
  assert.equal(cleanSuggestion('边际价值。',{kind:'prose',before:'含义 __',after:'__.\n'}),'边际价值');
  assert.equal(cleanSuggestion('保留.',{kind:'prose',before:'没有粗体',after:'**.\n'}),'保留.');
  assert.equal(cleanSuggestion('保留.',{kind:'prose',before:'\\** 转义',after:'**.\n'}),'保留.');
  assert.equal(cleanSuggestion('保留.',{kind:'prose',before:'字面 `**` 标记',after:'**.\n'}),'保留.');
  assert.equal(cleanSuggestion('保留.',{kind:'prose',before:'公式 $a**b$ 后',after:'**.\n'}),'保留.');
  assert.equal(cleanSuggestion('保留.',{kind:'prose',before:'foo__bar',after:'__.\n'}),'保留.');
  assert.equal(cleanSuggestion('保留.',{kind:'code',before:'const x=**',after:'**.\n'}),'保留.');
  assert.equal(cleanSuggestion('x.',{kind:'math',before:'$**',after:'**.\n',mathBefore:'',mathAfter:''}),'x.');
});
