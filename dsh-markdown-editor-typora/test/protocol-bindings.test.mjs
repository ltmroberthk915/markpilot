import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-lifecycle.cjs';

const {make,drain}=fixture;
const success=text=>({ok:true,value:{version:'v2',text,size:text.length}});

test('matching-apply-ack',async()=>{const h=make();h.transport.holdAck=true;await h.boot();const d=h.st.doc;
  assert(d.pendingApply&&!d.opened&&h.held.length===1,'held actual apply');
  h.message('apply-result',{...h.held[0].content,applyId:'different-request'});
  assert.equal(d.opened,false,'foreign ACK changed ready state');
  h.releaseAck();await drain();assert(d.opened&&d.lastVersion==='v1'&&d.text===h.engine.text);});

test('save-reload-serialization',async()=>{const h=make();await h.boot();h.edit('LOCAL');let finish,version='v1',disk='disk-v1';
  h.setFetch(r=>r.endpoint==='save'?new Promise(resolve=>finish=resolve):r.endpoint==='open'?{ok:true,value:{text:disk,version,size:disk.length}}:{ok:true,value:{version}});
  h.message('manual-save');await drain();assert(finish&&h.st.doc.saving,'save reached disk transport');
  h.st.actions.reloadDisk();await drain();assert.equal(h.engine.text,'LOCAL','reload replaced editor while save pending');
  disk='LOCAL';version='v2';finish({ok:true,value:{version}});await drain();assert.equal(h.st.doc.lastVersion,'v2');assert.equal(h.st.doc.text,disk);});

test('lost-ack-immediate-close',async()=>{const h=make();h.transport.dropAck=true;h.transport.dropText=true;await h.boot();assert(h.st.doc.pendingApply&&!h.st.doc.opened,'open ACK really missing');h.edit('LAST-INPUT');h.cleanup();await h.advance(500);
  assert([...h.storage.values()].map(JSON.parse).some(v=>v.text==='LAST-INPUT'),'lost ACK discarded the last input on close');assert(!h.requests.some(r=>r.endpoint==='save'));});

test('restore-checkpoint-durability',async()=>{const h=make();await h.boot();const d=h.st.doc,old={path:d.absPath,text:'RECOVERED-OLD',docToken:'old',session:{epoch:9,sourceRevision:8}};
  h.slots.set(old.docToken,old);d.recovery=old;let done;h.draftStore.checkpoint=()=>new Promise(resolve=>done=resolve);
  const apply=h.st.actions.restoreRecovery();await drain();await apply;assert.equal(h.engine.text,old.text);assert(done&&h.slots.has('old'),'replacement checkpoint pending');
  done({ok:false,durable:false,code:'QuotaExceededError'});await drain();assert(h.slots.has('old'),'failed replacement checkpoint deleted the recoverable old slot');});

test('ime-manual-save-barrier',async()=>{const h=make();await h.boot();h.edit('正在组字',true);assert(h.st.doc.dirty&&h.st.doc.composing);h.setFetch(()=>success('正在组字'));h.message('manual-save');await drain();
  assert.equal(h.requests.filter(r=>r.endpoint==='save').length,0,'manual save published active composition');h.composition(false);await drain();assert.equal(h.requests.filter(r=>r.endpoint==='save').length,1);});

test('snapshot-request-correlation',async()=>{const h=make();await h.boot();h.transport.dropText=true;const d=h.st.doc;
  // The renderer advanced once and the transport lost that delta; the next real
  // fixture edit emits a gap and the client asks for a correlated snapshot.
  h.engine.session={...h.engine.session,sourceRevision:1};h.engine.text='MISSED';h.edit('LATEST');await drain();
  const req=h.posts.filter(m=>m.type==='requestText').at(-1);assert(req&&!d.mirror.continuous,'a gap opened a snapshot request');
  const snapshot={protocol:2,docToken:h.engine.token,id:req.content.id,session:{...h.engine.session},lastApply:h.engine.lastApply,composing:false,text:'LATEST'};
  h.message('text',{...snapshot,id:'not-the-pull',text:'UNRELATED'});assert.equal(d.mirror.continuous,false,'unrelated snapshot replaced the draft');
  h.message('text',snapshot);await drain();assert(d.mirror.continuous);assert.equal(d.text,'LATEST');});

