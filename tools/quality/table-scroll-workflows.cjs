'use strict';
// Public synthetic native-input regressions for measured widget handoff.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,newWindow,waitUntil,frame}=require('./harness.cjs');
const text='Synthetic start\n\n'+Array.from({length:50},(_,i)=>'Synthetic paragraph '+i+' '+('words '.repeat(20))+'\n\n').join('')+
 '| Key | Position | Problem | Correction | Scope |\n| --- | --- | --- | --- | --- |\n'+
 '| TARGET | '+('位置<br>'.repeat(8))+' | '+('问题 中文 '.repeat(20))+'$a+b$ | '+('修正 中文 '.repeat(20))+'$\\frac{x}{y}$ | '+('范围<br>'.repeat(8))+' |\n\n'+('Synthetic end\n\n'.repeat(40));
const read=p=>p.evaluate(()=>{const v=window.mpEngine._view(),s=v.state.selection.main,td=document.querySelector('.mp-cell-editing'),e=document.querySelector('.mp-cell-overlay-text'),r=e=>e?.getBoundingClientRect().toJSON();return{text:v.state.doc.toString(),selection:{anchor:s.anchor,head:s.head},scroll:v.scrollDOM.scrollTop,focus:document.hasFocus()&&v.hasFocus,cellFocus:document.hasFocus()&&document.activeElement===e,owner:window.mpEngine.__cellLayout(),row:r(document.querySelector('.mp-row [data-mp-row="'+window.__handoff.row+'"]')?.closest('.mp-table-wrap')),cell:r(td),overlay:r(e),col:td&&Number(td.dataset.mpCol),from:td&&Number(td.dataset.mpFrom),to:td&&Number(td.dataset.mpTo),events:window.__handoff.events};});
async function setup(p){
 await p.bringToFront();await p.evaluate(()=>document.fonts.ready);
 await p.evaluate(()=>{const v=window.mpEngine._view();let row;for(let n=1;n<=v.state.doc.lines;n++){const l=v.state.doc.line(n);if(l.text.startsWith('| TARGET |'))row=l.from;}if(row===undefined)throw Error('Synthetic target row');window.__handoff={row,phase:'setup',events:[]};for(const type of ['mousedown','mouseup','keydown','beforeinput','input','wheel'])document.addEventListener(type,e=>window.__handoff.events.push({phase:window.__handoff.phase,type,trusted:e.isTrusted,key:e.key,data:e.data,x:e.clientX,y:e.clientY,at:performance.now(),scroll:v.scrollDOM.scrollTop}),{capture:true,passive:true});});
 await p.keyboard.press('Control+Home');
 // Diagnostic setup only. All tested handoffs below use trusted mouse input.
 await p.evaluate(()=>{const v=window.mpEngine._view();v.dispatch({effects:v.constructor.scrollIntoView(window.__handoff.row,{y:'center'})});});await sleep(240);
 for(let n=0;n<12;n++){
  const q=await p.evaluate(()=>{const v=window.mpEngine._view(),b=v.scrollDOM.getBoundingClientRect(),e=document.querySelector('.mp-row [data-mp-row="'+window.__handoff.row+'"]'),r=e?.closest('.mp-table-wrap').getBoundingClientRect();return{row:r?.toJSON(),b:b.toJSON()};});
  if(q.row&&Math.abs(q.row.top-(q.b.top+22))<2)return;
  assert(q.row,'Native End mounts the target row');
  await p.mouse.move(q.b.left+80,Math.min(q.b.bottom-40,innerHeightSafe(q.b)));
  await p.mouse.wheel(0,q.row.top-(q.b.top+22));await sleep(140);
 }
 throw Error('Native wheel setup did not reach partially visible row');
}
function innerHeightSafe(b){return b.top+Math.min(b.height*.6,260);}
async function click(p,col,phase){
 const point=await p.evaluate(col=>{const v=window.mpEngine._view(),td=document.querySelector('.mp-row [data-mp-row="'+window.__handoff.row+'"][data-mp-col="'+col+'"]'),r=td?.getBoundingClientRect(),b=v.scrollDOM.getBoundingClientRect(),bar=document.querySelector('.mp-toolbar')?.getBoundingClientRect();if(!r)return null;const top=Math.max(r.top,b.top,bar?.bottom||0)+8,bottom=Math.min(r.bottom,b.bottom,innerHeight)-8,x=r.left+r.width*.55,y=(top+bottom)/2;return{x,y,visible:bottom>top&&td.contains(document.elementFromPoint(x,y))};},col);
 assert(point?.visible,'Actual visible cell hit '+phase);const before=await read(p);
 await p.evaluate(phase=>window.__handoff.phase=phase,phase);await p.mouse.click(point.x,point.y,{delay:65});await sleep(140);const after=await read(p);
 assert(after.cellFocus&&after.owner.matched&&after.owner.owner.rowFrom===windowRow(before)&&after.col===col,'Native handoff selects the intended source owner');
 assert(Math.abs(after.scroll-before.scroll)<1,'No extra scroll compensation on equal-layout handoff');
 assert(Math.abs(after.row.top-before.row.top)<1,'Visible row stays at the same screen position');
 assert(after.selection.anchor>=after.from&&after.selection.head<=after.to,'Master selection belongs to clicked cell');
 return{point,before,after};
}
function windowRow(s){return s.owner.active?.rowFrom??s.events.find(e=>e.phase==='owner-identity')?.row;}
(async()=>{
 const o=args(process.argv.slice(2)),dir=outputDir(o.out,'table-scroll-workflows'),release=acquireSlot(),result={schema:1,suite:'table-scroll-workflows',probeSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),cases:[],errors:[],startedAt:new Date().toISOString()};let run;
 try{
  const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Synthetic owner\n');run=await launch({...o,settings:{autosaveEnabled:false}},owner,dir);result.artifact=run.metadata;
  run.browser.contexts()[0].on('page',p=>p.on('pageerror',e=>result.errors.push(e.message)));
  for(const z of [100,145,200]){
   const c={id:'cell-handoff-zoom-'+z,status:'running',switches:[],frames:[]};result.cases.push(c);let p;
   try{
    const file=path.join(dir,c.id+'.md');fs.writeFileSync(file,text);p=await newWindow(run,run.page,file);p.on('pageerror',e=>result.errors.push(e.message));
    await p.keyboard.press('Control+0');for(let n=100;n<z;n+=5)await p.keyboard.press('Control+=');await setup(p);
    await p.evaluate(()=>window.__handoff.events.push({phase:'owner-identity',row:window.__handoff.row}));
    for(let n=0;n<8;n++)c.switches.push(await click(p,n%2?2:3,'switch-'+n));
    // Paint-only preference changes have no RO size delivery.
    const before=await read(p);await p.evaluate(()=>window.mpEngine.setPref('island',95));await sleep(80);const changed=await read(p);
    assert(Math.abs(before.row.height-changed.row.height)<1&&Math.abs(before.row.width-changed.row.width)<1,'Island preference does not change table geometry');
    c.paintOnly=await click(p,3,'paint-only-first-switch');
    const at=await read(p),token='🙂';assert(at.cellFocus);
    await p.evaluate(()=>window.__handoff.phase='precise-input');await p.keyboard.insertText(token);await sleep(120);
    const edited=await read(p),expected=at.text.slice(0,at.selection.anchor)+token+at.text.slice(at.selection.head);assert.equal(edited.text,expected);c.exactNativeInsertion=true;
    await p.keyboard.press('Control+z');await sleep(120);assert.equal((await read(p)).text,text);c.exactUndo=true;
    await p.keyboard.press('Control+y');await sleep(120);assert.equal((await read(p)).text,expected);c.exactRedo=true;
    await p.keyboard.press('Tab');await sleep(120);const tab=await read(p);assert(tab.cellFocus&&tab.owner.matched&&tab.col===4);
    await p.keyboard.press('Shift+Tab');await sleep(120);const back=await read(p);assert(back.cellFocus&&back.owner.matched&&back.col===3);c.keyboardCells={tab:{focus:tab.cellFocus,col:tab.col,owner:tab.owner},shiftTab:{focus:back.cellFocus,col:back.col,owner:back.owner}};
    c.frames.push(await frame(p,dir,c.id+'-handoff',{caret:'dom'}));
    const saved=await p.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save',true));assert(saved.ok);
    await waitUntil(()=>fs.readFileSync(file,'utf8')===expected,'Independent exact saved bytes');c.diskMatches=true;
    await p.keyboard.press('Escape');await sleep(120);const closed=await read(p);assert(closed.focus&&!closed.owner.active,'Escape transfers to master');
    c.events=closed.events;c.escapeFocusTransferred=closed.focus&&!closed.owner.active;
    assert(closed.events.some(e=>e.type==='input'&&e.trusted&&e.phase==='precise-input'));
    assert(closed.events.some(e=>e.type==='mousedown'&&e.trusted&&e.phase==='paint-only-first-switch'));
    c.status='pass';
   }catch(e){c.status='fail';c.error=e.stack;if(p)c.frames.push(await frame(p,dir,c.id+'-failure',{caret:'dom',allowMissingCaret:true}));}
   finally{await p?.close().catch(()=>{});}
  }
  const c={id:'block-height-viewport-units',status:'running',values:[]};result.cases.push(c);let p;
  try{
   const file=path.join(dir,c.id+'.md'),fixture='Synthetic start\n\n$$\n\\frac{a}{\\frac{b}{c}}+\\sum_{i=1}^{n}x_i\n$$\n\n'+('Synthetic tail\n\n'.repeat(80));fs.writeFileSync(file,fixture);p=await newWindow(run,run.page,file);await p.bringToFront();await p.evaluate(()=>document.fonts.ready);
   for(const z of [100,145,200]){
    await p.keyboard.press('Control+0');for(let n=100;n<z;n+=5)await p.keyboard.press('Control+=');await p.keyboard.press('Control+End');await sleep(120);await p.keyboard.press('Control+Home');await sleep(240);
    const q=await p.evaluate(()=>{const v=window.mpEngine._view(),el=v.contentDOM.querySelector('.mp-cm6-math-block');let estimated;for(const set of v.state.facet(v.constructor.decorations)){if(typeof set==='function')continue;set.between(0,v.state.doc.length,(from,to,d)=>{if(d.widget?.display&&!d.widget.live)estimated=d.widget.estimatedHeight;});}return{actual:el?.getBoundingClientRect().height,estimated,zoom:window.mpZoom.get(),focus:document.hasFocus()&&v.hasFocus};});
    c.values.push(q);assert(q.focus&&q.zoom===z&&q.actual>0&&q.estimated>0);assert(Math.abs(q.actual-q.estimated)<1,'Cached block height uses measured viewport pixels');
   }
   c.status='pass';
   }catch(e){c.status='fail';c.error=e.stack;}finally{await p?.close().catch(()=>{});}
  const rich={id:'rich-budget-tall-formula-native-history',status:'running',frames:[]};result.cases.push(rich);p=null;
  try{
   const fixture='Synthetic start\n\n'+('Synthetic paragraph '+('words '.repeat(28))+'\n\n').repeat(430)+
    ('Inline $a+b$ paragraph.\n\n'.repeat(140))+'$$\n\\begin{matrix}'+Array.from({length:32},()=> 'a & b').join(' \\\\ ')+'\\end{matrix}\n$$\n\n'+('Synthetic tail\n\n'.repeat(40));
   const file=path.join(dir,rich.id+'.md');fs.writeFileSync(file,fixture);p=await newWindow(run,run.page,file);await p.bringToFront();await p.evaluate(()=>document.fonts.ready);
   await p.keyboard.press('Control+0');for(let z=100;z<145;z+=5)await p.keyboard.press('Control+=');
   const mathFrom=fixture.lastIndexOf('$$\n'),start=fixture.indexOf('$$\n');
   rich.setup='Diagnostic scroll placement; subsequent wheel, pointer and history actions are native';
   await p.evaluate(from=>{const v=window.mpEngine._view();v.dispatch({effects:v.constructor.scrollIntoView(from,{y:'center'})});},start);await sleep(240);
   rich.budget=await p.evaluate(()=>{const v=window.mpEngine._view();return v.state.facet(v.constructor.viewportMargin);});assert.equal(rich.budget,300);
   const point=await p.evaluate(()=>{const v=window.mpEngine._view(),b=v.scrollDOM.getBoundingClientRect(),bar=document.querySelector('.mp-toolbar')?.getBoundingClientRect();for(const el of v.contentDOM.querySelectorAll('.mp-cm6-math-block .katex-html [data-typora-source-start]')){const r=el.getBoundingClientRect(),x=r.left+r.width*.8,y=r.top+r.height*.5;if(el.textContent==='a'&&!el.childElementCount&&r.width>0&&r.top>Math.max(b.top,bar?.bottom||0)+5&&r.bottom<Math.min(b.bottom,innerHeight)-5&&el.contains(document.elementFromPoint(x,y)))return{x,y};}return null;});assert(point,'Tall atomic formula has a real visible glyph');
   await p.mouse.click(point.x,point.y,{delay:65});await sleep(180);
   const before=await p.evaluate(()=>{const v=window.mpEngine._view();return{text:v.state.doc.toString(),head:v.state.selection.main.head,focus:document.hasFocus()&&v.hasFocus,preview:!!v.dom.querySelector('.mp-inline-float')};});assert(before.focus&&before.preview&&before.head>start&&before.head<mathFrom);
   await p.keyboard.insertText('x');await sleep(120);const expected=fixture.slice(0,before.head)+'x'+fixture.slice(before.head);
   assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),expected);await p.keyboard.press('Control+z');await sleep(120);assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),fixture);await p.keyboard.press('Control+y');await sleep(120);assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),expected);
   rich.frames.push(await frame(p,dir,rich.id+'-active'));await p.keyboard.press('Control+End');await p.keyboard.press('Control+Home');await sleep(180);assert(await p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus));
   await p.keyboard.press('Control+a');await p.keyboard.insertText('Synthetic small\n');await sleep(180);
   assert.equal(await p.evaluate(()=>{const v=window.mpEngine._view();return v.state.facet(v.constructor.viewportMargin);}),1000);
   await p.keyboard.press('Control+z');await sleep(180);assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),expected);
   assert.equal(await p.evaluate(()=>{const v=window.mpEngine._view();return v.state.facet(v.constructor.viewportMargin);}),300);
   rich.status='pass';
  }catch(e){rich.status='fail';rich.error=e.stack;}finally{await p?.close().catch(()=>{});}
  const repeated={id:'duplicate-formula-template-owner-isolation',status:'running',frames:[]};result.cases.push(repeated);p=null;
  try{
   const fixture='Synthetic first $a+b$.\n\n> Synthetic second $a+b$.\n\n'+('Synthetic tail\n\n'.repeat(30)),file=path.join(dir,repeated.id+'.md');fs.writeFileSync(file,fixture);p=await newWindow(run,run.page,file);await p.bringToFront();await p.evaluate(()=>document.fonts.ready);await p.keyboard.press('Control+Home');await sleep(200);
   const point=await p.evaluate(()=>{const el=[...window.mpEngine._view().contentDOM.querySelectorAll('.mp-cm6-math .katex-html [data-typora-source-start]')].find(e=>e.textContent==='a'&&!e.childElementCount);const r=el?.getBoundingClientRect();return r&&{x:r.left+r.width*.8,y:r.top+r.height*.5};});assert(point);
   await p.mouse.click(point.x,point.y,{delay:65});await sleep(120);assert(await p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus));
   await p.keyboard.insertText('x');await sleep(120);const expected=fixture.replace('$a+b$','$ax+b$');assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),expected);
   const remaining=await p.evaluate(()=>[...document.querySelectorAll('.mp-cm6-math')].map(e=>e.textContent));assert(remaining.some(s=>s.includes('a+b')),'The other cloned formula remains rendered with its own content');
   await p.keyboard.press('Control+z');await sleep(120);assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),fixture);
   await p.keyboard.press('Control+y');await sleep(120);assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),expected);
   repeated.frames.push(await frame(p,dir,repeated.id+'-edited'));repeated.status='pass';
  }catch(e){repeated.status='fail';repeated.error=e.stack;}finally{await p?.close().catch(()=>{});}
  const drag={id:'rich-budget-cross-screen-native-selection',status:'running',samples:[],frames:[]};result.cases.push(drag);p=null;
  try{
   const fixture='Synthetic start\n\n'+Array.from({length:460},(_,n)=>'Synthetic '+n+' $a+b$ '+('words '.repeat(24))+'\n\n').join(''),file=path.join(dir,drag.id+'.md');fs.writeFileSync(file,fixture);
   p=await newWindow(run,run.page,file);await p.bringToFront();await p.evaluate(()=>document.fonts.ready);await p.keyboard.press('Control+Home');await sleep(180);
   const geometry=await p.evaluate(()=>{const v=window.mpEngine._view(),r=v.scrollDOM.getBoundingClientRect(),bar=document.querySelector('.mp-toolbar')?.getBoundingClientRect();const top=Math.max(r.top,bar?.bottom||0)+8,line=[...v.contentDOM.querySelectorAll('.cm-line')].find(e=>{const b=e.getBoundingClientRect();return e.textContent.trim()&&b.top>top&&b.bottom<r.bottom-10;});if(!line)return null;const pos=v.posAtDOM(line,0)+Math.min(8,line.textContent.length),c=v.coordsAtPos(pos),x=c.left+1,startY=(c.top+c.bottom)/2;return{x,startY,hit:line.contains(document.elementFromPoint(x,startY)),downY:Math.min(innerHeight-2,r.bottom+28),upY:Math.max(1,r.top-28),height:r.height,budget:v.state.facet(v.constructor.viewportMargin)};});assert(geometry?.hit,'Drag begins on an actual visible source glyph');assert.equal(geometry.budget,300);drag.geometry=geometry;
   await p.evaluate(()=>{window.__dragEvents=[];for(const type of ['mousedown','mousemove','mouseup','keydown'])document.addEventListener(type,e=>window.__dragEvents.push({type,trusted:e.isTrusted,key:e.key,buttons:e.buttons,x:e.clientX,y:e.clientY,at:performance.now(),scroll:window.mpEngine._view().scrollDOM.scrollTop}),true);});
   const sample=async()=>p.evaluate(()=>{const v=window.mpEngine._view(),s=v.state.selection.main;return{anchor:s.anchor,head:s.head,scroll:v.scrollDOM.scrollTop,focus:document.hasFocus()&&v.hasFocus};});
   await p.mouse.move(geometry.x,geometry.startY);await p.mouse.down();await p.mouse.move(geometry.x,geometry.startY+25,{steps:4});const start=await sample();assert(start.focus);drag.samples.push(start);
   await p.mouse.move(geometry.x,geometry.downY,{steps:12});
   for(let n=0;n<140;n++){await sleep(100);const s=await sample();drag.samples.push(s);assert(s.focus&&s.anchor===start.anchor&&s.head>=drag.samples.at(-2).head,'Native forward drag extends the same source selection');if(s.scroll-start.scroll>geometry.height*2)break;}
   const down=drag.samples.at(-1);assert(down.scroll-start.scroll>geometry.height*2,'Automatic native drag scroll crosses two screens');assert(down.head>start.head);
   // Keep the native press/move/release gesture continuous. Screenshot capture
   // can introduce a buttons=0 pointer move and terminate CM's selection owner.
   drag.forward=down;
   await p.mouse.move(geometry.x,geometry.upY,{steps:12});
   // Auto-scroll may legitimately continue forwards while the pointer crosses
   // the viewport. Start the reverse phase at its actual upper-edge endpoint.
   const endpoint=await sample();drag.reversalEndpoint=endpoint;assert(endpoint.focus&&endpoint.anchor===start.anchor);
   const lastMove=await p.evaluate(()=>window.__dragEvents.filter(e=>e.type==='mousemove').at(-1));assert(lastMove?.trusted&&lastMove.buttons===1&&Math.abs(lastMove.y-geometry.upY)<1,'Held pointer reaches the upper edge');
   let previous=endpoint;
   for(let n=0;n<140;n++){await sleep(100);const s=await sample();drag.samples.push({...s,phase:'reverse'});assert(s.focus&&s.anchor===start.anchor&&s.head<=previous.head,'Native reverse drag keeps anchor and contracts head');previous=s;if(endpoint.scroll-s.scroll>geometry.height&&down.scroll-s.scroll>geometry.height)break;}
   const reverse=drag.samples.at(-1);assert(endpoint.scroll-reverse.scroll>geometry.height&&down.scroll-reverse.scroll>geometry.height,'Reverse native drag crosses one screen');
   const heldEvents=await p.evaluate(()=>window.__dragEvents.slice(window.__dragEvents.findIndex(e=>e.type==='mousedown')+1));assert(!heldEvents.some(e=>e.type==='mouseup'||(e.type==='mousemove'&&e.buttons===0)),'Native continuous drag has no premature release');drag.heldEvents=heldEvents;
   await p.mouse.up();await sleep(150);const released=await sample();await sleep(180);const stable=await sample();assert.equal(stable.head,released.head);assert.equal(stable.anchor,released.anchor);assert(Math.abs(stable.scroll-released.scroll)<1,'Mouse release stops auto scrolling');
   await p.keyboard.press('Shift+ArrowLeft');await sleep(100);const combined=await sample();assert(combined.focus&&combined.anchor===released.anchor&&combined.head<released.head,'Drag then Shift+Left continues source selection');
   assert.equal(await p.evaluate(()=>window.mpEngine.getValue()),fixture);drag.sourceRange=fixture.slice(Math.min(combined.anchor,combined.head),Math.max(combined.anchor,combined.head));assert(drag.sourceRange.includes('$a+b$'));
   drag.frames.push(await frame(p,dir,drag.id+'-reverse',{caret:'dom',allowMissingCaret:true}));drag.events=await p.evaluate(()=>window.__dragEvents);assert(drag.events.some(e=>e.type==='mousedown'&&e.trusted)&&drag.events.some(e=>e.type==='mouseup'&&e.trusted)&&drag.events.some(e=>e.type==='keydown'&&e.trusted&&e.key==='ArrowLeft'));drag.status='pass';
  }catch(e){drag.status='fail';drag.error=e.stack;if(p)drag.frames.push(await frame(p,dir,drag.id+'-failure',{caret:'dom',allowMissingCaret:true}));}finally{await p?.mouse.up().catch(()=>{});await p?.close().catch(()=>{});}
 }catch(e){result.error=e.stack;}finally{if(run)result.cleanup=await run.cleanup();release();result.finishedAt=new Date().toISOString();result.passed=!result.error&&!result.errors.length&&result.cases.every(c=>c.status==='pass');fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),cleanup:result.cleanup}));if(!result.passed)process.exitCode=1;}
})();
