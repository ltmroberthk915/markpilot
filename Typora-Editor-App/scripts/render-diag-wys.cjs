// One-shot: how does WYSIWYG rebuild a formula-bearing paragraph on typing?
// Records every mutation batch touching previews: which were removed/added,
// whether they were rendered (.katex), had a code sibling, and a preview key.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<300;i++){if(await fe(code))return;await pause(40);}throw Error('Not ready: '+(label||code));};
  const file=path.join(output,'render-diag-wys.md');
  const fixture='# DiagW\n\nP1 has $a+1$ inline and block $$\\int_0^1 x\\,dx$$ here.\n\nP2 plain text before formulas $c+2$ middle $d+3$ tail.\n\nP3 untouched $e+4$.\n\nEnd $g+6$.\n';
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  await wait('vditor.getValue().includes("End")&&!!vditor.__completion');
  await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="wysiwyg"]').click();true`);
  await wait(`vditor.vditor.currentMode==='wysiwyg'`,'wysiwyg mode');
  await pause(400);
  const key=p=>{const code=p.previousElementSibling,child=p.firstElementChild;if(!code||!child)return null;if(!child.matches('.language-math'))return null;const text=code.textContent.replace(/\\u00a0/g,' ');if(child.hasAttribute('data-math')&&child.getAttribute('data-math')!==text)return null;return child.tagName+':'+text;};
  // Install an observer BEFORE typing that logs preview lifecycles raw.
  await fe(`window.__wysLog=[];window.__wysObs=new MutationObserver(records=>{const describe=n=>{if(n.nodeType!==1)return null;const list=n.matches('.vditor-wysiwyg__preview')?[n]:[...n.querySelectorAll('.vditor-wysiwyg__preview')];return list.map(p=>({katex:!!p.querySelector('.katex'),code:!!p.previousElementSibling&&p.previousElementSibling.tagName==='CODE',codeText:(p.previousElementSibling?.textContent||'').replace(/\\u200b/g,'').slice(0,20),child:p.firstElementChild?.className,dataMath:p.firstElementChild?.getAttribute('data-math')}));};for(const r of records){const rm=describe(r.target).filter(Boolean).length?[]:[];for(const n of r.removedNodes){const d=describe(n);if(d&&d.length)window.__wysLog.push({phase:'removed',previews:d});}for(const n of r.addedNodes){const d=describe(n);if(d&&d.length)window.__wysLog.push({phase:'added',previews:d});}}});window.__wysObs.observe(vditor.vditor.wysiwyg.element,{childList:true,subtree:true});true`);
  await fe(`(()=>{let i=0;for(const n of vditor.vditor.wysiwyg.element.querySelectorAll('.vditor-wysiwyg__preview .language-math'))n.dataset.wtag='w'+(i++);for(const n of vditor.vditor.wysiwyg.element.querySelectorAll('.vditor-wysiwyg__preview'))n.dataset.ptag='p'+(i++);return i})()`);
  const taggedMath=await fe(`document.querySelectorAll('.vditor-wysiwyg__preview .language-math').length`);
  const taggedPreview=await fe(`document.querySelectorAll('.vditor-wysiwyg__preview').length`);
  await fe(`(()=>{const root=vditor.vditor.wysiwyg.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.data.includes('P2 plain text'))break;}const at=n.data.indexOf('formulas');const r=document.createRange();r.setStart(n,at);r.collapse(true);const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  await win.webContents.insertText('x');
  await pause(150);await pause(700);
  const after=await fe(`(()=>{const e=vditor.vditor;const math=[...e.wysiwyg.element.querySelectorAll('.vditor-wysiwyg__preview .language-math')];const previews=[...e.wysiwyg.element.querySelectorAll('.vditor-wysiwyg__preview')];return{value:vditor.getValue(),keptMath:math.filter(n=>n.dataset.wtag).length,builtMath:math.filter(n=>!n.dataset.wtag).map(n=>n.getAttribute('data-math')||n.textContent.slice(0,20)),keptPreview:previews.filter(n=>n.dataset.ptag).length,log:window.__wysLog};})()`);
  await fe('window.__wysObs.disconnect();true');
  fs.writeFileSync(path.join(output,'diag-wys-report.json'),JSON.stringify({taggedMath,taggedPreview,after},null,2));
  console.log('DIAGW taggedMath='+taggedMath+' taggedPreview='+taggedPreview+' keptMath='+after.keptMath+' built='+JSON.stringify(after.builtMath)+' keptPreview='+after.keptPreview+' batches='+after.log.length);
  for(let i=0;i<Math.min(after.log.length,12);i++)console.log('  batch'+i+' '+JSON.stringify(after.log[i]).slice(0,300));
};
