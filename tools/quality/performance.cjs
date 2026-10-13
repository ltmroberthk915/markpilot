'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,reset,snapshot,recorder}=require('./harness.cjs');
(async()=>{
  const argv=process.argv.slice(2),budgetIndex=argv.indexOf('--latency-budget-ms');let latencyBudgetMs=null;
  if(budgetIndex>=0){latencyBudgetMs=Number(argv[budgetIndex+1]);assert(Number.isFinite(latencyBudgetMs)&&latencyBudgetMs>0,'Use a positive latency budget');argv.splice(budgetIndex,2);}
  const o=args(argv),dir=outputDir(o.out,'performance'),release=acquireSlot();
  const file=path.join(dir,'performance-fixture.md');fs.writeFileSync(file,'PERFORMANCE FIXTURE\n');
  const result={schema:1,startedAt:new Date().toISOString(),cases:[],performance:[],latencyBudgetMs,metric:'Wall time for CDP keyboard/insertText through the next renderer animation frame; includes transport and frame pacing, excludes full-document reads; the optional budget applies to steady p95'};
  const check=recorder(dir,result);let run;
  try {
    run=await launch(o,file,dir);result.metadata=run.metadata;const p=run.page;
    for(const [kind,lines] of [['plain',1000],['plain',10000],['plain',100000],['math',1000],['math',10000],['backspace',100000],['code',100000]]) {
      await check(kind+'-'+lines+'-lines',async trace=>{
        const prefix=Array.from({length:lines},(_,i)=>kind==='math' ? '公式 '+i+' $x_'+i+'^2+\\alpha$' : '正文 '+i+' abcdefghijklmnopqrstuvwxyz').join('\n')+'\n';
        const text=kind==='backspace'?prefix+'x'.repeat(35):kind==='code'?prefix+'\n```js\nconst value = ;\n```\n':prefix;
        const anchor=kind==='code'?text.lastIndexOf(' = ;')+3:text.length;
        await reset(p,text,anchor);await sleep(700);const samples=[],warmupMs=[];
        await p.evaluate(()=>{window.__qualityFrameGaps=[];let last=performance.now();const tick=now=>{window.__qualityFrameGaps.push(now-last);last=now;window.__qualityFrameWatch=requestAnimationFrame(tick);};window.__qualityFrameWatch=requestAnimationFrame(tick);});
        for(let i=0;i<35;i++) {
          const started=performance.now();if(kind==='backspace')await p.keyboard.press('Backspace');else await p.keyboard.insertText('x');
          const s=await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
            const v=window.mpEngine._view();resolve({length:v.state.doc.length,tail:v.state.doc.sliceString(v.state.doc.length-100),focus:v.hasFocus});
          })));
          const elapsed=performance.now()-started;
          assert.equal(s.length,text.length+(kind==='backspace'?-(i+1):i+1),'input '+i+' must land');assert(s.focus);if(kind!=='code'&&kind!=='backspace')assert(s.tail.endsWith('x'.repeat(i+1)));
          if(i>=5)samples.push(elapsed);else warmupMs.push(elapsed);
        }
        await sleep(900);const gaps=await p.evaluate(()=>{cancelAnimationFrame(window.__qualityFrameWatch);return window.__qualityFrameGaps;});
        const final=await snapshot(p),expected=kind==='backspace'?prefix:kind==='code'?text.slice(0,anchor)+'x'.repeat(35)+text.slice(anchor):text+'x'.repeat(35);assert.equal(final.text,expected,'all inputs preserve the fixture');
        const sorted=[...samples].sort((a,b)=>a-b),health=await p.evaluate(()=>window.mpHost.health()),syntax=await p.evaluate(()=>window.mpEngine._syntax?.()??null);
        const frames=[...gaps].sort((a,b)=>a-b),metric={kind,lines,characters:text.length,warmup:5,samples:30,p50Ms:Math.round(sorted[14]),p95Ms:Math.round(sorted[28]),maxMs:Math.round(sorted[29]),firstInputMs:Math.round(warmupMs[0]),warmupMaxMs:Math.round(Math.max(...warmupMs)),frameP95Ms:Math.round(frames[Math.floor(frames.length*.95)]),frameMaxMs:Math.round(frames.at(-1)),rawMs:samples,health};
        metric.syntax=syntax;result.performance.push(metric);trace.push({characters:text.length,tail:final.text.slice(-35),selection:final.selection});
        if(syntax)assert.equal(syntax.error,null,'Worker must not silently degrade during the performance measurement');
        if(latencyBudgetMs!==null)assert(metric.p95Ms<=latencyBudgetMs,kind+'-'+lines+' p95 '+metric.p95Ms+'ms exceeds '+latencyBudgetMs+'ms');
        return metric;
      });
    }
  }catch(e){result.fatal=e.stack;console.error(e.message);}
  finally{
    result.cleanup=run ? await run.cleanup() : {residual:[]};result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&result.cases.length===7&&result.cases.every(c=>c.status==='pass')&&result.cleanup.residual.length===0;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();console.log(JSON.stringify({out:dir,passed:result.passed,performance:result.performance.map(({rawMs,health,...r})=>r),cleanup:result.cleanup}));process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
