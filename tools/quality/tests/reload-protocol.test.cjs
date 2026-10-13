'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const {DocumentStore,createSession}=require(path.join(root,'MarkPilot-CM6/shell/document-store.js'));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
test('guarded disk load refuses a newer revision, path or logical document at atomic adoption',async()=>{
 for(const mutate of [S=>S.revision++,S=>S.filePath+='new',S=>S.documentId+='new']){
  const store=new DocumentStore(),S=createSession(),hold=defer();S.filePath=path.resolve('owned.md');S.savedText='buffer';store.canonical=async p=>p;store.snapshot=()=>hold.promise;
  const expected={documentId:S.documentId,revision:S.revision,filePath:S.filePath,loadRequest:S.loadRequest};
  const read=store.load(S,S.filePath,expected);await Promise.resolve();mutate(S);hold.resolve({bytes:Buffer.from('disk'),baseline:{mtimeMs:0}});
  await assert.rejects(read,{code:'MP_DOC_MISMATCH'});assert.equal(S.savedText,'buffer');
 }
});
test('actual reload handler releases canceled and thrown confirmations; a later read uses its own ticket',async()=>{
 const source=fs.readFileSync(path.join(root,'MarkPilot-CM6/main.js'),'utf8'),from=source.indexOf('async function reloadDoc('),to=source.indexOf('\n/* ── 【文件多开',from);
 assert(from>0&&to>from);const body=source.slice(from,to);
 const map=new Map(),S=createSession(),W={webContents:{id:1}};S.filePath='owned.md';let confirm=false,count=0,pushed=[];
 const documents={async load(session,file,expected){count++;assert.equal(expected.documentId,session.documentId);return{documentId:'new',filePath:file,text:'disk',revision:0}}};
 const reload=new Function('reloads','pdfActive','documents','confirmReplace','syncPathUi','sendTo',body+'\nreturn reloadDoc;')(map,null,documents,async()=>{if(confirm==='throw')throw Error('confirm');return confirm},()=>{},(w,event,payload)=>pushed.push(payload));
 assert((await reload({requestId:'one'},S,W)).canceled);assert.equal(map.size,0);
 confirm='throw';assert.equal((await reload({requestId:'two'},S,W)).error,'confirm');assert.equal(map.size,0);
 confirm=true;const r=await reload({requestId:'three'},S,W);assert(r.ok);assert.equal(count,1);assert.equal(pushed[0].requestId,'three');assert.equal(map.size,0);
});
test('an expired informational banner may not hide a newer recovery action',()=>{
 const source=fs.readFileSync(path.join(root,'MarkPilot-CM6/renderer/host.js'),'utf8'),from=source.indexOf('function showBanner('),to=source.indexOf('\n/* ── 标题',from);assert(from>0&&to>from);
 const node={textContent:'',className:'',style:{},appendChild(button){this.button=button}},document={createElement(){return{}}};
 const {showBanner,hideBanner}=new Function('bannerEl','document','let bannerSerial = 0;\n'+source.slice(from,to)+'\nreturn{showBanner,hideBanner};')(()=>node,document);
 const expired=showBanner('Export finished',[],true),pending=showBanner('Save failed',[{label:'Save As',run(){}}]);
 hideBanner(expired);assert.equal(node.textContent,'Save failed','a late export timeout must retain the current recovery surface');assert.equal(node.style.display,'block');
 hideBanner(pending);assert.equal(node.style.display,'none','the current banner remains explicitly dismissible');
 showBanner('new document');hideBanner();assert.equal(node.style.display,'none','document adoption and successful save may clear the current banner');
});
test('an older asynchronous Save As grant cannot replace a newer live shell permission',async()=>{
 const store=new DocumentStore(),S=createSession(),older=defer(),newer=defer();
 store.canonical=async p=>p;store.snapshot=p=>p==='older.md'?older.promise:newer.promise;
 const a=store.grantSaveAs(S,'older.md').then(value=>({value}),error=>({error}));
 const b=store.grantSaveAs(S,'newer.md');newer.resolve(null);const live=await b;
 older.resolve(null);const stale=await a;
 assert.equal(S.saveAsGrant?.token,live.saveAsToken,'the newer unconsumed permission must remain live');
 assert(stale.error,'stale grant completion is rejected');
});
for(const phase of ['before-replace','during-validation'])test('a consumed Save As grant superseded '+phase+' cannot commit or replace the current primary path',async()=>{
 const io=require('node:fs/promises'),dir=await io.mkdtemp(path.join(root,'.mp-verify/store-overlap-'));
 const primary=path.join(dir,'primary.md'),older=path.join(dir,'older.md'),newer=path.join(dir,'newer.md'),entered=defer(),release=defer();
 try{
  await io.writeFile(primary,'original\n');const S=createSession(),store=new DocumentStore();await store.load(S,primary);
  const grant=await store.grantSaveAs(S,older);
  if(phase==='before-replace')store.beforeReplace=async()=>{entered.resolve();await release.promise;};
  else{const validate=store.validate.bind(store);let calls=0;store.validate=async(...args)=>{await validate(...args);if(++calls===2){entered.resolve();await release.promise;}};}
  const pending=store.save(S,{filePath:older,text:'older text\n',documentId:S.documentId,revision:S.revision,saveAsToken:grant.saveAsToken}).then(value=>({value}),error=>({error}));
  await entered.promise;const current=await store.grantSaveAs(S,newer);release.resolve();const stale=await pending;
  assert(stale.error,'superseded permission is refused before target replacement');assert.equal(fs.existsSync(older),false);assert.equal(S.filePath,primary);assert.equal(S.saveAsGrant.token,current.saveAsToken);
  store.beforeReplace=async()=>{};const result=await store.save(S,{filePath:newer,text:'current text\n',documentId:S.documentId,revision:S.revision,saveAsToken:current.saveAsToken});
  assert(result.ok&&result.current);assert.equal(S.filePath,newer);assert.equal(await io.readFile(newer,'utf8'),'current text\n');assert.equal(await io.readFile(primary,'utf8'),'original\n');
 }finally{release.resolve();const resolved=await io.realpath(dir);assert(resolved.startsWith(path.join(fs.realpathSync(root),'.mp-verify')+path.sep));assert(path.basename(resolved).startsWith('store-overlap-'));await io.rm(resolved,{recursive:true,force:true});}
});
