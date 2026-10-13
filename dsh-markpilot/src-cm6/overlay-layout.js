// One viewport-space placement policy. Higher-priority controls protect their
// hit area; a preview never writes source, selection, focus or scroll to fit.
export function verticalFrame({ bounds, anchor, left, width, height, obstacles = [], minimumHeight = 20, maxDisplacement = Infinity }) {
  const blocked = obstacles.filter(r=>r.right>left&&r.left<left+width&&r.bottom>bounds.top&&r.top<bounds.bottom)
    .map(r=>[Math.max(bounds.top,r.top-2),Math.min(bounds.bottom,r.bottom+2)]).sort((a,b)=>a[0]-b[0]);
  const bands=[];let cursor=bounds.top;
  for(const [a,b] of blocked){if(a>cursor)bands.push([cursor,a]);cursor=Math.max(cursor,b);}
  if(cursor<bounds.bottom)bands.push([cursor,bounds.bottom]);
  const preferred=anchor.bottom+6,above=anchor.top-height-6;
  const fits=bands.filter(([a,b])=>b-a>=height).map(([a,b])=>{
    const top=Math.max(a,Math.min(preferred,b-height));return{top,height,cost:Math.abs(top-preferred),constrained:false};
  }).filter(slot=>Math.abs(slot.top-preferred)<=maxDisplacement);
  if(fits.length)return fits.sort((a,b)=>a.cost-b.cost||Math.abs(a.top-above)-Math.abs(b.top-above))[0];
  const slots=bands.filter(([a,b])=>b-a>=minimumHeight).map(([a,b])=>{
    const top=Math.max(a,preferred-maxDisplacement);
    return {top,height:Math.min(height,b-top),cost:Math.abs(top-preferred),constrained:true};
  }).filter(slot=>slot.height>=minimumHeight&&Math.abs(slot.top-preferred)<=maxDisplacement);
  if(!slots.length)return null;
  return slots.sort((a,b)=>b.height-a.height||a.cost-b.cost)[0];
}
export const PREVIEW_MAX_DISPLACEMENT = 96;
// Only formula previews opt into this limit. Completion keeps the unrestricted
// policy. When the nearby band is full, return the legacy covering anchor.
export function previewFrame(options) {
  const {bounds,anchor,height,minimumHeight=20}=options;
  const maxDisplacement=options.maxDisplacement??PREVIEW_MAX_DISPLACEMENT;
  const legacyTop=options.legacyTop??Math.max(bounds.top,Math.min(anchor.bottom+6,bounds.bottom-minimumHeight));
  const slot=verticalFrame({...options,anchor:{...anchor,bottom:legacyTop-6},maxDisplacement});
  if(slot)return {...slot,overlay:false,displacement:slot.top-legacyTop};
  const available=Math.max(minimumHeight,bounds.bottom-legacyTop),h=Math.min(height,available);
  return {top:legacyTop,height:h,constrained:h<height,overlay:true,displacement:0};
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
export function textObstacles(view, bounds = null) {
  const out=[],widgets='.mp-cm6-math,.mp-cm6-math-block,.mp-img,.mp-mermaid,.mp-table-wrap';
  const relevant=r=>r.width&&r.height&&(!bounds||overlap(r,bounds));
  // CM's direct children are rendered lines/blocks. Reject distant containers
  // before walking text or making Range rectangles; include intersecting blocks
  // even when their start is outside the candidate band.
  for(const root of view.contentDOM.children){
    if(bounds&&!relevant(root.getBoundingClientRect()))continue;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())){
      if(!node.nodeValue.trim()||node.parentElement.closest('.mp-inline-float,.mp-qmark,.mp-cm6-math,.mp-cm6-math-block,.mp-mermaid,.mp-table-wrap,.mp-img'))continue;
      const range=document.createRange();range.selectNodeContents(node);
      for(const r of range.getClientRects())if(relevant(r))out.push(r);
    }
    const blocks=[...(root.matches(widgets)?[root]:[]),...root.querySelectorAll(widgets)];
    for(const node of blocks){if(node.closest('.mp-inline-float'))continue;const r=node.getBoundingClientRect();if(relevant(r))out.push(r);}
  }
  return out;
}
