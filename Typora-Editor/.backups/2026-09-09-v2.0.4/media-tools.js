import {sourceText,selectRange} from './source-text.js';
import {preserveIR} from './preserve-render.js';
import {cloneSource} from './incremental-ir.js';
import {scheduleSurfaceCleanup} from './surface.js';
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let sequence=0;const pending=new Map();
// Save dialogs stay open while the user browses folders; only quick
// clipboard operations keep the short timeout.
const DIALOG_TIMEOUT_ACTIONS=new Set(['save-image']);
export function mediaRequest(action,payload={}){
  const id='media-'+(++sequence);return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('操作超时，请重试'));},DIALOG_TIMEOUT_ACTIONS.has(action)?600000:30000);
    pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});
    window.handler.emit('media-command',{id,action,...payload});
  });
}
function sourceBounds(index,node){
  let start=Infinity,end=-1;
  for(const span of index.spans)if(node.contains(span.node)){start=Math.min(start,span.start);end=Math.max(end,span.end);}
  return end>=start?{start,end}:null;
}
function directImageRange(api,img,root){
  // WYSIWYG table cells render Markdown images directly as <td><img>; there
  // is no hidden source-code sibling for sourceText() to index. Replace only
  // this image with a collision-checked sentinel in a cloned document and
  // align the resulting Markdown gap back to the live source.
  const table=img.closest('table'),container=table||root;
  const images=[...container.querySelectorAll('img')],imageIndex=images.indexOf(img);
  const copy=cloneSource(root,true),copyContainer=table
    ? [...copy.querySelectorAll('table')][[...root.querySelectorAll('table')].indexOf(table)] : copy;
  const target=copyContainer&&[...copyContainer.querySelectorAll('img')][imageIndex];
  if(!target)return null;
  const source=api.getValue(),prefixBase='typora-image-gap-',markerBase=prefixBase+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let marker=markerBase;while(source.includes(marker)||copy.textContent.includes(marker))marker+='x';
  target.replaceWith(document.createTextNode(marker));
  const converter=api.vditor.currentMode==='ir'?'VditorIRDOM2Md':'VditorDOM2Md';
  const masked=api.vditor.lute[converter](copy.innerHTML),at=masked.indexOf(marker);
  if(at<0)return null;
  const prefix=masked.slice(0,at),suffix=masked.slice(at+marker.length);
  const findGap=()=>{
    const left=suffix?prefix.slice(-Math.min(256,prefix.length)):prefix;
    const right=suffix.slice(0,256);
    for(let length=left.length;length>=8;length=Math.floor(length*.72)){
      const needle=left.slice(-length);let cursor=0,index;
      while((index=source.indexOf(needle,cursor))>=0){
        const start=index+needle.length,end=right?source.indexOf(right,start):source.length;
        if(end>=start&&/!\[|<img\b/i.test(source.slice(start,end)))return{source,start,end,direct:true};
        cursor=index+1;
      }
    }
    return null;
  };
  const exactStart=source.indexOf(prefix),exactEnd=suffix?source.indexOf(suffix,exactStart<0?0:exactStart+prefix.length):source.length;
  if(exactStart>=0&&exactEnd>=exactStart+prefix.length)return{source,start:exactStart+prefix.length,end:exactEnd,direct:true};
  // Lute may reflow the rest of a table row while it serializes the
  // sentinel. The unchanged prefix still gives us the exact target region;
  // find the first image token after it and parse its balanced closing mark.
  if(exactStart>=0){
    const from=exactStart+prefix.length,tail=source.slice(from),hit=tail.search(/!\[|<img\b/i);
    if(hit>=0){
      const start=from+hit;
      if(source.slice(start).startsWith('<img')){
        let quote='';for(let i=start;i<source.length;i++){const char=source[i];if(quote){if(char===quote&&source[i-1]!=='\\')quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='>')return{source,start,end:i+1,direct:true};}
      }else{
        const open=source.indexOf('](',start+2);if(open>=0){let depth=1,quote='';for(let i=open+2;i<source.length;i++){const char=source[i];if(char==='\\'){i++;continue;}if(quote){if(char===quote)quote='';continue;}if(char==='"'||char==="'"){quote=char;continue;}if(char==='(')depth++;else if(char===')'&&!--depth)return{source,start,end:i+1,direct:true};}}
      }
    }
  }
  return findGap();
}
function imageRange(api,img){
  const e=api.vditor,root=e[e.currentMode].element,index=sourceText(root);
  const marker=img.closest('[data-type="img"]');
  if(marker&&root.contains(marker)){
    const bounds=sourceBounds(index,marker);
    if(bounds)return{index,...bounds};
  }
  const preview=img.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'),code=preview?.previousElementSibling;
  if(code){
    const bounds=sourceBounds(index,code),imageIndex=[...preview.querySelectorAll('img')].indexOf(img);
    if(bounds){
      const source=index.text.slice(bounds.start,bounds.end),match=[...source.matchAll(/<img\b[^>]*>/gi)][imageIndex];
      if(match)return{index,start:bounds.start+match.index,end:bounds.start+match.index+match[0].length};
    }
  }
  const direct=directImageRange(api,img,root);
  if(direct)return direct;
  throw new Error('请在编辑区选择图片后重试');
}
function replaceImageSource(api,selection,replacement){
  if(selection.direct)return selection.source.slice(0,selection.start)+replacement+selection.source.slice(selection.end);
  const e=api.vditor,root=e[e.currentMode].element,copy=cloneSource(root,true),cloned=sourceText(copy);
  if(cloned.text!==selection.index.text)throw new Error('图片源位置已变化，请关闭对话框后重试');
  const range=cloned.range(selection.start,selection.end);range.deleteContents();range.insertNode(document.createTextNode(replacement));
  if(e.currentMode==='sv')return copy.textContent;
  const converter=e.currentMode==='ir'?'VditorIRDOM2Md':'VditorDOM2Md';
  return e.lute[converter](copy.innerHTML);
}
export function setImageScale(api,img,percent){
  const value=Number(percent);if(!Number.isFinite(value)||value<5||value>400)throw new Error('请输入 5～400 的缩放百分比');
  if(!img.isConnected||!img.naturalWidth)throw new Error('图片尚未加载完成');
  const e=api.vditor,root=e[e.currentMode].element,selection=imageRange(api,img);
  const alt=img.getAttribute('alt')||'',title=img.getAttribute('title');
  const titleAttribute=title===null?'':` title="${escape(title)}"`;
  const html=`<img src="${escape(img.getAttribute('src'))}" alt="${escape(alt)}"${titleAttribute} width="${Math.max(1,Math.round(img.naturalWidth*value/100))}" data-typora-scale="${value}" />`;
  const selected=selection.direct?selection.source.slice(selection.start,selection.end):selection.index.text.slice(selection.start,selection.end);
  if(selected===html){if(!selection.direct)selectRange(root,selection.index.range(selection.start,selection.end));return html;}
  const md=replaceImageSource(api,selection,html),scroll=root.scrollTop;
  e.undo.addToUndoStack(e);preserveIR(api,()=>api.setValue(md));
  const next=sourceText(root),position=next.text.indexOf(html,Math.max(0,selection.start-1));
  if(position>=0)selectRange(root,next.range(position+html.length,position+html.length));else root.focus({preventScroll:true});
  root.scrollTop=scroll;e.options.input?.(api.getValue());e.undo.addToUndoStack(e);
  return html;
}
function imageDialog(api,img){
  document.getElementById('typora-image-settings')?.remove();const dialog=document.createElement('dialog');dialog.id='typora-image-settings';dialog.className='typora-media-dialog';
  dialog.innerHTML='<form><h3>图片</h3><label>缩放 <input name="scale" type="number" min="5" max="400" step="1" required> %</label><p>100% 为原始尺寸；缩放只改变显示，不压缩原图。</p><div class="media-presets"></div><p class="media-error" role="status"></p><div class="media-actions"><button type="button" data-action="copy-image">复制原图</button><button type="button" data-action="save-image">导出原图…</button><button type="button" data-close>关闭</button><button type="submit">应用</button></div></form>';
  const input=dialog.querySelector('input');input.value=img.getAttribute('data-typora-scale')||Math.round((Number(img.getAttribute('width'))||img.naturalWidth)/img.naturalWidth*100)||100;
  for(const percent of [25,50,75,100,150]){const button=document.createElement('button');button.type='button';button.textContent=percent+'%';button.onclick=()=>{input.value=percent;};dialog.querySelector('.media-presets').append(button);}
  dialog.querySelector('form').onsubmit=event=>{event.preventDefault();try{setImageScale(api,img,input.value);dialog.close();}catch(error){dialog.querySelector('.media-error').textContent=error.message;}};
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  for(const button of dialog.querySelectorAll('[data-action]'))button.onclick=async()=>{button.disabled=true;try{const result=await mediaRequest(button.dataset.action,{src:img.getAttribute('src'),name:img.alt||'图片'});dialog.querySelector('.media-error').textContent=button.dataset.action==='copy-image'?'已复制，可粘贴到 Word、Excel 或 PowerPoint。':result.cancelled?'已取消':'已导出原图。';}catch(error){dialog.querySelector('.media-error').textContent=error.message;}finally{button.disabled=false;}};
  document.body.append(dialog);dialog.showModal();input.focus();input.select();dialog.addEventListener('close',()=>dialog.remove(),{once:true});
}
function cleanTableCopy(copy){
  // Convert formula source widgets to readable source first: in IR their code
  // element carries the marker class and would otherwise be swept below,
  // silently dropping every formula from the copied payload.
  for(const code of copy.querySelectorAll('code[data-type="math-inline"],code[data-type="math-block"]')){
    code.textContent='$'+code.textContent.replace(/\u200b/g,'')+'$';
    code.classList.remove('vditor-ir__marker');
  }
  copy.querySelectorAll('.vditor-ir__marker,.vditor-ir__preview,.vditor-wysiwyg__preview,.katex-html,wbr,script,style').forEach(n=>n.remove());
  for(const node of copy.querySelectorAll('*'))for(const attr of [...node.attributes])if(!['rowspan','colspan','href','src','alt','width','height'].includes(attr.name))node.removeAttribute(attr.name);
  for(const cell of copy.querySelectorAll('td,th'))cell.setAttribute('style','mso-number-format:"\\@";white-space:pre-wrap;border:1px solid #d9d9d9;padding:4px');
  return copy;
}
function tablePayload(table){
  const copy=cleanTableCopy(table.cloneNode(true));
  return{html:copy.outerHTML,text:[...copy.rows].map(row=>[...row.cells].map(cell=>cell.textContent.replace(/\u200b/g,'').replace(/[\t\r\n]+/g,' ')).join('\t')).join('\r\n')};
}
// One copied row keeps its cell boundaries: the pasted row is filled cell by
// cell instead of collapsing the whole row into the first target cell.
function rowPayload(row){
  const copy=cleanTableCopy(row.cloneNode(true));
  const wrap=document.createElement('table');wrap.append(copy);
  return{html:wrap.outerHTML,text:[...copy.cells].map(cell=>cell.textContent.replace(/\u200b/g,'').replace(/[\t\r\n]+/g,' ')).join('\t')};
}

const CONTEXT_MENU_ID='typora-editor-context-menu';
const TABLE_ACTIONS=[
  ['table-row-above','上方插入行'],['table-row-below','下方插入行'],
  ['table-col-left','左侧插入列'],['table-col-right','右侧插入列'],
  ['table-delete-row','删除当前行'],['table-delete-col','删除当前列'],
];
const GENERAL_ACTIONS=[
  ['copy','复制'],['copy-plain','复制 plain text'],['paste','粘贴'],['cut','剪切'],
];
const elementAt=node=>node?.nodeType===Node.TEXT_NODE?node.parentElement:node;

function savedSelection(){
  const selection=getSelection();
  return selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;
}
function restoreSelection(range,api){
  if(!range?.startContainer?.isConnected||!range.endContainer?.isConnected)return false;
  editorRoot(api)?.focus({preventScroll:true});
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return true;
}
function editorRoot(api){
  const e=api.vditor;return e?.[e.currentMode]?.element||null;
}
function beginDocumentEdit(api){
  const e=api.vditor;
  if(e.currentMode==='ir')e.__typoraFlushIR?.();
  else if(e.currentMode==='wysiwyg')clearTimeout(e.wysiwyg.processTimeoutId);
  e.undo.addToUndoStack(e);return api.getValue();
}
function finishDocumentEdit(api,before){
  const e=api.vditor,after=api.getValue();
  if(after===before)return false;
  e.options.input?.(after);e.undo.addToUndoStack(e);return true;
}
function selectionPlainText(api){
  const source=api?.vditor?.sv?.element;
  if(api?.vditor?.currentMode==='sv'&&typeof source?.selectionStart==='number'){
    return source.value.slice(source.selectionStart,source.selectionEnd).replace(/\u200b/g,'');
  }
  const selection=getSelection();
  if(!selection?.rangeCount||selection.isCollapsed)return '';
  const range=selection.getRangeAt(0);
  const formula=elementAt(selection.anchorNode)?.closest?.('.language-math'),formulaEnd=elementAt(selection.focusNode)?.closest?.('.language-math');
  if(formula&&formula===formulaEnd&&range.intersectsNode(formula)){
    const source=formula.getAttribute('data-math');
    if(source!==null)return source.replace(/\u200b/g,'');
  }
  const selected=selection.toString().replace(/\u200b/g,''),rangeText=range.toString().replace(/\u200b/g,'');
  const table=elementAt(selection.anchorNode)?.closest?.('table');
  if(table&&table.contains(selection.focusNode)&&range.intersectsNode(table)){
    const visible=(selected||rangeText).replace(/\s/g,'');
    if(visible===table.innerText.replace(/\s/g,''))return tablePayload(table).text;
  }
  return selected||rangeText;
}

export async function copyPlainText(api,text=selectionPlainText(api)){
  const value=String(text??'').replace(/\u200b/g,'');
  if(window.hostApi?.invoke){
    try{await window.hostApi.invoke('clipboard-write-text',{text:value});return true;}catch{/* use the webview clipboard below */}
  }
  if(navigator.clipboard?.writeText){
    try{await navigator.clipboard.writeText(value);return true;}catch{/* fall through to execCommand */}
  }
  const previous=savedSelection(),textarea=document.createElement('textarea');
  textarea.value=value;textarea.setAttribute('readonly','');textarea.style.cssText='position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
  document.body.append(textarea);textarea.select();
  let ok=false;try{ok=document.execCommand('copy');}catch{/* clipboard may be unavailable */}finally{textarea.remove();restoreSelection(previous,api);}
  if(!ok)throw new Error('无法写入系统剪贴板，请重试');
  return true;
}
function cutSelection(api){
  let ok=false;try{ok=document.execCommand('cut');}catch{/* use the editor event path below */}
  if(ok)return true;
  const root=editorRoot(api),selection=getSelection();
  if(!root||!selection?.rangeCount||selection.isCollapsed||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return false;
  let clipboardData=null;try{clipboardData=new DataTransfer();}catch{/* older webviews may omit DataTransfer */}
  try{
    const event=new ClipboardEvent('cut',{clipboardData,bubbles:true,cancelable:true});root.dispatchEvent(event);return event.defaultPrevented||true;
  }catch{return false;}
}
function cutDocumentSelection(api){
  const before=beginDocumentEdit(api),changed=cutSelection(api);
  return changed&&finishDocumentEdit(api,before);
}

function tableContext(api,event,table){
  const root=editorRoot(api);if(!root||!table||!root.contains(table))return null;
  const row=elementAt(event?.target)?.closest?.('tr')||elementAt(getSelection()?.anchorNode)?.closest?.('tr');
  const cell=elementAt(event?.target)?.closest?.('td,th')||elementAt(getSelection()?.anchorNode)?.closest?.('td,th');
  const rows=[...table.rows],rowIndex=Math.max(0,row?rows.indexOf(row):0);
  const actualRow=rows[rowIndex],cells=actualRow?[...actualRow.cells]:[];
  const colIndex=Math.max(0,cell&&cell.parentElement===actualRow?cells.indexOf(cell):0);
  return{root,tableIndex:[...root.querySelectorAll('table')].indexOf(table),rowIndex,colIndex};
}
function blankCell(document,row,reference){
  const tag=reference?.tagName==='TH'||row?.parentElement?.tagName==='THEAD'?'th':'td';
  return document.createElement(tag);
}
function makeBlankRow(document,reference,count){
  const row=document.createElement('tr');
  for(let i=0;i<count;i++)row.append(blankCell(document,row,reference?.cells?.[i]));
  return row;
}
function changeTableElement(table,context,action){
  if(!table)throw new Error('表格源位置已变化，请关闭菜单后重试');
  const rows=[...table.rows],row=rows[context.rowIndex]||rows[0];
  if(!row)throw new Error('当前表格没有可编辑的行');
  const document=table.ownerDocument;
  if(action==='table-row-above'||action==='table-row-below'){
    const count=Math.max(1,...rows.map(item=>item.cells.length));
    const next=makeBlankRow(document,row,count),parent=row.parentElement;
    if(action==='table-row-above')parent.insertBefore(next,row);else parent.insertBefore(next,row.nextSibling);
    return true;
  }
  if(action==='table-delete-row'){
    if(rows.length<=1)throw new Error('表格至少保留一行');
    row.remove();return true;
  }
  if(action==='table-col-left'||action==='table-col-right'){
    const insertOffset=action==='table-col-right'?1:0;
    for(const item of rows){
      const itemCells=[...item.cells],at=Math.min(context.colIndex+insertOffset,itemCells.length);
      item.insertBefore(blankCell(document,item,itemCells[Math.min(context.colIndex,itemCells.length-1)]),itemCells[at]||null);
    }
    return true;
  }
  if(action==='table-delete-col'){
    const count=Math.max(1,...rows.map(item=>item.cells.length));
    if(count<=1)throw new Error('表格至少保留一列');
    for(const item of rows)item.cells[context.colIndex]?.remove();
    return true;
  }
  return false;
}
function focusTableCell(api,context){
  const root=editorRoot(api),table=root&&[...root.querySelectorAll('table')][context?.tableIndex];
  const row=table?.rows[context?.rowIndex]||table?.rows[0],cell=row?.cells[context?.colIndex]||row?.cells[0];
  if(!root||!cell){root?.focus({preventScroll:true});return false;}
  const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let text;
  while((text=walker.nextNode())&&text.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')){/* skip generated preview text */}
  const range=document.createRange();if(text){range.setStart(text,0);range.collapse(true);}else{range.selectNodeContents(cell);range.collapse(true);}selectRange(root,range);return true;
}
function tableEdit(api,context,action){
  const e=api.vditor,root=editorRoot(api);
  if(!context||!root||e.currentMode==='sv')throw new Error('请在可视化编辑模式的表格内操作');
  const liveTable=[...root.querySelectorAll('table')][context.tableIndex];if(!liveTable)throw new Error('表格源位置已变化，请关闭菜单后重试');
  // Structural changes happen on the live table. This keeps the unchanged
  // inline link/math/code nodes byte-for-byte intact, especially in WYSIWYG.
  focusTableCell(api,context);
  const before=beginDocumentEdit(api),scroll=root.scrollTop;
  const changed=changeTableElement(liveTable,context,action);if(!changed)return false;
  focusTableCell(api,context);if(!finishDocumentEdit(api,before))return false;
  root.scrollTop=scroll;return true;
}
function closeContextMenu(){
  const menu=document.getElementById(CONTEXT_MENU_ID);
  if(menu?.__typoraClose)menu.__typoraClose();else menu?.remove();
}
function contextToast(message){
  document.querySelector('.typora-context-toast')?.remove();
  const toast=document.createElement('div');toast.className='typora-context-toast';toast.textContent=message;document.body.append(toast);
  setTimeout(()=>toast.remove(),2200);
}
function addMenuButton(menu,[action,label],run){
  const button=document.createElement('button');button.type='button';button.dataset.action=action;button.textContent=label;button.setAttribute('role','menuitem');
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',()=>run(action));menu.append(button);return button;
}
function addSeparator(menu){const line=document.createElement('div');line.className='typora-context-separator';line.setAttribute('role','separator');menu.append(line);}
function showContextMenu(api,event,{table,img}={}){
  closeContextMenu();
  const saved=savedSelection(),context=table&&tableContext(api,event,table),menu=document.createElement('div');
  menu.id=CONTEXT_MENU_ID;menu.className='typora-editor-context-menu';menu.setAttribute('role','menu');menu.tabIndex=-1;
  // A picture can be a table cell's content. Keep both action groups in that
  // case; the old table-first branch silently hid image settings.
  if(img){
    addMenuButton(menu,['image-settings','图片设置…'],()=>{closeContextMenu();imageDialog(api,img);});
    addSeparator(menu);
  }
  if(table){
    const title=document.createElement('div');title.className='typora-context-title';title.textContent='表格';menu.append(title);
    for(const item of TABLE_ACTIONS)addMenuButton(menu,item,async action=>{
      closeContextMenu();try{tableEdit(api,context,action,saved);}catch(error){contextToast(error.message);}
    });
    addMenuButton(menu,['copy-table','复制表格到 Excel'],async()=>{
      closeContextMenu();try{await mediaRequest('copy-table',tablePayload(table));contextToast('已复制表格，可粘贴到 Excel。');}catch(error){contextToast(error.message);}
    });
    addSeparator(menu);
  }
  for(const item of GENERAL_ACTIONS)addMenuButton(menu,item,async action=>{
    closeContextMenu();restoreSelection(saved,api);
    try{
      if(action==='copy')document.execCommand('copy');
      else if(action==='copy-plain')await copyPlainText(api);
      else if(action==='cut')cutDocumentSelection(api);
      else if(action==='paste'){
        const before=beginDocumentEdit(api);let pasted=false;try{pasted=document.execCommand('paste');}catch{/* browser may deny execCommand paste */}
        if(!pasted&&window.hostApi?.invoke){
          const text=await window.hostApi.invoke('clipboard-read-text');
          restoreSelection(saved,api);if(typeof text==='string')document.execCommand('insertText',false,text);
        }else if(!pasted&&navigator.clipboard?.readText){
          const text=await navigator.clipboard.readText();restoreSelection(saved,api);document.execCommand('insertText',false,text);
        }
        finishDocumentEdit(api,before);
      }
    }catch(error){contextToast(error.message);}
  });
  document.body.append(menu);
  const margin=8,rect=menu.getBoundingClientRect();
  menu.style.left=Math.max(margin,Math.min(event.clientX,window.innerWidth-rect.width-margin))+'px';
  menu.style.top=Math.max(margin,Math.min(event.clientY,window.innerHeight-rect.height-margin))+'px';
  const outside=click=>{if(!menu.contains(click.target))closeContextMenu();};
  document.addEventListener('mousedown',outside,true);
  const cleanup=()=>document.removeEventListener('mousedown',outside,true);
  menu.__typoraClose=()=>{cleanup();menu.remove();scheduleSurfaceCleanup(300);};
  menu.focus({preventScroll:true});
}
function contextTableFromSelection(api){
  const root=editorRoot(api),selection=getSelection(),table=elementAt(selection?.anchorNode)?.closest?.('table');
  return table&&root?.contains(table)?table:null;
}

function clipboardTableRows(html){
  try{
    const template=document.createElement('template');template.innerHTML=html;
    return [...template.content.querySelectorAll('tr')]
      .map(row=>[...row.cells].map(cell=>cell.textContent.replace(/\u200b/g,'').replace(/[\t\r\n]+/g,' ').trim()))
      .filter(cells=>cells.length);
  }catch{return [];}
}
// Fill the caret's row from pasted row cells; extra pasted rows are inserted
// below as new rows of the same width. Cell text goes through a one-row GFM
// roundtrip so formulas ($...$) and inline markup render again.
function pasteRowsIntoRow(api,targetRow,rows){
  const e=api.vditor,before=beginDocumentEdit(api),method=e.currentMode==='ir'?'Md2VditorIRDOM':'Md2VditorDOM';
  const width=targetRow.cells.length;
  const buildRow=cells=>{
    const safe=cells.slice(0,width);
    while(safe.length<width)safe.push('');
    if(cells.length>width)safe[width-1]+=' '+cells.slice(width).join(' ');
    const markdown='| '+safe.map(text=>text.replace(/\|/g,'\\|').replace(/\r?\n/g,'<br />')).join(' | ')+' |\n'
      +'| '+safe.map(()=>'---').join(' | ')+' |\n';
    const template=document.createElement('template');template.innerHTML=e.lute[method](markdown);
    return [...template.content.querySelectorAll('tr')][0];
  };
  let lastCell=null;
  const fill=(rowEl,cells)=>{
    const built=buildRow(cells);
    for(let i=0;i<width&&i<rowEl.cells.length;i++){
      const target=rowEl.cells[i];target.textContent='';target.append(...built.cells[i].childNodes);
    }
    lastCell=rowEl.cells[Math.max(0,Math.min(width-1,cells.length-1))];
  };
  fill(targetRow,rows[0]);
  let previous=targetRow;
  for(const cells of rows.slice(1)){
    const fresh=document.createElement('tr');
    for(let i=0;i<width;i++)fresh.append(blankCell(document,fresh,targetRow.cells[i]));
    previous.parentElement.insertBefore(fresh,previous.nextSibling);
    fill(fresh,cells);
    previous=fresh;
  }
  finishDocumentEdit(api,before);
  editorRoot(api)?.focus({preventScroll:true});
  if(lastCell){const range=document.createRange();range.selectNodeContents(lastCell);range.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(range);}
}
function pasteCellText(api,event){
  const e=api.vditor,root=editorRoot(api),s=getSelection(),data=event.clipboardData;
  if(event.defaultPrevented||!['ir','wysiwyg'].includes(e.currentMode)||!data||event.isComposing||e[e.currentMode].composingLock||!s?.rangeCount)return;
  const cell=elementAt(s.anchorNode)?.closest('td,th');
  if(!cell||!root.contains(cell)||!cell.contains(s.focusNode)||elementAt(s.anchorNode)?.closest('code')||elementAt(s.focusNode)?.closest('code'))return;
  const html=data.getData('text/html');
  // A copied table row fills the caret's row cell by cell; Vditor's default
  // paste would flatten the row markup into one long cell string.
  if(html&&!data.files?.length){
    const rows=clipboardTableRows(html);
    if(rows.length){event.preventDefault();event.stopImmediatePropagation();pasteRowsIntoRow(api,cell.parentElement,rows);return;}
  }
  const text=data.getData('text/plain');
  // A one-cell plain-text selection is not a request to replace the grid.
  // Let structured HTML/image pastes and the math source handler keep their
  // existing paths; only protect text that can introduce GFM row delimiters.
  if(html||data.files?.length||!/[\r\n\t|]/.test(text))return;
  event.preventDefault();event.stopImmediatePropagation();
  const before=beginDocumentEdit(api),range=s.getRangeAt(0);
  const escaped=text.replace(/\\/g,'\\\\').replace(/([`*_{}\[\]()#+.!<>|$-])/g,'\\$1').replace(/\r\n?|\n/g,'<br />');
  const template=document.createElement('template'),method=e.currentMode==='ir'?'Md2VditorIRDOM':'Md2VditorDOM';
  template.innerHTML=e.lute[method]('| value |\n| --- |\n| '+escaped+' |\n');
  const content=template.content.querySelector('td'),fragment=document.createDocumentFragment();
  if(!content)return;
  fragment.append(...content.childNodes);const last=fragment.lastChild;
  range.deleteContents();range.insertNode(fragment);root.focus({preventScroll:true});
  if(last){range.setStartAfter(last);range.collapse(true);s.removeAllRanges();s.addRange(range);}
  finishDocumentEdit(api,before);
}

export function installMediaTools(api){
  for(const mode of ['ir','wysiwyg'])api.vditor[mode].element.addEventListener('paste',event=>pasteCellText(api,event),true);
  window.handler.on('media-result',value=>{const request=pending.get(value?.id);if(!request)return;pending.delete(value.id);if(value.error)request.reject(new Error(value.error));else request.resolve(value);});
  document.addEventListener('contextmenu',event=>{
    const target=elementAt(event.target),content=target?.closest?.('.vditor-content');if(!content)return;
    const img=target.closest?.('img');
    if(img&&img.closest('.katex,.emoji'))return;
    const table=target.closest?.('table');
    event.preventDefault();event.stopImmediatePropagation();showContextMenu(api,event,{table,img});
  },true);
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||!event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
    const action=event.key==='Enter'?'table-row-below':event.key==='Backspace'?'table-delete-row':null;if(!action)return;
    const table=elementAt(event.target)?.closest?.('table')||contextTableFromSelection(api);if(!table)return;
    const context=tableContext(api,event,table);if(!context)return;
    event.preventDefault();event.stopImmediatePropagation();try{tableEdit(api,context,action);}catch(error){contextToast(error.message);}
  },true);
  document.addEventListener('copy',event=>{
    const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;const range=selection.getRangeAt(0),node=selection.anchorNode?.parentElement,table=node?.closest('table');
    if(!table||!table.contains(selection.focusNode)||!range.intersectsNode(table))return;
    // Only intercept an explicit whole-table selection. Partial cell text keeps
    // the ordinary editor copy behavior, and normal prose never scans tables.
    const selected=selection.toString().replace(/\s/g,'');
    if(selected===table.innerText.replace(/\s/g,'')){
      const payload=tablePayload(table);event.clipboardData.setData('text/html',payload.html);event.clipboardData.setData('text/plain',payload.text);event.preventDefault();event.stopImmediatePropagation();return;
    }
    // A full single row copies as a one-row table so a later paste fills the
    // target row cell by cell instead of collapsing it into one cell. Cell
    // text equality is unreliable (formula sources and image alts stringify
    // differently), so coverage is checked structurally: the range stays
    // inside one row and intersects every cell of that row.
    const row=elementAt(selection.anchorNode)?.closest('tr');
    if(row&&table.contains(row)&&row.contains(selection.focusNode)&&row.contains(range.startContainer)&&row.contains(range.endContainer)
      &&[...row.cells].every(cell=>range.intersectsNode(cell))){
      const payload=rowPayload(row);event.clipboardData.setData('text/html',payload.html);event.clipboardData.setData('text/plain',payload.text);event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  api.__media={setScale:(img,value)=>setImageScale(api,img,value),imageDialog:img=>imageDialog(api,img),tablePayload,copyPlainText:text=>copyPlainText(api,text),tableEdit:(context,action)=>tableEdit(api,context,action)};
}
