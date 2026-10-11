const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {newMarkdown,suggestedPath}=require('../app/main/new-document');
const base=path.resolve(__dirname,'../.perf');
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(base,'new-document-')),target=path.join(root,'新建 # & (文件).md');
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true});});
  const current={file:path.join(root,'old.md'),text:'未保存数学 $x^2$'};await fs.writeFile(current.file,'saved original');
  let confirmations=0,resumed=0;
  const doc={current,file:current.file,confirmDiscard:async()=>{confirmations++;return true;},scheduleProtection:()=>resumed++};
  const options={directory:root,win:{},doc,dialog:{showSaveDialog:async()=>({filePath:target})},open:async file=>{doc.file=file;return true;}};
  return {root,target,doc,options,confirmations:()=>confirmations,resumed:()=>resumed};
}
test('new file uses a collision-free default, appends .md and opens it for editing',async t=>{
  const {root,target,doc,options,confirmations}=await fixture(t);
  await fs.writeFile(path.join(root,'未命名.md'),'existing');await fs.mkdir(path.join(root,'未命名 1.md'));
  assert.equal(await suggestedPath(root),path.join(root,'未命名 2.md'));
  options.dialog.showSaveDialog=async(_win,opts)=>{assert.equal(opts.defaultPath,path.join(root,'未命名 2.md'));return{filePath:target.slice(0,-3)};};
  let proof;options.open=async(file,opts)=>{assert.equal(file,target);proof=opts.confirmedDiscard;doc.file=file;return true;};
  assert.equal(await newMarkdown(options),true);assert.equal(await fs.readFile(target,'utf8'),'');assert.equal(confirmations(),1);
  assert.equal(proof.current,doc.current);assert.equal(proof.text,doc.current.text);
  assert.equal(await fs.readFile(doc.current.file,'utf8'),'saved original');
});
test('cancelling the save-location dialog does not touch the current document',async t=>{
  const {options,target,confirmations}=await fixture(t);options.dialog.showSaveDialog=async()=>({canceled:true});
  assert.equal(await newMarkdown(options),false);assert.equal(confirmations(),0);await assert.rejects(fs.stat(target),{code:'ENOENT'});
});
test('cancelling the unsaved-changes confirmation creates no file',async t=>{
  const {options,target,doc}=await fixture(t);doc.confirmDiscard=async()=>false;
  assert.equal(await newMarkdown(options),false);await assert.rejects(fs.stat(target),{code:'ENOENT'});
});
test('same-name files are never overwritten, even if the native picker accepted overwrite',async t=>{
  const {options,target,confirmations}=await fixture(t);await fs.writeFile(target,'keep existing');
  await assert.rejects(newMarkdown(options),/同名文件已存在/);assert.equal(confirmations(),0);assert.equal(await fs.readFile(target,'utf8'),'keep existing');
});
test('a file appearing after the dialog is preserved and old document protection resumes',async t=>{
  const {options,target,doc,resumed}=await fixture(t);doc.confirmDiscard=async()=>{await fs.writeFile(target,'other process');return true;};
  await assert.rejects(newMarkdown(options),/刚被创建/);assert.equal(await fs.readFile(target,'utf8'),'other process');assert.equal(resumed(),1);
});
test('failed or cancelled opening removes only the empty new file and resumes protection',async t=>{
  const {options,target,resumed}=await fixture(t);options.open=async()=>false;
  assert.equal(await newMarkdown(options),false);await assert.rejects(fs.stat(target),{code:'ENOENT'});assert.equal(resumed(),1);
  options.open=async()=>{throw new Error('fixture open error');};await assert.rejects(newMarkdown(options),/fixture open error/);await assert.rejects(fs.stat(target),{code:'ENOENT'});
});
test('cleanup preserves a new file changed concurrently by another writer',async t=>{
  const {options,target}=await fixture(t);options.open=async()=>{await fs.writeFile(target,'concurrent content');return false;};
  assert.equal(await newMarkdown(options),false);assert.equal(await fs.readFile(target,'utf8'),'concurrent content');
});
test('new input during creation invalidates the prior discard proof',async t=>{
  const {options,doc}=await fixture(t);const original=doc.current.text;
  doc.confirmDiscard=async()=>{doc.current.text+=' newer input';return true;};
  options.open=async(file,{confirmedDiscard})=>{assert.equal(confirmedDiscard.text,original);assert.notEqual(confirmedDiscard.text,doc.current.text);doc.file=file;return true;};
  assert.equal(await newMarkdown(options),true);
});
