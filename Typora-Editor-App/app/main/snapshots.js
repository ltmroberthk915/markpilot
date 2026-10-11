'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const fsSync=require('node:fs');
const {computeStats}=require('./text-stats');
const ID=/^\d{8}-\d{6}(?:-\d{3,})?\.md$/;
const normalize=file=>{const absolute=path.resolve(file);return process.platform==='win32'?absolute.toLowerCase():absolute;};
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function stamp(date){const pad=n=>String(n).padStart(2,'0');return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;}

// Use a sibling temporary file; a failed write never truncates an existing file.
async function atomicWrite(file,text,{beforeCommit}={}) {
  const temp=path.join(path.dirname(file),'.'+path.basename(file)+'.'+crypto.randomUUID()+'.tmp');
  let handle;
  try {
    handle=await fs.open(temp,'wx');await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;
    // Windows rejects replacing read-only destinations, and indexers/cloud
    // sync can briefly hold a writable file. Never truncate/unlink the target
    // to work around either case; recheck conflicts before every retry.
    for(let attempt=0;;attempt++){
      if(beforeCommit)await beforeCommit();
      try{await fs.rename(temp,file);break;}
      catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
        const stat=await fs.stat(file).catch(()=>null);
        if(stat&&!(stat.mode&0o200)){
          const readonly=new Error('文件被设为只读，无法替换保存。编辑内容仍保留在窗口中；可另存为副本，或在文件属性中取消“只读”后重试。');readonly.code='EREADONLY';throw readonly;
        }
        if(attempt>=4){error.message='文件被其他程序占用或当前目录不允许替换保存。编辑内容仍保留，可另存为副本后继续。\n'+error.message;throw error;}
        await new Promise(resolve=>setTimeout(resolve,[60,120,240,400][attempt]));
      }
    }
  } finally {if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')console.error('Temporary file cleanup:',error.message);});}
}

/** 同步睡一下（同步退避用；不引第三方依赖）。 */
const sleepSync=ms=>{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{/* 退化：不睡，直接重试 */}};

/** 同步版原子写。给 `state.js` 用：它的保存发生在**退出/关窗路径**上（`saveNow()` 被同步调用），
 *  改成异步会把"退出时最后那一下写盘"变成竞态。策略与上面的 async 版一致：兄弟临时文件 +
 *  fsync + rename，任何失败都不截断目标文件。 */
function atomicWriteSync(file,text){
  const temp=path.join(path.dirname(file),'.'+path.basename(file)+'.'+crypto.randomUUID()+'.tmp');
  let handle=null;
  try{
    handle=fsSync.openSync(temp,'wx');
    fsSync.writeFileSync(handle,text,'utf8');
    fsSync.fsyncSync(handle);
    fsSync.closeSync(handle);handle=null;
    for(let attempt=0;;attempt++){
      try{fsSync.renameSync(temp,file);break;}
      catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4)throw error;
        sleepSync([60,120,240,400][attempt]);
      }
    }
  } finally {
    if(handle!==null){try{fsSync.closeSync(handle);}catch{/* 已经关了 */}}
    try{fsSync.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')console.error('Temporary file cleanup:',error.message);}
  }
}

