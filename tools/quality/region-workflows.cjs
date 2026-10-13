'use strict';
// Native source/presentation contracts, with independent literal source oracles.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,frame,recorder,waitUntil}=require('./harness.cjs');
const clipboard=require('./clipboard.cjs');
const SVG='<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><rect width="480" height="180" fill="#d7eaf5"/><rect x="20" y="20" width="440" height="140" fill="#146b9b"/><text x="65" y="103" font-size="30" fill="white">REGION PREVIEW</text></svg>';
async function main(){
 const o=args(process.argv.slice(2));assert(/^[a-f0-9]{64}$/i.test(o['expected-sha256']||''),'explicit executable identity');
 const dir=outputDir(o.out,'region-workflows'),release=acquireSlot(ROOT);
 const result={schema:1,suite:'region-workflows',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),seed:0x3215,cases:[],frames:[],errors:[],clipboard:{touched:false},transport:'trusted Chromium input; physical OS IME is a separate gate'};
 const record=recorder(dir,result);let run,p,clip;
 const filter=process.env.MP_QUALITY_CASES,wanted=id=>!filter||new RegExp(filter).test(id);
 const longUri='data:image/svg+xml;base64,'+Buffer.from(SVG.replace('</svg>','<!--'+'X'.repeat(8192)+'--></svg>')).toString('base64');
 const prefix=Array.from({length:28},(_,i)=>`Paragraph ${i} before the image.\n\n`).join('');
 const fixtures=[
  {id:'image-standalone',text:'# Image session\n\nBEFORE\n\n![Preview](region.svg)\n\nAFTER\n'},
  {id:'image-inline',text:'# Image session\n\nALPHA ![Preview](region.svg) OMEGA\n\nAFTER\n'},
  {id:'image-quote-scrolled',text:prefix+'> BEFORE\n>\n> ![Preview](region.svg)\n>\n> AFTER\n',scrolled:true},
  {id:'image-html',text:'# HTML session\n\n<img src="region.svg" alt="Preview" width="480">\n\nAFTER\n'},
  {id:'image-long-payload',text:'# Folded source\n\n![Preview]('+longUri+')\n\nAFTER\n',long:true},
  {id:'image-bad-source',text:'# Failed source\n\n![Preview](missing.png)\n\nAFTER\n',bad:true},
 ];
 fs.writeFileSync(path.join(dir,'region.svg'),SVG);
 const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Region owner\n');
 async function read(){return p.evaluate(()=>{
  const v=window.mpEngine._view(),s=v.state.selection.main,caret=v.coordsAtPos(s.head),protocol=window.mpEngine.__regions?.();
  const rect=e=>e.getBoundingClientRect().toJSON();
  return{text:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},focus:document.hasFocus()&&v.hasFocus,cellFocus:document.hasFocus()&&document.activeElement===document.querySelector('.mp-cell-overlay-text'),caret,
   scrollTop:v.scrollDOM.scrollTop,maxScroll:v.scrollDOM.scrollHeight-v.scrollDOM.clientHeight,protocol,
   host:{filePath:typeof filePath==='string'?filePath:null,dirty:typeof dirty==='boolean'?dirty:null,revision:typeof revision==='number'?revision:null,saveInFlight:typeof saveInFlight==='boolean'?saveInFlight:null,saveBlocked:typeof saveBlocked==='boolean'?saveBlocked:null,lastSaveError:typeof lastSaveError==='string'?lastSaveError:null,saveTrace:window.__mpDbg?.saveTrace,banner:document.querySelector('#mp-banner')?.textContent},
   images:[...v.contentDOM.querySelectorAll('.mp-img')].map(e=>({region:e.dataset.mpRegion,retained:e.classList.contains('mp-img-retained'),rect:rect(e),imageRect:rect(e.querySelector('img:not(.mp-img-pending)')||e),decoded:!!e.querySelector('img')?.naturalWidth,failed:e.classList.contains('is-failed')})),
   floats:[...v.contentDOM.querySelectorAll('.mp-inline-float')].map(e=>({rect:rect(e),font:parseFloat(getComputedStyle(e.querySelector('.katex')||e).fontSize),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),
   blocks:[...v.contentDOM.querySelectorAll('.mp-cm6-math-block')].map(e=>({rect:rect(e),quote:Number(e.dataset.mpQuoteDepth||0),border:getComputedStyle(e).borderLeftWidth,font:parseFloat(getComputedStyle(e.querySelector('.katex')||e).fontSize)})),
   rendered:[...v.contentDOM.querySelectorAll('.mp-cm6-math .katex')].map(e=>({rect:rect(e),font:parseFloat(getComputedStyle(e).fontSize)})),
   lines:[...v.contentDOM.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,rect:rect(e),class:e.className})),events:window.__regionEvents||[]};
 });}
 const capture=async(trace,id,stage,allowMissingCaret=false)=>{
  const state=await read(),shot=await frame(p,dir,id+'-'+stage,{allowMissingCaret,...(state.cellFocus?{caret:'dom'}:{})});result.frames.push(shot);
  trace.push({stage,state,screenshot:shot});return state;
 };
 async function open(id,text){
  const file=path.join(dir,id+'.md');fs.writeFileSync(file,text);
  const r=await p.evaluate(file=>window.mpHost.openPath(file),file);assert(r.ok,'owned fixture opened');
  await waitUntil(()=>p.evaluate(text=>window.mpEngine.getValue()===text&&document.hasFocus()&&window.mpEngine._view().hasFocus,text),'initial source and owner');
  await p.evaluate(()=>{window.__regionEvents=[];});return file;
 }
 const exact=(s,text,anchor,head=anchor)=>{assert.equal(s.text,text,'complete source oracle');assert.deepEqual(s.selection,{anchor,head},'directed literal source selection');assert(s.focus,'existing native document owner');assert(s.caret&&s.caret.bottom>s.caret.top&&s.caret.bottom-s.caret.top<45,'visible text caret');};
 try{
  run=await launch(o,owner,dir);p=run.page;result.artifact=run.metadata;
  p.on('pageerror',e=>result.errors.push(e.message));clip=await clipboard.hold();result.clipboard={touched:true,...clip.metadata};
  await p.evaluate(()=>{window.__regionEvents=[];for(const type of ['mousedown','mousemove','mouseup','keydown','keyup','input','beforeinput','wheel'])document.addEventListener(type,e=>{if(type==='mousemove'&&!e.buttons)return;const v=window.mpEngine._view(),s=v.state.selection.main;window.__regionEvents.push({type,trusted:e.isTrusted,key:e.key,data:e.data,ctrl:e.ctrlKey,shift:e.shiftKey,buttons:e.buttons,detail:e.detail,inMaster:v.contentDOM.contains(e.target),image:!!e.target.closest?.('.mp-img'),selection:{anchor:s.anchor,head:s.head},at:performance.now()});},{capture:true,passive:true});});
  for(const f of fixtures){if(!wanted(f.id))continue;await record(f.id,async trace=>{
   const file=await open(f.id,f.text),alt=f.text.indexOf('Preview'),literal=f.text.slice(f.text.indexOf(f.id==='image-html'?'<img':'!['),f.id==='image-html'?f.text.indexOf('>\n')+1:f.text.indexOf(')\n')+1);
   result.cases.at(-1).productReached=false;
   if(f.scrolled)await p.keyboard.press('Control+End');
   const target=p.locator(f.bad?'.cm-content .mp-img':'.cm-content .mp-img img').first();await target.scrollIntoViewIfNeeded();
   await waitUntil(()=>p.evaluate(bad=>{const e=document.querySelector('.cm-content .mp-img');return bad?e?.classList.contains('is-failed'):!!e?.querySelector('img')?.naturalWidth;},!!f.bad),'decoded preview or explicit failure');
   const before=await capture(trace,f.id,'01-before',true);assert.equal(before.text,f.text);if(f.scrolled)assert(before.scrollTop>0,'scroll action really reached the image');
   const region=before.protocol.regions.find(r=>r.kind==='image');assert.equal(region.editFrom,alt,'exact recognizer attribute landing');
   await target.click({delay:65});await p.keyboard.press('R'); // No focus/selection repair or waiting after activation.
   result.cases.at(-1).productReached=true;
   const edited=await capture(trace,f.id,'02-immediate-R'),rText=f.text.slice(0,alt)+'R'+f.text.slice(alt);exact(edited,rText,alt+1);
   assert.equal(edited.protocol.session.imageId,region.id,'ordinary source edit keeps active region');assert(edited.images.some(i=>i.retained),'source and preview coexist');
   assert(edited.events.some(e=>e.type==='mousedown'&&e.trusted&&e.image)&&edited.events.some(e=>e.type==='keydown'&&e.key==='R'&&e.inMaster),'real gesture and immediate input');
   if(!f.bad)assert(edited.images[0].decoded,'decoded preview remains present');
   const postInputImageShift=edited.images[0].imageRect.top-before.images[0].imageRect.top;
   if(f.long)assert(await p.locator('.mp-image-payload').count(),'long payload stays bounded while editing attributes');
   await p.keyboard.press('Control+z');const undone=await capture(trace,f.id,'03-undo');exact(undone,f.text,alt);
   await p.keyboard.press('Control+y');await p.keyboard.press('1'); // Continuous input immediately after native Redo.
   const finalText=f.text.slice(0,alt)+'R1'+f.text.slice(alt),continued=await capture(trace,f.id,'04-redo-one');exact(continued,finalText,alt+2);
   await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');}finally{await p.keyboard.up('Shift');}
   const selected=await capture(trace,f.id,'05-reverse-selected');exact(selected,finalText,alt+2,alt);
   await p.keyboard.press('Control+c');assert(clipboard.verifyText('R1').matches,'raw source clipboard for reverse native selection');
   await p.keyboard.press('Control+x');const cut=await capture(trace,f.id,'06-cut');exact(cut,f.text,alt);
   assert(clipboard.verifyText('R1').matches,'cut payload independently read back');await p.keyboard.press('Control+v');assert(clipboard.verifyText('R1').matches,'paste still owned the expected system payload');
   const pasted=await capture(trace,f.id,'07-paste');exact(pasted,finalText,alt+2);
   await p.keyboard.press('Control+z');await p.keyboard.press('Control+z');const restored=await capture(trace,f.id,'08-undo-paste-cut');exact(restored,finalText,alt+2,alt);
   // Mouse+keyboard and real pressed movement remain native in the source line.
   const coords=await p.evaluate(({a,b})=>{const v=window.mpEngine._view();return{a:v.coordsAtPos(a),b:v.coordsAtPos(b)};},{a:alt+5,b:alt+1});
   await p.mouse.move(coords.a.left+.2,(coords.a.top+coords.a.bottom)/2);await p.mouse.down();
   for(let n=1;n<=8;n++){await p.mouse.move(coords.a.left+(coords.b.left-coords.a.left)*n/8,(coords.a.top+coords.a.bottom)/2);await sleep(18);}await p.mouse.up();
   const dragged=await capture(trace,f.id,'09-source-drag');assert(dragged.focus&&dragged.selection.anchor>dragged.selection.head,'native reverse source drag');assert.equal(dragged.text,finalText);
   assert(dragged.events.filter(e=>e.type==='mousemove'&&e.trusted&&(e.buttons&1)).length>=8,'real multi-step pressed drag');
   await p.keyboard.down('Shift');try{await p.keyboard.press('ArrowRight');}finally{await p.keyboard.up('Shift');}const extended=await capture(trace,f.id,'10-drag-key');assert(extended.focus&&extended.text===finalText,'drag then modified keyboard remains in source owner');
   await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')===finalText,'literal UTF-8 disk bytes');
   if(f.long){await p.keyboard.press('Home');await p.keyboard.down('Shift');try{await p.keyboard.press('End');}finally{await p.keyboard.up('Shift');}await p.keyboard.press('Control+c');assert(clipboard.verifyText(finalText.split('\n').find(t=>t.includes('data:image/'))).matches,'folded native source copies the full literal payload');}
   const saved=await capture(trace,f.id,'11-saved');assert.equal(fs.readFileSync(file,'utf8'),finalText);assert(saved.focus);assert.equal(saved.protocol.session.imageId,region.id);
   // Image anchoring is a distinct operation intent. Do not demand the old image
   // intent after newer immediate typing has legitimately switched to the caret.
   await p.keyboard.press('Escape');const closed=await capture(trace,f.id,'12-closed',true);assert.equal(closed.protocol.session.imageId,null);
   await p.locator(f.bad?'.cm-content .mp-img':'.cm-content .mp-img img').first().click({delay:65});
   const anchored=await capture(trace,f.id,'13-click-anchor');assert(anchored.images[0].retained&&anchored.focus);
   const anchorError=anchored.images[0].imageRect.top-closed.images[0].imageRect.top;assert(Math.abs(anchorError)<=2,'activation image anchor within 2 CSS px: '+anchorError);
   assert.notEqual(trace.find(t=>t.stage==='12-closed').screenshot.sha256,trace.find(t=>t.stage==='13-click-anchor').screenshot.sha256,'event-driven frames actually changed');
   return{sourceBytes:true,oneHistory:true,sourceAbovePreview:true,anchorError,postInputImageShift,channels:['keyboard','mouse','modified-keys','mouse-keyboard','pressed-drag'],literalChars:literal.length,fixtureSha256:sha256(file)};
  });}
  for(const kind of ['code','table']){const id='source-owned-'+kind+'-eof';if(!wanted(id))continue;await record(id,async trace=>{
   const text=kind==='code'?'~~~\nx':'a | b\n---|---\nc | d',file=await open(id,text);
   if(kind==='table'){await p.locator('.mp-row td[data-mp-col="1"]').first().click({delay:65});await p.keyboard.press('End');}
   else await p.keyboard.press('Control+End');
   const before=await capture(trace,id,'01-eof-owner'),prior=before.protocol.regions.find(r=>r.kind===kind);assert(prior);assert.equal(before.selection.head,text.length);assert(before.focus||before.cellFocus);
   await p.keyboard.insertText('R');const edited=await capture(trace,id,'02-immediate-R');assert.equal(edited.text,text+'R');assert.equal(edited.selection.head,text.length+1);assert(edited.focus||edited.cellFocus);
   const sameOwner=s=>{const r=s.protocol.regions.find(r=>r.kind===kind);assert.equal(r.id,prior.id,'literal content edit retains the producer-owned region');assert(r.revision>prior.revision,'same owner publishes a new source revision');};sameOwner(edited);
   await p.keyboard.press('Control+z');const undone=await capture(trace,id,'03-undo');assert.equal(undone.text,text);assert.equal(undone.selection.head,text.length);sameOwner(undone);assert(undone.focus||undone.cellFocus);
   await p.keyboard.press('Control+y');await p.keyboard.press('1');const continued=await capture(trace,id,'04-redo-immediate-one');assert.equal(continued.text,text+'R1');assert.equal(continued.selection.head,text.length+2);sameOwner(continued);assert(continued.focus||continued.cellFocus);
   await p.keyboard.press('Control+s');
   try{await waitUntil(()=>fs.readFileSync(file,'utf8')===text+'R1','EOF literal disk bytes');}
   catch(error){const failure=await capture(trace,id,'05-save-failure');trace.push({stage:'disk-failure-bytes',disk:fs.readFileSync(file,'utf8'),commandEvents:failure.events.filter(e=>e.type==='keydown'&&['s','S','Control'].includes(e.key))});throw error;}
   await capture(trace,id,'05-saved');
   return{stableSourceOwner:true,oneHistory:true,immediateInput:true,diskBytes:true,kind};
  });}
  for(const depth of [0,1,2,3]){const id='quote-context-'+depth;if(!wanted(id))continue;await record(id,async trace=>{
   const q=depth?'> '.repeat(depth):'',text='# Context\n\n'+q+'$\\begin{aligned}x&=a+b\\\\&=c+d\\end{aligned}$\n'+q+'Follow $a=b$.\n'+q+'\n'+q+'Continue.\n\nAFTER\n';
   await open(id,text);const block=p.locator('.mp-cm6-math-block').first();await block.scrollIntoViewIfNeeded();
   const normal=await capture(trace,id,'01-normal',true);assert.equal(normal.blocks[0].quote,depth,'semantic container on block projection');if(depth)assert.equal(normal.blocks[0].border,'3px','shared quote bar over block height');
   await block.click({delay:65});const live=await capture(trace,id,'02-live');assert(live.focus&&live.floats.length===1);const ratio=live.floats[0].font/normal.blocks[0].font;assert(Math.abs(ratio-.93)<.002,'preview equals .93 of same contextual normal font: '+ratio);assert.equal(live.text,text);
   return{depth,ratio,sourceUntouched:true};
  });}
  const id='quote-comparison-literal';if(wanted(id))await record(id,async trace=>{
   const text='# Negative\n\n> Before $x>0$ after.\n> Continue.\n\nAFTER\n';await open(id,text);const s=await capture(trace,id,'01-prefix',true);
   assert(s.lines.filter(l=>l.class.includes('mp-quote')).every(l=>l.class.includes('mp-quote-d1')),'comparison is not an extra quote level');return{depth:1};
  });
 }catch(e){result.fatal=e.stack||e.message;}
 finally{
  try{if(clip)result.clipboard={...result.clipboard,...await clip.restore()};}catch(e){result.clipboard.restoreError=e.message;}
  try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupError=e.message;}
  release();result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupError&&!result.clipboard.restoreError&&!result.cleanup?.residual?.length;
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),errors:result.errors,fatal:result.fatal,cleanup:result.cleanup,clipboardRestored:result.clipboard.restored,out:dir}));
 }
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main};
