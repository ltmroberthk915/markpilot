import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';
const {make,drain}=fixture;
const cwd='D:/probe',id='fixture-draft',file=`${cwd}/未命名-${id}.md`;
const address='dsh-resource://file/absolute/D%3A/probe/'+encodeURIComponent(`未命名-${id}.md`);
const options={address,workspace:cwd,draft:{id,cwd}};
function init(){const h=make(options);h.test.pendingWorkspaceDraft({key:h.test.workspaceKey(cwd)},{path:file,address,workspace:cwd,sessionId:'test',draft:{id,cwd}});return h;}
test('blank frozen payload storage failure blocks external create',async()=>{
 const h=init();await h.boot();h.edit('FIRST');const set=h.storage.set;
 h.storage.set=()=>{throw Error('FIXTURE_QUOTA');};
 h.message('manual-save');await drain();
 assert.equal(h.requests.filter(r=>r.endpoint==='create').length,0);
 assert(h.st.doc.untitled&&h.st.doc.dirty);assert.equal(h.ui().saveStatus,'unsaved');assert.equal(h.ui().phase,'error');
 assert.match(h.ui().detail,/尚未创建文件/);h.storage.set=set;h.cleanup();
});
test('blank successful create remains saved when recovery mark throws',async()=>{
 const h=init();await h.boot();h.edit('FIRST');h.draftStore.markSaved=()=>Promise.reject(Error('FIXTURE_RECOVERY_MARK'));
 h.setFetch(r=>r.endpoint==='create'?{ok:true,value:{path:file,version:'v1'}}:{ok:true,value:{version:'v1'}});
 h.message('manual-save');await drain();
 assert(!h.st.doc.untitled&&!h.st.doc.dirty);assert.equal(h.ui().phase,'ready');assert.equal(h.ui().saveStatus,'saved');
 assert(h.posts.some(p=>p.type==='toast'&&String(p.content).includes('FIXTURE_RECOVERY_MARK')));
 assert.equal(h.requests.filter(r=>r.endpoint==='create').length,1);h.cleanup();
});
test('blank canonical junction receipt accepts matching requested path',async()=>{
 const h=init();await h.boot();h.edit('FIRST');
 h.setFetch(r=>r.endpoint==='create'?{ok:true,value:{path:'E:/canonical/未命名-fixture-draft.md',requestedPath:file,version:'v1'}}:{ok:true,value:{version:'v1'}});
 h.message('manual-save');await drain();
 assert(!h.st.doc.untitled&&!h.st.doc.dirty);assert.equal(h.st.doc.absPath,file);assert.equal(h.ui().saveStatus,'saved');h.cleanup();
});
test('blank canonical receipt with another requested path does not clear dirty',async()=>{
 const h=init();await h.boot();h.edit('FIRST');
 h.setFetch(r=>r.endpoint==='create'?{ok:true,value:{path:'E:/canonical/other.md',requestedPath:'D:/other/not-owned.md',version:'v1'}}:{ok:true,value:{version:'v1'}});
 h.message('manual-save');await drain();
 assert(h.st.doc.untitled&&h.st.doc.dirty);assert.equal(h.ui().saveStatus,'unsaved');assert.equal(h.ui().phase,'error');
 assert.match(h.ui().detail,/保存路径不匹配/);h.cleanup();
});
test('blank pending cleanup failure cannot reopen empty and overwrite the created file',async()=>{
 const h=init();await h.boot();h.edit('PRESERVE-ON-DISK');let disk='',created=false;
 const host=r=>{if(r.endpoint==='create'){if(!created){created=true;disk=r.payload.exactText;}return{ok:true,value:{path:file,version:'v1'}};}if(r.endpoint==='save'){disk=r.payload.text;return{ok:true,value:{version:'v2'}};}return{ok:true,value:{version:'v2',text:disk}};};
 h.setFetch(host);const originalSet=h.storage.set.bind(h.storage);
 h.storage.set=(key,value)=>{if(key==='dsh.markpilot.workspace-drafts.v1'&&value==='{}')throw Error('FIXTURE_CLEAR_FAILED');return originalSet(key,value);};
 h.message('manual-save');await drain();assert.equal(disk,'PRESERVE-ON-DISK');
 const pending=h.test.pendingWorkspaceDraft({key:h.test.workspaceKey(cwd)});assert(pending?.draft);
 h.cleanup();await h.advance(500);h.storage.set=originalSet;
 const next=make({...options,draft:pending.draft,storage:h.storage,slots:h.slots});next.setFetch(host);await next.boot();
 assert.equal(next.engine.text,'PRESERVE-ON-DISK','a stale pending record must retain created contents across reopen');
 next.message('manual-save');await drain();await next.advance(0);assert.equal(disk,'PRESERVE-ON-DISK');
 assert(!next.requests.some(r=>r.endpoint==='save'&&r.payload.text===''));next.cleanup();
});
test('blank frozen fallback restores contents without recovery record',async()=>{
 const h=make({...options,draft:{id,cwd,firstSaveText:'FROZEN-BEFORE-CRASH'}});
 h.draftStore.readLatest=()=>Promise.resolve(null);await h.boot();
 assert.equal(h.engine.text,'FROZEN-BEFORE-CRASH');assert(h.st.doc.untitled&&h.st.doc.dirty);
 assert.equal(h.ui().saveStatus,'unsaved');assert.equal(h.requests.filter(r=>r.endpoint==='create'||r.endpoint==='save').length,0);h.cleanup();
});
test('blank frozen fallback preserves explicit empty recovery contents',async()=>{
 const h=make({...options,draft:{id,cwd,firstSaveText:'FROZEN-BEFORE-CRASH'}});
 h.draftStore.readLatest=()=>Promise.resolve({text:'',dirty:true});await h.boot();
 assert.equal(h.engine.text,'','explicit empty recovery is a newer owned draft, not absence');
 assert(h.st.doc.untitled&&h.st.doc.dirty);assert.equal(h.ui().saveStatus,'unsaved');h.cleanup();
});
