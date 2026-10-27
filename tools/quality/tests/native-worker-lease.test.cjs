'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const shell=path.resolve(__dirname,'../../../MarkPilot-CM6/shell');
test('long-location worker shares concurrent saves, preserves failed transactions and drains accepted work',{skip:process.platform!=='win32',timeout:45000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mp-worker-contract-'));
 const modules=path.join(dir,'x'.repeat(259-dir.length-1-'/native/file-worker.exe'.length));
 await fs.mkdir(path.join(modules,'native'),{recursive:true});
 for(const rel of ['safe-file.js','native-worker-lease.js','native-worker-path.ps1','native/file-worker.exe','native/file-worker.exe.build.json'])await fs.copyFile(path.join(shell,rel),path.join(modules,rel));
 assert.equal(path.join(modules,'native/file-worker.exe').length,259);
 const leases=[],children=[],events=[],factory=require(path.join(modules,'native-worker-lease.js')),originalFactory=factory.createNativeWorkerLease,spawn=cp.spawn;
 let service;
 factory.createNativeWorkerLease=async()=>{for(const prior of leases)if(prior.ended)assert.equal(await fs.stat(prior.directory).then(()=>true,()=>false),false);const lease=await originalFactory();const record={directory:lease.directory,qualification:lease.qualification};leases.push(record);const cleanup=lease.cleanup;lease.cleanup=async()=>{await cleanup();record.ended=true;events.push('cleanup:'+record.directory);};return lease;};
 cp.spawn=(exe,...args)=>{const child=spawn(exe,...args);if(path.basename(exe)==='file-worker.exe'){children.push(child);events.push('spawn:'+child.pid);child.once('exit',()=>events.push('exit:'+child.pid));}return child;};
 try {
  service=require(path.join(modules,'safe-file.js'));
  async function prepare(name,old,next){const target=path.join(dir,name+'.md'),temp=path.join(dir,name+'.'+crypto.randomUUID()+'.tmp');if(old!==null)await fs.writeFile(target,old);const stage=await service.prepareFile(target,temp,{baseline:old===null?null:{sha256:sha(old)},output:{bytes:next.length,sha256:sha(next)}});return{target,temp,stage,next};}
  const old=Buffer.from('\ufeff原内容\r\nASCII\r\n'),next=Buffer.from('\ufeff新内容\r\nASCII-2\r\n'),fresh=Buffer.from('NEW\n中文\n');
  const [a,b]=await Promise.all([prepare('existing',old,next),prepare('new',null,fresh)]);
  assert.equal(children.length,1);assert.equal(leases.length,1);
  for(const x of [a,b])await fs.writeFile(x.temp,x.next,{flag:'r+'});
  await Promise.all([a.stage.commit(),b.stage.commit()]);
  assert.deepEqual(await fs.readFile(a.target),next);assert.deepEqual(await fs.readFile(b.target),fresh);
  const twice=await prepare('twice',next,Buffer.from('NEXT\r\n'));await fs.writeFile(twice.temp,twice.next,{flag:'r+'});await twice.stage.commit();assert.equal(children.length,1);assert.equal(leases.length,1);
  const lost=await prepare('precommit',Buffer.from('OLD'),Buffer.from('RECOVERY'));await fs.writeFile(lost.temp,lost.next,{flag:'r+'});const oldChild=children[0],exit=new Promise(resolve=>oldChild.once('exit',resolve));oldChild.kill();await exit;
  await assert.rejects(lost.stage.commit(),e=>e.code==='MP_FILE_WORKER_EXIT'&&e.preserveTemp===true);await lost.stage.abort();assert.equal(await fs.readFile(lost.target,'utf8'),'OLD');assert.equal(await fs.readFile(lost.temp,'utf8'),'RECOVERY');
  const accepted=await prepare('accepted',Buffer.from('BEFORE'),Buffer.from('AFTER'));
  assert.equal(children.length,2);assert.equal(leases.length,2);assert.notEqual(leases[0].directory,leases[1].directory);assert(leases[0].ended);
  let closed=false;const stop=service.shutdownFileWorker().then(r=>{closed=true;return r;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  await assert.rejects(service.prepareFile(path.join(dir,'late.md'),path.join(dir,'late.tmp'),{output:{bytes:0,sha256:sha('')}}),{code:'MP_FILE_WORKER_CLOSING'});
  await fs.writeFile(accepted.temp,accepted.next,{flag:'r+'});await accepted.stage.commit();const result=await stop;assert.equal(result.cleanupError,null);assert.equal(await fs.readFile(accepted.target,'utf8'),'AFTER');
  for(const lease of leases){assert(lease.ended);assert.equal(await fs.stat(lease.directory).then(()=>true,()=>false),false);}
  for(const child of children)assert(child.exitCode!==null||child.signalCode!==null,'actual child exit or signal');
  assert(events.indexOf('exit:'+children[0].pid)<events.indexOf('cleanup:'+leases[0].directory));assert(events.indexOf('cleanup:'+leases[0].directory)<events.indexOf('spawn:'+children[1].pid));
  const source=path.join(modules,'native/file-worker.exe'),saved=await fs.readFile(source),bad=Buffer.from(saved);bad[bad.length-1]^=1;await fs.writeFile(source,bad);const before=children.length;
  try{await assert.rejects(originalFactory(),{code:'MP_FILE_WORKER_INTEGRITY'});}finally{await fs.writeFile(source,saved);}
  assert.equal(children.length,before);
  const open=fs.open;let partialDirectory;
  fs.open=async function(file,...args){const handle=await open.call(this,file,...args);if(path.basename(file)==='file-worker.exe'&&path.basename(path.dirname(file)).startsWith('MarkPilot-file-')){partialDirectory=path.dirname(file);handle.writeFile=async()=>{};}return handle;};
  try{await assert.rejects(originalFactory(),{code:'MP_FILE_WORKER_INTEGRITY'});}finally{fs.open=open;}
  assert(partialDirectory);assert.equal(await fs.stat(partialDirectory).then(()=>true,()=>false),false);assert.equal(children.length,before);
 } finally {cp.spawn=spawn;factory.createNativeWorkerLease=originalFactory;if(service)await service.shutdownFileWorker();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
});
test('actual PowerShell ACL predicate rejects inheritable write and replace rights',{skip:process.platform!=='win32'},async()=>{
 const script=await fs.readFile(path.join(__dirname,'native-worker-acl.fixture.ps1'),'utf8');
 const exe=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const r=cp.spawnSync(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,MP_NATIVE_RULE_FILE:path.join(shell,'native-worker-path.ps1')}});
 assert.equal(r.status,0,r.stdout+'\n'+r.stderr);const rows=JSON.parse(r.stdout);assert.equal(rows.length,7);assert(rows.every(x=>x.passed));
});
