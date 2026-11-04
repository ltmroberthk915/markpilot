'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{test}=require('node:test'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..'),packages=path.join(root,'dsh-markpilot/node_modules');
const moduleURL=(name)=>pathToFileURL(path.join(packages,'@codemirror',name,'dist/index.js')).href;
const js=fs.readFileSync(path.join(root,'dsh-markpilot/src-cm6/composition-pointer.js'),'utf8').replace("'@codemirror/state'",JSON.stringify(moduleURL('state'))).replace("'@codemirror/view'",JSON.stringify(moduleURL('view')));
const code=js;
const imports=Promise.all([import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')),import(moduleURL('state')),import(moduleURL('commands'))]);
async function setup(){
 const [{CompositionPointer},cm,cmd]=await imports;
 const serial=11,tracker=new CompositionPointer();
 let state=cm.EditorState.create({doc:'Use xyz\n\nTarget line\n',selection:cm.EditorSelection.cursor(7),extensions:[cmd.history()]});
 tracker.start(serial,state.selection);
 const step=(spec,epoch=serial)=>{const tr=state.update(spec);tracker.update(tr,epoch);state=tr.state;return tr;};
 step({changes:{from:7,insert:'ni'},selection:{anchor:9},userEvent:'input.type.compose.start'});
 step({changes:{from:7,to:9,insert:'你'},selection:{anchor:8},userEvent:'input.type.compose'});
 return {cm,cmd,tracker,serial,get state(){return state;},step,
  click(anchor,head=anchor){tracker.press(state.selection);step({selection:{anchor,head},userEvent:'select.pointer'});tracker.release(state.selection);},
  commit(text='你'){tracker.writing();step({...text!=='你'&&{changes:{from:7,to:8,insert:text}},selection:{anchor:7+text.length},userEvent:'input.type.compose'});tracker.ended=true;tracker.writing();},
  restore(){const wanted=tracker.take(serial,state.selection);if(wanted)step({selection:wanted,annotations:cm.Transaction.addToHistory.of(false),userEvent:'select.pointer.composition'});return wanted;}
 };
}
test('observed source 8 → click 13 → native commit 8 restores position without changing text',async()=>{
 const v=await setup();v.click(13);v.commit();const text=v.state.doc.toString();assert.equal(v.state.selection.main.head,8);
 assert.equal(v.restore().main.head,13);assert.equal(v.state.doc.toString(),text);assert.equal(v.restore(),null);
});
test('a reverse drag keeps its anchor and head across a native replacement of a different length',async()=>{
 const v=await setup();v.click(18,13);v.commit('你好');const r=v.restore().main;
 assert.deepEqual({anchor:r.anchor,head:r.head},{anchor:19,head:14});
});
test('document/epoch or unrelated edit retires an old click even when text is identical',async()=>{
 const v=await setup();v.click(13);v.step({selection:{anchor:13}},12);assert.equal(v.tracker.epoch,null);v.commit();assert.equal(v.restore(),null);
 const w=await setup();w.click(13);w.step({changes:{from:13,insert:'OTHER'},userEvent:'input.type'});w.commit();assert.equal(w.restore(),null);
});
test('a newer deliberate navigation, history or cancel cannot be undone by the old composition',async()=>{
 const v=await setup();v.click(13);v.step({selection:{anchor:15},userEvent:'select'});v.commit();assert.equal(v.restore(),null);
 for(const why of ['undo','redo']){const w=await setup();w.click(13);w.step({selection:{anchor:8},userEvent:why});w.commit();assert.equal(w.restore(),null);}
 const w=await setup();w.click(13);w.tracker.reset();w.commit();assert.equal(w.restore(),null);
});
test('a second drag wins; a commit-first click is left to normal CM history',async()=>{
 const v=await setup();v.click(13);v.click(17,14);v.commit();const r=v.restore().main;assert.equal(r.anchor,17);assert.equal(r.head,14);
 const w=await setup();w.commit();w.click(13);assert.equal(w.restore(),null);assert.equal(w.state.selection.main.head,13);
});
test('ordinary edits Undo and Redo beside restored selection without history from the repair',async()=>{
 const v=await setup();v.click(13);v.commit();v.restore();v.step({changes:{from:13,insert:'Z'},selection:{anchor:14},userEvent:'input.type',annotations:v.cmd.isolateHistory.of('full')});
 const after=v.state.doc.toString(),before=after.replace('TarZ','Tar');assert(after.includes('TarZget'));
 const proxy={get state(){return v.state;},dispatch:tr=>v.step(tr)};
 assert(v.cmd.undo(proxy));assert.equal(v.state.doc.toString(),before);assert(v.cmd.redo(proxy));assert.equal(v.state.doc.toString(),after);
});
class FakeEvents {
 constructor(){this.handlers={};}
 addEventListener(type,fn,opts){(this.handlers[type]||=[]).push(fn);}
 emit(type,e){for(const f of this.handlers[type]||[])f({type,isTrusted:true,...e});}
}
async function pluginSetup(release=true){
 const [{compositionPointerSelection},cm]=await imports,doc=new FakeEvents(),win=doc.defaultView=new FakeEvents();
 doc.hasFocus=()=>true;const target={closest:()=>null},v={
  dom:{ownerDocument:doc,isConnected:true},contentDOM:{contains:n=>n===target},composing:false,compositionStarted:false,hasFocus:true,
  state:cm.EditorState.create({doc:'Use xyz\n\nTarget line\n',selection:cm.EditorSelection.cursor(7)}),
  dispatch(spec){const tr=this.state.update(spec);this.state=tr.state;plugin.update({transactions:[tr]});}
 };
 let epoch=11;const plugin=compositionPointerSelection(()=>epoch).create(v);
 const emit=(type,e={})=>doc.emit(type,{target,...e});
 emit('compositionstart');v.composing=v.compositionStarted=true;emit('compositionupdate');emit('beforeinput',{inputType:'insertCompositionText',isComposing:true});
 v.dispatch({changes:{from:7,insert:'ni'},selection:{anchor:9},userEvent:'input.type'});
 emit('pointerdown',{button:0});emit('mousedown',{button:0});v.dispatch({selection:{anchor:14},userEvent:'select.pointer'});if(release)emit('mouseup',{button:0});
 return {v,plugin,doc,win,emit,commit(){
   emit('compositionupdate');emit('beforeinput',{inputType:'insertCompositionText',isComposing:true});
   v.dispatch({changes:{from:7,to:9,insert:'你'},selection:{anchor:8},userEvent:'input.type'});
   emit('compositionend',{isTrusted:false});v.composing=v.compositionStarted=false;
 },expire(){epoch++;},end(){plugin.destroy();}};
}
test('EditContext end is a wake-up only after a trusted pointer and later verified native preedit write',async()=>{
 const run=await pluginSetup(),{v,emit}=run;
 try{
  emit('compositionend',{isTrusted:false});assert.equal(run.plugin.track.ended,false,'synthetic end alone cannot own navigation');
  run.commit();await new Promise(r=>setTimeout(r,3));assert.equal(v.state.selection.main.head,13);
 }finally{run.end();}
});
test('immediate next ordinary key sees restored position; blur, another pointer and switched epoch retire the old one',async()=>{
 for(const action of ['input','blur','new-pointer','epoch']){
  const run=await pluginSetup(),{v,emit}=run;
  try{
   run.commit();
   if(action==='blur')emit('focusout');if(action==='new-pointer')emit('pointerdown',{button:0});if(action==='epoch')run.expire();
   emit('keydown',{key:'Z',keyCode:90,isComposing:false});
   assert.equal(v.state.selection.main.head,action==='input'?13:8,action);
  }finally{run.end();}
 }
});
test('during live drag a later reverse range supersedes the initial click even if commit beats mouseup',async()=>{
 const v=await setup();v.tracker.press(v.state.selection);v.step({selection:{anchor:13},userEvent:'select.pointer'});
 v.tracker.writing();v.step({selection:{anchor:18,head:13},userEvent:'select.pointer'});
 v.commit();v.tracker.release(v.state.selection);const r=v.restore().main;
 assert.equal(r.anchor,18);assert.equal(r.head,13);
});
test('native end before release arms but does not move a live drag, and release consumes its final range',async()=>{
 const run=await pluginSetup(false),{v,emit}=run;
 try {
   emit('compositionupdate');emit('mousemove',{buttons:1});v.dispatch({selection:{anchor:19,head:14},userEvent:'select.pointer'});
   run.commit();assert.equal(run.plugin.track.ended,true);
   await new Promise(r=>setTimeout(r,3));assert.equal(v.state.selection.main.head,8,'still held');
   emit('mouseup',{button:0});await Promise.resolve();
   assert.equal(v.state.selection.main.anchor,18);assert.equal(v.state.selection.main.head,13);
 }finally{run.end();}
});
test('document mouseup snapshots the selection after the gesture handler updates its final endpoints',async()=>{
 const run=await pluginSetup(false),{v,doc,emit}=run;
 try {
   doc.addEventListener('mouseup',()=>v.dispatch({selection:{anchor:16,head:14},userEvent:'select.pointer'}));
   emit('mouseup',{button:0});await Promise.resolve();run.commit();
   await new Promise(r=>setTimeout(r,3));
   assert.equal(v.state.selection.main.anchor,15);assert.equal(v.state.selection.main.head,13);
 }finally{run.end();}
});

