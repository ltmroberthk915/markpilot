const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {AppState} = require('../app/main/state');

test('recent files and folders keep 50 unique paths, latest first, across restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'typora-recents-'));
  const file = path.join(dir,'state.json');
  const state = new AppState({file});
  t.after(()=>{state.saveNow();fs.unlinkSync(file);fs.rmdirSync(dir);});
  for(let i=0;i<60;i++) {
    state.pushRecent('recentFiles',path.join(dir,'doc-'+i+'.md'));
    state.pushRecent('recentFolders',path.join(dir,'folder-'+i));
  }
  for(const key of ['recentFiles','recentFolders']) assert.equal(state.get(key).length,50);
  const oldFile=path.join(dir,'doc-20.md');
  state.pushRecent('recentFiles',oldFile);
  state.pushRecent('recentFiles',process.platform==='win32'?oldFile.toUpperCase():oldFile);
  assert.equal(state.get('recentFiles').length,50);
  assert.equal(state.get('recentFiles')[0].toLowerCase(),oldFile.toLowerCase());
  const oldFolder=path.join(dir,'folder-20');state.pushRecent('recentFolders',oldFolder);
  assert.equal(state.get('recentFolders')[0],oldFolder);
  state.saveNow();const restored=new AppState({file});
  assert.deepEqual(restored.recent(),state.recent());
  assert.ok(!restored.get('recentFiles').some(p=>p.endsWith('doc-0.md')));
});

test('legacy histories normalize aliases; rename and delete respect directory boundaries', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'typora-recents-migrate-'));
  const file=path.join(dir,'state.json'),parent=path.join(dir,'notes'),renamed=path.join(dir,'renamed');
  fs.writeFileSync(file,JSON.stringify({recentFiles:[path.join(parent,'a.md'),path.join(parent,'..','notes','a.md'),path.join(dir,'notes-extra','b.md'),null],recentFolders:[parent]}));
  const state=new AppState({file});
  t.after(()=>{state.saveNow();fs.unlinkSync(file);fs.rmdirSync(dir);});
  assert.equal(state.get('recentFiles').length,2);
  state.updateRecentPath(parent,renamed);
  assert.equal(state.get('recentFiles')[0],path.join(renamed,'a.md'));
  assert.equal(state.get('recentFolders')[0],renamed);
  state.updateRecentPath(renamed,null);
  assert.deepEqual(state.get('recentFiles'),[path.join(dir,'notes-extra','b.md')]);
  assert.deepEqual(state.get('recentFolders'),[]);
});
