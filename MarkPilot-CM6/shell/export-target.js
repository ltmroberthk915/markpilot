'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {prepareFile} = require('./safe-file');
const failure = message => Object.assign(Error(message), {code:'MP_EXPORT_TARGET'});
const identity = st => [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs,st.nlink].map(String).join(':');
async function targetIdentity(file) {
  try { return identity(await fs.stat(file,{bigint:true})); }
  catch(error) { if(error.code==='ENOENT')return null;throw error; }
}

// A picker approves the bytes (or absence) seen at selection, not whatever
// later occupies the pathname. Stream large targets without materializing them.
async function captureBaseline(file) {
  let handle;
  try { handle=await fs.open(file,'r'); }
  catch(error) { if(error.code==='ENOENT')return null;throw error; }
  try {
    const first=await handle.stat({bigint:true});
    if(!first.isFile() || first.nlink!==1n)throw failure('导出目标不是独立的普通文件，请选择其他位置');
    const hash=crypto.createHash('sha256');
    for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
    const end=await fs.stat(file,{bigint:true});
    if(identity(first)!==identity(end))throw failure('选择目标时文件已改变，请重新选择');
    return {sha256:hash.digest('hex'),identity:identity(first)};
  } finally { await handle.close(); }
}

async function captureExportTarget(file,{documents,held,check}) {
  const selected=path.resolve(file),canonical=await documents.canonical(selected),key=documents.key(canonical);
  async function validate() {
    if(documents.key(await documents.canonical(selected))!==key)throw failure('导出目标位置已改变，请重新选择');
    check(key);
  }
  await validate();
  const baseline=await captureBaseline(canonical);
  await validate();
  return {canonical,key,baseline,validate,
    withPublication:task=>documents.queue(key,async()=>{
      held.add(key);
      try { await validate();return await task(); }
      finally { held.delete(key); }
    }),
    commitPublication:task=>documents.commit(async()=>{
      await validate();
      // The native transaction consumes the selected SHA-256. Keep the
      // cross-document commit fence short and also distinguish file identity.
      if(await targetIdentity(canonical)!==(baseline?.identity??null))throw failure('导出目标在选择后已改变，请重新选择');
      await validate();
      return task();
    }),
  };
}

async function publishImage(grant,bytes) {
  return grant.withPublication(async()=>{
    const temp=path.join(path.dirname(grant.canonical),'.mp-image-'+process.pid+'-'+crypto.randomUUID());
    const output={bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    const tx=await prepareFile(grant.canonical,temp,{baseline:grant.baseline,output});
    try {
      await fs.writeFile(temp,bytes,{flag:'r+'});
      await grant.commitPublication(()=>tx.commit());
    }finally {await tx.abort();}
  });
}
module.exports={captureBaseline,captureExportTarget,publishImage};
