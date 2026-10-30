'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),shell=path.join(root,'MarkPilot-CM6/shell');
function actualModule(file,overrides={},extra={}){const mod={exports:{}};const {createRequire}=require('node:module'),req=createRequire(file);const context={module:mod,exports:mod.exports,require:id=>Object.hasOwn(overrides,id)?overrides[id]:req(id),process,console,Buffer,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,...extra};vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});return mod.exports;}
test('PDF accepts canonical children of an aliased temp root while rejecting stage redirection and unowned requests',{skip:process.platform!=='win32'},async()=>{
 const outer=await fsp.mkdtemp(path.join(os.tmpdir(),'markpilot-pdf-alias-')),base=await fsp.realpath(outer),temp=path.join(base,'Long Temp Directory'),alias=path.join(base,'TEMP_ALIAS');
 await fsp.mkdir(temp);await fsp.symlink(temp,alias,'junction');
 const stage=await fsp.mkdtemp(path.join(temp,'markpilot-pdf-')),html=path.join(stage,'input.html');await fsp.writeFile(html,'<p>owned</p>');
 const app={getPath:name=>{assert.equal(name,'temp');return alias;}};let admitted=0;
 try{
  const processModule=actualModule(path.join(shell,'pdf-process.js'),{'./native-worker-lease':{createNativeWorkerLease:async()=>{admitted++;throw Object.assign(Error('ADMITTED_NO_LAUNCH'),{code:'ADMITTED_NO_LAUNCH'});}}});
  await assert.rejects(processModule.printInWorker({app,htmlFile:html}),e=>e.code==='ADMITTED_NO_LAUNCH');assert.equal(admitted,1);
  const redirected=path.join(temp,'markpilot-pdf-redirect');await fsp.symlink(stage,redirected,'junction');
  await assert.rejects(processModule.printInWorker({app,htmlFile:path.join(redirected,'input.html')}),e=>e.code==='MP_PDF_STAGE');assert.equal(admitted,1);
  const outside=path.join(base,'markpilot-pdf-outside');await fsp.mkdir(outside);await fsp.writeFile(path.join(outside,'input.html'),'outside');
  await assert.rejects(processModule.printInWorker({app,htmlFile:path.join(outside,'input.html')}),e=>e.code==='MP_PDF_STAGE');assert.equal(admitted,1);

  const token=crypto.randomUUID(),runDir=path.join(stage,'pdf-worker-'+token),profile=path.join(runDir,'profile-real');await fsp.mkdir(profile,{recursive:true});
  const config=path.join(runDir,'input.json'),input={schema:1,token,runDir,stageDir:stage,htmlFile:html};await fsp.writeFile(config,JSON.stringify(input));
  // Windows 8.3 aliases survive the JS realpathSync implementation, whereas
  // realpathSync.native and promises.realpath resolve their long spelling.
  const realpathSync=p=>p===alias?alias:fs.realpathSync(p);realpathSync.native=p=>fs.realpathSync.native(p);
  const shortNameFs={...fs,realpathSync};
  function worker(candidate){let ready=0,exit=null;const errors=[];const app={getPath:name=>name==='temp'?alias:profile,whenReady(){ready++;return{then(){return{catch(){}};}};},exit:n=>{exit=n;}};
   const actual=actualModule(path.join(shell,'pdf-worker.js'),{electron:{app},'node:fs':shortNameFs}, {process:{env:{MP_PDF_WORKER_TOKEN:token},pid:process.pid},console:{error:(...x)=>errors.push(x.join(' '))}});actual.run(candidate);return{ready,exit,errors};}
  assert.equal(worker(config).ready,1,'child admits the same canonical stage under short/aliased TEMP');
  await fsp.writeFile(config,JSON.stringify({...input,token:crypto.randomUUID()}));assert.equal(worker(config).exit,2,'wrong ownership token still rejected');
  await fsp.writeFile(config,JSON.stringify({...input,stageDir:outside}));assert.equal(worker(config).exit,2,'wrong parent still rejected');

  const main=fs.readFileSync(path.join(root,'MarkPilot-CM6/main.js'),'utf8'),begin=main.indexOf('function pdfStage('),end=main.indexOf("handle('doc:info'",begin);
  assert(begin>=0&&end>begin);const session={id:'pdf-owned',owner:5,dir:stage,tempRoot:temp};
  const context={fs:shortNameFs,path,app,pdfActive:session,failure:(code,message)=>Object.assign(Error(message),{code})};vm.runInNewContext(main.slice(begin,end)+'\nglobalThis.call=pdfStage;',context);
  assert.equal(context.call({sender:{id:5}},stage,'pdf-owned'),session);
  for(const dir of [stage,path.join(alias,path.basename(stage))])assert.throws(()=>context.call({sender:{id:5}},dir),e=>e.code==='MP_EXPORT_CANCELED','both spellings remain reserved without a session token');
  assert.throws(()=>context.call({sender:{id:9}},stage,'pdf-owned'),e=>e.code==='MP_EXPORT_CANCELED');
  assert.equal(context.call({sender:{id:5}},path.join(base,'ordinary-export')),null);
  context.pdfActive=null;
  for(const dir of [stage,path.join(alias,path.basename(stage))])assert.throws(()=>context.call({sender:{id:5}},dir),e=>e.code==='MP_EXPORT_CANCELED','both spellings remain reserved after the session has ended');
  const cleanupBegin=main.indexOf('  const cleanupStaging = async () => {'),cleanupEnd=main.indexOf('\n  try {\n    progress(',cleanupBegin);assert(cleanupBegin>=0&&cleanupEnd>cleanupBegin);
  const cleanStage=await fsp.mkdtemp(path.join(temp,'markpilot-pdf-')),clean={dir:cleanStage,session:{tempRoot:temp,assetJobs:new Set(),htmlWriter:null},path,fsp,process:{env:{}},exportWriters:new Map()};
  vm.runInNewContext(main.slice(cleanupBegin,cleanupEnd)+'\nglobalThis.call=cleanupStaging;',clean);await clean.call();assert.equal(fs.existsSync(cleanStage),false,'cleanup uses the captured canonical root');
 }finally{assert.equal(await fsp.realpath(base),base);assert.equal(path.dirname(base),await fsp.realpath(os.tmpdir()));assert(path.basename(base).startsWith('markpilot-pdf-alias-'));await fsp.rm(base,{recursive:true,force:true});}
});
