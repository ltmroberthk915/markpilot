'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../../..');
const modules=Promise.all([
 import(pathToFileURL(path.join(ROOT,'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href),
 import(pathToFileURL(path.join(ROOT,'dsh-markpilot/node_modules/@codemirror/commands/dist/index.js')).href),
 import(pathToFileURL(path.join(ROOT,'dsh-markpilot/src-cm6/image-removal.js')).href),
]);
const A='data:image/png;base64,QQ==',B='data:image/png;base64,Qg==';
const image=(src=A,alt='a')=>'!['+alt+']('+src+')';
const initial=image()+'\nKEEP\n';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// The gate's image-provider dependency is deliberately a small fixture parser.
// Actual gate, EditorState transaction filtering, and CM history run unchanged.
const images=state=>[...state.doc.toString().matchAll(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g)]
 .map(match=>({data:{image:{src:match[1]}}}));

async function fixture(doc=initial,extra=[],filterFactory=null) {
 const [S,C,G]=await modules;
 const env={identity:1,filePath:'D:/owned/fixture.md',documentId:'doc-1',bypass:false,after:0,closes:0,backupCalls:[],backupAnswer:{ok:true,files:[]}};
 const choices=[],applied=[];
 let gate;
 const view={dom:{isConnected:true},focusCalls:0,focus(){this.focusCalls++;},
  update(transactions){for(const transaction of transactions){assert.equal(transaction.startState,this.state,'CM transaction belongs to current state');this.state=transaction.state;applied.push(transaction);}},
  dispatch(...input){const transactions=input.length===1&&input[0] instanceof S.Transaction ? input
    : input.length===1&&Array.isArray(input[0]) ? input[0] : [this.state.update(...input)];gate.dispatch(transactions,this);},
 };
 view.dispatch=view.dispatch.bind(view);
 const removalFilter=filterFactory ? filterFactory(transaction=>gate.filter(transaction),env)
  : S.EditorState.transactionFilter.of(transaction=>gate.filter(transaction));
 view.state=S.EditorState.create({doc,extensions:[C.history(),removalFilter,...extra]});
 gate=G.createImageRemovalGate({getView:()=>view,images,identity:()=>env.identity,bypass:()=>env.bypass,
  path:()=>env.filePath,afterApply:()=>env.after++,
  host:()=>({currentDoc:async()=>({documentId:env.documentId,filePath:env.filePath}),
   backupEmbeddedImages:async request=>{env.backupCalls.push(request);return env.backupAnswer;}}),
  prompt:choice=>{choices.push(choice);return()=>{env.closes++;};},
 });
 return {S,C,G,view,gate,env,choices,applied,text:()=>view.state.doc.toString(),depth:()=>[C.undoDepth(view.state),C.redoDepth(view.state)],
  remove:()=>view.dispatch({changes:{from:0,to:image().length+1},userEvent:'delete.selection'}),
  choice:async()=>{await tick();assert(choices.length,'pending choice becomes visible');return choices.at(-1);},
 };
}

test('ordinary removal waits; cancel preserves source, selection and history',async()=>{
 const f=await fixture(),before=f.view.state,history=before.field(f.C.historyField);
 f.remove();assert.equal(f.text(),initial);assert.deepEqual(f.depth(),[0,0]);
 const choice=await f.choice();assert.equal(choice.count,1);assert.equal(choice.valid(),true);
 choice.finish(false);assert.equal(f.text(),initial);assert(f.view.state.selection.eq(before.selection));
 assert.equal(f.view.state.field(f.C.historyField),history);assert.deepEqual(f.depth(),[0,0]);assert.equal(f.env.after,0);
});

test('direct approval is one exact edit preserving effects, annotation, time and history',async()=>{
 const [S]=await modules,mark=S.Annotation.define(),set=S.StateEffect.define();
 const field=S.StateField.define({create:()=>0,update:(value,tr)=>{for(const effect of tr.effects)if(effect.is(set))value=effect.value;return value;}});
 const f=await fixture(initial,[field]),at=image().length+1;
 f.view.dispatch({changes:{from:0,to:at},selection:{anchor:2},effects:set.of(7),
  annotations:[mark.of('original-plan'),S.Transaction.time.of(123456)],userEvent:'delete.selection',scrollIntoView:true});
 assert.equal(f.view.state.field(field),0);
 const choice=await f.choice();choice.finish(true);
 assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.depth(),[1,0]);assert.equal(f.view.state.field(field),7);
 const tr=f.applied.at(-1);assert.equal(tr.annotation(mark),'original-plan');assert.equal(tr.annotation(S.Transaction.time),123456);
 assert.equal(tr.annotation(S.Transaction.userEvent),'delete.selection');assert.equal(tr.newSelection.main.head,2);assert(tr.scrollIntoView);
 choice.finish(true);assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.depth(),[1,0]);assert.equal(f.env.after,1,'choice cannot apply twice');
 assert(f.C.undo(f.view));assert.equal(f.text(),initial);assert.deepEqual(f.depth(),[0,1]);
});

test('destructive Undo filter:false waits and cancel retains future Undo/Redo',async()=>{
 const f=await fixture('KEEP\n');f.view.dispatch({changes:{from:0,insert:image()+'\n'},userEvent:'input.paste'});
 assert.deepEqual(f.depth(),[1,0]);assert.equal(f.choices.length,0);
 const history=f.view.state.field(f.C.historyField),before=f.text();
 assert(f.C.undo(f.view));assert.equal(f.text(),before);assert.deepEqual(f.depth(),[1,0]);
 (await f.choice()).finish(false);assert.equal(f.view.state.field(f.C.historyField),history);assert.equal(f.text(),before);
 assert(f.C.undo(f.view));(await f.choice()).finish(true);assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.depth(),[0,1]);
 assert(f.C.redo(f.view));assert.equal(f.text(),before);assert.deepEqual(f.depth(),[1,0]);
 assert.equal(f.choices.length,2,'restoring the image with Redo requires no choice');
});

