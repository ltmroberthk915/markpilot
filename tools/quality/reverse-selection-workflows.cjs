'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const qa=__dirname;
const {args,launch,sleep,acquireSlot}=require(path.join(qa,'lifecycle.cjs'));
const {frame,outputDir,newWindow,waitUntil,snapshot,recorder}=require(path.join(qa,'harness.cjs'));
const clipboard=require(path.join(qa,'clipboard.cjs'));
const text=['TOP alpha START','Formula $x+y$ paragraph','Code `let i = 1` sample','![diagram](sample.svg)','TAIL omega END','After sentinel',''].join('\n');
const texStart=text.indexOf('x+y');
async function point(p,pos){
 const q=await p.evaluate(pos=>{const v=window.mpEngine._view(),c=v.coordsAtPos(pos);
  return c&&{x:c.left+.1,y:(c.top+c.bottom)/2,hit:v.posAtCoords({x:c.left+.1,y:(c.top+c.bottom)/2})};},pos);
 assert(q&&q.hit===pos,'ENTRY_UNCONFIRMED source coordinate '+pos+' '+JSON.stringify(q));return q;
}
async function glyph(p,scope,ch,fraction){
 let pt;await waitUntil(async()=>{pt=await p.evaluate(({scope,ch,fraction})=>{
  for(const el of document.querySelectorAll(scope+' .katex-html [data-typora-source-start]')){
   if(el.textContent!==ch)continue;const rect=el.getBoundingClientRect(),x=rect.left+rect.width*fraction,y=rect.top+rect.height/2;
   if(rect.width>0&&document.elementFromPoint(x,y)?.closest(scope))return{x,y};
  }return null;},{scope,ch,fraction});return !!pt;},'painted '+scope+' '+ch);return pt;
}
async function observer(p){await p.evaluate(()=>{const v=window.mpEngine._view(),out=window.__rev=[];
 for(const type of ['mousedown','mouseup','mousemove','keydown','keyup','copy','cut'])document.addEventListener(type,e=>{
  if(type==='mousemove'&&!e.buttons)return;const t=e.target?.closest?.('.mp-inline-float,.mp-cm6-math,.mp-img,.cm-content,.cm-scroller');
  out.push({type,at:performance.now(),trusted:e.isTrusted,scope:t?.className||'',key:e.key||'',shift:e.shiftKey||false,
   x:e.clientX??null,y:e.clientY??null,buttons:e.buttons??null,selection:[v.state.selection.main.anchor,v.state.selection.main.head]});
 },true);});}
