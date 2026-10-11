const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const load=Module._load;Module._load=function(name,...args){return name==='electron'?{app:{},safeStorage:{}}:load.call(this,name,...args);};
const {CompletionVault}=require('../app/main/completion-vault');
const {findPaths}=require('../app/main/completion-platform');
const {DocController}=require('../app/main/doc');Module._load=load;
const base=path.resolve(__dirname,'../.perf');
async function fixture(fn){await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'vault-unit-'));try{await fn(root);}finally{assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true});}}
test('Encrypted vault preserves two providers, serializes writes and survives reopening',()=>fixture(async root=>{
  const key=crypto.randomBytes(32),iv=crypto.randomBytes(16);
  const storage={isEncryptionAvailable:()=>true,encryptString:value=>{const c=crypto.createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([c.update(value,'utf8'),c.final()]);},decryptString:bytes=>{const d=crypto.createDecipheriv('aes-256-cbc',key,iv);return Buffer.concat([d.update(bytes),d.final()]).toString('utf8');}};
  const options={file:path.join(root,'vault.json'),crypto:storage},vault=new CompletionVault(options);
  await Promise.all([vault.store('glm','test-glm-credential'),vault.store('ds','test-ds-credential')]);
  let reopened=new CompletionVault(options);assert.equal(await reopened.get('glm'),'test-glm-credential');assert.equal(await reopened.get('ds'),'test-ds-credential');
  const raw=await fs.readFile(options.file,'utf8');assert.ok(!raw.includes('test-glm-credential')&&!raw.includes('test-ds-credential'));
  await reopened.delete('glm');assert.equal(await reopened.get('glm'),undefined);assert.equal(await reopened.get('ds'),'test-ds-credential');
  storage.isEncryptionAvailable=()=>false;await assert.rejects(reopened.store('ds','replacement'),/加密存储/);
  storage.isEncryptionAvailable=()=>true;assert.equal(await reopened.get('ds'),'test-ds-credential');
  reopened=new CompletionVault(options);assert.equal(await reopened.get('ds'),'test-ds-credential');
}));
test('Unavailable native encryption never falls back to a plaintext key file',()=>fixture(async root=>{
  const file=path.join(root,'vault.json'),vault=new CompletionVault({file,crypto:{isEncryptionAvailable:()=>false}});
  await assert.rejects(vault.store('ds','never-write-me'),/加密存储/);await assert.rejects(fs.readFile(file),{code:'ENOENT'});
}));
test('Local paths honor cancellation and bounded scans while excluding build/dependency directories',()=>fixture(async root=>{
  await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules/secret.md'),'ignore');
  await fs.mkdir(path.join(root,'notes'));await fs.writeFile(path.join(root,'notes/数学.md'),'# Notes');await fs.writeFile(path.join(root,'notes/a.png'),'image');await fs.writeFile(path.join(root,'notes/a.txt'),'ignore');
  const files=await findPaths(root,{isCancellationRequested:false});assert.deepEqual(files.map(f=>path.basename(f.fsPath)).sort(),['a.png','数学.md']);
  assert.equal((await findPaths(root,{isCancellationRequested:false},1)).length,1);
  assert.deepEqual(await findPaths(root,{isCancellationRequested:true}),[]);
}));

test('Old frame messages cannot change a newly opened file before its initialization',async()=>{
  const current={text:'new document',frameId:null},doc={current,applyText:(cur,value)=>{cur.text=value;}};
  await DocController.prototype.handleRendererMsg.call(doc,{frameId:41},{type:'change',content:'late old text'});
  assert.equal(current.text,'new document');
  current.frameId=42;
  await DocController.prototype.handleRendererMsg.call(doc,{frameId:41},{type:'change',content:'late old text'});
  assert.equal(current.text,'new document');
  await DocController.prototype.handleRendererMsg.call(doc,{frameId:42},{type:'change',content:'new edit'});
  assert.equal(current.text,'new edit');
});
