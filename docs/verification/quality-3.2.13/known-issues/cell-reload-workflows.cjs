'use strict';
// Real More > Reload UI, passive authoritative onDoc, synthetic disk prefix.
// Installed 3.2.12 reaches this chain then fails; this regression tool does not claim a fix.
// No setMarkdown/setValue/reload IPC invocation by this probe, fake reload event or focus/range repair.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256}=require('../../../../tools/quality/lifecycle.cjs');
const {outputDir,frame,recorder,waitUntil,newWindow}=require('../../../../tools/quality/harness.cjs');
const SEED=32917,PREFIX='EXT\n',INITIAL='Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n';
const EXTERNAL=PREFIX+INITIAL,EDITED=EXTERNAL.replace('|a\\|b|KEEP|','|aR|KEEP|'),FINAL=EXTERNAL.replace('|a\\|b|KEEP|','|aR1|KEEP|');
const entry=(ok,message)=>{if(!ok)throw Error('ENTRY_UNCONFIRMED: '+message);};
function options(){const o=args(process.argv.slice(2));entry(o['expected-sha256']&&o.out,'Use --exe <file> --expected-sha256 <SHA> --out <new empty directory>');assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']));o['expected-sha256']=o['expected-sha256'].toLowerCase();return o;}
async function main(){
 const o=options(),id='active-cell-reverse-range-real-menu-reload-continue-history',filter=process.env.MP_QUALITY_CASES;entry(!filter||new RegExp(filter).test(id),'Filter selects the actual reload case');const dir=outputDir(o.out,'cell-reload-workflows'),result={schema:1,suite:'cell-reload-workflows',expectedCases:1,startedAt:new Date().toISOString(),seed:SEED,cases:[],errors:[],diagnostics:[],cleanupErrors:[],clipboard:{touched:false},
  transport:'Real Chromium toolbar/menu click and input; existing product reload route and passive onDoc only; no automatic-watcher/OS claim',
  contract:'extras.js:3107-3126 preserves history/caret through minimal non-history disk reload; toolbar.js:429-431; main.js:617-627; host.js:132-145',
  probe:{file:path.relative(ROOT,__filename).replaceAll('\\','/'),sha256:sha256(__filename)},sourceFiles:['dsh-markpilot/src-cm6/main.js','dsh-markpilot/src-cm6/extras.js','dsh-markpilot/src-cm6/toolbar.js','MarkPilot-CM6/main.js','MarkPilot-CM6/preload.js','MarkPilot-CM6/renderer/host.js'].map(file=>({file,sha256:sha256(path.join(ROOT,file))}))};
 const record=recorder(dir,result);let release,run;
 try{
  release=acquireSlot(ROOT);const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Owned cell reload synthetic probe\n');run=await launch(o,owner,dir);result.artifact=run.metadata;
  entry(typeof result.artifact.app?.version==='string'&&result.artifact.sourceMode===false&&result.artifact.asarSha256&&result.artifact.runtimeExecutableSha256,'actual tested executable/whole ASAR identity; version comes from artifact metadata');
  await record(id,async trace=>{
   const item=result.cases.at(-1);item.stage='fixture';item.productReached=false;const file=path.join(dir,'reload-cell-'+SEED+'.md');fs.writeFileSync(file,INITIAL);item.fixtureSha256=sha256(file);
   const p=await newWindow(run,run.page,file);p.on('pageerror',e=>result.errors.push(e.message));p.on('console',m=>{if(['error','warning'].includes(m.type()))result.diagnostics.push({type:m.type(),text:m.text().slice(0,1200)});});
   const read=()=>p.evaluate(()=>({...window.__qualityCellReload.read(),events:window.__qualityCellReload.events,docs:window.__qualityCellReload.docs}));
   const ownerOK=s=>s.cellFocus||s.cmFocus,received=(s,from,type)=>s.events.slice(from).filter(e=>e.type===type&&e.trusted);
   const key=(s,from,name,ctrl=false)=>received(s,from,'keydown').some(e=>e.key?.toLowerCase()===name.toLowerCase()&&e.ctrl===ctrl&&(e.inCell||e.inMaster));
   const capture=async name=>{const s=await read(),row={name,...s,disk:fs.readFileSync(file,'utf8'),diskSha256:sha256(file)};trace.push(row);row.screenshot=await frame(p,dir,name,s.cellFocus?{caret:'dom',allowMissingCaret:true,contextBox:s.overlayBox}:s.cmFocus?{}:{caret:'dom',allowMissingCaret:true,contextBox:s.cellBox});return row;};
   const exact=(s,text,range,visible,domRange,label)=>{assert.equal(s.text,text,label+' full source/neighbor preservation');assert.deepEqual(s.sourceSelection,range,label+' directional source range');assert(ownerOK(s),label+' real writable owner focus');if(s.cellFocus){assert(s.visible,label+' visible owned overlay');assert.equal(s.cellText,visible,label+' overlay content');assert.deepEqual(s.domSelection,domRange,label+' input/history boundary DOM range');}assert.equal(path.resolve(s.host.filePath),path.resolve(file),label+' original path');};
   try{
    await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&!!window.mpEngine?._view()),'owned fixture window');
    await p.evaluate(()=>{
     const events=[],docs=[],map=new WeakMap(),box=r=>r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:null;
     const read=()=>{const v=window.mpEngine._view(),el=document.querySelector('.mp-cell-overlay-text'),ae=document.activeElement,s=getSelection(),r=el?.getBoundingClientRect(),cell=document.querySelector('.mp-row td[data-mp-row="28"][data-mp-col="0"], .mp-row td[data-mp-row="24"][data-mp-col="0"]')?.getBoundingClientRect();
      const at=(node,n)=>{if(!el?.contains(node))return null;try{const q=document.createRange();q.selectNodeContents(el);q.setEnd(node,n);return q.toString().length;}catch{return null;}};
      const cmFocus=document.hasFocus()&&v.hasFocus&&v.contentDOM.contains(ae),cellFocus=document.hasFocus()&&!!el&&ae===el;return{text:v.state.doc.toString(),commandTrace:v.__mpCommandTrace,sourceSelection:{anchor:v.state.selection.main.anchor,head:v.state.selection.main.head},cmFocus,cellFocus,owner:cellFocus?'cell':cmFocus?'cm':'other',
       cellText:el?.textContent,domSelection:{anchor:at(s?.anchorNode,s?.anchorOffset),head:at(s?.focusNode,s?.focusOffset)},activeElement:{tag:ae?.tagName,class:ae?.className},visible:!!r&&r.width>0&&r.height>0,overlayBox:box(r),cellBox:box(cell),
       host:{documentId,filePath,dirty,saveTimer:!!saveTimer,saveTask:!!saveTask},toast:document.querySelector('.mp-toast')?.textContent||''};};
     window.__qualityCellReload={read,events,docs};
     window.mpHost.onDoc(payload=>docs.push({utc:Date.now(),payload:payload?{filePath:payload.filePath,documentId:payload.documentId,revision:payload.revision,loadKind:payload.loadKind,text:payload.text}:null,after:read()}));
     for(const type of ['mousedown','mouseup','click','keydown','keyup','beforeinput','input','focusin','focusout']){
      document.addEventListener(type,e=>{const v=window.mpEngine._view(),el=document.querySelector('.mp-cell-overlay-text'),menu=e.target.closest?.('.mp-pop-item');const row={type,trusted:e.isTrusted,key:e.key,code:e.code,ctrl:!!e.ctrlKey,shift:!!e.shiftKey,data:e.data,inputType:e.inputType,isComposing:e.isComposing??null,button:e.button,
       inMaster:v.contentDOM.contains(e.target),inCell:!!el?.contains(e.target),more:!!e.target.closest?.('.mp-tb-item[data-mp-id="more"]'),reloadItem:!!menu&&menu.querySelector('span')?.textContent==='重新加载',target:{tag:e.target?.tagName,class:e.target?.className},defaultPrevented:e.defaultPrevented,at:performance.now(),before:read(),bubbleSeen:false};events.push(row);map.set(e,row);
      },{capture:true,passive:true});document.addEventListener(type,e=>{const row=map.get(e);if(row)Object.assign(row,{bubbleSeen:true,defaultPreventedAfter:e.defaultPrevented,after:read()});},{passive:true});
     }
    }); // Passive product events; no bridge replacement, fabricated event or DOM selection changes.
    const fresh=await capture('01-fresh');entry(fresh.text===INITIAL&&!fresh.host.dirty&&!fresh.host.saveTimer&&!fresh.host.saveTask,'clean original file, no pending save can overwrite the external prefix');
    item.stage='reverse-cell-entry';await p.locator('.mp-row td[data-mp-row="24"][data-mp-col="0"]').click({delay:65});await waitUntil(()=>p.evaluate(()=>window.__qualityCellReload.read().cellFocus),'real clicked cell').catch(e=>entry(false,e.message));
    await p.keyboard.press('Home');for(let i=0;i<3;i++)await p.keyboard.press('ArrowRight');await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');}finally{await p.keyboard.up('Shift');}
    const selected=await capture('02-reverse-selected');entry(selected.text===INITIAL&&selected.cellFocus&&selected.visible&&selected.cellText==='a|b'&&selected.domSelection.anchor===3&&selected.domSelection.head===1&&key(selected,fresh.events.length,'Home')&&received(selected,fresh.events.length,'keydown').filter(e=>e.inCell&&e.key==='ArrowRight').length===3&&received(selected,fresh.events.length,'keydown').filter(e=>e.inCell&&e.key==='ArrowLeft'&&e.shift).length===2,'real reverse DOM3/1 over literal |b in escaped-pipe cell');
    entry(!selected.host.dirty&&!selected.host.saveTimer&&!selected.host.saveTask,'selection did not dirty the file or queue autosave');
    trace.push({name:'conceptual-selection-before-reload',expectedRawSource:{anchor:29,head:26},observed: selected.sourceSelection,expectedAfterPrefix:{anchor:33,head:30},limitation:'Final Arrow default action may legally leave CM source lagging until a real action/input boundary; no dummy key or clipboard sync is inserted'});
    item.stage='external-disk';fs.writeFileSync(file,EXTERNAL);trace.push({name:'external-prefix-written',file,source:EXTERNAL,sha256:sha256(file),prefix:PREFIX});
    item.stage='real-reload-menu';await p.locator('.mp-tb-item[data-mp-id="more"]').click({delay:65});await p.locator('.mp-pop-item').getByText('重新加载',{exact:true}).click({delay:65});
    try{await waitUntil(async()=>{const s=await read();return s.docs.some(d=>d.payload?.filePath===file&&d.payload.documentId!==selected.host.documentId&&d.payload.text===EXTERNAL);},'real authoritative same-file reload document push',5000);}catch(e){const s=await capture('reload-unconfirmed');const pushed=s.docs.some(d=>d.payload?.filePath===file&&d.payload.documentId!==selected.host.documentId);if(pushed){item.productReached=true;assert.fail('Actual reload reached this document but delivered wrong prefix/source: '+e.message);}entry(false,'No authoritative same-file reload response; '+e.message);}
    const invoked=await read();entry(received(invoked,selected.events.length,'mousedown').some(e=>e.more)&&received(invoked,selected.events.length,'click').some(e=>e.reloadItem),'trusted More/Reload menu entry was actually used');
    item.productReached=true;item.stage='reload-immediate-R';const load=invoked.docs.findLast(d=>d.payload?.filePath===file&&d.payload.documentId!==selected.host.documentId&&d.payload.text===EXTERNAL),from=invoked.events.length;
    // The target has been reached. Do not reject wrong owner/range as unconfirmed or repair it.
    await p.keyboard.insertText('R');await sleep(120);const edited=await capture('03-reload-immediate-R');item.reloadEvidence=load;
    assert.equal(load.payload.loadKind,'reload','actual menu uses reload semantic route');assert.equal(load.after.text,EXTERNAL,'product applied the authoritative external source');
    assert(ownerOK(load.after),'actual reload preserves/transfers writable editing focus without user repair');
    assert(received(edited,from,'input').some(e=>e.data==='R'&&!e.isComposing&&(e.inCell||e.inMaster)),'After actual reload the immediate R must reach the document owner; absence is product-check');
    exact(edited,EDITED,{anchor:31,head:31},'aR',{anchor:2,head:2},'reload replacement R');
    item.stage='undo';const undoFrom=edited.events.length;await p.keyboard.press('Control+z');await sleep(120);const undone=await capture('04-undo');assert(key(undone,undoFrom,'z',true),'real owner Undo after reached product target');exact(undone,EXTERNAL,{anchor:33,head:30},'a|b',{anchor:3,head:1},'Undo preserves external prefix and reverse selection');
    item.stage='redo-immediate-one';const redoFrom=undone.events.length;await p.keyboard.press('Control+y');await p.keyboard.press('1'); // No read/wait/frame or repair between Redo and continued digit.
    await sleep(120);const continued=await capture('06-continued-one'),redo=received(continued,redoFrom,'keyup').find(e=>e.ctrl&&e.key?.toLowerCase()==='y'&&(e.inCell||e.inMaster));assert(key(continued,redoFrom,'y',true)&&redo,'real Redo boundary after reached product target');trace.push({name:'05-passive-redo-before-one',state:redo.before});exact(redo.before,EDITED,{anchor:31,head:31},'aR',{anchor:2,head:2},'passive Redo boundary');
    assert(key(continued,redoFrom,'1')&&received(continued,redoFrom,'input').some(e=>e.data==='1'&&!e.isComposing&&(e.inCell||e.inMaster)),'immediate digit reached existing owner');exact(continued,FINAL,{anchor:32,head:32},'aR1',{anchor:3,head:3},'continued one');
    item.stage='disk';await waitUntil(()=>fs.readFileSync(file).equals(Buffer.from(FINAL)),'exact UTF-8 LF autosave',5000);const saved=await capture('07-saved');assert.equal(saved.disk,FINAL);exact(saved,FINAL,{anchor:32,head:32},'aR1',{anchor:3,head:3},'saved');
    item.stage='complete';return{initial:INITIAL,external:EXTERNAL,edited:EDITED,final:FINAL,realUIReload:true,automaticWatcherTested:false,clipboardTouched:false,finalSha256:saved.diskSha256};
   }catch(e){try{await capture('failure-'+item.stage);}catch(x){trace.push({name:'failure-capture-error',error:x.message});}throw e;}
  });
  const c=result.cases.at(-1);if(c.error?.startsWith('ENTRY_UNCONFIRMED:')&&!c.productReached)c.status='entry-unconfirmed';else if(c.status==='fail')c.failureKind=c.productReached?'product-check':'harness-or-setup';
 }catch(e){result.fatal=e.stack||e.message;}
 finally{try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupErrors.push('owned cleanup: '+e.message);}try{release?.();}catch(e){result.cleanupErrors.push('slot: '+e.message);}result.finishedAt=new Date().toISOString();result.passed=result.cases.length===1&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length;result.verdict=result.cases.some(c=>c.status==='entry-unconfirmed')?'ENTRY_UNCONFIRMED':result.passed?'cell-reload-chain-pass':'chain-or-suite-failure';fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));}
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
