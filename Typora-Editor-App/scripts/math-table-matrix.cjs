const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.run=async({win,output,application})=>{
  const soakRounds=Number(process.env.MATH_TABLE_SOAK_ROUNDS||24);
  assert.ok(Number.isInteger(soakRounds)&&soakRounds>=24&&soakRounds<=500,'Invalid soak round count');
  const source=fs.readFileSync(path.resolve(__dirname,'../.backups/2026-09-08-math-table/user-note-original.md'),'utf8');
  const report={started:new Date().toISOString(),application,cases:[],events:0};
  const fe=async code=>{const result=await win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{if(!w?.vditor)throw new Error('Editor not ready');return{ok:true,value:w.eval(${JSON.stringify(code)})}}catch(e){return{ok:false,error:e.stack||String(e)}}})()`,true);if(!result.ok)throw new Error(result.error+'\nExpression: '+code.slice(0,350));return result.value;};
  const wait=async(test,label)=>{for(let i=0;i<300;i++){try{if(await fe(test))return;}catch{}await pause(30);}throw new Error('Timed out: '+label);};
  let caseName='',baseline,trace=[];
  const root='vditor.vditor[vditor.vditor.currentMode].element';
  const cell=(t,r,c)=>`${root}.querySelectorAll('table')[${t}].rows[${r}].cells[${c}]`;
  const state=()=>fe(`(()=>{const root=${root},s=getSelection(),el=n=>n?.nodeType===3?n.parentElement:n,c=el(s.focusNode)?.closest('td,th'),tables=[...root.querySelectorAll('table')];return{mode:vditor.vditor.currentMode,value:vditor.getValue(),shapes:tables.map(t=>[...t.rows].map(r=>r.cells.length)),focus:{text:s.focusNode?.textContent?.slice(0,140),offset:s.focusOffset,selected:s.toString(),cell:c?[tables.indexOf(c.closest('table')),c.parentElement.rowIndex,c.cellIndex]:null,math:el(s.focusNode)?.closest('code[data-type="math-inline"]')?.textContent??null},expanded:[...root.querySelectorAll('.vditor-ir__node--expand')].filter(n=>n.querySelector('code[data-type="math-inline"]')).map(n=>{const c=n.closest('td,th');return{text:n.querySelector('code')?.textContent,cell:c?[tables.indexOf(c.closest('table')),c.parentElement.rowIndex,c.cellIndex]:null}}),tableHTML:tables.slice(0,3).map(t=>t.outerHTML),spins:window.__mathTableSpins||[]}})()`);
  const load=async(mode='ir',extra='')=>{
    const file=path.join(output,caseName+'.md');fs.writeFileSync(file,source+'\n\n测试段落 一、事件与集 end\n\n'+extra);
    const previous=global.doc.current;
    await global.doc.openFile(file,previous?{confirmedDiscard:{current:previous,text:previous.text}}:{});
    const version=global.doc.docVersion;
    await wait(`location.search.includes('v=${version}') && !!vditor.__completion && ${root}.querySelectorAll('table').length>=3`,'fixture');
    if(await fe('vditor.vditor.currentMode')!==mode){await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="${mode}"]').click();true`);await pause(120);}
    await fe(`(()=>{window.__mathTableSpins=[];const l=vditor.vditor.lute,f=l.SpinVditorIRDOM;l.SpinVditorIRDOM=function(html,...args){const out=f.call(this,html,...args);window.__mathTableSpins.push({in:html,out});if(window.__mathTableSpins.length>6)window.__mathTableSpins.shift();return out};return true})()`);
    await fe(`window.__testErrors=[];window.__testKeyups=0;window.addEventListener('keyup',()=>__testKeyups++,true);window.addEventListener('error',event=>__testErrors.push(String(event.error?.stack||event.message)));window.addEventListener('unhandledrejection',event=>__testErrors.push(String(event.reason?.stack||event.reason)));true`);
    await pause(180);baseline=await state();trace=[];return file;
  };
  const record=async(label,shapes=true)=>{const s=await state();trace.push({label,...s});report.events++;if(shapes)assert.deepEqual(s.shapes,baseline.shapes,label+' changed table structure');assert.deepEqual(await fe('window.__testErrors||[]'),[],label+' threw a renderer error');return s;};
  const key=async(keyCode,modifiers=[],delay=70)=>{const before=await fe('window.__testKeyups');win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await wait(`window.__testKeyups>${before}`,'trusted key delivered '+keyCode);if(delay)await pause(delay);return record('key '+modifiers.join('+')+'+'+keyCode);};
  const toggle=delay=>key('E',['control','shift'],delay);
  const type=async(text,delay=35)=>{for(const ch of text){win.webContents.sendInputEvent({type:'keyDown',keyCode:ch});win.webContents.sendInputEvent({type:'char',keyCode:ch});win.webContents.sendInputEvent({type:'keyUp',keyCode:ch});if(delay)await pause(delay);await record('type '+ch);}return state();};
  const click=async(expr)=>{
    await fe(`(${expr}).scrollIntoView({block:'center',inline:'center',behavior:'instant'});true`);await pause(100);
    const p=await fe(`(()=>{const n=${expr},r=n.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.left+r.left+Math.min(15,r.width/2)),y:Math.round(f.top+r.top+Math.min(18,r.height/2))}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await pause(70);return record('mouse click');
  };
  const select=async(expr,text,collapsed=false)=>{
    await click(expr);
    await fe(`(()=>{const node=${expr},walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode())if(!n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')&&n.data.includes(${JSON.stringify(text)}))break;if(!n)throw new Error('Source text missing');const at=n.data.indexOf(${JSON.stringify(text)}),r=document.createRange();r.setStart(n,at);r.setEnd(n,at+${collapsed?0:text.length});getSelection().removeAllRanges();getSelection().addRange(r);${root}.focus();return true})()`);
  };
  const prose=`[...${root}.querySelectorAll('p')].find(p=>p.textContent.includes('测试段落'))`;
  const cellContents=()=>fe(`(()=>{const root=${root};return [...root.querySelectorAll('table')].map(t=>[...t.rows].map(r=>[...r.cells].map(c=>{const copy=c.cloneNode(true);copy.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview').forEach(p=>p.remove());return copy.textContent.replaceAll('\u200b','').trim()})))})()`);
  const runCase=async(name,fn)=>{
    if(process.env.MATH_TABLE_CASES&&!new RegExp(process.env.MATH_TABLE_CASES).test(name))return;
    caseName=name;try{await fn();report.cases.push({name,status:'PASS',steps:trace.length});console.log('PASS '+name);}
    catch(e){report.cases.push({name,status:'FAIL',error:e.message,steps:trace.length});console.log('FAIL '+name+': '+e.message.slice(0,250));fs.writeFileSync(path.join(output,name+'-failure.json'),JSON.stringify({error:e.stack,baseline,trace,state:await state().catch(()=>null)},null,2));fs.writeFileSync(path.join(output,name+'-failure.png'),(await win.webContents.capturePage()).toPNG());}
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
  };
  for(const mode of ['ir','wysiwyg']){
    await runCase(mode+'-empty-cell-math-focus',async()=>{await load(mode);await click(cell(0,2,1));await toggle();let s=await type('a');assert.deepEqual(s.focus.cell,[0,2,1],'typing escaped its cell');assert.equal(s.focus.math?.replace(/\u200b/g,''),'a','caret outside inserted math');await click(cell(0,2,2));s=await record('after neighboring cell');assert.equal(s.expanded.length,0,'previous math remains expanded in another cell');});
    await runCase(mode+'-selected-cell-toggle-off',async()=>{await load(mode);await select(cell(1,2,4),'a');await toggle();const s=await toggle();assert.deepEqual(s.focus.cell,[1,2,4],'toggle moved to a duplicate formula');assert.equal(s.focus.math,null,'second shortcut nests instead of unwraps');assert.equal(s.value,baseline.value,'wrapping then unwrapping changed source');});
    await runCase(mode+'-prose-toggle-off',async()=>{await load(mode);await select(prose,'一、事件与集');await toggle();const s=await toggle();assert.equal(s.value,baseline.value,'second shortcut must remove delimiters');});
    await runCase(mode+'-existing-math-toggle-off',async()=>{await load(mode);await select(cell(0,1,0),'a',true);const s=await toggle();assert.equal(s.focus.math,null,'existing formula must unwrap');assert.deepEqual(s.focus.cell,[0,1,0],'unwrap stays in same cell');assert.ok(!s.value.includes('$$$'),'unwrap introduced extra dollars');});
    await runCase(mode+'-empty-math-cancel',async()=>{await load(mode);await click(cell(0,2,3));await toggle();const s=await toggle();assert.equal(s.value,baseline.value,'empty math toggle must be reversible');});
    await runCase(mode+'-br-cell-is-linebreak',async()=>{await load(mode);await click(cell(2,0,0));const exposed=await fe(`(()=>{const c=${cell(2,0,0)};return [...c.querySelectorAll('code')].filter(n=>n.textContent.includes('<br')&&getComputedStyle(n).display!=='none'&&n.getBoundingClientRect().width>1).map(n=>n.outerHTML)})()`);assert.equal(exposed.length,0,'line breaks expose HTML source '+exposed.join(''));});
    await runCase(mode+'-preview-contained-in-final-row',async()=>{
      await load(mode);await click(cell(0,2,1));await toggle();await type(String.raw`\frac{x_1}{1+x}`);await pause(180);
      const bounds=await fe(`(()=>{const c=${cell(0,2,1)},p=c.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');const cr=c.getBoundingClientRect(),pr=p.getBoundingClientRect();return{cell:{top:cr.top,bottom:cr.bottom,left:cr.left,right:cr.right},preview:{top:pr.top,bottom:pr.bottom,left:pr.left,right:pr.right,height:pr.height}}})()`);
      assert.ok(bounds.preview.height>12,'active math preview is not visible');
      assert.ok(bounds.preview.bottom<=bounds.cell.bottom+1&&bounds.preview.top>=bounds.cell.top-1,'table clips the active preview: '+JSON.stringify(bounds));
      if(mode==='ir'){
        const markers=await fe(`(()=>{const c=${cell(0,2,1)}.querySelector('code[data-type="math-inline"]'),n=c.parentElement;return{first:n.firstElementChild.getBoundingClientRect().top,last:n.lastElementChild.getBoundingClientRect().top,code:c.getBoundingClientRect().top}})()`);
        assert.ok(Math.abs(markers.first-markers.last)<2&&Math.abs(markers.code-markers.last)<2,'formula closing delimiter moved below its preview: '+JSON.stringify(markers));
      }
      fs.writeFileSync(path.join(output,caseName+'-active.png'),(await win.webContents.capturePage()).toPNG());
      await click(cell(0,2,2));
      const visible=await fe(`(()=>{const c=${cell(0,2,1)}.querySelector('code[data-type="math-inline"]'),r=c.getBoundingClientRect();return getComputedStyle(c).display!=='none'&&r.width>0&&r.height>0})()`);
      assert.equal(visible,false,'formula source stays visible after moving to the next cell');
    });
    for(const [label,text,canonical] of [['ascii','x_1^2+3'],['fraction',String.raw`\frac{a_1}{b^2}`],['pipe',String.raw`P(A|B)\mid x`,String.raw`P(A\vert{}B)\mid x`],['matrix',String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`],['unfinished',String.raw`\frac{a}{`],['punctuation','x$y`z_<>&%#']]){
      await runCase(mode+'-typing-'+label,async()=>{await load(mode);await click(cell(0,2,1));await toggle();let s=await type(text);assert.deepEqual(s.focus.cell,[0,2,1],'typing escaped target cell');const content=await fe(`(${cell(0,2,1)}).querySelector('code[data-type="math-inline"]')?.textContent.replaceAll('\u200b','')`);assert.equal(content,canonical||text,'formula source changed while typing');await click(cell(0,2,2));s=await record('formula settled');assert.equal(s.expanded.length,0,'formula left open after click');assert.ok(s.value.includes(canonical||text),'typed TeX lost');
        if(label==='pipe'||label==='matrix'){
          const beforeCells=await cellContents(),saved=s.value;
          await fe(`vditor.setValue(${JSON.stringify(saved)},true);true`);await pause(220);await record('reparse special formula');assert.deepEqual(await cellContents(),beforeCells,'reopening changed table cell content');
        }
      });
    }
    for(const [label,nav,modifiers] of [['tab','Tab',[]],['shift-tab','Tab',['shift']],['down','Down',[]],['up','Up',[]]]){
      await runCase(mode+'-navigation-'+label,async()=>{await load(mode);await click(cell(0,2,2));await toggle();await type('q');await key(nav,modifiers);const s=await record('navigation settled');if(s.focus.math===null)assert.equal(s.expanded.length,0,'preview must close after leaving source');assert.equal(s.shapes.length,baseline.shapes.length);});
    }
    await runCase(mode+'-rapid-toggle-30',async()=>{await load(mode);await select(cell(1,2,4),'a');for(let i=0;i<30;i++){const s=await toggle(i%3===0?0:10);assert.deepEqual(s.focus.cell,[1,2,4],'rapid toggle escaped cell');if(i%2)assert.equal(s.value,baseline.value,'toggle pair altered source');}await pause(700);const s=await record('no delayed caret theft');assert.deepEqual(s.focus.cell,[1,2,4]);assert.equal(s.value,baseline.value);});
    await runCase(mode+'-mouse-between-duplicates',async()=>{await load(mode);for(let i=0;i<6;i++){await click(cell(0,1,i%2?4:0));await click(cell(0,2,2));const s=await record('duplicate preview collapsed');assert.equal(s.expanded.length,0,'old cell still editing');}assert.equal((await state()).value,baseline.value,'focus-only movement modified document');});
    await runCase(mode+'-type-undo-redo-save-reopen',async()=>{
      const file=await load(mode);await click(cell(0,2,1));await toggle();await type('n^2');await pause(260);const edited=(await state()).value;
      await key('Z',['control']);const undone=(await state()).value;assert.notEqual(undone,edited,'undo must remove an actual edit');await key('Y',['control']);assert.equal((await state()).value,edited,'redo loses TeX');
      await click(cell(0,2,2));await wait(`vditor.getValue()===${JSON.stringify(edited)}`,'editor settle');
      for(let i=0;i<150&&global.doc.current.text!==edited;i++)await pause(30);assert.equal(global.doc.current.text,edited,'host did not receive source');await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),edited,'save not equal to editor');
      const reopened=path.join(output,caseName+'-reopened.md');fs.copyFileSync(file,reopened);await global.doc.openFile(reopened);const version=global.doc.docVersion;await wait(`location.search.includes('v=${version}')&&!!vditor.__completion`,'reopen');await pause(200);const s=await record('saved note reopened');assert.ok(s.value.includes('$n^2$'),'formula lost on reopen');
    });
    await runCase(mode+'-delete-empty-formula',async()=>{
      await load(mode);await click(cell(0,2,1));await toggle();await type('r');await key('Backspace');
      const empty=await cellContents();assert.equal(empty[0][2][1],'$$','deleted formula must have a serializable empty boundary');
      await key('Backspace');await type('s');assert.deepEqual((await state()).focus.cell,[0,2,1],'backspace escaped cell');
      const cells=await cellContents();assert.equal(cells[0][2][1],'s','second Backspace must remove the complete empty formula');
      const saved=(await state()).value;await fe(`vditor.setValue(${JSON.stringify(saved)},true);true`);await pause(160);await record('delete-empty reparse');assert.deepEqual(await cellContents(),cells,'deleted formula splits a table on reload');
    });
    await runCase(mode+'-empty-math-forward-delete',async()=>{await load(mode);await click(cell(0,2,1));await toggle();await key('Delete');await type('s');assert.equal((await cellContents())[0][2][1],'s','Delete must remove both empty formula delimiters');});
    await runCase(mode+'-chinese-and-emoji-input',async()=>{await load(mode);await click(cell(0,2,1));await toggle();await win.webContents.insertText('事件🙂集合');await pause(100);let s=await record('native composed text');assert.equal(s.focus.math?.replaceAll('\u200b',''),'事件🙂集合');await toggle();s=await state();assert.equal(s.focus.math,null);assert.ok(s.value.includes('事件🙂集合'));});
    await runCase(mode+'-br-edit-and-math',async()=>{await load(mode);await click(cell(2,0,0));await type('a');await toggle();await type('b');await click(cell(2,0,1));const s=await record('linebreak cell settled');assert.equal(s.expanded.length,0);assert.ok(s.value.includes('<br />'),'line break dropped');});
    await runCase(mode+'-clipboard-in-formula',async()=>{
      const {clipboard}=require('electron'),restore=await require('./test-clipboard.cjs').preserveClipboard();try{await load(mode);await click(cell(0,2,1));await toggle();await clipboard.writeText(String.raw`\frac{x_1}{1+x}`);await key('V',['control'],150);const s=await state();assert.deepEqual(s.focus.cell,[0,2,1]);assert.ok(s.value.includes(String.raw`\frac{x_1}{1+x}`),'paste lost LaTeX');await toggle();await type('z');}finally{await restore();}
    });
    await runCase(mode+'-multiline-paste-reopen',async()=>{
      const {clipboard}=require('electron'),restore=await require('./test-clipboard.cjs').preserveClipboard();try{
        await load(mode);await click(cell(0,2,1));await toggle();await clipboard.writeText('a|b\nc');await key('V',['control'],180);
        assert.equal((await state()).focus.math?.replaceAll('\u200b',''),String.raw`a\vert{}b c`,'table paste must encode a single-bar delimiter and keep one GFM row');
        await click(cell(0,2,2));const before=await cellContents(),saved=(await state()).value;await fe(`vditor.setValue(${JSON.stringify(saved)},true);true`);await pause(250);await record('multiline paste roundtrip');assert.deepEqual(await cellContents(),before,'multiline paste lost neighboring cells on reload');
      }finally{await restore();}
    });
    await runCase(mode+'-header-cell',async()=>{await load(mode);await click(cell(0,0,3));await toggle();await type('h');assert.deepEqual((await state()).focus.cell,[0,0,3]);await click(cell(0,1,1));assert.equal((await state()).expanded.length,0);});
    await runCase(mode+'-source-mode-roundtrip',async()=>{await load(mode);await click(cell(0,2,1));await toggle();await type('k+2');const edited=(await state()).value;await fe(`vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').click();true`);await pause(120);assert.equal(await fe('vditor.vditor.currentMode'),'sv');assert.ok((await fe('vditor.getValue()')).includes('$k+2$'),'SV dropped edited formula');await fe(`vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').click();true`);await pause(160);await record('visual source roundtrip');assert.equal((await state()).value,edited);await click(cell(0,2,2));assert.equal((await state()).expanded.length,0);});
    await runCase(mode+'-enter-inside-math',async()=>{await load(mode);await click(cell(0,2,1));await toggle();await type('a');await key('Enter');await type('b');const s=await state();assert.deepEqual(s.focus.cell,[0,2,1],'Enter must not escape or dismantle the current table');await click(cell(0,2,2));await record('enter committed');});
    await runCase(mode+'-partial-formula-selection-off',async()=>{await load(mode,'\n段首 $abc+def$ 段尾\n');const p=`[...${root}.querySelectorAll('p')].find(p=>p.textContent.includes('段首'))`;await select(p,'bc+d');const s=await toggle();assert.ok(s.value.includes('段首 abc+def 段尾'),'partial formula selection must unwrap the complete source');assert.ok(!s.value.includes('$abc+def$'));});
    await runCase(mode+'-multi-cell-selection',async()=>{await load(mode);await click(cell(0,0,0));await fe(`(()=>{const r=document.createRange();r.setStart((${cell(0,0,0)}).firstChild,0);r.setEnd((${cell(0,0,2)}).firstChild,4);getSelection().removeAllRanges();getSelection().addRange(r);return true})()`);const s=await toggle();assert.ok(s.value.includes('$col1$')&&s.value.includes('$col2$')&&s.value.includes('$col3$'),'multi-cell toggle must preserve each cell');await key('Z',['control']);assert.equal((await state()).value,baseline.value,'multi-cell math must undo as one transaction');});
    await runCase(mode+'-multi-paragraph-selection',async()=>{await load(mode,'\nleft one\n\nright two\n');const first=`[...${root}.querySelectorAll('p')].find(p=>p.textContent==='left one')`,last=`[...${root}.querySelectorAll('p')].find(p=>p.textContent==='right two')`;await click(first);await fe(`(()=>{const r=document.createRange();r.setStart((${first}).firstChild,0);r.setEnd((${last}).firstChild,9);getSelection().removeAllRanges();getSelection().addRange(r);return true})()`);const s=await toggle();assert.ok(s.value.includes('$left one$\n\n$right two$'),'multiblock math must keep paragraphs separate');await key('Z',['control']);assert.equal((await state()).value,baseline.value);});
    await runCase(mode+'-literal-code-boundary',async()=>{
      await load(mode,'\n| Code | Next |\n| - | - |\n| `literalXYZ` | safe |\n\n```tex\nfencedXYZ\n```\n');
      for(const token of ['literalXYZ','fencedXYZ']){const target=`[...${root}.querySelectorAll('code')].find(c=>c.textContent.includes(${JSON.stringify(token)})&&!c.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'))`;await select(target,token);const s=await toggle();assert.equal(s.value,baseline.value,'math command must keep literal code boundaries intact');}
    });
    await runCase(mode+'-sequence-soak-'+soakRounds,async()=>{
      const file=await load(mode);let previous=await cellContents();
      for(let i=0;i<soakRounds;i++){
        const col=1+(i*7%5);await click(cell(0,2,col));
        await fe(`(()=>{const r=document.createRange();r.selectNodeContents(${cell(0,2,col)});getSelection().removeAllRanges();getSelection().addRange(r);return true})()`);
        await toggle();await win.webContents.insertText('');
        // Select current source only, then replace using trusted native input.
        await fe(`(()=>{const c=(${cell(0,2,col)}).querySelector('code[data-type="math-inline"]');if(c){const r=document.createRange();r.selectNodeContents(c);getSelection().removeAllRanges();getSelection().addRange(r);}return true})()`);
        await win.webContents.insertText('s_'+i);await pause(i%2?5:30);await record('soak edit '+i);
        await click(cell(0,2,col===5?1:col+1));await click(cell(0,2,col));await toggle();
        const current=await cellContents();for(let t=0;t<current.length;t++)for(let r=0;r<current[t].length;r++)for(let c=0;c<current[t][r].length;c++)if(!(t===0&&r===2&&c===col))assert.equal(current[t][r][c],previous[t][r][c],'unrelated cell changed during sequence');
        previous=current;
        if(i%6===5){await key('Z',['control']);await key('Y',['control']);assert.deepEqual(await cellContents(),previous,'sequence undo/redo changed cells');await pause(250);await global.doc.save();}
      }
      await pause(500);const s=await record('soak final');for(let i=0;i<120&&global.doc.current.text!==s.value;i++)await pause(30);await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),s.value,'soak save mismatch');
      fs.writeFileSync(path.join(output,caseName+'-final.png'),(await win.webContents.capturePage()).toPNG());
    });
  }
  report.finished=new Date().toISOString();report.failed=report.cases.filter(c=>c.status==='FAIL').length;fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
  if(report.failed)throw new Error(`${report.failed}/${report.cases.length} math/table cases failed`);
  if(process.env.MATH_TABLE_HOLD==='1'){caseName='manual-observation';await load('ir');}
};
