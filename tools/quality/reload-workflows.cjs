'use strict';
// Actual host/store reloads with bounded test-only IO/response timing. Every edit,
// selection, owner change and continuation uses native Chromium input.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,recorder,waitUntil,frame}=require('./harness.cjs');
const BASE='alpha\nomega\n',TABLE='Before\n\n| A long header | Another long header |\n| --- | --- |\n| alpha | KEEP |\n\nAfter\n';
async function main(){
 const options=args(process.argv.slice(2));assert(/^[a-f0-9]{64}$/i.test(options['expected-sha256']||''));
 const dir=outputDir(options.out,'reload-workflows'),release=acquireSlot(ROOT),result={schema:1,suite:'reload-workflows',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),cases:[],errors:[],cleanupErrors:[],artifacts:[],timing:'Only MP_TEST_HOOKS=1 bounded delays; no source/focus repair at reload or history boundaries'};
 const record=recorder(dir,result),filter=process.env.MP_QUALITY_CASES,wanted=id=>!filter||new RegExp(filter).test(id);
 const plans=[
  {id:'native-cell-selection-maps-without-command-flush',selectionOnly:true},
  {id:'save-error-recovery-save-as-returns-source-owner',saveRecovery:true},
  {id:'new-input-before-disk-read',phase:'before-read'},
  {id:'new-input-after-store-adoption',phase:'after-adopt'},
  {id:'persistent-native-control-during-read',phase:'after-adopt',control:true,prefix:'EXT\n'},
  {id:'new-cell-owner-reverse-range-during-read',phase:'after-adopt',cell:true,prefix:'EXT\n'},
  {id:'same-width-inactive-cell-disk-reload',table:true},
  {id:'document-switch-during-read',phase:'before-read',switch:true},
  {id:'canceled-reload-then-fresh-reload',cancel:true},
 ];
 try{for(const plan of plans){if(!wanted(plan.id))continue;await record(plan.id,async trace=>{
  const arm=path.join(dir,plan.id);fs.mkdirSync(arm);const file=path.join(arm,'fixture.md'),saveAs=path.join(arm,'recovered.md'),initial=plan.cell||plan.table||plan.selectionOnly?TABLE:BASE;
  fs.writeFileSync(file,initial);const env={MP_TEST_SAVE_AS:saveAs};if(plan.phase)env[plan.phase==='before-read'?'MP_TEST_RELOAD_READ_DELAY_MS':'MP_TEST_RELOAD_RESPONSE_DELAY_MS']='2400';
  const run=await launch(options,file,arm,env),p=run.page;result.artifact||=run.metadata;result.artifacts.push(run.metadata);p.on('pageerror',e=>result.errors.push({id:plan.id,error:e.message}));
  const read=()=>p.evaluate(()=>{
   const v=window.mpEngine._view(),s=v.state.selection.main,el=document.querySelector('.mp-cell-overlay-text'),dom=getSelection(),offset=(node,at)=>{if(!el?.contains(node))return null;const r=document.createRange();r.selectNodeContents(el);r.setEnd(node,at);return r.toString().length;};
   return {text:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},focus:document.hasFocus()&&v.hasFocus,cellFocus:document.hasFocus()&&document.activeElement===el,cellText:el?.textContent,domSelection:{anchor:offset(dom?.anchorNode,dom?.anchorOffset),head:offset(dom?.focusNode,dom?.focusOffset)},active:{tag:document.activeElement?.tagName,class:document.activeElement?.className},host:{documentId,filePath,revision,dirty,saveBlocked,recoverySerial:typeof recoverySerial==='number'?recoverySerial:0,saveInFlight,saveTimer:!!saveTimer},banner:document.querySelector('#mp-banner')?.textContent,docs:window.__reloadDocs,events:window.__reloadEvents,reply:window.__reloadReply};
  });
  const capture=async name=>{const s=await read(),step={name,...s,disk:fs.readFileSync(file,'utf8'),diskSha256:sha256(file)};trace.push(step);step.screenshot=await frame(p,dir,plan.id+'-'+name,s.cellFocus?{caret:'dom',allowMissingCaret:true}:s.focus?{}:{caret:'dom',allowMissingCaret:true});return step;};
  const start=()=>p.evaluate(()=>{window.__reloadReply=null;window.__reloadPromise=window.mpReloadDocument({origin:'disk'}).then(r=>window.__reloadReply=r);});
  const settled=()=>waitUntil(()=>p.evaluate(()=>!!window.__reloadReply),'actual reload settled',7000);
  try{
   await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'fresh editor boot owner');
   await p.evaluate(()=>{window.__reloadDocs=[];window.__reloadEvents=[];window.mpHost.onDoc(d=>window.__reloadDocs.push({id:d.documentId,kind:d.loadKind,request:d.requestId,text:d.text}));for(const type of ['keydown','beforeinput','input','focusin','mousedown','mouseup'])document.addEventListener(type,e=>window.__reloadEvents.push({type,key:e.key,data:e.data,trusted:e.isTrusted,target:e.target?.className,tag:e.target?.tagName}),{capture:true,passive:true});});
   await p.keyboard.press('Control+End');const before=await capture('01-clean');assert.equal(before.text,initial);assert(before.focus&&!before.host.dirty&&!before.host.saveInFlight);
   if(plan.selectionOnly){
    await p.locator('.mp-row td[data-mp-col="1"]').first().click({delay:65});await p.keyboard.press('Home');for(let i=0;i<4;i++)await p.keyboard.press('ArrowRight');await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');}finally{await p.keyboard.up('Shift');}
    await sleep(120);const selected=await capture('02-native-selected');assert(selected.cellFocus);assert.deepEqual(selected.domSelection,{anchor:4,head:2});const raw=TABLE.indexOf(' KEEP ');assert.deepEqual(selected.selection,{anchor:raw+4,head:raw+2},'master source follows current DOM without a command flush');
   }else if(plan.saveRecovery){
    fs.writeFileSync(file,'EXTERNAL\n'+BASE);await p.keyboard.insertText('R');await waitUntil(()=>p.locator('#mp-banner').textContent().then(s=>s?.includes('保存失败')),'actual save conflict banner');const error=await capture('02-save-error');assert(error.focus);assert.equal(error.text,BASE+'R');assert.equal(error.disk,'EXTERNAL\n'+BASE);
    await p.locator('#mp-banner').getByText('另存为…',{exact:true}).click({delay:65});await waitUntil(()=>fs.existsSync(saveAs)&&fs.readFileSync(saveAs,'utf8')===BASE+'R','recovery Save As writes actual source');const saved=await capture('03-recovered-save-as');assert.equal(saved.host.filePath,saveAs);assert.equal(saved.disk,'EXTERNAL\n'+BASE);assert(saved.focus,'Save As returns the prior source input owner');
   }else if(plan.cancel){
    await p.keyboard.insertText('R');await start();await settled();const canceled=await capture('02-canceled');assert(canceled.reply?.canceled,'actual dirty confirmation refused in no-dialog mode');assert.equal(canceled.text,BASE+'R');assert.equal(canceled.host.documentId,before.host.documentId);
    await p.keyboard.press('Control+s');await waitUntil(async()=>{const s=await read();return !s.host.dirty&&!s.host.saveInFlight&&fs.readFileSync(file,'utf8')===BASE+'R'},'real save after cancellation');
    await start();await settled();const loaded=await capture('03-fresh-read');assert(loaded.reply.ok);assert.notEqual(loaded.host.documentId,before.host.documentId);await p.keyboard.press('Control+z');await sleep(120);assert.equal((await read()).text,BASE,'fresh reload retains local history');
   }else if(plan.table){
    await p.locator('.mp-row td[data-mp-col="1"]').first().click({delay:65});await p.keyboard.press('Home');await p.keyboard.press('ArrowRight');await p.keyboard.press('ArrowRight');await sleep(60);const owned=await capture('02-owned-cell');assert(owned.cellFocus);assert.equal(owned.cellText,' KEEP ');
    const external=TABLE.replace('| alpha |','| OMEGA |');assert.equal(external.length,TABLE.length);fs.writeFileSync(file,external);await start();await settled();const loaded=await capture('03-same-width-read');assert(loaded.reply.ok);assert.equal(loaded.text,external);assert(loaded.cellFocus);assert.deepEqual(loaded.selection,owned.selection);
    const rendered=await p.locator('.mp-row td[data-mp-col="0"]').first().textContent();assert.equal(rendered,'OMEGA','inactive cell rendered DOM follows equal-length disk edit');
    await p.keyboard.insertText('R');await sleep(80);assert.equal((await read()).text,external.replace('KEEP','KREEP'));
    await p.keyboard.press('Control+z');await sleep(80);assert.equal((await read()).text,external,'Undo retains inactive external edit');await p.keyboard.press('Control+y');await p.keyboard.press('1');await sleep(100);const end=await capture('04-redo-immediate-one');assert.equal(end.text,external.replace('KEEP','KR1EEP'));assert(end.cellFocus);
   }else{
    const external=(plan.prefix||'')+initial;if(plan.prefix)fs.writeFileSync(file,external);await start();
    await waitUntil(()=>{const log=path.join(run.profile,'main-debug.log');return fs.existsSync(log)&&fs.readFileSync(log,'utf8').split('\n').some(l=>l.includes('test:reload-delay')&&l.includes(plan.phase))},'actual '+plan.phase+' barrier');
    trace.push({name:'actual-delay-phase',phase:plan.phase,milliseconds:2400});
    if(plan.control){
     await p.locator('.mp-tb-item[data-mp-id="more"]').click({delay:65});await p.locator('.mp-pop').getByText('设置',{exact:true}).click({delay:65});const control=p.locator('.mp-dlg input.mp-rng[data-p]').first();await control.click({delay:65});
     const value=await control.evaluate(el=>({value:Number(el.value),step:Number(el.step)||1,max:Number(el.max)}));await p.keyboard.press('ArrowRight');const expected=Math.min(value.max,value.value+value.step);assert.equal(await control.inputValue(),String(expected));await settled();const loaded=await capture('03-native-control-kept');assert(loaded.reply.ok);assert.equal(loaded.text,external);assert(await control.evaluate(el=>document.hasFocus()&&document.activeElement===el));
     await p.keyboard.press('ArrowRight');assert.equal(await control.inputValue(),String(Math.min(value.max,expected+value.step)),'immediate key remains native control');assert.equal((await read()).text,external);
    }else if(plan.cell){
     await p.locator('.mp-row td[data-mp-col="1"]').first().click({delay:65});await p.keyboard.press('Home');for(let i=0;i<4;i++)await p.keyboard.press('ArrowRight');await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');}finally{await p.keyboard.up('Shift');}
     const raw=TABLE.indexOf(' KEEP '),expected={anchor:raw+4,head:raw+2};await waitUntil(async()=>{const s=await read();return s.selection.anchor===expected.anchor&&s.selection.head===expected.head},'native DOM range propagated to master source');
     const owned=await capture('02-new-reverse-owner');assert(owned.cellFocus);assert.deepEqual(owned.domSelection,{anchor:4,head:2});await settled();const loaded=await capture('03-loaded-current-owner');assert(loaded.reply.ok);assert.equal(loaded.text,external);assert(loaded.cellFocus);assert.deepEqual(loaded.domSelection,{anchor:4,head:2});assert.deepEqual(loaded.selection,{anchor:expected.anchor+4,head:expected.head+4});
     await p.keyboard.insertText('R');await sleep(100);const end=await capture('04-immediate-replacement');assert.equal(end.text,external.replace('KEEP','KRP'));assert(end.cellFocus);assert.deepEqual(end.domSelection,{anchor:3,head:3});
    }else if(plan.switch){
     const second=path.join(arm,'second.md');fs.writeFileSync(second,'SECOND\n');const opened=await p.evaluate(f=>window.mpHost.openPath(f),second);assert(opened.ok);await waitUntil(()=>p.evaluate(f=>filePath===f,second),'actual replacement document');await p.keyboard.insertText('NEW_');await settled();const end=await capture('03-switched-during-read');assert.equal(end.text,'NEW_SECOND\n');assert.equal(end.host.filePath,second);assert.notEqual(end.host.documentId,before.host.documentId);assert.equal(fs.readFileSync(file,'utf8'),initial);
    }else{
     await p.keyboard.insertText('R');await settled();const end=await capture('03-new-input-retained');assert.equal(end.text,BASE+'R');assert(end.focus);assert.equal(end.reply.ok,false);
     if(plan.phase==='before-read'){assert.equal(end.reply.code,'MP_DOC_MISMATCH');assert.equal(end.host.documentId,before.host.documentId);await waitUntil(()=>fs.readFileSync(file,'utf8')===BASE+'R','newer buffer autosaves after read rejection');}
     else{assert.equal(end.reply.code,'MP_RELOAD_NEWER_INPUT');assert.notEqual(end.host.documentId,before.host.documentId);assert(end.host.saveBlocked&&end.host.dirty&&end.host.recoverySerial>before.host.recoverySerial);assert(end.banner.includes('保留当前内容'));assert.equal(fs.readFileSync(file,'utf8'),BASE);
      await p.locator('#mp-banner').getByText('另存为…',{exact:true}).click({delay:65});await waitUntil(()=>fs.existsSync(saveAs)&&fs.readFileSync(saveAs,'utf8')===BASE+'R','recovered buffer has actual Save As path');const saved=await capture('04-recovered-save-as');assert(!saved.host.saveBlocked);assert.equal(saved.host.filePath,saveAs);assert.equal(fs.readFileSync(file,'utf8'),BASE);assert(saved.focus,'Save As returns the prior source input owner');
     }
    }
   }
   const final=await read();assert(final.events.some(e=>e.trusted&&e.type==='keydown'));return {actualHandlerAndStore:true,directionalRangeAndSourceOracle:true,reply:final.reply};
  }catch(e){await capture('failure').catch(x=>trace.push({name:'failure-capture',error:x.message}));throw e;}
  finally{try{const cleanup=await run.cleanup();result.cleanup||={residual:[]};result.cleanup.residual.push(...cleanup.residual);}catch(e){result.cleanupErrors.push(e.message);}}
 });}}
 finally{release();result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),errors:result.errors,cleanup:result.cleanup}));}
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1});
