// Runs the real application with a disposable profile, launch arguments and documents.
const {app, BrowserWindow, Menu, shell, clipboard, dialog} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const [application, scenario, output, forwardedPath] = process.argv.slice(2);
fs.mkdirSync(output,{recursive:true});
if(scenario!=='forward')require('./test-runtime-health.cjs').install({app,webFrameMain:require('electron').webFrameMain,output});
const profile = path.join(output, 'profile');
const fixtures = path.join(output, '文件 空格 # (fixtures)');
const first = path.join(fixtures, '第一份 # 教材.md');
const second = path.join(fixtures, '第二份 教材.markdown');
const previous = path.join(output, 'previous', 'previous.md');
const newTarget=path.join(fixtures,'新建 文档 # (test).md');
let nextSave={filePath:newTarget},saveDialogs=0;
const results = [];
const pass = text => {results.push('PASS ' + scenario + ': ' + text); console.log(results.at(-1));};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('userData', profile);
if (scenario === 'forward') {
  process.argv = [process.execPath, application, forwardedPath];
  require(path.join(application, 'app/main/main.js'));
} else {
  fs.mkdirSync(profile, {recursive: true});
  fs.mkdirSync(fixtures, {recursive: true});
  fs.mkdirSync(path.dirname(previous), {recursive: true});
  fs.writeFileSync(first, '# First launch\n\n正文 $x+1$\n');
  fs.writeFileSync(second, '# Second launch\n\n正文 $y+2$\n');
  fs.writeFileSync(previous, '# Previous session\n\n正文\n');
  fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify(scenario === 'empty' ? {} : {
    lastFile: previous, lastWs: path.dirname(previous), recentFiles: [previous], recentFolders: [path.dirname(previous)],
  }));
  if(scenario.startsWith('new-'))dialog.showSaveDialog=async()=>{saveDialogs++;return scenario==='new-cancel'?{canceled:true}:nextSave;};
  // Force the shell to load after the initial disk read: this reliably exercises
  // the cold-start race instead of depending on the speed of this machine.
  const loadURL = BrowserWindow.prototype.loadURL;
  BrowserWindow.prototype.loadURL = async function(url, ...args) {
    if (url.endsWith('/shell')) await delay(300);
    return loadURL.call(this, url, ...args);
  };
  // Test profiles must not compete with the user's application for its fixed port.
  const serverModule = require(path.join(application, 'app/main/server.js'));
  const startServer = serverModule.startServer;
  serverModule.startServer = options => startServer({...options, port: 0});
  process.argv = [process.execPath, application, ...(['cold','early','new-early'].includes(scenario) ? [first] : scenario === 'folder' ? [fixtures] : ['new-cold','new-cancel'].includes(scenario)?['--new-md']:[])];
  require(path.join(application, 'app/main/main.js'));
  if (scenario === 'early') {
    assert.equal(global.win, undefined, 'second launch must arrive before a window exists');
    app.emit('second-instance', {}, [process.execPath, application, path.basename(second)], fixtures);
  }
  if(scenario==='new-early')app.emit('second-instance',{},[process.execPath,application,'--new-md'],fixtures,{newFile:true});
  run().catch(async error => {
    console.error(error);
    console.error('Host document:', global.doc?.file);
    console.error('Host state:', JSON.stringify(global.doc?.current));
    if (global.win && !global.win.isDestroyed()) {
      console.error('Editor state:', await global.win.webContents.executeJavaScript(`(() => {const w=document.getElementById('editor')?.contentWindow;return {url:w?.location.href,value:w?.vditor?.vditor?.lute&&typeof w.vditor.getValue==='function'?w.vditor.getValue():null,selection:w?.getSelection()?.toString(),active:w?.document.activeElement?.className,patched:w?.vditor?.vditor?.__typoraPatched}})()`).catch(() => null));
    }
    app.exit(1);
  });
}
async function run() {
  await app.whenReady();
  const until = async (fn, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {if (await fn()) return;} catch {}
      await delay(50);
    }
    throw new Error('Timed out: ' + description);
  };
  await until(() => !!global.win, 'application window');
  const win = global.win;
  const ev = code => win.webContents.executeJavaScript(code, true);
  const iframe = 'document.getElementById("editor").contentWindow';
  await until(() => ev('document.readyState === "complete" && !!window.hostApi'), 'shell startup');
  if(scenario.startsWith('new-')) {
    await checkNewFile({ev,until,iframe});
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,scenario,results},null,2)+'\n');
    global.doc.closeWatch();global.state.saveNow();win.destroy();app.exit(0);return;
  }
  const expected = scenario === 'cold' ? first : scenario === 'early' ? second : scenario === 'restore' ? previous : null;
  if (expected) {
    await until(() => ev(`${iframe}?.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes(${JSON.stringify(scenario === 'restore' ? 'Previous session' : scenario === 'early' ? 'Second launch' : 'First launch')})`), 'requested document visible without clicking the tree');
    assert.equal(global.doc.file, expected);
    assert.equal(await ev('document.getElementById("welcome").style.display'), 'none');
    pass('launch or restored document is directly visible and editable');
    assert.equal(global.workspace.root, path.dirname(expected));
    assert.equal(global.state.get('recentFiles')[0], expected);
    pass('workspace and recent file follow the requested document');
  } else {
    await delay(400);
    assert.equal(global.doc.file, null);
    assert.equal(global.workspace.root, scenario === 'folder' ? fixtures : null);
    pass(scenario === 'folder' ? 'explicit folder takes priority over the previous document' : 'empty profile shows the welcome page');
  }
  if (scenario === 'cold') {
    // Send an actual second process through Electron's single-instance lock.
    const childCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, application, 'forward', output, path.basename(second)],
        {cwd: fixtures, env: process.env, windowsHide: true, stdio: 'inherit'});
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(childCode, 0);
    await until(() => ev(`${iframe}?.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes('Second launch')`), 'second instance document');
    assert.equal(global.doc.file, second);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    pass('second process opens its relative file in the existing window');
    await delay(300);
    await ev(`(() => {const w=${iframe},root=w.vditor.vditor.ir.element;w.focus();root.focus();w.getSelection().selectAllChildren(root.querySelector('h1'));w.getSelection().collapseToEnd()})()`);
    await win.webContents.insertText('直接编辑');
    await until(() => global.doc.dirty && global.doc.current.text.includes('直接编辑'), 'native edit reaches host');
    pass('native typing works immediately in the launched document');
    const before = global.doc.current.text;
    const recent = global.state.recent();
    const confirm = global.doc.confirmDiscard;
    global.doc.confirmDiscard = async () => false;
    app.emit('second-instance', {}, [process.execPath, application, first], fixtures);
    await delay(500);
    global.doc.confirmDiscard = confirm;
    assert.equal(global.doc.file, second); assert.equal(global.doc.current.text, before);
    assert.deepEqual(global.state.recent(), recent);
    pass('cancelling a double-click switch preserves unsaved text and recent order');
    const navigated = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await navigated;
    await until(() => ev(`${iframe}?.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes('直接编辑')`), 'shell reload restores unsaved document');
    assert.equal(global.doc.current.text, before); assert.equal(global.doc.dirty, true);
    pass('shell reload displays the in-memory document and preserves unsaved edits');
    await ev("hostApi.invoke('save')");
    assert.equal(fs.readFileSync(second, 'utf8'), before);
    pass('launched document saves to its original absolute path');
  }
  await checkFileActions({win, ev, until, iframe});
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({application, scenario, results}, null, 2) + '\n');
  global.doc.closeWatch();
  global.state.saveNow();
  win.destroy();
  app.exit(0);
}
async function checkNewFile({ev,until,iframe}) {
  await until(()=>saveDialogs===1,'new-file launch dialog');
  if(scenario==='new-cancel') {
    await delay(400);assert.equal(global.doc.file,null);assert.ok(!fs.existsSync(newTarget));
    assert.equal(global.state.get('lastFile'),previous);pass('cancelled cold create leaves the previous session and disk untouched');return;
  }
  await until(async()=>global.doc.file===newTarget && await ev(`${iframe}?.vditor?.vditor?.__typoraPatched`),'new file directly editable');
  assert.equal(global.doc.file,newTarget);assert.equal(global.doc.current.text,'');assert.equal(fs.readFileSync(newTarget,'utf8'),'');
  assert.equal(global.state.get('recentFiles')[0],newTarget);
  pass('new-file launch selects the created document and puts it first in recent files');
  const menu=Menu.getApplicationMenu().getMenuItemById('new-markdown');assert.ok(menu);assert.equal(menu.accelerator,'CmdOrCtrl+N');
  pass('File menu exposes New Markdown and Ctrl+N');
  if(scenario!=='new-cold')return;
  global.doc.setSetting('autoSave',false);global.doc.applyText(global.doc.current,'unsaved test $x^2$');
  const before=global.doc.current,confirm=global.doc.confirmDiscard;
  nextSave={filePath:path.join(fixtures,'cancelled-switch.md')};global.doc.confirmDiscard=async()=>false;
  assert.equal(await ev('hostApi.invoke("new-file")'),false);assert.equal(global.doc.current,before);assert.ok(!fs.existsSync(nextSave.filePath));
  pass('cancelling creation preserves unsaved text and creates no file');
  let confirmations=0;global.doc.confirmDiscard=async()=>{confirmations++;return confirm.call(global.doc);};
  const show=dialog.showMessageBoxSync;dialog.showMessageBoxSync=()=>1;
  nextSave={filePath:path.join(fixtures,'from menu 中文.md')};await menu.click();
  await until(()=>global.doc.file===nextSave.filePath,'menu creation');assert.equal(confirmations,1);
  assert.equal(fs.readFileSync(newTarget,'utf8'),'');
  pass('menu creation confirms unsaved changes exactly once and opens the new file');
  global.doc.confirmDiscard=confirm;dialog.showMessageBoxSync=show;
  nextSave={filePath:path.join(fixtures,'second instance.md')};
  app.emit('second-instance',{},[process.execPath,application,'--new-md'],fixtures,{newFile:true});
  await until(()=>global.doc.file===nextSave.filePath,'warm new-file launch');
  assert.equal(BrowserWindow.getAllWindows().length,1);
  pass('warm new-file request creates a document in the existing window');
}
async function checkFileActions({win, ev, until, iframe}) {
  const menu = Menu.getApplicationMenu();
  const reveal = menu.getMenuItemById('file-reveal');
  const copy = menu.getMenuItemById('file-copy-path');
  assert.ok(reveal && copy, 'File menu must expose both requested actions');
  if (!global.doc.file) {
    assert.equal(reveal.enabled, false); assert.equal(copy.enabled, false);
    pass('current-file actions are disabled when no document is open');
    return;
  }
  const originalReveal = shell.showItemInFolder;
  const originalCopy = clipboard.writeText;
  let revealed, copied;
  shell.showItemInFolder = file => {revealed = file;};
  clipboard.writeText = async text => {copied = text;};
  try {
    assert.equal(reveal.enabled, true); assert.equal(copy.enabled, true);
    await reveal.click(); await copy.click();
    assert.equal(revealed, global.doc.file); assert.equal(copied, global.doc.file);
    pass('File menu reveals the current file and copies its absolute path');
    if (scenario === 'cold') {
      const contextRow = `[...document.querySelectorAll('#tree .row')].find(row=>row.dataset.path===${JSON.stringify(first)})`;
      await until(() => ev(`!!(${contextRow})`), 'other document visible in the tree');
      const showContext = () => ev(`(${contextRow}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:90,clientY:180}))`);
      await showContext();
      const labels = await ev(`[...document.querySelectorAll('#ctxmenu .mi')].map(item=>item.textContent)`);
      assert.ok(labels.includes('打开文件所在文件夹')); assert.ok(labels.includes('复制绝对路径'));
      fs.writeFileSync(path.join(output, 'file-context-menu.png'), (await win.webContents.capturePage()).toPNG());
      await ev(`[...document.querySelectorAll('#ctxmenu .mi')].find(item=>item.textContent==='复制绝对路径').click()`);
      await until(() => copied === first, 'context menu copies the selected absolute path');
      await showContext();
      await ev(`[...document.querySelectorAll('#ctxmenu .mi')].find(item=>item.textContent==='打开文件所在文件夹').click()`);
      await until(() => revealed === first, 'context menu reveals the selected file');
      assert.equal(global.doc.file, second);
      pass('file-tree context actions use the selected file without changing the editor');
      const renamed = path.join(fixtures, '重命名 # 教材.md');
      await ev(`hostApi.invoke('tree-rename',{from:${JSON.stringify(second)},name:${JSON.stringify(path.basename(renamed))}})`);
      await until(() => ev(`${iframe}?.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes('直接编辑')`), 'renamed document visible');
      await reveal.click(); await copy.click();
      assert.equal(revealed, renamed); assert.equal(copied, renamed);
      pass('current-file actions follow a renamed document');
      const movedFolder = path.join(output, '重命名 文件夹');
      await ev(`hostApi.invoke('tree-rename',{from:${JSON.stringify(fixtures)},name:${JSON.stringify(path.basename(movedFolder))}})`);
      await until(() => ev(`${iframe}?.vditor?.vditor?.__typoraPatched && ${iframe}.vditor.getValue().includes('直接编辑')`), 'document survives containing-folder rename');
      await reveal.click(); await copy.click();
      assert.equal(revealed, path.join(movedFolder, path.basename(renamed))); assert.equal(copied, revealed);
      pass('current-file actions follow a renamed containing folder');
      global.doc.closeDoc();
      assert.equal(reveal.enabled, false); assert.equal(copy.enabled, false);
      pass('closing the document disables both current-file actions');
    }
  } finally {shell.showItemInFolder = originalReveal; clipboard.writeText = originalCopy;}
}
