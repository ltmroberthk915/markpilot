'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,snapshot,frame,recorder,waitUntil,newWindow}=require('./harness.cjs');
const clipboard=require('./clipboard.cjs');
async function main(){
  const options=args(process.argv.slice(2)),dir=outputDir(options.out,'math-workflows'),release=acquireSlot();
  const result={suite:'math-workflows',schema:1,startedAt:new Date().toISOString(),seed:32901,cases:[]},record=recorder(dir,result),filter=process.env.MP_QUALITY_CASES;
  const test=(id,body)=>!filter||new RegExp(filter).test(id)?record(id,body):Promise.resolve();let run,clip;
  try{
    const file=path.join(dir,'quoted-formula.md'),initial='Start\n\n> $$\n> x+y\n> $$\n\nEnd\n';fs.writeFileSync(file,initial);
    run=await launch(options,file,dir);result.artifact=run.metadata;const p=run.page;
    const fixtures=[
      ['quoted-block','Start\n\n> $$\n> x+y\n> $$\n\nEnd\n','block'],
      ['nested-quoted-block','Start\n\n> > $$\n> > x+y\n> > $$\n\nEnd\n','block'],
      ['multiline-quoted-block','Start\n\n> $$\n> x+\n> y\n> $$\n\nEnd\n','block'],
      ['quoted-whitespace-block','Start\n\n> $$\n>   x+y   \n> $$\n\nEnd\n','block'],
      ['single-dollar-quoted-block','Start\n\n> $\\begin{aligned}\n> x+y\n> \\end{aligned}$\n\nEnd\n','block'],
      ['ordinary-block','Start\n\n$$\nx+y\n$$\n\nEnd\n','block'],
      ['ordinary-inline','Start\n\ninline $x+y$ after\n\nEnd\n','inline']
    ];
    for(const [name,initial,kind]of fixtures)await test(name+'-glyph-click-edit-undo-redo',async trace=>{
      const fixture=path.join(dir,name+'.md');fs.writeFileSync(fixture,initial);
      const p=await newWindow(run,run.page,fixture);
      await p.bringToFront();await p.evaluate(()=>window.mpEngine.focus());
      await waitUntil(()=>p.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'actual editor focus');
      await p.keyboard.press('Control+Home');
      const selector=kind==='block'?'.mp-cm6-math-block':'.mp-cm6-math';
      await waitUntil(()=>p.locator('.cm-content '+selector+' .katex').count(),'rendered formula');
      const target=await p.evaluate(selector=>{
        const all=[...document.querySelectorAll('.cm-content '+selector+' .katex-html [data-typora-source-start]')];
        const glyph=all.find(el=>el.textContent==='y'&&el.getBoundingClientRect().width>0);
        if(!glyph)return null;const r=glyph.getBoundingClientRect();
        return{x:r.left+r.width*.8,y:r.top+r.height*.5,text:glyph.textContent,start:glyph.getAttribute('data-typora-source-start'),end:glyph.getAttribute('data-typora-source-end')};
      },selector);assert(target,'visible source-mapped y glyph');
      trace.push({name:'before-click',target,...await snapshot(p),screenshot:await frame(p,dir,name+'-01-rendered')});
      await p.mouse.click(target.x,target.y,{delay:65});await sleep(200);
      const clicked=await snapshot(p);trace.push({name:'clicked-y',...clicked,screenshot:await frame(p,dir,name+'-02-clicked')});
      const expectedCaret=initial.indexOf('y')+1;
      assert(clicked.focus,'mouse click retained editor focus');
      await p.keyboard.insertText('z');await sleep(200);
      const edited=await snapshot(p);trace.push({name:'edited',...edited,screenshot:await frame(p,dir,name+'-03-edited')});
      await p.keyboard.press('Control+z');await sleep(150);const undone=await snapshot(p);trace.push({name:'undo',...undone,screenshot:await frame(p,dir,name+'-04-undo')});
      await p.keyboard.press('Control+y');await sleep(200);const redone=await snapshot(p);trace.push({name:'redo',...redone,screenshot:await frame(p,dir,name+'-05-redo')});
      const floatTarget=await p.evaluate(()=>{
        const glyph=[...document.querySelectorAll('.mp-inline-float .katex-html [data-typora-source-start]')].find(el=>el.textContent==='y'&&el.getBoundingClientRect().width>0);
        if(!glyph)return null;const r=glyph.getBoundingClientRect();return{x:r.left+r.width*.8,y:r.top+r.height*.5};
      });assert(floatTarget,'visible floating preview y');
      await p.mouse.click(floatTarget.x,floatTarget.y,{delay:65});await sleep(150);const floated=await snapshot(p);trace.push({name:'float-click-y',...floated,screenshot:await frame(p,dir,name+'-06-float-click')});
      assert.equal(undone.text,initial,'undo restores original quoted formula');assert.equal(redone.text,edited.text,'redo restores edited quoted formula');
      assert.equal(clicked.selection.head,expectedCaret,'clicking last glyph maps to its source endpoint past quote prefixes');
      assert.equal(edited.text,initial.slice(0,expectedCaret)+'z'+initial.slice(expectedCaret),'typing edits the intended formula position');
      assert.equal(floated.selection.head,redone.text.indexOf('y')+1,'floating preview uses current source map');
      return{expectedCaret,actualCaret:clicked.selection.head,atomicUndoRedo:true};
    });
    clip=await clipboard.hold();
    const fresh=async(name,text)=>{
      const file=path.join(dir,name+'.md');fs.writeFileSync(file,text);const page=await newWindow(run,run.page,file);
      await page.bringToFront();await page.evaluate(()=>window.mpEngine.focus());
      await waitUntil(()=>page.evaluate(()=>document.hasFocus()&&window.mpEngine._view().hasFocus),'workflow editor focus');
      return{page,file};
    };
    const literalCases=[
      {name:'control-non-tail-left',text:'Before $\\lambda+y$ after.\n',symbol:'λ',side:.2},
      {name:'control-non-tail-right',text:'Before $\\lambda+y$ after.\n',symbol:'λ',side:.8},
      {name:'control-nested-quote',text:'> > Before $\\lambda+y$ after.\n',symbol:'λ',side:.8},
      {name:'control-tail-after',text:'Before $x+\\lambda$ after.\n',symbol:'λ',side:.2,tail:true},
      {name:'repeated-prime-second',text:"Before $x''+y$ after.\n",symbol:'′',side:.8,ordinal:1,prime:true},
    ];
    for(const item of literalCases)await test(item.name+'-literal-glyph-oracle',async trace=>{
      const {page:p,file}=await fresh(item.name,item.text);
      await waitUntil(()=>p.locator('.cm-content .mp-cm6-math .katex-html').count(),'literal formula rendered');
      // Visual glyph order and its rectangle choose the target; source attributes
      // never define the expected coordinate in this independent literal oracle.
      const target=await p.evaluate(({symbol,ordinal,side})=>{
        const rows=[...document.querySelectorAll('.cm-content .mp-cm6-math .katex-html span')].filter(e=>e.childElementCount===0&&e.textContent===symbol&&e.getBoundingClientRect().width>0).map(e=>{const r=e.getBoundingClientRect();return{x:r.left+side*r.width,y:r.top+r.height/2,left:r.left,top:r.top};}).sort((a,b)=>a.left-b.left||a.top-b.top);
        return rows[ordinal||0]&&{...rows[ordinal||0],glyphCount:rows.length};
      },item);assert(target,'literal glyph occurrence visible');if(item.prime)assert.equal(target.glyphCount,2,'two distinct visible prime occurrences');
      const expected=item.prime?item.text.indexOf("''")+2:item.text.indexOf('\\lambda')+(item.tail?'\\lambda'.length:1);
      trace.push({name:'literal-before',expected,target,...await snapshot(p),screenshot:await frame(p,dir,item.name+'-01-rendered')});
      await p.mouse.click(target.x,target.y,{delay:65});await p.keyboard.insertText('R');
      const edited=await snapshot(p),want=item.text.slice(0,expected)+'R'+item.text.slice(expected);
      trace.push({name:'literal-immediate-R',...edited,screenshot:await frame(p,dir,item.name+'-02-immediate-R')});
      assert(edited.focus);assert.equal(edited.text,want,'literal command/prime glyph maps to its independently known source endpoint');assert.equal(edited.selection.head,expected+1);
      await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,item.text);
      await p.keyboard.press('Control+y');await p.keyboard.insertText('1');const continued=await snapshot(p);
      assert(continued.focus);assert.equal(continued.text,item.text.slice(0,expected)+'R1'+item.text.slice(expected));assert.equal(continued.selection.head,expected+2);
      trace.push({name:'literal-redo-immediate-one',...continued,screenshot:await frame(p,dir,item.name+'-03-redo-one')});
      await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')===continued.text,'literal glyph exact disk source');return{independentLiteralOracle:true,expected,glyphOrdinal:item.ordinal||0,tail:!!item.tail};
    });
    const capture=async(p,trace,name)=>{const state=await snapshot(p);trace.push({name,...state,screenshot:await frame(p,dir,name)});return state;};
    const click=async(p,pos,options={})=>{
      const c=await p.evaluate(pos=>window.mpEngine._view().coordsAtPos(pos),pos);assert(c&&c.bottom>c.top,'visible click source position');
      await p.mouse.click(c.left+.1,(c.top+c.bottom)/2,{delay:65,...options});await sleep(100);
    };
    const copied=async(p,expected,trace)=>{
      assert((await snapshot(p)).focus,'copy keyboard focus');
      const written=await p.evaluate(()=>window.mpHost.writeClipboard({text:'QUALITY_COPY_ARM'})),armed=clipboard.verifyText('QUALITY_COPY_ARM');trace.push({name:'clipboard-arm',write:written,...armed});assert(written.ok,'copy arm write acknowledgement');assert(armed.matches,'independent copy arm');
      await p.keyboard.press('Control+c');await sleep(80);const check=clipboard.verifyText(expected);trace.push({name:'copied-source',...check});assert(check.matches,'copy retains exact Markdown, including formula delimiters');
      const before=await snapshot(p);await p.keyboard.press('Control+End');assert((await snapshot(p)).selection.head===before.text.length,'paste at document end');
      const beforePaste=clipboard.verifyText(expected);trace.push({name:'clipboard-before-paste',...beforePaste});assert(beforePaste.matches,'clipboard immediately before paste');await p.keyboard.press('Control+v');await sleep(200);const afterPaste=clipboard.verifyText(expected);trace.push({name:'clipboard-after-paste',...afterPaste});assert(afterPaste.matches,'clipboard after paste');
      const pasted=await snapshot(p);assert.equal(pasted.text,before.text+expected,'paste inserts exact copied source');
      await p.keyboard.press('Control+z');await sleep(100);assert.equal((await snapshot(p)).text,before.text,'undo restores pre-paste document');
      await p.keyboard.press('Control+y');await sleep(200);assert.equal((await snapshot(p)).text,pasted.text,'redo restores copied source');
      return pasted;
    };
    await test('keyboard-page-navigation-full-source-copy-paste-undo-redo',async trace=>{
      const text=Array.from({length:32},(_,i)=>'Paragraph '+i+' with $x+y$ and words.\n\n'+(i%8===0?'> $$\n> x+y\n> $$\n\n':'')).join('');
      const {page:p,file}=await fresh('keyboard-flow',text);
      await p.keyboard.press('Control+Home');assert.equal((await snapshot(p)).selection.head,0);
      await p.keyboard.press('PageDown');await sleep(150);const down=await capture(p,trace,'keyboard-01-page-down');assert(down.selection.head>0&&down.scrollTop>0,'PageDown actually navigates and scrolls');
      await p.keyboard.press('PageUp');await sleep(150);const up=await capture(p,trace,'keyboard-02-page-up');assert(up.selection.head<down.selection.head,'PageUp reverses navigation');assert.equal(up.text,text,'navigation does not change document');
      await p.keyboard.press('Control+Home');await p.keyboard.press('Control+a');const selected=await snapshot(p);assert.deepEqual(selected.selection,{anchor:0,head:text.length},'keyboard selects full document');
      await copied(p,text,trace);await capture(p,trace,'keyboard-03-copy-paste-redo');
      await waitUntil(()=>fs.readFileSync(file,'utf8')===text+text,'saved full source paste');return{channel:'keyboard and combinations',sourceCopy:true};
    });
    const first='alpha $x+y$ omega',text=first+'\n\n> $$\n> x+y\n> $$\n\nEnd\n';
    await test('mouse-double-click-text-replace-undo-redo-among-formulas',async trace=>{
      const {page:p}=await fresh('mouse-flow',text);await click(p,2,{clickCount:2});const selected=await capture(p,trace,'mouse-01-double-click');
      assert.equal(text.slice(Math.min(selected.selection.anchor,selected.selection.head),Math.max(selected.selection.anchor,selected.selection.head)),'alpha','real double click selects word');
      await p.keyboard.insertText('ALPHA');const changed=await capture(p,trace,'mouse-02-replaced');assert.equal(changed.text,'ALPHA'+text.slice(5));
      await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,text);await p.keyboard.press('Control+y');assert.equal((await snapshot(p)).text,changed.text);return{channel:'mouse',clickCount:2};
    });
    await test('shift-mouse-selection-across-inline-formula-copy-paste',async trace=>{
      const {page:p}=await fresh('shift-mouse-flow',text);await click(p,0);await p.keyboard.down('Shift');try{await click(p,first.length);}finally{await p.keyboard.up('Shift');}
      const selected=await capture(p,trace,'shift-mouse-01-selected');assert.deepEqual(selected.selection,{anchor:0,head:first.length},'Shift click selects complete text and rendered formula');
      await copied(p,first,trace);await capture(p,trace,'shift-mouse-02-paste-redo');return{channel:'keyboard and mouse'};
    });
    await test('real-drag-formula-text-then-shift-key-copy-paste',async trace=>{
      const {page:p}=await fresh('drag-flow',text);const points=await p.evaluate(end=>[0,end].map(pos=>window.mpEngine._view().coordsAtPos(pos)),first.length);assert(points.every(Boolean),'visible drag endpoints');
      const y=(points[0].top+points[0].bottom)/2;await p.mouse.move(points[0].left+.1,y);await p.mouse.down();
      for(let i=1;i<=12;i++){await p.mouse.move(points[0].left+(points[1].left-points[0].left)*i/12+.1,y);await sleep(20);}await p.mouse.up();await sleep(150);
      const dragged=await capture(p,trace,'drag-01-selected');assert.deepEqual(dragged.selection,{anchor:0,head:first.length},'real drag selects all text through rendered formula');
      await p.keyboard.press('Shift+ArrowLeft');await p.keyboard.press('Shift+ArrowLeft');const shortened=await capture(p,trace,'drag-02-key-shortened');assert.deepEqual(shortened.selection,{anchor:0,head:first.length-2},'keyboard shrinks dragged selection');
      await copied(p,first.slice(0,-2),trace);await capture(p,trace,'drag-03-paste-redo');return{channel:'drag and keyboard',moves:12};
    });
  }finally{
    try{if(clip)result.clipboard=await clip.restore();}finally{try{if(run)result.cleanup=await run.cleanup();}finally{release();}}
    result.finishedAt=new Date().toISOString();result.passed=result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.cleanup?.residual?.length;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  }
  if(!result.passed)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
