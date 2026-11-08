import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-lifecycle.cjs';
const {make,drain}=fixture;
test('client lifecycle preserves owned state with v2 apply receipts',async t=>{
 await t.test('failed force reload retains dirty conflict and recovery; later acknowledged retry succeeds',async()=>{
  const h=make();await h.boot();h.edit('UNSAVED');const d=h.st.doc;d.conflict=true;d.externalStale=true;d.recovery={text:'RECOVERY',baseVersion:'v1'};
  h.setFetch(()=>Promise.reject(Error('OFFLINE')));h.st.actions.reloadDisk();await drain();
  assert(d.dirty&&d.conflict&&d.externalStale&&d.recovery?.text==='RECOVERY');assert.equal(h.ui().phase,'conflict');
  h.setFetch(()=>({ok:true,value:{text:'disk-after-retry',version:'v2',size:16}}));h.st.actions.reloadDisk();await drain();
  assert(!d.dirty);assert.equal(d.text,'disk-after-retry');assert.equal(h.engine.text,d.text);assert.equal(d.lastVersion,'v2');
 });
 await t.test('apply rejection never advances version or clears dirty state',async()=>{
  const h=make();await h.boot();h.edit('UNSAVED');h.transport.rejectApply=true;
  h.setFetch(()=>({ok:true,value:{text:'disk-v2',version:'v2',size:7}}));h.st.actions.reloadDisk();await drain();
  assert(h.st.doc.dirty);assert.equal(h.st.doc.lastVersion,'v1');assert.equal(h.engine.text,'UNSAVED');
 });
 await t.test('new input while disk read is pending blocks discard',async()=>{
  const h=make();await h.boot();h.edit('UNSAVED');let resolve;h.setFetch(()=>new Promise(r=>resolve=r));h.st.actions.reloadDisk();await drain();assert.equal(typeof resolve,'function');
  h.edit('NEWER-INPUT');resolve({ok:true,value:{text:'disk-v2',version:'v2',size:7}});await drain();
  assert(h.st.doc.dirty);assert.equal(h.st.doc.lastVersion,'v1');assert.equal(h.engine.text,'NEWER-INPUT');assert(!h.posts.some(p=>p.type==='setValue'&&p.content.content==='disk-v2'));
 });
 await t.test('close without text reply preserves exact latest continuous mirror and does not write disk',async()=>{
  const h=make();await h.boot();h.edit('CURRENT-DRAFT');h.transport.dropText=true;h.cleanup();await h.advance(500);
  const slots=[...h.storage.values()].map(JSON.parse);assert(slots.some(s=>s.text==='CURRENT-DRAFT'));assert.equal(h.requests.filter(r=>r.keepalive).length,0);
 });
 await t.test('unrequested late legacy text cannot replace a closed draft',async()=>{
  const h=make();await h.boot();h.edit('CURRENT-DRAFT');h.cleanup();h.message('text','STALE-UNRELATED');await h.advance(500);
  assert([...h.storage.values()].map(JSON.parse).some(s=>s.text==='CURRENT-DRAFT'));assert.equal(h.requests.filter(r=>r.keepalive).length,0);
 });
 await t.test('older load success cannot overwrite newer acknowledged commit',async()=>{
  const h=make();await h.boot();const p=[];h.setFetch(()=>new Promise((resolve,reject)=>p.push({resolve,reject})));
  const a=h.st.doc.reload({silent:true}),b=h.st.doc.reload({silent:true});await drain();assert.equal(p.length,2);
  p[1].resolve({ok:true,value:{text:'new-v3',version:'v3',size:6}});await drain();p[0].resolve({ok:true,value:{text:'old-v2',version:'v2',size:6}});await Promise.all([a,b]);
  assert.equal(h.st.doc.text,'new-v3');assert.equal(h.engine.text,'new-v3');assert.equal(h.st.doc.lastVersion,'v3');
 });
 await t.test('older load failure cannot replace newer ready state',async()=>{
  const h=make();await h.boot();const p=[];h.setFetch(()=>new Promise((resolve,reject)=>p.push({resolve,reject})));
  const a=h.st.doc.reload({silent:false}),b=h.st.doc.reload({silent:false});await drain();p[1].resolve({ok:true,value:{text:'v3',version:'v3',size:2}});await drain();p[0].reject(Error('OLD-FAIL'));await Promise.all([a,b]);
  assert.equal(h.ui().phase,'ready');assert.equal(h.st.doc.text,'v3');
 });
 await t.test('held apply ACK cannot declare initial document ready',async()=>{
  const h=make();h.transport.holdAck=true;await h.boot();assert(!h.st.doc.opened);assert.equal(h.st.doc.lastVersion,null);assert(h.st.doc.pendingApply);
  h.transport.holdAck=false;h.releaseAck();await drain();assert(h.st.doc.opened);assert.equal(h.st.doc.lastVersion,'v1');
 });
 await t.test('IME delta marks dirty immediately but defers saving until composition ends',async()=>{
  const h=make();await h.boot();h.edit('IME-DRAFT',true);assert(h.st.doc.dirty&&h.st.doc.composing);await h.advance(1600);assert.equal(h.requests.filter(r=>r.endpoint==='save').length,0);
  h.composition(false);assert(!h.st.doc.composing);assert(h.st.doc.saveTimer);
 });
});
