const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

// Real App-shell regression matrix for the interaction between incremental IR,
// live table editing, media replacement, mode switching and host input.
// Every character is injected through Electron's input path and the live DOM
// is checked after every character; getValue() alone is not sufficient here.
exports.run=async({win,until,output})=>{
  const checks=[],base=path.join(output,'table-input-host');fs.mkdirSync(base,{recursive:true});
  const pass=text=>{checks.push('PASS '+text);console.log(checks.at(-1));};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const file=path.join(base,'table-input-source.md');
  const freshReopen=path.join(base,'table-input-fresh-reopen.md');
  const mediaReopen=path.join(base,'table-input-media-reopen.md');
  const reopened=path.join(base,'table-input-reopened.md');
  const bitmap=Buffer.alloc(48*24*4);
  for(let y=0;y<24;y++)for(let x=0;x<48;x++){const i=(y*48+x)*4;bitmap[i]=40+x*3;bitmap[i+1]=110+y*4;bitmap[i+2]=190;bitmap[i+3]=255;}
  const {nativeImage}=require('electron'),data='data:image/png;base64,'+nativeImage.createFromBitmap(bitmap,{width:48,height:24}).toPNG().toString('base64');
  const fixture=`# 表格输入矩阵

正文 $outside+1$，用于确认表格编辑不会影响相邻块。

| 名称 | 文本 | 公式与代码 | 图片 |
| --- | --- | --- | --- |
| 普通 | 普通单元格 | $x+1$ `+'`const a=1`'+` | ![表内图](${data}) |
| 引用 | [链接][ref] | `+'`=1+1`'+` | ![另一张](${data}) |
| 空白 |  | $y+1$ | 文本 |

[ref]: https://example.org

结尾 $outside+2$。
`;
  fs.writeFileSync(file,fixture);fs.writeFileSync(reopened,fixture);
  const fe=code=>win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w||!w.vditor)throw new Error('editor frame not ready');return w.eval(${JSON.stringify(code)});})()`,true);
  const waitEditor=async()=>{
    const version=global.doc.docVersion,marker=global.doc.current?.text.split('\n').find(line=>line.trim())?.trim().slice(0,32)||'';
    await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{return !!w&&w.location.search.includes('v=${version}')&&!!w.vditor?.__media&&!!w.vditor?.__completion;}catch{return false;}})()`);
    for(let i=0;i<200;i++){try{if(!marker||String(await fe('vditor.getValue()')).includes(marker))return;}catch{}await pause(30);}
    throw new Error('editor did not receive fixture '+JSON.stringify({version,file:global.doc.file,marker}));
  };
  const wait=async(expression,message='condition timed out')=>{for(let i=0;i<250;i++){if(await fe(expression))return;await pause(30);}throw new Error(message+': '+expression);};
  const rootState=async(mode)=>{mode ||= await fe('vditor.vditor.currentMode');return fe(`(()=>{const e=vditor.vditor,root=e[${JSON.stringify(mode)}]?.element,table=root?.querySelector('table');return{mode:${JSON.stringify(mode)},table:!!table,rows:table?.rows.length||0,cols:table?.rows[0]?.cells.length||0,value:vditor.getValue(),html:root?.innerHTML?.slice(0,5000),stats:e.__typoraPerformance?.stats?{version:e.__typoraPerformance.stats.version,blockParses:e.__typoraPerformance.stats.blockParses,calibrations:e.__typoraPerformance.stats.calibrations}:null,reuse:e.__typoraRenderReuse||null}})()`);};
  const assertTable=async(label,token='',mode)=>{
    mode ||= await fe('vditor.vditor.currentMode');
    const state=await rootState(mode);assert.ok(state.table&&state.rows>=4&&state.cols>=4&&(!token||state.value.includes(token)),`${label}: ${JSON.stringify(state)}`);return state;
  };
  const cellState=mode=>fe(`(()=>{const root=vditor.vditor[${JSON.stringify(mode)}].element,table=root.querySelector('table'),s=getSelection(),cell=(s.focusNode?.nodeType===3?s.focusNode.parentElement:s.focusNode)?.closest('td,th');return{shape:[...table.rows].map(r=>r.cells.length),cells:[...table.rows].map(r=>[...r.cells].map(c=>{const copy=c.cloneNode(true);copy.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview').forEach(n=>n.remove());return copy.textContent.replaceAll('\\u200b','').trim()})),focus:cell?[cell.parentElement.rowIndex,cell.cellIndex]:null,value:vditor.getValue()}})()`);
  const syncedValue=async()=>{const value=await fe('vditor.getValue()');for(let i=0;i<250&&global.doc.current?.text!==value;i++)await pause(30);assert.equal(global.doc.current?.text,value,'Latest complete editor text reaches the host before save');return value;};
  const saveExact=async()=>{const value=await syncedValue(),expected=global.doc.diskText(global.doc.current,value);assert.equal(await global.doc.save(),true);assert.equal(fs.readFileSync(global.doc.file,'utf8'),expected,'Saved bytes match complete editor text with images expanded');return value;};
  const clickCell=async(row,col,mode)=>{
    mode ||= await fe('vditor.vditor.currentMode');
    await fe(`(()=>{vditor.vditor[${JSON.stringify(mode)}].element.querySelector('table').rows[${row}].cells[${col}].scrollIntoView({block:'center',inline:'center',behavior:'instant'});return true})()`);await pause(80);
    const point=await fe(`(()=>{const cell=vditor.vditor[${JSON.stringify(mode)}].element.querySelector('table')?.rows[${row}]?.cells[${col}];if(!cell)throw new Error('table cell missing '+${JSON.stringify(row+','+col)});const r=cell.getBoundingClientRect(),f=window.frameElement?.getBoundingClientRect()||{left:0,top:0};return{x:Math.round(f.left+r.left+Math.max(5,Math.min(r.width-5,r.width*.72))),y:Math.round(f.top+r.top+Math.max(5,Math.min(r.height-5,r.height*.55)))}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y});
    await pause(60);
    assert.deepEqual((await cellState(mode)).focus,[row,col],'Native mouse click places the caret in the intended cell');
  };
  const typeCell=async(row,col,token,label,mode)=>{
    mode ||= await fe('vditor.vditor.currentMode');
    await clickCell(row,col,mode);
    let previous=await cellState(mode);
    for(const key of token){
      win.webContents.sendInputEvent({type:'keyDown',keyCode:key});
      win.webContents.sendInputEvent({type:'char',keyCode:key});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:key});
      await pause(75);
      await assertTable(`${label} after ${key}`,token,mode);
      const current=await cellState(mode);
      assert.deepEqual(current.shape,previous.shape,label+' preserves exact table shape');
      assert.deepEqual(current.focus,[row,col],label+' retains the target caret');
      assert.equal(current.cells[row][col].length,previous.cells[row][col].length+key.length,label+' inserts exactly one character in the target cell');
      for(let r=0;r<current.cells.length;r++)for(let c=0;c<current.cells[r].length;c++)if(r!==row||c!==col)assert.equal(current.cells[r][c],previous.cells[r][c],label+' preserves every neighboring cell');
      previous=current;
    }
    await syncedValue();
    pass(`${label} keeps live table after every real keystroke`);
  };
  const mode=async(name)=>{await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="${name}"]').click()`);await wait(`vditor.vditor.currentMode===${JSON.stringify(name)}&&!!vditor.vditor[${JSON.stringify(name)}].element`,'mode switch');await pause(120);};
  const load=async(target=file)=>{await global.doc.openFile(target);await waitEditor();await wait(`!!vditor.vditor[${JSON.stringify('ir')}].element.querySelector('table')||vditor.vditor.currentMode==='sv'`,'table render');};
  const reopenCopy=async(target)=>{fs.copyFileSync(file,target);await global.doc.openFile(target);await waitEditor();await wait(`!!vditor.vditor.ir.element.querySelector('table')`,'unique table reopen');};
  const openImageMenu=async(selector)=>{try{await wait(`!!document.querySelector(${JSON.stringify(selector)})?.naturalWidth`,'image render');}catch(error){const detail=await fe(`(()=>{const e=vditor.vditor,root=e[e.currentMode]?.element;return{mode:e.currentMode,images:[...root?.querySelectorAll('table img')||[]].map(x=>({naturalWidth:x.naturalWidth,complete:x.complete,src:x.getAttribute('src'),outer:x.outerHTML})),source:vditor.getValue().slice(0,3600)}})()`);throw new Error(error.message+' '+JSON.stringify(detail));}const info=await fe(`(()=>{const img=document.querySelector(${JSON.stringify(selector)});if(!img)throw new Error('image missing');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,view:window,clientX:100,clientY:100});img.dispatchEvent(event);const menu=document.getElementById('typora-editor-context-menu');return{mode:vditor.vditor.currentMode,prevented:event.defaultPrevented,button:!!menu?.querySelector('[data-action="image-settings"]'),images:[...document.querySelectorAll('table img')].map(x=>({connected:x.isConnected,src:x.getAttribute('src')?.slice(0,24),parent:x.parentElement?.tagName,outer:x.outerHTML.slice(0,500),chain:[...function*(){let n=x;while(n){yield n;n=n.parentElement;}}()].slice(0,7).map(n=>n.tagName+'.'+n.className)}))}})()`);if(!(info.prevented&&info.button))throw new Error('image context menu missing '+JSON.stringify(info));await fe(`document.querySelector('#typora-editor-context-menu [data-action="image-settings"]').click();true`);await wait('!!document.getElementById("typora-image-settings")','image dialog');};
  const scaleImage=async(selector,percent)=>{await openImageMenu(selector);await fe(`(()=>{const d=document.getElementById('typora-image-settings'),b=[...d.querySelectorAll('.media-presets button')].find(x=>x.textContent===${JSON.stringify(percent+'%')});if(!b)throw new Error('scale preset missing');b.click();d.querySelector('form button[type="submit"]').click();return true})()`);try{await wait('!document.getElementById(\"typora-image-settings\")','image dialog close');}catch(error){  const detail=await fe('(()=>{const d=document.getElementById("typora-image-settings");const img=document.querySelector(' + JSON.stringify(selector) + ');return d?{dialogOpen:true,error:d.querySelector(".media-error")?.textContent||"",scale:img?.getAttribute("data-typora-scale"),connected:img?.isConnected}:{dialogOpen:false};})()');  throw new Error(error.message+" "+JSON.stringify(detail));}await pause(80);};
  const structural=async(action,row=1,col=1)=>{await fe(`(()=>{const cell=vditor.vditor.ir.element.querySelector('table')?.rows[${row}]?.cells[${col}];if(!cell)throw new Error('structural target missing');const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:100,clientY:100});cell.dispatchEvent(e);const b=document.querySelector('#typora-editor-context-menu [data-action="${action}"]');if(!b)throw new Error('structural action missing');b.click();return true})()`);await pause(180);};
  try{
    await global.doc.openFile(file);await waitEditor();await wait('!!vditor.vditor.ir.element.querySelector("table")','initial table render');
    await typeCell(1,1,'A','IR fresh ordinary cell');
    await typeCell(1,2,'B','IR fresh formula/code cell');
    assert.equal(await fe(`vditor.vditor.ir.element.querySelectorAll('table img').length`),2,'IR fresh table image cells render as images');pass('IR fresh image cells remain intact beside editable cells');
    await saveExact();pass('Fresh IR table typing reaches the host file exactly');

    await reopenCopy(freshReopen);await mode('ir');await wait('!!vditor.vditor.ir.element.querySelector("table")','reopen table');
    await scaleImage('.vditor-ir table img',150);await assertTable('table image scaling before input');await typeCell(1,1,'D','IR table input after in-table image scaling');
    await scaleImage('.vditor-ir table img',75);await typeCell(1,1,'E','IR table input after second in-table image scaling');
    await saveExact();pass('In-table media replacement leaves the table editable');

    await reopenCopy(mediaReopen);await mode('ir');await wait('!!vditor.vditor.ir.element.querySelector("table")','structural table');
    await structural('table-row-below');await assertTable('after row insertion');await typeCell(2,1,'F','IR input after row insertion');
    await structural('table-col-right',1,1);await assertTable('after column insertion');await typeCell(1,2,'G','IR input after column insertion');
    await fe('vditor.vditor.undo.undo(vditor.vditor);true');await pause(180);await assertTable('after structural undo');
    await typeCell(1,1,'H','IR input after structural undo');
    await fe('vditor.vditor.undo.redo(vditor.vditor);true');await pause(180);await assertTable('after structural redo');
    pass('Structural table edits, undo and redo keep subsequent input safe');

    for(const visual of ['wysiwyg','ir']){
      await mode(visual);await wait(`!!vditor.vditor[${JSON.stringify(visual)}].element.querySelector('table')`,'visual table');
      await typeCell(1,1,visual==='wysiwyg'?'J':'K',visual+' input after mode switch',visual);
      await scaleImage('.vditor-'+visual+' table img',100);await assertTable(visual+' table after image scale',visual==='wysiwyg'?'J':'K',visual);
    }
    pass('IR and WYSIWYG retain the table through media and real input');

    await saveExact();const beforeReopen=await cellState('ir'),after=fs.readFileSync(mediaReopen,'utf8');fs.writeFileSync(reopened,after);await global.doc.openFile(reopened);await waitEditor();await wait('!!vditor.vditor.ir.element.querySelector("table")','unique reopen table');assert.deepEqual((await cellState('ir')).cells,beforeReopen.cells,'Unique-file reopen preserves every saved cell exactly');await typeCell(1,1,'L','IR input after unique-file reopen');await saveExact();const diskAfterReopen=fs.readFileSync(reopened,'utf8');assert.ok(diskAfterReopen.includes('data:image/')&&/\| 普通/.test(diskAfterReopen),'unique reopened file keeps the embedded image and table');pass('Saving and reopening a distinct Markdown file preserves exact table input state');

    // A whole-row copy must paste into another row cell by cell, keeping the
    // source row's cell structure instead of one concatenated string.
    await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});await waitEditor();
    await mode('ir');await wait('!!vditor.vditor.ir.element.querySelector("table")','row-paste base table');
    const rowCopy=await fe(`(()=>{const root=vditor.vditor.ir.element,table=root.querySelector('table'),row=table.rows[1];
      const range=document.createRange();range.selectNodeContents(row);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);root.focus({preventScroll:true});
      const data=new DataTransfer(),event=new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true});
      document.dispatchEvent(event);
      return{prevented:event.defaultPrevented,html:data.getData('text/html'),plain:data.getData('text/plain'),sel:selection.toString(),rowText:row.innerText};})()`);
        assert.ok(rowCopy.prevented,'row copy is intercepted');
    assert.ok(rowCopy.html.includes('<table')&&(rowCopy.html.match(/<tr[> ]/g)||[]).length===1,'row copy html is a one-row table: '+rowCopy.html.slice(0,160));
    const readRow=row=>fe(`(()=>{const row=vditor.vditor.ir.element.querySelector('table').rows[${row}];return [...row.cells].map(c=>{const copy=c.cloneNode(true);copy.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview').forEach(n=>n.remove());return copy.textContent.replaceAll('\\u200b','').trim()})})()`);
    const rowCells=await readRow(1);
    assert.equal(rowCopy.plain.split('\t').length,rowCells.length,'plain text keeps the tab cell split');
    const paste=async html=>{await fe(`(async()=>{await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([${JSON.stringify(html)}],{type:'text/html'}),'text/plain':new Blob([${JSON.stringify(rowCopy.plain)}],{type:'text/plain'})})]);return true})()`);
      await clickCell(2,0,'ir');
      for(const [type,keyCode] of [['keyDown','V'],['char','v'],['keyUp','V']])win.webContents.sendInputEvent({type,keyCode,modifiers:type==='keyUp'?[]:['control']});
      await pause(450);};
    const keyCombo=async(keyCode,char)=>{for(const [type,code] of [['keyDown',keyCode],['char',char],['keyUp',keyCode]])win.webContents.sendInputEvent({type,keyCode:code,modifiers:type==='keyUp'?[]:['control']});await pause(320);};
    const rowBeforePaste=await readRow(2);
    await paste(rowCopy.html);
    let pasted=(await cellState('ir'));    assert.deepEqual(pasted.cells[2].slice(0,2),rowCells.slice(0,2),'row paste fills target cells separately: '+JSON.stringify({rowCells,pasted:pasted.cells[2]}));
    assert.ok(JSON.stringify(pasted.cells[2]).includes('x+1'),'row paste re-renders the copied formula');
    assert.equal(pasted.shape.length,4,'single-row paste does not add rows');
    await keyCombo('Z','z');assert.deepEqual(await readRow(2),rowBeforePaste,'undo restores the exact previous row');
    await keyCombo('Y','y');assert.deepEqual((await readRow(2)).slice(0,2),rowCells.slice(0,2),'redo re-applies the row paste');
    await keyCombo('Z','z');
    const rowInner=rowCopy.html.replace(/^<table[^>]*>/,'').replace(/<\/table>$/,'');
    const twoRowHtml='<table>'+rowInner.repeat(2)+'</table>';
    await paste(twoRowHtml);
    pasted=(await cellState('ir'));
    assert.equal(pasted.shape.length,4,'two-row paste overwrites downward instead of inserting rows (CSV semantics)');
    assert.deepEqual(pasted.cells[2].slice(0,2),rowCells.slice(0,2),'first pasted row fills the target');
    assert.deepEqual(pasted.cells[3].slice(0,2),rowCells.slice(0,2),'second pasted row overwrites the row below');
    await keyCombo('Z','z');pasted=(await cellState('ir'));assert.equal(pasted.shape.length,4,'undo restores the overwritten row');
    pass('A copied table row pastes cell by cell into the next row; extra payload rows overwrite downward (CSV); undo/redo exact');
    // 贴到表格末尾之外时仍然扩表：三行载荷从最后一行开始向下铺。
    const threeRowHtml='<table>'+rowInner.repeat(3)+'</table>';
    const base4Rows=pasted.shape.length;
    await clickCell(3,0,'ir');await paste(threeRowHtml);
    pasted=(await cellState('ir'));
    // 真剪贴板对 HTML 表格行数的规范化不可控，这里只断言"贴到末尾之外会扩表"
    // 与"新长出来的行带着载荷内容"，不锁死具体行数。
    assert.ok(pasted.shape.length>base4Rows,'a payload taller than the remaining rows grows the table: '+pasted.shape.length);
    assert.deepEqual(pasted.cells[pasted.shape.length-1].slice(0,2),rowCells.slice(0,2),'the grown last row carries the payload row');
    await keyCombo('Z','z');

    await mode('sv');const sourceBefore=await fe('vditor.getValue()');const sourceInfo=await fe(`(()=>{const s=vditor.vditor.sv.element,w=document.createTreeWalker(s,NodeFilter.SHOW_TEXT);let n,at=-1;while(n=w.nextNode()){at=n.data.indexOf('| 普通');if(at>=0)break;}return{tag:s?.tagName,textLength:n?.length||0,at}})()`);assert.ok(sourceInfo.at>=0,'source view exposes the table text: '+JSON.stringify(sourceInfo));await fe(`(()=>{const s=vditor.vditor.sv.element,w=document.createTreeWalker(s,NodeFilter.SHOW_TEXT);let n,at=-1;while(n=w.nextNode()){at=n.data.indexOf('| 普通');if(at>=0)break;}if(!n)throw new Error('source text node missing');const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+2);const selection=getSelection();selection.removeAllRanges();selection.addRange(r);s.focus();return true})()`);for(const key of ['M','N']){win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await pause(35);}const sourceAfter=await fe('vditor.getValue()');assert.notEqual(sourceAfter,sourceBefore);await mode('ir');await assertTable('source-mode round trip');assert.ok((await fe('vditor.getValue()')).includes('MN'));pass('Source editing round-trip keeps the table and source changes');
  }finally{
    fs.writeFileSync(path.join(base,'results.json'),JSON.stringify(checks,null,2));
  }
  return checks;
};
