const delay=(ms=280)=>new Promise(resolve=>setTimeout(resolve,ms));

export async function runTableContext(){
  const api=window.vditor,e=api.vditor,results=[];
  const check=(value,label)=>{if(!value)throw new Error(label+'\n'+api.getValue());results.push('PASS '+label);};
  const root=()=>e[e.currentMode].element;
  const load=async(md)=>{api.setValue(md,true);await delay();api.clearStack();};
  const fixture='# 标题 $h+1$\n\n正文引用 [链接][ref] 与普通文字。\n\n| 项目 | 公式 | 代码 |\n| --- | --- | --- |\n| 普通 | $x+1$ | `const a=1` |\n| 引用 | [ref][ref] | `=1+1` |\n\n[ref]: https://example.org\n\n```js\nconst source = "代码";\n```\n\n末尾公式 $a^2+b^2$\n';
  const clickContext=target=>{
    const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:80});
    target.dispatchEvent(event);return event;
  };
  const menu=()=>document.getElementById('typora-editor-context-menu');
  const buttons=()=>[...menu().querySelectorAll('button')];
  const open=target=>{const event=clickContext(target);check(event.defaultPrevented,'context menu prevents the native menu');check(!!menu(),'context menu is visible');return menu();};
  const close=()=>{menu()?.__typoraClose?.();menu()?.remove();};
  const general=['复制','复制 plain text','粘贴','剪切'];
  const assertGeneral=label=>check(general.every(text=>buttons().some(button=>button.textContent===text)),label+' exposes copy/plain/paste/cut');
  const tableTarget=()=>root().querySelector('table');
  const tableCell=(row=1,col=1)=>tableTarget()?.rows[row]?.cells[col];
  const applyTable=(target,action)=>{open(target);const button=menu().querySelector(`[data-action="${action}"]`);check(!!button,'table menu exposes '+action);button.click();return delay();};
  const key=(target,key,options={})=>{const event=new KeyboardEvent('keydown',{key,code:key==='Enter'?'Enter':key==='Backspace'?'Backspace':'Key'+key.toUpperCase(),ctrlKey:true,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;};
  const selectText=(node,start,end)=>{
    let text=node.nodeType===Node.TEXT_NODE?node:null;
    if(!text){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);text=walker.nextNode();}
    if(!text)throw new Error('No selectable text');
    const selection=getSelection(),range=document.createRange(),finish=Math.min(end,text.length);range.setStart(text,Math.min(start,finish));range.setEnd(text,finish);selection.removeAllRanges();selection.addRange(range);return range;
  };

  const writes=[];let clipboardText='';
  try{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{clipboardText=String(text);writes.push(clipboardText);},readText:async()=>clipboardText}});}catch{ /* native clipboard is exercised by desktop tests */ }

  for(const mode of ['ir','wysiwyg']){
    e.toolbar.elements['edit-mode'].querySelector(`button[data-mode="${mode}"]`).click();
    await load(fixture);
    const editorRoot=root(),table=tableTarget();
    check(!!table&&table.rows.length===3,' '+mode+' fixture renders a three-row table');
    check(!!editorRoot.querySelector('h1')&&!!editorRoot.querySelector('pre')&&!!editorRoot.querySelector('.language-math'),mode+' renders title, code and formula alongside table');

    for(const target of [editorRoot.querySelector('h1'),editorRoot.querySelector('p'),editorRoot.querySelector('pre'),editorRoot.querySelector('.language-math'),tableCell()]){
      open(target);assertGeneral(mode+' '+(target.tagName||target.className));close();
    }
    open(tableCell());
    check(['table-row-above','table-row-below','table-col-left','table-col-right','table-delete-row','table-delete-col'].every(action=>menu().querySelector(`[data-action="${action}"]`)),mode+' table menu exposes four insert and two delete actions');
    check(!!menu().querySelector('[data-action="copy-table"]'),' '+mode+' table menu keeps Excel copy');
    close();

    const before=api.getValue();
    await applyTable(tableCell(1,1),'table-row-below');
    check(tableTarget().rows.length===4,mode+' adds a row below the clicked row');
    const afterBelow=api.getValue();check(afterBelow.includes('$x+1$')&&afterBelow.includes('const a=1')&&afterBelow.includes('[ref]')&&afterBelow.includes('[ref]:'),mode+' row insert preserves formula, code and reference source');
    e.undo.undo(e);await delay();check(api.getValue()===before,mode+' table row insert is one undo step');
    e.undo.redo(e);await delay();check(api.getValue()===afterBelow,mode+' table row insert is redoable');

    await applyTable(tableCell(1,1),'table-row-above');check(tableTarget().rows.length===5,mode+' adds a row above the clicked row');
    await applyTable(tableCell(1,1),'table-col-left');check(tableTarget().rows[0].cells.length===4,mode+' adds a column on the left');
    await applyTable(tableCell(1,1),'table-col-right');check(tableTarget().rows[0].cells.length===5,mode+' adds a column on the right');
    const rowsBeforeDelete=tableTarget().rows.length;await applyTable(tableCell(1,1),'table-delete-row');check(tableTarget().rows.length===rowsBeforeDelete-1,mode+' deletes the clicked row');
    const colsBeforeDelete=tableTarget().rows[0].cells.length;await applyTable(tableCell(1,1),'table-delete-col');check(tableTarget().rows[0].cells.length===colsBeforeDelete-1,mode+' deletes the clicked column');
    const edited=api.getValue();check(edited.includes('# 标题')&&edited.includes('$h+1$')&&edited.includes('```js')&&edited.includes('$a^2+b^2$'),mode+' structural edits preserve title, code block and trailing formula');

    await load(fixture);const shortcutRowCount=tableTarget().rows.length;
    const shortcutCell=tableCell(1,1);let event=key(shortcutCell,'Enter');await delay();check(event.defaultPrevented&&tableTarget().rows.length===shortcutRowCount+1,mode+' Ctrl+Enter inserts a row below');
    event=key(tableCell(1,1),'Backspace');await delay();check(event.defaultPrevented&&tableTarget().rows.length===shortcutRowCount,mode+' Ctrl+Backspace deletes the current row');

    await load(fixture);const prose=editorRoot.querySelector('p');const proseText=prose.firstChild;selectText(proseText,0,2);open(prose);await menu().querySelector('[data-action="copy-plain"]').click();await delay();check(writes.at(-1)==='正文',mode+' copy plain writes selected prose only');
    await load(fixture);
    let formula;
    const formulaDeadline=Date.now()+10000;
    while(Date.now()<formulaDeadline){
      const sourceMath=[...editorRoot.querySelectorAll('code[data-type="math-inline"]')].find(node=>node.textContent.includes('x+1'));
      formula=sourceMath?.nextElementSibling?.querySelector('.language-math');
      if(formula?.textContent?.replace(/\u200b/g,'').length)break;
      await delay(50);
    }
    check(!!formula&&formula.textContent.replace(/\u200b/g,'').length>0,mode+' formula preview has selectable text');
    const formulaRange=document.createRange();formulaRange.selectNodeContents(formula);getSelection().removeAllRanges();getSelection().addRange(formulaRange);
    const formulaSelected=formula.getAttribute('data-math')||getSelection().toString().replace(/\u200b/g,'')||formula.textContent.replace(/\u200b/g,'');check(formulaSelected.length>0,mode+' formula preview selection is non-empty');event=key(formula,'v',{altKey:true,shiftKey:false});await delay();check(event.defaultPrevented&&writes.at(-1)===formulaSelected,mode+' Ctrl+Alt+V copies formula preview as plain text');
    await load(fixture);const cutBaseline=api.getValue(),cutText=editorRoot.querySelector('p').firstChild;selectText(cutText,0,2);open(editorRoot.querySelector('p'));menu().querySelector('[data-action="cut"]').click();await delay();check(!api.getValue().includes('正文引用'),mode+' context cut edits the document');e.undo.undo(e);await delay();check(api.getValue()===cutBaseline,mode+' context cut is undoable');
    await load(fixture);const pasteText=editorRoot.querySelector('p').firstChild;selectText(pasteText,0,0);clipboardText='粘贴内容';open(editorRoot.querySelector('p'));menu().querySelector('[data-action="paste"]').click();await delay();check(api.getValue().includes('粘贴内容'),mode+' context paste inserts clipboard text');
  }

  e.toolbar.elements['edit-mode'].querySelector('button[data-mode="sv"]').click();await load(fixture);
  const source=e.sv.element;open(source);assertGeneral('sv source');close();
  source.focus();const sourceWalker=document.createTreeWalker(source,NodeFilter.SHOW_TEXT);let candidate;while((candidate=sourceWalker.nextNode())&&!candidate.data.includes('标题')){/* find the source text node */}if(!candidate)throw new Error('SV source text not found');const sourceAt=candidate.data.indexOf('标题');selectText(candidate,sourceAt,sourceAt+2);const sourceSelected=getSelection().toString();check(sourceSelected==='标题','sv source selection is available');const sourceEvent=key(source,'v',{altKey:true});await delay();check(sourceEvent.defaultPrevented&&writes.at(-1)===sourceSelected, 'sv Ctrl+Alt+V copies selected source text as plain text');
  return results;
}
