export function installOfficeClient(){
  let active=null;
  const clear=()=>{active?.frame.remove();active=null;};
  window.handler.on('office-export-start',request=>{
    clear();const frame=document.createElement('iframe');frame.hidden=true;frame.src=request.rootPath+'/office.html';
    active={id:request.id,frame};frame.onload=()=>{if(active?.frame===frame)frame.contentWindow.postMessage({scope:'typora-office',id:request.id,action:'prepare',payload:{text:request.text,title:request.title}},'*');};document.body.append(frame);
  }).on('office-export-assets',request=>{
    if(active?.id===request.id)active.frame.contentWindow.postMessage({scope:'typora-office',id:request.id,action:'finish',payload:{assets:request.assets,assetWarnings:request.assetWarnings}},'*');
  }).on('office-export-cancel',request=>{if(active?.id===request.id)clear();});
  window.addEventListener('message',event=>{
    if(!active||event.source!==active.frame.contentWindow||event.data?.scope!=='typora-office'||event.data.id!==active.id)return;
    window.handler.emit('office-export-phase',event.data);
  });
}
