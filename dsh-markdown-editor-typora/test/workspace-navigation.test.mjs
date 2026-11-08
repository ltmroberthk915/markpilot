import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/workspace-navigation.cjs';
const {make,drain}=fixture;
const flatten=t=>{const out=[];function visit(x){if(x===null||x===undefined)return;if(typeof x!=='object'){out.push(String(x));return;}out.push(x);for(const child of x.children||[])visit(child);}visit(t);return out;};

test('navigation: seed/list/metadata/same-cwd do not open',async()=>{
  const f=make(),stop=f.W.installWorkspaceNavigation(f.ctx);await drain();assert.equal(f.requests.length,0);
  f.setCwd('C','D:/Elsewhere');await drain();assert.equal(f.requests.length,0);
  f.setActive('A2');await drain();assert.equal(f.requests.length,0);
  stop();f.dispose();
 });
test('navigation: cross-workspace switch restores that directory’s remembered document',async()=>{
  const f=make();f.setFetch(()=>({ok:true,value:{items:['D:/B/b.md']}}));
  const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();
  f.setActive('B');await drain();
  assert.equal(f.W.state().docsModeOn,true);assert.equal(f.W.state().workbenchDoc.path,'D:/B/b.md');
  assert.equal(f.opens.length,0,'session switch must not open the file list');stop();f.dispose();
 });
test('navigation: cross-workspace switch without a remembered document opens nothing',async()=>{
  const blank=make(),stopB=blank.W.installWorkspaceNavigation(blank.ctx);await drain();
  blank.setActive('B');await drain();
  assert.equal(blank.opens.length,0,'no file list on session switch');assert.equal(blank.W.state().docsModeOn,false);assert.equal(blank.W.state().workbenchDoc,null);stopB();blank.dispose();
  const files=make({settings:{workspaceEmptyMode:'files'}}),stopF=files.W.installWorkspaceNavigation(files.ctx);await drain();
  files.setActive('B');await drain();
  assert.equal(files.opens.length,0,'native files panel must not pop up on session switch');assert.equal(files.W.state().docsModeOn,false);stopF();files.dispose();
 });
test('explicit open still applies the empty fallback: files panel',async()=>{
  const f=make({settings:{workspaceEmptyMode:'files'}});await f.W.openWorkspace(f.context());
  assert.equal(f.opens.length,1);assert.equal(f.opens[0].kind,'files');assert.equal(f.W.state().docsModeOn,false);f.dispose();
 });
test('explicit open still applies the empty fallback: blank document',async()=>{
  const f=make({settings:{workspaceEmptyMode:'blank'}});await f.W.openWorkspace(f.context());
  assert.equal(f.opens.length,0);assert.equal(f.W.state().docsModeOn,true);assert.match(f.W.state().workbenchDoc.path,/^D:\/A\/未命名-/);f.dispose();
 });
test('open intent: late B cannot replace newer C',async()=>{
  const f=make(),pending=[];f.setFetch(req=>new Promise(resolve=>pending.push({req,resolve})));
  f.setActive('B',false);const b=f.W.openWorkspace(f.context());await drain();f.setActive('C',false);const c=f.W.openWorkspace(f.context());await drain();
  pending[1].resolve({ok:true,value:{items:['D:/C/c.md']}});await c;pending[0].resolve({ok:true,value:{items:['D:/B/b.md']}});await b;
  assert.equal(f.W.state().workbenchDoc.path,'D:/C/c.md');f.dispose();
 });
test('leave refusal preserves the currently visible document',async()=>{
  const f=make();await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md'});f.W.editorLeaveGuards.set('unsafe',async()=>null);
  f.setActive('B',false);await f.W.openWorkspace(f.context());assert.equal(f.W.state().workbenchDoc.path,'D:/A/a.md');assert.match(f.W.state().workspaceNotice,/尚未安全/);f.dispose();
 });
