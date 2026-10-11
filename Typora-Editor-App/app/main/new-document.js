'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function suggestedPath(directory) {
  for(let i=0;i<1000;i++) {
    const file=path.join(directory,'未命名'+(i?' '+i:'')+'.md');
    try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return file;throw error;}
  }
  throw new Error('请为新文件选择其他名称');
}
async function newMarkdown({win,dialog,doc,directory,open}) {
  const selected=await dialog.showSaveDialog(win,{title:'新建 Markdown 文件',defaultPath:await suggestedPath(directory),filters:[{name:'Markdown',extensions:['md']}],properties:['createDirectory','showOverwriteConfirmation']});
  if(selected.canceled||!selected.filePath)return false;
  const file=/\.md$/i.test(selected.filePath)?selected.filePath:selected.filePath+'.md';
  try{await fs.lstat(file);throw new Error('同名文件已存在，请选择其他名称；原文件不会被覆盖');}catch(error){if(error.code!=='ENOENT')throw error;}
  const current=doc.current,text=current?.text;
  if(!(await doc.confirmDiscard()))return false;
  // openFile rechecks this exact identity/text after the disk operation; a newer
  // edit must receive its own confirmation rather than being silently discarded.
  const confirmedDiscard={current,text};
  let handle,created;
  try {
    handle=await fs.open(file,'wx');created=await handle.stat();await handle.close();handle=null;
    const opened=await open(file,{confirmedDiscard});
    if(opened)return true;
  } catch(error) {
    if(error.code==='EEXIST')throw new Error('同名文件刚被创建，请选择其他名称；原文件不会被覆盖');
    throw error;
  } finally {
    if(handle)await handle.close();
    if(doc.file!==path.resolve(file))doc.scheduleProtection?.();
    if(created&&doc.file!==path.resolve(file)) {
      // Only clean up the empty file created by this operation, never a changed
      // file or a replacement installed concurrently by another process.
      try{const now=await fs.lstat(file);if(now.isFile()&&now.size===0&&now.dev===created.dev&&now.ino===created.ino)await fs.unlink(file);}catch(error){if(error.code!=='ENOENT')console.error('New document cleanup:',error.message);}
    }
  }
  return false;
}
module.exports={newMarkdown,suggestedPath};
