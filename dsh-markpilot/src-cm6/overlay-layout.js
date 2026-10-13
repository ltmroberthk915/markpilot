// One viewport-space placement policy. Higher-priority controls protect their
// hit area; a preview never writes source, selection, focus or scroll to fit.
export function verticalFrame({ bounds, anchor, left, width, height, obstacles = [], minimumHeight = 20 }) {
  const blocked = obstacles.filter(r=>r.right>left&&r.left<left+width&&r.bottom>bounds.top&&r.top<bounds.bottom)
    .map(r=>[Math.max(bounds.top,r.top-2),Math.min(bounds.bottom,r.bottom+2)]).sort((a,b)=>a[0]-b[0]);
  const bands=[];let cursor=bounds.top;
  for(const [a,b] of blocked){if(a>cursor)bands.push([cursor,a]);cursor=Math.max(cursor,b);}
  if(cursor<bounds.bottom)bands.push([cursor,bounds.bottom]);
  const preferred=anchor.bottom+6,above=anchor.top-height-6;
  const fits=bands.filter(([a,b])=>b-a>=height).map(([a,b])=>{
    const top=Math.max(a,Math.min(preferred,b-height));return{top,height,cost:Math.abs(top-preferred),constrained:false};
  });
  if(fits.length)return fits.sort((a,b)=>a.cost-b.cost||Math.abs(a.top-above)-Math.abs(b.top-above))[0];
  const slots=bands.filter(([a,b])=>b-a>=minimumHeight).map(([a,b])=>({top:a,height:b-a,cost:Math.abs(a-preferred),constrained:true}));
  if(!slots.length)return null;
  return slots.sort((a,b)=>b.height-a.height||a.cost-b.cost)[0];
}
export const overlap = (a,b) => a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
const controls = [['.mp-toolbar',4],['.mp-pop,.mp-dialog,.cm-search,#mp-banner',3],['.mp-complete,.mp-table-bar,.mp-cell-overlay',2]];
export function controlObstacles(view, priority = 1) {
  const out=[];
  for(const [selector,rank] of controls)if(rank>priority)for(const node of document.querySelectorAll(selector)){
    const r=node.getBoundingClientRect();if(r.width>0&&r.height>0&&getComputedStyle(node).visibility!=='hidden')out.push(r);
  }
  return out;
}
export function textObstacles(view) {
  const out=[],walker=document.createTreeWalker(view.contentDOM,NodeFilter.SHOW_TEXT);
  let node;
  while((node=walker.nextNode())){
    if(!node.nodeValue.trim()||node.parentElement.closest('.mp-inline-float,.mp-qmark,.mp-cm6-math,.mp-cm6-math-block,.mp-mermaid,.mp-table-wrap,.mp-img'))continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const r of range.getClientRects())if(r.width&&r.height)out.push(r);
  }
  for(const node of view.contentDOM.querySelectorAll('.mp-cm6-math,.mp-cm6-math-block,.mp-img,.mp-mermaid,.mp-table-wrap')){
    if(node.closest('.mp-inline-float'))continue;const r=node.getBoundingClientRect();if(r.width&&r.height)out.push(r);
  }
  return out;
}
