'use strict';
// Save-status/blank lifecycle fixture. Executes actual client source; does not
// substitute its save logic. Optional source injection owns mutation negatives.
// Actual client closure; React, disk transport and renderer wire are deterministic
// fixtures. Renderer protocol correctness is covered separately by bridge/engine
// integration probes. This fixture does not claim native input or IDB coverage.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ROOT=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(ROOT,'lib/client.js'),'utf8');
const drain=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function make(options={}){
 const effects=[],refs=[],listeners=new Map(),timers=new Map(),storage=options.storage||new Map(),slots=options.slots||new Map(),posts=[],requests=[],held=[];
 const transport={dropAck:false,holdAck:false,dropText:false,rejectApply:false};
 const uiHistory=[]; let rendering=false,refCursor=0; let timerId=0,now=0,definition,ui,cwd=options.cwd||'D:/probe',fetchHandler=()=>Promise.resolve({ok:true,value:{text:'disk-v1',version:'v1',displayPath:'D:/probe/a.md',size:7}});
 const engine={text:'',session:null,token:null,lastApply:null,composing:false};
 const same=(a,b)=>!!a&&!!b&&a.epoch===b.epoch&&a.sourceRevision===b.sourceRevision;
 const add=(n,f)=>{if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(f);};
 const remove=(n,f)=>listeners.get(n)?.delete(f);
 const message=(type,content)=>{for(const f of [...(listeners.get('message')||[])])f({source:win,data:{__dshmd:true,dir:'up',type,content}});};
 function emit(type,content){if(type==='apply-result'&&(transport.dropAck||transport.holdAck)){if(transport.holdAck)held.push({type,content});return;}if(type==='text'&&transport.dropText)return;message(type,content);}
 function receive(m){
  const c=m.content;if(c?.protocol!==2)return;
  if(m.type==='open'||m.type==='setValue'){
   let applied=!transport.rejectApply&&!engine.composing&&(m.type==='open'?!engine.token:same(c.expected,engine.session));
   if(applied){
    if(m.type==='open'){engine.token=c.docToken;engine.session={epoch:1,sourceRevision:0};}
    else if(engine.text!==c.content)engine.session={...engine.session,sourceRevision:engine.session.sourceRevision+1};
    engine.text=c.content;engine.lastApply={applyId:c.applyId,session:{...engine.session},kind:c.kind};
   }
   emit('apply-result',{protocol:2,docToken:c.docToken,applyId:c.applyId,applied,reason:applied?null:'composing',session:engine.session&&{...engine.session}});
  }else if(m.type==='requestText'&&engine.token===c.docToken){emit('text',{protocol:2,docToken:engine.token,id:c.id,session:{...engine.session},lastApply:engine.lastApply,text:engine.text,composing:engine.composing});}
 }
 const win={postMessage(m){posts.push(m);if(options.syncWire)receive(m);else queueMicrotask(()=>receive(m));}};
 const React={useMemo:f=>f(),useRef:v=>{if(rendering)return refs[refCursor++];const r={current:v};refs.push(r);return r;},useState:v=>{if(!rendering)ui=v;return[ui,f=>{ui=typeof f==='function'?f(ui):f;uiHistory.push(ui.saveStatus);}];},useCallback:f=>f,useEffect:f=>{if(!rendering)effects.push(f);},createElement:(type,props,...children)=>({type,props,children})};
 // Small in-memory storage contract stub; storage helper's own tests and real
 // IDB browser probe own persistence correctness and large-document behavior.
 const draftStore={
  checkpoint:slot=>{slots.set(slot.docToken,{...slot});return Promise.resolve({ok:true,durable:true});},
  append:e=>{const slot=slots.get(e.docToken);if(!slot||!same(slot.session,e.before))throw Error('Fixture store revision gap');let text=slot.text;for(const c of [...e.changes].reverse())text=text.slice(0,c.from)+c.insert+text.slice(c.to);Object.assign(slot,{text,session:{...e.after},dirty:true,composing:e.composing});return{ok:true,durable:Promise.resolve({ok:true,durable:true})};},
  flush:({docToken})=>{const slot=slots.get(docToken);if(slot?.dirty)storage.set('fixture:'+docToken,JSON.stringify(slot));return{ok:true,durable:true};},
  markSaved:s=>{const slot=slots.get(s.docToken);if(slot){slot.baseVersion=s.baseVersion;slot.dirty=!same(slot.session,s.session);}return Promise.resolve({ok:true,durable:true});},
  readLatest:p=>Promise.resolve([...slots.values()].find(s=>s.path===p&&s.dirty)||null),
  clear:(p,token,session)=>{const slot=slots.get(token);if(slot&&session&&!same(slot.session,session))return Promise.resolve({ok:false,code:'RECOVERY_NEWER'});slots.delete(token);storage.delete('fixture:'+token);return Promise.resolve({ok:true});},
  release:()=>Promise.resolve({ok:true,released:true})
 };
 const window={__dshDraftStore:draftStore,__ModuleLoader__:{load:d=>definition=d},addEventListener:add,removeEventListener:remove,
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
 const sandbox={window,console,queueMicrotask,document:{visibilityState:'visible',body:{hasAttribute:()=>false},addEventListener(){},removeEventListener(){}},
  setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:now+ms,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(){},clearInterval(){},
  fetch:(url,opts)=>{const req={endpoint:url.split('/').at(-1),payload:JSON.parse(opts.body),keepalive:!!opts.keepalive};requests.push(req);return Promise.resolve(fetchHandler(req)).then(value=>({ok:true,json:()=>Promise.resolve(value)}));}};
 vm.createContext(sandbox);
 vm.runInContext((options.source??source).replace('exports.__test = __test;','exports.__test = { ...__test, EditorTabBodyInner, SessionsBridge, createSaveStatusController, prepareWorkspaceLeave, pendingWorkspaceDraft, workspaceKey };'),sandbox);
 const mod=definition.factory(n=>{if(n==='react')return React;throw Error(n);});
 mod.__test.SessionsBridge.getSessions=()=>({list:{getSnapshot:()=>({byId:{test:{cwd}}})}});
 const componentProps={sessionId:'test',useTabInfo:()=>({tab:{contentId:options.address||'dsh-resource://file/absolute/D%3A/probe/a.md',visible:true,draft:options.draft,workspace:options.workspace}})};
 mod.__test.EditorTabBodyInner(componentProps);
 refs[0].current={contentWindow:win};
 const cleanups=effects.map(effect=>effect()).filter(value=>typeof value==='function');
 const cleanup=()=>{for(const dispose of [...cleanups].reverse())dispose();};
 const st=refs[2].current;st.doc.win=win;
 return{uiHistory,test:mod.__test,render(){rendering=true;refCursor=0;try{return mod.__test.EditorTabBodyInner(componentProps);}finally{rendering=false;}},setUiForRender(value){ui={...ui,...value};},st,posts,requests,storage,slots,timers,cleanup,message,transport,held,engine,draftStore,setFetch:f=>fetchHandler=f,setCwd:value=>{cwd=value;},ui:()=>ui,
  edit(text,composing=false){if(!engine.session)throw Error('Renderer not initialized');const before={...engine.session},beforeLength=engine.text.length;engine.session={...before,sourceRevision:before.sourceRevision+1};engine.text=text;engine.composing=composing;message('document-delta',{protocol:2,docToken:engine.token,before,after:{...engine.session},beforeLength,afterLength:text.length,changes:[{from:0,to:beforeLength,insert:text}],composing,lastApply:engine.lastApply});},
  composition(value){engine.composing=value;message('composition',{protocol:2,docToken:engine.token,session:{...engine.session},composing:value});},
  releaseAck(){for(const m of held.splice(0))message(m.type,m.content);},
  async boot(){message('bridge-ready');message('init');await drain();},
  async advance(ms){now+=ms;for(const[id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await drain();}};
}
module.exports={make,drain,source};