test('list A late result cannot repopulate B list',async()=>{
  const f=make(),pending=[];f.setFetch(req=>new Promise(resolve=>pending.push({req,resolve})));
  f.render();f.setActive('B',false);f.render();assert.equal(pending.length,2);
  pending[1].resolve({ok:true,value:{items:['D:/B/b.md']}});await drain();pending[0].resolve({ok:true,value:{items:['D:/A/a.md']}});await drain();
  const tree=flatten(f.render()),text=tree.filter(x=>typeof x==='string').join('|');
  assert(text.includes('b.md'),'current B row disappeared: '+text);assert(!text.includes('a.md'),'stale A row survived: '+text);f.dispose();
 });
test('workspace POSIX root is not empty/invalid',async()=>{const f=make();assert.notEqual(f.W.workspaceKey('/'),'');f.dispose();});
test('legacy create A late result cannot replace selected B document',async()=>{
  const f=make();let finishCreate;f.setFetch(req=>req.url.endsWith('docs/create')?new Promise(resolve=>finishCreate=resolve):{ok:true,value:{items:[]}});
  let tree=flatten(f.render());tree.find(x=>x?.type==='input'&&x.props.placeholder==='新建文件名').props.onChange({target:{value:'a'}});
  tree=flatten(f.render());tree.find(x=>x?.type==='button'&&x.children?.includes('新建')).props.onClick();await drain();assert.equal(typeof finishCreate,'function');
  f.setActive('B',false);await f.W.chooseWorkbenchDoc({path:'D:/B/b.md',address:'dsh-resource://file/absolute/D%3A/B/b.md',workspace:'D:/B',sessionId:'B'});
  finishCreate({ok:true,value:{path:'D:/A/a.md',displayPath:'D:/A/a.md'}});await drain();
  assert.equal(f.W.state().workbenchDoc.path,'D:/B/b.md');f.dispose();
 });
test('workspace aliases collapse dot segments',async()=>{const f=make();assert.equal(f.W.workspaceKey('D:/repo/sub/..'),f.W.workspaceKey('D:/repo'));f.dispose();});
test('explicit navigation to another Markdown tab lands in the workbench and closes the sidebar tab',async()=>{
  const f=make(),signal=new AbortController().signal,closed=[];
  let tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal,actions:{close:()=>closed.push('native')}};
  const props={sessionId:'A',useTabInfo:()=>({tab})};f.render(f.W.EditorTabRedirect,props);await drain();
  await f.W.chooseWorkbenchDoc({path:'D:/A/work.md',address:'dsh-resource://file/absolute/D%3A/A/work.md',workspace:'D:/A',sessionId:'A'});
  assert.equal(f.W.state().docsModeOn,true);assert.equal(f.W.state().workbenchDoc.path,'D:/A/work.md');
  tab={...tab,navigation:{revision:2}};f.render(f.W.EditorTabRedirect,props);await drain();
  await new Promise((resolve)=>setTimeout(resolve,200));
  assert.equal(f.W.state().docsModeOn,true,'the workbench keeps the middle editor');
  assert.equal(f.W.state().workbenchDoc.path,'D:/A/native.md','the navigated document is adopted');
  assert.ok(closed.includes('native'),'the duplicate sidebar tab is closed');f.dispose();
 });
test('native navigation must not bypass a refused document leave',async()=>{
  const f=make(),signal=new AbortController().signal;let tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  const props={sessionId:'A',useTabInfo:()=>({tab})};f.render(f.W.EditorTabRedirect,props);await drain();
  await f.W.chooseWorkbenchDoc({path:'D:/A/work.md',address:'dsh-resource://file/absolute/D%3A/A/work.md'});f.W.editorLeaveGuards.set('unsafe',async()=>null);
  tab={...tab,navigation:{revision:2}};f.render(f.W.EditorTabRedirect,props);await drain();assert.equal(f.W.state().docsModeOn,true);assert.equal(f.W.state().workbenchDoc.path,'D:/A/work.md');f.dispose();
 });
