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
test('formula avoidance is bounded in both directions and distant bands use the covering anchor',async()=>{
 const {previewFrame,PREVIEW_MAX_DISPLACEMENT}=await modulePromise;
 assert.equal(PREVIEW_MAX_DISPLACEMENT,67.2);
 const base={bounds:{top:0,bottom:800},anchor:{top:350,bottom:370},legacyTop:376,left:0,width:200,height:50};
 for(const band of [[100,150],[650,700]]){
  const obstacles=[{left:0,right:200,top:0,bottom:band[0]},{left:0,right:200,top:band[1],bottom:800}];
  const result=previewFrame({...base,obstacles});assert.equal(result.top,376);assert.equal(result.overlay,true);
 }
 const near=previewFrame({...base,obstacles:[{left:0,right:200,top:0,bottom:420},{left:0,right:200,top:475,bottom:800}]});
 assert.equal(near.overlay,false);assert(Math.abs(near.top-base.legacyTop)<=67.2);
 const beyond=previewFrame({...base,obstacles:[{left:0,right:200,top:0,bottom:444},{left:0,right:200,top:500,bottom:800}]});
 assert.equal(beyond.overlay,true);assert.equal(beyond.top,base.legacyTop);
});
test('a blocked or shorter safe band keeps the full preview height at its covering anchor',async()=>{
 const {previewFrame}=await modulePromise;
 const result=previewFrame({bounds:{top:0,bottom:300},anchor:{top:230,bottom:260},left:0,width:200,height:500,minimumHeight:24,obstacles:[{left:0,right:200,top:0,bottom:300}]});
 assert.equal(result.top,266);assert.equal(result.height,500);assert(result.overlay&&!result.constrained);
 const partial=previewFrame({bounds:{top:0,bottom:200},anchor:{top:30,bottom:50},left:0,width:100,height:80,obstacles:[{left:0,right:100,top:0,bottom:50},{left:0,right:100,top:90,bottom:200}]});
 assert.equal(partial.top,56);assert.equal(partial.height,80);assert(partial.overlay&&!partial.constrained);
});
test('disabled preview avoidance stays directly below source and never reads obstacles',async()=>{
 const {previewFrame}=await modulePromise;
 for(const anchor of [{top:230,bottom:260},{top:-100,bottom:-80}]){
  const options={bounds:{top:0,bottom:240},anchor,left:0,width:200,height:500,avoidance:false};
  Object.defineProperty(options,'obstacles',{enumerable:true,get(){throw Error('disabled placement must not inspect obstacles');}});
  assert.deepEqual(previewFrame(options),{top:anchor.bottom+6,height:500,constrained:false,overlay:true,displacement:0});
 }
});
