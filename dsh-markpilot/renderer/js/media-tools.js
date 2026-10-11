import {sourceText,selectRange,PREVIEWS} from './source-text.js';
import {preserveIR} from './preserve-render.js';
import {cloneSource} from './incremental-ir.js';
import {scheduleSurfaceCleanup} from './surface.js';
import {closeDialog} from './util.js';
import {archiveImageFromPath} from './images.js';
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// T7（2026-10-02 二轮判决）：应用内表格剪贴板载荷的"Markdown 记号"标记。带标记的 html
// 粘回本产品走 markdown 还原；外来 html 表格（Excel/网页）没有标记，走 plain 转义。
const CELL_MD_MARK='data-typora-cell-md';
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
function blockOf(root,node){let n=node;while(n&&n!==root&&n.parentElement!==root)n=n.parentElement;return n&&n.parentElement===root?n:null;}
// v2.0.7：分块边界改为 DOM 事实。sourceText 的 IR 文本投影只在
// P/H1-6/LI/TR/BLOCKQUOTE 之后补换行，html-block 节点后没有分隔符，旧的
// 行扫描会把 blockEnd 落到下一个标题的行尾，"拆段"回填时把整段标题写进了
// <img> 源码里——用户看到的就是缩放后下方标题被复制一份。
function selectionBlock(index,root,offset){
  const located=index.point(offset);if(!located)return null;
  const block=blockOf(root,located[0]);if(!block)return null;
  let start=Infinity,end=-1;
  for(const span of index.spans)if(block.contains(span.node)){start=Math.min(start,span.start);end=Math.max(end,span.end);}
  return end>=start?{block,start,end}:null;
}
function paragraphSplitReplacement(text,selection,root,html){
  // direct 路径（图片位于表格单元格等没有 sourceText 投影的位置）不带索引，
  // 无法做分块判断：直接返回替换串。表格单元格里插 \n\n 会把表格拆坏，
  // 而这里原本会抛 "Cannot read properties of undefined (reading 'point')"，
  // 表现为图片缩放对话框点了应用不关、只显示一句 TypeError。
  if(selection.direct)return html;
  const bounds=selectionBlock(selection.index,root,selection.start);
  if(!bounds||bounds.block.tagName==='TABLE')return html;
  const blockText=text.slice(bounds.start,bounds.end);
  const around=blockText.slice(0,selection.start-bounds.start)+blockText.slice(selection.end-bounds.start);
  const plain=/^\s*(!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>)\s*$/.test(around.trim());
  if(!plain&&!/^\s*(?:[-*+] |\d+\. |>#{1,6} |\|)/.test(blockText)){
    const before=blockText.slice(0,Math.max(0,selection.start-bounds.start)).trimEnd();
    const after=blockText.slice(selection.end-bounds.start).trimStart();
    // R6（2026-10-02 判决，r5-export d4 实测）：替换区间只覆盖图片源码本身——
    // commitImageEdit 只删 selection.start..end 这段图片源码，before/after 仍留在
    // 原文里；替换串再拼一份邻文，存盘 md 就是"段落文字甲 段落文字甲"（正文被整段
    // 复制，数据损坏级）。拆段改为**在图片源码两侧各补一个空行**：哪一侧真有正文
    // 才在哪一侧补 \n\n，独占段图两侧皆空 → 原样返回。行内图缩放后保持行内不拆段
    // 是 Typora 同款语义，另立项处理；此处维持"图独占段"的既有行为目标。
    return (before?'\n\n':'')+html+(after?'\n\n':'');
  }
  return html;
}
// 共同的提交路径：源码裁剪 → setValue(reconcile 保渲染) → 光标与滚动复位。
// caretAfter 传入新 <img> 源码时，光标落在图片之后；删除场景光标落在删除点。
function commitImageEdit(api,selection,effective,{dropEmptyBlock=false,caretAfter=null,keepBelow=0,extraRanges=null}={}){
  const e=api.vditor,root=e[e.currentMode].element;
  let md;
  if(selection.direct)md=selection.source.slice(0,selection.start)+effective+selection.source.slice(selection.end);
  else{
    const copy=cloneSource(root,true),cloned=sourceText(copy);
    if(cloned.text!==selection.index.text)throw new Error('图片源位置已变化，请重试');
    const range=cloned.range(selection.start,selection.end);
    range.deleteContents();
    // D1（2026-10-02 判决）：多图删除把其余图片的源码区间并进**同一次**提交。索引的
    // spans 快照只被"覆盖到的区间"改变：附加区间都在主区间之后、且从后往前剪，
    // 各自落在互不相同的节点里，快照偏移在未触及的节点上仍然有效。第一张一旦
    // setValue 重建所在块，其余旧 <img> 节点就全部失联，逐张提交只能删掉一张——
    // 所以区间必须在动手前全部收齐、一次剪完。
    if(extraRanges)for(const extra of[...extraRanges].sort((a,b)=>b.start-a.start))cloned.range(extra.start,extra.end).deleteContents();
    if(effective)range.insertNode(document.createTextNode(effective));
    if(dropEmptyBlock&&!effective){
      const located=cloned.point(Math.min(selection.start,cloned.text.length));
      let block=located[0];while(block&&block!==copy&&block.parentElement!==copy)block=block.parentElement;
      if(block&&block!==copy&&!block.textContent.trim())block.remove();
    }
    if(e.currentMode==='sv')md=copy.textContent;
    else md=e.lute[e.currentMode==='ir'?'VditorIRDOM2Md':'VditorDOM2Md'](copy.innerHTML);
  }
  const scroll=root.scrollTop;
  // keepBelow：调用方已经判定"图片顶边滚出了上沿"，要求删除后下方文字原地不动。
  // 要补偿的高度**按内容总高的变化量算**，而不是按图片盒/块的几何：块级 HTML 图片那一块
  // 还带着外边距（实测 probe 场景里图片盒 881、那一块 getBoundingClientRect 906、而内容
  // 总高实际少了 920），按几何量算会差几十像素、下方文字仍然会跳一格。
  const heightBefore=keepBelow?root.scrollHeight:0;
  // 删除前的那条历史点：同样只在 markdown 真的变了时才补（见 pushHistoryIfChanged）。
  // 否则"点选图片"这个纯光标移动会被记成一条 markdown 毫无变化的撤销，用户按 Ctrl+Z
  // 时会先撞上这一条（"什么也没发生"），看起来就像要按两次才撤回删除。
  pushHistoryIfChanged(api);preserveIR(api,()=>api.setValue(md));
  const next=sourceText(root);
  if(!next.spans.length){root.focus({preventScroll:true});}
  else{
    let position=caretAfter?next.text.indexOf(caretAfter,Math.max(0,selection.start-1)):-1;
    if(position<0)position=Math.min(selection.start,next.text.length);
    const caret=caretAfter?position+caretAfter.length:position;
    selectRange(root,next.range(caret,caret));
  }
  // 重建后的异步收尾（光标显示/公式重排/outline）可能再次滚动视口——同步 +
  // 输入回调后 + 两拍延迟复位，保证删除图片后视口停在原地（用户报告过跳页）。
  // keepBelow：图片顶边已经滚出上沿时，用户要的是"下方文字位置不动、上方内容下移"，
  // 于是把复位目标整体上移"被删掉的那一段高度"（上方内容因此下移进视野，下方文字原地不动）。
  const removed=keepBelow?Math.max(0,heightBefore-root.scrollHeight):0;
  const target=removed?Math.max(0,scroll-removed):scroll;
  const pin=()=>{if(root.isConnected)root.scrollTop=target;};
  pin();e.options.input?.(api.getValue());pin();
  setTimeout(pin,0);setTimeout(pin,180);
  e.undo.addToUndoStack(e);
  return md;
}
function imageHtml(img,{width,scale,align}){
  const alt=img.getAttribute('alt')||'',title=img.getAttribute('title');
  const titleAttribute=title===null?'':` title="${escape(title)}"`;
  const alignAttribute=align&&align!=='left'?` data-typora-align="${align}"`:'';
  return `<img src="${escape(img.getAttribute('src'))}" alt="${escape(alt)}"${titleAttribute}${alignAttribute} width="${Math.max(1,Math.round(width))}" data-typora-scale="${scale}" />`;
}
export function setImageScale(api,img,percent){
  const value=Number(percent);if(!Number.isFinite(value)||value<5||value>400)throw new Error('请输入 5～400 的缩放百分比');
  if(!img.isConnected||!img.naturalWidth)throw new Error('图片尚未加载完成');
  const e=api.vditor,root=e[e.currentMode].element,selection=imageRange(api,img);
  // Percentages are relative to the size currently on screen: an oversized
  // paste is already clamped by max-width:100%, so natural-px math leaves the
  // display untouched until the result drops below the container (v2.0.4).
  // The base is recoverable from the stored attributes, so re-applying the
  // same percentage is idempotent instead of compounding.
  const prevScale=Number(img.getAttribute('data-typora-scale'))||0;
  const prevWidth=Number(img.getAttribute('width'))||0;
  const base=prevScale>0&&prevWidth>0?Math.round(prevWidth*100/prevScale):Math.min(img.naturalWidth,Math.round(img.getBoundingClientRect().width));
  const align=img.getAttribute('data-typora-align')||'left';
  const html=imageHtml(img,{width:Math.max(1,Math.round(base*value/100)),scale:value,align});
  const source=selection.direct?selection.source:selection.index.text;
  const selected=source.slice(selection.start,selection.end);
  const replacement=paragraphSplitReplacement(source,selection,root,html);
  if(selected===replacement){if(!selection.direct)selectRange(root,selection.index.range(selection.start,selection.end));return html;}
  commitImageEdit(api,selection,replacement,{caretAfter:html});
  return html;
}
// v2.0.7：右键对齐。写进 <img> 的 data-typora-align，CSS 层渲染；
// 缩放编辑会保留该属性（见 imageHtml）。
export function setImageAlign(api,img,align){
  if(!['left','center','right'].includes(align))throw new Error('未知对齐方式');
  if(!img.isConnected)throw new Error('图片已不在文档中，请重试');
  // D2（2026-10-02 判决）：断链/未加载的图 naturalWidth=0，照算下去 width 会被
  // imageHtml 的 Math.max(1,…) 写成 width="1"，等于把原图尺寸信息抹掉。与
  // setImageScale 开头的守卫同判：没加载完成就不改写源码（右键菜单侧以 toast 提示）。
  if(!img.naturalWidth)throw new Error('图片尚未加载完成');
  const e=api.vditor,root=e[e.currentMode].element,selection=imageRange(api,img);
  const width=Number(img.getAttribute('width'))||img.naturalWidth||0;
  const scale=Number(img.getAttribute('data-typora-scale'))||Math.round(width/(img.naturalWidth||width)*100)||100;
  const html=imageHtml(img,{width,scale,align});
  const source=selection.direct?selection.source:selection.index.text;
  const selected=source.slice(selection.start,selection.end);
  const replacement=paragraphSplitReplacement(source,selection,root,html);
  // FC3（2026-10-02 判决）：无变化早退与 setImageScale 同判——把选区/焦点还原回图片，
  // 否则点一次"右对齐"（本来就是右对齐）后焦点留在已移除的菜单上，打字落空。
  if(selected===replacement){if(!selection.direct)selectRange(root,selection.index.range(selection.start,selection.end));return html;}
  commitImageEdit(api,selection,replacement,{caretAfter:html});
  return html;
}
// v2.0.7：删除整张图片（单击选中后 Backspace/Delete）。图片独占的块随图一起
// 移除，避免留下空块；光标落在删除点，滚动位置保持不动（用户报告过删除后
// 视口跳到后面页面）。
// v2.1.15：**图片顶边已经滚出页面上沿**时（只剩图片下半截和它下面的文字看得见），
// 删除它要按用户定的规则办：下方文字位置不动、上方内容下移（=把视口整体下移一个
// 被删掉的高度）。否则删掉之后下方文字会往上跳一屏，阅读位置全乱。判据用几何：
// 图片盒的 top 在可视区上沿之上（`< root` 的上沿）才走这条；图片整体在视口里的
// 情形保持原样（下方文字上移是符合直觉的）。
function deleteImage(api,img){
  const selection=imageRange(api,img);
  // v2.1.15 用户规则：图片**顶边已经滚出页面上沿**时（只剩它下半截和下方文字看得见），
  // 删除后要求"下方文字位置不动、上方内容下移"；图片整体在视口里时保持原行为
  // （下方文字上移一格是符合直觉的，用户说那条没问题）。
  // 这里只判**条件**（几何），补偿多少由 commitImageEdit 按内容总高的变化量算。
  let keepBelow=false;
  try{
    const root=editorRoot(api),view=root?.getBoundingClientRect?.(),box=img?.getBoundingClientRect?.();
    if(view&&box&&box.height>1&&box.top<view.top)keepBelow=true;
  }catch{/* 量不到就按旧行为：视口不动 */ }
  return commitImageEdit(api,selection,'',{dropEmptyBlock:true,keepBelow});
}
/** D1（2026-10-02 判决通过）：多选图片删除的合并提交。
 *  旧的逐张 deleteImage 循环：第一张的 setValue 会让 reconcile 重建它所在的块，
 *  **同段的其余 <img> 节点随之失联**，第二张 imageRange 必抛「请在编辑区选择图片后
 *  重试」——用户看到"多选两张按退格只删掉一张，还弹一条错误 toast"。
 *  这里先在动 DOM 之前把每张**还连着**的图的源码区间收齐（失联/定位失败的跳过并
 *  继续，不再让一张坏图中断整批），除首张外全部作为附加区间并进一次
 *  commitImageEdit：一次 setValue、一条撤销、一次光标与滚动复位。 */
function deleteImages(api,imgs){
  const e=api.vditor,root=e&&e[e.currentMode]&&e[e.currentMode].element;
  const seen=new Set(),indexed=[],direct=[];
  let keepBelow=false;
  for(const img of imgs){
    if(seen.has(img)||!img.isConnected)continue;          // 失联的图（DOM 已被重建/移除）跳过并继续
    seen.add(img);
    let selection;
    try{selection=imageRange(api,img);}catch{continue;}   // 这张定位失败：跳过它，继续删其余
    (selection.direct?direct:indexed).push({img,selection});
    // keepBelow 判据与 deleteImage 相同：任一张"顶边滚出上沿"就要求删除后下方文字原地不动。
    if(root&&!keepBelow){
      try{const view=root.getBoundingClientRect(),box=img.getBoundingClientRect();if(box.height>1&&box.top<view.top)keepBelow=true;}catch{/* 量不到就按旧行为 */}
    }
  }
  if(indexed.length){
    indexed.sort((a,b)=>a.selection.start-b.selection.start);
    const first=indexed[0];
    // 同一份未改动的 DOM 上建出的索引文本必然一致；对不上（异常时序）的那几张不并入，
    // 绝不拿可能错位的区间乱剪——它们走下面的逐张补删。
    const extras=[],rest=[];
    for(const pair of indexed.slice(1))(pair.selection.index.text===first.selection.index.text?extras:rest).push(pair);
    commitImageEdit(api,first.selection,'',{dropEmptyBlock:true,keepBelow,
      extraRanges:extras.map(pair=>({start:pair.selection.start,end:pair.selection.end}))});
    for(const{img}of rest){if(img.isConnected){try{deleteImage(api,img);}catch{/* 跳过 */}}}
  }
  // 表格单元格里的直连图（direct，没有 sourceText 投影）与索引图分属两套坐标系，不能并进
  // 同一次克隆提交；它们所在的块没被上面的 setValue 换掉时仍然连着，逐张补删即可。
  for(const img of direct){
    if(!img.isConnected)continue;
    try{deleteImage(api,img);}catch{/* 跳过，继续下一张 */}
  }
}
function imageDialog(api,img){
  // FC1（2026-10-02 判决）：与本文件同族的五个弹窗（about/edit-shortcuts/themes/surface…）
  // 一样，打开前快照焦点与选区，关闭时还给正文。此前这里只 dialog.remove()，对话框一关
  // 焦点掉到 body，选区也留在对话框输入框上——用户接下来打字全部落空。
  const previousFocus=document.activeElement;
  const selectionSnapshot=getSelection();
  const savedRange=selectionSnapshot?.rangeCount?selectionSnapshot.getRangeAt(0).cloneRange():null;
  document.getElementById('typora-image-settings')?.remove();const dialog=document.createElement('dialog');dialog.id='typora-image-settings';dialog.className='typora-media-dialog';
  dialog.innerHTML='<form><h3>图片</h3><label>缩放 <input name="scale" type="number" min="5" max="400" step="1" required> %</label><p>100% 为原始尺寸；缩放只改变显示，不压缩原图。</p><div class="media-presets"></div><p class="media-error" role="status"></p><div class="media-actions"><button type="button" data-action="copy-image">复制原图</button><button type="button" data-action="save-image">导出原图…</button><button type="button" data-close>关闭</button><button type="submit">应用</button></div></form>';
  const input=dialog.querySelector('input');
  // D8（2026-10-02 判决）：断链图 naturalWidth=0 时 (width||0)/0 得到 Infinity，
  // number 输入框对非法值直接显示为空，对话框看起来"没填初值"。这时兜底 100，
  // 与表单里"100% 为原始尺寸"的文案一致。
  input.value=img.getAttribute('data-typora-scale')||(img.naturalWidth?Math.round((Number(img.getAttribute('width'))||img.naturalWidth)/img.naturalWidth*100):100)||100;
  for(const percent of [25,50,75,100,150]){const button=document.createElement('button');button.type='button';button.textContent=percent+'%';button.onclick=()=>{input.value=percent;};dialog.querySelector('.media-presets').append(button);}
  // FC1 收尾：还原焦点与选区。菜单路径进来时 previousFocus 是**已被移除的菜单**，
  // isConnected 检查会跳过它——这时必须显式把焦点还给编辑面，否则 selection 加回去了
  // 键盘焦点仍在 body，打字照样落空（dialog.close() 的原生回焦也只会指向已移除的菜单）。
  const finish=()=>{
    dialog.remove();
    const root=editorRoot(api);
    const back=previousFocus?.isConnected&&previousFocus!==document.body?previousFocus:root;
    if(back&&back!==document.activeElement)back.focus({preventScroll:true});
    if(savedRange?.startContainer?.isConnected&&savedRange.endContainer?.isConnected){
      selectionSnapshot.removeAllRanges();selectionSnapshot.addRange(savedRange);
    }
  };
  dialog.querySelector('form').onsubmit=event=>{event.preventDefault();try{setImageScale(api,img,input.value);closeDialog(dialog,finish);}catch(error){dialog.querySelector('.media-error').textContent=error.message;}};
  dialog.querySelector('[data-close]').onclick=()=>closeDialog(dialog,finish);
  for(const button of dialog.querySelectorAll('[data-action]'))button.onclick=async()=>{button.disabled=true;try{const result=await mediaRequest(button.dataset.action,{src:img.getAttribute('src'),name:img.alt||'图片'});dialog.querySelector('.media-error').textContent=button.dataset.action==='copy-image'?'已复制，可粘贴到 Word、Excel 或 PowerPoint。':result.cancelled?'已取消':'已导出原图。';}catch(error){dialog.querySelector('.media-error').textContent=error.message;}finally{button.disabled=false;}};
  document.body.append(dialog);dialog.showModal();input.focus();input.select();dialog.addEventListener('close',finish,{once:true});
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
  copy.setAttribute(CELL_MD_MARK,'1');   // T7：应用内载荷标记——粘回本产品时仍按 Markdown 记号还原
  return{html:copy.outerHTML,text:[...copy.rows].map(row=>[...row.cells].map(cell=>cellText(cell)).join('\t')).join('\r\n')};
}
// 单元格的可读文本：cleanTableCopy 之后，公式/图片/代码/粗体都以 Markdown 记号
// 形式留在文本里，粘回表格时再经 Lute 还原成渲染节点。
function cellText(cell){
  const copy=cell.cloneNode(true);
  for(const img of copy.querySelectorAll('img')){
    if(img.closest('.katex,.emoji')){img.remove();continue;}
    const alt=(img.getAttribute('alt')||'').replace(/[[\]]/g,'');
    const title=img.getAttribute('title');
    img.replaceWith(document.createTextNode('!['+alt+']('+(img.getAttribute('src')||'')+(title?' "'+title+'"':'')+')'));
  }
  return copy.textContent.replace(/\u200b/g,'').replace(/[\t\r\n]+/g,' ').trim();
}
/* ---------- 表格剪贴板：CSV 级矩形语义 ----------
   复制：任意覆盖 ≥1 个整格的表格选区都按"矩形切片"写出（text/plain 为 TSV、
   html 为只含该矩形的 <table>），不再依赖"选区文本恰好等于整表/整行文本"这种
   文本比对（空行会让整行选区被误判成整表，是"粘表头多一行"的根因）。
   粘贴：HTML 表格或 TSV 文本都按矩形逐格落位，缺行补行、缺列补列。
   T7（2026-10-02 二轮判决）：应用内复制出的 html 表格带 CELL_MD_MARK 标记，
   粘回时按 Markdown 记号还原；外来 html 表格（Excel/网页）**没有**标记，字符是
   字面文本，走 plain 转义路径——a_b*c $x$ 粘进格子原样可见，不能被 Lute 吃成
   粗体/斜体/公式。 */
function tableOf(node){return elementAt(node)?.closest?.('table')||null;}
// 表格选区 → 矩形。用"锚点格到焦点格"的包围盒，而不是 DOM Range 的线性跨度：
// 从第 0 行第 0 格拖到第 1 行第 1 格时，线性范围会把第 0 行后面几格也算进去，
// 而表格语义下用户要的是 2×2 那块。
// 表格选区 → 矩形。用"两个边界（锚点/焦点）的包围盒"，而不是 DOM Range 的线性
// 跨度：从第 0 行第 0 格拖到第 1 行第 1 格时，线性范围会把第 0 行后面几格也算进去，
// 而表格语义下用户要的是 2×2 那块。边界可以是单元格（td/th）、整行（tr，
// selectNodeContents(row) 就是这种）或表格本身（Ctrl+A / selectNodeContents(table)）。
// RC3（2026-10-02 判决）：tableBoundary 多收一个 table 参数——端点在**这张表之外**
// （比如"文段+表格"混合选区落在正文里的那个端点）时返回 null，不再退回 {}。此前 {}
// 会在 tableRectangle 里被撑成"整张表"的四个角，混合选区的复制/剪切就被劫成整表。
// 端点是 table 本体（selectNodeContents(table)，三击选段/整表选态）仍算表内。
function tableBoundary(node,table){
  const element=elementAt(node);
  if(!element)return null;
  if(table&&element!==table&&!table.contains(element)&&!table.contains(node))return null;
  const cell=element.closest('td,th');
  if(cell)return{cell,row:cell.parentElement,rowIndex:cell.parentElement.rowIndex,colIndex:cell.cellIndex};
  const row=element.closest('tr');
  if(row)return{row,rowIndex:row.rowIndex,colIndex:null};
  // 端点在表内但不在任何行/格里（table/tbody 本体）：整表语义，保留旧行为。
  return{};
}
function tableRectangle(range){
  if(!range||range.collapsed)return null;
  const startNode=range.startContainer,endNode=range.endContainer;
  const table=tableOf(startNode)||tableOf(endNode);
  if(!table)return null;
  const startTable=tableOf(startNode),endTable=tableOf(endNode);
  if(startTable&&endTable&&startTable!==endTable)return null;   // 跨表选区不接管
  const width=Math.max(0,...[...table.rows].map(row=>row.cells.length));
  if(!width)return null;
  const a=tableBoundary(startNode,table),b=tableBoundary(endNode,table);
  // RC3：任一端点不在这张表里（文段+表混合选区）→ 不接管，交回普通文本复制路径。
  if(!a||!b)return null;
  // 单格内的部分文字选中是普通文本复制，只有整格选中才算表格选区。
  if(a.cell&&b.cell&&a.cell===b.cell){
    const whole=document.createRange();whole.selectNodeContents(a.cell);
    if(range.compareBoundaryPoints(Range.START_TO_START,whole)>0||
       range.compareBoundaryPoints(Range.END_TO_END,whole)<0)return null;
  }
  const points=[];
  for(const boundary of [a,b]){
    if(!Number.isInteger(boundary.rowIndex)){points.push([0,0],[table.rows.length-1,width-1]);continue;}
    if(Number.isInteger(boundary.colIndex))points.push([boundary.rowIndex,boundary.colIndex]);
    else points.push([boundary.rowIndex,0],[boundary.rowIndex,width-1]);
  }
  if(!points.length)return null;
  const rows=points.map(point=>point[0]),cols=points.map(point=>point[1]);
  return{table,top:Math.min(...rows),bottom:Math.max(...rows),left:Math.min(...cols),right:Math.max(...cols)};
}
function cellAt(table,row,col){return table.rows[row]?.cells[col]||null;}
// 单元格 → Markdown 记号（**粗体**、`行内代码`、$公式$、![图](…)、转义竖线…）。
// 为什么不能只取 textContent：IR/WYSIWYG 里粗体是 <strong>、行内代码是 <code>，
// textContent 会把记号**悄悄吃掉**，于是"复制一格富文本 → 粘到另一个窗口的表格"里
// 粗体和代码退化成纯文本（2026-09-12 实测：载荷里 `**加粗**` 变成 `加粗`、
// `` `const a=1` `` 变成 `const a=1`）。这里走 Lute 的 DOM→Md，和粘贴时 Md→DOM 是
// 同一个引擎，一来一回不丢记号。公式/图片两条路径原本就正确，不能改坏。
function cellMarkdown(editor,cell){
  try{
    const container=document.createElement('p');container.setAttribute('data-block','0');
    for(const node of cell.childNodes)container.append(node.cloneNode(true));
    container.querySelectorAll(PREVIEWS).forEach(node=>node.remove());   // 预览岛（含 KaTeX 渲染）不参与序列化
    const id='TYPORACELL'+crypto.randomUUID().replaceAll('-',''),left=id+'B',right=id+'E';
    container.prepend(document.createTextNode(left));container.append(document.createTextNode(right));
    const md=editor.lute[editor.currentMode==='ir'?'VditorIRDOM2Md':'VditorDOM2Md'](container.outerHTML);
    const start=md.indexOf(left),end=md.indexOf(right);
    if(start<0||end<start)return cellText(cell);
    return md.slice(start+left.length,end).replace(/\u200b/g,'').replace(/[\t\r\n]+/g,' ').trim();
  }catch{return cellText(cell);}
}
function rectanglePayload(editor,range){
  const rect=tableRectangle(range);if(!rect)return null;
  const rows=[];
  for(let row=rect.top;row<=rect.bottom;row++){
    const line=[];
    for(let col=rect.left;col<=rect.right;col++){
      const cell=cellAt(rect.table,row,col);
      line.push(cell?cellMarkdown(editor,cell):'');
    }
    rows.push(line);
  }
  const copy=document.createElement('table');
  copy.setAttribute(CELL_MD_MARK,'1');   // T7：应用内矩形载荷标记——粘回时走 markdown 还原路径
  for(const line of rows){
    const tr=document.createElement('tr');
    for(const text of line){
      const td=document.createElement('td');
      if(text)td.textContent=text;
      tr.append(td);
    }
    copy.append(tr);
  }
  return{html:copy.outerHTML,text:rows.map(line=>line.join('\t')).join('\r\n'),rect};
}
// 多格选区按 CSV 语义整体清空/整体改写，而不是让浏览器把单元格合并掉。
function isMultiCellRange(range){
  const rect=tableRectangle(range);
  return rect&&(rect.bottom>rect.top||rect.right>rect.left)?rect:null;
}
function clearRectangle(rect){
  for(let row=rect.top;row<=rect.bottom;row++)for(let col=rect.left;col<=rect.right;col++){
    cellAt(rect.table,row,col)?.replaceChildren();
  }
}
function firstCellIn(rect){return cellAt(rect.table,rect.top,rect.left);}

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
/** 只有"文档真的变了"才补一条历史点。
 *  为什么需要这个判断：Vditor 的历史快照是**带光标位置**的（`undo.addToUndoStack` 内部先
 *  `addCaret`）。所以"只移动了光标"（例如点选一张图片：光标被搬到图片所在块）在这套机制里
 *  也算一次差异，照着推就会多出一条 markdown 完全没变的撤销——用户按 Ctrl+Z 时这一条
 *  "什么也不发生"，看起来就像"要按两次才能撤回删除"（用户报告 2026-09-14 第 6 轮第 4 条：
 *  选中图片删除后要两次 Ctrl+Z；实测 scripts/acceptance/probe-img4.cjs：一次 Delete 里
 *  `addToUndoStack` 被调 5 次、其中 2 次真的入栈，多出来那条的 markdown 与上一条完全相同）。
 *  判据与 typora-patches.js 的 flush 完全一致：拿历史快照换算出的 markdown 和当前 markdown 比。 */
function pushHistoryIfChanged(api){
  const e=api.vditor,mode=e?.currentMode,state=e?.[mode];
  if(!state||typeof state.lastText!=='string')return false;
  let previous=null;
  try{
    if(e.__typoraPerformance?.historyMarkdown)previous=e.__typoraPerformance.historyMarkdown(state.lastText);
    else previous=(mode==='ir'?e.lute.VditorIRDOM2Md:e.lute.VditorDOM2Md).call(e.lute,state.lastText);
  }catch{return false;}
  if(previous===api.getValue())return false;
  e.undo.addToUndoStack(e);return true;
}
function beginDocumentEdit(api){
  const e=api.vditor;
  if(e.currentMode==='ir')e.__typoraFlushIR?.();
  else if(e.currentMode==='wysiwyg')clearTimeout(e.wysiwyg.processTimeoutId);
  pushHistoryIfChanged(api);
  // 产品侧 DOM 编辑在 document/window 捕获层吞键，不经编辑面 keydown/beforeinput：
  // 撤销补丁缺"编辑前选区"（historySelections 喂不上料），载入态首快照也缺 <wbr>
  // 标记（撤销目标串无标记 → vendored renderDiff 兜底把选区丢到编辑面外的壳层
  // div.vditor-ir，rect 0×0 无可见光标）。按 patchHeadingEnter
  // （typora-patches.js recordFirstPosition 先例）与 completion（哑事件 {key:'Tab'}
  // 产线先例）的既定模式补喂：wrapper 先 captureBeforeInput，pending 由紧随的
  // finishDocumentEdit→addToUndoStack 消费；首个编辑时 vendored 体还会把 undoStack[0]
  // 标记为带光标版本（撤销目标串从此有标记）。必须在 flush/push 之后调用（去抖未落
  // 的上一个编辑先消费自己的 pending）；{key:'Enter'} 非 Backspace，不触发 mac 卫兵；
  // sv 不喂（与 captureBeforeInput 的 sv 政策一致）。
  if(e.currentMode!=='sv')e.undo.recordFirstPosition(e,{key:'Enter'});
  return api.getValue();
}
function finishDocumentEdit(api,before){
  const e=api.vditor,after=api.getValue();
  if(after===before)return false;
  e.options.input?.(after);e.undo.addToUndoStack(e);return true;
}
/** S5（2026-10-02 二轮判决，三轮返工）：被选区**完整罩住**的公式 owner 列表。
 *  KaTeX 渲染树会把同一个公式以 MathML + x-tex 注记 + 可视层多份文本混进
 *  selection.toString()，于是"选 文 $x$ 文 → Ctrl+Alt+V"拿到的不是单份带围栏源码。
 *  IR 真实结构（headless 实测，.zcode-tmp/lute-probe）：
 *    SPAN.vditor-ir__node[data-type="inline-node"]
 *      ├ SPAN.vditor-ir__marker "$"（前围栏）
 *      ├ CODE[data-type="math-inline"]（源码，**无 data-math 属性**）
 *      ├ SPAN.vditor-ir__preview > SPAN.language-math（KaTeX，.language-math 在预览里！）
 *      └ SPAN.vditor-ir__marker "$"（后围栏）
 *  一轮版查 '.language-math' 再 closest('[data-type=math-*]') 拿到的是**预览里的内层
 *  span**（壳的 data-type 是 inline-node，对不上），整段选中时分支根本不触发。
 *  返工口径：候选从 code[data-type=math-*] 与 .language-math 出发收进**节点壳**
 *  （.vditor-ir__node / .vditor-wysiwyg__node，找不到壳退到 code 自身），只留最外层；
 *  完整覆盖用**端点 containment 显式比较**（range.start ≤ 壳.start 且 range.end ≥ 壳.end），
 *  不依赖 containsNode 的实现口径。 */
function coveredMathOwners(range){
  const owners=[];
  try{
    let scope=range.commonAncestorContainer;
    scope=scope.nodeType===Node.ELEMENT_NODE?scope:scope.parentElement;
    if(!scope)return owners;
    const candidates=[];
    for(const code of scope.querySelectorAll('code[data-type="math-inline"],code[data-type="math-block"],.language-math')){
      const owner=code.closest('.vditor-ir__node,.vditor-wysiwyg__node,[data-type="math-inline"],[data-type="math-block"]')||code;
      if(!candidates.includes(owner))candidates.push(owner);
    }
    for(const owner of candidates){
      if(candidates.some(other=>other!==owner&&other.contains?.(owner)))continue;   // 只留最外层壳，壳+内部元素不重复替换
      const whole=document.createRange();whole.selectNodeContents(owner);
      if(range.compareBoundaryPoints(Range.START_TO_START,whole)<=0
        &&range.compareBoundaryPoints(Range.END_TO_END,whole)>=0)owners.push(owner);
    }
  }catch{/* 求值失败退回旧行为 */}
  return owners;
}
/** 公式 owner → 一份带围栏的源码文本（inline 补 $…$、block 补 $$…$$）。
 *  IR 的 code 上没有 data-math（实测），源码取 code.textContent；WYSIWYG/有 data-math
 *  时优先 data-math。围栏看 owner 或内部 code 的 data-type 是否 math-block。 */
function mathSourceText(owner){
  const code=owner.matches?.('code[data-type="math-inline"],code[data-type="math-block"],.language-math')?owner:owner.querySelector('code[data-type="math-inline"],code[data-type="math-block"],.language-math');
  const block=owner.getAttribute('data-type')==='math-block'||code?.getAttribute?.('data-type')==='math-block';
  const fence=block?'$$':'$';
  const raw=code&&code.getAttribute('data-math')!=null?code.getAttribute('data-math'):(code?code.textContent:owner.textContent);
  return fence+String(raw||'').replace(/\u200b/g,'')+fence;
}
/** 选区的纯文本口径：sv 取 textarea 选段；整个公式被选中时换回带围栏源码；
 *  整表被选中时换回表格 Markdown 载荷。复制（copyPlainText/Ctrl+Alt+V）与
 *  查找播种（find-replace 的 Ctrl+F 预填）共用同一口径。 */
export function selectionPlainText(api){
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
  // S5：把每个被完整覆盖的公式 owner 逐个换回**一份**带围栏源码，其余文本按选区原样，
  // Ctrl+Alt+V 得到的就是"文 $x$ 文"这样的单份源码文本。
  const covered=coveredMathOwners(range);
  if(covered.length){
    const MARK='data-typora-math-cover';
    for(const owner of covered)owner.setAttribute(MARK,'1');
    try{
      const fragment=range.cloneContents();
      for(const node of [...fragment.querySelectorAll('['+MARK+']')]){
        node.replaceWith(document.createTextNode(mathSourceText(node)));
      }
      const text=fragment.textContent.replace(/\u200b/g,'');
      if(text.trim())return text;
    }finally{for(const owner of covered)owner.removeAttribute(MARK);}
  }
  return selected||rangeText;
}

export async function copyPlainText(api,text=selectionPlainText(api)){
  const value=String(text??'').replace(/\u200b/g,'');
  // 【F13①·R10】空值守卫：折叠/空选区（selectionPlainText 返 ''）不做任何剪贴板写入——
  // 旧链直发 hostApi → main 进程 clipboard.writeText('') 会把用户剪贴板里已有的内容清空。
  // 守卫落在本函数内，Ctrl+Alt+V 与右键「复制 plain text」两条通道同享。
  if(!value)return false;
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
/** 【F13②·R10】Ctrl+Shift+V 粘贴纯文本：复用右键「粘贴」的文本通道（右键动作里
 *  execCommand('paste') 在 Chromium 系 renderer 上恒 false，实际生效的就是下面这条
 *  hostApi 'clipboard-read-text' / navigator.clipboard.readText → insertText 链）。
 *  只取 text/plain 味道、不取 html：富文本选区（含 ** 加粗）粘进来是纯文字，不新建
 *  strong。beginDocumentEdit/finishDocumentEdit 与右键粘贴同一包裹（一条撤销回粘贴前）。
 *  空剪贴板（读回 ''）不产生空编辑事务，直接返回。 */
export async function pasteClipboardAsText(api){
  let text=null;
  if(window.hostApi?.invoke){
    try{text=await window.hostApi.invoke('clipboard-read-text');}catch{/* 落到 webview 剪贴板 */}
  }
  if(typeof text!=='string'&&navigator.clipboard?.readText){
    try{text=await navigator.clipboard.readText();}catch{/* 两条通道都读不到 */}
  }
  if(typeof text!=='string')throw new Error('无法读取系统剪贴板，请重试');
  if(!text)return false;
  const saved=savedSelection();
  const before=beginDocumentEdit(api);
  try{
    const selection=getSelection();
    if(!selection?.rangeCount||!editorRoot(api)?.contains(selection.anchorNode)||!editorRoot(api)?.contains(selection.focusNode))restoreSelection(saved,api);
    document.execCommand('insertText',false,text);
  }finally{finishDocumentEdit(api,before);}
  return true;
}
function cutSelection(api){
  const root=editorRoot(api),selection=getSelection();
  const range=selection?.rangeCount&&!selection.isCollapsed?selection.getRangeAt(0).cloneRange():null;
  let ok=false;try{ok=document.execCommand('cut');}catch{/* use the manual path below */}
  const after=getSelection();
  // Electron/Blink 实测：execCommand('cut') 会**返回 true、把文本写进剪贴板，却不删正文**
  // （2026-09-11 打包产物实测：右键"剪切"之后文字原样还在，再粘贴就是一份重复内容；
  //  同一个选区走 Ctrl+X 是正常的）。所以这里以"选区是不是真的没了"为准——成功剪切之后
  // 选区必然塌掉——没塌就自己把选区删掉，剪贴板用 copy 再兜一次（已写过时是幂等的）。
  const stillThere=!!range&&!!after?.rangeCount&&!after.isCollapsed;
  if(!stillThere)return ok;
  if(root&&root.contains(range.startContainer)&&root.contains(range.endContainer)){
    try{document.execCommand('copy');}catch{/* 剪贴板通常已由上面的 cut 写好 */}
    range.deleteContents();
    after.removeAllRanges();
    return true;
  }
  // 选区不在编辑面里：交给编辑器的 cut 事件路径（保持原有语义）
  let clipboardData=null;try{clipboardData=new DataTransfer();}catch{/* older webviews may omit DataTransfer */}
  try{
    const event=new ClipboardEvent('cut',{clipboardData,bubbles:true,cancelable:true});root?.dispatchEvent(event);return event.defaultPrevented||ok;
  }catch{return ok;}
}
function cutDocumentSelection(api){
  const before=beginDocumentEdit(api),changed=cutSelection(api);
  return changed&&finishDocumentEdit(api,before);
}

/** RC8（2026-10-02 判决）：右键落在 table 本体（边框/表体留白，target 就是 table 元素）
 *  时，按 contextmenu 坐标找**离点击点最近的格**。旧代码 rows.indexOf(row) 得 -1 再
 *  Math.max(0,…) 钉到第 0 行——右键表底部却删掉表头那行。键盘事件（clientX/Y 全 0）
 *  不走这条（那类调用方的事件目标本来就在格子里）。 */
function nearestTableCell(table,x,y){
  let best=null,bestDistance=Infinity;
  for(const row of table.rows)for(const cell of row.cells){
    const rect=cell.getBoundingClientRect();
    if(!rect.width&&!rect.height)continue;
    const dx=Math.max(rect.left-x,0,x-rect.right),dy=Math.max(rect.top-y,0,y-rect.bottom);
    const distance=dx*dx+dy*dy;
    if(distance<bestDistance){bestDistance=distance;best=cell;}
  }
  return best;
}
function tableContext(api,event,table){
  const root=editorRoot(api);if(!root||!table||!root.contains(table))return null;
  const rows=[...table.rows];
  let row=elementAt(event?.target)?.closest?.('tr')||null;
  let cell=elementAt(event?.target)?.closest?.('td,th')||null;
  // 选区锚点兜底：只认**落在这张表里**的锚点（多表文档里锚点可能在别的表，照旧会被
  // rows.indexOf 钉成 -1→0）。
  if(!row||!cell){
    const anchorCell=elementAt(getSelection()?.anchorNode)?.closest?.('td,th');
    if(anchorCell&&table.contains(anchorCell)){if(!cell)cell=anchorCell;if(!row)row=anchorCell.parentElement;}
  }
  // RC8 坐标最近格回退：表本体上的右键。
  if((!row||!cell||!table.contains(row))&&(event?.clientX||event?.clientY)){
    const near=nearestTableCell(table,event.clientX,event.clientY);
    if(near){cell=near;row=near.parentElement;}
  }
  const rowIndex=row?rows.indexOf(row):-1;
  const resolvable=rowIndex>=0&&!!cell&&!!cell.parentElement&&rows[rowIndex]===cell.parentElement;
  const actualRow=rows[Math.max(0,rowIndex)],cells=actualRow?[...actualRow.cells]:[];
  const colIndex=Math.max(0,cell&&cell.parentElement===actualRow?cells.indexOf(cell):0);
  return{root,tableIndex:[...root.querySelectorAll('table')].indexOf(table),rowIndex:Math.max(0,rowIndex),colIndex,resolvable};
}
function blankCell(document,row,reference,dataRow=false){
  // T2（2026-10-02 二轮判决）：从表头"下方插入/末尾补出"的是**数据行**——即便参照格是
  // th、行要落在 thead 邻位，也一律用 td；否则新行跟着进 thead，存盘重开多出一行表头。
  if(dataRow)return document.createElement('td');
  const tag=reference?.tagName==='TH'||row?.parentElement?.tagName==='THEAD'?'th':'td';
  return document.createElement(tag);
}
function makeBlankRow(document,reference,count,dataRow=false){
  const row=document.createElement('tr');
  for(let i=0;i<count;i++)row.append(blankCell(document,row,reference?.cells?.[i],dataRow));
  return row;
}
// T2：确保表格有一个 tbody（没有就建一个，并把直挂在 table 下的行按原顺序收进去）。
// "表头行下方插行/末尾补行"的落点都是 **tbody 首行之前**——数据行绝不能落进 thead。
function ensureTableBody(table){
  let body=table.tBodies[0];
  if(!body){
    body=table.ownerDocument.createElement('tbody');
    for(const child of [...table.children])if(child.tagName==='TR')body.append(child);
    table.append(body);
  }
  return body;
}
function changeTableElement(table,context,action){
  if(!table)throw new Error('表格源位置已变化，请关闭菜单后重试');
  const rows=[...table.rows],row=rows[context.rowIndex]||rows[0];
  if(!row)throw new Error('当前表格没有可编辑的行');
  const document=table.ownerDocument;
  if(action==='table-row-above'||action==='table-row-below'){
    const count=Math.max(1,...rows.map(item=>item.cells.length));
    // T2（2026-10-02 二轮判决）：在表头行上"下方插入行"＝在 tbody 首行之前插一条**数据行**
    // （td，无 tbody 则创建），不能插进 thead 变第二个表头——旧代码 row.nextSibling 在
    // thead 里为 null，新行直接追加成表头行，存盘重开表头多一行。
    if(action==='table-row-below'&&row.parentElement?.tagName==='THEAD'){
      const body=ensureTableBody(table);
      body.insertBefore(makeBlankRow(document,row,count,true),body.firstElementChild);
      return true;
    }
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
/** Ctrl+C：把选中的图片当作**图片**放进系统剪贴板（不是 Markdown 文本）。
 *  单选和多选走同一条路；主进程把每张图解析成真实文件路径，剪贴板的主格式是文件拖放
 *  列表，所以微信 / 资源管理器 / Chrome 系网页（DeepSeek 这类）一次能收下多张；
 *  只认位图的目标由 PowerShell 侧拼接的位图回退兜住。 */
function installImageMultiCopy(api,context){
  document.addEventListener('copy',event=>{
    // 表格矩形复制排在前面注册，它已经处理过的粘贴载荷不能被我们抢走。
    // RC7：菜单"复制链接地址"派发的合成 copy 事件（__typoraLinkCopy）不经这两条图片通道。
    if(event.defaultPrevented||event.__typoraLinkCopy||!event.clipboardData)return;
    const items=context.selectedItems();
    if(!items.length)return;
    event.preventDefault();event.stopImmediatePropagation();
    mediaRequest('copy-images',{items})
      .then(()=>contextToast(items.length>1?('已复制 '+items.length+' 张图片，可一次粘贴到微信、文档或网页。'):'已复制这张图片，可粘贴到微信、文档或网页。'))
      .catch(error=>contextToast('复制图片失败：'+error.message));
  },true);
  // Ctrl+X 剪切图片：整组图片一样按"图片"放进剪贴板（文件拖放列表），再删掉原位置。
  // 不接管的话浏览器会把 <img> 连同**源文档目录**的相对路径写成一段 HTML，粘到另一个
  // 文档里变成断链（2026-09-12 实测：跨窗口粘进来的是对方目录的 images/A/…）。
  // 先发起复制（异步读字节/路径）再删，保证剪贴板拿到的是还在磁盘上的真实文件。
  document.addEventListener('cut',event=>{
    if(event.defaultPrevented||event.__typoraLinkCopy||!event.clipboardData)return;
    const items=context.selectedItems();
    if(!items.length)return;
    // 删除要用的元素：多选集合 + 单击选中的那一张
    const elements=[...context.multiSelected].filter(node=>node.isConnected);
    const single=context.selectedImage?.isConnected?context.selectedImage:null;
    if(single&&!elements.includes(single))elements.push(single);
    if(!elements.length)return;
    event.preventDefault();event.stopImmediatePropagation();
    mediaRequest('copy-images',{items})
      .then(()=>contextToast(items.length>1?('已剪切 '+items.length+' 张图片'):'已剪切这张图片'))
      .catch(error=>contextToast('剪切图片失败：'+error.message));
    context.clearImageSelection();
    const before=beginDocumentEdit(api);
    for(const img of elements){try{deleteImage(api,img);}catch(error){contextToast(error.message);}}
    finishDocumentEdit(api,before);
  },true);
}
function addMenuButton(menu,[action,label],run){
  const button=document.createElement('button');button.type='button';button.dataset.action=action;button.textContent=label;button.setAttribute('role','menuitem');
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',()=>run(action));menu.append(button);return button;
}
function addSeparator(menu){const line=document.createElement('div');line.className='typora-context-separator';line.setAttribute('role','separator');menu.append(line);}
/** 弹出菜单落位（用户定的规则，与补全面板同一条）：
 *  面板可以在鼠标/被操作的那一行之上或之下（看哪边放得下，尽量整块留在屏内），
 *  但**不许盖住鼠标**，也不许盖住被右键的那一行内容。
 *  原来是把菜单左上角钉在 (clientX, clientY) 上——那正好把鼠标和右键点的那一行压在菜单底下，
 *  想点"图片设置…"却先点到被压住的行、或者一松手菜单就没了。 */
function placeNearPointer(menu,event){
  const margin=8,gap=8;
  const rect=menu.getBoundingClientRect();
  const width=rect.width,height=rect.height;
  const target=event.target instanceof Element?event.target.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,.vditor-ir__node')||event.target:null;
  const line=target?.getBoundingClientRect();
  const lineTop=line&&line.height?line.top:event.clientY;
  const lineBottom=line&&line.height?line.bottom:event.clientY;
  const clampLeft=()=>Math.max(margin,Math.min(event.clientX,window.innerWidth-width-margin));
  const hits=top=>{const left=clampLeft();return event.clientX>=left&&event.clientX<=left+width&&event.clientY>=top&&event.clientY<=top+height;};
  const fits=top=>top>=margin&&top+height<=window.innerHeight-margin;
  // 候选：①那一行下方 ②那一行上方 ③鼠标右侧 ④鼠标左侧。取第一个"放得下且不压鼠标"的。
  const candidates=[lineBottom+gap,lineTop-gap-height,event.clientY+16,event.clientY-height-16];
  let top=candidates.find(value=>fits(value)&&!hits(value));
  if(top===undefined){
    // 四条都放不下（极小窗口 / 超大菜单）：退回"屏内 + 不压鼠标"的最靠近位置。
    top=Math.max(margin,Math.min(lineBottom+gap,window.innerHeight-height-margin));
    if(hits(top))top=Math.max(margin,Math.min(lineTop-gap-height,window.innerHeight-height-margin));
  }
  const left=clampLeft();
  // ③④ 是靠左右避让的候选：左右位置要挪开鼠标，否则仍然压在鼠标上。
  if(top===candidates[2]||top===candidates[3]){
    const right=event.clientX+16,leftSide=event.clientX-width-16;
    menu.style.left=(right+width<=window.innerWidth-margin?right:Math.max(margin,leftSide))+'px';
  }else{
    menu.style.left=left+'px';
  }
  menu.style.top=top+'px';
}
/** RC1 判据之一：这份选区是不是"整篇编辑面"的形态（Blink 在右键不可编辑岛时造出来
 *  的假选区就是这个形状；用户 Ctrl+A 的真选区形状相同，靠"本次右键是否经过守卫"
 *  来区分，见 showContextMenu 的 liveRange）。 */
function wholeRootSelection(range,root){
  if(!range||range.collapsed||!root)return false;
  if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return false;
  const whole=document.createRange();whole.selectNodeContents(root);
  return range.compareBoundaryPoints(Range.START_TO_START,whole)<=0&&range.compareBoundaryPoints(Range.END_TO_END,whole)>=0;
}
/** RC7（2026-10-02 判决）：右键命中的链接。WYSIWYG/渲染层是 A[href]；IR 源码里链接
 *  地址在 .vditor-ir__marker--link（与 util.js openLink 的判定同一套）；右键落在链接
 *  节点壳（.vditor-ir__node[data-type=a]，罩着可见的链接文字）也算命中——用户最自然
 *  的手势就是右键链接文字本身。 */
function linkTargetAt(target){
  const anchor=target?.closest?.('a[href]');
  if(anchor){const raw=anchor.getAttribute('href')||'';return raw?{url:anchor.href,raw}:null;}
  const shell=target?.closest?.('.vditor-ir__node[data-type="a"]');
  const marker=target?.closest?.('.vditor-ir__marker--link');
  const source=marker||shell?.querySelector?.('.vditor-ir__marker--link');
  if(source){const url=source.textContent.trim();return url?{url,raw:url}:null;}
  return null;
}
/** RC7：复制链接地址。系统侧走 hostApi / 异步剪贴板 API（与 copyPlainText 同两条通道）；
 *  同时**页面内**派发一次带 dataTransfer 的 copy 事件——窗口里的监听者（含验收探针）
 *  不读系统剪贴板也能拿到地址；两条系统通道都失败时以提示兜底（地址可见，用户可自行
 *  复制），绝不抛错打断菜单流程。 */
async function copyLinkAddress(url){
  let stored=false;
  if(window.hostApi?.invoke){try{await window.hostApi.invoke('clipboard-write-text',{text:url});stored=true;}catch{/* 落到 webview 剪贴板 */}}
  if(!stored&&navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(url);stored=true;}catch{/* 页面内事件仍是可用的载荷 */}}
  let dispatched=false;
  try{
    const data=new DataTransfer();
    data.setData('text/plain',url);data.setData('text/uri-list',url);
    const event=new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true});
    event.__typoraLinkCopy=true;   // 页内既有 copy 监听（图片通道/表格矩形）不接管这次合成事件
    document.dispatchEvent(event);
    dispatched=true;
  }catch{/* 老内核没有 DataTransfer 构造器：两条系统剪贴板通道已尽力 */}
  if(!stored&&!dispatched)contextToast('复制失败，链接地址：'+url);
  return stored||dispatched;
}
function showContextMenu(api,event,{table,img,link,imageContext,guardCaret}={}){
  closeContextMenu();
  const saved=savedSelection(),context=table&&tableContext(api,event,table),menu=document.createElement('div');
  menu.id=CONTEXT_MENU_ID;menu.className='typora-editor-context-menu';menu.setAttribute('role','menu');menu.tabIndex=-1;
  const root=editorRoot(api);
  /** RC1（2026-10-02 判决）：动作时刻的"有效选区"解析器。菜单闭包里的 saved 是右键
   *  那一刻的快照——右键不可编辑岛时它正是 Blink 造的"整篇文档"假选区（补光标的
   *  setTimeout(0) 在菜单打开之后才落地，救不了闭包里的 saved），复制得全文/剪切删
   *  全文/粘贴插文档头都从这里来。动作时刻重读：
   *    · 活选区在编辑面里且非整篇形态 → 用活选区；
   *    · 整篇形态且本次右键经过守卫（guardCaret 存在）→ 假选区，用补光标的折叠点；
   *    · 活选区丢了 / 不在编辑面 → 补光标；再退打开时的快照。 */
  const liveRange=()=>{
    const selection=getSelection();
    if(selection?.rangeCount){
      const live=selection.getRangeAt(0);
      if(root&&root.contains(live.startContainer)&&root.contains(live.endContainer)){
        if(guardCaret&&wholeRootSelection(live,root))return guardCaret.cloneRange();
        return live.cloneRange();
      }
    }
    if(guardCaret?.startContainer?.isConnected&&guardCaret.endContainer?.isConnected)return guardCaret.cloneRange();
    return saved;
  };
  /** FC2/RC4 关后还原：焦点回编辑面、选区回 liveRange()（与菜单动作同一口径）。 */
  const restoreFromMenu=()=>{
    const rootNow=editorRoot(api);if(!rootNow)return;
    const range=liveRange();
    if(range&&range.startContainer?.isConnected&&range.endContainer?.isConnected){
      restoreSelection(range,api);
      // focus() 的选区覆盖是异步落下的（ensureCaretNearRightClick 的三轮实测），下一拍
      // 再钉一次；用户已把焦点挪去别处（focusout 关闭路径）时不再抢。
      setTimeout(()=>{
        if(!rootNow.isConnected)return;
        const now=document.activeElement;
        if(now&&now!==rootNow&&!rootNow.contains(now)&&now!==document.body)return;
        if(range.startContainer?.isConnected&&range.endContainer?.isConnected){
          const fresh=getSelection();fresh?.removeAllRanges();fresh?.addRange(range);
        }
      },0);
    }else rootNow.focus({preventScroll:true});
  };
  let closed=false;
  const closeVia=restore=>{
    if(closed)return;closed=true;
    cleanup();menu.remove();scheduleSurfaceCleanup(300);
    if(restore)restoreFromMenu();
  };
  // A picture can be a table cell's content. Keep both action groups in that
  // case; the old table-first branch silently hid image settings.
  if(img){
    addMenuButton(menu,['image-settings','图片设置…'],()=>{closeContextMenu();imageDialog(api,img);});
    addSeparator(menu);
    const alignTitle=document.createElement('div');alignTitle.className='typora-context-title';alignTitle.textContent='对齐';menu.append(alignTitle);
    const currentAlign=img.getAttribute('data-typora-align')||'left';
    for(const [value,label] of [['left','左对齐'],['center','居中对齐'],['right','右对齐']]){
      const button=addMenuButton(menu,['image-align-'+value,(currentAlign===value?'● ':'')+label],()=>{
        closeContextMenu();try{setImageAlign(api,img,value);}catch(error){contextToast(error.message);}
      });
      button.setAttribute('aria-checked',String(currentAlign===value));
    }
    addSeparator(menu);
  }
  // RC7：链接语义菜单。打开走 util.js openLink 的同一条 handler 通道（宿主侧
  // shell.openExternal）；复制见 copyLinkAddress。
  if(link){
    const title=document.createElement('div');title.className='typora-context-title';title.textContent='链接';menu.append(title);
    addMenuButton(menu,['open-link','打开链接'],()=>{
      closeContextMenu();
      try{window.handler?.emit?.('openLink',link.url);}catch(error){contextToast('打开链接失败：'+error.message);}
    });
    addMenuButton(menu,['copy-link','复制链接地址'],async()=>{
      closeContextMenu();
      try{if(await copyLinkAddress(link.url))contextToast('已复制链接地址');}catch(error){contextToast('复制链接地址失败：'+error.message);}
    });
    addSeparator(menu);
  }
  if(table){
    const title=document.createElement('div');title.className='typora-context-title';title.textContent='表格';menu.append(title);
    const structureButtons=[];
    for(const item of TABLE_ACTIONS)structureButtons.push(addMenuButton(menu,item,async action=>{
      closeContextMenu();try{tableEdit(api,context,action);}catch(error){contextToast(error.message);}
    }));
    // RC8：右键落在 table 本体且最近格也解不出（表格已失联/零格）→ 表结构项禁用，
    // 不再静默落到第 0 行（旧行为右键表底却删表头行）。
    if(context&&!context.resolvable)for(const button of structureButtons)button.disabled=true;
    addMenuButton(menu,['copy-table','复制表格到 Excel'],async()=>{
      closeContextMenu();
      try{await mediaRequest('copy-table',tablePayload(table));contextToast('已复制表格，可粘贴到 Excel。');}
      catch(error){contextToast(error.message);}
      finally{restoreFromMenu();}   // FC3：复制表格完成后把焦点/选区还给正文
    });
    addSeparator(menu);
  }
  for(const item of GENERAL_ACTIONS)addMenuButton(menu,item,async action=>{
    closeContextMenu();
    // RC2（2026-10-02 判决）：图片选中态非空时，菜单复制/剪切走图片剪贴板通道（与
    // Ctrl+C/Ctrl+X 同一条 mediaRequest('copy-images')），不再把选区当文本处理——
    // 旧路径把 <img> 连同源文档目录的相对路径写成断链 HTML。右键(button2)不再清图片
    // 选中态（见 mousedown 处理器），所以这里拿得到用户刚选的图。
    const items=imageContext?.selectedItems?.()||[];
    if(items.length&&(action==='copy'||action==='cut')){
      const elements=[...(imageContext.multiSelected||[])].filter(node=>node.isConnected);
      const single=imageContext.selectedImage?.isConnected?imageContext.selectedImage:null;
      if(single&&!elements.includes(single))elements.push(single);
      if(action==='copy'){
        try{
          await mediaRequest('copy-images',{items});
          contextToast(items.length>1?('已复制 '+items.length+' 张图片，可一次粘贴到微信、文档或网页。'):'已复制这张图片，可粘贴到微信、文档或网页。');
        }catch(error){contextToast('复制图片失败：'+error.message);}
        return;
      }
      // 剪切：先复制成功（确认），再删原图——先发复制（异步读字节/路径）再删，
      // 保证剪贴板拿到的是还在磁盘上的真实文件。
      let copied=true;
      try{await mediaRequest('copy-images',{items});}
      catch(error){copied=false;contextToast('剪切图片失败：'+error.message);}
      if(!copied)return;
      contextToast(items.length>1?('已剪切 '+items.length+' 张图片'):'已剪切这张图片');
      imageContext.clearImageSelection();
      const before=beginDocumentEdit(api);
      try{deleteImages(api,elements);}catch(error){contextToast(error.message);}
      finishDocumentEdit(api,before);
      return;
    }
    // RC1：动作时刻重读选区（解析规则见 liveRange），不再用打开菜单那一刻的快照。
    const range=liveRange();
    restoreSelection(range,api);
    try{
      if(action==='copy')document.execCommand('copy');
      else if(action==='copy-plain')await copyPlainText(api);
      else if(action==='cut')cutDocumentSelection(api);
      else if(action==='paste'){
        const before=beginDocumentEdit(api);let pasted=false;try{pasted=document.execCommand('paste');}catch{/* browser may deny execCommand paste */}
        if(!pasted&&window.hostApi?.invoke){
          const text=await window.hostApi.invoke('clipboard-read-text');
          restoreSelection(range,api);if(typeof text==='string')document.execCommand('insertText',false,text);
        }else if(!pasted&&navigator.clipboard?.readText){
          const text=await navigator.clipboard.readText();restoreSelection(range,api);document.execCommand('insertText',false,text);
        }
        finishDocumentEdit(api,before);
      }
    }catch(error){contextToast(error.message);}
  });
  document.body.append(menu);
  placeNearPointer(menu,event);
  // FC2/RC4（2026-10-02 判决）：菜单级关闭通道。此前只有"菜单外 mousedown"一条关闭
  // 路径——Esc 不关、失焦不关、编辑面滚动不关（fixed 菜单钉在视口上悬空），且菜单
  // 持焦期间 Ctrl+F 开不了查找（查找面板的窗口级监听只认"事件目标在编辑面里"）。
  const outside=click=>{if(!menu.contains(click.target))closeVia(false);};
  const onScroll=scroll=>{if(menu.contains(scroll.target))return;closeVia(true);};
  // FC2/RC4 focusout 关闭：焦点真离开（去别的控件/丢到 body）才关。**落进编辑面不算**——
  // 右键不可编辑岛（图片/公式/列表项图）时 ensureCaretNearRightClick 的补光标
  // setTimeout(0) 会在菜单打开后的下一拍 root.focus() 把焦点从菜单接回编辑面，那正是
  // 打开菜单的正常流程（76 场景实测：不豁免这一支，守卫目标的菜单开出来 0ms 就被
  // focusout 关掉——右键图片/公式从此不出菜单；正文右键不走守卫，所以只有它们红）。
  // 判定必须看 relatedTarget：focusout 派发时 document.activeElement 往往还停在过渡态
  // （BODY），要等 focusin 落到新目标之后才更新——只看 activeElement 会漏判这一拍。
  const onFocusOut=event=>{
    if(closed||menu.contains(document.activeElement))return;
    const going=event?.relatedTarget||document.activeElement;
    if(root&&(going===root||root.contains(going)))return;
    closeVia(true);
  };
  document.addEventListener('mousedown',outside,true);
  window.addEventListener('scroll',onScroll,true);
  menu.addEventListener('focusout',onFocusOut);
  const cleanup=()=>{
    document.removeEventListener('mousedown',outside,true);
    window.removeEventListener('scroll',onScroll,true);
    menu.removeEventListener('focusout',onFocusOut);
  };
  menu.__typoraClose=()=>closeVia(false);
  // 菜单自己的 keydown 只处理 Esc（关菜单+还焦），其余按键一律放行；Ctrl+F / Ctrl+H
  // 在关菜单、焦点回编辑面后**原样重放**一次——查找面板的监听器才认得这次按键。
  menu.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing)return;
    if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();
      closeVia(true);
      return;
    }
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&['f','h'].includes(event.key.toLowerCase())){
      const replay={key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey};
      closeVia(true);
      const rootNow=editorRoot(api);
      rootNow?.dispatchEvent(new KeyboardEvent('keydown',{...replay,bubbles:true,cancelable:true}));
    }
  });
  menu.focus({preventScroll:true});
}
function contextTableFromSelection(api){
  const root=editorRoot(api),selection=getSelection(),table=elementAt(selection?.anchorNode)?.closest?.('table');
  return table&&root?.contains(table)?table:null;
}
/** T3（2026-10-02 二轮判决）：当前选区是否已是**整行选态**——非折叠、落在表格里、
 *  矩形把所在行整行盖满（left=0 且 right=末列）。只有这种选态下 Ctrl+Backspace 才
 *  当"删行"用；格内折叠光标/部分选区一律放行原生词删（Typora/Word 习惯）。 */
