'use strict';
// Copies one verified helper per generation. No shared cache or DACL changes.
// 冷路径单助手：一次 PowerShell 进程完成两段资格验证，顺序与原版一致——
// Q1 base → Node 独占 mkdtemp + 重解析核验 → Q2 从头复查 base+lease → END →
// 身份/重解析核验 → 之后才读取、独占创建并校验辅助程序副本。规则、realpath、
// mkdtemp、hash/长度/硬链接/权限/清理与失败即拒全部保留。行协议帧经有界队列
// 按序消费（早到/合并/post-close 缓冲均合法），END 后验证无多余帧与退出码；
// 任何失败、超时或 EOF（父进程退出）都有界地终止助手，不留驻 shell。
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const STEP_TIMEOUT=10000, OUT_BUDGET=262144, FRAME_LIMIT=64, ERR_BUDGET=8192, EXIT_TIMEOUT=5000;
const workerPathError=cause=>Object.assign(Error('找不到通过权限检查的辅助程序执行目录'),{code:'MP_NATIVE_WORKER_PATH',cause});

function parseReport(line,tag){
  if(typeof line!=='string'||!line.startsWith(tag+' '))throw workerPathError(Error('资格验证助手输出帧无效'));
  let report;
  try{report=JSON.parse(line.slice(tag.length+1));}catch(error){throw workerPathError(error);}
  if(typeof report.base!=='string'||!report.sid||!Array.isArray(report.checks)||!report.checks.length)throw workerPathError(Error('Invalid worker path qualification'));
  return report;
}

async function startHandshake() {
  const script=await fs.readFile(path.join(__dirname,'native-worker-path.ps1'),'utf8');
  const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,MP_NATIVE_LEASE_HANDSHAKE:'1',MP_NATIVE_LEASE_PATH:''}});
  const frames=[];let framesBytes=0,buffer='',stderrText='',waiter=null,failed=null,closed=false;
  const wake=()=>{const w=waiter;waiter=null;if(w)w.resolve();};
  const fail=error=>{if(failed)return;failed=error;try{child.kill();}catch{/* 已退 */}wake();};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    if(failed)return;
    buffer+=chunk;
    let end;
    while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
      frames.push(line);framesBytes+=line.length;
    }
    if(frames.length>FRAME_LIMIT||framesBytes>OUT_BUDGET||buffer.length>OUT_BUDGET)return fail(Error('资格验证助手输出超界'));
    wake();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderrText+=chunk;if(stderrText.length>ERR_BUDGET)fail(Error('资格验证助手错误输出超界'));});
  child.on('error',fail);
  child.on('close',()=>{closed=true;wake();});
  async function step(promise,label){
    let timer=null;
    try{
      return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>{const error=Error('资格验证助手'+label+'超时');fail(error);reject(workerPathError(error));},STEP_TIMEOUT);
        if(timer.unref)timer.unref();
      })]);
    } finally { if(timer)clearTimeout(timer); }
  }
  // 有界帧队列：合法帧先缓存后按序消费；child 关闭后仍可消费已完整缓冲的帧。
  async function readLine(){
    for(;;){
      if(frames.length)return frames.shift();
      if(failed)throw workerPathError(failed);
      if(closed)throw workerPathError(Error('资格验证助手提前退出'));
      await step(new Promise(resolve=>{waiter={resolve};}),'等待输出');
    }
  }
  const write=frame=>new Promise((resolve,reject)=>{
    if(failed||closed)return reject(workerPathError(failed||Error('资格验证助手提前退出')));
    child.stdin.write(frame,'utf8',error=>error?reject(workerPathError(error)):resolve());
  });
  const finish=async()=>{ // END 已收：无多余帧、干净退出（有界）
    if(frames.length)throw workerPathError(Error('资格验证助手输出多余帧'));
    if(!closed)await step(new Promise(resolve=>{if(closed)return resolve();child.once('close',resolve);}),'退出');
    if(child.exitCode!==0)throw workerPathError(Error('资格验证助手退出码异常：'+child.exitCode));
  };
  const kill=async()=>{ // 有界终止：EOF + kill + 有限等待 + 兜底 SIGKILL
    try{child.stdin.end();}catch{/* 已断 */}
    if(child.exitCode===null&&child.signalCode===null){try{child.kill();}catch{/* 已退 */}}
    await step(new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('close',resolve);}),'终止');
    if(child.exitCode===null&&child.signalCode===null){try{child.kill('SIGKILL');}catch{/* 已退 */}}
  };
  return {child,readLine,write,finish,kill};
}

