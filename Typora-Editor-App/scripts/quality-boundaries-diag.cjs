// Focused diagnostic: why does reveal+click+End lose the tail position at
// length 150001 (quality 'blocks') right after the source toggle, while the
// same entry works at 150000 ('precise')? Samples pane scrollTop, caret and
// anchor at 8ms while replaying the exact fixed test entry. Test tooling only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,output,application})=>{
  const report={application,output,phases:{}};
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async code=>{for(let i=0;i<200;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+code);};
  const frame=()=>win.webContents.executeJavaScript('(()=>{const r=document.getElementById("editor").getBoundingClientRect();return{x:r.x,y:r.y}})()');
  const mouse=async(type,point,extra={})=>{const f=await frame();win.webContents.sendInputEvent({type,x:Math.round(point.x+f.x),y:Math.round(point.y+f.y),button:'left',...extra});};
  const click=async(point)=>{await mouse('mouseDown',point,{clickCount:1});await mouse('mouseUp',point,{clickCount:1});await pause(180);};
  const toggle=async()=>{const box=await fe("(()=>{const b=vditor.vditor.toolbar.elements['source-toggle'].querySelector('button');const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()");await click(box);await pause(300);};
  const mode=async value=>{if(await fe('vditor.vditor.currentMode==="sv"'))await toggle();await fe("vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode=\""+value+"\"]').click();true");await pause(180);};
  const setup=()=>{window.__flow={
    pane(side){const e=vditor.vditor;return side==='source'?e.sv.element:side==='preview'?e.preview.element:e[e.currentMode].element;},
    point(side,text,occurrence=0,local=0){const w=document.createTreeWalker(this.root(side),NodeFilter.SHOW_TEXT);let node,count=0;while(node=w.nextNode()){
      if(node.parentElement.closest('.katex-mathml,.vditor-anchor,.vditor-linenumber__rows,.vditor-linenumber__temp,.vditor-copy')||!this.rect([node,0]).height)continue;
      for(let at=node.data.indexOf(text);at>=0;at=node.data.indexOf(text,at+text.length)){if(count++===occurrence)return[node,at+local];}
    }throw Error('Text missing '+side+' '+text);},
    root(side){return side==='preview'?vditor.vditor.preview.previewElement:this.pane(side);},
    rect(point){const [n,a]=point,r=document.createRange();r.setStart(n,a);r.setEnd(n,Math.min(n.length,a+1));const b=r.getBoundingClientRect();return{x:b.left+b.width*.2,y:b.top+b.height/2,width:b.width,height:b.height};},
    reveal(side,text,occurrence=0,local=0){const pane=this.pane(side),p=this.rect(this.point(side,text,occurrence,local)),r=pane.getBoundingClientRect();pane.scrollTop+=p.y-r.top-r.height*.4;return true;},
    caret(){const s=getSelection(),root=vditor.vditor.sv.element;if(!root.contains(s.focusNode))return null;const range=document.createRange();range.selectNodeContents(root);range.setEnd(s.focusNode,s.focusOffset);return{offset:range.toString().replaceAll('\u200b','').length};},
    expected(text,occurrence=0,local=0){const value=vditor.getValue();let at=-1;for(let i=0;i<=occurrence;i++)at=value.indexOf(text,at+1);if(at<0)throw Error('Source missing '+text);return at+local;}
  };return true;};
  const instrument=()=>fe(`(()=>{window.__diagLog=[];const t0=performance.now();const sample=()=>{try{return{st:Math.round(vditor.vditor.sv.element.scrollTop),caret:__flow.caret()?.offset,anchor:vditor.__splitNavigation.anchor?.offset};}catch(error){return{err:String(error)}};};const rec=(event,extra={})=>{if(window.__diagLog.length<800)window.__diagLog.push({t:Math.round(performance.now()-t0),event,...sample(),...extra});};for(const type of ['selectionchange','pointerdown'])document.addEventListener(type,e=>rec(type,{}),true);const src=vditor.vditor.sv.element;src.addEventListener('scroll',()=>rec('source:scroll',{}),true);for(const type of ['keydown','beforeinput','input'])src.addEventListener(type,e=>rec('source:'+type,{key:e.key||'',inputType:String(e.inputType||'')}),true);window.__sampler=null;window.__startSampler=()=>{const t0=performance.now(),out=[];window.__sampler=out;const step=()=>{if(!window.__sampler)return;out.push({t:Math.round(performance.now()-t0),...sample()});setTimeout(step,8);};step();};window.__stopSampler=()=>{const out=window.__sampler||[];window.__sampler=null;return out;};return true;})()`);

  const results={};
  for(const length of [150001]){
    const prefix='# Threshold '+length+'\n\n',block='Repeated boundary paragraph '.repeat(24).trim()+'\n\n',tail='ENDTOKEN\n';
    let file,text,canonicalAdjustment=0;
    for(let attempt=0;attempt<2;attempt++){
      const rawLength=length+canonicalAdjustment,count=Math.floor((rawLength-prefix.length-tail.length-2)/block.length),padding=rawLength-prefix.length-count*block.length-tail.length;
      text=prefix+block.repeat(count)+'p'.repeat(padding)+tail;assert.equal(text.length,rawLength);
      file=path.join(output,'diag-threshold-'+length+'-'+attempt+'.md');fs.writeFileSync(file,text);
      await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
      const version=String(global.doc.docVersion);
      await wait('new URLSearchParams(location.search).get("v")==='+JSON.stringify(version)+'&&!!vditor.__splitNavigation&&vditor.getValue().includes("ENDTOKEN")');
      await fe('('+setup.toString()+')()');await mode('ir');
      await fe('window.focus();vditor.vditor.ir.element.focus();getSelection().collapse(vditor.vditor.ir.element,0);true');
      await toggle();await wait('vditor.__splitNavigation.active&&vditor.__splitNavigation.source===vditor.getValue()');
      const actual=await fe('vditor.getValue().length');if(actual===length)break;
      assert.ok(Math.abs(actual-length)<=2,'Unexpected fixture normalization');canonicalAdjustment+=length-actual;
    }
    await instrument();
    const initial=await fe('({length:vditor.getValue().length,quality:vditor.__splitNavigation.quality,anchor:vditor.__splitNavigation.anchor?{offset:vditor.__splitNavigation.anchor.offset,y:Math.round(vditor.__splitNavigation.anchor.y)}:null,scrollTop:vditor.vditor.sv.element.scrollTop})');
    results[length]={initial};

    // Replay the fixed entry with a live sampler: reveal -> settle -> click
    // the last ENDTOKEN character -> End -> verify caret -> type.
    await fe('window.__startSampler();true');
    await fe("__flow.reveal('source','ENDTOKEN');true");
    const afterReveal=await fe('({scrollTop:vditor.vditor.sv.element.scrollTop,stats:vditor.__splitNavigation.stats})');
    await pause(150);
    const afterSettle=await fe('({scrollTop:vditor.vditor.sv.element.scrollTop,stats:vditor.__splitNavigation.stats})');
    await click(await fe("__flow.rect(__flow.point('source','ENDTOKEN',0,7))"));
    const afterClick=await fe('({scrollTop:vditor.vditor.sv.element.scrollTop,caret:__flow.caret()?.offset})');
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'End'});
    await pause(200);
    const target=await fe('__flow.expected("ENDTOKEN",0,8)');
    const afterEnd=await fe('({scrollTop:vditor.vditor.sv.element.scrollTop,caret:__flow.caret()?.offset})');
    let typedAt=null,typedOk=false;
    if(afterEnd.caret===target){
      await win.webContents.insertText('z');typedAt=Date.now();
      try{await wait('vditor.getValue().includes("ENDTOKENz")&&vditor.__splitNavigation.source===vditor.getValue()');typedOk=true;}catch{}
    }
    await fe('window.__stopSampler();true');
    const samples=await fe('window.__diagLog.length');
    results[length].entry={afterReveal:{scrollTop:afterReveal.scrollTop,parses:afterReveal.stats.parses,bindings:afterReveal.stats.bindings},afterSettle:{scrollTop:afterSettle.scrollTop,parses:afterSettle.stats.parses,bindings:afterSettle.stats.bindings},afterClick,afterEnd,typed:typedOk,typedSyncMs:typedAt?Date.now()-typedAt:null};
    console.log('DIAG '+length+' initial='+JSON.stringify(initial));
    console.log('DIAG '+length+' reveal scrollTop '+afterReveal.scrollTop+' -> settle '+afterSettle.scrollTop+' -> click caret '+(afterClick.caret??null)+' st '+afterClick.scrollTop+' -> End caret '+(afterEnd.caret??null)+' target '+target+' typed '+typedOk);
  }
  report.phases=results;
  report.eventLog=await fe('window.__diagLog');
  fs.writeFileSync(path.join(output,'diag-report.json'),JSON.stringify(report,null,2));
};
