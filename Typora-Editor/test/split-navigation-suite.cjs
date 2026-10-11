const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.probe=async function(request){
  const api=window.vditor,e=api.vditor,pause=ms=>new Promise(r=>setTimeout(r,ms));
  if(request.op==='entryReady')return api.__splitNavigation.active&&api.__splitNavigation.source===api.getValue()&&!!api.__splitNavigation.anchor;
  if(request.op==='load'){
    e.toolbar.elements['edit-mode'].querySelector('button[data-mode="sv"]').click();api.setValue(request.text,true);
    for(let i=0;i<200&&(!api.__splitNavigation.active||api.__splitNavigation.source!==api.getValue());i++)await pause(25);
    // setValue is intentionally silent. Publish the disposable fixture through
    // the existing host input bridge before asserting navigation makes no edit.
    e.options.input(api.getValue());
  }
  if(request.op==='visualPoint'){
    if(e.currentMode==='sv')e.toolbar.elements['source-toggle'].querySelector('button').click();
    if(e.currentMode!==request.mode)e.toolbar.elements['edit-mode'].querySelector('button[data-mode="'+request.mode+'"]').click();await pause(180);
  }
  const box=node=>{const r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height};};
  if(request.op==='togglePoint')return box(e.toolbar.elements['source-toggle'].querySelector('button'));
  if(request.op==='pane')return box(request.side==='source'?e.sv.element:e.preview.element);
  if(request.op==='separator')return box(document.querySelector('.typora-split-divider'));
  const find=(side,needle,occurrence=0)=>{
    const root=side==='source'?e.sv.element:side==='visual'?e[e.currentMode].element:e.preview.previewElement,walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,count=0;
    while(n=walker.nextNode()){
      if(side==='preview'&&n.parentElement.closest('.katex-mathml,.hljs-ln-numbers,.vditor-anchor'))continue;
      for(let at=n.data.indexOf(needle);at>=0;at=n.data.indexOf(needle,at+needle.length))if(count++===occurrence)return[n,at];
    }
    throw Error('Missing '+side+' text '+needle);
  };
  const rect=point=>{const r=document.createRange();r.setStart(...point);r.setEnd(point[0],Math.min(point[0].length,point[1]+1));const b=r.getBoundingClientRect();return{x:b.left+b.width*.2,y:b.top+b.height/2};};
  const needle=request.needle||'导航正文',occurrence=request.occurrence||0;
  if(request.op==='point'||request.op==='visualPoint'){
    const side=request.op==='visualPoint'?'visual':request.side,point=find(side,needle,occurrence),scroller=side==='source'?e.sv.element:side==='visual'?e[e.currentMode].element:e.preview.element,b=rect(point);
    scroller.scrollTop+=b.y-scroller.getBoundingClientRect().top-scroller.clientHeight*.4;await pause(90);return rect(point);
  }
  const selection=getSelection();let caret=null;
  if(e.sv.element.contains(selection.focusNode)){
    const range=document.createRange();range.selectNodeContents(e.sv.element);range.setEnd(selection.focusNode,selection.focusOffset);
    const c=document.createRange();c.setStart(selection.focusNode,selection.focusOffset);c.collapse(true);const b=c.getBoundingClientRect();caret={offset:range.toString().length,y:b.top+b.height/2};
  }
  const source=find('source',needle,occurrence),before=document.createRange();before.selectNodeContents(e.sv.element);before.setEnd(...source);
  return{caret,expected:before.toString().length,preview:rect(find('preview',needle,occurrence)),value:api.getValue(),errors:window.__completionErrors||[],active:api.__splitNavigation.active,anchor:api.__splitNavigation.anchor,sourceReady:api.__splitNavigation.source===api.getValue(),panes:[e.sv.element,e.preview.element].map(n=>({top:n.scrollTop,width:box(n).width})),stats:api.__splitNavigation.stats};
};
exports.run=async({request,send,document,file,until,pass,testRoot})=>{
  const q=fields=>request('splitNavigation',fields),records=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
  const source='# 双屏导航\n\n导航正文 **加粗部分**。\n\n'+Array.from({length:28},(_,i)=>`第 ${i} 段 ${'用于拉开源码和预览的排版距离。'.repeat(3)}`).join('\n\n')+'\n\n| 名称 | 内容 |\n| --- | --- |\n| 行一 | 重复项 |\n| 行二 | 重复项 |\n\n> 引用位置\n\n```js\nconst codeTarget=1;\n```\n\n结尾位置\n';
  const baseline=await q({op:'load',text:source});await until(()=>document.getText()===baseline.value);await document.save();
  await send('Page.bringToFront');
  const frame=(await send('Runtime.evaluate',{expression:`(()=>{const frames=[...document.querySelectorAll('iframe')].map(n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,src:n.src};}).filter(b=>b.width>100&&b.height>100);return frames.sort((a,b)=>b.width*b.height-a.width*a.height)[0];})()`,returnByValue:true})).result.value;
  assert.ok(frame,'The actual VS Code Webview iframe is visible');fs.writeFileSync(path.join(testRoot,'split-frame.json'),JSON.stringify(frame,null,2));
  const click=async(point)=>{
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:point.x+frame.x,y:point.y+frame.y,button:'left',clickCount:1});await pause(220);
  };
  for(const [needle,occurrence] of [['双屏导航',0],['加粗部分',0],['重复项',1],['引用位置',0],['codeTarget',0],['结尾位置',0]]){
    await click(await q({op:'point',side:'source',needle,occurrence}));let state=await q({op:'read',needle,occurrence});
    assert.ok(state.caret&&Math.abs(state.caret.y-state.preview.y)<4,JSON.stringify(state));assert.deepEqual(state.errors,[]);records.push({direction:'source-preview',needle,delta:Math.abs(state.caret.y-state.preview.y)});pass('Actual VSIX source click aligns rendered '+needle);
    await click(await q({op:'point',side:'preview',needle,occurrence}));state=await q({op:'read',needle,occurrence});
    assert.ok(state.caret&&Math.abs(state.caret.offset-state.expected)<=1,JSON.stringify(state));assert.deepEqual(state.errors,[]);records.push({direction:'preview-source',needle,offset:state.caret.offset});pass('Actual VSIX rendered click places source caret at '+needle);
  }
  assert.equal((await q({op:'read'})).value,baseline.value);assert.equal(document.isDirty,false);assert.equal(fs.readFileSync(file,'utf8'),baseline.value);pass('Actual VSIX bidirectional navigation preserves TextDocument and disk source');
  for(const mode of ['ir','wysiwyg'])for(const [needle,occurrence] of [['重复项',1],['引用位置',0],['结尾位置',0]]){
    const before=await q({op:'visualPoint',mode,needle,occurrence});await click(before);await click(await q({op:'togglePoint'}));
    for(let i=0;i<120&&!await q({op:'entryReady'});i++)await pause(25);
    const state=await q({op:'read',needle,occurrence});
    fs.writeFileSync(path.join(testRoot,'split-entry-latest.json'),JSON.stringify({mode,needle,before,state},null,2));
    assert.ok(state.active);assert.ok(Math.abs(state.caret.offset-state.expected)<=1,JSON.stringify(state));assert.ok(Math.abs(state.preview.y-before.y)<4,JSON.stringify({before,state}));pass('Actual VSIX '+mode+' split entry keeps '+needle);records.push({mode,needle,entryDelta:Math.abs(state.preview.y-before.y)});
  }
  await click(await q({op:'point',side:'source',needle:'第 16 段'}));
  const cacheBefore=(await q({op:'read'})).stats;
  for(const side of ['source','preview'])for(const deltaY of [220,180,-240,-160]){
    const point=await q({op:'pane',side}),before=await q({op:'read'});await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x+frame.x,y:point.y+frame.y,deltaX:0,deltaY});await pause(250);const after=await q({op:'read'});
    assert.ok(after.panes.every((p,i)=>Math.abs(p.top-before.panes[i].top)>20),JSON.stringify({before,after}));assert.equal(after.caret?.offset,before.caret?.offset);assert.deepEqual(after.errors,[]);pass('Actual VSIX '+side+' wheel '+deltaY+' synchronizes both panes');
  }
  const cacheAfter=(await q({op:'read'})).stats;assert.equal(cacheAfter.parses,cacheBefore.parses);assert.equal(cacheAfter.modelBuilds,cacheBefore.modelBuilds);pass('Actual VSIX scroll reuses Markdown mappings');
  for(const delta of [120,-180]){
    const bar=await q({op:'separator'}),before=await q({op:'read'});await send('Input.dispatchMouseEvent',{type:'mousePressed',x:bar.x+frame.x,y:bar.y+frame.y,button:'left',clickCount:1});
    for(let i=1;i<=6;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:bar.x+frame.x+delta*i/6,y:bar.y+frame.y,button:'left',buttons:1});await pause(25);}
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:bar.x+frame.x+delta,y:bar.y+frame.y,button:'left',clickCount:1});await pause(250);const after=await q({op:'read'});
    assert.ok(Math.abs((after.panes[0].width-before.panes[0].width)-delta)<3,JSON.stringify({before,after}));assert.equal(after.value,before.value);pass('Actual VSIX divider drag '+delta+' resizes and reflows panes');
  }
  assert.equal(document.isDirty,false);assert.equal(fs.readFileSync(file,'utf8'),baseline.value);pass('Actual VSIX split entry, scrolling and resizing keep saved document intact');
  fs.writeFileSync(path.join(testRoot,'split-navigation-verified.json'),JSON.stringify({records,verified:true},null,2));
};