test('destructive Redo filter:false waits; cancellation preserves the redo branch',async()=>{
 const f=await fixture();f.remove();(await f.choice()).finish(true);assert(f.C.undo(f.view));
 const history=f.view.state.field(f.C.historyField);assert.deepEqual(f.depth(),[0,1]);
 assert(f.C.redo(f.view));assert.equal(f.text(),initial);(await f.choice()).finish(false);
 assert.equal(f.view.state.field(f.C.historyField),history);assert.deepEqual(f.depth(),[0,1]);
 assert(f.C.redo(f.view));(await f.choice()).finish(true);assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.depth(),[1,0]);
 assert(f.C.undo(f.view));assert.equal(f.text(),initial);
});

test('duplicate occurrence removal asks; metadata edits and image moves do not',async()=>{
 const doc=image(A,'a')+'\n'+image(A,'b')+'\n'+image(B,'c')+'\n',f=await fixture(doc);
 f.view.dispatch({changes:{from:2,to:3,insert:'metadata'},userEvent:'input.type'});await tick();assert.equal(f.choices.length,0);
 const moved=image(B,'c')+'\n'+image(A,'b')+'\n'+image(A,'metadata')+'\n';
 f.view.dispatch({changes:{from:0,to:f.view.state.doc.length,insert:moved},userEvent:'input.move'});await tick();assert.equal(f.choices.length,0);
 const first=moved.indexOf(image(A,'b'));
 f.view.dispatch({changes:{from:first,to:first+image(A,'b').length+1},userEvent:'delete.selection'});
 assert.equal(f.text(),moved);const choice=await f.choice();assert.equal(choice.count,1);choice.finish(true);
 assert.equal(f.text(),image(B,'c')+'\n'+image(A,'metadata')+'\n');
});

