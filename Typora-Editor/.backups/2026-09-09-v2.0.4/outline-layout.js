// Keep Vditor's outline inside .vditor-content: native heading navigation,
// hint coordinates and formula scheduling all refer to this existing node.
export function installOutlineLayout(api) {
  const editor=api.vditor,host=editor.element,outline=editor.outline.element;
  const content=outline.parentElement,toolbar=editor.toolbar.element;
  const toggle=editor.toolbar.elements.outline?.querySelector('button');
  outline.id ||= 'typora-outline';toggle?.setAttribute('aria-controls',outline.id);
  // Vditor assumes a narrow Webview is a phone and refuses to open its outline.
  // A VS Code split editor is also narrow; our clamped sidebar leaves 240 px
  // for the writing area, so keep the requested toggle usable there as well.
  const originalToggle=editor.outline.toggle;
  const responsiveToggle=function(state,shown=true,...args){
    const result=originalToggle.call(this,state,shown,...args);
    if(shown&&window.innerWidth<520){
      outline.style.display='block';this.render(state);
      toggle?.classList.add('vditor-menu--current');window.dispatchEvent(new Event('resize'));
    }
    return result;
  };
  editor.outline.toggle=responsiveToggle;
  // IDE sidebar outline navigation: the host sends the heading's ordinal
  // (source order) or its source line; scroll there and take the caret, the
  // same result as clicking this editor's own outline. Inert in the desktop
  // app because nothing emits the message.
  window.handler?.on('outline-reveal',payload=>{
    try{
      window.__outlineReveal={index:payload?.index,line:payload?.line,mode:editor.currentMode,at:performance.now()};
      const index=payload?.index;
      if(editor.currentMode==='sv'){
        // The SV pane highlights source into per-line elements, so literal
        // newline counting is unreliable: anchor on the heading's own text.
        const source=editor.sv.element,marker=payload?.text;
        source.focus();
        const walker=document.createTreeWalker(source,NodeFilter.SHOW_TEXT);
        let node,range=null;
        while((node=walker.nextNode())){
          const at=marker?node.data.indexOf(marker):-1;
          if(at>=0){range=document.createRange();range.setStart(node,at);range.collapse(true);break;}
        }
        if(!range){const first=source.querySelector('h1,h2,h3,h4,h5,h6')?.firstChild||source.firstChild;if(first){range=document.createRange();range.setStart(first,0);range.collapse(true);}}
        if(range){
          const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
          const rect=range.getClientRects()[0];
          if(rect)source.scrollTop=Math.max(0,rect.top+source.scrollTop-source.clientHeight/3);
        }
        return;
      }
      if(typeof index!=='number'||index<0)return;
      const root=editor[editor.currentMode].element;
      const headings=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      const heading=headings[index]||(payload?.text&&headings.find(node=>node.textContent.trim()===payload.text));
      if(!heading)return;
      heading.scrollIntoView({block:'center',behavior:'instant'});
      root.focus({preventScroll:true});
      const walker=document.createTreeWalker(heading,NodeFilter.SHOW_TEXT);const first=walker.nextNode();
      if(first){const range=document.createRange();range.setStart(first,0);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}
    }catch{/* reveal must never disturb editing */}
  });
  const saved=Number(localStorage.getItem('outline-width'));
  let preferred=saved>=80&&saved<=640?saved:250,frame=0,drag=null;
  const separator=document.createElement('div');
  separator.className='typora-outline-resizer';separator.tabIndex=0;
  separator.setAttribute('role','separator');separator.setAttribute('aria-orientation','vertical');
  separator.setAttribute('aria-label','调整大纲宽度');
  separator.title='拖动调整大纲宽度；双击恢复默认宽度';
  host.classList.add('typora-layout');host.append(separator);
  const bounds=()=>{const max=Math.max(80,Math.min(640,host.clientWidth-240));return{min:Math.min(160,max),max};};
  const clamp=value=>{const {min,max}=bounds();return Math.max(min,Math.min(max,value));};
  const set=(element,name,value)=>{if(element.style.getPropertyValue(name)!==value)element.style.setProperty(name,value);};
  const update=()=>{
    frame=0;
    const shown=outline.style.display==='block',width=clamp(preferred);
    const zoom=Number.parseFloat(getComputedStyle(content).zoom)||1;
    const cssWidth=width/zoom,oldWidth=Number.parseFloat(outline.style.width);
    // CSSOM rounds fractional pixel values. Comparing its serialized string
    // with a full-precision pointer coordinate would cause an idle RAF loop.
    const changed=!Number.isFinite(oldWidth)||Math.abs(oldWidth-cssWidth)>.01;
    if(changed)outline.style.width=`${cssWidth}px`;
    set(host,'--typora-outline-width',`${shown?width:0}px`);
    separator.hidden=!shown;
    const {min,max}=bounds();
    separator.setAttribute('aria-valuemin',String(min));separator.setAttribute('aria-valuemax',String(max));
    separator.setAttribute('aria-valuenow',String(Math.round(width)));
    // Recalculate Vditor's centered writing area only when its width changed.
    // No document parsing, math rendering or polling is needed for this layout.
    if(changed)window.dispatchEvent(new Event('resize'));
    set(host,'--typora-toolbar-height',`${toolbar.offsetHeight}px`);
    toggle?.setAttribute('aria-expanded',String(shown));
    toggle?.setAttribute('aria-label',shown?'收起大纲':'展开大纲');
    const top=Math.max(8,Math.min(toolbar.getBoundingClientRect().bottom+8,window.innerHeight-100));
    set(document.documentElement,'--typora-find-top',`${top}px`);
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
  const persist=()=>localStorage.setItem('outline-width',String(Math.round(preferred)));
  const down=event=>{
    if(event.button!==0||separator.hidden)return;
    event.preventDefault();
    drag={id:event.pointerId,x:event.clientX,width:clamp(preferred),previous:preferred,
      scale:host.getBoundingClientRect().width/host.offsetWidth||1};
    separator.setPointerCapture(event.pointerId);host.classList.add('typora-outline-dragging');
  };
  const move=event=>{
    if(!drag||drag.id!==event.pointerId)return;
    preferred=clamp(drag.width+(event.clientX-drag.x)/drag.scale);schedule();
  };
  const finish=event=>{
    if(!drag||drag.id!==event.pointerId)return;
    if(event.type==='pointercancel')preferred=drag.previous;
    const id=drag.id;drag=null;
    if(separator.hasPointerCapture(id))separator.releasePointerCapture(id);
    host.classList.remove('typora-outline-dragging');persist();schedule();
  };
  const reset=()=>{preferred=250;persist();schedule();};
  const keydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const {min,max}=bounds();
    preferred=event.key==='Home'?min:event.key==='End'?max:clamp(clamp(preferred)+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?32:16));
    persist();schedule();
  };
  separator.addEventListener('pointerdown',down);separator.addEventListener('pointermove',move);
  separator.addEventListener('pointerup',finish);separator.addEventListener('pointercancel',finish);
  separator.addEventListener('lostpointercapture',finish);separator.addEventListener('dblclick',reset);
  separator.addEventListener('keydown',keydown);
  const resize=new ResizeObserver(schedule);resize.observe(host);resize.observe(toolbar);
  const attributes=new MutationObserver(schedule);
  attributes.observe(outline,{attributes:true,attributeFilter:['style']});
  attributes.observe(content,{attributes:true,attributeFilter:['style']});
  update();
  return ()=>{
    if(editor.outline.toggle===responsiveToggle)editor.outline.toggle=originalToggle;
    resize.disconnect();attributes.disconnect();cancelAnimationFrame(frame);separator.remove();
    host.classList.remove('typora-layout','typora-outline-dragging');
    host.style.removeProperty('--typora-outline-width');outline.style.removeProperty('width');
    host.style.removeProperty('--typora-toolbar-height');document.documentElement.style.removeProperty('--typora-find-top');
  };
}
