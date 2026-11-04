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
for(const encoding of ['utf8','utf16le','utf16be'])test(encoding+' refuses an invalid editor surrogate without losing disk or draft metadata',async t=>{
 const {store,file,S,dir}=await fixture(t);S.encoding=encoding;edit(store,S,1);const before=await fs.readFile(file),id=S.documentId;
 await assert.rejects(save(store,S,'invalid\ud800',1),code('MP_ENCODING'));assert((await fs.readFile(file)).equals(before));assert.equal(S.documentId,id);assert.equal(S.savedText,'original\n');assert(S.dirty);assert.deepEqual((await fs.readdir(dir)).filter(n=>n.includes('.mp-tmp-')),[]);
 await save(store,S,'recovered',1);assert(!S.dirty);
});
test('separate windows retain independent BOM, EOL and saved snapshots',async t=>{
 const {dir,store,file,S}=await fixture(t),b=path.join(dir,'b.md'),B=createSession();await fs.writeFile(file,'\ufeffA\r\n');await store.load(S,file);await fs.writeFile(b,'B\n');await store.load(B,b);edit(store,B,1);await save(store,B,'B\nedit',1);assert.equal(await fs.readFile(file,'utf8'),'\ufeffA\r\n');assert.equal(await fs.readFile(b,'utf8'),'B\nedit');assert.equal(S.savedText,'A\n');assert.equal(B.savedText,'B\nedit');
});
test('same-file concurrent independent drafts accept one writer and preserve the loser',async t=>{
 const {store,file,S}=await fixture(t),B=createSession();await store.load(B,file);edit(store,S,1);edit(store,B,1);
 const results=await Promise.allSettled([save(store,S,'first\n',1),save(store,B,'second\n',1)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'MP_FILE_CONFLICT');
 const winner=results.findIndex(r=>r.status==='fulfilled'),loser=winner===0?B:S;assert.equal(await fs.readFile(file,'utf8'),winner===0?'first\n':'second\n');assert(loser.dirty);assert.equal(loser.savedText,'original\n');
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

test('keep-mine authorizes only the confirmed disk baseline and editor revision', async t => {
 const {store,file,S}=await fixture(t);
 edit(store,S,1);
 const owner=()=>({documentId:S.documentId,filePath:S.filePath,revision:S.revision});
 await fs.writeFile(file,'outside edit');
 await assert.rejects(store.grantOverwrite(S,owner(),()=>false),code('MP_DOC_MISMATCH'));
 const old=await store.grantOverwrite(S,owner());
 edit(store,S,2);
 await assert.rejects(save(store,S,'old local',1,old),code('MP_DOC_MISMATCH'));
 const current=await store.grantOverwrite(S,owner());
 await fs.writeFile(file,'newer outside edit');
 await assert.rejects(save(store,S,'current local',2,current),code('MP_FILE_CONFLICT'));
 assert.equal(await fs.readFile(file,'utf8'),'newer outside edit');
 assert(S.dirty);
 const fresh=await store.grantOverwrite(S,owner());
 await save(store,S,'current local',2,fresh);
 assert.equal(await fs.readFile(file,'utf8'),'current local');
 assert(!S.dirty);
});

test('ordinary save and keep-mine refuse a directory redirected after open', async t => {
 const {dir,store,S}=await fixture(t);
 const active=path.join(dir,'active'),parked=path.join(dir,'parked'),other=path.join(dir,'other');
 await fs.mkdir(active);await fs.mkdir(other);
 const opened=path.join(active,'note.md'),unrelated=path.join(other,'note.md');
 await fs.writeFile(opened,'same baseline');await fs.writeFile(unrelated,'same baseline');
 await store.load(S,opened);const id=S.documentId,originalPath=S.filePath;edit(store,S,1);
 await fs.rename(active,parked);
 await fs.symlink(other,active,process.platform==='win32'?'junction':'dir');
 try {
   await assert.rejects(save(store,S,'local draft',1),code('MP_FILE_CONFLICT'));
   await assert.rejects(store.grantOverwrite(S,{documentId:id,revision:1,filePath:originalPath}),code('MP_FILE_CONFLICT'));
   assert.equal(S.documentId,id);assert.equal(S.filePath,originalPath);assert(S.dirty);assert.equal(S.saveAsGrant,null);
   assert.equal(await fs.readFile(unrelated,'utf8'),'same baseline');
   assert.equal(await fs.readFile(path.join(parked,'note.md'),'utf8'),'same baseline');
   // An explicit Save As still grants its separately selected target.
   const dest=path.join(dir,'explicit.md'),grant=await store.grantSaveAs(S,dest);
   await save(store,S,'local draft',1,grant);
   assert.equal(S.filePath,dest);assert.equal(await fs.readFile(dest,'utf8'),'local draft');
 } finally {await fs.unlink(active);}
});

test('a new edit during confirmed overwrite preserves the external disk until reconfirmed', async t => {
 const staged=defer(), release=defer();
 const {store,S,file}=await fixture(t,{beforeReplace:async()=>{staged.resolve();await release.promise;}});
 const owner=()=>({documentId:S.documentId,filePath:S.filePath,revision:S.revision});
 await fs.writeFile(file,'external');edit(store,S,1);
 const grant=await store.grantOverwrite(S,owner()),pending=save(store,S,'local 1',1,grant);
 await staged.promise;edit(store,S,2);release.resolve();
 await assert.rejects(pending,code('MP_FILE_CONFLICT'));
 assert.equal(await fs.readFile(file,'utf8'),'external');assert(S.dirty);assert.equal(S.savedText,'original\n');
 const latest=await store.grantOverwrite(S,owner());await save(store,S,'local 2',2,latest);
 assert.equal(await fs.readFile(file,'utf8'),'local 2');assert(!S.dirty);
});

test('external-change detection and same-document reload retain a clean original after directory redirection',async t=>{
 const {dir,store,S}=await fixture(t),a=path.join(dir,'active'),b=path.join(dir,'foreign'),park=path.join(dir,'parked');
 await fs.mkdir(a);await fs.mkdir(b);const file=path.join(a,'note.md'),target=path.join(b,'note.md');
 await fs.writeFile(file,'ORIGINAL');await fs.writeFile(target,'OTHER');await store.load(S,file);
 const expected={documentId:S.documentId,revision:S.revision,filePath:S.filePath,loadRequest:S.loadRequest};
 await fs.rename(a,park);await fs.symlink(b,a,process.platform==='win32'?'junction':'dir');
 try {
   const notice=await store.outsideChange(S,file);assert(notice.changed&&notice.relocated);
   await assert.rejects(store.load(S,file,expected),code('MP_FILE_CONFLICT'));
   assert.equal(S.documentId,expected.documentId);assert.equal(S.savedText,'ORIGINAL');assert.equal(S.filePath,expected.filePath);
   const other=createSession();await store.load(other,target);assert.equal(other.savedText,'OTHER');
   assert.equal(await fs.readFile(target,'utf8'),'OTHER');assert.equal(await fs.readFile(path.join(park,'note.md'),'utf8'),'ORIGINAL');
 } finally {await fs.unlink(a);}
});