test('backup callback binds document/path and deduplicates sources; failed host does not itself apply',async()=>{
 const doc=image()+'\n'+image()+'\n'+image(B)+'\n',f=await fixture(doc);
 f.env.backupAnswer={ok:false,error:'injected failure',files:[{relPath:'assets/kept.png'}]};
 f.view.dispatch({changes:{from:0,to:f.view.state.doc.length},userEvent:'delete.selection'});
 const choice=await f.choice();assert.equal(choice.count,3);const answer=await choice.backup();
 assert.equal(answer.ok,false);assert.equal(f.text(),doc);assert.deepEqual(f.depth(),[0,0]);
 assert.deepEqual(f.env.backupCalls,[{documentId:'doc-1',filePath:'D:/owned/fixture.md',sources:[A,B]}]);
 // This tests the gate callback only. Real dialog failure/retry behavior is UI evidence.
 choice.finish(false);assert.equal(f.text(),doc);assert.deepEqual(f.depth(),[0,0]);
});

test('pending ordinary input and filter:false history edits cannot replace the plan',async()=>{
 const f=await fixture();f.remove();const choice=await f.choice();
 f.view.dispatch({changes:{from:f.view.state.doc.length,insert:'BAD'},userEvent:'input.type'});
 f.view.dispatch(f.view.state.update({changes:{from:0,to:1},filter:false,userEvent:'undo'}));
 assert.equal(f.text(),initial);assert.deepEqual(f.depth(),[0,0]);assert.equal(f.choices.length,1);assert(choice.valid());
 choice.finish(true);assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.depth(),[1,0]);
});

test('selection change invalidates an old approval',async()=>{
 const f=await fixture();f.remove();const choice=await f.choice();
 f.view.dispatch({selection:{anchor:1},userEvent:'select.pointer'});assert.equal(f.env.closes,1);assert.equal(choice.valid(),false);
 choice.finish(true);assert.equal(f.text(),initial);assert.equal(f.view.state.selection.main.head,1);assert.deepEqual(f.depth(),[0,0]);
});

test('new identity, doc root, path, disconnected view and readonly state each invalidate replay',async()=>{
 for(const kind of ['identity','doc','path','disconnect','readonly']){
  const f=await fixture();f.remove();const choice=await f.choice();
  if(kind==='identity')f.env.identity++;
  if(kind==='doc')f.view.state=f.S.EditorState.create({doc:initial,extensions:[f.C.history()]});
  if(kind==='path')f.env.filePath='D:/other/new.md';
  if(kind==='disconnect')f.view.dom.isConnected=false;
  if(kind==='readonly')f.view.dispatch({effects:f.S.StateEffect.appendConfig.of(f.S.EditorState.readOnly.of(true))});
  assert.equal(choice.valid(),false,kind);choice.finish(true);assert.equal(f.text(),initial,kind);assert.equal(f.env.after,0,kind);
 }
});

test('explicit load cancels a pending plan; old choice cannot edit the replacement document',async()=>{
 const f=await fixture();f.remove();const choice=await f.choice();f.env.bypass=true;
 f.view.dispatch({changes:{from:0,to:f.view.state.doc.length,insert:'NEW DOCUMENT\n'},annotations:f.S.Transaction.addToHistory.of(false)});
 f.env.bypass=false;assert.equal(f.env.closes,1);assert.equal(choice.valid(),false);choice.finish(true);
 assert.equal(f.text(),'NEW DOCUMENT\n');assert.equal(f.env.after,0);assert.deepEqual(f.depth(),[0,0]);
});

test('a history-owner change without doc change invalidates replay',async()=>{
 const f=await fixture();f.view.dispatch({changes:{from:f.view.state.doc.length,insert:'X'},userEvent:'input.type'});
 f.remove();const choice=await f.choice(),before=f.text();
 f.view.dispatch({annotations:f.C.isolateHistory.of('full')});
 assert.equal(choice.valid(),false);choice.finish(true);assert.equal(f.text(),before);assert.equal(f.env.after,0);
});

