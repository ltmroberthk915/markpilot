'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {DocumentStore,createSession}=require(process.env.MP_TEST_DOCUMENT_STORE ? path.resolve(process.env.MP_TEST_DOCUMENT_STORE) : '../../../MarkPilot-CM6/shell/document-store');
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
async function fixture(t,options){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'markpilot-store-'));
 t.after(async()=>{const actual=await fs.realpath(dir),parent=await fs.realpath(os.tmpdir());assert.equal(path.dirname(actual),parent);assert(path.basename(actual).startsWith('markpilot-store-'));await fs.rm(actual,{recursive:true,force:true});});
 const store=new DocumentStore(options),file=path.join(dir,'a.md');await fs.writeFile(file,'original\n');const S=createSession();await store.load(S,file);return {dir,store,file,S};
}
function edit(store,S,revision){store.markDirty(S,{documentId:S.documentId,revision,dirty:true});}
function save(store,S,text,revision,grant){return store.save(S,{filePath:grant?.filePath||S.filePath,text,documentId:S.documentId,revision,...(grant?{saveAsToken:grant.saveAsToken}:{})});}
const code=c=>e=>e.code===c;
test('separate windows retain independent BOM, EOL and saved snapshots',async t=>{
 const {dir,store,file,S}=await fixture(t),b=path.join(dir,'b.md'),B=createSession();await fs.writeFile(file,'\ufeffA\r\n');await store.load(S,file);await fs.writeFile(b,'B\n');await store.load(B,b);edit(store,B,1);await save(store,B,'B\nedit',1);assert.equal(await fs.readFile(file,'utf8'),'\ufeffA\r\n');assert.equal(await fs.readFile(b,'utf8'),'B\nedit');assert.equal(S.savedText,'A\n');assert.equal(B.savedText,'B\nedit');
});
test('same-file concurrent independent drafts accept one writer and preserve the loser',async t=>{
 const {store,file,S}=await fixture(t),B=createSession();await store.load(B,file);edit(store,S,1);edit(store,B,1);
 const results=await Promise.allSettled([save(store,S,'first\n',1),save(store,B,'second\n',1)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'MP_FILE_CONFLICT');assert.equal(await fs.readFile(file,'utf8'),'first\n');assert(B.dirty);assert.equal(B.savedText,'original\n');
});
test('own queued newer revision follows earlier write and late older requests cannot roll back',async t=>{
 const {store,file,S}=await fixture(t);edit(store,S,2);const r=await Promise.allSettled([save(store,S,'one',1),save(store,S,'two',2)]);assert.equal(r[1].status,'fulfilled');if(r[0].status==='rejected')assert.equal(r[0].reason.code,'MP_DOC_MISMATCH');assert.equal(await fs.readFile(file,'utf8'),'two');assert.equal(S.savedText,'two');assert.equal(S.dirty,false);await assert.rejects(save(store,S,'old',1),code('MP_DOC_MISMATCH'));assert.equal(await fs.readFile(file,'utf8'),'two');
});
test('older dirty messages cannot clear a later revision',async t=>{
 const {store,S}=await fixture(t);edit(store,S,2);assert.equal(store.markDirty(S,{documentId:S.documentId,revision:1,dirty:false}),false);assert(S.dirty);assert.equal(store.markDirty(S,{documentId:'other',revision:8,dirty:false}),false);assert.equal(S.revision,2);
});
test('edit during a write remains dirty until its own save',async t=>{
 const entered=defer(),release=defer();const {store,file,S}=await fixture(t,{beforeReplace:async()=>{entered.resolve();await release.promise;}});edit(store,S,1);const writing=save(store,S,'one',1);await entered.promise;edit(store,S,2);release.resolve();await writing;assert(S.dirty);assert.equal(S.savedText,'one');await save(store,S,'two',2);assert.equal(await fs.readFile(file,'utf8'),'two');assert(!S.dirty);
});
test('switching buffers during disk IO cannot change new document metadata',async t=>{
 const entered=defer(),release=defer();const {dir,store,file,S}=await fixture(t,{beforeReplace:async()=>{entered.resolve();await release.promise;}});const next=path.join(dir,'next.md');await fs.writeFile(next,'new');edit(store,S,1);const writing=save(store,S,'old edit',1);await entered.promise;await store.load(S,next);const id=S.documentId;release.resolve();const r=await writing;assert(!r.current);assert.equal(S.documentId,id);assert.equal(S.filePath,next);assert.equal(S.savedText,'new');assert.equal(await fs.readFile(file,'utf8'),'old edit');assert.equal(await fs.readFile(next,'utf8'),'new');
});
test('external change with restored mtime and equal byte length is still detected',async t=>{
 const {store,file,S}=await fixture(t),st=await fs.stat(file);await fs.writeFile(file,'external\n');await fs.utimes(file,st.atime,st.mtime);edit(store,S,1);await assert.rejects(save(store,S,'local',1),code('MP_FILE_CONFLICT'));assert.equal(await fs.readFile(file,'utf8'),'external\n');assert(S.dirty);
});
test('external modification between temporary write and rename is preserved',async t=>{
 let file;const f=await fixture(t,{beforeReplace:async()=>fs.writeFile(file,'changed during save')});file=f.file;edit(f.store,f.S,1);await assert.rejects(save(f.store,f.S,'local',1),code('MP_FILE_CONFLICT'));assert.equal(await fs.readFile(file,'utf8'),'changed during save');assert.deepEqual((await fs.readdir(f.dir)).filter(n=>n.includes('.mp-tmp-')),[]);
});
test('deleted source cannot be revived, even by an explicit save',async t=>{
 const {store,file,S}=await fixture(t);await fs.unlink(file);edit(store,S,1);await assert.rejects(save(store,S,'revived',1),code('MP_FILE_MISSING'));await assert.rejects(fs.stat(file),code('ENOENT'));assert(S.dirty);
});
test('Save As grant does not mutate source; success alone commits path and encoding',async t=>{
 const {dir,store,file,S}=await fixture(t);const target=path.join(dir,'new.md');edit(store,S,1);const grant=await store.grantSaveAs(S,target);assert.equal(S.filePath,file);assert(S.dirty);await save(store,S,'copy',1,grant);assert.equal(S.filePath,target);assert.equal(await fs.readFile(target,'utf8'),'copy');assert.equal(await fs.readFile(file,'utf8'),'original\n');await assert.rejects(save(store,S,'replay',1,grant),code('MP_SAVE_TARGET'));
});
test('Save As refuses a target created after selection and retains source state',async t=>{
 const {dir,store,file,S}=await fixture(t),target=path.join(dir,'new.md'),grant=await store.grantSaveAs(S,target);await fs.writeFile(target,'someone else');edit(store,S,1);await assert.rejects(save(store,S,'overwrite',1,grant),code('MP_FILE_CONFLICT'));assert.equal(S.filePath,file);assert(S.dirty);assert.equal(await fs.readFile(target,'utf8'),'someone else');assert.equal(S.saveAsGrant,null);
});
test('Save As over an existing explicitly selected snapshot succeeds',async t=>{
 const {dir,store,S}=await fixture(t),target=path.join(dir,'existing.md');await fs.writeFile(target,'existing');const grant=await store.grantSaveAs(S,target);edit(store,S,1);await save(store,S,'chosen replacement',1,grant);assert.equal(await fs.readFile(target,'utf8'),'chosen replacement');
});
test('write failure removes temporary files and leaves source metadata untouched',async t=>{
 const {dir,store,file,S}=await fixture(t,{beforeReplace:async()=>{throw new Error('injected disk failure');}});edit(store,S,1);await assert.rejects(save(store,S,'new',1),/injected disk failure/);assert.equal(await fs.readFile(file,'utf8'),'original\n');assert.equal(S.savedText,'original\n');assert(S.dirty);assert.deepEqual((await fs.readdir(dir)).filter(n=>n.includes('.mp-tmp-')),[]);await store.pending(S);assert.equal(S.pendingSaves.size,0);
});
test('new unnamed empty document can be saved using a granted path',async t=>{
 const {dir,store}=await fixture(t),S=createSession(),target=path.join(dir,'empty.md'),grant=await store.grantSaveAs(S,target);await save(store,S,'',0,grant);assert.equal((await fs.stat(target)).size,0);assert.equal(S.filePath,target);assert(!S.dirty);
});
test('ordinary save rejects another path and a mismatched document identity',async t=>{
 const {dir,store,S}=await fixture(t);await assert.rejects(store.save(S,{documentId:S.documentId,revision:0,filePath:path.join(dir,'wrong.md'),text:'wrong'}),code('MP_SAVE_TARGET'));await assert.rejects(store.save(S,{documentId:'other',revision:0,filePath:S.filePath,text:'wrong'}),code('MP_DOC_MISMATCH'));
});
test('failed load preserves old document and latest concurrent load wins',async t=>{
 const {dir,store,file,S}=await fixture(t),id=S.documentId;await assert.rejects(store.load(S,path.join(dir,'missing.md')),code('ENOENT'));assert.equal(S.documentId,id);assert.equal(S.filePath,file);const b=path.join(dir,'b.md');await fs.writeFile(b,'B');const results=await Promise.allSettled([store.load(S,file),store.load(S,b)]);assert.equal(results[0].reason.code,'MP_DOC_MISMATCH');assert.equal(S.filePath,b);assert.equal(S.savedText,'B');
});
test('hard links are refused instead of silently severing shared disk identity',async t=>{
 const {dir,store,file,S}=await fixture(t);await fs.link(file,path.join(dir,'linked.md'));edit(store,S,1);await assert.rejects(save(store,S,'new',1),code('MP_FILE_LINKED'));assert.equal(await fs.readFile(file,'utf8'),'original\n');
});
