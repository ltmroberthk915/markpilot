const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {APP_ID,LIMIT,quoteArgument,commandLine,launcherFor,buildJumpList,JumpListController}=require('../app/main/jump-list');
const launcher={program:path.resolve('markpilot.exe'),args:[]},file=i=>path.resolve('笔记 # (test)',i+'.md');
const mockApp=(isPackaged=true,profile='')=>({isPackaged,getAppPath:()=>path.resolve('.'),commandLine:{getSwitchValue:()=>profile}});

test('15 unique files retain MRU order and the create task is last after a separator',()=>{
  const recent=[file(3),file(3).toUpperCase(),file(4),...Array.from({length:30},(_,i)=>file(i))];
  const [category]=buildJumpList(recent,launcher),items=category.items;
  assert.equal(category.type,'tasks');assert.equal(items.length,LIMIT+2);
  assert.deepEqual(items.slice(0,3).map(i=>i.title),['3.md','4.md','0.md']);
  assert.equal(new Set(items.slice(0,LIMIT).map(i=>i.args.toLowerCase())).size,LIMIT);
  assert.equal(items.at(-2).type,'separator');assert.equal(items.at(-1).title,'新建 Markdown 文件');
  assert.equal(items.at(-1).args,'"--new-md"');
  assert.equal(items[0].args,commandLine(['--',file(3)]));
});
test('empty history has one create task; same-name files show their different directories',()=>{
  assert.equal(buildJumpList([],launcher)[0].items.length,1);
  const items=buildJumpList([file('a'),path.resolve('其他目录','a.md')],launcher)[0].items;
  assert.ok(items[0].title.includes(path.dirname(file('a'))));
  assert.ok(items[1].title.includes(path.resolve('其他目录')));
  assert.notEqual(items[0].title,items[1].title);
});
test('installed, portable and explicit profile launchers preserve the appropriate executable and identity',()=>{
  const installed=launcherFor(mockApp(),{executable:launcher.program,env:{}});
  assert.equal(installed.id,APP_ID);assert.deepEqual(installed.args,[]);
  const portable=path.resolve('便携 程序','markpilot portable.exe');
  assert.equal(launcherFor(mockApp(),{env:{PORTABLE_EXECUTABLE_FILE:portable}}).program,portable);
  const profile=path.resolve('.perf','profile with spaces');
  const isolated=launcherFor(mockApp(true,profile),{executable:launcher.program,env:{}});
  assert.notEqual(isolated.id,APP_ID);assert.deepEqual(isolated.args,['--user-data-dir='+profile]);
  assert.equal(isolated.id,launcherFor(mockApp(true,profile.toUpperCase()),{env:{}}).id);
  const dev=launcherFor(mockApp(false),{env:{PORTABLE_EXECUTABLE_FILE:portable}});
  assert.equal(dev.program,process.execPath);assert.deepEqual(dev.args,[path.resolve('.')]);
});
test('Windows command line survives native argv decoding without a shell',{skip:process.platform!=='win32'},()=>{
  const args=['中文 空格 # & (x).md','--new-md','C:\\trailing spaces\\','a"b','a\\"b','',String.raw`a\\\"b`];
  const raw=commandLine(['-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--',...args]);
  const result=spawnSync(process.execPath,[raw],{argv0:quoteArgument(process.execPath),windowsVerbatimArguments:true,windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),args);
});

function setup(t,{recent=[file(1)],stat=async()=>({isFile:()=>true}),...options}={}) {
  const calls=[],state={recent:()=>({recentFiles:recent})};
  const app={setJumpList:items=>{calls.push(items);return 'ok';}};
  const controller=new JumpListController({app,state,launcher,enabled:true,stat,...options});
  t.after(()=>controller.dispose());
  return {controller,calls,app,setRecent:value=>{recent=value;controller.changed();}};
}
test('missing paths and directories are skipped and older valid files fill the 15 slots',async t=>{
  const {controller,calls}=setup(t,{recent:Array.from({length:25},(_,i)=>file(i)),stat:async f=>{
    if(f===file(0))throw new Error('deleted');return {isFile:()=>f!==file(1)};
  }});
  controller.changed();await controller.flush();
  assert.equal(calls[0][0].items[0].title,'2.md');assert.equal(calls[0][0].items.at(-3).title,'16.md');
  assert.equal(controller.needsFlush,false);
});
test('debounced changes publish once; identical contents do not rewrite the shell list',async t=>{
  const {controller,calls,setRecent}=setup(t);
  controller.changed();controller.changed();setRecent([file(2),file(1)]);await controller.flush();
  assert.equal(calls.length,1);assert.equal(calls[0][0].items[0].title,'2.md');
  controller.changed();await controller.flush();assert.equal(calls.length,1);
  setRecent([file(1),file(2)]);await controller.flush();assert.equal(calls.length,2);
});
test('slow stale file checks cannot overwrite a newer recent list',async t=>{
  let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
  const {controller,calls,setRecent}=setup(t,{stat:async f=>{if(f===file(1)){entered();await gate;}return{isFile:()=>true};}});
  controller.changed();const first=controller.flush();await start;
  setRecent([file(2)]);release();await first;
  assert.equal(calls.length,1);assert.equal(calls[0][0].items[0].title,'2.md');
});
test('unreachable drive times out and never blocks flushing during quit',async t=>{
  const {controller,calls}=setup(t,{stat:()=>new Promise(()=>{}),statTimeout:20});
  controller.changed();await controller.flush();
  assert.equal(calls[0][0].items.length,1);assert.equal(controller.needsFlush,false);
});
test('Explorer rejection and exceptions finish the attempt and retry on the next change',async t=>{
  const {controller,app}=setup(t);let count=0;
  t.mock.method(console,'error',()=>{});
  app.setJumpList=()=>{count++;if(count===1)throw new Error('Explorer unavailable');return count===2?'error':'ok';};
  for(const expected of ['error','error','ok']){controller.changed();await controller.flush();assert.equal(controller.result,expected);assert.equal(controller.needsFlush,false);}
  assert.equal(count,3);
});
test('focus refreshes after inactivity; disabled and disposed instances never publish',async t=>{
  const {controller,calls}=setup(t);controller.changed();await controller.flush();
  const initial=controller.version;controller.focus();assert.equal(controller.version,initial);
  controller.lastRefresh=Date.now()-31000;controller.focus();assert.equal(controller.version,initial+1);
  controller.dispose();await controller.flush();assert.equal(calls.length,1);
  const disabled=setup(t,{enabled:false});disabled.controller.changed();await disabled.controller.flush();assert.equal(disabled.calls.length,0);
});