function wholeTableRowSelected(){
  const selection=getSelection();
  if(!selection?.rangeCount||selection.isCollapsed)return false;
  const rect=tableRectangle(selection.getRangeAt(0));
  if(!rect)return false;
  const width=Math.max(0,...[...rect.table.rows].map(row=>row.cells.length));
  return rect.left===0&&rect.right>=width-1;
}

// 粘贴载荷 → 矩形网格。HTML 表格优先（应用内复制自带结构），否则按 TSV 纯文本切分。
// T7（2026-10-02 二轮判决）：只有带 CELL_MD_MARK 标记的 html（应用内 cellMarkdown 载荷）
// 才按 Markdown 记号还原；外来 html 表格（Excel/网页）没有标记，`* _ $ \` 等字符是
// 字面文本，必须走 plain 转义路径——旧代码把外来表格也当 markdown，Excel 里的
// a_b*c $x$ 粘进来会被 Lute 吃成斜体/公式。
function clipboardGrid(data){
  const html=data.getData('text/html');
  if(html){
    try{
      const template=document.createElement('template');template.innerHTML=html;
      const rows=[...template.content.querySelectorAll('tr')]
        .map(row=>[...row.cells].map(cell=>cellText(cell)))
        .filter(cells=>cells.length);
      if(rows.length){
        const marked=!!template.content.querySelector('['+CELL_MD_MARK+']');
        return{kind:marked?'markdown':'plain',rows};
      }
    }catch{/* 非表格 HTML 交给原生粘贴 */}
  }
  const text=data.getData('text/plain');
  if(!text||!/[\t\r\n]/.test(text))return null;
  const rows=text.replace(/\r\n?/g,'\n').split('\n').map(line=>line.split('\t'));
  while(rows.length&&rows[rows.length-1].every(cell=>!cell))rows.pop();
  return rows.length?{kind:'plain',rows}:null;
}
// 单元格文本 → IR/WYSIWYG 单元格子节点：一行 GFM 往返，让 $公式$、**粗体**、
// 图片语法与行内代码重新变成渲染节点。
// T7 返工（2026-10-02 三轮）：plain 路径改为"显示即原文"**直插文本节点**——旧法（md 转义
// 后过 Lute）实测会把 `\_` 原样留在 IR 文本里，用户看到 a\_b\*c \$x\$（转义被当字面写进
// 渲染层）。headless 实测（.zcode-tmp/lute-probe，真 Lute + 真 VditorIRDOM2Md）：
//   · 文本节点经 VditorIRDOM2Md **逐字**进存盘 md——文件里就是原文，一个反斜杠都不多；
//   · `_` 与单个 `*` 重开仍是字面（GFM intraword 规则）；
//   · `$x$` 这类 token 重开会按 md 语义解析成公式——IR 没有"字面 $ 又能原样存回"的表示
//     （`\$` 重开显示带反斜杠，同批实测），这是 IR 的语义上限，与粘贴当天的原样显示无关。
function cellNodes(editor,text,kind){
  const method=editor.currentMode==='ir'?'Md2VditorIRDOM':'Md2VditorDOM';
  const source=String(text??'');
  if(kind!=='markdown'){
    // 外来纯文本：原文直插（换行转 <br>），不转义、不做 md 解释。
    const parts=source.split(/\r\n?|\n/),nodes=[];
    parts.forEach((part,index)=>{
      if(index)nodes.push(document.createElement('br'));
      if(part)nodes.push(document.createTextNode(part));
    });
    return nodes;
  }
  // 应用内 markdown 载荷（cellMarkdown 记号）：仍走 Lute 往返（原样，勿动）。
  // 这里不能像纯文本那样直插——记号要以渲染节点形式还原；也不能把反斜杠先翻倍：
  // `a\| b` 翻倍后 Lute 读成"字面反斜杠 + 列分隔符"，整行被撑成 5 列（2026-09-12 实测）。
  // 所以只给"前面是偶数个反斜杠"的竖线补转义。
  let fenced=source.replace(/(\\*)\|/g,(match,slashes)=>slashes.length%2?match:slashes+'\\|');
  fenced=fenced.replace(/\r\n?|\n/g,'<br />');
  const template=document.createElement('template');
  template.innerHTML=editor.lute[method]('| v |\n| --- |\n| '+fenced+' |\n');
  // Lute 为 '| v |' 建出的表首行是表头占位 v，正文在最后一行
  const built=[...template.content.querySelectorAll('td,th')].pop();
  return built?[...built.childNodes]:[];
}
// 缺列补列、缺行补行：列要补到每一行（含表头），行插在与上一行同一个分区里，
// 否则新行会被塞进 thead 变成表头。
function growTable(table,rows,cols){
  for(const row of [...table.rows]){
    while(row.cells.length<cols)row.append(blankCell(document,row,row.cells[row.cells.length-1]));
  }
  while(table.rows.length<rows){
    const previous=table.rows[table.rows.length-1];
    if(!previous)break;
    // T2 同坑：末行在 thead（只有表头行的表）时，补出来的是数据行——落 tbody 首行前、
    // 用 td；旧代码 makeBlankRow 参照 th 会在 thead 后面再接一条 th 表头行。
    if(previous.parentElement?.tagName==='THEAD'){
      const body=ensureTableBody(table);
      body.insertBefore(makeBlankRow(document,previous,cols,true),body.firstElementChild);
      continue;
    }
    const fresh=makeBlankRow(document,previous,cols);
    previous.parentElement.insertBefore(fresh,previous.nextSibling);
  }
}
// 矩形落位：从光标所在格向右向下铺开，覆盖到的格整体改写，超出表格就扩表。
function pasteRectangle(api,cell,grid){
  const e=api.vditor,root=editorRoot(api),table=cell.closest('table');
  if(!root||!table)return false;
  const rows=grid.rows,width=Math.max(...rows.map(line=>line.length));
  if(!width)return false;
  const startRow=cell.parentElement.rowIndex,startCol=cell.cellIndex;
  const before=beginDocumentEdit(api);
  growTable(table,startRow+rows.length,startCol+width);
  // 先建好结构再写内容，避免读-写交错触发整表重排。
  const writes=[];
  for(let r=0;r<rows.length;r++){
    for(let c=0;c<rows[r].length;c++){
      const target=table.rows[startRow+r]?.cells[startCol+c];
      if(target)writes.push([target,cellNodes(e,rows[r][c],grid.kind)]);
    }
  }
  let lastCell=null;
  for(const [target,nodes] of writes){
    target.replaceChildren();
    if(nodes.length)target.append(...nodes);
    lastCell=target;
  }
  finishDocumentEdit(api,before);
  window.__typoraScheduleMath?.(table,{cdn:e.options.cdn,math:e.options.preview.math});
  root.focus({preventScroll:true});
  if(lastCell){
    const range=document.createRange();range.selectNodeContents(lastCell);range.collapse(false);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  }
  return true;
}
function pasteCellText(api,event){
  const e=api.vditor,root=editorRoot(api),s=getSelection(),data=event.clipboardData;
  if(event.defaultPrevented||!['ir','wysiwyg'].includes(e.currentMode)||!data||event.isComposing||e[e.currentMode].composingLock||!s?.rangeCount)return;
  const cell=elementAt(s.anchorNode)?.closest('td,th');
  if(!cell||!root.contains(cell)||elementAt(s.anchorNode)?.closest('code')||elementAt(s.focusNode)?.closest('code'))return;
  // K2（R9 E9-B 裁决）：anchor 格与 focus 格落在**同一张表**里的跨格选区（Excel 拖出的
  // 2×2 等）也按矩形落位。粘贴网格左上角对齐"两格 rowIndex/cellIndex 取 min"的左上格
  // （Excel 语义，不随拖拽方向变），走既有 pasteRectangle：矩形外既有格逐字保真、行数只
  // 可能因 growTable 扩表而变。旧门槛 `!cell.contains(s.focusNode)` 把跨格选区整个挡在
  // 门外，落进浏览器原生线性粘贴——字面 TAB 进格、行数错乱、选区外内容丢失（H1 实测：
  // 丙1 被清空、乙2 只剩残字、md 落盘带字面 ^I）。端点跨表或在表外（文段+表混合选区）
  // 仍不接管，交回原生粘贴；单格剪贴板（无 TAB/换行的纯文本）粘到跨格选区也维持原生
  // 线性行为——该语义 E9 裁决留待与 Typora 实机对照后再定（G-K2-3），本轮不强拍。
  let origin=cell;
  if(!cell.contains(s.focusNode)){
    const focusCell=elementAt(s.focusNode)?.closest('td,th'),table=cell.closest('table');
    if(!focusCell||!table||!table.contains(focusCell))return;
    origin=table.rows[Math.min(cell.parentElement.rowIndex,focusCell.parentElement.rowIndex)]?.cells[Math.min(cell.cellIndex,focusCell.cellIndex)]||cell;
  }
  const grid=clipboardGrid(data);
  if(!grid)return;   // 单格纯文本 / 图片 / 其它结构化 HTML：留给原生粘贴
  event.preventDefault();event.stopImmediatePropagation();
  pasteRectangle(api,origin,grid);
}
// K1（R9 E9-A 裁决）：CF_HTML 载荷里指向本机路径的图片（Word/Outlook 的 msohtmlclip
// 临时目录、file:/// 绝对路径、伪 CDN 域名回写形态）**粘贴时归档**。旧链路只在图进了 DOM
// 之后把 img.src 改写成伪 CDN 域名（util.js imageParser）让当次显示正常，存盘 md 仍写
// file:/// 临时路径、embedded-images 零归档——源程序一清临时目录（Word 退出即清）、文档
// 一搬家，图全部断链且无字节可救（H1 实锤：md 落 `![](file:///…)`、embedded-images/
// 未创建）。裁决驳回"落盘前改写"（dirty 闪变循环），改定本路径：
//   paste 拦截 → 识别 html 里的本地路径 img → IPC（'img' 消息 {id,path} 变体）请主进程
//   读字节、走 cur.images.insert 既有归档管线 → 把 src 改写为归档后的缓存 URL → 用改写
//   后的 html 构造 DataTransfer 自派发 ClipboardEvent('paste')，交给 vditor 原生管线完成
//   html→IR 转换（零 IR 手工改写；cutSelection 的自派发 cut 是同款手法）。
// 失败语义：任一张图读不到字节/IPC 失败 → 该 img 保留原引用（=现状），粘贴本身不被阻塞，
// warning 留 console。重入守卫用 isTrusted：自派发的重放事件 isTrusted=false，不再进这里。
// 只接管 file:///（含伪 CDN 域名）img：http(s):// 是用户自己贴的网络引用，不动。cid:
// （邮件内嵌引用）无本地字节可归档——R10 K1b 起按下方 CID_IMAGE_SRC 分支剥图保文字，
// 绝不让 `![](cid:…)` 永久断链引用落盘。文件载荷（截图 Ctrl+V）不碰：clipboardData.files
// 非空时直接放行，交给 vditor→uploadImages 的既有上传管线（字节不变，G-K1-6 红线）。
// 注册顺序：在 pasteCellText **之前**挂上——Word 表格（html 网格+图）粘进单元格时，先归档
// 重放、pasteCellText 在重放事件上做矩形落位，格里的图引用同样被归档；而 math-edit 的公式
// 粘贴拦截注册更早，光标在公式内时它先接管原始事件（本拦截不参与，公式粘贴字节不变）。
const LOCAL_IMAGE_SRC=/^(?:file:\/+|https:\/\/file(?:\+|%2b)\.vscode-resource\.vscode-cdn\.net\/)/i;
// K1b（R10 E10-P4/F4 取证）：cid: 是"无字节可剥离"的邮件 Content-ID 引用，与
// LOCAL_IMAGE_SRC（"有本地字节可归档"名单）语义相反——**独立常量、独立处置**，勿混入。
// 协议前缀判定即充分必要（真样本 cid:image007.png@01D20000.8F3D5A80 命中；不会误伤
// file:///、http(s)://、data:），判定在 DOM 层做（模板树 img 的 src 属性），不啃 CF_HTML 原文。
const CID_IMAGE_SRC=/^cid:/i;
// K1b 一次性 tip：只在**真的剥掉过至少一张 cid: 图**的那次粘贴弹，localStorage 去重（全局
// 只弹一次）；纯文字/纯归档粘贴不打扰。
function cidImagePasteTip(){
  try{if(localStorage.getItem('typora-k1b-cid-tip'))return;}catch{/* 存储不可用就照弹一次 */}
  try{localStorage.setItem('typora-k1b-cid-tip','1');}catch{/* 写不进则下次可能再弹，可接受 */}
  contextToast('邮件内嵌图片无法自动带入，请另存后再插入');
}
function pasteArchiveLocalImages(api,event){
  const e=api.vditor,root=editorRoot(api),data=event.clipboardData;
  if(!event.isTrusted||event.defaultPrevented||!data||!['ir','wysiwyg'].includes(e.currentMode))return;
  if(data.files&&data.files.length)return;   // 文件载荷走既有上传管线
  let html='';
  try{html=data.getData('text/html');}catch{return;}
  if(!html)return;
  let local,cid,holder;   // holder=装载载荷的模板树：重放闭包要序列化的是这棵（可能已改写 src / 剥过图 的）树
  try{
    const template=document.createElement('template');template.innerHTML=html;
    const images=[...template.content.querySelectorAll('img')];
    local=images.filter(img=>LOCAL_IMAGE_SRC.test(img.getAttribute('src')||''));
    cid=images.filter(img=>CID_IMAGE_SRC.test(img.getAttribute('src')||''));
    if(!local.length&&!cid.length)return;   // http(s):// 等其余引用：不接管，交回原生粘贴（现状不变）
    holder=template;
  }catch{return;}   // html 解析失败：不接管，交回原生粘贴
  const text=data.getData('text/plain');
  event.preventDefault();event.stopImmediatePropagation();
  // K1b：剥图保文字。剥**节点**而非剥标签（img.remove()）；img 独占的父块（Outlook 载荷
  // 形态 <p><img…></p>）删图后连块一起删，避免 html→IR 凭空多一个空行。同一载荷里
  // cid: 与 file:/// 并存时各走各分支：这里同步剥 cid:，下方归档照常改写 local 的 src，
  // 重放的 holder 同时携带两处处置。CF_HTML 长度头无需重算：重放 setData 由浏览器
  // 重新生成 CF_HTML（F4 取证 §5-1）。
  if(cid.length){
    for(const img of cid){
      const block=img.closest('p,div,li,td,th,h1,h2,h3,h4,h5,h6,blockquote');
      img.remove();
      if(block&&!block.textContent.trim()&&!block.firstElementChild)block.remove();
    }
    cidImagePasteTip();
  }
  const replay=()=>{
    try{
      const transfer=new DataTransfer();
      transfer.setData('text/html',holder.innerHTML);   // 归档失败的 img 保留原 src（=现状引用）
      if(text)transfer.setData('text/plain',text);
      root.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
    }catch(error){console.warn('剪贴板图片粘贴重放失败，本次粘贴未生效：',error);}
  };
  Promise.all(local.map(async img=>{
    const src=img.getAttribute('src');
    try{
      const markdown=await archiveImageFromPath(src,img.getAttribute('alt')||'');
      const url=/^!\[[^\]]*\]\(([^)]*)\)$/.exec(String(markdown).trim())?.[1];
      if(url)img.setAttribute('src',url);
      else console.warn('剪贴板图片归档返回异常引用，保留原引用：',src);
    }catch(error){console.warn('剪贴板图片归档失败，保留原引用：',src,error?.message||error);}
  })).then(replay,replay);   // 全部归档动作落定（成败皆然）后一次性重放，绝不吞掉这次粘贴
}