test('workspace settings validate enums and preserve unrelated preferences',async()=>{
  const f=make(),s={getItem:k=>f.storage.get(k)||null,setItem:(k,v)=>f.storage.set(k,v)};
  f.W.writeSettings(s,{workspaceOpenMode:'bad',workspaceEmptyMode:'recent',workspaceSwitchMode:true,chatWidth:320});
  let cfg=f.W.readSettings(s);assert.equal(cfg.workspaceOpenMode,'recent');assert.equal(cfg.workspaceEmptyMode,'files');assert.equal(cfg.workspaceSwitchMode,'follow');assert.equal(cfg.chatWidth,320);
  f.W.writeSettings(s,{workspaceOpenMode:'blank',workspaceEmptyMode:'blank',workspaceSwitchMode:'keep'});cfg=f.W.readSettings(s);assert.equal(cfg.workspaceOpenMode,'blank');assert.equal(cfg.workspaceEmptyMode,'blank');assert.equal(cfg.workspaceSwitchMode,'keep');assert.equal(cfg.chatWidth,320);f.dispose();
 });
test('keep mode and same-session metadata changes retain document identity',async()=>{
  const f=make({settings:{workspaceSwitchMode:'keep'}});await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md'});const doc=f.W.state().workbenchDoc,stop=f.W.installWorkspaceNavigation(f.ctx);await drain();
  f.setCwd('A','D:/Changed');await drain();f.setActive('B');await drain();assert.equal(f.requests.length,0);assert.equal(f.W.state().workbenchDoc,doc);stop();f.dispose();
 });
test('explicit close invalidates an unresolved automatic open',async()=>{
  const f=make();let resolve;f.setFetch(()=>new Promise(r=>resolve=r));f.setActive('B',false);const pending=f.W.openWorkspace(f.context());await drain();
  await f.W.closeWorkspaceEditor();resolve({ok:true,value:{items:['D:/B/b.md']}});await pending;assert.equal(f.W.state().docsModeOn,false);assert.equal(f.W.state().workbenchDoc,null);f.dispose();
 });
test('navigation disposer cancels queued callbacks and detaches both stores',async()=>{
  const f=make();f.ctx.inject=(names,bind)=>bind(Object.fromEntries(names.map(n=>[n,f.ctx.get(n)])));
  const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');stop();await drain();assert.equal(f.requests.length,0);assert.equal(f.subs.selection.size,0);assert.equal(f.subs.list.size,0);f.dispose();
 });
test('native target hidden during durable leave must not replace workbench',async()=>{
  const f=make(),signal=new AbortController().signal;let tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  const props={sessionId:'A',useTabInfo:()=>({tab})};f.render(f.W.EditorTabRedirect,props);await drain();
  await f.W.chooseWorkbenchDoc({path:'D:/A/work.md',address:'dsh-resource://file/absolute/D%3A/A/work.md'});let release;
  f.W.editorLeaveGuards.set('held',()=>new Promise(resolve=>release=resolve));tab={...tab,navigation:{revision:2}};f.render(f.W.EditorTabRedirect,props);await drain();assert.equal(typeof release,'function');
  tab={...tab,visible:false};f.render(f.W.EditorTabRedirect,props);release(()=>true);await drain();assert.equal(f.W.state().docsModeOn,true);f.dispose();
 });

test('navigation: switching to a workspace without history closes the previous document',async()=>{
  const f=make();await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md',workspace:'D:/A',sessionId:'A'});
  assert.equal(f.W.state().docsModeOn,true);
  const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');await drain();
  assert.equal(f.opens.length,0,'no file list on session switch');assert.equal(f.W.state().docsModeOn,false,'the previous document is tucked away');stop();f.dispose();
 });
test('navigation: an unsaved blank draft is restored on switch',async()=>{
  const f=make();f.storage.set('dsh.markpilot.workspace-drafts.v1',JSON.stringify({'d:/b':{path:'D:/B/未命名-abc.md',address:'dsh-resource://file/absolute/D%3A/B/%E6%9C%AA%E5%91%BD%E5%90%8D-abc.md',workspace:'D:/B',sessionId:'B',draft:{id:'abc',cwd:'D:/B'}}}));
  const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');await drain();
  assert.equal(f.W.state().docsModeOn,true);assert.match(f.W.state().workbenchDoc.path,/未命名-abc/);assert.equal(f.requests.length,0,'a blank draft needs no recent query');stop();f.dispose();
 });
