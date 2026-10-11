// One-shot diagnostic: does plain-text input in a formula-bearing paragraph
// preserve that paragraph's rendered math (same DOM node, no unrendered
// flash)? Tags every rendered math node, types one char nearby, samples per
// animation frame, reports node identity + flash + render-reuse stats.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<300;i++){if(await fe(code))return;await pause(40);}throw Error('Not ready: '+(label||code));};
  const file=path.join(output,'render-diag.md');
  const fixture='# Diag\n\nP1 has $a+1$ inline and block $$\\int_0^1 x\\,dx$$ here.\n\nP2 plain text before formulas $c+2$ middle $d+3$ tail.\n\nP3 untouched $e+4$.\n\n| head |\n| --- |\n| cell $f+5$ |\n\nEnd $g+6$.\n';
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  await wait('vditor.getValue().includes("End")&&!!vditor.__completion');
  await wait("window.__typoraMathStats?.__lookupGetter__('pending')?window.__typoraMathStats.pending===0:true",'math idle');
  await pause(300);
  const report={};
  report.before=await fe(`(()=>{const e=vditor.vditor;return{mode:e.currentMode,math:[...e.ir.element.querySelectorAll('.language-math')].map(n=>n.getAttribute('data-math'))};})()`);
  // Tag every rendered math node with a stable id.
  await fe(`(()=>{let i=0;for(const n of vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math'))n.dataset.diag='m'+(i++);return true})()`);
  const count=await fe(`document.querySelectorAll('.vditor-ir__preview .language-math').length`);
  // Place the caret in P2's leading plain text (before any formula), like a user click.
  await fe(`(()=>{const root=vditor.vditor.ir.element,walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(n.data.includes('P2 plain text'))break;}const at=n.data.indexOf('formulas');const r=document.createRange();r.setStart(n,at);r.collapse(true);const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  // Sample every frame while typing one real character: any frame where a
  // preview's math lacks its tag means it was rebuilt (unrendered flash).
  await fe(`window.__flash=[];window.__samplerRunning=true;const sample=()=>{if(!window.__samplerRunning)return;const missing=[],pending=window.__typoraMathStats?.pending||0;for(const p of vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview')){const m=p.firstElementChild;if(!m||!m.dataset||!m.dataset.diag)missing.push(m?.getAttribute('data-math'));}if(missing.length||pending)__flash.push({t:Math.round(performance.now()),missing:missing.slice(0,8),pending});requestAnimationFrame(sample);};requestAnimationFrame(sample);true`);
  await win.webContents.insertText('x');
  await pause(150);
  await fe(`window.__samplerRunning=false;true`);
  await pause(700);
  report.after=await fe(`(()=>{const e=vditor.vditor;const survived=[...e.ir.element.querySelectorAll('.vditor-ir__preview .language-math')].map(n=>n.dataset.diag||('BUILT:'+n.getAttribute('data-math')));return{value:vditor.getValue(),survived,reuse:e.__typoraRenderReuse,mathStats:{...window.__typoraMathStats}};})()`);
  report.flash=await fe('window.__flash');
  // Case 2: editing INSIDE a formula's source - only that formula may rebuild.
  await wait('window.__typoraMathStats?.pending===0||true','idle2');await pause(200);
  await fe(`(()=>{let i=100;for(const n of vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math'))n.dataset.diag='m'+(i++);return true})()`);
  await fe(`(()=>{const codes=[...vditor.vditor.ir.element.querySelectorAll('code')];const c=codes.find(n=>n.textContent.replace(/\\u200b/g,'')==='c+2');const r=document.createRange();r.setStart(c.firstChild,1);r.collapse(true);const s=getSelection();vditor.vditor.ir.element.focus();s.removeAllRanges();s.addRange(r);return !!c})()`);
  await fe(`window.__flash2=[];window.__sampler2=true;const sample=()=>{if(!window.__sampler2)return;const missing=[];for(const p of vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview')){const m=p.firstElementChild;if(!m?.dataset?.diag)missing.push(m?.getAttribute('data-math'));}if(missing.length)__flash2.push(missing.slice(0,8));requestAnimationFrame(sample);};requestAnimationFrame(sample);true`);
  await win.webContents.insertText('9');
  await pause(150);
  await fe('window.__sampler2=false;true');
  await pause(900);
  report.formulaEdit=await fe(`(()=>{const survived=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')].map(n=>n.dataset.diag||('BUILT:'+n.getAttribute('data-math')));return{value:vditor.getValue(),survived,flash:window.__flash2,mathStats:{...window.__typoraMathStats}};})()`);
  console.log('DIAG2 formulaEdit keptTagged='+report.formulaEdit.survived.filter(s=>!String(s).startsWith('BUILT:')).length+' rebuilt='+report.formulaEdit.survived.filter(s=>String(s).startsWith('BUILT:')).map(s=>String(s).slice(6))+' flashFrames='+report.formulaEdit.flash.length+' rendered='+report.formulaEdit.mathStats.rendered);
  fs.writeFileSync(path.join(output,'diag-report.json'),JSON.stringify(report,null,2));
  console.log('DIAG mathCount='+count+' survivedTagged='+report.after.survived.filter(s=>!String(s).startsWith('BUILT:')).length+' built='+report.after.survived.filter(s=>String(s).startsWith('BUILT:')).length+' flashFrames='+report.flash.length+' reuse='+JSON.stringify(report.after.reuse));
};