export function installMediaTools(api){
  // K1：本地路径图归档拦截排在 pasteCellText 之前（见 pasteArchiveLocalImages 注释里的顺序说明）。
  for(const mode of ['ir','wysiwyg'])api.vditor[mode].element.addEventListener('paste',event=>pasteArchiveLocalImages(api,event),true);
  for(const mode of ['ir','wysiwyg'])api.vditor[mode].element.addEventListener('paste',event=>pasteCellText(api,event),true);
  window.handler.on('media-result',value=>{const request=pending.get(value?.id);if(!request)return;pending.delete(value.id);if(value.error)request.reject(new Error(value.error));else request.resolve(value);});
  // v2.0.7：单击选中图片（Typora 式），Backspace/Delete 直接删除整图；
  // Alt+单击或双击仍走 vditor 原生"展开源码"路径，供需要改源码的场景。
  let selectedImage=null;
  // 多选集合：Ctrl+单击把图片加进/移出集合；集合非空时 Ctrl+C 一次把整组图片放进剪贴板
  // （主格式是文件拖放列表，微信/资源管理器/Chrome 系网页都能一次收下多张）。
  const multiSelected=new Set();
  // 【接管轮 2026-10-05·兜底】"用户上一次落在正文里的文本光标"。为什么要记：单击图片会把选区换成
  // `selectNode(img)`（整图选中），Ctrl 多选这条链过去用 `getSelection().removeAllRanges()` 把它
  // 清掉——但清完之后 `keepEditorFocused()` 保存到的是**已被清空的选区**，Blink 于是把光标停在
  // **文档开头**：紧接着按 Delete 吃掉第一行标题的 `# `（标题塌成正文）、打字打进文首（实测复现，
  // 装机 2.3.2 同样中招）。这里记下用户真正的文本落点，多选链路里把它还回去。
  let 上次文本光标=null;
  const clearImageSelection=()=>{
    if(selectedImage){selectedImage.classList.remove('typora-img-selected');selectedImage=null;}
    for(const img of multiSelected){img.classList.remove('typora-img-multi-selected');}
    multiSelected.clear();
  };
  /** Ctrl+多选只改高亮集合、不动文档，但**必须把键盘焦点留在编辑区**：
   *  实测（probe-img-del4.cjs）Ctrl+点多张之后编辑区 iframe 的 `document.hasFocus()` 变成 false，
   *  之后的 Backspace/Delete 等按键**全部落到外壳文档**，编辑区一个都收不到——用户报的
   *  「图片多选后按退格/删除没反应」就是这么来的（单选路径不会，因为它走 selectRange 顺手把焦点拿回来了）。
   *  光标位置原样保留（选区收成折叠态），免得下一次输入跑到文档开头；
   *  焦点落位是异步的，所以补选区放到下一个任务里做——与上面补右键光标同一套经验。 */
  const keepEditorFocused=()=>{
    const root=editorRoot(api);if(!root)return;
    const selection=getSelection();
    const saved=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;
    root.focus({preventScroll:true});
    setTimeout(()=>{
      const freshRoot=editorRoot(api);if(!freshRoot?.isConnected)return;
      const fresh=getSelection();if(!fresh)return;
      fresh.removeAllRanges();
      if(saved&&freshRoot.contains(saved.startContainer)){const range=saved.cloneRange();range.collapse(true);fresh.addRange(range);}
    },0);
  };
  const selectedItems=()=>{
    const items=[];
    for(const img of multiSelected){
      if(!img.isConnected){multiSelected.delete(img);continue;}
      items.push({src:img.getAttribute('src')||'',name:img.getAttribute('alt')||'图片'});
    }
    // 单击选中的那一张只有在"选区仍然罩着它"时才算数，否则用户在正文里选文字按 Ctrl+C
    // 会被图片抢走（多选集合不受此限：它是显式 Ctrl+点击出来的）。
    if(!items.length&&selectedImage?.isConnected&&selectionCovers(selectedImage)){
      items.push({src:selectedImage.getAttribute('src')||'',name:selectedImage.getAttribute('alt')||'图片'});
    }
    return items;
  };
  const selectionCovers=img=>{
    const selection=getSelection();
    if(!selection?.rangeCount||selection.isCollapsed)return false;
    try{return selection.getRangeAt(0).intersectsNode(img);}catch{return false;}
  };
  const context = {multiSelected, selectedItems, clearImageSelection, get selectedImage(){return selectedImage;}};
  installImageMultiCopy(api, context);
  const imageAt=event=>{const target=elementAt(event.target);const img=target?.closest?.('img');return img&&editorRoot(api)?.contains(img)&&!img.closest('.katex,.emoji')?img:null;};
  // ── 图片节点：展开态与"图片之后"的落点（2026-10-02 用户报两条，探针见
  //    scripts/acceptance/probe-image-click-v3.cjs / probe-image-paste-tail.cjs /
  //    probe-image-blankzone.cjs）─────────────────────────────────────────────────
  //  形状：Markdown 图是 `SPAN.vditor-ir__node[data-type="img"]`（子节点=一串 marker，
  //  折叠态 0 宽，末尾是 IMG）；正文里直接写 `<img …>` 的是
  //  `DIV.vditor-ir__node[data-type="html-block"]`（两个子节点：源码 pre.marker--pre
  //  + 不可编辑的渲染岛 pre.vditor-ir__preview，图片在岛里）。
  const imageOwner=img=>img?.closest?.('.vditor-ir__node[data-type]')||null;
  /** 节点所在的那个**顶层块**（root 的直接子元素）：md 图是它所在的 P，HTML 图块是它自己。 */
  const ownerBlock=(root,owner)=>{let block=owner;while(block&&block.parentElement&&block.parentElement!==root)block=block.parentElement;return block&&block.parentElement===root?block:null;};
  /** 节点自己的源码容器：md 图取 `--link` 那格（路径，vditor 原生展开也把光标放这儿），
   *  HTML 图块取源码 code。 */
  const ownerSource=owner=>owner.querySelector('.vditor-ir__marker--link')||owner.querySelector('pre.vditor-ir__marker--pre code')||owner.querySelector('code[data-type]')||null;
  const 首个文本=el=>el?[...el.childNodes].find(node=>node.nodeType===3)||null:null;
  // R11（2026-10-04 辩论裁决）：用户显式展开过的图片/HTML 块节点名册。为什么要自建：
  // vendored vditor 的 Ce（index.min.js，IR 构造时挂在编辑面 blur 上）**类型盲**摘掉第一条
  // --expand——真实失焦（点工具栏/切窗口/输入法弹层）100% 折叠，不依赖任何竞态（装机取证
  // 4/4）；math-edit 的公式名册也只认公式。用户打开的检视态挂在「焦点在不在」这种隐式环境
  // 条件上，等于契约随时被一次通知作废。这里登记用户手势展开的 owner：blur 同事件补挂
  // （本模块安装晚于 vditor 构造，同元素同相位按注册序在 Ce 之后执行，帧内补回无可见缝隙）；
  // Esc 收起；点正文别处由 vditor B() 的点击收起天然完成，事后出册。
  const 用户展开=new Set();
  /** 出册并收起（Esc 路径）：摘类前先把光标救出将隐藏的源码（独立防线：任何收起都不得
   *  把光标困进 display:none 的文本——公式族 R10-P8 病例 4 同源缺陷）。 */
  const 收起用户展开=()=>{
    for(const owner of [...用户展开]){
      用户展开.delete(owner);
      if(!owner.isConnected)continue;
      const s=getSelection();
      if(s?.rangeCount&&s.focusNode&&owner.contains(s.focusNode)){
        const range=document.createRange();range.setStartAfter(owner);range.collapse(true);
        s.removeAllRanges();s.addRange(range);
      }
      owner.classList.remove('vditor-ir__node--expand');
    }
  };
  /** blur 补挂（通道 A 堵口）：Ce 摘掉的那条若在名册里，这里同事件内补回。 */
  const 钉住用户展开=()=>{
    for(const owner of [...用户展开]){
      if(owner.isConnected)owner.classList.add('vditor-ir__node--expand');
      else 用户展开.delete(owner);
    }
  };
  /** 点正文别处之后清理：被 B() 收起（或重渲染失联）的成员出册，防止后续 blur 把它复活。 */
  const 用户展开清理=()=>{
    for(const owner of [...用户展开])
      if(!owner.isConnected||!owner.classList.contains('vditor-ir__node--expand'))用户展开.delete(owner);
  };
  /** 确定性展开：连点（detail≥2）与点 HTML 图块空白时用。
   *  为什么不能交给 vditor 原生（`B()`，index.min.js 1:83237）：它每次点击都先把全文档的
   *  `vditor-ir__node--expand` **摘干净**，再看"当前 range 的 startContainer 在不在某个
   *  vditor-ir__node 里"决定重加。连点时第 2 下点击把源码行展开、图片被推下去，第 3 下
   *  常常落到节点外——于是"刚展开又被摘回去"，连点次数是奇是偶决定成败。用户看到的
   *  就是"高频率点击有概率展不开源码"（实测：连点 3/5 次终态=折叠，2/4 次=展开）。 */
  const 展开图片节点=(root,owner,光标=true)=>{
    if(!root.contains(owner))return false;
    for(const node of root.querySelectorAll('.vditor-ir__node--expand')){node.classList.remove('vditor-ir__node--expand');用户展开.delete(node);}
    owner.classList.add('vditor-ir__node--expand');
    用户展开.add(owner);
    owner.classList.remove('vditor-ir__node--hidden');
    if(!光标)return true;
    const text=首个文本(ownerSource(owner));
    if(!text)return false;
    const range=document.createRange();range.setStart(text,0);range.collapse(true);selectRange(root,range);
    return true;
  };
  /** 点（或它的祖先链）落在**这个图片节点**里吗——图片本体、源码行（marker/code）、
   *  渲染岛都算。展开态下连点的第 3 下往往落到源码行上（源码一出现，图片被推下去），
   *  这条判据让那一支也能被认出来。连点的第 3 下还可能落到**图片所在那一段的空白**上
   *  （实测 probe-image-click-timeline.cjs：target 是 P）——那一支单独标 `空块`，
   *  只认"这一段里只有这一个图片节点、其余全是空白"，免得抢走正文里双击选词的语义。 */
  const 图片节点At=event=>{
    const root=editorRoot(api),target=elementAt(event.target);
    if(!root||!target||!root.contains(target))return null;
    const owner=target.closest?.('.vditor-ir__node[data-type="img"],.vditor-ir__node[data-type="html-block"]');
    if(owner&&owner.querySelector('img'))return {owner,源码上:!!target.closest?.('code[data-type],.vditor-ir__marker'),空块:false};
    let block=target;
    while(block&&block.parentElement&&block.parentElement!==root)block=block.parentElement;
    if(!block||block.parentElement!==root)return null;
    const nodes=[...block.querySelectorAll('.vditor-ir__node[data-type]')];
    if(nodes.length!==1||!nodes[0].querySelector('img'))return null;
    const doc=block.ownerDocument,walker=doc.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    let text=null;
    while((text=walker.nextNode()))if(!nodes[0].contains(text.parentElement||text)&&text.data.replace(/[\s\u200b]/g,''))return null;
    return {owner:nodes[0],源码上:false,空块:true};
  };
  // —— 收束轮1（2026-10-02，用户令「取消双重光标」）：图片右侧空白的可见性从「root 层
  // 逻辑位＋合成线」换成「ZWSP 零宽文本锚＋原生 caret」——Blink 对普通文本节点内部位置
  // 原生建 caret 框，锚本身就是看得见的那根线，不再画任何合成元素（.typora-image-after-caret
  // 修饰类从此不再产生；index.css 的 .typora-selection-endpoint 一族留给 math-select-reveal）。
  // 同习语先例：vendored 空段 <p>ZWSP</p>、本文件 Enter 图后新段、软换行脚手架 text\nZWSP
  // （typora-patches.js patchSoftBreak——插入/清除/IME 三套时机照抄它）。锚语义不变：紧随
  // 图片节点的逻辑位；Lute 序列化剥净不落 md（S0-1 三形态逐字节实证：段内/root 层均剥）、
  // IR 重放即除锚（重放产物不含 ZWSP——owner 被换块时锚随块消失，天然生命周期，不挂 RO）。
  let 锚=null,组合中=false;   // 锚={z,root,owner,html,服役}；服役=false＝Enter 让位后的遗锚（只当撤销重显落点）
  const 是零宽锚=节点=>!!节点&&节点.nodeType===Node.TEXT_NODE&&节点.data.length===1&&节点.data.charCodeAt(0)===0x200b;
  /** 立零宽锚：在 owner 之后放（或复用）一个 ZWSP 文本节点，登记为当前锚。幂等：紧随
   *  owner 已有同款节点则复用（click 尾声重钉/撤销后回锚不叠节点）；别处的旧锚先归位
   *  摘除（单锚制）。不建任何元素、不挂 RO。 */
  const 立零宽锚=(root,owner)=>{
    if(!root||!owner?.isConnected||!owner.parentNode)return null;
    const 复用=是零宽锚(owner.nextSibling)?owner.nextSibling:null;
    if(锚&&(!复用||锚.z!==复用))除零宽锚(true);
    const z=复用||document.createTextNode('\u200b');
    if(!复用)owner.after(z);
    锚={z,root,owner,html:owner.getAttribute('data-type')!=='img',服役:true};
    return z;
  };
  /** 锚仍被选区占着吗：折叠且落在锚内（z@0；打字后 z@n 同理），或与 z@0 数值异形几何
   *  同点（元素边界位会被 resolve 归一化成「下一源节点 offset 0」，md 图形态必现——
   *  沿用旧 锚命中 的 compareBoundaryPoints 边界点比较）。 */
  const 锚仍占=()=>{
    const s=getSelection();
    if(!s?.rangeCount||!s.isCollapsed||!锚?.z.isConnected)return false;
    const r=s.getRangeAt(0);
    if(r.startContainer===锚.z)return true;
    try{
      const a=document.createRange();a.setStart(锚.z,0);a.collapse(true);
      return r.compareBoundaryPoints(Range.START_TO_START,a)===0;
    }catch{return false;}
  };
  /** 除零宽锚：仅当「选区已离开锚且非 IME 组合期」才静默摘节点——组合期细则抄
   *  patchSoftBreak 的 removePlaceholder（typora-patches.js:680-696）：组合区间挂在该
   *  文本节点上时节点一变，整个组合被 Blink 作废并在节点开头重起。归位=true：选区还压
   *  在锚上时先把它放回锚的逻辑位（owner 之后边界）再摘——只在马上要另立新锚的场合用。 */
  const 除零宽锚=归位=>{
    if(!锚)return;
    const {z,root}=锚;
    if(!z.isConnected){锚=null;return;}
    if(组合中)return;
    const r=(getSelection()?.rangeCount)?getSelection().getRangeAt(0):null;
    const 压着=!!r&&(r.startContainer===z||r.endContainer===z);
    if(压着&&!归位)return;
    if(压着){
      const rr=document.createRange();
      rr.setStart(z.parentNode,[...z.parentNode.childNodes].indexOf(z));rr.collapse(true);
      selectRange(root,rr);
    }
    z.remove();锚=null;
  };
  /** 无守卫摘锚：调用方保证紧随其后重设选区（拖选接力/防御位），只剩 IME 一道闸。 */
  const 摘锚节点=()=>{
    if(!锚)return;
    const z=锚.z;锚=null;
    if(z.isConnected&&!组合中)z.remove();
  };
  /** 真输入后的锚处理（照抄 patchSoftBreak 的时机三则）：IME 组合期与 isComposing 拍、
   *  非信任事件一概不动；只有新位置真落了字才摘——光标在 z@0 打字＝字插在 ZWSP 之前
   *  （紧贴图片后，语义正确），截掉锚文本尾端的 ZWSP、光标原位重钉；选区已在别处的真
   *  输入（含 Enter 让位后的遗锚）则整节点静默摘除。 */
  const 锚输入摘除=event=>{
    if(组合中||(event&&event.isComposing))return;
    if(event&&event.isTrusted===false)return;
    if(!锚)return;
    const {z,root}=锚;
    if(!z.isConnected){锚=null;return;}
    // 【U-088】图片节点即顶级块（html-block，含右键图片设置缩放回写的 <img … data-typora-scale>）
    // 形态：owner 就是顶级块，z 落在编辑面 root 层的裸文本位——真落第一个字后若只截 ZWSP
    // 留裸文本节点，vendored P()/F9() 找不到 data-block 祖先 ⇒ root.innerHTML 全篇重放，
    // Lute 把裸文本与紧随的块并成一行（标题被吞成「插### 标题甲」、H3 降级 P、列表/引用
    // 同毁；对抗轮前后置块序实证）。懒升格：首个真实文本输入把字升格成图片块之后的独立
    // <p data-block="0">，选区移到新段文本末、摘 z、不 preventInput——vendored 按"新块"
    // 自己单块 spin（值/撤销栈走正常链；对抗轮装机实证第 2/3 字只改同一块）。
    // 判据用显式「z 不在图片所在顶级块内」（对抗轮修订1：旧"块外无文字"在 md 族上恒为假
    // ——用户刚打的字本就在 owner 之外、自我否决；显式判据把"md 族保持行内语义"从巧合
    // 变成结构保证，三条对照腿逐字节相同）。段中图/图后同段文字：z 在 <p> 内 ⇒ contains
    // ⇒ 不升格。已知边界（对抗轮挂账）：IME 组字上屏那一拍 DOM 已被 vendored 先 spin，
    // 本支够不着（A-042 另立）；Enter（insertParagraph）不在此处理（138/147 通道本就正常）。
    if(event&&event.inputType!=='insertParagraph'){
      let 块=锚.owner&&锚.owner.isConnected?锚.owner:null;
      while(块&&块.parentNode&&块.parentNode!==root)块=块.parentNode;
      if(块&&块.parentNode===root&&!块.contains(z)){
        const 文本=z.data.replace(/\u200b/g,'');   // 修订2：ZWSP 在头/中被吃一并兜住
        if(文本){
          const 段=document.createElement('p');
          段.setAttribute('data-block','0');
          块.after(段);
          段.append(document.createTextNode(文本));
          const rr=document.createRange();rr.setStart(段.firstChild,文本.length);rr.collapse(true);
          selectRange(root,rr);
          z.remove();锚=null;
          return;
        }
      }
    }
    const r=(getSelection()?.rangeCount)?getSelection().getRangeAt(0):null;
    const 在锚内=!!r&&(r.startContainer===z||r.endContainer===z);
    if(!在锚内){z.remove();锚=null;return;}
    if(!(z.data.length>1&&z.data.charCodeAt(z.data.length-1)===0x200b))return;   // 还没真落字：锚继续服役
    const off=r.startContainer===z?r.startOffset:z.data.length;
    z.data=z.data.slice(0,-1);
    const rr=document.createRange();rr.setStart(z,Math.min(off,z.data.length));rr.collapse(true);
    selectRange(root,rr);
    锚=null;    // 已成普通文本
  };
  /** 光标放到"图片之后"：点图片右侧空白该落的地方（2.2.16 契约）。立零宽锚后选区落
   *  z@0——Blink 原生画 caret（收束轮1 起合成光标取消）。html 图块**不展开源码**（R11
   *  第二波裁决不变：旧"展开+光标进源码"正是案一吞块入口，且实测光标落点还会被后续
   *  处理器重置到源码开头）；click 尾声"重钉"语义不变：md 图锚在终态被后续处理器改写
   *  成「整图选中」时，在最后一个能拦的位置再钉回 z@0，保住"光标在图片之后"。 */
  const 落到图片之后=(root,owner,html)=>{
    if(root&&owner?.isConnected&&owner.parentNode){
      const z=立零宽锚(root,owner);
      if(z){
        const range=document.createRange();
        range.setStart(z,0);range.collapse(true);selectRange(root,range);
      }
    }
    return true;
  };
  /** 命中"图片的空白带"吗：点在这一块里、没点在图片/源码上，且落在图片**右侧或下方**。
   *  判据做成"先看原生会落到哪，只有原生落点不对才接管"——点图片后面正文里两个词中间、
   *  点展开态的源码，原生落点本来就是对的，一根手指都不动（这样表格单元格、图文同段、
   *  引用块里的图都不会被误伤）。 */
  let 空白带接管=null;   // mousedown 接管过的空白带：click 那一步还要再挡一次 vditor 的岛分支
  let 按下坐标=null;     // 【U-086】R-1 拖拽闸：mousedown 记坐标，click 位移 ≤4px 才算单击（对抗轮终版强制修订）
  // W4 返工（2026-10-02 三轮）：第 3 击 mousedown 时刻的"是否存在非折叠词/段选区"快照。
  // 原生三击选段在 mousedown 默认动作里改写选区——点在不可编辑的渲染岛上时实测会被
  // 折到节点边界，click 那一刻再读 getSelection() 已经晚了；放行与否得看这份快照。
  let 三击词选=null;
  // 【接管轮 2026-10-05·问题2】"这一次**按下之前**，这张图是不是已经带着可见的选中框"——
  // 判据就是用户自己能看见的那圈蓝框（`typora-img-selected`），不含任何时间项、不含"已展开"。
  // 为什么需要按下时刻的快照：mousedown 的选中分支在**按下**那一刻就把 selectedImage 指到这张
  // 图，click 时刻再读它恒为真，分不出"第 1 下"和"第 2 下"。
  // 为什么绑可见选中态而不是"上一次点击的手势记录"：Esc（收起+清选）、Delete 失败路径这类
  // 打断**清掉了画面却没产生 click**，手势记录会残留成"下一击直接出源码"（画面上明明没有蓝框）；
  // 绑可见态则天然随画面复位——**蓝框在 ⇒ 下一击必出源码；蓝框不在 ⇒ 这一击只上蓝框**。
  let 单击快照=null;
  const 图片空白带=event=>{
    const root=editorRoot(api),target=elementAt(event.target),doc=document;
    if(!root||!target||!root.contains(target))return null;
    if(target.closest?.('img'))return null;                                   // 图片本体：走选中/展开
    // 节点要么在命中链上（裸 HTML 图块的渲染岛、展开态的源码），要么在**同一块里**——
    // md 图右侧那条空白在块里、节点**外**（节点盒就是图片盒），从 target 往上找是找不到的
    // （2026-10-02 实测：点图右 30px 命中 P，owner 找不到 → 补丁空转、落点仍摇摆）。
    // 一块里有多张图（表格单元格那种）时取"离点击点最近的那张"，且必须离得够近，
    // 免得把远处另一张图当成目标。
    let block=target;
    while(block&&block.parentElement&&block.parentElement!==root)block=block.parentElement;
    if(!block||block.parentElement!==root)return null;
    // 候选节点：裸 HTML 图块是"节点即块"（节点本身不是自己的后代，必须显式带上），
    // md 图则在块的里面。都只认最里层、且确实含 <img> 的。
    const 全集=[...(block.matches?.('.vditor-ir__node[data-type]')?[block]:[]),...block.querySelectorAll('.vditor-ir__node[data-type]')];
    const 候选=全集
      .filter(node=>!node.querySelector('.vditor-ir__node[data-type]'))          // 只认最里层节点
      .filter(node=>node.querySelector('img'));
    if(!候选.length)return null;
    const 链上=target.closest?.('.vditor-ir__node[data-type]');
    let owner=null,img=null,近=Infinity;
    for(const node of 候选){
      const 图=node.querySelector('img'),b=图.getBoundingClientRect();
      if(!b.width||!b.height)continue;
      const dx=Math.max(b.left-event.clientX,0,event.clientX-b.right);
      const dy=Math.max(b.top-event.clientY,0,event.clientY-b.bottom);
      const d=dx*dx+dy*dy;
      if(node===链上||d<近){近=d;owner=node;img=图;}
    }
    if(!owner||(候选.length>1&&近>60*60))return null;
    const ib=img.getBoundingClientRect();
    const bb=block.getBoundingClientRect();
    if(event.clientX<bb.left-2||event.clientX>bb.right+2)return null;         // 块外的左右：交给原生（含文末空白）
    if(event.clientY<ib.top-2)return null;                                    // 图片上方：不动
    if(event.clientY<=ib.bottom+2&&event.clientX<=ib.right+1)return null;     // 左侧同一行 / 图片本身：不动
    if(event.clientY>bb.bottom+2)return null;                                 // 块下方：交给原生（点文末空白 → 新段）
    const html=owner.getAttribute('data-type')!=='img';
    const native=doc.caretRangeFromPoint?doc.caretRangeFromPoint(event.clientX,event.clientY):null;
    if(native){
      const at=native.startContainer,el=elementAt(at);
      if(el&&root.contains(el)){
        // 只在**展开态**下承认"点了源码"：折叠时源码是 0×0 的隐藏块，Blink 的
        // caretRangeFromPoint 照样会落到它里面（实测 probe-image-blankzone.cjs：裸 HTML
        // 图块上点图右侧空白，原生落点是隐藏源码的 offset 0＝图片**前面**，接着打字就
        // 打进 <img> 标签里）。那种"落在源码里"恰恰是要修的对象，不是要豁免的对象。
        if(owner.classList.contains('vditor-ir__node--expand')&&el.closest('code[data-type],.vditor-ir__marker'))return null;
        if(at&&nodeAfter(owner,at))return null;                                // 原生已经在图片之后：不插手
      }
    }
    return {owner,html};
  };
  /** `container` 在 `node` 之后（文档序），且不是 node 的后代。 */
  const nodeAfter=(node,container)=>{
    if(!container||container===node)return false;
    if(node.contains(container))return false;
    const rel=node.compareDocumentPosition(container);
    return !!(rel&Node.DOCUMENT_POSITION_FOLLOWING)&&!(rel&Node.DOCUMENT_POSITION_CONTAINED_BY);
  };
  // 右键落在**不可编辑的预览岛**（图片、行内/块公式渲染出的 KaTeX、图表）上时，Blink 的
  // 原生默认行为是 SelectionController::SetSelectionFromNone()：编辑区当前没有选区，它就把
  // 选区设成"整篇文档的内容"、光标落到第 0 个位置。实测（scripts/acceptance/
  // probe-image-rightclick.cjs）：右键图片后光标被扔到视口上方 7059px 的文档开头，
  // 用户报的"右键图片，光标直接跳到文章开头"就是它；此后第一次输入会插在文章最前面。
  // 左键点图片我们一直有 preventDefault（还自己造选区），右键这条路径漏了。
  // 只挡岛上的右键：正文/表格/代码块/标题上的右键保持 Blink 原生语义（光标落到点击处），
  // 我们的菜单动作（复制/剪切/粘贴）本来就是围绕那份选区工作的，不能一起改掉。
  // 判据（scripts/acceptance/probe-rightclick-targets.cjs 逐类实测得来）：
  //   · `isContentEditable===false` → 不可编辑的预览岛（pre.vditor-ir__preview 里的
  //     KaTeX 渲染等）；
  //   · `closest('img,.katex')` → 图片本体与公式渲染。**注意不能只看 isContentEditable**：
  //     IR 里行内图片的 `img.isContentEditable` 实测是 true（它继承了可编辑父级），
  //     但它照样中招；
  //   · 命中点正好是"包着图片的 vditor-ir__node 外壳"时也算（点在外壳的留白上）。
  // 正文文字、标题、表格单元格、代码块、引用块、分隔线都不在此列——那里右键该按 Blink
  // 原生语义把光标放到点击处，不能一起挡。
  const rightClickNeedsGuard=event=>{
    const root=editorRoot(api),target=elementAt(event.target);
    if(!root||!target||!root.contains(target))return false;
    if(target.isContentEditable===false)return true;
    if(target.closest?.('img,.katex'))return true;
    return !!(target.matches?.('.vditor-ir__node')&&target.querySelector('img,.katex'));
  };
  /** 守卫的第二半：把被 Blink 摆到"文档开头"的光标，改放到被右键的那个岛前面的块边界上。
   *  为什么光有 preventDefault 不够（三轮探针实测）：
   *    · WYSIWYG 下 Blink **在派发 mousedown 之前**就把选区改成"整篇文档"（只按下、不抬起，
   *      光标已经在第 0 块），preventDefault 拦不住一个已经发生的选区变更；
   *    · IR 下多数目标 preventDefault 就够，但原样 HTML 图片块、代码高亮岛、块公式节点
   *      在 mouseup/contextmenu 那一步还会被**再摆一次**（时间线上：按下时补到块 4，
   *      抬手后又回块 0；素材上的图是补到块 111、抬手后回块 0，光标离视口 7059px）。
   *  所以 mousedown 与 contextmenu 两处都调用本函数，各自延到下一个任务里落地
   *  （`focus()` 的覆盖是异步的：先 focus 再在 microtask 里补选区仍被覆盖）。
   *  代价（如实记账）：光标本来就停在**文档最开头**时，这两种情形在代码里长得一模一样，
   *  无法区分，所以此时也会把它挪到被右键的块旁边。 */
  const ensureCaretNearRightClick=event=>{
    const root=editorRoot(api),selection=getSelection();
    if(!root||!selection)return null;
    const live=selection.rangeCount?selection.getRangeAt(0):null;
    // 该补的情况只有两种：① 编辑区里根本没有光标；② 光标正好在"文档最开头"——那正是
    // Blink 刚替我们摆出来的那个位置（WYSIWYG 实测 blockIndex 0 / offset 0）。用户自己
    // 放在别处的光标一个字都不动（实测：WYSIWYG 里光标在第 9 块时右键图片，光标留在第 9 块）。
    const atVeryStart=()=>{
      if(!live||!live.collapsed||live.startOffset!==0)return false;
      if(live.startContainer===root)return true;
      const first=root.firstElementChild;
      return !!(first&&(first===live.startContainer||first.contains(live.startContainer)));
    };
    const inside=!!live&&live.startContainer&&root.contains(live.startContainer);
    // RC1（2026-10-02 判决）："整篇编辑面"的非折叠选区也是 Blink 在 mouseup/contextmenu
    // 那一步重摆出来的假形态之一（此时活选区在 root 里、却罩住全文）。守卫只发生在
    // 不可编辑岛上，用户真 Ctrl+A 全选后右键岛的场景远假于真——按假选区处理。
    if(inside&&!atVeryStart()&&!wholeRootSelection(live,root))return null;
    // 落点固定取"这个岛所在顶层块的边界之前"（root 层、offset = 块下标）。
    // 为什么不用 caretRangeFromPoint 去解一个"看着更自然"的位置：岛内部解出来的点会被
    // Blink 归一化回 non-editable 的岛里，**接着打字会把字打到文档最前面**——实测
    // （probe-caret-strategy.cjs，素材上的真图）三种补法里只有块边界这一种不打坏文档开头：
    //   caretRangeFromPoint → 落点 P/offset 4 → 最终光标在岛里（editable=false）→ 打出 `# Q第一部分…`
    //   邻近可编辑文本     → 同上，也打出 `# Q第一部分…`
    //   块边界             → 落点 PRE/offset 111（root 层、可编辑）→ 文档开头一字不变
    // 块边界在 root 里，永远可编辑；打字会在图片旁边新起一块，可预期。
    const target=elementAt(event.target);
    // RC5（2026-10-02 判决）：爬升先看 td/th——格内的渲染岛（公式/图片）右键，光标要落在
    // **这个格的边界**，不能按旧逻辑一路爬到顶层块（=整张 table 之前），那会把光标搬出表格。
    const cell=target?.closest?.('td,th');
    const range=document.createRange();
    if(cell&&root.contains(cell)){
      range.selectNodeContents(cell);range.collapse(true);
    }else{
      let block=target;
      while(block&&block.parentElement&&block.parentElement!==root)block=block.parentElement;
      if(!block||block.parentElement!==root)return null;
      range.setStartBefore(block);range.collapse(true);
    }
    // 为什么放到下一个任务里补，而不是就地 selectRange：`focus()` 会把光标摆到内容开头，
    // 而且这一步是**异步**落下来的——实测（probe-caret-restore.cjs）先 focus 再 microtask
    // 里补选区仍被覆盖（setfirst / focusmicro 两个变体都停在块 0），把补选区放到下一个
    // 任务里才生效（focustask 变体：图片落到块 5、代码岛落到块 7，都在视口里）。
    setTimeout(()=>{
      if(!root.isConnected)return;
      root.focus({preventScroll:true});
      const fresh=getSelection();
      if(!fresh)return;
      fresh.removeAllRanges();fresh.addRange(range);
    },0);
    // RC1（2026-10-02 判决）：把补光标的落点交给调用方——右键菜单的动作要用它当
    // "整篇假选区"的替代品（见 showContextMenu 的 liveRange）。
    return range;
  };
  document.addEventListener('mousedown',event=>{
    if(event.button===0)按下坐标={x:event.clientX,y:event.clientY};   // 【U-086】R-1 拖拽闸用（click 时算位移）
    if(event.button===2&&rightClickNeedsGuard(event)){event.preventDefault();ensureCaretNearRightClick(event);}
    // 【接管轮 2026-10-05·问题2】按下之前这张图**已经带着可见选中框**吗——第 2 下点击据此
    // 判定。快照必须在选中分支（下面 18xx 行那处 clearImageSelection/selectedImage=图）之前取，
    // 而且每次都重写：点正文/工具栏/另一张图/空白带/拖选/Ctrl 取消都会在自己的 mousedown 里
    // 把它换成 null 或换图，不需要任何"消费"动作，也就不会被任何早退分支吞掉。
    if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&event.detail<2){
      const 图=imageAt(event);
      单击快照=图&&selectedImage===图&&图.classList.contains('typora-img-selected')?{img:图}:null;
    }else 单击快照=null;
    // W4 返工（2026-10-02 三轮）：第 3 击的 mousedown——在原生三击选段改写选区**之前**，
    // 把"此刻是否存在非折叠词/段选区"（上一击双击选词留下的状态）记进快照。
    if(event.detail===3){
      const live=getSelection();
      三击词选={t:Date.now(),有选区:!!(live?.rangeCount&&!live.isCollapsed)};
    }
    // Ctrl+单击：把图片加入/移出多选集合（不改动文档、不移动光标）。
    // W5（2026-10-02 二轮判决）：detail<2 限制放开（只对图上生效，下面有 imageAt 门）——
    // Ctrl 快速两击同图是"选入再取消"的连续手势，第二击 detail=2 也必须进这条多选分支
    // 完成取消；旧代码把它漏给 click 的 detail≥2 分支，源码被弹出来。
    if(event.button===0&&(event.ctrlKey||event.metaKey)&&!event.altKey){
      const img=imageAt(event);
      if(img){
        event.preventDefault();
        // 【接管轮 2026-10-05·多选指示框】语义要在**迁移之前**定下来：这一次 Ctrl 点的是不是
        // 刚才那张"普通单击选中（实线框）"的图。
        const 刚才是实线=(selectedImage===img);
        // 把先前"普通点击"单选的那张迁移进多选集合。这样两种顺序都能多选：
        //   先 Ctrl 点第一张 → 再 Ctrl 点第二张（原有）
        //   先普通点第一张 → 再按住 Ctrl 点第二张
        // 【接管轮 2026-10-05 修正】原来"Ctrl 点已经单选的那一张 = 取消选择（资源管理器语义）"
        // 走一条早退：结果是"单击 A（实线）→ 按住 Ctrl 再点 A 自己"**框被摘光、没有虚线接手**，
        // 屏幕上就是一个选中指示都没有——用户报的"选中指示框没了"就是这一格；而同一手势点**别的**
        // 图却正常出虚线框，同一手势两种语义。现在：Ctrl 点实线那张 = 并入多选集合（实线→虚线），
        // 取消改成"再 Ctrl 点一下这张虚线图"（复制/剪切载荷与单选通道一致，见 selectedItems）。
        if(selectedImage&&selectedImage.isConnected&&!multiSelected.has(selectedImage)){
          const 迁走=selectedImage;
          multiSelected.add(迁走);
          迁走.classList.remove('typora-img-selected');
          迁走.classList.add('typora-img-multi-selected');
          selectedImage=null;
          // 光标不许丢、更不许被扔到文档开头：优先还回用户上一次的文本落点；没有就退到
          // "这张图之后"的零宽锚位（与点图右空白同一套基础设施）。
          const 根=editorRoot(api);
          const 恢复=上次文本光标&&上次文本光标.startContainer?.isConnected&&根&&根.contains(上次文本光标.startContainer)?上次文本光标:null;
          if(恢复){
            const r=恢复.cloneRange();r.collapse(true);selectRange(根,r);
          }else{
            const z=根?立零宽锚(根,imageOwner(迁走)||迁走):null;
            if(z){const r=document.createRange();r.setStart(z,0);r.collapse(true);selectRange(根,r);}
          }
        }
        // 迁移过来的那一张"迁移即选中"，不再 toggle（否则加虚与摘虚在同一任务里跑完，
        // 中间一次绘制都没有，用户看到的就是"框全没了"）。
        if(!刚才是实线){
          if(multiSelected.has(img)){multiSelected.delete(img);img.classList.remove('typora-img-multi-selected');}
          else{multiSelected.add(img);img.classList.add('typora-img-multi-selected');}
        }
        keepEditorFocused();
        contextToast(multiSelected.size?('已选中 '+multiSelected.size+' 张图片，Ctrl+C 一次复制'):'已取消图片多选');
        return;
      }
    }
    // 图片右侧/下方的空白带：把光标确定性地放到"图片之后"（用户 2026-10-02 报的
    // "文档最后是一个图片时，点右边空白后要能回车新行"）。放在选中分支之前：
    // 点在空白带上本来就不该选中图片。
    // D4 返工（2026-10-02 二轮）：**必须在这里 preventDefault 并自己立锚**。原以为
    // 不拦、把落点纠正留到 mouseup 就够——实测原生把锚点摆进折叠隐藏源码 offset 0
    // 之后，拖选根本无法从那个锚扩展（拖 80px 松手仍是零长折叠选区，锚/焦都在源码
    // 层，mouseup 时无选区可救）。所以按下这一刻就把锚立到"图片节点之后"（收束轮1
    // 起为紧随图片的 ZWSP 文本位，原生可画、永远可编辑——R11 第二波起 落到图片之后
    // 不展开源码，锚语义两形态统一）。拖选扩展由下面的 mousemove 补丁接力；位移 ≤4px
    // 的"点击"仍由 mouseup 走 落到图片之后（2.2.16 契约不回退）。
    const 带=event.button===0&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.detail<2?图片空白带(event):null;
    if(带){
      clearImageSelection();
      event.preventDefault();
      const root=editorRoot(api);
      if(root&&带.owner.isConnected){
        const z=立零宽锚(root,带.owner);
        if(z){
          const anchor=document.createRange();anchor.setStart(z,0);anchor.collapse(true);
          selectRange(root,anchor);
        }
      }
      空白带接管={owner:带.owner,html:带.html,x:event.clientX,y:event.clientY,t:Date.now()};
      return;
    }
    空白带接管=null;
    const img=event.button===0&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.detail<2?imageAt(event):null;
    if(img){
      event.preventDefault();
      // 【接管轮 2026-10-05·兜底】这一击会把选区换成"整图选中"，先把用户**此刻的文本光标**
      // 记下来（只认折叠、且落在编辑面里的真文本位）；Ctrl 多选链路要用它把光标原样还回去。
      {
        const 现选=getSelection(),现范围=现选?.rangeCount?现选.getRangeAt(0).cloneRange():null,现根=editorRoot(api);
        上次文本光标=现范围&&现范围.collapsed&&现根&&现根.contains(现范围.startContainer)?现范围:null;
      }
      clearImageSelection();
      selectedImage=img;img.classList.add('typora-img-selected');
      const range=document.createRange();range.selectNode(img);
      selectRange(editorRoot(api),range);
      // F15（2026-10-02 判决）：图上起手的**拖选**。上面 preventDefault 之后原生不代劳
      // 扩展，旧代码到这里直接 return、不立旗，D4 的 mousemove 补丁只认空白带的旗——
      // 图上按住拖出去选区纹丝不动（一直停在整图选中）。与空白带同构：立同一面旗
      // （img:true 标明图上起手），owner=图自己的节点，锚=selectNode(img) 的**起点**
      // （图片之前），mousemove 补丁据此把扫过的文字接进选区（整张图圈进来）；≤4px
      // 死区仍是"单击整选"（mouseup 的 img 分支原样保留选区）。Ctrl/Shift/Alt 组合与
      // 连点(detail≥2)进不了本分支（上面的门卫已挡），天然不立旗——W4/138 契约不回退。
      空白带接管={owner:imageOwner(img)||img,x:event.clientX,y:event.clientY,t:Date.now(),img:true,
        anchor:{node:range.startContainer,offset:range.startOffset}};
      return;
    }
    // RC2（2026-10-02 判决）：右键（button 2）不清图片选中态——右键被选中的图要像
    // 资源管理器那样保持高亮，菜单里的复制/剪切据此走图片剪贴板通道。只有左键
    // 点到别处才按"取消选择"处理（Esc 的清选走键盘路径，不在此列）。
    // 点在**自家浮层**（右键菜单/图片设置对话框）上的那一下同样不能清：菜单按钮的
    // 动作（复制/剪切）读的正是这份选中态，mousedown 抢先清掉的话 click 到达时
    // selectedItems 已空，复制就退回空选区的文本通道（R4M5 实测：copy-images 从未发出）。
    const overOwnOverlay=elementAt(event.target)?.closest?.('#'+CONTEXT_MENU_ID+',.typora-media-dialog');
    if(event.button===0&&!overOwnOverlay&&(selectedImage||multiSelected.size))clearImageSelection();
  },true);
  document.addEventListener('mouseup',event=>{
    // 空白带那一下的落点纠正：位移 ≤4px 才算"点击"，走 2.2.16 契约（图片之后）。
    const 带=空白带接管;
    if(!带||event.button!==0)return;
    // F15：图上起手的那一下不走「图片之后」——>4px 的拖选已由 mousemove 补丁把选区
    // 扩展到位（只收旗）；≤4px 是"单击整选"，mousedown 立的 selectNode(img) 选区与
    // 高亮原样保留。「落到图片之后」是空白带点击的 2.2.16 契约，两码事。
    if(带.img){空白带接管=null;return;}
    if(Math.abs(event.clientX-带.x)>4||Math.abs(event.clientY-带.y)>4){
      // >4px＝拖选：ZWSP 锚的使命结束（mousemove 接力处已摘，这里兜底再摘一次——
      // 锚节点留着会被圈进选区，复制时泄漏 \u200b）。
      摘锚节点();
      // D4（2026-10-02 判决，二道保险）：锚点已在 mousedown 立到"图片节点之后"、扩展由
      // mousemove 补丁接力，正常情况下走到这里选区已经是干净的。仍兜底检查一次：万一选区
      // 锚还挂在隐藏源码/marker 里（preventDefault 之前的旧时序、或其它路径形成的真选
      // 区），把它重设到图片节点之后，焦点原样保留。两种情况不碰：源码处于展开态（用户
      // 看得见自己在选源码）；焦点不在图片节点之后（往前拖的选区，重锚反而会把图片整个
      // 圈进选区）。
      const selection=getSelection();
      if(selection?.rangeCount&&!selection.isCollapsed&&带.owner.isConnected
        &&!带.owner.classList.contains('vditor-ir__node--expand')){
        const anchorEl=elementAt(selection.anchorNode);
        if(anchorEl&&带.owner.contains(anchorEl)&&anchorEl.closest('code,[class*="vditor-ir__marker"]')
          &&nodeAfter(带.owner,selection.focusNode)){
          const after=document.createRange();after.setStartAfter(带.owner);after.collapse(true);
          selection.setBaseAndExtent(after.startContainer,after.startOffset,selection.focusNode,selection.focusOffset);
        }
      }
      空白带接管=null;return;
    }
    if(Date.now()-带.t>1500||!带.owner.isConnected)return;
    落到图片之后(editorRoot(api),带.owner,带.html);
    带.t=Date.now();
  },true);
  // D4 返工：空白带那次按下之后的**拖选扩展**。锚点已在 mousedown 立到"图片节点
  // 之后"；preventDefault 之后原生不再代劳扩展（不拦的旧路径实测也扩不动——锚在
  // 隐藏源码里），这里在左键按住期间逐帧把焦点跟到指针落点（caretRangeFromPoint），
  // 松手即得真选区。焦点落进这张图自己的节点（源码/marker/渲染岛）时不更新——
  // 那种倒挂选区会把图块圈进去，维持上一次的有效焦点即可。
  document.addEventListener('mousemove',event=>{
    const 带=空白带接管;
    if(!带)return;
    if(!(event.buttons&1)){空白带接管=null;return;}   // 左键已松（mouseup 被吃掉时的兜底清旗）
    if(Math.abs(event.clientX-带.x)<=4&&Math.abs(event.clientY-带.y)<=4)return;   // 还在 4px 死区内：算点击
    if(!带.owner.isConnected){空白带接管=null;return;}
    // 拖选起手（越过死区即成拖选）：ZWSP 锚的使命结束——原生扩展要拿干净的「图片节点
    // 之后」边界当锚基，锚节点留着会占住 setStartAfter 的位（边界落在它前面）且会被圈
    // 进选区（复制泄漏 \u200b）。摘后紧随的 setBaseAndExtent 重设选区，节点摘除造成的
    // 落点解析被完全覆盖。
    摘锚节点();
    const root=editorRoot(api);
    const spot=document.caretRangeFromPoint?.(event.clientX,event.clientY)||null;
    if(!root||!spot||!spot.startContainer||!root.contains(spot.startContainer))return;   // 指针在编辑面外：保持原选区
    const spotEl=elementAt(spot.startContainer);
    if(spotEl&&带.owner.contains(spotEl))return;   // 焦点还在图块内部：见上注，不更新
    // F15（2026-10-02 判决）：图上起手的拖选在这里接力。锚随旗走——空白带是"图片节点
    // 之后"，图上起手是 mousedown 记下的 selectNode(img) 起点（图片之前），拖出去的
    // 选区把整张图圈进来（含图+扫过文字）。手势一旦越过死区就成了"拖选"：把点图的
    // 高亮/多选态撤下——Ctrl+C 的图片剪贴板通道与 Backspace 删图都挂在 selectedImage
    // 上，留着它会把拖出的文字选区劫成图片操作（空白带路径在 mousedown 就
    // clearImageSelection，这里是图上路径的同一语义）。记下的锚在拖动途中失联（所在
    // 块被重渲染）时收旗：不拿陈旧锚去 setStart。
    if(带.img){
      if(!带.anchor||!带.anchor.node.isConnected){空白带接管=null;return;}
      clearImageSelection();
    }
    const anchor=document.createRange();
    if(带.img)anchor.setStart(带.anchor.node,带.anchor.offset);
    else anchor.setStartAfter(带.owner);
    anchor.collapse(true);
    const sel=getSelection();
    sel.setBaseAndExtent(anchor.startContainer,anchor.startOffset,spot.startContainer,spot.startOffset);
  },true);
  document.addEventListener('click',event=>{
    // R11：本次派发结束后清理用户展开名册——vditor B() 对未被拦下的点击会收起全部
    // --expand（＝「点正文别处」的收起手势），被收走的成员要出册，免得下一次 blur 又把它复活。
    setTimeout(用户展开清理,0);
    if(event.metaKey)return;
    // 空白带那一下：mouseup 已经把光标放到"图片之后"了，这里必须再挡一次——裸 HTML 图块
    // 上点的是**渲染岛**（pre.vditor-ir__preview），vditor 的 click 分支会把选区改成
    // "岛的前一个兄弟（源码）的内容开头"（实测 probe-image-blankzone-html.cjs：点图右侧
    // 空白后光标被抢回 CODE offset 0，打字就打到 <img> 标签**前面**去了）。
    // 【接管轮 2026-10-05·问题2】读走本次 click 用的快照。快照由 mousedown 顶部每次重写
    // （落在带蓝框的图上才非空），不需要任何"消费"动作——读一次就够，顺手清掉免得留到下回。
    const 快照=单击快照;
    单击快照=null;
    const root=editorRoot(api),接管点=elementAt(event.target);
    if(空白带接管&&Date.now()-空白带接管.t<1200&&空白带接管.owner.isConnected&&root
      &&(空白带接管.owner===接管点||空白带接管.owner.contains(接管点)||接管点===ownerBlock(root,空白带接管.owner))){
      const 带=空白带接管;空白带接管=null;event.preventDefault();event.stopImmediatePropagation();
      // R11 第二波：click 尾声重立锚+合成光标（B3 案三：md 图的锚在终态会被后续处理器
      // 改写成整图选中——在最后一个能拦的位置再钉一次，保住"光标在图片之后"的契约）。
      落到图片之后(root,带.owner,带.html);
      return;
    }
    const img=imageAt(event);
    // 【U-086】块外空白确定性收起臂（确认轮主案照抄＋对抗轮 R-1，.zcode-tmp/r18-u086/B-对抗评审.md §9）。
    // 靶子：空标题（仅#）折叠记号 0×0 无墨水（vditor index.css:1510-1535），用户点"标题行"极易
    // 越过盒底（实测 156/157 分界）——Blink 把块盒外的点解到下一块第一行，图片源码展开态下正是
    // 源码行 ⇒ 光标进图片节点 ⇒ vendored B()（本臂在 document 冒泡相，晚于它）按"光标在谁里"
    // 重加 --expand ⇒ 源码被加回——"点标题行＝该折不折"。判据（对抗轮 M-4 裁定不得放宽）：
    // 落点爬不到 editorRoot 直接子元素（event.target 就是编辑面自身）＝块外空白。
    // 动作（不拦事件流）：①钉位＝落点上方最近块最后一个可落文本位（折叠记号也算；跳过预览；
    // 表格→末格文本末，空标题→记号末，实测光标盒 0×34/0×16 可见）②收起＝摘含 img 的
    // --expand 并出册（防 blur 复活，同 展开图片节点 习语）。两道闸（M-3/M-6 实测为兜底非支点，
    // 如实记账）：仅当光标已在将收起的节点里；仅当落点下方还有块（150⑨ 点文末空白让路）。
    // R-1：位移>4px＝真人拖选（正文起手→块外带落点），不得把用户选区折成光标——跳过本臂
    // （与 空白带接管 的 4px 死区同习语）。已界定（B-对抗评审）：y≥图片块盒上沿＝反例4 域维持
    // 只钉不折（事件 target 在图片块内，本臂判据不成立自然够不着）；容器内图点容器内空白、
    // 围栏/公式→图的上一块下空白＝本臂不可达（挂 F1/反例4 域）。
    {
      const 拖=按下坐标?Math.hypot(event.clientX-按下坐标.x,event.clientY-按下坐标.y):0;
      if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&event.detail<2&&拖<=4&&root&&event.target===root){
        let 上块=null;
        for(const 块 of root.children){const 盒=块.getBoundingClientRect();if(盒.bottom<=event.clientY+1)上块=块;else break;}
        let 有收起=false,光标在内=false;
        const 选=getSelection(),现=(选?.rangeCount)?选.getRangeAt(0):null;
        for(const 节 of root.querySelectorAll('.vditor-ir__node--expand')){
          if(!节.querySelector('img'))continue;
          if(现&&节.contains(现.startContainer))光标在内=true;
          节.classList.remove('vditor-ir__node--expand');用户展开.delete(节);有收起=true;
        }
        const 下方还有块=[...root.children].some(块=>块.getBoundingClientRect().top>=event.clientY-1);
        if(有收起&&光标在内&&下方还有块&&上块){
          const 步=document.createTreeWalker(上块,NodeFilter.SHOW_TEXT);let 文=null,点;
          while((点=步.nextNode())){if(点.length&&!点.parentElement?.closest?.('.vditor-ir__preview'))文=点;}
          if(文){const 钉=document.createRange();钉.setStart(文,文.length);钉.collapse(true);selectRange(root,钉);}
        }
      }
    }
    const at=img?{owner:imageOwner(img),源码上:false}:图片节点At(event);
    if(!at||!at.owner)return;
    // W5（2026-10-02 二轮判决）：detail≥2 的展开分支对 Ctrl/Cmd 让位——Ctrl 快速两击
    // 同图是"多选再取消"（mousedown 的 Ctrl 分支已处理），此处不得展开源码。
    if(event.detail>=2&&(event.ctrlKey||event.metaKey)&&!event.altKey)return;
    // W4（2026-10-02 二轮判决，三轮返工）：双击选中图旁的词之后，第三击点图＝原生"三击
    // 选段"的最后一击。放行与否看 **mousedown 快照**里的词选态（click 时选区可能已被原生
    // 折到节点边界——一轮版读 click 时刻的选区，于是没拦住、源码照弹）。原生已把整段选好
    // （含图）就纯放行；没选上就产品层补齐"整段选中含图"——两种都不展开、不弹源码。
    if(event.detail===3){
      const 词选=三击词选&&Date.now()-三击词选.t<1500?三击词选.有选区:false;
      三击词选=null;
      if(词选){
        const selection=getSelection(),clicked=imageAt(event);
        if(selection?.rangeCount&&!selection.isCollapsed
          &&(!clicked||selection.getRangeAt(0).intersectsNode(clicked)))return;   // 原生整段选好：放行
        event.stopImmediatePropagation();
        const root=editorRoot(api);
        let block=at.owner;
        while(block&&block.parentElement&&block.parentElement!==root)block=block.parentElement;
        if(root&&block&&block.parentElement===root){
          const range=document.createRange();range.selectNodeContents(block);
          selection?.removeAllRanges?.();selection?.addRange?.(range);
          root.focus({preventScroll:true});
        }
        return;
      }
    }
    if(event.altKey||event.detail>=2){
      if(img||!at.源码上&&!at.空块){
        // Alt+单击（文档里的老手势）与双击/连点落在**图片本体/渲染岛**上：确定性展开源码，
        // 并把光标放进源码（路径那格）。不再让 vditor 的 B() 摇摆——它先摘光全部 --expand，
        // 再按"当前 range 在不在节点里"重加，连点时落点受布局位移影响，展开成败取决于
        // 连点次数的奇偶。用户口径（2026-10-02）："点击图片高频率点击有概率触发无法展开源码"。
        event.preventDefault();event.stopImmediatePropagation();
        clearImageSelection();
        展开图片节点(editorRoot(api),at.owner,true);
        return;
      }
      // 连点落在**已经展开的源码行**上：只钉住"别折回去"，光标与选区原样保留
      // （双击选词、三击选段这些原生语义一个都不动）。
      // 落在**图片独占那一段的空白**上（展开后图片被源码顶走，第 3 下常常打在这儿）：
      // 同样只钉住展开，顺手把光标收到"图片之后"。
      event.stopImmediatePropagation();
      展开图片节点(editorRoot(api),at.owner,false);
      if(at.空块)落到图片之后(editorRoot(api),at.owner,false);
      return;
    }
    if(img&&event.ctrlKey){event.preventDefault();event.stopImmediatePropagation();return;}   // Ctrl+单击=多选（mousedown 里处理），同样不让 vditor 原生 click 插手
    // 【接管轮 2026-10-05·问题2】"点两下必出源码"，而且**不看快慢**。
    // 旧实现只有 detail≥2 这一条展开路，而浏览器只在两次点击的间隔小于系统双击阈值
    // （本机 500ms）且位移在阈值内时才把第二击标成 detail=2：点快了出、点慢了永远停在
    // "只选中"，用户感受到的就是"要点随机下数图片才露出源码"。这里的判据与时间、与点击
    // 次数都无关——**按下之前这张图带着可见选中框**，这一击就确定性展开并把光标放进源码；
    // 没有蓝框的那一击仍旧只上蓝框（138 号契约"单击不展开"原样保留）。
    if(img&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.detail<2){
      if(快照&&快照.img===img&&img.isConnected){
        event.preventDefault();event.stopImmediatePropagation();
        clearImageSelection();
        展开图片节点(editorRoot(api),at.owner,true);
        return;
      }
    }
    // 【接管轮 2026-10-05·问题2·反例4】用户展开过的图，点它所在那一段的**空白**（大图展开后
    // 源码行把图片顶下去，用户第 3 下往往打在原坐标＝图片上方的空白）时，必须钉住展开，不能
    // 放行给 vditor 的 B()（它先摘光全文档 --expand 再按"当前 range 落在哪个节点里"重加，
    // 落点不在节点内就折回去——小图侥幸同行、大图必折，这就是"连点次数奇偶决定成败"的残余）。
    if(at.空块&&at.owner.isConnected&&用户展开.has(at.owner)&&event.detail<2
      &&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
      event.preventDefault();event.stopImmediatePropagation();
      展开图片节点(editorRoot(api),at.owner,false);
      return;
    }
    if(!img)return;                        // 单击落在源码/围栏上=编辑源码（原生语义）
    // 单击图片本体=选中（Typora 式），并挡掉 vditor 原生 click。
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  // R11：编辑面 blur 上钉住用户展开（通道 A 堵口，见 用户展开 名册注释）。挂 IR 编辑面——
  // 与 vditor Ce 同元素同相位，且本模块安装晚于 vditor 构造，注册序保证总在其后执行。
  api.vditor.ir?.element?.addEventListener('blur',钉住用户展开);
  /** 边界救援（零状态）：选区恰好折叠在「图片节点之后」的**元素边界位**——该位原生
   *  0×0 画不出 caret（B3 实证：root 层/元素后边界），典型来源是撤销把选区放回锚的
   *  逻辑位（撤销锚记忆已随合成光标取消，这是它的零状态替身：任何来源把选区放到这个
   *  不可见位——undo 的 restoreHistorySelection、renderDiff、方向键路过——锚都把它
   *  接住）。判定只看现场 DOM（ remembered owner 已被重放换对象也能命中）：容器是元素、
   *  前一个子节点是含 img 的 vditor-ir__node、该节点不在源码展开态（双击互斥）。 */
  const 边界救援=()=>{
    const root=editorRoot(api),s=getSelection();
    if(!root?.isConnected||!s?.rangeCount||!s.isCollapsed)return;
    const r=s.getRangeAt(0),c=r.startContainer;
    if(c.nodeType!==Node.ELEMENT_NODE||!root.contains(c))return;
    const prev=c.childNodes[r.startOffset-1];
    if(!prev||prev.nodeType!==Node.ELEMENT_NODE)return;
    if(!(prev.matches?.('.vditor-ir__node[data-type]')&&prev.querySelector('img')))return;
    if(prev.classList.contains('vditor-ir__node--expand'))return;
    const z=立零宽锚(root,prev);
    if(z){
      const rr=document.createRange();rr.setStart(z,0);rr.collapse(true);
      selectRange(root,rr);
    }
  };
  // 收束轮1（2026-10-02）：锚生命周期——服役锚的选区离开、或 owner/z 失联（IR 重放换块、
  // 程序摘除）即除；随后跑一次边界救援（undo 把选区放回锚逻辑位时重立锚，见其注释）。
  document.addEventListener('selectionchange',()=>{
    if(组合中)return;                          // IME 组合期：不动节点也不挪选区
    if(锚){
      if(锚.owner.isConnected&&锚.z.isConnected){
        if(锚.服役&&!锚仍占())除零宽锚();
      }else{
        // owner/z 失联＝锚随块消失；z 若还连着（程序只摘了 owner 那种），且选区不在其
        // 上，顺手摘净，防 ZWSP 常驻被复制。状态清掉后继续走边界救援（旧 owner 对象
        // 已被重放换掉，救援从现场 DOM 重新找图节点）。
        const z=锚.z;
        锚=null;
        if(z&&z.isConnected){
          const r=(getSelection()?.rangeCount)?getSelection().getRangeAt(0):null;
          if(!(r&&(r.startContainer===z||r.endContainer===z)))z.remove();
        }
      }
    }
    边界救援();
  });
  // 【J 修订·rm-1】锚位上的 ← 导航守卫。Blink 从零宽锚位（root 层或段内图片节点之后）
  // 按 ← 会按文档序倒退，落进图片节点的**隐藏源码**（p3zwsp rm-1 实测：html 图形态
  // 落 CODE 文本「<img s」offset 34——光标进了不可见源码，接着打字就改 <img> 标签）。
  // 接管：选区正在锚位时，← 落到 owner 之前**最近的可见实字文本尾**（Typora 直觉：
  // 上一行行尾），随后除锚。
  const 前一处可见文本=(root,owner)=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{
      acceptNode:t=>{
        if(owner.contains(t.parentElement||t))return NodeFilter.FILTER_REJECT;
        const pe=t.parentElement;
        if(!pe||pe.closest(PREVIEWS))return NodeFilter.FILTER_REJECT;
        return t.data.replace(/[\s\u200b]/g,'')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
      }});
    let last=null,n;
    while((n=walker.nextNode())){
      if(owner.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)break;   // 走过 owner 即停
      const pe=n.parentElement;
      if(pe&&(pe.offsetParent!==null||pe.getClientRects().length))last=n;           // 隐藏（折叠源码/marker）不算
    }
    return last?[last,last.data.length]:null;
  };
  document.addEventListener('keydown',event=>{
    if(event.key!=='ArrowLeft'||event.defaultPrevented||event.isComposing)return;
    if(!锚||!锚仍占())return;
    const {root,owner}=锚;
    if(!root?.isConnected||!owner.isConnected||!root.contains(owner))return;
    const target=前一处可见文本(root,owner);
    if(!target)return;                         // 前面没有可见文本（图是文档首块）：放行原生
    event.preventDefault();event.stopImmediatePropagation();
    const rr=document.createRange();rr.setStart(target[0],target[1]);rr.collapse(true);
    selectRange(root,rr);
    除零宽锚();
  },true);
  // 真输入的锚摘除 + IME 组合期闸（patchSoftBreak 同款接线：compositionend 之后那一拍
  // 仍不动节点，推到下一宏任务收尾）。
  document.addEventListener('compositionstart',()=>{组合中=true;},true);
  document.addEventListener('compositionend',()=>{组合中=false;setTimeout(()=>锚输入摘除(),0);},true);
  document.addEventListener('input',锚输入摘除,true);
  // blur → 除锚（防 ZWSP 常驻被复制）。不归位选区：blur 时除零宽锚 的 selectRange 会带
  // root.focus 与工具栏抢焦点；节点摘除后 Blink 把光标就近解析到锚的逻辑位，与旧版
  // 「摘线留锚」的 blur 终态一致。IME 组合期的 blur 不动节点（组合作废重起的代价大于
  // 暂留，收尾交给组合期结束后的锚输入摘除）。
  api.vditor.ir?.element?.addEventListener('blur',()=>{
    if(!锚)return;
    const z=锚.z;
    锚=null;
    if(z.isConnected&&!组合中)z.remove();
  });
  // R11 第二波（D-D 案一·主闸）：\n 入口闸——html-block 源码文本里一旦混进换行（回车/
  // Shift+回车/粘贴/IME 换行），keyup 的块级 SpinVditorIRDOM 重放会重铸块壳，随后第一次
  // 退格以壳为单位替换子树时把整个图块丢弃（B3 案一 2/2：DOM+md 一起消失，光标甩进前一
  // 个标题的源码继续误删）。闸设在入口而非出口：毒状态（源码含 \n）落盘后，拦"紧跟的那次
  // 退格"救不了第二次退格。副闸在 keydown（Enter 直按兜底）。
  api.vditor.ir?.element?.addEventListener('beforeinput',event=>{
    if(!['insertParagraph','insertLineBreak','insertText','insertFromPaste','insertReplacementText'].includes(event.inputType))return;
    if(!['insertParagraph','insertLineBreak'].includes(event.inputType)&&!(event.data||'').includes('\n'))return;
    const s=getSelection(),node=s?.focusNode;
    const el=node?.nodeType===3?node.parentElement:node;
    if(!el?.closest?.('code[data-type="html-block"]'))return;
    event.preventDefault();
  });
  // R11 第三波（V2 轮 D 实测定谳）：粘贴面主闸。vditor 的粘贴走**自有 paste 处理器**程序性
  // 插入——整条链不派发 beforeinput（主闸拦截点不存在），且即便派发，insertFromPaste 的载荷
  // 在 dataTransfer、event.data 恒空（旧条件对粘贴永假）。MO 实证：粘贴含 \n 文本瞬间
  // CODE 文本整体换成多行、重放后块降级。这里在 document 捕获层接管（vditor 的 paste 监听
  // 挂在自己的 element 上且注册更早，同节点同相位抢不过它；祖先捕获恒先于目标节点）。
  document.addEventListener('paste',event=>{
    if(event.defaultPrevented)return;
    const s=getSelection(),node=s?.focusNode;
    const el=node?.nodeType===3?node.parentElement:node;
    if(!el?.closest?.('code[data-type="html-block"]'))return;
    const text=event.clipboardData?.getData('text/plain')??'';
    if(!text.includes('\n'))return;
    event.preventDefault();event.stopImmediatePropagation();
    // 整单拦截（D-D 口径）：折叠成单行再插也不行——插到标签尾巴上同样把标签打断、
    // 块降级成段落（轮 D 实测 557→271、DIV→P、图不再渲染）。多行文本本就进不了
    // html-block 源码，拦下并告知，内容原样留在剪贴板里。
    contextToast('图片源码不支持多行文本，已拦截粘贴（内容仍在剪贴板）');
  },true);
  document.addEventListener('keydown',event=>{
    // 收束轮1：锚在场时，Enter＝在图片所在块后新起一段（用户需求 2026-10-04："图片右侧
    // 空白点击之后直接按回车创建新的一行"；2.2.16 契约）。旧版锚在 root 层、Blink 对它
    // 零默认动作；现在锚是真实文本位、Blink 有默认动作（在 z 里插换行），preventDefault
    // 后照旧自己造段：插空 P（内放零宽锚点，vendored 的 ZWSP 习语，Lute 序列化剥掉、
    // 不落 md），触发 IR 输入处理让 DOM→md 与撤销栈走正常链，一步可撤销。
    // Shift+Enter 同语义——该逻辑位没有软换行落点（R11 第三波裁决：V3 实测 Shift+Enter
    // 落空、块数不变），新起一段是唯一有意义的行为。
    if(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey&&!event.altKey
      &&!event.isComposing&&锚&&锚.owner.isConnected){
      const {root,owner}=锚;
      const block=ownerBlock(root,owner);
      if(root.isConnected&&block){
        event.preventDefault();event.stopImmediatePropagation();
        // 让位但不摘节点（撤销锚记忆已随合成光标取消）：选区即将移进新段；锚文本留在
        // 原处充当撤销重显的落点——撤销把选区放回 z@0 原生可见，z 被 IR 重放剥掉则
        // selectionchange 守卫的边界救援接管。选区离开后的任何真实输入会把它静默
        // 清掉（锚输入摘除 的 else 腿）。
        锚.服役=false;
        const before=beginDocumentEdit(api);
        try{
          const p=document.createElement('p');p.setAttribute('data-block','0');p.textContent='\u200b';
          block.after(p);
          const range=document.createRange();range.setStart(p.firstChild,1);range.collapse(true);
          selectRange(root,range);
          // 【J 修订·-6】派发前置 preventInput（patchSoftBreak 同款先例 @202407 分支）：
          // 不拦的话 vendored 的 P() 会整块 spin——Lute 把新段的 \u200b 剥掉、光标被
          // wbr 兜底逻辑放到 (P,0) 元素位（0×0 不可见，p3zwsp 四形态 -6 实测）。走
          // At-only 快道：值/undo 栈照走，新段保持 vendored 空段习语（\u200b 文本位
          // 承载原生光标）。
          api.vditor.ir.preventInput=true;
          root.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertParagraph'}));
        }finally{finishDocumentEdit(api,before);}
        return;
      }
    }
    // R11 第二波（D-D 案一·副闸）：html-block 源码里的 Enter 一律不插 \n（主闸 beforeinput
    // 之外兜键盘直按；IME 组组字期不碰）。
    if(event.key==='Enter'&&!event.isComposing){
      const s=getSelection(),node=s?.focusNode;
      const el=node?.nodeType===3?node.parentElement:node;
      if(el?.closest?.('code[data-type="html-block"]')){event.preventDefault();event.stopImmediatePropagation();return;}
    }
    if(event.key==='Escape'&&!event.defaultPrevented){clearImageSelection();收起用户展开();return;}
    if(event.defaultPrevented||event.isComposing||!['Backspace','Delete'].includes(event.key))return;
    // 多选（Ctrl+点选）的图片也要能一次删掉：用户报「图片多选后按退格/删除没有反应」。
    // 单击选中的那一张**以点选状态为准**（`selectedImage` 只由"点在图片上"这一次设置，
    // 点到别处/按 Esc 都会被清掉），不再要求 DOM 选区还压在图片上——用户报告
    // （2026-09-14）HTML 图片（正文里直接写 `<img>` 的那种）点选后按下退格/删除时，
    // **图片没被删掉，反而是别处的一个字被吃掉、光标跳到不知道哪里**：实测点选后 Vditor
    // 把 DOM 选区收掉了（collapsed），旧判据 `!selection.isCollapsed && range.intersectsNode(img)`
    // 于是判定"这张图已经不算选中"，直接放弃并把这次按键让给浏览器——浏览器就按"删光标
    // 左边那个字"处理（在那个文档里光标停在标题 H1 上，删掉的是标题里的字）。
    // 现在按点选状态删：删除与撤销都走同一条编辑路径，一次撤销退回，光标落在删除点。
    const elements=[...multiSelected].filter(node=>node.isConnected);
    if(selectedImage?.isConnected)elements.unshift(selectedImage);
    if(!elements.length)return;
    event.preventDefault();event.stopImmediatePropagation();
    clearImageSelection();
    const before=beginDocumentEdit(api);
    // D1：多图删除交给 deleteImages 合并提交——第一张的 setValue 会重建所在块、同段
    // 其余 <img> 节点失联，旧的逐张循环从第二张起只会弹「请在编辑区选择图片后重试」
    // 的错误 toast（用户看到"多选两张退格只删掉一张"）。
    try{deleteImages(api,elements);}catch(error){contextToast(error.message);}
    finishDocumentEdit(api,before);
  },true);
  document.addEventListener('contextmenu',event=>{
    const target=elementAt(event.target),content=target?.closest?.('.vditor-content');if(!content)return;
    const img=target.closest?.('img');
    if(img&&img.closest('.katex,.emoji'))return;
    const table=target.closest?.('table');
    event.preventDefault();event.stopImmediatePropagation();
    // 补光标要在这里**再补一次**：实测（probe-caret-timeline.cjs 的时间线）mouseup/contextmenu
    // 这一步 Blink 会重新把选区设成"整篇文档"——原样 HTML 图片块：鼠标按下时已经补到了块 4，
    // 抬手之后又变回块 0；素材上的图片：按下时补到了块 111，抬手后变回块 0（光标离视口 7059px）。
    // 我们的补光标是延到下一个任务里做的，所以它天然排在菜单 `menu.focus()` 之后。
    // RC1：把补光标的落点（guardCaret）随菜单带走——菜单动作用它顶掉"整篇假选区"。
    const guardCaret=rightClickNeedsGuard(event)?ensureCaretNearRightClick(event):null;
    showContextMenu(api,event,{table,img,link:linkTargetAt(target),imageContext:context,guardCaret});
  },true);
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||!event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
    const action=event.key==='Enter'?'table-row-below':event.key==='Backspace'?'table-delete-row':null;if(!action)return;
    // T3（2026-10-02 二轮判决）：Ctrl+Backspace 在格内词中是"删前一个词"，不再劫成删行
    // ——删行只保留给菜单与"整行选中"的行选态；其余一律放行原生词删。
    if(action==='table-delete-row'&&!wholeTableRowSelected())return;
    const table=elementAt(event.target)?.closest?.('table')||contextTableFromSelection(api);if(!table)return;
    const context=tableContext(api,event,table);if(!context)return;
    event.preventDefault();event.stopImmediatePropagation();try{tableEdit(api,context,action);}catch(error){contextToast(error.message);}
  },true);
  // T8（2026-10-02 二轮判决）：单元格内**非折叠选区**按 Enter——先 deleteContents 把选中
  // 文字删掉，再让 vendor 的 Enter 处理器（此刻看到的是折叠光标）走它自己的 br 插入，
  // 选中文字被替换。刻意**不 preventDefault**：一拦 vendor 就不跑了，就得整条复刻回车
  // 语义。选区跨格（多格矩形）或选区不在表格里时不归这条管。
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.key!=='Enter'||event.ctrlKey||event.altKey||event.metaKey)return;
    const e=api.vditor;
    if(!['ir','wysiwyg'].includes(e.currentMode))return;
    const root=editorRoot(api),s=getSelection();
    if(!root||!s?.rangeCount||s.isCollapsed)return;
    const range=s.getRangeAt(0);
    if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return;
    const cell=elementAt(range.startContainer)?.closest?.('td,th'),endCell=elementAt(range.endContainer)?.closest?.('td,th');
    if(!cell||cell!==endCell||!root.contains(cell))return;   // 只管"选区整个落在一个格里"
    const before=beginDocumentEdit(api),scroll=root.scrollTop;
    // flush 之后 DOM 可能被重建：重读选区，仍落在这格且非折叠才动手，避免删到失联节点。
    const live=getSelection(),liveRange=live?.rangeCount?live.getRangeAt(0):null;
    if(liveRange&&!liveRange.collapsed&&elementAt(liveRange.startContainer)?.closest?.('td,th')===cell)liveRange.deleteContents();
    finishDocumentEdit(api,before);
    root.scrollTop=scroll;
  },true);
  // T6（2026-10-02 二轮判决）：产品层接管表格 Tab 的"末格补行"。
  // 末格（最后行最后格）按 Tab＝growTable 追加一条数据行 + 光标进新行首格；
  // 首格 Shift+Tab 与其余格的移动**一律不 preventDefault**，维持 vendor 原生移动。
  // 补全候选框开着时让位（completion.js 的 Tab=接受候选）。
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.key!=='Tab'||event.shiftKey)return;
    const e=api.vditor;
    if(e.currentMode==='sv')return;
    if(document.querySelector('.md-completion:not([hidden])'))return;
    const root=editorRoot(api),s=getSelection();
    if(!root||!s?.rangeCount||!root.contains(s.focusNode))return;
    const cell=elementAt(s.focusNode)?.closest?.('td,th');
    if(!cell||!root.contains(cell))return;
    const table=cell.closest('table'),row=cell.parentElement,last=table?.rows[table.rows.length-1];
    if(!table||!last||row!==last||cell!==last.cells[last.cells.length-1])return;   // 不是末格：vendor 原生移动
    event.preventDefault();event.stopImmediatePropagation();
    const before=beginDocumentEdit(api),scroll=root.scrollTop;
    growTable(table,table.rows.length+1,Math.max(1,...[...table.rows].map(item=>item.cells.length)));
    finishDocumentEdit(api,before);
    root.scrollTop=scroll;
    // 光标落新行首格（T2 修后新行必是 td 数据行；空行没有文字节点，取格内容折叠点）
    const fresh=table.rows[table.rows.length-1]?.cells[0];
    if(fresh){
      const walker=document.createTreeWalker(fresh,NodeFilter.SHOW_TEXT);let text;
      while((text=walker.nextNode())&&text.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')){/* skip preview text */}
      const range=document.createRange();
      if(text){range.setStart(text,0);range.collapse(true);}
      else{range.selectNodeContents(fresh);range.collapse(true);}
      selectRange(root,range);
    }
    root.focus({preventScroll:true});
  },true);
  // 任意覆盖整格的表格选区都按矩形切片写出：text/plain 为 TSV、html 为只含该矩形的
  // 表格。旧的“选区文本 == 整表文本”比对会在其余行为空时把本行误判成整表（粘表头
  // 多一行），也会让跨格选区落回 Vditor 的纯文本复制（两格并成一格）。
  document.addEventListener('copy',event=>{
    const selection=getSelection();
    if(event.__typoraLinkCopy||!selection?.rangeCount||selection.isCollapsed||!event.clipboardData)return;
    const payload=rectanglePayload(api.vditor,selection.getRangeAt(0));
    if(!payload)return;   // 非表格矩形（含单元格内部分文字）：沿用原有复制路径
    event.clipboardData.setData('text/html',payload.html);
    event.clipboardData.setData('text/plain',payload.text);
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  // 剪切：同一套矩形语义，外加"把选区清空"。**必须自己接管**——浏览器默认的 cut 是
  // 线性 DOM 删除：跨格选区会被折叠/并格，写进剪贴板的也只是拼在一起的文本。
  // 2026-09-12 真机实测（跨窗口套件）：剪切 3 格拿到的是 "a1a2a3"，粘到另一个窗口只有
  // 一格，表格结构还可能被撑坏。这里与复制保持完全一致（TSV + 只含该矩形的 html），
  // 清空走 clearRectangle（整格清空、不改表形），一次撤销就能回退。
  document.addEventListener('cut',event=>{
    const selection=getSelection();
    if(event.__typoraLinkCopy||!selection?.rangeCount||selection.isCollapsed||!event.clipboardData)return;
    const payload=rectanglePayload(api.vditor,selection.getRangeAt(0));
    if(!payload)return;   // 非表格矩形（正文/单元格内部分文字）：沿用原有剪切路径
    event.clipboardData.setData('text/html',payload.html);
    event.clipboardData.setData('text/plain',payload.text);
    event.preventDefault();event.stopImmediatePropagation();
    const e=api.vditor,before=beginDocumentEdit(api);
    clearRectangle(payload.rect);
    finishDocumentEdit(api,before);
    window.__typoraScheduleMath?.(payload.rect.table,{cdn:e.options.cdn,math:e.options.preview.math});
    // 剪切之后把光标落在矩形左上角那一格：留在被清空的节点里，下一次输入会静默丢失。
    const first=firstCellIn(payload.rect),root=editorRoot(api);
    if(first&&root){
      const range=document.createRange();range.selectNodeContents(first);range.collapse(true);
      const live=getSelection();live.removeAllRanges();live.addRange(range);
      root.focus({preventScroll:true});
    }
  },true);
  // 多格选区上的 Delete/Backspace 按单元格整体清空（CSV 语义），不让浏览器把
  // 跨格选区折叠成一次删除而破坏表格结构；可打印字符则先清空选区再落到首格。
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.ctrlKey||event.altKey||event.metaKey)return;
    const selection=getSelection();
    if(!selection?.rangeCount||selection.isCollapsed)return;
    const rect=isMultiCellRange(selection.getRangeAt(0));
    if(!rect)return;
    if(event.key==='Backspace'||event.key==='Delete'){
      event.preventDefault();event.stopImmediatePropagation();
      const before=beginDocumentEdit(api);clearRectangle(rect);finishDocumentEdit(api,before);
      return;
    }
    if(event.key.length!==1)return;   // 方向键/组合键交给原生
    const first=firstCellIn(rect);if(!first)return;
    const before=beginDocumentEdit(api),scroll=editorRoot(api)?.scrollTop;
    clearRectangle(rect);
    const range=document.createRange();range.selectNodeContents(first);range.collapse(true);
    const live=getSelection();live.removeAllRanges();live.addRange(range);
    finishDocumentEdit(api,before);
    const root=editorRoot(api);if(root&&Number.isFinite(scroll))root.scrollTop=scroll;
  },true);
  api.__media={setScale:(img,value)=>setImageScale(api,img,value),setAlign:(img,value)=>setImageAlign(api,img,value),removeImage:img=>deleteImage(api,img),imageDialog:img=>imageDialog(api,img),tablePayload,copyPlainText:text=>copyPlainText(api,text),tableEdit:(context,action)=>tableEdit(api,context,action)};
}
