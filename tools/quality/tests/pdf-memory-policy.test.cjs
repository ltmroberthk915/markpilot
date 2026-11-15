'use strict';
// Regression for tools/quality test root:
// - options.limits keeps the old one-value semantics when a legacy
//   minAvailable* override is explicit; only timing/CPU/{} opts into the new
//   1792 MiB startup + 1024 MiB runtime policy;
// - a failed memory guard returns the natural short sentence and never writes
//   the old target;
// - the native PdfMemoryPolicy.RuntimeLimit/Below functions are compiled from
//   the same production C# source with /main:PdfMemoryPolicyTests in a temp
//   directory (no product run, no environment threshold override).
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),shell=path.join(root,'MarkPilot-CM6','shell');
const productCs=path.join(root,'MarkPilot-CM6','native','PdfWorkerGuard.cs'),testCs=path.join(__dirname,'..','native','pdf-memory-policy-tests.cs');
const FALLBACK='系统内存余量不足，已停止 PDF 打印以保持系统响应，请释放内存后重试';
function actualModule(file,overrides={},extra={}){
 const mod={exports:{}};const {createRequire}=require('node:module'),req=createRequire(file);
 const context={module:mod,exports:mod.exports,require:id=>Object.hasOwn(overrides,id)?overrides[id]:req(id),process,console,Buffer,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,...extra};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});return mod.exports;
}
async function ownedTemp(prefix){
 const created=await fsp.mkdtemp(path.join(os.tmpdir(),prefix)),canonical=await fsp.realpath(created),parent=await fsp.realpath(os.tmpdir()),ownStat=await fsp.lstat(created),realStat=await fsp.lstat(canonical);
 assert.equal(path.dirname(canonical),parent,'temp directory must stay directly under the real temp root');
 assert(path.basename(created).startsWith(prefix)&&path.basename(canonical).startsWith(prefix),'temp directory must keep the exclusive prefix');
 assert(ownStat.isDirectory()&&!ownStat.isSymbolicLink(),'temp directory must be a real directory, not a link');
 assert(realStat.isDirectory()&&!realStat.isSymbolicLink()&&await fsp.realpath(created)===canonical,'temp directory must resolve to itself');
 return {created,canonical};
}
async function removeOwnedTemp(entry,prefix){
 const canonical=await fsp.realpath(entry.canonical),parent=await fsp.realpath(os.tmpdir()),ownStat=await fsp.lstat(entry.created),realStat=await fsp.lstat(canonical);
 assert.equal(canonical,entry.canonical,'refuse rm if the owned directory moved');
 assert.equal(path.dirname(canonical),parent,'refuse rm outside the real temp root');
 assert(path.basename(entry.created).startsWith(prefix)&&path.basename(canonical).startsWith(prefix),'refuse rm without the exclusive prefix');
 assert(ownStat.isDirectory()&&!ownStat.isSymbolicLink(),'refuse rm of a linked or non-directory temp entry');
 assert(realStat.isDirectory()&&!realStat.isSymbolicLink()&&await fsp.realpath(entry.created)===canonical,'refuse rm if the temp entry no longer resolves to itself');
 await fsp.rm(canonical,{recursive:true,force:true});
}
function runToFiles(command,args,dir,tag,timeout){
 const out=path.join(dir,tag+'.stdout.txt'),err=path.join(dir,tag+'.stderr.txt'),outFd=fs.openSync(out,'w'),errFd=fs.openSync(err,'w'),r=(()=>{try{return spawnSync(command,args,{stdio:['ignore',outFd,errFd],windowsHide:true,timeout});}finally{fs.closeSync(outFd);fs.closeSync(errFd);}})();
 return {status:r.status,signal:r.signal,error:r.error,stdout:fs.readFileSync(out,'utf8'),stderr:fs.readFileSync(err,'utf8')};
}
const describe=r=>`status=${r.status} signal=${r.signal} error=${r.error}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
function fakeSpawn(resultFor,seen){
 return (exe,args)=>{
  const config=JSON.parse(fs.readFileSync(args[0],'utf8'));seen.push(config);
  const guard={...resultFor(config),ownerToken:config.ownerToken,jobEmpty:true,cleanupError:null};
  fs.writeFileSync(path.join(config.runDir,'guard-launch.json'),JSON.stringify({ownerToken:config.ownerToken,rootPid:4242}));
  fs.writeFileSync(path.join(config.runDir,'guard-result.json'),JSON.stringify(guard));
  const child=new EventEmitter();child.pid=4242;child.stderr=new EventEmitter();child.kill=()=>{};
  setImmediate(()=>child.emit('close',2,null));return child;
 };
}
async function runCase({limits,guard,expectedMessage,checkConfig}){
 const owned=await ownedTemp('mp-pdf-memory-'),temp=owned.canonical;
 const stage=await fsp.mkdtemp(path.join(temp,'markpilot-pdf-'));
 const html=path.join(stage,'input.html'),target=path.join(temp,'target.pdf');
 await fsp.writeFile(html,'<p>owned</p>');await fsp.writeFile(target,'ORIGINAL-TARGET');
 const seen=[];
 const processModule=actualModule(path.join(shell,'pdf-process.js'),{
  'node:child_process':{spawn:fakeSpawn(()=>guard,seen)},
  './native-worker-lease':{createNativeWorkerLease:async()=>({executable:'fake-guard.exe',sha256:'0'.repeat(64),cleanup:async()=>{}})}
 });
 const app={isPackaged:true,getAppPath:()=>root,getPath:name=>{assert.equal(name,'temp');return temp;}};
 try{
  await assert.rejects(processModule.printInWorker({app,htmlFile:html,outFile:target,...(limits===undefined?{}:{limits})}),error=>{
   assert.equal(error.code,'MP_PDF_MEMORY');
   assert.equal(error.message,expectedMessage);
   assert.equal(fs.readFileSync(target,'utf8'),'ORIGINAL-TARGET','old target must stay untouched');
   assert.equal(fs.readdirSync(temp).some(name=>name.startsWith('.mp-pdf-')),false,'no partial target next to the old file');
   const config=JSON.parse(fs.readFileSync(path.join(error.worker.runDir,'guard-config.json'),'utf8'));
   checkConfig(config);
   return true;
  });
  assert.equal(seen.length,1,'guard was spawned once');
 }finally{await removeOwnedTemp(owned,'mp-pdf-memory-');}
}
const startupAvailable={reason:'guard infrastructure error',error:'InvalidOperationException: MP_PDF_LOW_MEMORY: insufficient available memory before worker creation',memoryErrorStage:'startup',memoryErrorResource:'available',memoryErrorActualMB:1500.4,memoryErrorLimitMB:1792};
const startupCommit={reason:'guard infrastructure error',error:'InvalidOperationException: MP_PDF_LOW_MEMORY: insufficient system commit headroom before worker creation',memoryErrorStage:'startup',memoryErrorResource:'commit',memoryErrorActualMB:1600.5,memoryErrorLimitMB:1792};
const runtimeAvailable={reason:'system available memory threshold',memoryErrorStage:'runtime',memoryErrorResource:'available',memoryErrorActualMB:1000.4,memoryErrorLimitMB:1024};
const runtimeCommit={reason:'system commit memory threshold',memoryErrorStage:'runtime',memoryErrorResource:'commit',memoryErrorActualMB:990.5,memoryErrorLimitMB:1024};
const privateCap={reason:'owned private bytes threshold',memoryErrorStage:'private',memoryErrorResource:'private',memoryErrorActualMB:2600.3,memoryErrorLimitMB:2560};
test('default call sends 1792 MiB startup and 1024 MiB runtime on both dimensions',async()=>{
 await runCase({guard:startupAvailable,expectedMessage:'可用内存为 1500.4 MiB，开始打印至少需要 1792 MiB。',checkConfig:config=>{
  assert.deepEqual({startupAvailable:config.minAvailableMB,startupCommit:config.minAvailableCommitMB,runtimeAvailable:config.runtimeMinAvailableMB,runtimeCommit:config.runtimeMinAvailableCommitMB},{startupAvailable:1792,startupCommit:1792,runtimeAvailable:1024,runtimeCommit:1024});
 }});
});
test('legacy minAvailableMB override keeps one value for both stages and the old commit default',async()=>{
 await runCase({limits:{minAvailableMB:2048},guard:{...startupAvailable,memoryErrorActualMB:1900.4,memoryErrorLimitMB:2048},expectedMessage:'可用内存为 1900.4 MiB，开始打印至少需要 2048 MiB。',checkConfig:config=>{
  assert.equal(config.minAvailableMB,2048);assert.equal(config.minAvailableCommitMB,3072);
  assert.equal('runtimeMinAvailableMB' in config,false);assert.equal('runtimeMinAvailableCommitMB' in config,false);
 }});
});
test('legacy minAvailableCommitMB override keeps one value for both stages',async()=>{
 await runCase({limits:{minAvailableCommitMB:1536},guard:{...startupCommit,memoryErrorActualMB:1400.5,memoryErrorLimitMB:1536},expectedMessage:'可用提交量为 1400.5 MiB，开始打印至少需要 1536 MiB。',checkConfig:config=>{
  assert.equal(config.minAvailableMB,3072);assert.equal(config.minAvailableCommitMB,1536);
  assert.equal('runtimeMinAvailableMB' in config,false);assert.equal('runtimeMinAvailableCommitMB' in config,false);
 }});
});
test('only a timing or CPU override still uses the new two-stage policy',async()=>{
 await runCase({limits:{maxDurationMs:60000},guard:runtimeAvailable,expectedMessage:'可用内存为 1000.4 MiB，继续打印至少需要 1024 MiB。',checkConfig:config=>{
  assert.equal(config.minAvailableMB,1792);assert.equal(config.runtimeMinAvailableMB,1024);assert.equal(config.maxDurationMs,60000);
 }});
});
test('an empty limits object uses the new two-stage policy',async()=>{
 await runCase({limits:{},guard:runtimeCommit,expectedMessage:'可用提交量为 990.5 MiB，继续打印至少需要 1024 MiB。',checkConfig:config=>{
  assert.equal(config.minAvailableMB,1792);assert.equal(config.minAvailableCommitMB,1792);assert.equal(config.runtimeMinAvailableMB,1024);assert.equal(config.runtimeMinAvailableCommitMB,1024);
 }});
});
test('explicit runtime keys keep the 1792 MiB startup line and override only runtime',async()=>{
 await runCase({limits:{runtimeMinAvailableMB:1536,runtimeMinAvailableCommitMB:1536},guard:privateCap,expectedMessage:'PDF 打印进程已用私有内存 2600.3 MiB，上限为 2560 MiB。',checkConfig:config=>{
  assert.equal(config.minAvailableMB,1792);assert.equal(config.minAvailableCommitMB,1792);assert.equal(config.runtimeMinAvailableMB,1536);assert.equal(config.runtimeMinAvailableCommitMB,1536);
 }});
});
test('an old helper without structured fields keeps the old generic sentence',async()=>{
 await runCase({guard:{reason:'system available memory threshold'},expectedMessage:FALLBACK,checkConfig:()=>{}});
});
test('one byte below the startup line is shown as 1791.9, never 1792.0',async()=>{
 await runCase({guard:{...startupAvailable,memoryErrorActualMB:1791.999999},expectedMessage:'可用内存为 1791.9 MiB，开始打印至少需要 1792 MiB。',checkConfig:()=>{}});
});
test('native RuntimeLimit/Below regression compiles the production source with /main:',{skip:process.platform!=='win32'},async(t)=>{
 const compiler=path.join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 if(!fs.existsSync(compiler))return t.skip('csc unavailable');
 const owned=await ownedTemp('mp-pdf-policy-'),dir=owned.canonical;
 try{
  const exe=path.join(dir,'PdfMemoryPolicyTests.exe');
  const compiled=runToFiles(compiler,['/nologo','/target:exe','/platform:x64','/main:PdfMemoryPolicyTests','/reference:System.Web.Extensions.dll','/out:'+exe,productCs,testCs],dir,'csc');
  assert.equal(compiled.status,0,'native policy fixture compiles\n'+describe(compiled));
  const run=runToFiles(exe,[],dir,'run',120000);
  assert.equal(run.status,0,'native policy fixture passes\n'+describe(run));
 }finally{await removeOwnedTemp(owned,'mp-pdf-policy-');}
});
