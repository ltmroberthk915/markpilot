'use strict';
/* PRIVATE corpus last-image workflow probe (generic; ROOT executes).
 * CLI: --corpus <owned copy> --target <manifest.json> --exe <exe> [--expected-sha256 <exe sha>] --out <dir>
 * Manifest: {corpusSha256, imageCount, target:{from,to,editFrom,form}} — numeric ranges only.
 * Oracles are manifest-driven (editFrom + literal R/1 splices); beforeinput selection is NEVER an oracle.
 * No source bodies/alt/URI in result/stdout/errors: booleans, hashes, lengths, ranges only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,frame,waitUntil}=require('./harness.cjs');
const clipboard=require('./clipboard.cjs');
const sha=s=>crypto.createHash('sha256').update(s,'utf16le').digest('hex');
const norm=b=>{let t=b.toString('utf8');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);return t.replace(/\r\n?/g,'\n');};
const relRefs=t=>{const out=[],re=/(!\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?\)|<img\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)["']?/gi;for(let m;(m=re.exec(t));){const u=m[2]||m[4];if(u&&!/^(data:|https?:|file:|\/|[A-Za-z]:)[\\\/]?/.test(u))out.push(u.split(/[?#]/)[0]);}return [...new Set(out)];};
const splice=(s,at,ins)=>s.slice(0,at)+ins+s.slice(at);
async function main(){
 const mine={corpus:null,target:null};const rest=[];
 for(let i=2;i<process.argv.length;i++){const k=process.argv[i];
  if(k==='--corpus'||k==='--target')mine[k.slice(2)]=process.argv[++i];
  else rest.push(k,process.argv[++i]);}
 assert(mine.corpus&&mine.target,'--corpus and --target required');const o=args(rest);
 assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']||''),'explicit executable identity required');
 const dir=outputDir(o.out,'corpus-last-image');let release;
 const bytes=fs.readFileSync(mine.corpus),rawSha=sha256(mine.corpus);
 const manifest=JSON.parse(fs.readFileSync(mine.target,'utf8'));
 assert(rawSha===manifest.corpusSha256,'corpus sha256 mismatch vs manifest');
 const E0=norm(bytes),T=manifest.target;
 for(const k of ['from','to','editFrom'])assert(Number.isInteger(T[k])&&T[k]>=0&&T[k]<=E0.length,'manifest '+k+' within normalized doc');
 assert((T.to-T.from)>=4&&T.editFrom>=T.from&&T.editFrom<T.to,'manifest range sanity');
 const E1=splice(E0,T.editFrom,'R'),E2=splice(E1,T.editFrom+1,'1');
 const rawText=bytes.toString('utf8'),bom=rawText.charCodeAt(0)===0xFEFF?'\uFEFF':'',eol=rawText.includes('\r\n')?'\r\n':rawText.includes('\r')?'\r':'\n';
 const diskBytes=text=>Buffer.from(bom+text.replace(/\n/g,eol),'utf8');
 const wantForm=E0.slice(T.from,T.from+1)==='<'?'html':'markdown';assert(wantForm===T.form,'manifest form mismatch (boolean)');
 const fixtureDir=path.join(dir,'fixture');fs.mkdirSync(fixtureDir,{recursive:true});
 const file=path.join(fixtureDir,'owned-copy.md');fs.writeFileSync(file,bytes);
 const corpusDir=fs.realpathSync(path.dirname(mine.corpus));
 const copied=[];for(const rel of relRefs(E0)){const src=path.resolve(corpusDir,decodeURIComponent(rel));
  assert(src.startsWith(corpusDir+path.sep),'asset source escapes owned corpus directory');
  if(!fs.existsSync(src))continue;const dst=path.resolve(fixtureDir,rel);
  assert(fs.realpathSync(src).startsWith(corpusDir+path.sep),'linked asset source escapes owned corpus directory');
  assert(dst.startsWith(fixtureDir+path.sep),'asset escapes fixture dir (ref rejected)');
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  fs.copyFileSync(src,dst);assert(sha256(src)===sha256(dst),'asset copy sha guard');copied.push({bytes:fs.statSync(dst).size});}
 const result={schema:1,kind:'private-corpus-last-image',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),manifestSha256:sha256(mine.target),sourceHashUnits:'normalized UTF16LE; raw files use byte SHA256',
  corpus:{rawSha256:rawSha,normSha256:sha(E0),normUTF16:E0.length,imageCount:manifest.imageCount,target:{...T},assetsCopied:copied.length,assetBytes:copied.reduce((a,c)=>a+c.bytes,0)},
  expected:{e0:sha(E0),e1:sha(E1),e2:sha(E2)},ledgerFilter:{data:['R','1']},states:[],perf:null,lifecycle:null,clipboard:{touched:false},errors:[]};
 let run,p,clip;const stage=(name,okc,extra)=>{const s={name,ok:!!okc,...(extra||{})};result.states.push(s);assert(okc,name);return s;};
 const read=async()=>{const s=await p.evaluate(()=>{const v=window.mpEngine._view(),sel=v.state.selection.main;
   return{text:v.state.doc.toString(),len:v.state.doc.length,focus:document.hasFocus()&&v.hasFocus,sel:{anchor:sel.anchor,head:sel.head},caret:v.coordsAtPos(sel.head),
    regions:window.mpEngine.__regions?.(),images:[...v.contentDOM.querySelectorAll('.mp-img')].map(e=>({region:e.dataset.mpRegion||null,retained:e.classList.contains('mp-img-retained'),failed:e.classList.contains('is-failed'),decoded:!!e.querySelector('img')?.complete&&e.querySelector('img')?.naturalWidth>0,pos:v.posAtDOM(e,0),rect:(r=>({x:r.x,y:r.y,w:r.width,h:r.height}))(e.getBoundingClientRect())}))};});
  const text=s.text;delete s.text;return{text,state:{...s,textSha256:sha(text),textLen:text.length,images:s.images.map(i=>({...i,rect:{x:Math.round(i.rect.x),y:Math.round(i.rect.y),w:Math.round(i.rect.w),h:Math.round(i.rect.h)}}))}};};
 const srcEq=(got,want,label)=>stage(label,got===want,{gotSha256:sha(got),wantSha256:sha(want),gotLen:got.length});
 const armCopy=async()=>{const marker='MP_PRIVATE_COPY_'+crypto.randomUUID(),written=await p.evaluate(marker=>window.mpHost.writeClipboard({text:marker}),marker);stage('clipboard sentinel independently armed',!!written.ok&&clipboard.verifyText(marker).matches);};
 try{
  release=acquireSlot();
  run=await launch(o,file,dir);p=run.page;result.metadata=run.metadata;p.on('pageerror',e=>result.errors.push(e.message));
  clip=await clipboard.hold();result.clipboard={touched:true,...clip.metadata};
  await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'fresh document owner');
  await p.evaluate(()=>{window.__ledger=[];for(const t of ['beforeinput','keydown','mousedown','mousemove','mouseup'])document.addEventListener(t,e=>{if(t==='mousemove'&&!e.buttons)return;const v=window.mpEngine._view();
   window.__ledger.push({t,key:e.key,data:['R','1'].includes(e.data)?e.data:undefined,trusted:e.isTrusted,buttons:e.buttons,shift:e.shiftKey,inMaster:v.contentDOM.contains(e.target),focus:v.hasFocus&&document.hasFocus(),at:performance.now()});},{capture:true,passive:true});});
  const loaded=await read();srcEq(loaded.text,E0,'S0 loaded normalized owned copy');
  const imgs=(loaded.state.regions?.regions||[]).filter(r=>r.kind==='image');
  stage('S0 manifest cross-check',imgs.length===manifest.imageCount&&imgs.at(-1).from===T.from&&imgs.at(-1).to===T.to,{recognizedImages:imgs.length,lastFrom:imgs.at(-1)?.from,lastTo:imgs.at(-1)?.to});
  const targetVisible=()=>p.evaluate(f=>{const r=window.mpEngine.__regions().regions.find(r=>r.kind==='image'&&r.from===f);return!!r&&[...document.querySelectorAll('.cm-content .mp-img')].some(w=>{const i=w.querySelector('img'),box=i?.getBoundingClientRect();return w.dataset.mpRegion===r.id&&i?.complete&&i.naturalWidth>0&&box.bottom>70&&box.top<innerHeight-40;});},T.from);
  await p.keyboard.press('Control+End');await sleep(220);
  for(let k=0;k<16&&!await targetVisible();k++){await p.keyboard.press('PageUp');await sleep(100);}
  await waitUntil(targetVisible,'last image rendered',9000);
  const rect=(await read()).state.images.find(i=>i.pos===T.from);assert(rect,'target image mounted');
  result.frames=[await frame(p,dir,'00-last-image-rendered',{caret:'dom',allowMissingCaret:true})];
  // Real click -> IMMEDIATE R: no read/wait/focus/selection repair in between.
  const activationStarted=performance.now();
  await p.mouse.click(rect.rect.x+rect.rect.w/2,rect.rect.y+Math.min(rect.rect.h/2,80),{delay:65});
  const activationMs=performance.now()-activationStarted,firstStarted=performance.now();
  await p.keyboard.insertText('R');await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  const firstActualInputMs=performance.now()-firstStarted;result.firstInteraction={activationMs:Math.round(activationMs),pressDelayMs:65,inputToFrameMs:Math.round(firstActualInputMs)};await sleep(200);
  const s1=await read();srcEq(s1.text,E1,'S1 click+immediate R exact source');
  const rr=s1.state.regions,act=rr?.session&&rr.regions.filter(r=>r.kind==='image').at(-1);
  stage('S1 source-above retained preview',!!(s1.state.focus&&rr?.session?.imageId&&act&&act.from===T.from&&act.to===T.to+1&&s1.state.images.some(i=>i.retained&&(i.decoded||i.failed))),{focus:s1.state.focus,session:!!rr?.session?.imageId,activeFrom:act?.from,activeTo:act?.to,retainedVisible:s1.state.images.some(i=>i.retained)});
  const inR=s1.state&&await p.evaluate(d=>window.__ledger.findLast(e=>e.t==='beforeinput'&&e.data===d),'R');
  stage('S1 R reached native document owner',!!(inR&&inR.inMaster&&inR.trusted&&inR.focus));
  const retained=s1.state.images.find(i=>i.region===act?.id&&i.retained);
  stage('S1 visible source above same retained image',!!(retained&&retained.rect.w>0&&s1.state.caret&&s1.state.caret.bottom>s1.state.caret.top&&s1.state.caret.bottom<=retained.rect.y+2));
  const fr1=await frame(p,dir,'01-click-R');result.frames.push(fr1);
  await p.keyboard.press('Control+z');await sleep(180);
  srcEq((await read()).text,E0,'S2 undo restores exact original');
  await p.keyboard.press('Control+y');await p.keyboard.insertText('1');await sleep(200);
  const s3=await read();srcEq(s3.text,E2,'S3 redo+immediate 1 contiguous at editFrom+1');
  result.frames.push(await frame(p,dir,'02-redo-immediate-one'));
  const in1=await p.evaluate(d=>window.__ledger.findLast(e=>e.t==='beforeinput'&&e.data===d),'1');
  stage('S3 1 reached native owner',!!(in1&&in1.inMaster&&in1.trusted));
  // Reverse Shift + native C/X/V + pressed drag, clipboard guarded independently.
  await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');}finally{await p.keyboard.up('Shift');}
  result.frames.push(await frame(p,dir,'03-reverse-selected'));
  await armCopy();
  await p.keyboard.press('Control+c');stage('S4 reverse copy payload',clipboard.verifyText('R1').matches);
  await p.keyboard.press('ArrowRight');
  const pts=await p.evaluate(f=>{const v=window.mpEngine._view();const a=v.coordsAtPos(f),b=v.coordsAtPos(f+2);return{a:{x:a.left+.2,y:(a.top+a.bottom)/2},b:{x:b.left+.2,y:(b.top+b.bottom)/2}};},T.editFrom);
  await p.mouse.move(pts.a.x,pts.a.y);await p.mouse.down();for(let n=1;n<=8;n++){const k=n/8;await p.mouse.move(pts.a.x+(pts.b.x-pts.a.x)*k,pts.a.y+(pts.b.y-pts.a.y)*k);await sleep(18);}await p.mouse.up();
  const sd=await read();stage('S4 real drag selected R1',Math.min(sd.state.sel.anchor,sd.state.sel.head)===T.editFrom&&Math.max(sd.state.sel.anchor,sd.state.sel.head)===T.editFrom+2);
  result.frames.push(await frame(p,dir,'04-drag-selected'));
  await armCopy();
  await p.keyboard.press('Control+c');stage('S4 drag copy payload',clipboard.verifyText('R1').matches);
  await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowRight');}finally{await p.keyboard.up('Shift');}
  await armCopy();
  await p.keyboard.press('Control+x');const afterCut=await read();const cutDoc=E2.slice(0,T.editFrom)+E2.slice(T.editFrom+2);
  stage('S4 cut payload',clipboard.verifyText('R1').matches&&afterCut.text===cutDoc,{cutLen:afterCut.text.length});
  stage('S4 paste payload before native input',clipboard.verifyText('R1').matches);await p.keyboard.press('Control+v');stage('S4 paste payload after native input',clipboard.verifyText('R1').matches);await sleep(160);srcEq((await read()).text,E2,'S4 paste restores source');
  await p.keyboard.press('Control+z');await p.keyboard.press('Control+z');srcEq((await read()).text,E2,'S4 history settles at E2');
  // DISK oracle at E2 then back to E0 (native keys only).
  const savedClean=()=>p.evaluate(()=>!dirty&&!saveInFlight);
  await p.keyboard.press('Control+s');await waitUntil(async()=>await savedClean()&&fs.readFileSync(file).equals(diskBytes(E2)),'saved E2 exact bytes',15000);
  let disk=norm(fs.readFileSync(file));stage('S5 disk E2',sha(disk)===sha(E2),{diskLen:disk.length});
  for(let k=0;k<8&&(await read()).text!==E0;k++)await p.keyboard.press('Control+z');
  srcEq((await read()).text,E0,'S5 native undo to baseline E0');
  await p.keyboard.press('Control+s');await waitUntil(async()=>await savedClean()&&fs.readFileSync(file).equals(diskBytes(E0)),'saved E0 exact bytes',15000);
  disk=norm(fs.readFileSync(file));stage('S5 disk E0',sha(disk)===sha(E0));
  // Continuous input-to-frame at the activated region (performance.cjs algorithm).
  const perf=await p.evaluate(()=>{window.__gaps=[];let last=performance.now();const tick=n=>{window.__gaps.push(n-last);last=n;window.__raf=requestAnimationFrame(tick);};window.__raf=requestAnimationFrame(tick);return true;});
  const samples=[],warm=[];const baseLen=E0.length;
  for(let i=0;i<30;i++){const t0=performance.now();await p.keyboard.insertText('R');
   const s=await p.evaluate(()=>new Promise(res=>requestAnimationFrame(()=>{const v=window.mpEngine._view();res({len:v.state.doc.length,focus:v.hasFocus&&document.hasFocus()});})));
   const el=performance.now()-t0;assert(s.len===baseLen+i+1&&s.focus,'sample '+i+' landed in owner');
   (i<5?warm:samples).push(el);
  }
  await p.evaluate(()=>cancelAnimationFrame(window.__raf));
  const st=[...samples].sort((a,b)=>a-b);
  result.perf={algorithm:'continuous performance.cjs input-to-frame',warmup:5,samples:25,firstInputMs:Math.round(firstActualInputMs),firstWarmInputMs:Math.round(warm[0]),p50Ms:Math.round(st[12]),p95Ms:Math.round(st[23]),maxMs:Math.round(st[24]),budgetP95Ms:50,p95WithinBudget:st[23]<=50};
  assert(result.perf.p95WithinBudget,'steady p95 exceeds 50ms budget');
  assert(firstActualInputMs<=50,'first actual input exceeds 50ms budget');
  srcEq((await read()).text,splice(E0,T.editFrom,'R'.repeat(30)),'S6 all continuous inputs use exact source owner');
  for(let k=0;k<35&&(await read()).text!==E0;k++)await p.keyboard.press('Control+z');
  srcEq((await read()).text,E0,'S6 perf restored baseline E0 via native undo only');
  assert(perf,'frame watch armed');
  const ledger=await p.evaluate(()=>window.__ledger);result.ledger=ledger;
  stage('S6 five native input channels',ledger.every(e=>e.trusted)&&ledger.some(e=>e.t==='beforeinput')&&ledger.some(e=>e.t==='mousedown')&&ledger.some(e=>e.t==='keydown'&&e.shift)&&ledger.filter(e=>e.t==='mousemove'&&(e.buttons&1)).length>=8);
  // Lifetime: 20 native wheel exit/reentry cycles; status only.
  const life=async()=>p.evaluate(()=>window.mpEngine.__regions?.().lifecycle);
  const before=await life();let okCycles=0;const cycles=[];
  for(let k=0;k<20;k++){
   await p.mouse.wheel(0,-1000000);await waitUntil(async()=>!(await targetVisible()),'actual last-image viewport exit');
   const exited=await life();await p.mouse.wheel(0,1000000);await sleep(90);
   for(let n=0;n<32&&!(await targetVisible());n++){await p.mouse.wheel(0,-400);await sleep(55);}
   await waitUntil(targetVisible,'actual last-image viewport reentry');okCycles++;
   const reentered=await life();cycles.push({index:k,exited,reentered});
  }
  const after=await life();
  result.lifecycle={claim:'actual exit/reentry and cache/mount counts; no process-memory bound claim',cycles:20,okCycles,before:{mounts:before?.mounts,decodedImages:before?.decodedImages},after:{mounts:after?.mounts,decodedImages:after?.decodedImages},samples:cycles};
  stage('S7 every last-image exit/reentry reached its actual mount',okCycles===20);
  result.completed=true;
 }catch(e){result.error=e.message;result.errorKind=e&&e.constructor&&e.constructor.name;if(p)try{const failure=await read();result.failureState=failure.state;result.frames||=[];result.frames.push(await frame(p,dir,'failure',failure.state.focus?{}:{caret:'dom',allowMissingCaret:true}));}catch(x){result.captureError=x.message;}}
 finally{
  if(clip)try{result.clipboard={...result.clipboard,...(await clip.restore())};}catch(e){result.clipboard={restoreError:e.message};}
  if(run)try{result.cleanup=await run.cleanup();}catch(e){result.cleanupError=e.message;}
  const after=sha256(mine.corpus);result.corpus.originalUnchanged=after===rawSha;
  if(release)release();result.finishedAt=new Date().toISOString();
  result.completed=!!result.completed&&!result.error&&!result.errors.length&&result.clipboard.restored===true&&!result.cleanupError&&!!result.cleanup&&!result.cleanup.residual.length&&result.corpus.originalUnchanged;
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({completed:result.completed,stages:result.states.map(s=>({name:s.name,ok:s.ok})),perf:result.perf,lifecycle:result.lifecycle,corpusUnchanged:result.corpus.originalUnchanged,error:result.error,out:dir}));
 }
 if(!result.completed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
