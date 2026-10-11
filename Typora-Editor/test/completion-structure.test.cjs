const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseHeadings,sectionAt,StructureCache,LIMIT}=require('../extension-src/out/completion/structure.cjs');
const {settings}=require('../extension-src/out/completion/core.cjs');
const {CompletionManager}=require('../extension-src/out/completion/host.cjs');
test('ATX and Setext preserve skipped levels, literal math, CRLF and heading ancestry',()=>{
  const index=parseHeadings('\uFEFF# 教材\r\n\r\n## 连续时间\r\n\r\n#### HJB $V_x$ ###\r\n\r\n唯一公式 $x=$\r\n\r\n离散时间\r\n===\r\n\r\n结论\r\n---\r\n');
  assert.deepEqual(index.headings.map(h=>[h.title,h.parent]),[['教材',-1],['连续时间',0],['HJB $V_x$',1],['离散时间',-1],['结论',3]]);
  const context=sectionAt(index,index.text.indexOf('唯一公式'));
  assert.match(context,/PARENT # 教材\nPARENT ## 连续时间\nCURRENT #### HJB \$V_x\$/);
  assert.match(context,/NEXT # 离散时间/);
});
test('Front matter, comments, raw HTML, fenced code, math and indented code do not become headings',()=>{
  const source=['---','# YAML','---','# Real','```md','<!--','<pre>','# Code','```','$$','# Math','$$','<!--','# Comment','-->','<pre>','# HTML','</pre>','    # Indented','> # Quoted','- # List','## End'].join('\n');
  assert.deepEqual(parseHeadings(source).headings.map(h=>h.title),['Real','End']);
});
test('Code fence length and marker match; horizontal rules never become headings',()=>{
  const index=parseHeadings('---\nfront matter\n...\n\n---\n\n# Good\n\n````md\n```\n# Not a title\n~~~~\n````\n\n## Last\n');
  assert.deepEqual(index.headings.map(h=>h.title),['Good','Last']);
  assert.deepEqual(parseHeadings('plain paragraph\nsecond line\n===\n').headings.map(h=>h.title),['plain paragraph second line']);
});
test('Large outlines send bounded ancestors and neighbors, not an entire TOC',()=>{
  const text='# Book\n'+Array.from({length:5000},(_,i)=>'## Section '+i+' '+ '长'.repeat(200)+'\nbody '+i+'\n').join('');
  const index=parseHeadings(text),excerpt=sectionAt(index,index.text.indexOf('body 4500'));
  assert.ok(excerpt.length<=LIMIT);assert.match(excerpt,/CURRENT ## Section 4500/);assert.ok(!excerpt.includes('Section 1 '));
});
test('Index is built once at open, reused for unchanged versions and refreshed after edit/undo',()=>{
  let text='# Old\n\nunique equation $x=$\n',reads=0;
  const doc={version:1,getText:()=>{reads++;return text;}},cache=new StructureCache(doc),request={needle:'unique equation $x=$',caret:20};
  assert.equal(reads,1);assert.match(cache.forRequest(doc,request),/Old/);assert.match(cache.forRequest(doc,request),/Old/);assert.equal(reads,1);
  text=text.replace('Old','New');doc.version++;assert.match(cache.forRequest(doc,request),/New/);assert.equal(reads,2);
  text=text.replace('New','Old');doc.version++;assert.match(cache.forRequest(doc,request),/Old/);cache.dispose();assert.equal(cache.index,null);
});
test('Ambiguous, missing or invalid source positions omit structure rather than guess',()=>{
  const doc={version:1,getText:()=> '# First\n\nsame $x=$\n\n# Second\n\nsame $x=$\n'},cache=new StructureCache(doc);
  for(const request of [{needle:'same $x=$',caret:5},{needle:'missing',caret:0},{needle:'',caret:0},{needle:'First',caret:99}])assert.equal(cache.forRequest(doc,request),'');
});
function hostFixture(t,config={}) {
  const values=new Map([['completionSettings',settings({ai:true,baseUrl:'http://127.0.0.1:65500',model:'fixture',...config})]]),events=[],handlers=new Map();
  const platform={commands:{registerCommand:()=>({dispose(){}})},CancellationTokenSource:class{constructor(){this.token={};}cancel(){this.token.isCancellationRequested=true;}dispose(){}}};
  const manager=new CompletionManager({subscriptions:[],globalState:{get:key=>values.get(key),update:async(key,value)=>values.set(key,value)},secrets:{get:async()=>undefined}},platform);
  let text='# Parent A\n\n## Repeated\n\nunique $x=$\n',reads=0,dispose;
  const doc={version:1,getText:()=>{reads++;return text;}};
  manager.bind(doc,{onDidChangeViewState(){},onDidDispose(fn){dispose=fn;}},{on:(name,fn)=>handlers.set(name,fn),emit:(name,value)=>events.push({name,value})},()=>assert.fail('AI must not edit the document'));
  t.after(()=>dispose());
  const request=id=>handlers.get('completion-request')({id,kind:'ai',version:doc.version,needle:'unique $x=$',caret:10,aiContext:{before:'unique $x=',after:'$',kind:'math',mathBefore:'x=',mathAfter:''}});
  return{manager,events,request,reads:()=>reads,edit:value=>{text=value;doc.version++;}};
}
test('Opening calls no API; heading changes invalidate a repeated local completion cache',async t=>{
  let calls=0;const bodies=[];t.mock.method(global,'fetch',async(_url,options)=>{calls++;bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({content:[{type:'text',text:'1'}]}));});
  const f=hostFixture(t);await f.manager.ready;assert.equal(calls,0);assert.equal(f.reads(),1);
  await f.request(1);await f.request(2);assert.equal(calls,1);assert.match(bodies[0].messages[0].content,/<document_structure>\nPARENT # Parent A\nCURRENT ## Repeated/);
  f.edit('# Parent B\n\n## Repeated\n\nunique $x=$\n');await f.request(3);assert.equal(calls,2);assert.match(bodies[1].messages[0].content,/PARENT # Parent B/);
  await f.manager.update({...f.manager.config,sectionContext:false});await f.request(4);assert.equal(calls,3);assert.ok(!bodies[2].messages[0].content.includes('<document_structure>'));
});
test('Disabled section context avoids priming; missing API keys and network failures leave local completion enabled',async t=>{
  const f=hostFixture(t,{sectionContext:false});assert.equal(f.reads(),0);
  t.mock.method(global,'fetch',async()=>{throw new TypeError('offline');});await f.manager.ready;
  await f.request(1);assert.match(f.events.at(-1).value.error,/无法连接/);assert.equal(f.manager.config.local,true);
  // 已知平台（这里是 DeepSeek 的 Anthropic 兼容端点）没填密钥时给出可操作的提示；
  // 本机/自建地址允许不带密钥，所以这里不再依赖“内置预设表”。
  await f.manager.update({...f.manager.config,protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'});
  await f.request(2);assert.match(f.events.at(-1).value.error,/API Key/);assert.equal(f.manager.config.local,true);
});
test('HTTP errors and malformed responses remain bounded errors without editing or disabling local completion',async t=>{
  const f=hostFixture(t);await f.manager.ready;
  for(const status of [401,429,503]){
    t.mock.method(global,'fetch',async()=>new Response('untrusted response details',{status}));
    await f.request(status);assert.match(f.events.at(-1).value.error,new RegExp('HTTP '+status));assert.equal(f.manager.config.local,true);
  }
  t.mock.method(global,'fetch',async()=>new Response('invalid JSON'));await f.request(10);assert.match(f.events.at(-1).value.error,/JSON/);
});
