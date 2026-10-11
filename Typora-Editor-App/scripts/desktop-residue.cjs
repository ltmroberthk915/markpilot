// Full-app gate for the deletion-residue trigger (v2.0.3). The user saw
// stale pixels while backspacing after an AI insert: at key-repeat pace the
// completion popup used to flicker open (120ms debounce ≈ repeat interval)
// over the reflowing text, and a translucent overlay toggling there is the
// stale-paint trigger. Gate: with real local completion installed, a
// held-backspace burst never shows the popup; typing a letter afterwards
// still brings candidates up promptly. Live-pixel diagnostics are recorded
// as evidence but not asserted (transient windows are machine-dependent).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const frame='document.getElementById("editor").contentWindow';
  const source='# 删除残迹守门\n\n'
    +'概率测度 probability measure 与 Borel 代数的构造背景段落，删除过程不得弹出补全候选框。\n\n'
    +'typing probe word tail.\n';
  const file=path.join(output,'residue-gate.md');
  fs.writeFileSync(file,source);
  const report=[];
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  await until(`${frame}.vditor?.vditor?.__typoraPatched && ${frame}.vditor.getValue().includes('删除过程')`);
  await until(`${frame}.__typoraMathStats?.pending===0`);
  await delay(400);
  const popupVisible=()=>ev(`(()=>{const w=${frame};const m=w.document.querySelector('.md-completion:not([hidden])');return !!m&&m.offsetWidth>0&&m.offsetHeight>0})()`);
  // Positive control with a deterministic offline source: '/ta' matches the
  // built-in snippet dictionary (table), proving the popup machinery would
  // open in this session — the burst assertion below is only meaningful
  // against a working popup. (A '\' trigger is unusable in text: IR wraps
  // backslashes in marker nodes, so the captured prefix loses the slash.)
  const openSnippetPopup=async()=>{
    await ev(`(()=>{const w=${frame};const ir=w.vditor.vditor.ir.element;const blocks=[...ir.children];const last=blocks.at(-1);const r=w.document.createRange();r.selectNodeContents(last);r.collapse(false);ir.focus();const s=w.getSelection();s.removeAllRanges();s.addRange(r);return true})()`);
    await win.webContents.insertText(' /ta');
    for(let i=0;i<30;i++){if(await popupVisible())return true;await delay(100);}
    return false;
  };
  const control=await openSnippetPopup();
  if(!control){
    const diag=await ev(`JSON.stringify((()=>{const w=${frame};const c=w.vditor&&w.vditor.__completion;const s=w.getSelection();return{installed:!!c,focus:w.document.hasFocus(),rangeCount:s?s.rangeCount:-1,anchorText:s&&s.rangeCount&&s.anchorNode.nodeType===3?s.anchorNode.data.slice(-20):null,anchorTag:s&&s.rangeCount&&s.anchorNode.nodeType===1?s.anchorNode.tagName:null}})())`).catch(error=>String(error));
    console.error('control diagnostics:',JSON.stringify(diag));
  }
  report.push({step:'positive-control',visible:control});
  assert.equal(control,true,'positive control: "/ta" must open the snippet popup (otherwise the burst gate is vacuous)');
  console.log('positive control: popup opens via /ta snippet candidates');

  // 2) Held-backspace burst at key-repeat pace: popup must never be visible.
  await ev(`(()=>{const w=${frame};const ir=w.vditor.vditor.ir.element;const sel=w.getSelection();if(!sel.rangeCount)return false;const r=sel.getRangeAt(0).cloneRange();r.setStart(r.startContainer,Math.max(0,r.startOffset));r.collapse(false);ir.focus();sel.removeAllRanges();sel.addRange(r);return true})()`);
  let sightings=0,checks=0;
  for(let i=0;i<50;i++){
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});
    await delay(45);
    if(await popupVisible())sightings++;
    checks++;
  }
  report.push({step:'backspace-burst',checks,sightings});
  console.log(`held-backspace burst: ${checks} checks, ${sightings} popup sightings`);
  assert.equal(sightings,0,'completion popup must stay hidden during a deletion burst (stale-paint trigger)');

  // 3) Deterministic reopen after the burst: the same snippet trigger must
  // open the popup once typing (not deleting) resumes.
  await delay(800); // let the quiet window pass
  const reopened=await openSnippetPopup();
  report.push({step:'typing-reopens',visible:reopened});
  assert.equal(reopened,true,'completion must still open when typing resumes after deletions');
  console.log('PASS Deletion burst keeps the popup closed; typing reopens it');
  fs.writeFileSync(path.join(output,'desktop-residue.json'),JSON.stringify({report},null,2));
  return report.map(r=>r.step+':'+JSON.stringify(r));
};
