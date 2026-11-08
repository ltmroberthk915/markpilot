// Private actual-closure fixture. Measures candidate synchronous read barriers,
// never browser rendering cost, FPS, or visual correctness.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const cssName = name => String(name).replace(/[A-Z]/g, c => '-' + c.toLowerCase());

function createFixture(file, options = {}) {
  let source = fs.readFileSync(file, 'utf8');
  source=source.replace('function paintHandles() {','function paintHandles() { globalThis.__probePaintCalls=(globalThis.__probePaintCalls||0)+1;');
  const anchor = 'exports.__test = __test;';
  if (source.split(anchor).length !== 2) throw Error('Export anchor must be unique');
  source = source.replace(anchor, `exports.__test = {...__test,__private:{onHandleDown,onHandleMove,onHandleUp,flushHandleMove,paintHandles,readHandleWidths,pinGrid,
    install(eng){handleState.engine=eng;layoutReapply=function(){return eng.flush();};layoutReapply.schedule=eng.requestApply;installHandleLifecycle({effect(){}});},
    activate(mode){if(mode==="native")overlayDoc={tab:{id:"native",contentId:"dsh-resource://file/absolute/D%3A/probe/a.md"}};else docsModeOn=true;bumpOverlay();},
    close(){closeDocsWorkbench();},paintCalls(){return globalThis.__probePaintCalls||0;},
    state(){return {side:handleState.side,dragging:handleState.dragging,sb:handleState.sb,rb:handleState.rb};}
  }};`);
  let now = 1000, rafId = 0, timerId = 0, dirty = false;
  let afterGridWrite = false, seq = 0;
  const frames = new Map(), timers = new Map(), elements = new Map(), storage = new Map();
  const ros = [], mos = [], log = [];
  const counts = {reads:0, queries:0, setters:0, changedWrites:0, barriers:0, afterGridBarriers:0,naturalLayouts:0,resizeDeliveries:0,paints:0};
  function record(type, node, field, value) { log.push({seq:++seq,type,node:node?.name || node || '',field,value}); }
  function write(node, key, value, changed) {
    counts.setters++;
    if (!changed) return;
    counts.changedWrites++; dirty = true;
    if (node?.name === 'frame' && /^--mp-(sidebar|rightbar|center-min)$/.test(key)) afterGridWrite = true;
    record('write', node, key, value);
  }
  function read(node, kind) {
    counts.reads++;
    if (dirty) { counts.barriers++; if (afterGridWrite) counts.afterGridBarriers++; record('candidate-barrier', node, kind, afterGridWrite); }
    dirty = false; afterGridWrite = false; record('read', node, kind);
  }
  function reset() { log.length = 0; seq=0; dirty=false; afterGridWrite=false; for (const k of Object.keys(counts)) counts[k]=0; }
  function eventTarget(node) {
    const listeners = new Map();
    node.addEventListener = (type, fn) => { if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn); };
    node.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    node.listenerCount = () => [...listeners.values()].reduce((n,s)=>n+s.size,0);
    return node;
  }
  function element(name, rectFn) {
    const values = new Map(), priority = new Map(), attrs = new Map();
    const el = eventTarget({name, tagName:'DIV', nodeType:1, children:[], dataset:{}, isConnected:true, className:'', parentElement:null});
    const style = {
      getPropertyValue:key=>values.get(key)||'', getPropertyPriority:key=>priority.get(key)||'',
      setProperty(key, value, importance=''){value=String(value);write(el,key,value,values.get(key)!==value||priority.get(key)!==importance);values.set(key,value);priority.set(key,importance);},
      removeProperty(key){const old=values.get(key)||'';write(el,key,'',values.has(key));values.delete(key);priority.delete(key);return old;},
    };
    el.style = new Proxy(style, {get:(t,k)=>k in t?t[k]:values.get(cssName(k))||'',set(t,k,v){t.setProperty(cssName(k),v);return true;}});
    const rect = () => {const r=rectFn?rectFn():{left:0,top:36,width:0,height:786};return {...r,right:r.right??r.left+r.width,bottom:r.bottom??r.top+r.height,x:r.left,y:r.top};};
    el.rawRect = rect;
    el.getBoundingClientRect = () => {read(el,'rect');return rect();};
    el.getClientRects = () => [el.getBoundingClientRect()];
    for(const [prop,axis] of [['offsetWidth','width'],['offsetHeight','height'],['clientWidth','width'],['clientHeight','height']]) Object.defineProperty(el,prop,{get(){read(el,prop);return rect()[axis];}});
    Object.defineProperty(el,'firstElementChild',{get:()=>el.children[0]||null});
    Object.defineProperty(el,'childElementCount',{get:()=>el.children.length});
    el.getAttribute = key => attrs.has(key)?attrs.get(key):null;
    el.hasAttribute = key => attrs.has(key);
    el.setAttribute = (key,value) => {value=String(value);write(el,'@'+key,value,attrs.get(key)!==value);attrs.set(key,value);};
    el.removeAttribute = key => {write(el,'@'+key,'',attrs.has(key));attrs.delete(key);};
    el.appendChild = child => {el.children.push(child);child.parentElement=el;child.isConnected=true;if(child.id)elements.set(child.id,child);return child;};
    el.remove = () => {el.isConnected=false;if(el.id)elements.delete(el.id);if(el.parentElement)el.parentElement.children=el.parentElement.children.filter(x=>x!==el);};
    el.contains = other => other===el||el.children.some(child=>child.contains(other));
    el.closest = selector => {let n=el;while(n){if(selector.includes('_frame')&&n.className.includes('_frame'))return n;n=n.parentElement;}return null;};
    el.querySelector = selector => {counts.queries++;return queryWithin(el,selector)[0]||null;};
    el.querySelectorAll = selector => {counts.queries++;return queryWithin(el,selector);};
    el.setPointerCapture = ()=>{};el.releasePointerCapture=()=>{};
    return el;
  }
  let window;
  const fullWidth=()=>window?.innerWidth||1600;
  const frame=element('frame',()=>({left:0,top:36,width:fullWidth(),height:786})); frame.className='fixture_frame';
  const initialSb=options.initialSb??280,initialRb=options.initialRb??300;
  const pinW = (key, fallback) => {const x=parseFloat(frame.style.getPropertyValue(key));return Number.isFinite(x)?x:fallback;};
  const sb=()=>pinW('--mp-sidebar',initialSb),rb=()=>pinW('--mp-rightbar',initialRb);
  const centerRect=()=>({left:sb(),top:36,width:fullWidth()-sb()-rb(),height:786});
  const sidebar=element('sidebar',()=>({left:0,top:36,width:sb(),height:786})); sidebar.className='fixture_sidebarCol';
  const rightbar=element('rightbar',()=>({left:fullWidth()-rb(),top:36,width:rb(),height:786})); rightbar.className='fixture_rightbarCol';
  let parent=element('main',centerRect); parent.className='fixture_centerCol';
  let root=element('root',centerRect);root.className='fixture_root';root.dataset.phase='active';
  const headerHeight=()=>options.wrapAt&&centerRect().width<options.wrapAt?64:32;
  let header=element('header',()=>({...centerRect(),height:headerHeight(),bottom:36+headerHeight()}));
  let body=element('body',()=>{const r=centerRect(),ml=parseFloat(body.style.marginLeft)||0,mr=parseFloat(body.style.marginRight)||0;return {...r,left:r.left+ml,width:Math.max(0,r.width-ml-mr),top:36+headerHeight(),height:786-headerHeight()};}); body.setAttribute('data-conversation-content','');
  const sidebarContent=element('sidebar-content',()=>({left:0,top:36,width:Math.max(280,sb()),height:786}));
  const rightContent=element('right-content',()=>({left:fullWidth()-rb(),top:36,width:300,height:786}));
  const leftHandle=element('left-handle',()=>({left:sb(),top:36,width:8,height:786}));leftHandle.className='fixture_handle';leftHandle.setAttribute('data-side','sidebar');
  const rightHandle=element('right-handle',()=>({left:fullWidth()-rb(),top:36,width:8,height:786}));rightHandle.className='fixture_handle';rightHandle.setAttribute('data-side','rightbar');
  const stage=element('stage');stage.id='mp-stage';elements.set(stage.id,stage);
  const docBody=element('document-body',()=>({left:0,top:0,width:fullWidth(),height:822}));
  docBody.appendChild(frame);frame.appendChild(sidebar);frame.appendChild(parent);frame.appendChild(rightbar);frame.appendChild(leftHandle);frame.appendChild(rightHandle);
  sidebar.appendChild(sidebarContent);rightbar.appendChild(rightContent);parent.appendChild(root);root.appendChild(header);root.appendChild(body);docBody.appendChild(stage);
  function descendants(el) {return el.children.flatMap(x=>[x,...descendants(x)]);}
  function queryWithin(el, selector) {
    const nodes=descendants(el);
    if(selector==='*')return nodes;
    if(selector===':scope > [data-conversation-content]')return el.children.filter(x=>x.hasAttribute('data-conversation-content'));
    if(selector.includes('_sidebarCol'))return nodes.filter(x=>x.className.includes('_sidebarCol'));
    if(selector.includes('_rightbarCol'))return nodes.filter(x=>x.className.includes('_rightbarCol'));
    if(selector.includes('_mainCol'))return nodes.filter(x=>x.className.includes('_mainCol'));
    if(selector.includes('_centerCol'))return nodes.filter(x=>x.className.includes('_centerCol'));
    if(selector.includes('_frame'))return nodes.filter(x=>x.className.includes('_frame'));
    if(selector.includes('_handle'))return nodes.filter(x=>x.className.includes('_handle'));
    if(selector==='[data-phase]')return [root];
    const attr=selector.match(/^\[([^=\]]+)\]$/); if(attr)return nodes.filter(x=>x.hasAttribute(attr[1]));
    return [];
  }
  const document=eventTarget({body:docBody,head:docBody,documentElement:docBody,
    querySelectorAll:s=>{counts.queries++;return queryWithin(docBody,s);},
    querySelector:s=>{counts.queries++;return queryWithin(docBody,s)[0]||null;},
    getElementById:id=>elements.get(id)||null,createElement:tag=>{const x=element('generated-'+tag);x.tagName=tag.toUpperCase();return x;},
  });
  const raf=fn=>{frames.set(++rafId,fn);return rafId;};
  function flushRaf(){record('phase','','raf');for(const [id,fn] of [...frames]){if(frames.has(id)){frames.delete(id);fn(now);}}}
  function nativeLayout(){record('phase','','native-layout');if(dirty)counts.naturalLayouts++;dirty=false;afterGridWrite=false;}
  function deliverChangedResize(force=false){
    const batches=[];
    for(const ro of ros){const entries=[];for(const target of ro.targets){const r=target.rawRect(),prior=ro.last.get(target),size=[r.width,r.height];if(force||!prior||prior[0]!==size[0]||prior[1]!==size[1]){ro.last.set(target,size);entries.push({target,contentRect:r,borderBoxSize:[{inlineSize:r.width,blockSize:r.height}]});}}
      if(entries.length)batches.push([ro,entries]);}
    for(const [ro,entries]of batches){if(ro.targets.length){counts.resizeDeliveries++;record('phase','','resize-observer',entries.map(x=>x.target.name));ro.cb(entries);}}
    return batches.length;
  }
  function nativeAndPaint({skipResize=false}={}){nativeLayout();if(!skipResize){for(let i=0;i<5;i++){if(!deliverChangedResize())break;nativeLayout();if(i===4)throw Error('Synthetic ResizeObserver loop did not settle');}}counts.paints++;record('phase','','paint');}
  function flush(opts){flushRaf();nativeAndPaint(opts);}
  class RO {constructor(cb){this.cb=cb;this.targets=[];this.last=new Map();ros.push(this);}observe(node){this.targets.push(node);this.last.delete(node);}unobserve(node){this.targets=this.targets.filter(x=>x!==node);this.last.delete(node);}disconnect(){this.targets=[];this.last.clear();}}
  class MO {constructor(cb){this.cb=cb;this.targets=[];mos.push(this);}observe(node,opts){this.targets.push({node,opts});}disconnect(){this.targets=[];}}
  function computed(el) {
    read(el,'getComputedStyle');
    const r=el.rawRect();
    const values={display:'flex',position:'static',zoom:el.style.zoom||'1',transform:'none',direction:'ltr',boxSizing:'border-box',width:r.width+'px',height:r.height+'px',paddingLeft:'0px',paddingRight:'0px',paddingTop:'0px',paddingBottom:'0px',borderLeftWidth:'0px',borderRightWidth:'0px',marginLeft:'0px',marginRight:'0px',columnGap:'0px',rowGap:'0px',gap:'0px',transitionProperty:'none',transitionDuration:'0s',animationName:'none',contain:'none',writingMode:'horizontal-tb',whiteSpace:options.wrapAt?'normal':'nowrap',flexWrap:options.wrapAt?'wrap':'nowrap'};
    if(el===frame){values.display='grid';values.gridTemplateColumns=`${sb()}px ${fullWidth()-sb()-rb()}px ${rb()}px`;}
    return {...values,getPropertyValue:key=>values[key]??values[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]??el.style.getPropertyValue(key)};
  }
  let captured;
  window=eventTarget({innerWidth:options.viewportWidth??1600,innerHeight:822,devicePixelRatio:1,navigator:{platform:options.navigatorPlatform??'Win32',userAgent:'Windows NT 10.0; Win64; x64',userAgentData:{platform:'Windows'}},performance:{now:()=>now},__ModuleLoader__:{load:x=>captured=x},
    requestAnimationFrame:raf,cancelAnimationFrame:id=>frames.delete(id),ResizeObserver:options.withoutResizeObserver?undefined:RO,MutationObserver:MO,getComputedStyle:computed,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
  });
  const sandbox={window,document,console,navigator:window.navigator,requestAnimationFrame:raf,cancelAnimationFrame:window.cancelAnimationFrame,getComputedStyle:computed,ResizeObserver:RO,MutationObserver:MO,
    setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,at:now+delay});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval(){}};
  vm.createContext(sandbox);vm.runInContext(source,sandbox,{filename:file});
  const exported=captured.factory(()=>null).__test,L=exported.layout,P=exported.__private;
  L.setSqueezeForTests(false);
  if(options.platform!==undefined)docBody.setAttribute('data-platform',options.platform);
  frame.style.gridTemplateColumns=`${initialSb}px minmax(400px, 1fr) ${initialRb}px`;
  const engine=L.createLayoutEngine({doc:document,win:window,cfg:{enabled:true,mode:'center',chatWidth:420},...options});
  if(options.rightbarClosed)frame.setAttribute("data-rightbar-collapsed","true");P.install(engine);P.activate(options.activation||"native");engine.flush();nativeAndPaint();flush();frames.clear();reset();
  const event=(x,target=leftHandle,type='pointermove')=>({clientX:x,clientY:100,target,button:0,buttons:1,pointerId:1,type,preventDefault(){},stopPropagation(){}});
  function start(side='sidebar'){const handle=side==='sidebar'?leftHandle:rightHandle;const x=side==='sidebar'?sb():fullWidth()-rb();P.onHandleDown(event(x,handle,'pointerdown'));return x;}
  function geometry(){return {sb:sb(),rb:rb(),chatW:engine.snapshot().chatW,marginLeft:body.style.getPropertyValue('margin-left'),marginRight:body.style.getPropertyValue('margin-right'),widthVar:body.style.getPropertyValue('--dsh-chat-user-width'),stage:Object.fromEntries(['left','top','width','height','display'].map(k=>[k,stage.style.getPropertyValue(k)])),handles:{left:leftHandle.style.left,right:rightHandle.style.left}};}
  function deliverResize(){nativeLayout();deliverChangedResize(true);}
  function replaceRoot(){const old={root,body,parent,header};root.isConnected=false;body.isConnected=false;header.isConnected=false;parent.isConnected=false;frame.children=frame.children.filter(x=>x!==parent);parent=element('main-v2',centerRect);parent.className='fixture_centerCol';root=element('root-v2',centerRect);root.dataset.phase='active';header=element('header-v2',()=>({...centerRect(),height:40,bottom:76}));body=element('body-v2',()=>({...centerRect(),top:76,height:746}));body.setAttribute('data-conversation-content','');frame.appendChild(parent);parent.appendChild(root);root.appendChild(header);root.appendChild(body);return old;}
  return {L,P,engine,frame,stage,window,document,ros,mos,frames,timers,storage,log,counts,reset,flush,flushRaf,nativeAndPaint,nativeLayout,deliverChangedResize,start,event,geometry,deliverResize,replaceRoot,get root(){return root;},get body(){return body;},get parent(){return parent;},get header(){return header;},
    dispose(){engine.dispose();window.__mpHandleFloorDispose?.();},advance(dt){now+=dt;for(const[id,t]of[...timers])if(t.at<=now){timers.delete(id);t.fn();}}};
}

module.exports={createFixture};
