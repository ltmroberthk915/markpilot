'use strict';
// Actual split source click transfers editing ownership from an active escaped-pipe cell.
// Table target and independent plain-body positive control each start in a fresh renderer.
// Source pane is read-only: real click transfers editing ownership; never repair focus/ranges.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,frame,recorder,waitUntil,newWindow}=require('./harness.cjs');
const SEED=32917,INITIAL='Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n';
const ARMS=[
 {kind:'table',id:'active-cell-source-pane-click-immediate-edit-history-continue',pos:28,char:'b',edited:INITIAL.replace('|a\\|b|KEEP|','|a\\|Rb|KEEP|'),final:INITIAL.replace('|a\\|b|KEEP|','|a\\|R1b|KEEP|')},
 {kind:'plain',id:'active-cell-source-pane-plain-click-immediate-edit-history-continue',pos:INITIAL.indexOf('After')+3,char:'e',edited:INITIAL.replace('After','AftRer'),final:INITIAL.replace('After','AftR1er')}
];
const entry=(ok,message)=>{if(!ok)throw Error('ENTRY_UNCONFIRMED: '+message);};
function options(){const o=args(process.argv.slice(2));entry(o['expected-sha256']&&o.out,'Use --exe <file> --expected-sha256 <SHA256> --out <new empty directory>');assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']));o['expected-sha256']=o['expected-sha256'].toLowerCase();return o;}
async function main(){
 const o=options(),dir=outputDir(o.out,'split-source-workflows'),filter=process.env.MP_QUALITY_CASES,arms=ARMS.filter(a=>!filter||new RegExp(filter).test(a.id));entry(arms.length,'Filter selects an actual split source case');
 const result={schema:1,suite:'split-source-workflows',expectedCases:arms.length,requestedCases:arms.map(a=>a.id),startedAt:new Date().toISOString(),seed:SEED,cases:[],errors:[],diagnostics:[],cleanupErrors:[],clipboard:{touched:false},
  transport:'Trusted Chromium renderer mouse/keyboard input; no OS physical input claim',probe:{file:path.relative(ROOT,__filename).replaceAll('\\','/'),sha256:sha256(__filename)},
  sourceFiles:['dsh-markpilot/src-cm6/main.js','dsh-markpilot/src-cm6/splitview.js','dsh-markpilot/src-cm6/cell-source-map.js','MarkPilot-CM6/renderer/host.js'].map(file=>({file,sha256:sha256(path.join(ROOT,file))}))};
 const record=recorder(dir,result);let release,run;
 try{
  release=acquireSlot(ROOT);const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Owned split-view synthetic probe\n');run=await launch(o,owner,dir);result.artifact=run.metadata;
  entry(typeof result.artifact.app?.version==='string'&&result.artifact.sourceMode===false&&/^[a-f0-9]{64}$/i.test(result.artifact.asarSha256)&&/^[a-f0-9]{64}$/i.test(result.artifact.runtimeExecutableSha256),'actual executable and whole ASAR identity; version is read from the tested artifact');
  for(const arm of arms){const POS=arm.pos,EDITED=arm.edited,FINAL=arm.final;await record(arm.id,async trace=>{
   const item=result.cases.at(-1);item.productReached=false;item.stage='fixture';item.target=arm.kind;const file=path.join(dir,'split-'+arm.kind+'-'+SEED+'.md');fs.writeFileSync(file,INITIAL);item.fixtureSha256=sha256(file);
   const p=await newWindow(run,run.page,file);p.on('pageerror',e=>result.errors.push(e.message));p.on('console',m=>{if(['warning','error'].includes(m.type()))result.diagnostics.push({type:m.type(),text:m.text().slice(0,1200)});});
   const read=()=>p.evaluate(()=>({...window.__qualitySplitCell.read(),events:window.__qualitySplitCell.events}));
   const capture=async name=>{const s=await read(),row={name,...s,disk:fs.readFileSync(file,'utf8'),diskSha256:sha256(file)};trace.push(row);
    row.screenshot=await frame(p,dir,arm.kind+'-'+name,s.cellFocus?{caret:'dom',allowMissingCaret:true,contextBox:s.overlayBox}:s.cmFocus?{}:{caret:'dom',allowMissingCaret:true,contextBox:s.paneBox});return row;};
   const received=(s,from,type)=>s.events.slice(from).filter(e=>e.type===type&&e.trusted);
   const actualKey=(s,from,key,ctrl=false)=>received(s,from,'keydown').some(e=>e.key?.toLowerCase()===key.toLowerCase()&&e.ctrl===ctrl&&(e.inMaster||e.inCell));
   const owner=s=>s.cmFocus||s.cellFocus;
   const exact=(s,text,at,visible,domAt,label)=>{
    assert.equal(s.text,text,label+' full source / neighbors');assert.deepEqual(s.sourceSelection,{anchor:at,head:at},label+' directional source caret');assert(owner(s),label+' actual writable owner focus');if(arm.kind==='plain')assert(s.cmFocus&&!s.cellFocus&&!s.visible,label+' plain target belongs to master CM, with the old cell overlay retired');
    assert(s.pane.open&&s.pane.readOnly&&s.pane.sameText,label+' source pane shares current immutable Text');assert.equal(s.pane.text,text,label+' source pane text');
    if(s.cellFocus){assert(s.visible,label+' owned overlay is visible');assert.equal(s.cellText,visible,label+' owned overlay text');assert.deepEqual(s.domSelection,{anchor:domAt,head:domAt},label+' input/history boundary DOM caret');}
   };
   try{
    await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&!!window.mpEngine?._view()),'owned fixture window');
    await p.evaluate(()=>{
     const events=[],map=new WeakMap(),box=r=>r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:null;
     const read=()=>{const v=window.mpEngine._view(),b=window.mpSplit?._slave(),el=document.querySelector('.mp-cell-overlay-text'),ae=document.activeElement,s=getSelection(),r=el?.getBoundingClientRect(),pane=document.querySelector('.mp-split-pane')?.getBoundingClientRect();
      const at=(node,n)=>{if(!el?.contains(node))return null;try{const q=document.createRange();q.selectNodeContents(el);q.setEnd(node,n);return q.toString().length;}catch{return null;}};
      const cmFocus=document.hasFocus()&&v.hasFocus&&v.contentDOM.contains(ae),cellFocus=document.hasFocus()&&!!el&&ae===el;
      return{text:v.state.doc.toString(),sourceSelection:{anchor:v.state.selection.main.anchor,head:v.state.selection.main.head},cmFocus,cellFocus,owner:cellFocus?'cell':cmFocus?'cm':'other',
       activeElement:{tag:ae?.tagName,class:ae?.className},cellText:el?.textContent,domSelection:{anchor:at(s?.anchorNode,s?.anchorOffset),head:at(s?.focusNode,s?.focusOffset)},visible:!!r&&r.width>0&&r.height>0,overlayBox:box(r),paneBox:box(pane),
       pane:{open:!!b,readOnly:b?.state.readOnly,sameText:b?.state.doc===v.state.doc,text:b?.state.doc.toString()}};};
     window.__qualitySplitCell={events,read};
     for(const type of ['mousedown','mouseup','click','keydown','keyup','beforeinput','input','focusin','focusout']){
      document.addEventListener(type,e=>{const v=window.mpEngine._view(),b=window.mpSplit?._slave(),el=document.querySelector('.mp-cell-overlay-text');let sourceHit=null;const inSlave=!!b?.dom.contains(e.target);
       if(inSlave&&['mousedown','mouseup','click'].includes(type))try{sourceHit=b.posAtCoords({x:e.clientX,y:e.clientY});}catch{}
       const row={type,trusted:e.isTrusted,key:e.key,code:e.code,ctrl:!!e.ctrlKey,shift:!!e.shiftKey,inputType:e.inputType,data:e.data,isComposing:e.isComposing??null,button:e.button,buttons:e.buttons,x:e.clientX,y:e.clientY,
        target:{tag:e.target?.tagName,class:e.target?.className},inMaster:v.contentDOM.contains(e.target),inCell:!!el?.contains(e.target),inSlave,sourceHit,defaultPrevented:e.defaultPrevented,at:performance.now(),before:read(),bubbleSeen:false};map.set(e,row);events.push(row);
      },{capture:true,passive:true});
      document.addEventListener(type,e=>{const row=map.get(e);if(row)Object.assign(row,{bubbleSeen:true,defaultPreventedAfter:e.defaultPrevented,after:read()});},{passive:true});
     }
    }); // Only passive events and read-only Range geometry, not selection/focus mutation.
    entry((await capture('01-fresh')).text===INITIAL,'exact fresh synthetic source');
    item.stage='split-entry';await p.locator('.mp-tb-item[data-mp-id="split"]').click({delay:65});await waitUntil(()=>p.evaluate(()=>window.__qualitySplitCell.read().pane.open),'actual split toolbar click').catch(e=>entry(false,e.message));
    const opened=await capture('02-source-pane');entry(opened.pane.readOnly&&opened.pane.sameText&&opened.pane.text===INITIAL&&opened.text===INITIAL,'actual read-only source pane mirrors this fixture');
    item.stage='cell-entry';await p.locator('.mp-row td[data-mp-row="24"][data-mp-col="0"]').click({delay:65});await waitUntil(()=>p.evaluate(()=>window.__qualitySplitCell.read().cellFocus),'actual clicked cell focus').catch(e=>entry(false,e.message));
    const cell=await capture('03-active-cell');entry(cell.text===INITIAL&&cell.cellFocus&&cell.visible&&cell.cellText==='a|b'&&received(cell,opened.events.length,'mousedown').some(e=>e.button===0&&e.inMaster),'real active col0 overlay, not stale focus from another surface');
    const point=await p.evaluate(pos=>{const b=window.mpSplit._slave(),r=b.coordsAtPos(pos),sc=b.scrollDOM.getBoundingClientRect();if(!r)return null;const x=r.left+.1,y=(r.top+r.bottom)/2;return{x,y,box:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},hit:b.posAtCoords({x,y}),char:b.state.doc.sliceString(pos,pos+1),visible:x>=sc.left&&x<sc.right&&y>=sc.top&&y<sc.bottom};},POS);
    trace.push({name:'calibrated-'+arm.kind+'-'+arm.char+'-left-point',seed:SEED,sourcePos:POS,point,method:'Actual readonly CM coordsAtPos('+POS+'), left+0.1; no synthetic caret or source dispatch'});
    entry(point?.visible&&point.char===arm.char&&point.hit===POS,'calibrated '+arm.kind+' '+arm.char+'-left coordinate hits exactly source'+POS);
    item.stage='source-click-immediate-R';const from=cell.events.length;
    await p.mouse.click(point.x,point.y,{delay:65});await p.keyboard.insertText('R'); // No read/wait/frame/repair between source click and input.
    await sleep(120);const edited=await capture('04-immediate-R');
    const down=received(edited,from,'mousedown').find(e=>e.inSlave&&e.button===0&&e.sourceHit===POS),up=received(edited,from,'mouseup').find(e=>e.inSlave&&e.sourceHit===POS&&e.after);
    const boundary=received(edited,from,'beforeinput').find(e=>e.data==='R'&&!e.isComposing&&(e.inMaster||e.inCell)),input=received(edited,from,'input').find(e=>e.data==='R'&&!e.isComposing&&(e.inMaster||e.inCell));
    entry(down&&up,'trusted readonly mousedown/up actually reached the calibrated '+arm.kind+' target source'+POS);
    item.productReached=true;item.inputBoundary={down,up,beforeinput:boundary,input};
    assert.equal(up.after.text,INITIAL,'source click does not change Markdown');
    assert(owner(up.after),'actual source click transfers focus to a writable owner');
    assert.deepEqual(up.after.sourceSelection,{anchor:POS,head:POS},'source click transfers exact target range '+POS);
    assert(boundary&&input&&boundary.before.text===INITIAL&&boundary.before.sourceSelection.anchor===POS&&boundary.before.sourceSelection.head===POS&&owner(boundary.before),'immediate trusted R reaches the proven writable owner at '+POS);
    exact(edited,EDITED,POS+1,'a|Rb',3,'immediate R');
    item.stage='undo';const undoFrom=edited.events.length;await p.keyboard.press('Control+z');await sleep(120);const undone=await capture('05-undo');assert(actualKey(undone,undoFrom,'z',true),'trusted Undo on actual editing owner');exact(undone,INITIAL,POS,'a|b',2,'Undo');
    item.stage='redo-immediate-one';const redoFrom=undone.events.length;
    await p.keyboard.press('Control+y');await p.keyboard.press('1'); // No read/wait/frame/repair between Redo and digit.
    await sleep(120);const continued=await capture('07-continued-one'),redo=received(continued,redoFrom,'keyup').find(e=>e.key?.toLowerCase()==='y'&&e.ctrl&&(e.inMaster||e.inCell));
    assert(actualKey(continued,redoFrom,'y',true)&&redo,'trusted Redo keyup recorded passively before immediate digit');trace.push({name:'06-passive-redo-boundary',state:redo.before,limitation:'No frame/read or action inserted between ControlY and 1'});exact(redo.before,EDITED,POS+1,'a|Rb',3,'passive Redo boundary');
    assert(actualKey(continued,redoFrom,'1')&&received(continued,redoFrom,'input').some(e=>e.data==='1'&&!e.isComposing&&(e.inMaster||e.inCell)),'true continued digit reaches the actual editing owner');exact(continued,FINAL,POS+2,'a|R1b',4,'continued 1');
    item.stage='disk';await waitUntil(()=>fs.readFileSync(file).equals(Buffer.from(FINAL)),'exact UTF-8 LF autosave',5000);const saved=await capture('08-saved');assert.equal(saved.disk,FINAL);exact(saved,FINAL,POS+2,'a|R1b',4,'saved');
    item.stage='complete';return{initial:INITIAL,edited:EDITED,final:FINAL,target:arm.kind,sourcePoint:POS,legalOwners:arm.kind==='plain'?['cm']:['cm','cell'],clipboardTouched:false,finalSha256:saved.diskSha256};
   }catch(e){try{await capture('failure-'+item.stage);}catch(x){trace.push({name:'failure-capture-error',error:x.message});}throw e;}
  });
  const c=result.cases.at(-1);if(c.error?.startsWith('ENTRY_UNCONFIRMED:')&&!c.productReached)c.status='entry-unconfirmed';else if(c.status==='fail')c.failureKind=c.productReached?'product-check':'harness-or-setup';
  }
 }catch(e){result.fatal=e.stack||e.message;}
 finally{
  try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupErrors.push('owned cleanup: '+e.message);}try{release?.();}catch(e){result.cleanupErrors.push('slot: '+e.message);}
  result.finishedAt=new Date().toISOString();result.passed=result.cases.length===result.expectedCases&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length;
  result.verdict=result.cases.some(c=>c.status==='entry-unconfirmed')?'ENTRY_UNCONFIRMED':result.passed?'split-source-chain-pass':'chain-or-suite-failure';fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
 }
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
