'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {prepareFile}=require('../../../MarkPilot-CM6/shell/safe-file');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
async function owned(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'markpilot-native-'));try{await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
async function prepare(dir,old='OLD',next='NEW') {const target=path.join(dir,'note.md'),temp=path.join(dir,'.owned.tmp');if(old!==null)await fs.writeFile(target,old);const stage=await prepareFile(target,temp,{baseline:old===null?null:{sha256:hash(old)},output:{bytes:Buffer.byteLength(next),sha256:hash(next)}});await fs.writeFile(temp,next,{flag:'r+'});return {target,temp,stage};}
test('native execution rechecks a version changed after Node staging',{skip:process.platform!=='win32'},()=>owned(async dir=>{
 const {target,temp,stage}=await prepare(dir);await fs.writeFile(target,'EXTERNAL');await assert.rejects(stage.commit(),e=>e.code==='MP_FILE_CONFLICT');await stage.abort();assert.equal(await fs.readFile(target,'utf8'),'EXTERNAL');await assert.rejects(fs.stat(temp),{code:'ENOENT'});
}));
test('native output digest rejects a modified staging file',{skip:process.platform!=='win32'},()=>owned(async dir=>{
 const {target,temp,stage}=await prepare(dir);await fs.writeFile(temp,'BAD');await assert.rejects(stage.commit(),e=>e.code==='MP_FILE_CONFLICT');await stage.abort();assert.equal(await fs.readFile(target,'utf8'),'OLD');
}));
test('native prepare never treats a missing original as a new default-ACL document',{skip:process.platform!=='win32'},()=>owned(async dir=>{
 const target=path.join(dir,'missing.md'),temp=path.join(dir,'.owned.tmp');await assert.rejects(prepareFile(target,temp,{baseline:{sha256:hash('OLD')},output:{bytes:3,sha256:hash('NEW')}}));await assert.rejects(fs.stat(temp),{code:'ENOENT'});
}));
test('native commit catches a newly added hard link',{skip:process.platform!=='win32'},()=>owned(async dir=>{
 const {target,stage}=await prepare(dir);const alias=path.join(dir,'alias.md');await fs.link(target,alias);await assert.rejects(stage.commit(),e=>e.code==='MP_FILE_LINKED');await stage.abort();assert.equal(await fs.readFile(alias,'utf8'),'OLD');
}));
test('native new and existing documents support an owned path longer than 260 characters',{skip:process.platform!=='win32'},()=>owned(async dir=>{
 const deep=path.join(dir,...Array.from({length:7},(_,i)=>'long folder '+i+' xxxxxxxxxxxxxxxxxxxxx'));await fs.mkdir(deep,{recursive:true});const {target,stage}=await prepare(deep,null);assert(target.length>260);await stage.commit();await stage.abort();assert.equal(await fs.readFile(target,'utf8'),'NEW');
 const second=await prepareFile(target,path.join(deep,'.second.tmp'),{baseline:{sha256:hash('NEW')},output:{bytes:4,sha256:hash('NEXT')}});await fs.writeFile(path.join(deep,'.second.tmp'),'NEXT',{flag:'r+'});await second.commit();assert.equal(await fs.readFile(target,'utf8'),'NEXT');
}));
