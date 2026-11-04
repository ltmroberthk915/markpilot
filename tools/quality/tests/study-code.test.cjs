'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..'),project=path.join(root,'dsh-markpilot'),engine=path.join(project,'src-cm6');
const moduleAt=file=>import(pathToFileURL(file).href);
const inline=moduleAt(path.join(engine,'inline-format.js')),toolbar=moduleAt(path.join(engine,'toolbar.js'));
const cm=moduleAt(path.join(project,'node_modules/@codemirror/state/dist/index.js')),commands=moduleAt(path.join(project,'node_modules/@codemirror/commands/dist/index.js'));
const tick=String.fromCharCode(96);
async function viewFor(doc,anchor,head){
  const {EditorState,Transaction}=await cm,{history}=await commands;
  const view={state:EditorState.create({doc,selection:{anchor,head},extensions:[history()]}),focus(){}};
  view.dispatch=tr=>{view.state=tr instanceof Transaction?tr.state:view.state.update(tr).state;};
  return view;
}
function element(tag,attributes={},...children) {
  const childNodes=children.map(child=>typeof child==='string'?{nodeType:3,nodeValue:child,get textContent(){return child;}}:child);
  const classes=(attributes.class||'').split(' ').filter(Boolean);
  classes.contains=name=>classes.includes(name);
  return {nodeType:1,tagName:tag,childNodes,children:childNodes.filter(c=>c.nodeType===1),classList:classes,
    get textContent(){return this.childNodes.map(n=>n.textContent).join('');},getAttribute(key){return attributes[key]??null;},
    matches(selector){return selector.toUpperCase().split(',').includes(tag);},
    querySelector(selector){return this.children.find(c=>c.matches(selector)||c.querySelector(selector))||null;}};
}
async function rich(node) {
  const src=fs.readFileSync(path.join(engine,'extras.js'),'utf8');
  const start=src.indexOf('  function clipboardCodeText'),end=src.indexOf('  function tableRowsFromElement',start);
  assert(start>=0&&end>start);
  const {clipboardFormula,clipboardStyle,serializeClipboardRuns}=await moduleAt(path.join(engine,'rich-clipboard.js'));
  return new Function('codeSpanMarkers','clipboardFormula','clipboardStyle','serializeClipboardRuns','node',src.slice(start,end)+'\nreturn htmlRichToMd(node);')((await inline).codeSpanMarkers,clipboardFormula,clipboardStyle,serializeClipboardRuns,node);
}
test('a reverse code command with internal ticks preserves the next line and the literal caret',async()=>{
  const {wrap}=await toolbar,{undo,redo}=await commands,{renderInline}=await inline;
  const lit='map('+tick+'id'+tick+')',doc=lit+'\nTAIL',expected=tick.repeat(2)+lit+tick.repeat(2);
  const view=await viewFor(doc,lit.length,0),prior=global.window;
  try {
    global.window={};wrap(view,tick);
    assert.equal(view.state.doc.toString(),expected+'\nTAIL');assert.equal(view.state.selection.main.head,2);assert.equal(renderInline(expected),'<code>'+lit+'</code>');
    assert(undo(view));assert.equal(view.state.doc.toString(),doc);assert.deepEqual([view.state.selection.main.anchor,view.state.selection.main.head],[lit.length,0]);
    assert(redo(view));assert.equal(view.state.doc.toString(),expected+'\nTAIL');
    view.dispatch({selection:{anchor:expected.length,head:0}});wrap(view,tick);assert.equal(view.state.doc.toString(),doc);assert.deepEqual([view.state.selection.main.anchor,view.state.selection.main.head],[lit.length,0]);
  } finally {if(prior===undefined)delete global.window;else global.window=prior;}
});
test('HTML inline code preserves internal ticks, literal break tags, edge padding and inner spacing',async()=>{
  const {renderInline}=await inline;
  for(const lit of [tick+'edge','x'+tick,' lead  and tail ','   ','a'+tick+'  b','<br>']){
    const code=await rich(element('BODY',{},element('P',{},element('CODE',{},lit))));
    assert.equal(renderInline(code),'<code>'+lit.replaceAll('<','&lt;').replaceAll('>','&gt;')+'</code>',lit);
  }
  assert.equal(renderInline(tick+'<br>'+tick+'<br>after'),'<code>&lt;br&gt;</code><br>after');
});
test('a preformatted rich fragment retains br-delimited code rows and their indentation',async()=>{
  const data=element('BODY',{},element('PRE',{},element('CODE',{class:'language-js'},
    element('SPAN',{},'if (ok)'),element('BR'), '  run()',element('BR'), '// '+tick.repeat(3))));
  assert.equal(await rich(data),tick.repeat(4)+'js\nif (ok)\n  run()\n// '+tick.repeat(3)+'\n'+tick.repeat(4));
});
test('rich link labels retain literal brackets within formatting while inline code stays opaque',async()=>{
  const {renderInline}=await inline;
  const data=element('BODY',{},element('P',{},element('A',{href:'https://example.test/ref'},
    element('STRONG',{},'A]B'), ' ',element('CODE',{},'item]'))));
  const md=await rich(data);
  assert.equal(renderInline(md,{link:href=>'<a href="'+href+'">'}),'<a href="https://example.test/ref"><strong>A]B</strong> <code>item]</code></a>');
});


