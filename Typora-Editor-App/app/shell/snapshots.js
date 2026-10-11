// Read-only history UI in the shell; never mounts another editor/diagram engine.
(() => {
  const api=window.hostApi,dialog=document.createElement('dialog');dialog.className='completion-dialog snapshots-dialog';dialog.setAttribute('aria-labelledby','snapshots-title');
  const title=document.createElement('h2');title.id='snapshots-title';title.textContent='版本历史';
  const filename=document.createElement('p');filename.className='snapshots-file';
  const body=document.createElement('div');body.className='snapshots-body';
  const list=document.createElement('div');list.className='completion-dialog-items snapshots-list';list.setAttribute('aria-label','历史版本');
  const pane=document.createElement('div');pane.className='snapshots-pane';
  const label=document.createElement('p');label.textContent='内容预览';
  const preview=document.createElement('pre');preview.className='snapshots-preview';preview.tabIndex=0;preview.setAttribute('aria-label','快照内容预览');
  const hint=document.createElement('p');hint.className='snapshots-hint';pane.append(label,preview,hint);body.append(list,pane);
  const message=document.createElement('p');message.className='snapshots-message';message.setAttribute('role','status');
  const error=document.createElement('p');error.className='completion-dialog-error';error.setAttribute('role','alert');
  const footer=document.createElement('footer');
  const button=text=>{const b=document.createElement('button');b.type='button';b.textContent=text;return b;};
  const reveal=button('打开快照目录'),openCopy=button('打开副本'),close=button('关闭'),restore=button('恢复为副本');
  openCopy.hidden=true;footer.append(reveal,openCopy,close,restore);dialog.append(title,filename,body,message,error,footer);document.body.append(dialog);
  let file=null,selected=null,generation=0,busy=false,copy=null;
  const invoke=async(name,args={})=>{const result=await api.invoke(name,{file,...args});if(result.error)throw new Error(result.error);return result;};
  async function choose(id){
    selected=id;const token=++generation;error.textContent='';preview.textContent='正在读取…';restore.disabled=true;
    list.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.snapshotId===id)));
    try{const data=await invoke('snapshots-list',{id});if(token!==generation||!dialog.open)return;preview.textContent=data.text;hint.textContent=data.truncated?'预览仅显示前 12 万字符，恢复副本会保留全文。':'恢复会创建新文件，原文件保持不变。';restore.disabled=false;}
    catch(e){if(token===generation){preview.textContent='';error.textContent=e.message;}}
  }
  api.onPush('snapshots-open',async data=>{
    file=data.file;selected=null;copy=null;busy=false;const token=++generation;
    filename.textContent=file||'';filename.title=file||'';list.replaceChildren();preview.textContent='';hint.textContent='';message.textContent='正在读取版本历史…';error.textContent='';openCopy.hidden=true;restore.disabled=true;reveal.disabled=false;
    if(!dialog.open)dialog.showModal();
    try{
      const result=await invoke('snapshots-list');if(token!==generation||!dialog.open)return;
      message.textContent=result.items.length?`${result.items.length} 个版本 · 每个文件最多保留 50 份`+(result.enabled?'':' · 本地快照已关闭'):(result.enabled?'尚无快照。打开文件及保存成功后会自动记录。':'本地快照已关闭，可从“文件”菜单开启。');
      for(const item of result.items){
        const b=button('');b.dataset.snapshotId=item.id;
        const time=document.createElement('span');time.textContent=new Date(item.created).toLocaleString('zh-CN',{hour12:false});
        const detail=document.createElement('small');detail.textContent=`${item.words.toLocaleString('zh-CN')} 字 · ${item.bytes<1024?item.bytes+' B':(item.bytes/1024).toFixed(1)+' KB'}`;
        b.append(time,detail);b.addEventListener('click',()=>{if(!busy)choose(item.id);});list.append(b);
      }
      if(result.items.length){await choose(result.items[0].id);list.querySelector('button')?.focus();}else close.focus();
    }catch(e){if(token===generation){message.textContent='';error.textContent=e.message;}}
  });
  close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{generation++;selected=null;preview.textContent='';});
  list.addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||busy)return;event.preventDefault();
    const buttons=[...list.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();buttons[next]?.click();
  });
  reveal.addEventListener('click',async()=>{try{await invoke('snapshots-reveal');}catch(e){error.textContent=e.message;}});
  restore.addEventListener('click',async()=>{
    if(!selected||busy)return;busy=true;restore.disabled=true;const token=generation;
    try{const result=await invoke('snapshots-restore',{id:selected});if(token!==generation||!dialog.open)return;copy=result.path;message.textContent='已恢复为副本：'+copy;openCopy.hidden=false;}
    catch(e){if(token===generation)error.textContent=e.message;}
    finally{if(token===generation){busy=false;restore.disabled=false;}}
  });
  openCopy.addEventListener('click',async()=>{if(!copy)return;const target=copy;dialog.close();await api.invoke('open-file',{path:target});});
})();
