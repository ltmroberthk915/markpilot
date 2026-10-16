'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
let worker=null,serial=0;
async function nativeWorker() {
  if(worker?.failed)await worker.exited;
  if(worker&&!worker.failed)return worker;
  const executable=path.join(__dirname,'native/file-worker.exe').replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
  const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer='',failure=null,current=null,tail=Promise.resolve(),exitResolve;
  const exited=new Promise(resolve=>{exitResolve=resolve;});
  child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream.unref?.();
  const fail=error=>{
    if(failure)return;
    failure=error;error.preserveTemp=true;
    if(current){clearTimeout(current.timer);current.reject(error);current=null;}
    child.kill();
  };
  const instance={child,exited,get failed(){return !!failure;},rpc(command){
    // Queue in Node: execution deadlines start when a command is sent, and a
    // poisoned generation cannot overlap a replacement worker's commits.
    const job=tail.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
      if(failure)return reject(failure);
      const request=String(++serial),timer=setTimeout(()=>fail(Object.assign(Error('文件安全写入等待超时，磁盘结果待确认，恢复副本已保留'),{code:'MP_FILE_WORKER_TIMEOUT'})),30000);
      current={request,resolve,reject,timer};
      child.stdin.write(JSON.stringify({...command,request})+'\n',error=>{if(error)fail(error);});
    }));
    tail=job;return job;
  }};
  child.on('error',error=>{fail(error);if(!child.pid)exitResolve();});
  child.on('exit',code=>{fail(Object.assign(Error('文件安全写入进程已退出：'+code),{code:'MP_FILE_WORKER_EXIT'}));exitResolve();if(worker===instance)worker=null;});
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
function nativeFailure(reply,temp,backup) {
  const error=Object.assign(Error('无法安全替换文件，当前草稿已保留：'+(reply.error||'未知错误')),{code:reply.code||'MP_REPLACE_FAILED',preserveTemp:!!reply.preserveTemp});
  if(error.preserveTemp)error.recoveryPaths={temp,backup};return error;
}
async function prepareFile(target,temp,{baseline,output}={}) {
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
module.exports={prepareFile};
