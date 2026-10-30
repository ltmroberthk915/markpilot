'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../../..'),engine=createRequire(path.join(root,'dsh-markpilot/package.json'));
test('actual pending parser preserves only the mapped prefix without native work, aliasing or scheduler spin',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markpilot-prefix-unit-'));
 Object.defineProperty(globalThis,'navigator',{value:{platform:'Win32',userAgent:'Node prefix test'},configurable:true});
 try{
  const file=path.join(dir,'probe.cjs');
  await engine('esbuild').build({entryPoints:[path.join(__dirname,'fixtures/pending-prefix.mjs')],bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'error',nodePaths:[path.join(root,'dsh-markpilot/node_modules')]});
  const r=require(file).run();assert(r.bufferedCuts>40);assert.equal(r.nativeCalls,0);assert(r.rawUnchanged);
 }finally{const actual=fs.realpathSync(dir);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert(path.basename(actual).startsWith('markpilot-prefix-unit-'));fs.rmSync(actual,{recursive:true,force:true});}
});
test('actual mixed parser drops redundant table fragments but preserves nested mounts and native commands',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markpilot-mixed-fragments-'));
 Object.defineProperty(globalThis,'navigator',{value:{platform:'Win32',userAgent:'Node mixed fragment test'},configurable:true});
 try{
  const file=path.join(dir,'probe.cjs');
  await engine('esbuild').build({entryPoints:[path.join(__dirname,'fixtures/mixed-fragments.mjs')],bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'error',nodePaths:[path.join(root,'dsh-markpilot/node_modules')]});
  const results=require(file).run();assert.equal(results.length,2);assert(results.every(r=>r.pendingCalls&&r.forcedCalls));
 }finally{const actual=fs.realpathSync(dir);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert(path.basename(actual).startsWith('markpilot-mixed-fragments-'));fs.rmSync(actual,{recursive:true,force:true});}
});
