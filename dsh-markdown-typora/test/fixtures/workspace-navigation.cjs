'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.MP_TRIAL_ROOT || path.resolve(__dirname,'../..');
const drain=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function make(options={}){
  const source=options.source||fs.readFileSync(process.env.MP_CLIENT_FILE || path.join(root,'lib/client.js'),'utf8');
  const storage=new Map([['dsh.markpilot.settings.v1',JSON.stringify({enabled:true,workspaceOpenMode:'recent',workspaceEmptyMode:'blank',workspaceSwitchMode:'follow',...options.settings})]]);
  const requests=[],opens=[],hooks=[],pending=[],subs={selection:new Set(),list:new Set()};let cursor=0,definition,active='A',byId={A:{cwd:'D:/A'},B:{cwd:'D:/B'},C:{cwd:'D:/C'},A2:{cwd:'D:/A'}};
  let fetchHandler=()=>({ok:true,value:{items:[]}});
  const equal=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const React={
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
    useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,v=>{hooks[i].value=typeof v==='function'?v(hooks[i].value):v;}];},
    useRef(initial){const i=cursor++;return hooks[i]||(hooks[i]={current:initial});},
    useMemo(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps))hooks[i]={deps,value:fn()};return hooks[i].value;},
    useCallback(fn,deps){return React.useMemo(()=>fn,deps);},
    useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||!equal(old.deps,deps)){hooks[i]={deps,cleanup:old?.cleanup};pending.push(()=>{hooks[i].cleanup?.();hooks[i].cleanup=fn();});}}
  };
  const sessions={list:{getSnapshot:()=>({byId}),subscribe:f=>{subs.list.add(f);return()=>subs.list.delete(f);}}};
  const uiWorkspace={selection:{getSnapshot:()=>({sessionId:active}),subscribe:f=>{subs.selection.add(f);return()=>subs.selection.delete(f);}}};
  const sidebarRight={commandTarget:()=>({sessionId:active}),openTabFromTarget:(kind,target)=>opens.push({kind,target})};
  const ctx={get:n=>({sessions,uiWorkspace,sidebarRight}[n]),effect:fn=>fn()};
  const window={__ModuleLoader__:{load:d=>definition=d},crypto:{randomUUID:()=> '01234567-89ab-4cde-8abc-0123456789ab'},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},addEventListener(){},removeEventListener(){}};
  const sandbox={window,console,setTimeout,clearTimeout,setInterval,clearInterval,fetch:(url,init)=>{const req={url,payload:JSON.parse(init.body)};requests.push(req);return Promise.resolve(fetchHandler(req)).then(value=>({ok:true,json:()=>Promise.resolve(value)}));}};
  vm.createContext(sandbox);
  const marker='exports.__test = __test;';if(!source.includes(marker))throw Error('exports anchor');
  vm.runInContext(source.replace(marker,`exports.__test={...__test,workspace:{workspaceKey,workspaceContext,pendingWorkspaceDraft,workspaceEditorState,workspaceAutoOpenSuppressed,setWorkspaceAutoOpenSuppressed,prepareWorkspaceLeave,openWorkspace,chooseWorkbenchDoc,closeWorkspaceEditor,installWorkspaceNavigation,DocsWorkbench,EditorOverlayStage,EditorTabRedirect,publishOverlayDoc,readSettings,writeSettings,editorLeaveGuards,bind(ctx){docsCtx=ctx;workspaceService=ctx.get('uiWorkspace');hostSidebarRight=ctx.get('sidebarRight');SessionsBridge.getSessions=()=>ctx.get('sessions');},state:()=>({workbenchDoc,workspaceIntent,workspaceNotice,docsModeOn,overlayDoc})}};`),sandbox);
  const W=definition.factory(n=>{if(n==='react')return React;throw Error(n);}).__test.workspace;W.bind(ctx);
  return {W,source,storage,requests,opens,subs,ctx,React,setFetch:fn=>{fetchHandler=fn;},context:()=>W.workspaceContext(),setActive(id,notify=true){active=id;if(notify)for(const fn of subs.selection)fn();},setCwd(id,cwd,notify=true){byId[id]={cwd};if(notify)for(const fn of subs.list)fn();},render(component=W.DocsWorkbench,props={}){cursor=0;const tree=component(props);for(const effect of pending.splice(0))effect();return tree;},dispose(){for(const hook of hooks)hook?.cleanup?.();}};
}
module.exports={make,drain,root};
