'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../../../dsh-markpilot/src-cm6/floating-layout.js');
test('short and long frames stay inside the visible source column',async()=>{
 const {horizontalFrame}=await modulePromise;
 assert.deepEqual(horizontalFrame({left:178.08,right:928,preferredLeft:550.63,naturalWidth:398.39}),{left:529.61,width:398.39,maxWidth:749.92});
 const wide=horizontalFrame({left:212.36,right:725,preferredLeft:212.36,naturalWidth:1377.91});
 assert.equal(wide.left,212.36);assert.equal(wide.width,725-212.36);assert.equal(wide.left+wide.width,725);
 const block=horizontalFrame({left:135.1,right:572.5,preferredLeft:345.94,naturalWidth:100,center:true});
 assert(Math.abs(block.left-303.8)<1e-8);assert.equal(block.width,100);
 assert.equal(horizontalFrame({left:20,right:20,preferredLeft:20,naturalWidth:100}),null);
 assert.equal(horizontalFrame({left:0,right:100,preferredLeft:NaN,naturalWidth:50}),null);
});
test('fixed-seed placements clamp to the nearest legal horizontal position',async()=>{
 const {horizontalFrame}=await modulePromise;let seed=32924;
 const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let i=0;i<512;i++){
  const left=random()*700-350,right=left+1+random()*900,preferredLeft=random()*2500-1250,naturalWidth=1+random()*2000,center=i%2===0;
  const r=horizontalFrame({left,right,preferredLeft,naturalWidth,center});
  assert(r.left>=left-1e-8&&r.left+r.width<=right+1e-8,'entire border-box is bounded');
  assert.equal(r.width,Math.min(naturalWidth,right-left),'font preserves intrinsic size when it fits');
  if(center)assert(Math.abs((r.left+r.width/2)-(left+right)/2)<1e-8);
  else for(const x of [left,right-r.width,(left+right-r.width)/2])assert(Math.abs(r.left-preferredLeft)<=Math.abs(x-preferredLeft)+1e-8,'nearest legal position');
 }
});
test('quote borders, scroll offsets and CSS zoom round-trip without DPR',async()=>{
 const {localPoint}=await modulePromise;
 for(const zoom of [1,1.5,2])for(const clientLeft of [0,3])for(const scrollTop of [0,1297.5]){
  const parent={left:162,top:-200,clientLeft,clientTop:2,scrollLeft:37,scrollTop,zoom},desired={left:529.61,top:154.875};
  const p=localPoint(desired,parent);
  assert(Math.abs(parent.left+(p.left+clientLeft-parent.scrollLeft)*zoom-desired.left)<1e-8);
  assert(Math.abs(parent.top+(p.top+parent.clientTop-scrollTop)*zoom-desired.top)<1e-8);
 }
 assert.equal(localPoint({left:0,top:0},{zoom:0}),null);
});
