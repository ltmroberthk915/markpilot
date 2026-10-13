'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const modulePromise=import(pathToFileURL(path.resolve(__dirname,'../../../dsh-markpilot/src-cm6/overlay-layout.js')).href);
test('preview placement avoids next paragraph, input caret and higher-priority control hit areas',async()=>{
 const {verticalFrame,overlap}=await modulePromise,bounds={top:0,bottom:400},anchor={top:100,bottom:120};
 const obstacles=[{left:0,right:200,top:100,bottom:120},{left:0,right:200,top:140,bottom:210},{left:0,right:200,top:220,bottom:400}];
 const p=verticalFrame({bounds,anchor,left:10,width:150,height:30,obstacles});assert(p&&!p.constrained);
 const rect={left:10,right:160,top:p.top,bottom:p.top+p.height};assert(obstacles.every(o=>!overlap(o,rect)));
});
test('vertical scrolling is requested only after no full-height safe band fits',async()=>{
 const {verticalFrame}=await modulePromise;
 const base={bounds:{top:0,bottom:100},anchor:{top:20,bottom:30},left:0,width:100,height:70,obstacles:[{left:0,right:100,top:30,bottom:65}]};
 assert.equal(verticalFrame(base).constrained,true);assert.equal(verticalFrame({...base,height:20}).constrained,false);
 assert.equal(verticalFrame({...base,minimumHeight:40}),null);
});
