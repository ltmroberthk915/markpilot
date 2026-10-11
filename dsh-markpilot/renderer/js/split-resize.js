// Layout only: changing pane widths must never write to the Markdown editor.
export function installSplitResize(source,preview,{begin,change,end}){
  const container=source.parentElement,bar=document.createElement('div'),storageKey='typora-split-source-share';
  let share=.5,active=false,drag=null,frame=0,resizeFrame=0,pendingX=null,lastWidth=0;
  try{const saved=Number(localStorage.getItem(storageKey));if(saved>=.15&&saved<=.85)share=saved;}catch{}
  bar.className='typora-split-divider';bar.tabIndex=0;bar.setAttribute('role','separator');bar.setAttribute('aria-orientation','vertical');bar.setAttribute('aria-label','调整源码与预览宽度');bar.title='拖动调整宽度 · 方向键微调 · 双击恢复各半';bar.hidden=true;
  container.insertBefore(bar,preview);
  const limits=()=>{const left=source.getBoundingClientRect().left,right=preview.getBoundingClientRect().right,width=Math.max(1,right-left-6),min=Math.max(.15,Math.min(.45,160/width));return{left,width,min,max:1-min};};
  const apply=value=>{
    const {min,max,width}=limits();share=Math.max(min,Math.min(max,value));lastWidth=width;
    container.style.setProperty('--typora-source-width',share*width+'px');
    bar.setAttribute('aria-valuemin',String(Math.round(min*100)));bar.setAttribute('aria-valuemax',String(Math.round(max*100)));bar.setAttribute('aria-valuenow',String(Math.round(share*100)));change();
  };
  const save=()=>{try{localStorage.setItem(storageKey,String(share));}catch{}};
  const flush=()=>{frame=0;if(pendingX==null)return;const {left,width}=limits();apply((pendingX-left-3)/width);pendingX=null;};
  const finish=()=>{if(!drag)return;cancelAnimationFrame(frame);flush();const id=drag;drag=null;if(bar.hasPointerCapture(id))bar.releasePointerCapture(id);container.classList.remove('typora-split-dragging');save();end();};
  bar.addEventListener('pointerdown',event=>{if(!active||event.button!==0)return;event.preventDefault();begin();drag=event.pointerId;bar.setPointerCapture(drag);container.classList.add('typora-split-dragging');});
  bar.addEventListener('pointermove',event=>{if(drag!==event.pointerId)return;pendingX=event.clientX;if(!frame)frame=requestAnimationFrame(flush);});
  bar.addEventListener('pointerup',finish);bar.addEventListener('pointercancel',finish);bar.addEventListener('lostpointercapture',finish);
  bar.addEventListener('dblclick',event=>{event.preventDefault();begin();apply(.5);save();end();});
  bar.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();const {min,max}=limits();begin();
    apply(event.key==='Home'?min:event.key==='End'?max:share+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?.05:.01));save();end();
  });
  // Writing widths during ResizeObserver delivery can resize an already
  // delivered ancestor when the IDE opens its AI sidebar. Defer that write.
  const observer=new ResizeObserver(()=>{
    if(active&&!resizeFrame)resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;if(active&&Math.abs(limits().width-lastWidth)>.5)apply(share);});
  });observer.observe(container);observer.observe(preview);
  return{
    setActive(value){if(value===active)return;active=value;bar.hidden=!active;container.classList.toggle('typora-split-resizable',active);if(active)apply(share);else{cancelAnimationFrame(resizeFrame);resizeFrame=0;finish();}},
    destroy(){finish();observer.disconnect();cancelAnimationFrame(frame);cancelAnimationFrame(resizeFrame);bar.remove();container.classList.remove('typora-split-resizable','typora-split-dragging');container.style.removeProperty('--typora-source-width');}
  };
}
