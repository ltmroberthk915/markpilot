// Desktop counterpart of native IDE password input and quick-pick dialogs.
(() => {
  const api=window.hostApi, popup=document.createElement('dialog');popup.className='completion-dialog';
  const form=document.createElement('form'),title=document.createElement('h2'),prompt=document.createElement('p'),input=document.createElement('input'),items=document.createElement('div'),error=document.createElement('p'),footer=document.createElement('footer');
  items.className='completion-dialog-items';error.className='completion-dialog-error';error.setAttribute('role','alert');
  input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-label','设置值');
  const cancel=document.createElement('button'),save=document.createElement('button');cancel.type='button';cancel.textContent='取消';save.type='submit';save.textContent='保存';footer.append(cancel,save);
  form.append(title,prompt,input,items,error,footer);popup.append(form);document.body.append(popup);
  let current=null,busy=false;
  async function reply(value) {
    if(!current||busy)return;busy=true;save.disabled=true;const id=current.id;
    try {
      const result=await api.invoke('completion-dialog-result',{id,...value});
      if(current?.id!==id)return;
      if(result.closed){current=null;input.value='';popup.close();}
      else error.textContent=result.error||'无法保存设置。';
    } catch {if(current?.id===id)error.textContent='无法保存设置，请重试。';}
    finally {busy=false;save.disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();reply({value:input.value});});
  cancel.addEventListener('click',()=>reply({cancel:true}));popup.addEventListener('cancel',event=>{event.preventDefault();reply({cancel:true});});
  popup.addEventListener('keydown',event=>{
    if(current?.kind!=='pick'||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const buttons=[...items.querySelectorAll('button')],at=buttons.indexOf(document.activeElement);
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
  });
  api.onPush('completion-dialog',data=>{
    current=data;busy=false;save.disabled=false;title.textContent=data.title||'补全设置';prompt.textContent=data.prompt;error.textContent='';
    input.hidden=data.kind!=='input';save.hidden=data.kind!=='input';input.type=data.password?'password':'text';input.value=data.value||'';items.replaceChildren();
    (data.items||[]).forEach((item,index)=>{
      const button=document.createElement('button');button.type='button';
      const label=document.createElement('span');label.textContent=item.label.replace(/\$\(check\)/g,'✓');button.append(label);
      for(const text of [item.description,item.detail].filter(Boolean)){const detail=document.createElement('small');detail.textContent=text;button.append(detail);}
      button.addEventListener('click',()=>reply({index}));items.append(button);
    });
    if(!popup.open)popup.showModal();
    const target=data.kind==='input'?input:items.querySelector('button');target?.focus();if(data.kind==='input')input.select();
  });
})();
