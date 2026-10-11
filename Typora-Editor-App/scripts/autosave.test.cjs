const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module'),{EventEmitter}=require('node:events');
const messages=[];let choice=2;
const load=Module._load;Module._load=function(name,...args){
  if(name==='electron')return{app:{},dialog:{showMessageBoxSync(_win,options){messages.push(options);return choice;}},shell:{}};
  if(name==='./completion-platform')return{createCompletionManager:()=>({ready:Promise.resolve()}),uri:file=>({fsPath:file})};
  return load.call(this,name,...args);
};
const {DocController}=require('../app/main/doc'),{AppState}=require('../app/main/state'),{SnapshotStore}=require('../app/main/snapshots');Module._load=load;
const base=path.resolve(__dirname,'../.perf');
async function fixture(t,fn){
  const root=await fs.mkdtemp(path.join(base,'autosave-test-')),file=path.join(root,'note.md');await fs.writeFile(file,'baseline\n');
  const state=new AppState({file:path.join(root,'state.json')}),snapshots=new SnapshotStore({root:path.join(root,'snapshots')});
  const win=Object.assign(new EventEmitter(),{webContents:{send(){}},setTitle(){},isDestroyed:()=>false});
  const doc=new DocController({win,state,serverPort:1,snapshots});messages.length=0;choice=2;
  const drain=async()=>{await Promise.all([...snapshots.queues.values()]);};
  try{await doc.openFile(file);await drain();await fn({doc,state,snapshots,file,root,drain,win});}
  finally{win.emit('closed');await doc.finishSave();await drain();state.saveNow();assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true});}
}
async function holdWrite(t,file){
  const open=fs.open;let entered,release,once=true;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  t.mock.method(fs,'open',async function(target,...args){const handle=await open.call(fs,target,...args);if(once&&path.basename(target).startsWith('.'+path.basename(file)+'.')){once=false;const write=handle.writeFile.bind(handle);handle.writeFile=async(...values)=>{entered();await gate;return write(...values);};}return handle;});
  return{start,release};
}
test('Legacy and partial settings migrate to enabled defaults without undoing an explicit opt-out',t=>fixture(t,async({state,root})=>{
  assert.deepEqual(state.get('settings'),{autoSave:true,snapshots:true});state.set('settings',{autoSave:false});state.saveNow();
  const loaded=new AppState({file:state.file});assert.deepEqual(loaded.get('settings'),{autoSave:false,snapshots:true});loaded.saveNow();
}));
test('1.5 second debounce saves the latest input and produces baseline + saved snapshots',t=>fixture(t,async({doc,file,snapshots,drain})=>{
  t.mock.timers.enable({apis:['setTimeout']});doc.applyText(doc.current,'one');t.mock.timers.tick(1000);doc.applyText(doc.current,'two');t.mock.timers.tick(1499);
  assert.equal(await fs.readFile(file,'utf8'),'baseline\n');t.mock.timers.tick(1);await doc.finishSave();await drain();
  assert.equal(await fs.readFile(file,'utf8'),'two');assert.equal(doc.dirty,false);assert.equal((await snapshots.list(file)).length,2);assert.equal(doc._snapshotTimer,null);
}));
test('Edits arriving during automatic disk I/O stay dirty until a second write; manual concurrent saves are serialized',t=>fixture(t,async({doc,file})=>{
  const held=await holdWrite(t,file);doc.applyText(doc.current,'first');const saving=doc.save({automatic:true});await held.start;doc.applyText(doc.current,'second');held.release();assert.equal(await saving,true);
  assert.equal(await fs.readFile(file,'utf8'),'first');assert.equal(doc.current.savedText,'first');assert.equal(doc.current.text,'second');assert.equal(doc.dirty,true);
  await Promise.all([doc.save(),doc.save()]);assert.equal(await fs.readFile(file,'utf8'),'second');assert.equal(doc.dirty,false);
}));
test('Write failure never truncates the old file or dismisses the close confirmation',t=>fixture(t,async({doc,file})=>{
  doc.setSetting('autoSave',false);doc.applyText(doc.current,'unsaved');
  const rename=fs.rename;t.mock.method(fs,'rename',async(from,to)=>{if(to===file)throw Object.assign(new Error('read only fixture'),{code:'EACCES'});return rename(from,to);});
  choice=0;assert.equal(await doc.confirmDiscard(),false);assert.equal(doc.dirty,true);assert.equal(await fs.readFile(file,'utf8'),'baseline\n');assert.ok(messages.some(m=>m.message==='保存失败'));
}));
test('External writes preserve dirty editor contents, suspend autosave, and snapshot both versions',t=>fixture(t,async({doc,file,snapshots,drain})=>{
  doc.applyText(doc.current,'local');await fs.writeFile(file,'external');await doc.checkFile();await drain();
  assert.equal(doc.current.text,'local');assert.equal(await fs.readFile(file,'utf8'),'external');assert.equal(await doc.save({automatic:true}),false);
  const texts=await Promise.all((await snapshots.list(file)).map(async i=>(await snapshots.preview(file,i.id)).text));assert.ok(texts.includes('local')&&texts.includes('external'));
  choice=1;assert.equal(await doc.save(),false);choice=0;assert.equal(await doc.save(),true);assert.equal(await fs.readFile(file,'utf8'),'local');
}));
test('External change during a pending atomic write is detected before replacement',t=>fixture(t,async({doc,file})=>{
  const held=await holdWrite(t,file);doc.applyText(doc.current,'local');const saving=doc.save({automatic:true});await held.start;await fs.writeFile(file,'external during I/O');held.release();assert.equal(await saving,false);
  assert.equal(await fs.readFile(file,'utf8'),'external during I/O');assert.equal(doc.current.text,'local');assert.equal(doc.dirty,true);
}));
test('Disabled autosave stays off; dirty snapshots run every five minutes and stop when disabled',t=>fixture(t,async({doc,file,snapshots,drain})=>{
  t.mock.timers.enable({apis:['setTimeout']});doc.setSetting('autoSave',false);doc.applyText(doc.current,'unsaved math $x$');t.mock.timers.tick(299999);await drain();assert.equal((await snapshots.list(file)).length,1);
  t.mock.timers.tick(1);await drain();assert.equal((await snapshots.list(file)).length,2);assert.equal(await fs.readFile(file,'utf8'),'baseline\n');
  doc.setSetting('snapshots',false);doc.applyText(doc.current,'another edit');t.mock.timers.tick(600000);await drain();assert.equal((await snapshots.list(file)).length,2);assert.equal(doc._snapshotTimer,null);
}));
test('Deleting a file never recreates it automatically; explicit save can recreate it',t=>fixture(t,async({doc,file})=>{
  doc.applyText(doc.current,'keep me');await fs.unlink(file);doc.onFileDeleted(file);assert.equal(await doc.save({automatic:true}),false);await assert.rejects(fs.stat(file),{code:'ENOENT'});
  assert.equal(await doc.save(),true);assert.equal(await fs.readFile(file,'utf8'),'keep me');
}));
test('Periodic snapshot work does not postpone an already scheduled autosave',t=>fixture(t,async({doc,file,drain})=>{
  t.mock.timers.enable({apis:['setTimeout']});doc.setSetting('autoSave',false);doc.applyText(doc.current,'timed edit');t.mock.timers.tick(299000);doc.setSetting('autoSave',true);
  t.mock.timers.tick(1000);await drain();t.mock.timers.tick(500);await doc.finishSave();assert.equal(await fs.readFile(file,'utf8'),'timed edit');
}));
test('Saved/dirty status updates reuse counts, while changed content invalidates them',t=>fixture(t,async({doc})=>{
  t.mock.timers.enable({apis:['setTimeout']});doc.setSetting('autoSave',false);doc.applyText(doc.current,'中文 abc');t.mock.timers.tick(400);
  const counts=doc._statsCache.stats;assert.equal(counts.words,3);await doc.save();t.mock.timers.tick(400);assert.equal(doc._statsCache.stats,counts);
  doc.applyText(doc.current,'中文 abc def');t.mock.timers.tick(400);assert.notEqual(doc._statsCache.stats,counts);assert.equal(doc._statsCache.stats.words,4);
}));
test('Switching files cancels pending timers and old-frame edits cannot save into the new file',t=>fixture(t,async({doc,file,root})=>{
  t.mock.timers.enable({apis:['setTimeout']});const other=path.join(root,'other.md');await fs.writeFile(other,'other');const old=doc.current;
  doc.applyText(old,'discarded edit');choice=1;assert.equal(await doc.openFile(other),true);doc.applyText(old,'late old edit');t.mock.timers.tick(2000);
  assert.equal(doc.current.text,'other');assert.equal(await fs.readFile(other,'utf8'),'other');assert.equal(await fs.readFile(file,'utf8'),'baseline\n');
}));

test('New-file switch reuses an exact discard decision, but reconfirms if text changed',t=>fixture(t,async({doc,root})=>{
  doc.setSetting('autoSave',false);const other=path.join(root,'new.md');await fs.writeFile(other,'');
  doc.applyText(doc.current,'first edit');const confirmedDiscard={current:doc.current,text:doc.current.text};
  doc.applyText(doc.current,'newer edit');choice=2;
  assert.equal(await doc.openFile(other,{confirmedDiscard}),false);assert.equal(doc.current.text,'newer edit');
  const messageCount=messages.length;
  assert.equal(await doc.openFile(other,{confirmedDiscard:{current:doc.current,text:doc.current.text}}),true);
  assert.equal(messages.length,messageCount);assert.equal(doc.file,other);
}));
