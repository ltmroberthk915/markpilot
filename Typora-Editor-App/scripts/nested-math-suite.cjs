const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,output,application})=>{
  const records=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async code=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Timed out '+code);};
  const original=fs.readFileSync(path.resolve(__dirname,'../.backups/2026-09-08-viewflow/user-note-original.md'),'utf8'),line=original.split(/\r?\n/).find(s=>s.startsWith('可见**概率密度正是'));assert.ok(line);
  const plain=line.replaceAll('**','');
  const formats={bold:line,plain,italic:'*'+plain+'*',strike:'~~'+plain+'~~',nested:'***'+plain+'***',link:'['+plain+'](#local-anchor)'};
  for(const mode of ['ir','wysiwyg'])for(const [kind,text] of Object.entries(formats))for(const context of ['paragraph','table']){
    const name=mode+'-'+kind+'-'+context;if(process.env.NESTED_MATH_CASES&&!new RegExp(process.env.NESTED_MATH_CASES).test(name))continue;
    const fixture='# 公式独立展开验收\n\n'+(context==='table'?'| Formula | Neighbor |\n| --- | --- |\n| '+text+' | 保留邻格 $z$ |':text)+'\n\n退出公式后的普通正文。\n',file=path.join(output,name+'.md');fs.writeFileSync(file,fixture);
    await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});const version=global.doc.docVersion;
    await wait('location.search.includes("v='+version+'")&&vditor.getValue().includes("公式独立展开验收")&&!!vditor.__splitNavigation');
    if(await fe('vditor.vditor.currentMode')!==mode)await fe('vditor.vditor.toolbar.elements["edit-mode"].querySelector(\'button[data-mode="'+mode+'"]\').click();true');await pause(160);
    await fe('document.documentElement.dataset.readingPalette="beige";true');
    const baseline=await fe('vditor.getValue()'),steps=[];
    const state=()=>fe(`(()=>{const e=vditor.vditor,root=e[e.currentMode].element,s=getSelection();return{value:vditor.getValue(),focus:{text:s.focusNode?.textContent,offset:s.focusOffset},codes:[...root.querySelectorAll('code[data-type="math-inline"]')].map(c=>{const r=c.getBoundingClientRect(),st=getComputedStyle(c),owner=c.closest('.vditor-ir__node,.vditor-wysiwyg__block'),m=owner.querySelector('.language-math');return{tex:c.textContent,visible:st.display!=='none'&&st.visibility!=='hidden'&&r.width>1&&r.height>1,expanded:owner.classList.contains('vditor-ir__node--expand'),rect:r.toJSON(),style:{display:st.display,color:st.color,background:st.backgroundColor},preview:m?.getBoundingClientRect().toJSON(),owner:owner.outerHTML.slice(0,500)};})};})()`);
    const click=async(index,second=false)=>{
      const expr=`(()=>{const e=vditor.vditor,r=e[e.currentMode].element,c=r.querySelectorAll('code[data-type="math-inline"]')[${index}],o=c.closest('.vditor-ir__node,.vditor-wysiwyg__block');return o.querySelector('.language-math');})()`;
      if(!second){await fe('('+expr+').scrollIntoView({block:"center",inline:"center"});true');await pause(80);}
      const p=await fe('(()=>{const m='+expr+',r=m.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+r.x+r.width/2),y:Math.round(f.y+r.y+r.height/2)};})()');
      for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});await pause(150);
    };
    try{
      for(const index of [0,1,2,0]){
        await click(index);let s=await state();steps.push({action:'open',index,...s});assert.deepEqual(s.codes.map((c,i)=>c.visible?i:null).filter(i=>i!=null),[index],'Opening one formula exposes neighboring source');assert.equal(s.value,baseline);
        await click(index,true);s=await state();steps.push({action:'preview-click',index,...s});assert.deepEqual(s.codes.map((c,i)=>c.visible?i:null).filter(i=>i!=null),[index],'Clicking the active preview opens neighboring source');assert.equal(s.value,baseline);
      }
      assert.equal(global.doc.dirty,false,'Clicking formulas must not edit the document');
      const p=await fe(`(()=>{const e=vditor.vditor,r=e[e.currentMode].element,w=document.createTreeWalker(r,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.data.includes('概率密度正是'))break;const a=n.data.indexOf('概率密度正是')+3,range=document.createRange();range.setStart(n,a);range.setEnd(n,a+1);const b=range.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+b.x+b.width*.2),y:Math.round(f.y+b.y+b.height/2)};})()`);
      for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});await pause(160);let s=await state();steps.push({action:'ordinary-formatted-text',...s});assert.ok(s.codes.every(c=>!c.visible),'A caret in ordinary formatted text activates a formula');
      for(let i=0;i<2;i++){for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'E',modifiers:['control','shift']});await pause(100);s=await state();steps.push({action:'text-shortcut-toggle',...s});assert.ok(s.value.includes('$\\mathbb{P}_X$')&&s.value.includes('$\\mathcal{L}$'),'Shortcut in formatted text changed an unrelated formula');}
      assert.equal(s.value,baseline,'Shortcut pair in formatted text must be reversible');
      assert.equal(fs.readFileSync(file,'utf8'),fixture);records.push({name,status:'PASS',steps:steps.length});console.log('PASS '+name);
    }catch(error){records.push({name,status:'FAIL',error:String(error.stack)});fs.writeFileSync(path.join(output,name+'-failure.json'),JSON.stringify({steps,state:await state()},null,2));fs.writeFileSync(path.join(output,name+'-failure.png'),(await win.webContents.capturePage()).toPNG());console.log('FAIL '+name+' '+error.message);throw error;}
    finally{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,cases:records,failed:records.filter(r=>r.status==='FAIL').length},null,2));}
  }
};