async function drag(p,a,b,held){
 await p.mouse.move(a.x,a.y);await p.mouse.down();
 try{await sleep(65);if(held)await held();
  for(let i=1;i<=18;i++){await p.mouse.move(a.x+(b.x-a.x)*i/18,a.y+(b.y-a.y)*i/18);await sleep(18);}
 }finally{await p.mouse.up();}await sleep(135);
}
async function main(){
 const opt=args(process.argv.slice(2));assert(opt.exe&&opt['expected-sha256']&&opt.out);
 const dir=outputDir(opt.out,'reverse-family'),release=acquireSlot();
 const result={schema:1,suite:'reverse-family',cases:[],errors:[],frames:[],passed:false};
 const check=recorder(dir,result),filter=process.env.MP_QUALITY_CASES&&new RegExp(process.env.MP_QUALITY_CASES);
 let run,clip;
 try{
 const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Owner\n');fs.writeFileSync(path.join(dir,'sample.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="48" height="28"><rect width="48" height="28" fill="#942f00"/></svg>');
 run=await launch({...opt,settings:{autosaveEnabled:false,restoreLast:false}},owner,dir);clip=await clipboard.hold();result.artifact=run.metadata;
 for(const id of ['mixed-reverse','float-reverse-inner','float-reverse-to-prose','image-blank-reverse','image-blank-key-during-drag']){
 if(filter&&!filter.test(id))continue;
 await check(id,async trace=>{
  const file=path.join(dir,id+'.md');fs.writeFileSync(file,text);const p=await newWindow(run,run.page,file);p.on('pageerror',e=>result.errors.push(e.message));
  await p.bringToFront();await waitUntil(async()=>{const s=await snapshot(p);return s.text===text&&s.focus;},'owned fixture focus');await observer(p);
  await waitUntil(()=>p.evaluate(()=>[...document.querySelectorAll('.mp-img img')].some(i=>i.complete&&i.naturalWidth>0)),'rendered fixture image');
  await p.keyboard.press('Control+Home');
  let anchor,head,a,b,held;
  if(id.startsWith('float-')){
   const y=await glyph(p,'.cm-content .mp-cm6-math','y',.82);await p.mouse.click(y.x,y.y,{delay:65});
   await waitUntil(async()=>(await snapshot(p)).selection.head===texStart+3,'click y end');await sleep(520);
   a=await glyph(p,'.mp-inline-float','y',.82);anchor=texStart+3;
   if(id.endsWith('inner')){b=await glyph(p,'.mp-inline-float','x',.18);head=texStart;}else{
    // Existing plain-drag contract includes the closing fence when crossing from
    // inside an inline formula into the previous paragraph. Shift-click differs.
    anchor=texStart+4;head=text.indexOf('alpha');b=await point(p,head);
   }
  }else if(id.startsWith('image-')){
   a=await p.evaluate(()=>{const img=document.querySelector('.mp-img img'),r=img.getBoundingClientRect();return{x:r.right+32,y:r.top+r.height/2};});
   anchor=text.indexOf('TAIL');head=text.indexOf('alpha');b=await point(p,head);
   held=async()=>{const down=await p.evaluate(()=>window.mpEngine._view().__mpImageRightBlank||null);
    assert.equal(down?.pos,anchor,'ENTRY_UNCONFIRMED actual image-right blank route');trace.push({down});
    if(id.includes('key-during')){await p.keyboard.press('Control+End');const after=await snapshot(p);
     trace.push({afterKey:after.selection});assert.equal(after.selection.head,text.length,'ENTRY_UNCONFIRMED new trusted caret before old drag continued');anchor=head=text.length;}
   };
  }else{anchor=text.indexOf('END')+3;head=text.indexOf('alpha');a=await point(p,anchor);b=await point(p,head);}
  trace.push({a,b});await drag(p,a,b,held);
  const selected=await snapshot(p),events=await p.evaluate(()=>window.__rev);trace.push({expected:{anchor,head},selected,events});
  const sequence=events.filter(e=>e.type==='mousedown'||e.type==='mousemove'||e.type==='mouseup');
  assert(sequence.filter(e=>e.type==='mousemove'&&e.buttons===1&&e.trusted).length>=8 && sequence.at(-1).type==='mouseup'&&sequence.at(-1).trusted,'ENTRY_UNCONFIRMED multi-step native drag');
  result.frames.push(await frame(p,dir,id+'-selected',{allowMissingCaret:true}));
  if(id.includes('key-during')){assert.deepEqual(selected.selection,{anchor,head},'late pointer move replaced later keyboard caret');return;}
  const from=Math.min(anchor,head),to=Math.max(anchor,head),expected=text.slice(from,to),remaining=text.slice(0,from)+text.slice(to);
  const sentinel='SYNTHETIC_ARM_'+id;
  assert((await p.evaluate(s=>window.mpHost.writeClipboard({text:s},window.mpHost.beginClipboardIntent('copy')),sentinel)).ok&&clipboard.verifyText(sentinel).matches);
  await p.keyboard.press('Control+c');const copied=clipboard.verifyText(expected);trace.push({copied});assert.deepEqual(selected.selection,{anchor,head},'reverse drag source endpoints');
  assert(copied.matches,'copied exact source span');await p.keyboard.press('Control+x');
  assert(clipboard.verifyText(expected).matches,'cut exact source span');assert.equal((await snapshot(p)).text,remaining);
  await p.keyboard.press('Control+z');const restored=await snapshot(p);assert.equal(restored.text,text);assert.deepEqual(restored.selection,{anchor,head},'undo restores reverse span');
  await p.keyboard.press('Control+y');assert.equal((await snapshot(p)).text,remaining);await p.keyboard.press('Control+s');
  await waitUntil(()=>fs.readFileSync(file,'utf8')===remaining,'cut retained on disk');trace.push({saved:true});
 });
 }
 }catch(e){result.fatal=e.stack;}
 finally{if(clip)try{result.clipboardRestore=await clip.restore();}catch(e){result.errors.push(e.message);}
 if(run)try{result.cleanup=await run.cleanup();}catch(e){result.errors.push(e.message);}
 release();result.passed=!result.fatal&&!result.errors.length&&result.cases.length>0&&result.cases.every(x=>x.status==='pass')&&result.clipboardRestore?.restored===true&&!result.cleanup?.residual?.length;
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

