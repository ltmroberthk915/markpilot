// Keep Vditor's outline inside .vditor-content: native heading navigation,
// hint coordinates and formula scheduling all refer to this existing node.
import {afterPaint} from './warmup.js';
export function installOutlineLayout(api) {
  const editor=api.vditor,host=editor.element,outline=editor.outline.element;
  // 【C7 2026-10-02】大纲点击 / IDE 的 outline-reveal 都是"程序性选区跳转"：既不经过键盘、也不点
  // 在编辑面上，纵向移动补丁的 goalX/lastBox 两个 reset 时机都碰不到它——旧的目标列于是被带进
  // 新位置（连按 ↓ 后点大纲跳标题再按 ↓，目标列还是旧行那一列）。跳转完成后发一个事件，
  // typora-patches 收到即清；通知失败不影响跳转本身。
  const jump=()=>{try{window.dispatchEvent(new Event('typora-selection-jump'));}catch{/* 只发通知 */}};
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
          jump();
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
      if(first){const range=document.createRange();range.setStart(first,0);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);jump();}
    }catch{/* reveal must never disturb editing */}
  });
  const saved=Number(localStorage.getItem('outline-width'));
  let preferred=saved>=80&&saved<=640?saved:250,frame=0,drag=null,warmed=false;
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
    // 首屏之前不做几何：这段代码每次"写样式再读几何"都会强制重排整篇文档
    // （348k 字素材实测 329ms，另加我们派发 resize 触发 Vditor 的 K 全量重排
    // 1017ms），而这些量只服务于侧栏自身的宽度，读者看不见差别。CSS 变量由
    // 样式表兜底，等 warmup 在首屏之后放行再做第一次真正的量取。
    if(!warmed)return;
    // 先读后写：读-写交错时每一次读都会重排整篇文档（单次约 170ms）。原先
    // 交错四次，现在只付一次。
    const shown=outline.style.display==='block',width=clamp(preferred);
    const zoom=Number.parseFloat(getComputedStyle(content).zoom)||1;
    const oldWidth=Number.parseFloat(outline.style.width);
    const {min,max}=bounds();
    const toolbarHeight=toolbar.offsetHeight,toolbarBottom=toolbar.getBoundingClientRect().bottom;
    const viewport=window.innerHeight;
    /* ---------- 以下只写不读 ---------- */
    const cssWidth=width/zoom;
    // CSSOM rounds fractional pixel values. Comparing its serialized string
    // with a full-precision pointer coordinate would cause an idle RAF loop.
    const changed=!Number.isFinite(oldWidth)||Math.abs(oldWidth-cssWidth)>.01;
    if(changed)outline.style.width=`${cssWidth}px`;
    set(host,'--typora-outline-width',`${shown?width:0}px`);
    separator.hidden=!shown;
    separator.setAttribute('aria-valuemin',String(min));separator.setAttribute('aria-valuemax',String(max));
    separator.setAttribute('aria-valuenow',String(Math.round(width)));
    // Recalculate Vditor's centered writing area only when the width changed.
    // No document parsing, math rendering or polling is needed for this layout.
    // 面板隐藏时它不占宽度，内容区没有变化：此时派发 resize 只会让 Vditor 白跑一次
    // 全量重排（实测 500ms 级），所以只在真正显示着的时候通知。
    if(changed&&shown)window.dispatchEvent(new Event('resize'));
    set(host,'--typora-toolbar-height',`${toolbarHeight}px`);
    // The toolbar lives outside the content element, while the outline panel
    // and the scroller live inside it and inherit its zoom. A toolbar-height
    // margin set inside zoomed content would render zoom-times too tall
    // (v2.0.4 overlay layout); expose the zoom-compensated value too.
    set(host,'--typora-toolbar-inner',`${(toolbarBottom/zoom).toFixed(2)}px`);
    toggle?.setAttribute('aria-expanded',String(shown));
    toggle?.setAttribute('aria-label',shown?'收起大纲':'展开大纲');
    const top=Math.max(8,Math.min(toolbarBottom+8,viewport-100));
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
  outline.addEventListener('click',()=>jump(),true);   // 大纲项点击＝程序性选区跳转：清纵向目标列（见 jump 注释）
  // 【B2 2026-10-04】大纲/目录点击的落位修正。vditor 对 outline 面板条目与文内 [toc] 块
  // 条目（都带 data-target-id）的点击，最终都是给滚动容器直赋 `scrollTop=目标.offsetTop`
  // （dist 的 outline 点击与 vditor-toc 点击两处）。直赋值不经过 CSS 的
  // scroll-padding-top——而 media-tools.css 已在 .vditor-reset 上声明
  // `scroll-padding-top:calc(var(--typora-toolbar-inner,var(--typora-toolbar-height,36px))
  // + 14px)`：锚点链接（util.js scrollToAnchor 走 scrollIntoView）吃得到这份留白，
  // 大纲/TOC 却贴死视口顶沿、被悬浮工具栏盖住（实测点击后标题顶沿=视口顶 0px，工具栏
  // 下沿在 71px，标题整行埋进工具栏区）。实测 vditor 的直赋值发生在点击派发内
  // （HTMLUListElement 监听器），微任务补滚会先于它执行、随即被覆写；所以这里在捕获
  // 阶段直接拦下这条点击（stopPropagation 压掉 vditor 挂在面板内部列表上的监听器），
  // 由我们自己滚：scrollIntoView({block:'start'}) 吃 scroll-padding，标题落在工具栏
  // 下沿 +14px 呼吸空间；工具栏实测高度由上方 update() 动态写入 CSS 变量（收起/自动
  // 隐藏态跟随），这里不写死像素。文内 [toc] 条目原本是死路径（渲染出的 span 没有
  // vditor-toc 类，vditor 的点击处理器不认，点击无任何滚动），这里一并救活。
  const revealBelowToolbar = event => {
    let node = event.target;
    while (node && node instanceof Element) {
      if (node.classList.contains('vditor-outline__action')) return;   // 折叠开关留给 vditor，只切列表不滚动
      const id = node.getAttribute && node.getAttribute('data-target-id');
      if (id) {
        const heading = document.getElementById(id);
        if (heading) {
          event.stopPropagation();   // 压掉 vditor 的 scrollTop=offsetTop 直赋值（贴顶根源）
          jump();                    // 顶替上面那个 jump 捕获监听器（本条点击不再传到它）
          try { heading.scrollIntoView({block: 'start', behavior: 'instant'}); }
          catch { try { heading.scrollIntoView(); } catch { /* 连基本调用都失败：放弃本条跳转，不错位 */ } }
        }
        return;
      }
      node = node.parentElement;
    }
  };
  content.addEventListener('click', revealBelowToolbar, true);   // 大纲面板与文内 [toc] 条目都在 content 内
  const resize=new ResizeObserver(schedule);resize.observe(host);resize.observe(toolbar);
  const attributes=new MutationObserver(schedule);
  attributes.observe(outline,{attributes:true,attributeFilter:['style']});
  attributes.observe(content,{attributes:true,attributeFilter:['style']});
  afterPaint('outline-layout',()=>{warmed=true;update();return true;});
  return ()=>{
    if(editor.outline.toggle===responsiveToggle)editor.outline.toggle=originalToggle;
    resize.disconnect();attributes.disconnect();cancelAnimationFrame(frame);separator.remove();
    host.classList.remove('typora-layout','typora-outline-dragging');
    host.style.removeProperty('--typora-outline-width');outline.style.removeProperty('width');
    host.style.removeProperty('--typora-toolbar-height');document.documentElement.style.removeProperty('--typora-find-top');
  };
}
