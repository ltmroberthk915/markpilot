// dsh-markdown-typora 客户端半边（DSH 0.2.1 契约版）：右侧栏 tab 类型 + iframe 编辑面壳。
//
// 架构（见 README.md）：引擎在 iframe 里跑构建好的 CM6 核心，
// 本文件只做 DSH 皮/桥：
//   · 一个 tab 类型（*.md / *.markdown，priority=extension）吃下 dsh-resource://file/ 资源；
//   · 一个 tab body（sidebar.right.pane.tab, key=dsh-markdown-typora/editor）承载 iframe；
//   · iframe 生命周期：bridge-ready/init 后先发 theme 再 open；文档身份=sessionId+path+generation，
//     过期回执直接丢弃；切 tab / 关 tab / path 变化时 abort 或置 dead；
//   · 保存：引擎回执确认文档版本，连续增量在父窗口保留，防抖后按基准版本串行写盘。
//     关闭时将最后编辑保存在恢复日志。FS_STALE_VERSION 只给
//     冲突横幅（重载磁盘版本 / 复制我的内容），绝不覆盖；
//   · 手动保存：iframe 内 Ctrl+S（引擎 keymap）经 dsh-bridge 的 mpHost.__save 上行
//     manual-save；焦点在本 tab 的壳上时由父窗口 keydown 兜住（同时 preventDefault，
//     避免浏览器弹出“保存网页/HTML”）。两者都走同一个 runSave，立即拉全文、立即落盘，
//     并给出“已保存/保存失败/无改动”反馈；不排队盲写、不绕过版本守卫；
//   · SSE 外部变更：干净缓冲才 setValue 静默重载；脏/冲突只提示；SSE 断开降级 2s→6s 轮询，
//     页面隐藏/后台 tab 暂停轮询；
//   · 选中文段插入：只用 props.inputActions（captureInsertion + insertText，失败重 capture 一次），
//     不可用时 navigator.clipboard.writeText 兜底并提示 —— 不直接改 composer DOM（单权威）。
//
// 形态（dsh-client-modules 装载契约）：window.__ModuleLoader__.load({id, factory(require)})，
// factory 体是普通 CJS；require 只解析冻结平台表（本插件只用 react）与 dsh.client 申报过的包。
// 防御纪律：一个抛错的工厂会把整个 web shell 带崩（"entries did not activate" → 白屏），
// 所以每个服务种子独立 try，绝不上抛。
window.__ModuleLoader__.load({
  id: "dsh-markdown-typora",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = null;
    try { React = require("react"); } catch (e) { React = null; }



    /* ───────────────────────── 常量 ───────────────────────── */
    const TAB_TYPE_ID = "dsh-markdown-typora/editor";
    const TAB_KIND = "markdown-editor";
    const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
    const API_BASE = "/dsh-markdown-typora/api/";
    const FRAME_SRC = "/dsh-markdown-typora/renderer-cm6/index.html";
    const SAVE_DEBOUNCE_MS = 1500;   // 与桌面壳 _autoSaveTimer 同拍
    const PULL_TIMEOUT_MS = 2000;    // requestText 超时：超时就不保存，绝不拿旧缓存盖新内容
    const FLUSH_WAIT_MS = 120;       // 关闭后接收已排队输入消息的宽限期
    const RECOVERY_PREFIX = "dsh-markdown-typora:recovery:";
    const POLL_FAST_MS = 2000;       // SSE 断开后的首档轮询
    const POLL_SLOW_MS = 6000;       // 连续失败后的降频档
    const MAX_TEXT_CHARS = 512 * 1024; // 恢复槽上限：localStorage 5MB 配额，超限不写并告警
    const LIVE_FLUSH_TIMEOUT_MS = 4000; // live flush（引擎 facade 拉齐未确认编辑）的等待上限

    /** 当前打开的文档登记表（@mp 候选源用）。key = sessionId + '\n' + absPath */
    const openDocs = new Map();

// Browser-only recovery: IndexedDB owns large checkpoints and ordered deltas;
// Web Storage owns only the bounded tail not yet acknowledged by IndexedDB.
function createDraftStore(options = {}) {
  const idb = options.indexedDB ?? globalThis.indexedDB;
  let storage = options.storage;
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const dbName = options.dbName || 'dsh-markdown-typora-drafts-v2';
  const prefix = options.prefix || 'dsh-markdown-typora:journal:v2:';
  const maxSyncChars = options.maxSyncChars ?? 512 * 1024;
  const states = new Map(), jobs = new Map();
  let database, opening, serial = 0;
  const pathKey = value => /^[a-z]:[\\/]/i.test(value) || /^[/\\]{2}/.test(value)
    ? String(value).replace(/\\/g, '/').toLowerCase() : String(value);
  const sessionOK = s => !!s && Number.isSafeInteger(s.epoch) && Number.isSafeInteger(s.sourceRevision) && s.sourceRevision >= 0;
  const same = (a,b) => sessionOK(a) && sessionOK(b) && a.epoch === b.epoch && a.sourceRevision === b.sourceRevision;
  const failure = (code, message) => Object.assign(new Error(message), {code});
  const cloneSession = s => ({epoch:s.epoch,sourceRevision:s.sourceRevision});
  const slotKey = token => prefix + encodeURIComponent(token);
  function notify(state, error) {
    const code=error?.code || error?.name || 'RECOVERY_STORAGE';
    if(state)state.error={code,message:String(error?.message||error)};
    try {onError({path:state?.path,docToken:state?.docToken,code,message:String(error?.message||error)});} catch {}
    return {ok:false,durable:false,code,error:String(error?.message||error)};
  }
  function open() {
    if(database)return Promise.resolve(database);
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      if(!idb?.open){reject(failure('RECOVERY_UNAVAILABLE','IndexedDB is unavailable'));return;}
      let ended=false,request;
      const done=(error,db)=>{if(ended){db?.close();return;}ended=true;clearTimeout(timer);error?reject(error):resolve(database=db);};
      const timer=setTimeout(()=>done(failure('RECOVERY_OPEN_TIMEOUT','Recovery database open timed out')),5000);
      try {request=idb.open(dbName,1);}catch(error){done(error);return;}
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('records')){
          const records=db.createObjectStore('records',{keyPath:'id'});
          records.createIndex('token','docToken',{unique:false});
          records.createIndex('path','pathKey',{unique:false});
        }
      };
      request.onerror=()=>done(request.error||failure('RECOVERY_OPEN','Recovery database failed to open'));
      request.onsuccess=()=>{
        const db=request.result;db.onversionchange=()=>{db.close();if(database===db)database=null;};
        done(null,db);
      };
      request.onblocked=()=>done(failure('RECOVERY_BLOCKED','Another page is blocking recovery storage'));
    }).finally(()=>{opening=null;});
    return opening;
  }
  async function transaction(mode,body) {
    const db=await open();
    return new Promise((resolve,reject)=>{
      let tx,value,explicitError,timer;
      try {
        tx=db.transaction('records',mode);
        timer=setTimeout(()=>{explicitError=failure('RECOVERY_TRANSACTION_TIMEOUT','Recovery storage transaction timed out');try{tx.abort();}catch{reject(explicitError);}},options.transactionTimeoutMs??10000);
        tx.oncomplete=()=>{clearTimeout(timer);resolve(value);};
        tx.onerror=()=>{};
        tx.onabort=()=>{clearTimeout(timer);reject(explicitError||tx.error||failure('RECOVERY_TRANSACTION','Recovery transaction aborted'));};
        body(tx.objectStore('records'),v=>{value=v;},error=>{explicitError=error;tx.abort();});
      } catch(error){clearTimeout(timer);try{tx?.abort();}catch{}reject(error);}
    });
  }
  function enqueue(token,action,state) {
    const task=(jobs.get(token)||Promise.resolve()).catch(()=>{}).then(action).catch(error=>notify(state,error));
    jobs.set(token,task);
    task.then(()=>{if(jobs.get(token)===task)jobs.delete(token);});
    return task;
  }
  function metadata(state,session=state.session) {
    return {id:'m:'+state.docToken,type:'meta',path:state.path,pathKey:state.pathKey,
      docToken:state.docToken,checkpointId:state.checkpointId,checkpointOrder:state.checkpointOrder,session:cloneSession(session),
      baseVersion:state.baseVersion,dirty:state.dirty,composing:state.composing,ts:state.ts};
  }
  function addPiece(out,piece) {
    if(piece.from===piece.to)return;
    const prev=out.at(-1);
    if(prev&&prev.text===piece.text&&prev.to===piece.from)prev.to=piece.to;
    else out.push(piece);
  }
  function patchPieces(state,event) {
    if(!same(state.session,event.before)||!sessionOK(event.after)||event.after.epoch!==event.before.epoch||event.after.sourceRevision!==event.before.sourceRevision+1||event.beforeLength!==state.length||!Array.isArray(event.changes))throw failure('RECOVERY_GAP','Recovery delta is not continuous');
    let end=0,length=state.length;
    for(const c of event.changes){
      if(!c||!Number.isSafeInteger(c.from)||!Number.isSafeInteger(c.to)||c.from<end||c.to<c.from||c.to>state.length||typeof c.insert!=='string')throw failure('RECOVERY_DELTA','Invalid recovery delta');
      end=c.to;length+=c.insert.length-(c.to-c.from);
    }
    if(length!==event.afterLength)throw failure('RECOVERY_LENGTH','Recovery delta length mismatch');
    const out=[];let position=0,index=0,offset=0;
    function walk(to,keep){while(position<to){const p=state.pieces[index];if(!p)throw failure('RECOVERY_PIECES','Recovery pieces are incomplete');const count=Math.min(to-position,p.to-p.from-offset);if(keep)addPiece(out,{text:p.text,from:p.from+offset,to:p.from+offset+count});position+=count;offset+=count;if(offset===p.to-p.from){index++;offset=0;}}}
    for(const c of event.changes){walk(c.from,true);walk(c.to,false);addPiece(out,{text:c.insert,from:0,to:c.insert.length});}
    walk(state.length,true);
    return {...state,pieces:out,length,session:cloneSession(event.after)};
  }
  const materialize = state => state.pieces.map(p=>p.text.slice(p.from,p.to)).join('');
  function flush({docToken,path}={}) {
    const state=states.get(docToken);
    if(!state||pathKey(path||state.path)!==state.pathKey)return {ok:false,durable:false,code:'RECOVERY_OWNER'};
    if(!state.dirty){try{storage?.removeItem(slotKey(docToken));}catch{}return {ok:true,durable:state.checkpointDurable&&state.pending.length===0,synchronous:true,pending:0};}
    const durable=state.checkpointDurable&&state.pending.length===0;
    if(durable){try{storage?.removeItem(slotKey(docToken));}catch{}return {ok:true,durable:true,synchronous:true,pending:0};}
    const size=state.pendingChars+1024+(state.checkpointDurable?0:state.checkpointText.length);
    if(size>maxSyncChars)return {ok:false,durable:false,synchronous:false,pending:state.pending.length,code:'RECOVERY_TAIL_TOO_LARGE'};
    const value={schema:2,...metadata(state),baseSession:cloneSession(state.durableSession||state.checkpointSession),
      events:state.pending,...(!state.checkpointDurable?{checkpoint:{text:state.checkpointText,session:state.checkpointSession}}:{})};
    try {
      if(!storage?.setItem)throw failure('RECOVERY_SYNC_UNAVAILABLE','Synchronous recovery storage is unavailable');
      const json=JSON.stringify(value);
      if(json.length>maxSyncChars)throw failure('RECOVERY_TAIL_TOO_LARGE','Recovery tail exceeds synchronous storage budget');
      storage.setItem(slotKey(docToken),json);
      return {ok:true,durable:false,synchronous:true,pending:state.pending.length,checkpointDurable:state.checkpointDurable};
    } catch(error){return {...notify(state,error),synchronous:false,pending:state.pending.length};}
  }
  function checkpoint(slot) {
    if(!slot||typeof slot.path!=='string'||!slot.path||typeof slot.docToken!=='string'||!slot.docToken||typeof slot.text!=='string'||!sessionOK(slot.session))return Promise.resolve({ok:false,durable:false,code:'RECOVERY_CHECKPOINT'});
    const old=states.get(slot.docToken);if(old?.compactTimer)clearTimeout(old.compactTimer);
    const state={...slot,pathKey:pathKey(slot.path),session:cloneSession(slot.session),dirty:!!slot.dirty,composing:!!slot.composing,ts:slot.ts||Date.now(),
      checkpointId:Date.now().toString(36)+'-'+(++serial).toString(36)+'-'+Math.random().toString(36).slice(2),
      checkpointOrder:(old?.checkpointOrder||0)+1,
      checkpointText:slot.text,checkpointSession:cloneSession(slot.session),checkpointDurable:false,durableSession:null,
      pieces:slot.text.length?[{text:slot.text,from:0,to:slot.text.length}]:[],length:slot.text.length,pending:[],pendingChars:0,events:0,error:null};
    states.set(slot.docToken,state);flush({docToken:slot.docToken});
    const meta=metadata(state),record={...meta,id:'c:'+state.docToken+':'+state.checkpointId,type:'checkpoint',text:slot.text};
    return enqueue(state.docToken,async()=>{
      await transaction('readwrite',(records,done)=>{
        const keys=records.index('token').getAllKeys(state.docToken);
        keys.onsuccess=()=>{for(const key of keys.result)records.delete(key);records.put(record);records.put(meta);done({ok:true});};
      });
      state.checkpointDurable=true;state.durableSession=cloneSession(state.checkpointSession);
      if(states.get(state.docToken)===state)flush({docToken:state.docToken});
      return {ok:true,durable:true,session:cloneSession(state.checkpointSession)};
    },state);
  }
  function append(event) {
    const state=states.get(event?.docToken);
    if(!state||event.path&&pathKey(event.path)!==state.pathKey)return {ok:false,durable:Promise.resolve({ok:false}),code:'RECOVERY_OWNER'};
    try {
      const next=patchPieces(state,event);
      const delta={before:cloneSession(event.before),after:cloneSession(event.after),beforeLength:event.beforeLength,afterLength:event.afterLength,
        changes:event.changes.map(c=>({from:c.from,to:c.to,insert:c.insert})),composing:!!event.composing,ts:Date.now()};
      Object.assign(state,{pieces:next.pieces,length:next.length,session:next.session,dirty:true,composing:delta.composing,ts:delta.ts});
      if(typeof event.baseVersion==='string')state.baseVersion=event.baseVersion;
      const cost=delta.changes.reduce((n,c)=>n+c.insert.length+128,256);
      state.pending.push(delta);state.pendingChars+=cost;state.events++;
      const meta=metadata(state),record={...meta,id:'d:'+state.docToken+':'+state.checkpointId+':'+delta.after.sourceRevision,type:'delta',delta};
      const synchronous=flush({docToken:state.docToken});
      const durable=enqueue(state.docToken,async()=>{
        await transaction('readwrite',(records,done,abort)=>{
          const get=records.get('m:'+state.docToken);
          get.onsuccess=()=>{
            const old=get.result;
            if(!old||old.checkpointId!==record.checkpointId){abort(failure('RECOVERY_GAP','Stored recovery journal is not continuous'));return;}
            let head=old.session;
            // Retry an earlier failed write with the next delta, without ever
            // skipping the missing revision or serializing the full document.
            for(const pending of state.pending){
              if(pending.after.sourceRevision>delta.after.sourceRevision)break;
              if(pending.after.sourceRevision<=head.sourceRevision)continue;
              if(!same(head,pending.before)){abort(failure('RECOVERY_GAP','Stored recovery journal has a missing revision'));return;}
              records.put({...record,id:'d:'+state.docToken+':'+state.checkpointId+':'+pending.after.sourceRevision,delta:pending});head=pending.after;
            }
            if(!same(head,delta.after)){abort(failure('RECOVERY_GAP','Stored recovery head does not match the delta'));return;}
            records.put(meta);done({ok:true});
          };
        });
        state.pending=state.pending.filter(p=>p.after.sourceRevision>delta.after.sourceRevision);
        state.pendingChars=state.pending.reduce((sum,p)=>sum+p.changes.reduce((n,c)=>n+c.insert.length+128,256),0);
        state.durableSession=cloneSession(delta.after);
        if(states.get(state.docToken)===state)flush({docToken:state.docToken});
        return {ok:true,durable:true,session:cloneSession(delta.after)};
      },state);
      if(state.events>=128&&!state.compactTimer&&!state.releaseRequested){
        state.compactTimer=setTimeout(()=>{
          state.compactTimer=null;if(states.get(state.docToken)!==state||state.releaseRequested)return;
          void checkpoint({...metadata(state),text:materialize(state)});
        },1000);
      }
      return {ok:true,synchronous:synchronous.synchronous===true,durable};
    } catch(error){const answer=notify(state,error);return {...answer,durable:Promise.resolve(answer)};}
  }
  function markSaved(slot) {
    const state=states.get(slot?.docToken);
    if(!state||pathKey(slot.path)!==state.pathKey||!sessionOK(slot.session)||slot.session.epoch!==state.session.epoch||slot.session.sourceRevision>state.session.sourceRevision)return Promise.resolve({ok:false,code:'RECOVERY_OWNER'});
    state.baseVersion=slot.baseVersion;state.dirty=!same(slot.session,state.session);state.ts=Date.now();
    flush({docToken:state.docToken});
    return enqueue(state.docToken,()=>transaction('readwrite',(records,done,abort)=>{
      const request=records.get('m:'+state.docToken);
      request.onsuccess=()=>{
        const old=request.result;
        if(!old||old.checkpointId!==state.checkpointId||old.session.epoch!==slot.session.epoch||old.session.sourceRevision<slot.session.sourceRevision){abort(failure('RECOVERY_OWNER','Save does not belong to the recovery checkpoint'));return;}
        records.put({...old,baseVersion:slot.baseVersion,dirty:!same(old.session,slot.session),ts:state.ts});done({ok:true,durable:true});
      };
    }),state);
  }
  function clear(path,docToken,expectedSession) {
    const state=states.get(docToken);
    if(state&&(state.pathKey!==pathKey(path)||expectedSession&&!same(state.session,expectedSession)))return Promise.resolve({ok:false,code:'RECOVERY_NEWER'});
    // Another page may already own a newer synchronous tail on this baseline.
    try {const raw=storage?.getItem(slotKey(docToken));if(raw){const tail=JSON.parse(raw);if(tail.pathKey!==pathKey(path)||expectedSession&&!same(tail.session,expectedSession))return Promise.resolve({ok:false,code:'RECOVERY_NEWER'});}}catch{}
    if(state){states.delete(docToken);clearTimeout(state.compactTimer);}
    try {const raw=storage?.getItem(slotKey(docToken));if(raw){const old=JSON.parse(raw);if(old.pathKey===pathKey(path)&&(!expectedSession||same(old.session,expectedSession)))storage.removeItem(slotKey(docToken));}}catch{}
    return enqueue(docToken,()=>transaction('readwrite',(records,done)=>{
      const get=records.get('m:'+docToken);
      get.onsuccess=()=>{
        const old=get.result;
        if(old&&(old.pathKey!==pathKey(path)||expectedSession&&!same(old.session,expectedSession))){done({ok:false,code:'RECOVERY_NEWER'});return;}
        const keys=records.index('token').getAllKeys(docToken);keys.onsuccess=()=>{for(const key of keys.result)records.delete(key);done({ok:true});};
      };
    }),state);
  }
  function replay(base,events) {
    let result={session:cloneSession(base.session),length:base.text.length,pieces:base.text.length?[{text:base.text,from:0,to:base.text.length}]:[]};
    for(const event of events){if(event.after.epoch===result.session.epoch&&event.after.sourceRevision<=result.session.sourceRevision)continue;result=patchPieces(result,event);}
    return {...result,text:materialize(result)};
  }
  async function readLatest(path) {
    const key=pathKey(path),candidates=new Map(),errors=[];
    let rows=[];
    try {rows=await transaction('readonly',(records,done)=>{const request=records.index('path').getAll(key);request.onsuccess=()=>done(request.result);});}
    catch(error){errors.push(notify(null,error));}
    for(const meta of rows.filter(r=>r.type==='meta')){
      const base=rows.find(r=>r.type==='checkpoint'&&r.docToken===meta.docToken&&r.checkpointId===meta.checkpointId);
      if(!base)continue;
      try {
        const events=rows.filter(r=>r.type==='delta'&&r.docToken===meta.docToken&&r.checkpointId===meta.checkpointId).map(r=>r.delta).sort((a,b)=>a.after.sourceRevision-b.after.sourceRevision);
        const value=replay(base,events);if(!same(value.session,meta.session))throw failure('RECOVERY_GAP','Stored recovery metadata has a journal gap');
        candidates.set(meta.docToken,{...meta,text:value.text,durable:true});
      }catch(error){errors.push(notify(null,error));}
    }
    try {
      for(let i=0;i<(storage?.length||0);i++){
        const k=storage.key(i);if(!k?.startsWith(prefix))continue;
        try {
        const tail=JSON.parse(storage.getItem(k));if(tail?.schema!==2||tail.pathKey!==key||!Array.isArray(tail.events))continue;
        const stored=candidates.get(tail.docToken);
        const base=stored?.checkpointId===tail.checkpointId?stored:tail.checkpoint&&typeof tail.checkpoint.text==='string'?tail.checkpoint:null;
        if(!base)continue;
        const value=replay(base,tail.events);
        if(!same(value.session,tail.session))continue;
        // A stale synchronous tail never replaces a later IndexedDB checkpoint.
        if(stored&&stored.checkpointId!==tail.checkpointId&&stored.checkpointOrder>=tail.checkpointOrder)continue;
        candidates.set(tail.docToken,{...tail,text:value.text,durable:true,synchronous:true});
        }catch(error){errors.push(notify(null,error));}
      }
    }catch(error){errors.push(notify(null,error));}
    for(const state of states.values())if(state.pathKey===key){
      candidates.set(state.docToken,{...metadata(state),text:materialize(state),durable:state.checkpointDurable&&state.pending.length===0,error:state.error});
    }
    const dirty=[...candidates.values()].filter(r=>r.dirty).sort((a,b)=>b.ts-a.ts);
    return dirty.length?{...dirty[0],alternatives:dirty.slice(1).map(r=>({docToken:r.docToken,session:r.session,ts:r.ts})),storageErrors:errors}:null;
  }
  function status(docToken) {
    const state=states.get(docToken);
    return state?{docToken,path:state.path,session:cloneSession(state.session),dirty:state.dirty,pending:state.pending.length,
      durable:state.checkpointDurable&&state.pending.length===0,checkpointDurable:state.checkpointDurable,retained:!!state.releaseRequested,error:state.error}:null;
  }
  async function release(value) {
    const docToken=typeof value==='string'?value:value?.docToken,path=typeof value==='object'?value.path:null;
    let state=states.get(docToken);
    if(!state)return {ok:true,released:true};
    if(path&&pathKey(path)!==state.pathKey)return {ok:false,released:false,code:'RECOVERY_OWNER'};
    state.releaseRequested=true;clearTimeout(state.compactTimer);state.compactTimer=null;
    // Close grace finishes message admission before calling release. Still
    // follow any already-enqueued checkpoint/delta, including its replacement.
    for(;;){const job=jobs.get(docToken);if(!job)break;await job;}
    state=states.get(docToken);
    if(!state)return {ok:true,released:true};
    clearTimeout(state.compactTimer);
    if(!state.checkpointDurable||state.pending.length){
      const sync=flush({docToken});
      return {...notify(state,failure('RECOVERY_RETAINED','Recovery storage is incomplete; the closed draft remains in memory')),
        released:false,retained:true,synchronous:!!sync.synchronous};
    }
    if(!state.dirty){
      const result=await clear(state.path,docToken,state.session);
      return {...result,released:!states.has(docToken),durable:true};
    }
    states.delete(docToken);
    return {ok:true,durable:true,released:true};
  }
  function close() {for(const state of states.values()){clearTimeout(state.compactTimer);flush({docToken:state.docToken});}database?.close();database=null;}
  return {checkpoint,append,flush,readLatest,markSaved,clear,status,release,close};
}

    const recoveryStore = window.__dshDraftStore || createDraftStore({onError(error) {
      for (const document of openDocs.values()) document.storageError?.(error);
    }});
    window.__dshDraftStore = recoveryStore;


// The parent keeps a delta mirror for recovery; editor revisions remain authoritative.
// Session truth always comes from mpEngine.documentSession(); these functions
// never create a second editor revision counter.
function sameSession(a,b){return !!a&&!!b&&a.epoch===b.epoch&&a.sourceRevision===b.sourceRevision;}
function validSession(s){return !!s&&Number.isSafeInteger(s.epoch)&&Number.isSafeInteger(s.sourceRevision)&&s.sourceRevision>=0;}
function mirrorOf(text,session,token){
 if(typeof text!=='string'||!validSession(session))throw Error('Invalid mirror checkpoint');
 return{token,session:{...session},length:text.length,pieces:text.length?[{text,from:0,to:text.length}]:[],continuous:true};
}
function materialize(mirror){return mirror.pieces.map(p=>p.text.slice(p.from,p.to)).join('');}
function appendPiece(out,piece){
 if(piece.from===piece.to)return;
 const prev=out[out.length-1];
 if(prev&&prev.text===piece.text&&prev.to===piece.from)prev.to=piece.to;
 else out.push(piece);
}
function applyMirrorDelta(mirror,event){
 if(!mirror.continuous||event.docToken!==mirror.token||!sameSession(mirror.session,event.before)||!validSession(event.after)||event.after.epoch!==event.before.epoch||event.after.sourceRevision!==event.before.sourceRevision+1)return{ok:false,reason:'gap-or-owner'};
 if(event.beforeLength!==mirror.length||!Array.isArray(event.changes))return{ok:false,reason:'shape'};
 let previousEnd=0,length=mirror.length;
 for(const c of event.changes){
  if(!c||!Number.isSafeInteger(c.from)||!Number.isSafeInteger(c.to)||c.from<previousEnd||c.to<c.from||c.to>mirror.length||typeof c.insert!=='string')return{ok:false,reason:'ranges'};
  previousEnd=c.to;length+=c.insert.length-(c.to-c.from);
 }
 if(length!==event.afterLength)return{ok:false,reason:'length'};
 // Walk existing piece boundaries. Unchanged source text stays shared; only the
 // inserted strings and a small piece array are retained. No full text clone.
 const pieces=[];let sourcePos=0,pieceIndex=0,pieceOffset=0;
 function walkTo(target,keep){
  while(sourcePos<target){
   const p=mirror.pieces[pieceIndex];if(!p)throw Error('Corrupt mirror pieces');
   const count=Math.min(target-sourcePos,p.to-p.from-pieceOffset);
   if(keep)appendPiece(pieces,{text:p.text,from:p.from+pieceOffset,to:p.from+pieceOffset+count});
   sourcePos+=count;pieceOffset+=count;
   if(pieceOffset===p.to-p.from){pieceIndex++;pieceOffset=0;}
  }
 }
 for(const c of event.changes){walkTo(c.from,true);walkTo(c.to,false);appendPiece(pieces,{text:c.insert,from:0,to:c.insert.length});}
 walkTo(mirror.length,true);
 return{ok:true,mirror:{...mirror,session:{...event.after},length,pieces}};
}


    /** sessions 服务旁路：apply 里写入取值器（每次 boot 现取，服务晚到也能拿到 cwd；不进 cordis inject） */
    const SessionsBridge = { getSessions: null };

    let generationCounter = 0;

    /* ───────────────────────── 纯函数（可测） ───────────────────────── */

    /** 解析 dsh-resource://file/…（session / absolute 两种 scope，与官方 workspace-path 同形）。 */
    function parseFileAddress(address) {
      try {
        if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
        const segments = body.split("/");
        const scope = segments.shift();
        if (scope === "session") {
          const id = segments.shift();
          if (!id || segments.length === 0) return undefined;
          return { scope: scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join("/") };
        }
        if (scope === "absolute") {
          const unc = segments[0] === "" && segments.length > 1;
          const parts = (unc ? segments.slice(1) : segments).map(decodeURIComponent);
          if (parts.length === 0 || parts[0] === "") return undefined;
          const path = unc
            ? "//" + parts.join("/")
            : (/^[A-Za-z]:$/.test(parts[0]) ? parts.join("/") : "/" + parts.join("/"));
          return { scope: scope, path: path };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    function basenameOf(p) {
      const parts = String(p == null ? "" : p).split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(p == null ? "" : p);
    }

    function directoryOf(p) {
      const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
      const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      return cut > 0 ? s.slice(0, cut) : ".";
    }

    function isAbsolutePath(p) {
      return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
    }

    /** 用 session cwd 把相对路径并成绝对路径（纯字符串运算，不碰 fs 服务）。 */
    function absolutePath(path, cwd) {
      if (isAbsolutePath(path) || !cwd) return String(path).replace(/\\/g, "/");
      const c = String(cwd).replace(/[\\/]+$/, "");
      return (c + "/" + path).replace(/\\/g, "/");
    }

    function encodeFileAddress(sessionId, path) {
      const enc = String(path == null ? "" : path).split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return FILE_ADDRESS_PREFIX + "session/" + encodeURIComponent(sessionId) + "/" + enc;
    }

    function normalizePathKey(p) {
      return String(p == null ? "" : p).replace(/\\/g, "/");
    }

    /** Windows 盘符路径大小写不敏感；POSIX 路径保持大小写敏感。 */
    function samePath(a, b) {
      const na = normalizePathKey(a);
      const nb = normalizePathKey(b);
      if (/^[A-Za-z]:/.test(na) || /^[A-Za-z]:/.test(nb)) return na.toLowerCase() === nb.toLowerCase();
      return na === nb;
    }

    /** 恢复槽键（要求口径）：dsh-markdown-typora:recovery:<path>。 */
    function recoveryKey(path) {
      return RECOVERY_PREFIX + String(path == null ? "" : path);
    }

    function storageOf(storage) {
      if (storage) return storage;
      try { return window.localStorage; } catch (e) { return null; }
    }

    function readRecoverySlot(storage, path) {
      const store = storageOf(storage);
      if (!store || typeof store.getItem !== "function") return null;
      try {
        const raw = store.getItem(recoveryKey(path));
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!value || typeof value.text !== "string" || value.path !== path) return null;
        return value;
      } catch (e) {
        return null;
      }
    }

    function writeRecoverySlot(storage, slot) {
      const store = storageOf(storage);
      if (!store || typeof store.setItem !== "function") return false;
      if (!slot || typeof slot.path !== "string" || typeof slot.text !== "string") return false;
      if (slot.text.length > MAX_TEXT_CHARS) return false;
      try {
        store.setItem(recoveryKey(slot.path), JSON.stringify(slot));
        return true;
      } catch (e) {
        return false;
      }
    }

    function clearRecoverySlot(storage, path) {
      const store = storageOf(storage);
      if (!store || typeof store.removeItem !== "function") return;
      try { store.removeItem(recoveryKey(path)); } catch (e) { /* 配额/权限失败忽略 */ }
    }

    /** 文档代际票：sessionId + path + generation。 */
    function ticketOf(sessionId, path, generation) {
      return {
        sessionId: String(sessionId == null ? "" : sessionId),
        path: String(path == null ? "" : path),
        generation: Number.isFinite(Number(generation)) ? Number(generation) : 0,
      };
    }

    function isCurrentTicket(ticket, current) {
      if (!ticket || !current) return false;
      return ticket.generation === current.generation
        && ticket.sessionId === current.sessionId
        && samePath(ticket.path, current.path);
    }

    /**
     * 保存闸门（纯函数）：
     *   skip  = dead / 未打开 / 干净；
     *   queue = 已有保存飞行（串行，不并发）；
     *   block = 缺 baseVersion —— 拒绝盲写，交给 UI 报错；
     *   save  = 可以发请求。
     */
    function saveGate(state) {
      const s = state || {};
      if (s.dead) return { action: "skip", reason: "dead" };
      if (!s.opened) return { action: "skip", reason: "not-open" };
      if (!s.dirty) return { action: "skip", reason: "clean" };
      if (s.saving) return { action: "queue", reason: "saving" };
      if (typeof s.baseVersion !== "string" || s.baseVersion.length === 0) {
        return { action: "block", reason: "missing-base-version", code: "missing-base-version" };
      }
      return { action: "save", reason: "dirty" };
    }

    /**
     * 手动保存闸门（纯函数）：Ctrl+S 与自动保存共用版本守卫，但“干净/冲突/无基准版本”
     * 要在 UI 上给出明确反馈，而不是静默跳过。
     *   skip  = dead / 未打开；clean = 无改动；block = 冲突或缺 baseVersion；
     *   queue = 已有保存飞行；save = 立即保存。
     */
    function manualSaveGate(state) {
      const s = state || {};
      if (s.conflict) return { action: "block", reason: "conflict", code: "FS_STALE_VERSION" };
      const base = saveGate(s);
      if (base.action === "skip" && base.reason === "clean") return { action: "clean", reason: "clean" };
      return base;
    }

    /** 保存请求体：path/text/baseVersion 三者齐全才放行（baseVersion 永不省略）。
     *  live 会话激活时附带守卫票 {client, epoch, version}（房间版本来自 flush 回执）；
     *  票不完整按拒绝处理，绝不降级成无票盲写。 */
    function buildSaveRequest(payload) {
      const p = payload || {};
      if (typeof p.path !== "string" || p.path.length === 0) return { ok: false, reason: "missing-path" };
      if (typeof p.text !== "string") return { ok: false, reason: "missing-text" };
      if (typeof p.baseVersion !== "string" || p.baseVersion.length === 0) return { ok: false, reason: "missing-base-version" };
      const body = { path: p.path, text: p.text, baseVersion: p.baseVersion };
      const ticket = p.live;
      if (ticket !== undefined && ticket !== null) {
        // 房间 epoch 是 LiveDocuments rooms.epoch 的 UUID 字符串；version/savedVersion 才是整数。
        // 引擎 documentSession 的数字 epoch 是另一条契约，两者不得混用。
        if (!ticket || typeof ticket !== "object" || typeof ticket.client !== "string" || !ticket.client
          || typeof ticket.epoch !== "string" || !ticket.epoch
          || !Number.isSafeInteger(ticket.version)) {
          return { ok: false, reason: "malformed-live-ticket" };
        }
        body.live = { client: ticket.client, epoch: ticket.epoch, version: ticket.version };
      }
      return { ok: true, body: body };
    }

    /** live 保存回执并入本地会话状态（纯函数）：房间侧字段缺失时保留 flush 对齐值。 */
    function applyLiveReceipt(live, value) {
      if (!live || !value || typeof value !== "object") return live;
      const next = { ...live };
      if (Number.isSafeInteger(value.savedVersion)) next.savedVersion = value.savedVersion;
      if (typeof value.diskHash === "string" && value.diskHash) next.diskHash = value.diskHash;
      if (typeof value.epoch === "string" && value.epoch) next.epoch = value.epoch;   // UUID 字符串
      if (Number.isSafeInteger(value.liveVersion)) next.version = value.liveVersion;
      return next;
    }

    /** live 错误分类（纯函数）：unsupported=引擎无 facade（回落单窗口）；conflict=会话已死
     *  （保留草稿 + 冲突横幅，API.md §4 halt 集）；notice=瞬态（facade 自行退避重试）。 */
    function liveErrorAction(code) {
      const c = String(code || "");
      if (c === "MP_LIVE_FACADE_MISSING") return "unsupported";
      if (["MP_LIVE_LEASE", "MP_LIVE_SESSION", "MP_LIVE_CLOSED", "MP_LIVE_CONFLICT",
        "MP_LIVE_CHANGE", "MP_LIVE_UNREACHABLE", "MP_DOC_MISMATCH", "MP_FILE_CONFLICT",
        "MP_LIVE_STALE"].indexOf(c) !== -1) return "conflict";
      return "notice";
    }

    /** MP_LIVE_STALE 保存路径决策（纯函数；runSave 与真实客户端测试共用同一实现）：
     *  · 该码只表示「同一房间对端还在写」的版本竞争（API.md §4：保存路径、不 halt）；
     *  · 快重试 3 轮（0ms）→ 退避 ≤3 轮（2000ms，与输入 1500ms 防抖自然合并）→
     *    有界停止（blocked：不再自动发请求，保草稿等显式 Ctrl+S）；
     *  · 显式保存（manual）立即重试并重置预算；保存成功同样重置；
     *  · 其它冲突码（换代/歧义替换/外盘冲突）不走此函数，仍由 liveErrorAction 明确停。 */
    function liveStaleAction(state) {
      const s = state || {};
      const attempt = Number(s.attempt) || 1;
      const rounds = Number(s.rounds) || 0;
      if (s.manual) return { action: "retry-now", rounds: 0, blocked: false };       // 显式保存：重置预算
      if (s.blocked) return { action: "stopped", rounds };                           // 已停：自动路径不得再发请求
      if (attempt < 3) return { action: "retry-immediate", rounds };
      if (rounds < 3) return { action: "retry-delayed", rounds: rounds + 1, delayMs: 2000 };
      return { action: "stopped", rounds, blocked: true };
    }

    /** join 票 recovered 字段的展示投影（纯函数）：只保留带字符串 recoveryPath 的条目，
     *  截前 5 条、其余字段原样透传（sha256/at 供定位与时间显示）；宿主与插件都**不读**这些文件。
     *  提示按票（client）去重：同一 client 只提示一次。 */
    function liveRecoveredItems(ticket) {
      const raw = ticket && Array.isArray(ticket.recovered) ? ticket.recovered : [];
      const items = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== "object" || typeof entry.recoveryPath !== "string" || !entry.recoveryPath) continue;
        items.push({
          recoveryPath: entry.recoveryPath,
          ...(typeof entry.sha256 === "string" && entry.sha256 ? { sha256: entry.sha256 } : {}),
          ...(Number.isFinite(Number(entry.at)) ? { at: Number(entry.at) } : {}),
        });
        if (items.length >= 5) break;
      }
      return items;
    }

    /** 轮询档位：SSE 健康/页面隐藏/后台 tab 时返回 null（不调度）；断开首档 2s，三次后 6s。 */
    function nextPollDelay(state) {
      const s = state || {};
      if (s.hidden) return null;
      if (s.healthy) return null;
      return Number(s.failures) >= 3 ? POLL_SLOW_MS : POLL_FAST_MS;
    }

    /** 外部变更能否直接覆盖编辑面：只有干净、非冲突、无保存飞行、可见且页面在前台才行。 */
    function shouldAcceptExternal(state) {
      const s = state || {};
      if (s.dirty || s.conflict || s.saving) return false;
      if (s.hidden) return false;
      if (s.visible === false) return false;
      return true;
    }

    /**
     * 选中文段 → 对话时的载荷：开头永远先给文档绝对路径，再空一行接选区源码。
     * 这样对话里能直接看出这段内容来自哪个文件；路径为空时退回原文，不插入空行。
     */
    function composeInsertionText(path, text) {
      const source = typeof path === "string" ? path.trim() : "";
      const body = typeof text === "string" ? text : "";
      if (!source) return body;
      if (!body) return source;
      return source + "\n\n" + body;
    }

    /**
     * 选中文段插入（纯逻辑，副作用全部通过参数注入）：
     *   1) inputActions 存在 → captureInsertion() + insertText(text, span)；
     *   2) 失败/版本变了 → 重新 capture 再试一次；
     *   3) 仍失败或 props 缺失 → clipboard.writeText(text) 兜底并通知。
     * 不直接改 composer DOM（单权威：输入框内容归 inputActions）。
     */
    async function insertSelectionToChat(inputActions, text, options) {
      const opts = options || {};
      const content = typeof text === "string" ? text : "";
      if (content.length === 0) return { ok: false, method: "none", reason: "empty-text" };
      let reason = "missing-input-actions";
      const canInsert = inputActions
        && typeof inputActions.captureInsertion === "function"
        && typeof inputActions.insertText === "function";
      if (canInsert) {
        reason = "insert-rejected";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          let span;
          try { span = inputActions.captureInsertion(); } catch (e) { span = undefined; }
          if (span === undefined || span === null) continue;
          let inserted = false;
          try { inserted = inputActions.insertText(content, span) === true; } catch (e) { inserted = false; }
          if (inserted) return { ok: true, method: "insert", attempts: attempt };
        }
      }
      let copied = false;
      let error;
      try {
        if (opts.clipboard && typeof opts.clipboard.writeText === "function") {
          await opts.clipboard.writeText(content);
          copied = true;
        }
      } catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      if (typeof opts.notify === "function") {
        try { opts.notify(copied ? "copied" : "copy-failed", { reason: reason, error: error }); } catch (e) { /* 通知失败不影响结果 */ }
      }
      return {
        ok: false,
        method: copied ? "clipboard" : "clipboard-failed",
        reason: reason,
        ...(error ? { error: error } : {}),
      };
    }

    /**
     * 直接让宿主会话发一条消息（照抄 dsh-worktable 的 sendHostSession）：
     * 浮层里的编辑器拿不到右侧栏 tab 才有的 inputActions，所以不能用 composer 那条路；
     * worktable 的做法是走 sessions 服务——临时持有 → 等 ready → session.prompt(…,'queue')。
     * 只选一条通路，拒绝/超时绝不换第二条重发（第一条可能已经到宿主了）。
     */
    async function sendViaHostSession(sessionId, text) {
      const content = typeof text === "string" ? text : "";
      if (!content) return { ok: false, reason: "empty-text" };
      const sessions = SessionsBridge.getSessions ? SessionsBridge.getSessions() : null;
      if (!sessions) return { ok: false, reason: "no-sessions-service" };
      const check = (result) => {
        if (result && (result.kind === "error" || result.ok === false)) {
          const err = result.error || {};
          throw new Error(result.text || err.message || err.code || "session rejected");
        }
      };
      const send = async (session) => {
        if (session && typeof session.prompt === "function") {
          check(await session.prompt([{ type: "text", text: content }], "queue"));
          return true;
        }
        let conv = null;
        try {
          const scoped = typeof sessions.scope === "function" ? sessions.scope(sessionId) : null;
          conv = scoped && typeof scoped.get === "function" ? scoped.get("conversation") : null;
        } catch (e) { conv = null; }
        if (conv && typeof conv.send === "function") {
          check(await conv.send(content));
          return true;
        }
        return false;
      };
      try {
        if (typeof sessions.using === "function") {
          let sent = false;
          await sessions.using(sessionId, { source: "dshMarkdownTypora" }, async (ref) => {
            const binding = await (ref && ref.ready);
            sent = await send(binding && binding.session);
          });
          return sent ? { ok: true, method: "session" } : { ok: false, reason: "no-send-path" };
        }
        let face = null;
        for (let i = 0; i < 10 && !face; i += 1) {
          try { const b = sessions.binding(sessionId); face = b && b.session; } catch (e) { face = null; }
          if (!face) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const sent = await send(face);
        return sent ? { ok: true, method: "session" } : { ok: false, reason: "no-send-path" };
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    }

    /* ── 浮层编辑器的兜底通道：宿主输入框（composer）──
     * 背景：右侧栏 tab 的 body 能拿到 props.inputActions，浮层（文档工作台）拿不到，
     * 所以工具栏“插入对话/发给 AI”在浮层里必须另走一条真能到达输入框的路：
     *   ① 直接把文本写到宿主的 Lexical 输入框（派发原生 paste，交给宿主自己处理草稿）；
     *   ② 发送 = 先试回车，再退到点宿主的发送按钮。
     * 只动“把用户想发的内容送进输入框”这一步，不改宿主其它状态。
     */
    function composerEl() {
      try {
        return document.querySelector("[data-composer-input][data-lexical-editor]")
          || document.querySelector("[data-composer-input]")
          || null;
      } catch (e) { return null; }
    }

    async function writeIntoComposer(text) {
      const el = composerEl();
      if (!el) return false;
      const before = String(el.innerText || el.textContent || "");
      const content = typeof text === "string" ? text : "";
      if (!content) return false;
      try { el.focus(); } catch (e) { /* 聚焦失败也继续试 paste */ }
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      } catch (e) { /* 光标定位失败就让宿主决定插入点 */ }
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", content);
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
      } catch (e) {
        // ClipboardEvent 构造器不可用时的最后手段（execCommand 已废弃但仍广泛可用）
        try { document.execCommand("insertText", false, content); } catch (e2) { return false; }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const after = String(el.innerText || el.textContent || "");
      return composerEl() === el && after !== before && after.replace(/\s+/g, " ").includes(content.trim().replace(/\s+/g, " "));
    }

    function composerText() {
      const el = composerEl();
      if (!el) return "";
      try { return String(el.innerText || el.textContent || "").trim(); } catch (e) { return ""; }
    }

    async function submitComposer() {
      const el = composerEl();
      if (!el || !composerText()) return false;
      try {
        const card = el.closest("[data-composer-card]");
        const buttons = card ? Array.from(card.querySelectorAll("button")) : [];
        const send = buttons.find((b) => {
          const label = String(b.getAttribute("aria-label") || b.title || "");
          return /^(发送消息|Send message)$/i.test(label) && !b.disabled && b.offsetParent !== null;
        });
        if (send) { send.click(); return true; }
      } catch (e) { /* 忽略 */ }
      return false;
    }

    /* ── 手柄极限最短宽度（外壳层接管）─────────────────────────────────
     * 先查清了宿主能给的接口（不是猜的）：
     *   · layout store：setSidebar → clampWidth(px, 264, 420)；setRightbar → clampWidth(px, 300, viewport*0.7)
     *   · LayoutController 公开方法只有 selectPanel / toggleSidebar / openRightbar / closeRightbar
     *   · ui-layout 包里 264 / 300 / 0.45 / 0.7 全是模块常量，没有设置项、没有服务、没有 CSS 变量
     *   · 手柄本体是 .pI_x6G_handle（cursor:col-resize，宽 8px，挂在 frame 上）
     * 结论：**宿主的钳位下限无法通过任何官方接口改**。所以这两条手柄的拖动改由外壳层接管：
     *   · 捕获阶段拦下 pointerdown/move/up（stopPropagation），宿主就拿不到这次拖动、也就不会立刻弹回；
     *   · 自己写 frame 的 grid-template-columns 和两条手柄的 left；
     *   · 用 MutationObserver 盯 frame 的 style，宿主重渲染后把我们的值补回去；
     *   · 侧栏折叠/展开（data-sidebar-collapsed 变化）时放弃接管，交还宿主。
     * 只在拖动时生效，不改宿主状态机、不改内核。
     */
    var HANDLE_FLOOR_SIDEBAR = 180;
    var HANDLE_FLOOR_RIGHTBAR = 200;
    var HANDLE_CEIL_SIDEBAR = 420;
    var handleFloorInstalled = false;
    var handleGeneration = 0;
    var nativeHandleLeft = new Map();
    var handleLifecycleStop = null;
    var handleState = { dragging: false, side: null, startX: 0, startW: 0, sb: 0, rb: 0, frame: null, mo: null, hostGrid: "", lastWritten: "", sbMax: 0, rbMax: 0, sbUser: false, rbUser: false, parentMo: null, parentMoTarget: null };

    /**
     * 取 frame 上那两根真正的手柄。
     * 不能用裸的 `[class*="_handle"]` —— 页面里任何 class 含 _handle 的元素都会被捞进来，
     * 我们随后会把 list[0]/list[last] 的 left 挪走（等于乱动别人的元素），测量也被污染。
     * 判定：父元素的 class 含 _frame，且该元素至少有 8px 宽、cursor 是 col-resize。
     */
    function handleEls() {
      try {
        var all = document.querySelectorAll('[class*="_handle"]');
        var out = [];
        for (var i = 0; i < all.length; i += 1) {
          var el = all[i];
          var parent = el.parentElement;
          if (!parent) continue;
          var pcls = typeof parent.className === "string" ? parent.className : "";
          if (pcls.indexOf("_frame") < 0) continue;
          out.push(el);
        }
        return out.length ? out : all;   // 一个都没匹配上就退回原选择器，别把功能弄没
      } catch (e) { return []; }
    }

    function handleFrame(fallback) {
      if (fallback && fallback.isConnected) return fallback;
      var list = handleEls();
      return list.length ? list[0].parentElement : null;
    }

    /** 按类名找 frame 的三列（frame 里还有 overlay/bottom 等兄弟，不能靠 children[0]/[last] 猜）。 */
    function frameCol(kind) {
      var frame = handleFrame(handleState.frame);
      if (!frame || typeof frame.querySelector !== "function") return null;
      try { return frame.querySelector('[class*="_' + kind + 'Col"]'); } catch (e) { return null; }
    }

    /**
     * 左栏变窄后内容不要被裁掉，而是整体等比缩小：
     * zoom = 实际宽度 / 280（宿主的设计基准宽），内容按 280 逻辑像素排版、再缩到目标宽度。
     * 只在我们把手柄拖到 264 以下（宿主本来不允许的区间）时启用；
     * 回到正常区间或折叠时立即清掉，不留副作用。
     */
    var sidebarFit = null;
    function restoreSidebarFit() {
      if (!sidebarFit) return;
      var saved = sidebarFit;
      sidebarFit = null;
      Object.keys(saved.styles).forEach(function (name) {
        var before = saved.styles[name];
        // Only restore values still owned by this fit pass.
        if (saved.el.style.getPropertyValue(name) === saved.written[name]) {
          if (before.value) saved.el.style.setProperty(name, before.value, before.priority);
          else saved.el.style.removeProperty(name);
        }
      });
      saved.el.removeAttribute("data-mp-sidebar-fit");
    }
    function measureSidebarFit() {
      if (handleState.sbUser !== true) return null;
      var col = frameCol("sidebar");
      var content = col && col.firstElementChild;
      var depth = 0;
      while (content && content.children && content.children.length === 1 && depth++ < 12 && getComputedStyle(content).display === "contents") content = content.firstElementChild;
      if (!content || !content.style) return null;
      var base = sidebarFit && sidebarFit.el === content ? sidebarFit.base : Math.max(280, parseFloat(getComputedStyle(content).width) || content.offsetWidth || 280);
      return { content: content, base: base };
    }
    function fitSidebarContent(measurement) {
      var measured = arguments.length ? measurement : measureSidebarFit();
      var content = measured && measured.content;
      var sb = Number(handleState.sb);
      if (!content || !content.style || handleState.sbUser !== true || !(sb >= 100)) { restoreSidebarFit(); return; }
      if (sidebarFit && sidebarFit.el !== content) restoreSidebarFit();
      var base = measured.base;
      if (sb === base) { restoreSidebarFit(); return; }
      if (!sidebarFit) {
        var styles = {};
        ["zoom", "width", "height"].forEach(function (name) { styles[name] = { value: content.style.getPropertyValue(name), priority: content.style.getPropertyPriority(name) }; });
        sidebarFit = { el: content, base: base, styles: styles, written: {} };
      }
      var ratio = Math.min(1, sb / base);
      // Percentage heights already resolve against the physical track under
      // CSS zoom. Multiplying 100% by 1/ratio pushes the footer off screen.
      var next = { zoom: String(ratio), width: Math.max(base, sb) + "px", height: "100%" };
      Object.keys(next).forEach(function (name) {
        if (content.style.getPropertyValue(name) !== next[name]) content.style.setProperty(name, next[name]);
        sidebarFit.written[name] = content.style.getPropertyValue(name);
      });
      markOwned(content, "data-mp-sidebar-fit");
    }

    /**
     * 右栏同理：宿主的设计基准宽是 300，拖到 300 以下时内容会溢出/压到对话上，
     * 所以按 rb/300 等比缩小内容（和左栏同一套做法）。
     */
    var rightbarFit = null;
    function releaseRightbarFits(col) {
      var saved = rightbarFit;
      if (!saved || (col && col !== saved.el && saved.el.isConnected !== false)) return;
      rightbarFit = null;
      if (saved.el.isConnected === false || !saved.el.style) return;
      for (var name of Object.keys(saved.styles)) {
        var old = saved.styles[name];
        if (saved.el.style.getPropertyValue(name) !== saved.written[name]
            || saved.el.style.getPropertyPriority(name) !== "") continue;
        if (old.value) saved.el.style.setProperty(name, old.value, old.priority);
        else saved.el.style.removeProperty(name);
      }
      saved.el.removeAttribute("data-mp-rightbar-fit");
    }
    function fitRightbarContent() {
      var col = frameCol("rightbar");
      if (rightbarFit && rightbarFit.el !== col) releaseRightbarFits();
      var rb = Number(handleState.rb);
      if (col && col.style && rb >= 80) {
        // The stable column owns the fit. A newly mounted session panel gets
        // the same CSS immediately, without another observer or DOM mutation.
        var names = ["--mp-rightbar-fit-width", "--mp-rightbar-fit-zoom"];
        if (!rightbarFit) {
          rightbarFit = { el: col, styles: {}, written: {} };
          for (var name of names) rightbarFit.styles[name] = { value: col.style.getPropertyValue(name), priority: col.style.getPropertyPriority(name) };
        }
        var logicalWidth = Math.max(300, rb);
        var next = { "--mp-rightbar-fit-width": logicalWidth + "px", "--mp-rightbar-fit-zoom": String(rb / logicalWidth) };
        for (var name of names) {
          setOwnedStyle(col, name, next[name]); rightbarFit.written[name] = next[name];
        }
        markOwned(col, "data-mp-rightbar-fit");
      }
      // At zero track keep the previous width for the native closing transform.
      // Fullscreen does not match the push-only CSS, even before this runs.
      if (col && col.querySelector && col.querySelector('[data-sidebar-right-panel]')) return;
      // Legacy host without a panel marker: retain the previous fallback.
      var col = frameCol("rightbar");
      // 注意：右栏手柄本身渲染在这一列**内部**，所以 zoom 不能加在列上（会把手柄一起缩），
      // 只能加在列的第一个内容子元素上。
      var content = col && col.firstElementChild ? col.firstElementChild : null;
      if (!content || !content.style) return;
      var rb = handleState.rb;
      if (!(rb >= 80) || rb >= 300) {
        try { if (content.style.zoom) content.style.zoom = ""; } catch (e) { /* 忽略 */ }
        try { if (content.hasAttribute("data-mp-zoom")) content.removeAttribute("data-mp-zoom"); } catch (e) { /* 忽略 */ }
        return;
      }
      var ratio = Math.max(0.55, Math.min(1, rb / 300));
      try { setOwnedStyle(content, "zoom", String(Math.round(ratio * 1000) / 1000)); } catch (e) { /* 忽略 */ }
      try { markOwned(content, "data-mp-zoom"); } catch (e) { /* 忽略 */ }
    }

    /** 按标记清掉所有残留 zoom（不依赖 firstElementChild 是谁）。 */
    function clearColZoom(col) {
      releaseRightbarFits(col);
      if (sidebarFit && (!col || col === sidebarFit.el || (col.contains && col.contains(sidebarFit.el)))) restoreSidebarFit();
      if (!col) return;
      try { if (col.style) col.style.zoom = ""; } catch (e) { /* 忽略 */ }
      try { col.removeAttribute("data-mp-zoom"); } catch (e) { /* 忽略 */ }
      try {
        var nodes = col.querySelectorAll ? col.querySelectorAll("[data-mp-zoom]") : [];
        for (var i = 0; i < nodes.length; i += 1) {
          try { nodes[i].style.zoom = ""; } catch (e2) { /* 忽略 */ }
          try { nodes[i].removeAttribute("data-mp-zoom"); } catch (e3) { /* 忽略 */ }
        }
      } catch (e4) { /* 忽略 */ }
    }

    /* 中间那道：对话列边界。宿主没有给可拖手柄（挤压是我自己写的 margin），
     * 所以在编辑区右沿画一根 10px 的拖条，拖动直接改对话宽度（下限 LAYOUT_MIN_CHAT=220）。 */
    var chatHandleState = { el: null, dragging: false, startX: 0, startW: 0 };
    var handleMoveFrame = null;
    var handlePaintPending = false;

    // Raw pointer events may outnumber display frames. Commit the latest
    // geometry once, and always drain the final position before persisting.
    function flushHandleMove() {
      if (handleMoveFrame !== null) {
        try { cancelAnimationFrame(handleMoveFrame); } catch (e) { /* no RAF */ }
        handleMoveFrame = null;
      }
      if (!handleFloorInstalled) { handlePaintPending = false; return; }
      if (handlePaintPending) { handlePaintPending = false; paintHandles(); }
      if (typeof layoutReapply === "function") layoutReapply();
      else if (handleState.engine) handleState.engine.apply();
    }

    function queueHandleMove(paint) {
      handlePaintPending = handlePaintPending || paint === true;
      // ResizeObserver may have queued first. The drag commit owns that frame
      // and flushes the same engine after applying its latest grid widths.
      if (handleState.engine && handleState.engine.cancelPendingApply) handleState.engine.cancelPendingApply();
      if (handleMoveFrame !== null) return;
      if (typeof requestAnimationFrame !== "function") { flushHandleMove(); return; }
      var generation = handleGeneration;
      handleMoveFrame = requestAnimationFrame(function () {
        handleMoveFrame = null;
        if (handleGeneration === generation) flushHandleMove();
      });
    }

    function scheduleLayout() {
      if (typeof layoutReapply !== "function") return;
      if (layoutReapply.schedule) layoutReapply.schedule();
      else layoutReapply();
    }

    function setOwnedStyle(el, name, value) {
      if (el && el.style && el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    }

    // Lease only the native handle offset we actually replace. React may
    // publish a new offset while pinned; that becomes the restore baseline.
    function setNativeHandleLeft(el, value) {
      if (!el || !el.style) return;
      for (var stale of nativeHandleLeft.keys()) if (stale.isConnected === false) nativeHandleLeft.delete(stale);
      var style = el.style;
      var current = style.getPropertyValue("left");
      var priority = style.getPropertyPriority ? style.getPropertyPriority("left") : "";
      var lease = nativeHandleLeft.get(el);
      if (!lease) {
        lease = { value: current, priority: priority, written: current, writtenPriority: priority };
        nativeHandleLeft.set(el, lease);
      } else if (current !== lease.written || priority !== lease.writtenPriority) {
        lease.value = current; lease.priority = priority;
      }
      if (current !== value || priority !== "") style.setProperty("left", value);
      lease.written = value; lease.writtenPriority = "";
    }

    function restoreNativeHandleLeft() {
      for (var pair of nativeHandleLeft) {
        var el = pair[0], lease = pair[1], style = el && el.style;
        if (!style || el.isConnected === false) continue;
        var priority = style.getPropertyPriority ? style.getPropertyPriority("left") : "";
        if (style.getPropertyValue("left") !== lease.written || priority !== lease.writtenPriority) continue;
        if (lease.value) style.setProperty("left", lease.value, lease.priority);
        else style.removeProperty("left");
      }
      nativeHandleLeft.clear();
    }

    function markOwned(el, name) {
      if (el && el.getAttribute(name) !== "") el.setAttribute(name, "");
    }

    function captureHandlePointer(el, pointerId) {
      handleState.captureTarget = el;
      handleState.captureId = pointerId;
      try { if (el && el.setPointerCapture) el.setPointerCapture(pointerId); } catch (e) { /* 忽略 */ }
    }

    function releaseHandlePointer() {
      var el = handleState.captureTarget;
      var pointerId = handleState.captureId;
      handleState.captureTarget = null;
      handleState.captureId = null;
      try { if (el && el.releasePointerCapture) el.releasePointerCapture(pointerId); } catch (e) { /* 忽略 */ }
    }

    function ensureChatHandle() {
      if (!handleFloorInstalled) return null;
      if (chatHandleState.el && chatHandleState.el.isConnected) return chatHandleState.el;
      if (typeof document === "undefined" || !document.body) return null;
      try {
        // A retired factory must not leave duplicate fixed hit targets behind.
        var stale = document.querySelectorAll('[id="mp-chat-handle"]');
        for (var si = 0; si < stale.length; si += 1) stale[si].remove();
        var el = document.createElement("div");
        el.id = "mp-chat-handle";
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = "position:fixed;width:22px;margin-left:-11px;cursor:col-resize;"
          + "z-index:2147483647;display:none;background:transparent;touch-action:none";
        document.body.appendChild(el);
        chatHandleState.el = el;
        return el;
      } catch (e) { return null; }
    }

    /**
     * 左右边界的**浮层热区**（父文档层）。
     * 为什么必须有：docs 模式下编辑器的 iframe 正好盖住左侧边界线，
     * 在 iframe 上按下的 pointerdown 只会派发给 iframe 文档，父页面的
     * document 监听根本收不到 —— 表现就是"左侧手柄拖不动"（实测）。
     * 所以像中间那根一样，自己画一根浮在最上层（z-index 最高）的热区。
     */
    var frameEdge = { left: null, right: null };

    function ensureEdgeHandle(id) {
      if (!handleFloorInstalled) return null;
      if (typeof document === "undefined" || !document.body) return null;
      var el = document.getElementById(id);
      if (el && el.__mpHandleOwner === handleState) return el;
      if (el) { try { el.remove(); } catch (e) { return null; } }
      try {
        el = document.createElement("div");
        el.id = id;
        el.__mpHandleOwner = handleState;
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = "position:fixed;width:18px;margin-left:-9px;cursor:col-resize;"
          + "z-index:2147483600;display:none;background:transparent;touch-action:none";
        document.body.appendChild(el);
        frameEdge[id === "mp-edge-left" ? "left" : "right"] = el;
        return el;
      } catch (e) { return null; }
    }

    /** 摆位（visible=false 时隐藏）。 */
    function positionEdgeHandles(leftX, rightX, top, height, visible) {
      var L = ensureEdgeHandle("mp-edge-left");
      var R = ensureEdgeHandle("mp-edge-right");
      if (L) {
        setOwnedStyle(L, "display", visible ? "block" : "none");
        if (visible) { setOwnedStyle(L, "left", Math.round(leftX) + "px"); setOwnedStyle(L, "top", Math.round(top) + "px"); setOwnedStyle(L, "height", Math.round(height) + "px"); }
      }
      if (R) {
        setOwnedStyle(R, "display", visible && rightX > 0 ? "block" : "none");
        if (visible && rightX > 0) { setOwnedStyle(R, "left", Math.round(rightX) + "px"); setOwnedStyle(R, "top", Math.round(top) + "px"); setOwnedStyle(R, "height", Math.round(height) + "px"); }
      }
    }

    /** 浮层热区的按下：直接喂给现有 document 级的 move/up 逻辑。 */
    function bindEdgeHandles() {
      var styles = [["mp-edge-left", "sidebar"], ["mp-edge-right", "rightbar"]];
      for (var i = 0; i < styles.length; i += 1) {
        (function (id, side) {
          var el = ensureEdgeHandle(id);
          if (!el || el.__mpBound) return;
          el.__mpBound = true;
          el.addEventListener("pointerdown", function (e) {
            if (!handleFloorInstalled || e.button !== 0) return;
            try { e.preventDefault(); e.stopPropagation(); } catch (e0) { /* 忽略 */ }
            var now = null;
            try { now = readHandleWidths(); } catch (e1) { now = null; }
            if (!now) return;
            // 只拦"被拖的那一侧"折叠
            if (side === "sidebar" && attrOn(now.frame, "data-sidebar-collapsed")) return;
            if (side === "rightbar" && attrOn(now.frame, "data-rightbar-collapsed")) return;
            handleState.frame = now.frame;
            handleState.side = side;
            handleState.startX = e.clientX;
            handleState.startW = side === "rightbar" ? now.rb : now.sb;
            handleState.sb = now.sb;
            handleState.rb = now.rb;
            if (side === "rightbar") handleState.rbUser = true; else handleState.sbUser = true;
            handleState.dragging = true;
            captureHandlePointer(el, e.pointerId);
            traceHandle("edge-down", { side: side, x: e.clientX, sb: now.sb, rb: now.rb, vw: now.vw });
          });
        })(styles[i][0], styles[i][1]);
      }
    }

    function positionChatHandle(x, top, height, visible) {
      var el = ensureChatHandle();
      if (!el) return;
      setOwnedStyle(el, "display", visible ? "block" : "none");
      if (!visible) return;
      setOwnedStyle(el, "left", Math.round(x) + "px");
      setOwnedStyle(el, "top", Math.round(top) + "px");
      setOwnedStyle(el, "height", Math.round(height) + "px");
      // Replaying captured coordinates next frame can overwrite a newer apply.
    }

    /**
     * 侧栏/右栏是否处于宿主折叠态。
     * 注意：属性**存在**不等于折叠 —— 宿主可能写成 data-sidebar-collapsed="false"，
     * 或者干脆常驻这个属性只改值。用「属性存在」判定会把正常态误判成折叠，
     * 于是 onHandleDown 一律早退、手柄彻底拖不动（用户实测：点一下之后就不能拖了）。
     */
    function attrOn(frame, name) {
      if (!frame || !frame.getAttribute) return false;
      var v = frame.getAttribute(name);
      if (v === null) return false;
      var s = String(v).trim().toLowerCase();
      return !(s === "" || s === "false" || s === "0" || s === "off" || s === "null");
    }

    function frameCollapsed(frame) {
      return !!(frame && (attrOn(frame, "data-sidebar-collapsed") || attrOn(frame, "data-rightbar-collapsed")));
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * P1：pin 写路径（方案 A）
     *   不再改写宿主的 inline grid-template-columns（那是 React 的），改成
     *   「注入样式表 + CSS 变量 + data-mp-grid 属性」：
     *     · 折叠/隐藏/禁用 = 摘属性，宿主的 inline 从来没被改过 → 不需要"还原成什么"
     *     · !important 压过 React 的内联 style（inline 永不产生 !important）
     *     · transition:none 避免拖拽时被宿主的网格过渡平滑成橡皮筋
     *     · pin 期隐藏宿主自己的 frame 手柄（它按旧 store 摆位，会变成"假手柄"）
     * ═══════════════════════════════════════════════════════════════════════ */
    var USE_NEW_LAYOUT = true;                       // 总闸：任何异常可整体回退
    var MP_GRID_ATTR = "data-mp-grid";
    var MP_GRID_STYLE_ID = "dsh-markdown-typora-grid-style";
    /*
     * 注意两件事（第五轮审查 B1/#4）：
     * 1) **绝不能**在这里把宿主手柄 display:none —— 我们的命中判定仍靠量它的矩形，
     *    display:none 会让矩形变 0，第一次拖完手柄就永久"哑"掉。
     *    pin 期间手柄位置由 paintHandles 按模型重摆，不是"假手柄"。
     * 2) 属性选择器写两遍把特异性抬到 (0,2,0)，这样即使宿主也有同名的
     *    author-!important 规则（如全屏态），我们也不会因为"源顺序"而静默输。
     */
    // These values are consumed on the frame itself; do not propagate every
    // drag update into descendants. Defaults match the grid var() fallbacks.
    var MP_GRID_CSS = ""
      + "@property --mp-sidebar{syntax:\"<length>\";inherits:false;initial-value:264px;}"
      + "@property --mp-rightbar{syntax:\"<length>\";inherits:false;initial-value:0px;}"
      + "@property --mp-center-min{syntax:\"<length>\";inherits:false;initial-value:400px;}"
      + "[" + MP_GRID_ATTR + "][" + MP_GRID_ATTR + "]{"
      + "grid-template-columns:var(--mp-sidebar,264px) minmax(var(--mp-center-min,400px),1fr) var(--mp-rightbar,0px)!important;"
      + "transition:none!important;}"
      // 右栏卡片被窗口右边缘切掉（实测：右栏列起点比视口右界多出 ~209 CSS）。
      // 根因是列的 min-width:auto 不肯收缩，把后面的列整体推出视口。
      + "[" + MP_GRID_ATTR + "] [data-mp-rightbar-fit] [data-sidebar-right-panel=\"push\"]{width:var(--mp-rightbar-fit-width)!important;zoom:var(--mp-rightbar-fit-zoom)!important;--dsh-sidebar-width:var(--mp-rightbar-fit-width)!important;}"
      + "[" + MP_GRID_ATTR + "] > [class*=\"Col\"]{min-width:0!important;}"
      + "[" + MP_GRID_ATTR + "] > [class*=\"Col\"] > *{min-width:0!important;}";

    /** 注入 pin 样式表（幂等；doc 缺 head 时挂到 documentElement）。 */
    function ensureGridStyle(doc) {
      try {
        var d = doc || (typeof document !== "undefined" ? document : null);
        if (!d) return null;
        var found = d.getElementById ? d.getElementById(MP_GRID_STYLE_ID) : null;
        if (found) {
          if (String(found.tagName || "").toLowerCase() !== "style") return null;
          // Upgrade a previous factory's stylesheet once after hot reload.
          if (found.textContent !== MP_GRID_CSS) found.textContent = MP_GRID_CSS;
          return found;
        }
        if (!d.createElement) return null;
        var style = d.createElement("style");
        style.id = MP_GRID_STYLE_ID;
        style.textContent = MP_GRID_CSS;
        (d.head || d.documentElement).appendChild(style);
        return style;
      } catch (e) { return null; }
    }

    /** 上钉：**先写变量、后挂属性**（否则会有一帧 264 的假宽度）。 */
    function pinGrid(frame, sb, rb, centerMin) {
      if (!frame || !frame.style || !frame.setAttribute) return false;
      try { ensureGridStyle(document); } catch (e0) { /* 忽略 */ }
      try {
        setOwnedStyle(frame, "--mp-sidebar", Math.round(pureClamp(sb, 0, 9999)) + "px");
        setOwnedStyle(frame, "--mp-rightbar", Math.round(pureClamp(rb, 0, 9999)) + "px");
        if (isFinite(centerMin)) setOwnedStyle(frame, "--mp-center-min", Math.round(centerMin) + "px");
        markOwned(frame, MP_GRID_ATTR);
        return true;
      } catch (e) { return false; }
    }

    /** 下钉：**先摘属性、后清变量**（同上，避免一帧假宽度）。 */
    function unpinGrid(frame) {
      if (!frame) return;
      try { if (frame.removeAttribute) frame.removeAttribute(MP_GRID_ATTR); } catch (e0) { /* 忽略 */ }
      try {
        if (frame.style) {
          frame.style.removeProperty("--mp-sidebar");
          frame.style.removeProperty("--mp-rightbar");
          frame.style.removeProperty("--mp-center-min");
        }
      } catch (e) { /* 忽略 */ }
    }

    /** 当前是否处于 pin 态。 */
    function isPinned(frame) {
      try { return !!(frame && frame.getAttribute && frame.getAttribute(MP_GRID_ATTR) !== null); } catch (e) { return false; }
    }

    /**
     * 诊断追踪（只在页面 URL 带 ?mpdiag=1 时生效，生产零开销）。
     * 每次手柄按下/抬起时把缓冲区发给宿主，落到 %TEMP%\mp-diag.json —— 用来回答
     * "为什么这一刻手柄拖不动"这类只能在真机上定位的问题。
     */
    var traceBuf = [];
    function traceHandle(kind, data) {
      // 临时诊断已下线：保留空壳，避免改动所有调用点（零副作用）。
      return;
    }

    /**
     * P1 主路径：按模型把 pin 应用到 frame。
     * 数据来源全部走 P0 纯函数（parseHostGrid / clampModel），这里只做 DOM 写。
     */
    function applyPinnedModel(frame) {
      if (!frame) return { ok: false, reason: "no-frame" };
      var hostStr = "";
      try { hostStr = String(frame.style.gridTemplateColumns || ""); } catch (e0) { /* 忽略 */ }
      var host = parseHostGrid(hostStr);
      // 冷启动时宿主可能还没把 inline grid 写成三轨形态（React 尚未 commit / 只有两轨），
      // 这里若直接放弃，拖拽就会"完全没反应"（用户实测：必须先开一次 Markdown 才能拖）。
      // 兜底：解析失败时改用**手柄位置**量当前边界，照样能 pin。
      var fallbackW = null;
      if (!host.ok) {
        try { fallbackW = readHandleWidths(); } catch (eF) { fallbackW = null; }
        if (!fallbackW) { unpinGrid(frame); return { ok: false, reason: "host-grid-" + (host.reason || "unknown") }; }
      }
      // F3：视口太窄时绝不 pin —— 三列下限之和会超过视口，中列被压成 0，
      // 表现是"整页只剩右栏"。这类情况下让宿主自己排，我们完全放手。
      var vwGuard = Math.max(0, Math.round(Number(typeof window !== "undefined" ? window.innerWidth : 0) || 0));
      if (vwGuard > 0 && vwGuard < 1024) {
        unpinGrid(frame);
        try { frame.removeAttribute("data-mp-pinned"); } catch (eG) { /* 忽略 */ }
        traceHandle("pin-fail", { why: "viewport-narrow", vw: vwGuard });
        return { ok: false, reason: "viewport-narrow" };
      }
      var sbTrack = host.ok ? host.sbTrack : Math.max(0, fallbackW.sb);
      var rbTrack = host.ok ? host.rbTrack : Math.max(0, fallbackW.rb);

      var sidebarCollapsed = attrOn(frame, "data-sidebar-collapsed") || (host.ok && host.collapsedSidebar);
      var rightbarCollapsed = attrOn(frame, "data-rightbar-collapsed") || (host.ok && !host.rightbarOpen);
      var cfg = {};
      try { cfg = readSettings(window.localStorage) || {}; } catch (e1) { cfg = {}; }
      var vw = Math.max(0, Math.round(Number(typeof window !== "undefined" ? window.innerWidth : 0) || 0));

      // 宽度上限 = **宿主自己的面板宽**。
      // 宿主的面板是固定宽的（264 或用户设定的值），我们把网格轨道调得比它宽，
      // 面板不会跟着变宽 → 列右边空出一条大缝（用户实测）。
      // 所以：往窄拖是我们的功能（配 zoom 缩放内容），往宽拖没意义 —— 封死在宿主值。
      var sbCeil = HANDLE_CEIL_SIDEBAR;
      var rbCeil = (host.ok && rbTrack > 0) ? Math.min(RIGHTBAR_MAX, Math.round(rbTrack)) : RIGHTBAR_MAX;
      if (handleState.sb > sbCeil) handleState.sb = sbCeil;
      if (handleState.rb > rbCeil) handleState.rb = rbCeil;

      var input = {
        viewport: { w: vw, h: 0 },
        sidebar: {
          w: handleState.sb > 0 ? handleState.sb : sbTrack,
          min: isFinite(cfg.sidebarMin) ? Math.round(cfg.sidebarMin) : HANDLE_FLOOR_SIDEBAR,
          max: sbCeil,
          collapsed: sidebarCollapsed,
          userW: handleState.sbUser === true ? handleState.sb : null,
        },
        rightbar: {
          w: handleState.rbUser !== true && (docsModeOn === true || !!overlayDoc)
            ? cfg.rightbarWidth : (handleState.rb > 0 ? handleState.rb : rbTrack),
          min: isFinite(cfg.rightbarMin) ? Math.round(cfg.rightbarMin) : HANDLE_FLOOR_RIGHTBAR,
          max: rbCeil,
          collapsed: rightbarCollapsed,
          userW: handleState.rbUser === true ? handleState.rb : null,
        },
        chat: { w: isFinite(cfg.chatWidth) ? Math.round(cfg.chatWidth) : 420, min: LAYOUT_MIN_CHAT, max: 900, side: cfg.mode === "right" ? "right" : "left" },
        docs: { open: true, listW: 268 },
        phase: handleState.dragging ? "dragging" : "idle",
      };
      var res = clampModel(input, {
        viewportW: vw,
        sidebarMax: sbCeil,
        rightbarMax: rbCeil,
        collapsedSidebarW: sbTrack,
        editorMin: 240,
      });
      // 硬门：仍然放不下就不 pin（宁可让宿主自己排，也不横向溢出）
      if (!res.pinnable) { unpinGrid(frame); traceHandle("pin-fail", { why: "not-pinnable", sb: res.model.sidebar.w, rb: res.model.rightbar.w, reasons: res.reasons.join(",") }); return { ok: false, reason: "not-pinnable", model: res.model, reasons: res.reasons }; }

      var wasPinned = isPinned(frame);
      var beforeSb = parseFloat(frame.style.getPropertyValue("--mp-sidebar"));
      var beforeRb = parseFloat(frame.style.getPropertyValue("--mp-rightbar"));
      pinGrid(frame, res.model.sidebar.w, res.model.rightbar.w, PURE_DEFAULT_CENTER_MIN);
      // 把生效值回写进 handleState，后续拖动从当前值继续
      handleState.sb = res.model.sidebar.w;
      handleState.rb = res.model.rightbar.w;
      // 首次 pin 成功时记住"这是宿主实测的边界"，供后续冷启动兜底。
      if (handleState.sbMax <= 0 && sbTrack > 0) handleState.sbMax = sbTrack;
      if (handleState.rbMax <= 0 && rbTrack > 0) handleState.rbMax = rbTrack;
      try { markOwned(frame, "data-mp-pinned"); } catch (e2) { /* 旧标记：兼容现有读取方 */ }
      // 列宽真的变了 → 告调用方"舞台几何需要重算"
      var pinnedChanged = !wasPinned || (res.model.sidebar.w !== beforeSb) || (res.model.rightbar.w !== beforeRb);
      return { ok: true, model: res.model, reasons: res.reasons, host: host, pinnedChanged: pinnedChanged };
    }

    /**
     * 把 frame 的列宽交还宿主。
     * 注意：**不能删** grid-template-columns —— 那是宿主用 React 内联样式写的，
     * 删掉后 React 不会立刻补回，网格退化成单列堆叠，整页错位（用户实测"点一下崩了"）。
     * 正确做法是写回接管前记下的宿主原值；没有原值时给一个三列兜底。
     */
    function restoreHostGrid(frame) {
      if (!frame || !frame.style) return;
      // P1：新写路径下我们从不改 inline，所以"还原"就是摘掉 pin 属性/变量。
      if (USE_NEW_LAYOUT) {
        unpinGrid(frame);
        try { frame.removeAttribute("data-mp-pinned"); } catch (eN) { /* 忽略 */ }
        return;
      }
      // P0：只在"我们确实是 inline style 的最后写入者"时才还原。
      // 宿主已经自己重写过（折叠后的窄轨宽）就绝不能碰，否则会把折叠态写回全宽。
      var cur = "";
      try { cur = String(frame.style.gridTemplateColumns || ""); } catch (e) { /* 忽略 */ }
      if (handleState.lastWritten && cur !== handleState.lastWritten) {
        handleState.hostGrid = "";
        handleState.lastWritten = "";
        return;
      }
      var saved = (typeof handleState.hostGrid === "string" && handleState.hostGrid.trim()) || "";
      // 没采样到宿主原值就什么都不写：宁可保持现状，也不用兜底值把布局钉死。
      if (!saved) { handleState.lastWritten = ""; return; }
      try { frame.style.gridTemplateColumns = saved; } catch (e) { /* 忽略 */ }
      // 还原过一次就作废记录：下次接管必须重新采样宿主当前值。
      handleState.hostGrid = "";
      handleState.lastWritten = "";
      // 只在"被清空成空字符串"时补一次三列兜底（React 不会补，会塌成单列）。
      try {
        var restoreGeneration = handleGeneration;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(function () {
            try {
              if (!handleFloorInstalled || handleGeneration !== restoreGeneration) return;
              if (!frame.isConnected) return;
              if (String(frame.style.gridTemplateColumns || "").trim() === "") {
                frame.style.gridTemplateColumns = saved;
              }
            } catch (e2) { /* 忽略 */ }
          });
        }
      } catch (e3) { /* 忽略 */ }
    }

    function paintHandles() {
      if (!handleFloorInstalled) return;
      var frame = handleFrame(handleState.frame);
      if (!frame) return;
      // ── P1 新写路径 ──────────────────────────────────────────────────
      if (USE_NEW_LAYOUT) {
        var sidebarMeasurement = measureSidebarFit();
        var out = applyPinnedModel(frame);
        // 新路径成功：摆热区 + 内容缩放，收工。
        if (out.ok && out.model) {
          var vwN = Math.max(0, Math.round(Number(window.innerWidth) || 0));
          var listN = handleEls();
          for (var hi = 0; hi < listN.length; hi += 1) {
            var sideN = listN[hi].getAttribute("data-side");
            if (sideN === "sidebar") setNativeHandleLeft(listN[hi], out.model.sidebar.w + "px");
            else if (sideN === "rightbar") setNativeHandleLeft(listN[hi], (vwN - out.model.rightbar.w) + "px");
          }
          fitSidebarContent(sidebarMeasurement);
          fitRightbarContent();
          // pin 改变了中列宽度 → 舞台几何（编辑器位置/宽度）必须跟着重算，
          // 否则编辑器会停在旧几何上、甚至被算成 0 宽而"消失"（用户实测）。
          if (out.pinnedChanged) scheduleLayout();
          return;
        }
        // 失败路径（not-pinnable / 解析失败）：必须先清残留，否则
        //   · 列上还挂着我们的 zoom（宿主自己排版、内容凭空变小）
        //   · data-mp-pinned 还在（语义撒谎）
        try { frame.removeAttribute("data-mp-pinned"); } catch (eX) { /* 忽略 */ }
        try { clearColZoom(frameCol("sidebar")); clearColZoom(frameCol("rightbar")); } catch (eY) { /* 忽略 */ }
        // 宿主窄屏/折叠布局拥有几何；不可再落入旧路径改写其 grid。
        return;
      }
      // ── 旧写路径（总闸关掉、或新路径失败时走这里）──────────────────────
      // 折叠态下不能把列宽写死：否则图标收成一条、右边却留一大块空白。
      if (frameCollapsed(frame)) {
        restoreHostGrid(frame);
        try { frame.removeAttribute("data-mp-pinned"); } catch (e) { /* 忽略 */ }
        return;
      }
      // P0：sb/rb 初值是 0，若在"从未拖过手柄"时就接管，会把
      // "0px minmax(0px,1fr) 0px" 写进去 —— 两侧列直接归零、整页塌掉。
      // 规则：没量到的值先按宿主当前布局补一次；一旦有值就以用户的为准（不会被宿主覆盖）。
      var pinnedFrame = false;
      try { pinnedFrame = frame.getAttribute("data-mp-pinned") === ""; } catch (eP) { pinnedFrame = false; }
      var nowP = null;
      try { nowP = readHandleWidths(); } catch (e5) { nowP = null; }
      if (!(handleState.sb > 0) && nowP && nowP.sb > 0) handleState.sb = nowP.sb;
      if (!(handleState.rb > 0) && nowP && nowP.rb > 0) handleState.rb = nowP.rb;
      if (!(handleState.sb > 0)) return;   // 手柄还没渲染出来，别接管
      // 侧栏/右栏最宽上限：宿主自己的面板宽度。超过它，面板不会跟着变宽，
      // 列右边就会空出一条（用户实测的"缝隙"）。左右同一套规则。
      try {
        if (!(handleState.sbMax > 0)) {
          var sbColM = frameCol("sidebar");
          if (sbColM && !pinnedFrame) {
            var wM = Math.round(sbColM.getBoundingClientRect().width);
            if (wM > 0) handleState.sbMax = wM;
          }
        }
        if (!(handleState.rbMax > 0)) {
          var rbColM = frameCol("rightbar");
          if (rbColM && !pinnedFrame) {
            var wrM = Math.round(rbColM.getBoundingClientRect().width);
            if (wrM > 0) handleState.rbMax = wrM;
          }
        }
      } catch (e6) { /* 忽略 */ }
      var sbCeil = HANDLE_CEIL_SIDEBAR;
      if (handleState.sbMax > 0) sbCeil = Math.min(sbCeil, handleState.sbMax);
      // 兜底夹紧：历史上被污染过的值（比如 452）不能写回 DOM。
      handleState.sb = Math.max(HANDLE_FLOOR_SIDEBAR, Math.min(handleState.sb, sbCeil));
      var list = handleEls();
      var vw = window.innerWidth;
      // 右栏同样按"面板宽度"封顶 + 视口比例上限
      var rbCeil = Math.round(vw * 0.7);
      if (handleState.rbMax > 0) rbCeil = Math.min(rbCeil, handleState.rbMax);
      try {
        if (handleState.rb > 0) {
          handleState.rb = Math.max(HANDLE_FLOOR_RIGHTBAR, Math.min(handleState.rb, rbCeil));
        } else {
          handleState.rb = 0;
        }
      } catch (e4) { /* 忽略 */ }
      // 每次接管前都重新采样宿主自己的列宽 —— 但必须排除"我自己写进去的值"，
      // 否则记下来的是我们的宽度，还原时等于没还原，展开后就填不回来。
      var cur = String(frame.style.gridTemplateColumns || "");
      if (cur && cur !== handleState.lastWritten) handleState.hostGrid = cur;
      var mine = handleState.sb + "px minmax(0px, 1fr) " + handleState.rb + "px";
      handleState.lastWritten = mine;
      frame.style.gridTemplateColumns = mine;
      // 只有两根手柄都在时才摆位置，否则单根会被摆到错误一侧
      if (list.length >= 2) {
        if (list[0]) list[0].style.left = (handleState.sb - 4) + "px";
        list[list.length - 1].style.left = (vw - handleState.rb) + "px";
      }
      frame.setAttribute("data-mp-pinned", "");
      fitSidebarContent();
      fitRightbarContent();
    }

    function readHandleWidths() {
      var frame = handleFrame(handleState.frame);
      if (!frame) return null;
      var vw = window.innerWidth;
      // 采样策略：
      //  · 还没接管（没有 data-mp-pinned）→ 量「列本身」。此刻列宽是宿主自己的值，
      //    用它能拿到真实宽度；而手柄位置在折叠/重排后可能已经不准。
      //  · 已经接管（我们写过列宽、可能还带 zoom）→ 用「手柄位置」反推。
      //    因为列上若挂了 zoom，getBoundingClientRect 会被缩放，量出来是错的。
      var pinned = false;
      try { pinned = frame.getAttribute("data-mp-pinned") === ""; } catch (e0) { pinned = false; }
      var sbMeasured = null;
      var rbMeasured = null;
      if (pinned && !attrOn(frame, "data-animating")) {
        // Pin lives in our CSS variables. The host inline grid intentionally
        // stays unchanged, so reading it here would resurrect the old width
        // and make the visible, narrowed edge impossible to drag back.
        try {
          var pinSb = parseFloat(frame.style.getPropertyValue("--mp-sidebar"));
          var pinRb = parseFloat(frame.style.getPropertyValue("--mp-rightbar"));
          if (isFinite(pinSb)) sbMeasured = Math.round(pinSb);
          if (isFinite(pinRb)) rbMeasured = Math.round(pinRb);
        } catch (eg) { /* 解析失败就走手柄位置 */ }
      } else {
        try {
          var sbCol = frameCol("sidebar");
          if (sbCol) sbMeasured = Math.round(sbCol.getBoundingClientRect().width);
          var rbCol = frameCol("rightbar");
          if (rbCol) rbMeasured = Math.round(rbCol.getBoundingClientRect().width);
        } catch (e) { /* 量不到就退回手柄位置 */ }
      }
      if (sbMeasured !== null && rbMeasured !== null) return { frame: frame, sb: Math.max(0, sbMeasured), rb: Math.max(0, rbMeasured), vw: vw };
      var list = handleEls();
      if (!list.length) return null;
      // 按横坐标排序：宿主 DOM 顺序不一定是从左到右，取错就会把左边界的坐标当成右边界的。
      var rects = [];
      for (var qi = 0; qi < list.length; qi += 1) {
        try { rects.push(list[qi].getBoundingClientRect()); } catch (er) { /* 忽略 */ }
      }
      rects.sort(function (a, b) { return a.left - b.left; });
      var l0 = rects[0] || null;
      var l1 = rects.length > 1 ? rects[rects.length - 1] : null;
      var sbFromHandle = l0 ? Math.round(l0.left + 4) : 0;
      var rbFromHandle = l1 ? Math.round(vw - (l1.left + 4)) : 0;
      // 还没接管时，**边界以手柄位置为准**（手柄就摆在那条缝上），列宽只作兜底。
      // 之前优先用"列宽"，一旦量到别的同名元素（或列还没渲染）就会算出错的边界，
      // 命中判定随之失效 —— 表现就是"刚打开时最左侧手柄拖不动"（用户实测）。
      var sb = sbMeasured !== null ? Math.max(0, sbMeasured) : Math.max(0, sbFromHandle);
      var rb = rbMeasured !== null ? Math.max(0, rbMeasured) : Math.max(0, rbFromHandle);
      // 注意：这里**不钳位**。测量值必须如实返回 ——
      // 折叠窄轨只有 ~48px，若在测量阶段就抬到 180，调用方会把 180 写进 grid，
      // 等于"把折叠的侧栏硬撑开"。钳位只在真正写 DOM 之前做（paintHandles / onHandleMove）。
      return {
        frame: frame,
        sb: sb,
        rb: rb,
        vw: vw,
      };
    }

    function watchPinned() {
      if (!handleFloorInstalled) return;
      var watchGeneration = handleGeneration;
      var frame = handleFrame(handleState.frame);
      if (!frame || handleState.mo) return;
      var MO = window.MutationObserver;
      if (!MO) return;
      try {
        handleState.mo = new MO(function () {
          if (!handleFloorInstalled || handleGeneration !== watchGeneration) return;
          if (handleState.dragging) return;
          // frame 被宿主重挂（主区切换等）时会变成僵尸观察器：自己摘掉、重新挂到新 frame 上。
          if (!frame.isConnected) {
            try { handleState.mo.disconnect(); } catch (e1) { /* 忽略 */ }
            handleState.mo = null;
            try { watchPinned(); } catch (e2) { /* 忽略 */ }
            return;
          }
          if (frame.getAttribute("data-mp-pinned") !== "") return;
          // P1：新写路径下我们不再写 inline，旧的"inline 是否等于 want"比较已无意义，
          // 改成"只要不在 pin 态就补钉"（幂等：pin 值没变时写 DOM 也是同值，不再触发回调）。
          if (USE_NEW_LAYOUT) { if (!isPinned(frame)) paintHandles(); return; }
          var want = handleState.sb + "px minmax(0px, 1fr) " + handleState.rb + "px";
          if (frame.style.gridTemplateColumns !== want) paintHandles();
        });
        handleState.mo.observe(frame, { attributes: true, attributeFilter: ["style", "data-sidebar-collapsed", "data-rightbar-collapsed"] });
        // P1：frame 被宿主整块重挂时，pin 属性/变量随旧节点蒸发 —— 盯父节点 childList 重新钉回去。
        try {
          if (frame.parentNode && (!handleState.parentMo || handleState.parentMoTarget !== frame.parentNode)) {
            try { if (handleState.parentMo) handleState.parentMo.disconnect(); } catch (ePD) { /* 忽略 */ }
            handleState.parentMoTarget = frame.parentNode;
            handleState.parentMo = new MO(function () {
              if (!handleFloorInstalled || handleGeneration !== watchGeneration) return;
              try {
                var f = handleFrame(handleState.frame);
                if (!f) return;
                if (!isPinned(f)) paintHandles();
              } catch (e3) { /* 忽略 */ }
            });
            handleState.parentMo.observe(frame.parentNode, { childList: true });
          }
        } catch (e4) { /* 忽略 */ }
      } catch (e) { /* 忽略 */ }
    }

    function onHandleDown(e) {
      if (!handleFloorInstalled || e.button !== 0) return;
      var t = e.target;
      // ① 中间那根：对话列边界（我自己画的）
      if (t && t.id === "mp-chat-handle") {
        chatHandleState.dragging = true;
        chatHandleState.startX = e.clientX;
        var snap = handleState.engine && handleState.engine.snapshot ? handleState.engine.snapshot() : null;
        chatHandleState.startW = (snap && snap.chatW) || 420;
        // mp-chat-handle 的指针捕获：往左拖时指针会越过编辑器 iframe，
        // 不捕获的话后续 pointermove 全进 iframe 文档，父窗口收不到 → 往左拖永远没反应。
        captureHandlePointer(t, e.pointerId);
        try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
        return;
      }
      // ② 左右两条：宿主的 frame 手柄。命中判定不只认类名 ——
      //    8px 的条很容易点偏一两像素，所以再按“离边界 8px 内”兜一层。
      var cls = t && typeof t.className === "string" ? t.className : "";
      var isHandleEl = cls.indexOf("_handle") >= 0;
      var now0 = readHandleWidths();
      if (!now0) return;
      var vwNow = now0.vw;
      var midX = vwNow / 2;
      // F1：侧栏列在窄列时会挂 zoom，手柄的**可视**位置 ≈ sb × zoom，
      // 而 sb 是逻辑宽度 → 只比 sb 会差出几十像素，永远命中不了（实测"拖窄后拖不回来"）。
      var sbZoom = 1;
      try {
        var sbColZ = frameCol("sidebar");
        if (sbColZ && sbColZ.style && sbColZ.style.zoom) sbZoom = parseFloat(sbColZ.style.zoom) || 1;
      } catch (eZ) { sbZoom = 1; }
      var sbVisual = Math.round(now0.sb * sbZoom);
      var nearLeft = Math.abs(e.clientX - now0.sb) <= 8 || Math.abs(e.clientX - sbVisual) <= 10;
      var nearRight = now0.rb > 0 && Math.abs(e.clientX - (vwNow - now0.rb)) <= 8;
      if (!isHandleEl && !nearLeft && !nearRight) return;
      // 只拦"被拖的那一侧"折叠：左栏折叠不影响拖右栏，右栏收起也不该让左栏拖不动。
      // 传值是 "false"/"" 之类的都不算折叠（见 attrOn）。
      var wantLeft = nearLeft || (!nearRight && e.clientX < midX);
      if (wantLeft && attrOn(now0.frame, "data-sidebar-collapsed")) return;
      if (!wantLeft && attrOn(now0.frame, "data-rightbar-collapsed")) return;
      var now = now0;
      // 下限每次拖动现读设置（改完立刻生效，不需要重启页面）
      try {
        var cfgS = readSettings(window.localStorage);
        if (cfgS && isFinite(cfgS.sidebarMin)) HANDLE_FLOOR_SIDEBAR = Math.round(cfgS.sidebarMin);
        if (cfgS && isFinite(cfgS.rightbarMin)) HANDLE_FLOOR_RIGHTBAR = Math.round(cfgS.rightbarMin);
      } catch (err) { /* 用默认值 */ }
      var list = handleEls();
      // 优先按位置判断（右侧边界在视口中线右边）；位置也判不出来时才退回类名比较。
      var isRight = nearRight || (!nearLeft && e.clientX > now.vw * 0.5 && now.rb > 0
        && Math.abs(e.clientX - (now.vw - now.rb)) < Math.abs(e.clientX - now.sb));
      handleState.frame = now.frame;
      handleState.side = isRight ? "rightbar" : "sidebar";
      handleState.startX = e.clientX;
      handleState.startW = isRight ? now.rb : now.sb;
      handleState.sb = now.sb;
      handleState.rb = now.rb;
      // 用户主动拖过这一侧 → 之后的重排必须保留他的宽度，不能被宿主值覆盖。
      if (isRight) handleState.rbUser = true; else handleState.sbUser = true;
      handleState.dragging = true;
      // 同理：左右两条手柄也捕获指针，拖出窗口/越过 iframe 时仍能收到 move/up。
      captureHandlePointer(t, e.pointerId);
      try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
    }

    function onHandleMove(e) {
      if (!handleFloorInstalled) return;
      // 中间那根：改对话宽度（下限 220，上限 900）
      if (chatHandleState.dragging) {
        try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
        var dx0 = e.clientX - chatHandleState.startX;
        var v0 = Math.round(layoutClamp(chatHandleState.startW - dx0, LAYOUT_MIN_CHAT, 900));
        var eng = handleState.engine;
        if (eng && typeof eng.updateCfg === "function") {
          eng.updateCfg({ chatWidth: v0 });
          queueHandleMove(false);
        }
        return;
      }
      if (!handleState.dragging) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
      var dx = e.clientX - handleState.startX;
      if (handleState.side === "rightbar") {
        var maxR = Math.round(window.innerWidth * 0.7);
        handleState.rb = Math.min(maxR, Math.max(HANDLE_FLOOR_RIGHTBAR, Math.round(handleState.startW - dx)));
      } else {
        handleState.sb = Math.min(HANDLE_CEIL_SIDEBAR, Math.max(HANDLE_FLOOR_SIDEBAR, Math.round(handleState.startW + dx)));
      }
      queueHandleMove(true);
    }

    function onHandleUp(e) {
      if (!handleFloorInstalled) return;
      if (chatHandleState.dragging || handleState.dragging) {
        if (e && e.type !== "pointercancel" && isFinite(e.clientX)) onHandleMove(e);
        flushHandleMove();
      }
      releaseHandlePointer();
      if (chatHandleState.dragging) {
        chatHandleState.dragging = false;
        try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
        try {
          var snap = handleState.engine && handleState.engine.snapshot ? handleState.engine.snapshot() : null;
          if (snap && snap.chatW) writeSettings(window.localStorage, { chatWidth: snap.chatW });
        } catch (err) { /* 无存储 */ }
        return;
      }
      if (!handleState.dragging) return;
      handleState.dragging = false;
      traceHandle("up", { sb: handleState.sb, rb: handleState.rb });
      try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
      try {
        window.localStorage.setItem("dsh.markpilot.handles.v1", JSON.stringify({ sb: handleState.sb, rb: handleState.rb }));
      } catch (err) { /* 无存储 */ }
      watchPinned();
    }

    /** 侧栏折叠/展开时把手柄交还宿主：清掉接管标记与观察器。 */
    function releasePinned() {
      var frame = handleFrame(handleState.frame);
      if (handleState.mo) { try { handleState.mo.disconnect(); } catch (e) { /* 忽略 */ } handleState.mo = null; }
      if (handleState.parentMo) { try { handleState.parentMo.disconnect(); } catch (e2) { /* 忽略 */ } handleState.parentMo = null; }
      if (frame) {
        try { frame.removeAttribute("data-mp-pinned"); } catch (e) { /* 忽略 */ }
        // 关键：还原宿主自己的列宽（不能删，见 restoreHostGrid 注释）。
        restoreHostGrid(frame);
        // 交还宿主前把内容缩放清掉，否则宿主自己排版后字号会偏小。
        // 按 data-mp-zoom 标记清，宿主换过 firstElementChild 也能清干净。
        try {
          clearColZoom(frameCol("sidebar"));
          clearColZoom(frameCol("rightbar"));
        } catch (e) { /* 忽略 */ }
      }
      restoreNativeHandleLeft();
      handleState.hostGrid = "";
      handleState.lastWritten = "";
    }

    function installHandleFloor() {
      if (handleFloorInstalled) return window.__mpHandleFloorDispose;
      if (typeof window !== "undefined" && window.__mpHandleFloorInstalled) return null;
      if (typeof document === "undefined" || !document.addEventListener) return;
      handleFloorInstalled = true;
      handleGeneration += 1;
      try { window.__mpHandleFloorInstalled = true; } catch (e) { /* 忽略 */ }
      var release = null;
      var disposed = false;
      function disposeHandles() {
        if (disposed) return;
        disposed = true;
        handleFloorInstalled = false;
        handleGeneration += 1;
        chatHandleState.dragging = false;
        handleState.dragging = false;
        releaseHandlePointer();
        try { if (handleMoveFrame !== null) cancelAnimationFrame(handleMoveFrame); } catch (e0) { /* 忽略 */ }
        handleMoveFrame = null;
        handlePaintPending = false;
        try { releasePinned(); } catch (e0) { /* 忽略 */ }
        try { if (release) release.disconnect(); } catch (e0) { /* 忽略 */ }
        release = null;
        try { document.removeEventListener("pointerdown", onHandleDown, true); } catch (e0) { /* 忽略 */ }
        try { document.removeEventListener("pointermove", onHandleMove, true); } catch (e0) { /* 忽略 */ }
        try { document.removeEventListener("pointerup", onHandleUp, true); } catch (e0) { /* 忽略 */ }
        try { document.removeEventListener("pointercancel", onHandleUp, true); } catch (e0) { /* 忽略 */ }
        var owned = [chatHandleState.el, frameEdge.left, frameEdge.right];
        for (var i = 0; i < owned.length; i += 1) {
          try { if (owned[i]) owned[i].remove(); } catch (e1) { /* 忽略 */ }
        }
        chatHandleState.el = null;
        frameEdge.left = frameEdge.right = null;
        try {
          if (window.__mpHandleFloorDispose === disposeHandles) {
            // releasePinned() ran above. Only the active factory may remove
            // its unchanged sheet; a late old disposer cannot unregister it.
            var gridStyle = document.getElementById(MP_GRID_STYLE_ID);
            if (gridStyle && String(gridStyle.tagName || "").toLowerCase() === "style"
                && gridStyle.textContent === MP_GRID_CSS) gridStyle.remove();
            delete window.__mpHandleFloorDispose;
            window.__mpHandleFloorInstalled = false;
          }
        } catch (e2) { /* 忽略 */ }
      }
      try { window.__mpHandleFloorDispose = disposeHandles; } catch (e) { /* 忽略 */ }
      // The plugin lifecycle owns this disposer; opening the workbench does
      // not append another ctx.effect registration.
      document.addEventListener("pointerdown", onHandleDown, true);
      document.addEventListener("pointermove", onHandleMove, true);
      document.addEventListener("pointerup", onHandleUp, true);
      document.addEventListener("pointercancel", onHandleUp, true);
      // 侧栏折叠/展开、右栏开关：宿主会自己重排，我们放手（否则会和它的动画打架）。
      // 注意：不能只在安装这一刻解析 frame —— 插件可能比宿主布局先跑，
      // 那时 frame 还不存在，观察器就永远装不上。改成挂在 document 上、回调里现找。
      try {
        var MO = window.MutationObserver;
        if (MO) {
          release = new MO(function () {
            if (disposed) return;
            var f = handleFrame(handleState.frame);
            if (!f) return;
            if (frameCollapsed(f)) { releasePinned(); return; }
            // 重新展开：把用户自己拉过的宽度接回来
            try { paintHandles(); } catch (e) { /* 忽略 */ }
            try { watchPinned(); } catch (e) { /* 忽略 */ }
          });
          release.observe(document.documentElement || document.body, {
            attributes: true,
            subtree: true,
            attributeFilter: ["data-sidebar-collapsed", "data-rightbar-collapsed"],
          });
        }
      } catch (e) { /* 忽略 */ }
      return disposeHandles;
    }

    function installHandleLifecycle(ctx) {
      if (handleLifecycleStop) return handleLifecycleStop;
      var disposed = false, current = null;
      var sync = function () {
        if (disposed) return;
        var storage = null;
        try { storage = window.localStorage; } catch (e) { /* defaults */ }
        var settings = readSettings(storage);
        var active = docsModeOn === true || !!overlayDoc;
        var wanted = active || settings.keepResizeHandlesAfterClose === true;
        if (wanted) {
          if (!current) current = installHandleFloor();
          return;
        }
        if (!current) return;
        // Restore the document geometry before releasing its frame handles.
        try { if (typeof layoutReapply === "function") layoutReapply(); } catch (e) { /* still release handles */ }
        current(); current = null;
        handleState.sb = handleState.rb = handleState.sbMax = handleState.rbMax = 0;
        handleState.sbUser = handleState.rbUser = false;
        handleState.side = null; handleState.frame = null;
      };
      var offSettings = watchSettingsChanges(sync);
      var offOverlay = subscribeOverlayDoc(sync);
      var stop = function () {
        if (disposed) return;
        disposed = true;
        offSettings(); offOverlay();
        if (current) { current(); current = null; }
        if (handleLifecycleStop === stop) handleLifecycleStop = null;
        if (window.__mpHandleLifecycleDispose === stop) delete window.__mpHandleLifecycleDispose;
      };
      handleLifecycleStop = stop;
      window.__mpHandleLifecycleDispose = stop;
      sync();
      if (ctx && typeof ctx.effect === "function") ctx.effect(function () { return stop; }, "dsh-markdown-typora: handle lifecycle");
      return stop;
    }

    /** tab 类型定义（纯函数，便于测试 id/patterns/priority/keepMounted）。 */
    function buildTabDefinition() {
      return {
        id: TAB_TYPE_ID,
        kind: TAB_KIND,
        patterns: ["*.md", "*.markdown"],
        priority: "extension",
        canOpen: (address) => typeof address === "string" && address.startsWith(FILE_ADDRESS_PREFIX),
        title: (address) => {
          const parsed = parseFileAddress(address);
          return parsed ? basenameOf(parsed.path) : "Markdown";
        },
        keepMounted: true,
      };
    }

    function isDarkTheme() {
      try {
        return !!(typeof document !== "undefined" && document.body && document.body.hasAttribute("data-ds-dark-theme"));
      } catch (e) {
        return false;
      }
    }

    function isDocumentHidden() {
      try { return typeof document !== "undefined" && document.visibilityState === "hidden"; } catch (e) { return false; }
    }

    function currentCwd(sessionId) {
      try {
        const sessions = SessionsBridge.getSessions && SessionsBridge.getSessions();
        const byId = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot().byId;
        return byId && byId[sessionId] ? byId[sessionId].cwd : undefined;
      } catch (e) {
        return undefined;
      }
    }

    async function api(endpoint, payload) {
      const res = await fetch(API_BASE + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      if (!res.ok) throw new Error("api " + endpoint + ": HTTP " + res.status);
      return res.json();
    }

    /**
     * 上行消息判定（协议 v1 的两个信封）：
     *   __dshmd —— 插件桥 dsh-bridge.js 的 emit（init / bridge-ready / insert-to-chat …）；
     *   __dshmp —— 引擎自身的 shell 通道（change / text / openLink 直接 post 给父窗口）。
     * 两者都必须是 dir:"up" 且来自当前代 iframe；漏判 __dshmp 会让脏标与 requestText 回执全部丢失。
     */
    function isUpEnvelope(data) {
      if (!data || data.dir !== "up") return false;
      return data.__dshmd === true || data.__dshmp === true;
    }

    /* ═══════════════ 布局引擎 M0（只挤压对话，不搬 DOM）═══════════════════
 *
 * 目的：验证「把宿主的 AI 对话挤窄、在中间列空出一块」这件事在本宿主上成立。
 *       M0 不动编辑区（仍在右侧栏），只证明"挤得出来"；M1 才把编辑区搬进去。
 *
 * 边界（硬）：
 *   · 只写宿主会话内容区的 margin-left / margin-right 与一个 CSS 变量；
 *   · 不搬节点、不改宿主 grid、不碰 iframe、不动宿主 layoutInfo；
 *   · 全部写操作经 writeStyle()，值没变不碰 DOM（= 回归场景 8 的前提）；
 *   · 关闭默认：localStorage["dsh.markpilot.layout.v1"].enabled === true 才启动。
 *
 * 依据：设计 draft-2 §3.3 / §3.4 / §3.6。最关键的一条是 §3.6：
 *   宽度变量必须写在 **会话内容区** 上，不能写在会话根上 —— 宿主的
 *   ConversationWidthControls 会以 ResizeObserver 观察内容区并往**根**重写该变量
 *   （含 preference===null 时的 removeProperty），写根必然被覆盖。
 */

const LAYOUT_STORAGE_KEY = "dsh.markpilot.layout.v1";
const LAYOUT_MODES = ["center", "right", "dock", "focus"];
const LAYOUT_DEFAULTS = { enabled: false, mode: "center", chatWidth: 420 };
const LAYOUT_MIN_CHAT = 220;   // 对话列下限：220 时宿主内部（composer/卡片）会塌成竖条，300 是实测稳定值
const LAYOUT_EDITOR_MIN = 420;   // 编辑区最小可读宽：右侧栏一开，中间列可能只剩几百像素
const LAYOUT_GAP = 8;
const LAYOUT_WIDTH_VAR = "--dsh-chat-user-width";
const LAYOUT_FLAG_ATTR = "data-mp-layout";
/** 测试用：绕过"必须打开工作台才挤压"的门控（生产永远走 docsModeOn/overlayDoc）。 */
var squeezeForTests = null;
/**
 * 宿主自带一个可拖的对话宽度手柄：
 *   .Dc7zOa_widthHandle{ width: min(10px, calc((100% - var(--dsh-chat-content-width))/2 - 48px)) }
 * 我们把内容宽钉到 300~900 后该 calc 可变为负 ⇒ 声明在计算值阶段失效、width 回落 auto，
 * 同时 right 的定位会把手柄推出列外。所以布局激活期间直接隐藏它。
 * 手柄有稳定属性 data-width-handle（不依赖哈希类名）。
 */
const LAYOUT_STYLE_ID = "dsh-markdown-typora-layout-style";
const LAYOUT_STYLE_CSS = '[data-mp-layout="on"] [data-width-handle]{display:none !important}';

function ensureLayoutStyle(doc) {
  try {
    if (!doc || typeof doc.createElement !== "function") return;
    if (doc.getElementById && doc.getElementById(LAYOUT_STYLE_ID)) return;
    var style = doc.createElement("style");
    style.id = LAYOUT_STYLE_ID;
    style.textContent = LAYOUT_STYLE_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  } catch (e) { /* 样式注入失败不影响挤压本身 */ }
}

function dropLayoutStyle(doc) {
  try {
    if (!doc || typeof doc.getElementById !== "function") return;
    var el = doc.getElementById(LAYOUT_STYLE_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  } catch (e) { /* 忽略 */ }
}

function layoutClamp(value, lo, hi) {
  var n = Number(value);
  if (!isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/* ── 设置存储（官方设置页 section 的唯一数据源）──────────────────────
 * 一个键存全部：布局开关 / 对话宽 / 目标文档文件夹 / 新建模板。
 * 兼容：旧键 dsh.markpilot.layout.v1 继续被 readLayoutConfig 读取（引擎和既有测试都走它），
 * 所以写设置时把布局三字段同步回旧键 —— 两边永远一致，用户之前的配置也不会丢。
 */
const SETTINGS_KEY = "dsh.markpilot.settings.v1";
const SETTINGS_CHANGED_EVENT = "dsh-markdown-typora:settings-changed";
function readAppearance() {
  var storage = null;
  try { storage = window.localStorage; } catch (e) { /* use defaults */ }
  return { transparent: readSettings(storage).transparent !== false };
}
function watchSettingsChanges(callback) {
  var onStorage = function (event) {
    if (event.key === SETTINGS_KEY || event.key === null) callback();
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return function () {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}
const SETTINGS_DEFAULTS = {
  enabled: false,
  mode: "center",
  chatWidth: 420,
  docsFolder: "",
  workspaceOpenMode: "recent",
  workspaceEmptyMode: "files",
  workspaceSwitchMode: "follow",
  docsTemplate: "# {title}\n\n",
  transparent: true,     // 编辑区透明：让应用背景（含 dream-skin 皮肤）透上来
  keepResizeHandlesAfterClose: false,
  docsListCollapsed: false,  // 文档中心左侧列表是否折叠
  docsListWidth: 268,       // 文档中心左侧列表宽度（可拖，160..460）
  rightbarWidth: 300,    // 编辑器内的期望右栏宽度；只影响可撤回的本方网格
  sidebarMin: 180,       // 左侧栏手柄能拖到的最短宽度（宿主写死 264）
  rightbarMin: 200,      // 右侧栏手柄能拖到的最短宽度（宿主写死 300）
};

const RIGHTBAR_MIN = 300;
const RIGHTBAR_MAX = 900;

/** 读设置：旧键铺底 → 新键覆盖；任何异常都回默认。 */
function readSettings(storage) {
  var out = {
    enabled: SETTINGS_DEFAULTS.enabled,
    mode: SETTINGS_DEFAULTS.mode,
    chatWidth: SETTINGS_DEFAULTS.chatWidth,
    docsFolder: SETTINGS_DEFAULTS.docsFolder,
    workspaceOpenMode: SETTINGS_DEFAULTS.workspaceOpenMode,
    workspaceEmptyMode: SETTINGS_DEFAULTS.workspaceEmptyMode,
    workspaceSwitchMode: SETTINGS_DEFAULTS.workspaceSwitchMode,
    docsTemplate: SETTINGS_DEFAULTS.docsTemplate,
    transparent: SETTINGS_DEFAULTS.transparent,
    docsListCollapsed: SETTINGS_DEFAULTS.docsListCollapsed,
    keepResizeHandlesAfterClose: SETTINGS_DEFAULTS.keepResizeHandlesAfterClose,
    rightbarWidth: SETTINGS_DEFAULTS.rightbarWidth,
    sidebarMin: SETTINGS_DEFAULTS.sidebarMin,
    rightbarMin: SETTINGS_DEFAULTS.rightbarMin,
  };
  var legacy = readLayoutConfig(storage);
  out.enabled = legacy.enabled;
  out.mode = legacy.mode;
  out.chatWidth = legacy.chatWidth;
  try {
    if (!storage) return out;
    var raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return out;
    var s = JSON.parse(raw);
    if (!s || typeof s !== "object") return out;
    if (typeof s.enabled === "boolean") out.enabled = s.enabled;
    if (LAYOUT_MODES.indexOf(s.mode) >= 0) out.mode = s.mode;
    if (typeof s.chatWidth === "number") out.chatWidth = Math.round(layoutClamp(s.chatWidth, LAYOUT_MIN_CHAT, 900));
    if (typeof s.docsFolder === "string") out.docsFolder = s.docsFolder;
    if (["recent", "files", "blank"].includes(s.workspaceOpenMode)) out.workspaceOpenMode=s.workspaceOpenMode;
    if (["files", "blank"].includes(s.workspaceEmptyMode)) out.workspaceEmptyMode=s.workspaceEmptyMode;
    if (["follow", "keep"].includes(s.workspaceSwitchMode)) out.workspaceSwitchMode=s.workspaceSwitchMode;
    if (typeof s.docsTemplate === "string") out.docsTemplate = s.docsTemplate;
    if (typeof s.transparent === "boolean") out.transparent = s.transparent;
    if (typeof s.keepResizeHandlesAfterClose === "boolean") out.keepResizeHandlesAfterClose = s.keepResizeHandlesAfterClose;
    if (typeof s.docsListCollapsed === "boolean") out.docsListCollapsed = s.docsListCollapsed;
    if (typeof s.docsListWidth === "number") out.docsListWidth = Math.round(layoutClamp(s.docsListWidth, 160, 460));
    if (typeof s.rightbarWidth === "number") out.rightbarWidth = Math.round(layoutClamp(s.rightbarWidth, RIGHTBAR_MIN, RIGHTBAR_MAX));
    if (typeof s.sidebarMin === "number") out.sidebarMin = Math.round(layoutClamp(s.sidebarMin, 140, 420));
    if (typeof s.rightbarMin === "number") out.rightbarMin = Math.round(layoutClamp(s.rightbarMin, 160, 900));
  } catch (e) { /* 坏存档 = 沿用旧键 */ }
  return out;
}

/** 写设置：合并 → 落新键 → 布局三字段同步回旧键。返回写后的完整设置，失败返回 null。 */
function writeSettings(storage, patch) {
  var next = readSettings(storage);
  if (patch && typeof patch === "object") {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    }
  }
  next.chatWidth = Math.round(layoutClamp(next.chatWidth, LAYOUT_MIN_CHAT, 900));
  if (LAYOUT_MODES.indexOf(next.mode) < 0) next.mode = "center";
  next.enabled = next.enabled === true;
  if (!["recent", "files", "blank"].includes(next.workspaceOpenMode)) next.workspaceOpenMode="recent";
  if (!["files", "blank"].includes(next.workspaceEmptyMode)) next.workspaceEmptyMode="files";
  if (!["follow", "keep"].includes(next.workspaceSwitchMode)) next.workspaceSwitchMode="follow";
  if (typeof next.docsFolder !== "string") next.docsFolder = "";
  if (typeof next.docsTemplate !== "string") next.docsTemplate = SETTINGS_DEFAULTS.docsTemplate;
  next.transparent = next.transparent !== false;
  next.docsListCollapsed = next.docsListCollapsed === true;
  next.keepResizeHandlesAfterClose = next.keepResizeHandlesAfterClose === true;
  next.rightbarWidth = Math.round(layoutClamp(next.rightbarWidth, RIGHTBAR_MIN, RIGHTBAR_MAX));
  next.sidebarMin = Math.round(layoutClamp(next.sidebarMin, 140, 420));
  next.rightbarMin = Math.round(layoutClamp(next.rightbarMin, 160, 900));
  try {
    if (!storage) return null;
    storage.setItem(SETTINGS_KEY, JSON.stringify(next));
    saveLayoutConfig(storage, { enabled: next.enabled, mode: next.mode, chatWidth: next.chatWidth });
  } catch (e) { return null; }
  return next;
}

/** 读配置：任何异常都回默认，绝不把坏存档抛到启动路径上。 */
function readLayoutConfig(storage) {
  var out = { enabled: LAYOUT_DEFAULTS.enabled, mode: LAYOUT_DEFAULTS.mode, chatWidth: LAYOUT_DEFAULTS.chatWidth };
  if (!storage) return out;
  // 以设置键为准（设置页写的就是它），旧键仅作兼容回退。
  // 直接解析 JSON 而不调 readSettings —— 后者会回调本函数，构成递归。
  try {
    var rawNew = storage.getItem(SETTINGS_KEY);
    if (rawNew) {
      var s = JSON.parse(rawNew);
      if (s && typeof s === "object") {
        out.enabled = s.enabled === true;
        out.mode = LAYOUT_MODES.indexOf(s.mode) >= 0 ? s.mode : "center";
        if (typeof s.chatWidth === "number") out.chatWidth = Math.round(layoutClamp(s.chatWidth, LAYOUT_MIN_CHAT, 900));
        return out;
      }
    }
  } catch (e) { /* 新键坏了就继续读旧键 */ }
  try {
    var raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return out;
    var saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return out;
    out.enabled = saved.enabled === true;
    out.mode = LAYOUT_MODES.indexOf(saved.mode) >= 0 ? saved.mode : "center";
    out.chatWidth = Math.round(layoutClamp(saved.chatWidth, LAYOUT_MIN_CHAT, 900));
  } catch (e) { /* 坏存档 = 默认值 */ }
  return out;
}

function saveLayoutConfig(storage, cfg) {
  try {
    if (!storage) return false;
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      enabled: cfg.enabled === true,
      mode: LAYOUT_MODES.indexOf(cfg.mode) >= 0 ? cfg.mode : "center",
      chatWidth: Math.round(layoutClamp(cfg.chatWidth, LAYOUT_MIN_CHAT, 900)),
    }));
    return true;
  } catch (e) { return false; }
}

/** 会话根：data-phase 里排除输入框，按 active > hero > 其它 排序取第一。 */
function findConversationRoot(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return null;
  var all;
  try { all = doc.querySelectorAll("[data-phase]"); } catch (e) { return null; }
  var best = null;
  var bestRank = Infinity;
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    if (!el || el.tagName === "TEXTAREA" || el.tagName === "INPUT") continue;
    if (!el.children || el.children.length < 1) continue;
    if (/input/i.test(String(el.className || ""))) continue;
    var phase = el.dataset ? el.dataset.phase : null;
    var rank = phase === "active" ? 0 : phase === "hero" ? 1 : 2;
    if (rank < bestRank) { bestRank = rank; best = el; }
  }
  return best;
}

/**
 * 会话内容区：语义属性优先；索引仅作兜底，且**只在有两个及以上子元素时**才用 children[1]。
 *
 * 为什么不再退到 children[0]（真实宿主验收发现的缺陷）：
 *   空会话（hero 态）的 [data-phase] 根只有 1 个子元素，且**没有** [data-conversation-content]；
 *   此时 children[0] 是头部/hero 外壳，挤压它等于把标题区挤歪。
 *   宁可不挤压（返回 null → apply 放弃），也不要挤错元素。
 */
function findConversationBody(root) {
  if (!root) return null;
  try {
    if (typeof root.querySelector === "function") {
      var byAttr = root.querySelector(":scope > [data-conversation-content]");
      if (byAttr) return byAttr;
    }
  } catch (e) { /* :scope 不被支持时落到索引 */ }
  if (root.children && root.children.length >= 2) return root.children[1] || null;
  return null;
}

/**
 * 解析分栏锚点（照抄 dsh-worktable split.tsx → resolveAnchor / visibleHeaderIn）。
 * 会话根 children = [头部(或零高包装), 内容滚动区]；头是否可见要用真实 rect 判断：
 * 空会话（blank）头部是 display:none，此时按「无头部」处理，上沿取根顶部。
 * 返回的 header 只用于算编辑器上沿 —— 我们**不移动**头部，也就不会把头部裁掉。
 */
function visibleHeaderIn(first) {
  if (!first || typeof first.getBoundingClientRect !== "function") return null;
  try {
    if (first.getBoundingClientRect().height > 0) return first;
  } catch (e) { return null; }
  var all = first.querySelectorAll ? first.querySelectorAll("*") : [];
  for (var i = 0; i < all.length; i += 1) {
    try {
      var r = all[i].getBoundingClientRect();
      if (r.height > 0 && r.width > 0) return all[i];
    } catch (e) { /* 单个元素取不到就跳过 */ }
  }
  return null;
}

function resolveAnchor(root) {
  if (!root || !root.children) return null;
  var first = root.children[0];
  var second = root.children[1];
  var header = (second && first) ? visibleHeaderIn(first) : null;
  return { header: header, viewArea: second || first || null };
}

/**
 * 纯几何：给列宽/列高与配置，算出要写的两个 margin 与变量值。
 * 硬性：绝不返回负数；放不下时缩到最小并如实报告 fits=false。
 */
function computeLayout(mode, cfg, width, height) {
  var w = Number(width);
  var h = Number(height);
  if (!isFinite(w) || w <= 0) {
    return { ok: false, reason: "no-width", width: 0, height: 0, chatW: 0, marginLeft: "", marginRight: "", fits: false };
  }
  var want = layoutClamp(cfg && cfg.chatWidth, LAYOUT_MIN_CHAT, 900);
  // 内容区最多占满整列（再宽也挤不出去），且至少留 60px 给 squeezed 侧
  var chatW = Math.round(Math.min(want, Math.max(LAYOUT_MIN_CHAT, w - 60)));
  var gap = Math.max(0, w - chatW);
  var side = mode === "right" ? "right" : "left";
  return {
    ok: gap >= 0,
    reason: "ok",
    width: w,
    height: isFinite(h) ? h : 0,
    chatW: chatW,
    // 对话贴右 → 左 margin；对话贴左 → 右 margin（与设计 §3.3 一致）
    marginLeft: side === "left" ? Math.max(0, gap) + "px" : "",
    marginRight: side === "left" ? "" : Math.max(0, gap) + "px",
    fits: gap > 0,
    side: side,
  };
}

/**
 * 找出会话根里承载输入框（composer）的那个直接子元素。
 * 会话根的结构是 [头部, 内容滚动区, (可选)输入区]；我们只压内容区，
 * 输入区是**另一个孩子**，不一起压就会在窄列里飘出去/塌成竖条。
 */
function findComposerChild(root) {
  if (!root || typeof root.querySelector !== "function") return null;
  try {
    var ed = root.querySelector('[contenteditable="true"]') || root.querySelector("textarea");
    if (!ed) return null;
    var node = ed;
    while (node && node.parentElement && node.parentElement !== root) node = node.parentElement;
    return (node && node.parentElement === root) ? node : null;
  } catch (e) { return null; }
}

/**
 * 找出与「会话根」同一列的输入区（composer）容器。
 * 实测：composer 并不在会话根内部（`data-mp-narrow-chat` 盖不到它），
 * 它是列的另一个孩子；不跟着挤压，窄列里就会塌成一条竖条（输入框实测仅 43px 宽）。
 */
function findComposerInColumn(root) {
  if (!root || !root.parentElement) return null;
  var col = root.parentElement;
  var ed = null;
  try { ed = col.querySelector('[contenteditable="true"]') || col.querySelector("textarea"); } catch (e) { return null; }
  if (!ed) return null;
  var node = ed;
  var guard = 0;
  while (node && node.parentElement && node.parentElement !== col && guard < 40) {
    node = node.parentElement;
    guard += 1;
  }
  if (!node || node.parentElement !== col || node === root) return null;
  return node;
}

/** 比较再写：值没变就不碰 DOM。返回 true 表示确实写了。 */
function writeStyle(el, prop, value) {
  if (!el || !el.style) return false;
  var want = value == null ? "" : String(value);
  var current;
  try { current = el.style.getPropertyValue(prop); } catch (e) { current = ""; }
  if (current === want) return false;
  try {
    if (want === "") el.style.removeProperty(prop);
    else el.style.setProperty(prop, want);
  } catch (e) { return false; }
  return true;
}

/**
 * 引擎实例。doc/win 可注入（测试用）；observers 可注入以免依赖真实 DOM。
 * 状态：root/body/geo 只在 apply 时现取一次，平时不缓存。
 */
// Isolate platform capabilities from geometry. Only Windows has native
// verification for grouped resize observation; other hosts keep two observers.
// Both paths use the same measured geometry and frame-coalesced scheduler.
function createLayoutHostAdapter(doc, win) {
  var platform = "";
  try { platform = doc.documentElement.getAttribute("data-platform") || ""; } catch (e) { /* unknown host */ }
  if (!platform) {
    try { if (/^Win/i.test(win.navigator.platform || "")) platform = "win32"; } catch (e) { /* non-browser */ }
  }
  return {
    platform: platform || "unknown",
    groupResizeTargets: platform === "win32" || platform === "windows",
  };
}

function createLayoutEngine(options) {
  var opts = options || {};
  var doc = opts.doc || (typeof document !== "undefined" ? document : null);
  var win = opts.win || (typeof window !== "undefined" ? window : null);
  var cfg = opts.cfg || LAYOUT_DEFAULTS;
  var ResizeObserverImpl = opts.ResizeObserver || (win && win.ResizeObserver) || null;
  var MutationObserverImpl = opts.MutationObserver || (win && win.MutationObserver) || null;
  var onWarn = typeof opts.onWarn === "function" ? opts.onWarn : function () {};
  var hostAdapter = opts.hostAdapter || createLayoutHostAdapter(doc, win);

  var state = {
    disposed: false,
    active: false,
    root: null,
    body: null,
    saved: null,      // { widthVar, marginLeft, marginRight }
    last: null,       // 上次写入值，用于让位检测
    writes: 0,        // 诊断：真正写入次数
    applies: 0,       // 诊断：apply 调用次数
    negativeMargins: 0,
    yields: 0,
    ro: null,
    mo: null,
  };

  var applyFrame = null;
  var mutationTimer = null;
  function cancelApply() {
    if (applyFrame !== null && win && win.cancelAnimationFrame) win.cancelAnimationFrame(applyFrame);
    applyFrame = null;
  }
  function flush() {
    cancelApply();
    var ok = apply();
    if (ok) observe();
    return ok;
  }
  function requestApply() {
    if (state.disposed || applyFrame !== null) return;
    if (!win || !win.requestAnimationFrame) { flush(); return; }
    applyFrame = win.requestAnimationFrame(function () { applyFrame = null; flush(); });
  }

  function onObservedResize() {
    if (!state.active || state.disposed) return;
    requestApply();
  }

  function readRect(el) {
    try {
      var r = el.getBoundingClientRect();
      return {
        width: Math.round(r.width), height: Math.round(r.height),
        top: Math.round(r.top), left: Math.round(r.left),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
      };
    } catch (e) { return null; }
  }

  /** 收起浮层舞台：挤压没做成（退出文档模式 / 列太窄）时，编辑区绝不能留在屏幕上盖住对话。 */
  function hideStage() {
    try {
      var el = (doc && typeof doc.getElementById === "function") ? doc.getElementById("mp-stage") : null;
      if (el && el.style && el.style.display !== "none") el.style.display = "none";
    } catch (e) { /* 拿不到舞台就算了 */ }
    try { positionChatHandle(0, 0, 0, false); } catch (e) { /* 手柄不存在就算了 */ }
    try { positionEdgeHandles(0, 0, 0, 0, false); } catch (e2) { /* 忽略 */ }
  }

  /** 记录打开前的内联原值（只记一次；同元素重锚时不刷新，避免把自写值当原值）。 */
  function rememberOriginal(body) {
    if (state.saved && state.saved.body === body) return;
    state.saved = {
      body: body,
      widthVar: body.style.getPropertyValue(LAYOUT_WIDTH_VAR),
      marginLeft: body.style.getPropertyValue("margin-left"),
      marginRight: body.style.getPropertyValue("margin-right"),
      composer: null,
      composerMarginLeft: "",
      composerMarginRight: "",
    };
  }

  // While the normal body owns a valid explicit chat width, the host column
  // width is an unused fallback. Stop its ancestor updates at this boundary.
  // Keep the root and host declarations intact; never overwrite another owner.
  var columnWidthProperty = "--dsh-conversation-column-width";
  function columnShadowEligible(body, width) {
    return !!body && body.hasAttribute && body.hasAttribute("data-conversation-content")
      && String(body.className || "").indexOf("_embeddedBody") < 0
      && /^(?:\d+(?:\.\d+)?)px$/.test(width) && parseFloat(width) > 0
      && body.style.getPropertyValue(LAYOUT_WIDTH_VAR) === width;
  }
  function releaseColumnShadow(saved) {
    var held = saved && saved.columnShadow;
    if (!held) return;
    saved.columnShadow = null;
    var style = held.body.style;
    // A same-value declaration with a new priority also belongs to its writer.
    if (style.getPropertyValue(columnWidthProperty) !== held.written
        || style.getPropertyPriority(columnWidthProperty) !== held.writtenPriority) return;
    if (held.value) style.setProperty(columnWidthProperty, held.value, held.priority);
    else style.removeProperty(columnWidthProperty);
  }
  function syncColumnShadow(body, width) {
    var saved = state.saved;
    if (!saved || saved.body !== body || saved.columnShadowBlocked) return;
    var held = saved.columnShadow;
    if (held) {
      if (!columnShadowEligible(body, width)
          || body.style.getPropertyValue(columnWidthProperty) !== held.written
          || body.style.getPropertyPriority(columnWidthProperty) !== held.writtenPriority) {
        releaseColumnShadow(saved);
        saved.columnShadowBlocked = true;
      }
      return;
    }
    if (!state.active || !columnShadowEligible(body, width)) return;
    var value = body.style.getPropertyValue(columnWidthProperty);
    var priority = body.style.getPropertyPriority(columnWidthProperty);
    if (value || priority) { saved.columnShadowBlocked = true; return; }
    body.style.setProperty(columnWidthProperty, "0px");
    saved.columnShadow = { body: body, value: value, priority: priority,
      written: "0px", writtenPriority: "" };
    state.writes += 1;
  }

  /** 记录 composer 的原值（只记一次；元素换了就重记）。 */
  function rememberComposerOriginal(el) {
    if (!state.saved || !el) return;
    if (state.saved.composer === el) return;
    state.saved.composer = el;
    state.saved.composerMarginLeft = el.style ? el.style.getPropertyValue("margin-left") : "";
    state.saved.composerMarginRight = el.style ? el.style.getPropertyValue("margin-right") : "";
  }

  function apply() {
    if (state.disposed) return false;
    state.applies += 1;
    // ① 只有文档工作台／浮层编辑区打开时才挤压对话；
    //    否则一进首页就把对话推到右边（用户报的"没点 Markdown 对话却跑右边了"）。
    var squeezing = squeezeForTests === true
      || (typeof docsModeOn !== "undefined" && docsModeOn === true)
      || (typeof overlayDoc !== "undefined" && !!overlayDoc);
    // 视口太窄时**完全不挤压**：实测 ~1013 CSS 下列宽不够，挤压算出来的 margin 会把
    // 对话内容整块推出可视区（页面看起来全空）。这里直接放弃挤压、交还宿主。
    try {
      var vwNow2 = Math.max(0, Math.round(Number((win && win.innerWidth) || (doc && doc.documentElement && doc.documentElement.clientWidth) || 0) || 0));
      if (squeezing && vwNow2 > 0 && vwNow2 < 1024) {
        state.reason = "viewport-narrow";
        hideStage();
        if (state.active) restore();
        return false;
      }
    } catch (eVN) { /* 忽略 */ }
    if (!squeezing) { state.reason = "not-squeezing"; hideStage(); if (state.active) restore(); return false; }
    var root = findConversationRoot(doc);
    if (!root) { state.reason = "no-root"; hideStage(); if (state.active) restore(); return false; }
    var body = findConversationBody(root);
    if (!body) { state.reason = "no-body"; hideStage(); if (state.active) restore(); return false; }
    // A Files tab can already be expanded before the first Markdown opens.
    // Bootstrap its sizing lease before measuring the conversation column;
    // subsequent frames reuse the pin and never repaint handles here.
    if(handleFloorInstalled) {
      var initialFrame=handleFrame(handleState.frame);
      if(initialFrame && !isPinned(initialFrame)) { paintHandles(); watchPinned(); }
    }
    var rect = readRect(root);
    if (!rect || rect.width <= 0) { state.reason = "bad-rect"; hideStage(); if (state.active) restore(); return false; }

    var geo = computeLayout(cfg.mode, cfg, rect.width, rect.height);
    if (!geo.ok) return false;
    if (geo.chatW <= 0) { state.negativeMargins += 1; return false; }
    // 宿主列宽会变（右栏打开/收起、窗口缩放）。挤压必须按**当前**宽度重算并钳制，
    // 绝不沿用旧值 —— 否则 padding 大于可用宽度，对话会被挤到左边盖住编辑区。
    var ROOM_MIN_EDITOR = 240;   // 编辑区最少留 240（实测窗口 520 宽时仍要能挤压；420 会把窄窗口直接判死）
    var maxChat = rect.width - ROOM_MIN_EDITOR;
    if (maxChat < LAYOUT_MIN_CHAT) {
      state.reason = "too-narrow";
      // 关键：挤压放弃时必须把浮层舞台一起收起来，否则编辑区会浮在没被挤开的对话上面。
      hideStage();
      if (state.active) restore();
      return false;
    }   // 太窄，放弃挤压
    if (geo.chatW > maxChat) {
      // 钳位重建 geo 时必须沿用原来的 side：mode="right"（对话贴右）要写 margin-left，
      // mode 贴左则写 margin-right。以前这里硬编码 marginLeft，会把舞台翻到错误一侧。
      var gapC = Math.max(0, rect.width - maxChat);
      var sideC = geo.side || "left";
      geo = {
        ok: true,
        mode: geo.mode,
        side: sideC,
        chatW: maxChat,
        marginLeft: sideC === "left" ? gapC + "px" : "",
        marginRight: sideC === "left" ? "" : gapC + "px",
        height: rect.height,
        fits: gapC > 0,
      };
    }

    if ((state.root && state.root !== root) || (state.body && state.body !== body)) restore();
    rememberOriginal(body);
    state.root = root;
    state.body = body;

    var topEdge = rect.top;
    try {
      var anchorEl = resolveAnchor(root);
      var hdr = anchorEl && anchorEl.header;
      if (hdr && typeof hdr.getBoundingClientRect === "function") {
        var hr = hdr.getBoundingClientRect();
        if (hr.height > 0 && hr.bottom > rect.top) topEdge = Math.round(hr.bottom);
      }
    } catch (e) { /* 头部解析失败就贴根顶部 */ }
      // 边界坐标优先取「宿主列元素的实测边」——比 rect.left 更贴合视觉缝隙
      var leftEdgeX = rect.left;
      var rightEdgeX = rect.left + rect.width - (geo.marginLeft ? geo.chatW : 0);
      try {
        var sbColE = frameCol("sidebar");
        if (sbColE) {
          var sbR = sbColE.getBoundingClientRect();
          if (sbR && sbR.width > 0) leftEdgeX = sbR.right;
        }
        var rbColE = frameCol("rightbar");
        if (rbColE) {
          var rbR = rbColE.getBoundingClientRect();
          if (rbR && rbR.width > 4) rightEdgeX = rbR.left;
        }
      } catch (eCol) { /* 用 rect 兜底 */ }

    // ① 钉内容宽：写在 body 上（§3.6）。写在根上会被宿主 publishWidths 覆盖。
    if (writeStyle(body, LAYOUT_WIDTH_VAR, geo.chatW + "px")) state.writes += 1;

    // ② 挤压：照抄 dsh-worktable 的「会话内容区 margin」契约（split.tsx applyMargin）。
    //    gap = 列宽 − 对话宽，只写 viewArea（children[1]）的 margin-left/right；
    //    绝不碰会话根的 padding / 宽高 —— 宿主重渲染或换列宽时不会残留错值。
    if (writeStyle(body, "margin-left", geo.marginLeft)) state.writes += 1;
    if (writeStyle(body, "margin-right", geo.marginRight)) state.writes += 1;

    // ②-b 输入区（composer）是会话根的**另一个孩子**，不跟着挤压的话，
    //     窄列里它会飘到列外、塌成一条竖条（用户实测）。这里把它一起挤。
    // 输入区不单独挤压：实测给 composer 加 margin 会让它塌成 43px 竖条（宿主内部布局所致）。
    // ── 临时诊断（验证完即删）：把 composer 的祖先链（类名+宽度）发给宿主，落到 %TEMP%\mp-diag.json
    try {
      if (typeof window !== "undefined" && window.location && String(window.location.search).indexOf("mpdiag=1") >= 0) {
        var edEl = null;
        try { edEl = root.querySelector('[contenteditable="true"]'); } catch (eD0) { edEl = null; }
        if (!edEl) { try { edEl = doc.querySelector('[class*="_input"]'); } catch (eD1) { edEl = null; } }
        if (edEl) {
          var chain = [];
          var nEl = edEl;
          var guardD = 0;
          while (nEl && guardD < 14) {
            var rD = null;
            try { rD = nEl.getBoundingClientRect(); } catch (eD2) { rD = null; }
            chain.push({
              tag: String(nEl.tagName || ""),
              cls: String(nEl.className || "").slice(0, 80),
              w: rD ? Math.round(rD.width) : -1,
              h: rD ? Math.round(rD.height) : -1,
              x: rD ? Math.round(rD.left) : -1,
              ml: nEl.style ? nEl.style.marginLeft : "",
              disp: (function () { try { return getComputedStyle(nEl).display; } catch (e) { return ""; } })(),
              fd: (function () { try { return getComputedStyle(nEl).flexDirection; } catch (e) { return ""; } })()
            });
            nEl = nEl.parentElement;
            guardD += 1;
          }
          try {
            fetch("/dsh-markdown-typora/api/diag", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ kind: "composer-chain", chatW: geo.chatW, colW: rect.width, chain: chain })
            });
          } catch (eD3) { /* 忽略 */ }
        }
      }
    } catch (eD4) { /* 忽略 */ }

    // ③ 浮层舞台几何：编辑器占对话之外的那块（与 gap 严格同宽，不抢对话的位置）
    var stageEl = null;
    try { stageEl = (doc && typeof doc.getElementById === "function") ? doc.getElementById("mp-stage") : null; } catch (e) { stageEl = null; }
    var editorW = Math.max(0, rect.width - geo.chatW);
    // F2：编辑区放不下时若继续画舞台，用户看到的是"编辑器整块变白（工具栏/正文全没）"。
    // 宁可收起舞台 + 还原挤压，让对话恢复正常排版。
    if (editorW < 240) {
      state.reason = "editor-too-small";
      hideStage();
      if (state.active) restore();
      return false;
    }
    if (stageEl && editorW > 0) {
      if (stageEl.style && stageEl.style.display === "none") stageEl.style.display = "";   // 恢复上一步收起过的舞台
      var chatOnRight = !!geo.marginLeft;                 // 对话被推到右 ⇒ 编辑器在左
      var stageLeft = chatOnRight ? rect.left : rect.left + geo.chatW;
      if (writeStyle(stageEl, "left", stageLeft + "px")) state.writes += 1;
      if (writeStyle(stageEl, "top", topEdge + "px")) state.writes += 1;
      if (writeStyle(stageEl, "width", editorW + "px")) state.writes += 1;
      if (writeStyle(stageEl, "height", Math.max(0, rect.bottom - topEdge) + "px")) state.writes += 1;
    }
    // 中间那道手柄（对话列边界）跟着编辑区右沿走
    try {
      var handleX = (geo.marginLeft ? rect.left : rect.left + geo.chatW) + editorW;
      positionChatHandle(handleX, topEdge, Math.max(0, rect.bottom - topEdge), !!(stageEl && editorW > 0));
    } catch (e) { /* 手柄定位失败不影响挤压 */ }

    // 左右边界也用浮层热区（iframe 会盖住真手柄，见 ensureEdgeHandle 注释）。
    // 注意：**独立 try**，不能挂在上面那段里 —— 中间手柄一旦抛错，这段就被跳过，
    // 左边界又会"拖不动"（实测踩过）。
    try {
      bindEdgeHandles();
      // 热区与舞台是否可见无关：只要在挤压（docs 模式），左右边界就该能拖。
      positionEdgeHandles(leftEdgeX, rightEdgeX, rect.top, Math.max(0, rect.height), true);
      // The host owns the sticky composer seat and its scroll clearance.
      // Its body contains both history and composer; using that body's height
      // as padding moves the composer outside the viewport and survives close.
      // Geometry changes schedule a fresh apply; never replay stale edge positions.
      traceHandle("edge-place", { left: Math.round(leftEdgeX), right: Math.round(rightEdgeX), rootLeft: Math.round(rect.left) });
    } catch (eEdge) { /* 忽略 */ }


    // ④ 会话头：不再做"平移对齐"。
    //    之前把 Chat/Trajectory 那一条用 translateX 平移到对话列上方，
    //    结果拖中间手柄时它会跟着一路跑（用户实测：越拖越跑，还伴随抖动）。
    //    标签栏本来就属于会话头，跟着挤压自然走即可，这里只负责把历史位移清掉。
    try {
      if (state.saved && state.saved.strip) {
        try { writeStyle(state.saved.strip, "transform", state.saved.stripTransform || ""); } catch (e0) { /* 忽略 */ }
        state.saved.strip = null;
        state.saved.stripTransform = "";
      }
    } catch (e) { /* 头部对齐失败不影响挤压 */ }

    state.last = {
      marginLeft: body.style.getPropertyValue("margin-left"),
      marginRight: body.style.getPropertyValue("margin-right"),
      widthVar: geo.chatW + "px",
    };
    state.active = true;
    state.reason = "ok";
    syncColumnShadow(body, geo.chatW + "px");
    // 窄列排版修正：列宽低于阈值时挂标记。会话根上挂 data-mp-narrow-chat，
    // frame 上挂 data-mp-narrow-frame —— composer 在会话根**之外**，只有 frame 上的标记盖得到它。
    try {
      ensureNarrowChatStyle(doc);
      ensureStageHandleStyle(doc);
      var frameForMark = null;
      try { frameForMark = root.closest ? root.closest('[class*="_frame"]') : null; } catch (eFM) { frameForMark = null; }
      var isNarrow = geo.chatW < NARROW_CHAT_PX;
      // 只要在挤压（docs 模式）就给 frame 挂标记：输入框对齐、表头并行的 CSS 都挂在这个标记下。
      try {
        if (frameForMark) {
          if (frameForMark.getAttribute("data-mp-squeezed") === null) frameForMark.setAttribute("data-mp-squeezed", "");
        }
      } catch (eSQ) { /* 忽略 */ }
      if (isNarrow) {
        if (root.getAttribute("data-mp-narrow-chat") === null) root.setAttribute("data-mp-narrow-chat", "");
        if (frameForMark && frameForMark.getAttribute("data-mp-narrow-frame") === null) frameForMark.setAttribute("data-mp-narrow-frame", "");
      } else {
        if (root.getAttribute("data-mp-narrow-chat") !== null) root.removeAttribute("data-mp-narrow-chat");
        if (frameForMark && frameForMark.getAttribute("data-mp-narrow-frame") !== null) frameForMark.removeAttribute("data-mp-narrow-frame");
      }
    } catch (e) { /* 标记挂不上不影响挤压 */ }
    try { if (root.setAttribute) if (root.getAttribute(LAYOUT_FLAG_ATTR) !== "on") root.setAttribute(LAYOUT_FLAG_ATTR, "on"); } catch (e) { /* 忽略 */ }
    return true;
  }

  /** 还原：只还原我们自己动过的三个内联样式，其它一概不碰。 */
  function restore() {
    cancelApply();
    if (mutationTimer !== null) { clearTimeout(mutationTimer); mutationTimer = null; }
    hideStage();   // 舞台只由 apply() 亮起；还原时先收起来，杜绝"对话没挤、编辑区还压在上面"
    var body = state.body;
    var saved = state.saved;
    if (body && saved && saved.body === body) {
      releaseColumnShadow(saved);
      writeStyle(body, LAYOUT_WIDTH_VAR, saved.widthVar || "");
      writeStyle(body, "margin-left", saved.marginLeft || "");
      writeStyle(body, "margin-right", saved.marginRight || "");
    }
    // composer 的 margin 也要还原，否则退出文档模式后输入区会偏在右边
    if (saved && saved.composer) {
      try {
        writeStyle(saved.composer, "margin-left", saved.composerMarginLeft || "");
        writeStyle(saved.composer, "margin-right", saved.composerMarginRight || "");
      } catch (eC2) { /* 元素没了就算了 */ }
      saved.composer = null;
    }
    if (saved && saved.strip) {
      writeStyle(saved.strip, "transform", saved.stripTransform || "");
    }
    if (saved && saved.root) {
      writeStyle(saved.root, "padding-left", saved.paddingLeft || "");
      writeStyle(saved.root, "padding-right", saved.paddingRight || "");
    }
    if (state.root) {
      try { if (state.root.removeAttribute) state.root.removeAttribute(LAYOUT_FLAG_ATTR); } catch (e) { /* 忽略 */ }
      try { if (state.root.removeAttribute) state.root.removeAttribute("data-mp-narrow-chat"); } catch (e) { /* 忽略 */ }
      try {
        var frameR = state.root.closest ? state.root.closest('[class*="_frame"]') : null;
        if (frameR && frameR.removeAttribute) frameR.removeAttribute("data-mp-narrow-frame");
        if (frameR && frameR.removeAttribute) frameR.removeAttribute("data-mp-squeezed");
      } catch (eFR) { /* 忽略 */ }
    }
    if (state.ro && state.ro.disconnect) { try { state.ro.disconnect(); } catch (e) { /* 忽略 */ } }
    if (state.mo && state.mo.disconnect) { try { state.mo.disconnect(); } catch (e) { /* 忽略 */ } }
    state.ro = null;
    state.mo = null;
    if (state.parentRo && state.parentRo.disconnect) { try { state.parentRo.disconnect(); } catch (e) { /* 忽略 */ } }
    state.parentRo = null;
    if (state.heal && state.heal.disconnect) { try { state.heal.disconnect(); } catch (e) { /* 忽略 */ } }
    state.heal = null;
    state.active = false;
    state.root = null;
    state.body = null;
    state.saved = null;
    state.last = null;
  }

  /**
   * 让位：别人改了我们写过的 margin 就自动关闭（多插件共存礼貌协议）。
   * 返回 true 表示检测到外部改写并已让位。
   */
  function checkYield() {
    if (!state.active || !state.body || !state.last) return false;
    // 挤压写在「会话内容区」的 margin 上（worktable 契约），让位协议就看这两个值。
    var ml = state.body.style.getPropertyValue("margin-left");
    var mr = state.body.style.getPropertyValue("margin-right");
    if (ml !== state.last.marginLeft || mr !== state.last.marginRight) {
      state.yields += 1;
      restore();
      return true;
    }
    return false;
  }

  /** 挂观察器：只观察"根是否被换"，且 rAF + 100ms 合并（流式输出期不放大）。 */
  function observe() {
    if (!state.active) return;
    var parent = state.root && state.root.parentElement;
    if (state.parentRo && state.parentTarget !== parent) {
      if (state.ro && state.ro !== state.parentRo) state.ro.disconnect();
      state.parentRo.disconnect(); state.parentRo = null; state.ro = null;
    }
    // 右栏开关改的是网格列宽，会话根自身不一定触发 RO；同时观察父容器。
    if (ResizeObserverImpl && state.root && !state.ro) {
      try {
        state.ro = new ResizeObserverImpl(onObservedResize);
        state.ro.observe(state.root);
        // One Windows observer owns both targets, reducing registrations and
        // duplicate callbacks. Geometry still commits through the existing RAF.
        if (parent) {
          state.parentRo = hostAdapter.groupResizeTargets ? state.ro : new ResizeObserverImpl(onObservedResize);
          state.parentRo.observe(parent);
          state.parentTarget = parent;
        }
      } catch (e) { onWarn("layout: ResizeObserver 挂载失败", e); }
    }
    // 自愈：宿主重渲染可能抹掉我们写的 margin（右栏开关、会话重挂载都会发生）。
    // 只监听内容区自身的 style 变化，值与我们最后一次写入不一致就立刻补写回来。
    if (MutationObserverImpl && state.body && !state.heal) {
      try {
        state.heal = new MutationObserverImpl(function () {
          if (!state.active || !state.body || !state.last) return;
          if (!state.body.isConnected) { requestApply(); return; }
          // If our prerequisite or boundary is taken over, release before any
          // fallback width can be used. Do not reclaim it in this body lifetime.
          if (state.saved && state.saved.columnShadow) syncColumnShadow(state.body, state.last.widthVar);
          var ml = state.body.style.getPropertyValue("margin-left");
          var mr = state.body.style.getPropertyValue("margin-right");
          if (ml === state.last.marginLeft && mr === state.last.marginRight) return;
          requestApply();
        });
        state.heal.observe(state.body, { attributes: true, attributeFilter: ["style"] });
      } catch (e) { onWarn("layout: 自愈观察器挂载失败", e); }
    }
    if (MutationObserverImpl && doc && doc.body && !state.mo) {
      var lastRun = 0;
      try {
        state.mo = new MutationObserverImpl(function () {
          if (!state.active) return;
          if (onWarn.noop) return;
          var now = (win && win.performance && win.performance.now) ? win.performance.now() : Date.now();
          if (now - lastRun < 100) {
            if (mutationTimer === null) {
              mutationTimer = setTimeout(function () {
                mutationTimer = null;
                lastRun = (win && win.performance && win.performance.now) ? win.performance.now() : Date.now();
                tick();
              }, 100 - (now - lastRun));
            }
            return;
          }
          lastRun = now;
          tick();
        });
        state.mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-phase"] });
      } catch (e) { onWarn("layout: MutationObserver 挂载失败", e); }
      var tick = function () {
        if (!state.active) return;
        if (checkYield()) return;
        var current = findConversationRoot(doc);
        if (current && (current !== state.root || findConversationBody(current) !== state.body)) requestApply();
      };
    }
  }

  /** 根被换（切会话 / hero→active）：旧身体还原 → 新根重绑 → 重新挤压。 */
  function rebind() {
    var oldBody = state.body;
    var saved = state.saved;
    if (oldBody && saved && saved.body === oldBody) {
      releaseColumnShadow(saved);
      writeStyle(oldBody, LAYOUT_WIDTH_VAR, saved.widthVar || "");
      writeStyle(oldBody, "margin-left", saved.marginLeft || "");
      writeStyle(oldBody, "margin-right", saved.marginRight || "");
    }
    state.saved = null;
    state.last = null;
    state.body = null;
    state.root = null;
    if (state.ro && state.ro.disconnect) { try { state.ro.disconnect(); } catch (e) { /* 忽略 */ } }
    state.ro = null;
    if (state.heal && state.heal.disconnect) { try { state.heal.disconnect(); } catch (e) { /* 忽略 */ } }
    state.heal = null;
    state.active = false;
    if (apply()) observe();
  }

  function snapshot() {
    return {
      active: state.active,
      reason: state.reason || "",
      writes: state.writes,
      applies: state.applies,
      negativeMargins: state.negativeMargins,
      yields: state.yields,
      chatW: state.last ? parseInt(state.last.widthVar, 10) : 0,
      marginLeft: state.last ? state.last.marginLeft : "",
      marginRight: state.last ? state.last.marginRight : "",
      hasRoot: !!state.root,
      hasBody: !!state.body,
    };
  }

  return {
    apply: apply,
    requestApply: requestApply,
    cancelPendingApply: cancelApply,
    flush: flush,
    restore: restore,
    dispose: function () { if (!state.disposed) { state.disposed = true; restore(); } },
    observe: observe,
    checkYield: checkYield,
    snapshot: snapshot,
    /** 侧栏手柄拖动时实时改对话宽度用：只改闭包里的 cfg，下一次 apply 立刻生效。 */
    updateCfg: function (next) {
      if (next && typeof next === "object") {
        for (var k in next) {
          if (Object.prototype.hasOwnProperty.call(next, k)) cfg[k] = next[k];
        }
      }
      return cfg;
    },
    // 测试出口
    __internals: { computeLayout: computeLayout, writeStyle: writeStyle },
  };
}

/**
 * 等会话根出现再激活（一次性 MutationObserver + 单次超时，不轮询）。
 * 场景：用户先看到 onboarding / 还没有任何会话，此时 [data-phase] 根本不存在；
 * 如果只在加载瞬间尝试一次，布局永远不会激活（实测缺陷）。
 * 返回一个 stop()，调用方在卸载时用它收尾。
 */
const NARROW_CHAT_PX = 360;
// 窄列排版"修正"已停用（方案 v3 的教训）：
//   · 对话列下限提到 300 之后，宿主自己的排版是正常的（换行、卡片、输入框都没问题）；
//   · 之前那一堆 `overflow-wrap:anywhere` / `min-width:0` / `max-width:100%` 规则
//     反而把 composer 挤成 43px 的竖条、把英文拆成一字一行 —— 实测（关掉整组 CSS 即恢复正常）。
// 保留常量与注入点，方便将来某个具体控件真出问题时**单条**加回来，而不是整组。
// 窄列下**只**处理输入区那一行的按钮尺寸：宿主按钮是固定尺寸，列一窄就换行占两行高。
// 注意作用域挂 frame（composer 在会话根之外，`[data-mp-narrow-chat]` 盖不到它）。
const NARROW_CHAT_CSS = [
  // Only adapt the native input card. Composer dock slots belong to other
  // plugins (including balance-dsh), whose buttons must retain their sizing.
  '[data-mp-narrow-frame] [data-composer-card] > [class*="_row"]{flex-wrap:wrap;gap:4px;min-width:0}',
  '[data-mp-narrow-frame] [data-composer-card] > [class*="_row"] > *{min-width:0;max-width:100%}',
  '[data-mp-narrow-frame] [data-composer-card] > [class*="_row"] > [class*="_tools"]{flex-wrap:nowrap;gap:4px}',
  // Keep model/language/send together; wrapping this native group creates a
  // four-storey input card at the 220px chat minimum. Do not size slot buttons.
  '@container (max-width:320px){[data-mp-narrow-frame] [data-composer-card] > [class*="_row"] > [class*="_trailing"]{flex:1 0 100%;width:100%;max-width:100%;flex-wrap:nowrap;gap:4px;margin-left:0}[data-mp-narrow-frame] [data-composer-card] > [class*="_row"] > [class*="_trailing"] > [class*="_standardControls"]{flex:1 1 auto;min-width:0;gap:4px}}',
  // F10：最窄列时正文会溢出到输入框/底部状态条下面（实测"the turn was closed"压住 3/7/2%）。
  // 给滚动区留出底部安全区；只在我们挤压期间生效。
  // 对话列内容顶部留白偏多（用户自检反馈）：列容器与内容顶部的 padding 都收到 0/8。
  '[data-mp-squeezed] [class*="_column"]{padding-top:0 !important}',
  // 挤压时对话列的滚动条偏粗、贴着列边像一条灰杠（用户自检反馈）——统一收细、圆角、留 4px。
  '[data-mp-squeezed] [class*="_scroll"]{scrollbar-width:thin !important;padding-top:8px !important;padding-right:4px !important}',
  '[data-mp-squeezed] [class*="_scroll"]::-webkit-scrollbar{width:6px !important}',
  '[data-mp-squeezed] [class*="_scroll"]::-webkit-scrollbar-thumb{border-radius:3px !important;background:color-mix(in srgb,currentColor 22%,transparent) !important}',
  '[data-mp-squeezed] [class*="_scroll"]::-webkit-scrollbar-track{background:transparent !important}',
  // F7：宿主表格单元格默认按字符断行（Bellm/an、Bana/ch），英文应该按词断。
  '[data-mp-narrow-frame] table,[data-mp-narrow-frame] th,[data-mp-narrow-frame] td{word-break:normal !important;overflow-wrap:break-word !important}',
  // ── 输入框位置（用户反馈"太高、位置奇怪"）──────────────────────────────
  // 挤压时宿主输入区会保持原始最大宽并贴右，导致它比对话内容宽、还悬在半空。
  // 这里让它跟对话内容同宽、水平居中、贴住底部。
  '[data-mp-squeezed] [data-composer-card]{min-width:0;box-sizing:border-box}',
  // 文档工作台左上那两个小按钮（展开/收起文件列表、关闭工作台）在收起态浮在正文上，
  // 看起来像"野字符"。给它们加底 + hover 提亮，视觉上成为一个控件而不是散字。
  '[data-mp-workbench] [data-mp-rail-action]{background:transparent !important;border-color:transparent !important;border-radius:8px !important;transition:background .12s ease,color .12s ease,border-color .12s ease}',
  '[data-mp-workbench] [data-mp-rail-action]:hover{background:color-mix(in srgb,currentColor 10%,transparent) !important;border-color:color-mix(in srgb,currentColor 20%,transparent) !important}',
  '[data-mp-workbench] [data-mp-rail-action]:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4f8ef7);outline-offset:1px;background:color-mix(in srgb,currentColor 10%,transparent) !important}',
  // ── 表头：只压缩高度，**不合并行** ────────────────────────────────────
  // 试过把标题行与标签行并成一行（横向 flex）：标题 "Test Rely OK" 直接被挤没了（实测截图），
  // 所以改成保守做法——两行都保留，只把行高/间距压紧，省下 8~10px。
  // 会话头：**不做并一行**。试过两次（flex 横排 + ellipsis），都会把宿主的标题块压成 0 宽、
  // 标题 "Test Rely OK" 直接消失 —— 这是宿主结构决定的，只能保守压缩高度。
  '[data-mp-squeezed] [data-phase] > :first-child{padding-top:0 !important;padding-bottom:0 !important;min-height:0 !important}',
  '[data-mp-squeezed] [data-phase] > :first-child > *{min-height:0 !important}',
  '[data-mp-squeezed] [data-phase] > :first-child > *{min-height:0 !important}',
].join("\n");

/** 对话列被挤窄时的排版修正（外壳层 CSS；改完可整条删掉，不影响宿主）。 */
/** 舞台右边缘的拖拽热区：用伪元素，避免额外 DOM 与层叠问题（只影响 cursor 与命中区）。 */
function ensureStageHandleStyle(doc) {
  if (!doc || typeof doc.createElement !== "function") return;
  try {
    if (doc.getElementById("mp-stage-handle-style")) return;
    const st = doc.createElement("style");
    st.id = "mp-stage-handle-style";
    st.textContent = "#mp-stage::after{content:\"\";position:absolute;right:0;top:0;width:16px;height:100%;cursor:col-resize;z-index:2147483000;background:transparent}";
    (doc.head || doc.documentElement).appendChild(st);
  } catch (e) { /* 注入失败就只靠 18px 命中区 */ }
}

function ensureNarrowChatStyle(doc) {
  if (!doc || typeof doc.createElement !== "function") return;
  try {
    if (doc.getElementById("mp-narrow-chat-style")) return;
    const st = doc.createElement("style");
    st.id = "mp-narrow-chat-style";
    st.textContent = (typeof NARROW_CHAT_CSS === "string" ? NARROW_CHAT_CSS : "");
    (doc.head || doc.documentElement).appendChild(st);
  } catch (e) { /* 注入失败就退化为宿主原始排版 */ }
}

function waitForConversationRoot(engine, options) {
  var opts = options || {};
  var doc = opts.doc || (typeof document !== "undefined" ? document : null);
  var win = opts.win || (typeof window !== "undefined" ? window : null);
  var MO = opts.MutationObserver || (win && win.MutationObserver) || null;
  var limitMs = typeof opts.limitMs === "number" ? opts.limitMs : 300000;
  if (!doc || !doc.body || !MO) return null;

  var stopped = false;
  var timer = null;
  var observer = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (observer && observer.disconnect) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } }
    observer = null;
    if (timer != null) { try { (win && win.clearTimeout ? win.clearTimeout(timer) : clearTimeout(timer)); } catch (e) { /* 忽略 */ } }
    timer = null;
  }

  function tryActivate() {
    if (stopped) return true;
    if (!findConversationRoot(doc)) return false;
    stop();
    if (engine.apply()) engine.observe();
    return true;
  }

  try {
    observer = new MO(function () { tryActivate(); });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-phase"] });
  } catch (e) {
    return null;
  }
  // 单次超时兜底：等太久就放弃，避免常驻观察器
  try {
    var schedule = (win && win.setTimeout) ? win.setTimeout.bind(win) : setTimeout;
    timer = schedule(function () { stop(); }, limitMs);
    // 不吊住进程/事件循环：浏览器无副作用，Node 下避免测试与宿主退出被阻塞
    try { if (timer && typeof timer.unref === "function") timer.unref(); } catch (e) { /* 忽略 */ }
  } catch (e) { timer = null; }

  // 挂上观察器后立刻再试一次，防止根在两步之间出现
  tryActivate();
  return { stop: stop };
}


/**
 * M1：把编辑区变大 —— 走宿主公开 API（ctx.layout），不搬 iframe、不重载。
 *
 *   mode = "focus" → openRightbar(false, true)：右侧栏面板按 100vw 呈现，覆盖整窗
 *   mode = "dock"  → openRightbar(true,  false)：给右侧栏一条真实轨道，按原宽度展开
 *
 * ⚠ 2026-11-04 在 0.2.1-rc.5 隔离实例上的实测结论（重要）：
 *   1. 插件默认 inject = ["slots"]，此时 ctx.get("layout") 返回 undefined、
 *      ctx.inject(["layout"]) 的回调也不触发 —— 该服务不在插件可见服务域内。
 *      把 "layout" 加进 inject 后，服务可达、openRightbar 调用返回成功（hostApplied=true）。
 *   2. **但面板并不会进入 fullscreen**：实测 panel 宽度仍为 706px、
 *      [data-rightbar-fullscreen] 未出现 —— 右侧栏组件会重新断言自己的状态，
 *      把外部对 openRightbar 的设置冲掉。
 *   ⇒ 结论：靠 openRightbar 把编辑区放大**不可靠**，不能作为 M1 的实现路径。
 *      M1 应改为把编辑器 iframe 挂到 shell.overlay（跨 React 子树，一次性重载）。
 *   本函数保留，供将来宿主支持或排查用；默认不启用（需要同时把 "layout" 加进 inject）。
 *
 * 实测前提：右侧栏**关闭时面板完全不挂载**（[data-rightbar-col] 宽 0、
 * 子节点全是 display:contents、--dsh-sidebar-width 为空），所以不存在
 * "把已有面板挪到中间"的可行路径；必须先让它有轨道或全屏。
 *
 * 边界：只调用公开 API，不改宿主 layoutInfo 的内部字段；退出时不强行关闭
 * 用户可能本来就开着的右侧栏（宁可留着，也不误关）。
 */
function applyHostMode(ctx, mode, onApplied, isActive) {
  if (mode !== "focus" && mode !== "dock") return false;
  var done = false;
  var call = function (layout) {
    try {
      if (typeof isActive === "function" && !isActive()) return;
      if (!layout || typeof layout.openRightbar !== "function") return;
      if (mode === "focus") layout.openRightbar(false, true);
      else layout.openRightbar(true, false);
      done = true;
      if (typeof onApplied === "function") { try { onApplied(true); } catch (e) { /* 忽略 */ } }
    } catch (e) { /* 宿主拒绝时保持原状 */ }
  };
  try {
    // 优先 ctx.inject：layout 服务可能在插件加载之后才就绪（实测：用 ctx.get 拿不到）
    if (ctx && typeof ctx.inject === "function") {
      ctx.inject(["layout"], function (c) { call(c && c.layout); });
      if (!done && ctx && typeof ctx.get === "function") call(ctx.get("layout"));
      return done;
    }
    if (ctx && typeof ctx.get === "function") { call(ctx.get("layout")); return done; }
  } catch (e) { /* 落到 false */ }
  return false;
}

/** apply() 开头调用：只有用户在配置里显式打开才会真的启动。 */
function mountLayout(ctx, overrides) {
  try {
    var ov = overrides || {};
    var doc = ov.doc || (typeof document !== "undefined" ? document : null);
    var win = ov.win || (typeof window !== "undefined" ? window : null);
    if (win && typeof win.__mpLayoutDispose === "function") win.__mpLayoutDispose();
    var storage = ov.storage;
    if (storage === undefined) {
      try { storage = (win && win.localStorage) || null; } catch (e) { storage = null; }
    }
    var cfg = readLayoutConfig(storage);
    if (!cfg.enabled) return null;
    ensureLayoutStyle(doc);

    // M1：focus / dock 由宿主 API 负责放大编辑区，不做文字挤压
    if (cfg.mode === "focus" || cfg.mode === "dock") {
      var hostDisposed = false;
      var hostOk = false;
      var hostEngine = {
        mode: cfg.mode,
        hostApplied: false,
        apply: function () { return hostOk; },
        restore: function () { /* 不强行关闭用户的右侧栏 */ },
        observe: function () { /* 无挤压即无需观察 */ },
        checkYield: function () { return false; },
        snapshot: function () { return { mode: cfg.mode, hostApplied: hostOk, active: !hostDisposed && hostOk, writes: 0, applies: 0, negativeMargins: 0, yields: 0, chatW: 0, marginLeft: "", marginRight: "", hasRoot: false, hasBody: false }; },
      };
      hostEngine.apply = function () {
        if (hostDisposed) return false;
        hostOk = applyHostMode(ctx, cfg.mode, function () { if (!hostDisposed) { hostOk = true; hostEngine.hostApplied = true; } }, function () { return !hostDisposed; });
        return hostOk;
      };
      var hostOkNow = hostEngine.apply();
      try {
        var svcDiag = null;
        try {
          var byGet = (typeof ctx.get === "function") ? ctx.get("layout") : undefined;
          svcDiag = { byGet: !!byGet, openRightbar: !!(byGet && typeof byGet.openRightbar === "function") };
        } catch (e) { svcDiag = { error: String(e && e.message ? e.message : e) }; }
        window.__MP_LAYOUT_DEBUG = {
          enabled: cfg.enabled, mode: cfg.mode, hostOkNow: hostOkNow,
          hostApplied: hostEngine.hostApplied, svc: svcDiag,
          hasInject: typeof ctx.inject === "function",
          injectArr: Array.isArray(inject) ? inject.slice() : null,
        };
      } catch (e) { /* 忽略 */ }
      function teardownHostLayout() {
        if (hostDisposed) return;
        hostDisposed = true;
        if (win && win.__mpLayoutDispose !== teardownHostLayout) return;
        try { dropLayoutStyle(doc); } catch (e) { /* 忽略 */ }
        if (win) delete win.__mpLayoutDispose;
      }
      if (win) win.__mpLayoutDispose = teardownHostLayout;
      try {
        if (ctx && typeof ctx.effect === "function") ctx.effect(function () { return teardownHostLayout; }, "dsh-markdown-typora: layout restore");
      } catch (e) { /* 忽略 */ }
      return hostEngine;
    }
    var engine = createLayoutEngine({
      doc: doc,
      win: win,
      cfg: cfg,
      ResizeObserver: ov.ResizeObserver || (win && win.ResizeObserver) || null,
      MutationObserver: ov.MutationObserver || (win && win.MutationObserver) || null,
    });

      var layoutDisposed = false;
      var stopPanelWatch = null;
      var onLayoutResize = function () {
        if (!layoutDisposed) engine.requestApply();
      };

      try {
        if (win && typeof win.addEventListener === "function") {
          // 窄窗右栏保护：**加载时也要跑一次**（只在 resize 里跑的话，窄窗直接打开页面时
          // 右栏仍在屏幕外 —— 实测 x=2855 而窗口右边界 1679）。
          win.addEventListener("resize", onLayoutResize);
        }
      } catch (e) { /* 忽略 */ }

      // ── 宽度看门：只在文档模式开启时运行 ────────────────────────────
      // 实测教训：右栏开合会改网格列宽，但会话根的 ResizeObserver 并不总能接到这次变化
      // （根可能被重挂载 / 观察器在 restore 后断开）。所以这里用一个极轻的看门：
      // 每 250ms 只读一次会话根宽度，变了才重算；文档模式关闭时立刻停掉，不做无谓轮询。
      try {
        var watchLastW = -1;
        var watchTimer = setInterval(function () {
          try {
            if (layoutDisposed) return;
            var on = (typeof docsModeOn !== "undefined" && docsModeOn === true)
              || (typeof overlayDoc !== "undefined" && !!overlayDoc);
            if (!on) { watchLastW = -1; return; }
            var r = findConversationRoot(doc);
            var w = r ? Math.round(r.getBoundingClientRect().width) : -1;
            if (w !== watchLastW) {
              watchLastW = w;
              engine.requestApply();
            }
          } catch (e) { /* 忽略 */ }
        }, 250);
      } catch (e) { /* 忽略 */ }

      // 订阅宿主 layout 面板状态：右栏开合/面板切换都会改列宽 → 立刻重算
      try {
        var laySvc = ctx && typeof ctx.get === "function" ? ctx.get("layout") : null;
        if (laySvc && laySvc.panelInfo && typeof laySvc.panelInfo.subscribe === "function") {
          stopPanelWatch = laySvc.panelInfo.subscribe(function () {
            try { if (!layoutDisposed) engine.requestApply(); } catch (e) { /* 忽略 */ }
          });
        }
      } catch (e) { /* 忽略 */ }

      var reapply = function () {
        if (layoutDisposed) return;
        // 主区域切换会把会话根重新挂载：不仅要重算，还要把观察器重新挂上，
        // 否则后续变化（拖拽、窗口 resize）都不再触发，挤压会"卡死"在旧值上。
        try { engine.flush(); } catch (e) { /* 忽略 */ }
      };
      reapply.schedule = engine.requestApply;
      layoutReapply = reapply;

      /* 诊断：只在 DevTools 里按需调用 window.__mpSnapshot()，返回一份只读快照。
       * 验收阶段那套「页面读数 + 1.2s 定时器 + POST 上报」已全部移除：
       * 交付版零 DOM、零定时器、零网络请求。 */
      function rectOf(el) {
        try {
          if (!el || typeof el.getBoundingClientRect !== "function") return null;
          var r = el.getBoundingClientRect();
          return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        } catch (e) { return null; }
      }
      engine.__snapshot = function () {
        try {
          var rootEl = findConversationRoot(doc);
          var anchorEl = rootEl ? resolveAnchor(rootEl) : null;
          var stageEl = null;
          try { stageEl = doc.getElementById("mp-stage"); } catch (e) { stageEl = null; }
          var snap = (engine && engine.snapshot) ? engine.snapshot() : null;
          return {
            docsModeOn: (typeof docsModeOn !== "undefined") ? (docsModeOn === true) : null,
            hasOverlayDoc: (typeof overlayDoc !== "undefined") ? !!overlayDoc : null,
            root: rectOf(rootEl),
            viewArea: anchorEl ? rectOf(anchorEl.viewArea) : null,
            bodyMarginLeft: (anchorEl && anchorEl.viewArea) ? anchorEl.viewArea.style.marginLeft : null,
            stage: rectOf(stageEl),
            engineActive: snap ? snap.active : null,
            engineReason: snap ? snap.reason : null,
            chatW: snap ? snap.chatW : null,
            sidebarW: handleState.sb || null,
            rightbarW: handleState.rb || null,
          };
        } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
      };
      try { window.__mpSnapshot = engine.__snapshot; } catch (e) { /* 忽略 */ }
      handleState.engine = engine;   // 侧栏手柄/中间手柄共用同一个引擎实例
      var waiter = null;
    if (engine.apply()) {
      engine.observe();
    } else {
      // 根还没出现：等它出现再激活
      waiter = waitForConversationRoot(engine, { doc: doc, win: win, MutationObserver: ov.MutationObserver, limitMs: ov.limitMs });
    }

    function teardown() {
      if (layoutDisposed) return;
      layoutDisposed = true;
      try { if (waiter && waiter.stop) waiter.stop(); } catch (e) { /* 忽略 */ }
      clearInterval(watchTimer);
      try { if (win && win.removeEventListener) win.removeEventListener("resize", onLayoutResize); } catch (e) { /* 忽略 */ }
      try {
        if (typeof stopPanelWatch === "function") stopPanelWatch();
        else if (stopPanelWatch && typeof stopPanelWatch.unsubscribe === "function") stopPanelWatch.unsubscribe();
      } catch (e) { /* 忽略 */ }
      stopPanelWatch = null;
      try { engine.dispose(); } catch (e) { /* 忽略 */ }
      try { dropLayoutStyle(doc); } catch (e) { /* 忽略 */ }
      if (layoutReapply === reapply) layoutReapply = null;
      if (handleState.engine === engine) handleState.engine = null;
      try {
        if (win && win.__mpLayoutDispose === teardown) delete win.__mpLayoutDispose;
        if (win && win.__mpSnapshot === engine.__snapshot) delete win.__mpSnapshot;
      } catch (e) { /* 忽略 */ }
    }
    if (win) win.__mpLayoutDispose = teardown;
    try {
      if (ctx && typeof ctx.effect === "function") ctx.effect(function () { return teardown; }, "dsh-markdown-typora: layout restore");
    } catch (e) { /* 无 effect 能力时退化为不自动还原 */ }
    engine.__waiter = waiter;
    return engine;
  } catch (e) {
    try { console.warn("[dsh-markdown-typora] layout mount failed:", e); } catch (ignored) { /* 无 console */ }
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * P0 纯函数区（布局子系统升级 v3 · 第一阶段）
 *   · 无 DOM、无副作用、无状态，全部可单测
 *   · 本阶段只新增，不改变任何现有行为（旧路径仍在用）
 *   · 对应方案 §1.1（模型/不变量）、§1.3（解析文法）、§1.5（colW 推导）
 * ═══════════════════════════════════════════════════════════════════════════ */
const PURE_MIN_CHAT = 220;        // 对话列最窄（与 LAYOUT_MIN_CHAT 同步：<300 宿主内部会塌）
const PURE_DEFAULT_CENTER_MIN = 400;  // 中列最窄（宿主原本的 minmax(400px, 1fr)）
const PURE_DEFAULT_EDITOR_MIN = 240;  // 编辑区最窄
const PURE_COLLAPSED_FALLBACK = 56;   // 解析不到宿主窄轨宽时的兜底
const PURE_SIDEBAR_MAX = 420;         // 宿主 setSidebar 的硬上限（源码常量）
const PURE_RIGHTBAR_MAX_RATIO = 0.7;  // 宿主 setRightbar 的视口比例上限

/** 数值钳制；非有限数退到 min。 */
function pureClamp(v, min, max) {
  var n = Number(v);
  if (!isFinite(n)) n = min;
  if (isFinite(min) && n < min) n = min;
  if (isFinite(max) && n > max) n = max;
  return n;
}

/** 折叠属性值的语义解析（与 attrOn 一致）：'false'/''/'0'/'off'/'null'/缺失 = 未折叠。 */
function parseCollapseValue(v) {
  if (v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return !(s === "" || s === "false" || s === "0" || s === "off" || s === "null");
}

/**
 * 解析宿主的内联列宽字符串（协议 B 的真值通道）。
 * 宿主文法恒为：`Spx minmax(Mpx, 1fr) minmax(0px, Rpx)`
 *   sbTrack = S，centerMin = M（宿主把中轨 min 键挂在侧栏上，仅作数据用），rbTrack = R（第三轨的 **max**）
 * 解析失败 / 轨道数 != 3 → ok:false（调用方应走 retire，不要"猜"）。
 */
function parseHostGrid(str) {
  var s = String(str == null ? "" : str).trim();
  if (!s) return { ok: false, reason: "empty" };
  var re = /^(\d+(?:\.\d+)?)px\s+minmax\(\s*(\d+(?:\.\d+)?)px\s*,\s*(?:1fr|\d+(?:\.\d+)?px)\s*\)\s+minmax\(\s*(\d+(?:\.\d+)?)px\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/i;
  var m = re.exec(s);
  if (!m) return { ok: false, reason: "grammar" };
  var sbTrack = parseFloat(m[1]);
  var centerMin = parseFloat(m[2]);
  var rbMin = parseFloat(m[3]);
  var rbTrack = parseFloat(m[4]);
  if (!isFinite(sbTrack) || !isFinite(centerMin) || !isFinite(rbTrack)) return { ok: false, reason: "nan" };
  return {
    ok: true,
    sbTrack: sbTrack,
    centerMin: centerMin,
    rbMin: isFinite(rbMin) ? rbMin : 0,
    rbTrack: rbTrack,
    // 右栏开合**只看第三轨 max**：宿主模板的中轨 min 键在侧栏上（`S>0?400:0`），
    // 不能拿来判断右栏（桌面折叠 S=0 时它也会是 0，会误判成"右栏关"）。
    rightbarOpen: rbTrack > 0,
    // 窄轨：web=56、Windows 桌面构建=0，两者都 < 120；展开下限 264、自拖下限 180 都 > 120。
    collapsedSidebar: sbTrack < 120,
  };
}

/** 中列宽 = 视口 − 两条固定轨（推导，绝不采样）。 */
function deriveColW(viewportW, sbTrack, rbTrack) {
  var vw = Number(viewportW);
  var sb = Math.max(0, Number(sbTrack) || 0);
  var rb = Math.max(0, Number(rbTrack) || 0);
  if (!isFinite(vw) || vw <= 0) return 0;
  return Math.max(0, Math.round(vw - sb - rb));
}

/**
 * 对话挤压几何：把 chatW 钳进 [MIN_CHAT, colW - editorMin]，并按 side 给出 margin。
 * 不产负 margin；放不下时给出 reason 让调用方放弃挤压（并收起舞台）。
 */
function computeChatMargins(input) {
  var src = input || {};
  var colW = Math.round(Number(src.colW) || 0);
  var want = Number(src.chatW);
  var side = src.side === "right" ? "right" : "left";
  var minEditor = isFinite(src.editorMin) ? Number(src.editorMin) : PURE_DEFAULT_EDITOR_MIN;
  var minChat = isFinite(src.minChat) ? Number(src.minChat) : PURE_MIN_CHAT;
  if (colW <= 0) return { ok: false, reason: "no-col", colW: 0, chatW: 0, gap: 0, marginLeft: "", marginRight: "" };
  var maxChat = Math.round(colW - minEditor);
  if (maxChat < minChat) {
    return { ok: false, reason: "too-narrow", colW: colW, chatW: 0, gap: 0, marginLeft: "", marginRight: "" };
  }
  var w = Math.round(pureClamp(want, minChat, maxChat));
  var gap = Math.max(0, colW - w);
  return {
    ok: true,
    reason: "ok",
    colW: colW,
    chatW: w,
    gap: gap,
    marginLeft: side === "left" ? gap + "px" : "",
    marginRight: side === "left" ? "" : gap + "px",
  };
}

/**
 * 模型钳制（不变量 I1 / I2 / I6）。
 * caps: { viewportW, sidebarMax?, rightbarMax?, collapsedSidebarW?, editorMin? }
 *
 * **返回值契约**：
 *   · `pinnable === true` 才允许直接 apply（写 pin/变量/热区）。
 *   · `pinnable === false`（reasons 含 `still-tight`）⇒ 必须走与 too-narrow 相同的降级：
 *     retire / 收起舞台 / 还原 margin / **不写网格变量**；可选产品动作是主动折叠右栏后重算。
 *   · 除 I6 的削列外，`chat.w` 也会被钳进 [min, max]（I5：任何写入都必须过 clamp）。
 */
function clampModel(model, caps) {
  var src = model || {};
  var c = caps || {};
  var reasons = [];
  var vw = Math.max(0, Math.round(Number(c.viewportW) || 0));
  var sidebar = src.sidebar || {};
  var rightbar = src.rightbar || {};
  var chat = src.chat || {};
  var chatMin = isFinite(chat.min) ? Number(chat.min) : PURE_MIN_CHAT;
  var chatMax = isFinite(chat.max) ? Number(chat.max) : 900;
  var editorMin = isFinite(c.editorMin) ? Number(c.editorMin) : PURE_DEFAULT_EDITOR_MIN;

  // I1：上限不来自几何采样 —— 优先宿主 store 常量；模型自带的 max（来自设置）只能更严
  var sbModelMax = isFinite(sidebar.max) ? Number(sidebar.max) : PURE_SIDEBAR_MAX;
  var sbCap = isFinite(c.sidebarMax) ? Number(c.sidebarMax) : PURE_SIDEBAR_MAX;
  var sbMax = pureClamp(Math.min(sbModelMax, sbCap), 0, PURE_SIDEBAR_MAX);
  var rbMaxCap = vw > 0 ? Math.round(vw * PURE_RIGHTBAR_MAX_RATIO) : 0;
  var rbModelMax = isFinite(rightbar.max) ? Number(rightbar.max) : rbMaxCap;
  var rbCap = isFinite(c.rightbarMax) ? Number(c.rightbarMax) : rbMaxCap;
  var rbMax = Math.max(0, Math.min(rbModelMax, rbCap, rbMaxCap || rbModelMax));

  var sbW = pureClamp(sidebar.w, sidebar.min, sbMax);
  var rbW = pureClamp(rightbar.w, rightbar.min, rbMax);
  if (sbW !== sidebar.w) reasons.push("sidebar-clamped");
  if (rbW !== rightbar.w) reasons.push("rightbar-clamped");

  // I5：chat.w 也必须过 clamp（以前这里是原样透传，5000 会直接穿透）
  var chatW = Math.round(pureClamp(chat.w, chatMin, chatMax));
  if (chatW !== Math.round(Number(chat.w) || 0)) reasons.push("chat-clamped");

  // I2：折叠列取宿主窄轨宽（不是"不写"，而是写窄轨值）
  var collapsedW = isFinite(c.collapsedSidebarW) && c.collapsedSidebarW >= 0
    ? Math.round(c.collapsedSidebarW)
    : PURE_COLLAPSED_FALLBACK;
  if (sidebar.collapsed) { sbW = collapsedW; reasons.push("sidebar-collapsed"); }
  if (rightbar.collapsed) { rbW = 0; reasons.push("rightbar-collapsed"); }

  // I6：sb + rb + 中列底线 <= 视口。中列底线取 max(chat.min + editor.min, CENTER_MIN)，
  // 与 pin 样式里 --mp-center-min 的 400px 下限对齐，避免"钳完仍然横向溢出"。
  var midFloor = Math.max(chatMin + editorMin, PURE_DEFAULT_CENTER_MIN);
  var need = Math.round(sbW) + Math.round(rbW) + midFloor;
  if (vw > 0 && need > vw) {
    var overflow = need - vw;
    reasons.push("viewport-tight");
    var cut = Math.min(overflow, Math.max(0, rbW - (rightbar.min || 0)));
    rbW -= cut; overflow -= cut;
    if (overflow > 0) {
      cut = Math.min(overflow, Math.max(0, sbW - (sidebar.min || 0)));
      sbW -= cut; overflow -= cut;
    }
    if (overflow > 0) reasons.push("still-tight");
  }

  return {
    // pinnable：唯一"能否直接 apply"的硬门（P1/P3 必须读它，不能只看 reasons 是否为空）
    pinnable: reasons.indexOf("still-tight") < 0,
    model: {
      viewport: { w: vw, h: Math.max(0, Math.round(Number((src.viewport || {}).h) || 0)) },
      sidebar: { w: Math.round(sbW), min: sidebar.min, max: sbMax, collapsed: !!sidebar.collapsed, userW: normUserW(sidebar.userW) },
      rightbar: { w: Math.round(rbW), min: rightbar.min, max: rbMax, collapsed: !!rightbar.collapsed, userW: normUserW(rightbar.userW) },
      chat: { w: chatW, min: chatMin, max: chatMax, side: chat.side === "right" ? "right" : "left" },
      docs: normDocs(src.docs),
      phase: src.phase === "dragging" ? "dragging" : "idle",
    },
    reasons: reasons,
  };
}

/** userW 归一：只有"用户真的拖过"才保留数字（字符串/NaN 一律 null）。 */
function normUserW(v) {
  if (v === null || v === undefined) return null;
  var n = Number(v);
  // 负宽/0 不是"用户拖过的宽度"：真实拖动必然被 min 钳过，产出不了非正数。
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** docs 归一（深拷，避免与入参共享引用）。 */
function normDocs(d) {
  if (!d || typeof d !== "object") return { open: false, listW: 268 };
  var w = Number(d.listW);
  return { open: d.open === true, listW: (isFinite(w) && w > 0) ? Math.round(w) : 268 };
}

const __test = {
      createDraftStore,
      constants: {
        TAB_TYPE_ID: TAB_TYPE_ID,
        FILE_ADDRESS_PREFIX: FILE_ADDRESS_PREFIX,
        RECOVERY_PREFIX: RECOVERY_PREFIX,
        SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS,
        PULL_TIMEOUT_MS: PULL_TIMEOUT_MS,
        FLUSH_WAIT_MS: FLUSH_WAIT_MS,
      },
      layout: {
    // P0 纯函数区（升级 v3）：无 DOM、无副作用，供单测与后续 P1+ 复用
    pure: {
      clamp: pureClamp,
      parseCollapseValue: parseCollapseValue,
      parseHostGrid: parseHostGrid,
      deriveColW: deriveColW,
      computeChatMargins: computeChatMargins,
      clampModel: clampModel,
      constants: {
        MIN_CHAT: PURE_MIN_CHAT,
        CENTER_MIN: PURE_DEFAULT_CENTER_MIN,
        EDITOR_MIN: PURE_DEFAULT_EDITOR_MIN,
        COLLAPSED_FALLBACK: PURE_COLLAPSED_FALLBACK,
        SIDEBAR_MAX: PURE_SIDEBAR_MAX,
        RIGHTBAR_MAX_RATIO: PURE_RIGHTBAR_MAX_RATIO,
      },
    },
    readLayoutConfig: readLayoutConfig,
    saveLayoutConfig: saveLayoutConfig,
    findConversationRoot: findConversationRoot,
    findConversationBody: findConversationBody,
    computeLayout: computeLayout,
    writeStyle: writeStyle,
    createLayoutEngine: createLayoutEngine,
    mountLayout: mountLayout,
    waitForConversationRoot: waitForConversationRoot,
    applyHostMode: applyHostMode,
    layoutEnabled: layoutEnabled,
    readSettings: readSettings,
    setSqueezeForTests: function (v) { squeezeForTests = v === true ? true : null; },
    absoluteFileAddress: absoluteFileAddress,
    writeSettings: writeSettings,
    publishOverlayDoc: publishOverlayDoc,
    unpublishOverlayDoc: unpublishOverlayDoc,
    clearOverlayDoc: clearOverlayDoc,
    docKeyOf: docKeyOf,
    getOverlayDoc: function () { return overlayDoc; },
    modes: LAYOUT_MODES,
    defaults: LAYOUT_DEFAULTS,
    storageKey: LAYOUT_STORAGE_KEY,
    widthVar: LAYOUT_WIDTH_VAR,
  },
  parseFileAddress: parseFileAddress,
      basenameOf: basenameOf,
      directoryOf: directoryOf,
      absolutePath: absolutePath,
      encodeFileAddress: encodeFileAddress,
      normalizePathKey: normalizePathKey,
      samePath: samePath,
      recoveryKey: recoveryKey,
      readRecoverySlot: readRecoverySlot,
      writeRecoverySlot: writeRecoverySlot,
      clearRecoverySlot: clearRecoverySlot,
      ticketOf: ticketOf,
      isCurrentTicket: isCurrentTicket,
      saveGate: saveGate,
      manualSaveGate: manualSaveGate,
      buildSaveRequest: buildSaveRequest,
      applyLiveReceipt: applyLiveReceipt,
      liveErrorAction: liveErrorAction,
      liveStaleAction: liveStaleAction,
      liveRecoveredItems: liveRecoveredItems,
      nextPollDelay: nextPollDelay,
      shouldAcceptExternal: shouldAcceptExternal,
      insertSelectionToChat: insertSelectionToChat,
      composeInsertionText: composeInsertionText,
      buildTabDefinition: buildTabDefinition,
      isDarkTheme: isDarkTheme,
      isUpEnvelope: isUpEnvelope,
    };

    /* ───────────────────────── 宿主能力（iframe host-invoke） ───────────────────────── */

    function clipboardOf() {
      try { return typeof navigator !== "undefined" ? navigator.clipboard : null; } catch (e) { return null; }
    }

    function handleHostInvoke(content, post) {
      const id = content && content.id;
      const done = (result) => post("host-result", { id: id, result: result });
      const fail = (error) => post("host-result", { id: id, error: String(error && error.message ? error.message : error) });
      try {
        const cmd = content && content.cmd;
        const args = (content && content.args) || {};
        if (cmd === "clipboard-write-text") {
          const clipboard = clipboardOf();
          if (!clipboard || typeof clipboard.writeText !== "function") { fail(new Error("clipboard unavailable")); return; }
          clipboard.writeText(String(args.text == null ? "" : args.text)).then(done, fail);
        } else if (cmd === "clipboard-read-text") {
          const clipboard = clipboardOf();
          if (!clipboard || typeof clipboard.readText !== "function") { fail(new Error("clipboard unavailable")); return; }
          clipboard.readText().then(done, fail);
        } else if (cmd === "open-external") {
          try { window.open(String(args.url == null ? "" : args.url), "_blank", "noopener"); } catch (e) { /* 拦截器拒绝 */ }
          done(true);
        } else {
          done(null);
        }
      } catch (error) {
        fail(error);
      }
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    const bannerStyle = (warn) => ({
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: "2px 10px", fontSize: 12, flex: "0 0 auto",
      background: warn ? "color-mix(in srgb, currentColor 10%, transparent)" : "color-mix(in srgb, currentColor 5%, transparent)",
      borderBottom: "1px solid color-mix(in srgb, currentColor " + (warn ? 25 : 14) + "%, transparent)",
    });
    /**
     * 轻提示（"已发送给 AI" 这类）：**悬浮**在内容之上，**不占布局高度**。
     * 之前它是一整行 flex 子元素，把 Chat/Trajectory 下面顶出一条横栏，太挤（用户实测）。
     * 定位靠父容器的 position:relative；4 秒后自动消失（见 showNotice 里的定时器）。
     */
    const toastStyle = {
      position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)",
      zIndex: 30, padding: "3px 12px", borderRadius: 999, fontSize: 12,
      background: "color-mix(in srgb, currentColor 14%, transparent)",
      border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
      backdropFilter: "blur(6px)", pointerEvents: "none", maxWidth: "90%",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    };
    const btnStyle = {
      fontSize: 12, padding: "1px 8px", border: "1px solid rgba(127,127,127,0.4)",
      borderRadius: 4, background: "transparent", cursor: "pointer",
    };
    const emptyStyle = { padding: 12, fontSize: 12, opacity: 0.7 };

    /* ───────────────────────── tab body ───────────────────────── */

    /* ── M1：浮层承载（worktable 架构）──────────────────────────────────
     * 以前 iframe 挂在右侧栏 tab 里：位置由 tab 决定、文档地址也来自 tab，
     * 想挪到中间就必须跨 React 子树搬 iframe ⇒ 一次重载。
     * 现在改为：tab body 只「接住 .md 并公布当前文档」，编辑器**只在 shell.overlay
     * 挂载一次** —— 从头到尾只有一个挂载点，没有「搬家」这个动作，也就没有重载。
     *
     * 安全阀：仅当布局开关打开（localStorage enabled=true）时走浮层；
     * 否则完全保持旧行为（iframe 仍渲染在 tab 里），对现有用户零影响。
     */
    /* 文档表：key → { tab, sessionId, inputActions, visible, seq }
     * 为什么不是一个 overlayDoc：多个 md tab 同时存在时，任何一个 tab 卸载都会把
     * 另一个 tab 的编辑区一起清掉（"编辑区突然消失"的坑）。改成按 tab 记录、
     * 卸载只回收自己那一条，再重算活跃文档。 */
    var overlayDocs = new Map();
    var overlayDocSeq = 0;
    var overlayDoc = null;
    var overlayDocListeners = new Set();
    var layoutReapply = null;   // 由 mountLayout 注入；浮层挂载后立刻重算一次几何

    /* ── 会话输入面（官方 provide 通道动作面）─────────────────────────
     * DSH 0.2.1-rc.5 的槽位目录把 `inputActions` 列为**会话作用域槽位的标准 prop**，
     * 它就是宿主 conversation 包自己发布的那一份：
     *   { captureInsertion, insertText, setDraft, persistDraft, addAttachments, submit, … }
     * 注释原文：「The public provide-channel action face (one stable identity per session)」。
     * 所以浮层/侧栏都能拿到它，不必依赖右侧栏 tab、也不必去猜 composer 的 DOM。
     *
     * 做法：在 conversation.composer（chain 槽位，会话一显示就存在）里挂一个
     * 只负责“收下这份动作面”的零像素组件 —— 渲染 null，无监听、无轮询、无 DOM。
     * actions 每个会话身份稳定，effect 只跑一次；卸载即摘除，不留引用。
     */
    var inputFaces = new Map();   // sessionId -> inputActions

    function InputFaceTap(props) {
      var sessionId = props && props.sessionId;
      var actions = props && props.inputActions;
      var hasEffect = React && typeof React.useEffect === "function";
      if (hasEffect) {
        React.useEffect(function () {
          if (!sessionId || !actions) return undefined;
          inputFaces.set(sessionId, actions);
          return function () {
            if (inputFaces.get(sessionId) === actions) inputFaces.delete(sessionId);
          };
        }, [sessionId, actions]);
      } else if (sessionId && actions) {
        inputFaces.set(sessionId, actions);
      }
      return null;
    }

    /** 取某个会话的输入面：先官方动作面，再退到 tab props 里记住的那份。 */
    function inputFaceOf(sessionId) {
      var face = sessionId ? inputFaces.get(sessionId) : null;
      return face || null;
    }

    function docKeyOf(tab) {
      return tab ? String(tab.id || tab.occurrenceId || "") + "|" + String(tab.contentId || "") : "";
    }

    /* 记住最后一份有效文档。
     * 为什么需要：收起右侧栏时宿主会**卸载 tab**，浮层就失去了文档身份，
     * 编辑区会凭空消失（实机复现）。所以没有可见条目时回落到这份记忆，
     * 而不是立刻清空；真正的"关闭"由舞台上的 × 调用 clearOverlayDoc()。 */
    var overlayLastDoc = null;
    var closedOverlayKeys = new Set();
    var closedOverlayOwners = new Map();
    var closedOverlaySignals = new WeakMap();

    function releaseClosedOverlayKey(key, expectedOwner) {
      var owner = closedOverlayOwners.get(key);
      if (expectedOwner && owner !== expectedOwner) return;
      closedOverlayKeys.delete(key);
      if (!owner) return;
      closedOverlayOwners.delete(key);
      owner.keys.delete(key);
      if (owner.keys.size === 0) {
        try { owner.signal.removeEventListener("abort", owner.onAbort); } catch (e) { /* 旧宿主 */ }
        closedOverlaySignals.delete(owner.signal);
      }
    }

    function clearClosedOverlayKeys() {
      for (var key of Array.from(closedOverlayKeys)) releaseClosedOverlayKey(key);
    }

    // A hidden tab may mount again. Only its occurrence's final abort retires
    // the close marker; keep legacy hosts without that signal on the old path.
    function rememberClosedOverlayTab(tab) {
      var key = docKeyOf(tab);
      if (!key) return;
      var signal = tab && tab.signal;
      var canObserve = signal && typeof signal.addEventListener === "function"
        && typeof signal.removeEventListener === "function";
      var previous = closedOverlayOwners.get(key);
      if (canObserve && signal.aborted) {
        if (!previous || previous.signal === signal) releaseClosedOverlayKey(key, previous);
        return;
      }
      if (previous && previous.signal === signal) return;
      releaseClosedOverlayKey(key);
      closedOverlayKeys.add(key);
      if (!canObserve) return;
      var owner = closedOverlaySignals.get(signal);
      var isNew = !owner;
      if (!owner) {
        owner = { signal: signal, keys: new Set(), onAbort: null };
        owner.onAbort = function () {
          for (var closedKey of Array.from(owner.keys)) releaseClosedOverlayKey(closedKey, owner);
        };
        closedOverlaySignals.set(signal, owner);
      }
      owner.keys.add(key);
      closedOverlayOwners.set(key, owner);
      if (isNew) {
        try { signal.addEventListener("abort", owner.onAbort, { once: true }); }
        catch (e) {
          closedOverlayOwners.delete(key);
          owner.keys.delete(key);
          closedOverlaySignals.delete(signal);
          return;
        }
      }
      if (signal.aborted) owner.onAbort();
    }

    /** 活跃文档 = 可见条目里 seq 最大的；都没有则回落到记忆。 */
    function recomputeOverlayDoc() {
      var best = null;
      for (var item of overlayDocs.values()) {
        if (!item.visible) continue;
        if (!best || item.seq > best.seq) best = item;
      }
      if (best) overlayLastDoc = best;
      var next = best || overlayLastDoc;
      var before = overlayDoc ? docKeyOf(overlayDoc.tab) : "";
      var after = next ? docKeyOf(next.tab) : "";
      overlayDoc = next;
      if (before !== after) {
        for (var fn of Array.from(overlayDocListeners)) { try { fn(); } catch (e) { /* 忽略 */ } }
      }
    }

    /** 用户显式关闭编辑区：连记忆一起清掉，避免关掉 tab 后留下幽灵。 */
    function clearOverlayDoc() {
      for (var item of overlayDocs.values()) rememberClosedOverlayTab(item.tab);
      if (overlayDoc && overlayDoc.tab) rememberClosedOverlayTab(overlayDoc.tab);
      overlayDocs.clear();
      overlayLastDoc = null;
      recomputeOverlayDoc();
    }

    function layoutEnabled() {
      try {
        var raw = window.localStorage ? window.localStorage.getItem("dsh.markpilot.layout.v1") : null;
        if (!raw) return false;
        return JSON.parse(raw).enabled === true;
      } catch (e) { return false; }
    }

    function publishOverlayDoc(next) {
      if (!next || !next.tab) return;
      var signal = next.tab.signal;
      if (signal && signal.aborted) return;
      var key = docKeyOf(next.tab);
      if (!key) return;
      var closedOwner = closedOverlayOwners.get(key);
      if (closedOwner && signal && signal !== closedOwner.signal
        && typeof signal.addEventListener === "function" && typeof signal.removeEventListener === "function") {
        releaseClosedOverlayKey(key, closedOwner);
      }
      if (next.explicit === true) releaseClosedOverlayKey(key);
      if (closedOverlayKeys.has(key)) return;
      overlayDocs.set(key, {
        tab: next.tab,
        sessionId: next.sessionId,
        inputActions: next.inputActions,
        visible: next.tab.visible !== false,
        seq: ++overlayDocSeq,
      });
      recomputeOverlayDoc();
      if(next.explicit === true && next.tab.visible !== false && docsModeOn)void activateNativeOverlay(next);
    }

    /** 只回收这一条；绝不因为一个 tab 卸载就清空全部。 */
    function unpublishOverlayDoc(tab) {
      var key = docKeyOf(tab);
      if (!key || !overlayDocs.has(key)) return;
      var item = overlayDocs.get(key);
      if (tab && tab.signal && item.tab && item.tab.signal && tab.signal !== item.tab.signal) return;
      overlayDocs.delete(key);
      recomputeOverlayDoc();
    }

    function subscribeOverlayDoc(fn) {
      overlayDocListeners.add(fn);
      return function () { overlayDocListeners.delete(fn); };
    }

    /** tab 里的占位卡：如实反映浮层是否正在显示本 tab 的文档，并支持重新打开。 */
    function EditorTabPlaceholder(props) {
      var h = React.createElement;
      var narrowState = React.useState(window.innerWidth < 1024);
      var narrow = narrowState[0];
      React.useEffect(function () {
        var update = function () { narrowState[1](window.innerWidth < 1024); };
        window.addEventListener("resize", update);
        return function () { window.removeEventListener("resize", update); };
      }, []);
      var tab = props.tab || {};
      var name = tab.title || (tab.contentId ? String(tab.contentId).split("/").pop() : "文档");
      var shown = props.shown === true;
      var reopen = function () {
        try {
          publishOverlayDoc({ tab: tab, sessionId: props.sessionId, inputActions: props.inputActions, explicit: true });
        } catch (e) { /* 忽略 */ }
      };
      return h("div", {
        style: { padding: 18, display: "flex", flexDirection: "column", gap: 8, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, #9aa4b2)" },
      },
      h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e8eb)" } },
        shown ? (narrow ? "窗口较窄，编辑区已收起" : "正在编辑") : "编辑区已关闭"),
      h("div", { style: { wordBreak: "break-all" } }, name),
      shown
        ? h("div", { style: { opacity: 0.85 } }, narrow ? "加宽窗口后，文档会自动恢复。对话仍可正常使用。" : "文档已在中间编辑区打开，可拖动分隔线调整宽度。")
        : h("button", {
            type: "button",
            onClick: reopen,
            style: { alignSelf: "flex-start", marginTop: 4, padding: "5px 12px", border: "1px solid var(--dsw-alias-state-accent-primary, #4f8ef7)", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-state-accent-primary, #4f8ef7)", font: "inherit", fontSize: 12, cursor: "pointer" },
          }, "重新打开编辑区"),
      h("div", { style: { opacity: 0.65 } }, "编辑布局可在设置 → Markdown 中调整。"));
    }

    /* ── 左栏入口（探针）──────────────────────────────────────────────
     * 契约抄自已实测可用的 balance-dsh v2.2.1：
     *   sidebar.panellist 是列表型 slot，DSH 读 {id,label,order} 生成「图标+文字」整行；
     *   点图标后 DSH 调 layout.selectPanel(id)，主区域用 keyed slot "main" 按同名 key 取页面。
     *   图标组件收到 props { size, active }（size：展开 16 / 收起 rail 18）。
     */
    /* ── 最近文档 + 打开/新建通道（文档中心用）────────────────────────── */
    var docsCtx = null;        // apply 时注入，供页面调宿主服务
    var hostSidebarRight = null;   // sidebarRight 服务（get 优先 / inject 等待，与 tab 类型注册同套）
    var docsModeOn = false;        // 文档工作台是否打开（列表+编辑器都在浮层里，主区域留给对话）

    var workbenchDoc = null, workspaceIntent = 0, workspaceNotice = "";
    var editorLeaveGuards = new Map();
    var workspaceService = null;
    const WORKSPACE_DRAFT_KEY = "dsh.markpilot.workspace-drafts.v1";
    function workspaceKey(path) {
      var p=String(path||"").replace(/\\/g,"/");
      var windows=/^[a-z]:\//i.test(p) || p.startsWith("//");
      var root=p.startsWith("//") ? "//" : p.startsWith("/") ? "/" : /^[a-z]:\//i.test(p) ? p.slice(0,3) : "";
      var parts=[], floor=root==="//" ? 2 : 0;
      for(var part of p.slice(root.length).split("/")) {
        if(!part || part===".")continue;
        if(part==="..") { if(parts.length>floor && parts[parts.length-1]!=="..")parts.pop();else if(!root)parts.push(part); }
        else parts.push(part);
      }
      var key=root+parts.join("/");
      return windows ? key.toLowerCase() : key;
    }
    function workspaceContext() {
      try {
        var service=workspaceService || docsCtx?.get?.("uiWorkspace");
        var id=service?.selection?.getSnapshot?.()?.sessionId || "";
        var cwd=id ? currentCwd(id) : "";
        return { sessionId:id, cwd:cwd||"", key:workspaceKey(cwd) };
      } catch(e) { return {sessionId:"",cwd:"",key:""}; }
    }
    function workspaceMessage(message) { workspaceNotice=message; bumpOverlay(); }
    function pendingWorkspaceDraft(context, value) {
      try {
        var all=JSON.parse(window.localStorage.getItem(WORKSPACE_DRAFT_KEY)||"{}");
        if(!all || typeof all!=="object" || Array.isArray(all))throw new Error("空白草稿索引无法读取，原记录已保留。");
        if (value === undefined) return all[context.key] || null;
        if(value && !all[context.key] && Object.keys(all).length>=128)throw new Error("待保存草稿较多，请先保存已有草稿。");
        if (value === null) delete all[context.key]; else all[context.key]=value;
        window.localStorage.setItem(WORKSPACE_DRAFT_KEY,JSON.stringify(all));
        return true;
      } catch(e) { if(value===undefined)throw e; return false; }
    }
    async function prepareWorkspaceLeave() {
      var leases=[];
      for (var guard of editorLeaveGuards.values()) {
        var lease=await guard();
        if (!lease) { workspaceMessage("当前文档尚未安全留存，请完成输入或保存后再切换。"); return null; }
        leases.push(lease);
      }
      return () => leases.every(check=>check());
    }
    function enableWorkbench() {
      if (readSettings(window.localStorage).enabled!==true) {
        writeSettings(window.localStorage,{enabled:true}); mountLayout(docsCtx);
      }
    }
    async function chooseWorkbenchDoc(entry) {
      var intent=++workspaceIntent;
      var check=await prepareWorkspaceLeave();
      if (!check || intent!==workspaceIntent || !check()) return false;
      workbenchDoc=entry; workspaceNotice=""; docsModeOn=true; clearClosedOverlayKeys();
      enableWorkbench(); bumpOverlay(); return true;
    }
    async function activateNativeOverlay(next) {
      const context=workspaceContext(), key=docKeyOf(next.tab);
      if(next.sessionId!==context.sessionId || next.tab.signal?.aborted)return;
      const intent=++workspaceIntent, check=await prepareWorkspaceLeave();
      if(!check || !check() || intent!==workspaceIntent || workspaceContext().sessionId!==context.sessionId
        || next.tab.signal?.aborted || docKeyOf(overlayDoc?.tab)!==key
        || !overlayDocs.get(key)?.visible || overlayDocs.get(key)?.tab.navigation?.revision!==next.tab.navigation?.revision)return;
      docsModeOn=false;workspaceNotice="";enableWorkbench();bumpOverlay();
    }
    async function closeWorkspaceEditor() {
      var intent=++workspaceIntent, check=await prepareWorkspaceLeave();
      if (!check || intent!==workspaceIntent || !check()) return;
      closeDocsWorkbench();
    }
    /**
     * 打开当前会话工作目录的文档。
     * options.auto：会话自动切换（点开会话、跨工作目录）触发。此时只恢复该目录**上一次打开的 Markdown**
     * （含未保存的空白草稿），没有历史文档就什么都不打开——文件列表 / 空白稿只属于「点击 Markdown」的显式打开；
     * 跟随模式下同时收起上一个目录的文档，避免跨目录误编辑。
     */
    async function openWorkspace(context, options) {
      var auto=!!(options && options.auto);
      var intent=++workspaceIntent, cfg=readSettings(window.localStorage);
      const current=()=>intent===workspaceIntent && workspaceContext().sessionId===context.sessionId && workspaceContext().key===context.key;
      if (!context.sessionId || !context.key) { if(!auto) workspaceMessage("请先选择有工作目录的会话。"); return; }
      try {
        var mode=auto ? "recent" : cfg.workspaceOpenMode, entry=null;
        if (mode==="recent") {
          var pending=pendingWorkspaceDraft(context);
          if (pending && pending.draft?.id && workspaceKey(pending.draft.cwd)===context.key) entry=pending;
          else {
            var result=await api("docs/recent",{op:"list",workspace:context.cwd});
            if (!current()) return;
            if (!result.ok) throw new Error(result.error?.message || "无法读取最近文档");
            var paths=result.value?.items || [];
            if (paths.length) entry={path:paths[0],address:absoluteFileAddress(paths[0]),workspace:context.cwd,sessionId:context.sessionId};
            else if (auto) {
              // 该工作目录没有上次打开的文档：不弹文件列表、不建空白稿。
              // 若上个目录的文档还开着，跟随模式下把它收起（编辑区回到原生布局），
              // 免得工作台列表已是新目录、编辑区还停在别处的文件上。
              if (docsModeOn) { var leave=await prepareWorkspaceLeave(); if (current() && leave && leave()) closeDocsWorkbench(); }
              return;
            }
            else mode=cfg.workspaceEmptyMode;
          }
        }
        if (mode==="blank") {
          entry=pendingWorkspaceDraft(context);
          if (!entry) {
            var id=window.crypto.randomUUID(), path=context.cwd.replace(/[\\/]+$/,"")+"/未命名-"+id+".md";
            entry={path:path,address:absoluteFileAddress(path),workspace:context.cwd,sessionId:context.sessionId,draft:{id:id,cwd:context.cwd}};
          }
        }
        var check=await prepareWorkspaceLeave();
        if (!current() || !check || !check()) return;
        if (mode==="files") {
          var sr=hostSidebarRight || docsCtx?.get?.("sidebarRight"), opened=false;
          for (var n=0;n<8 && current();n++) {
            try {
              var target=sr?.commandTarget?.(null);
              if (target?.sessionId===context.sessionId && typeof sr.openTabFromTarget==="function") { sr.openTabFromTarget("files",target); opened=true; }
              else if (!sr?.commandTarget && sr?.openTab) { sr.openTab("files"); opened=true; }
              if (opened) break;
            } catch(e) { if(n===7) throw e; }
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          if (!opened) throw new Error("文件目录暂未就绪，请再次点击 Markdown。");
          if (current() && check()) closeDocsWorkbench();
          return;
        }
        if (!entry) return;
        if (entry.draft && !pendingWorkspaceDraft(context,entry)) throw new Error("无法保留空白草稿，请检查本机存储空间。");
        workbenchDoc=entry; workspaceNotice=""; docsModeOn=true; clearClosedOverlayKeys();
        enableWorkbench(); bumpOverlay();
      } catch(e) {
        if(current()) {
          if(!auto) workspaceMessage(String(e?.message||e));
          else { try { console.warn("[markpilot] 自动恢复文档失败：",e); } catch(e2) { /* 忽略 */ } }
        }
      }
    }
    function installWorkspaceNavigation(ctx) {
      var stops=[], disposed=false, queued=false, previous=null;
      function observe() {
        if(disposed || queued)return; queued=true;
        Promise.resolve().then(()=>{
          queued=false;if(disposed)return;
          var now=workspaceContext();
          if(!now.sessionId || !now.key)return;
          if(!previous){previous=now;return;}
          if(now.sessionId===previous.sessionId){previous=now;return;}
          var changed=now.key!==previous.key; previous=now;
          ++workspaceIntent; bumpOverlay();
          if(changed && readSettings(window.localStorage).workspaceSwitchMode!=="keep")void openWorkspace(now,{auto:true});
        });
      }
      const bind=(c)=>{
        if(disposed)return;
        workspaceService=c.uiWorkspace;
        for(var stop of stops)stop();stops=[];
        for(var store of [c.uiWorkspace?.selection,c.sessions?.list])if(store?.subscribe)stops.push(store.subscribe(observe));
        observe();
        return ()=>{for(var stop of stops)stop();stops=[];};
      };
      if(ctx?.inject)ctx.inject(["uiWorkspace","sessions"],bind);
      else bind({uiWorkspace:ctx?.get?.("uiWorkspace"),sessions:ctx?.get?.("sessions")});
      return ()=>{disposed=true;++workspaceIntent;for(var stop of stops)stop();};
    }

    /** 让浮层舞台重画（docsMode 变化时用；沿用文档订阅通道）。 */
    function bumpOverlay() {
      for (var fn of Array.from(overlayDocListeners)) { try { fn(); } catch (e) { /* 忽略 */ } }
    }

    function closeDocsWorkbench() {
      ++workspaceIntent; workspaceNotice="";
      docsModeOn = false;
      clearOverlayDoc();
      bumpOverlay();
      if (typeof layoutReapply === "function") layoutReapply();
    }

    /** 最近列表来自宿主（与 EXE 共用 recents.json）；返回 {path, address} 数组。 */
    function readRecentDocs(cb, workspace) {
      var done = typeof cb === "function" ? cb : function () {};
      fetch(API_BASE + "docs/recent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "list", workspace:workspace || undefined }),
      }).then(function (r) { return r.json(); })
        .then(function (res) {
          var items = (res && res.ok && res.value && Array.isArray(res.value.items)) ? res.value.items : [];
          done(items.map(function (p) { return { path: String(p), address: absoluteFileAddress(p) }; }));
        })
        .catch(function () { done([]); });
    }

    /** 记一条最近：交给宿主置顶并落盘（失败静默，不影响编辑）。 */
    function recordRecentDoc(parsed, sessionId, workspace) {
      try {
        if (!parsed || !parsed.path) return;
        fetch(API_BASE + "docs/recent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "push", path: parsed.path, sessionId: sessionId || "", scope: parsed.scope, workspace:workspace || undefined }),
        }).catch(function () { /* 记最近失败不影响编辑 */ });
      } catch (e) { /* 忽略 */ }
    }

        /** 原生路径 → dsh-resource 绝对地址（段级 encode，与 parseFileAddress 对称）。 */
    function absoluteFileAddress(nativePath) {
      var p = String(nativePath || "").replace(/\\/g, "/");
      if (!p) return "";
      return FILE_ADDRESS_PREFIX + "absolute/" + (p.startsWith("//") ? "/" : "") + p.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    }

    /** 用宿主服务打开一份资源；宿主没给 sidebarRight 时返回 false（页面据此提示）。 */
    /** 最近一次打开失败的真实原因（右侧栏没挂载会话时会抛 no session surface）。 */
    var lastOpenError = "";

    function openDocAddress(ctx, address) {
      lastOpenError = "";
      if (!address) return false;
      try {
        var sr = hostSidebarRight || (ctx && typeof ctx.get === "function" ? ctx.get("sidebarRight") : null);
        if (sr && typeof sr.openResource === "function") {
          sr.openResource(address);
          try { window.__MP_OPEN_DIAG = { ok: true, address: address }; } catch (e) { /* 忽略 */ }
          return true;
        }
        lastOpenError = sr ? "宿主未提供 openResource" : "宿主未提供 sidebarRight 服务";
        try { window.__MP_OPEN_DIAG = { ok: false, reason: lastOpenError, address: address }; } catch (e) { /* 忽略 */ }
      } catch (e) {
        lastOpenError = String((e && e.message) || e);
        // 我们在自己的 main 面板上时，会话视图不在 ⇒ 右侧栏没有 session surface。
        // 先离开面板让会话回来，一帧后再试一次。
        if (/session surface/i.test(lastOpenError)) {
          try {
            var lay = ctx && typeof ctx.get === "function" ? ctx.get("layout") : null;
            if (lay && typeof lay.selectPanel === "function") lay.selectPanel(null);
            // 右侧栏没显示时不会有 session surface —— 先把它显出来
            if (lay && typeof lay.openRightbar === "function") {
              try { lay.openRightbar(false, false); } catch (e2b) { /* 忽略 */ }
            }
          } catch (e2) { /* 忽略 */ }
          // 已知宿主限制：openResource 需要右侧栏已挂载会话（controller.require()），
          // 而文档中心本身占着 main 面板 ⇒ 会话视图不在 ⇒ 从本页无法直接打开。
          // 这里不再做无效重试，只把原因记下来，由页面给出可操作的提示。
          try { window.__MP_OPEN_DIAG = { ok: false, reason: lastOpenError, needsSession: true }; } catch (e6) { /* 忽略 */ }
          return true;
        }
        try { window.__MP_OPEN_DIAG = { ok: false, reason: lastOpenError }; } catch (e2) { /* 忽略 */ }
      }
      return false;
    }

    /** 调宿主半边新建文档。 */
    function createDocViaHost(dir, name, template) {
      return fetch(API_BASE + "docs/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: dir, name: name, template: template }),
      }).then(function (r) { return r.json(); });
    }

    var DOCS_PANEL_ID = "dsh-markdown-typora-docs";

    function DocsPanelIcon(props) {
      var size = (props && typeof props.size === "number") ? props.size : 16;
      var h = React.createElement;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true",
      },
      h("path", { d: "M6 3.5h7.5L18 8v12.5H6z", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" }),
      h("path", { d: "M13.5 3.5V8H18", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" }),
      h("path", { d: "M9 12.5h6M9 16h4.5", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }

    /**
     * 文档中心：左列表（可折叠）+ 右内嵌编辑器。
     *
     * 为什么不再走 sidebarRight.openResource：那个服务要求右侧栏已挂载会话
     * （controller.require() 会抛 no session surface），而本页占着主区域 ⇒ 永远抛。
     * 这里直接自己渲染编辑器 iframe —— 复用 EditorTabBodyInner 与同一套桥协议，
     * 只是给它一个合成 tab（contentId = 文档的绝对地址）。
     */
    function DocsWorkbench(props) {
      var h = React.createElement;
      var settings = readSettings(window.localStorage);
      var context = workspaceContext();
      var folder = String(settings.docsFolder || context.cwd || "").trim();

      var collapsedUnit = React.useState(settings.docsListCollapsed === true);
      var collapsed = collapsedUnit[0], setCollapsed = collapsedUnit[1];
      // 列表宽度可拖（160..460），松手写回设置
      var listWUnit = React.useState(settings.docsListWidth > 0 ? settings.docsListWidth : 268);
      var listW0 = listWUnit[0], setListW0 = listWUnit[1];
      var listRef = React.useRef(null);
      var listDragRef = React.useRef(null);
      React.useEffect(function () { return function () {
        if (listDragRef.current) listDragRef.current(false);
      }; }, []);
      var onListHandleDown = function (e) {
        if (e.button !== 0) return;
        if (listDragRef.current) listDragRef.current(false);
        try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
        var el = listRef.current;
        if (!el) return;
        var target = e.currentTarget, pointerId = e.pointerId;
        try { target.setPointerCapture(pointerId); } catch (err) { /* detached */ }
        var startX = e.clientX;
        // CSS width excludes the one-pixel divider; a border-box measurement
        // would accumulate one pixel on every drag/release cycle.
        var startW = parseFloat(window.getComputedStyle(el).width) || listW0;
        var clampW = function (x) { return Math.max(160, Math.min(460, Math.round(x))); };
        var width = startW, frame = null, finished = false;
        var previousTransition = el.style.transition;
        el.style.transition = "none";
        var paint = function () {
          frame = null;
          setOwnedStyle(el, "--mp-list-width", width + "px");
        };
        var finish = function (commit) {
          if (finished) return;
          finished = true;
          try { window.removeEventListener("pointermove", move, true); } catch (err1) { /* 忽略 */ }
          try { window.removeEventListener("pointerup", up, true); } catch (err2) { /* 忽略 */ }
          try { window.removeEventListener("pointercancel", up, true); } catch (err3) { /* 忽略 */ }
          window.removeEventListener("blur", blur);
          if (frame !== null) window.cancelAnimationFrame(frame);
          try { target.releasePointerCapture(pointerId); } catch (err) { /* released */ }
          if (commit) {
            paint();
            setListW0(width);
            try { writeSettings(window.localStorage, { docsListWidth: width }); } catch (err4) { /* 无存储 */ }
          } else {
            if (el.isConnected) el.style.transition = previousTransition;
            listDragRef.current = null;
            return;
          }
          // Restore the collapse animation only after the final direct resize
          // has been painted; never animate every incoming pointer position.
          frame = window.requestAnimationFrame(function () { frame = null; if (el.isConnected) el.style.transition = previousTransition; });
          listDragRef.current = function () {
            if (frame !== null) window.cancelAnimationFrame(frame);
            frame = null; if (el.isConnected) el.style.transition = previousTransition;
          };
        };
        var move = function (ev) {
          if (ev.pointerId !== pointerId) return;
          if (ev.buttons === 0) { finish(true); return; }
          ev.preventDefault();
          width = clampW(startW + (ev.clientX - startX));
          if (frame === null) frame = window.requestAnimationFrame(paint);
        };
        var up = function (ev) {
          if (ev.pointerId !== pointerId) return;
          if (ev.type !== "pointercancel" && isFinite(ev.clientX)) width = clampW(startW + (ev.clientX - startX));
          finish(true);
        };
        var blur = function () { finish(true); };
        listDragRef.current = finish;
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", up, true);
        window.addEventListener("blur", blur);
      };
      var recentsUnit = React.useState([]);
      var recents = recentsUnit[0], setRecents = recentsUnit[1];
      var active = workbenchDoc;
      var setActive = function(entry) { void chooseWorkbenchDoc(Object.assign({workspace:context.cwd,sessionId:context.sessionId},entry)); };
      var nameUnit = React.useState("");
      var name = nameUnit[0], setName = nameUnit[1];
      var busyUnit = React.useState(false);
      var busy = busyUnit[0], setBusy = busyUnit[1];
      var noticeUnit = React.useState("");
      var notice = workspaceNotice || noticeUnit[0], setNotice = noticeUnit[1];

      var listEpoch = React.useRef(0);
      var loadRecents = React.useCallback(function () {
        var request=++listEpoch.current;
        readRecentDocs(function (items) {
          if(request===listEpoch.current && workspaceContext().key===context.key)setRecents(items);
        }, context.cwd);
      }, [context.key]);
      React.useEffect(function () { setRecents([]);setBusy(false);setNotice("");loadRecents();return ()=>{++listEpoch.current;}; }, [context.key]);

      var toggleCollapsed = function () {
        var next = !collapsed;
        setCollapsed(next);
        writeSettings(window.localStorage, { docsListCollapsed: next });
      };

      var doCreate = function () {
        if (!folder) { setNotice("请先在「设置 → Markdown 编辑器」里填写目标文档文件夹。"); return; }
        if (!String(name).trim()) { setNotice("请先输入文件名。"); return; }
        var intent=workspaceIntent, origin=context.key;
        var current=()=>intent===workspaceIntent && workspaceContext().key===origin;
        setBusy(true); setNotice("");
        createDocViaHost(folder, String(name).trim(), String(settings.docsTemplate || ""))
          .then(function (res) {
            if(!current())return;
            setBusy(false);
            try { window.__MP_DOCS_LOG = { create: res }; } catch (e) { /* 忽略 */ }
            if (!res || res.ok !== true) {
              setNotice("新建失败：" + String((res && res.error && res.error.message) || "未知错误"));
              return;
            }
            var value = (res && res.value) || {};
            var entry = { address: absoluteFileAddress(value.path || value.displayPath || ""), path: value.path || "" };
            setName("");
            setActive(entry);
            setNotice("已创建：" + String(value.displayPath || value.path || ""));
            loadRecents();
          })
          .catch(function (e) {
            if(!current())return;
            setBusy(false);
            setNotice("新建失败：" + String((e && e.message) || e));
          });
      };

      var sub = { color: "var(--dsw-alias-label-secondary, #9aa4b2)" };
      var listW = collapsed ? 0 : listW0;
      var railBtn = {
        width: 32, height: 32, flex: "0 0 auto", padding: 0, pointerEvents: "auto",
        display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: "1", textAlign: "center",
        border: "1px solid var(--dsw-alias-border-l2, #3a4150)", borderRadius: 5,
        background: "transparent", color: "var(--dsw-alias-label-secondary, #9aa4b2)",
        cursor: "pointer", font: (collapsed ? "11px/1" : "12px/1") + " system-ui, sans-serif",
      };
      var rowStyle = function (isActive) {
        return {
          padding: "7px 9px", marginBottom: 4, borderRadius: 6, cursor: "pointer",
          background: isActive ? "var(--dsw-alias-bg-elevated, rgba(255,255,255,.06))" : "transparent",
          border: "1px solid " + (isActive ? "var(--dsw-alias-border-l2, #3a4150)" : "transparent"),
        };
      };

      return h("div", { "data-mp-workbench": "", style: { display: "flex", height: "100%", minHeight: 0, color: "inherit" } },
        workspaceNotice ? h(WorkspaceNotice) : null,

        // ── 左：文件列表（可折叠、右沿可拖宽） ──
        h("div", {
          ref: listRef,
          style: {
            width: collapsed ? 0 : "var(--mp-list-width," + listW + "px)", flex: "0 0 auto", display: "flex", flexDirection: "column", minHeight: 0,
            position: "relative",
            // 折叠时不画分界线：一条贯穿全高的竖线在窄条旁边很扎眼
            borderRight: collapsed ? "none" : "1px solid var(--dsw-alias-border-l2, #3a4150)",
            transition: "width .16s ease",
          },
        },
        // 右沿拖拽热区：往左拖变窄（160），往右拖变宽（460），松手写回设置
        collapsed ? null : h("div", {
          onPointerDown: onListHandleDown,
          title: "拖动调整文件列表宽度",
          "aria-label": "拖动调整文件列表宽度",
          "data-mp-list-handle": "",
          style: {
            position: "absolute", top: 0, bottom: 0, right: -4, width: 8,
            cursor: "col-resize", zIndex: 6, touchAction: "none", background: "transparent",
          },
        }),
        h("div", { "data-mp-workbench-controls": collapsed ? "floating" : "inline", style: { display: "flex", flexDirection: collapsed ? "column" : "row", alignItems: "center", gap: collapsed ? 12 : 8, padding: collapsed ? 0 : "8px 8px 8px 10px", boxSizing: "border-box", position: collapsed ? "absolute" : "relative", top: collapsed ? 8 : 0, left: collapsed ? 12 : 0, width: collapsed ? 32 : "auto", zIndex: collapsed ? 12 : "auto", pointerEvents: collapsed ? "none" : "auto" } },
          h("button", {
            key: "list-toggle", type: "button", onClick: toggleCollapsed,
            "data-mp-rail-action": "toggle", "aria-expanded": !collapsed,
            title: collapsed ? "展开文件列表" : "收起文件列表",
            "aria-label": collapsed ? "展开文件列表" : "收起文件列表",
            style: railBtn,
          }, h("svg", { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" },
            h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
            h("path", { d: collapsed ? "M9 4v16m4-11 3 3-3 3" : "M9 4v16m7-11-3 3 3 3" }))),
          collapsed ? null : h("div", { style: { fontSize: 12.5, fontWeight: 600, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "Markdown"),
          h("button", {
            key: "workbench-close", type: "button", title: "关闭文档工作台", "aria-label": "关闭文档工作台", "data-mp-rail-action": "close",
            onClick: function () { try { if (typeof props !== "undefined" && props.close) props.close(); else void closeWorkspaceEditor(); } catch (e) { /* 忽略 */ } },
            style: railBtn,
          }, h("svg", { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M7 7l10 10M17 7 7 17" })))),

        collapsed ? null : h("div", { style: { padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { display: "flex", gap: 6 } },
            h("input", {
              type: "text", value: name, placeholder: "新建文件名", disabled: busy,
              style: {
                flex: "1 1 auto", minWidth: 0, padding: "6px 8px", fontSize: 12, borderRadius: 6,
                border: "1px solid var(--dsw-alias-border-l2, #3a4150)",
                background: "var(--dsw-alias-bg-base, #0b0e14)", color: "inherit", outline: "none", fontFamily: "inherit",
              },
              onChange: function (e) { setName(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") doCreate(); },
            }),
            h("button", {
              type: "button", onClick: doCreate, disabled: busy,
              style: { ...railBtn, width: "auto", padding: "0 10px" },
            }, busy ? "…" : "新建")),
          folder
            ? h("div", { style: { ...sub, fontSize: 10.5, wordBreak: "break-all", opacity: 0.75 } }, folder)
            : h("div", { style: { ...sub, fontSize: 10.5, opacity: 0.75 } }, "未设置目标文件夹（去设置里填）"),
          notice ? h("div", { style: { fontSize: 11, opacity: 0.9, wordBreak: "break-all" } }, notice) : null),

        collapsed ? null : h("div", { style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 8px 12px" } },
          h("div", { style: { ...sub, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, padding: "4px 4px 6px" } }, "最近打开 · " + recents.length + " 份"),
          recents.length === 0
            ? h("div", { style: { ...sub, fontSize: 11.5, opacity: 0.75, padding: "4px" } }, "还没有打开过文档。")
            : recents.map(function (entry, index) {
                var isActive = !!(active && active.address === entry.address);
                var full = String(entry.path || entry.address);
                var base = full.split(/[\\/]/).pop() || full;
                return h("div", {
                  key: entry.address + index,
                  onClick: function () { setActive(entry); },
                  title: full,
                  style: rowStyle(isActive),
                },
                h("div", { style: { fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, base),
                h("div", { style: { ...sub, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.75 } }, full));
              }))),

        // ── 右：内嵌编辑器 ──
        h("div", { style: { flex: "1 1 auto", minWidth: 0, minHeight: 0, display: "flex" } },
          active
            ? h(EditorTabBodyInner, {
                useTabInfo: function () { return { tab: { contentId: active.address, id: "dsh-markdown-typora-docs", draft:active.draft, workspace:active.workspace } }; },
                sessionId: active.sessionId || context.sessionId, workbenchCollapsed: collapsed,
              })
            : h("div", { style: { margin: "auto", textAlign: "center", fontSize: 12.5, ...sub, opacity: 0.8 } },
                folder ? "从左侧选一份文档，或新建一份。" : "先在「设置 → Markdown 编辑器」里填写目标文档文件夹。")),
      );
    }

    /* ── 设置页 section（官方设置界面）────────────────────────────────
     * 契约（读自 dsh-client-ui-settings-general / settings-account）：
     *   slots.register({ name:"settings.section", id, order, label }, Component)
     *   条目按 order 升序出现在设置页左侧导航；
     *   label 可以是字符串或函数；组件额外收到宿主的 { close } 属性（本页不用）。
     * 本页只做「读写设置」，不承载业务；文档中心与布局引擎都从这里取值。
     */
    var SETTINGS_SECTION_ID = "dsh-markdown-typora";

    function SettingsField(props) {
      var h = React.createElement;
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 } },
      h("div", { style: { fontSize: 12.5, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e8eb)" } }, props.label),
      props.hint ? h("div", { style: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary, #9aa4b2)" } }, props.hint) : null,
      props.children);
    }

    function SettingsInputStyle(extra) {
      return Object.assign({
        width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: 12.5,
        borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #3a4150)",
        background: "var(--dsw-alias-bg-base, #0b0e14)", color: "var(--dsw-alias-label-primary, #e6e8eb)",
        fontFamily: "inherit", outline: "none",
      }, extra || {});
    }

    /**
     * 数字设置项：**失焦 / 回车才提交**。
     * 为什么不用受控 value + onChange：那样每敲一个字符就 clamp 一次 ——
     * 想输 "160" 时第一下 "1" 被夹成 160，再敲 "6" 变成 1606 又被夹到上限，根本输不进去
     * （本机实测踩过：右侧栏最短宽度被顶成 900）。
     */
    function NumberSetting(props) {
      var h = React.createElement;
      return h(SettingsField, { label: props.label, hint: props.hint },
        h("input", {
          type: "number", min: props.min, max: props.max, step: props.step || 10,
          defaultValue: props.value,
          style: SettingsInputStyle({ width: 140 }),
          onKeyDown: function (e) { if (e.key === "Enter") { try { e.currentTarget.blur(); } catch (err) { /* 忽略 */ } } },
          onBlur: function (e) {
            var raw = e.target.value;
            var v = Number(raw);
            if (raw === "" || !isFinite(v)) { e.target.value = String(props.value); return; }
            props.onCommit(v);
          },
        }));
    }

    function MarkdownSettingsSection() {
      var h = React.createElement;
      var bump = React.useState(0)[1];
      var settings = readSettings(window.localStorage);
      var save = function (patch) {
        writeSettings(window.localStorage, patch);
        try { window.dispatchEvent(new CustomEvent("dsh-markdown-typora:settings-changed")); } catch (e) { /* 忽略 */ }
        bump(function (n) { return n + 1; });
      };
      var reload = function () { try { window.location.reload(); } catch (e) { /* 忽略 */ } };

      var box = { padding: "20px 24px", maxWidth: 620, fontSize: 12.5, lineHeight: 1.7, color: "var(--dsw-alias-label-primary, #e6e8eb)" };
      var group = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--dsw-alias-label-tertiary, #6e7683)", margin: "6px 0 12px" };

      return h("div", { style: box },
        h("div", { style: { fontSize: 16, fontWeight: 600, marginBottom: 4 } }, "Markdown 编辑器"),
        h("div", { style: { color: "var(--dsw-alias-label-secondary, #9aa4b2)", marginBottom: 18 } }, "管理文档与编辑布局。修改后自动保存。"),

        h("div", { style: group }, "打开与切换"),
        ...[
          ["workspaceOpenMode","点击 Markdown 时","按当前会话的工作目录打开。",[["recent","最近打开的 Markdown"],["files","工作目录文件列表"],["blank","新空白 Markdown"]]],
          ["workspaceEmptyMode","没有最近文档时","独立于上方选项，仅在点击 Markdown、且该工作目录没有历史文档时生效；切换会话不会自动弹出。",[["files","工作目录文件列表"],["blank","新空白 Markdown"]]],
          ["workspaceSwitchMode","切换到其他工作目录","同一工作目录内切换会话始终保留当前文档。跨目录时只恢复该目录上次打开的文档；没有历史文档就收起编辑区，需点 Markdown 才按上方规则打开。",[["follow","恢复该目录上次的文档"],["keep","保持当前文档"]]]
        ].map(([key,label,hint,choices])=>h(SettingsField,{key,label,hint},h("select",{value:settings[key],style:SettingsInputStyle({}),onChange:e=>save({[key]:e.target.value})},...choices.map(([value,label])=>h("option",{key:value,value},label))))),
        h("div", { style: group }, "文档"),
        h(SettingsField, {
          label: "目标文档文件夹",
          hint: "新建文档的默认保存位置。留空时使用当前工作区。",
        }, h("input", {
          type: "text", value: settings.docsFolder, placeholder: "例如 D:\\Notes",
          style: SettingsInputStyle({}),
          onChange: function (e) { save({ docsFolder: e.target.value }); },
        })),
        h(SettingsField, {
          label: "新建文档模板",
          hint: "新建时写入的初始内容。{title} 会替换成文件名。",
        }, h("textarea", {
          rows: 4, value: settings.docsTemplate, spellCheck: false,
          style: SettingsInputStyle({ resize: "vertical", fontFamily: "ui-monospace, Consolas, monospace", lineHeight: 1.6 }),
          onChange: function (e) { save({ docsTemplate: e.target.value }); },
        })),

        h("div", { style: group }, "布局"),
        h(SettingsField, {
          label: "编辑区居中（对话靠右）",
          hint: "将编辑区放在中间，对话显示在右侧。关闭后，文档在右侧栏中打开。",
        }, h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
          h("input", {
            type: "checkbox", checked: settings.enabled === true,
            onChange: function (e) { save({ enabled: e.target.checked }); },
          }),
          h("span", { style: { color: "var(--dsw-alias-label-secondary, #9aa4b2)" } },
            settings.enabled ? "已开启" : "已关闭"))),
        h(SettingsField, {
          label: "退出编辑器后保留分栏拖动",
          hint: "关闭后恢复宿主布局；开启时仍可使用扩展拖动范围。",
        }, h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
          h("input", {
            type: "checkbox", checked: settings.keepResizeHandlesAfterClose === true,
            onChange: function (e) { save({ keepResizeHandlesAfterClose: e.target.checked }); },
          }),
          h("span", null, settings.keepResizeHandlesAfterClose ? "已开启" : "已关闭"))),
        h(NumberSetting, {
          label: "对话区宽度",
          hint: "220 – 900 px。编辑区会自动占用剩余空间。",
          min: LAYOUT_MIN_CHAT, max: 900, value: settings.chatWidth,
          onCommit: function (v) { save({ chatWidth: v }); },
        }),

        h(NumberSetting, {
          label: "编辑器内右栏期望宽度",
          hint: "300 – 900 px，受宿主当前栏宽与可用空间限制。使用期间仍可拖动调整。",
          min: RIGHTBAR_MIN, max: RIGHTBAR_MAX, value: settings.rightbarWidth,
          onCommit: function (v) { save({ rightbarWidth: v }); },
        }),


        h(NumberSetting, {
          label: "左侧栏最短宽度",
          hint: "左侧栏的拖拽下限（140 – 420 px）。窄于标准宽度时，内容等比缩小。",
          min: 140, max: 420, value: settings.sidebarMin,
          onCommit: function (v) { save({ sidebarMin: v }); },
        }),

        h(NumberSetting, {
          label: "右侧栏最短宽度",
          hint: "右侧栏的拖拽下限（160 – 900 px），可为编辑区留出更多空间。",
          min: 160, max: 900, value: settings.rightbarMin,
          onCommit: function (v) { save({ rightbarMin: v }); },
        }),


        h(SettingsField, {
          label: "编辑区透明",
          hint: "让应用背景透过编辑区，保持界面统一。",
        }, h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
          h("input", {
            type: "checkbox", checked: settings.transparent !== false,
            onChange: function (e) { save({ transparent: e.target.checked }); },
          }),
          h("span", { style: { color: "var(--dsw-alias-label-secondary, #9aa4b2)" } },
            settings.transparent !== false ? "已开启" : "已关闭"))),

        h("div", { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 4 } },
          h("button", {
            type: "button", onClick: reload,
            style: { padding: "6px 14px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #3a4150)", background: "transparent", color: "inherit", cursor: "pointer", fontFamily: "inherit" },
          }, "重新加载以应用布局"),
          h("span", { style: { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary, #6e7683)" } },
            "布局开关与宽度设置重新加载后生效；透明、退出分栏策略和文档设置立即生效。")),
      );
    }

    function EditorTabBody(props) {
      if (!React) return null;
      if (typeof props.useTabInfo !== "function") {
        return React.createElement("div", { style: emptyStyle }, "dsh-markdown-typora: useTabInfo unavailable");
      }
      // 布局关闭 ⇒ 旧行为（iframe 仍在这里）
      if (!layoutEnabled()) return React.createElement(EditorTabBodyInner, props);
      return React.createElement(EditorTabRedirect, props);
    }

    /** 布局开启时：公布文档、渲染占位，把 iframe 让给浮层。
     *  deps 里带上 visible：切到另一个 md tab 时本 tab 会变不可见，
     *  必须重发布一次让活跃文档跟着切换。 */
    function EditorTabRedirect(props) {
      var tab = props.useTabInfo().tab;
      var key = docKeyOf(tab);
      var visible = !(tab && tab.visible === false);
      var navigation = tab?.navigation?.revision;
      var previousNavigation = React.useRef({key,signal:tab?.signal,revision:navigation});
      var rerender = React.useState(0)[1];
      React.useEffect(function () {
        var off = subscribeOverlayDoc(function () { rerender(function (n) { return n + 1; }); });
        return off;
      }, []);
      React.useEffect(function () {
        var previous=previousNavigation.current;
        var explicit=previous.key===key && previous.signal===tab?.signal && navigation>previous.revision;
        previousNavigation.current={key,signal:tab?.signal,revision:navigation};
        publishOverlayDoc({ tab: tab, sessionId: props.sessionId, inputActions: props.inputActions, explicit:explicit });
        return function () { unpublishOverlayDoc(tab); };
      }, [key, visible, navigation]);
      var shown = !docsModeOn && !!(overlayDoc && docKeyOf(overlayDoc.tab) === key);
      if(docsModeOn && workbenchDoc?.path) {
        var nativeFile=parseFileAddress(tab?.contentId);
        if(nativeFile)shown=workspaceKey(absolutePath(nativeFile.path,currentCwd(nativeFile.sessionId || props.sessionId)))===workspaceKey(workbenchDoc.path);
      }
      return React.createElement(EditorTabPlaceholder, {
        tab: tab, shown: shown, sessionId: props.sessionId, inputActions: props.inputActions,
      });
    }

    /** 浮层舞台：唯一的 iframe 挂载点。几何由布局引擎写（left/top/width/height）。 */
    /**
     * 左栏入口的 main 页：**什么都不渲染**，只做两件事 ——
     *   ① 打开浮层工作台（列表+编辑器都画在 overlay 上）
     *   ② 立刻把主区域还给会话视图，让对话栏（含输入框）始终在最右侧
     * 这一步是本次架构修正的核心：worktable 的窗格从不接管 main，所以对话一直在。
     */
    function DocsEntryRedirect() {
      var consumed = React.useRef(false);
      React.useEffect(function () {
        if (consumed.current) return;
        consumed.current = true;
        // 浮层舞台的几何由布局引擎写；布局关着时舞台是 0×0 —— 先确保它开着。
        try {
          var cfg = readSettings(window.localStorage);
          if (cfg.enabled !== true) {
            writeSettings(window.localStorage, { enabled: true });
            mountLayout(docsCtx);
          }
        } catch (e0) { /* 忽略 */ }
        if (docsModeOn || overlayDoc) void closeWorkspaceEditor();
        else void openWorkspace(workspaceContext());
        try {
          var lay = docsCtx && typeof docsCtx.get === "function" ? docsCtx.get("layout") : null;
          if (lay && typeof lay.selectPanel === "function") lay.selectPanel(null);
        } catch (e) { /* 忽略 */ }
        // 主区域切换是异步重挂载：在几个时间点各重算一次，确保挤压落到新根上。
        [0, 80, 260, 600].forEach(function (delay) {
          try {
            setTimeout(function () {
              if (typeof layoutReapply === "function") layoutReapply();
            }, delay);
          } catch (e2) { /* 忽略 */ }
        });
      }, []);
      return null;
    }

    function WorkspaceNotice() {
      if(!workspaceNotice)return null;
      return React.createElement("div", {role:"alert",style:{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",zIndex:1000,maxWidth:"min(560px,80vw)",display:"flex",gap:16,alignItems:"center",padding:"12px 16px",borderRadius:10,border:"1px solid var(--dsw-alias-border-l2,#555)",background:"var(--dsw-alias-bg-elevated,#25282e)",color:"var(--dsw-alias-label-primary,#eee)",boxShadow:"0 6px 24px #0003",font:"13px/1.5 system-ui",pointerEvents:"auto"}},workspaceNotice,
        React.createElement("button",{type:"button","aria-label":"关闭提示",onClick:()=>{workspaceNotice="";bumpOverlay();},style:{border:0,background:"transparent",color:"inherit",cursor:"pointer",fontSize:18,padding:4}},"×"));
    }
    function EditorOverlayStage(props) {
      var h = React.createElement;
      var docRef = React.useRef(null);
      var rerender = React.useState(0)[1];
      React.useEffect(function () {
        var update = function () { rerender(function (n) { return n + 1; }); };
        var off = subscribeOverlayDoc(update);
        var offSettings = watchSettingsChanges(update);
        return function () { offSettings(); off(); };
      }, []);
      var d = overlayDoc;
      var docsOpen = docsModeOn === true;
      React.useEffect(function () {
        if (!d && !docsOpen) return;
        if (typeof layoutReapply === "function") { try { layoutReapply(); } catch (e) { /* 忽略 */ } }
      }, [d ? d.tab && d.tab.contentId : null, docsOpen]);
      if (docsOpen) {
        // 工作台：左列表 + 右编辑区，整体画在浮层里；主区域右侧仍是对话。
        return h("div", {
          id: "mp-stage",
          style: {
            // 兜底几何：布局引擎只在"有会话"时才写 left/width；没有会话时也要能看见工作台。
            // 引擎一旦写内联值就会覆盖这里（writeStyle 直接改同一批属性）。
            position: "fixed", left: 0, top: 0, width: "62vw", height: "100%", zIndex: 19,
            display: "flex", flexDirection: "column", minWidth: 0,
            background: (readSettings(window.localStorage).transparent !== false) ? "transparent" : "var(--dsw-alias-bg-base, #0b0e14)",
            // 与宿主同款分隔线：编辑区右侧一条细线，和对话分开但不割裂
            borderRight: "1px solid var(--dsw-alias-border-l2, #3a4150)",
            borderRadius: 0, overflow: "hidden", pointerEvents: "auto",
          },
          onPointerDown: function (e) {
            // 只有贴在舞台右边缘 18px 内才算"拖对话列"（其余点击照常进编辑器）
            var r = e.currentTarget.getBoundingClientRect();
            if (e.clientX < r.right - 18) return;
            chatHandleState.dragging = true;
            chatHandleState.startX = e.clientX;
            var snap0 = handleState.engine && handleState.engine.snapshot ? handleState.engine.snapshot() : null;
            chatHandleState.startW = (snap0 && snap0.chatW) || 420;
            try { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); } catch (err0) { /* 忽略 */ }
            try { e.preventDefault(); } catch (err1) { /* 忽略 */ }
          },
          onPointerMove: onHandleMove,
          onPointerUp: onHandleUp,
          onPointerCancel: onHandleUp,
        }, h(DocsWorkbench, {
          close: closeWorkspaceEditor,
        }));
      }
      if (!d || !d.tab) return workspaceNotice ? h(WorkspaceNotice) : null;
      var closeBtn = h("button", {
        type: "button",
        title: "关闭编辑区",
        "aria-label": "关闭编辑区",
        onClick: function () { try { clearOverlayDoc(); } catch (e) { /* 忽略 */ } },
        style: {
          position: "absolute", top: 4, right: 6, zIndex: 2,
          width: 20, height: 20, padding: 0, border: "none", borderRadius: 4,
          background: "rgba(0,0,0,0.35)", color: "#c8cfda", cursor: "pointer",
          font: "13px/1 system-ui, sans-serif", lineHeight: "20px",
        },
      }, "\u00d7");
      return h("div", {
        id: "mp-stage",
        style: {
          position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: 19,
          display: "flex", flexDirection: "column", minWidth: 0,
          background: (readSettings(window.localStorage).transparent !== false) ? "transparent" : "var(--dsw-alias-bg-base, #0b0e14)",
          borderRadius: 0, overflow: "hidden",
          pointerEvents: "auto",
        },
      }, closeBtn, h("div", {
                  id: "mp-chat-drag",
                  onPointerDown: function (e) {
                    chatHandleState.dragging = true;
                    chatHandleState.startX = e.clientX;
                    var snap0 = handleState.engine && handleState.engine.snapshot ? handleState.engine.snapshot() : null;
                    chatHandleState.startW = (snap0 && snap0.chatW) || 420;
                    try { if (e.currentTarget && e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); } catch (err0) { /* 忽略 */ }
                    try { e.preventDefault(); } catch (err1) { /* 忽略 */ }
                  },
                  onPointerMove: onHandleMove,
                  onPointerUp: onHandleUp,
                  onPointerCancel: onHandleUp,
                  style: { position: "absolute", right: 0, top: 0, width: 16, height: "100%", cursor: "col-resize", zIndex: 6, touchAction: "none", background: "transparent" },
                }), h(EditorTabBodyInner, {
        useTabInfo: function () { return { tab: d.tab }; },
        sessionId: d.sessionId,
        inputActions: d.inputActions,
      }));
    }

    // Save acknowledgement is independent of phase/detail, which also carry errors,
    // recovery and notices. A controller belongs to one document generation.
    function createSaveStatusController(isCurrent, publish) {
      let dirty = false, status = "", timer = null, epoch = 0, disposed = false;
      function cancelTimer() {
        epoch += 1;
        if (timer !== null) clearTimeout(timer);
        timer = null;
      }
      function emit(next) {
        if (next === status) return;
        status = next;
        if (!disposed && isCurrent()) publish(next);
      }
      return {
        update(nextDirty, confirmedSaved) {
          if (disposed || !isCurrent()) return;
          const wasDirty = dirty;
          dirty = nextDirty === true;
          if (dirty) {
            cancelTimer();
            emit("unsaved");
          } else if (confirmedSaved === true) {
            cancelTimer();
            emit("saved");
            const ticket = epoch;
            timer = setTimeout(() => {
              if (disposed || !isCurrent() || dirty || ticket !== epoch) return;
              timer = null;
              emit("");
            }, 3000);
          } else if (wasDirty) {
            // Reload/discard can become clean without saving: do not claim a save.
            cancelTimer();
            emit("");
          }
        },
        dispose() { disposed = true; cancelTimer(); },
      };
    }

    function EditorTabBodyInner(props) {
      const h = React.createElement;
      const tab = props.useTabInfo().tab;
      const address = tab && tab.contentId;
      const parsed = React.useMemo(() => parseFileAddress(address), [address]);
      const depKey = parsed ? [parsed.scope, parsed.sessionId || "", parsed.path].join("|") : null;
      const tabVisible = !(tab && tab.visible === false);
      const sessionIdFromProps = typeof props.sessionId === "string" ? props.sessionId : "";

      // 最近文档登记：交给宿主置顶（与 EXE 共用 MRU），布局开关关着也记。
      // Successful application below records the workspace history.

      const frameRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const st = React.useRef({ doc: null, actions: {} }).current;
      const inputActionsRef = React.useRef(props.inputActions);
      inputActionsRef.current = props.inputActions;
      const workbenchCollapsedRef = React.useRef(props.workbenchCollapsed === true);
      workbenchCollapsedRef.current = props.workbenchCollapsed === true;
      const editorAppearance = () => Object.assign(readAppearance(), { workbenchCollapsed: workbenchCollapsedRef.current });
      React.useEffect(() => {
        const win = frameRef.current && frameRef.current.contentWindow;
        if (win) { try { win.postMessage({ __dshmd: true, dir: "down", type: "appearance", content: editorAppearance() }, "*"); } catch (e) { /* load/ready retries */ } }
      }, [props.workbenchCollapsed]);

      const [ui, setUi] = React.useState({ phase: "loading", detail: "", notice: "", recovery: null, recovered: null, saveStatus: "" });
      const setUiIfChanged = React.useCallback((next) => {
        setUi((prev) => {
          if (prev.phase === next.phase && prev.detail === next.detail && prev.notice === next.notice) return prev;
          return { ...prev, ...next };
        });
      }, []);
      // recovered 横幅独立于 phase（dirty/ready 切换不清除；按票一次，用户「知道了」才收起）。
      const setUiIfChangedWithRecovered = React.useCallback((items) => {
        setUi((prev) => (prev.recovered === items ? prev : { ...prev, recovered: items }));
      }, []);

      /* ── 文档生命周期（每个 depKey 一代；异步回执都验票） ── */
      React.useEffect(() => {
        if (!parsed) return undefined;
        const doc = {
          gen: ++generationCounter,
          key: depKey,
          win: null,
          sessionId: parsed.sessionId || sessionIdFromProps || "",
          path: parsed.path,
          absPath: absolutePath(parsed.path, currentCwd(parsed.sessionId || sessionIdFromProps)),
          displayPath: "",
          size: 0,
          opened: false,
          dead: false,
          bridgeUp: false,
          editorReady: false,
          booting: false,
          lastVersion: null,
          untitled: !!tab.draft, draft:tab.draft || null, firstSaveText:typeof tab.draft?.firstSaveText==="string" ? tab.draft.firstSaveText : null,
          workspace:tab.workspace || currentCwd(sessionIdFromProps) || workspaceContext().cwd,
          dirty: false,
          conflict: false,
          saving: false,
          saveQueued: false,
          manualPending: false,
          editSeq: 0,
          token: "dshdoc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + generationCounter,
          mirror: null, pendingApply: null, applyUnknown: false, composing: false,
          wireSeq: 0, pulls: new Map(), gapDeltas: [], closeUntil: 0,
          loadSeq: 0,
          text: "",
          textFresh: false,
          recovery: null,
          saveTimer: null,
          flushed: false,
          live: null, liveUnsupported: false, liveFlushSeq: 0, liveFlushWaiters: new Map(), liveStatus: null,
          liveStaleRounds: 0, liveStaleBlocked: false,
          liveRecoveredShownFor: null, liveRecoveredItems: null,
          es: null,
          esHealthy: false,
          pollTimer: null,
          pollFailures: 0,
          externalStale: false,
          staleNotified: false,
          tabVisible: tabVisible,
          notice: "",
          phase: "loading",
          reload: null,
          reloadDisk: null,
          copyMine: null,
        };
        st.doc = doc;
        setUiIfChanged({ phase: "loading", detail: "", notice: "", recovery: null });
        setUi((prev) => (prev.recovered || prev.saveStatus ? { ...prev, recovered: null, saveStatus: "" } : prev));   // 新文档代际不继承恢复提示或保存回执

        const ticket = ticketOf(doc.sessionId, doc.absPath, doc.gen);
        const alive = () => !doc.dead && st.doc === doc && ticket.generation === doc.gen;
        const cleanups = [];
        const saveStatus = createSaveStatusController(alive, (status) => {
          setUi((prev) => prev.saveStatus === status ? prev : { ...prev, saveStatus: status });
        });
        cleanups.push(() => saveStatus.dispose());

        function refreshPath() {
          // A session cwd change never retargets an already owned document.
          if (!doc.opened && !doc.mirror && !doc.pendingApply) {
            const previousPath=doc.absPath;
            doc.absPath = absolutePath(parsed.path, currentCwd(doc.sessionId));
            if(previousPath!==doc.absPath)openDocs.delete(doc.sessionId + "\n" + previousPath);
          }
          doc.displayPath = doc.displayPath || doc.absPath;
          openDocs.set(doc.sessionId + "\n" + doc.absPath, {
            sessionId: doc.sessionId,
            path: doc.absPath,
            basename: basenameOf(doc.absPath),
            storageError: error => doc.storageError?.(error),
          });
        }
        refreshPath();
        editorLeaveGuards.set(doc.token, async () => {
          if (!alive()) return ()=>true;
          if (doc.saving || doc.composing || doc.pendingApply || doc.applyUnknown) return null;
          if (!doc.dirty) return ()=>alive() && !doc.dirty && !doc.saving && !doc.composing && !doc.pendingApply && !doc.applyUnknown;
          const seq=doc.editSeq, pulled=await pullText();
          if (pulled.stale || !alive() || doc.editSeq!==seq || doc.composing) return null;
          const receipt=await checkpointRecovery(pulled.text,pulled.session,true);
          if (receipt?.ok!==true || receipt.durable!==true) return null;
          return ()=>alive() && doc.editSeq===seq && !doc.saving && !doc.composing && !doc.pendingApply && !doc.applyUnknown;
        });
        cleanups.push(()=>editorLeaveGuards.delete(doc.token));

        function currentFrameWin() {
          // 只在"还是当前代且未死"时回落到 ref：清理阶段 frameRef 可能已指向新文档的 iframe，
          // 拿它发 requestText 会把旧文档的全文当成新文档的回执（跨文档污染）。
          if (st.doc !== doc || doc.dead) return null;
          try { return frameRef.current ? frameRef.current.contentWindow : null; } catch (e) { return null; }
        }

        function post(type, content) {
          const win = doc.win || currentFrameWin();
          if (!win) return false;
          try {
            win.postMessage({ __dshmd: true, dir: "down", type: type, content: content }, "*");
            return true;
          } catch (e) {
            return false;
          }
        }

        function draftStore() { return recoveryStore; }
        doc.storageError = error => showNotice("恢复记录尚未持久化：" + String(error.message || error.code));
        function inspectStoreResult(result) { if(result?.ok===false)showNotice('恢复记录尚未持久化：'+String(result.error||result.code||'storage unavailable')); return result; }
        function wireSession() { return doc.mirror ? {...doc.mirror.session} : null; }
        /* ── live 会话（引擎 facade mpEngine.liveDocument 承担 OT；父窗口只做中继）── */
        function startLive(ticket, text) {
          if (!alive() || doc.live || doc.liveUnsupported) return;
          // 房间票：client/epoch(UUID 字符串)/version(整数)；text 允许空串（空文件）。
          if (!ticket || typeof ticket.client !== "string" || !ticket.client
            || typeof ticket.epoch !== "string" || !ticket.epoch
            || !Number.isSafeInteger(ticket.version) || typeof text !== "string") return;
          doc.live = { client: ticket.client, epoch: ticket.epoch, version: ticket.version,
            diskHash: ticket.diskHash, savedVersion: Number.isSafeInteger(ticket.savedVersion) ? ticket.savedVersion : ticket.version };
          post("live-bind", { protocol: 2, docToken: doc.token, text: text, live: ticket });
          // recovered：join 票带回的草稿副本（内核恢复记录）。只在本 tab 内展示一次：
          // 路径可复制、原件未被覆盖；不读文件、不进 SSE、不影响其它文档。
          const recovered = liveRecoveredItems(ticket);
          if (recovered.length && !doc.liveRecoveredShownFor) {
            doc.liveRecoveredShownFor = ticket.client;
            doc.liveRecoveredItems = recovered;
            setUiIfChangedWithRecovered(recovered);
          }
        }
        function stopLive(backstopLeave) {
          const session = doc.live;
          doc.live = null;
          doc.liveStaleBlocked = false;   // 会话离场：STALE 预算随会话作废
          doc.liveStaleRounds = 0;
          doc.liveFlushWaiters.forEach(function (waiter) { waiter.resolve({ ok: false, code: "MP_LIVE_GONE", error: "live 会话已结束" }); });
          doc.liveFlushWaiters.clear();
          if (!session) return;
          post("live-unbind", { protocol: 2, docToken: doc.token });   // facade unbind → leave 上行
          if (backstopLeave) api("live", { client: session.client, action: "leave" }).catch(function () { /* 已关或已过期 */ });
        }
        function flushLive() {
          if (!doc.live) return Promise.resolve({ ok: false, code: "MP_LIVE_GONE", error: "live 会话已结束" });
          const id = ++doc.liveFlushSeq;
          return new Promise(function (resolve) {
            const waiter = { resolve: function (value) { clearTimeout(timer); resolve(value); } };
            const timer = setTimeout(function () {
              doc.liveFlushWaiters.delete(id);
              resolve({ ok: false, code: "MP_LIVE_TIMEOUT", error: "同步确认超时" });
            }, LIVE_FLUSH_TIMEOUT_MS);
            doc.liveFlushWaiters.set(id, waiter);
            if (!post("live-flush", { protocol: 2, docToken: doc.token, id: id })) {
              doc.liveFlushWaiters.delete(id); clearTimeout(timer);
              resolve({ ok: false, code: "MP_LIVE_GONE", error: "编辑面不可达" });
            }
          });
        }
        async function relayLiveExchange(content) {
          const client = content && content.client;
          const reply = function (response) {
            post("live-exchange-result", { protocol: 2, docToken: doc.token, id: content && content.id, response: response });
          };
          if (!alive() && !(doc.closeUntil >= Date.now())) { reply({ ok: false, error: "编辑面已关闭", code: "MP_LIVE_GONE" }); return; }
          try {
            reply(await api("live", { client: client, action: "exchange", request: content.request }));
          } catch (error) {
            reply({ ok: false, error: String(error && error.message || error), code: "MP_LIVE_TRANSPORT" });
          }
        }
        function handleLiveError(code, message) {
          const action = liveErrorAction(code);
          const friendly = String(message || code || "共享编辑会话异常");
          if (action === "unsupported") {
            doc.liveUnsupported = true;
            const session = doc.live;
            doc.live = null;
            if (session) api("live", { client: session.client, action: "leave" }).catch(function () { /* 已过期 */ });
            showNotice("当前引擎暂不支持跨窗口实时同步，已切换为单窗口安全模式");
            // 单窗口回落：重新以非 live 口径读盘（干净时），避免把共享房间的未存草稿
            // 留在编辑面里被当成磁盘基线；用户已输入（脏）时由 loadFromDisk 自身守卫保留。
            if (doc.opened && !doc.dirty && !doc.conflict) void loadFromDisk({ silent: true, reason: "live-unsupported" });
            return;
          }
          if (action === "conflict") {
            doc.live = null;
            doc.conflict = true;
            showPhase("conflict", (code === "MP_LIVE_STALE" ? "共享文档版本已变化，未覆盖；" : "共享编辑会话已结束，") + "当前内容已保留：" + friendly);
            return;
          }
          showNotice("共享编辑同步提示：" + friendly);
        }

        function checkpointRecovery(text,session,dirty) {
          const store=draftStore();
          if(!store)return Promise.resolve({ok:false,durable:false,code:'RECOVERY_UNAVAILABLE'});
          try { return Promise.resolve(store.checkpoint({path:doc.absPath,docToken:doc.token,session,text,baseVersion:doc.lastVersion,dirty:!!dirty,composing:doc.composing})).then(inspectStoreResult).catch(error=>{showNotice('恢复记录尚未持久化：'+String(error));return{ok:false,durable:false};}); }
          catch(error){showNotice('恢复记录尚未持久化：'+String(error));return Promise.resolve({ok:false,durable:false});}
        }
        function persistCurrentRecovery() {
          const store=draftStore();
          if(store){try{return inspectStoreResult(store.flush({path:doc.absPath,docToken:doc.token}));}catch(error){showNotice('恢复记录写入失败：'+String(error));}}
          if(doc.mirror?.continuous){writeRecovery(materialize(doc.mirror),doc.composing || !!doc.pendingApply);}
          return {durable:false,retained:true};
        }
        function requestSnapshot(reason) {
          const id=doc.token+':pull:'+ (++doc.wireSeq);
          return new Promise(resolve=>{
            const pending={id,docToken:doc.token,reason,expected:wireSession(),resolve,timer:null};
            doc.pulls.set(id,pending);
            pending.timer=setTimeout(()=>{
              doc.pulls.delete(id);resolve({text:doc.text,stale:true});
              if(reason==='apply' && doc.pendingApply){doc.applyUnknown=true;doc.pendingApply.resolve?.(false);doc.pendingApply.resolve=null;if(alive())showError('编辑器应用状态尚未确认；当前稿件已保留，保存暂停');}
            },PULL_TIMEOUT_MS);
            if(!post('requestText',{protocol:2,docToken:doc.token,id,expectedSession:pending.expected})){clearTimeout(pending.timer);doc.pulls.delete(id);resolve({text:doc.text,stale:true});}
          });
        }
        function applyToFrame(candidate) {
          if(doc.pendingApply || doc.applyUnknown || doc.composing || doc.saving || !alive())return Promise.resolve(false);
          if(candidate.path!==doc.absPath || candidate.baseVersion!==doc.lastVersion || candidate.editSeq!==doc.editSeq || candidate.loadSeq!==doc.loadSeq)return Promise.resolve(false);
          if(!candidate.firstOpen && !doc.mirror?.continuous)return Promise.resolve(false);
          return new Promise(resolve=>{
            const applyId=doc.token+':apply:'+(++doc.wireSeq);
            const wire={protocol:2,docToken:doc.token,applyId,serial:doc.wireSeq,expected:wireSession(),content:candidate.value.text,kind:candidate.kind,rootPath:directoryOf(doc.absPath)};
            const pending={...candidate,docToken:doc.token,applyId,expected:wire.expected,wire,resolve,edits:[],timer:null};
            doc.pendingApply=pending;
            pending.timer=setTimeout(()=>{if(doc.pendingApply!==pending)return;doc.applyUnknown=true;void requestSnapshot('apply');},PULL_TIMEOUT_MS);
            if(candidate.firstOpen)post('theme',{dark:isDarkTheme()});
            if(!post(candidate.firstOpen?'open':'setValue',wire)){clearTimeout(pending.timer);doc.pendingApply=null;resolve(false);}
          });
        }
        function commitApplied(pending,reply,snapshot) {
          const value=pending.value,restore=pending.kind==='restore';
          doc.opened=true;doc.text=value.text;doc.textFresh=true;doc.lastVersion=value.version;
          doc.displayPath=value.displayPath||doc.absPath;doc.size=value.size;
          doc.mirror=mirrorOf(value.text,reply.session,doc.token);doc.composing=false;
          // 共享房间的未存草稿不是磁盘状态：open 带回的正文若与磁盘种子不同（value.live.dirty），
          // 必须如实标记脏 —— baseVersion/lastVersion 仍指向磁盘版本，绝不能把共享正文
          // 当成"已在盘上"的基线；后续落盘只能走 live 票（房间校验）路径。
          doc.dirty=restore||doc.untitled||(pending.firstOpen&&value.live&&value.live.dirty===true);
          if(pending.firstOpen && !doc.untitled) recordRecentDoc({path:doc.absPath,scope:"absolute"},doc.sessionId,doc.workspace);
          doc.conflict=false;doc.externalStale=false;doc.staleNotified=false;
          if(restore)doc.editSeq++;
          // live 会话：open(live:true) 回执带票且引擎 facade 可用时，把传输桥交给 iframe。
          // join 票对应的正文就是本次应用的 value.text，facade bind 的 initial 与之一致。
          if(value.live && pending.firstOpen && !doc.live && !doc.liveUnsupported) startLive(value.live, value.text);
          const recoveryReceipt=checkpointRecovery(value.text,reply.session,restore);
          if(snapshot && snapshot.session.epoch===reply.session.epoch && snapshot.session.sourceRevision>=reply.session.sourceRevision){
            const changed=snapshot.session.sourceRevision>reply.session.sourceRevision;
            doc.mirror=mirrorOf(snapshot.text,snapshot.session,doc.token);doc.text=snapshot.text;doc.composing=!!snapshot.composing;
            if(changed){doc.dirty=true;doc.editSeq++;checkpointRecovery(snapshot.text,snapshot.session,true);}
          }
          for(const delta of pending.edits){
            if(delta.after.epoch===doc.mirror.session.epoch && delta.after.sourceRevision<=doc.mirror.session.sourceRevision)continue;
            acceptDelta(delta);
          }
          if(pending.composition && sameSession(pending.composition.session,wireSession()))doc.composing=!!pending.composition.composing;
          if(restore){
            const consumed=pending.recoverySlot,pathAtApply=doc.absPath,tokenAtApply=doc.token;
            // Editor ACK proves application, not durability. The old recovery
            // remains the only durable copy until the new checkpoint commits.
            void recoveryReceipt.then(receipt=>{
              if(receipt?.ok!==true || receipt.durable!==true || doc.token!==tokenAtApply || doc.absPath!==pathAtApply)return;
              clearRecoverySlot(null,pathAtApply);
              if(consumed?.docToken && consumed.docToken!==tokenAtApply){try{Promise.resolve(draftStore()?.clear?.(pathAtApply,consumed.docToken,consumed.session)).then(inspectStoreResult).catch(error=>showNotice('恢复记录清理失败：'+String(error)));}catch(e){}}
            });
            doc.recovery=null;
          }else if(pending.opts.discard){clearRecoverySlot(null,doc.absPath);doc.recovery=null;}
          if(doc.dead){persistCurrentRecovery();return;}
          showPhase(doc.dirty?'dirty':'ready',restore?'已恢复未保存内容':pending.firstOpen?'':'已同步磁盘更新');
          if(doc.dirty && !doc.composing)scheduleSave(restore?0:SAVE_DEBOUNCE_MS);
          if(pending.firstOpen){
            const atEdit=doc.editSeq;
            Promise.resolve(draftStore()?.readLatest?.(doc.absPath)).then(saved=>{
              const slot=saved??readRecoverySlot(null,doc.absPath);
              if(!alive() || doc.editSeq!==atEdit || doc.dirty || !slot || typeof slot.text!=='string' || slot.text===doc.text)return;
              doc.recovery=slot;setUiIfChanged({phase:'recovery',detail:'检测到上次关闭时未保存的内容',notice:'',recovery:slot});
            }).catch(error=>showNotice('读取恢复记录失败：'+String(error)));
          }
        }
        function onApplyResult(reply,snapshot) {
          const pending=doc.pendingApply;
          if(!pending || reply?.protocol!==2 || reply.docToken!==doc.token || reply.applyId!==pending.applyId || doc.absPath!==pending.path || doc.lastVersion!==pending.baseVersion)return;
          if(reply.applied && !validSession(reply.session))return;
          clearTimeout(pending.timer);doc.pendingApply=null;doc.applyUnknown=false;
          if(reply.applied){commitApplied(pending,reply,snapshot);pending.resolve?.(true);}
          else{
            for(const delta of pending.edits)acceptDelta(delta);
            if(pending.composition && sameSession(pending.composition.session,wireSession()))doc.composing=!!pending.composition.composing;
            if(alive())showNotice(reply.reason==='composing'?'请先完成输入，再重试同步':'编辑器未应用磁盘内容，当前编辑已保留：'+String(reply.reason||'rejected'));
            pending.resolve?.(false);
          }
        }
        function acceptDelta(delta) {
          if(delta?.protocol!==2 || delta.docToken!==doc.token || !doc.mirror)return false;
          if(delta.after?.epoch===doc.mirror.session.epoch && delta.after.sourceRevision<=doc.mirror.session.sourceRevision)return true;
          const applied=applyMirrorDelta(doc.mirror,delta);
          if(!applied.ok){doc.mirror.continuous=false;doc.dirty=true;saveStatus.update(true);if(!doc.gapDeltas.some(x=>sameSession(x.after,delta.after)))doc.gapDeltas.push(delta);if(!doc.pulls.size)void requestSnapshot('gap');return false;}
          doc.mirror=applied.mirror;doc.textFresh=false;doc.dirty=true;doc.editSeq++;doc.composing=!!delta.composing;
          try{const result=inspectStoreResult(draftStore()?.append?.({...delta,path:doc.absPath,baseVersion:doc.lastVersion}));result?.durable?.then?.(inspectStoreResult).catch?.(error=>showNotice('恢复记录尚未持久化：'+String(error)));}catch(error){showNotice('恢复记录尚未持久化：'+String(error));}
          if(doc.dead){persistCurrentRecovery();return true;}
          showPhase('dirty',doc.composing?'输入中…':'编辑中…');
          if(doc.saveTimer){clearTimeout(doc.saveTimer);doc.saveTimer=null;}
          if(!doc.composing)scheduleSave(SAVE_DEBOUNCE_MS);
          return true;
        }
        function onDelta(delta) {
          if(delta?.protocol!==2 || delta.docToken!==doc.token)return;
          if(doc.pendingApply){
            const pending=doc.pendingApply,applied=delta.lastApply;
            if(applied?.applyId===pending.applyId && validSession(applied.session) && validSession(delta.before) && validSession(delta.after) &&
                delta.before.epoch===applied.session.epoch && delta.after.epoch===applied.session.epoch &&
                delta.before.sourceRevision>=applied.session.sourceRevision && delta.after.sourceRevision===delta.before.sourceRevision+1 &&
                (pending.firstOpen || (pending.expected?.epoch===applied.session.epoch && applied.session.sourceRevision>=pending.expected.sourceRevision))){
              onApplyResult({protocol:2,docToken:doc.token,applyId:pending.applyId,applied:true,session:applied.session});
              if(!doc.pendingApply){acceptDelta(delta);return;}
            }
            doc.pendingApply.edits.push(delta);return;
          }
          acceptDelta(delta);
        }
        function onComposition(content) {
          if(content?.protocol!==2 || content.docToken!==doc.token)return;
          if(doc.pendingApply){doc.pendingApply.composition=content;return;}
          if(!sameSession(content.session,wireSession()))return;
          doc.composing=!!content.composing;
          if(doc.dead){persistCurrentRecovery();return;}
          if(!doc.composing && doc.dirty && !doc.pendingApply){if(doc.manualPending){doc.manualPending=false;void runSave({manual:true});}else scheduleSave(SAVE_DEBOUNCE_MS);}
        }
        function onSnapshot(reply) {
          const pending=reply && doc.pulls.get(reply.id);
          if(!pending || reply.protocol!==2 || reply.docToken!==doc.token || !validSession(reply.session) || typeof reply.text!=='string')return;
          if(doc.pendingApply){
            const applying=doc.pendingApply,last=reply.lastApply;
            if(last?.applyId===applying.applyId && validSession(last.session) && reply.session.epoch===last.session.epoch && reply.session.sourceRevision>=last.session.sourceRevision){
              onApplyResult({protocol:2,docToken:doc.token,applyId:applying.applyId,applied:true,session:last.session},reply);
            }else if(sameSession(reply.session,applying.expected) && last?.applyId!==applying.applyId){
              onApplyResult({protocol:2,docToken:doc.token,applyId:applying.applyId,applied:false,reason:'not-applied',session:reply.session});
            }else{return;}
          }else{
            if(!doc.mirror || reply.session.epoch!==doc.mirror.session.epoch || reply.session.sourceRevision<doc.mirror.session.sourceRevision)return;
            const advanced=reply.session.sourceRevision>doc.mirror.session.sourceRevision;
            doc.mirror=mirrorOf(reply.text,reply.session,doc.token);doc.text=reply.text;doc.textFresh=true;doc.composing=!!reply.composing;
            if(advanced){doc.dirty=true;doc.editSeq++;saveStatus.update(true);}
            if(doc.dirty)checkpointRecovery(reply.text,reply.session,true);
            const queued=doc.gapDeltas;doc.gapDeltas=[];
            for(const delta of queued)acceptDelta(delta);
          }
          clearTimeout(pending.timer);doc.pulls.delete(reply.id);
          pending.resolve({text:doc.mirror?.continuous?materialize(doc.mirror):reply.text,stale:!!doc.pendingApply||doc.composing||!doc.mirror?.continuous,session:wireSession()});
          if(!doc.mirror?.continuous && !doc.pulls.size)void requestSnapshot('gap');
          if(doc.dead)persistCurrentRecovery();
        }


        function showPhase(phase, detail) {
          saveStatus.update(doc.dirty);
          doc.phase = phase;
          doc.detail = detail || "";
          if (phase !== "ready" && phase !== "dirty") doc.notice = "";
          setUiIfChanged({ phase: phase, detail: detail || "", notice: doc.notice });
        }
        function showError(message) {
          showPhase("error", message);
        }
        function showNotice(message) {
          if (!alive()) return;
          // Non-status feedback uses the existing bottom editor toast. It must
          // never replace or extend the top save acknowledgement.
          post("toast", message);
        }

        function writeRecovery(text, stale) {
          const slot = {
            text: typeof text === "string" ? text : doc.text,
            baseVersion: typeof doc.lastVersion === "string" ? doc.lastVersion : null,
            ts: Date.now(),
            path: doc.absPath,
            ...(stale ? { stale: true } : {}),
          };
          const ok = writeRecoverySlot(null, slot);
          if (!ok && typeof text === "string" && text.length > MAX_TEXT_CHARS) {
            showNotice("文档过大，关闭前恢复槽未写入；请先保存");
          }
        }

        function flushClose() {
          if (doc.flushed) return;
          doc.flushed = true; doc.closeUntil = Date.now() + FLUSH_WAIT_MS + 80;
          if (!doc.opened || !doc.absPath || !doc.dirty) return;
          persistCurrentRecovery();
          // The parent mirror survives iframe removal. Unknown/composing text
          // is recovery only; closing never promotes it to a disk write.
          if (!doc.mirror?.continuous) void requestSnapshot('close');
        }

        function pullText() {
          if (doc.pendingApply || doc.applyUnknown || doc.composing) return Promise.resolve({text:doc.text,stale:true});
          if (doc.mirror?.continuous) return Promise.resolve({text:materialize(doc.mirror),stale:false,session:{...doc.mirror.session}});
          return requestSnapshot('save');
        }

        function scheduleSave(delay) {
          if (doc.dead) return;
          if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
          doc.saveTimer = setTimeout(() => {
            doc.saveTimer = null;
            void runSave();
          }, typeof delay === "number" ? Math.max(0, delay) : SAVE_DEBOUNCE_MS);
        }

        async function saveUntitled() {
          if(!alive() || !doc.opened || doc.saving || doc.composing || doc.pendingApply || doc.applyUnknown)return;
          doc.saving=true;
          try {
            const seq=doc.editSeq, pulled=await pullText();
            if(pulled.stale || !alive())return;
            if(doc.firstSaveText===null) {
              const frozen={...doc.draft,firstSaveText:pulled.text};
              const entry={path:doc.absPath,address,workspace:doc.workspace,sessionId:doc.sessionId,draft:frozen};
              if(!pendingWorkspaceDraft({key:workspaceKey(doc.workspace)},entry))throw new Error("首次保存记录无法持久化，尚未创建文件");
              doc.draft=frozen;doc.firstSaveText=pulled.text;
              if(workbenchDoc?.address===address)workbenchDoc.draft=frozen;
            }
            const result=await api("docs/create",{dir:doc.draft.cwd,draftId:doc.draft.id,exactText:doc.firstSaveText});
            if(!alive())return;
            if(!result.ok){showError("保存失败："+(result.error?.message||"未知错误"));return;}
            if(!result.value?.version || (result.value.draftId && result.value.draftId!==doc.draft.id)) {
              showError("保存回执不完整，草稿已保留，请重试");return;
            }
            // The host resolves junctions/symlinks. Its request-path receipt preserves
            // the original ownership while the canonical path may differ.
            if(workspaceKey(result.value.requestedPath || result.value.path)!==workspaceKey(doc.absPath)){showError("保存路径不匹配，草稿已保留");return;}
            if(!pendingWorkspaceDraft({key:workspaceKey(doc.workspace)},null)) {
              showError("文件已创建，但本机草稿状态尚未确认；内容已保留，请再次保存。");return;
            }
            doc.lastVersion=result.value.version;doc.untitled=false;
            const clean=seq===doc.editSeq && pulled.text===doc.firstSaveText;
            doc.dirty=!clean; doc.firstSaveText=null;
            if(workbenchDoc?.address===address)delete workbenchDoc.draft;
            recordRecentDoc({path:doc.absPath,scope:"absolute"},doc.sessionId,doc.workspace);
            if(clean) {
              try {inspectStoreResult(await draftStore()?.markSaved?.({path:doc.absPath,docToken:doc.token,session:pulled.session,baseVersion:doc.lastVersion}));}
              catch(e) {if(alive())showNotice("恢复记录更新失败："+String(e));}
            }
            if(!alive())return;
            saveStatus.update(doc.dirty,!doc.dirty);showPhase(doc.dirty?"dirty":"ready","");startSse();
            if(doc.dirty)doc.saveQueued=true;
          } catch(e) {if(alive())showError("保存未确认，草稿已保留，请重试："+String(e?.message||e));}
          finally {
            doc.saving=false;
            if(alive() && !doc.untitled && (doc.saveQueued || doc.manualPending)) {
              doc.saveQueued=false; scheduleSave(0);
            }
          }
        }
        async function runSave(options) {
          const manual = !!(options && options.manual);
          if (doc.dead) return;
          // 有界预算耗尽后不再自动发保存请求（防持续竞争下无界后台唤醒）；
          // 显式保存（Ctrl+S）重置预算，输入改动只保留草稿等显式动作。
          if (doc.untitled) { if(manual) await saveUntitled(); return; }
          if (doc.liveStaleBlocked && !manual) return;
          if (doc.pendingApply || doc.applyUnknown || doc.composing) { if (manual) { doc.manualPending = true; post("toast", "请先完成输入或等待编辑器同步"); } return; }
          const gate = saveGate({
            dirty: doc.dirty,
            saving: doc.saving,
            baseVersion: doc.lastVersion,
            opened: doc.opened,
            dead: doc.dead,
          });
          if (gate.action === "queue") {
            doc.saveQueued = true;
            if (manual) {
              doc.manualPending = true;
              post("toast", "正在保存，完成后会保存最新改动");
            }
            return;
          }
          if (gate.action === "block") {
            showError("保存被拒绝：缺少基准版本（请重新打开文档）");
            if (manual) post("toast", "保存被拒绝：缺少基准版本");
            return;
          }
          if (gate.action !== "save") {
            if (manual && gate.reason === "clean") saveStatus.update(false, true);
            else if (manual) post("toast", "文档尚未就绪，暂不能保存");
            return;
          }
          const manualThisRun = manual || doc.manualPending;
          doc.manualPending = false;
          doc.saving = true;
          const saveSeq = doc.editSeq; // 保存飞行期间的新编辑靠它识别：宁可多存一轮，不许把脏标清掉
          if (doc.phase !== "dirty" && doc.phase !== "conflict") showPhase("saving", "保存中…");
          if (manualThisRun) showPhase("saving", "手动保存中…");
          try {
            for (let attempt = 1; ; attempt += 1) {
              if (doc.live) {
                const flushed = await flushLive();
                if (!alive()) return;
                if (!flushed.ok) {
                  if (["MP_LIVE_TIMEOUT", "MP_LIVE_GONE", "MP_LIVE_FLUSH", "MP_LIVE_COMPOSING", "MP_LIVE_SWITCH"].indexOf(flushed.code) !== -1) {
                    showError("保存暂停：编辑器未在 " + LIVE_FLUSH_TIMEOUT_MS + "ms 内确认同步（未写入磁盘，可继续编辑后重试）");
                    if (manualThisRun) post("toast", "保存暂停：编辑器未确认同步，未写入磁盘");
                  } else {
                    handleLiveError(flushed.code, flushed.error);
                  }
                  return;
                }
                if (!flushed.result) {
                  // API.md §1.3：未绑定时 flush resolve null（unbind/halt 后）——丢弃残票，
                  // 回落无票守卫保存（盘 CAS 仍在，绝不盲写）。
                  stopLive(true);
                } else {
                  doc.live.epoch = flushed.result.epoch;
                  doc.live.version = flushed.result.version;
                }
              }
              const pulled = await pullText();
              if (!alive()) return;
              if (pulled.stale) {
                showError("保存暂停：编辑器未在 " + PULL_TIMEOUT_MS + "ms 内返回全文（未写入磁盘，可继续编辑后重试）");
                if (manualThisRun) post("toast", "保存暂停：编辑器未返回全文，未写入磁盘");
                return;
              }
              const request = buildSaveRequest({ path: doc.absPath, text: pulled.text, baseVersion: doc.lastVersion,
                ...(doc.live ? { live: { client: doc.live.client, epoch: doc.live.epoch, version: doc.live.version } } : {}) });
              if (!request.ok) {
                showError("保存被拒绝：" + request.reason);
                if (manualThisRun) post("toast", "保存被拒绝：" + request.reason);
                return;
              }
              const result = await api("save", request.body);
              if (!alive()) return;
              if (result.ok === true) {
                const editedDuringSave = doc.editSeq !== saveSeq;
                doc.lastVersion = result.value.version;
                if (doc.live) doc.live = applyLiveReceipt(doc.live, result.value);
                try { Promise.resolve(draftStore()?.markSaved?.({path:doc.absPath,docToken:doc.token,session:pulled.session,baseVersion:doc.lastVersion})).then(inspectStoreResult).catch(e=>showNotice("恢复记录更新失败：" + String(e))); } catch (e) { showNotice("恢复记录更新失败：" + String(e)); }
                if (!editedDuringSave) {
                  doc.text = pulled.text;
                  doc.textFresh = true;
                  doc.mirror = mirrorOf(pulled.text, pulled.session, doc.token);
                  doc.dirty = false;
                } else {
                  doc.dirty = true;
                  doc.saveQueued = true;
                }
                doc.conflict = false;
                doc.externalStale = false;
                doc.staleNotified = false;
                doc.liveStaleRounds = 0;      // 保存成功 = 预算清零（下一轮竞争重新计数）
                doc.liveStaleBlocked = false;
                saveStatus.update(doc.dirty, !doc.dirty);
                showPhase(doc.dirty ? "dirty" : "ready", doc.dirty ? "编辑中…（上一轮已保存，继续保存新改动）" : "已保存");
                if (manualThisRun && doc.dirty) post("toast", "已保存；还有新改动，继续保存中…");
                // 保存飞行期间可能被外部改过：落盘后 stat 对账（live 会话交给房间刷新，干净非 live 才静默重载）。
                try {
                  const stat = await api("stat", { path: doc.absPath });
                  if (alive() && stat.ok === true && stat.value && stat.value.version !== doc.lastVersion) {
                    if (doc.live) post("live-refresh", { protocol: 2, docToken: doc.token });
                    else if (doc.dirty || doc.conflict) { doc.externalStale = true; }
                    else await loadFromDisk({ silent: true, reason: "save-reconcile" });
                  }
                } catch (e) { /* 对账失败不阻塞保存结果 */ }
                return;
              }
              // live 房间在 flush 与落盘之间又动了（对端新编辑）：交给纯决策函数。
              // API.md §4 MP_LIVE_STALE：**不 halt**——快重试→有界退避→停止（保草稿等显式
              // Ctrl+S）；换代/歧义替换/外盘冲突码不走这里，仍由 liveErrorAction 明确停。
              if (doc.live && result.error && result.error.code === "MP_LIVE_STALE") {
                const decision = liveStaleAction({ attempt, rounds: doc.liveStaleRounds, blocked: doc.liveStaleBlocked });
                doc.liveStaleRounds = decision.rounds;
                if (decision.action === "retry-immediate") continue;
                post("live-refresh", { protocol: 2, docToken: doc.token });   // 促 facade 立即消费对端增量
                if (decision.action === "retry-delayed") {
                  if (decision.rounds >= 2) showNotice("共享房间正在同步对端编辑，稍后自动重试（正文已保留）");
                  if (manualThisRun && decision.rounds >= 2) post("toast", "正在同步对端编辑，稍后自动重试保存");
                  scheduleSave(decision.delayMs);
                  return;
                }
                // stopped：有界预算耗尽，停止自动写请求（不无界后台唤醒），保草稿与 epoch，
                // 等用户显式动作（Ctrl+S → manualSave 重置预算）或输入触发新一轮。
                doc.liveStaleBlocked = true;
                showNotice("保存暂停：对端持续编辑中；正文已保留，按 Ctrl+S 手动保存或稍后继续编辑");
                if (manualThisRun) post("toast", "对端持续编辑中，请按 Ctrl+S 手动保存");
                return;
              }
              if (doc.live && result.error && liveErrorAction(result.error.code) === "conflict") {
                handleLiveError(result.error.code, result.error.message);
                return;
              }
              if (result.error && result.error.code === "FS_STALE_VERSION") {
                doc.conflict = true;
                showPhase("conflict", "文件已在别处被修改（" + (result.error.message || "FS_STALE_VERSION") + "）；版本守卫拒绝覆盖");
                if (manualThisRun) post("toast", "文件已在别处被修改，未覆盖；请先重载磁盘版本");
                return;
              }
              const message = (result.error && result.error.code ? result.error.code : "error") + " — " + (result.error && result.error.message ? result.error.message : "");
              showError("保存失败：" + message);
              if (manualThisRun) post("toast", "保存失败：" + message);
              return;
            }
          } catch (error) {
            if (alive()) {
              const message = String(error && error.message ? error.message : error);
              showError("保存失败：" + message);
              if (manualThisRun) post("toast", "保存失败：" + message);
            }
          } finally {
            doc.saving = false;
            const reload=doc.reloadAfterSave;doc.reloadAfterSave=null;
            if(reload && alive()){if(doc.editSeq===reload.editSeq)void loadFromDisk(reload.opts);else doc.externalStale=true;}
            if (doc.saveQueued && alive()) {
              doc.saveQueued = false;
              if (doc.manualPending) {
                doc.manualPending = false;
                void runSave({ manual: true });
              } else {
                scheduleSave(0);
              }
            }
          }
        }

        /**
         * 手动保存：iframe 内 Ctrl+S（引擎 keymap → bridge.mpHost.__save）与
         * 焦点在本 tab 壳上时的父窗口 Ctrl+S 都走这里。
         * 立即取消 1500ms 防抖并拉全文，但不绕过版本守卫；所有结果都给用户一条可见反馈。
         */
        function manualSave(content) {
          if (doc.dead) return;
          if(doc.untitled){void runSave({manual:true});return;}
          doc.liveStaleBlocked = false;   // 显式保存 = 重置 STALE 退避预算（只此显式入口重置）
          doc.liveStaleRounds = 0;
          const gate = manualSaveGate({
            dirty: doc.dirty,
            saving: doc.saving,
            conflict: doc.conflict,
            baseVersion: doc.lastVersion,
            opened: doc.opened,
            dead: doc.dead,
          });
          if (gate.action === "skip") return;
          if (gate.action === "clean") { saveStatus.update(false, true); return; }
          if (gate.action === "block") {
            if (gate.reason === "conflict") {
              showPhase("conflict", "文件已在别处被修改；版本守卫拒绝覆盖");
              post("toast", "文件已在别处被修改，未覆盖；请先重载磁盘版本");
            } else {
              showError("保存被拒绝：缺少基准版本（请重新打开文档）");
              post("toast", "保存被拒绝：缺少基准版本");
            }
            return;
          }
          if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
          if (gate.action === "queue") {
            doc.saveQueued = true;
            doc.manualPending = true;
            post("toast", "正在保存，完成后会保存最新改动");
            return;
          }
          void runSave({ manual: true });
        }


        async function loadFromDisk(options) {
          const opts = options || {};
          if (doc.dead || doc.pendingApply || doc.applyUnknown) return false;
          if (doc.saving) {doc.reloadAfterSave={opts:{...opts},editSeq:doc.editSeq};return false;}
          refreshPath();
          const editSeqAtStart = doc.editSeq;
          const loadSeq = ++doc.loadSeq, pathAtStart = doc.absPath, versionAtStart = doc.lastVersion;
          const ownsLoad = () => alive() && doc.loadSeq === loadSeq && doc.absPath === pathAtStart && doc.lastVersion === versionAtStart;
          try {
            // live:true 只在本机文件上会真正入房（宿主在 join 前核对原生文件与字节基线）；
            // 虚拟/会话投影文件拿不到 live 票，自动走原有单窗口守卫路径。
            let result;
            if (doc.untitled) {
              var recovery=await draftStore()?.readLatest?.(doc.absPath);
              result={ok:true,value:{text:typeof recovery?.text==="string" ? recovery.text : (doc.firstSaveText || ""),version:null,displayPath:doc.absPath,size:0}};
            } else result = await api("open", {path:pathAtStart, live:!doc.liveUnsupported});
            if (!ownsLoad()) return false;
            if (doc.opened && (doc.editSeq !== editSeqAtStart || doc.composing || (!opts.discard && (doc.dirty || doc.conflict)))) { doc.externalStale = true; return false; }
            if (result.ok !== true) { if (!opts.silent) showError("打开失败：" + (result.error?.message || result.error?.code || "error")); return false; }
            const value=result.value,firstOpen=!doc.opened;
            return await applyToFrame({kind:firstOpen?'open':'reload',value,firstOpen,opts,path:pathAtStart,baseVersion:versionAtStart,loadSeq,editSeq:editSeqAtStart});
          } catch(error) {
            if (!ownsLoad() || doc.editSeq !== editSeqAtStart) return false;
            if (!opts.silent) showError("打开失败：" + String(error?.message || error));
            return false;
          }
        }

        function syncAppearance() {
          if (alive()) post("appearance", editorAppearance());
        }
        cleanups.push(watchSettingsChanges(syncAppearance));
        syncAppearance();

        function maybeBoot() {
          if (!alive() || !doc.bridgeUp || !doc.editorReady || doc.opened || doc.booting) return;
          doc.booting = true;
          post("theme", { dark: isDarkTheme() });
          void loadFromDisk({}).finally(() => { doc.booting = false; });
        }

        function onDirty(content) {
          doc.dirty = true;
          saveStatus.update(true);
          doc.editSeq += 1;
          doc.textFresh = false;
          const len = content && typeof content === "object" && Number.isFinite(Number(content.len)) ? Number(content.len) : null;
          if (doc.phase !== "dirty" && doc.phase !== "conflict") {
            showPhase("dirty", len === null ? "编辑中…" : "编辑中…（" + len + " 字符）");
          } else if (doc.externalStale && !doc.staleNotified) {
            doc.staleNotified = true;
            showPhase("dirty", "编辑中…（磁盘已更新，保存时会冲突）");
          }
          scheduleSave(SAVE_DEBOUNCE_MS);
        }

        function onExternalEvent(event) {
          let data = {};
          try { data = JSON.parse(event.data) || {}; } catch (e) { data = {}; }
          if (data.path && doc.absPath && !samePath(data.path, doc.absPath)) return;
          if (!doc.opened) return; // 握手/首次 open 之前的事件没有落点（boot 自己会读磁盘）
          // live 会话：磁盘事件的采纳权在共享房间（external 写入会被 adopt 成房间更新），
          // 这里只催一次 refresh，绝不 loadFromDisk 覆盖共享草稿。
          if (doc.live) { post("live-refresh", { protocol: 2, docToken: doc.token }); return; }
          const version = data.version == null ? "" : String(data.version);
          const accepted = shouldAcceptExternal({
            dirty: doc.dirty,
            conflict: doc.conflict,
            saving: doc.saving,
            hidden: isDocumentHidden(),
            visible: doc.tabVisible,
          });
          if (!accepted) {
            if (!doc.externalStale) {
              doc.externalStale = true;
              if (doc.dirty && !doc.staleNotified) {
                doc.staleNotified = true;
                showPhase("dirty", "编辑中…（磁盘已更新，保存时会冲突）");
              }
            }
            return;
          }
          if (doc.phase === "conflict") { doc.externalStale = true; return; }
          if (doc.lastVersion && version && version === String(doc.lastVersion)) return;
          void loadFromDisk({ silent: true, reason: "sse" });
        }

        function clearPoll() {
          if (doc.pollTimer) { clearTimeout(doc.pollTimer); doc.pollTimer = null; }
        }

        function schedulePoll(delay) {
          clearPoll();
          if (doc.dead) return;
          const wait = typeof delay === "number"
            ? delay
            : nextPollDelay({ healthy: doc.esHealthy, failures: doc.pollFailures, hidden: isDocumentHidden() });
          if (wait === null) return;
          doc.pollTimer = setTimeout(pollOnce, wait);
        }

        function pollOnce() {
          doc.pollTimer = null;
          if (doc.dead) return;
          // 页面隐藏 = 暂停轮询（visibilitychange 恢复）；后台 tab = 降频，回到前台会立刻补一轮。
          if (isDocumentHidden()) return;
          if (doc.tabVisible === false) { schedulePoll(POLL_SLOW_MS); return; }
          if (doc.esHealthy) { schedulePoll(POLL_SLOW_MS); return; }
          if (doc.dirty || doc.conflict || doc.saving || !doc.opened || !doc.lastVersion) {
            doc.pollFailures = Math.min(3, doc.pollFailures + 1);
            schedulePoll(nextPollDelay({ healthy: false, failures: doc.pollFailures, hidden: false }));
            return;
          }
          api("stat", { path: doc.absPath }).then((result) => {
            if (doc.dead) return;
            if (result.ok === true && result.value && String(result.value.version) !== String(doc.lastVersion)) {
              void loadFromDisk({ silent: true, reason: "poll" });
            }
          }).catch(() => { /* 轮询失败静默，下轮重试 */ }).finally(() => {
            if (doc.dead) return;
            doc.pollFailures = Math.min(3, doc.pollFailures + 1);
            schedulePoll(nextPollDelay({ healthy: doc.esHealthy, failures: doc.pollFailures, hidden: isDocumentHidden() }));
          });
        }

        function startSse() {
          if(doc.untitled)return;
          if (typeof EventSource !== "function") { schedulePoll(POLL_FAST_MS); return; }
          try {
            const es = new EventSource(API_BASE + "watch?path=" + encodeURIComponent(doc.absPath));
            doc.es = es;
            es.addEventListener("open", () => {
              if (doc.dead) return;
              doc.esHealthy = true;
              doc.pollFailures = 0;
              clearPoll();
            });
            es.addEventListener("change", (event) => {
              doc.esHealthy = true;
              doc.pollFailures = 0;
              onExternalEvent(event);
            });
            es.onerror = () => {
              if (doc.dead) return;
              doc.esHealthy = false;
              schedulePoll(POLL_FAST_MS);
            };
          } catch (e) {
            schedulePoll(POLL_FAST_MS);
          }
        }

        async function onInsertToChat(content) {
          const text = typeof content === "string"
            ? content
            : (content && typeof content.text === "string" ? content.text : "");
          if (!text) return;
          // 用户口径：选中→对话的内容开头永远带文档绝对路径（显示路径优先）。
          const sourcePath = doc.displayPath || doc.absPath || doc.path || "";
          const payload = composeInsertionText(sourcePath, text);
          // 用户口径：工具条/面板上的动作一律**直接发给模型**。
          // 浮层编辑器没有 composer 的 inputActions（那是右侧栏 tab 才有的），
          // 所以那条路走宿主的 sessions 服务直发（worktable 同款），而不是复制到剪贴板。
          const wantSend = !!(content && content.send === true);
          // 优先用官方 provide 通道的动作面（浮层、侧栏 tab 都能拿到），其次才是 tab props 那份。
          const recipient = workspaceContext().sessionId || doc.sessionId;
          const acts0 = inputFaceOf(recipient) || (recipient===doc.sessionId ? inputActionsRef.current : null);
          const canCompose = !!(acts0
            && typeof acts0.captureInsertion === "function"
            && typeof acts0.insertText === "function");
          if (!canCompose) {
            // 浮层编辑器没有 composer 句柄：先真的写进宿主输入框（用户看得见），
            // 要发送就再触发一次发送；写不进去才退到 sessions 直发。
            const wrote = false; // No asynchronous DOM fallback across session navigation.
            if (!alive()) return;
            if (wrote) {
              if (wantSend) {
                const sent = await submitComposer();
                if (!alive()) return;
                post("toast", sent ? "已提交发送" : "已写入输入框");
                showNotice(sent ? "已提交发送" : "已写入输入框");
                return;
              }
              post("toast", "已插入到输入框");
              showNotice("已插入到输入框");
              return;
            }
            if (wantSend) {
              const direct = await sendViaHostSession(recipient, payload);
              if (!alive()) return;
              if (direct.ok) {
                post("toast", "已发送给 AI");
                showNotice("已发送给 AI");
                return;
              }
              log.warn?.("dsh-markdown-typora: 直发失败：%s", String(direct.reason || "unknown"));
            }
          }
          const outcome = await insertSelectionToChat(acts0, payload, {
            clipboard: clipboardOf(),
          });
          if (!alive()) return;
          // 工具条动作一律直接发送（content.send === true）
          let submitted = false;
          if (outcome.ok && wantSend && acts0 && typeof acts0.submit === "function") {
            try { acts0.submit(); submitted = true; } catch (e) { /* 保留已插入的内容 */ }
          }
          if (outcome.ok) {
            post("toast", submitted ? "已提交发送" : "已插入到输入框");
            showNotice(submitted ? "已提交发送" : "已插入到输入框");
          } else if (outcome.method === "clipboard") {
            post("toast", "输入框暂不可用，内容已复制");
            showNotice("输入框暂不可用，内容已复制");
          } else {
            post("toast", "插入失败：编辑框不可用，复制也失败");
            showNotice("插入失败：编辑框不可用，复制也失败");
          }
        }

        function onMessage(event) {
          const data = event && event.data;
          if (!isUpEnvelope(data)) return;
          const liveWin = doc.win || currentFrameWin();
          if (!liveWin || event.source !== liveWin) return; // 只认当前代 iframe，旧 iframe 的晚到消息丢弃
          const type = data.type;
          // 已死代际只放行"关 tab flush 的 text 回执"（旧回执一律丢弃）。
          if (!alive() && !(doc.closeUntil >= Date.now() && ["text","document-delta","composition","apply-result","live-exchange","live-leave","live-flush-result"].includes(type))) return;
          // 编辑器 iframe 的右沿热区：拖动量上行到这里改对话宽度
          if (type === "chat-resize") {
            var rz = data.content || {};
            var eng0 = handleState.engine;
            if (eng0) {
              if (rz.phase === "start") {
                var snapW = eng0.snapshot ? eng0.snapshot() : null;
                chatHandleState.startW = (snapW && snapW.chatW) || 420;
              } else {
                // 上限按"当前可用列宽"算，否则会拖出一个宽到放不下的对话列（编辑区被压没、对话内容溢出）
                var rootEl1 = findConversationRoot(doc);
                var rectNow = rootEl1 ? rootEl1.getBoundingClientRect() : null;
                var hiW = rectNow ? Math.max(LAYOUT_MIN_CHAT, Math.round(rectNow.width) - 240) : 900;
                var nextW = Math.round(layoutClamp(chatHandleState.startW - (Number(rz.dx) || 0), LAYOUT_MIN_CHAT, Math.min(900, hiW)));
                eng0.updateCfg({ chatWidth: nextW });
                // 必须走统一的 layoutReapply（apply + observe + 阶段几何），
                // 只调 apply() 时舞台宽度会滞后 —— 表现为"编辑区撑满、对话列跑出屏幕"。
                try {
                  if (rz.phase === "end") {
                    if (typeof layoutReapply === "function") layoutReapply();
                    else eng0.apply();
                  } else if (typeof layoutReapply === "function") scheduleLayout();
                  else if (eng0.requestApply) eng0.requestApply();
                } catch (e0) { /* 忽略 */ }
                if (rz.phase === "end") {
                  try { writeSettings(window.localStorage, { chatWidth: nextW }); } catch (e1) { /* 无存储 */ }
                }
              }
            }
            return;
          }
          if (type === "apply-result") { onApplyResult(data.content); return; }
          if (type === "document-delta") { onDelta(data.content); return; }
          if (type === "composition") { onComposition(data.content); return; }
          if (type === "live-exchange") { void relayLiveExchange(data.content); return; }
          if (type === "live-leave") {
            const client = data.content && data.content.client;
            if (typeof client === "string" && client) api("live", { client: client, action: "leave" }).catch(function () { /* 已过期 */ });
            return;
          }
          if (type === "live-flush-result") {
            const content = data.content || {};
            const waiter = doc.liveFlushWaiters.get(content.id);
            if (waiter) {
              doc.liveFlushWaiters.delete(content.id);
              waiter.resolve(content.ok === true
                ? { ok: true, result: content.result }
                : { ok: false, code: content.code || "MP_LIVE_FLUSH", error: content.error || "同步失败" });
            }
            return;
          }
          if (type === "live-error") {
            const content = data.content || {};
            handleLiveError(content.code, content.error || content.message);
            return;
          }
          if (type === "live-status") {
            const content = data.content || {};
            const status = content.status;
            if (alive() && status && typeof status === "object") {
              doc.liveStatus = status;
              if (doc.live && status.client) {
                if (typeof status.epoch === "string" && status.epoch) doc.live.epoch = status.epoch;
                if (Number.isSafeInteger(status.version)) doc.live.version = status.version;
                if (Number.isSafeInteger(status.savedVersion)) doc.live.savedVersion = status.savedVersion;
                if (typeof status.diskHash === "string" && status.diskHash) doc.live.diskHash = status.diskHash;
                // API.md §3.2 消脏唯一条件：version===savedVersion && pending===0 && error==null。
                // onStatus 为 null / client 未分配 / 会话错误 / 本端还有 pending / 镜像有缺口
                // （含应用未确认、保存飞行中）时绝不消脏；savedVersion 前进本身不消脏。
                if (doc.dirty && !doc.pendingApply && !doc.applyUnknown && !doc.composing && !doc.saving
                  && doc.mirror && doc.mirror.continuous && !doc.gapDeltas.length
                  && status.error == null && !status.conflict && status.pending === 0
                  && Number.isSafeInteger(status.savedVersion) && status.version === status.savedVersion) {
                  doc.dirty = false;
                  if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
                  saveStatus.update(false, true);
                  if (doc.phase === "dirty") showPhase("ready", "已同步保存");
                }
              }
            }
            return;
          }
          if (type === "bridge-ready") {
            syncAppearance();
            if (doc.bridgeUp) return;
            doc.bridgeUp = true;
            post("theme", { dark: isDarkTheme() });
            maybeBoot();
            return;
          }
          if (type === "init") {
            syncAppearance();
            doc.editorReady = true;
            if (data.content && data.content.again === true && doc.pendingApply) {
              post(doc.pendingApply.firstOpen ? "open" : "setValue",doc.pendingApply.wire);
              return;
            }
            maybeBoot();
            return;
          }
          if (type === "change") { if (!doc.mirror && !doc.pendingApply) onDirty(data.content); return; }
          if (type === "manual-save") { manualSave(data.content); return; }
          if (type === "text") { onSnapshot(data.content); return; }
          if (type === "insert-to-chat") { void onInsertToChat(data.content); return; }
          if (type === "host-invoke") { handleHostInvoke(data.content, post); return; }
          if (type === "openLink" && data.content) {
            try { window.open(String(data.content), "_blank", "noopener"); } catch (e) { /* 拦截器拒绝 */ }
            return;
          }
          // scroll / img / media-command 等：MVP 静默（协议 v1 无对应能力）。
        }

        async function restoreRecovery() {
          const slot=doc.recovery;
          if (!slot || typeof slot.text!=="string" || doc.pendingApply || doc.applyUnknown) return false;
          return applyToFrame({kind:'restore',value:{text:slot.text,version:doc.lastVersion,displayPath:doc.displayPath,size:slot.text.length},firstOpen:false,opts:{},path:doc.absPath,baseVersion:doc.lastVersion,loadSeq:doc.loadSeq,editSeq:doc.editSeq,recoverySlot:slot});
        }

        function discardRecovery() {
          const slot=doc.recovery;doc.recovery=null;
          clearRecoverySlot(null,doc.absPath);
          try{Promise.resolve(draftStore()?.clear?.(doc.absPath,slot?.docToken||doc.token,slot?.session)).catch(error=>showNotice('清除恢复记录失败：'+String(error)));}catch(error){showNotice('清除恢复记录失败：'+String(error));}
          setUiIfChanged({phase:'ready',detail:'已丢弃恢复内容',notice:'',recovery:null});
          return Promise.resolve();
        }

        async function copyMine() {
          const pulled = await pullText();
          if (!alive()) return;
          const text = pulled.stale ? doc.text : pulled.text;
          try {
            const clipboard = clipboardOf();
            if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard unavailable");
            await clipboard.writeText(text);
            post("toast", "已复制当前编辑内容");
            showPhase("conflict", "已复制当前编辑内容；磁盘版本未覆盖");
          } catch (error) {
            post("toast", "复制失败：" + String(error && error.message ? error.message : error));
          }
        }

        function forceReload() {
          stopLive(true);   // 冲突后重载 = 放弃旧房间，重新 join
          setUiIfChanged({ phase: "loading", detail: "", notice: "" });
          void loadFromDisk({ silent: false, discard: true }).then(loaded => {
            if (!loaded && alive() && (doc.dirty || doc.conflict)) {
              showPhase("conflict", "未重载，当前编辑内容已保留；可再次重载磁盘版本");
            }
          });
        }

        // 横幅按钮回调（渲染侧通过 st.actions 取当前代）。
        st.actions = {
          reloadDisk: forceReload,
          copyMine: copyMine,
          restoreRecovery: restoreRecovery,
          discardRecovery: discardRecovery,
          copyRecoveredPath: (index) => {
            const items = doc.liveRecoveredItems || [];
            const item = items[index];
            if (!item) return;
            // 只把路径写入剪贴板（web shell 既有能力）；不读取、不打开该文件。
            const clipboard = clipboardOf();
            if (!clipboard || typeof clipboard.writeText !== "function") { showNotice("剪贴板不可用，请手动选择复制路径"); return; }
            clipboard.writeText(item.recoveryPath).then(
              () => showNotice("已复制草稿副本路径：" + item.recoveryPath),
              (error) => showNotice("复制失败：" + String(error && error.message || error)),
            );
          },
          dismissRecovered: () => {
            doc.liveRecoveredItems = null;
            setUi((prev) => (prev.recovered ? { ...prev, recovered: null } : prev));
          },
          retry: () => { if(doc.pendingApply || doc.applyUnknown){void requestSnapshot("apply");return;} if (doc.live) stopLive(true); showPhase("loading", ""); void loadFromDisk({ silent: false }); },
        };
        doc.reload = (opts) => loadFromDisk(opts || {});
        doc.reloadDisk = forceReload;
        doc.copyMine = copyMine;

        window.addEventListener("message", onMessage);
        const disposeMessage = () => { try { window.removeEventListener("message", onMessage); } catch (e) { /* 忽略 */ } };

        /* 焦点在 iframe 内时，Ctrl+S 由引擎 keymap 处理；焦点在 tab 壳、其它面板
         * 甚至对话输入框时，父窗口在捕获阶段兜住并保存当前可见的 Markdown tab，
         * 同时 preventDefault，避免浏览器弹“保存网页/HTML”。用户口径：只要这个
         * 文档 tab 打开着，不论当前焦点在不在编辑区，Ctrl+S 都应保存文档。 */
        const onManualShortcut = (event) => {
          if (!event || event.defaultPrevented || event.isComposing) return;
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
          if (String(event.key || "").toLowerCase() !== "s") return;
          if (doc.dead || doc.tabVisible === false) return;
          event.preventDefault();
          event.stopPropagation();
          manualSave({ source: "shortcut" });
        };
        try {
          window.addEventListener("keydown", onManualShortcut, true);
          cleanups.push(() => { try { window.removeEventListener("keydown", onManualShortcut, true); } catch (e) { /* 忽略 */ } });
        } catch (e) { /* 无 window（测试环境） */ }

        // 主题：只观察 body 的 data-ds-dark-theme 属性（不做 DOM 树观察）。
        let themeObserver = null;
        try {
          if (typeof MutationObserver === "function" && document.body) {
            themeObserver = new MutationObserver(() => { post("theme", { dark: isDarkTheme() }); });
            themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
          }
        } catch (error) { themeObserver = null; }

        const onVisibilityChange = () => {
          if (doc.dead) return;
          if (isDocumentHidden()) { clearPoll(); return; }
          // API.md §1.5：窗口重新获焦 → 立即增量交换（不是全文轮询）。
          if (doc.live) post("live-refresh", { protocol: 2, docToken: doc.token });
          schedulePoll(0);
          if (doc.opened && doc.externalStale && !doc.dirty && !doc.conflict && !doc.saving && doc.tabVisible !== false) {
            doc.externalStale = false;
            void loadFromDisk({ silent: true, reason: "visible" });
          }
        };
        try {
          document.addEventListener("visibilitychange", onVisibilityChange);
          cleanups.push(() => { try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (e) { /* 忽略 */ } });
        } catch (e) { /* 无 document（测试环境） */ }

        // tab 关闭/替换：signal 在记录移除时 abort，比 React 卸载更早，留出 requestText 的窗口。
        const tabSignal = tab && tab.signal;
        try {
          if (tabSignal && typeof tabSignal.addEventListener === "function") {
            const onAbort = () => { try { flushClose(); } catch (e) { /* 最后一搏失败不阻塞关闭 */ } };
            tabSignal.addEventListener("abort", onAbort, { once: true });
            cleanups.push(() => { try { tabSignal.removeEventListener("abort", onAbort); } catch (e) { /* 忽略 */ } });
          }
        } catch (e) { /* 旧宿主无 signal */ }

        startSse();

        return () => {
          doc.dead = true;
          try { flushClose(); } catch (e) { /* 已尽力 */ }
          // live 会话离场：先请 facade 解绑（iframe 还在时经上行 leave），再直接向宿主
          // 补一张 leave（幂等）兜底 iframe 已删的情形 —— 租约不落盘、不残留。
          try { stopLive(true); } catch (e) { /* 关闭路径不再抛 */ }
          if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
          if (doc.pendingApply) { clearTimeout(doc.pendingApply.timer); doc.pendingApply.resolve?.(false); doc.pendingApply.resolve=null; }
          if (doc.pollTimer) { clearTimeout(doc.pollTimer); doc.pollTimer = null; }
          // A pending close flush owns its deadline after React unmount. Its
          // timeout must still persist the cached recovery when the iframe is gone.
          if (doc.es) { try { doc.es.close(); } catch (e) { /* 已断 */ } doc.es = null; }
          if (themeObserver) { try { themeObserver.disconnect(); } catch (e) { /* 已断 */ } }
          for (let i = 0; i < cleanups.length; i += 1) {
            try { cleanups[i](); } catch (e) { /* 忽略 */ }
          }
          // 先移除 message 监听再拉全文 = 永远拿不到回执（LOG-3.3.8 已知缺口）；这里留到 flush 结束。
          if (doc.closeUntil) setTimeout(() => { disposeMessage(); try { Promise.resolve(draftStore()?.release?.({path:doc.absPath,docToken:doc.token})).then(inspectStoreResult).catch(()=>{}); } catch(e){} }, FLUSH_WAIT_MS + 80);
          else disposeMessage();
          openDocs.delete(doc.sessionId + "\n" + doc.absPath);
          if (st.doc === doc) st.doc = null;
          st.actions = {};
        };
      }, [depKey]);

      /* ── tab 可见性变化：后台期间暂停覆盖，回到前台再决定重载 ── */
      React.useEffect(() => {
        const doc = st.doc;
        if (!doc) return;
        doc.tabVisible = tabVisible;
        if (tabVisible && doc.externalStale && !doc.dirty && !doc.conflict && !doc.saving) {
          doc.externalStale = false;
          if (typeof doc.reload === "function") void doc.reload({ silent: true, reason: "visible" });
        }
      }, [tabVisible]);

      if (!parsed) {
        return h("div", { style: emptyStyle }, "dsh-markdown-typora: 无法解析文件地址 " + String(address == null ? "" : address));
      }

      let banner = null;
      if (ui.phase === "conflict") {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "⚠ " + ui.detail),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.reloadDisk && st.actions.reloadDisk(); } catch (e) { /* 忽略 */ } } }, "重载磁盘版本"),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.copyMine && st.actions.copyMine(); } catch (e) { /* 忽略 */ } } }, "复制我的内容"));
      } else if (ui.phase === "recovery" && ui.recovery) {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "检测到上次关闭时未保存的内容（" + new Date(ui.recovery.ts || Date.now()).toLocaleString() + "）"),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.restoreRecovery && st.actions.restoreRecovery(); } catch (e) { /* 忽略 */ } } }, "恢复"),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.discardRecovery && st.actions.discardRecovery(); } catch (e) { /* 忽略 */ } } }, "丢弃"));
      } else if (ui.phase === "error") {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "✗ " + ui.detail),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.retry && st.actions.retry(); } catch (e) { /* 忽略 */ } } }, "重试"));
      } else if (ui.phase === "loading") {
        banner = h("div", { style: bannerStyle(false) }, "正在加载文档…");
      } else {
        // Only save state appears at the top. Actionable banners above keep
        // priority; their actions and the independent recovered banner survive.
        const saveText = ui.saveStatus === "unsaved" ? "未保存" : ui.saveStatus === "saved" ? "已保存" : "";
        banner = saveText ? h("div", { style: toastStyle, "data-mp-save-status": ui.saveStatus, role: "status" }, saveText) : null;
      }

      /* recovered：join 票带回的草稿副本提示（独立于 phase；按票一次；只展示+复制路径，
       * 不读取/不打开这些文件；不经 SSE、不影响其它文档 tab）。 */
      let recoveredBanner = null;
      if (ui.recovered && ui.recovered.length) {
        recoveredBanner = h("div", { style: bannerStyle(true), flexDirection: "column", alignItems: "stretch" },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("span", null, "♻ 该文件存在共享会话恢复的草稿副本（原件未被覆盖）："),
            h("button", { style: btnStyle, onClick: () => { try { st.actions.dismissRecovered && st.actions.dismissRecovered(); } catch (e) { /* 忽略 */ } } }, "知道了")),
          ...ui.recovered.map((item, index) => h("div", { key: item.recoveryPath + ":" + index, style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("code", { style: { userSelect: "all", wordBreak: "break-all", fontSize: 11 } }, item.recoveryPath),
            item.at ? h("span", { style: { opacity: 0.65, fontSize: 11 } }, new Date(item.at).toLocaleString()) : null,
            h("button", { style: btnStyle, onClick: () => { try { st.actions.copyRecoveredPath && st.actions.copyRecoveredPath(index); } catch (e) { /* 忽略 */ } } }, "复制路径"))));
      }

      const frameName = "dsh-markdown-typora-" + String((tab && (tab.id || tab.occurrenceId)) || "tab");
      // position:relative —— 让轻提示(toastStyle)能绝对定位悬浮，不占布局高度。
      return h("div", { ref: rootRef, style: { position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 } },
        banner,
        recoveredBanner,
        h("iframe", {
          key: depKey,
          ref: frameRef,
          name: frameName,
          src: FRAME_SRC,
          allowFullScreen: true,
          // 同源整装：内容是插件自带的可信 renderer（非第三方文档），需要 localStorage（主题/偏好）。
          sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
          onLoad: () => {
            const win = frameRef.current ? frameRef.current.contentWindow : null;
            const current = st.doc;
            // 只有"这一代的 iframe"才写入 doc.win：旧 iframe 的 load 晚到不得覆盖新文档的窗口。
            if (current && current.key === depKey) current.win = win;
            if (win) {
              try {
                win.postMessage({ __dshmd: true, dir: "down", type: "theme", content: { dark: isDarkTheme() } }, "*");
                win.postMessage({ __dshmd: true, dir: "down", type: "appearance", content: editorAppearance() }, "*");
              } catch (e) { /* 尚未就绪 */ }
            }
          },
          style: { width: "100%", height: "100%", border: 0, flex: 1, background: "transparent" },
        }));
    }

    /* ───────────────────────── @mp 引用源（可失败，不阻塞主功能） ───────────────────────── */

    function registerMpSource(ctx, hooks) {
      const log = hooks.log;
      try {
        if (typeof ctx.inject !== "function") return;
        ctx.inject(["inputTriggers"], (scope) => {
          try {
            const triggers = scope.inputTriggers || (scope.get && scope.get("inputTriggers"));
            if (!triggers || typeof triggers.registerSource !== "function") {
              log.warn?.("dsh-markdown-typora: inputTriggers unavailable, @mp source not registered");
              return;
            }
            const sidebarRight = (() => { try { return scope.get ? scope.get("sidebarRight") : undefined; } catch (e) { return undefined; } })();
            const source = {
              trigger: "@",
              name: "mp",
              async candidates(_session, context) {
                const query = String((context && context.query) || "").toLowerCase();
                const rows = [];
                for (const item of openDocs.values()) {
                  if (query && item.basename.toLowerCase().indexOf(query) === -1 && item.path.toLowerCase().indexOf(query) === -1) continue;
                  rows.push({
                    label: item.basename,
                    name: "mp",
                    description: "Markdown 编辑面打开的文档",
                    value: JSON.stringify({ kind: "mp", path: item.path, sessionId: item.sessionId }),
                  });
                }
                return rows;
              },
              onPick({ candidate }) {
                let value = null;
                try { value = JSON.parse(candidate.value); } catch (e) { value = null; }
                if (!value || value.kind !== "mp") return undefined;
                return {
                  insert: {
                    source: "mp",
                    ref: '@mp "' + value.path + '"',
                    label: basenameOf(value.path),
                    appearance: "file",
                    clipboardText: value.path,
                  },
                };
              },
              openReference(session, refData) {
                try {
                  if (!sidebarRight) return false;
                  const ref = String((refData && refData.ref) || "");
                  const path = ref.replace(/^@mp\s*"?/, "").replace(/"$/, "");
                  if (!path) return false;
                  sidebarRight.openResource(encodeFileAddress(session.sessionId, path));
                  return true;
                } catch (e) {
                  return false;
                }
              },
            };
            if (typeof scope.effect === "function") scope.effect(() => triggers.registerSource(source), "dsh-markdown-typora: @mp source");
            else triggers.registerSource(source);
            try { if (window.__DSH_MARKDOWN__) window.__DSH_MARKDOWN__.mpSourceRegistered = true; } catch (e) { /* 诊断位 */ }
            log.info?.("dsh-markdown-typora: @mp source registered");
          } catch (error) {
            log.warn?.("dsh-markdown-typora: @mp source inner failed: %s", String(error && error.message ? error.message : error));
          }
        });
      } catch (error) {
        log.warn?.("dsh-markdown-typora: @mp source failed: %s", String(error && error.message ? error.message : error));
      }
    }

    /* ───────────────────────── 插件入口 ───────────────────────── */

    const inject = ["slots", "sidebarRight", "sessions", "layout"];   // sidebarRight 打开文档；sessions 直发；layout 面板导航（未声明时 ctx.get 拿不到）

    function apply(ctx) {
    // Retire an older factory before mounting its replacement. Late disposal of
    // that older context is harmless because each disposer is idempotent.
    try { if (typeof window.__mpLayoutDispose === "function") window.__mpLayoutDispose(); } catch (e) { /* 忽略 */ }
    try { if (typeof window.__mpHandleLifecycleDispose === "function") window.__mpHandleLifecycleDispose(); } catch (e) { /* 忽略 */ }
    try { if (typeof window.__mpHandleFloorDispose === "function") window.__mpHandleFloorDispose(); } catch (e) { /* 忽略 */ }
    try { installHandleLifecycle(ctx); } catch (e) { /* 忽略 */ }
    // 布局引擎（M0）：默认关闭，只在用户显式开启时挤压对话。
    // 失败绝不影响插件其余能力（mountLayout 内部已 try/catch + 日志）。
    try { mountLayout(ctx); } catch (e) { /* 见 mountLayout */ }
      const log = (() => {
        try { return typeof ctx.logger === "function" ? ctx.logger("dsh-markdown-typora") : console; } catch (e) { return console; }
      })();
      const get = (name) => {
        try { return ctx.get(name); } catch (e) { return undefined; }
      };
      const runEffect = (fn, label) => {
        try {
          if (typeof ctx.effect === "function") ctx.effect(fn, label);
          else fn();
        } catch (error) {
          log.warn?.("dsh-markdown-typora: effect failed (%s): %s", label, String(error && error.message ? error.message : error));
        }
      };

      // DSH 0.2.2 adds will-change:transform to the sticky composer seat.
      // balance-dsh positions its fixed pill in viewport coordinates; retain
      // that coordinate system without changing its sizing or usage logic.
      runEffect(() => {
        if (typeof document === "undefined" || !document.createElement) return;
        const id = "mp-composer-compat-style";
        const old = document.getElementById(id);
        if (old) old.remove();
        const style = document.createElement("style");
        style.id = id;
        style.textContent = "[data-composer-seat]:has(.balance-float){will-change:auto!important}";
        (document.head || document.documentElement).appendChild(style);
        return () => { style.remove(); };
      }, "dsh-markdown-typora: composer compatibility");

      let tabTypeRegistered = false;
      const registerTabType = (tabs) => {
        if (tabTypeRegistered) return;
        if (!tabs || typeof tabs.register !== "function") {
          log.warn?.("dsh-markdown-typora: sidebarRightTabs.register unavailable, tab type not registered");
          return;
        }
        try {
          runEffect(() => tabs.register(buildTabDefinition()), "dsh-markdown-typora: tab type");
          tabTypeRegistered = true;
          log.info?.("dsh-markdown-typora: tab type registered");
        } catch (error) {
          log.warn?.("dsh-markdown-typora: tab type failed: %s", String(error && error.message ? error.message : error));
        }
      };

      // ① tab 类型：服务可能晚于本插件 apply 注册 —— get 优先，缺失时用 ctx.inject 等待就绪。
      try {
        const tabs = get("sidebarRightTabs");
        if (tabs) {
          registerTabType(tabs);
        } else if (typeof ctx.inject === "function") {
          ctx.inject(["sidebarRightTabs"], (scope) => {
            try { registerTabType(scope.sidebarRightTabs || (scope.get && scope.get("sidebarRightTabs"))); }
            catch (error) { log.warn?.("dsh-markdown-typora: tab type late registration failed: %s", String(error && error.message ? error.message : error)); }
          });
        } else {
          log.warn?.("dsh-markdown-typora: sidebarRightTabs unavailable, tab type not registered");
        }
      } catch (error) {
        log.warn?.("dsh-markdown-typora: tab type seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ② tab body：只有这一个入口渲染 iframe（引擎在 iframe 内，宿主不订阅文档文本）。
      try {
        if (ctx.slots && typeof ctx.slots.inject === "function") {
          runEffect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: TAB_TYPE_ID,
          }, EditorTabBody)), "dsh-markdown-typora: tab body");
        } else if (ctx.slots && typeof ctx.slots.register === "function") {
          runEffect(() => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE_ID }, EditorTabBody), "dsh-markdown-typora: tab body");
        } else {
          log.warn?.("dsh-markdown-typora: slots service unavailable, tab body not registered");
        }
      } catch (error) {
        log.warn?.("dsh-markdown-typora: tab body seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ②-b 会话输入面守卫：dock 是列表槽位，旁路读取，不接管宿主 composer。
      //      标准 props 含 inputActions。组件返回 null，只为把那份动作面收进模块级表。
      try {
        if (ctx.slots && typeof ctx.slots.inject === "function") {
          runEffect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
            name: "conversation.composer.dock",
            id: "dsh-markdown-typora-input-face",
            order: 900,
          }, InputFaceTap)), "dsh-markdown-typora: input face tap");
        }
      } catch (error) {
        log.warn?.("dsh-markdown-typora: input face tap seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ③ M1 浮层舞台：编辑器的唯一挂载点。布局开关关闭时组件返回 null，不产生任何影响。
      try {
        if (ctx.slots && typeof ctx.slots.inject === "function") {
          runEffect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-markdown-typora-stage",
            order: 90,
          }, EditorOverlayStage)), "dsh-markdown-typora: overlay stage");
        } else {
          log.warn?.("dsh-markdown-typora: slots.inject unavailable, overlay stage not registered");
        }
      } catch (error) {
        log.warn?.("dsh-markdown-typora: overlay stage seed failed: %s", String(error && error.message ? error.message : error));
      }

      docsCtx = ctx;
      // sidebarRight 服务：get 优先，缺失时用 ctx.inject 等待就绪（tab 类型注册同款模式）。
      try {
        var directSr = get("sidebarRight");
        if (directSr) hostSidebarRight = directSr;
      } catch (e) { /* 忽略 */ }
      if (!hostSidebarRight && typeof ctx.inject === "function") {
        try {
          ctx.inject(["sidebarRight"], (scope) => {
            try { hostSidebarRight = scope.sidebarRight || (scope.get && scope.get("sidebarRight")) || null; }
            catch (e) { /* 忽略 */ }
          });
        } catch (e) { /* 忽略 */ }
      }

      // 诊断：哪些宿主服务在插件上下文里真的可达（决定 openResource 能不能用）。
      try {
        window.__MP_SVC = {};
        ["sidebarRight", "sidebarRightTabs", "layout", "sessions", "uiSession", "uiWorkspace", "session"].forEach(function (n) {
          try {
            var v = ctx.get(n);
            window.__MP_SVC[n] = v ? (typeof v) + (typeof v.openResource === "function" ? ":openResource" : "") : null;
          } catch (e) { window.__MP_SVC[n] = "throw"; }
        });
      } catch (e) { /* 忽略 */ }

      // ④ 左栏入口（探针）：sidebar.panellist 出图标，main 出页面。
      //    注意：这两个 slot 由宿主声明，缺失时 inject 静默无效 —— 所以下面写诊断位，便于确认到底有没有注册上。
      try {
        runEffect(() => ctx.slots.inject("sidebar.panellist", () => {
          var dispose = ctx.slots.register({
            name: "sidebar.panellist",
            id: DOCS_PANEL_ID,
            order: 35,
            label: "Markdown",
          }, DocsPanelIcon);
          try {
            window.__MP_DOCS_ENTRY = { registered: true, id: DOCS_PANEL_ID, hasDisposer: typeof dispose === "function" };
            log.info?.("dsh-markdown-typora: sidebar.panellist entry registered");
          } catch (e) { /* 忽略 */ }
          return dispose;
        }), "dsh-markdown-typora: sidebar entry");
        runEffect(() => ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: DOCS_PANEL_ID,
        }, DocsEntryRedirect)), "dsh-markdown-typora: docs page");
      } catch (error) {
        log.warn?.("dsh-markdown-typora: sidebar entry seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ⑤ 官方设置页 section：「Markdown 编辑器」
      try {
        runEffect(() => ctx.slots.inject("settings.section", () => {
          var dispose = ctx.slots.register({
            name: "settings.section",
            id: SETTINGS_SECTION_ID,
            order: 40,
            label: "Markdown 编辑器",
          }, MarkdownSettingsSection);
          try {
            window.__MP_SETTINGS_SEED = { registered: true, id: SETTINGS_SECTION_ID, hasDisposer: typeof dispose === "function" };
            log.info?.("dsh-markdown-typora: settings.section registered");
          } catch (e) { /* 忽略 */ }
          return dispose;
        }), "dsh-markdown-typora: settings section");
      } catch (error) {
        log.warn?.("dsh-markdown-typora: settings section seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ③ sessions 旁路（cwd 解析用；服务晚到也没关系，每次 open 现取）。
      try { SessionsBridge.getSessions = () => get("sessions"); } catch (e) { /* 忽略 */ }
      ctx.effect(() => installWorkspaceNavigation(ctx), "dsh-markdown-typora: workspace navigation");

      // Rightbar preferences apply only to the editor-owned grid.

      // ④ @mp 引用源：全部 try/catch，失败只告警，不影响编辑/插入。
      registerMpSource(ctx, { log: log, get: get });

      /* ① 把持久化里 markpilot 相关的旧面板状态清掉（旧版本中间面板方案已撤回）。
       *    只动含 markpilot-main 的键，不碰其它插件/外壳状态。 */
      try {
        const dead = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key) continue;
          let value = "";
          try { value = String(localStorage.getItem(key) || ""); } catch (e) { value = ""; }
          if (key.indexOf("markpilot-main") !== -1 || value.indexOf("markpilot-main") !== -1) dead.push(key);
        }
        for (let i = 0; i < dead.length; i += 1) { try { localStorage.removeItem(dead[i]); } catch (e) { /* 忽略 */ } }
      } catch (e) { /* 无存储 */ }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-markdown-typora";
    exports.__test = __test;

    // 调试面（只读镜像，方便宿主/桌面工具观察；不影响渲染）。
    try { window.__DSH_MARKDOWN__ = { openDocs: openDocs, version: "0.3.2" }; } catch (e) { /* 沙箱环境 */ }

    return module.exports;
  },
});
