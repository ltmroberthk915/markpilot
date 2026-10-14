'use strict';
// Real cell-format source/history/manual-save/export regression. Synthetic input only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const {args,launch,acquireSlot,sleep}=require(path.join(ROOT,'tools/quality/lifecycle.cjs'));
const {outputDir,waitUntil,frame,newWindow}=require(path.join(ROOT,'tools/quality/harness.cjs'));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const CODE='**码** *字* <u>码线</u> ~~码删~~';
const CELL='**不采** *斜体* <u>下划线</u> ~~删除线~~ **外 *内斜* 尾** `'+CODE+'` $x_i*y$ [**标签** $z_i*t$ `literal_**`](#target)';
function fixture(quoted){const q=quoted?'> ':'';return '# Synthetic format acceptance\n\n'+q+'| '+CELL+' | HEADER_KEEP |\n'+q+'| --- | --- |\n'+q+'| '+CELL+' | BODY_KEEP |\n\nAFTER_KEEP\n';}
const read=p=>p.evaluate(()=>{
 const v=window.mpEngine._view(),r=v.state.selection.main,el=document.querySelector('.mp-cell-overlay-text'),td=document.querySelector('.mp-cell-editing'),ds=getSelection();
 const offset=(node,o)=>{if(!el?.contains(node))return null;const range=document.createRange();range.selectNodeContents(el);range.setEnd(node,o);return range.toString().length;};
 let caret=null;if(document.activeElement===el&&ds?.focusNode&&el.contains(ds.focusNode)){let n=ds.focusNode,o=ds.focusOffset;if(n.nodeType===1){const forward=o<n.childNodes.length;n=n.childNodes[forward?o:o-1];while(n&&n.nodeType!==3)n=forward?n.firstChild:n.lastChild;if(n)o=forward?0:n.textContent.length;}if(n){const range=document.createRange();range.setStart(n,o);range.collapse(true);caret=range.getBoundingClientRect().toJSON();}}
 return{source:v.state.doc.toString(),selection:{anchor:r.anchor,head:r.head},host:{documentId,filePath,dirty,revision,saveInFlight},cellFrom:td?Number(td.dataset.mpFrom):null,cellTo:td?Number(td.dataset.mpTo):null,domSource:el?.textContent,domSelection:{anchor:offset(ds?.anchorNode,ds?.anchorOffset),head:offset(ds?.focusNode,ds?.focusOffset)},caret,cellFocus:document.hasFocus()&&document.activeElement===el,focus:document.hasFocus()&&v.hasFocus,events:window.__formatEvents||[]};
});
async function instrument(p,result){p.on('pageerror',e=>result.errors.push(e.message));await p.evaluate(()=>{
 window.__formatEvents=[];window.__formatPhase='boot';
 for(const type of ['mousedown','mouseup','click','keydown','keyup','beforeinput','input'])document.addEventListener(type,e=>{
  const v=window.mpEngine?._view?.();if(!v)return;const s=v.state.selection.main;
  window.__formatEvents.push({phase:window.__formatPhase,type,trusted:e.isTrusted,detail:e.detail,key:e.key,data:e.data,inputType:e.inputType,ctrl:e.ctrlKey,shift:e.shiftKey,inCell:!!e.target.closest?.('.mp-cell-overlay-text'),selection:{anchor:s.anchor,head:s.head},at:performance.now()});
 },{capture:true,passive:true});
});}
const phase=(p,name)=>p.evaluate(name=>{window.__formatPhase=name;},name);
async function formatFrame(p,dir,name,kind){
 const clip=await p.evaluate(kind=>{
  const cell=document.querySelector('.mp-row '+kind+'[data-mp-col="0"]:not(.mp-cell-editing)'),r=cell.getBoundingClientRect();
  const x=Math.max(0,r.left),y=Math.max(0,r.top);
  return{x,y,width:Math.min(innerWidth,r.right)-x,height:Math.min(innerHeight,r.bottom)-y,scale:2};
 },kind);
 assert(clip.width>0&&clip.height>0,'style ROI is in actual viewport');
 const cdp=await p.context().newCDPSession(p);let bytes;
 try{const shot=await cdp.send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:false});bytes=Buffer.from(shot.data,'base64');}finally{await cdp.detach();}
 const file=name+'-styles-2x.png';fs.writeFileSync(path.join(dir,file),bytes);
 return{file,sha256:hash(bytes),clip,kind:'actual-browser-cell-style-ROI'};
}
async function projection(p,source){return p.evaluate(({source,code})=>{
 const inspect=(cell,styles)=>{
  const find=(tag,text)=>[...cell.querySelectorAll(tag)].find(n=>n.textContent===text);
  const strong=find('strong','不采'),em=find('em','斜体'),u=find('u','下划线'),strike=find('s','删除线');
  const nested=[...cell.querySelectorAll('strong')].find(n=>n.textContent==='外 内斜 尾');
  const inlineCode=cell.querySelector('code');
  const style=n=>n&&{weight:getComputedStyle(n).fontWeight,fontStyle:getComputedStyle(n).fontStyle,decoration:getComputedStyle(n).textDecorationLine};
  const clone=cell.cloneNode(true);for(const n of clone.querySelectorAll('code,.katex'))n.remove();
  return{tags:{strong:!!strong,em:!!em,u:!!u,s:!!strike},nested:!!nested&&!![...nested.querySelectorAll('em')].find(n=>n.textContent==='内斜'),plainText:clone.textContent.replace(/\s+/g,' ').trim(),codeText:inlineCode?.textContent,codeChildren:inlineCode?.querySelectorAll('strong,em,u,s,.katex').length,math:!!cell.querySelector('.katex'),mathCount:cell.querySelectorAll('.katex').length,labelStrong:!!find('strong','标签'),labelCode:[...cell.querySelectorAll('code')].some(n=>n.textContent==='literal_**'),mathText:cell.querySelector('.katex')?.textContent,mathFormatChildren:cell.querySelector('.katex')?.querySelectorAll('strong,em,u,s').length,styles:styles?{strong:style(strong),em:style(em),u:style(u),s:style(strike)}:null,html:cell.innerHTML};
 };
 const actual=[...document.querySelectorAll('.mp-row th[data-mp-col="0"],.mp-row td[data-mp-col="0"]')].filter(n=>!n.classList.contains('mp-cell-editing')).map(n=>({kind:n.tagName,...inspect(n,true)}));
 const html=window.mpExtras.mdToHtml(source,{math:true});
 const exported=new DOMParser().parseFromString(html,'text/html');
 return{actual,exported:[...exported.querySelectorAll('th:first-child,td:first-child')].map(n=>({kind:n.tagName,...inspect(n,false)})),html,exportSizerCount:exported.querySelectorAll('.mp-cell-layout,.mp-cell-source-size,.mp-cell-rendered-size').length,codeExpected:code};
},{source,code:CODE});}
function assertProjection(p){
 assert.equal(p.actual.length,2,'nonediting header+body rendered');assert.equal(p.exported.length,2,'actual mdToHtml header+body output');assert.equal(p.exportSizerCount,0);
 for(const c of [...p.actual,...p.exported]){
  assert.deepEqual(c.tags,{strong:true,em:true,u:true,s:true},c.kind+' four semantic tags');assert(c.nested,c.kind+' nested strong/em');assert.equal(c.plainText,'不采 斜体 下划线 删除线 外 内斜 尾'+(c.styles?' [标签 ](#target)':' 标签'),c.kind+' no raw formatting delimiters outside protected code/math');
  assert(c.labelStrong&&c.labelCode,c.kind+' link-label format/code projected');assert.equal(c.mathCount,2,c.kind+' formula within link label stays rendered');
  assert.equal(c.codeText,CODE,c.kind+' code remains literal');assert.equal(c.codeChildren,0,c.kind+' code has no nested formatting/math');
  assert(c.math,c.kind+' real KaTeX output');assert(/[∗*]/.test(c.mathText),c.kind+' star inside TeX renders');assert.equal(c.mathFormatChildren,0,c.kind+' text formatter never enters KaTeX');
  if(c.styles){assert(Number(c.styles.strong.weight)>=600,'strong computed bold');assert.equal(c.styles.em.fontStyle,'italic');assert(c.styles.u.decoration.includes('underline'));assert(c.styles.s.decoration.includes('line-through'));}
 }
}
async function nativeEnter(p,kind){
 await phase(p,'native-entry-'+kind);
 const target=await p.evaluate(kind=>{
  const cell=document.querySelector('.mp-row '+kind+'[data-mp-col="0"]:not(.mp-cell-editing)');
  const glyph=[...cell.querySelectorAll('strong')].find(n=>n.textContent==='不采');if(!glyph)throw Error('Rendered entry glyph missing');
  const r=document.createRange();r.selectNodeContents(glyph);const box=r.getBoundingClientRect();const x=(box.left+box.right)/2,y=(box.top+box.bottom)/2;
  return{x,y,inTarget:cell.contains(document.elementFromPoint(x,y)),rect:box.toJSON()};
 },kind);
 assert(target.inTarget,'native entry glyph must not be obstructed');
 await p.mouse.move(target.x,target.y);await p.mouse.down();await sleep(80);await p.mouse.up();
 await waitUntil(async()=>(await read(p)).cellFocus,'native cell focus without repair',5000);
 const s=await read(p);assert.equal(s.domSource,s.source.slice(s.cellFrom,s.cellTo),'editing surface displays complete original source');
 assert(s.domSource.includes(CELL),'all markup/math/code source present');
 assert(s.events.some(e=>e.phase==='native-entry-'+kind&&e.type==='mousedown'&&e.trusted&&e.detail===1),'trusted single-click entry');
 return target;
}
async function menuSave(p,file,expected){assert((await read(p)).cellFocus,'save keeps actual cell owner');const receipt=await p.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save',true));assert(receipt.ok,'installed MenuItem save callback reached');await waitUntil(async()=>{const s=await read(p);return s.source===expected&&!s.host.dirty&&!s.host.saveInFlight&&fs.readFileSync(file,'utf8')===expected;},'native menu save plus independent disk bytes',15000);return{ok:true,route:'installed MenuItem callback; no physical CtrlS claim',diskSha256:hash(fs.readFileSync(file))};}
async function main(){
 const o=args(process.argv.slice(2));assert(o.exe&&o['expected-sha256'],'--exe / --expected-sha256 required');
 const dir=outputDir(o.out,'cell-format-workflows'),release=acquireSlot();let run,currentCase,currentPage;
 const result={schema:1,suite:'cell-format-workflows',expectedFullCases:2,startedAt:new Date().toISOString(),cases:[],errors:[],cleanup:null,notes:['Owned synthetic files and manual isolated profile only.','No focus/source-selection repair after native entry.','Actual mdToHtml出口; semantic strike tag is s in shared parser.','Save uses actual installed menu callback, not physical OS CtrlS.','Root must review full and caret frames. Negative root-seam build is supplied by Root; script performs no mutation.']};
 const write=()=>fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
 const capture=async(p,c,name,cell=true)=>{const s=await read(p);c.trace.push({step:name,...s,diskSha256:hash(fs.readFileSync(c.file))});if(/td-(source|typed|rerendered)$/.test(name))c.frames.push(await frame(p,dir,c.id+'-'+name,{caret:cell?'dom':undefined}));return s;};
 try{
  const normal=fixture(false),normalFile=path.join(dir,'normal.md');fs.writeFileSync(normalFile,normal);
  run=await launch({...o,settings:{autosaveEnabled:false,restoreLast:false,theme:'light'}},normalFile,dir);result.metadata=run.metadata;
  for(const quoted of [false,true]){
   const id=quoted?'quoted-header-and-body':'normal-header-and-body',source=fixture(quoted),file=quoted?path.join(dir,'quoted.md'):normalFile;
   if(quoted)fs.writeFileSync(file,source);
   const p=quoted?await newWindow(run,run.page,file):run.page;currentPage=p;
   // Bringing a newly created fixture window forward is startup only; never
   // used to repair failed native entry, editing, history or save operations.
   if(quoted)await p.bringToFront();
   const c=currentCase={id,file,status:'running',trace:[],frames:[]};result.cases.push(c);write();
   await waitUntil(()=>p.evaluate(()=>!!window.mpEngine?._view?.()&&typeof window.mpExtras?.mdToHtml==='function'),'engine/extras initialization');
   await instrument(p,result);await waitUntil(async()=>(await read(p)).source===source,'exact startup fixture');assert((await read(p)).focus,'initial native editor focus');
   c.beforeProjection=await projection(p,source);assertProjection(c.beforeProjection);
   c.frames.push(await frame(p,dir,id+'-rendered-before'));
   for(const kind of ['th','td'])c.frames.push(await formatFrame(p,dir,id+'-'+kind,kind));
   for(const kind of ['th','td']){
    c.trace.push({step:kind+'-target',target:await nativeEnter(p,kind)});
    const before=await capture(p,c,kind+'-source');assert.equal(before.source,source);assert.equal(before.selection.head,before.cellFrom+before.domSelection.head,'native DOM endpoint maps to full source UTF16 endpoint');assert.equal(before.selection.anchor,before.cellFrom+before.domSelection.anchor);
    await phase(p,kind+'-input');assert(before.cellFocus);await p.keyboard.insertText('R');
    const changed=source.slice(0,before.selection.head)+'R'+source.slice(before.selection.head);
    await waitUntil(async()=>(await read(p)).source===changed,'R at native source endpoint');
    let s=await capture(p,c,kind+'-typed');assert(s.host.dirty);assert.equal(s.selection.head,before.selection.head+1);assert.equal(fs.readFileSync(file,'utf8'),source,'manual profile preserves disk until save');
    assert(s.events.some(e=>e.phase===kind+'-input'&&e.type==='input'&&e.trusted&&e.inCell),'trusted input on real source overlay');
    await phase(p,kind+'-undo');assert(s.cellFocus);await p.keyboard.press('Control+z');await waitUntil(async()=>(await read(p)).source===source,'Undo exact original');await capture(p,c,kind+'-undo');
    await phase(p,kind+'-redo');assert((await read(p)).cellFocus);await p.keyboard.press('Control+y');await waitUntil(async()=>(await read(p)).source===changed,'Redo exact R');await capture(p,c,kind+'-redo');
    c.trace.push({step:kind+'-saved',receipt:await menuSave(p,file,changed)});await capture(p,c,kind+'-saved');
    await phase(p,kind+'-restore-undo');assert((await read(p)).cellFocus);await p.keyboard.press('Control+z');await waitUntil(async()=>(await read(p)).source===source,'Undo saved R restores source');
    c.trace.push({step:kind+'-restored-disk',receipt:await menuSave(p,file,source)});
    await phase(p,kind+'-escape');assert((await read(p)).cellFocus);await p.keyboard.press('Escape');
    await waitUntil(()=>p.evaluate(()=>!document.querySelector('.mp-cell-editing')),'Esc exits active source');
    s=await capture(p,c,kind+'-rerendered',false);assert.equal(s.source,source);assert.equal(s.host.dirty,false);assert.equal(fs.readFileSync(file,'utf8'),source);
    const after=await projection(p,source);assertProjection(after);c.trace.push({step:kind+'-projection-restored',projection:after});
   }
   c.status='pass';c.diskRestoredSha256=hash(fs.readFileSync(file));write();console.log('PASS '+id);currentCase=null;
  }
 }catch(error){
  result.fatal=error.stack||error.message;if(currentCase){currentCase.status='fail';currentCase.error=error.message;try{currentCase.failureState=await read(currentPage);currentCase.frames.push(await frame(currentPage,dir,currentCase.id+'-failure',{caret:'dom',allowMissingCaret:true}));currentCase.failureHasRealSourceCaret=!!currentCase.failureState.caret&&currentCase.failureState.cellFocus;}catch(frameError){currentCase.failureCaptureError=frameError.message;}}
  process.exitCode=1;
 }finally{
  if(run)try{result.cleanup=await run.cleanup();}catch(error){result.cleanupError=error.message;process.exitCode=1;}
  release();result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&!result.errors.length&&!result.cleanupError&&result.cases.length===2&&result.cases.every(c=>c.status==='pass')&&result.cleanup?.residual?.length===0;write();console.log(JSON.stringify({out:dir,passed:result.passed,error:result.fatal?.split('\n')[0],cleanup:result.cleanup}));if(!result.passed)process.exitCode=1;
 }
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
