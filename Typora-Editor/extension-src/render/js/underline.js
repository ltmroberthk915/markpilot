import {sourceText, selectRange, PREVIEWS} from './source-text.js';
import {inlineMarkdown} from './selection-markdown.js';

export function toggleUnderline(api) {
  const e=api.vditor,root=e[e.currentMode].element,selection=getSelection();
  const index=sourceText(root),range=selection.getRangeAt(0);
  const start=index.spans.find(s=>s.node===range.startContainer),end=index.spans.find(s=>s.node===range.endContainer);
  if (start && end) {
    const a=start.start+range.startOffset,b=end.start+range.endOffset;
    const pairs=[...index.text.matchAll(/<u>([\s\S]*?)<\/u>/gi)];
    const pair=pairs.find(m=>a>=m.index+3 && b<=m.index+m[0].length-4);
    if (pair) {
      const outer=index.range(pair.index,pair.index+pair[0].length);
      const open=outer.startContainer.parentElement?.closest('[data-type="html-inline"]'),close=outer.endContainer.parentElement?.closest('[data-type="html-inline"]');
      open?.classList.remove('typora-underline-marker');close?.classList.remove('typora-underline-marker');
      if(open)outer.setStartBefore(open);if(close)outer.setEndAfter(close);
      selectRange(root,outer);
      const inside=index.range(pair.index+3,pair.index+pair[0].length-4);
      document.execCommand('insertText',false,inlineMarkdown(e,inside).replace(/\u200b/g,''));return;
    }
  }
  const text=inlineMarkdown(e,range);
  document.execCommand('insertText',false,'<u>'+text+'</u>');
  // Keep typing inside an empty underline, as with the formula command.
  if (!text) for(let i=0;i<4;i++) selection.modify('move','backward','character');
}

/** CSS highlights paint underline without adding markup to Lute's source DOM. */
export function installUnderlines(api) {
  const e=api.vditor,highlight=new Highlight(),ranges=new Map();
  CSS.highlights.set('typora-underline',highlight);
  let frame=0;const dirty=new Set();
  const update=block=>{
    for(const r of ranges.get(block)||[]) highlight.delete(r);
    ranges.delete(block);if(!block.isConnected)return;
    const markers=[...block.querySelectorAll('[data-type="html-inline"]')], stack=[],list=[];
    for(const marker of markers){
      const text=marker.textContent.replace(/\u200b/g,'');
      if (/^<u>$/i.test(text)) {stack.push(marker);if(marker.tagName==='CODE')marker.classList.add('typora-underline-marker');}
      else if (/^<\/u>$/i.test(text) && stack.length) {
        const open=stack.pop(),r=document.createRange();r.setStartAfter(open);r.setEndBefore(marker);
        list.push(r);highlight.add(r);if(marker.tagName==='CODE')marker.classList.add('typora-underline-marker');
      }
    }
    if(list.length)ranges.set(block,list);
  };
  const run=()=>{
    frame=0;
    for(const [block,list] of ranges) if(!block.isConnected){list.forEach(r=>highlight.delete(r));ranges.delete(block);}
    for(const block of dirty) update(block);dirty.clear();
  };
  const observers=[];
  for(const mode of ['ir','wysiwyg']){
    const root=e[mode].element;
    const observer=new MutationObserver(records=>{
      for(const record of records){
        let node=record.target.nodeType===3?record.target.parentElement:record.target;
        if(!node || node.closest?.(PREVIEWS))continue;
        if(node===root){for(const added of record.addedNodes)if(added.nodeType===1)dirty.add(added);}
        else {while(node?.parentElement && node.parentElement!==root)node=node.parentElement;if(node?.parentElement===root)dirty.add(node);}
      }
      if(!frame)frame=requestAnimationFrame(run);
    });
    observer.observe(root,{childList:true,subtree:true,characterData:true});observers.push(observer);
    for(const block of root.children)dirty.add(block);
  }
  run();
  return ()=>{observers.forEach(o=>o.disconnect());cancelAnimationFrame(frame);CSS.highlights.delete('typora-underline');};
}
