'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {createNativeWorkerLease}=require('./native-worker-lease');
let worker=null,starting=null,serial=0,closing=false,shutdown=null,operations=0;
const idleWaiters=new Set();
let operationHold=null;
async function startWorker() {
  if(worker?.failed)await worker.exited;
  const lease=await createNativeWorkerLease();
  let child;
  try {child=spawn(lease.executable,[],{cwd:lease.directory,windowsHide:true,stdio:['pipe','pipe','pipe']});}
  catch(error){await lease.cleanup().catch(cleanupError=>{error.workerLeaseCleanupError=String(cleanupError);});throw error;}
  let buffer='',failure=null,current=null,tail=Promise.resolve(),exitResolve,hasExited=false,expectedEOF=false;
  const exited=new Promise(resolve=>{exitResolve=resolve;});
  const unref=()=>{child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream.unref?.();};
  unref();
  const fail=error=>{
    if(failure)return;
    failure=error;error.preserveTemp=true;
    if(current){clearTimeout(current.timer);current.reject(error);current=null;}
    child.kill();
  };
  const instance={child,exited,lease,get failed(){return !!failure||hasExited;},rpc(command){
    // Queue deadlines start at dispatch. A failed generation is awaited before replacement.
    const job=tail.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
      if(failure)return reject(failure);
      if(expectedEOF||hasExited)return reject(Object.assign(Error('文件安全写入进程正在关闭'),{code:'MP_FILE_WORKER_CLOSING',preserveTemp:true}));
      const request=String(++serial),timer=setTimeout(()=>fail(Object.assign(Error('文件安全写入等待超时，磁盘结果待确认，恢复副本已保留'),{code:'MP_FILE_WORKER_TIMEOUT'})),30000);
      current={request,resolve,reject,timer};
      child.stdin.write(JSON.stringify({...command,request})+'\n',error=>{if(error)fail(error);});
    }));
    tail=job;return job;
  },async stop(){
    await tail.catch(()=>{});
    if(!hasExited&&!failure){expectedEOF=true;child.stdin.end();}
    child.ref();for(const stream of [child.stdin,child.stdout,child.stderr])stream.ref?.();
    let timer;
    try {await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('文件安全写入进程关闭超时，执行目录保留：'+lease.directory));},5000);})]);}
    finally {clearTimeout(timer);unref();}
    return {pid:child.pid,lease:lease.directory,cleanupError:instance.cleanupError||null};
  }};
  async function finishExit(code) {
    if(hasExited)return;
    hasExited=true;
    if(!(expectedEOF&&code===0&&!current&&!failure))fail(Object.assign(Error('文件安全写入进程已退出：'+code),{code:'MP_FILE_WORKER_EXIT'}));
    try {await lease.cleanup();}catch(error){instance.cleanupError=String(error);console.error('MarkPilot worker lease cleanup:',lease.directory,String(error));}
    if(worker===instance)worker=null;
    exitResolve();
  }
  child.on('error',error=>{fail(error);if(!child.pid)void finishExit(null);});
  child.on('exit',code=>{void finishExit(code);});
  child.stdin.on('error',fail);child.stderr.on('data',()=>{});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>65536){fail(Error('文件安全写入进程回复过长'));return;}
    let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/^\ufeff/,'');buffer=buffer.slice(end+1);let reply;
      try{reply=JSON.parse(line);}catch{fail(Error('文件安全写入进程返回无效数据'));return;}
      if(!current||reply.request!==current.request||typeof reply.result?.ok!=='boolean'){fail(Error('文件安全写入回复不属于当前操作'));return;}
      const job=current;current=null;clearTimeout(job.timer);job.resolve(reply.result);
    }
  });
  worker=instance;return instance;
}
function nativeWorker() {
  if(starting)return starting;
  if(worker&&!worker.failed)return Promise.resolve(worker);
  // Publish the shared admission promise before any asynchronous materialization.
  starting=Promise.resolve().then(startWorker).finally(()=>{starting=null;});
  return starting;
}
function finishOperation() {if(--operations===0){clearInterval(operationHold);operationHold=null;for(const resolve of idleWaiters)resolve();idleWaiters.clear();}}
async function prepareFile(...args) {
  if(process.platform!=='win32')return prepareFileImpl(...args);
  if(closing)throw Object.assign(Error('文件安全写入服务正在关闭'),{code:'MP_FILE_WORKER_CLOSING'});
  if(operations++===0)operationHold=setInterval(()=>{},60000);
  let finished=false;const done=()=>{if(!finished){finished=true;finishOperation();}};
  try {
    const stage=await prepareFileImpl(...args);
    return {
      async commit(){try{const reply=await stage.commit();done();return reply;}catch(error){if(error.preserveTemp)done();throw error;}},
      async abort(){try{return await stage.abort();}finally{done();}},
    };
  } catch(error){done();throw error;}
}
function shutdownFileWorker() {
  if(shutdown)return shutdown;
  closing=true;
  shutdown=(async()=>{
    // Accepted transactions (including asynchronous startup) retain commit/abort admission.
    if(operations)await new Promise(resolve=>idleWaiters.add(resolve));
    if(starting)await starting.catch(()=>{});
    const current=worker;
    return current?current.stop():null;
  })();
  return shutdown;
}
// Standalone Node tests/tools also close the unref'ed helper on a normal exit.
process.once('beforeExit',()=>{void shutdownFileWorker().catch(error=>console.error('MarkPilot worker shutdown:',String(error)));});
function nativeFailure(reply,temp,backup) {
  const error=Object.assign(Error('无法安全替换文件，当前草稿已保留：'+(reply.error||'未知错误')),{code:reply.code||'MP_REPLACE_FAILED',preserveTemp:!!reply.preserveTemp});
  if(error.preserveTemp)error.recoveryPaths={temp,backup};return error;
}
async function prepareFileImpl(target,temp,{baseline,output}={}) {
  if(process.platform!=='win32') {
    const before=await fs.stat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    const handle=await fs.open(temp,'wx',before?.mode??0o600);await handle.close();
    if(before){await fs.chmod(temp,before.mode);if(before.uid!==process.getuid?.()||before.gid!==process.getgid?.())await fs.chown(temp,before.uid,before.gid);}
    let done=false;
    return {async commit(){await fs.rename(temp,target);done=true;},async abort(){if(!done)await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}};
  }
  const id=crypto.randomUUID(),backup=temp+'.backup',native=await nativeWorker();let done=false,recovery=false;
  const expected={exists:!!baseline,sha256:baseline?.sha256||null};
  let prepared;
  try{prepared=await native.rpc({action:'prepare',id,target,temp,backup,expected,output});}
  catch(error){error.recoveryPaths={temp,backup};throw error;}
  if(!prepared?.ok)throw nativeFailure(prepared||{},temp,backup);
  return {
    async commit(){
      recovery=true;
      let reply;try{reply=await native.rpc({action:'commit',id});}catch(error){error.preserveTemp=true;error.recoveryPaths={temp,backup};throw error;}
      if(!reply?.ok){recovery=reply.preserveTemp!==false;throw nativeFailure(reply||{},temp,backup);}
      done=true;recovery=false;
      return {backupRetained:reply.backupRetained?backup:null};
    },
    async abort(){if(done||recovery)return;const reply=await native.rpc({action:'abort',id});if(!reply?.ok)throw nativeFailure(reply||{},temp,backup);done=true;},
  };
}
module.exports={prepareFile,shutdownFileWorker};
