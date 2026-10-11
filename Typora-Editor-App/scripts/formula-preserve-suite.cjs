// Permanent regression: rendered formulas survive every edit path that does
// not change their own source. Tags each rendered math node with a stable id,
// performs one real edit, then asserts node identity (the tag survived), no
// unrendered flash frames, and the value actually changed. The only edit that
// may rebuild a formula is editing that formula's own source.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,output,application})=>{
  const records=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const fixture='# 公式保留验收\n\nP1 has $a+1$ inline and block $$\\int_0^1 x\\,dx$$ here.\n\nP2 plain text before formulas $c+2$ middle $d+3$ tail.\n\nP3 untouched $e+4$.\n\n| head | plain |\n| --- | --- |\n| cell $f+5$ | words |\n\nEnd $g+6$.\n';
  const tag=mode=>fe(`(()=>{let i=0;for(const n of vditor.vditor[ '${mode}' ].element.querySelectorAll('.vditor-${mode}__preview .language-math'))n.dataset.keep='k'+(i++);return i})()`);
  const snapshot=mode=>fe(`(()=>{const e=vditor.vditor;const math=[...e[ '${mode}' ].element.querySelectorAll('.vditor-${mode}__preview .language-math')];return{mode:e.currentMode,value:vditor.getValue(),kept:math.filter(n=>n.dataset.keep).length,built:math.filter(n=>!n.dataset.keep).map(n=>n.getAttribute('data-math')||n.textContent.slice(0,40))};})()`);
  // Sample per frame while editing: a preview whose math lost its tag is a
  // visible unrendered flash. Pending background renders are recorded as a
  // property, not a failure - they never blank the preserved nodes.
  const arm=mode=>fe(`window.__flash=[];window.__samplerOn=true;const sample=()=>{if(!window.__samplerOn)return;const missing=[],pending=window.__typoraMathStats?.pending||0;for(const p of vditor.vditor[ '${mode}' ].element.querySelectorAll('.vditor-${mode}__preview')){const m=p.querySelector('.language-math');if(!m||!m.dataset||!m.dataset.keep)missing.push(String(m?.getAttribute('data-math')??m?.textContent?.slice(0,40)));}if(missing.length)window.__flash.push({missing:missing.slice(0,10),pending});requestAnimationFrame(sample);};requestAnimationFrame(sample);true`);
  const disarm=()=>fe('const f=window.__flash||[];window.__samplerOn=false;f');
  const caretText=(mode,needle,word)=>fe(`(()=>{const root=vditor.vditor[ '${mode}' ].element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.data.includes(${JSON.stringify(needle)}))break;}if(!n)return false;const at=n.data.indexOf(${JSON.stringify(word)});if(at<0)return false;const r=document.createRange();r.setStart(n,at);r.collapse(true);const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  const selectWord=(mode,needle,word)=>fe(`(()=>{const root=vditor.vditor[ '${mode}' ].element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.data.includes(${JSON.stringify(needle)}))break;}if(!n)return false;const at=n.data.indexOf(${JSON.stringify(word)});if(at<0)return false;const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+${word.length});const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return s.toString()===${JSON.stringify(word)}})()`);
  const caretFormula=(mode)=>fe(`(()=>{const codes=[...vditor.vditor[ '${mode}' ].element.querySelectorAll('code')];const c=codes.find(n=>n.textContent.replace(/\\u200b/g,'')==='c+2');if(!c||!c.firstChild)return false;const r=document.createRange();r.setStart(c.firstChild,1);r.collapse(true);const s=getSelection();vditor.vditor[ '${mode}' ].element.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  const caretCell=(mode)=>fe(`(()=>{const root=vditor.vditor[ '${mode}' ].element;const cell=[...root.querySelectorAll('th,td')].find(c=>c.textContent.trim()==='words');if(!cell)return false;const w=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);const n=w.nextNode();if(!n)return false;const r=document.createRange();r.setStart(n,n.data.length);r.collapse(true);const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  const type=async text=>{await win.webContents.insertText(text);await pause(200);};
  const key=(k,mods=[])=>{for(const t of ['keyDown','keyUp'])win.webContents.sendInputEvent({type:t,keyCode:k,modifiers:mods});};
  const open=async name=>{const file=path.join(output,'formula-'+name+'.md');fs.writeFileSync(file,fixture);await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});const version=global.doc.docVersion;await wait(`location.search.includes("v=${version}")&&vditor.getValue().includes("End")&&vditor.vditor.currentMode==='ir'`,'ir editor ready');await wait("window.__typoraMathStats?.pending===0",'math idle');await pause(250);return file;};
  const run=async(name,mode,action)=>{
    try{
      await open(name);
      if(mode!=='ir'){await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="${mode}"]').click();true`);await wait(`vditor.vditor.currentMode==='${mode}'`,mode);await pause(300);}
      const tagged=await tag(mode);assert.ok(tagged>=6,'tagged '+tagged+' rendered formulas');
      const before=await snapshot(mode);
      await arm(mode);
      await action(before);
      const flash=await disarm();await pause(800);
      const after=await snapshot(mode);
      fs.writeFileSync(path.join(output,'formula-'+name+'-state.json'),JSON.stringify({tagged,before,after,flash},null,2));
      return {tagged,before,after,flash};
    }catch(error){
      records.push({name,status:'FAIL',error:String(error.stack||error)});console.log('FAIL '+name+' '+error.message);
      try{fs.writeFileSync(path.join(output,'formula-'+name+'-failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}
      fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,cases:records,failed:records.filter(r=>r.status==='FAIL').length},null,2));
      throw error;
    }
  };
  const finish=name=>{records.push({name,status:'PASS'});console.log('PASS '+name);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,cases:records,failed:records.filter(r=>r.status==='FAIL').length},null,2));};

  { // Common: plain typing inside a formula-bearing line keeps every formula.
    const s=await run('ir-plain-type','ir',async before=>{
      assert.equal(await caretText('ir','P2 plain text','formulas'),true,'caret placed');
      await type('x');
    });
    assert.equal(s.after.kept,s.tagged,'all formulas keep their DOM nodes');
    assert.equal(s.after.built.length,0,'nothing rebuilt');
    assert.equal(s.flash.length,0,'no unrendered flash frames');
    assert.notEqual(s.after.value,s.before.value);assert.ok(s.after.value.includes('x'),'the edit landed');
    finish('Formula preservation: plain typing keeps every rendered formula (IR)');
  }
  { // Common: editing one formula's source rebuilds only that formula.
    const s=await run('ir-formula-edit','ir',async()=>{
      assert.equal(await caretFormula('ir'),true,'caret inside the c+2 source');
      await type('9');
    });
    assert.equal(s.after.kept,s.tagged-1,'all other formulas keep their nodes');
    assert.deepEqual(s.after.built.map(x=>String(x).replace(/\u200b/g,'')),['c9+2'],'exactly the edited formula rebuilt');
    for(const frame of s.flash)for(const missing of frame.missing)assert.ok(/^c9?\+/.test(String(missing).replace(/\u200b/g,'')),'only the edited formula may flash, saw '+missing);
    assert.ok(s.after.value.includes('c9+2'),'the formula edit landed');
    finish('Formula re-render is on demand: editing c+2 rebuilds only c+92');
  }
  { // Edge: typing in a neighbouring plain table cell keeps the cell formula.
    const s=await run('ir-table-neighbor','ir',async()=>{
      assert.equal(await caretCell('ir'),true,'caret in the plain cell');
      await type('x');
    });
    assert.equal(s.after.kept,s.tagged,'table formula keeps its node');
    assert.equal(s.after.built.length,0,'nothing rebuilt');
    assert.equal(s.flash.length,0,'no unrendered flash frames');
    assert.ok(s.after.value.includes('wordsx'),'the cell edit landed');
    finish('Formula preservation: typing in a neighbouring table cell keeps the cell formula');
  }
  { // v2.0.3 regression (user report): keyboard formatting on a selection in a
    // formula-bearing paragraph must not flash the other rendered formulas in
    // that line back to source while the block rebuilds.
    const format=async(name,code,marker)=>{
      const s=await run('ir-format-'+name,'ir',async()=>{
        assert.equal(await selectWord('ir','P2 plain text','plain text'),true,'selection placed');
        key(code,['control']);
        await pause(450);
      });
      assert.equal(s.after.kept,s.tagged,name+': every formula keeps its DOM node');
      assert.equal(s.after.built.length,0,name+': no formula rebuilt');
      assert.equal(s.flash.length,0,name+': no unrendered flash frames');
      assert.ok(s.after.value.includes(marker),name+' markup landed');
      finish('Formula preservation: Ctrl+'+code+' keeps same-line formulas rendered (no source flash)');
    };
    await format('bold','B','**plain text**');
    await format('italic','I','*plain text*');
    await format('underline','U','<u>plain text</u>');
  }
  { // Edge: undo and redo of plain typing restore value without re-rendering.
    const s=await run('ir-undo-redo','ir',async before=>{
      const taggedCount=await fe(`vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math').length`);
      assert.equal(await caretText('ir','P2 plain text','formulas'),true,'caret placed');
      await type('x');await pause(400);
      const typed=await snapshot('ir');assert.ok(typed.value.includes('x'),'typed');
      key('Z',['control']);await pause(500);
      const undone=await snapshot('ir');
      assert.equal(undone.value,before.value,'undo restored the exact source');
      assert.equal(undone.kept,taggedCount,'undo kept every formula node');
      assert.equal(undone.built.length,0,'undo rebuilt nothing');
      key('Y',['control']);await pause(500);
    });
    assert.equal(s.after.kept,s.tagged,'redo kept every formula node');
    assert.equal(s.after.built.length,0,'redo rebuilt nothing');
    assert.ok(s.after.value.includes('x'),'redo restored the edit');
    assert.equal(s.flash.length,0,'no unrendered flash frames through undo/redo');
    finish('Formula preservation: undo and redo never re-render formulas');
  }
  { // Edge: a programmatic whole-document setValue (the IDE AI sidebar path)
    // changes plain text but must not rebuild any formula it did not touch.
    const s=await run('ir-ai-setvalue','ir',async()=>{
      const next=fixture.replace('P3 untouched','P3 由 AI 侧边栏修改');
      await fe(`vditor.setValue(${JSON.stringify(next)});true`);
    });
    assert.ok(s.after.value.includes('AI 侧边栏修改'),'the AI edit landed');
    assert.equal(s.after.kept,s.tagged,'AI-side edit kept every formula node');
    assert.equal(s.after.built.length,0,'AI-side edit rebuilt nothing');
    assert.equal(s.flash.length,0,'no unrendered flash frames');
    finish('Formula preservation: AI-sidebar-style setValue keeps untouched formulas');
  }
  { // Edge: WYSIWYG typing near formulas keeps them rendered too.
    const s=await run('wysiwyg-plain-type','wysiwyg',async()=>{
      assert.equal(await caretText('wysiwyg','P2 plain text','formulas'),true,'caret placed');
      await type('x');
    });
    assert.equal(s.after.kept,s.tagged,'all formulas keep their DOM nodes');
    assert.equal(s.after.built.length,0,'nothing rebuilt');
    assert.equal(s.flash.length,0,'no unrendered flash frames');
    assert.ok(s.after.value.includes('x'),'the edit landed');
    finish('Formula preservation: plain typing keeps every rendered formula (WYSIWYG)');
  }
  await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="ir"]').click();true`);
};
