'use strict';
/* UNRUN PRIVATE PROBE (no execution claims until ROOT runs it). Corpus inline-math
 * glyph-click -> immediate R -> undo -> 35x continuous R perf -> undo-only restore
 * -> Ctrl+S disk oracle -> 20x wheel exit/reentry lifetime (status only).
 * CLI: --corpus <owned utf8 copy> --target <manifest.json> --exe <exe>
 *      [--expected-sha256 <exe sha>] --out <dir>
 * Manifest: {corpusSha256, mathCount, from, to, expectedCaret, glyph, side(=.8)}.
 * Oracles: manifest expectedCaret + literal splices only; never beforeinput offsets,
 * never source attributes. Mount lookup = regionID + viewport rect intersection,
 * never posAtDOM. No DOM stubs; real app page only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,frame,waitUntil}=require('./harness.cjs');
const sha=s=>crypto.createHash('sha256').update(s,'utf16le').digest('hex');
const norm=b=>{let t=b.toString('utf8');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);return t.replace(/\r\n?/g,'\n');};
const splice=(s,at,ins)=>s.slice(0,at)+ins+s.slice(at);
async function main(){
 const mine={};const rest=[];
 for(let i=2;i<process.argv.length;i++){const k=process.argv[i];
  if(k==='--corpus'||k==='--target')mine[k.slice(2)]=process.argv[++i];else rest.push(k,process.argv[++i]);}
 assert(mine.corpus&&mine.target,'--corpus and --target required');const o=args(rest);
 assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']||''),'explicit executable identity required');
 const dir=outputDir(o.out,'corpus-math-perf');let release;
 const bytes=fs.readFileSync(mine.corpus),rawSha=sha256(mine.corpus);
 const m=JSON.parse(fs.readFileSync(mine.target,'utf8'));
 assert(rawSha===m.corpusSha256,'corpus sha mismatch vs manifest');
 const E0=norm(bytes),T=m.target,side=Number.isFinite(m.side)?m.side:0.8;
 assert(Number.isInteger(T.from)&&Number.isInteger(T.to)&&Number.isInteger(T.expectedCaret),'manifest integer ranges');
 assert(T.from<T.to&&T.expectedCaret>=T.from&&T.expectedCaret<=T.to,'expectedCaret inside target literal');
 assert(typeof m.glyph==='string'&&[...m.glyph].length===1,'single plain glyph');
 assert(E0[T.from]==='$'&&E0[T.to-1]==='$'&&E0[T.from+1]===m.glyph&&T.expectedCaret===T.from+2,'independent first plain glyph literal end');
 assert(side>0&&side<1&&Number.isInteger(m.mathCount)&&m.mathCount>0,'manifest count and click side');
 const E1=splice(E0,T.expectedCaret,'R'),E35=splice(E0,T.expectedCaret,'R'.repeat(35));
 const file=path.join(dir,'owned-copy.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
 const result={schema:1,kind:'private-corpus-math-performance',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),manifestSha256:sha256(mine.target),
  corpus:{rawSha256:rawSha,normSha256:sha(E0),normUTF16:E0.length,mathCount:m.mathCount,target:{from:T.from,to:T.to,expectedCaret:T.expectedCaret},side,assetsCopied:0},
  expected:{e1:sha(E1),e35:sha(E35)},stages:[],perf:null,lifetime:null,clipboardTouched:false,errors:[]};
 let run,p;
 const ok=(name,cond,extra)=>{const s={name,ok:!!cond,...(extra||{})};result.stages.push(s);assert(cond,name);};
 const read=async()=>p.evaluate(({from,to})=>{const v=window.mpEngine._view(),sel=v.state.selection.main,regions=window.mpEngine.__regions().regions.filter(r=>r.kind==='math'),target=regions.find(r=>r.from===from&&r.to===to);
  return{len:v.state.doc.length,focus:v.hasFocus&&document.hasFocus(),head:sel.head,mathCount:regions.length,target:target&&{id:target.id,from:target.from,to:target.to}};},T);
 const textIs=w=>p.evaluate(w=>window.mpEngine._view().state.doc.toString()===w,w);
 const mountVisible=id=>p.evaluate(id=>{const el=document.querySelector('.mp-cm6-math[data-mp-region="'+id+'"],.mp-inline-float[data-mp-region="'+id+'"]');
  if(!el)return false;const r=el.getBoundingClientRect(),s=document.querySelector('.cm-scroller')?.getBoundingClientRect();
  return !!s&&r.width>0&&r.bottom>s.top+2&&r.top<s.bottom-2;},id);
 try{
  release=acquireSlot();
  run=await launch(o,file,dir);p=run.page;result.metadata=run.metadata;p.on('pageerror',e=>result.errors.push(e.message));
  await p.bringToFront();
  await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'boot focus',9000);
  ok('S0 loaded exact normalized copy',await textIs(E0));
  const r0=await read(),target=r0.target;
  ok('S0 target math by exact range',!!target&&r0.mathCount===m.mathCount,{mathRegions:r0.mathCount,mathCountMatches:r0.mathCount===m.mathCount});
  const tid=target.id;
  result.targetId=tid;
  await p.keyboard.press('Control+Home');await sleep(200);
  result.navigation=[];
  const nav=()=>p.evaluate(tid=>{const v=window.mpEngine._view(),e=v.dom.querySelector('[data-mp-region="'+tid+'"]'),b=e?.getBoundingClientRect(),s=v.scrollDOM.getBoundingClientRect();return{top:v.scrollDOM.scrollTop,viewport:v.viewport,target:b&&{top:b.top,bottom:b.bottom,width:b.width,className:e.className},scroller:{top:s.top,bottom:s.bottom},mounted:[...v.dom.querySelectorAll('[data-mp-region]')].map(e=>e.dataset.mpRegion)};},tid);
  result.navigation.push(await nav());
  for(let k=0;k<80&&!await mountVisible(tid);k++){await p.mouse.wheel(0,260);await sleep(90);const n=await nav();result.navigation.push(n);if(n.viewport.from>T.to)break;}
  await waitUntil(()=>mountVisible(tid),'target math visible',9000);
  const glyph=await p.evaluate(({tid,g,side})=>{const el=document.querySelector('.mp-cm6-math[data-mp-region="'+tid+'"],.mp-inline-float[data-mp-region="'+tid+'"]');
   if(!el)return null;const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
   for(let n;(n=w.nextNode());){const i=n.nodeValue.indexOf(g);if(i>=0){const r=document.createRange();
    r.setStart(n,i);r.setEnd(n,i+1);const b=r.getBoundingClientRect();if(b.width>0&&b.bottom>b.top)return{x:b.left+b.width*side,y:(b.top+b.bottom)/2};}}
   return null;},{tid,g:m.glyph,side});
  ok('S1 visible glyph leaf found',!!glyph);
  await p.evaluate(({length,head})=>{
    window.__firstNative=null;
    const listener=e=>{
      if(e.data!=='R')return;
      document.removeEventListener('beforeinput',listener,true);
      const started=performance.now(),v=window.mpEngine._view(),epoch=window.mpEngine.documentSession().epoch;
      window.__firstNative={trusted:e.isTrusted,inMaster:v.contentDOM.contains(e.target),beforeFocus:v.hasFocus&&document.hasFocus(),composing:e.isComposing,started,frameAttempts:0,metric:'beforeinput to committed/caret-ready RAF; before paint'};
      const tick=()=>{
        const view=window.mpEngine._view(),selection=document.getSelection(),bounds=view.scrollDOM.getBoundingClientRect();let caret,nativeHead;
        window.__firstNative.frameAttempts++;
        try{if(selection?.isCollapsed&&view.contentDOM.contains(selection.anchorNode)&&view.contentDOM.contains(selection.focusNode)){
          nativeHead=view.posAtDOM(selection.focusNode,selection.focusOffset);
          if(view.posAtDOM(selection.anchorNode,selection.anchorOffset)===head&&nativeHead===head)caret=selection.getRangeAt(0).getBoundingClientRect();
        }}catch{}
        // DOM geometry and posAtDOM do not call CM readMeasured/flush. The
        // recorder must observe natural timing, never advance pending measures.
        const visible=caret&&caret.bottom>caret.top&&caret.bottom>Math.max(0,bounds.top)&&caret.top<Math.min(innerHeight,bounds.bottom)&&caret.left>=bounds.left-1&&caret.left<=bounds.right+1;
        const ready=window.mpEngine.documentSession().epoch===epoch&&view.state.doc.length===length&&view.state.selection.main.head===head&&view.hasFocus&&document.hasFocus()&&visible;
        if(ready)Object.assign(window.__firstNative,{milliseconds:performance.now()-started,committedVisibleOwner:true,nativeHead});
        else if(performance.now()-started<2000)requestAnimationFrame(tick);
        else window.__firstNative.timedOut=true;
      };
      requestAnimationFrame(tick);
    };
    document.addEventListener('beforeinput',listener,true);
  },{length:E0.length+1,head:T.expectedCaret+1});
  let profiler;
  if(process.env.MP_QUALITY_PROFILE_FIRST==='1'){profiler=await p.context().newCDPSession(p);await profiler.send('Profiler.enable');await profiler.send('Profiler.setSamplingInterval',{interval:500});await profiler.send('Profiler.start');}
  // Real click 65ms -> IMMEDIATE R; first latency starts after the click resolves (press delay excluded).
  await p.mouse.click(glyph.x,glyph.y,{delay:65});
  const firstMode=process.env.MP_QUALITY_FIRST_INPUT_MODE==='key'?'key':'text';
  result.firstInputTransport=firstMode==='key'?'trusted keydown/keyup R':'CDP insertText R';
  const t0=performance.now();if(firstMode==='key')await p.keyboard.press('R');else await p.keyboard.insertText('R');
  const s1=await p.evaluate(l=>new Promise(res=>requestAnimationFrame(()=>{const v=window.mpEngine._view();
   res({len:v.state.doc.length,focus:v.hasFocus&&document.hasFocus(),head:v.state.selection.main.head});})),E0.length+1);
  const firstMs=performance.now()-t0;
  await waitUntil(()=>p.evaluate(()=>window.__firstNative?.committedVisibleOwner||window.__firstNative?.timedOut),'native first-input frame observation',2500);
  result.firstNative=await p.evaluate(()=>window.__firstNative);
  ok('S1 first input frame came from trusted source owner',result.firstNative.trusted&&result.firstNative.inMaster&&result.firstNative.beforeFocus&&!result.firstNative.composing&&result.firstNative.committedVisibleOwner);
  if(profiler){const profile=await profiler.send('Profiler.stop');fs.writeFileSync(path.join(dir,'first-input.cpuprofile'),JSON.stringify(profile.profile));await profiler.detach();result.profiled=true;}
  result.firstComputation=await p.evaluate(()=>window.mpEngine.__regions().computation);
  ok('S1 immediate R: owner+focus+len',s1.focus&&s1.len===E0.length+1&&s1.head===T.expectedCaret+1,{firstInputMs:Math.round(firstMs),head:s1.head});
  ok('S1 exact full source at manifest caret',await textIs(E1));
  result.frames=[await frame(p,dir,'01-first-R')];
  await p.keyboard.press('Control+z');await sleep(150);
  ok('S2 undo baseline',await textIs(E0));
  // 35 continuous native R at the same caret; clock covers insertText..next rAF (len/focus/head reads only).
  await p.evaluate(()=>{window.__gaps=[];let last=performance.now();const tick=n=>{window.__gaps.push(n-last);last=n;window.__raf=requestAnimationFrame(tick);};window.__raf=requestAnimationFrame(tick);});
  const warm=[],steady=[];
  for(let i=0;i<35;i++){const t=performance.now();await p.keyboard.insertText('R');
   const s=await p.evaluate(l=>new Promise(res=>requestAnimationFrame(()=>{const v=window.mpEngine._view();
    res({len:v.state.doc.length,focus:v.hasFocus&&document.hasFocus(),head:v.state.selection.main.head});})),E0.length+i+1);
   const el=performance.now()-t;
   assert(s.focus&&s.len===E0.length+i+1&&s.head===T.expectedCaret+i+1,'sample '+i+' landing (len/focus/head)');
   (i<5?warm:steady).push(el);}
  await p.evaluate(()=>cancelAnimationFrame(window.__raf));
  ok('S3 entire source after 35 samples',await textIs(E35));
  const st=[...steady].sort((a,b)=>a-b);
  result.perf={algorithm:'performance.cjs input-to-next-rAF',warmup:5,steady:30,firstInputMs:Math.round(firstMs),warmFirstMs:Math.round(warm[0]),
   p50Ms:Math.round(st[14]),p95Ms:Math.round(st[28]),maxMs:Math.round(st[29]),budgetP95Ms:50,firstWithinBudget:firstMs<=50,p95WithinBudget:st[28]<=50};
  assert(result.perf.firstWithinBudget&&result.perf.p95WithinBudget,'first and steady p95 exceed 50ms budget');
  for(let k=0;k<40&&!await textIs(E0);k++)await p.keyboard.press('Control+z');
  ok('S4 native-undo-only whole original',await textIs(E0));
  result.frames.push(await frame(p,dir,'02-restored',{allowMissingCaret:true}));
  const savedClean=()=>p.evaluate(()=>{const t=window.__mpDbg?.saveTrace||[];return t.at(-1)?.step==='doSave:saved'&&typeof dirty==='boolean'&&!dirty;});
  await p.keyboard.press('Control+s');await waitUntil(savedClean,'saved baseline',15000);
  const disk=norm(fs.readFileSync(file));
  ok('S4 disk normalized source hash',sha(disk)===sha(E0),{diskLen:disk.length});
  // Lifetime: 20x wheel TOP-exit / bounded down-reentry via regionID + viewport intersection. Status only.
  const life=()=>p.evaluate(()=>({lifecycle:window.mpEngine.__regions?.().lifecycle,computation:window.mpEngine.__regions?.().computation}));
  const before=await life();let okCycles=0;const cycles=[];
  for(let k=0;k<20;k++){await p.mouse.wheel(0,-1000000);await waitUntil(async()=>!await mountVisible(tid),'actual target viewport exit');
   const exited=await life();
   for(let w=0;w<30&&!await mountVisible(tid);w++){await p.mouse.wheel(0,450);await sleep(75);}
   await waitUntil(()=>mountVisible(tid),'actual target viewport reentry');okCycles++;
   cycles.push({index:k,exited,reentered:await life()});}
  const after=await life();
  result.lifetime={claim:'actual exit/reentry and cache/mount counts; no heap-bound claim',cycles:20,reentryVisibleCycles:okCycles,
   before:{mounts:before?.lifecycle?.mounts,decodedImages:before?.lifecycle?.decodedImages},after:{mounts:after?.lifecycle?.mounts,decodedImages:after?.lifecycle?.decodedImages},samples:cycles};
  ok('S5 every target exit and reentry reached its actual mount',okCycles===20);
  result.completed=true;
 }catch(e){result.error=e.message;result.errorKind=e&&e.constructor&&e.constructor.name;if(p)try{result.failure=await p.evaluate(()=>{const v=window.mpEngine._view();return{focus:v.hasFocus&&document.hasFocus(),selection:{anchor:v.state.selection.main.anchor,head:v.state.selection.main.head},scrollTop:v.scrollDOM.scrollTop,viewport:v.viewport,mounted:[...v.dom.querySelectorAll('[data-mp-region]')].map(e=>({id:e.dataset.mpRegion,className:e.className,rect:(r=>({top:r.top,bottom:r.bottom,width:r.width}))(e.getBoundingClientRect())}))};});}catch(x){result.captureError=x.message;}}
 finally{
  if(run)try{result.cleanup=await run.cleanup();}catch(e){result.cleanupError=e.message;}
  result.corpus.originalUnchanged=sha256(mine.corpus)===rawSha;
  if(release)release();result.finishedAt=new Date().toISOString();
  result.completed=!!result.completed&&!result.error&&!result.errors.length&&!result.cleanupError&&!!result.cleanup&&!result.cleanup.residual.length&&result.corpus.originalUnchanged;
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({completed:result.completed,stages:result.stages.map(s=>({name:s.name,ok:s.ok})),perf:result.perf,lifetime:result.lifetime&&{cycles:result.lifetime.cycles,reentryVisibleCycles:result.lifetime.reentryVisibleCycles,before:result.lifetime.before,after:result.lifetime.after},corpusUnchanged:result.corpus.originalUnchanged,error:result.error,out:dir}));
 }
 if(!result.completed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
