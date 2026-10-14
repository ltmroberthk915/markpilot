'use strict';
// Owned native source-layout and viewport workflows.
// No product dispatch/focus/selection repair is used after a native entry.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,frame,waitUntil,newWindow}=require('./harness.cjs');
const TAIL='\n\n'+Array.from({length:38},(_,i)=>`Synthetic paragraph ${i}: owner and scroll control.\n\n`).join('');
const TABLE=(a,b)=>`BEFORE\n\n| Synthetic A | Synthetic B |\n| --- | --- |\n| ${a} | ${b} |\n\nAFTER${TAIL}`;
const LONG='WORD 中文🙂\\|tail '+('source words 中文 '.repeat(12));
const TALL='neighbor'+('<br>line'.repeat(10));
const read=p=>p.evaluate(()=>{
 const v=window.mpEngine._view(),s=v.state.selection.main,el=document.querySelector('.mp-cell-overlay-text'),ae=document.activeElement,ds=getSelection();
 const off=(n,o)=>{if(!el?.contains(n))return null;const r=document.createRange();r.selectNodeContents(el);r.setEnd(n,o);return r.toString().length;};
 const td=document.querySelector('.mp-cell-editing'),sz=td?.querySelector('.mp-cell-source-size'),rect=e=>e?.getBoundingClientRect().toJSON()||null;
 const er=rect(el),sr=rect(sz),tr=rect(td),cs=td&&getComputedStyle(td),es=el&&getComputedStyle(el);
 const textRange=e=>{if(!e)return null;const r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().toJSON();};
 const cellFocus=document.hasFocus()&&ae===el,from=td?.hasAttribute('data-mp-from')?Number(td.dataset.mpFrom):null,to=td?.hasAttribute('data-mp-to')?Number(td.dataset.mpTo):null;
 const owner=window.mpEngine.__cellLayout?.()||{owner:td?{rowFrom:Number(td.dataset.mpRow),col:Number(td.dataset.mpCol)}:null,matched:!!td&&v.contentDOM.contains(td)&&from!==null&&to!==null&&[s.anchor,s.head].every(n=>n>=from&&n<=to)&&cellFocus,sizer:!!sz,observer:'live DOM fallback'};
 let domCaret=null;if(cellFocus&&ds?.focusNode&&el.contains(ds.focusNode)){let n=ds.focusNode,o=ds.focusOffset;if(n.nodeType===1){const forward=o<n.childNodes.length;n=n.childNodes[forward?o:o-1];while(n&&n.nodeType!==3)n=forward?n.firstChild:n.lastChild;if(n)o=forward?0:n.textContent.length;}if(n){const r=document.createRange();r.setStart(n,o);r.collapse(true);domCaret=r.getBoundingClientRect().toJSON();}}
 const sc=v.scrollDOM,vr=rect(sc),z=window.mpZoom.get()/100,scrollViewport={left:Math.max(0,vr.left+sc.clientLeft*z),right:Math.min(innerWidth,vr.left+(sc.clientLeft+sc.clientWidth)*z),top:Math.max(0,vr.top+sc.clientTop*z),bottom:Math.min(innerHeight,vr.top+sc.clientTop*z+sc.clientHeight*z)};
 return {text:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},domSelection:{anchor:off(ds?.anchorNode,ds?.anchorOffset),head:off(ds?.focusNode,ds?.focusOffset)},domCaret,scrollViewport,scrollDOMRect:vr,cellFrom:from,cellTo:to,cellText:el?.textContent,cellFocus,focus:document.hasFocus()&&v.hasFocus,active:{tag:ae?.tagName,class:ae?.className},zoom:window.mpZoom.get(),owner,regions:window.mpEngine.__regions(),host:{documentId,filePath,dirty,revision,saveInFlight,saveTimer:!!saveTimer},scroll:{top:sc.scrollTop,left:sc.scrollLeft,width:sc.clientWidth,scrollWidth:sc.scrollWidth},cell:tr,source:sr,overlay:er,textRect:textRange(el),sizerText:sz?.textContent,cellFont:cs&&{family:cs.fontFamily,size:parseFloat(cs.fontSize),line:cs.lineHeight},overlayFont:es&&{family:es.fontFamily,size:parseFloat(es.fontSize),line:es.lineHeight},events:window.__sourceLayoutEvents||[]};
});
async function listen(p,result){
 p.on('pageerror',e=>result.errors.push({url:p.url(),error:e.message}));
 await p.evaluate(()=>{window.__sourceLayoutEvents=[];window.__sourceLayoutPhase='boot';for(const type of ['mousedown','mouseup','mousemove','click','dblclick','keydown','keyup','beforeinput','input','wheel'])document.addEventListener(type,e=>{
  if(type==='mousemove'&&!e.buttons)return;
  const v=window.mpEngine._view(),s=v.state.selection.main;
  window.__sourceLayoutEvents.push({phase:window.__sourceLayoutPhase,type,trusted:e.isTrusted,detail:e.detail,buttons:e.buttons,key:e.key,data:e.data,inputType:e.inputType,ctrl:e.ctrlKey,shift:e.shiftKey,x:e.clientX,y:e.clientY,deltaX:e.deltaX,deltaY:e.deltaY,inCell:!!e.target.closest?.('.mp-cell-overlay-text'),inEditor:v.dom.contains(e.target),selection:{anchor:s.anchor,head:s.head},at:performance.now()});
 },{capture:true,passive:true});});
}
const phase=(p,name)=>p.evaluate(name=>{window.__sourceLayoutPhase=name;},name);
async function keys(p,key,cell=false){const s=await read(p);assert(cell?s.cellFocus:s.focus,'native key input requires editor focus');await p.keyboard.press(key);await sleep(100);}
async function insert(p,text,cell=false){const s=await read(p);assert(cell?s.cellFocus:s.focus,'native insert requires owner focus');await p.keyboard.insertText(text);await sleep(100);}
async function zoom(p,z){await keys(p,'Control+0');for(let n=100;n<z;n+=5)await keys(p,'Control+=');assert.equal((await read(p)).zoom,z);}
async function enter(p,verifyPointer=true){
 const td=p.locator('.mp-row td[data-mp-col="0"]').first();let box=await td.boundingBox();assert(box,'live table cell geometry');
 // A zoomed, tall header can put the target row below the screen. Reach it
 // with actual wheel input before clicking; never click an offscreen point.
 for(let attempt=0;attempt<3;attempt++){
  const v=(await read(p)).scrollViewport,y=box.y+Math.min(box.height*.5,18);
  if(y>=v.top+40&&y<=v.bottom-20)break;
  await phase(p,'cell-entry-reveal');await p.mouse.move(v.left+40,Math.max(v.top+50,v.bottom-60));
  await p.mouse.wheel(0,y-(v.top+120));await sleep(150);box=await td.boundingBox();assert(box,'live cell after wheel');
 }
 const visible=(await read(p)).scrollViewport,clickY=box.y+Math.min(box.height*.5,18);assert(clickY>=visible.top&&clickY<=visible.bottom,'entry click is physically inside the visible viewport');
 await phase(p,'cell-entry');await p.mouse.click(box.x+box.width*.55,box.y+Math.min(box.height*.5,18),{delay:65});
 await waitUntil(async()=>{const s=await read(p);return s.cellFocus&&s.owner?.matched;},'native table entry');
 if(!verifyPointer)return;
 // Read the original trusted pointer against the newly laid-out source. This
 // ruler never changes focus or DOM/master selection and detects default-end
 // entry when the product's native pointer mapping branch is disabled.
 const entry=await p.evaluate(()=>{
  const event=window.__sourceLayoutEvents.findLast(e=>e.phase==='cell-entry'&&e.type==='mousedown'&&e.trusted);
  const edit=document.querySelector('.mp-cell-overlay-text'),td=document.querySelector('.mp-cell-editing'),v=window.mpEngine._view();
  if(!event||!edit||!td)throw new Error('Native entry lacks pointer/source evidence');
  const rect=edit.getBoundingClientRect(),x=Math.max(rect.left+.5,Math.min(event.x,rect.right-.5)),y=Math.max(rect.top+.5,Math.min(event.y,rect.bottom-.5));
  const hit=document.caretRangeFromPoint(x,y);
  if(!hit||!edit.contains(hit.startContainer))throw new Error('Independent entry hit is outside source overlay');
  const prefix=document.createRange();prefix.selectNodeContents(edit);prefix.setEnd(hit.startContainer,hit.startOffset);
  const fragment=prefix.cloneContents(),walker=document.createTreeWalker(fragment,NodeFilter.SHOW_TEXT);let node,expectedDOM=0;
  while(node=walker.nextNode())expectedDOM+=node.textContent.length;
  const from=Number(td.dataset.mpFrom),to=Number(td.dataset.mpTo),raw=v.state.doc.sliceString(from,to);let sourceOffset=0,displayOffset=0;
  while(displayOffset<expectedDOM){sourceOffset+=raw[sourceOffset]==='\\'&&raw[sourceOffset+1]==='|'?2:1;displayOffset++;}
  return {event,clamped:{x,y},rect:rect.toJSON(),expectedDOM,expectedSource:from+sourceOffset,raw};
 });
 const actual=await read(p);actual.entryRuler=entry;
 await p.evaluate(entry=>{window.__sourceLayoutEntryRuler=entry;window.__sourceLayoutEvents.push({phase:'cell-entry-ruler',...entry});},entry);
 assert.deepEqual(actual.domSelection,{anchor:entry.expectedDOM,head:entry.expectedDOM},'initial native click matches independent live DOM hit');
 assert.deepEqual(actual.selection,{anchor:entry.expectedSource,head:entry.expectedSource},'initial native click matches independent raw source codec');
}
function geometry(s,floor){
 assert(s.cellFocus&&s.owner?.matched&&s.owner?.sizer,'cell overlay and sizer own current view');
 assert.equal(s.sizerText,s.cellText,'active eq/payload reuse must refresh source sizer');
 assert(s.cell.height>=floor-.05,'activation preserves entry row floor');
 for(const r of [s.overlay,s.textRect]){assert(r,'complete source geometry');assert(r.left>=s.cell.left-1&&r.right<=s.cell.right+1&&r.top>=s.cell.top-1&&r.bottom<=s.cell.bottom+1,'complete source text stays inside active cell');}
 assert.equal(s.overlayFont.family,s.cellFont.family);assert(Math.abs(s.overlayFont.size-s.cellFont.size*s.zoom/100)<.05,'body overlay has same visual font scale');
 for(const k of ['left','right','top','bottom'])assert(Math.abs(s.overlay[k]-s.source[k])<1,'overlay follows full source sizer rectangle '+k);
}
// DOM Range is a read-only ruler. Native clicks determine actual selection.
async function point(p,offset){return p.evaluate(offset=>{
 const el=document.querySelector('.mp-cell-overlay-text');if(!el)throw new Error('No active source');
 const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n,remaining=offset,last;
 while(n=w.nextNode()){last=n;if(remaining<=n.length)break;remaining-=n.length;}
 n=n||last;if(!n)throw new Error('Empty source has no text endpoint');
 const r=document.createRange();r.setStart(n,Math.min(remaining,n.length));r.collapse(true);const b=r.getBoundingClientRect();
 return{x:b.left,y:b.top+b.height/2,offset,rect:b.toJSON()};
 },offset);}
