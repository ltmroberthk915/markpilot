'use strict';
// Copies one verified helper per generation. No shared cache or DACL changes.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function qualify(lease='') {
 const script=await fs.readFile(path.join(__dirname,'native-worker-path.ps1'),'utf8');
 const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 let stdout;
 try{({stdout}=await execFile(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:65536,env:{...process.env,MP_NATIVE_LEASE_PATH:lease}}));}
 catch(error){throw Object.assign(Error('找不到通过权限检查的辅助程序执行目录'),{code:'MP_NATIVE_WORKER_PATH',cause:error});}
 const report=JSON.parse(stdout.replace(/^\ufeff/,''));
 if(typeof report.base!=='string'||!report.sid||!Array.isArray(report.checks)||!report.checks.length)throw Error('Invalid worker path qualification');
 return report;
}
async function createNativeWorkerLease({name='file-worker.exe'}={}) {
 if(!['file-worker.exe','pdf-worker-guard.exe'].includes(name))throw Error('Unknown native worker');
 const baseReport=await qualify(),base=await fs.realpath(baseReport.base);
 if(path.resolve(base).toLowerCase()!==path.resolve(baseReport.base).toLowerCase())throw Error('Worker base changed during qualification');
 const prefix=path.join(base,'MarkPilot-file-'+process.pid+'-');
 if((prefix+'xxxxxx/'+name).length>240)throw Error('No short worker execution path');
 const dir=await fs.mkdtemp(prefix),file=path.join(dir,name);
 let createdFile=false;
 async function cleanup() {
  const stat=await fs.lstat(dir).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  if(!stat)return;
  if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await fs.realpath(dir)).toLowerCase()!==path.resolve(dir).toLowerCase())throw Error('Worker lease changed before cleanup');
  if(createdFile)await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  await fs.rmdir(dir); // Never recursively remove unknown entries.
 }
 try {
  const qualification=await qualify(dir);
  if(path.resolve(qualification.base).toLowerCase()!==path.resolve(base).toLowerCase()||path.resolve(qualification.lease).toLowerCase()!==path.resolve(dir).toLowerCase()||baseReport.sid!==qualification.sid)throw Error('Worker lease identity changed');
  if((await fs.lstat(dir)).isSymbolicLink()||path.resolve(await fs.realpath(dir)).toLowerCase()!==path.resolve(dir).toLowerCase())throw Error('Worker lease redirected');
  const source=path.join(__dirname,'native',name).replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
  const [data,stampText]=await Promise.all([fs.readFile(source),fs.readFile(path.join(__dirname,'native',name+'.build.json'),'utf8')]);
  const stamp=JSON.parse(stampText);
  if(!Number.isSafeInteger(stamp.bytes)||stamp.bytes<=0||!/^[a-f0-9]{64}$/.test(stamp.sha256)||data.length!==stamp.bytes||digest(data)!==stamp.sha256)throw Object.assign(Error('文件安全写入辅助程序校验失败'),{code:'MP_FILE_WORKER_INTEGRITY'});
  const handle=await fs.open(file,'wx',0o600);createdFile=true;
  try {await handle.writeFile(data);await handle.sync();} finally {await handle.close();}
  const stat=await fs.lstat(file),copy=await fs.readFile(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||copy.length!==stamp.bytes||digest(copy)!==stamp.sha256)throw Object.assign(Error('文件安全写入辅助副本校验失败'),{code:'MP_FILE_WORKER_INTEGRITY'});
  return {directory:dir,executable:file,sha256:stamp.sha256,qualification,cleanup};
 } catch(error) {try{await cleanup();}catch(cleanupError){error.workerLeaseCleanupError=String(cleanupError);error.workerLease=dir;}throw error;}
}
module.exports={createNativeWorkerLease};
