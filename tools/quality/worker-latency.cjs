'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot}=require('./lifecycle.cjs');
const {outputDir,snapshot,recorder,waitUntil}=require('./harness.cjs');
(async()=>{
 const options=args(process.argv.slice(2)),dir=outputDir(options.out,'worker-latency'),release=acquireSlot(),file=path.join(dir,'latency-fixture.md');fs.writeFileSync(file,'SENSITIVE COMMAND LATENCY\n');
 const result={schema:1,startedAt:new Date().toISOString(),metric:'CDP key input through the next renderer frame, including transport and frame pacing; semantic correctness is asserted separately from latency',cases:[],errors:[]},check=recorder(dir,result);let run;
 try{
  run=await launch(options,file,dir);result.metadata=run.metadata;const p=run.page;p.on('pageerror',e=>result.errors.push(e.message));
  await check('pending-quote-enter-20-repetitions',async trace=>{
   const text='paragraph abcdefghijklmnopqrstuvwxyz\n'.repeat(15000)+'\n> quote';
   await p.bringToFront();const prepared=await p.evaluate(text=>{window.mpEngine.setValue(text);const v=window.mpEngine._view();v.dispatch({selection:{anchor:text.length},scrollIntoView:true});v.focus();return {focus:v.hasFocus&&document.hasFocus(),status:window.mpEngine._syntax()};},text);
   assert(prepared.focus);assert.equal(prepared.status.status,'pending');assert.equal(prepared.status.available,false);trace.push(prepared.status);
   const samples=[];for(let i=0;i<20;i++){
    const start=performance.now();await p.keyboard.press('Enter');await p.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));samples.push(performance.now()-start);await p.keyboard.insertText('x');
   }
   const state=await snapshot(p);assert.equal(state.text,text+'\n> x'.repeat(20));assert(state.focus);
   await waitUntil(()=>p.evaluate(()=>{const s=window.mpEngine._syntax();return s.status==='ready'&&s.available;}),'final complete syntax',10000);
   const status=await p.evaluate(()=>window.mpEngine._syntax());assert.equal(status.error,null);trace.push(status);
   const sorted=samples.slice(1).sort((a,b)=>a-b);return {characters:text.length,samples:20,firstMs:Math.round(samples[0]),steadyP50Ms:Math.round(sorted[9]),steadyP95Ms:Math.round(sorted[18]),rawMs:samples,status};
  });
 }catch(e){result.fatal=e.stack;}
 finally{result.cleanup=run?await run.cleanup():{residual:[]};result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&result.cases.length===1&&result.cases.every(c=>c.status==='pass')&&!result.errors.length&&!result.cleanup.residual.length;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;}
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
