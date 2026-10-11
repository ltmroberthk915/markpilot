'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),vscode=require('vscode');
const {imageBytes}=require('../../render/js/media-host.cjs');
const {portableMarkdown}=require('../../render/js/portable-markdown.cjs');
const fingerprint=async file=>{try{const s=await fs.stat(file);return[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
async function distinct(source,target){
  if(path.resolve(source).toLowerCase()===path.resolve(target).toLowerCase())throw new Error('不能覆盖正在编辑的 Markdown 原文件');
  try{const [a,b]=await Promise.all([fs.stat(source),fs.stat(target)]);if(a.dev===b.dev&&a.ino===b.ino)throw new Error('导出路径指向原文件');}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function write(target,bytes,check){
  const temp=path.join(path.dirname(target),'.'+path.basename(target)+'.'+randomUUID()+'.tmp');let handle;
  try{handle=await fs.open(temp,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    for(let i=0;;i++){await check();try{await fs.rename(temp,target);break;}catch(error){if(i===4||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(r=>setTimeout(r,[60,120,240,400][i]));}}
  }finally{await handle?.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
}
exports.bindOfficeExport=function({provider,document,panel,handler,rootPath}){
  let job=null,disposed=false,selecting=false;
  const finish=(error,expected=job)=>{if(!job||job!==expected)return;const current=job;job=null;clearTimeout(current.timer);handler.emit('office-export-cancel',{id:current.id});error?current.reject(error):current.resolve();};
  panel.onDidDispose(()=>{disposed=true;finish(new Error('编辑器已关闭，导出已取消'));});
  const complete=async(data,warnings=[],current=job)=>{
    if(!current||job!==current||disposed)return;
    try{await write(current.target,data,async()=>{if(job!==current||disposed)throw new Error('导出已取消');await distinct(document.uri.fsPath,current.target);if(await fingerprint(current.target)!==current.fingerprint)throw new Error('导出目标被外部修改，未覆盖');});
      const target=current.target;finish();const message='已导出：'+path.basename(target)+(warnings.length?'；'+warnings.length+' 项内容需要检查':'');
      const pick=await vscode.window.showInformationMessage(message,...(warnings.length?['查看转换说明','打开所在文件夹']:['打开文件','打开所在文件夹']));
      if(pick==='打开文件')await vscode.env.openExternal(vscode.Uri.file(target));else if(pick==='打开所在文件夹')await vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(target));else if(pick==='查看转换说明'){const note=await vscode.workspace.openTextDocument({content:warnings.join('\n'),language:'plaintext'});await vscode.window.showTextDocument(note);}
    }catch(error){finish(error,current);}
  };
  handler.on('office-export',async request=>{
    if(job||selecting){await vscode.window.showInformationMessage('已有导出任务进行中');return;}
    if(typeof request?.text!=='string')return;
    selecting=true;
    try{
    const selected=request.format||((await vscode.window.showQuickPick([{label:'Word 文档（可编辑公式）',format:'docx'},{label:'便携 Markdown（内嵌图片）',format:'md'}],{title:'导出文档'}))?.format);
    if(!['md','docx'].includes(selected)||disposed)return;
    const source=document.uri.fsPath,targetUri=await vscode.window.showSaveDialog({title:'导出文档',defaultUri:vscode.Uri.file(path.join(path.dirname(source),path.basename(source,path.extname(source))+(selected==='md'?'-便携':'')+'.'+selected)),filters:{[selected==='docx'?'Word 文档':'Markdown']:[selected]}});
    if(!targetUri||disposed)return;
    try{await distinct(source,targetUri.fsPath);const initial=await fingerprint(targetUri.fsPath),text=provider.documents.get(document).images.expand(request.text);
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'正在导出 '+selected,cancellable:true},(_progress,cancel)=>new Promise((resolve,reject)=>{
        const id=randomUUID(),current={id,target:targetUri.fsPath,fingerprint:initial,resolve,reject};job=current;current.timer=setTimeout(()=>finish(new Error('导出超时'),current),180000);
        cancel.onCancellationRequested(()=>finish(new Error('已取消导出'),current));
        if(selected==='md')portableMarkdown(text,{file:source}).then(result=>complete(result.text,[],current)).catch(error=>finish(error,current));
        else handler.emit('office-export-start',{id,text,title:path.basename(source,path.extname(source)),rootPath});
      }));
    }catch(error){if(!disposed)await vscode.window.showErrorMessage('导出未完成：'+error.message);}
    }finally{selecting=false;}
  });
  handler.on('office-export-phase',async result=>{
    const current=job;if(!current||current.id!==result?.id)return;
    if(result.error){finish(new Error(result.error));return;}
    try{
      if(result.action==='prepare'){
        const sources=result.result?.images;if(!Array.isArray(sources)||sources.some(src=>typeof src!=='string'))throw new Error('图片列表无效');
        const assets={},warnings=[];let total=0,next=0;const unique=[...new Set(sources)];
        await Promise.all(Array.from({length:Math.min(4,unique.length)},async()=>{while(next<unique.length&&job===current){const src=unique[next++];try{const image=await imageBytes(src,document.uri.fsPath);total+=image.bytes.length;if(total>100*1024*1024)throw new Error('图片总量超过 100 MB');assets[src]='data:'+image.mime+';base64,'+image.bytes.toString('base64');}catch(error){warnings.push('图片未能嵌入：'+src.slice(0,100)+'（'+error.message+'）');}}}));
        if(job===current)handler.emit('office-export-assets',{id:current.id,assets,assetWarnings:warnings});
      }else if(result.action==='finish'){
        if(typeof result.result?.data!=='string'||result.result.data.length>200000000)throw new Error('Word 导出数据无效或过大');
        await complete(Buffer.from(result.result.data,'base64'),result.result.warnings||[],current);
      }
    }catch(error){finish(error,current);}
  });
};
