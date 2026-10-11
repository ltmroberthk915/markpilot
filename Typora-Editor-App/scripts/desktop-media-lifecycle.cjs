// Real-main-process lifecycle coverage for the media/office feature set:
// paste→delete→save→undo→reopen, scaling undo/redo, editing while a save is
// in flight, external conflicts and deletion, read-only → save-as copy with
// relative-image embedding. GUI-only; run serially (never with Office open).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const checks=[],base=path.join(output,'media-lifecycle');
  fs.mkdirSync(base,{recursive:true});
  // A fresh workspace per run: crashed runs can leave watcher handles that
  // keep a deleted directory pending on Windows. Old ones are swept best-effort.
  for(const stale of fs.readdirSync(base)){if(stale.startsWith('workspace')){try{fs.rmSync(path.join(base,stale),{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{/* swept next time */}}}
  const root=path.join(base,'workspace-'+Date.now());fs.mkdirSync(root,{recursive:true});
  const pass=text=>{checks.push('PASS '+text);console.log(checks.at(-1));};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const imageCount=text=>(text.match(/<img\b/gi)||[]).length;
  const markdownImageCount=text=>(text.match(/!\[[^\]]*\]\(/g)||[]).length;
  const noPseudoURLs=disk=>assert.ok(!/file\+\.vscode-resource\.vscode-cdn\.net/.test(disk),'disk text must never contain internal cache URLs');
  const {nativeImage,dialog}=require('electron'),bitmap=Buffer.alloc(640*320*4);
  for(let y=0;y<320;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;bitmap[i]=x%256;bitmap[i+1]=y%256;bitmap[i+2]=160;bitmap[i+3]=255;}
  const png=nativeImage.createFromBitmap(bitmap,{width:640,height:320}).toPNG();
  // Always target the CURRENT editor iframe via the shell's iframe element:
  // after closeDoc/openFile both the old and new frames can coexist, and a
  // frames.find() lookup may hit the stale one (same-origin eval is exact).
  const fe=code=>win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w||!w.vditor)throw new Error('editor frame not ready');return w.eval(${JSON.stringify(code)});})()`,true);
  const waitImage=async()=>{for(let i=0;i<200;i++){if(await fe(`!!document.querySelector('.vditor-ir img')?.naturalWidth`))break;await pause(30);}assert.equal(await fe(`document.querySelector('.vditor-ir img')?.naturalWidth`),640,'embedded image must decode at original pixels');};
  const upload=`vditor.vditor.options.upload.handler([new File([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0))],'插入图.png',{type:'image/png'})])`;
  const originalDialog=dialog.showSaveDialog,originalBox=dialog.showMessageBoxSync;
  // Wait for the iframe of the CURRENT docVersion AND for the late 'open'
  // push (gated on completions.ready) to have applied cur.text: the frame's
  // own readiness races that push, which would otherwise overwrite edits.
  const waitForEditor=async()=>{
    const version=global.doc.docVersion;
    // contentWindow.location (not the src attribute): during navigation the
    // attribute already points at the new document while the old document is
    // still live and would answer probes with stale content.
    await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{return !!w&&w.location.search.includes('v=${version}')&&!!w.vditor?.__media&&!!w.vditor?.__completion;}catch{return false;}})()`);
    for(let i=0;i<200;i++){if(global.doc.current.text===await fe(`vditor.getValue()`).catch(()=>''))return;await pause(30);}
    throw new Error('editor did not receive the open content in time');
  };
  let boxAnswer=0;dialog.showMessageBoxSync=()=>boxAnswer;
  try{
    // ---- 1. paste screenshot → delete → save → undo → reopen -----------------
    const file=path.join(root,'lifecycle.md');fs.writeFileSync(file,'# Lifecycle\n\nBefore $x+1$.\n\nAfter.\n');
    await global.doc.openFile(file);await waitForEditor();
    global.doc.setSetting('autoSave',false);
    await fe(upload);
    for(let i=0;i<200;i++){if(global.doc.current.text.includes('vscode-cdn.net')&&await fe(`!!document.querySelector('.vditor-ir img')?.naturalWidth`))break;await pause(30);}
    assert.ok(global.doc.current.text.includes('![插入图](')&&!global.doc.current.text.includes('base64,'),'upload keeps compact text');
    await waitImage();
    // Delete through the real editing path: setValue is programmatic and
    // never emits input, so select the image marker and delete it instead.
    await fe(`(()=>{const img=document.querySelector('.vditor-ir img');const r=document.createRange();r.selectNode(img.closest('[data-type="img"]')||img);const s=getSelection();s.removeAllRanges();s.addRange(r);return document.execCommand('delete');})()`);
    for(let i=0;i<100&&global.doc.current.text.includes('插入图');i++)await pause(30);
    assert.ok(!global.doc.current.text.includes('插入图'),'deletion reaches the document model before saving');
    assert.equal(await global.doc.save(),true);
    let disk=fs.readFileSync(file,'utf8');assert.ok(!disk.includes('data:image'),'deleted image is gone from disk');noPseudoURLs(disk);
    await fe(`vditor.vditor.undo.undo(vditor.vditor);true`);
    for(let i=0;i<100&&!global.doc.current.text.includes('![插入图](');i++)await pause(30);
    assert.ok(global.doc.current.text.includes('![插入图]('),'undo restores the image reference');
    assert.equal(await global.doc.save(),true);
    disk=fs.readFileSync(file,'utf8');assert.ok(disk.includes('data:image/png;base64,'),'undo then save embeds the image again');
    assert.ok(disk.includes(png.toString('base64').slice(0,200)),'original PNG bytes round-trip');
    noPseudoURLs(disk);
    global.doc.closeDoc();assert.equal(await global.doc.openFile(file),true);
    await waitForEditor();
    await waitImage();
    pass('Paste→delete→save→undo→reopen keeps every byte of the embedded image and never leaves cache URLs on disk');

    // ---- 2. scale 50% then undo/redo (pixels vs display size) ----------------
    await fe(`vditor.__media.setScale(document.querySelector('.vditor-ir img'),50);true`);
    for(let i=0;i<100&&!global.doc.current.text.includes('width="320"');i++)await pause(30);
    assert.equal(imageCount(global.doc.current.text),1,'scaling replaces the uploaded Markdown image in place');
    assert.equal(markdownImageCount(global.doc.current.text),0,'scaled source has one canonical HTML image');
    assert.ok(global.doc.current.text.includes('data-typora-scale="50"'));
    assert.equal(await fe(`document.querySelector('.vditor-ir img').naturalWidth`),640,'display scaling never resamples pixels');
    await fe(`vditor.vditor.undo.undo(vditor.vditor);true`);
    for(let i=0;i<100&&global.doc.current.text.includes('width="320"');i++)await pause(30);
    assert.equal(imageCount(global.doc.current.text),0,'undo removes the generated HTML image');
    assert.equal(markdownImageCount(global.doc.current.text),1,'undo restores the original Markdown image');
    assert.ok(!global.doc.current.text.includes('width="320"'),'undo removes the display width');
    await fe(`vditor.vditor.undo.redo(vditor.vditor);true`);
    for(let i=0;i<100&&!global.doc.current.text.includes('width="320"');i++)await pause(30);
    assert.equal(imageCount(global.doc.current.text),1,'redo restores one canonical HTML image');
    assert.equal(markdownImageCount(global.doc.current.text),0,'redo does not append a second Markdown image');
    assert.equal(await global.doc.save(),true);
    disk=fs.readFileSync(file,'utf8');assert.equal(imageCount(disk),1);assert.equal(markdownImageCount(disk),0);assert.equal((disk.match(/data:image\//gi)||[]).length,1);assert.ok(disk.includes('width="320"')&&disk.includes('data:image/png;base64,'),'scaled image saves original pixels plus display width');
    noPseudoURLs(disk);
    pass('Image scaling is undoable/redoable while the saved file keeps original pixels with the 50% display width');

    // ---- 3. keep editing while a save is in flight ---------------------------
    const typeAtEnd=text=>fe(`(()=>{const r=vditor.vditor.ir.element;r.focus();getSelection().collapse(r,r.childNodes.length);document.execCommand('insertText',false,${JSON.stringify(text)});})()`);
    await typeAtEnd('第一段');
    for(let i=0;i<100&&!global.doc.current.dirty;i++)await pause(30);
    assert.ok(global.doc.current.dirty,'first edit marks the document dirty');
    const saving=global.doc.save(); // start the real write, do not await yet
    await typeAtEnd('保存期间的编辑'); // lands while/around the pending write
    await saving; // manual saves re-loop while dirty, then settle
    for(let i=0;i<200&&!global.doc.current.text.includes('保存期间的编辑');i++)await pause(30); // late input round-trips through the completion chain
    if(global.doc.dirty)assert.equal(await global.doc.save(),true);
    let settled=false;for(let i=0;i<200;i++){const d=fs.readFileSync(file,'utf8');if(d.includes('第一段')&&d.includes('保存期间的编辑')){settled=true;break;}await pause(30);}
    assert.ok(settled,'both edits reach disk');
    noPseudoURLs(fs.readFileSync(file,'utf8'));
    pass('Typing during a save stays in the editor and reaches disk on the next save');

    // ---- 4. external modification conflict, then deletion and rebuild --------
    fs.writeFileSync(file,disk.replace('# Lifecycle','# 外部修改'));
    for(let i=0;i<200&&!global.doc.current.text.includes('外部修改');i++)await pause(30); // clean state → editor follows disk
    assert.ok(global.doc.current.text.includes('外部修改'),'external update reloads into the editor');
    await fe(`(()=>{const r=vditor.vditor.ir.element;r.focus();getSelection().collapse(r,r.childNodes.length);document.execCommand('insertText',false,'后补');})()`);
    for(let i=0;i<100&&!global.doc.current.dirty;i++)await pause(30);
    fs.writeFileSync(file,fs.readFileSync(file,'utf8')+'外部又改');
    for(let i=0;i<200&&!global.doc.current.externalConflict;i++)await pause(30);
    assert.ok(global.doc.current.externalConflict,'conflict is detected and autosave paused');
    boxAnswer=0; // overwrite disk with the window's version
    assert.equal(await global.doc.save(),true);
    assert.ok(fs.readFileSync(file,'utf8').includes('后补')&&fs.readFileSync(file,'utf8').includes('外部修改'),'explicit overwrite keeps every keystroke');
    fs.rmSync(file);
    for(let i=0;i<200&&!global.doc.current.deleted;i++)await pause(30);
    assert.ok(global.doc.current.deleted&&global.doc.current.dirty,'deleted file keeps content and flags dirty');
    assert.equal(await global.doc.save(),true);
    disk=fs.readFileSync(file,'utf8');assert.ok(disk.includes('后补'),'Ctrl+S rebuilds the deleted file');
    noPseudoURLs(disk);
    pass('External conflicts pause autosave, explicit overwrite wins, and a deleted file is rebuilt by Ctrl+S');

    // ---- 5. read-only source → save-as copy embeds relative images -----------
    const rel=path.join(root,'rel');fs.mkdirSync(rel,{recursive:true});
    fs.writeFileSync(path.join(rel,'image.png'),png);
    const locked=path.join(rel,'locked.md');fs.writeFileSync(locked,'# 只读源\n\n![相对图](image.png)\n\n正文。\n');
    fs.chmodSync(locked,0o444);
    await global.doc.openFile(locked);await waitForEditor();
    assert.ok(global.doc.current.text.includes('![相对图](image.png)'),'relative reference stays as text while editing');
    await fe(`(()=>{const r=vditor.vditor.ir.element;r.focus();getSelection().collapse(r,r.childNodes.length);document.execCommand('insertText',false,'新内容');})()`);
    for(let i=0;i<100&&!global.doc.current.dirty;i++)await pause(30);
    const copy=path.join(root,'elsewhere','独立副本.md');
    dialog.showSaveDialog=async()=>({canceled:false,filePath:copy});
    boxAnswer=1; // 保存失败对话框选择「另存为副本…」
    assert.equal(await global.doc.save(),true);
    const saved=fs.readFileSync(copy,'utf8');
    assert.ok(saved.includes('data:image/png;base64,')&&saved.includes('新内容'),'copy embeds the relative image with the new text');
    assert.ok(saved.includes(png.toString('base64').slice(0,200)));
    assert.ok(fs.readFileSync(locked,'utf8').includes('![相对图](image.png)'),'read-only source file is untouched');
    noPseudoURLs(saved);
    fs.renameSync(path.join(rel,'image.png'),path.join(root,'moved-away.png')); // prove self-containment
    global.doc.closeDoc();assert.equal(await global.doc.openFile(copy),true);
    await waitForEditor();
    await waitImage();
    fs.chmodSync(locked,0o644);
    pass('Read-only save failure offers save-as; the copy embeds relative images and opens standalone anywhere');
  }finally{
    dialog.showSaveDialog=originalDialog;dialog.showMessageBoxSync=originalBox;
  }
  fs.writeFileSync(path.join(output,'media-lifecycle','results.json'),JSON.stringify(checks,null,2));
  return checks;
};
