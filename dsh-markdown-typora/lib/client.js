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
      padding: "4px 10px", fontSize: 12, flex: "0 0 auto",
      background: warn ? "color-mix(in srgb, currentColor 10%, transparent)" : "color-mix(in srgb, currentColor 5%, transparent)",
      borderBottom: "1px solid color-mix(in srgb, currentColor " + (warn ? 25 : 14) + "%, transparent)",
    });
    const btnStyle = {
      fontSize: 12, padding: "1px 8px", border: "1px solid rgba(127,127,127,0.4)",
      borderRadius: 4, background: "transparent", cursor: "pointer",
    };
    const emptyStyle = { padding: 12, fontSize: 12, opacity: 0.7 };

    /* ───────────────────────── tab body ───────────────────────── */

    function EditorTabBody(props) {
      if (!React) return null;
      if (typeof props.useTabInfo !== "function") {
        return React.createElement("div", { style: emptyStyle }, "dsh-markdown-typora: useTabInfo unavailable");
      }
      return React.createElement(EditorTabBodyInner, props);
    }

    function EditorTabBodyInner(props) {
      const h = React.createElement;
      const tab = props.useTabInfo().tab;
      const address = tab && tab.contentId;
      const parsed = React.useMemo(() => parseFileAddress(address), [address]);
      const depKey = parsed ? [parsed.scope, parsed.sessionId || "", parsed.path].join("|") : null;
      const tabVisible = !(tab && tab.visible === false);
      const sessionIdFromProps = typeof props.sessionId === "string" ? props.sessionId : "";

      const frameRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const st = React.useRef({ doc: null, actions: {} }).current;
      const inputActionsRef = React.useRef(props.inputActions);
      inputActionsRef.current = props.inputActions;

      const [ui, setUi] = React.useState({ phase: "loading", detail: "", notice: "", recovery: null, recovered: null });
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
        setUi((prev) => (prev.recovered ? { ...prev, recovered: null } : prev));   // 新文档代际不继承 recovered 横幅

        const ticket = ticketOf(doc.sessionId, doc.absPath, doc.gen);
        const alive = () => !doc.dead && st.doc === doc && ticket.generation === doc.gen;
        const cleanups = [];

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
          doc.dirty=restore||(pending.firstOpen&&value.live&&value.live.dirty===true);
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
          if(!applied.ok){doc.mirror.continuous=false;doc.dirty=true;if(!doc.gapDeltas.some(x=>sameSession(x.after,delta.after)))doc.gapDeltas.push(delta);if(!doc.pulls.size)void requestSnapshot('gap');return false;}
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
            if(advanced){doc.dirty=true;doc.editSeq++;}
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
          doc.phase = phase;
          doc.detail = detail || "";
          if (phase !== "ready" && phase !== "dirty") doc.notice = "";
          setUiIfChanged({ phase: phase, detail: detail || "", notice: doc.notice });
        }
        function showError(message) {
          showPhase("error", message);
        }
        function showNotice(message) {
          if (doc.dead) return; // 卸载/关闭后不再 setState（恢复槽超大等清理期提示）
          doc.notice = message;
          setUiIfChanged({ phase: doc.phase, detail: doc.detail || "", notice: message });
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

        async function runSave(options) {
          const manual = !!(options && options.manual);
          if (doc.dead) return;
          // 有界预算耗尽后不再自动发保存请求（防持续竞争下无界后台唤醒）；
          // 显式保存（Ctrl+S）重置预算，输入改动只保留草稿等显式动作。
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
            if (manual) post("toast", gate.reason === "clean" ? "没有需要保存的改动" : "文档尚未就绪，暂不能保存");
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
                showPhase(doc.dirty ? "dirty" : "ready", doc.dirty ? "编辑中…（上一轮已保存，继续保存新改动）" : "已保存");
                if (manualThisRun) post("toast", doc.dirty ? "已保存；还有新改动，继续保存中…" : "已保存");
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
          if (gate.action === "clean") { post("toast", "没有需要保存的改动"); return; }
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
            const result = await api("open", {path:pathAtStart, live:!doc.liveUnsupported});
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

        function maybeBoot() {
          if (!alive() || !doc.bridgeUp || !doc.editorReady || doc.opened || doc.booting) return;
          doc.booting = true;
          post("theme", { dark: isDarkTheme() });
          void loadFromDisk({}).finally(() => { doc.booting = false; });
        }

        function onDirty(content) {
          doc.dirty = true;
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
          const outcome = await insertSelectionToChat(inputActionsRef.current, payload, {
            clipboard: clipboardOf(),
          });
          if (!alive()) return;
          if (outcome.ok) {
            post("toast", "已插入到输入框");
            showNotice("已插入到输入框");
          } else if (outcome.method === "clipboard") {
            post("toast", "已复制，粘贴到输入框");
            showNotice("已复制，粘贴到输入框");
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
                  if (doc.phase === "dirty") showPhase("ready", "已同步保存");
                }
              }
            }
            return;
          }
          if (type === "bridge-ready") {
            if (doc.bridgeUp) return;
            doc.bridgeUp = true;
            post("theme", { dark: isDarkTheme() });
            maybeBoot();
            return;
          }
          if (type === "init") {
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
        banner = h("div", { style: { ...bannerStyle(false), minHeight: 22 } }, ui.notice || ui.detail || "");
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
      return h("div", { ref: rootRef, style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 } },
        banner,
        recoveredBanner,
        h("iframe", {
          key: depKey,
          ref: frameRef,
          name: frameName,
          src: FRAME_SRC,
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

    const inject = ["slots"];

    function apply(ctx) {
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

      // ③ sessions 旁路（cwd 解析用；服务晚到也没关系，每次 open 现取）。
      try { SessionsBridge.getSessions = () => get("sessions"); } catch (e) { /* 忽略 */ }

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
