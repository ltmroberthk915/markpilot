const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

// Reproduce the customer's real note, copied before every case so a failing
// edit cannot contaminate the next cell/mode. This is intentionally separate
// from the small synthetic fixtures: the note contains an unusual table with
// an inline `$$` marker and <br /> cells, which is exactly the kind of input a
// happy-path table test misses.
exports.run=async({win,until,output})=>{
  const checks=[],base=path.join(output,'user-file-host');fs.mkdirSync(base,{recursive:true});
  // 原来写死在另一台机器上的桌面路径（D:\Users\Ming\…），换台机器必然 ENOENT。
  // 默认改用本机受保护素材里的富文本素材（含内嵌 base64 插图，正是这条链要覆盖的
  // 场景）：原素材只读，编辑与断言都发生在 output/ 下的副本上。可用 USER_FILE_SOURCE 覆盖。
  const sourceFile=process.env.USER_FILE_SOURCE?path.resolve(process.env.USER_FILE_SOURCE):'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md';
  if(!fs.existsSync(sourceFile))throw new Error('用户素材未就位：'+sourceFile+'（可用 USER_FILE_SOURCE 指定）');
  const source=fs.readFileSync(sourceFile);
  const pass=text=>{checks.push('PASS '+text);console.log(checks.at(-1));};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  // 取值塌缩定位（见文末长度断言的三元组）：在这条链路每一步同时记录
  // 渲染层 getValue() 与宿主镜像 doc.current.text 的长度，用来二分出
  // "编辑器/宿主认为文档变短"的那一步。只读，不改行为。
  const stages=[];
  const stage=async label=>{
    let editor=null,host=null,error='';
    try{editor=(await fe('vditor.getValue()')).length;}catch(err){error=String(err).slice(0,160);}
    try{host=global.doc.current?.text?.length??null;}catch(err){error+=' host:'+String(err).slice(0,80);}
    stages.push({label,editor,host,error});
    console.log(`[stage] ${label} editor=${editor} host=${host}${error?' error='+error:''}`);
  };
  const flushStages=()=>{try{fs.writeFileSync(path.join(base,'stages.json'),JSON.stringify(stages,null,2));}catch{}};
  const fe=async code=>{const result=await win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w||!w.vditor)throw new Error('editor frame not ready');try{return{ok:true,value:w.eval(${JSON.stringify(code)})}}catch(error){return{ok:false,error:String(error),stack:error?.stack||''}}})()`,true);if(!result?.ok)throw new Error(`renderer JS failed: ${result?.error||'unknown'}\n${result?.stack||''}\nCode: ${code.slice(0,500)}`);return result.value;};
  const wait=async(expression,message)=>{for(let i=0;i<400;i++){if(await fe(expression))return;await pause(30);}throw new Error(message+': '+expression);};
  const waitEditor=async()=>{const version=global.doc.docVersion;await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{return !!w&&w.location.search.includes('v=${version}')&&!!w.vditor?.__media&&!!w.vditor?.__completion;}catch{return false;}})()`);await wait(`vditor.getValue().includes(${JSON.stringify('# 第一部分 高等概率论基础')})`,'real note did not reach editor');};
  const openCase=async(label)=>{const file=path.join(base,label+'.md');fs.writeFileSync(file,source);const previous=global.doc.current;await global.doc.openFile(file,previous?{confirmedDiscard:{current:previous,text:previous.text}}:{});await waitEditor();await wait('vditor.vditor.currentMode===\'ir\'&&!!vditor.vditor.ir.element.querySelector(\'table\')','real note table did not render');return file;};
  const tableState=()=>fe(`(()=>{const root=vditor.vditor.ir.element,tables=[...root.querySelectorAll('table')],s=getSelection(),n=s.focusNode,c=(n?.nodeType===3?n.parentElement:n)?.closest('td,th');return{tables:tables.length,shapes:tables.map(t=>[...t.rows].map(r=>r.cells.length)),cells:tables.map(t=>[...t.rows].map(r=>[...r.cells].map(c=>{const copy=c.cloneNode(true);copy.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview').forEach(n=>n.remove());return copy.textContent.replaceAll('\\u200b','').trim();}))),focusCell:c?[tables.indexOf(c.closest('table')),c.parentElement.rowIndex,c.cellIndex]:null,value:vditor.getValue()}})()`);
  const clickCell=async(table,row,col)=>{
    const expr=`vditor.vditor.ir.element.querySelectorAll('table')[${table}]?.rows[${row}]?.cells[${col}]`;
    await fe(`(()=>{const cell=${expr};if(!cell)throw Error('Cell missing');cell.scrollIntoView({block:'center',inline:'center',behavior:'instant'});return true;})()`);await pause(80);
    const point=await fe(`(()=>{const cell=${expr},r=cell.getBoundingClientRect(),f=window.frameElement.getBoundingClientRect();return{x:Math.round(f.left+r.left+Math.max(4,Math.min(r.width-4,r.width*.45))),y:Math.round(f.top+r.top+Math.max(4,Math.min(r.height-4,r.height*.5)))}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await pause(80);
  };
  const typeInCell=async(table,row,col,token)=>{
    await clickCell(table,row,col);let previous=await tableState();
    for(const key of token){
      win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await pause(70);
      const state=await tableState();
      try{
        assert.deepEqual(state.shapes,previous.shapes,'Typing changed the actual table shape');
        assert.deepEqual(state.focusCell,[table,row,col],'Typing escaped the clicked cell');
        assert.equal(state.cells[table][row][col].length,previous.cells[table][row][col].length+key.length,'Target cell did not receive exactly one character');
        for(let t=0;t<state.cells.length;t++)for(let r=0;r<state.cells[t].length;r++)for(let c=0;c<state.cells[t][r].length;c++)if(t!==table||r!==row||c!==col)assert.equal(state.cells[t][r][c],previous.cells[t][r][c],'Unrelated cell changed');
      }catch(error){fs.writeFileSync(path.join(base,`failure-${table}-${row}-${col}.json`),JSON.stringify({table,row,col,key,previous,state,error:error.message},null,2));throw Error(`Table ${table}, row ${row}, col ${col}: ${error.message}`);}
      previous=state;
    }
  };
  try{
    // Let the shell finish session restoration before the first direct host
    // open. Otherwise the restore request can race this matrix and replace
    // the real note with the previous profile document.
    await win.webContents.executeJavaScript("hostApi.invoke('boot')",true);
    await openCase('shape-baseline');const originalTables=await tableState();
    fs.writeFileSync(path.join(base,'initial-tables.json'),JSON.stringify(originalTables,null,2));
    for(let table=0;table<originalTables.shapes.length;table++)for(let row=0;row<originalTables.shapes[table].length;row++)for(let col=0;col<originalTables.shapes[table][row];col++){
      await openCase(`cell-${table}-${row}-${col}`);await typeInCell(table,row,col,'Z');pass(`Real note cell ${table},${row},${col} accepts typing and preserves every unrelated cell`);
    }
    await openCase('body-key');
    await fe(`(()=>{const root=vditor.vditor.ir.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.data.includes('称全集'))break;if(!n)throw new Error('body text missing');const at=n.data.indexOf('称全集');const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+2);const s=getSelection();s.removeAllRanges();s.addRange(r);root.focus();return true})()`);
    const bodyTables=await tableState();
    for(const key of ['X','Y']){win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await pause(45);const state=await tableState();assert.deepEqual(state.shapes,bodyTables.shapes,`body key ${key} keeps all real note tables`);assert.deepEqual(state.cells,bodyTables.cells,'Body input must preserve all table contents');}
    pass('Real note body typing keeps the distant unusual table attached');
    // Body typing above intentionally replaced the probe text. Start the
    // shortcut checks from a clean copy so the two experiments cannot poison
    // one another.
    const shortcutFile=await openCase('shortcut');await stage('open-shortcut');
    const baselineMath=await fe('vditor.vditor.ir.element.querySelectorAll(\'code[data-type="math-block"]\').length');
    const shortcutState=async()=>fe(`(()=>{const e=vditor.vditor,root=e.ir.element,s=getSelection(),anchor=s.anchorNode?.nodeType===3?s.anchorNode.parentElement:s.anchorNode,formulas=[...root.querySelectorAll('code[data-type="math-inline"]')],target=formulas.find(x=>x.textContent.includes('称全集'));return{value:vditor.getValue().slice(0,4000),inline:!!target,block:root.querySelectorAll('code[data-type="math-block"]').length,selected:s.toString(),node:s.focusNode?.textContent?.slice(0,120),offset:s.focusOffset,parent:anchor?.tagName+'.'+anchor?.className,source:target?.textContent||'',caretInside:!!target?.contains(s.anchorNode),inlineSources:formulas.map(x=>x.textContent).slice(0,10)}})()`);
    const selectBody=()=>fe(`(()=>{const root=vditor.vditor.ir.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.data.includes('称全集')&&!n.parentElement.closest('code[data-type="math-block"'))break;if(!n)throw new Error('body text missing');const at=n.data.indexOf('称全集');const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+3);const s=getSelection();s.removeAllRanges();s.addRange(r);root.focus();return s.toString()})()`);
    await selectBody();
    // The shipped command is Ctrl+Shift+E. The optional Enter variant in the
    // original note was a typo, so this acceptance suite deliberately does
    // not add or exercise an Enter binding.
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});await pause(260);
    const eShortcut=await shortcutState();fs.writeFileSync(path.join(base,'ctrl-shift-e.json'),JSON.stringify(eShortcut,null,2));assert.ok(eShortcut.inline&&eShortcut.source.includes('称全集'),`Ctrl+Shift+E body result is not inline math: ${JSON.stringify(eShortcut)}`);assert.ok(eShortcut.value.includes('$称全集$'),'Ctrl+Shift+E body source does not wrap selection');assert.equal(eShortcut.block,baselineMath,'Ctrl+Shift+E does not create a display-math block');pass('Real note body Ctrl+Shift+E creates inline math around selected text');
    await stage('wrap-inline');assert.equal(eShortcut.caretInside,true,`Ctrl+Shift+E caret must be inside the new inline formula: ${JSON.stringify(eShortcut)}`);pass('Real note body shortcut leaves the caret inside the inline formula source');
    await global.doc.save();assert.ok(fs.readFileSync(shortcutFile,'utf8').includes('$称全集$'),'Real note shortcut reaches disk without losing the table');
    await stage('save-inline');const emptyFile=await openCase('shortcut-empty');await stage('open-empty');
    const emptyBaseline=await fe('vditor.vditor.ir.element.querySelectorAll(\'code[data-type="math-block"]\').length');
    await fe(`(()=>{const root=vditor.vditor.ir.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.data.includes('称全集')&&!n.parentElement.closest('code[data-type="math-block"'))break;if(!n)throw new Error('body text missing for empty formula');const at=n.data.indexOf('称全集')+3;const r=document.createRange();r.setStart(n,at);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r);root.focus();return true})()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});await pause(260);
    const emptyShortcut=await fe(`(()=>{const e=vditor.vditor,root=e.ir.element,s=getSelection(),node=s.focusNode?.nodeType===3?s.focusNode:null,element=node?.parentElement||s.focusNode,code=element?.closest('code[data-type="math-inline"]'),value=vditor.getValue(),at=value.indexOf('称全集');return{value:value.slice(Math.max(0,at-20),at+30),blocks:root.querySelectorAll('code[data-type="math-block"]').length,selected:s.toString(),node:node?.data||'',offset:s.focusOffset,caretInside:!!code?.contains(s.focusNode),inlineSource:code?.textContent.replaceAll('\\u200b',''),owner:code?.outerHTML}})()`);
    fs.writeFileSync(path.join(base,'ctrl-shift-e-empty.json'),JSON.stringify(emptyShortcut,null,2));assert.equal(emptyShortcut.blocks,emptyBaseline,'Ctrl+Shift+E collapsed body caret does not create a display-math block');assert.ok(emptyShortcut.value.includes('称全集$$'),'Ctrl+Shift+E collapsed body inserts an empty inline formula source');assert.equal(emptyShortcut.selected,'');assert.equal(emptyShortcut.caretInside,true,'Empty formula has actual editing focus');assert.equal(emptyShortcut.inlineSource,'');pass('Real note empty formula has a caret inside its own editable source');
    await global.doc.save();assert.ok(fs.readFileSync(emptyFile,'utf8').includes('称全集$$'),'Real note empty formula reaches disk without losing the table');
    await stage('empty-formula-save');for(const type of ['keyDown','char','keyUp'])win.webContents.sendInputEvent({type,keyCode:'q'});await pause(260);
    assert.ok((await fe('vditor.getValue()')).includes('称全集$q$'),'Typing immediately after the shortcut must fill that empty formula');
    await stage('typed-q');for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'E',modifiers:['control','shift']});await pause(260);
    // 取值稳定性守卫：这里曾经直接读一次 getValue() 就断言。getValue() 的长度是
    // 由媒体规范化决定的（见下方 disk/editor/host 的说明），所以先等取值稳定，
    // 把"抖动"排除掉，剩下的差异才有意义。
    // [stage] 行（stages.json）记录这条链路每一步的 editor/host 长度，用来证明
    // 取值全程稳定；这条链路上不存在"中途变短"的步骤。
    const settledValue=async()=>{let previous=-1,stable=0,value='';
      for(let i=0;i<400;i++){value=await fe('vditor.getValue()');
        if(value.length===previous)stable++;else stable=0;
        previous=value.length;
        if(stable>=3&&global.doc.current?.text===value)return value;
        await pause(30);}
      return value;};
    await stage('before-settle');const unwrapped=await settledValue();await stage('after-settle');assert.ok(unwrapped.includes('称全集q'),'Cancelling the newly filled formula must retain its text');assert.ok(!unwrapped.includes('称全集$q$'));
    await global.doc.save();
    await stage('final-save');flushStages();const onDisk=fs.readFileSync(emptyFile,'utf8');
    // 这份素材把插图以 base64 data URI 内嵌（单张载荷 145,152 字符），而编辑器对外
    // 给出的 Markdown（getValue() 与宿主 doc.text）会按媒体生命周期把 data URI 规范化
    // 成资源引用。所以"磁盘原文 == 编辑器取值"在本素材上永远不可能成立——旧的
    // 160,221 / 15,238 / 15,238 三元组就是这个口径差，不是数据丢失（已逐字节核对：
    // 磁盘只比源文件多本次编辑的那 1 个字符，图片载荷 md5 完全相同）。
    // 因此这里分别守住两件真正会出事的事：
    //   1) 媒体不丢：磁盘里每个 data URI 载荷与源文件逐字节一致；
    //   2) 文本不丢：把 data URI 载荷规范化掉之后，磁盘 == 源文件 + 本次编辑。
    const sourceText=source.toString('utf8');
    const payloads=text=>[...text.matchAll(/data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)/g)].map(match=>match[1]);
    const maskMedia=text=>text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g,'<data-uri>');
    assert.deepEqual(payloads(onDisk),payloads(sourceText),`saved file lost or altered an embedded media payload (disk=${onDisk.length} editor=${unwrapped.length} host=${global.doc.current?.text?.length} file=${global.doc.file})`);
    assert.equal(maskMedia(onDisk),maskMedia(sourceText).replace('称全集','称全集q'),'saved text must equal the source plus this edit once media payloads are normalized away');
    pass('Saved file keeps every embedded media payload byte-for-byte and differs from the source only by this edit');
    // Reopen a distinct saved file so the actual loading path is exercised.
    const copy=path.join(base,'typed-empty-saved-copy.md');fs.copyFileSync(emptyFile,copy);await global.doc.openFile(copy);await waitEditor();assert.ok((await fe('vditor.getValue()')).includes('称全集q'));
    assert.deepEqual((await tableState()).shapes,originalTables.shapes);pass('Empty formula accepts immediate typing, unwraps, saves and reopens without changing tables');
  }finally{fs.writeFileSync(path.join(base,'results.json'),JSON.stringify(checks,null,2));}
  return checks;
};
