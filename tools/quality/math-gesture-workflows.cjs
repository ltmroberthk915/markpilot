'use strict';
// Real formula gestures: click/jitter controls and two independently qualified loops.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,snapshot,frame,recorder,newWindow,waitUntil}=require('./harness.cjs');
const SEED=32923,initial='START\n\n$$\na+b\n$$\n\n'+Array.from({length:24},(_,i)=>'P'+String(i).padStart(2,'0')+' ordinary fixed seed '+SEED+' words.\n\n').join('');
const glyphEndpoint=initial.indexOf('a+b')+1;
const entry=(ok,why)=>{if(!ok)throw Error('ENTRY_UNCONFIRMED: '+why);};
async function main(){
 const o=args(process.argv.slice(2));entry(/^[a-f0-9]{64}$/i.test(o['expected-sha256']||''),'mandatory executable SHA');
 const dir=outputDir(o.out,'math-gesture-workflows'),result={schema:1,suite:'math-gesture-workflows',startedAt:new Date().toISOString(),seed:SEED,cases:[],errors:[],cleanupErrors:[],clipboard:{touched:false},probeSha256:sha256(__filename),fixtureSha256:null,transport:'Renderer CDP actual input; OS physical input unverified'};
 const record=recorder(dir,result);let release,run;
 try{
  release=acquireSlot(ROOT);const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Formula gesture owner\n');run=await launch(o,owner,dir);result.artifact=run.metadata;
  const filter=process.env.MP_QUALITY_CASES, wanted=id=>!filter||new RegExp(filter).test(id);
  for(const kind of ['click','jitter','local-loop','wheel-only']){
   const id='math-gesture-'+kind+'-source-and-selection';if(!wanted(id))continue;
   await record(id,async trace=>{
    const item=result.cases.at(-1);item.productReached=false;const file=path.join(dir,kind+'.md');fs.writeFileSync(file,initial);result.fixtureSha256=sha256(file);
    const p=await newWindow(run,run.page,file);let held=false;p.on('pageerror',e=>result.errors.push({id,error:e.message}));
    const capture=async stage=>{const s=await snapshot(p),diag=await p.evaluate(()=>({events:window.__gestureEvents,rangeCount:window.mpEngine._view().state.selection.ranges.length,viewportHeight:window.mpEngine._view().scrollDOM.clientHeight}));const t={name:kind+'-'+stage,...s,...diag,disk:fs.readFileSync(file,'utf8')};trace.push(t);t.screenshot=await frame(p,dir,t.name,{allowMissingCaret:true});return t;};
    try{
     await p.bringToFront();await waitUntil(async()=>{const s=await snapshot(p);return s.focus&&s.text===initial;},'actual fixture editor focus');
     await p.evaluate(()=>{const v=window.mpEngine._view();window.__gestureEvents={pointers:[],wheels:[],scrolls:[]};for(const type of ['mousedown','mousemove','mouseup'])document.addEventListener(type,e=>{if(type==='mousemove'&&!e.buttons)return;const r=v.state.selection.main;window.__gestureEvents.pointers.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,detail:e.detail,inEditor:v.contentDOM.contains(e.target),math:!!e.target.closest?.('.mp-cm6-math-block'),selection:{anchor:r.anchor,head:r.head},at:performance.now()});},{capture:true,passive:true});document.addEventListener('wheel',e=>window.__gestureEvents.wheels.push({trusted:e.isTrusted,deltaY:e.deltaY,buttons:e.buttons,at:performance.now()}),{capture:true,passive:true});v.scrollDOM.addEventListener('scroll',e=>window.__gestureEvents.scrolls.push({trusted:e.isTrusted,top:v.scrollDOM.scrollTop,at:performance.now()}),{passive:true});});
     await p.keyboard.press('Control+Home');await sleep(120);const before=await capture('01-before');assert.equal(before.text,initial);assert.equal(before.disk,initial);assert(before.focus&&before.rangeCount===1);
     const point=await p.evaluate(()=>{const v=window.mpEngine._view(),el=[...v.contentDOM.querySelectorAll('.mp-cm6-math-block .katex-html [data-typora-source-start]')].find(e=>e.textContent==='a'&&e.getBoundingClientRect().width>0),r=el?.getBoundingClientRect(),sc=v.scrollDOM.getBoundingClientRect();return r&&{x:r.left+r.width*.8,y:(r.top+r.bottom)/2,sc:{left:sc.left,right:sc.right,top:sc.top,bottom:sc.bottom}};});
     entry(point&&point.y+160<point.sc.bottom&&point.x+20<point.sc.right,'fixed true rendered glyph and movement path');trace.push({name:'fixed-path',kind,point,glyphEndpoint,steps:16,stepMs:20});
     await p.mouse.move(point.x,point.y);await p.mouse.down({clickCount:1});held=true;
     if(kind==='local-loop'){for(let i=1;i<=16;i++){await p.mouse.move(point.x+20*i/16,point.y+160*i/16);await sleep(20);}for(let i=1;i<=16;i++){await p.mouse.move(point.x+20*(1-i/16),point.y+160*(1-i/16));await sleep(20);}}
     else if(kind==='jitter'){await p.mouse.move(point.x+2,point.y+1);await sleep(65);await p.mouse.move(point.x,point.y);}
     else if(kind==='wheel-only'){for(const delta of [300,300]){await p.mouse.wheel(0,delta);await sleep(80);}}
     else await sleep(65);
     await sleep(80);const pre=await capture('02-pre-up'),stable=await snapshot(p),down=pre.events.pointers.find(e=>e.type==='mousedown'),pressed=pre.events.pointers.filter(e=>e.type==='mousemove'&&e.trusted&&(e.buttons&1));
     entry(down?.trusted&&down.math&&down.inEditor&&down.button===0&&(down.buttons&1)&&down.detail===1,'true formula pointer down');entry(pre.focus&&pre.rangeCount===1&&pre.text===initial&&stable.text===pre.text&&stable.scrollTop===pre.scrollTop&&stable.selection.anchor===pre.selection.anchor&&stable.selection.head===pre.selection.head,'observational stable pre-up range');
     const maxDistance=Math.max(0,...pressed.map(e=>Math.abs(e.x-down.x)+Math.abs(e.y-down.y))),scrollDelta=pre.scrollTop-before.scrollTop;
     if(kind==='local-loop')entry(pressed.length>=32&&maxDistance>=160&&pre.events.wheels.length===0&&scrollDelta===0,'true no-scroll pressed loop');
     else if(kind==='wheel-only')entry(pressed.length===0&&pre.events.wheels.length===2&&pre.events.wheels.every(e=>e.trusted&&e.deltaY===300&&e.at>down.at)&&pre.events.scrolls.some(e=>e.trusted)&&scrollDelta>=pre.viewportHeight/2,'true held wheel without pressed movement');
     else entry(pre.events.wheels.length===0&&maxDistance<=4&&scrollDelta===0,'click or small jitter positive control');
     const drag=kind==='local-loop'||kind==='wheel-only';if(drag)entry(pre.selection.anchor!==glyphEndpoint||pre.selection.head!==glyphEndpoint,'pre-up range discriminates native ownership from exact glyph click');
     item.productReached=true;item.oracle={preUp:pre.selection,glyphEndpoint,maxDistance,scrollDelta};
     await p.mouse.up({clickCount:1});held=false;await sleep(120);const after=await capture('03-released'),up=after.events.pointers.find(e=>e.type==='mouseup');
     entry(up?.trusted&&up.inEditor&&up.button===0&&!(up.buttons&1)&&up.detail===1&&Math.abs(up.x-down.x)+Math.abs(up.y-down.y)<=4,'actual release at original screen point');
     assert.equal(after.text,initial);assert.equal(after.disk,initial);assert(after.focus);
     assert.deepEqual(after.selection,drag?pre.selection:{anchor:glyphEndpoint,head:glyphEndpoint},drag?'formula gesture release preserves proven native pre-up range':'real click and small jitter retain exact source glyph endpoint');
     return{kind,sourceUntouched:true,selection:after.selection,discriminating:true};
    }catch(e){try{await capture('failure');}catch(x){trace.push({name:'failure-capture-error',error:x.message});}throw e;}finally{if(held)await p.mouse.up({clickCount:1}).catch(e=>result.cleanupErrors.push(e.message));}
   });const c=result.cases.at(-1);if(c.error?.startsWith('ENTRY_UNCONFIRMED:'))c.status='entry-unconfirmed';else if(c.status==='fail')c.failureKind=c.productReached?'product-check':'harness-or-setup';
  }entry(result.cases.length>0,'known case filter');
 }catch(e){result.fatal=e.stack||e.message;}finally{try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupErrors.push(e.message);}try{release?.();}catch(e){result.cleanupErrors.push(e.message);}result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&result.cleanup?.residual?.length===0;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));}
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
