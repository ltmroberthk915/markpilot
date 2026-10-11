const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {SnapshotStore}=require('../app/main/snapshots');
const base=path.resolve(__dirname,'../.perf');
async function fixture(fn){const root=await fs.mkdtemp(path.join(base,'snapshot-test-'));try{await fn(root);}finally{assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true});}}
test('50 newest snapshots survive concurrent same-second saves and restart; repeated content is deduplicated',()=>fixture(async root=>{
  const store=new SnapshotStore({root:path.join(root,'snapshots'),now:()=>new Date(2026,8,6,12,34,56)}),file=path.join(root,'数学.md');
  await Promise.all(Array.from({length:56},(_,i)=>store.capture(file,'正文 '+i,'save')));
  let items=await store.list(file);assert.equal(items.length,50);assert.equal(new Set(items.map(i=>i.id)).size,50);
  assert.equal((await store.preview(file,items[0].id)).text,'正文 55');assert.equal((await store.preview(file,items.at(-1).id)).text,'正文 6');
  await store.capture(file,'正文 55','open');assert.equal((await store.list(file)).length,50);
  const reopened=new SnapshotStore({root:store.root});assert.deepEqual(await reopened.list(file),items);
  assert.equal((await fs.readdir(store.directory(file))).filter(f=>f.endsWith('.md')).length,50);
  if(process.platform==='win32')assert.equal(store.directory(file),store.directory(file.toUpperCase()));
}));
test('Restore creates collision-safe copies without changing source or snapshot; preview is bounded but restore is complete',()=>fixture(async root=>{
  const store=new SnapshotStore({root:path.join(root,'snapshots')}),file=path.join(root,'数学 笔记.md');
  const text='# 原始\n\n$x^2$\n'+ '正文 '.repeat(60000);await fs.writeFile(file,'current text');
  const item=await store.capture(file,text,'open');const preview=await store.preview(file,item.id);assert.equal(preview.text.length,120000);assert.equal(preview.truncated,true);
  const [a,b]=await Promise.all([store.restore(file,item.id),store.restore(file,item.id)]);assert.notEqual(a,b);assert.notEqual(a,file);
  assert.match(path.basename(a),/^数学 笔记-\d{8}-\d{4}\.md$/);assert.equal(await fs.readFile(a,'utf8'),text);assert.equal(await fs.readFile(b,'utf8'),text);
  assert.equal(await fs.readFile(file,'utf8'),'current text');assert.equal((await store.preview(file,item.id)).text,preview.text);
  await assert.rejects(store.preview(file,'../state.json'),/无效/);await assert.rejects(store.restore(file,'C:\\escape.md'),/无效/);
}));
test('LRU retains an older previewed version and evicts the least recently used version',()=>fixture(async root=>{
  const store=new SnapshotStore({root:path.join(root,'snapshots'),limit:3}),file=path.join(root,'lru.md');
  const first=await store.capture(file,'a');await store.capture(file,'b');await store.capture(file,'c');await store.preview(file,first.id);await store.capture(file,'d');
  const reopened=new SnapshotStore({root:store.root,limit:3}),items=await reopened.list(file),texts=[];
  for(const item of items)texts.push((await reopened.preview(file,item.id)).text);
  assert.deepEqual(texts,['d','c','a']);
}));
test('Damaged metadata and externally deleted snapshots recover; empty snapshots remain restorable',()=>fixture(async root=>{
  const store=new SnapshotStore({root:path.join(root,'snapshots')}),file=path.join(root,'empty.md');
  const empty=await store.capture(file,'','open');assert.equal(empty.words,0);assert.equal(empty.bytes,0);
  const copy=await store.restore(file,empty.id);assert.equal(await fs.readFile(copy,'utf8'),'');
  await fs.writeFile(path.join(store.directory(file),'index.json'),'{broken');assert.equal((await store.list(file)).length,1);
  await fs.unlink(path.join(store.directory(file),empty.id));assert.deepEqual(await store.list(file),[]);
  await store.capture(file,'new','save');assert.equal((await store.list(file)).length,1);
}));
test('Failed restore removes its incomplete copy while preserving source and stored history',t=>fixture(async root=>{
  const store=new SnapshotStore({root:path.join(root,'snapshots')}),file=path.join(root,'note.md');await fs.writeFile(file,'current');const item=await store.capture(file,'history');
  const before=await fs.readdir(root),open=fs.open;
  t.mock.method(fs,'open',async(target,...args)=>{const handle=await open(target,...args);if(path.dirname(target)===root&&target!==file)handle.writeFile=async()=>{throw new Error('disk full fixture');};return handle;});
  await assert.rejects(store.restore(file,item.id),/disk full/);assert.deepEqual(await fs.readdir(root),before);assert.equal(await fs.readFile(file,'utf8'),'current');assert.equal((await store.preview(file,item.id)).text,'history');
}));
