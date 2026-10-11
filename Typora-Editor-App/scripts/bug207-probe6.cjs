// v2.0.7 P4 probe6: what does sendInputEvent Ctrl+= actually deliver to the iframe?
exports.run=async({win})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  await fe(`(()=>{
    window.__k=[];
    document.addEventListener('keydown',e=>{window.__k.push({key:e.key,code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,defaultPrevented:e.defaultPrevented});},true);
    return true;})()`);
  // 先点编辑区聚焦
  const fr=await win.webContents.executeJavaScript(`document.getElementById('editor').getBoundingClientRect().toJSON()`,true);
  const x=Math.round(fr.left+200),y=Math.round(fr.top+150);
  win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
  await pause(200);
  await fe('window.__k=[];true');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});
  await pause(150);
  console.log('[after-backspace]',JSON.stringify(await fe('window.__k')));
  await fe('window.__k=[];true');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'='});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'='});
  await pause(150);
  console.log('[after-bare-eq]',JSON.stringify(await fe('window.__k')));
  await fe('window.__k=[];true');
  // 先按下 Control 本身，再按 =（某些合成输入路径只认独立修饰键事件）
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Control'});
  await pause(60);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'='});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'='});
  await pause(60);
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Control'});
  await pause(150);
  console.log('[after-ctrl-then-eq]',JSON.stringify(await fe('window.__k')));
  console.log('[focus]',JSON.stringify(await fe(`({tag:document.activeElement?.tagName,cls:String(document.activeElement?.className).slice(0,40),editable:!!document.activeElement?.isContentEditable})`)));
  console.log('[zoom-now]',await fe(`document.querySelector('.vditor-content')?.style.zoom||'100%'`));
};