test('code wrapping preserves both raw newline edges through a full unwrap',async()=>{
  const {wrap}=await toolbar,{renderInline}=await inline,raw='\nx\n',v=await viewFor(raw,raw.length,0),prior=global.window;
  try {global.window={};wrap(v,tick);const encoded=v.state.doc.toString();
    assert.equal(encoded,tick+' '+raw+' '+tick);assert.equal(renderInline(encoded),'<code> x </code>');
    v.dispatch({selection:{anchor:encoded.length,head:0}});wrap(v,tick);assert.equal(v.state.doc.toString(),raw);
  }finally{if(prior===undefined)delete global.window;else global.window=prior;}
});
async function projectInline(source, math=[]) {
  const file=fs.readFileSync(path.join(engine,'main.js'),'utf8'),a=file.indexOf('function scanInlineMarks('),b=file.indexOf('const inlineMarksField',a);
  assert(a>=0&&b>a);
  const {Text}=await cm,plan=await moduleAt(path.join(project,'src-cm6/edit-plan.js')),context=await moduleAt(path.join(project,'src-cm6/markdown-context.js'));
  const helpers={...await inline,...plan,...context,tableLead:context.quoteLead,scanImageMarks:()=>[]};
  helpers.inlineCodeSpans=(await inline).inlineCodeSpans;
  const scan=new Function(...Object.keys(helpers),file.slice(a,b)+'\nreturn scanInlineMarks;')(...Object.values(helpers));
  return scan(Text.of(source.split('\n')),math);
}
test('a literal HTML comment opener in inline code does not hide later notes',async()=>{
  const example='Example '+tick+'<!--'+tick,source=example+'\nSECOND NOTE\nTHIRD NOTE';
  assert(!(await projectInline(source)).some(m=>m.comment),'literal comment syntax');
  assert((await projectInline('REAL <!--\nHIDDEN\n-->\nAFTER')).some(m=>m.comment),'actual HTML comment');
});
test('code projection uses the actual matching fences after a TeX backtick and keeps code escapes visible',async()=>{
  const tex='$a\\text{'+tick+'}b$',body='path\\'+tick+'literal\\*',fence=tick.repeat(2);
  const s=tex+' and '+fence+body+fence+' tail',start=s.indexOf(fence),end=start+body.length+4;
  const marks=await projectInline(s,[{from:0,to:tex.length,tex:tex.slice(1,-1)}]);
  assert(marks.some(m=>m.from===start&&m.to===end&&JSON.stringify(m.hides)===JSON.stringify([[start,start+2],[end-2,end]])),'both complete code delimiters');
  assert(!marks.some(m=>m.hides.some(([a,b])=>a>=start+2&&b<=end-2)),'literal content must remain visible');
});

test('adjacent editor font runs merge and block styles end at each paragraph', async () => {
  const b={fontWeight:'700'}, normal={fontWeight:'400'};
  const styled=(tag,style,...children)=>Object.assign(element(tag,{},...children),{style});
  const mk=(...children)=>element('BODY',{},...children);
  const inline=mk(element('P',{},styled('SPAN',b,'A'),styled('SPAN',b,'B')));
  assert.equal(await rich(inline),'**AB**');
  const nested=mk(styled('DIV',b,element('P',{},'A'),element('P',{},'B')));
  assert.equal(await rich(nested),'**A**\n\n**B**');
  const reset=mk(styled('DIV',b,element('P',{},styled('SPAN',normal,'A'), 'B')));
  assert.equal(await rich(reset),'A**B**');
  const {renderInline} = await moduleAt(path.join(engine,'inline-format.js'));
  for(const [children, projection] of [
    [[element('B',{},'A',element('I',{},'B'),'C')],'<strong>A<em>B</em>C</strong>'],
    [[element('B',{},'A'),element('I',{},'B')],'<strong>A</strong><em>B</em>'],
    [[element('S',{},'A',element('I',{},'B'),'C')],'<s>A<em>B</em>C</s>'],
  ]) assert.equal(renderInline(await rich(mk(element('P',{},...children)))), projection);
});

test('a large inline image does not erase the typography on either side of it', async () => {
  const src='data:image/png;base64,'+'A'.repeat(20000);
  const doc=element('BODY',{},element('P',{},element('B',{},'word'),element('IMG',{src,alt:'figure'}),element('SUP',{},'2')));
  const md=await rich(doc);
  assert(md.includes(src));
  const {renderInline}=await inline;
  assert.equal(renderInline(md,{image:()=>'<img>'}),'<strong>word</strong><img><sup>2</sup>');
});
