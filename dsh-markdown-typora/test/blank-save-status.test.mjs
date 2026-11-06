import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';
const {make,drain}=fixture;
const cwd='D:/probe',id='fixture-draft',file=`${cwd}/未命名-${id}.md`;
const address='dsh-resource://file/absolute/D%3A/probe/'+encodeURIComponent(`未命名-${id}.md`);
const options={address,workspace:cwd,draft:{id,cwd}};
const entry={path:file,address,workspace:cwd,sessionId:'test',draft:{id,cwd}};
const created=text=>({ok:true,value:{path:file,version:'draft-v1',text}});
function init(extra={}){const h=make({...options,...extra});h.test.pendingWorkspaceDraft({key:h.test.workspaceKey(cwd)},entry);return h;}

test('blank initializes dirty through synchronous apply ACK without touching disk or controller TDZ',async()=>{
 const h=init({syncWire:true});await h.boot();
 assert(h.st.doc.opened&&h.st.doc.untitled&&h.st.doc.dirty);
 assert.equal(h.engine.text,'');assert.equal(h.ui().saveStatus,'unsaved');
 await h.advance(10000);
 assert.equal(h.requests.filter(r=>['open','create','save'].includes(r.endpoint)).length,0);
 assert.equal(h.ui().saveStatus,'unsaved');h.cleanup();
});
test('blank first manual save confirms even empty contents and hides receipt at 3000 ms',async()=>{
 const h=init();await h.boot();h.setFetch(r=>r.endpoint==='create'?created(r.payload.exactText):{ok:true,value:{version:'draft-v1'}});
 h.message('manual-save');await drain();
 const create=h.requests.find(r=>r.endpoint==='create');assert(create);assert.equal(create.payload.exactText,'');
 assert(!h.st.doc.untitled&&!h.st.doc.dirty);assert.equal(h.ui().saveStatus,'saved');
 assert.equal(h.test.pendingWorkspaceDraft({key:h.test.workspaceKey(cwd)}),null);
 await h.advance(2999);assert.equal(h.ui().saveStatus,'saved');await h.advance(1);assert.equal(h.ui().saveStatus,'');h.cleanup();
});
test('blank delayed recovery load has initialized status controller and remains unsaved',async()=>{
 const h=init({syncWire:true});let resolve;h.draftStore.readLatest=()=>new Promise(r=>resolve=r);
 await h.boot();assert.equal(h.ui().phase,'loading');assert.equal(h.ui().saveStatus,'');
 resolve({text:'RECOVERED-BLANK',dirty:true});await drain();
 assert.equal(h.engine.text,'RECOVERED-BLANK');assert.equal(h.ui().saveStatus,'unsaved');assert(h.st.doc.untitled);h.cleanup();
});
test('blank recovery read failure preserves persistent retry without a false saved receipt',async()=>{
 const h=init({syncWire:true});h.draftStore.readLatest=()=>{throw Error('FIXTURE_STORAGE_READ');};await h.boot();
 assert.equal(h.ui().phase,'error');assert.match(h.ui().detail,/FIXTURE_STORAGE_READ/);assert.equal(h.ui().saveStatus,'');
 assert.equal(typeof h.st.actions.retry,'function');await h.advance(4000);assert.equal(h.ui().phase,'error');h.cleanup();
});
test('blank creation in flight stays unsaved and follows newer edits with ordinary save',async()=>{
 const h=init();await h.boot();h.edit('FIRST');let resolve;
 h.setFetch(r=>r.endpoint==='create'?new Promise(r=>resolve=r):{ok:true,value:{version:r.endpoint==='save'?'draft-v2':'draft-v2'}});
 h.message('manual-save');await drain();assert(h.st.doc.saving);assert.equal(h.ui().saveStatus,'unsaved');
 h.edit('NEWER');resolve(created('FIRST'));await drain();
 assert(!h.st.doc.untitled&&h.st.doc.dirty);assert.equal(h.ui().saveStatus,'unsaved');await h.advance(0);
 assert.equal(h.requests.find(r=>r.endpoint==='save')?.payload.text,'NEWER');assert.equal(h.ui().saveStatus,'saved');h.cleanup();
});
test('blank input during snapshot await cannot be falsely marked saved',async()=>{
 const h=init();await h.boot();h.edit('FIRST');
 h.setFetch(r=>r.endpoint==='create'?created(r.payload.exactText):{ok:true,value:{version:r.endpoint==='save'?'draft-v2':'draft-v2'}});
 h.message('manual-save');h.edit('NEWER');await drain();
 assert.equal(h.requests.find(r=>r.endpoint==='create')?.payload.exactText,'FIRST');
 assert(h.st.doc.dirty,'new input after snapshot capture must remain dirty');
 assert.equal(h.ui().saveStatus,'unsaved');await h.advance(0);
 assert.equal(h.requests.find(r=>r.endpoint==='save')?.payload.text,'NEWER');h.cleanup();
});
test('blank creation failure keeps draft recovery and never claims saved',async()=>{
 const h=init();await h.boot();h.edit('PRESERVED');h.setFetch(r=>r.endpoint==='create'?{ok:false,error:{code:'FIXTURE_CREATE',message:'fixture denied'}}:{ok:true,value:{}});
 h.message('manual-save');await drain();assert(h.st.doc.untitled&&h.st.doc.dirty);assert.equal(h.ui().saveStatus,'unsaved');assert.equal(h.ui().phase,'error');
 assert(h.test.pendingWorkspaceDraft({key:h.test.workspaceKey(cwd)}));assert.equal(h.engine.text,'PRESERVED');h.cleanup();
});
test('blank durable-mark wait does not strand a queued newer autosave',async()=>{
 const h=init();await h.boot();h.edit('FIRST');let release;
 h.draftStore.markSaved=()=>new Promise(r=>release=r);
 h.setFetch(r=>r.endpoint==='create'?created(r.payload.exactText):{ok:true,value:{version:r.endpoint==='save'?'draft-v2':'draft-v2'}});
 h.message('manual-save');await drain();assert.equal(typeof release,'function');assert(h.st.doc.saving&&!h.st.doc.untitled);
 h.edit('NEWER');await h.advance(1500);assert(h.st.doc.saveQueued);assert.equal(h.requests.filter(r=>r.endpoint==='save').length,0);
 h.draftStore.markSaved=()=>Promise.resolve({ok:true,durable:true});release({ok:true,durable:true});await drain();await h.advance(0);
 assert.equal(h.requests.find(r=>r.endpoint==='save')?.payload.text,'NEWER','queued edit must receive a follow-up autosave');
 assert(!h.st.doc.dirty);assert.equal(h.ui().saveStatus,'saved');h.cleanup();
});
test('blank durable-mark completion after cleanup cannot publish into the retired document',async()=>{
 const h=init();await h.boot();h.edit('FIRST');let release;
 h.draftStore.markSaved=()=>new Promise(r=>release=r);
 h.setFetch(r=>r.endpoint==='create'?created(r.payload.exactText):{ok:true,value:{version:'draft-v1'}});
 h.message('manual-save');await drain();assert.equal(typeof release,'function');
 h.cleanup();const retiredUi=h.ui();release({ok:true,durable:true});await drain();
 assert.equal(h.ui(),retiredUi,'post-await continuation must recheck document ownership');
 assert.equal([...h.timers.values()].filter(t=>t.ms===3000).length,0);
});
test('blank lost create receipt survives close/reopen and reuses frozen first payload',async()=>{
 const storage=new Map(),slots=new Map(),createPayloads=[];let hostFirstText=null,attempt=0;
 function host(r){
  if(r.endpoint==='create'){
   attempt++;createPayloads.push(r.payload.exactText);
   if(hostFirstText===null){hostFirstText=r.payload.exactText;return Promise.reject(Error('FIXTURE_LOST_RECEIPT'));}
   if(r.payload.exactText!==hostFirstText)return{ok:false,error:{code:'MP_DRAFT_REUSED',message:'draft id payload changed'}};
   return created(hostFirstText);
  }
  return{ok:true,value:{version:r.endpoint==='save'?'draft-v2':'draft-v2'}};
 }
 const first=init({storage,slots});await first.boot();first.setFetch(host);first.edit('FIRST');first.message('manual-save');await drain();
 assert(first.st.doc.untitled&&first.st.doc.dirty);first.edit('NEWER');const safe=await first.test.prepareWorkspaceLeave();assert(safe&&safe());
 first.cleanup();await first.advance(500);
 const pending=first.test.pendingWorkspaceDraft({key:first.test.workspaceKey(cwd)});assert(pending?.draft?.id);
 const next=make({...options,draft:pending.draft,storage,slots});next.setFetch(host);await next.boot();assert.equal(next.engine.text,'NEWER');
 next.message('manual-save');await drain();await next.advance(0);
 assert.deepEqual(createPayloads,['FIRST','FIRST'],'retry must preserve idempotency payload across editor generations');
 assert.equal(next.requests.find(r=>r.endpoint==='save')?.payload.text,'NEWER');assert(!next.st.doc.dirty);assert.equal(next.ui().saveStatus,'saved');next.cleanup();
});
