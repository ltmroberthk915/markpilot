import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/workspace-navigation.cjs';
const {make,drain}=fixture;
const flatten=t=>{const out=[];function visit(x){if(x===null||x===undefined)return;if(typeof x!=='object'){out.push(String(x));return;}out.push(x);for(const child of x.children||[])visit(child);}visit(t);return out;};

test('navigation: seed/list/metadata/same-cwd do not open; closed cross-cwd does',async()=>{
  const f=make(),stop=f.W.installWorkspaceNavigation(f.ctx);await drain();assert.equal(f.requests.length,0);
  f.setCwd('C','D:/Elsewhere');await drain();assert.equal(f.requests.length,0);
  f.setActive('A2');await drain();assert.equal(f.requests.length,0);
  f.setActive('B');await drain();assert.equal(f.requests.length,1);assert.equal(f.W.state().docsModeOn,true);assert.equal(f.W.state().workbenchDoc.workspace,'D:/B');stop();f.dispose();
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
test('native repeated navigation revision reveals its Markdown above workbench',async()=>{
  const f=make(),signal=new AbortController().signal;let tab={id:'native-md',contentId:'dsh-resource://file/absolute/D%3A/A/native.md',visible:true,navigation:{revision:1},signal};
  const props={sessionId:'A',useTabInfo:()=>({tab})};f.render(f.W.EditorTabRedirect,props);await drain();
  await f.W.chooseWorkbenchDoc({path:'D:/A/work.md',address:'dsh-resource://file/absolute/D%3A/A/work.md',workspace:'D:/A',sessionId:'A'});
  assert.equal(f.W.state().docsModeOn,true);
  tab={...tab,navigation:{revision:2}};f.render(f.W.EditorTabRedirect,props);await drain();
  assert.equal(f.W.state().docsModeOn,false,'native user navigation remains obscured by Workbench');assert.equal(f.W.state().overlayDoc.tab.id,'native-md');f.dispose();
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
