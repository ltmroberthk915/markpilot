'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {waitUntil}=require('../harness.cjs');
test('async false must be polled rather than treating the Promise as success',async()=>{
 let calls=0;await waitUntil(async()=>++calls===3,'delayed truth',1000);assert.equal(calls,3);
 await assert.rejects(waitUntil(async()=>false,'always false',100),/Timed out/);
});
