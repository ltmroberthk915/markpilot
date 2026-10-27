'use strict';
// Real host document transitions. Each history fixture gets a fresh renderer.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { args, launch, acquireSlot, sleep } = require('./lifecycle.cjs');
const { outputDir, snapshot, frame, recorder, waitUntil, newWindow, newBlankWindow } = require('./harness.cjs');

async function focus(page) {
  await page.bringToFront();
  await page.evaluate(() => window.mpEngine.focus());
  await waitUntil(() => page.evaluate(() => document.hasFocus() && window.mpEngine._view().hasFocus), 'actual editor focus');
}
async function saved(page, file, text) {
  await waitUntil(async () => {
    const clean = await page.evaluate(() => !dirty && !saveInFlight && !saveTimer);
    return clean && fs.readFileSync(file, 'utf8') === text;
  }, 'autosaved exact bytes');
}
async function observed(page, dir, trace, name, contextBox) {
  const state = await snapshot(page);
  const host = await page.evaluate(() => ({documentId, filePath, dirty, saveInFlight, saveTimer: !!saveTimer}));
  const screenshot = await frame(page, dir, name, state.focus ? {} : {caret:'dom',allowMissingCaret:true,contextBox});
  const step = {name, ...state, host, screenshot};
  trace.push(step);
  return step;
}
async function main() {
  const options = args(process.argv.slice(2));
  const dir = outputDir(options.out, 'document-workflows');
  const release = acquireSlot();
  const result = {suite:'document-workflows', schema:1, startedAt:new Date().toISOString(), cases:[], input:'CDP real key events and insertText; file opening uses real host IPC'};
  const record = recorder(dir, result), filter = process.env.MP_QUALITY_CASES;
  const test = (id, body) => !filter || new RegExp(filter).test(id) ? record(id, body) : Promise.resolve();
  let run;
  try {
    const first = path.join(dir, 'history-A.md');
    const second = path.join(dir, 'history-B.md');
    const initial = 'A base\n';
    const edited = initial + 'FROM_A';
    fs.writeFileSync(first, initial);
    fs.writeFileSync(second, edited);
    run = await launch(options, first, dir);
    result.artifact = run.metadata;
    const page = run.page;
    await waitUntil(() => page.evaluate(p => filePath === p && window.mpEngine.getValue() === 'A base\n', first), 'first renderer document');
    await test('same-text-other-file-starts-empty-history', async trace => {
      await focus(page);
      await page.keyboard.press('Control+End');
      await observed(page, dir, trace, 'same-text-01-before-edit');
      await page.keyboard.insertText('FROM_A');
      await saved(page, first, edited);
      const before = await observed(page, dir, trace, 'same-text-02-A-edited');
      const opened = await page.evaluate(p => window.mpHost.openPath(p), second);
      assert(opened?.ok, 'real host open must succeed');
      await waitUntil(() => page.evaluate(({p,old}) => filePath === p && documentId !== old, {p:second,old:before.host.documentId}), 'new file identity even when bytes match');
      await focus(page);
      const switched = await observed(page, dir, trace, 'same-text-03-B-before-undo');
      assert.equal(switched.text, edited, 'second document initial bytes');
      await page.keyboard.press('Control+z');
      await sleep(750);
      const after = await observed(page, dir, trace, 'same-text-04-B-after-undo');
      const disk = {A:fs.readFileSync(first,'utf8'),B:fs.readFileSync(second,'utf8')};
      trace.push({name:'disk-after-undo', ...disk});
      assert.equal(after.text, edited, 'undo in newly opened B must not replay A history');
      assert.deepEqual(disk, {A:edited,B:edited}, 'undo must not contaminate either file');
      return {historyIsolated:true, documentIdentityChanged:true};
    });
    const fresh = async (name, text) => {
      const file=path.join(dir,name+'.md');fs.writeFileSync(file,text);
      const page=await newWindow(run,run.page,file);await focus(page);
      return {page,file};
    };
    const open = async (page, file) => {
      const old=await page.evaluate(()=>documentId);
      const answer=await page.evaluate(p=>window.mpHost.openPath(p),file);assert(answer?.ok,'real host open');
      await waitUntil(()=>page.evaluate(({p,old})=>filePath===p&&documentId!==old,{p:file,old}),'replacement renderer identity');
      await focus(page);
    };
    await test('new-empty-document-cannot-undo-deletion-in-old-file',async trace=>{
      const {page:p,file}=await fresh('delete-then-new','OLD_PRIVATE_SYNTHETIC\n');
      await p.keyboard.press('Control+a');await p.keyboard.press('Backspace');await saved(p,file,'');
      await observed(p,dir,trace,'new-01-old-empty');
      const old=await p.evaluate(()=>documentId);
      const blank=await newBlankWindow(run,p);
      assert.notEqual(await blank.evaluate(()=>documentId),old,'new blank has an independent identity');
      assert.equal(await p.evaluate(()=>documentId),old,'old document keeps its identity');
      await focus(blank);await blank.keyboard.press('Control+z');await sleep(200);
      const after=await observed(blank,dir,trace,'new-02-after-undo');assert.equal(after.text,'','new blank document has empty history');assert.equal(fs.readFileSync(file,'utf8'),'','old file remains saved empty');
      assert.equal((await snapshot(p)).text,'','old source remains saved empty');
      return{historyIsolated:true};
    });
    await test('new-file-cannot-redo-old-file-edit',async trace=>{
      const initial='COMMON\n',{page:p,file}=await fresh('redo-old',initial);
      await p.keyboard.press('Control+End');await p.keyboard.insertText('OLD_EDIT');await saved(p,file,initial+'OLD_EDIT');
      await p.keyboard.press('Control+z');await saved(p,file,initial);
      const second=path.join(dir,'redo-new.md');fs.writeFileSync(second,initial);await open(p,second);
      await p.keyboard.press('Control+y');await sleep(650);const after=await observed(p,dir,trace,'redo-01-after');
      assert.equal(after.text,initial,'redo in new document must not replay old edit');assert.equal(fs.readFileSync(second,'utf8'),initial,'new file unchanged');return{redoIsolated:true};
    });
    await test('different-text-open-does-not-undo-previous-file',async trace=>{
      const initial='COMMON\n',{page:p,file}=await fresh('different-old',initial);
      await p.keyboard.press('Control+Home');await p.keyboard.insertText('OLD_EDIT\n');await saved(p,file,'OLD_EDIT\n'+initial);
      const second=path.join(dir,'different-new.md'),text='COMMON\nSECOND_DOCUMENT\n';fs.writeFileSync(second,text);await open(p,second);
      await p.keyboard.press('Control+z');await sleep(650);const after=await observed(p,dir,trace,'different-01-after');assert.equal(after.text,text);assert.equal(fs.readFileSync(second,'utf8'),text);return{historyIsolated:true};
    });
    for(const external of [false,true])await test('same-file-reload-preserves-undo-'+(external?'external-prefix':'identical-bytes'),async trace=>{
      const initial='alpha\nomega\n',{page:p,file}=await fresh('reload-'+external,initial),edited=initial+'LOCAL_EDIT';
      await p.keyboard.press('Control+End');await p.keyboard.insertText('LOCAL_EDIT');await saved(p,file,edited);
      const prefix=external?'EXTERNAL_PREFIX\n':'';fs.writeFileSync(file,prefix+edited);
      const old=await p.evaluate(()=>documentId),answer=await p.evaluate(()=>window.mpHost.reload());assert(answer?.ok,'real reload response');
      await waitUntil(()=>p.evaluate(({old,text})=>documentId!==old&&window.mpEngine.getValue()===text,{old,text:prefix+edited}),'reload reached renderer');
      await focus(p);await observed(p,dir,trace,'reload-'+external+'-01-before-undo');
      await p.keyboard.press('Control+z');await saved(p,file,prefix+initial);const after=await observed(p,dir,trace,'reload-'+external+'-02-after-undo');
      assert.equal(after.text,prefix+initial,'undo changes only local edit, preserves disk edit');return{sameFileUndoRetained:true,externalContentRetained:external};
    });
    await test('explicit-reopen-same-path-starts-new-history',async trace=>{
      const initial='REOPEN\n',{page:p,file}=await fresh('reopen',initial),edited=initial+'SAVED_EDIT';
      await p.keyboard.press('Control+End');await p.keyboard.insertText('SAVED_EDIT');await saved(p,file,edited);await open(p,file);
      await p.keyboard.press('Control+z');await sleep(650);const after=await observed(p,dir,trace,'reopen-01-after-undo');assert.equal(after.text,edited,'explicit open starts a new document session');return{historyIsolated:true};
    });
    await test('open-from-active-cell-immediately-types-in-new-document',async trace=>{
      const {page:p}=await fresh('active-cell-old','| Name | Value |\n| --- | --- |\n| alpha | one |\n\nEnd\n');
      const cell=p.locator('.mp-row td[data-mp-row]').first(),box=await cell.boundingBox();assert(box,'visible interactive table cell');
      trace.push({name:'cell-click-target',box,cell:await cell.evaluate(el=>({text:el.textContent,row:el.dataset.mpRow,col:el.dataset.mpCol}))});
      await p.mouse.click(box.x+box.width*.5,box.y+box.height*.5,{delay:65});
      await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&document.activeElement?.classList.contains('mp-cell-overlay-text')),'real cell overlay focus');
      await observed(p,dir,trace,'active-cell-01-before-open');
      const second=path.join(dir,'active-cell-new.md'),text='B second document\n';fs.writeFileSync(second,text);
      const old=await p.evaluate(()=>documentId),answer=await p.evaluate(file=>window.mpHost.openPath(file),second);assert(answer?.ok,'real host replacement');
      await waitUntil(()=>p.evaluate(({old,file})=>documentId!==old&&filePath===file,{old,file:second}),'replacement identity');
      await sleep(250);const opened=await observed(p,dir,trace,'active-cell-02-after-open');
      await p.keyboard.insertText('NEW_');await sleep(250);const typed=await observed(p,dir,trace,'active-cell-03-immediate-typing');
      assert(opened.focus,'new document receives editor focus without test refocusing it');
      assert.equal(opened.selection.head,0,'new document starts at its beginning');
      assert.equal(typed.text,'NEW_'+text,'typing immediately after open reaches only the new document');
      await saved(p,second,'NEW_'+text);return{inputFocus:true,oldOverlayRetired:true};
    });
    await test('open-keeps-focused-persistent-settings-control',async trace=>{
      const initial='A settings control\n',{page:p}=await fresh('settings-focus-old',initial);
      await p.locator('.mp-tb-item[data-mp-id="more"]').click({delay:65});
      await p.locator('.mp-pop').getByText('设置',{exact:true}).click({delay:65});
      await p.locator('[data-settings-tab="layout"]').click({delay:65});
      const control=p.locator('.mp-dlg input.mp-rng[data-p]').first();
      await control.click({delay:65});
      const before=await control.evaluate(el=>{
        window.__qualitySettingsFocus=el;
        window.__qualitySettingsKey=null;
        el.addEventListener('keydown',e=>{window.__qualitySettingsKey={key:e.key,code:e.code,trusted:e.isTrusted};},{capture:true});
        return{focused:document.hasFocus()&&document.activeElement===el,value:Number(el.value),step:Number(el.step)||1,max:Number(el.max)};
      });
      assert(before.focused,'real settings range receives the click focus');
      const box=await control.boundingBox();assert(box,'visible focused settings range');
      const context={left:box.x+box.width/2,top:box.y};
      await observed(p,dir,trace,'settings-focus-01-before-open',context);
      const second=path.join(dir,'settings-focus-new.md'),text='B settings control\n';fs.writeFileSync(second,text);
      const old=await p.evaluate(()=>documentId),answer=await p.evaluate(file=>window.mpHost.openPath(file),second);assert(answer?.ok,'real host replacement');
      await waitUntil(()=>p.evaluate(({old,file})=>documentId!==old&&filePath===file,{old,file:second}),'replacement identity');
      await sleep(250);
      const retained=await p.evaluate(()=>({focused:document.hasFocus()&&document.activeElement===window.__qualitySettingsFocus,connected:window.__qualitySettingsFocus.isConnected}));
      const opened=await observed(p,dir,trace,'settings-focus-02-after-open',context);
      assert.deepEqual(retained,{focused:true,connected:true},'existing settings control keeps focus across document replacement');
      assert.equal(opened.text,text,'new document loaded without modifying its source');
      await p.keyboard.press('ArrowRight');
      const after=await control.evaluate(el=>({value:Number(el.value),event:window.__qualitySettingsKey}));
      trace.push({name:'settings-key-after-open',before,retained,after});
      assert.deepEqual(after.event,{key:'ArrowRight',code:'ArrowRight',trusted:true},'real arrow reaches the preserved settings control');
      assert.equal(after.value,Math.min(before.max,before.value+before.step),'settings input remains keyboard operable');
      assert.equal((await snapshot(p)).text,text,'settings arrow never edits document text');
      await p.locator('.mp-dlg .close').click({delay:65});
      return{persistentControlFocus:true,realKeyboardInput:true};
    });
    await test('replacement-keeps-custom-keys-extras-and-open-source-pane',async trace=>{
      const original='A_ONLY\n'+Array.from({length:45},(_,i)=>'Long A paragraph '+i+' with words.\n\n').join('');
      const {page:p,file}=await fresh('configured-old',original);
      await p.locator('.mp-tb-item[data-mp-id="more"]').click({delay:65});
      await p.locator('.mp-pop').getByText('快捷键设置…',{exact:true}).click({delay:65});
      await p.locator('.mp-key[data-a="italic"]').click({delay:65});await p.keyboard.press('Control+Shift+U');
      assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('mp-keys')).italic),'Mod-Shift-u','real shortcut settings committed');
      await p.locator('.mp-dlg .close').click({delay:65});
      await focus(p);await p.keyboard.press('Control+Home');await p.keyboard.press('Shift+End');
      await p.evaluate(()=>{window.__qualityCustomKey=null;document.addEventListener('keydown',e=>{if(e.code==='KeyU')window.__qualityCustomKey={trusted:e.isTrusted,key:e.key,code:e.code,shiftKey:e.shiftKey,ctrlKey:e.ctrlKey};},{capture:true});});
      await p.keyboard.press('Control+Shift+U');
      const beforeSwitch=await observed(p,dir,trace,'configured-00-key-before-switch');
      trace.push({name:'custom-key-positive-control',beforeSwitchCorrect:beforeSwitch.text===original.replace('A_ONLY','*A_ONLY*'),event:await p.evaluate(()=>window.__qualityCustomKey)});
      assert.equal(beforeSwitch.text,original.replace('A_ONLY','*A_ONLY*'),'custom key works before replacement');
      await p.keyboard.press('Control+z');await saved(p,file,original);
      await p.locator('.mp-tb-item[data-mp-id="split"]').click({delay:65});
      assert(await p.evaluate(()=>window.mpSplit.isOpen()),'source pane is open');await focus(p);await p.keyboard.press('Control+End');await sleep(100);
      assert((await snapshot(p)).scrollTop>0,'old document was actually deep-scrolled');
      const second=path.join(dir,'configured-new.md'),text='B_ONLY\nalpha beta\n\n```text\nx\n```\n';fs.writeFileSync(second,text);await open(p,second);await sleep(200);
      const pane=()=>p.evaluate(()=>{const a=window.mpEngine._view(),b=window.mpSplit._slave();return{open:window.mpSplit.isOpen(),sameText:a.state.doc===b?.state.doc,text:b?.state.doc.toString(),readOnly:b?.state.readOnly};});
      const switched=await observed(p,dir,trace,'configured-01-switched');trace.push({name:'pane-after-open',...await pane()});
      assert.equal(switched.selection.head,0);assert.equal(switched.scrollTop,0);assert.deepEqual(await pane(),{open:true,sameText:true,text,readOnly:true});
      await p.keyboard.press('Control+Home');await p.keyboard.press('ArrowDown');await p.keyboard.press('Home');await p.keyboard.press('Shift+End');
      assert.equal(text.slice((await snapshot(p)).selection.anchor,(await snapshot(p)).selection.head),'alpha beta','real keyboard selection');
      await p.keyboard.press('Control+Shift+U');await sleep(120);const italic=await observed(p,dir,trace,'configured-02-custom-key');
      assert.equal(italic.text,text.replace('alpha beta','*alpha beta*'),'current key configuration survives replacement');
      assert.equal((await pane()).text,italic.text);const afterEditPane=await pane();trace.push({name:'pane-after-custom-key',...afterEditPane});assert(afterEditPane.open&&afterEditPane.readOnly,'pane remains open and read-only after input');await saved(p,second,italic.text);
      await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,text);await p.keyboard.press('Control+y');assert.equal((await snapshot(p)).text,italic.text);
      const pos=italic.text.indexOf('\nx\n')+1,c=await p.evaluate(pos=>window.mpSplit._slave().coordsAtPos(pos),pos);assert(c&&c.bottom>c.top,'visible right source x');
      await p.mouse.click(c.left+.1,(c.top+c.bottom)/2,{delay:65});await sleep(100);assert((await snapshot(p)).focus,'source click focuses master');assert.equal((await snapshot(p)).selection.head,pos,'source click maps to current B');
      await p.keyboard.press('Tab');const indented=await observed(p,dir,trace,'configured-03-code-tab');assert.equal(indented.text,italic.text.replace('\nx\n','\n  x\n'),'extras code Tab survives replacement');
      await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,italic.text);assert.equal(fs.readFileSync(file,'utf8'),original,'old document bytes unchanged');
      return{customKeysPreserved:true,extrasPreserved:true,openSourcePaneMirrored:true};
    });
  } finally {
    if (run) result.cleanup = await run.cleanup();
    release();
    result.finishedAt = new Date().toISOString();
    result.passed = result.cases.length > 0 && result.cases.every(c => c.status === 'pass') && !result.cleanup?.residual?.length;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result,null,2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
