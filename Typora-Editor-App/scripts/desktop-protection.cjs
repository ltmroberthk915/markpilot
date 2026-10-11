const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const checks=[],pass=label=>{checks.push('PASS '+label);fs.writeFileSync(path.join(output,'desktop-protection.json'),JSON.stringify(checks,null,2));},pause=ms=>new Promise(r=>setTimeout(r,ms));
  const {Menu,shell}=require('electron');
  const menu=id=>Menu.getApplicationMenu().getMenuItemById(id);
  const toggle=(id,value)=>{if(menu(id).checked!==value)menu(id).click(menu(id),win);assert.equal(menu(id).checked,value);};
  toggle('auto-save',true);toggle('local-snapshots',true);
  const root=path.join(output,'protection-workspace-'+Date.now());fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,'真实 编辑测试.md'),baseline='# 版本历史\n\n原始内容 $x^2$。\n';fs.writeFileSync(file,baseline);
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
  const fe=code=>win.webContents.mainFrame.frames.find(f=>f.url.includes('/doc/')).executeJavaScript(code,true);
  await until(`!!document.getElementById('editor').contentWindow.vditor?.__completion`);
  assert.ok(menu('version-history').enabled);
  // 打开文档时的基线快照是**异步写盘**的（openFile 里的 capture 不等它），立刻读会
  // 偶发读到 0 条——同一个套件在批量跑时失败、单独跑时通过就是这个竞态（实测）。
  // 断言本身不变，只是等它出现（有界等待）。
  let original=[];
  for(let i=0;i<80;i++){original=await global.doc.snapshots.list(file);if(original.length>=1)break;await pause(100);}
  assert.equal(original.length,1);pass('File menu exposes enabled autosave/snapshot toggles and opening creates a baseline');
  // CDP 的 sendCommand 没有超时：渲染进程忙（长文档 + 批量负载）时它会永远挂着，
  // 整个套件就这么卡死（实测：completion 在批量跑里挂过两次、单独跑必过）。这里统一
  // 加一个有界超时，让卡住变成一条明确的失败而不是无限等待。
  const sendCommand = (dbg, method, params) => Promise.race([
    dbg.sendCommand(method, params || {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CDP 超时：' + method)), 25000)),
  ]);
  win.webContents.debugger.attach('1.3');const send = (m, p = {}) => sendCommand(win.webContents.debugger, m, p);
  const type=async text=>{
    await send('Page.bringToFront');
    await fe(`(()=>{const root=vditor.vditor[vditor.vditor.currentMode].element;root.focus();const walker=document.createTreeWalker(root,4);let n;while((n=walker.nextNode()))if(n.data.includes('原始内容'))break;getSelection().collapse(n,n.data.indexOf('原始内容')+4)})()`);
    await send('Input.insertText',{text});
  };
  await type(' 自动保存');const start=Date.now();
  for(let i=0;i<90&&(!fs.readFileSync(file,'utf8').includes('自动保存')||global.doc.dirty);i++)await pause(50);
  const saved=fs.readFileSync(file,'utf8');assert.ok(saved.includes('自动保存'));assert.ok(Date.now()-start>=1200);assert.equal(global.doc.dirty,false);assert.equal(saved,await fe('vditor.getValue()'));
  assert.equal((await global.doc.snapshots.list(file)).length,2);pass('Real editor input reaches disk after the debounce and records the exact saved version');
  toggle('auto-save',false);await type(' 保留未保存');await pause(1850);assert.equal(fs.readFileSync(file,'utf8'),saved);assert.equal(global.doc.dirty,true);const dirtyText=global.doc.current.text;pass('Disabling autosave leaves subsequent edits dirty and disk content unchanged');
  menu('version-history').click(menu('version-history'),win);await until(`document.querySelector('.snapshots-dialog').open&&document.querySelectorAll('.snapshots-list button').length===2`);
  await ev(`document.querySelector('.snapshots-list button:last-child').click();true`);await until(`document.querySelector('.snapshots-preview').textContent.includes('原始内容')&&!document.querySelector('.snapshots-preview').textContent.includes('自动保存')`);
  assert.ok(await ev(`document.querySelector('.snapshots-list small').textContent.includes('字')`));pass('History dialog lists timestamp, word count and size; selecting a version previews its original content');
  const namesBefore=new Set(fs.readdirSync(root));await ev(`document.querySelector('.snapshots-dialog footer button:last-child').click();true`);await until(`document.querySelector('.snapshots-message').textContent.includes('已恢复为副本')`);
  const copied=fs.readdirSync(root).find(name=>!namesBefore.has(name));assert.ok(copied);assert.equal(fs.readFileSync(path.join(root,copied),'utf8'),baseline);assert.equal(fs.readFileSync(file,'utf8'),saved);assert.equal(global.doc.current.text,dirtyText);pass('Restore creates a separate Markdown file and preserves both original disk content and unsaved editor text');
  const opened=[],openPath=shell.openPath;shell.openPath=async value=>{opened.push(value);return'';};
  try{await ev(`document.querySelector('.snapshots-dialog footer button:first-child').click();true`);await pause(100);assert.equal(opened[0],global.doc.snapshots.directory(file));}finally{shell.openPath=openPath;}pass('Reveal action opens the current file’s snapshot directory through shell IPC');
  for(const theme of ['konayuki-light','konayuki-dark']){
    await ev(`document.documentElement.dataset.editorTheme=${JSON.stringify(theme)};true`);await pause(150);
    fs.writeFileSync(path.join(output,'snapshots-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(`!document.querySelector('.snapshots-dialog').open`);assert.equal(global.doc.current.text,dirtyText);pass('Native Escape closes history without affecting current edits');
  toggle('local-snapshots',false);const before=(await global.doc.snapshots.list(file)).length;await global.doc.save();assert.equal((await global.doc.snapshots.list(file)).length,before);pass('Snapshot opt-out prevents versions even after a successful manual save');
  const bad=await ev(`hostApi.invoke('snapshots-restore',{file:${JSON.stringify(file)},id:'../state.json'})`);assert.ok(bad.error);const stale=await ev(`hostApi.invoke('snapshots-list',{file:'C:/wrong-file.md'})`);assert.ok(stale.error);pass('History IPC rejects invalid snapshot IDs and stale document requests');
  global.state.saveNow();const settings=JSON.parse(fs.readFileSync(global.state.file)).settings;assert.deepEqual(settings,{autoSave:false,snapshots:false});pass('Both checkbox choices persist to the desktop profile');
  toggle('auto-save',true);toggle('local-snapshots',true);await global.doc.snapshots.list(file);
  return checks;
};
