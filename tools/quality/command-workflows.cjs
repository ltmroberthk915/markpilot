'use strict';
// Actual asynchronous custom-menu cut with independent source/clipboard oracles.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
function repositoryRoot(start){let p=fs.realpathSync(start);for(;;){if(fs.existsSync(path.join(p,'tools/quality/lifecycle.cjs'))&&fs.existsSync(path.join(p,'MarkPilot-CM6/main.js')))return p;const q=path.dirname(p);if(q===p)throw Error('Repository not found');p=q;}}
const ROOT=repositoryRoot(__dirname),quality=path.join(ROOT,'tools/quality');
const {args,launch,acquireSlot,sha256}=require(path.join(quality,'lifecycle.cjs'));
const {outputDir,recorder,waitUntil,frame}=require(path.join(quality,'harness.cjs'));
const clipboard=require(path.join(quality,'clipboard.cjs'));
const BASE='ALPHA\nOMEGA\n',SECOND='SECOND\n',DELAY=2000;
async function main(){
 const o=args(process.argv.slice(2));assert(o.exe&&!o.app&&!o.electron,'Actual EXE/ASAR required');assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']||''),'Explicit executable hash required');
 const dir=outputDir(o.out,'command-workflows'),result={schema:1,suite:'command-workflows',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),dependencySha256:Object.fromEntries(['lifecycle.cjs','harness.cjs','clipboard.cjs','windows-clipboard.ps1'].map(f=>[f,sha256(path.join(quality,f))])),cases:[],frames:[],artifacts:[],errors:[],cleanupErrors:[],clipboard:{touched:false},hook:{flag:'MP_TEST_CLIPBOARD_DELAY_MS',milliseconds:DELAY,barrier:'main-debug.log clipboardWrite:start count increment; no fixed sleep'},transport:'trusted Chromium keyboard/mouse input; actual shell IPC for document replacement'};
 const record=recorder(dir,result),wanted=id=>!process.env.MP_QUALITY_CASES||new RegExp(process.env.MP_QUALITY_CASES).test(id);
 let release,clip;
 try{
  release=acquireSlot(ROOT);clip=await clipboard.hold();result.clipboard={touched:true,...clip.metadata};
  for(const mode of ['normal','selection-race','new-document']){const id='async-context-cut-'+mode;if(!wanted(id))continue;await record(id,async trace=>{
   const arm=path.join(dir,id);fs.mkdirSync(arm);const file=path.join(arm,'base.md'),second=path.join(arm,'second.md');fs.writeFileSync(file,BASE);fs.writeFileSync(second,SECOND);
   let run,p;
   try{
    run=await launch(o,file,arm,{MP_TEST_CLIPBOARD_DELAY_MS:String(DELAY)});p=run.page;result.artifact||=run.metadata;result.artifacts.push(run.metadata);assert(!run.metadata.sourceMode&&/^[a-f0-9]{64}$/i.test(run.metadata.asarSha256||''),'Actual full ASAR identity');assert(run.metadata.artifactFiles.every(f=>/^[a-f0-9]{64}$/i.test(f.sha256||'')),'Actual loaded identity resources');
    p.on('pageerror',e=>result.errors.push({id,error:e.message}));
    const read=()=>p.evaluate(()=>{const v=window.mpEngine._view(),s=v.state.selection.main;return{text:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},focus:document.hasFocus()&&v.hasFocus,active:{tag:document.activeElement?.tagName,class:document.activeElement?.className},session:window.mpEngine.documentSession(),host:{documentId,filePath,dirty,saveInFlight,saveTimer:!!saveTimer},toast:document.querySelector('.mp-toast')?.textContent||'',events:window.__commandEvents||[]};});
    const capture=async(stage,allowMissingCaret=false)=>{const state=await read(),shot=await frame(p,dir,id+'-'+stage,{allowMissingCaret});result.frames.push(shot);trace.push({stage,state,screenshot:shot,disk:{base:fs.readFileSync(file,'utf8'),second:fs.readFileSync(second,'utf8')}});return state;};
    const exact=(state,text,anchor,head=anchor)=>{assert.equal(state.text,text,'Independent complete literal source');assert.deepEqual(state.selection,{anchor,head},'Independent directed source range');assert(state.focus,'Current source input owner');};
    const point=pos=>p.evaluate(pos=>{const r=window.mpEngine._view().coordsAtPos(pos);if(!r||r.bottom<=r.top)throw Error('No measured source point');return{x:r.left,y:(r.top+r.bottom)/2};},pos);
    const clickAt=async(pos,options={})=>{const at=await point(pos);await p.mouse.click(at.x,at.y,{delay:65,...options});};
    const log=path.join(run.profile,'main-debug.log'),starts=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').split(/\r?\n/).filter(l=>l.includes('clipboardWrite:start')).length:0;
    await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'fresh editor native owner');
    await p.evaluate(()=>{window.__commandEvents=[];for(const type of ['keydown','keyup','beforeinput','input','mousedown','mousemove','mouseup','contextmenu','focusin'])document.addEventListener(type,e=>{if(type==='mousemove'&&!e.buttons)return;const v=window.mpEngine._view(),s=v.state.selection.main;window.__commandEvents.push({type,trusted:e.isTrusted,key:e.key,data:e.data,ctrl:!!e.ctrlKey,shift:!!e.shiftKey,buttons:e.buttons,button:e.button,detail:e.detail,inMaster:v.contentDOM.contains(e.target),target:e.target?.className,selection:{anchor:s.anchor,head:s.head},at:performance.now()});},{capture:true,passive:true});});
    await p.keyboard.press('Control+Home');const clean=await capture('01-clean');exact(clean,BASE,0);assert(!clean.host.dirty&&!clean.host.saveInFlight);
    // Preparatory drag proves the fifth input channel before the critical menu.
    const a=await point(0),b=await point(5);await p.mouse.move(a.x,a.y);await p.mouse.down();for(let step=1;step<=5;step++)await p.mouse.move(a.x+(b.x-a.x)*step/5,a.y+(b.y-a.y)*step/5);await p.mouse.up();
    await waitUntil(async()=>{const s=await read();return s.selection.anchor===0&&s.selection.head===5},'actual drag selected ALPHA');await capture('02-trusted-drag');
    // Native click followed by modified keys supplies the keyboard/mouse channel.
    await clickAt(0);await p.keyboard.press('Control+Home');await p.keyboard.down('Shift');try{for(let n=0;n<5;n++)await p.keyboard.press('ArrowRight');}finally{await p.keyboard.up('Shift');}
    exact(await capture('03-selected'),BASE,0,5);
    const sentinel='MP_COMMAND_SENTINEL_'+crypto.randomUUID().replaceAll('-','');execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-STA','-Command','Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText($env:MP_QUALITY_SENTINEL)'],{env:{...process.env,MP_QUALITY_SENTINEL:sentinel},windowsHide:true,stdio:'ignore',timeout:10000});assert(clipboard.verifyText(sentinel).matches,'Independent unique clipboard sentinel');
    const beforeStart=starts();trace.push({stage:'clipboard-sentinel-ready',sentinelSha256:crypto.createHash('sha256').update(sentinel).digest('hex'),startCount:beforeStart});
    await clickAt(2,{button:'right'});await waitUntil(()=>p.locator('.mp-pop-menu').getByText('剪切',{exact:true}).isVisible(),'actual custom cut menu');const menu=await capture('04-menu',true);assert.equal(menu.text,BASE);assert.deepEqual(menu.selection,{anchor:0,head:5},'Right-click preserves original range');
    await p.locator('.mp-pop-menu').getByText('剪切',{exact:true}).click({delay:65});
    await waitUntil(()=>starts()>beforeStart,'actual clipboardWrite:start increment',7000);assert.equal(starts(),beforeStart+1,'One actual cut write request');trace.push({stage:'actual-clipboard-write-barrier',baseline:beforeStart,observed:starts(),delayMs:DELAY});
    if(mode==='selection-race'){
     await clickAt(6);await p.keyboard.press('Shift+End');exact(await capture('05-new-native-range'),BASE,6,11);
    }else if(mode==='new-document'){
     const response=await p.evaluate(file=>window.mpHost.openPath(file),second);assert(response.ok,'Actual shell document replacement');await waitUntil(async()=>{const s=await read();return s.text===SECOND&&s.host.filePath===second&&s.host.documentId!==clean.host.documentId&&s.session.epoch!==clean.session.epoch},'new document ID and engine epoch before old reply',7000);
     await p.keyboard.press('Control+a');exact(await capture('05-new-document-selected'),SECOND,0,SECOND.length);
    }
    await waitUntil(()=>clipboard.verifyText('ALPHA').matches,'independent clipboard ALPHA readback',7000);
    if(mode==='normal')await waitUntil(async()=>{const s=await read();return s.text==='\nOMEGA\n'&&s.focus},'normal delayed cut actually deletes and resumes',7000);
    else await waitUntil(async()=>{const s=await read();return s.toast.includes('选区已改变，已复制原选区，本次未剪切')||s.text!==(mode==='new-document'?SECOND:BASE);},'actual stale cut reply completed',7000);
    assert.equal(starts(),beforeStart+1,'No unexpected clipboard writes');
    const replied=await capture('06-clipboard-reply');assert(clipboard.verifyText('ALPHA').matches,'Old original range copied independently');
    if(mode==='normal'){
     exact(replied,'\nOMEGA\n',0);await p.keyboard.press('Control+z');const undone=await capture('07-undo');assert.equal(undone.text,BASE,'Undo restores complete original source');assert(undone.focus);
     await p.keyboard.press('Control+y');await p.keyboard.press('1');exact(await capture('08-redo-immediate-one'),'1\nOMEGA\n',1);await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')==='1\nOMEGA\n','normal full disk bytes');
    }else if(mode==='selection-race'){
     exact(replied,BASE,6,11);assert.equal(fs.readFileSync(file,'utf8'),BASE,'Declined cut leaves old disk unchanged');await p.keyboard.insertText('R');exact(await capture('07-immediate-range-replacement'),'ALPHA\nR\n',7);await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')==='ALPHA\nR\n','race continuation full disk bytes');
    }else{
     exact(replied,SECOND,0,SECOND.length);assert.notEqual(replied.host.documentId,clean.host.documentId);assert.notEqual(replied.session.epoch,clean.session.epoch);assert.equal(replied.host.filePath,second);assert.equal(fs.readFileSync(file,'utf8'),BASE,'Old document disk unchanged');assert.equal(fs.readFileSync(second,'utf8'),SECOND,'New document disk unchanged');assert(!replied.host.dirty);
    }
    const final=await capture('09-final'),events=final.events;assert(events.length&&events.every(e=>e.trusted),'Input ledger contains trusted events only');
    const channels={keyboard:events.some(e=>e.type==='keydown'&&e.key==='ArrowRight'),mouse:events.some(e=>e.type==='contextmenu'&&e.button===2),modifiedKeys:events.some(e=>e.type==='keydown'&&(e.ctrl||e.shift)),mouseKeyboard:events.some(e=>e.type==='mousedown'&&e.inMaster)&&events.some(e=>e.type==='keydown'&&e.shift),drag:events.filter(e=>e.type==='mousemove'&&(e.buttons&1)).length>=3&&events.some(e=>e.type==='mouseup'&&e.button===0)};assert(Object.values(channels).every(Boolean),'Five trusted input channels');trace.push({stage:'five-channel-ledger',channels});
    assert.equal(fs.readFileSync(second,'utf8'),SECOND);return{actualCut:true,actualClipboardReadback:true,independentLiteralOracle:true,noSourceOwnerRepair:true,channels};
   }catch(e){if(p)try{trace.push({stage:'failure-state',state:await p.evaluate(()=>({text:window.mpEngine?.getValue(),active:document.activeElement?.className})),screenshot:await frame(p,dir,id+'-failure',{allowMissingCaret:true})});}catch(captureError){trace.push({stage:'failure-capture-error',error:captureError.message});}throw e;}
   finally{if(run)try{const c=await run.cleanup();result.cleanup||={residual:[]};result.cleanup.residual.push(...c.residual);}catch(e){result.cleanupErrors.push(e.message);}}
  });}
 }catch(e){result.fatal=e.stack||e.message;}
 finally{
  try{if(clip)result.clipboard={...result.clipboard,...await clip.restore()};}catch(e){result.clipboard.restoreError=e.message;}
  try{if(release)release();}catch(e){result.cleanupErrors.push(e.message);}
  result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length&&result.clipboard.restored===true;
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),fatal:result.fatal,errors:result.errors,cleanup:result.cleanup,clipboardRestored:result.clipboard.restored}));
 }
 return result.passed;
}
main().then(ok=>{process.exitCode=ok?0:1;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
