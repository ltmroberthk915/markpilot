'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const {launch,acquireSlot,sleep,sha256}=require(path.join(ROOT,'tools/quality/lifecycle.cjs'));
const {frame,waitUntil,newWindow,outputDir}=require(path.join(ROOT,'tools/quality/harness.cjs'));
const a=process.argv.slice(2),opt=k=>a.includes(k)?a[a.indexOf(k)+1]:null;
const expectFixed=true;
const dir=outputDir(opt('--out'),'autosave-liveness');
const EXE=opt('--exe');
assert(EXE&&opt('--expected-sha256'),'explicit executable and SHA256 required');
const INITIAL='Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const result={schema:1,suite:'autosave-liveness-workflows',kind:'actual-ui-probe',startedAt:new Date().toISOString(),transport:'Supported Chromium CDP composition/cancel; no synthetic DOM events; OS IME unverified',cases:[],frames:[],errors:[],cleanupErrors:[],clipboard:{touched:false},probe:{file:path.relative(ROOT,__filename),sha256:sha256(__filename)}};
let run,release;
async function read(p){return p.evaluate(async()=>{const v=window.mpEngine._view(),el=document.querySelector('.mp-cell-overlay-text'),sel=v.state.selection.main,dom=getSelection();const offset=(node,at)=>{if(!el?.contains(node))return null;const range=document.createRange();range.selectNodeContents(el);range.setEnd(node,at);return range.toString().length;};return{text:v.state.doc.toString(),selection:{anchor:sel.anchor,head:sel.head},domSelection:dom?{anchor:offset(dom.anchorNode,dom.anchorOffset),head:offset(dom.focusNode,dom.focusOffset)}:null,active:document.activeElement?.className,hasFocus:document.hasFocus(),cmFocus:document.hasFocus()&&v.hasFocus,cellFocus:document.hasFocus()&&el===document.activeElement,cellText:el?.textContent,viewComposing:v.composing,commandsAllowed:!!window.mpEngine.commands.capture({flush:false}),host:{dirty,timerArmed:!!saveTimer,inFlight:saveInFlight,revision,documentId,autoGeneration,policy:savePolicy,lastSaveError,saveBlocked},scroll:{top:v.scrollDOM.scrollTop,left:v.scrollDOM.scrollLeft},doc:await window.mpHost.currentDoc(),events:window.__autoEvents,saveTrace:window.__mpDbg?.saveTrace};});}
(async()=>{try{
  const initial=INITIAL,settings={theme:'light'};
  release=acquireSlot(ROOT);const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Owned autosave liveness probe\n');
  run=await launch({exe:EXE,'expected-sha256':opt('--expected-sha256'),settings:{...settings,restoreLast:false,autosaveEnabled:true,autosaveIntervalMs:1000,winBounds:{width:1100,height:800,x:50,y:50}}},owner,dir);
  result.artifact=run.metadata;
  const tracked=new WeakSet();
  const track=p=>{if(tracked.has(p))return;tracked.add(p);p.on('pageerror',e=>result.errors.push({page:p.url(),message:e.message}));};
  run.browser.contexts().forEach(c=>{c.pages().forEach(track);c.on('page',track);});
  for(const mode of ['cell','cm']){
    const file=path.join(dir,mode+'-book-copy.md');fs.writeFileSync(file,initial);const p=await newWindow(run,run.page,file),item={id:mode+'-autosave-cancel-settled',status:'running',mode,file,frames:[]};result.cases.push(item);
    await p.bringToFront();await waitUntil(async()=>{const s=await read(p);return s.text===initial&&s.cmFocus&&s.host.policy.enabled&&s.host.policy.intervalMs===1000;},'loaded exact corpus, real initial focus and explicit opt-in policy');
    await p.evaluate(()=>{window.__autoEvents=[];for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','blur','mousedown','mouseup','mousemove'])document.addEventListener(type,e=>window.__autoEvents.push({type,trusted:e.isTrusted,inputType:e.inputType,isComposing:e.isComposing??null,data:e.data,key:e.key,ctrl:!!e.ctrlKey,shift:!!e.shiftKey,target:e.target?.className,at:performance.now()}),{capture:true,passive:true});});
    await p.keyboard.press('Control+End');await sleep(160);
    if(mode==='cell'){
      const rowFrom=initial.lastIndexOf('|a\\|b|KEEP|');item.rowFrom=rowFrom;
      await p.locator('.mp-row td[data-mp-row="'+rowFrom+'"][data-mp-col="0"]').click({delay:65});
      // Prove the reported boundary independently: one visible step is after a.
      await p.keyboard.press('Home');await p.keyboard.press('ArrowRight');
      item.beforePipe=await read(p);assert(item.beforePipe.cellFocus);
      assert.deepEqual(item.beforePipe.domSelection,{anchor:1,head:1});
      await p.keyboard.insertText('R');await sleep(90);item.beforePipeEntered=await read(p);
      assert.equal(item.beforePipeEntered.text,initial.replace('|a\\|b|KEEP|','|aR\\|b|KEEP|'),'typing before visible pipe stays before escaped source pipe');
      item.frames.push(await frame(p,dir,'cell-00-before-pipe',{caret:'dom'}));
      await p.keyboard.press('Control+z');await sleep(150);assert.equal((await read(p)).text,initial);
      await waitUntil(()=>fs.readFileSync(file,'utf8')===initial,'boundary proof restores original disk',4500);
      await p.keyboard.press('Home');await p.keyboard.press('ArrowRight');await p.keyboard.press('ArrowRight');
      // keydown precedes native caret movement; selectionchange updates CM later.
      // Two visible steps in a|b are after |: source offset is rowFrom + 4.
      await waitUntil(async()=>{const s=await read(p);return s.cellFocus&&s.domSelection?.anchor===2&&s.domSelection.head===2&&s.selection.anchor===rowFrom+4&&s.selection.head===rowFrom+4;},'native DOM caret and source selection settle after escaped pipe');
    }
    const start=await read(p);item.start=start;assert(mode==='cell'?start.cellFocus:start.cmFocus,'native input owner has focus');
    assert.equal(start.selection.anchor,start.selection.head);
    await p.keyboard.insertText('R');await sleep(90);const entered=await read(p);
    const expected=mode==='cell'?initial.replace('|a\\|b|KEEP|','|a\\|Rb|KEEP|'):initial+'R';assert.equal(entered.text,expected,'native R exact source at independently specified visible caret');
    await waitUntil(()=>fs.readFileSync(file,'utf8')===expected,'ordinary R saves once',4500);item.positive=await read(p);
    await p.keyboard.press('Control+z');await sleep(150);assert.equal((await read(p)).text,initial,'Undo restores exact corpus');
    await waitUntil(()=>fs.readFileSync(file,'utf8')===initial,'Undo autosaves exact original copy',4500);
    await p.keyboard.insertText('R');const cdp=await p.context().newCDPSession(p);
    try{
      await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});await sleep(100);item.started=await read(p);
      assert(item.started.events.some(e=>e.type==='compositionstart'&&e.trusted),'trusted Chromium composition start');assert.equal(item.started.commandsAllowed,false,'unfinished composition refuses capture');
      await sleep(2300);item.timerElapsed={state:await read(p),disk:fs.readFileSync(file,'utf8')};assert.equal(item.timerElapsed.disk,initial,'blocked composition writes neither R nor preedit');
      item.frames.push(await frame(p,dir,mode+'-01-pending',{caret:mode==='cell'?'dom':undefined,allowMissingCaret:true}));
      await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await sleep(550);item.canceled={state:await read(p),disk:fs.readFileSync(file,'utf8')};
      item.frames.push(await frame(p,dir,mode+'-02-canceled',{caret:mode==='cell'?'dom':undefined,allowMissingCaret:true}));
      await sleep(2300);item.idle={state:await read(p),disk:fs.readFileSync(file,'utf8')};
      item.sourceRetained=item.idle.state.text===expected;item.autosaveResumed=item.idle.disk===expected;
      item.compositionEndTrust=item.idle.state.events.filter(e=>e.type==='compositionend').map(e=>e.trusted);
      const cancelEvents=item.idle.state.events.slice(item.started.events.length);
      item.supportedCancelReached=item.idle.state.commandsAllowed&&item.sourceRetained&&cancelEvents.some(e=>e.type==='compositionupdate'&&e.trusted&&e.data==='')&&cancelEvents.some(e=>e.type==='beforeinput'&&e.trusted&&e.inputType==='insertCompositionText'&&e.data==='')&&cancelEvents.some(e=>e.type==='input'&&e.trusted&&e.inputType==='insertCompositionText'&&e.data==null);
      item.confirmedSchedulingFailure=item.supportedCancelReached&&item.idle.state.host.policy.enabled&&item.idle.state.host.dirty&&!item.idle.state.host.timerArmed&&!item.autosaveResumed;
      assert(item.supportedCancelReached,'supported CDP cancel reached input owner');
      if(expectFixed){
        assert(item.autosaveResumed,'committed R eventually saved after canceled composition');
        assert.equal(item.idle.state.host.dirty,false,'accurate save clears dirty');assert.equal(item.idle.state.host.timerArmed,false,'clean state stops timer');
        assert.deepEqual(item.idle.state.selection,item.canceled.state.selection,'background save preserves caret');assert.deepEqual(item.idle.state.scroll,item.canceled.state.scroll,'background save preserves viewport');assert(mode==='cell'?item.idle.state.cellFocus:item.idle.state.cmFocus,'background save preserves input focus');
      }
      item.frames.push(await frame(p,dir,mode+'-03-saved',{caret:mode==='cell'?'dom':undefined,allowMissingCaret:true}));
      if(mode==='cell'){
        const drag=await p.evaluate(()=>{const el=document.querySelector('.mp-cell-overlay-text'),n=el?.firstChild;if(!n||n.nodeType!==3)return null;const r=document.createRange();r.setStart(n,2);r.setEnd(n,3);const b=r.getBoundingClientRect();return {x:b.left,y:(b.top+b.bottom)/2,end:b.right};});
        assert(drag&&drag.end>drag.x,'R has an actual character box');
        await p.mouse.move(drag.x+.1,drag.y);await p.mouse.down();await p.mouse.move(drag.end-.1,drag.y,{steps:5});await p.mouse.up();await sleep(100);
        item.dragSelection=await p.evaluate(()=>getSelection()?.toString());assert(item.dragSelection?.includes('R'),'real drag selects committed R');
        assert((await read(p)).cellFocus,'drag leaves real input focus');await p.keyboard.press('Shift+ArrowRight');
        item.extendedSelection=await p.evaluate(()=>getSelection()?.toString());assert(item.extendedSelection.includes('R'),'keyboard and mouse preserve selected committed R');
        const gestures=(await read(p)).events;
        assert(gestures.some(e=>e.type==='mousedown'&&e.trusted&&e.target==='mp-cell-overlay-text')&&gestures.some(e=>e.type==='mouseup'&&e.trusted&&e.target==='mp-cell-overlay-text'),'trusted mouse drag reached cell owner');
        assert.equal((await read(p)).text,expected,'selection gestures never modify source');
      }
      const historyFocus=await read(p);assert(mode==='cell'?historyFocus.cellFocus:historyFocus.cmFocus,'actual focus before undo');
      await p.keyboard.press('Control+z');await sleep(150);assert.equal((await read(p)).text,initial,'autosave adds no undo step and canceled preedit leaves no source');
      await waitUntil(()=>fs.readFileSync(file,'utf8')===initial,'Undo accurately autosaves',4500);
      await p.keyboard.press('Control+y');await sleep(150);assert.equal((await read(p)).text,expected,'Redo restores committed R');
      await waitUntil(()=>fs.readFileSync(file,'utf8')===expected,'Redo accurately autosaves',4500);
      item.history=await read(p);item.gestureChannels=mode==='cell'?['keyboard','mouse','combination','keyboard-mouse','drag']:['keyboard','combination'];
      item.completed=true;item.status='pass';console.log(JSON.stringify({mode,sourceRetained:item.sourceRetained,autosaveResumed:item.autosaveResumed,supportedCancelReached:item.supportedCancelReached,compositionEndTrust:item.compositionEndTrust,confirmedSchedulingFailure:item.confirmedSchedulingFailure}));
    }finally{try{await cdp.detach();}catch(e){result.cleanupErrors.push('CDP detach: '+e.message);}}
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  }
}catch(e){result.fatal=e.stack;if(result.cases.length){result.cases.at(-1).status='fail';result.cases.at(-1).error=e.message;}process.exitCode=1;}finally{try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupErrors.push('app cleanup: '+e.message);}release?.();result.finishedAt=new Date().toISOString();result.passed=result.cases.length===2&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length;if(!result.passed)process.exitCode=1;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,error:result.fatal,cleanup:result.cleanup}));}})();
