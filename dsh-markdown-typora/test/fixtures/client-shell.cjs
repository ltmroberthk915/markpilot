// Actual shell closure with a minimal DOM double; not browser layout evidence.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=process.env.MP_TRIAL_ROOT||path.resolve(__dirname,'../..');
const source=fs.readFileSync(process.env.MP_CLIENT_FILE||path.join(ROOT,'lib/client.js'),'utf8');
function fixture(source){
  const ids=new Map(),winListeners=new Map(),docListeners=new Map(),observers=[],events=[],effects=[],store=new Map();
  let captured,queries=0,writes=0,reads=0,nextRaf=0;const rafs=new Map();
  const eventTarget=map=>({addEventListener(n,f){if(!map.has(n))map.set(n,new Set());map.get(n).add(f);},removeEventListener(n,f){map.get(n)?.delete(f);}});
  const storage={getItem:k=>{reads++;return store.get(k)||null;},setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
  function style(){const vals=new Map(),priorities=new Map();return {getPropertyValue:k=>vals.get(k)||'',getPropertyPriority:k=>priorities.get(k)||'',setProperty(k,v,p=''){writes++;vals.set(k,String(v));priorities.set(k,p);events.push('write:'+k);},removeProperty(k){writes++;vals.delete(k);priorities.delete(k);events.push('remove:'+k);}};}
  function node(tag='div'){const attrs=new Map();return{tagName:tag.toUpperCase(),isConnected:true,style:style(),className:'',parentNode:null,textContent:'',setAttribute(k,v){attrs.set(k,String(v));events.push('attr:'+k);},getAttribute:k=>attrs.has(k)?attrs.get(k):null,removeAttribute(k){attrs.delete(k);events.push('remove:'+k);},hasAttribute:k=>attrs.has(k),querySelector(){queries++;return null;},querySelectorAll(){queries++;return [];},remove(){events.push('node-remove:'+this.id);this.isConnected=false;ids.delete(this.id);},addEventListener(){},removeEventListener(){}};}
  const parent=node();parent.appendChild=n=>{ids.set(n.id,n);n.parentNode=parent;};
  const document={...eventTarget(docListeners),head:parent,documentElement:parent,body:parent,createElement:node,getElementById:k=>ids.get(k)||null,querySelectorAll(){queries++;return[];},querySelector(){queries++;return null;}};
  const MO=function(cb){this.cb=cb;this.active=false;this.observe=()=>{this.active=true;};this.disconnect=()=>{this.active=false;};observers.push(this);};
  const window={...eventTarget(winListeners),localStorage:storage,MutationObserver:MO,innerWidth:1282,__ModuleLoader__:{load:x=>{captured=x;}}};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState:v=>[v===null?{address:'dsh-resource://file/absolute/D%3A/probe/a.md'}:typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useCallback:f=>f,useEffect:()=>{}};
  const sandbox={window,document,console,MutationObserver:MO,requestAnimationFrame:f=>{rafs.set(++nextRaf,f);return nextRaf;},cancelAnimationFrame:id=>rafs.delete(id),setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  source=source.replace('exports.__test = __test;',`exports.__test = {...__test, fitRightbarContent, releaseRightbarFits, installHandleLifecycle, installHandleFloor, ensureGridStyle, ensureEdgeHandle, ensureChatHandle, handleState, pinGrid, applyPinnedModel, paintHandles, watchPinned, setNativeHandleLeft, restoreNativeHandleLeft, DocsWorkbench, closeDocsWorkbench,
    privateSetDocs(v){docsModeOn=v;bumpOverlay();}, privateLeaseSize(){return nativeHandleLeft.size;},
    privateSetReapply(fn){layoutReapply=fn;}, privateInstalled(){return handleFloorInstalled;}};`);
  vm.runInNewContext(source,sandbox,{filename:'private-candidate'});
  const createModule=()=>captured.factory(name=>name==='react'?React:null);
  const factory=()=>createModule().__test;
  const ctx={effect(fn){effects.push(fn());}};
  const emit=(name,event={})=>{for(const f of [...(winListeners.get(name)||[])])f(event);};
  const count=map=>[...map.values()].reduce((n,s)=>n+s.size,0);
  return {a:factory(),factory,createModule,ctx,events,effects,store,storage,window,document,node,parent,observers,ids,emit,
    reads:()=>reads,writes:()=>writes,queries:()=>queries,callbacks:name=>[...(winListeners.get(name)||[])],listeners:()=>({win:count(winListeners),doc:count(docListeners)}),rafs};
}
module.exports={make:()=>fixture(source)};