test('navigation: a failed recent query neither notifies nor opens',async()=>{
  const f=make();f.setFetch(()=>({ok:false,error:{message:'boom'}}));const warns=[],real=console.warn;console.warn=(...a)=>warns.push(a.join(' '));
  let stop;try{stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');await drain();}finally{console.warn=real;stop&&stop();}
  assert.equal(f.W.state().workspaceNotice,'');assert.equal(f.W.state().docsModeOn,false);assert.ok(warns.length>=1,'auto failures leave a diagnostic warning');f.dispose();
 });
test('navigation: an empty switch issues exactly one recent query',async()=>{
  const f=make();const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');await drain();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].payload.op,'list');assert.equal(f.requests[0].payload.workspace,'D:/B');assert.equal(f.W.state().workspaceNotice,'');stop();f.dispose();
 });

test('navigation: a workspace closed with × is not restored on switch',async()=>{
  const f=make();f.setFetch(()=>({ok:true,value:{items:['D:/B/b.md']}}));
  f.W.setWorkspaceAutoOpenSuppressed(f.W.workspaceKey('D:/B'),true);
  const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');await drain();
  assert.equal(f.W.state().docsModeOn,false);assert.equal(f.opens.length,0);assert.equal(f.W.state().workbenchDoc,null);stop();f.dispose();
 });
test('navigation: × memory also tucks away a document from another directory',async()=>{
  const f=make();f.setFetch(()=>({ok:true,value:{items:['D:/B/b.md']}}));
  await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md',workspace:'D:/A',sessionId:'A'});
  f.W.setWorkspaceAutoOpenSuppressed(f.W.workspaceKey('D:/B'),true);
  const stop=f.W.installWorkspaceNavigation(f.ctx);await drain();f.setActive('B');await drain();
  assert.equal(f.W.state().docsModeOn,false,'the document from A is tucked away');assert.equal(f.opens.length,0);stop();f.dispose();
 });
test('explicit Markdown open lifts the × memory',async()=>{
  const f=make();f.setFetch(()=>({ok:true,value:{items:['D:/A/a.md']}}));f.W.setWorkspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A'),true);
  await f.W.openWorkspace(f.context());
  assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A')),false);assert.equal(f.W.state().workbenchDoc.path,'D:/A/a.md');f.dispose();
 });
test('workbench × closes the editor and remembers the workspace',async()=>{
  const f=make();await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md',workspace:'D:/A',sessionId:'A'});
  const tree=flatten(f.render(f.W.DocsWorkbench)),btn=tree.find(x=>x&&x.props&&x.props['data-mp-rail-action']==='close');
  assert.ok(btn,'workbench close button is rendered');btn.props.onClick();await drain();
  assert.equal(f.W.state().docsModeOn,false);assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A')),true);f.dispose();
 });

test('workbench × marks the displayed document directory, not the current session',async()=>{
  const f=make();await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md',workspace:'D:/A',sessionId:'A'});
  f.setActive('B',false); // 会话已切到 B，A 的文档还开着
  const tree=flatten(f.render(f.W.DocsWorkbench)),btn=tree.find(x=>x&&x.props&&x.props['data-mp-rail-action']==='close');
  btn.props.onClick();await drain();
  assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A')),true,'the displayed document directory is remembered');
  assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/B')),false,'the session directory stays untouched');f.dispose();
 });
test('a refused close leaves no × memory behind',async()=>{
  const f=make();await f.W.chooseWorkbenchDoc({path:'D:/A/a.md',address:'dsh-resource://file/absolute/D%3A/A/a.md',workspace:'D:/A',sessionId:'A'});
  f.W.editorLeaveGuards.set('unsafe',async()=>null);
  const tree=flatten(f.render(f.W.DocsWorkbench)),btn=tree.find(x=>x&&x.props&&x.props['data-mp-rail-action']==='close');
  btn.props.onClick();await drain();
  assert.equal(f.W.state().docsModeOn,true,'the editor stays open');assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A')),false);f.dispose();
 });
test('recording a recent document lifts the × memory',async()=>{
  const f=make();f.W.setWorkspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A'),true);
  f.W.recordRecentDoc({path:'D:/A/a.md',scope:'absolute'},'A','D:/A');await drain();
  assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A')),false);f.dispose();
 });
test('× memory is capped and drops the oldest entries',async()=>{
  const f=make();for(let i=0;i<200;i++)f.W.setWorkspaceAutoOpenSuppressed('d:/w'+i,true);
  f.W.setWorkspaceAutoOpenSuppressed('d:/extra',true);
  assert.equal(f.W.workspaceAutoOpenSuppressed('d:/w0'),false,'the oldest entry is pruned');assert.equal(f.W.workspaceAutoOpenSuppressed('d:/extra'),true);f.dispose();
 });
test('overlay × marks the document directory and closes the stage',async()=>{
  const f=make(),signal=new AbortController().signal;
  f.W.publishOverlayDoc({tab:{id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal},sessionId:'A'});
  f.setActive('B',false);
  const tree=flatten(f.render(f.W.EditorOverlayStage,{}));const btn=tree.find(x=>x&&x.props&&x.props.title==='关闭编辑区');
  assert.ok(btn,'overlay close button is rendered');btn.props.onClick();await drain();
  assert.equal(f.W.state().overlayDoc,null);assert.equal(f.W.workspaceAutoOpenSuppressed(f.W.workspaceKey('D:/A')),true);f.dispose();
 });

test('a passive native Markdown tab opens in the workbench by default',async()=>{
  const f=make(),signal=new AbortController().signal;
  const tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab})});await drain();
  assert.equal(f.W.state().docsModeOn,true,'the workbench opens with the document');
  assert.equal(f.W.state().workbenchDoc.path,'D:/A/native.md');
  const tree=flatten(f.render(f.W.DocsWorkbench));
  assert.ok(tree.find(x=>x&&x.props&&x.props['data-mp-rail-action']==='close'),'the floating close button is rendered');
  assert.ok(tree.find(x=>x&&x.props&&x.props['data-mp-rail-action']==='toggle'),'the list toggle is rendered');f.dispose();
 });