test('batch gate preserves all sequential effects and exact final source',async()=>{
 const [S]=await modules,set=S.StateEffect.define();
 const field=S.StateField.define({create:()=>[],update:(value,tr)=>{for(const e of tr.effects)if(e.is(set))value=value.concat(e.value);return value;}});
 const f=await fixture(initial,[field]);
 const first=f.view.state.update({effects:set.of('first'),annotations:S.Transaction.addToHistory.of(false),filter:false});
 const second=first.state.update({changes:{from:0,to:image().length+1},effects:set.of('second'),userEvent:'delete.selection',filter:false});
 f.view.dispatch([first,second]);assert.equal(f.text(),initial);assert.deepEqual(f.view.state.field(field),[]);
 (await f.choice()).finish(true);assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.view.state.field(field),['first','second']);
 assert.deepEqual(f.depth(),[1,0]);assert(f.C.undo(f.view));assert.equal(f.text(),initial);
});

test('actual applySourceHistory selection preparation retains exact Undo/Redo after cancel',async()=>{
 const {applySourceHistory}=await import(pathToFileURL(path.join(ROOT,'dsh-markpilot/src-cm6/command-context.js')).href);
 const f=await fixture('KEEP\n'),insert=image()+'\n';
 f.view.dispatch({changes:{from:0,insert},selection:{anchor:insert.length},userEvent:'input.paste'});
 const before=f.text(),selection=f.view.state.selection;
 assert(applySourceHistory(f.view,'undo'));const history=f.view.state.field(f.C.historyField);
 assert.equal(f.text(),before);(await f.choice()).finish(false);assert.equal(f.view.state.field(f.C.historyField),history);
 assert.deepEqual(f.depth(),[1,0]);assert(applySourceHistory(f.view,'undo'));(await f.choice()).finish(true);
 assert.equal(f.text(),'KEEP\n');assert.deepEqual(f.depth(),[0,1]);assert(applySourceHistory(f.view,'redo'));
 assert.equal(f.text(),before);assert(f.view.state.selection.eq(selection));assert.deepEqual(f.depth(),[1,0]);
});

test('explicit load bypass also permits minimal diff inside a protected data URL',async()=>{
 const [S]=await modules;
 const {protectImagePayloads}=await import(pathToFileURL(path.join(ROOT,'dsh-markpilot/src-cm6/image-payload.js')).href);
 const {createRegionIndex}=await import(pathToFileURL(path.join(ROOT,'dsh-markpilot/src-cm6/region-index.js')).href);
 const index=createRegionIndex(state=>[...state.doc.toString().matchAll(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g)]
  .map(match=>{const from=match.index,p=from+match[0].indexOf(match[1]);return {kind:'image',form:'markdown',from,to:from+match[0].length,
   payload:[p,p+match[1].length],data:{image:{src:match[1]}},content:[match[1]],context:{key:'fixture-body'}};}));
 const f=await fixture(initial,[index],(callback,env)=>protectImagePayloads(index,callback,()=>env.bypass));
 const at=initial.indexOf('QQ=='),next=initial.slice(0,at)+'R'+initial.slice(at+1);
 f.view.dispatch({changes:{from:at,to:at+1,insert:'R'},userEvent:'input.type'});
 await tick();assert.equal(f.text(),initial,'ordinary typing inside encoded image stays rejected');assert.equal(f.choices.length,0);
 f.env.bypass=true;
 f.view.dispatch({changes:{from:at,to:at+1,insert:'R'},annotations:S.Transaction.addToHistory.of(false)});
 f.env.bypass=false;await tick();
 assert.equal(f.text(),next,'explicit external load must not silently retain stale image bytes');
 assert.equal(f.choices.length,0);assert.deepEqual(f.depth(),[0,0]);
});
