const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {Menu} = require('electron');

exports.runShellFeatures = async ({win, ev, until, output}) => {
  const results = [];
  const pass = text => {results.push('PASS '+text);};
  const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const iframe='document.getElementById("editor").contentWindow';
  const fixtureDir=path.join(output,'recent-fixtures');
  fs.mkdirSync(fixtureDir,{recursive:true});
  const first=path.join(fixtureDir,'first.md'),second=path.join(fixtureDir,'second.md');
  fs.writeFileSync(first,'alpha beta\n\nsecond line\n');
  fs.writeFileSync(second,'# Other file\n\nother text\n');
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(first)}})`);
  await until(`${iframe}.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes('alpha beta')`);
  await ev(`(() => {const w=${iframe},root=w.vditor.vditor.ir.element;w.focus();root.focus();const t=root.querySelector('p').firstChild;const range=w.document.createRange();range.setStart(t,0);range.setEnd(t,5);w.getSelection().removeAllRanges();w.getSelection().addRange(range)})()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});
  await until(`${iframe}.vditor.getValue().includes('$alpha$')`);
  await delay(350);
  assert.ok(global.doc.current.text.includes('$alpha$'));
  pass('Native desktop Ctrl+Shift+E wraps selection and updates the host');
  const dirty=global.doc.current.text;
  const opened=await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(first)}})`);
  assert.equal(opened.ok,true);assert.equal(global.doc.current.text,dirty);assert.equal(global.doc.dirty,true);
  pass('Reopening the current recent file preserves unsaved content');
  const before=global.state.recent();const confirm=global.doc.confirmDiscard;
  global.doc.confirmDiscard=async()=>false;
  try {
    const cancelled=await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(second)}})`);
    assert.equal(cancelled.ok,false);assert.equal(global.doc.file,first);assert.deepEqual(global.state.recent(),before);
  } finally {global.doc.confirmDiscard=confirm;}
  pass('Cancelling a recent-file switch preserves document and ordering');
  await global.doc.save();
  const missing=await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(path.join(fixtureDir,'missing.md'))}})`);
  assert.equal(missing.ok,false);assert.deepEqual(global.state.recent(),before);
  pass('Failed recent-file opening does not enter or reorder the history');
  for(let i=0;i<55;i++) {
    const folder=path.join(fixtureDir,'folder-'+i);fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'教材-'+i+'.md');fs.writeFileSync(file,'# Recent '+i+'\n');
    global.state.pushRecent('recentFolders',folder);global.state.pushRecent('recentFiles',file);
  }
  await ev(`document.getElementById('btn-recent').click()`);
  await until(`document.getElementById('recent-dialog').open && document.querySelectorAll('#recent-files .recent-link').length===50`);
  assert.equal(await ev(`document.querySelectorAll('#recent-folders .recent-link').length`),50);
  pass('Recent dialog exposes all 50 files and all 50 folders');
  fs.writeFileSync(path.join(output,'recent-dialog.png'),(await win.webContents.capturePage()).toPNG());
  await ev(`(() => {const input=document.getElementById('recent-search');input.value='教材-20';input.dispatchEvent(new Event('input'))})()`);
  assert.equal(await ev(`document.querySelectorAll('#recent-files .recent-link').length`),1);
  pass('Recent links filter by filename and path');
  await ev(`document.querySelector('#recent-files .recent-link').click()`);
  const chosen=path.join(fixtureDir,'folder-20','教材-20.md');
  await until(`!document.getElementById('recent-dialog').open`);
  // 2.1.0 多窗口：点「最近打开」里的文件会**在它自己的新窗口**里打开，当前窗口的文档
  // 不动（这正是用户要的「开一个不顶掉旧的」）。所以这里断言的是「有窗口打开了它 +
  // 历史把它提到最前 + 当前窗口没被替换」，而不是「当前窗口的文档换了」。
  const hasChosen=`(await hostApi.invoke('windows-list')).some(w=>w.file&&w.file.toLowerCase()===${JSON.stringify(chosen.toLowerCase())})`;
  await until(`(async()=>${hasChosen})()`);
  assert.equal(await ev(`(async()=>${hasChosen})()`),true);
  assert.notEqual(global.doc.file,chosen);
  assert.equal(global.state.get('recentFiles')[0],chosen);
  assert.equal(global.state.get('recentFiles').length,50);
  pass('A recent file link opens the file in its own window and promotes it without duplicates');
  await ev(`document.getElementById('btn-recent').click()`);
  await until(`document.getElementById('recent-dialog').open`);
  await ev(`(() => {const input=document.getElementById('recent-search');input.value='folder-10';input.dispatchEvent(new Event('input'));document.querySelector('#recent-folders .recent-link').click()})()`);
  await until(`!document.getElementById('recent-dialog').open`);
  assert.equal(global.workspace.root,path.join(fixtureDir,'folder-10'));
  assert.equal(global.state.get('recentFolders')[0],global.workspace.root);
  pass('A recent folder link opens the workspace and promotes it');
  global.state.saveNow();
  const restored=new global.state.constructor({file:global.state.file});
  assert.deepEqual(restored.recent(),global.state.recent());
  pass('Both 50-entry recent histories survive a state reload');
  const editMenu=Menu.getApplicationMenu().items.find(item=>item.label==='编辑(&E)');
  editMenu.submenu.items.find(item=>item.label==='快捷键设置…').click();
  await until(`!!document.getElementById('typora-shortcuts')?.open`);
  fs.writeFileSync(path.join(output,'shortcut-settings.png'),(await win.webContents.capturePage()).toPNG());
  await ev(`(() => {const input=document.querySelector('#typora-shortcuts input[data-action="math"]');input.dispatchEvent(new KeyboardEvent('keydown',{key:'M',code:'KeyM',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));document.querySelector('#typora-shortcuts [data-action="save"]').click()})()`);
  await until(`!document.getElementById('typora-shortcuts')`);
  assert.equal(global.state.get('editorShortcuts').math,'Ctrl+Alt+M');
  pass('Desktop menu opens shared shortcut settings and persists the change');
  // The remapped math shortcut is persisted in this profile; every path out
  // of the suite below must restore defaults or the NEXT run starts with
  // math mapped to Ctrl+Alt+M and fails its own Ctrl+Shift+E probe.
  const restoreShortcuts = () => ev(`hostApi.invoke('shortcuts-set',{math:'Ctrl+Shift+E',quote:'Ctrl+Shift+Q',code:'Ctrl+Shift+K'})`).catch(()=>{});
  try {
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(second)}})`);
  await until(`${iframe}.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes('Other file')`);
  assert.equal(await ev(`JSON.parse(${iframe}.localStorage.getItem('typora-editor-shortcuts')).math`),'Ctrl+Alt+M');
  pass('Shortcut preferences carry across desktop documents');
  // Leftmost fixed status-bar buttons: folder sidebar and document outline.
  await until(`document.getElementById('st-files') && document.getElementById('st-outline') && document.getElementById('statusbar').style.display!=='none'`);
  assert.equal(await ev(`(() => {const bar=document.getElementById('statusbar'),first=bar.firstElementChild,btn=document.getElementById('st-files').getBoundingClientRect(),item=bar.querySelector('.st-item')?.getBoundingClientRect();return first.id==='st-actions'&&first.contains(document.getElementById('st-files'))&&first.contains(document.getElementById('st-outline'))&&(!item||btn.left<=item.left)})()`),true);
  pass('Status bar keeps the folder-sidebar and outline buttons at the fixed bottom-left');
  const sidebarHiddenBefore=await ev(`document.getElementById('app').classList.contains('sb-hidden')`);
  const fixedBefore=await ev(`document.getElementById('st-files').getBoundingClientRect().left`);
  await ev(`document.getElementById('st-files').click()`);
  await until(`document.getElementById('app').classList.contains('sb-hidden')===${!sidebarHiddenBefore}`);
  await delay(200);
  const fixedAfter=await ev(`document.getElementById('st-files').getBoundingClientRect().left`);
  assert.equal(fixedAfter,fixedBefore,'The status bar must not shift when the folder sidebar expands');
  await ev(`document.getElementById('st-files').click()`);
  await until(`document.getElementById('app').classList.contains('sb-hidden')===${sidebarHiddenBefore}`);
  pass('The bottom-left buttons keep the whole status bar fixed while the folder sidebar opens and closes');
  await until(`!!${iframe}.vditor?.vditor?.outline?.element`);
  const outlineShownBefore=await ev(`${iframe}.vditor.vditor.outline.element.offsetWidth>0`);
  await ev(`document.getElementById('st-outline').click()`);
  await until(`${iframe}.vditor.vditor.outline.element.offsetWidth>0===${!outlineShownBefore}`);
  await ev(`document.getElementById('st-outline').click()`);
  await until(`${iframe}.vditor.vditor.outline.element.offsetWidth>0===${outlineShownBefore}`);
  pass('The bottom-left outline button opens and closes the document outline through the editor');
  } finally {
    // Restore defaults in the disposable test profile for repeated runs,
    // including when an assertion above throws.
    await restoreShortcuts();
  }
  return results;
};
