'use strict';
// Model checks of actual main.js functions, not native input or parser evidence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test'),acorn=require('acorn');
const source=fs.readFileSync(path.resolve(__dirname,'../../../dsh-markpilot/src-cm6/main.js'),'utf8');
const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
test('a reused row immediately paints its computed initial widths before deferred fitting',()=>{
 const node=ast.body.find(n=>n.type==='ClassDeclaration'&&n.id.name==='TableRowWidget');
 const method=node.body.body.find(n=>n.key.name==='toDOM');
 const cells=[0,1].map(()=>({dataset:{mpRow:'10',mpFrom:'11',mpTo:'12'},hasAttribute:()=>false,removeAttribute(){}}));
 const cols=[{style:{width:'50%'}},{style:{width:'50%'}}],table={firstElementChild:{children:cols},rows:[{cells}]},wrap={firstElementChild:table};
 const scope={cachedTableGeometry:()=>({fittedWidth:400}),tableWidthMetadata:()=>null,mathGeometryVersion:1,
  observeTableGeometry(){},tableRowDOMOwners:new WeakMap(),tableRowDOMViews:new WeakMap()};
 const render=Function('scope','with(scope){return function(inputView,reusableWrap){'+source.slice(method.value.body.start+1,method.value.body.end-1)+'};}')(scope);
 const widget={region:null,geometry:{},qDepth:0,weights:null,widths:[50,50],ranges:[[20,22],[23,25]],rowFrom:19,activeCol:-1,fitWidthsNow:()=>[30,70]};
 assert.equal(render.call(widget,{},wrap),wrap);
 assert.deepEqual(cols.map(col=>col.style.width),['30%','70%'],'existing columns must receive the fresh initial vector immediately');
 assert.equal(cells[1].dataset.mpFrom,'23','source positions rebound on retained cells');
});
function functions(scope,names){
 const code=names.map(name=>{const node=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert(node,name);return source.slice(node.start,node.end);}).join('\n');
 return Function('scope','with(scope){'+code+';return {'+names.join(',')+'};}')(scope);
}
function getter(scope,className){
 const node=ast.body.find(n=>n.type==='ClassDeclaration'&&n.id.name===className),method=node.body.body.find(n=>n.kind==='get'&&n.key.name==='estimatedHeight');
 return Function('scope','with(scope){return function(){'+source.slice(method.value.body.start+1,method.value.body.end-1)+'};}')(scope);
}
function rig(){
 const field={},view={},scope={regionIndexField:field,view,mathGeometryVersion:1,tableRowIndexes:new WeakMap(),tableRowOrdinals:new WeakMap(),tableLayoutSignatures:new WeakMap(),tableGeometryObservers:new WeakMap()};
 const f=functions(scope,['tableRowIndex','tableRowGeometry','cachedTableGeometry']),state={field:f=>{assert.equal(f,field);return{epoch:7};}};
 const block={from:10,cells:['A','B'],lead:0},tb={rows:[block],headerBlock:{qDepth:0},widths:[50,50],weights:[2,2],aligns:['left','left']},region={id:'7:3',contextVersion:0};
 const owner={recent:new Map()};scope.tableGeometryObservers.set(view,owner);
 const identity=f.tableRowGeometry(state,tb,block,false,region),record={signature:identity.signature,generation:1,width:300,height:200,viewportHeight:290};
 owner.recent.set(identity.key,record);
 return{scope,f,state,view,tb,block,region,identity,record,owner};
}
test('row geometry survives source-offset mapping but rejects changed content and table width policy',()=>{
 const r=rig(),moved={...r.block,from:50},tb={...r.tb,rows:[moved]};
 const id=r.f.tableRowGeometry(r.state,tb,moved,false,r.region);
 assert.equal(id.key,r.identity.key);assert.equal(r.f.cachedTableGeometry(r.view,id),r.record);
 for(const changed of [{...moved,cells:['much longer source','B']},{...moved,lead:2}]){
  const t={...tb,rows:[changed]},i=r.f.tableRowGeometry(r.state,t,changed,false,r.region);
  assert.equal(r.f.cachedTableGeometry(r.view,i),null);
 }
 for(const changed of [{widths:[40,60]},{weights:[1,8]},{aligns:['right','left']},{headerBlock:{qDepth:2}}]){
  const i=r.f.tableRowGeometry(r.state,{...tb,...changed},moved,false,r.region);
  assert.equal(r.f.cachedTableGeometry(r.view,i),null);
 }
});
test('epoch, context, row shape and layout generation prevent stale geometry reuse',()=>{
 const r=rig();
 for(const [state,tb,region] of [
  [{field:()=>({epoch:8})},r.tb,r.region],
  [r.state,r.tb,{...r.region,contextVersion:1}],
  [r.state,{...r.tb,rows:[r.block,{from:80,cells:['C','D']}]},r.region],
  [r.state,{...r.tb,widths:[30,30,40]},r.region],
 ]){
  const id=r.f.tableRowGeometry(state,tb,r.block,false,region);assert.equal(r.f.cachedTableGeometry(r.view,id),null);
 }
 r.scope.mathGeometryVersion++;assert.equal(r.f.cachedTableGeometry(r.view,r.identity),null);
 assert.equal(r.f.cachedTableGeometry({},r.identity),null,'A different view cannot inherit geometry');
});
test('table estimates return viewport measurements without layout reads or rescaling',()=>{
 const r=rig();r.scope.cachedTableGeometry=r.f.cachedTableGeometry;
 const estimate=getter(r.scope,'TableRowWidget'),widget={geometry:r.identity};
 Object.defineProperty(r.view,'scaleY',{get(){throw Error('Current CM scale may still be from before a zoom');}});
 assert.equal(estimate.call(widget),290);
 r.owner.recent.clear();assert.equal(estimate.call(widget),-1);
});
test('row fitting batches all reads before writes and rejects retired consumers',()=>{
 const queueScope={tableFitQueues:new WeakMap(),getComputedStyle:t=>({width:t.measuredWidth+'px'})},f=functions(queueScope,['scheduleTableFit']),requests=[],view={requestMeasure:r=>requests.push(r)},events=[];
 const work=name=>({table:{get measuredWidth(){events.push('read-'+name);return 300.25;},get clientWidth(){throw Error('Integer clientWidth loses fractional CSS width');}},valid:()=>true,finish:width=>events.push('write-'+name+'-'+width)});
 f.scheduleTableFit(view,work('A'));f.scheduleTableFit(view,work('B'));
 assert.equal(requests[0].key,requests[1].key);
 const data=requests.at(-1).read();requests.at(-1).write(data);
 assert.deepEqual(events,['read-A','read-B','write-A-300.25','write-B-300.25']);
 events.length=0;let valid=true;const old=work('old');old.valid=()=>valid;
 f.scheduleTableFit(view,old);const pending=requests.at(-1).read();valid=false;requests.at(-1).write(pending);
 assert.deepEqual(events,['read-old','write-old-null']);
 events.length=0;const cancel=f.scheduleTableFit(view,work('canceled'));cancel();requests.at(-1).write(requests.at(-1).read());assert.deepEqual(events,[]);
});
test('block-height recording uses real viewport units and drops released or obsolete results',()=>{
 const raf=[],scope={requestAnimationFrame:f=>raf.push(f),mathHeightKey:(tex,r)=>scope.generation+':'+r.id+':'+tex,generation:1,blockHeights:new Map(),lastLiveHeight:-1,lastLiveHeightKey:''};
 const f=functions(scope,['rememberBlockHeight']),region={id:'r'},span={isConnected:true,get offsetHeight(){throw Error('CSS height must not enter the viewport height map');},getBoundingClientRect:()=>({height:145.25})};
 f.rememberBlockHeight('T',span,false,region,{valid:()=>true});raf.shift()();assert.equal(scope.blockHeights.get('1:r:T'),145.25);
 const estimate=getter(scope,'MathPreview');assert.equal(estimate.call({display:true,live:false,tex:'T',region}),145.25);
 f.rememberBlockHeight('obsolete',span,false,region,{valid:()=>true});scope.generation++;raf.shift()();assert(!scope.blockHeights.has('1:r:obsolete'));
 f.rememberBlockHeight('released',span,false,region,{valid:()=>false});raf.shift()();assert(!scope.blockHeights.has('2:r:released'));
 f.rememberBlockHeight('live',span,true,region,{valid:()=>true});raf.shift()();assert.equal(estimate.call({display:true,live:true,tex:'new',region}),145.25);
 scope.generation++;assert.equal(estimate.call({display:true,live:true,tex:'new',region}),-1);
 assert.equal(estimate.call({display:true,live:true,tex:'new',region:{id:'another'}}),-1);
});
test('selection-only active-cell updates keep field identity, while edits still map and retire it',async()=>{
 const {pathToFileURL}=require('node:url'),cm=await import(pathToFileURL(path.resolve(__dirname,'../../../dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href);
 const declarations=['setActiveCell','activeCellField'].map(name=>{const node=ast.body.find(n=>n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name===name));assert(node);return source.slice(node.start,node.end);}).join('\n');
 const {setActiveCell,activeCellField}=Function('StateEffect','StateField','parseTableRow',declarations+';return{setActiveCell,activeCellField};')(cm.StateEffect,cm.StateField,t=>t.startsWith('|'));
 let state=cm.EditorState.create({doc:'before\n| A | B |\n',extensions:[activeCellField]});
 state=state.update({effects:setActiveCell.of({rowFrom:7,col:1})}).state;const original=state.field(activeCellField);
 state=state.update({selection:{anchor:9}}).state;assert.equal(state.field(activeCellField),original);
 state=state.update({effects:setActiveCell.of({rowFrom:7,col:1})}).state;assert.equal(state.field(activeCellField),original);
 state=state.update({changes:{from:0,insert:'x'}}).state;assert.equal(state.field(activeCellField).rowFrom,8);assert.notEqual(state.field(activeCellField),original);
 state=state.update({changes:{from:8,to:9,insert:'plain'}}).state;assert.equal(state.field(activeCellField),null);
});
