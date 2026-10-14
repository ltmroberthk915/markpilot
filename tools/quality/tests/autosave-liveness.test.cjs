'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const r=spawnSync(process.execPath,[path.resolve(__dirname,'../autosave-liveness-model.cjs')],{encoding:'utf8',windowsHide:true,timeout:15000});
assert.equal(r.status,0,r.stderr||r.stdout);
const report=JSON.parse(r.stdout);
assert.equal(report.results.length,21);
assert.equal(report.summary.unexpected,0);
for(const item of report.results)test('actual autosave host: '+item.id,()=>{
  assert.equal(item.ok,true,JSON.stringify(item.detail));
  assert.match(report.host.sha256,/^[a-f0-9]{64}$/);
});