async function createNativeWorkerLease({name='file-worker.exe'}={}) {
  if(!['file-worker.exe','pdf-worker-guard.exe'].includes(name))throw Error('Unknown native worker');
  const handshake=await startHandshake();
  let dir=null,createdFile=false;
  async function cleanup() {
    const stat=await fs.lstat(dir).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
    if(!stat)return;
    if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await fs.realpath(dir)).toLowerCase()!==path.resolve(dir).toLowerCase())throw Error('Worker lease changed before cleanup');
    if(createdFile)await fs.unlink(path.join(dir,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await fs.rmdir(dir); // Never recursively remove unknown entries.
  }
  try {
    const first=parseReport(await handshake.readLine(),'Q1');
    const base=await fs.realpath(first.base);
    if(path.resolve(base).toLowerCase()!==path.resolve(first.base).toLowerCase())throw Error('Worker base changed during qualification');
    const prefix=path.join(base,'MarkPilot-file-'+process.pid+'-');
    if((prefix+'xxxxxx/'+name).length>240)throw Error('No short worker execution path');
    dir=await fs.mkdtemp(prefix);
    const file=path.join(dir,name);
    // 原精确顺序：先完成第二段资格与身份/重解析核验，之后才写入辅助程序。
    if((await fs.lstat(dir)).isSymbolicLink()||path.resolve(await fs.realpath(dir)).toLowerCase()!==path.resolve(dir).toLowerCase())throw Error('Worker lease redirected');
    await handshake.write('LEASE\t'+Buffer.from(dir,'utf16le').toString('base64')+'\n');
    const second=parseReport(await handshake.readLine(),'Q2');
    if((await handshake.readLine())!=='END')throw Error('Worker handshake footer missing');
    if(path.resolve(second.base).toLowerCase()!==path.resolve(first.base).toLowerCase()
      ||path.resolve(second.lease).toLowerCase()!==path.resolve(dir).toLowerCase()
      ||second.sid!==first.sid)throw Error('Worker lease identity changed');
    if((await fs.lstat(dir)).isSymbolicLink()||path.resolve(await fs.realpath(dir)).toLowerCase()!==path.resolve(dir).toLowerCase())throw Error('Worker lease redirected');
    await handshake.finish();
    const source=path.join(__dirname,'native',name).replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
    const [data,stampText]=await Promise.all([fs.readFile(source),fs.readFile(path.join(__dirname,'native',name+'.build.json'),'utf8')]);
    const stamp=JSON.parse(stampText);
    if(!Number.isSafeInteger(stamp.bytes)||stamp.bytes<=0||!/^[a-f0-9]{64}$/.test(stamp.sha256)||data.length!==stamp.bytes||digest(data)!==stamp.sha256)throw Object.assign(Error('文件安全写入辅助程序校验失败'),{code:'MP_FILE_WORKER_INTEGRITY'});
    const handle=await fs.open(file,'wx',0o600);createdFile=true;
    try {await handle.writeFile(data);await handle.sync();} finally {await handle.close();}
    const stat=await fs.lstat(file),copy=await fs.readFile(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||copy.length!==stamp.bytes||digest(copy)!==stamp.sha256)throw Object.assign(Error('文件安全写入辅助副本校验失败'),{code:'MP_FILE_WORKER_INTEGRITY'});
    return {directory:dir,executable:file,sha256:stamp.sha256,qualification:second,cleanup};
  } catch(error) {
    await handshake.kill().catch(()=>{});
    if(dir){try{await cleanup();}catch(cleanupError){error.workerLeaseCleanupError=String(cleanupError);error.workerLease=dir;}}
    throw error;
  }
}
module.exports={createNativeWorkerLease};
