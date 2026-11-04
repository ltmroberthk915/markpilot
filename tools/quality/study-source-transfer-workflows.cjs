'use strict';
// Exercise the real clipboard in an isolated editor profile and restore it at exit.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),qa=file=>require(path.join(root,'tools/quality',file));
const {args,launch,acquireSlot,sleep}=qa('lifecycle.cjs');
const {outputDir,frame,recorder,waitUntil,snapshot,newWindow}=qa('harness.cjs'),clipboard=qa('clipboard.cjs');
const options=args(process.argv.slice(2)),out=outputDir(options.out,'note-source-transfer');
assert(options.exe&&options['expected-sha256'],'Specify --exe and --expected-sha256');
const result={suite:'two-note-clipboard-provenance',cases:[],frames:[],errors:[]},record=recorder(out,result);
const only=process.env.MP_QUALITY_CASES,check=(id,fn)=>!only||new RegExp(only).test(id)?record(id,fn):null;
const entry=(ok,label)=>{if(!ok)throw Error('ENTRY_UNCONFIRMED: '+label);};
const tick=String.fromCharCode(96);
const disk=file=>fs.readFileSync(file,'utf8');
const shapes=[
  {id:'source-copy-forward-math-code',command:'copy',reverse:false,text:'定义\t**结论** $x+1$\n计算\t'+tick+'sum(a, b)'+tick},
  {id:'source-cut-reverse-relative-image',command:'cut',reverse:true,text:'阅读\t$x+1$ '+tick+'index[i]'+tick+'\n图解\t![图示](study-diagram.svg)'},
  {id:'source-copy-reverse-relative-image',command:'copy',reverse:true,text:'图解\t![图示](study-diagram.svg)\n证明\t**要点** $x+1$'},
  {id:'external-two-row-tsv-import',external:true,text:'event\tvalue\ndelta\t7',table:'| event | value |\n| --- | --- |\n| delta | 7 |'}
];
function readText(value){
  const lf=clipboard.verifyText(value);
  if(lf.matches||!value.includes('\n'))return{matches:lf.matches,length:lf.length,eol:'literal'};
  const crlf=clipboard.verifyText(value.replace(/\n/g,'\r\n'));return{matches:crlf.matches,length:crlf.length,eol:'crlf'};
}
async function listen(page,text){
  await page.evaluate(original=>{
    window.__studySourceEvents=[];
    for(const name of ['keydown','copy','cut','paste'])document.addEventListener(name,e=>{
      const cb=e.clipboardData,html=cb?.getData('text/html')||'';
      window.__studySourceEvents.push({type:e.type,trusted:e.isTrusted,key:e.key,code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,
        source:window.mpEngine._view().contentDOM.contains(e.target),types:cb?[...cb.types]:null,
        matches:name==='paste'?cb.getData('text/plain').replace(/\r\n?/g,'\n')===original:undefined,
        markdownHtml:html.includes('data-markpilot-source'),length:cb?.getData('text/plain').length});
    },true);
  },text);
}
async function front(page){await page.bringToFront();await waitUntil(async()=>(await snapshot(page)).focus,'native editor focus on foreground window');}
async function save(page,file,expected){await page.keyboard.press('Control+s');await waitUntil(()=>disk(file)===expected,'Ctrl+S independent disk read');}
(async()=>{
 const release=acquireSlot();let run,holder;
 try{
  const seed=path.join(out,'launcher.md');fs.writeFileSync(seed,'Synthetic launcher');
  run=await launch({...options,settings:{restoreLast:false,autosaveEnabled:false}},seed,out);result.artifact=run.metadata;
  holder=await clipboard.hold();
  for(const spec of shapes)await check(spec.id,async trace=>{
    const dir=path.join(out,spec.id);fs.mkdirSync(dir);
    const asset=path.join(dir,'study-diagram.svg');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="#375269"/></svg>';
    fs.writeFileSync(asset,svg);
    const sourceFile=path.join(dir,'lecture.md'),destinationFile=path.join(dir,'summary.md');
    const initial='SUMMARY_TARGET',wanted=spec.table??spec.text;
    fs.writeFileSync(sourceFile,spec.text);fs.writeFileSync(destinationFile,initial);
    const destination=await newWindow(run,run.page,destinationFile);await front(destination);await listen(destination,spec.text);
    let source=null;
    if(!spec.external){source=await newWindow(run,run.page,sourceFile);await front(source);await listen(source,spec.text);}
    const initialClip=spec.external?spec.text:'CONTROL_CLIPBOARD_'+spec.id;
    const host=source||destination;
    assert((await host.evaluate(text=>window.mpHost.writeClipboard({text},window.mpHost.beginClipboardIntent('copy')),initialClip)).ok);
    const armed=readText(initialClip);trace.push({step:'independent arm',armed});entry(armed.matches,'known clipboard armed');
    let selected=null;
    if(source){
      if(spec.reverse){await source.keyboard.press('Control+End');await source.keyboard.press('Control+Shift+Home');}
      else{await source.keyboard.press('Control+Home');await source.keyboard.press('Control+Shift+End');}
      selected=await snapshot(source);trace.push({step:'source selection',source:selected});
      entry(selected.text===spec.text&&selected.selection.anchor===(spec.reverse?spec.text.length:0)&&selected.selection.head===(spec.reverse?0:spec.text.length),'exact source selection in specified direction');
      result.frames.push(await frame(source,out,spec.id+'-source-selected',{allowMissingCaret:true}));
      await source.keyboard.press(spec.command==='cut'?'Control+x':'Control+c');
      const expectedSource=spec.command==='cut'?'':spec.text;
      await waitUntil(async()=>(await snapshot(source)).text===expectedSource,'transfer changed only the selected source');
      const sourceEvents=await source.evaluate(()=>window.__studySourceEvents),wire=readText(spec.text);
      trace.push({step:'actual copy or cut',sourceEvents,wire,text:(await snapshot(source)).text});
      entry(sourceEvents.some(e=>e.type===spec.command&&e.trusted&&e.source),'trusted source '+spec.command);
      entry(wire.matches,'Windows source clipboard exact');
    }
    await front(destination);await destination.keyboard.press('Control+a');const target=await snapshot(destination);
    entry(target.text===initial&&target.selection.anchor===0&&target.selection.head===initial.length,'entire destination placeholder selected');
    const beforePaste=readText(spec.text);entry(beforePaste.matches,'clipboard unchanged before paste');
    await destination.keyboard.press('Control+v');
    await waitUntil(async()=>(await snapshot(destination)).text!==initial,'destination received actual paste');
    const after=await snapshot(destination),events=await destination.evaluate(()=>window.__studySourceEvents),event=events.find(e=>e.type==='paste');
    const afterPaste=readText(spec.text);trace.push({step:'destination paste',beforePaste,afterPaste,event,events,after});
    entry(event?.trusted&&event.source&&event.matches&&afterPaste.matches,'trusted paste with exact independently verified payload');
    result.frames.push(await frame(destination,out,spec.id+'-after',{allowMissingCaret:true}));
    await save(destination,destinationFile,after.text);trace.push({step:'target disk',text:disk(destinationFile)});
    await destination.keyboard.press('Control+z');const undone=await snapshot(destination);
    await destination.keyboard.press('Control+y');const redone=await snapshot(destination);trace.push({step:'destination history',undone,redone});
    assert.equal(undone.text,initial);assert.equal(redone.text,after.text);
    if(source){
      await front(source);const origin=await snapshot(source);assert.equal(origin.text,spec.command==='cut'?'':spec.text);
      if(spec.command==='cut'){
        await save(source,sourceFile,'');await source.keyboard.press('Control+z');const restored=await snapshot(source);
        await source.keyboard.press('Control+y');const recut=await snapshot(source);trace.push({step:'source history',restored,recut});
        assert.equal(restored.text,spec.text);assert.deepEqual(restored.selection,selected.selection);assert.equal(recut.text,'');await save(source,sourceFile,'');
      }
      assert.equal(disk(sourceFile),spec.command==='cut'?'':spec.text);
    }
    assert.equal(disk(asset),svg);assert.equal(after.text,wanted,'destination must preserve editor Markdown, and external TSV must still become a table');
    assert.equal(disk(destinationFile),wanted);
  });
 }finally{
  try{if(holder)result.clipboard=await holder.restore();}finally{try{if(run)result.cleanup=await run.cleanup();}finally{release();}}
  result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.cleanup?.residual?.length;
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error}))}));
 }if(!result.passed)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
