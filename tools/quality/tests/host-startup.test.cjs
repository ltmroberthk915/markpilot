'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('actual host and document handlers preserve ownership across controlled startup races',()=>{
  const tool=path.resolve(__dirname,'../host-startup.mjs');
  const child=spawnSync(process.execPath,[tool],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(child.status,0,child.stderr||child.stdout);
  const result=JSON.parse(child.stdout);
  assert.equal(result.passed,true);assert.equal(result.total,14);
  assert(result.results.every(item=>item.passed));
  assert(result.scope.includes('controlled IO/IPC/DOM'));
  for(const hash of Object.values(result.hashes))assert.match(hash,/^[a-f0-9]{64}$/);
});
