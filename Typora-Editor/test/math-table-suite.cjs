const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

// This probe runs only in the isolated extension-host test Webview. Commands
// and text input below travel through Chromium's trusted keyboard input path.
exports.probe=async function(request){
  const api=window.vditor,e=api.vditor,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  if(request.op==='load'){
    e.toolbar.elements['edit-mode'].querySelector(`button[data-mode="${request.mode}"]`).click();
    api.setValue(request.source,true);await delay(250);api.clearStack();
    window.__tableMathErrors=[];
    if(!window.__tableMathListening){window.__tableMathListening=true;window.addEventListener('error',event=>window.__tableMathErrors.push(String(event.error?.stack||event.message)));window.addEventListener('unhandledrejection',event=>window.__tableMathErrors.push(String(event.reason)));}
  }
  const root=e[e.currentMode].element,s=getSelection(),cell=request.cell&&root.querySelectorAll('table')[request.cell[0]]?.rows[request.cell[1]]?.cells[request.cell[2]];
  if(request.op.startsWith('nested')){
    document.documentElement.dataset.readingPalette='beige';const p=[...root.querySelectorAll('p')].find(n=>n.textContent.includes('可见')&&n.textContent.includes('概率密度正是')),codes=[...p.querySelectorAll('code[data-type="math-inline"]')];
    if(request.op==='nestedPoint'){
      const node=codes[request.index].closest('.vditor-ir__node,.vditor-wysiwyg__block').querySelector('.language-math');node.scrollIntoView({block:'center',inline:'center'});await delay(80);const r=node.getBoundingClientRect();const p=document.querySelector('.md-completion');const pr=p&&!p.hidden?p.getBoundingClientRect():null;const diag=(window.__posdiag||[]).slice(-14);return{x:r.x+r.width/2,y:r.y+r.height/2,popupAtClick:pr?{top:Math.round(pr.top),bottom:Math.round(pr.bottom),left:Math.round(pr.left),right:Math.round(pr.right)}:null,diag};
    }
    return{value:api.getValue(),visible:codes.map((code,index)=>{const r=code.getBoundingClientRect();return getComputedStyle(code).display!=='none'&&r.width>1&&r.height>1?index:null;}).filter(n=>n!=null),errors:window.__tableMathErrors||[],popup:(()=>{const p=document.querySelector('.md-completion');if(!p||p.hidden)return null;const r=p.getBoundingClientRect();return{top:Math.round(r.top),bottom:Math.round(r.bottom),left:Math.round(r.left),right:Math.round(r.right)}})()};
  }
  if(request.op==='cell'){
    cell.scrollIntoView({block:'center',behavior:'instant'});root.focus();
    const range=document.createRange();range.selectNodeContents(cell);
    if(!request.select)range.collapse(true);s.removeAllRanges();s.addRange(range);await delay(30);
  }
  if(request.op==='prose'){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;
    while(n=walker.nextNode())if(!n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')&&n.data.includes('一、事件与集'))break;
    if(!n)throw new Error('No prose source');root.focus();const at=n.data.indexOf('一、事件与集'),r=document.createRange();r.setStart(n,at);r.setEnd(n,at+6);s.removeAllRanges();s.addRange(r);
  }
  const el=n=>n?.nodeType===3?n.parentElement:n,c=el(s.focusNode)?.closest('td,th'),tables=[...root.querySelectorAll('table')];
  return{markdown:api.getValue(),mode:e.currentMode,shapes:tables.map(t=>[...t.rows].map(r=>r.cells.length)),cells:tables.map(t=>[...t.rows].map(r=>[...r.cells].map(c=>{const copy=c.cloneNode(true);copy.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview').forEach(p=>p.remove());return copy.textContent.replaceAll('\u200b','').trim()}))),focusCell:c?[tables.indexOf(c.closest('table')),c.parentElement.rowIndex,c.cellIndex]:null,math:el(s.focusNode)?.closest('code[data-type="math-inline"]')?.textContent.replaceAll('\u200b','')??null,expanded:root.querySelectorAll('.vditor-ir__node--expand code[data-type="math-inline"]').length,errors:window.__tableMathErrors||[]};
};

exports.run=async({request,shortcut,send,document,file,until,pass,testRoot})=>{
  const note=fs.readFileSync(path.resolve(__dirname,'../../Typora-Editor-App/.backups/2026-09-08-math-table/user-note-original.md'),'utf8');
  const q=fields=>request('mathTable',fields);
  const source='一、事件与集\n\n'+note;
  for(const mode of ['ir','wysiwyg','sv']){
    const before=await q({op:'load',mode,source});await q({op:'prose'});await shortcut('E');await shortcut('E');let current=await q({op:'read'});
    assert.equal(current.markdown,before.markdown,mode+' native math toggle must restore exact source');assert.deepEqual(current.errors,[]);pass('Actual VSIX '+mode+' trusted Ctrl+Shift+E adds and removes Chinese math');
    if(mode==='sv')continue;
    for(const tex of [String.raw`P(A|B)+\frac{x_1}{1+x}`,'事件🙂集合',String.raw`\begin{matrix}a&b\\c&d\end{matrix}`]){
      const base=await q({op:'load',mode,source});await q({op:'cell',cell:[0,2,1]});await shortcut('E');
      for(const ch of tex){await send('Input.insertText',{text:ch});current=await q({op:'read'});assert.deepEqual(current.shapes,base.shapes,'VSIX table broke during '+ch);assert.deepEqual(current.focusCell,[0,2,1],'VSIX input escaped cell');assert.deepEqual(current.errors,[]);}
      assert.equal(current.math,tex.startsWith('P(A|B)')?String.raw`P(A\vert{}B)+\frac{x_1}{1+x}`:tex,'VSIX source differs from typed TeX');
      await q({op:'cell',cell:[0,2,2]});current=await q({op:'read'});assert.equal(current.expanded,0,'VSIX stale cell preview');
      await until(()=>document.getText()===current.markdown);await document.save();assert.equal(fs.readFileSync(file,'utf8'),current.markdown);
      const saved=current.markdown,cells=current.cells,reopened=await q({op:'load',mode,source:saved});assert.deepEqual(reopened.shapes,base.shapes,'VSIX saved pipe/matrix breaks table on reload');assert.deepEqual(reopened.cells,cells,'VSIX lost cell content on reload');
      pass('Actual VSIX '+mode+' cell typing, cell exit, host save and reload preserve '+tex);
    }
    const base=await q({op:'load',mode,source});await q({op:'cell',cell:[1,2,4],select:true});
    for(let i=0;i<12;i++){await shortcut('E');current=await q({op:'read'});assert.deepEqual(current.focusCell,[1,2,4]);if(i%2)assert.equal(current.markdown,base.markdown);}
    pass('Actual VSIX '+mode+' repeated formula toggles stay in the selected duplicate cell');
    const nestedBase=await q({op:'load',mode,source});
    const frame=(await send('Runtime.evaluate',{expression:`(()=>{const a=[...document.querySelectorAll('iframe')].map(n=>n.getBoundingClientRect().toJSON()).filter(r=>r.width>100&&r.height>100);return a.sort((a,b)=>b.width*b.height-a.width*a.height)[0];})()`,returnByValue:true})).result.value;
    for(const index of [0,1,2,0])for(let repeat=0;repeat<2;repeat++){
      const point=await q({op:'nestedPoint',index});for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:point.x+frame.x,y:point.y+frame.y,button:'left',clickCount:1});await new Promise(r=>setTimeout(r,180));const s=await q({op:'nestedRead'});
      console.log('nested-step mode=%s index=%d repeat=%d point=%j popup=%j visible=%j',mode,index,repeat,point,s.popup,s.visible);
      assert.deepEqual(s.visible,[index],'Actual VSIX nested formula exposes other sources (click '+JSON.stringify(point)+' popupAtClick '+JSON.stringify(point.popupAtClick)+' popupAfter '+JSON.stringify(s.popup)+' visible '+JSON.stringify(s.visible)+')');assert.equal(s.value,nestedBase.markdown);assert.deepEqual(s.errors,[]);
    }
    pass('Actual VSIX '+mode+' original RN paragraph opens only the clicked formula, including preview reclicks');
  }
  fs.writeFileSync(path.join(testRoot,'math-table-verified.json'),JSON.stringify({sourceNote:'user-note-original.md',modes:['ir','wysiwyg','sv'],verified:true},null,2));
};
