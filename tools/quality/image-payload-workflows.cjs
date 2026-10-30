'use strict';
// Region-workflows harness, literal source/byte oracles, and trusted input.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,frame,recorder,waitUntil,newWindow,newBlankWindow}=require('./harness.cjs');
const clipboard=require('./clipboard.cjs');
const SVG='<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect width="360" height="120" fill="#286bb2"/><text x="35" y="70" font-size="28" fill="white">IMAGE BACKUP</text></svg>';
const URI='data:image/svg+xml;base64,'+Buffer.from(SVG).toString('base64');
(async()=>{
 const o=args(process.argv.slice(2)),dir=outputDir(o.out,'image-payload-workflows'),release=acquireSlot(),r={schema:1,cases:[],errors:[],frames:[],clipboard:{touched:false}};
 const record=recorder(dir,r),filter=process.env.MP_QUALITY_CASES,wanted=id=>!filter||new RegExp(filter).test(id);let run,p,clip;
 const read=()=>p.evaluate(()=>{const v=window.mpEngine._view(),s=window.mpSplit._slave();return {text:v.state.doc.toString(),selection:{anchor:v.state.selection.main.anchor,head:v.state.selection.main.head},focus:document.hasFocus()&&v.hasFocus,cell:document.activeElement?.classList.contains('mp-cell-overlay-text'),body:v.contentDOM.textContent,source:s?.contentDOM.textContent,sourceEqual:s?.state.doc.eq(v.state.doc),chips:[...document.querySelectorAll('.mp-image-payload-protected')].map(e=>e.textContent),dialog:!!document.querySelector('dialog.mp-image-removal-dialog[open]'),status:document.querySelector('.mp-image-removal-status')?.textContent};});
 const shot=async(trace,name)=>{const s=await read(),image=await frame(p,dir,name,{allowMissingCaret:true});trace.push({name,...s,screenshot:image});r.frames.push(image);return s;};
 const open=async(name,text)=>{const file=path.join(dir,name+'.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);p=await newWindow(run,run.page,file);p.on('pageerror',e=>r.errors.push(e.message));await p.bringToFront();await waitUntil(()=>p.evaluate(text=>window.mpEngine.getValue()===text&&document.hasFocus()&&window.mpEngine._view().hasFocus,text),'native open focus');return file;};
 const image=()=>p.locator('.cm-content .mp-img img,.cm-content img.mp-cell-img').first();
 const exact=async text=>assert.equal((await read()).text,text,'complete source oracle');
 const choose=async action=>{await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await p.locator('[data-image-removal="'+action+'"]').click({delay:65});await waitUntil(()=>p.locator('dialog.mp-image-removal-dialog[open]').count().then(n=>n===0),'choice completes');};
 const menuDelete=async()=>{await image().click({button:'right',delay:65});await p.locator('.mp-pop-item').filter({hasText:'删除图片'}).click({delay:65});};
 try{
  const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Owned image verification\n');
  run=await launch({...o,settings:{autosaveEnabled:false,restoreLast:false,theme:'light'}},owner,dir);p=run.page;r.artifact=run.metadata;p.on('pageerror',e=>r.errors.push(e.message));clip=await clipboard.hold();r.clipboard={touched:true,...clip.metadata};
  for(const form of ['markdown','html','quote','table','percent']){const id='concealed-'+form;if(!wanted(id))continue;await record(id,async trace=>{
   const uri=form==='percent'?'data:image/svg+xml,'+encodeURIComponent(SVG):URI;
   const mark=form==='html'?'<img src="'+uri+'" alt="Preview" width="360">':'![Preview]('+uri+')';
   const text=form==='table'?'# Image\n\n| Picture | Keep |\n|---|---|\n| '+mark+' | SAFE |\n\nAFTER\n':'# Image\n\n'+(form==='quote'?'> ':'')+mark+'\n\nAFTER\n';
   await open(id,text);await waitUntil(()=>image().evaluate(e=>e.naturalWidth>0),'image decoded');
   if(!await p.evaluate(()=>window.mpSplit.isOpen()))await p.locator('[data-mp-id="split"]').click({delay:65});
   const opened=await shot(trace,id+'-source');assert(opened.sourceEqual);assert(!opened.source.includes(uri)&&!opened.source.includes(uri.slice(35,95)),'source conceals whole encoded payload');
   await image().click({delay:65});await p.keyboard.insertText('R');const alt=text.indexOf('Preview'),edited=text.slice(0,alt)+'R'+text.slice(alt);await exact(edited);
   const active=await shot(trace,id+'-active');assert(!active.body.includes(uri)&&!active.body.includes(uri.slice(35,95)),'body conceals whole encoded payload');assert(active.chips.every(c=>!c.includes('展开')&&!c.includes('base64')));assert(active.sourceEqual);
   await p.keyboard.press('Control+z');await exact(text);assert(!(await read()).dialog,'metadata Undo never prompts');
   // Deliberate source-selection fixture: targets reachable by search/commands.
   // The attempted edits themselves use trusted native input, no dispatch edits.
   const start=text.indexOf(uri),end=start+uri.length;
   for(const [name,a,b,key] of [['start',start,start,'X'],['inside',start+12,start+15,'Backspace'],['end',end,end,'X'],['orphan',text.indexOf(mark),text.indexOf(mark)+1,'Backspace']]){
    await p.evaluate(({a,b})=>{const v=window.mpEngine._view();v.dispatch({selection:{anchor:a,head:b},scrollIntoView:true});v.focus();},{a,b});
    assert((await read()).focus,'fixture owner before trusted input');
    if(key==='X')await p.keyboard.insertText('X');else await p.keyboard.press(key);
    await exact(text);assert(!(await read()).dialog,'partial data/syntax edits are rejected, not offered as whole-image deletion');
   }
   await shot(trace,id+'-guarded');return{metadataEditable:true,fullConcealment:true,partialEditsBlocked:true};
  });}
  if(wanted('backup-delete-cancel-direct-history'))await record('backup-delete-cancel-direct-history',async trace=>{
   const mark='![Preview]('+URI+')',text='# Backup\n\n'+mark+'\n\nAFTER\n',file=await open('backup-choice',text),deleted=text.replace(mark,'');
   await waitUntil(()=>image().evaluate(e=>e.naturalWidth>0),'image decoded');await menuDelete();await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await exact(text);await shot(trace,'backup-choice');
   await p.keyboard.press('Escape');await exact(text);assert(!(await read()).dialog,'Escape cancels');
   await menuDelete();await choose('direct');await exact(deleted);await p.keyboard.press('Control+z');await exact(text);
   await p.keyboard.press('Control+y');await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await exact(text);await choose('cancel');await exact(text);
   await p.keyboard.press('Control+y');await choose('backup');await exact(deleted);
   const files=fs.readdirSync(path.join(dir,'assets')).filter(f=>f.startsWith('embedded-image-'));assert.equal(files.length,1);assert(fs.readFileSync(path.join(dir,'assets',files[0])).equals(Buffer.from(SVG)),'backup bytes are original image bytes');
   await p.keyboard.press('Control+z');await exact(text);await menuDelete();await choose('backup');await exact(deleted);assert.equal(fs.readdirSync(path.join(dir,'assets')).filter(f=>f.startsWith('embedded-image-')).length,1,'identical bytes reuse existing backup');
   await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')===deleted,'saved deletion');await shot(trace,'backup-complete');return{backupSha256:sha256(path.join(dir,'assets',files[0])),cancel:true,redoStillAvailable:true,deduplicated:true};
  });
  if(wanted('native-cell-paste-conceals-new-image'))await record('native-cell-paste-conceals-new-image',async trace=>{
   const text='# Cell paste\n\n| Picture | Keep |\n|---|---|\n| ab | SAFE |\n\nAFTER\n';await open('cell-paste',text);
   await p.locator('.mp-row td').filter({hasText:'ab'}).first().click({delay:65});await p.keyboard.press('End');const before=await read();assert(before.cell);
   const md='![Preview]('+URI+')';assert((await p.evaluate(text=>window.mpHost.writeClipboard({text},window.mpHost.beginClipboardIntent('copy')),md)).ok);assert(clipboard.verifyText(md).matches);
   await p.keyboard.press('Control+v');await sleep(200);assert(clipboard.verifyText(md).matches);const expected=text.slice(0,before.selection.head)+md+text.slice(before.selection.head);await exact(expected);
   const pasted=await shot(trace,'cell-pasted');assert(!pasted.cell&&!pasted.body.includes(URI),'new embedded cell uses protected CM surface');assert(pasted.chips.length);
   await p.keyboard.press('Control+z');await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await exact(expected);await choose('cancel');await exact(expected);
   await p.keyboard.press('Control+z');await choose('direct');await exact(text);await p.keyboard.press('Control+y');await exact(expected);await shot(trace,'cell-redone');return{nativePaste:true,undoChoice:true,oneHistory:true};
  });
  if(wanted('duplicate-percent-backup-keeps-name-collision'))await record('duplicate-percent-backup-keeps-name-collision',async trace=>{
   const uri='data:image/svg+xml,'+encodeURIComponent(SVG),mark='![Preview]('+uri+')',text=mark+'\n\n'+mark+'\n';
   const file=await open('collision/image',text),assets=path.join(path.dirname(file),'assets');fs.mkdirSync(assets);
   const name='embedded-image-'+crypto.createHash('sha256').update(SVG).digest('hex').slice(0,16)+'.svg',existing=path.join(assets,name);fs.writeFileSync(existing,'EXISTING FILE OWNER');
   await p.keyboard.press('Control+a');await p.keyboard.press('Backspace');await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await exact(text);
   assert((await p.locator('dialog.mp-image-removal-dialog p').first().textContent()).includes('2 张'));
   await p.keyboard.press('Tab');await p.keyboard.press('Tab');assert(await p.locator('[data-image-removal="cancel"]').evaluate(e=>e===document.activeElement),'keyboard focus reaches Cancel');
   await p.keyboard.press('Tab');assert(await p.locator('[data-image-removal="backup"]').evaluate(e=>e===document.activeElement),'modal wraps focus');
   await choose('backup');await exact('');assert.equal(fs.readFileSync(existing,'utf8'),'EXISTING FILE OWNER');
   const added=fs.readdirSync(assets).filter(f=>f!==name);assert.equal(added.length,1,'identical image occurrences share one backup');assert(fs.readFileSync(path.join(assets,added[0])).equals(Buffer.from(SVG)),'percent data decoded losslessly');
   await p.keyboard.press('Control+z');await exact(text);await shot(trace,'collision-restored');return{duplicateCount:2,backupCount:1,percentBytes:true,collisionUntouched:true,focusTrap:true};
  });
  if(wanted('search-replace-protects-payload-keeps-metadata'))await record('search-replace-protects-payload-keeps-metadata',async trace=>{
   const text='![Preview]('+URI+')\n\nAFTER\n';await open('search-image',text);
   await p.locator('[data-mp-id="find-replace"]').click({delay:65});
   const query=p.locator('.cm-search input[name="search"]'),replacement=p.locator('.cm-search input[name="replace"]');await query.waitFor();
   await query.fill(URI.slice(40,70));await replacement.fill('X');await p.locator('.cm-search button[name="replaceAll"]').click({delay:65});await exact(text);assert(!(await read()).dialog,'partial payload replacement does not prompt');
   await query.fill('Preview');await replacement.fill('Changed');await p.locator('.cm-search button[name="replaceAll"]').click({delay:65});await exact(text.replace('Preview','Changed'));assert(!(await read()).dialog,'metadata remains editable');
   await shot(trace,'search-payload-blocked-metadata-changed');return{realSearchEntry:true,payloadReplacementBlocked:true,metadataReplacement:true};
  });
  if(wanted('backup-failure-keeps-original'))await record('backup-failure-keeps-original',async trace=>{
   const text='![Preview]('+URI+')\n\nAFTER\n';await open('write-blocked/image',text);const blocker=path.join(dir,'write-blocked/assets');fs.writeFileSync(blocker,'KEEP ASSET NAME OWNER');
   await waitUntil(()=>image().evaluate(e=>e.naturalWidth>0),'image decoded');await menuDelete();await p.locator('[data-image-removal="backup"]').click({delay:65});
   await waitUntil(()=>p.locator('.mp-image-removal-status').textContent().then(t=>t.includes('原图已保留')),'write failure is explicit');await exact(text);assert.equal(fs.readFileSync(blocker,'utf8'),'KEEP ASSET NAME OWNER');await shot(trace,'backup-write-failed');await choose('cancel');await exact(text);return{failurePreservesImage:true,existingFileUntouched:true};
  });
  if(wanted('unsaved-and-replaced-document'))await record('unsaved-and-replaced-document',async trace=>{
   p=await newBlankWindow(run,run.page);p.on('pageerror',e=>r.errors.push(e.message));await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'blank owner');
   const text='![Preview]('+URI+')\n\nAFTER\n';await p.keyboard.insertText(text);await exact(text);await p.keyboard.press('Control+a');await p.keyboard.press('Backspace');await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await exact(text);assert(await p.locator('[data-image-removal="backup"]').isDisabled());await shot(trace,'unsaved-choice');await choose('cancel');await exact(text);
   await open('stale-before',text);await waitUntil(()=>image().evaluate(e=>e.naturalWidth>0),'image decoded');await menuDelete();await p.locator('dialog.mp-image-removal-dialog[open]').waitFor();await exact(text);
   const other=path.join(dir,'stale-after.md');fs.writeFileSync(other,'OTHER DOCUMENT\n');assert((await p.evaluate(file=>window.mpHost.openPath(file),other)).ok);await waitUntil(()=>p.evaluate(()=>window.mpEngine.getValue()==='OTHER DOCUMENT\n'),'new document');assert(!(await read()).dialog,'old choice retired');await exact('OTHER DOCUMENT\n');return{unsavedBackupDisabled:true,staleChoiceCanceled:true};
  });
 }catch(e){r.fatal=e.stack;}finally{
  try{if(clip)Object.assign(r.clipboard,await clip.restore());}catch(e){r.clipboard.error=e.message;}
  try{if(run)r.cleanup=await run.cleanup();}catch(e){r.cleanupError=e.message;}release();
  r.passed=r.cases.length>0&&r.cases.every(c=>c.status==='pass')&&!r.fatal&&!r.errors.length&&!r.cleanupError&&!r.clipboard.error&&!r.cleanup?.residual?.length;
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(r,null,2));console.log(JSON.stringify({passed:r.passed,cases:r.cases.map(c=>({id:c.id,status:c.status,error:c.error})),errors:r.errors,fatal:r.fatal,cleanup:r.cleanup,clipboard:r.clipboard.restored}));if(!r.passed)process.exitCode=1;
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