class SnapshotStore {
  constructor({root,limit=50,now=()=>new Date()}={}) {
    this.root=path.resolve(root||path.join(require('electron').app.getPath('userData'),'snapshots'));
    this.limit=limit;this.now=now;this.queues=new Map();
  }
  directory(file){return path.join(this.root,hash(normalize(file)).slice(0,12));}
  enqueue(file,work){
    const key=this.directory(file),previous=this.queues.get(key)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>work(key));this.queues.set(key,next);
    next.finally(()=>{if(this.queues.get(key)===next)this.queues.delete(key);}).catch(()=>{});return next;
  }
  async inventory(dir){
    let saved={};try{const index=JSON.parse(await fs.readFile(path.join(dir,'index.json'),'utf8'));saved=Object.fromEntries(index.items.map(item=>[item.id,item]));}catch{}
    let names;try{names=await fs.readdir(dir);}catch(error){if(error.code==='ENOENT')return[];throw error;}
    const items=[];
    for(const id of names.filter(name=>ID.test(name))){
      const file=path.join(dir,id);let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!stat.isFile()||stat.isSymbolicLink())continue;
      const old=saved[id];
      if(old&&old.bytes===stat.size&&old.mtime===stat.mtimeMs&&typeof old.hash==='string'&&Number.isFinite(old.words)&&Number.isFinite(old.created)&&(old.used===undefined||Number.isFinite(old.used)))items.push(old);
      else {const text=await fs.readFile(file,'utf8');items.push({id,created:stat.mtimeMs,mtime:stat.mtimeMs,bytes:stat.size,words:computeStats(text).words,hash:hash(text),reason:'recovered'});}
    }
    return items.sort((a,b)=>b.created-a.created||b.id.slice(0,15).localeCompare(a.id.slice(0,15))||Number(b.id.slice(0,-3).split('-')[2]||0)-Number(a.id.slice(0,-3).split('-')[2]||0));
  }
  async index(dir,file,items){await atomicWrite(path.join(dir,'index.json'),JSON.stringify({version:1,file:path.resolve(file),items}));}
  async touch(dir,file,items,id){
    const item=items.find(value=>value.id===id);if(!item)return;
    const recent=Math.max(...items.map(value=>value.used||value.created));
    if((item.used||item.created)<recent){item.used=recent+1;await this.index(dir,file,items);}
  }
  async touchRead(dir,file,id){try{await this.touch(dir,file,await this.inventory(dir),id);}catch(error){console.error('Snapshot LRU update:',error.message);}}
  capture(file,text,reason='save'){
    // Capture immutable arguments before awaiting earlier writes.
    const created=this.now().getTime(),base=stamp(new Date(created)),digest=hash(text);
    return this.enqueue(file,async dir=>{
      await fs.mkdir(dir,{recursive:true});const items=await this.inventory(dir);
      if(items[0]?.hash===digest){await this.touch(dir,file,items,items[0].id);return items[0];}
      const sameSecond=items.filter(item=>item.id.startsWith(base));
      let suffix=sameSecond.length?Math.max(...sameSecond.map(item=>Number(item.id.slice(0,-3).split('-')[2]||0)))+1:0;
      let id=base+(suffix?'-'+String(suffix).padStart(3,'0'):'')+'.md';
      const names=new Set(items.map(item=>item.id));
      while(names.has(id))id=base+'-'+String(++suffix).padStart(3,'0')+'.md';
      await atomicWrite(path.join(dir,id),text);
      const stat=await fs.stat(path.join(dir,id));
      const used=Math.max(created,...items.map(value=>value.used||value.created))+1;
      const item={id,created,used,mtime:stat.mtimeMs,bytes:stat.size,words:computeStats(text).words,hash:digest,reason};items.unshift(item);
      // Reads/restores refresh LRU use order, while the UI always lists by time.
      const recency=[...items].sort((a,b)=>(b.used||b.created)-(a.used||a.created));
      const retained=recency.slice(0,this.limit);await this.index(dir,file,retained);
      for(const old of recency.slice(this.limit))await fs.unlink(path.join(dir,old.id)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      return item;
    });
  }
  list(file){return this.enqueue(file,async dir=>(await this.inventory(dir)).slice(0,this.limit).map(({hash,mtime,used,...item})=>item));}
  /** 整份快照正文（不做 UI 用的 120k 截断）。给"这份快照和磁盘内容是不是同一个东西"这类
   *  判定用——`list()` 有意不带 hash，别据它比较。 */
  full(file,id){return this.enqueue(file,async dir=>this.readIn(dir,id));}
  async readIn(dir,id){
    if(typeof id!=='string'||!ID.test(id))throw new Error('无效的快照编号');
    const file=path.join(dir,id),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('快照文件不可用');
    return fs.readFile(file,'utf8');
  }
  preview(file,id){return this.enqueue(file,async dir=>{const text=await this.readIn(dir,id);await this.touchRead(dir,file,id);return{text:text.slice(0,120000),truncated:text.length>120000};});}
  restore(file,id){return this.enqueue(file,async dir=>{const copy=await this.copy(file,await this.readIn(dir,id));await this.touchRead(dir,file,id);return copy;});}
  async copy(file,text){
    const ext=path.extname(file),base=path.basename(file,ext)+'-'+stamp(this.now()).slice(0,13);
    for(let n=0;n<10000;n++){
      const target=path.join(path.dirname(file),base+(n?'-'+n:'')+'.md');
      let handle;
      try{handle=await fs.open(target,'wx');await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;return target;}
      catch(error){if(handle){await handle.close().catch(()=>{});await fs.unlink(target).catch(()=>{});}if(error.code!=='EEXIST')throw error;}
    }
    throw new Error('无法创建不重名的恢复副本');
  }
  async reveal(file){const dir=this.directory(file);await fs.mkdir(dir,{recursive:true});return dir;}
}
module.exports={SnapshotStore,atomicWrite,atomicWriteSync,stamp,contentHash:hash};
