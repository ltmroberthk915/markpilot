'use strict';
// Trusted input drives the actual packaged producers. Full recognition is an
// independent-from-cache oracle over the same source, read outside timing.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,args,launch,acquireSlot,sha256,sleep}=require('./lifecycle.cjs');
const {outputDir,frame,recorder,waitUntil,newWindow}=require('./harness.cjs');
async function main(){
 const o=args(process.argv.slice(2));assert(o.out&&o['expected-sha256']);const dir=outputDir(o.out,'incremental-workflows'),result={schema:1,suite:'incremental-workflows',cases:[],errors:[],cleanupErrors:[],startedAt:new Date().toISOString()};
 const record=recorder(dir,result);let run,release;
 const tail='\n\nUnchanged $a+b$.\n\n> $$\n> z+1\n> $$\n\n```text\n$x$ and ![literal](tile.svg)\n```\n\n1. one\n2. two\n\nEND\n';
 const fixtures=[
  {id:'inline-formula-local-body',source:'START $x+y$'+tail,pos:8,insert:'Q',local:true},
  {id:'quoted-multiline-formula-local-body',source:'> $$\n> x+y\n> $$'+tail,pos:8,insert:'Q',local:true},
  {id:'standalone-image-local-alt',source:'![alpha](tile.svg)'+tail,image:true,insert:'Q'},
  {id:'quoted-image-local-alt',source:'> ![alpha](tile.svg)'+tail,image:true,insert:'Q'},
  {id:'closed-mermaid-same-length-body',source:'```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n```'+tail,pos:26,replace:true,insert:'O',diagram:true},
  {id:'heading-space-removal',source:'# heading'+tail,pos:1,key:'Delete'},
  {id:'heading-created-by-leading-letter-removal',source:'x# heading'+tail,pos:0,key:'Delete'},
  {id:'hr-retired-by-plain-letter',source:'---'+tail,pos:3,insert:'x'},
  {id:'inline-code-math-and-image-negatives',source:'`$x$ ![literal](tile.svg)` plain'+tail,pos:27,insert:'Q',negative:true},
  {id:'parent-list-context-invalidates-inactive-block',source:'Lead\n\n- item\n  > $$\n  > x+y\n  > $$\n\nEnd\n'+tail,pos:6,key:'Delete',parent:true},
 ];
 try{
  release=acquireSlot(ROOT);const owner=path.join(dir,'owner.md');fs.writeFileSync(owner,'Owned incremental workflows\n');fs.writeFileSync(path.join(dir,'tile.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#4682b4"/></svg>');run=await launch(o,owner,dir);result.artifact=run.metadata;
  for(const f of fixtures){if(process.env.MP_QUALITY_CASES&&!new RegExp(process.env.MP_QUALITY_CASES).test(f.id))continue;
   await record(f.id,async trace=>{
    const file=path.join(dir,f.id+'.md');fs.writeFileSync(file,f.source);const p=await newWindow(run,run.page,file);p.on('pageerror',e=>result.errors.push(e.message));await p.bringToFront();await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&!!window.mpEngine?.__recognition),'real engine');
    const check=async name=>{
     const s=await p.evaluate(()=>({cached:window.mpEngine.__recognition(),fresh:window.mpEngine.__recognition(true),regions:window.mpEngine.__regions(),text:window.mpEngine.getValue(),selection:window.mpEngine.getSelection()}));
     assert.deepEqual(s.cached,s.fresh,name+' actual incremental/fresh equivalence');
     trace.push({name,textSha256:require('node:crypto').createHash('sha256').update(s.text).digest('hex'),selection:s.selection,computation:s.regions.computation,regions:s.regions.regions.map(r=>({id:r.id,kind:r.kind,revision:r.revision,from:r.from,to:r.to}))});return s;
    };
    const initial=await check('initial');assert.equal(initial.text,f.source);
    let parentId;
    if(f.parent){const found=initial.regions.regions.find(r=>r.kind==='math'&&r.from===f.source.indexOf('  > $$'));assert(found,'literal quoted block');parentId=found.id;const initialIndent=await p.evaluate(id=>document.querySelector('[data-mp-region="'+id+'"].mp-cm6-math-block')?.style.getPropertyValue('--mp-region-indent'),parentId);assert.equal(initialIndent,'2ch','literal list marker owns two columns of indent');}
    if(f.image){await p.locator('.mp-img img').first().click();await waitUntil(()=>p.evaluate(()=>!!window.mpEngine.__regions().session.imageId),'explicit native image owner');}
    else {await p.keyboard.press('Control+Home');for(let n=0;n<f.pos;n++)await p.keyboard.press('ArrowRight');}
    const at=await check('entered');assert(at.selection&&p);result.cases.at(-1).productReached=true;
    if(f.replace)await p.keyboard.press('Delete');if(f.key)await p.keyboard.press(f.key);else await p.keyboard.insertText(f.insert);
    await sleep(30);const changed=await check('changed');assert.notEqual(changed.text,f.source,'real input changed source');
    if(f.local)assert.equal(changed.regions.computation.math.fullRescan,0,'formula used bounded complete-owner recognition');
    if(f.diagram){const old=initial.regions.regions.find(r=>r.kind==='mermaid'),now=changed.regions.regions.find(r=>r.id===old.id);assert(now&&now.revision>old.revision,'same-length diagram source invalidates content lease');assert.equal(changed.text.length,f.source.length);}
    if(f.negative){assert(!changed.cached.math.some(s=>s.from<28));assert(!changed.cached.inline.some(m=>m.image&&m.from<28));}
    if(f.parent){assert.equal(changed.text,f.source.slice(0,6)+f.source.slice(7),'literal list-parent marker deletion');const indent=await p.evaluate(id=>document.querySelector('[data-mp-region="'+id+'"].mp-cm6-math-block')?.style.getPropertyValue('--mp-region-indent'),parentId);assert.equal(indent,'0ch','inactive block immediately rebinds the removed list parent');}
    const capture=await frame(p,dir,f.id+'-changed');trace.push({name:'native-frame',screenshot:capture});
    await p.keyboard.press('Control+z');await check('undo');
    return{fixtureSha256:sha256(file),literalSourceChanged:true,fullRecognitionEqual:true};
   });
  }
 }catch(e){result.fatal=e.stack||e.message;}
 finally{try{if(run)result.cleanup=await run.cleanup();}catch(e){result.cleanupErrors.push(e.message)}release?.();result.finishedAt=new Date().toISOString();result.passed=!!result.cases.length&&result.cases.every(c=>c.status==='pass')&&!result.fatal&&!result.errors.length&&!result.cleanupErrors.length&&!!result.cleanup&&!result.cleanup.residual.length;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));}
 if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1});
