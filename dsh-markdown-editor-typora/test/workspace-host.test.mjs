// Product candidate: install as test/workspace-host.test.mjs.
// No desktop, ASAR, service, or repository-external fixture dependency.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,stat,unlink,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createHost} from '../lib/index.js';

const version=s=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const provider={
  async resolve(p){return {targetKey:resolve(p),displayPath:resolve(p)};},
  async stat(target){
    try{const s=await stat(target.targetKey,{bigint:true});return {type:s.isFile()?'file':'directory',version:version(s),size:Number(s.size)};}
    catch(error){if(error.code==='ENOENT')return undefined;throw error;}
  },
  async readText(target){return readFile(target.targetKey,'utf8');},
  async writeText(){throw Error('Unexpected ordinary write during draft-creation test');}
};
const log={info(){},warn(){},error(){}};
const draft=(dir,text='',id=randomUUID())=>({dir,draftId:id,exactText:text});
const target=p=>join(p.dir,`未命名-${p.draftId.toLowerCase()}.md`);
const expectOk=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};

test('workspace host APIs preserve cwd isolation and draft creation boundaries',{timeout:30000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'markpilot-workspace-host-')));
  const previous={APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA};
  process.env.APPDATA=join(root,'appdata');process.env.LOCALAPPDATA=join(root,'localappdata');
  const cwd=join(root,'work'),other=join(root,'work-other');
  await mkdir(cwd);await mkdir(other);await mkdir(process.env.APPDATA);await mkdir(process.env.LOCALAPPDATA);
  const hosts=[];
  const make=()=>{const h=createHost({fs:provider,log});hosts.push(h);return h;};
  const host=make();
  const create=payload=>host.dispatch('docs/create',payload);
  const recent=payload=>host.dispatch('docs/recent',payload);
  const history=join(process.env.APPDATA,'MarkPilot','workspace-recents.json');
  const globalHistory=join(process.env.APPDATA,'MarkPilot','recents.json');
  try{
    await t.test('blank descriptor and invalid create requests never write a file',async()=>{
      assert.deepEqual(await readdir(cwd),[]);
      for(const payload of [draft(cwd,'x','../bad'),{dir:cwd,draftId:randomUUID()},draft('relative','x'),{...draft(cwd),path:join(other,'arbitrary.md')}]){
        assert.equal((await create(payload)).ok,false);
      }
      assert.deepEqual(await readdir(cwd),[]);assert.deepEqual(await readdir(other),[]);
    });
    await t.test('automatic draft destination must already exist',async()=>{
      const dir=join(cwd,'missing');assert.equal((await create(draft(dir))).ok,false);
      await assert.rejects(stat(dir),{code:'ENOENT'});
    });
    const one=join(cwd,'one.md'),two=join(cwd,'two.markdown'),outside=join(other,'outside.md');
    await writeFile(one,'one');await writeFile(two,'two');await writeFile(outside,'outside');
    await mkdir(join(process.env.APPDATA,'MarkPilot'));await writeFile(globalHistory,JSON.stringify([outside,one]));
    await t.test('migration selects only Markdown files contained by this cwd',async()=>{
      const result=expectOk(await recent({op:'list',workspace:cwd}));assert.deepEqual(result.items,[one]);
    });
    await t.test('workspace push changes only workspace MRU order',async()=>{
      expectOk(await recent({op:'push',workspace:cwd,path:two}));
      assert.deepEqual(expectOk(await recent({op:'list',workspace:cwd})).items,[two,one]);
      assert.deepEqual(expectOk(await recent({op:'list'})).items,[outside,one]);
    });
    await t.test('a sibling with a matching path prefix is outside the workspace',async()=>{
      const result=expectOk(await recent({op:'push',workspace:cwd,path:outside}));
      assert.equal(result.recorded,false);assert.deepEqual(result.items,[two,one]);
    });
    await t.test('parallel host updates retain both workspace histories',async()=>{
      const second=make();
      const results=await Promise.all([recent({op:'push',workspace:cwd,path:one}),second.dispatch('docs/recent',{op:'push',workspace:other,path:outside})]);
      results.forEach(expectOk);
      assert.deepEqual(expectOk(await second.dispatch('docs/recent',{op:'list',workspace:other})).items,[outside]);
      expectOk(await recent({op:'push',workspace:cwd,path:two}));
    });
    await t.test('missing recent is pruned without losing the next file',async()=>{
      await unlink(two);assert.deepEqual(expectOk(await recent({op:'list',workspace:cwd})).items,[one]);
    });
    await t.test('directories, non-Markdown files and relative paths cannot be pushed',async()=>{
      const text=join(cwd,'note.txt');await writeFile(text,'text');
      for(const path of [cwd,text,'one.md'])assert.equal((await recent({op:'push',workspace:cwd,path})).ok,false);
    });
    await t.test('workspace clear cannot erase the legacy global list',async()=>{
      expectOk(await recent({op:'clear',workspace:cwd}));
      assert.deepEqual(expectOk(await recent({op:'list',workspace:cwd})).items,[]);
      assert.deepEqual(expectOk(await recent({op:'list'})).items,[outside,one]);
    });
    await t.test('invalid workspace data returns an error rather than no history',async()=>{
      for(const payload of [{op:'list',workspace:'relative'},{op:'list',workspace:one},{op:'list',workspace:join(root,'absent')}]){
        assert.equal((await recent(payload)).ok,false);
      }
      const valid=await readFile(history,'utf8');
      await writeFile(history,'broken json');assert.equal((await recent({op:'list',workspace:cwd})).ok,false);
      // Use the actual platform key, including case-sensitive POSIX roots.
      await writeFile(history,JSON.stringify({schema:1,workspaces:{[process.platform==='win32'?cwd.toLowerCase():cwd]:'invalid'}}));
      assert.equal((await recent({op:'list',workspace:cwd})).ok,false);await writeFile(history,valid);
    });
    await t.test('corrupt legacy history cannot become empty migration',async()=>{
      const fresh=join(root,'fresh');await mkdir(fresh);const valid=await readFile(globalHistory,'utf8');
      await writeFile(globalHistory,'broken json');assert.equal((await recent({op:'list',workspace:fresh})).ok,false);
      await writeFile(globalHistory,valid);
    });
    await t.test('known receipt first-save behavior on POSIX',{skip:process.platform==='win32'?'Windows atomic-worker cases are exercised by the private native acceptance suite':false},async t=>{
      const p=draft(cwd,'literal {title}\r\n中文 🌙');
      const first=expectOk(await create(p));
      assert.equal(await readFile(target(p),'utf8'),p.exactText);
      assert.equal(first.version,version(await stat(target(p),{bigint:true})));
      assert.equal(first.requestedPath,target(p));
      const again=expectOk(await create(p));assert.equal(again.idempotent,true);assert.equal(again.version,first.version);
      assert.equal((await create({...p,exactText:'different'})).error?.code,'MP_DRAFT_REUSED');
      assert.equal((await create({...p,dir:other})).error?.code,'MP_DRAFT_REUSED');
      const concurrent=draft(cwd,'concurrent');const results=await Promise.all([create(concurrent),create(concurrent)]);
      results.forEach(expectOk);assert.equal(results[0].value.version,results[1].value.version);
      const collision=draft(cwd,'mine');await writeFile(target(collision),'external');
      assert.equal((await create(collision)).error?.code,'FS_STALE_VERSION');assert.equal(await readFile(target(collision),'utf8'),'external');
      assert.equal((await make().dispatch('docs/create',p)).value?.idempotent,true);
      await writeFile(target(p),'external changed');assert.equal((await create(p)).error?.code,'FS_STALE_VERSION');
      const removed=draft(cwd,'removed');expectOk(await create(removed));await unlink(target(removed));
      assert.equal((await create(removed)).error?.code,'FS_STALE_VERSION');
    });
  }finally{
    for(const h of hosts)h.close();
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    // root is the exact mkdtemp result owned by this test, never a user-supplied directory.
    await rm(root,{recursive:true,force:true});
  }
});
