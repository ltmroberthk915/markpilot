/** A searchable view of editable text, excluding generated math/diagram DOM. */
export const PREVIEWS='.vditor-ir__preview,.vditor-wysiwyg__preview';
export function sourceText(root) {
  let text='';const spans=[];
  const visit=node=>{
    if (node.nodeType===3) {
      spans.push({node,start:text.length,end:text.length+node.length});text+=node.data;return;
    }
    if (node.nodeType!==1 || node.matches(PREVIEWS+',script,style,wbr,[data-type="toc-block"]')) return;
    for (const child of node.childNodes) visit(child);
    // 块尾分隔符：DIV/PRE 是块公式（$$ 围栏）、代码块等的顶层容器——清单缺它们时，
    // 上一块的尾巴和下一块的围栏在可搜索文本里无缝拼接（"段落abc" + "$$" → "abc$$"），
    // 跨块出现假命中（搜 "c$" 命中段落尾与公式围栏的接缝）。补上后块与块之间一律有 \n。
    if (node!==root && /^(P|H[1-6]|LI|TR|BLOCKQUOTE|DIV|PRE)$/.test(node.tagName)) text+='\n';
  };
  visit(root);
  const point=(offset,end=false)=>{
    let lo=0, hi=spans.length;
    while(lo<hi){const m=(lo+hi)>>>1;if(end ? spans[m].end<offset : spans[m].end<=offset)lo=m+1;else hi=m;}
    const item=spans[Math.min(lo,spans.length-1)];
    return item ? [item.node,Math.max(0,Math.min(item.node.length,offset-item.start))] : [root,0];
  };
  return {text,spans,point,range(start,end){const r=document.createRange();r.setStart(...point(start));r.setEnd(...point(end,true));return r;}};
}
export function selectRange(root,range) {
  root.focus({preventScroll:true});getSelection().removeAllRanges();getSelection().addRange(range);
}
