'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const {args,acquireSlot,launch,sleep,sha256}=require(path.join(root,'tools/quality/lifecycle.cjs'));
const {newWindow,outputDir,frame,recorder,waitUntil}=require(path.join(root,'tools/quality/harness.cjs'));
const original=process.env.MP_MANUAL_REPRESENTATIVE;
const state=p=>p.evaluate(()=>{const v=window.mpEngine._view();return {start:v.state.doc.sliceString(0,45),length:v.state.doc.length,head:v.state.selection.main.head,reading:v.state.readOnly,pill:document.documentElement.dataset.mpReading==='1',composing:v.compositionStarted};});
const clickMode=async p=>{await p.locator('.mp-toolbar [data-mp-id="reading-mode"]').click({delay:45});await sleep(120);};
(async()=>{
const opts=args(process.argv.slice(2)),out=outputDir(opts.out,'manual-actions'),release=acquireSlot();
const result={cases:[],frames:[],originalHash:original ? sha256(original) : null}, record=recorder(out,result);
const check=(id,fn)=>!process.env.MP_QUALITY_CASES || new RegExp(process.env.MP_QUALITY_CASES).test(id) ? record(id,fn) : null;
let run;
try {
 const base='INTRO\n\n- [ ] reusable task\n\nNEXT\n\n';
 const large=path.join(out,'large-copy.md'); fs.writeFileSync(large,Buffer.concat([Buffer.from(base),original ? fs.readFileSync(original) : Buffer.alloc(0)]));
 if(original) assert.equal(sha256(original),result.originalHash);
 const config=process.env.MP_MANUAL_SETTINGS ? JSON.parse(fs.readFileSync(process.env.MP_MANUAL_SETTINGS,'utf8')) : {};delete config.recentFiles;delete config.lastFile;
 run=await launch({...opts,settings:{...config,autosaveEnabled:false,restoreLast:false}},large,out);result.metadata=run.metadata;
 const fresh=async(id,content=base)=>{const f=path.join(out,id+'.md');fs.writeFileSync(f,content);const p=await newWindow(run,run.page,f);await p.bringToFront();return p;};
 const show=async(p,id)=>{result.frames.push(await frame(p,out,id,{allowMissingCaret:true}));};
 await check('reading-checkbox-preserves-source',async trace=>{
  const p=run.page;await p.bringToFront();await p.keyboard.press('Control+Home');
  const pre=await state(p);assert(!pre.reading && pre.start.startsWith(base));await clickMode(p);
  assert((await state(p)).reading && (await state(p)).pill,'reading entry');const box=p.locator('.mp-cm6-check').first();const rect=await box.boundingBox();assert(rect);await p.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2,{delay:45});await sleep(100);
  const post=await state(p);trace.push({pre:{length:pre.length},post:{length:post.length,checked:post.start.includes('[x]'),reading:post.reading}});
  await p.locator('.mp-reading-exit').click({delay:45});await p.keyboard.press('Control+s');await sleep(180);
  assert(post.start===pre.start,'readonly checkbox must preserve Markdown');assert(fs.readFileSync(large,'utf8').startsWith(base),'saved copy unchanged');
 });
 await check('secondary-button-keeps-document',async trace=>{
  const p=await fresh('secondary');await p.keyboard.press('Control+End');await p.keyboard.type('MANUAL');
  const pre=await state(p);await p.locator('.mp-toolbar [data-mp-id="undo"]').click({button:'right',delay:55});await sleep(120);
  const post=await state(p);trace.push({pre,post});await show(p,'secondary-after');assert.equal(post.length,pre.length,'secondary click on toolbar must not execute Undo');
  await p.keyboard.press('Escape');const box=p.locator('.mp-cm6-check').first();await box.click({button:'right',delay:55});await sleep(100);assert(!(await state(p)).start.includes('[x]'));
  await p.keyboard.press('Escape');await box.click({delay:55});assert((await state(p)).start.includes('[x]'),'normal checkbox click');
 });
 await check('reading-mode-local-to-window',async trace=>{
  const a=await fresh('window-a'),b=await fresh('window-b');assert(!(await state(a)).reading&&!(await state(b)).reading);
  await a.bringToFront();await clickMode(a);assert((await state(a)).reading);await b.bringToFront();await clickMode(b);
  const post=await state(b);trace.push({a:await state(a),b:post});await show(b,'reading-second-window');assert(post.reading && post.pill,'first click in second editing window must enter reading');
  await b.locator('.mp-reading-exit').click();assert((await state(a)).reading);await a.bringToFront();await a.locator('.mp-reading-exit').click();
 });
 await check('composition-reading-entry-is-atomic',async trace=>{
  const p=await fresh('composition','TYPE HERE');await p.keyboard.press('Control+End');
  const cdp=await p.context().newCDPSession(p);
  try{
   await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
   await waitUntil(async()=>(await state(p)).composing,'Chromium composition active');
   await clickMode(p);const refused=await state(p);trace.push({refused});await show(p,'composition-mode-after');
   assert(!refused.reading && !refused.pill,'mode control must match editor while composition owns the draft');
   await cdp.send('Input.insertText',{text:'中'});await waitUntil(async()=>(await state(p)).start==='TYPE HERE中','composition commit');
   await clickMode(p);assert((await state(p)).reading && (await state(p)).pill,'after composition reading can enter');
  }finally{await cdp.detach();}
 });
}catch(e){result.fatal=String(e.stack);}finally{result.cleanup=await run?.cleanup();release();result.originalUnchanged=!original || sha256(original)===result.originalHash;result.passed=!result.fatal && result.cases.length>0 && result.cases.every(c=>c.status==='pass') && result.originalUnchanged;
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;}
})();
