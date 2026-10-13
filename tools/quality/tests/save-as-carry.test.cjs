'use strict';
// PRIVATE MODEL ONLY. Extract actual doSave; mutate one local string, never files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{test,after}=require('node:test');
function repositoryRoot(start){let p=fs.realpathSync(start);for(;;){if(fs.existsSync(path.join(p,'MarkPilot-CM6/renderer/host.js'))&&fs.existsSync(path.join(p,'tools/quality/tests/command-context.test.cjs')))return p;const q=path.dirname(p);if(q===p)throw Error('Repository not found');p=q;}}
const ROOT=repositoryRoot(__dirname),HOST=path.join(ROOT,'MarkPilot-CM6/renderer/host.js');
const bytes=fs.readFileSync(HOST),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),hostSha=hash(bytes),source=bytes.toString('utf8');
const mode=process.argv[2]||'off';assert(['on','off'].includes(mode),'Use node save-as-carry.test.cjs on|off');
const startAnchor='async function doSave(force = false, grant = null, saveAsOperation = null) {',endAnchor='async function saveAsFlow() {';
assert.equal(source.split(startAnchor).length,2,'Unique production doSave start');assert.equal(source.split(endAnchor).length,2,'Unique following production function');
const start=source.indexOf(startAnchor),end=source.indexOf(endAnchor,start);assert(end>start);
const original=source.slice(start,end).trim();assert(original.endsWith('}'),'Exact function end');
const carry='return doSave(force, grant, saveAsOperation);';assert.equal(original.split(carry).length,2,'Unique recursive carry anchor');
assert(original.includes('await saveTask;')&&original.includes('await currentText()')&&original.includes('!operationCurrent()'),'Production await/guard sanity');
const extracted=mode==='on'?original.replace(carry,'return doSave(force, grant);'):original;
assert.equal(hash(fs.readFileSync(HOST)),hostSha,'String mutation leaves production exact bytes unchanged');
after(()=>assert.equal(hash(fs.readFileSync(HOST)),hostSha,'Production file still byte-identical after models'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function rig(){
 const initial=deferred(),text=deferred(),entered=deferred(),events=[],writes=[],failures=[];
 const env={initialTask:initial.promise,currentText:()=>{events.push('recursive-currentText-entered');entered.resolve();return text.promise;},engineValue:()=>null,syncSource:()=>events.push('capture-source'),saveTrace:(stage)=>events.push(stage),saveFailure:e=>failures.push(e),scheduleSave:()=>events.push('schedule-save'),window:{mpEngine:{commands:{capture:()=>({owner:'cm'})}},mpHost:{save:async(file,body,metadata)=>{writes.push({file,body,metadata});return{ok:true,current:true,filePath:file};},docSaved:async()=>events.push('docSaved')}}};
 const host=new Function('env','"use strict";\n'+
  'let saveAsSerial=1,documentId="same-doc",filePath="primary.md",revision=7,recoverySerial=0;\n'+
  'let saveInFlight=true,saveTask=env.initialTask,saveBlocked=false,saveTimer=0,dirty=true,lastSaveError=null,knownLen=20;\n'+
  'const SHRINK_MIN=1000,SHRINK_RATIO=.5,window=env.window;\n'+
  'const {currentText,engineValue,syncSource,saveTrace,saveFailure,scheduleSave}=env;\n'+
  'const publishDocDir=()=>{},hideBanner=()=>{},refreshTitle=()=>{},showBanner=()=>{throw Error("Unexpected shrink banner");};\n'+
  'const saveAsFlow=()=>{throw Error("Unexpected Save As entry");};\n'+extracted+'\n'+
  'return {doSave,finishInitial:()=>{saveInFlight=false;saveTask=null;},supersede:()=>{saveAsSerial++;},snapshot:()=>({saveAsSerial,documentId,filePath,revision,saveInFlight,dirty,lastSaveError})};')(env);
 return{host,initial,text,entered,events,writes,failures};
}
// Returning the pending Promise from an async helper would assimilate it and
// deadlock before text resolution. The wrapper keeps it as an ordinary property.
async function prepared(r){
 let pending;
 const grant={documentId:'same-doc',filePath:'older.md',saveAsToken:'older-token'};
 pending=r.host.doSave(true,grant,1);assert.deepEqual(r.events,['capture-source']);assert.equal(r.writes.length,0);
 // Complete the first task while operation 1 is current. Its after-await guard
 // passes; only then enter recursion's actual deferred currentText await.
 r.host.finishInitial();r.initial.resolve(true);await r.entered.promise;
 assert.equal(r.host.snapshot().saveAsSerial,1,'First after-await guard passed under current operation');
 assert.equal(r.host.snapshot().saveInFlight,true);assert.equal(r.events.filter(e=>e==='capture-source').length,2,'Actual recursive entry');assert.equal(r.events.filter(e=>e==='recursive-currentText-entered').length,1,'Actual currentText barrier');assert.equal(r.writes.length,0);
 return{pending};
}
test('MODEL recursive carry rejects older operation superseded DURING recursive text await',{timeout:3000},async()=>{
 const r=rig(),{pending}=await prepared(r);r.host.supersede();assert.equal(r.host.snapshot().saveAsSerial,2);r.text.resolve('latest source\n');
 const outcome=await pending;
 assert.equal(r.writes.length,0,'recursive save must carry Save As operation; stale operation dispatches no save IPC');
 assert.equal(outcome,false);assert.equal(r.host.snapshot().filePath,'primary.md','Old target never adopted');assert.deepEqual(r.failures,[],'No stale recovery UI');
});
test('MODEL recursive carry positive control saves source when operation remains current',{timeout:3000},async()=>{
 const r=rig(),{pending}=await prepared(r);r.text.resolve('latest source\n');assert.equal(await pending,true);
 assert.deepEqual(r.writes,[{file:'older.md',body:'latest source\n',metadata:{documentId:'same-doc',revision:7,saveAsToken:'older-token'}}]);
 assert.equal(r.host.snapshot().filePath,'older.md');assert.deepEqual(r.failures,[]);
});
console.log(JSON.stringify({modelOnly:true,mutation:mode,hostSha256:hostSha,originalFunctionSha256:hash(original),effectiveFunctionSha256:hash(extracted),filesystemMutation:false}));
