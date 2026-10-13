'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..'),local=n=>pathToFileURL(path.join(root,'dsh-markpilot/src-cm6',n)).href;
const cm=n=>pathToFileURL(path.join(root,'dsh-markpilot/node_modules/@codemirror',n,'dist/index.js')).href;
test('all kinds share directed selection sessions; math has per-range source and only main preview',async()=>{
 const {EditorState,EditorSelection,StateField}=await import(cm('state'));
 const {createRegionIndex}=await import(local('region-index.js')),{createRegionSession,activateRegion}=await import(local('region-session.js'));
 const rows=[{kind:'math',from:0,to:4,content:'a'},{kind:'math',from:6,to:10,content:'b'},{kind:'mermaid',from:12,to:16,content:'graph LR'},{kind:'code',from:18,to:22,content:'code'},{kind:'table',from:24,to:28,content:'table'},{kind:'image',from:30,to:34,content:'image'}];
 const source=StateField.define({create:()=>rows,update:v=>v}),index=createRegionIndex(s=>s.field(source),[source]),session=createRegionSession(index);
 let state=EditorState.create({doc:' '.repeat(40),selection:EditorSelection.create([EditorSelection.range(0,2),EditorSelection.range(9,7),EditorSelection.cursor(14),EditorSelection.cursor(20),EditorSelection.cursor(26),EditorSelection.cursor(32)],1),extensions:[EditorState.allowMultipleSelections.of(true),source,index,session]});
 const flags=kind=>[...state.field(session).presentation.values()].filter(r=>r.kind===kind);
 assert.equal(flags('math').length,2);assert(flags('math').every(r=>r.editing));assert.equal(flags('math').filter(r=>r.preview).length,1);assert.equal(flags('math').find(r=>r.preview).from,6);
 assert.equal(flags('mermaid')[0].editing,false);assert.equal(flags('code')[0].editing,true);assert.equal(flags('table')[0].editing,true);assert.equal(flags('image')[0].editing,false);
 const image=state.field(index).byKind.get('image')[0];state=state.update({effects:activateRegion.of({id:image.id})}).state;
 assert(flags('image')[0].editing&&flags('image')[0].preview);
 state=state.update({selection:{anchor:38},userEvent:'undo'}).state;assert.equal(state.field(session).imageId,null);
 state=state.update({selection:{anchor:13},userEvent:'select.pointer'}).state;assert(flags('mermaid')[0].editing);
});
test('a mounted consumer may retain a changed aggregate revision only when its literal snapshot still matches',async()=>{
 const {EditorState,StateField}=await import(cm('state')),{createRegionIndex}=await import(local('region-index.js')),{createRenderLifecycle}=await import(local('render-lifecycle.js'));
 const row=doc=>({kind:'table',from:0,to:doc.length,content:doc.toString(),context:{key:'table',path:[],depth:0}});
 const source=StateField.define({create:s=>[row(s.doc)],update:(v,tr)=>tr.docChanged?[row(tr.state.doc)]:v});
 const index=createRegionIndex(s=>s.field(source),[source]);let state=EditorState.create({doc:'row1\nrow2',extensions:[source,index]});
 const view={state,dom:{contains:()=>true},requestMeasure(){}},node={isConnected:true},lifecycle=createRenderLifecycle(index),r=state.field(index).regions[0];let disposed=0;
 const lease=lifecycle.mount(view,r,node,{sameContent:current=>current.content.split('\n')[0]==='row1'});lease.cleanup(()=>disposed++);
 view.state=state=state.update({changes:{from:5,to:9,insert:'ROW2'}}).state;assert(lease.valid());assert(lease.publish(()=>{}));
 view.state=state=state.update({changes:{from:0,to:4,insert:'ROW1'}}).state;assert.equal(lease.valid(),false);assert.equal(lease.publish(()=>{}),false);
 lifecycle.release(node);assert.equal(disposed,1);assert.equal(lifecycle.inspect(view).mounts,0);
});
test('literal source-owned revisions use the original changed domain and stay quiet on selection',async()=>{
 const {EditorState,StateField}=await import(cm('state')),{createRegionIndex}=await import(local('region-index.js'));
 const read=s=>{const line=s.doc.line(2);return /^C.*E$/.test(line.text)?[{kind:'code',from:line.from,to:line.to,sourceOwned:true,content:null,context:{key:'code'}}]:[]};
 const source=StateField.define({create:read,update:(v,tr)=>tr.docChanged?read(tr.state):v}),index=createRegionIndex(s=>s.field(source),[source]);
 let state=EditorState.create({doc:'AA\nCODE\nZZ',extensions:[source,index]}),r=state.field(index).regions[0];
 state=state.update({changes:{from:0,insert:'XX'}}).state;let now=state.field(index).regions[0];assert.equal(now.id,r.id);assert.equal(now.revision,0);assert.equal(now.from,5);
 state=state.update({changes:{from:6,to:7,insert:'X'}}).state;now=state.field(index).regions[0];assert.equal(now.id,r.id);assert.equal(now.revision,1);
 const before=state.field(index);state=state.update({selection:{anchor:1},userEvent:'select'}).state;assert.equal(state.field(index),before);
 state=state.update({changes:{from:5,to:9,insert:'plain'}}).state;assert.equal(state.field(index).regions.length,0);
});
for(const kind of ['code','table'])test('source-owned '+kind+' keeps its identity for native-equivalent EOF content edits',async()=>{
 const {EditorState,StateField}=await import(cm('state')),{createRegionIndex}=await import(local('region-index.js'));
 const {scanFencedBlocks}=await import(local('markdown-context.js'));
 // Code recognition is production. The table adapter states only this three-line
 // fixture's independent literal ownership; it does not copy the table parser.
 const read=s=>kind==='code'?scanFencedBlocks(s.doc).map(b=>({kind,form:b.char,from:b.from,to:b.to,sourceOwned:true,content:null,context:{key:kind}}))
  :s.doc.lines===3&&s.doc.line(2).text==='---|---'?[{kind,from:0,to:s.doc.length,sourceOwned:true,content:null,context:{key:kind}}]:[];
 const source=StateField.define({create:read,update:(v,tr)=>tr.docChanged?read(tr.state):v}),index=createRegionIndex(s=>s.field(source),[source]);
 const literal=kind==='code'?'~~~\nx':'a | b\n---|---\nc | d';
 let state=EditorState.create({doc:literal,extensions:[source,index]}),prior=state.field(index).regions[0];
 state=state.update({changes:{from:state.doc.length,insert:'R'},userEvent:'input.type'}).state;
 let current=state.field(index).regions[0];assert.equal(state.doc.toString(),literal+'R');assert.equal(current.id,prior.id);assert.equal(current.revision,1);
 state=state.update({changes:{from:state.doc.length-1,to:state.doc.length},userEvent:'delete.backward'}).state;
 current=state.field(index).regions[0];assert.equal(current.id,prior.id);assert.equal(current.revision,2);
 state=state.update({changes:{from:0,to:state.doc.length,insert:literal}}).state;
 assert.notEqual(state.field(index).regions[0].id,prior.id,'a fully covered replacement retires its prior owner even with identical bytes');
});
test('source-owned right-end reconciliation leaves a closed fence outside insertion outside its owner',async()=>{
 const {EditorState,StateField}=await import(cm('state')),{createRegionIndex}=await import(local('region-index.js')),{scanFencedBlocks}=await import(local('markdown-context.js'));
 const read=s=>scanFencedBlocks(s.doc).map(b=>({kind:'code',form:b.char,from:b.from,to:b.to,sourceOwned:true,content:null,context:{key:'code'}}));
 const source=StateField.define({create:read,update:(v,tr)=>tr.docChanged?read(tr.state):v}),index=createRegionIndex(s=>s.field(source),[source]);
 let state=EditorState.create({doc:'~~~\nx\n~~~',extensions:[source,index]}),prior=state.field(index).regions[0];
 state=state.update({changes:{from:state.doc.length,insert:'\nOUTSIDE'}}).state;
 const current=state.field(index).regions[0];assert.equal(current.id,prior.id);assert.equal(current.to,prior.to);assert.equal(state.doc.sliceString(current.from,current.to),'~~~\nx\n~~~');
});
test('an EOF candidate cannot reuse an exact successor or assign one prior identity twice',async()=>{
 const {EditorState,StateField}=await import(cm('state')),{createRegionIndex}=await import(local('region-index.js'));
 const row=(from,to)=>({kind:'code',form:'~',from,to,sourceOwned:true,content:null,context:{key:'code'}});
 for(const ambiguous of [false,true]){
  const source=StateField.define({create:()=>[row(0,4),row(4,8)],update:(v,tr)=>tr.docChanged?ambiguous?[row(0,5),row(0,5),row(5,9)]:[row(0,4),row(0,5),row(5,9)]:v});
  const index=createRegionIndex(s=>s.field(source),[source]);let state=EditorState.create({doc:'ABCDWXYZ',extensions:[source,index]});const prior=state.field(index).regions;
  state=state.update({changes:{from:4,insert:'X'}}).state;const current=state.field(index).regions;
  assert.equal(new Set(current.map(r=>r.id)).size,current.length,'all successor identities are unique');
  assert.equal(current.find(r=>r.from===5).id,prior[1].id,'unrelated exact successor is reserved');
  if(ambiguous)assert(current.filter(r=>r.from===0).every(r=>r.id!==prior[0].id),'ambiguous new ownership retires both candidates');
  else{assert.equal(current.find(r=>r.from===0&&r.to===4).id,prior[0].id);assert.notEqual(current.find(r=>r.from===0&&r.to===5).id,prior[0].id);}
 }
});
