const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

// Real App-shell acceptance for the shared table/context-menu feature. This
// deliberately uses the iframe's production hostApi and Electron's native
// clipboard instead of the renderer test's navigator.clipboard stub.
exports.run=async({win,ev,until,output})=>{
  const checks=[],base=path.join(output,'table-context-host');fs.mkdirSync(base,{recursive:true});
  const pass=text=>{checks.push('PASS '+text);console.log(checks.at(-1));};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const file=path.join(base,`table-context-host-${Date.now()}.md`);
  const fixture='# 标题 $h+1$\n\n正文引用 [链接][ref] 与普通文字。\n\n| 项目 | 公式 | 代码 |\n| --- | --- | --- |\n| 普通 | $x+1$ | `const a=1` |\n| 引用 | [ref][ref] | `=1+1` |\n\n[ref]: https://example.org\n\n```js\nconst source = "代码";\n```\n\n末尾公式 $a^2+b^2$\n';
  fs.writeFileSync(file,fixture);
  const fe=code=>win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w||!w.vditor)throw new Error('editor frame not ready');return w.eval(${JSON.stringify(code)});})()`,true);
  const waitForEditor=async()=>{
    const version=global.doc.docVersion;
    const marker=global.doc.current?.text.split('\n').find(line=>line.trim())?.trim().slice(0,32)||'';
    try{await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{return !!w&&new URL(w.location.href).searchParams.get('v')==='${version}'&&!!w.vditor?.__media&&!!w.vditor?.__completion;}catch{return false;}})()`,20000);}
    catch(error){
      const state=await ev(`(()=>{const frame=document.getElementById('editor'),w=frame?.contentWindow;try{return{src:frame?.src,url:w?.location.href,media:!!w?.vditor?.__media,completion:!!w?.vditor?.__completion,value:w?.vditor?.getValue()}}catch(error){return{src:frame?.src,error:error.message}}})()`);
      fs.writeFileSync(path.join(base,'editor-ready-failure.json'),JSON.stringify({expectedVersion:version,actualVersion:global.doc.docVersion,file:global.doc.file,state},null,2));throw error;
    }
    for(let i=0;i<200;i++){
      try{if(!marker||String(await fe('vditor.getValue()')).includes(marker))return;}catch{}
      await pause(30);
    }
    let observed={};try{observed=await fe('({url:location.href,value:vditor.getValue(),patched:!!vditor.vditor.__media,completion:!!vditor.vditor.__completion})');}catch(error){observed={error:error.message};}
    throw new Error('editor did not receive host fixture '+JSON.stringify({version,docText:global.doc.current?.text,docVersion:global.doc.docVersion,observed}));
  };
  const waitValue=async(predicate,message)=>{for(let i=0;i<200;i++){if(await fe(`(${predicate})`))return;await pause(30);}throw new Error(message);};
  const openMenu=async(target)=>fe(`(()=>{const target=${target};if(!target)throw new Error('context target missing');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:80,clientY:80});target.dispatchEvent(event);const menu=document.getElementById('typora-editor-context-menu'),style=getComputedStyle(menu);return{prevented:event.defaultPrevented,labels:[...menu.querySelectorAll('button')].map(button=>button.textContent),style:{background:style.backgroundColor,opacity:style.opacity,backdrop:style.backdropFilter}}})()`);
  const closeMenu=()=>fe("document.getElementById('typora-editor-context-menu')?.__typoraClose?.();true");
  const nativeClipboard=require('electron').clipboard,restoreClipboard=await require('./test-clipboard.cjs').preserveClipboard();
  const waitClipboard=async expected=>{for(let i=0;i<100;i++){if(await nativeClipboard.readText()===expected)return;await pause(20);}const actual=await nativeClipboard.readText();throw new Error(`native clipboard mismatch: ${JSON.stringify({expected,actual:actual??null,type:typeof actual})}`);};
  const selectProse=()=>fe(`(()=>{const root=vditor.vditor.ir.element,p=root.querySelector('p'),node=[...p.childNodes].find(item=>item.nodeType===3);if(!node)throw new Error('ordinary prose text missing');const range=document.createRange();range.setStart(node,0);range.setEnd(node,2);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);root.focus();return selection.toString()})()`);
  const clickAction=(target,action)=>fe(`(()=>{const node=${target};const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:80,clientY:80});node.dispatchEvent(event);const button=document.querySelector('#typora-editor-context-menu [data-action="${action}"]');if(!button)throw new Error('missing context action ${action}');button.click();return true})()`);
  try{
    await global.doc.openFile(file);await waitForEditor();
    const menuTargets=['vditor.vditor.ir.element.querySelector(\'h1\')','vditor.vditor.ir.element.querySelector(\'p\')','vditor.vditor.ir.element.querySelector(\'pre\')','vditor.vditor.ir.element.querySelector(\'.language-math\')','vditor.vditor.ir.element.querySelector(\'td\')'];
    for(const [index,target] of menuTargets.entries()){
      const info=await openMenu(target);assert.equal(info.prevented,true);if(index===0){
        // v2.0.3 视觉规格（用户指令）：菜单表面不透明度跟随全局设置
        // （默认 66%，--typora-surface-opacity），文字保持全不透明；
        // 不再使用 backdrop-filter（iframe 内随重排移动会留像素残迹）。
        assert.equal(info.style.opacity,'1','context menu keeps text at full opacity');
        const alpha=/rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,\/]+([\d.]+)\s*\)/.exec(info.style.background);
        assert.ok(alpha&&+alpha[1]>=0.64&&+alpha[1]<=0.68,'context menu surface is 66% translucent by default: '+info.style.background);
        assert.ok(!/blur/.test(info.style.backdrop),'context menu must not use backdrop-filter (residue bug)');
        const shot=await win.webContents.capturePage();fs.writeFileSync(path.join(base,'context-menu.png'),shot.toPNG());}for(const label of ['复制','复制 plain text','粘贴','剪切'])assert.ok(info.labels.includes(label),`missing ${label}`);await closeMenu();
    }
    pass('Production App menu exposes copy, plain text copy, paste and cut on title, prose, code, formula and table cells');

    await selectProse();await clickAction("vditor.vditor.ir.element.querySelector('p')",'copy');await waitClipboard('正文');
    pass('Production App rich copy writes selected ordinary text to the native clipboard');

    await selectProse();await clickAction("vditor.vditor.ir.element.querySelector('p')",'copy-plain');await waitClipboard('正文');
    pass('Production App plain copy uses the main-process clipboard bridge');

    const tableInfo=await openMenu("vditor.vditor.ir.element.querySelector('td')");
    for(const action of ['table-row-above','table-row-below','table-col-left','table-col-right','table-delete-row','table-delete-col'])assert.ok(infoHas(tableInfo.labels,action),`table context menu contains ${action}`);
    await closeMenu();
    function infoHas(labels,action){
      const names={'table-row-above':'上方插入行','table-row-below':'下方插入行','table-col-left':'左侧插入列','table-col-right':'右侧插入列','table-delete-row':'删除当前行','table-delete-col':'删除当前列'};
      return labels.includes(names[action]);
    }
    pass('Production App table menu exposes four insert and two delete actions');

    const before=await fe('vditor.getValue()');
    await clickAction("vditor.vditor.ir.element.querySelector('table').rows[1].cells[1]",'table-row-below');
    await waitValue("vditor.vditor.ir.element.querySelectorAll('table tr').length===4",'host row insertion did not update the live table');
    const after=await fe('vditor.getValue()');assert.ok(after.includes('$x+1$')&&after.includes('const a=1')&&after.includes('[ref]')&&after.includes('[ref]: https://example.org'));
    pass('Production App row insertion preserves formula, code, reference and source text');
    await fe('vditor.vditor.undo.undo(vditor.vditor);true');await waitValue(`vditor.getValue()===${JSON.stringify(before)}`,'host table undo did not restore the source');
    await fe('vditor.vditor.undo.redo(vditor.vditor);true');await waitValue(`vditor.getValue()===${JSON.stringify(after)}`,'host table redo did not restore the edit');
    pass('Production App table edit is one undo step and redoable');

    await fe(`(()=>{const cell=vditor.vditor.ir.element.querySelector('table').rows[1].cells[1],event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',ctrlKey:true,bubbles:true,cancelable:true});cell.dispatchEvent(event);return event.defaultPrevented})()`);
    await waitValue("vditor.vditor.ir.element.querySelectorAll('table tr').length===5",'host Ctrl+Enter did not insert a row below');
    await fe(`(()=>{const cell=vditor.vditor.ir.element.querySelector('table').rows[1].cells[1],event=new KeyboardEvent('keydown',{key:'Backspace',code:'Backspace',ctrlKey:true,bubbles:true,cancelable:true});cell.dispatchEvent(event);return event.defaultPrevented})()`);
    await waitValue("vditor.vditor.ir.element.querySelectorAll('table tr').length===4",'host Ctrl+Backspace did not delete the current row');
    pass('Production App Ctrl+Enter and Ctrl+Backspace operate on the current table row');

    const formulaText=await fe(`(()=>{const formula=vditor.vditor.ir.element.querySelector('.language-math'),range=document.createRange();range.selectNodeContents(formula);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return formula.getAttribute('data-math')||formula.textContent})()`);
    await clickAction("vditor.vditor.ir.element.querySelector('.language-math')",'copy-plain');await waitClipboard(formulaText);
    pass('Production App plain copy resolves a non-editable formula preview to its LaTeX source');

    await nativeClipboard.writeText('宿主粘贴内容');await selectProse();await clickAction("vditor.vditor.ir.element.querySelector('p')",'paste');await waitValue("vditor.getValue().includes('宿主粘贴内容')",'host paste did not read the native clipboard');await pause(400);
    pass('Production App paste reads native clipboard text through the host bridge');

    const cutBefore=await fe('vditor.getValue()');await selectProse();await clickAction("vditor.vditor.ir.element.querySelector('p')",'cut');await waitValue("!vditor.getValue().includes('正文引用')",'host cut did not edit the source');await pause(400);await fe('vditor.vditor.undo.undo(vditor.vditor);true');const cutAfterUndo=await fe('vditor.getValue()');if(cutAfterUndo!==cutBefore){const history=await fe('({mode:vditor.vditor.currentMode,undo:vditor.vditor.undo[vditor.vditor.currentMode]?.undoStack?.length,redo:vditor.vditor.undo[vditor.vditor.currentMode]?.redoStack?.length})');throw new Error('host cut undo did not restore the source '+JSON.stringify({before:cutBefore,after:cutAfterUndo,history}));}
    pass('Production App cut is undoable');

    assert.equal(await global.doc.save(),true);const disk=fs.readFileSync(file,'utf8');assert.ok(disk.includes('$h+1$')&&disk.includes('```js')&&!disk.includes('vscode-cdn.net'));pass('Production App saves the accepted table/context workflow without internal URLs');
  }finally{
    await restoreClipboard();
  }
  fs.writeFileSync(path.join(base,'results.json'),JSON.stringify(checks,null,2));return checks;
};
