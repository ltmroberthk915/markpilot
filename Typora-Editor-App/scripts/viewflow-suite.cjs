const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,output,application})=>{
  const cases=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code)=>{for(let i=0;i<600;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+code);};
  const frame=()=>win.webContents.executeJavaScript('(()=>{const r=document.getElementById("editor").getBoundingClientRect();return{x:r.x,y:r.y}})()');
  const mouse=async(type,point,extra={})=>{const f=await frame();win.webContents.sendInputEvent({type,x:Math.round(point.x+f.x),y:Math.round(point.y+f.y),button:'left',...extra});};
  const click=async(point)=>{await mouse('mouseDown',point,{clickCount:1});await mouse('mouseUp',point,{clickCount:1});await pause(180);};
  const toggle=async()=>{await click(await fe("__flow.box(vditor.vditor.toolbar.elements['source-toggle'].querySelector('button'))"));await pause(300);};
  const wheel=async(side,delta)=>{const p=await fe('__flow.box(__flow.pane('+JSON.stringify(side)+'))'),f=await frame();win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(p.x+f.x),y:Math.round(p.y+f.y),deltaY:delta,deltaX:0});await pause(230);};
  const file=path.join(output,'切换位置与双向滚动.md');
  const fixture='# 开始\n\n'+Array.from({length:24},(_,i)=>'## 小节 '+i+'\n\n正文位置'+i+'，**强调内容**和其他文字。'+'一段用于制造左右不同排版高度的内容。'.repeat(5)+'\n\n').join('')+
    '| 名称 | 内容 | 公式 |\n| --- | --- | --- |\n| 行一 | 重复内容 | $a+b$ |\n| 行二 | 重复内容 | $\\frac{x}{y}$ |\n| 行三 |  |  |\n\n'+
    '> 引用中的段落。\n>\n> - 列表项目\n>   - 内层项目\n\n'+
    '~~~js\nconst blockCode = 1;\nconsole.log(blockCode);\n~~~\n\n'+
    '最后公式 $u^2+v^2$\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n文档终点。\n';
  fs.writeFileSync(file,fixture);await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  await wait('vditor.getValue().includes("正文位置18")&&!!vditor.__splitNavigation');
  const setup=()=>{window.__flow={
    pane(side){const e=vditor.vditor;return side==='source'?e.sv.element:side==='preview'?e.preview.element:e[e.currentMode].element;},
    root(side){return side==='preview'?vditor.vditor.preview.previewElement:this.pane(side);},
    box(n){const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height};},
    point(side,text,occurrence=0,local=0){const w=document.createTreeWalker(this.root(side),NodeFilter.SHOW_TEXT);let node,count=0;while(node=w.nextNode()){
      if(node.parentElement.closest('.katex-mathml,.vditor-anchor,.vditor-linenumber__rows,.vditor-linenumber__temp,.vditor-copy')||node.parentElement.matches('.vditor-ir__marker')||node.parentElement.closest('.vditor-ir__marker')&&!node.parentElement.closest('.vditor-ir__node--expand')||!this.rect([node,0]).height)continue;
      for(let at=node.data.indexOf(text);at>=0;at=node.data.indexOf(text,at+text.length)){if(count++===occurrence)return[node,at+local];}
    }throw Error('Text missing '+side+' '+text);},
    rect(point){const [n,a]=point,r=document.createRange();r.setStart(n,a);r.setEnd(n,Math.min(n.length,a+1));const b=r.getBoundingClientRect();return{x:b.left+b.width*.2,y:b.top+b.height/2,width:b.width,height:b.height};},
    reveal(side,text,occurrence=0,local=0){const pane=this.pane(side),p=this.rect(this.point(side,text,occurrence,local)),r=pane.getBoundingClientRect();pane.scrollTop+=p.y-r.top-r.height*.4;return true;},
    caret(){const s=getSelection(),root=vditor.vditor.sv.element;if(!root.contains(s.focusNode))return null;const range=document.createRange();range.selectNodeContents(root);range.setEnd(s.focusNode,s.focusOffset);const n=s.focusNode,a=s.focusOffset,r=document.createRange();r.setStart(n,a);r.collapse(true);const b=r.getBoundingClientRect();return{offset:range.toString().replaceAll('\u200b','').length,x:b.x,y:b.y+b.height/2};},
    expected(text,occurrence=0,local=0){const value=vditor.getValue();let at=-1;for(let i=0;i<=occurrence;i++)at=value.indexOf(text,at+1);if(at<0)throw Error('Source missing '+text);return at+local;},
    state(){const e=vditor.vditor;return{mode:e.currentMode,quality:vditor.__splitNavigation.quality,anchor:vditor.__splitNavigation.anchor,stats:vditor.__splitNavigation.stats,panes:['source','preview'].map(side=>{const p=this.pane(side);return{side,top:p.scrollTop,height:p.scrollHeight,client:p.clientHeight,rect:p.getBoundingClientRect().toJSON()};})};}
  };return true;};await fe('('+setup.toString()+')()');
  const test=async(name,fn)=>{try{const details=await fn();cases.push({name,status:'PASS',details});console.log('PASS '+name);}catch(error){cases.push({name,status:'FAIL',error:String(error.stack)});console.error('FAIL '+name+' '+error.message);fs.writeFileSync(path.join(output,'failure-state.json'),JSON.stringify(await fe('__flow.state()'),null,2));await win.webContents.capturePage().then(img=>fs.writeFileSync(path.join(output,'failure.png'),img.toPNG()));throw error;}finally{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,cases,failed:cases.filter(c=>c.status==='FAIL').length},null,2));}};
  const mode=async value=>{if(await fe('vditor.vditor.currentMode==="sv"'))await toggle();await fe("vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode=\""+value+"\"]').click();true");await pause(180);};
  const performanceSuite=()=>require('./viewflow-performance-suite.cjs').run({fe,wait,pause,test,wheel,toggle,mode,mouse,output,setup:()=>fe('('+setup.toString()+')()')});
  if(process.env.VIEWFLOW_PHASE==='performance'){await performanceSuite();return;}
  if(process.env.VIEWFLOW_PHASE==='boundaries'){await require('./release100-quality-boundaries.cjs').run({win,fe,wait,pause,test,toggle,mode,output,setup:()=>fe('('+setup.toString()+')()'),click});return;}
  const enterText=async(view,text,occurrence=0,local=2)=>{
    const args=[text,occurrence,local].map(JSON.stringify).join(',');
    await mode(view);await fe("__flow.reveal('visual',"+args+")");await pause(100);
    await click(await fe("__flow.rect(__flow.point('visual',"+args+"))"));
    if(text==='blockCode'){
      // Opening a rendered block exposes editable source; click the desired
      // character in that source after its expansion has settled.
      await fe("__flow.reveal('visual',"+args+")");await pause(180);await click(await fe("__flow.rect(__flow.point('visual',"+args+"))"));
      // The WYSIWYG preview can overlap the source character's rectangle at
      // some window sizes. Its click opens the code at offset zero. Establish
      // the intended editable caret with real arrow keys before testing that
      // the source-view switch preserves it, rather than assuming a hit.
      const codeCaret="(()=>{const p=__flow.point('visual',"+args+"),code=p[0].parentElement.closest('code'),s=getSelection();if(!code?.parentElement.contains(s.focusNode))return null;const a=document.createRange(),b=document.createRange();a.selectNodeContents(code);a.setEnd(s.focusNode,s.focusOffset);b.selectNodeContents(code);b.setEnd(...p);return{actual:a.toString().length,wanted:b.toString().length};})()";
      const current=await fe(codeCaret);assert.ok(current,'Code source has actual editing focus');
      const delta=current.wanted-current.actual;assert.ok(Math.abs(delta)<100,'Bounded keyboard positioning in the test code block');
      for(let i=0;i<Math.abs(delta);i++){const keyCode=delta>0?'Right':'Left';win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});}
      await wait('(()=>{const c='+codeCaret+';return c&&c.actual===c.wanted;})()');
    }
    const before=await fe("(()=>{const p=__flow.point('visual',"+args+"),point=__flow.rect(p),s=getSelection(),hit=document.elementFromPoint(point.x,point.y);return{point,top:__flow.pane('visual').scrollTop,selection:{text:s.focusNode?.textContent?.slice(0,100),offset:s.focusOffset,parent:s.focusNode?.parentElement?.outerHTML.slice(0,700)},desired:{text:p[0].textContent?.slice(0,100),offset:p[1],parent:p[0].parentElement?.outerHTML.slice(0,700)},hit:hit?.outerHTML.slice(0,700)}})()");
    if(process.env.VIEWFLOW_ENTRY_TRACE)await fe(`(()=>{window.__entryLog=[];const nav=vditor.__splitNavigation,c=nav.captureVisual,e=nav.enterAt;nav.captureVisual=function(...args){const r=c(...args);__entryLog.push({action:'capture',mode:r?.mode,offset:r?.offset,y:r?.y,block:r?.block?.kind});return r;};nav.enterAt=function(r){__entryLog.push({action:'enter',offset:r?.offset,y:r?.y});return e(r);};for(const event of ['pointerdown','pointerup','click','scroll','selectionchange'])document.addEventListener(event,x=>{if(__entryLog.length<100){const s=getSelection();__entryLog.push({event,target:x.target?.className,mode:vditor.vditor.currentMode,anchor:nav.anchor,focus:s.focusNode?.parentElement?.className,offset:s.focusOffset,sourceTop:vditor.vditor.sv.element.scrollTop,previewTop:vditor.vditor.preview.element.scrollTop});}},true);return true;})()`);
    await toggle();await wait('vditor.__splitNavigation.active&&vditor.__splitNavigation.source===vditor.getValue()&&vditor.__splitNavigation.anchor!==null');await pause(100);
    if(process.env.VIEWFLOW_ENTRY_TRACE)fs.writeFileSync(path.join(output,'entry-trace.json'),JSON.stringify(await fe('__entryLog'),null,2));
    const state=await fe("({caret:__flow.caret(),expected:__flow.expected("+args+"),preview:__flow.rect(__flow.point('preview',"+args+")),...__flow.state()})");
    assert.equal(state.caret?.offset,state.expected,JSON.stringify({before,state}));assert.ok(Math.abs(state.preview.y-before.point.y)<4,JSON.stringify({before,state}));assert.ok(Math.abs(state.caret.y-state.preview.y)<4,JSON.stringify(state));return{before,state};
  };
  for(const view of ['ir','wysiwyg']){
    for(const [text,nth,local] of [['正文位置18',0,2],['重复内容',1,2],['引用中的段落',0,2],['内层项目',0,2],['blockCode',1,3],['文档终点',0,2]])await test('enter-'+view+'-'+text,()=>enterText(view,text,nth,local));
    for(const [tex,local] of [['a+b',2],['\\frac{x}{y}',6],['u^2+v^2',4],['\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}',15]])await test('enter-'+view+'-math-'+tex,async()=>{
      await mode(view);
      await fe('window.__flowMathTex='+JSON.stringify(tex)+';window.__flowMathLocal='+local+';true');
      await fe(`window.__flowMath=function(side){const root=__flow.root(side),math=[...root.querySelectorAll('.language-math')].find(n=>n.getAttribute('data-math')===__flowMathTex);if(!math)throw Error('Formula missing '+side);return math;};(()=>{const m=__flowMath('visual'),p=__flow.pane('visual'),r=m.getBoundingClientRect();p.scrollTop+=r.top+r.height/2-p.getBoundingClientRect().top-p.clientHeight*.4;return true;})()`);await pause(120);
      await click(await fe(`__flow.box(__flowMath('visual'))`));
      await fe(`window.__flowMathRaw=function(){const root=__flow.root('visual'),code=[...root.querySelectorAll('code')].find(n=>n.textContent.replaceAll('\u200b','').trim()===__flowMathTex&&!n.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'));if(!code)throw Error('Editable formula missing');const w=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let n,left=__flowMathLocal;while(n=w.nextNode()){for(let i=0;i<n.length;i++){if(n.data[i]==='\u200b')continue;if(!left--)return[n,i];}}throw Error('Formula offset missing');};(()=>{const p=__flow.pane('visual'),r=__flow.rect(__flowMathRaw());p.scrollTop+=r.y-p.getBoundingClientRect().top-p.clientHeight*.4;return true;})()`);await pause(140);
      await click(await fe('__flow.rect(__flowMathRaw())'));const before=await fe('__flow.rect(__flowMathRaw())');await toggle();await pause(150);
      const after=await fe(`(()=>{const m=__flowMath('preview'),symbols=[...m.querySelectorAll('[data-typora-source-start]')].filter(n=>+n.dataset.typoraSourceStart<=__flowMathLocal&&+n.dataset.typoraSourceEnd>__flowMathLocal).sort((a,b)=>(+a.dataset.typoraSourceEnd-+a.dataset.typoraSourceStart)-(+b.dataset.typoraSourceEnd-+b.dataset.typoraSourceStart)||a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);return{caret:__flow.caret(),expected:__flow.expected(__flowMathTex,0,__flowMathLocal),preview:__flow.box(symbols[0]||m)};})()`);
      assert.equal(after.caret?.offset,after.expected,JSON.stringify({before,after}));assert.ok(Math.abs(after.preview.y-before.y)<4,JSON.stringify({before,after}));return{before,after};
    });
    await test('enter-'+view+'-reading-with-offscreen-caret',async()=>{
      await mode(view);await fe("__flow.reveal('visual','正文位置0');true");await pause(60);await click(await fe("__flow.rect(__flow.point('visual','正文位置0'))"));
      await fe("__flow.reveal('visual','正文位置17');true");await pause(80);await wheel('visual',-120);
      const before=await fe("__flow.rect(__flow.point('visual','正文位置17'))");await toggle();await pause(180);
      const after=await fe("__flow.rect(__flow.point('preview','正文位置17'))"),state=await fe('__flow.state()');
      assert.ok(state.panes[1].top>1000,JSON.stringify(state));assert.ok(Math.abs(after.y-before.y)<110,JSON.stringify({before,after,state}));return{before,after,state};
    });
  }
  await test('navigation-keeps-note-and-clean-state',async()=>{assert.equal(global.doc.dirty,false);assert.equal(fs.readFileSync(file,'utf8'),fixture);return true;});
  await enterText('ir','正文位置12');
  for(const side of ['source','preview'])for(const delta of [-190,-370,260,160])await test('wheel-'+side+'-'+delta,async()=>{
    const before=await fe('({...__flow.state(),caret:__flow.caret(),value:vditor.getValue()})');await wheel(side,delta);const after=await fe('({...__flow.state(),caret:__flow.caret(),value:vditor.getValue()})');
    assert.ok(after.panes.every((p,i)=>Math.abs(p.top-before.panes[i].top)>30),JSON.stringify({before,after}));assert.equal(after.caret?.offset,before.caret?.offset,'Scrolling must not move insertion point');assert.equal(after.value,before.value);
    await pause(180);const stable=await fe('__flow.state()');assert.ok(stable.panes.every((p,i)=>Math.abs(p.top-after.panes[i].top)<3),'feedback scroll loop');
    const geometry=await fe("(()=>{const a=vditor.__splitNavigation.anchor,s=__flow.pane('source'),w=document.createTreeWalker(s,NodeFilter.SHOW_TEXT);let n,left=a.offset;while(n=w.nextNode()){const length=n.data.replaceAll('\\u200b','').length;if(left<length)break;left-=length;}return{anchor:a,source:__flow.rect([n,left])};})()");
    assert.ok(Math.abs(geometry.anchor.y-geometry.source.y)<4,JSON.stringify(geometry));return{before:before.panes,after:after.panes,geometry};
  });
  await test('scroll-mapping-is-cached',async()=>{
    const before=await fe('vditor.__splitNavigation.stats');for(let i=0;i<8;i++)await wheel(i%2?'preview':'source',i%3?-110:130);const after=await fe('vditor.__splitNavigation.stats');
    assert.equal(after.parses,before.parses);assert.equal(after.modelBuilds,before.modelBuilds);assert.equal(after.bindings,before.bindings);return{before,after};
  });
  await test('source-wheel-with-preview-reading-selection',async()=>{
    await fe(`(()=>{const p=__flow.point('preview','正文位置12'),r=document.createRange();r.setStart(...p);r.setEnd(p[0],p[1]+6);getSelection().removeAllRanges();getSelection().addRange(r);return true;})()`);await pause(70);
    const before=await fe('({...__flow.state(),selection:getSelection().toString()})');await wheel('source',-260);const after=await fe('({...__flow.state(),selection:getSelection().toString()})');
    assert.ok(after.panes.every((p,i)=>Math.abs(p.top-before.panes[i].top)>30));assert.equal(after.selection,before.selection);return{before,after};
  });
  const drag=async share=>{const bar=await fe("__flow.box(document.querySelector('.typora-split-divider'))"),target=await fe("(()=>{const a=__flow.pane('source').getBoundingClientRect(),b=__flow.pane('preview').getBoundingClientRect();return a.left+(b.right-a.left)*"+share+";})()");await mouse('mouseDown',bar,{clickCount:1});for(let i=1;i<=8;i++){await mouse('mouseMove',{x:bar.x+(target-bar.x)*i/8,y:bar.y},{modifiers:['leftButtonDown']});await pause(25);}await mouse('mouseUp',{x:target,y:bar.y},{clickCount:1});await pause(300);};
  for(const share of [.7,.3,.85,.15,.5])await test('divider-drag-'+share,async()=>{
    const before=await fe('({value:vditor.getValue(),caret:__flow.caret()})');await drag(share);const state=await fe("({...__flow.state(),value:vditor.getValue(),caret:__flow.caret(),divider:__flow.box(document.querySelector('.typora-split-divider'))})");
    const width=state.panes[0].rect.width+state.panes[1].rect.width,ratio=state.panes[0].rect.width/width;
    assert.ok(Math.abs(ratio-Math.max(160/width,Math.min(1-160/width,share)))<.02,JSON.stringify({...state,value:undefined}));assert.equal(state.value,before.value);assert.equal(state.caret?.offset,before.caret?.offset);
    assert.ok(state.panes.every(p=>p.rect.width>=159),JSON.stringify(state));return{ratio,state};
  });
  await test('divider-keyboard-persistence-and-exit',async()=>{
    await click(await fe("__flow.box(document.querySelector('.typora-split-divider'))"));await fe("document.querySelector('.typora-split-divider').focus();true");
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Right',modifiers:['shift']});await pause(220);
    const before=await fe("({width:__flow.box(__flow.pane('source')).width,value:document.querySelector('.typora-split-divider').getAttribute('aria-valuenow')})");assert.equal(before.value,'55');
    await toggle();assert.equal(await fe("document.querySelector('.typora-split-divider').getBoundingClientRect().width"),0);assert.equal(await fe("document.querySelectorAll('.typora-navigation-pane').length"),0);
    await toggle();const after=await fe("__flow.box(__flow.pane('source')).width");assert.ok(Math.abs(after-before.width)<2);return{before,after};
  });
  await test('divider-double-click-reset',async()=>{
    const p=await fe("__flow.box(document.querySelector('.typora-split-divider'))");for(const count of [1,2]){await mouse('mouseDown',p,{clickCount:count});await mouse('mouseUp',p,{clickCount:count});}await pause(260);
    const widths=await fe("['source','preview'].map(side=>__flow.box(__flow.pane(side)).width)");assert.ok(Math.abs(widths[0]-widths[1])<2);return widths;
  });
  await test('all-layout-actions-preserve-document',async()=>{assert.equal(global.doc.dirty,false);assert.equal(fs.readFileSync(file,'utf8'),fixture);return true;});
  for(const view of ['ir','wysiwyg'])await test('enter-'+view+'-empty-table-cell',async()=>{
    await mode(view);await fe(`(()=>{const p=__flow.pane('visual'),c=p.querySelector('table').rows[3].cells[1],r=c.getBoundingClientRect();p.scrollTop+=r.top+r.height/2-p.getBoundingClientRect().top-p.clientHeight*.4;return true;})()`);await pause(120);
    await click(await fe(`__flow.box(__flow.pane('visual').querySelector('table').rows[3].cells[1])`));const before=await fe(`__flow.box(__flow.pane('visual').querySelector('table').rows[3].cells[1])`);await toggle();await wait('vditor.__splitNavigation.anchor!==null');
    const after=await fe(String.raw`(()=>{const text=vditor.getValue(),start=text.indexOf('| 行三'),end=text.indexOf('\n',start),line=text.slice(start,end),pipes=[...line.matchAll(/\|/g)].map(m=>m.index);return{caret:__flow.caret(),expected:start+pipes[2],preview:__flow.box(__flow.root('preview').querySelector('table').rows[3].cells[1])};})()`);
    assert.equal(after.caret?.offset,after.expected,JSON.stringify({before,after}));assert.ok(Math.abs(after.preview.y-before.y)<4,JSON.stringify({before,after}));return{before,after};
  });
  await test('entry-survives-delayed-container-focus-restore',async()=>{
    const before=await fe('__flow.caret()');await fe('getSelection().collapse(vditor.vditor.sv.element,0);true');await pause(180);const after=await fe('__flow.caret()');assert.equal(after.offset,before.offset);return{before,after};
  });
  await test('external-refresh-releases-old-entry-before-completion-input',async()=>{
    await fe(`vditor.__completion.externalChange();vditor.setValue(${JSON.stringify('# 外部刷新\n\n\\f\n')},true);true`);await pause(400);
    await fe(`(()=>{const p=__flow.point('source','\\\\f',0,2);vditor.vditor.sv.element.focus();getSelection().collapse(...p);return true;})()`);await pause(150);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'r'});win.webContents.sendInputEvent({type:'char',keyCode:'r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'r'});await pause(400);
    const value=await fe('vditor.getValue()');assert.ok(value.includes('\\fr'),'Refreshed selection moved before its completion prefix: '+value);assert.ok(!value.includes('r\\f'));return{value};
  });
  const noteFile=path.join(output,'真实笔记-分屏操作副本.md'),noteOriginal=path.resolve(__dirname,'../.backups/2026-09-08-viewflow/user-note-original.md');fs.copyFileSync(noteOriginal,noteFile);
  await global.doc.openFile(noteFile,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});await wait('vditor.getValue().includes("第一章 集合运算法则")&&!!vditor.__splitNavigation');await fe('('+setup.toString()+')()');
  for(const view of ['ir','wysiwyg'])for(const text of ['底层状态','勒贝格积分','控制收敛'])await test('user-note-enter-'+view+'-'+text,()=>enterText(view,text,0,2));
  await test('user-note-viewflow-preserved',async()=>{assert.equal(global.doc.dirty,false);assert.deepEqual(fs.readFileSync(noteFile),fs.readFileSync(noteOriginal));return true;});
  await performanceSuite();
  fs.writeFileSync(path.join(output,'final-state.json'),JSON.stringify(await fe('__flow.state()'),null,2));await win.webContents.capturePage().then(img=>fs.writeFileSync(path.join(output,'final.png'),img.toPNG()));
};
