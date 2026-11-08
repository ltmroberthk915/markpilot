import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fixture from './fixtures/layout-bootstrap.cjs';
const root=process.env.MP_TRIAL_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const client=path.join(root,'lib/client.js');
for(const activation of ['native','workbench'])for(const viewportWidth of [1281,1463])test(activation+' cold overlay boot at '+viewportWidth+' pins once before measuring and restores on close',()=>{
 const f=fixture.createFixture(client,{activation,viewportWidth,initialSb:280,initialRb:576});
 try {
  const first=f.geometry();assert.equal(first.rb,300);assert.equal(first.stage.display,'');assert(Number.parseFloat(first.stage.width)>=240);assert.equal(f.P.paintCalls(),1);
  for(let i=0;i<8;i++)f.engine.flush();assert.equal(f.P.paintCalls(),1,'idle apply must not paint handles again');
  const start=f.start();for(let i=1;i<=12;i++)f.P.onHandleMove(f.event(start+i));f.flush();assert.equal(f.P.paintCalls(),2,'12 raw moves should cause one additional RAF paint');
  f.P.onHandleUp(f.event(start+12,undefined,'pointerup'));f.P.close();f.flush();const closed=f.geometry();assert.equal(closed.sb,280);assert.equal(closed.rb,576);assert.equal(f.frame.hasAttribute('data-mp-grid'),false);assert.equal(closed.stage.display,'none');
 } finally {f.dispose();}
});
test('recent/workbench boot with native rightbar collapsed leaves zero right track and a visible editor',()=>{
 const f=fixture.createFixture(client,{activation:'workbench',viewportWidth:1281,initialSb:280,initialRb:0,rightbarClosed:true});
 try {const g=f.geometry();assert.equal(g.rb,0);assert.equal(g.stage.display,'');assert(Number.parseFloat(g.stage.width)>=240);f.P.close();f.flush();assert.equal(f.frame.hasAttribute('data-mp-grid'),false);}
 finally {f.dispose();}
});
