const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({fe,wait,pause,test,wheel,toggle,mode,mouse,output,setup})=>{
  for(const [count,quality] of [[210,'blocks'],[1050,'ratio']]){
    const text='# 大文件分屏性能验收\n\n'+Array.from({length:count},(_,i)=>'## 段落 '+i+'\n\n'+('largeFile'+i+' 这是一段用于检查滚动同步、缓存和自动降级的长文本。').repeat(24)+'\n\n').join('');
    const file=path.join(output,'大文件-'+quality+'.md');fs.writeFileSync(file,text);
    const started=Date.now();await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});await wait('vditor.getValue().includes("largeFile'+(count-1)+'")&&!!vditor.__splitNavigation');
    await setup();await mode('ir');await fe('(()=>{const e=vditor.vditor,r=e.ir.element;r.focus();getSelection().collapse(r,0);r.scrollTop=(r.scrollHeight-r.clientHeight)*.52;return true;})()');await pause(120);
    const before=await fe('__flow.pane("visual").scrollTop/(__flow.pane("visual").scrollHeight-__flow.pane("visual").clientHeight)');
    const entryStarted=Date.now();await toggle();await wait('vditor.__splitNavigation.active&&vditor.__splitNavigation.source===vditor.getValue()');await pause(200);
    await test('large-'+quality+'-entry-and-degradation',async()=>{
      const state=await fe('({...__flow.state(),chars:vditor.getValue().length,pointCount:vditor.__splitNavigation.blocks.reduce((n,b)=>n+b.points.length,0)})');
      assert.equal(state.quality,quality);assert.equal(state.pointCount,0,'Large files must omit per-character render mappings');assert.ok(state.panes.every(p=>p.top>p.client*2),JSON.stringify(state));
      if(quality==='ratio')assert.ok(state.panes.every(p=>Math.abs(p.top/(p.height-p.client)-before)<.01),JSON.stringify(state));
      return{bytes:Buffer.byteLength(text),chars:text.length,openAndEntryMs:Date.now()-started,entryMs:Date.now()-entryStarted,before,state};
    });
    await test('large-'+quality+'-both-wheel-directions-and-cache',async()=>{
      await fe('window.__flowLongTasks=[];window.__flowPerfObserver=new PerformanceObserver(list=>window.__flowLongTasks.push(...list.getEntries().map(e=>e.duration)));window.__flowPerfObserver.observe({type:"longtask",buffered:false});true');
      const before=await fe('({...__flow.state(),value:vditor.getValue()})');
      for(const side of ['source','preview'])for(const delta of [-430,-170,340,190]){
        const old=await fe('__flow.state()');await wheel(side,delta);const next=await fe('__flow.state()');assert.ok(next.panes.every((p,i)=>Math.abs(p.top-old.panes[i].top)>15),JSON.stringify({side,delta,old,next}));
        if(quality==='ratio'){const r=next.panes.map(p=>p.top/(p.height-p.client));assert.ok(Math.abs(r[0]-r[1])<.002,JSON.stringify(r));}
      }
      const after=await fe('({...__flow.state(),value:vditor.getValue(),longTasks:__flowLongTasks})');await fe('__flowPerfObserver.disconnect();true');
      assert.equal(after.value,before.value);assert.equal(after.stats.modelBuilds,before.stats.modelBuilds);assert.equal(after.stats.parses,before.stats.parses);assert.equal(after.stats.bindings,before.stats.bindings);
      assert.ok(after.stats.maxScrollSyncMs<80,JSON.stringify(after.stats));assert.ok(Math.max(0,...after.longTasks)<120,JSON.stringify(after.longTasks));
      await pause(200);const settled=await fe('__flow.state()');assert.ok(settled.panes.every((p,i)=>Math.abs(p.top-after.panes[i].top)<3),'Large-file feedback loop');return{before:before.stats,after:after.stats,longTasks:after.longTasks};
    });
    await test('large-'+quality+'-divider-reflow',async()=>{
      const before=await fe('({...__flow.state(),value:vditor.getValue()})'),bar=await fe('__flow.box(document.querySelector(".typora-split-divider"))');
      await mouse('mouseDown',bar,{clickCount:1});for(let i=1;i<=10;i++){await mouse('mouseMove',{x:bar.x+i*15,y:bar.y},{modifiers:['leftButtonDown']});await pause(20);}await mouse('mouseUp',{x:bar.x+150,y:bar.y},{clickCount:1});await pause(300);
      const after=await fe('({...__flow.state(),value:vditor.getValue()})');assert.ok(after.panes[0].rect.width-before.panes[0].rect.width>120);assert.equal(after.value,before.value);assert.equal(after.stats.parses,before.stats.parses);assert.equal(after.stats.modelBuilds,before.stats.modelBuilds);return{before:before.panes,after:after.panes,stats:after.stats};
    });
    await test('large-'+quality+'-source-and-disk-preserved',async()=>{assert.equal(global.doc.dirty,false);assert.equal(fs.readFileSync(file,'utf8'),text);return true;});
  }
};