test('the overlay setting keeps a passive native tab full-width',async()=>{
  const f=make({settings:{passiveOpenMode:'overlay'}}),signal=new AbortController().signal;
  const tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab})});await drain();
  assert.equal(f.W.state().docsModeOn,false);assert.equal(f.W.state().overlayDoc.tab.id,'native-md');f.dispose();
 });
test('a document closed with × is not reopened by a restored native tab',async()=>{
  const f=make(),signal=new AbortController().signal;
  const tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab})});await drain();
  const tree=flatten(f.render(f.W.DocsWorkbench));
  tree.find(x=>x&&x.props&&x.props['data-mp-rail-action']==='close').props.onClick();await drain();
  assert.equal(f.W.state().docsModeOn,false);
  const reopened=f.W.routePassiveNativeDoc(tab,'A');await drain();
  assert.equal(reopened,false,'the × memory keeps the restored tab out of the workbench');
  assert.equal(f.W.state().docsModeOn,false);f.dispose();
 });
test('passive open mode validates and defaults to the workbench',async()=>{
  const f=make(),s={getItem:k=>f.storage.get(k)||null,setItem:(k,v)=>f.storage.set(k,v)};
  assert.equal(f.W.readSettings(s).passiveOpenMode,'workbench');
  f.W.writeSettings(s,{passiveOpenMode:'bad'});assert.equal(f.W.readSettings(s).passiveOpenMode,'workbench');
  f.W.writeSettings(s,{passiveOpenMode:'overlay'});assert.equal(f.W.readSettings(s).passiveOpenMode,'overlay');f.dispose();
 });

test('a host-restored Markdown preview tab is adopted into the workbench',async()=>{
  const f=make();
  f.setOpenTabs([{sessionId:'A',tabId:'t1',kind:'text',contentId:'dsh-resource://file/absolute/D%3A/A/native.md'}]);
  const adopted=f.W.adoptOpenNativeDocs();await drain();
  assert.equal(adopted,true);assert.equal(f.W.state().docsModeOn,true);assert.equal(f.W.state().workbenchDoc.path,'D:/A/native.md');
  f.dispose();
 });
