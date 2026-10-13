'use strict';
// Profile the same genuine input path as performance.cjs. Raw profiles stay in the owned output.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,reset}=require('./harness.cjs');
function profileSummary(profile) {
  const byId=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map();
  for(const n of profile.nodes)for(const id of n.children||[])parents.set(id,n.id);
  const self=new Map(),total=new Map();
  for(let i=0;i<(profile.samples||[]).length;i++) {
    const id=profile.samples[i],us=profile.timeDeltas?.[i]||0;
    self.set(id,(self.get(id)||0)+us);
    for(let n=id;n!=null;n=parents.get(n))total.set(n,(total.get(n)||0)+us);
  }
  const rows=profile.nodes.map(n=>({function:n.callFrame.functionName||'(anonymous)',url:n.callFrame.url,line:n.callFrame.lineNumber+1,column:n.callFrame.columnNumber+1,selfMs:Math.round((self.get(n.id)||0)/1000),totalMs:Math.round((total.get(n.id)||0)/1000)}));
  return {durationMs:Math.round((profile.endTime-profile.startTime)/1000),samples:profile.samples?.length||0,bySelf:[...rows].sort((a,b)=>b.selfMs-a.selfMs).slice(0,35),byTotal:[...rows].sort((a,b)=>b.totalMs-a.totalMs).slice(0,35)};
}
(async()=>{
  const argv=process.argv.slice(2),index=argv.indexOf('--lines');
  if(index<0)throw new Error('Specify --lines <positive integer> along with normal launch arguments');
  const lines=Number(argv[index+1]);assert(Number.isSafeInteger(lines)&&lines>0&&lines<=1000000);argv.splice(index,2);
  const o=args(argv),dir=outputDir(o.out,'input-profile'),release=acquireSlot();
  const file=path.join(dir,'profile-fixture.md');fs.writeFileSync(file,'CPU PROFILE FIXTURE\n');
  const result={schema:1,startedAt:new Date().toISOString(),lines,metric:'CDP insertText through the next renderer animation frame; transport and frame pacing included'};
  let run,cdp,started=false;const errors=[];
  try {
    run=await launch(o,file,dir);result.metadata=run.metadata;const p=run.page;
    p.on('pageerror',e=>errors.push(e.message));
    const text=Array.from({length:lines},(_,i)=>'正文 '+i+' abcdefghijklmnopqrstuvwxyz').join('\n')+'\n';
    await reset(p,text,text.length);await sleep(500);
    cdp=await p.context().newCDPSession(p);await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});
    await cdp.send('Profiler.start');started=true;const timings=[];
    for(let i=0;i<15;i++) {
      const start=performance.now();await p.keyboard.insertText('x');
      const state=await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{const v=window.mpEngine._view();resolve({length:v.state.doc.length,tail:v.state.doc.sliceString(v.state.doc.length-15),focus:v.hasFocus&&document.hasFocus()});})));
      timings.push(performance.now()-start);assert.equal(state.length,text.length+i+1);assert(state.tail.endsWith('x'.repeat(i+1)));assert(state.focus);
    }
    await sleep(2500);
    const {profile}=await cdp.send('Profiler.stop');started=false;
    fs.writeFileSync(path.join(dir,'renderer.cpuprofile'),JSON.stringify(profile));
    result.profile=profileSummary(profile);result.timingsMs=timings;result.characters=text.length;result.errors=errors;
    const final=await p.evaluate(()=>window.mpEngine.getValue());assert.equal(final,text+'x'.repeat(15));assert.deepEqual(errors,[]);result.passed=true;
  }catch(e){result.passed=false;result.error=e.stack;}
  finally {
    if(started)await cdp?.send('Profiler.stop').catch(()=>{});
    await cdp?.detach().catch(()=>{});result.cleanup=run?await run.cleanup():{residual:[]};result.finishedAt=new Date().toISOString();
    result.passed=!!result.passed&&!result.cleanup.residual.length;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();
    console.log(JSON.stringify({out:dir,passed:result.passed,lines,errors,resultError:result.error,profile:result.profile,cleanup:result.cleanup}));process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
