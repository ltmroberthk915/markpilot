'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,reset,snapshot,recorder}=require('./harness.cjs');
(async()=>{
  const o=args(process.argv.slice(2)),dir=outputDir(o.out,'performance'),release=acquireSlot();
  const file=path.join(dir,'performance-fixture.md');fs.writeFileSync(file,'PERFORMANCE FIXTURE\n');
  const result={schema:1,startedAt:new Date().toISOString(),cases:[],performance:[],metric:'Wall time for CDP insertText through the next renderer animation frame; includes transport and frame pacing, excludes full-document reads'};
  const check=recorder(dir,result);let run;
  try {
    run=await launch(o,file,dir);result.metadata=run.metadata;const p=run.page;
    for(const [kind,lines] of [['plain',1000],['plain',10000],['plain',100000],['math',1000],['math',10000]]) {
      await check(kind+'-'+lines+'-lines',async trace=>{
        const text=Array.from({length:lines},(_,i)=>kind==='plain' ? '正文 '+i+' abcdefghijklmnopqrstuvwxyz' : '公式 '+i+' $x_'+i+'^2+\\alpha$').join('\n')+'\n';
        await reset(p,text,text.length);await sleep(300);const samples=[];
        for(let i=0;i<35;i++) {
          const started=performance.now();await p.keyboard.insertText('x');
          const s=await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
            const v=window.mpEngine._view();resolve({length:v.state.doc.length,tail:v.state.doc.sliceString(v.state.doc.length-35),focus:v.hasFocus});
          })));
          const elapsed=performance.now()-started;
          assert.equal(s.length,text.length+i+1,'input '+i+' must land');assert(s.focus);assert(s.tail.endsWith('x'.repeat(i+1)));
          if(i>=5)samples.push(elapsed);
        }
        const final=await snapshot(p);assert.equal(final.text,text+'x'.repeat(35),'all inputs preserve the fixture');
        const sorted=[...samples].sort((a,b)=>a-b),health=await p.evaluate(()=>window.mpHost.health());
        const metric={kind,lines,characters:text.length,warmup:5,samples:30,p50Ms:Math.round(sorted[14]),p95Ms:Math.round(sorted[28]),maxMs:Math.round(sorted[29]),rawMs:samples,health};
        result.performance.push(metric);trace.push({characters:text.length,tail:final.text.slice(-35),selection:final.selection});return metric;
      });
    }
  }catch(e){result.fatal=e.stack;console.error(e.message);}
  finally{
    result.cleanup=run ? await run.cleanup() : {residual:[]};result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&result.cases.length===5&&result.cases.every(c=>c.status==='pass')&&result.cleanup.residual.length===0;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();console.log(JSON.stringify({out:dir,passed:result.passed,performance:result.performance.map(({rawMs,health,...r})=>r),cleanup:result.cleanup}));process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
