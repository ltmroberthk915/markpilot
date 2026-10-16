'use strict';
// Actual MenuItem callbacks and native edits, with bounded test-only dialog delay.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,recorder,waitUntil,frame}=require('./harness.cjs');
const BASE='alpha\nomega\n';
async function main(){
 const o=args(process.argv.slice(2));assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']||''));
 const dir=outputDir(o.out,'save-as-workflows'),release=acquireSlot(ROOT),result={schema:1,suite:'save-as-workflows',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),cases:[],errors:[],artifacts:[],clipboard:{touched:false},cleanup:{residual:[]}};
 const record=recorder(dir,result),filter=process.env.MP_QUALITY_CASES,wanted=id=>!filter||new RegExp(filter).test(id);
 const plans=[{id:'save-as-overlap-newer-path-wins',overlap:true,delay:2200},{id:'save-as-cancel-keeps-source-owner',cancel:true},{id:'save-as-newer-native-control-kept',control:true,delay:2200},{id:'save-as-current-new-input-is-saved',input:true,delay:1800},{id:'save-as-document-switch-late-grant',switch:true,delay:1800},{id:'save-as-grant-failure-returns-current-owner',failure:true}];
 try{for(const plan of plans){if(!wanted(plan.id))continue;await record(plan.id,async trace=>{
  const arm=path.join(dir,plan.id);fs.mkdirSync(arm);const file=path.join(arm,'fixture.md'),older=path.join(arm,'older.md'),newer=path.join(arm,'newer.md');fs.writeFileSync(file,BASE);if(plan.failure)fs.mkdirSync(older);
  const env={MP_TEST_SAVE_AS_PLAN:JSON.stringify([{filePath:older,delayMs:plan.delay||0},{filePath:newer,delayMs:0}]),...(plan.cancel?{MP_TEST_SAVE_AS_CANCEL:'1'}:{})};
  const run=await launch(o,file,arm,env),p=run.page;result.artifact||=run.metadata;result.artifacts.push(run.metadata);p.on('pageerror',e=>result.errors.push({id:plan.id,error:e.message}));
  const read=()=>p.evaluate(async()=>{const v=window.mpEngine._view(),s=v.state.selection.main,active=document.activeElement;return{text:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},focus:document.hasFocus()&&v.hasFocus,foreground:document.hasFocus(),active:{tag:active?.tagName,class:active?.className},host:{documentId,filePath,dirty,saveBlocked,lastSaveError},store:await window.mpHost.docInfo(),saveTrace:window.__mpDbg?.saveTrace||[],events:window.__saveAsEvents||[],banner:document.querySelector('#mp-banner')?.textContent};});
  const capture=async name=>{const s=await read();trace.push({name,...s,screenshot:await frame(p,dir,plan.id+'-'+name,s.focus?{}:{caret:'dom',allowMissingCaret:true})});return s;};
  const menu=async()=>{const ack=await p.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save-as'));assert(ack.ok,'actual registered MenuItem callback');trace.push({name:'actual-MenuItem-save-as',ack});};
  const barrier=()=>waitUntil(()=>{const log=path.join(run.profile,'main-debug.log');return fs.existsSync(log)&&fs.readFileSync(log,'utf8').includes('test:save-as-delay')},'actual before-grant delay',7000);
  try{
   await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'initial source owner');
   await p.evaluate(()=>{window.__saveAsEvents=[];for(const type of ['keydown','beforeinput','input','mousedown','mouseup','focusin'])document.addEventListener(type,e=>window.__saveAsEvents.push({type,key:e.key,data:e.data,trusted:e.isTrusted,tag:e.target?.tagName,class:e.target?.className}),{capture:true,passive:true});});
   await p.keyboard.press('Control+End');const clean=await capture('01-clean');assert.equal(clean.text,BASE);assert(clean.focus&&!clean.host.dirty);
   await menu();if(plan.delay)await barrier();
   if(plan.overlap){
    await capture('02-older-pending');await menu();await waitUntil(async()=>{const s=await read();return s.host.filePath===newer},'newer actual Save As completes');const current=await capture('03-newer-saved');assert.equal(fs.readFileSync(newer,'utf8'),BASE);assert(current.focus);
    await waitUntil(async()=>{const s=await read();return s.saveTrace.filter(t=>t.step==='saveAsFlow:result').length>=2},'both actual grant responses settle',7000);await sleep(250);
    const settled=await capture('04-older-response');assert.equal(settled.host.filePath,newer,'a late older Save As cannot redirect the current primary path');assert.equal(settled.store.filePath,newer);assert(!fs.existsSync(older),'obsolete late operation may not write its target');assert(settled.focus);assert.equal(settled.text,BASE);
   }else if(plan.control){
    await p.locator('.mp-tb-item[data-mp-id="more"]').click({delay:65});await p.locator('.mp-pop').getByText('设置',{exact:true}).click({delay:65});await p.locator('[data-settings-tab="layout"]').click({delay:65});const control=p.locator('.mp-dlg input.mp-rng[data-p]').first();await control.click({delay:65});await p.keyboard.press('ArrowRight');const value=await control.inputValue();
    await waitUntil(async()=>{const s=await read();return s.host.filePath===older},'save with current native owner');const saved=await capture('02-native-owner-kept');assert.equal(fs.readFileSync(older,'utf8'),BASE);assert(await control.evaluate(el=>document.hasFocus()&&document.activeElement===el));assert.equal(await control.inputValue(),value);await p.keyboard.press('ArrowLeft');assert.equal((await read()).text,BASE);
   }else if(plan.input){
    await p.keyboard.insertText('R');await waitUntil(()=>fs.existsSync(older)&&fs.readFileSync(older,'utf8')===BASE+'R','accepted current operation saves newer source');const saved=await capture('02-new-input-saved');assert(saved.focus);assert.equal(saved.text,BASE+'R');assert.equal(saved.host.filePath,older);assert.equal(saved.selection.head,BASE.length+1);
   }else if(plan.switch){
    const second=path.join(arm,'second.md');fs.writeFileSync(second,'SECOND\n');const opened=await p.evaluate(f=>window.mpHost.openPath(f),second);assert(opened.ok);await waitUntil(async()=>{const s=await read();return s.host.filePath===second},'actual newer document');await p.keyboard.insertText('R');
    await waitUntil(async()=>{const s=await read();return s.saveTrace.some(t=>t.step==='saveAsFlow:result')},'old dialog completion rejected');const saved=await capture('02-new-document-kept');assert.equal(saved.text,'RSECOND\n');assert(saved.focus);assert.equal(saved.host.filePath,second);assert.notEqual(saved.host.documentId,clean.host.documentId);assert(!fs.existsSync(older));assert.equal(fs.readFileSync(file,'utf8'),BASE);
   }else{
    await waitUntil(async()=>{const s=await read();return s.saveTrace.some(t=>t.step==='saveAsFlow:result')},'cancel or actual grant error settled');const saved=await capture('02-returned-owner');assert(saved.focus);assert.equal(saved.text,BASE);assert.equal(saved.host.filePath,file);assert.equal(fs.readFileSync(file,'utf8'),BASE);if(plan.cancel)assert(!fs.existsSync(older));if(plan.failure)assert(saved.host.lastSaveError);
    await p.keyboard.insertText('R');assert.equal((await read()).text,BASE+'R','immediate continued input reaches current owner');
   }
   return{actualMenuCallback:true,actualHostAndStore:true,sourceAndDiskOracle:true};
  }catch(error){await capture('failure').catch(e=>trace.push({name:'failure-capture',error:e.message}));throw error;}
  finally{const c=await run.cleanup();result.cleanup.residual.push(...c.residual);}
 });}}
 finally{release();result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.errors.length&&!result.cleanup.residual.length;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),cleanup:result.cleanup,errors:result.errors}));}
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
