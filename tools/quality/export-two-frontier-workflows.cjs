'use strict';
// Root-only, synthetic isolated-profile audit of the two previously uncovered boundaries.
// Observers forward the original arguments, values and Promise identities without delay.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {ROOT,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,waitUntil,newWindow,frame}=require(path.join(ROOT,'tools/quality/harness.cjs'));
const options=require('./lifecycle.cjs').args(process.argv.slice(2)),out=outputDir(options.out,'export-two-frontier'),token=crypto.randomUUID();
const aFile=path.join(out,'A.md'),bFile=path.join(out,'B.md'),pdf=path.join(out,'output.pdf'),bFolder=path.join(out,'B-folder');
const markerA='FRONTIER_A_'+token,markerB='FRONTIER_B_'+token;
const prose='A clear note paragraph with **bold words**, _emphasis_, ~~old text~~ and a [reference](https://example.invalid/). '+ 'ordinary notebook text '.repeat(15);
const originalA='# '+markerA+'\n\n'+Array.from({length:18000},(_,i)=>'Paragraph '+i+' '+prose+'\n\n').join('')+'A_END_'+token+'\n';
const originalB='# '+markerB+'\n\nIndependent window note.\n\n|H|K|\n|---|---|\n|**bold** and _italic_|KEEP|\n';
const shortA='# A_RECOVERY_'+token+'\n\nShort note exported after cancellation.\n';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const result={schema:1,kind:'two-bounded-export-frontiers',version:require(path.join(ROOT,'MarkPilot-CM6/package.json')).version,suite:'export-two-frontier-workflows',startedAt:new Date().toISOString(),cases:[],errors:[],cleanupErrors:[],frames:[],clipboardTouched:false,menuRoute:'Actual installed MenuItem callback; no physical accelerator claim',instrumentation:'Original IPC handlers and HTML writer methods forwarded synchronously; original Promise returned; no artificial delay'};
fs.writeFileSync(aFile,originalA,{flag:'wx'});fs.writeFileSync(bFile,originalB,{flag:'wx'});
let run,release,debug,a,b;
async function connectInspector(url){
 assert(url,'Observed Node inspector endpoint required');const ws=new WebSocket(url),pending=new Map();let sequence=0;
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Inspector connect timeout')),8000);ws.addEventListener('open',()=>{clearTimeout(t);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(Error('Inspector connection failure'));},{once:true});});
 ws.addEventListener('message',event=>{const r=JSON.parse(event.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error('Inspector protocol failure')):p.resolve(r.result);});
 return{async evaluate(expression){const id=++sequence;const r=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector evaluation timeout'));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});if(r.exceptionDetails)throw Error('Inspector expression failed: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result?.value;},close:()=>ws.close()};
}
function installObservers(){
 const {ipcMain}=process.mainModule.require('electron'),exporter=process.mainModule.require('./export-folder');
 if(!(ipcMain._invokeHandlers instanceof Map))throw Error('Actual IPC Map capability unavailable');
 const map=ipcMain._invokeHandlers,originalCreate=exporter.createHtmlWriter,originals=new Map(),writerOriginals=[];
 const o={writers:[],calls:[],cancelCuts:[]};globalThis.__mpFrontierObserver=o;
 const now=()=>Date.now();
 const writerSnapshot=()=>o.writers.map(w=>({...w}));
 function settle(value,done,error){if(value&&typeof value.then==='function')value.then(done,error);else done(value);return value;}
 exporter.createHtmlWriter=function(...args){
  const writer=Reflect.apply(originalCreate,this,args),w={id:writer.id,file:writer.file,created:now(),writeEntered:0,writeSettled:0,pending:0,finishEntered:0,finishSettled:0,abortEntered:0,abortSettled:0,errors:[]};o.writers.push(w);
  for(const method of ['write','finish','abort']){
   const original=writer[method];writerOriginals.push({writer,method,original});
   writer[method]=function(...values){w[method==='write'?'writeEntered':method+'Entered']++;if(method==='write')w.pending++;
    let returned;try{returned=Reflect.apply(original,this,values);}catch(e){w.errors.push({method,error:e.message});if(method==='write')w.pending--;throw e;}
    return settle(returned,()=>{w[method==='write'?'writeSettled':method+'Settled']++;if(method==='write')w.pending--;},e=>{w.errors.push({method,error:e.message});if(method==='write')w.pending--;});
   };
  }return writer;
 };
 for(const name of ['export:pdf','export:pdfCancel','export:beginHtml','export:appendHtml','export:finishHtml','export:abortHtml','export:htmlDone']){
  const original=map.get(name);if(typeof original!=='function')throw Error('Actual handler absent: '+name);originals.set(name,original);
  map.set(name,function(...args){const data=args[1]||{},call={name,owner:args[0]?.sender?.id,entered:now(),settled:false,payload:{id:data.id,dir:data.dir,name:data.name,ok:data.ok,error:data.error,mode:data.mode,pdfSessionId:data.pdfSessionId,textLength:typeof data.text==='string'?data.text.length:undefined}};o.calls.push(call);
   if(name==='export:pdfCancel')o.cancelCuts.push({owner:call.owner,at:now(),writers:writerSnapshot(),pdfs:o.calls.filter(c=>c.name==='export:pdf'&&!c.settled).map(c=>({owner:c.owner,entered:c.entered}))});
   let returned;try{returned=Reflect.apply(original,this,args);}catch(e){call.settled=true;call.error=e.message;throw e;}
   return settle(returned,r=>{call.settled=true;call.finished=now();call.result=r;if(name==='export:beginHtml'&&r?.id){const w=o.writers.find(w=>w.id===r.id);if(w)w.owner=call.owner;}},e=>{call.settled=true;call.finished=now();call.error=e.message;});
  });
 }
 o.snapshot=()=>({writers:writerSnapshot(),calls:o.calls,cancelCuts:o.cancelCuts});
 o.restore=()=>{exporter.createHtmlWriter=originalCreate;for(const [name,original] of originals)map.set(name,original);for(const {writer,method,original} of writerOriginals)writer[method]=original;};
 return{installed:true,ipcMapVerified:true,methods:['write','finish','abort'],delayIntroduced:false};
}
const observe=()=>debug.evaluate('globalThis.__mpFrontierObserver.snapshot()');
async function attach(page){page.on('pageerror',e=>result.errors.push(e.message));await page.evaluate(()=>{window.__frontierEvents={progress:[],html:[],input:[]};window.mpHost.onExportProgress(p=>window.__frontierEvents.progress.push({...p,observedAt:Date.now()}));window.mpHost.onExportMakeHtml(p=>window.__frontierEvents.html.push({...p,observedAt:Date.now()}));for(const type of ['keydown','pointerdown','pointermove','pointerup','beforeinput','input'])document.addEventListener(type,e=>window.__frontierEvents.input.push({type,trusted:e.isTrusted,key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey,buttons:e.buttons,owner:e.target?.closest?.('.cm-content')?'cm':'other',at:performance.now()}),{capture:true,passive:true});});}
async function state(page){return page.evaluate(async()=>{const v=window.mpEngine._view(),s=v.state.selection.main;return{document:await window.mpHost.docInfo(),sessions:await window.mpHost.debugSessions(),source:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},focus:document.hasFocus()&&v.hasFocus,scroll:{top:v.scrollDOM.scrollTop,left:v.scrollDOM.scrollLeft},dirty,saveInFlight,events:window.__frontierEvents,lastPdf:window.__mpDbg.lastPdf,banner:document.getElementById('mp-banner')?.textContent||'',lastExport:window.mpExtras.lastExport()};});}
async function menuPdf(page){await page.bringToFront();const r=await page.evaluate(()=>window.mpHost.recentTestMenuClick('menu-export-pdf',true));assert(r?.ok,'actual PDF menu callback');}
async function cancelUi(page){await page.bringToFront();const button=page.locator('#mp-banner button').filter({hasText:'取消'});const box=await button.boundingBox();assert(box,'actual cancel button visible');await page.mouse.click(box.x+box.width/2,box.y+box.height/2);}
async function shot(page,label){const bytes=await page.screenshot({path:path.join(out,label+'.png'),animations:'disabled'});result.frames.push({file:label+'.png',sha256:hash(bytes),nativeCaretClaim:false});}
async function currentHtml(page,priorCount){let payload;await waitUntil(async()=>{const list=await page.evaluate(()=>window.__frontierEvents.html);if(list.length<=priorCount)return false;payload=list.at(-1);return true;},'new actual make-html payload',25000);return payload;}
async function awaitAppend(payload,owner){let cut;await waitUntil(async()=>{const o=await observe();cut=o.writers.find(w=>w.owner===owner&&path.dirname(w.file)===payload.stageDir&&w.writeEntered>0&&!w.finishEntered);return !!cut;},'actual HTML append chain before finish',25000);return cut;}
async function awaitSettled(payload){await waitUntil(async()=>{const o=await observe();return o.calls.some(c=>c.name==='export:htmlDone'&&c.payload.id===payload.id&&c.payload.mode!=='root-fault-injection'&&c.settled)&&o.writers.filter(w=>path.dirname(w.file)===payload.stageDir).every(w=>w.pending===0);},'renderer HTML reply and pending writes settle',25000);const o=await observe();assert(o.writers.filter(w=>path.dirname(w.file)===payload.stageDir).every(w=>w.finishSettled||w.abortSettled),'writer close/abort settled after PDF and renderer reply');await sleep(200);assert(!fs.existsSync(payload.stageDir),'own staging is gone after all renderer work');}
async function pdfResult(page,after){let value;await waitUntil(async()=>{const o=await observe();const call=o.calls.find(c=>c.name==='export:pdf'&&c.owner===(page===a?result.owners.a:result.owners.b)&&c.entered>=after&&c.settled);if(!call)return false;value=call.result;return true;},'real PDF handler settled',90000);await waitUntil(()=>page.evaluate(()=>!!window.__mpDbg.lastPdf),'host PDF diagnostic reached');return value;}
async function nativeReplace(page,text){await page.bringToFront();await page.locator('.cm-line').first().click();await page.keyboard.press('Control+a');await page.keyboard.insertText(text);await waitUntil(()=>page.evaluate(text=>window.mpEngine._view().state.doc.toString()===text,text),'native whole-note replacement');}
(async()=>{try{
 release=acquireSlot();run=await launch({...options,inspectMain:true,settings:{autosaveEnabled:false,restoreLast:false}},aFile,out,{MP_EXPORT_PDF:pdf,MP_EXPORT_DIR:bFolder,MP_KEEP_STAGING:''});
 result.artifact=run.metadata;assert.equal(run.metadata.app.version,result.version);
 debug=await connectInspector(run.nodeInspectorURL);result.observers=await debug.evaluate('('+installObservers.toString()+')()');a=run.page;await attach(a);b=await newWindow(run,a,bFile);await attach(b);
 const initialA=await state(a),initialB=await state(b);assert.equal(initialA.source,originalA);assert.equal(initialB.source,originalB);result.owners={a:initialA.sessions.mine,b:initialB.sessions.mine};assert.notEqual(result.owners.a,result.owners.b);assert.notEqual(initialA.document.documentId,initialB.document.documentId);
 result.fixture={aBytes:Buffer.byteLength(originalA),aSha256:hash(originalA),bSha256:hash(originalB)};
 const c2={id:'C2-cancel-during-actual-html-appends',status:'running'};result.cases.push(c2);
 let started=Date.now();await menuPdf(a);const html1=await currentHtml(a,0);c2.payload=html1;c2.preClickWriter=await awaitAppend(html1,result.owners.a);await cancelUi(a);
 c2.pdfResult=await pdfResult(a,started);assert(c2.pdfResult.canceled&&!c2.pdfResult.ok,'real canceled PDF result');
 const cut=(await observe()).cancelCuts.at(-1);c2.cancelCut=cut;assert.equal(cut.owner,result.owners.a);assert(cut.writers.some(w=>path.dirname(w.file)===html1.stageDir&&w.writeEntered>0&&!w.finishEntered),'cancel handler reached after append entered and before finish');
 await awaitSettled(html1);assert(!fs.existsSync(pdf),'canceled first export creates no PDF');await shot(a,'C2-canceled');
 started=Date.now();await menuPdf(a);const htmlFailure=await currentHtml(a,1);await awaitAppend(htmlFailure,result.owners.a);
 c2.diagnosticFailureReply=await a.evaluate(id=>window.mpHost.htmlDone({id,ok:false,error:'ROOT_DIAGNOSTIC_HTML_FAILURE',mode:'root-fault-injection'}),htmlFailure.id);assert(c2.diagnosticFailureReply.ok);
 c2.nonCancelFailureResult=await pdfResult(a,started);assert(!c2.nonCancelFailureResult.ok&&!c2.nonCancelFailureResult.canceled&&c2.nonCancelFailureResult.error==='ROOT_DIAGNOSTIC_HTML_FAILURE');await awaitSettled(htmlFailure);assert(!fs.existsSync(pdf));
 await a.locator('.cm-line').first().click();assert((await state(a)).focus,'native click gives editor focus');await a.keyboard.press('Control+End');await a.keyboard.insertText('R');assert.equal((await state(a)).source,originalA+'R');await a.keyboard.press('Control+z');assert.equal((await state(a)).source,originalA,'actual Undo restores note after cancel');c2.nativeEditingAndUndo=true;
 await a.keyboard.press('Control+Home');assert((await state(a)).focus);
 const points=await a.evaluate(()=>{const v=window.mpEngine._view();return [v.coordsAtPos(2),v.coordsAtPos(14)];});assert(points.every(p=>p&&p.bottom>p.top));
 const inputCut=await a.evaluate(()=>window.__frontierEvents.input.length);
 await a.mouse.move(points[0].left+1,(points[0].top+points[0].bottom)/2);await a.mouse.down();
 for(let i=1;i<=5;i++)await a.mouse.move(points[0].left+(points[1].left-points[0].left)*i/5,(points[0].top+points[0].bottom)/2);
 await a.mouse.up();const dragged=await state(a);assert.notEqual(dragged.selection.anchor,dragged.selection.head,'real held drag creates visible selection');assert.equal(dragged.source,originalA);assert(dragged.focus);
 await a.keyboard.press('Shift+ArrowRight');const extended=await state(a);assert.notDeepEqual(extended.selection,dragged.selection,'Shift key extends the native drag');assert.equal(extended.source,originalA);c2.dragAndKey={before:dragged.selection,after:extended.selection,focus:extended.focus,scroll:extended.scroll,inputCut,newEvents:extended.events.input.slice(inputCut)};
 const events=c2.dragAndKey.newEvents,down=events.findIndex(e=>e.type==='pointerdown'&&e.trusted&&e.owner==='cm'),up=events.findIndex((e,i)=>i>down&&e.type==='pointerup'&&e.trusted&&e.owner==='cm');assert(down>=0&&up>down);assert(events.slice(down+1,up).filter(e=>e.type==='pointermove'&&e.trusted&&e.buttons===1).length>=5);assert(events.slice(up+1).some(e=>e.type==='keydown'&&e.trusted&&e.key==='ArrowRight'&&e.shift&&e.owner==='cm'));assert(extended.focus);
 c2.frames=[await frame(a,out,'C2-editor-history-and-drag')];
 await nativeReplace(a,shortA);c2.retrySource={nativeWholeNoteReplacement:true,bytes:Buffer.byteLength(shortA),sha256:hash(shortA)};started=Date.now();await menuPdf(a);const html2=await currentHtml(a,2);c2.retryResult=await pdfResult(a,started);assert(c2.retryResult.ok&&c2.retryResult.bytes>0,'same-window actual PDF retry succeeds');await awaitSettled(html2);assert.equal(fs.readFileSync(pdf).subarray(0,5).toString(),'%PDF-');c2.retryPdfSha256=hash(fs.readFileSync(pdf));
 await a.locator('.cm-line').first().click();await a.keyboard.press('Control+z');assert.equal((await state(a)).source,originalA,'whole-note replacement Undo retains earlier history');c2.status='pass';
 const c3={id:'C3-second-window-busy-folder-owner-recovery',status:'running'};result.cases.push(c3);
 started=Date.now();await menuPdf(a);const html3=await currentHtml(a,3);c3.aPayload=html3;c3.preBusyWriter=await awaitAppend(html3,result.owners.a);
 c3.oldGenerationDiagnostics=await a.evaluate(async old=>({pick:await window.mpHost.exportPickFolder({pdfSessionId:old.id}),begin:await window.mpHost.exportBeginHtml({dir:old.stageDir,name:'late-old',pdfSessionId:old.id})}),html1);
 assert(!c3.oldGenerationDiagnostics.pick.ok&&c3.oldGenerationDiagnostics.pick.code==='MP_EXPORT_CANCELED'&&!c3.oldGenerationDiagnostics.begin.ok&&c3.oldGenerationDiagnostics.begin.error==='PDF 导出已结束或取消','retired generation cannot borrow a new PDF directory');
 assert(!fs.existsSync(html1.stageDir),'retired begin does not recreate old staging');
 const busyAt=Date.now();await menuPdf(b);c3.busyResult=await pdfResult(b,busyAt);assert(!c3.busyResult.ok&&c3.busyResult.error==='已有一个 PDF 导出在进行中','B actual PDF returns readable busy');const busyState=await state(b);assert(busyState.banner.includes('已有一个 PDF 导出在进行中'));await shot(b,'C3-B-busy');
 c3.diagnosticOwnerRefusal=await b.evaluate(()=>window.mpHost.exportPdfCancel());assert(!c3.diagnosticOwnerRefusal.ok&&c3.diagnosticOwnerRefusal.error==='PDF 导出不属于当前窗口','B diagnostic cancel cannot cancel A');
 assert((await observe()).calls.some(c=>c.name==='export:pdf'&&c.owner===result.owners.a&&!c.settled),'A remains in flight before B folder');
 await b.locator('#mp-banner button').filter({hasText:'关闭'}).click();
 await b.locator('[data-mp-id="more"]').click();await b.locator('.mp-pop-item').filter({hasText:'导出…'}).click();await b.locator('[data-ex="folder"]').click();
 await waitUntil(()=>b.evaluate(()=>window.mpExtras.lastExport()?.ok),'B actual folder export completed',25000);c3.bFolder=(await state(b)).lastExport;assert.equal(path.resolve(c3.bFolder.dir),path.resolve(bFolder));const htmlB=fs.readFileSync(c3.bFolder.file,'utf8');assert(htmlB.includes(markerB)&&!htmlB.includes(markerA));assert(!path.resolve(c3.bFolder.file).startsWith(path.resolve(html3.stageDir)+path.sep));
 c3.beforeACancel=await observe();assert(c3.beforeACancel.calls.some(c=>c.name==='export:pdf'&&c.owner===result.owners.a&&!c.settled),'B folder completes while A remains active');assert(!c3.beforeACancel.cancelCuts.some(c=>c.owner===result.owners.b&&c.writers.some(w=>w.id===c3.preBusyWriter.id&&w.abortEntered)));
 await cancelUi(a);c3.aCanceled=await pdfResult(a,started);assert(c3.aCanceled.canceled&&!c3.aCanceled.ok);await awaitSettled(html3);assert.equal(hash(fs.readFileSync(pdf)),c2.retryPdfSha256,'cancel preserves previously completed PDF');
 assert.equal((await state(a)).source,originalA);assert.equal((await state(b)).source,originalB);assert.equal(hash(fs.readFileSync(aFile)),result.fixture.aSha256);assert.equal(hash(fs.readFileSync(bFile)),result.fixture.bSha256);
 const retryAt=Date.now();await menuPdf(b);const html4=await currentHtml(b,0);c3.bRetryPayload=html4;c3.bRetryResult=await pdfResult(b,retryAt);assert(c3.bRetryResult.ok&&c3.bRetryResult.bytes>0);await awaitSettled(html4);assert.equal(fs.readFileSync(pdf).subarray(0,5).toString(),'%PDF-');await shot(b,'C3-B-retry-success');
 const restored=await state(a);await a.bringToFront();await a.locator('.cm-line').first().click();await a.keyboard.press('Control+y');assert.equal((await state(a)).source,shortA,'A Redo survives B export');await a.keyboard.press('Control+z');assert.equal((await state(a)).source,originalA,'A Undo survives B export');assert.equal((await state(b)).source,originalB);c3.historyPreserved=true;c3.originalDocumentIdPreserved=(await state(a)).document.documentId===initialA.document.documentId;assert(c3.originalDocumentIdPreserved);c3.aSelectionBefore=restored.selection;c3.status='pass';
 result.trace=await observe();assert(result.trace.writers.every(w=>w.pending===0&&(w.finishSettled||w.abortSettled)));assert(result.errors.length===0);result.passed=true;
}catch(e){result.error=e.stack;result.passed=false;const active=result.cases.find(c=>c.status==='running');if(active){active.status='fail';active.error=e.message;}if(a)try{await shot(a,'failure-window');}catch(shotError){result.failedFrameError=shotError.message;}process.exitCode=1;}
finally{
 if(debug){try{result.finalObserver=await observe();await debug.evaluate('globalThis.__mpFrontierObserver.restore(); true');}catch(e){result.cleanupErrors.push(e.message);}debug.close();}
 if(run){try{result.cleanup=await run.cleanup();if(result.cleanup.residual.length)result.cleanupErrors.push('owned app residual');}catch(e){result.cleanupErrors.push(e.message);}}
 release?.();result.finishedAt=new Date().toISOString();
 const logs=fs.readdirSync(out).filter(n=>n.startsWith('main-')&&n.endsWith('.log')).map(n=>fs.readFileSync(path.join(out,n),'utf8')).join('\n');result.cleanupErrorLogged=logs.includes('export:pdf:cleanup-error');if(result.cleanupErrorLogged||result.cleanupErrors.length||result.errors.length){result.passed=false;process.exitCode=1;}
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),error:result.error,cleanup:result.cleanup,cleanupErrorLogged:result.cleanupErrorLogged,cleanupErrors:result.cleanupErrors}));
}
})();
