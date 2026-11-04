'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),q=path.join(root,'tools/quality');
const {args,launch,acquireSlot,sha256,sleep}=require(path.join(q,'lifecycle.cjs'));
const {outputDir,snapshot,frame,recorder,waitUntil,newWindow}=require(path.join(q,'harness.cjs'));
const clipboard=require(path.join(q,'clipboard.cjs'));
const formula='<span class="katex"><span class="katex-mathml"><math><semantics><msup><mi>x</mi><mn>2</mn></msup><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span>';
const probes=[
  ['scientific-rich-math','<p>Energy '+formula+' is positive.</p>','Energy $x^2$ is positive.'],
  ['scientific-rich-marks','<p>Use <span style="font-weight:700">proof</span> <u>only</u> in H<sub>2</sub>O with m<sup>2</sup>.</p>','Use **proof** <u>only</u> in H<sub>2</sub>O with m<sup>2</sup>.'],
  ['rich-line-boundaries','<p>Rule<br>Exception</p><table><tr><th>Step</th></tr><tr><td><p>First</p><p>Second<br>Third</p></td></tr></table>','Rule  \nException\n\n| Step |\n| --- |\n| First<br>Second<br>Third |'],
  ['adjacent-editorial-runs','<p><strong>A</strong><span style="font-weight:700">B</span></p><div style="font-weight:bold"><p>one</p><p>two</p></div>','**AB**\n\n**one**\n\n**two**'],
  ['formula-with-literal-dollars','<math><semantics><mtext>price</mtext><annotation encoding="application/x-tex">\\text{$x$}</annotation></semantics></math>','$$\n\\text{$x$}\n$$'],
  ['nested-editorial-runs','<p><strong>A<em>B</em>C</strong></p>','**A*B*C**'],
  ['literal-missing-alt','<p>Note <img src="cid:unavailable" alt="![extra](other.svg)"> end</p>','Note '+String.fromCharCode(96)+'【图片：![extra](other.svg)】'+String.fromCharCode(96)+' end']
];
(async()=>{
const opts=args(process.argv.slice(2)),out=outputDir(opts.out,'study-rich'),release=acquireSlot(),result={cases:[],frames:[]};
let run,clip;
const check=recorder(out,result);
try {
  const original=process.env.MP_STUDY_DOC,settings=process.env.MP_STUDY_PREFS;
  const tail=original?fs.readFileSync(original):Buffer.alloc(0);
  if(original)result.originalSha256=sha256(original);
  const owner=path.join(out,'representative.md');fs.writeFileSync(owner,Buffer.concat([Buffer.from('TARGET\n'),tail]));
  const cfg=settings?JSON.parse(fs.readFileSync(settings,'utf8')):{};delete cfg.recentFiles;delete cfg.lastFile;
  run=await launch({...opts,settings:{...cfg,restoreLast:false,autosaveEnabled:false}},owner,out);result.artifact=run.metadata;
  clip=await clipboard.hold();
  const cases=process.env.MP_QUALITY_CASES && new RegExp(process.env.MP_QUALITY_CASES);
  for(const [id,html,expected] of probes){
    if(cases&&!cases.test(id))continue;
    await check(id,async trace=>{
      const large=id===probes[0][0]&&!!original;
      const file=large?owner:path.join(out,id+'.md');if(!large)fs.writeFileSync(file,'TARGET\n');
      const p=large?run.page:await newWindow(run,run.page,file);await p.bringToFront();
      await p.keyboard.press('Control+Home');await p.keyboard.press('Shift+End');
      const sel=await p.evaluate(()=>window.mpEngine._view().state.selection.main.toJSON());assert.equal(sel.anchor,0);assert.equal(sel.head,6);
      await p.evaluate(()=>document.addEventListener('paste',e=>{window.__studyPaste={trusted:e.isTrusted,types:[...e.clipboardData.types]};},{capture:true,once:true}));
      assert((await p.evaluate(payload=>window.mpHost.writeClipboard(payload,window.mpHost.beginClipboardIntent('copy')),{text:'',html})).ok);
      assert(clipboard.verifyHtml(html).matches);await p.keyboard.press('Control+v');
      await waitUntil(()=>p.evaluate(()=>window.__studyPaste?.trusted),'native paste reached document');
      await sleep(240);
      const prefix=await p.evaluate(()=>window.mpEngine._view().state.doc.sliceString(0,230));const event=await p.evaluate(()=>window.__studyPaste);
      trace.push({event,matched:prefix.startsWith(expected+'\n'),...(!large?{actual:prefix}:{})});
      if(!large)result.frames.push(await frame(p,out,id+'-pasted',{allowMissingCaret:true}));
      assert(prefix.startsWith(expected+'\n'),'converted rich source mismatch');
      if(id==='scientific-rich-marks'){
        await p.keyboard.press('Control+End');
        await waitUntil(()=>p.locator('.cm-content .mp-sub').count(),'subscript projection');
        const scripts=await p.evaluate(()=>['sub','sup'].map(tag=>{const el=document.querySelector('.cm-content .mp-'+tag);return el && [el.textContent,getComputedStyle(el).verticalAlign];}));
        trace.push({scripts});assert.deepEqual(scripts,[['2','sub'],['2','super']]);
      }
      await p.keyboard.press('Control+z');await waitUntil(()=>p.evaluate(()=>window.mpEngine._view().state.doc.line(1).text==='TARGET'),'one Undo restores selected text');
      await p.keyboard.press('Control+y');await p.keyboard.press('Control+s');
      const intended=Buffer.concat([Buffer.from(expected+'\n'),large?tail:Buffer.alloc(0)]);
      await waitUntil(()=>fs.readFileSync(file).equals(intended),'complete independent disk readback');assert(clipboard.verifyHtml(html).matches);
    });
  }
  for(const reverse of [false,true]){
    const id='italic-preserves-existing-bold-'+(reverse?'reverse':'forward');if(cases&&!cases.test(id))continue;
    await check(id,async trace=>{
      const file=path.join(out,id+'.md');fs.writeFileSync(file,'**word** tail');
      const p=await newWindow(run,run.page,file);await p.bringToFront();await p.keyboard.press('Control+Home');
      // Reach both UTF-16 source endpoints using the real editor keyboard path.
      const base=await p.evaluate(()=>{const v=window.mpEngine._view();return v.state.doc.toString();});assert.equal(base,'**word** tail');
      await p.keyboard.press('Shift+End');await p.keyboard.press('Home');
      const position=reverse?6:2;for(let i=0;i<position;i++)await p.keyboard.press('ArrowRight');
      for(let i=0;i<4;i++)await p.keyboard.press(reverse?'Shift+ArrowLeft':'Shift+ArrowRight');
      const before=await snapshot(p);assert.equal(before.selection.anchor,reverse?6:2,'selection start confirmed');assert.equal(before.selection.head,reverse?2:6,'selection end confirmed');
      await p.keyboard.press('Control+i');const after=await snapshot(p);trace.push({selection:before.selection,text:after.text});
      result.frames.push(await frame(p,out,id+'-after',{allowMissingCaret:true}));assert.equal(after.text,'***word*** tail');
      await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,base);
      await p.keyboard.press('Control+y');await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')==='***word*** tail','saved bold italic');
    });
  }
}catch(e){result.fatal=e.stack;}finally{
  try{if(clip)result.clipboard=await clip.restore();}finally{try{result.cleanup=await run?.cleanup();}finally{release();}}
  result.originalUnchanged=!process.env.MP_STUDY_DOC||sha256(process.env.MP_STUDY_DOC)===result.originalSha256;
  result.passed=!result.fatal&&result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&result.originalUnchanged;
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
})();
