const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

// Re-run the reported failure against the exact media-office workspace file,
// not a newly generated fixture. Each mode gets a disposable copy so a cell
// edit cannot hide a later failure.
exports.run=async({win,until,output})=>{
  const checks=[],sourceFile=path.resolve(__dirname,'../.perf/media-office-1.0.15/workspace/media.md');
  if(!fs.existsSync(sourceFile))throw new Error('reported media.md is missing: '+sourceFile);
  const base=path.join(output,'media-repro-host');fs.mkdirSync(base,{recursive:true});
  const pass=text=>{checks.push('PASS '+text);console.log(checks.at(-1));};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const fe=async code=>win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w?.vditor)throw new Error('editor frame not ready');return w.eval(${JSON.stringify(code)});})()`,true);
  const wait=async(expression,message)=>{for(let i=0;i<300;i++){if(await fe(expression))return;await pause(30);}throw new Error(message+': '+expression);};
  const waitEditor=async()=>{const version=global.doc.docVersion,marker=global.doc.current?.text.split('\n').find(line=>line.trim())?.trim().slice(0,32)||'';await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{return !!w&&w.location.search.includes('v=${version}')&&!!w.vditor?.__media&&!!w.vditor?.__completion}catch{return false}})()`);await wait(`vditor.getValue().includes(${JSON.stringify(marker)})`,'reported file did not reach editor');};
  const state=mode=>fe(`(()=>{const e=vditor.vditor,r=e[${JSON.stringify(mode)}]?.element,t=r?.querySelector('table');return{mode:${JSON.stringify(mode)},tables:r?.querySelectorAll('table').length||0,table:!!t,rows:t?.rows.length||0,cols:t?.rows[0]?.cells.length||0,value:vditor.getValue()}})()`);
  const clickCell=async(mode,row,col)=>{const point=await fe(`(()=>{const cell=vditor.vditor[${JSON.stringify(mode)}].element.querySelector('table')?.rows[${row}]?.cells[${col}];if(!cell)throw new Error('reported table cell missing ${row},${col}');const r=cell.getBoundingClientRect(),f=window.frameElement?.getBoundingClientRect()||{left:0,top:0};return{x:Math.round(f.left+r.left+Math.max(4,Math.min(r.width-4,r.width*.55))),y:Math.round(f.top+r.top+Math.max(4,Math.min(r.height-4,r.height*.5)))}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y});await pause(70);};
  const typeCell=async(mode,row,col,token)=>{await clickCell(mode,row,col);let typed='';for(const key of token){typed+=key;win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await pause(45);const got=await state(mode);assert.ok(got.tables>=1&&got.table&&got.rows>=3&&got.cols>=4&&got.value.includes(typed),`reported media table changed after ${key} at ${row},${col}: ${JSON.stringify(got)}`);for(let i=0;i<100&&!global.doc.current?.text.includes(typed);i++)await pause(10);assert.ok(global.doc.current?.text.includes(typed),`reported media input did not reach host after ${key} at ${row},${col}`);}};
  try{
    const original=fs.readFileSync(sourceFile);
    for(const mode of ['ir','wysiwyg']){
      const file=path.join(base,`${mode}.md`);fs.writeFileSync(file,original);await global.doc.openFile(file);await waitEditor();await wait(`vditor.vditor.currentMode==='${mode}'||vditor.vditor.currentMode==='ir'`,'reported file table render');
      if(mode==='wysiwyg'){await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="wysiwyg"]').click();true`);await wait(`vditor.vditor.currentMode==='wysiwyg'&&!!vditor.vditor.wysiwyg.element.querySelector('table')`,'reported file WYSIWYG table render');}
      const before=await state(mode);assert.ok(before.table&&before.rows>=3&&before.cols>=4,`reported media table initial shape: ${JSON.stringify(before)}`);
      if(mode==='ir'){
        const baseline=await fe('vditor.vditor.ir.element.querySelectorAll(\'code[data-type="math-block"]\').length');
        await fe(`(()=>{const cell=vditor.vditor.ir.element.querySelector('table').rows[1].cells[0],w=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.data.includes('普通'))break;if(!n)throw new Error('reported table probe text missing');const at=n.data.indexOf('普通'),r=document.createRange();r.setStart(n,at);r.setEnd(n,at+2);const s=getSelection();s.removeAllRanges();s.addRange(r);vditor.vditor.ir.element.focus();return true})()`);
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});await pause(260);
        const math=await fe(`(()=>{const root=vditor.vditor.ir.element,cell=root.querySelector('table').rows[1].cells[0],s=getSelection(),code=[...cell.querySelectorAll('code[data-type="math-inline"]')].find(x=>x.textContent==='普通');return{value:vditor.getValue(),blocks:root.querySelectorAll('code[data-type="math-block"]').length,table:!!root.querySelector('table'),code:!!code,caretInside:!!code?.contains(s.anchorNode)}})()`);
        assert.equal(math.blocks,baseline,'reported table math shortcut does not create a display block');assert.ok(math.table&&math.code&&math.value.includes('$普通$')&&math.caretInside,`reported table math shortcut failed: ${JSON.stringify(math)}`);pass('Reported media.md table Ctrl+Shift+E keeps inline math and caret inside its source');
      }
      for(const [row,col] of [[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]])await typeCell(mode,row,col,`R${row}${col}`);
      await global.doc.save();const disk=fs.readFileSync(file,'utf8');assert.ok(disk.includes('R10')&&disk.includes('R23')&&disk.includes('|'),'reported media table edits reach disk in '+mode);pass(`Reported media.md keeps its table through every real cell input in ${mode}`);
    }
    pass('Reported media.md reproduction covers both visual editing modes without table loss');
  }finally{fs.writeFileSync(path.join(base,'results.json'),JSON.stringify(checks,null,2));}
  return checks;
};