async function visiblePoint(p,offset){
 for(let attempt=0;attempt<10;attempt++){
  const q=await point(p,offset),s=await read(p),v=s.scrollViewport;
  assert(q.rect.height>0,'source endpoint has real DOM caret geometry');
  if(q.x>=v.left+2&&q.x<=v.right-2&&q.rect.top>=v.top+2&&q.rect.bottom<=v.bottom-2)return {...q,viewport:v};
  const dx=q.x<v.left+2?q.x-(v.left+6):q.x>v.right-2?q.x-(v.right-6):0;
  const dy=q.rect.top<v.top+2?q.rect.top-(v.top+6):q.rect.bottom>v.bottom-2?q.rect.bottom-(v.bottom-6):0;
  const er=s.overlay,l=Math.max(v.left+6,er?.left||v.left),r=Math.min(v.right-6,er?.right||v.right),t=Math.max(v.top+6,er?.top||v.top),b=Math.min(v.bottom-6,er?.bottom||v.bottom);
  const hit=r>l&&b>t?{x:(l+r)/2,y:(t+b)/2}:{x:v.left+12,y:(v.top+v.bottom)/2};
  await p.mouse.move(hit.x,hit.y);await p.mouse.wheel(dx,dy);await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await sleep(100);
  const moved=await read(p);assert(moved.scroll.top!==s.scroll.top||moved.scroll.left!==s.scroll.left,'native reveal wheel must move owning viewport');
 }
 throw new Error('Source endpoint could not be revealed through native wheel');
}
async function clickOffset(p,offset){const q=await visiblePoint(p,offset);await p.mouse.click(q.x,q.y,{delay:65});await sleep(100);return q;}
function visibleCaret(s){const r=s.domCaret,v=s.scrollViewport;assert(r&&r.height>0,'native cell caret has real geometry');assert(r.left>=v.left-1&&r.right<=v.right+1&&r.top>=v.top-1&&r.bottom<=v.bottom+1,'editing caret remains inside owning visible viewport');}
function codepointBoundaries(text){let n=0;return[0,...Array.from(text,c=>(n+=c.length))];}
// Independent map, fixed synthetic fixture: each escaped pipe consumes one extra source code unit.
function fixtureMap(source,displayOffset){let i=0,j=0;while(j<displayOffset){i+=source[i]==='\\'&&source[i+1]==='|'?2:1;j++;}return i;}
async function main(){
 const o=args(process.argv.slice(2));assert(o.exe&&o['expected-sha256'],'packaged --exe and --expected-sha256 required');
 const dir=outputDir(o.out,'source-layout-workflows'),release=acquireSlot();let run;
 const caseFilter=process.env.MP_QUALITY_CASES?new RegExp(process.env.MP_QUALITY_CASES):null;
 const result={schema:1,suite:'source-layout-workflows',expectedFullCases:15,filter:caseFilter?.source||null,startedAt:new Date().toISOString(),cases:[],errors:[],cleanup:null,notes:['Synthetic fixtures only; no clipboard. All frames need Root visual review.','No horizontal range: Shift-wheel marked not-applicable, never pass.','TODO: bad-TeX cache lifecycle, real source search, Shift-wheel actual horizontal movement and quoted source exactly two lines remain unverified.']};
 const write=()=>fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
 const check=async(id,body)=>{if(caseFilter&&!caseFilter.test(id))return;const c={id,status:'running',frames:[],trace:[]};result.cases.push(c);write();try{await body(c);c.status='pass';}catch(e){c.status='fail';c.error=e.stack;write();throw e;}finally{write();console.log(c.status.toUpperCase()+' '+id+(c.error?': '+c.error.split('\n')[0]:''));}};
 const capture=async(p,c,name,cell=true)=>{const s=await read(p);c.trace.push({step:name,...s});c.frames.push(await frame(p,dir,c.id+'-'+name,{caret:cell?'dom':undefined}));return s;};
 const fresh=async(id,text)=>{const file=path.join(dir,id+'.md');fs.writeFileSync(file,text);const p=await newWindow(run,run.page,file);await listen(p,result);await p.bringToFront();await waitUntil(async()=>{const s=await read(p);return s.text===text&&s.focus;},'new exact source and native focus');return{p,file};};
 try{
  const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Synthetic owner\n');
  run=await launch({...o,settings:{autosaveEnabled:false,restoreLast:false,theme:'light'}},owner,dir,{MP_EXPORT_DIR:path.join(dir,'cell-active-html')});result.metadata=run.metadata;await listen(run.page,result);
  for(const z of [100,145,200])for(const kind of ['long','neighbor','sole-br'])await check(`cell-${kind}-${z}`,async c=>{
   const a=kind==='long'?LONG:kind==='sole-br'?TALL:'WORD 中文🙂\\|tail',b=kind==='neighbor'?TALL:'KEEP',E0=TABLE(a,b);
   const {p,file}=await fresh(c.id,E0);await zoom(p,z);
   const floor=await p.locator('.mp-row td[data-mp-col="0"]').first().evaluate(e=>e.getBoundingClientRect().height);c.entryFloor=floor;
   await enter(p);let s=await capture(p,c,'entry');assert.equal(s.text,E0);geometry(s,floor);
   const owner0=s.owner.owner,baseFrom=s.cellFrom,raw=E0.slice(s.cellFrom,s.cellTo),boundaries=codepointBoundaries(s.cellText),middle=boundaries.reduce((best,n)=>Math.abs(n-s.cellText.length/2)<Math.abs(best-s.cellText.length/2)?n:best,0);
   // First, middle, last of the full wrapped source block; coordinates never set selection.
   for(const off of [...new Set([0,middle,s.cellText.length])]){
    await phase(p,'offset-'+off);const target=await clickOffset(p,off);s=await capture(p,c,'offset-'+off);c.trace.push({target});
    assert.equal(s.domSelection.head,off,'native multiline DOM endpoint');assert.equal(s.selection.head,baseFrom+fixtureMap(raw,off),'UTF16 source codec endpoint including raw whitespace');assert.equal(s.selection.anchor,s.selection.head);
   }
   // Native keyboard edit, exact independent source model, Undo / Redo, manual save.
   await keys(p,'End',true);s=await read(p);const at=s.selection.head,E1=E0.slice(0,at)+'R'+E0.slice(at);
   await phase(p,'precise-input');await insert(p,'R',true);s=await capture(p,c,'typed');assert.equal(s.text,E1);geometry(s,floor);
   await sleep(1300);assert.equal(fs.readFileSync(file,'utf8'),E0,'manual profile must not autosave');assert((await read(p)).host.dirty);
   await keys(p,'Control+z',true);s=await capture(p,c,'undo');assert.equal(s.text,E0);
   await keys(p,'Control+y',true);s=await capture(p,c,'redo');assert.equal(s.text,E1);
   // CDP does not invoke native menu accelerators. The generic sendKey helper
   // also emits an extra char event, which inserts a literal S in body owners.
   // Exercise the real installed menu item's callback; do not claim OS keys.
   await phase(p,'manual-save-menu');assert((await read(p)).cellFocus);c.saveMenu=await p.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save',true));assert(c.saveMenu.ok,'actual installed save menu callback');await waitUntil(async()=>{const q=await read(p);return !q.host.dirty&&!q.host.saveInFlight&&fs.readFileSync(file,'utf8')===E1;},'manual menu save independent byte read');c.disk={text:fs.readFileSync(file,'utf8'),matchesE1:true};
   await phase(p,'overlay-wheel');s=await read(p);const r=s.overlay,v=s.scrollViewport,l=Math.max(r.left+4,v.left+4),right=Math.min(r.right-4,v.right-4),top=Math.max(r.top+4,v.top+4),bottom=Math.min(r.bottom-4,v.bottom-4);assert(right>l&&bottom>top,'overlay wheel target is live and visible');await p.mouse.move((l+right)/2,(top+bottom)/2);await p.mouse.wheel(0,180);await sleep(150);const w=await capture(p,c,'wheel');assert(w.events.some(e=>e.phase==='overlay-wheel'&&e.type==='wheel'&&e.trusted&&e.inCell),'wheel really targets owning overlay');
   c.wheel={before:s.scroll,after:w.scroll,viewportDelta:(w.scroll.top-s.scroll.top)*z/100};assert(Math.abs(c.wheel.viewportDelta-180)<3,'overlay wheel moves exactly 180 visual pixels');
   assert.equal(w.text,E1);assert.deepEqual(w.selection,s.selection);assert.deepEqual(w.owner.owner,owner0);assert(w.cellFocus);
   await p.mouse.wheel(0,-180);await sleep(150);
   await phase(p,'ctrl-wheel');s=await read(p);await p.keyboard.down('Control');try{await p.mouse.wheel(0,-180);}finally{await p.keyboard.up('Control');}await sleep(150);const zw=await capture(p,c,'ctrl-wheel');assert.equal(zw.zoom,z+5);assert.equal(zw.text,E1);assert.deepEqual(zw.selection,s.selection);
   await phase(p,'shift-wheel');s=await read(p);if(s.scroll.scrollWidth<=s.scroll.width+1)c.shiftWheel={status:'not-applicable',reason:'owning view has no horizontal scroll range'};else{await p.keyboard.down('Shift');try{await p.mouse.wheel(0,180);}finally{await p.keyboard.up('Shift');}await sleep(150);const sh=await read(p);c.shiftWheel={status:'observed',before:s.scroll,after:sh.scroll};assert.equal(sh.text,E1);assert.deepEqual(sh.selection,s.selection);}
   s=await read(p);assert(s.events.some(e=>e.phase==='cell-entry'&&e.type==='mousedown'&&e.trusted&&e.detail===1));assert(s.events.some(e=>e.phase==='precise-input'&&e.type==='input'&&e.trusted&&e.inCell));assert(s.events.some(e=>e.type==='keydown'&&e.trusted&&e.ctrl));
   if(kind==='long'&&z===100){
    const folder=path.join(dir,'cell-active-html');fs.mkdirSync(folder);
    const exported=await p.evaluate(()=>Promise.race([window.mpExtras.exportFolder(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('HTML export timeout')),15000))]));
    assert(exported?.ok&&exported.file&&fs.existsSync(exported.file),'real HTML export returned independently readable file');
    const html=fs.readFileSync(exported.file,'utf8');c.export=await p.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html');return{text:d.body.textContent,hidden:d.querySelectorAll('.mp-cell-layout,.mp-cell-source-size,.mp-cell-rendered-size').length};},html);
    assert.equal(c.export.hidden,0,'export never includes hidden layout sizers');assert.equal((c.export.text.match(/WORD/g)||[]).length,1,'export contains true cell once');assert.equal((await read(p)).text,E1);
   }
  });
  await check('cell-five-channel-and-shrink',async c=>{
   const a='WORD 中文🙂\\|tail '+('narrow '.repeat(25)),E0=TABLE(a,'KEEP'),{p}=await fresh(c.id,E0);await zoom(p,205);await capture(p,c,'pre-entry',false);await enter(p);await capture(p,c,'entry');
   await phase(p,'doubleclick');const q=await visiblePoint(p,2);await p.mouse.click(q.x,q.y,{clickCount:1,delay:65});await sleep(80);await p.mouse.click(q.x,q.y,{clickCount:2,delay:65});await sleep(120);let s=await capture(p,c,'doubleclick');
   const wordStart=s.cellText.indexOf('WORD'),wordFrom=Math.min(s.domSelection.anchor,s.domSelection.head),wordTo=Math.max(s.domSelection.anchor,s.domSelection.head);assert.equal(wordFrom,wordStart,'native doubleclick starts at word');assert([wordStart+4,wordStart+5].includes(wordTo),'native word may include its following space');assert.equal(s.cellText.slice(wordFrom,wordTo).trimEnd(),'WORD');assert(s.events.some(e=>e.type==='dblclick'&&e.detail===2&&e.trusted));
   const begin=5,end=12,initial=await read(p),raw=E0.slice(initial.cellFrom,initial.cellTo),bounds=codepointBoundaries(initial.cellText);assert(bounds.includes(begin)&&bounds.includes(end),'gesture endpoints are complete codepoint boundaries');c.gesture={begin,end,raw,display:initial.cellText};
   await clickOffset(p,begin);await phase(p,'shift-click');const target=await visiblePoint(p,end);await p.keyboard.down('Shift');try{await p.mouse.click(target.x,target.y,{delay:65});}finally{await p.keyboard.up('Shift');}await sleep(120);s=await capture(p,c,'shift-click');assert.equal(s.domSelection.anchor,begin);assert.equal(s.domSelection.head,end);assert.equal(s.selection.anchor,s.cellFrom+fixtureMap(raw,begin));assert.equal(s.selection.head,s.cellFrom+fixtureMap(raw,end));
   // Collapse using an actual click, then native down / six live moves / up.
   await visiblePoint(p,end);await clickOffset(p,begin);await phase(p,'drag');const start=await point(p,begin);await p.mouse.move(start.x,start.y);await p.mouse.down({clickCount:1});for(const at of bounds.filter(n=>n>begin&&n<=end)){const t=await point(p,at),v=(await read(p)).scrollViewport;assert(t.x>=v.left&&t.x<=v.right&&t.rect.top>=v.top&&t.rect.bottom<=v.bottom,'drag endpoint remains live and visible');await p.mouse.move(t.x,t.y);await sleep(30);}await p.mouse.up();await sleep(120);s=await capture(p,c,'drag');assert.equal(s.domSelection.anchor,begin);assert.equal(s.domSelection.head,end);assert.equal(s.selection.anchor,s.cellFrom+fixtureMap(raw,begin));assert.equal(s.selection.head,s.cellFrom+fixtureMap(raw,end),'emoji and escaped pipe use independent raw codec');assert(s.events.filter(e=>e.phase==='drag'&&e.type==='mousemove'&&e.trusted&&e.buttons===1).length>=4);
   await keys(p,'Shift+ArrowRight',true);await capture(p,c,'drag-shift-key');
   await clickOffset(p,0);await keys(p,'Shift+ArrowRight',true);s=await read(p);let E=s.text.slice(0,s.selection.anchor)+'中'+s.text.slice(s.selection.head);await insert(p,'中',true);assert.equal((await read(p)).text,E);await capture(p,c,'equal-length-wide');
   await keys(p,'Control+z',true);assert.equal((await read(p)).text,E0);
   // The next action deliberately starts at the source boundary via native Home.
   // A pointer at a collapsed leading-space edge can select either visual alias.
   await phase(p,'growth-boundary-key');await keys(p,'Control+Home',true);const before=await read(p),at=before.selection.head,payload='W'.repeat(600);assert.equal(before.domSelection.head,0);E=E0.slice(0,at)+payload+E0.slice(at);await insert(p,payload,true);const grown=await capture(p,c,'grown');assert.equal(grown.text,E);assert(grown.cell.height>before.cell.height+20,'real source input grows sizer and row');visibleCaret(grown);
   await keys(p,'Control+z',true);const undone=await capture(p,c,'undo-growth');assert.equal(undone.text,E0);assert(Math.abs(undone.cell.height-before.cell.height)<1,'Undo shrinks row to render floor');visibleCaret(undone);
   await keys(p,'Control+y',true);const redone=await read(p);assert.equal(redone.text,E);assert.deepEqual(redone.domSelection,{anchor:600,head:600},'Redo restores payload end caret');
   // Select precisely the inserted 600 UTF16 units using native keys, then delete.
   await keys(p,'Control+Shift+Home',true);
   const selected=await read(p);c.trace.push({step:'native-delete-selection',...selected});assert.deepEqual(selected.domSelection,{anchor:600,head:0},'native CtrlShiftHome selects exactly inserted payload');await keys(p,'Backspace',true);
   const shrunk=await capture(p,c,'deleted');assert.equal(shrunk.text,E0);assert(Math.abs(shrunk.cell.height-before.cell.height)<1,'deletion shrinks source row to frozen render floor');visibleCaret(shrunk);
  });
  for(const f of [
   {id:'inline-tall',text:'Before $\\dfrac{a}{b}$ after.\n\nEND'+TAIL,tall:true},
   {id:'inline-short',text:'Before $a+b$ after.\n\nEND'+TAIL},
   {id:'inline-quoted-wrap',text:'> Before $'+('a+'.repeat(75))+'b$ after.\n\nEND'+TAIL,wrap:true}
  ])await check(f.id,async c=>{
   const {p}=await fresh(c.id,f.text);
   if(f.wrap)await zoom(p,205);
   const line=p.locator('.cm-line').filter({hasText:'Before '}).first();
   const ruler=()=>line.evaluate(e=>{const r=e.getBoundingClientRect(),w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.nodeValue.startsWith('Before ')){const q=document.createRange();q.setStart(n,0);q.setEnd(n,6);const prefix=q.getBoundingClientRect();return{height:r.height,baseline:prefix.bottom-r.top,top:r.top,prefixTop:prefix.top,prefixBottom:prefix.bottom};}return{height:r.height,baseline:null};});
   const closed=await ruler();c.closed=closed;
   for(let i=0;i<(f.tall?3:1);i++){
    const glyph=await p.locator('.mp-cm6-math').first().boundingBox();assert(glyph);
    const target=f.wrap?await p.locator('.mp-cm6-math .katex-html').first().evaluate(e=>{const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.nodeValue==='a'){const r=document.createRange();r.selectNodeContents(n);const b=r.getBoundingClientRect();if(b.width>0&&b.top>=0&&b.bottom<=innerHeight)return{x:b.left+b.width/2,y:b.top+b.height/2,text:n.nodeValue};}return null;}):{x:glyph.x+glyph.width*.5,y:glyph.y+glyph.height*.5};
    assert(target,'native point targets an actual visible formula glyph');c.glyphEntry=target;await phase(p,'math-entry');await p.mouse.click(target.x,target.y,{delay:65});await sleep(150);let s=await capture(p,c,'opened-'+i,false);assert(s.focus&&s.text===f.text);const open=await ruler();c.trace.push({open});
    if(!f.wrap){assert.equal(open.height,closed.height,'single-line source preserves exact line height');assert.equal(open.baseline,closed.baseline,'single-line source preserves exact neighboring text baseline');}else{
      assert.equal(open.top,closed.top,'wrapped source keeps paragraph viewport origin');assert.equal(open.prefixTop,closed.prefixTop,'wrapped source keeps neighbor text top');assert.equal(open.prefixBottom,closed.prefixBottom,'wrapped source keeps neighbor text bottom');
      const from=f.text.indexOf('$')+1,to=f.text.lastIndexOf('$'),caret=c.frames.at(-1).caret,v=s.scrollViewport;
      assert(s.selection.head>=from&&s.selection.head<=to,'native pointer enters actual TeX source interval');assert(caret&&caret.left>=v.left-1&&caret.right<=v.right+1&&caret.top>=v.top-1&&caret.bottom<=v.bottom+1,'wrapped source caret is reachable in actual viewport');
      c.wrapReflow={closedHeight:closed.height,sourceHeight:open.height,meaning:'KaTeX and raw source have different widths; actual wrapped line count may grow or shrink without moving the neighboring prefix'};
    }
    assert(await p.evaluate(()=>[...document.querySelectorAll('.mp-inline-math-space')].every(e=>e.textContent===''&&e.getAttribute('aria-hidden')==='true'&&e.getBoundingClientRect().width===0)),'strut is empty, hidden and zero width');
    const before=s,at=s.selection.head,E1=f.text.slice(0,at)+'R'+f.text.slice(at);await insert(p,'R');s=await capture(p,c,'typed-'+i,false);assert.equal(s.text,E1);assert.equal(s.regions.computation.math.fullRescan,0,'bounded incremental source edit');await keys(p,'Control+z');assert.equal((await read(p)).text,f.text);
    const prefix=await line.evaluate(e=>{const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.nodeValue.startsWith('Before ')){const r=document.createRange();r.setStart(n,1);r.collapse(true);const b=r.getBoundingClientRect();return{x:b.left,y:b.top+b.height/2};}return null;});assert(prefix,'live neighboring prefix');
    await p.mouse.click(prefix.x,prefix.y,{delay:65});await sleep(150);await capture(p,c,'closed-'+i,false);const again=await ruler();assert.equal(again.height,closed.height);assert.equal(again.baseline,closed.baseline);assert.equal(before.host.documentId,(await read(p)).host.documentId);
   }
  });
  await check('body-wheel-owner-history',async c=>{
   const E0='Synthetic body control\n'+TAIL,{p,file}=await fresh(c.id,E0);await zoom(p,100);await keys(p,'Control+Home');let s=await read(p);await phase(p,'body-wheel');const r=await p.locator('.cm-content').boundingBox();await p.mouse.move(r.x+20,Math.max(100,r.y+20));await p.mouse.wheel(0,180);await sleep(150);const w=await capture(p,c,'wheel',false);assert(Math.abs(w.scroll.top-s.scroll.top-180)<3);assert.deepEqual(w.selection,s.selection);assert.equal(w.text,E0);assert(w.events.some(e=>e.phase==='body-wheel'&&e.type==='wheel'&&e.trusted&&e.inEditor));
   await insert(p,'X');s=await read(p);assert.equal(s.text,'X'+E0);await keys(p,'Control+z');assert.equal((await read(p)).text,E0);
   const other=await fresh('owner-independent','Independent clean document\n');await keys(other.p,'Control+y');assert.equal((await read(other.p)).text,'Independent clean document\n');assert.equal((await read(p)).text,E0);assert.equal(fs.readFileSync(file,'utf8'),E0);
  });
  await check('input-two-raf-p95',async c=>{
   c.samples={ordinary:[],cell:[]};for(const mode of ['ordinary','cell']){
    const {p}=await fresh('perf-'+mode,mode==='cell'?TABLE('x','KEEP'):'ordinary\n');await zoom(p,100);if(mode==='cell')await enter(p,false);else await keys(p,'Control+Home');
    for(let i=0;i<7;i++){const before=await read(p),at=before.selection.head;await p.evaluate(()=>{window.__qualityInputTick=new Promise(resolve=>document.addEventListener('input',e=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({ms:performance.now()-start,trusted:e.isTrusted})));},{once:true,capture:true}));});await insert(p,'q',mode==='cell');const sample=await p.evaluate(()=>Promise.race([window.__qualityInputTick,new Promise((_,reject)=>setTimeout(()=>reject(new Error('No trusted input performance sample')),5000))]));assert(sample.trusted);c.samples[mode].push(sample.ms);const s=await read(p);assert.equal(s.text,before.text.slice(0,at)+'q'+before.text.slice(at));c.trace.push({mode,iteration:i,...s});}
    c.frames.push(await frame(p,dir,'perf-'+mode,{caret:mode==='cell'?'dom':undefined}));
   }
   c.p95=Object.fromEntries(Object.entries(c.samples).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)[Math.ceil(v.length*.95)-1]]));c.measurement='trusted input event to two requestAnimationFrame callbacks; seven serial samples, no threshold invented';
  });
  assert.deepEqual(result.errors,[],'all owned windows have no pageerrors');
 }catch(e){result.fatal=e.stack;process.exitCode=1;}finally{
  if(run)try{result.cleanup=await run.cleanup();if(result.cleanup.residual.length)process.exitCode=1;}catch(e){result.cleanup={error:e.stack};process.exitCode=1;}
  try{release();}catch(e){result.slotReleaseError=e.stack;process.exitCode=1;}result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.errors.length&&!result.fatal&&!result.slotReleaseError&&!!result.cleanup&&!result.cleanup.error&&Array.isArray(result.cleanup.residual)&&result.cleanup.residual.length===0;if(!result.passed)process.exitCode=1;write();console.log(JSON.stringify({suite:result.suite,passed:result.passed,cases:result.cases.length,expectedFullCases:result.expectedFullCases,filter:result.filter,errors:result.errors.length,cleanup:result.cleanup}));
 }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