test('adoption stays off in the overlay mode and for suppressed directories',async()=>{
  const overlay=make({settings:{passiveOpenMode:'overlay'}});
  overlay.setOpenTabs([{sessionId:'A',tabId:'t1',kind:'text',contentId:'dsh-resource://file/absolute/D%3A/A/native.md'}]);
  assert.equal(overlay.W.adoptOpenNativeDocs(),false);assert.equal(overlay.W.state().docsModeOn,false);overlay.dispose();
  const closed=make();
  closed.W.setWorkspaceAutoOpenSuppressed(closed.W.workspaceKey('D:/A'),true);
  closed.setOpenTabs([{sessionId:'A',tabId:'t1',kind:'text',contentId:'dsh-resource://file/absolute/D%3A/A/native.md'}]);
  assert.equal(closed.W.adoptOpenNativeDocs(),false,'a directory closed with × stays closed');assert.equal(closed.W.state().docsModeOn,false);closed.dispose();
 });
test('adoption never takes over while an editor is already open',async()=>{
  const f=make();await f.W.chooseWorkbenchDoc({path:'D:/A/work.md',address:'dsh-resource://file/absolute/D%3A/A/work.md',workspace:'D:/A',sessionId:'A'});
  f.setOpenTabs([{sessionId:'A',tabId:'t1',kind:'text',contentId:'dsh-resource://file/absolute/D%3A/A/native.md'}]);
  assert.equal(f.W.adoptOpenNativeDocs(),false);assert.equal(f.W.state().workbenchDoc.path,'D:/A/work.md');f.dispose();
 });

test('opening a Markdown link into the workbench closes the duplicate sidebar tab',async()=>{
  const f=make(),signal=new AbortController().signal,closed=[];
  const tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal,actions:{close:()=>closed.push('tab')}};
  f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab})});await drain();
  assert.equal(f.W.state().docsModeOn,true);
  await new Promise((resolve)=>setTimeout(resolve,380));
  assert.deepEqual(closed,['tab'],'the duplicate sidebar tab is closed through tab.actions');f.dispose();
 });
test('the legacy props.actions fallback also closes the duplicate tab',async()=>{
  const f=make(),signal=new AbortController().signal,closed=[];
  const tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  f.render(f.W.EditorTabRedirect,{sessionId:'A',useTabInfo:()=>({tab}),actions:{close:()=>closed.push('tab')}});await drain();
  await new Promise((resolve)=>setTimeout(resolve,380));
  assert.deepEqual(closed,['tab']);f.dispose();
 });

test('file:// links to Markdown documents resolve to Windows paths',()=>{
  const p=make().W;
  assert.equal(p.decodeFileUrlPath('file:///C:/Users/Ming/.dsh/AGENTS.md'),'C:\\Users\\Ming\\.dsh\\AGENTS.md');
  assert.equal(p.decodeFileUrlPath('file:///C:/a%20b/%E4%B8%AD.md'),'C:\\a b\\中.md');
  assert.equal(p.decodeFileUrlPath('https://example.com/a.md'),'');
 });
test('an absolute Markdown path chip is recognised, other text is not',()=>{
  const p=make().W;
  assert.equal(p.docPathFromChipText('绝对路径: C:\\Users\\Ming\\.dsh\\AGENTS.md'),'C:\\Users\\Ming\\.dsh\\AGENTS.md');
  assert.equal(p.docPathFromChipText('README.md'),'');
  assert.equal(p.docPathFromChipText('点这里'),'');
 });
test('a link-opened local document lands in the workbench',async()=>{
  const f=make();f.storage.set('dsh.markpilot.layout.v1',JSON.stringify({enabled:true}));
  const ok=f.W.openLocalDoc('D:/A/AGENTS.md');await drain();
  assert.equal(ok,true);assert.equal(f.W.state().docsModeOn,true);
  assert.equal(f.W.state().workbenchDoc.path,'D:/A/AGENTS.md');f.dispose();
 });
