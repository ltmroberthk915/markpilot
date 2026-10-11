import {selectRange} from './source-text.js';
const pending=new Map();
let sequence=0,tail=Promise.resolve();
export function uploadImages(files) {
  const api=window.vditor,e=api.vditor,selection=getSelection();
  const range=selection.rangeCount?selection.getRangeAt(0).cloneRange():null;
  // One request per image and ordered insertion for multi-file paste/drop.
  tail=tail.catch(()=>{}).then(async()=>{
    if(range?.startContainer.isConnected && range.endContainer.isConnected)selectRange(e[e.currentMode].element,range);
    for(const file of files){
      try{
        const id='image-'+Date.now()+'-'+(++sequence);
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error);reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
        const reply=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
        window.handler.emit('img',{id,name:file.name,mime:file.type,data});
        const markdown=await reply;
        if(window.vditor!==api)return;
        const currentRoot=e[e.currentMode].element;
        if(!currentRoot.contains(getSelection().focusNode)){currentRoot.focus();getSelection().collapse(currentRoot,currentRoot.childNodes.length);}
        api.insertMD(markdown);
      }catch(error){api.tip('图片插入失败：'+String(error.message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),5000);}
    }
  });
  return null;
}
/** K1（R9 E9-A 裁决）：把剪贴板 html 里指向本机路径的图片（file:/// 等）交给宿主归档。
 *  复用上面的等待表与 'img'/'image-result' 通道，**不新开 window.handler.on('image-result')**
 *  ——vscode.js 的 on 是单回调覆盖式注册（events[event]=fn），再挂一个会把 uploadImages
 *  的应答监听顶掉。宿主读字节后走 cur.images.insert 的既有归档管线（embedded-images
 *  目录落盘 + 会话登记），resolve 归档后的 markdown 引用（![alt](缓存URL)）。失败 reject，
 *  调用方退回原样引用，不阻塞粘贴。 */
export function archiveImageFromPath(path,name=''){
  return new Promise((resolve,reject)=>{
    const id='image-'+Date.now()+'-'+(++sequence);
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('图片归档超时，请重试'));},30000);
    pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});
    window.handler.emit('img',{id,path:String(path),name:String(name||'')});
  });
}
export function installImageReplies(api){
  window.handler.on('image-result',value=>{
    const request=pending.get(value?.id);if(!request)return;pending.delete(value.id);
    if(value.error)request.reject(new Error(value.error));else request.resolve(value.markdown);
  });
  // Compatibility with older hosts, also used by existing URL insertion.
  window.handler.on('insertValue',markdown=>api.insertMD(markdown));
}
