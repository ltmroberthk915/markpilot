const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Menu,clipboard,ClipboardItem}=require('electron');
exports.runShellRepairs=async({win,ev,until,output})=>{
  const results=[],pass=s=>results.push('PASS '+s),delay=ms=>new Promise(r=>setTimeout(r,ms));
  const frame='document.getElementById("editor").contentWindow';
  const file=path.join(output,'图片 演示 (#1).md');fs.writeFileSync(file,'# 图片\n\nalpha beta\n');
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
  await until(`${frame}.vditor?.vditor?.__typoraPatched&&${frame}.vditor.getValue().includes('alpha beta')`);
  await ev(`(()=>{const w=${frame},root=w.vditor.vditor.ir.element,t=root.querySelector('p').firstChild,r=w.document.createRange();r.setStart(t,0);r.setEnd(t,5);w.focus();root.focus();w.getSelection().removeAllRanges();w.getSelection().addRange(r);})()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'U',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'U',modifiers:['control']});
  await until(`${frame}.vditor.getValue().includes('<u>alpha</u>')`);await delay(300);await global.doc.save();
  assert.ok(fs.readFileSync(file,'utf8').includes('<u>alpha</u>'));pass('Native desktop Ctrl+U saves real underline without a paragraph command');
  const menu=Menu.getApplicationMenu().items.find(i=>i.label==='编辑(&E)');menu.submenu.items.find(i=>i.label==='替换…').click();
  await until(`!!${frame}.document.getElementById('typora-find')`);
  await ev(`(()=>{const w=${frame};w.document.querySelector('#typora-find [data-field=query]').value='beta';w.document.querySelector('#typora-find [data-field=replace]').value='替换完成';w.vditor.__typoraFind.search();})()`);
  await until(`!${frame}.vditor.__typoraFind.state.pending`);
  await ev(`${frame}.vditor.__typoraFind.replace(true)`);await delay(400);await global.doc.save();
  assert.ok(fs.readFileSync(file,'utf8').includes('替换完成'));pass('Desktop Replace menu edits and saves through the real host');
  await ev(`${frame}.vditor.__typoraFind.close()`);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6kAAAAASUVORK5CYII=';
  await ev(`(()=>{const w=${frame},root=w.vditor.vditor.ir.element;w.focus();root.focus();w.getSelection().collapse(root,root.childNodes.length);const png=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0));w.vditor.vditor.options.upload.handler([new w.File([png],'小图.png',{type:'image/png'}),new w.File(['<svg xmlns="http://www.w3.org/2000/svg" width="36" height="24"><rect width="36" height="24" fill="blue"/></svg>'],'矢量图.svg',{type:'image/svg+xml'})]);})()`);
  await until(`${frame}.document.querySelectorAll('.vditor-ir img').length>=2`);
  await until(`[...${frame}.document.querySelectorAll('.vditor-ir img')].every(img=>img.complete&&img.naturalWidth>0)`);
  await delay(350);await global.doc.save();
  const md=fs.readFileSync(file,'utf8'),embedded=[...md.matchAll(/!\[[^\]]*\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/]+={0,2})\)/g)].map(match=>({data:match[1],mime:match[1].slice(5,match[1].indexOf(';'))}));
  assert.equal(embedded.length,2);assert.deepEqual(new Set(embedded.map(item=>item.mime)),new Set(['image/png','image/svg+xml']));
  assert.ok(embedded.some(item=>Buffer.from(item.data.slice(item.data.indexOf(',')+1),'base64').equals(Buffer.from(png,'base64'))));assert.equal((md.match(/file(?:\+|%2b)\.vscode-resource\.vscode-cdn\.net/gi)||[]).length,0);pass('Multiple images save as self-contained data URIs with exact bytes and formats');
  await ev(`(()=>{const w=${frame};w.vditor.setValue('temporary\\n',true);w.handler.emit('reload');})()`);
  await until(`${frame}.vditor.getValue().includes('vscode-resource')&&${frame}.document.querySelectorAll('.vditor-ir img').length>=2`);
  await until(`[...${frame}.document.querySelectorAll('.vditor-ir img')].every(img=>img.complete&&img.naturalWidth>0)`);pass('Saved relative image links render again after reloading the document');
  // Exercise Vditor's native image paste handler without altering user clipboard
  // permanently: restore all clipboard formats after this isolated test.
  if(!process.env.MD_EDITOR_TEST_SKIP_CLIPBOARD){
  const restoreClipboard=await require('./test-clipboard.cjs').preserveClipboard();
  try{
    win.focus();win.webContents.focus();
    const pastePNG=(await win.webContents.capturePage({x:0,y:0,width:4,height:4})).toPNG();
    await clipboard.write([new ClipboardItem({'image/png':new Blob([pastePNG],{type:'image/png'})})]);
    assert.ok(await clipboard.has('image/png'),'clipboard contains the test PNG');
    await ev(`(()=>{const w=${frame},root=w.vditor.vditor.ir.element;w.focus();root.focus();w.getSelection().collapse(root,root.childNodes.length)})()`);
    await ev(`(()=>{const w=${frame};w.document.addEventListener('paste',e=>w.__pasteProbe={types:[...e.clipboardData.types],files:[...e.clipboardData.files].map(f=>({type:f.type,size:f.size}))},{capture:true,once:true});})()`);
    win.webContents.paste();
    await delay(1200);
    fs.writeFileSync(path.join(output,'paste-probe.json'),JSON.stringify(await ev(`({event:${frame}.__pasteProbe})`),null,2));
    await until(`${frame}.document.querySelectorAll('.vditor-ir img').length>=3`,15000);await delay(350);await global.doc.save();pass('Native clipboard image paste reaches the upload pipeline');
  }finally{await restoreClipboard();}
  }
  await global.doc.save();const beforeTheme=global.doc.current.text;
  Menu.getApplicationMenu().items.find(i=>i.label==='查看(&V)').submenu.items.find(i=>i.label==='主题（含 Konayuki）…').click();
  await until(`!!${frame}.document.getElementById('typora-themes')`);pass('Desktop View menu opens the Konayuki theme chooser');
  await ev(`(()=>{const w=${frame};w.vditor.vditor.toolbar.elements['theme-settings'].querySelector('button').click();w.document.querySelector('#typora-themes [data-theme="konayuki-dark"]').click();w.document.querySelector('#typora-themes footer button').click()})()`);
  await until(`document.documentElement.dataset.editorTheme==='konayuki-dark'`);
  assert.equal(global.state.get('editorTheme'),'konayuki-dark');global.state.saveNow();assert.equal(new global.state.constructor({file:global.state.file}).get('editorTheme'),'konayuki-dark');pass('Konayuki theme persists and updates the desktop sidebar');
  await delay(400);assert.equal(global.doc.current.text,beforeTheme);assert.equal(global.doc.dirty,false);pass('Changing theme leaves saved documents clean');
  await ev(`(()=>{const w=${frame};w.vditor.__typoraFind.open(false);w.document.querySelector('#typora-find [data-mode=replace]').click();w.document.querySelector('#typora-find [data-field=replace]').focus()})()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until(`!${frame}.document.getElementById('typora-find')`);pass('Desktop iframe mode button and native Esc close replacement');
  fs.writeFileSync(path.join(output,'desktop-konayuki-dark.png'),(await win.webContents.capturePage()).toPNG());
  return results;
};
