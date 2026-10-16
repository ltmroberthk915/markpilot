'use strict';
// Document metadata belongs to one editor session. Only disk operations are shared.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {decodeDocument,encodeDocument}=require('./text-codec');
const {prepareFile}=require('./safe-file');
const failure=(code,message)=>Object.assign(new Error(message),{code});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function createSession(){
  return {documentId:crypto.randomUUID(),revision:0,lastSavedRevision:0,filePath:null,savedText:'',diskMtime:0,baseline:null,bom:false,eol:'\n',encoding:'utf8',dirty:false,saveAsRequest:0,saveAsGrant:null,lastSave:null,loadRequest:0,pendingSaves:new Set()};
}
class DocumentStore{
  constructor({beforeReplace=async()=>{},prepareSaveAs=async()=>null}={}){this.jobs=new Map();this.commitTail=Promise.resolve();this.beforeReplace=beforeReplace;this.prepareSaveAs=prepareSaveAs;}
  reset(S){const pending=S.pendingSaves,request=S.loadRequest+1;Object.assign(S,createSession(),{pendingSaves:pending,loadRequest:request});return this.metadata(S);}
  metadata(S){return {documentId:S.documentId,revision:S.revision,filePath:S.filePath,text:S.savedText,bom:S.bom,eol:S.eol,encoding:S.encoding};}
  async canonical(file){
    const absolute=path.resolve(file);
    try{return await fs.realpath(absolute);}catch(e){if(e.code!=='ENOENT')throw e;}
    let parent=path.dirname(absolute),tail=[path.basename(absolute)];
    for(;;){try{return path.join(await fs.realpath(parent),...tail);}catch(e){if(e.code!=='ENOENT')throw e;const next=path.dirname(parent);if(next===parent)return absolute;tail.unshift(path.basename(parent));parent=next;}}
  }
  key(file){return process.platform==='win32'?file.toLowerCase():file;}
  queue(key,fn){
    const previous=this.jobs.get(key)||Promise.resolve(),job=previous.catch(()=>{}).then(fn);
    this.jobs.set(key,job);const clear=()=>{if(this.jobs.get(key)===job)this.jobs.delete(key);};job.then(clear,clear);return job;
  }
  commit(fn){const job=this.commitTail.catch(()=>{}).then(fn);this.commitTail=job;return job;}
  async snapshot(file,{allowMissing=false}={}){
    let handle;
    try{
      handle=await fs.open(file,'r');const first=await handle.stat();
      if(!first.isFile())throw failure('MP_NOT_FILE','目标不是普通文件：'+file);
      const bytes=await handle.readFile(),last=await handle.stat(),onPath=await fs.stat(file);
      if(first.mtimeMs!==last.mtimeMs||first.size!==last.size||last.ino!==onPath.ino||last.dev!==onPath.dev||last.mtimeMs!==onPath.mtimeMs||last.size!==onPath.size)
        throw failure('MP_FILE_CONFLICT','读取期间文件已被其他程序修改，请重新加载：'+file);
      return {bytes,baseline:{sha256:digest(bytes),mtimeMs:last.mtimeMs,size:bytes.length,nlink:last.nlink}};
    }catch(e){if(allowMissing&&e.code==='ENOENT')return null;throw e;}finally{await handle?.close();}
  }
  async load(S,file,expected=null){
    if(typeof file!=='string'||!file)throw failure('MP_BAD_PATH','没有指定文件路径');
    const origin=expected||{documentId:S.documentId,revision:S.revision,filePath:S.filePath};
    const current=()=>S.documentId===origin.documentId&&S.revision===origin.revision&&this.key(S.filePath||'')===this.key(origin.filePath||'');
    if(!current()||(expected&&expected.loadRequest!==S.loadRequest))throw failure('MP_DOC_MISMATCH','重载期间文档或编辑版本已改变');
    const request=++S.loadRequest,canonical=await this.canonical(file);
    return this.queue(this.key(canonical),async()=>{
      const snap=await this.snapshot(canonical),decoded=decodeDocument(snap.bytes,file);
      if(this.key(await this.canonical(file))!==this.key(canonical))throw failure('MP_FILE_CONFLICT','读取期间文件位置已改变，已保留原文档：'+file);
      if(request!==S.loadRequest||!current())throw failure('MP_DOC_MISMATCH','文档已切换或继续编辑，本次读取已取消');
      const pending=S.pendingSaves,{text,...format}=decoded;
      Object.assign(S,createSession(),format,{pendingSaves:pending,loadRequest:request,filePath:canonical,savedText:text,baseline:snap.baseline,diskMtime:snap.baseline.mtimeMs});
      return this.metadata(S);
    });
  }
  markDirty(S,{documentId,revision,dirty}){
    if(documentId!==S.documentId||!Number.isSafeInteger(revision)||revision<S.revision)return false;
    S.revision=revision;
    S.dirty=!!dirty||revision!==S.lastSavedRevision;
    return true;
  }
  beginSaveAs(S){
    S.saveAsGrant=null;
    return {documentId:S.documentId,serial:++S.saveAsRequest};
  }
  async grantSaveAs(S,file,request=this.beginSaveAs(S)){
    const current=()=>request.documentId===S.documentId&&request.serial===S.saveAsRequest;
    if(!current())throw failure('MP_SAVE_TARGET','另存为操作已被新的选择替代');
    const documentId=request.documentId,canonical=await this.canonical(file),snap=await this.snapshot(canonical,{allowMissing:true});
    if(!current())throw failure('MP_SAVE_TARGET','另存为操作已被新的选择替代');
    const grant={token:crypto.randomUUID(),documentId,request:request.serial,filePath:path.resolve(file),canonical,baseline:snap?.baseline||null};
    S.saveAsGrant=grant;return {ok:true,filePath:grant.filePath,documentId,saveAsToken:grant.token};
  }
  async validate(file,baseline){
    const actual=await this.snapshot(file,{allowMissing:true});
    if(baseline&&!actual)throw failure('MP_FILE_MISSING','原文件已不在磁盘上（可能被重命名或删除）：'+file);
    if((!baseline&&actual)||(baseline&&actual?.baseline.sha256!==baseline.sha256))throw failure('MP_FILE_CONFLICT','文件已被其他窗口或程序修改，请重新加载或另存为：'+file);
    if(actual?.baseline.nlink>1)throw failure('MP_FILE_LINKED','文件包含硬链接，请另存为独立文件后编辑：'+file);
  }
  save(S,request={}){
    const job=(async()=>{
      const {filePath,text,documentId,revision,saveAsToken}=request;
      if(documentId!==S.documentId||typeof text!=='string'||!Number.isSafeInteger(revision)||revision<0)throw failure('MP_DOC_MISMATCH','文档或编辑版本已改变，保存已取消');
      const sourcePath=S.filePath,ownerCurrent=typeof request.ownerCurrent==='function'?request.ownerCurrent:()=>true;
      const grant=saveAsToken&&S.saveAsGrant;
      const grantCurrent=()=>!grant||(S.documentId===grant.documentId&&S.saveAsRequest===grant.request);
      if(saveAsToken&&(!grant||grant.token!==saveAsToken||grant.documentId!==documentId||grant.filePath!==path.resolve(filePath)))throw failure('MP_SAVE_TARGET','另存为许可已失效，请重新选择路径');
      if(!grant&&(!S.filePath||path.resolve(filePath)!==S.filePath))throw failure('MP_SAVE_TARGET','保存目标不属于当前文档，请使用另存为');
      if(grant)S.saveAsGrant=null; // One use, including a failed attempt.
      const target=await this.canonical(filePath);
      if(grant&&this.key(target)!==this.key(grant.canonical))throw failure('MP_FILE_CONFLICT','另存为目标位置已改变，请重新选择路径');
      return this.queue(this.key(target),async()=>{
        if(!grantCurrent())throw failure('MP_SAVE_TARGET','另存为操作已被新的选择替代');
        if(S.documentId!==documentId||(!grant&&S.filePath!==path.resolve(filePath))||revision<S.lastSavedRevision)throw failure('MP_DOC_MISMATCH','文档已切换或已有更新的保存');
        const baseline=grant?grant.baseline:S.baseline,format={bom:S.bom,eol:S.eol,encoding:S.encoding},out=encodeDocument(text,format);
        await this.validate(target,baseline);
        await fs.mkdir(path.dirname(target),{recursive:true});
        const saveAsCurrent=()=>S.documentId===documentId&&grantCurrent()&&revision>=S.lastSavedRevision&&ownerCurrent();
        const prepared=grant?await this.prepareSaveAs({sourcePath,filePath:path.resolve(filePath),text,canonical:f=>this.canonical(f),current:saveAsCurrent}):null;
        const assets=prepared?.summary||prepared;
        if(grant&&!saveAsCurrent())throw failure('MP_DOC_MISMATCH','另存为的文档或窗口已改变');
        // A valid target may already use the filesystem's entire name budget.
        // Keep the sibling staging/backup components independent of its basename.
        const tmp=path.join(path.dirname(target),'.mp-tmp-'+process.pid+'-'+crypto.randomUUID());
        let stage,primaryFailure;
        try{
          const outHash=digest(out);
          stage=await prepareFile(target,tmp,{baseline,output:{bytes:out.length,sha256:outHash}});
          await fs.writeFile(tmp,out,{flag:'r+'});
          await this.beforeReplace({session:S,filePath:target,text,revision});
          return await this.commit(async()=>{
            // The short shared commit also protects alternate names of the same file.
            if(this.key(await this.canonical(filePath))!==this.key(target))throw failure('MP_FILE_CONFLICT','保存位置已改变，请重新加载或另存为');
            if(typeof prepared?.validate==='function')await prepared.validate();
            await this.validate(target,baseline);
            if(!grantCurrent())throw failure('MP_SAVE_TARGET','另存为操作已被新的选择替代');
            if(grant&&!saveAsCurrent())throw failure('MP_DOC_MISMATCH','另存为的文档或窗口已改变');
            const receipt=await stage.commit();const st=await fs.stat(target),id=crypto.randomUUID();
            const current=S.documentId===documentId&&grantCurrent();
            if(current){
              S.filePath=target;S.savedText=text;S.baseline={sha256:outHash,mtimeMs:st.mtimeMs,size:out.length,nlink:st.nlink};S.diskMtime=st.mtimeMs;
              S.lastSavedRevision=revision;S.dirty=S.revision!==revision;
              S.lastSave={id,documentId,revision,filePath:S.filePath};
            }
            return {ok:true,saveId:id,documentId,revision,filePath:target,current,mtimeMs:st.mtimeMs,bytes:out.length,...(receipt?.backupRetained?{recoveryBackup:receipt.backupRetained}:{}),...(assets?{assets}:{})};
          });
        }catch(error){primaryFailure=error;throw error;}
        finally{try{await stage?.abort();}catch(error){if(primaryFailure)primaryFailure.cleanupError=error.message;else throw error;}}
      });
    })();
    S.pendingSaves.add(job);const clear=()=>S.pendingSaves.delete(job);job.then(clear,clear);return job;
  }
  async pending(S){await Promise.allSettled([...S.pendingSaves]);}
  async outsideChange(S,file){
    if(file!==S.filePath)return {changed:false,stale:true};
    const documentId=S.documentId,snap=await this.snapshot(await this.canonical(file),{allowMissing:true});
    if(documentId!==S.documentId)return {changed:false,stale:true};
    return {changed:!snap||snap.baseline.sha256!==S.baseline?.sha256,missing:!snap,mtimeMs:snap?.baseline.mtimeMs,size:snap?.baseline.size};
  }
}
module.exports={DocumentStore,createSession,failure};
