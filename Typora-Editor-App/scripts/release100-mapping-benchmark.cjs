const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
exports.run=async({win,output,application})=>{
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),samples=[];
 const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
 const wait=async code=>{for(let i=0;i<500;i++){if(await fe(code))return;await pause(25);}throw Error('benchmark readiness: '+code);};
 const user=fs.readFileSync(path.join(__dirname,'../.backups/2026-09-08-release100/user-note-start.md'),'utf8');
 const fixtures=[['user-note',user],['rich-medium','# Middle\n\n'+Array.from({length:160},(_,i)=>'## Section '+i+'\n\n'+('正文段落'+i+' **强调文字🙂** 与普通内容。').repeat(9)+'\n\n| A | B |\n|---|---|\n| '+i+' | $x+1$ |\n\n').join('')],['many-cells','# Cells\n\n| A | B | C |\n|---|---|---|\n'+Array.from({length:900},(_,i)=>'| '+i+' | 单元格重复内容 | 加粗**测试** |\n').join('')]];
 for(const [name,text] of fixtures){
  const file=path.join(output,name+'.md');fs.writeFileSync(file,text);await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  const documentVersion=String(global.doc.docVersion),fixtureSHA256=createHash('sha256').update(text).digest('hex');
  await wait('new URLSearchParams(location.search).get("v")==='+JSON.stringify(documentVersion)+'&&!!vditor.__splitNavigation&&vditor.getValue().length>1000');
  for(const mode of ['ir','wysiwyg']){
   await fe('vditor.vditor.toolbar.elements["edit-mode"].querySelector(\'button[data-mode="'+mode+'"]\').click();true');await pause(220);
   await wait('vditor.vditor.currentMode==='+JSON.stringify(mode));
   await fe(`(()=>{const e=vditor.vditor,r=e[e.currentMode].element,w=document.createTreeWalker(r,NodeFilter.SHOW_TEXT),nodes=[],probe=document.createRange();let n;while(n=w.nextNode())if(n.length>2&&!n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview,.vditor-ir__marker')){probe.setStart(n,3);probe.collapse(true);if(probe.getBoundingClientRect().height>0)nodes.push(n);}n=nodes[Math.floor(nodes.length*.53)];if(!n)throw Error('No text node with a visible caret rectangle');r.focus();getSelection().collapse(n,3);n.parentElement.scrollIntoView({block:'center',inline:'center',behavior:'instant'});return true;})()`);await pause(120);
   const activeMarkdownSHA256=createHash('sha256').update(await fe('vditor.getValue()')).digest('hex');
   for(const caret of ['visible','offscreen']){
    if(caret==='offscreen')await fe('vditor.vditor[vditor.vditor.currentMode].element.scrollTop=0;true');
    const geometry=await fe(`(()=>{const e=vditor.vditor,p=e[e.currentMode].element.getBoundingClientRect(),s=getSelection(),r=s.rangeCount?s.getRangeAt(0).getBoundingClientRect():null;return{documentVersion:new URLSearchParams(location.search).get('v'),caret:r?.toJSON(),pane:p.toJSON(),caretVisible:!!(r&&r.height>0&&r.bottom>Math.max(0,p.top)&&r.top<Math.min(innerHeight,p.bottom)&&r.right>=Math.max(0,p.left)&&r.left<=Math.min(innerWidth,p.right))};})()`);
    assert.equal(geometry.documentVersion,documentVersion,'Benchmark must use the newly opened fixture');
    assert.equal(geometry.caretVisible,caret==='visible',name+' '+mode+' does not match its caret-visibility label');
    const result=await fe(`(()=>{const api=vditor,mode=api.vditor.currentMode,markdown=api.getValue(),times=[],points=[];let anchor;for(let i=0;i<8;i++){const start=performance.now();anchor=api.__splitNavigation.captureVisual(mode,markdown);times.push(performance.now()-start);points.push(anchor?.block?.points.length||0);}return{chars:markdown.length,times,points,offset:anchor?.offset,anchorKind:anchor?.block?.kind,sourceUnchanged:api.getValue()===markdown,errors:window.__completionErrors||[]};})()`);
    assert.equal(result.sourceUnchanged,true);assert.ok(Number.isFinite(result.offset));assert.deepEqual(result.errors,[]);
    const sorted=result.times.slice(1).sort((a,b)=>a-b);samples.push({name,mode,caret,documentVersion,fixtureSHA256,activeMarkdownSHA256,geometry,...result,medianMs:sorted[3],maxWarmMs:Math.max(...sorted)});
    fs.writeFileSync(path.join(output,'benchmark.json'),JSON.stringify({application,samples},null,2));console.log('BENCH '+name+' '+mode+' '+caret+' '+sorted[3].toFixed(1)+'ms');
   }
  }
  assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(global.doc.dirty,false);
 }
};
