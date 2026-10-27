'use strict';
// Chromium PDF/font work can block its Browser main thread. Keep that thread
// outside the editor, and let an independent Windows Job supervisor stop it.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {createNativeWorkerLease}=require('./native-worker-lease');
const {prepareFile}=require('./safe-file');
const pdf=require('../export-pdf');
const LIMITS=Object.freeze({jobMemoryMB:3072,maxPrivateMB:2560,minAvailableMB:3072,minAvailableCommitMB:3072,cpuRatePercent:25,maxDurationMs:290000,sampleIntervalMs:250});
const active=new Set();let closing=false;
const canceled=()=>Object.assign(Error('已取消导出 PDF'),{canceled:true});
const fail=(code,message,extra={})=>Object.assign(Error(message),{code,...extra});
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
async function atomicJson(file,value){const temp=file+'.next';await fsp.writeFile(temp,JSON.stringify(value),{mode:0o600});await fsp.rename(temp,file);}
async function readJson(file,max=1024*1024){const s=await fsp.stat(file);if(s.size>max)throw Error('PDF 工作进程回复过大');return JSON.parse(await fsp.readFile(file,'utf8'));}
async function hashFile(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
async function inspectPdf(file){
 const st=await fsp.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<8||st.size>pdf.GATE.PDF_MAX_BYTES)throw fail('MP_PDF_OUTPUT','PDF 文件不完整或超出大小上限');
 const h=crypto.createHash('sha256');let bytes=0,pages=0,carry='',tail=Buffer.alloc(0),header='';
 for await(const b of fs.createReadStream(file,{highWaterMark:pdf.GATE.SCAN_CHUNK_BYTES})){
  if(!bytes)header=b.subarray(0,5).toString('ascii');bytes+=b.length;h.update(b);
  const s=carry+b.toString('latin1'),old=carry.length;
  // A chunk ending in /Page has no following byte yet: it might be /Pages.
  for(const m of s.matchAll(/\/Type\s*\/Page\b/g)){const end=m.index+m[0].length;if(end>=old&&end<s.length)pages++;}
  carry=s.slice(-128);tail=Buffer.concat([tail,b]).subarray(-1024);
 }
 if(header!=='%PDF-'||!/%%EOF\s*$/.test(tail.toString('latin1'))||!pages||bytes!==st.size)throw fail('MP_PDF_OUTPUT','PDF 文件未完成，已保留原保存目标');
 return {bytes,pages,sha256:h.digest('hex')};
}
async function publishPdf(source,target,info,{isCanceled,onPhase,onPublishing,validateTarget,commitPublication}={}){
 if(isCanceled?.())throw canceled();
 await validateTarget?.();
 const before=await fsp.stat(target).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
 if(before&&!before.isFile())throw fail('MP_PDF_TARGET','PDF 保存目标不是文件');
 const baseline=before?{sha256:await hashFile(target)}:null,temp=path.join(path.dirname(target),'.mp-pdf-'+process.pid+'-'+crypto.randomUUID());
 let transaction,handle,committed=false,written=0,chunks=0;const h=crypto.createHash('sha256');
 try{
  if(isCanceled?.())throw canceled();
  transaction=await prepareFile(target,temp,{baseline,output:{bytes:info.bytes,sha256:info.sha256}});
  handle=await fsp.open(temp,'r+');
  for await(const b of fs.createReadStream(source,{highWaterMark:pdf.GATE.WRITE_CHUNK_BYTES})){
   if(isCanceled?.())throw canceled();let off=0;
   while(off<b.length){const n=await handle.write(b,off,b.length-off,null);if(!n.bytesWritten)throw Error('PDF 写入未前进');off+=n.bytesWritten;}
   h.update(b);written+=b.length;chunks++;onPhase?.({phase:'write',done:written,bytes:info.bytes,chunks});
  }
  await handle.sync();await handle.close();handle=null;
  if(written!==info.bytes||h.digest('hex')!==info.sha256)throw fail('MP_PDF_OUTPUT','PDF 在保存前发生变化，已保留原保存目标');
  if(isCanceled?.())throw canceled();
  // Commit admission is the cancellation boundary. The existing safe-file
  // transaction preserves the old target until its atomic replacement.
  const commit=async()=>{if(isCanceled?.())throw canceled();onPublishing?.();await transaction.commit();committed=true;};
  if(commitPublication)await commitPublication(commit);else await commit();
  return {bytes:written,chunks};
 }catch(error){
  if(handle)await handle.close().catch(()=>{});
  if(transaction&&!committed)try{await transaction.abort();}catch(e){error.publishCleanupError=String(e);error.preserveTemp=true;error.recoveryPaths={temp};}
  throw error;
 }
}
function printInWorker(options){
 if(process.platform!=='win32')return pdf.printLocalHtmlToPdf(options);
 if(closing)return Promise.reject(fail('MP_PDF_CLOSING','PDF 导出服务正在关闭'));
 let finish;const job={stopReason:null,runDir:null,child:null,exited:false,done:new Promise(r=>{finish=r;})};active.add(job);
 const requestedCancel=()=>job.stopReason==='canceled'||options.isCanceled?.()||options.signal?.aborted;
 const stop=reason=>{
  if(!job.stopReason)job.stopReason=reason;
  if(!job.runDir||job.exited)return Promise.resolve();
  return job.stopWriting||=(atomicJson(path.join(job.runDir,'guard-stop.json'),{ownerToken:job.token}).catch(e=>{job.stopWriteError=String(e);job.stopWriting=null;}));
 };
 job.stop=stop;
 const abort=()=>{void stop('canceled');};options.signal?.addEventListener('abort',abort,{once:true});
 return (async()=>{
  const t0=Date.now();let lease,timer,escalate,pollTimer,polling=null,result,published=false,stderr='';
  let guard=null,launch=null,relayed=0;
  const emit=p=>{try{options.onPhase?.(p);}catch{}};
  async function poll(){
   if(polling)return polling;
   polling=(async()=>{
    try{const p=await readJson(path.join(job.runDir,'progress.json'));if(p.token!==job.token||!Array.isArray(p.phases))throw Error('PDF 进度不属于本次导出');for(const phase of p.phases.slice(relayed))emit(phase);relayed=p.phases.length;}
    catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))job.progressError=String(e);}
   })().finally(()=>{polling=null;});return polling;
  }
  try{
   if(requestedCancel())throw canceled();
   const stage=path.dirname(path.resolve(options.htmlFile)),temp=path.resolve(options.app.getPath('temp'));
   if(!same(path.dirname(stage),temp)||!path.basename(stage).startsWith('markpilot-pdf-')||!same(await fsp.realpath(stage),stage))throw fail('MP_PDF_STAGE','PDF 临时目录不属于本次导出');
   job.token=crypto.randomUUID();job.runDir=path.join(stage,'pdf-worker-'+job.token);await fsp.mkdir(job.runDir);
   const profile=path.join(job.runDir,'profile-real');await fsp.mkdir(profile);
   const stagedPdf=path.join(job.runDir,'output.pdf'),inputFile=path.join(job.runDir,'input.json');
   const input={schema:1,token:job.token,runDir:job.runDir,stageDir:stage,htmlFile:path.resolve(options.htmlFile),extraCss:options.extraCss||'',sourceBytes:options.sourceBytes||0};
   for(const k of ['css','kp','print','showWindow'])if(k in options)input[k]=options[k];
   await atomicJson(inputFile,input);
   lease=await createNativeWorkerLease({name:'pdf-worker-guard.exe'});
   const argv=[...(options.app.isPackaged?[]:[options.app.getAppPath()]),'--mp-pdf-worker='+inputFile,'--user-data-dir='+profile];
   const limits={...LIMITS,...options.limits};
   const config={runDir:job.runDir,exePath:process.execPath,profilePath:profile,expectedExeSha256:await hashFile(process.execPath),workingDirectory:job.runDir,arguments:argv,runnerPid:process.pid,ownerToken:job.token,...limits};
   const configFile=path.join(job.runDir,'guard-config.json');await atomicJson(configFile,config);
   if(requestedCancel())throw canceled();
   const env={...process.env,MP_PDF_WORKER_TOKEN:job.token};delete env.ELECTRON_RUN_AS_NODE;
   const child=job.child=spawn(lease.executable,[configFile],{cwd:job.runDir,env,windowsHide:true,stdio:['ignore','ignore','pipe']});
   child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16384);});
   const exited=new Promise(resolve=>{child.once('error',e=>{job.spawnError=String(e);});child.once('close',(code,signal)=>{job.exited=true;resolve({code,signal});});});
   pollTimer=setInterval(()=>{void poll();if(requestedCancel())void stop('canceled');},100);
   timer=setTimeout(()=>{void stop('timeout');escalate=setTimeout(()=>{if(!job.exited)child.kill();},6000);},limits.maxDurationMs+1000);
   const exit=await exited;clearTimeout(timer);clearTimeout(escalate);clearInterval(pollTimer);if(polling)await polling;await poll();
   launch=await readJson(path.join(job.runDir,'guard-launch.json')).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
   guard=await readJson(path.join(job.runDir,'guard-result.json')).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
   const worker={pid:launch?.rootPid,helperPid:child.pid,exit,guard,guardSha256:lease.sha256,runDir:job.runDir};
   if(guard&&guard.ownerToken!==job.token)throw fail('MP_PDF_IDENTITY','PDF 进程回执不属于本次导出',{worker,preserveStage:true});
   if(guard?.jobEmpty===false||guard?.cleanupError)throw fail('MP_PDF_CLEANUP','PDF 进程清理未确认，临时文件已保留',{worker,preserveStage:true});
   if(requestedCancel()){
    if(!guard&&launch)throw fail('MP_PDF_CLEANUP','PDF 取消后的进程清理未确认',{worker,preserveStage:true});
    return {ok:false,canceled:true,worker,ms:Date.now()-t0};
   }
   if(job.stopReason==='timeout'||guard?.reason==='owned total duration threshold')throw fail('MP_PDF_TIMEOUT','PDF 打印超过等待上限，已停止打印进程，请重试',{worker});
   if(/memory threshold|private bytes threshold/.test(guard?.reason||'')||guard?.error?.includes('MP_PDF_LOW_MEMORY'))throw fail('MP_PDF_MEMORY','系统内存余量不足，已停止 PDF 打印以保持系统响应，请释放内存后重试',{worker});
   if(exit.code!==0||!guard?.success||!guard.assignedBeforeResume||!guard.jobEmpty||guard.rootPid===process.pid)throw fail('MP_PDF_WORKER','PDF 打印进程未正常完成，原保存目标未改动',{worker,detail:job.spawnError||stderr});
   result=await readJson(path.join(job.runDir,'result.json'));
   if(result.token!==job.token||result.pid!==guard.rootPid||!result.result?.ok)throw fail('MP_PDF_WORKER',result.result?.error||'PDF 打印结果无效',{worker});
   const r=result.result,info=await inspectPdf(stagedPdf);
   if(info.bytes!==r.bytes||info.pages!==r.pages||!same(r.file,stagedPdf))throw fail('MP_PDF_OUTPUT','PDF 字节或页数校验失败，原保存目标未改动',{worker});
   if(requestedCancel())throw canceled();
   const publish=()=>publishPdf(stagedPdf,options.outFile,info,{isCanceled:requestedCancel,onPhase:emit,onPublishing:options.onPublishing,validateTarget:options.validateTarget,commitPublication:options.commitPublication});
   const copied=await(options.withPublication?options.withPublication(publish):publish());published=true;
   emit({phase:'write-done',bytes:info.bytes,chunks:copied.chunks,ms:Date.now()-t0});
   return {...r,file:options.outFile,bytes:info.bytes,pages:info.pages,chunks:copied.chunks,ms:Date.now()-t0,worker:{...worker,sha256:info.sha256}};
  }catch(error){if(error.canceled)return {ok:false,canceled:true,ms:Date.now()-t0};throw error;}
  finally{
   clearTimeout(timer);clearTimeout(escalate);clearInterval(pollTimer);if(polling)await polling;
   options.signal?.removeEventListener('abort',abort);
   if(lease)try{await lease.cleanup();}catch(e){if(published)console.error('PDF guard lease cleanup:',String(e));else if(!result)console.error('PDF guard lease retained:',String(e));}
  }
 })().finally(()=>{active.delete(job);finish();});
}
async function shutdownPdfWorkers(){closing=true;const jobs=[...active];await Promise.all(jobs.map(j=>j.stop('canceled')));await Promise.all(jobs.map(j=>j.done));}
module.exports={printInWorker,shutdownPdfWorkers,inspectPdf,publishPdf,LIMITS};
