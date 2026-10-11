(() => {
  const api=window.hostApi;
  const dialog=document.createElement('dialog');dialog.className='completion-dialog';dialog.id='export-dialog';dialog.setAttribute('aria-labelledby','export-title');
  dialog.innerHTML='<h2 id="export-title">导出</h2><p id="export-message" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></p><p id="export-elapsed" hidden style="margin:0;font-size:12px;opacity:.7"></p><details hidden><summary>导出提示</summary><pre style="white-space:pre-wrap;max-height:220px;overflow:auto"></pre></details><footer><button data-action="open" hidden>打开文件</button><button data-action="reveal" hidden>打开所在文件夹</button><button data-action="close">取消</button></footer>';
  document.body.append(dialog);let busy=false;
  // 导出最长的静默窗在 printToPDF 布局（页数与进度都拿不到），唯一诚实的活动信号
  // 是时间：首个 working 记 t0、每秒跳一下，终态/quiet/关窗即停——证明对话框没死。
  const elapsed=dialog.querySelector('#export-elapsed');
  let elapsedTimer=null,elapsedStart=0;
  const stopElapsed=()=>{if(elapsedTimer){clearInterval(elapsedTimer);elapsedTimer=null;}elapsed.hidden=true;elapsed.textContent='';};
  const close=()=>{if(busy)api.invoke('export-cancel');else dialog.close();};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',stopElapsed);
  dialog.querySelector('[data-action=close]').onclick=close;
  for(const action of ['open','reveal'])dialog.querySelector('[data-action='+action+']').onclick=()=>api.invoke('export-open',{reveal:action==='reveal'}).catch(error=>{dialog.querySelector('#export-message').textContent=error.message;});
  api.onPush('export-status',value=>{
    // quiet 的取消通知只用于清掉残留文案：用户刚取消保存对话框，此时弹出一个新
    // 窗口去说明「已取消」是多余的打扰。
    if (value.quiet&&!dialog.open)return;
    busy=value.phase==='working';
    dialog.querySelector('#export-message').textContent=value.error||value.message||(value.phase==='done'?'已导出\n'+value.path:'已取消导出');
    const closeButton=dialog.querySelector('[data-action=close]');closeButton.textContent=busy?'取消':'完成';closeButton.disabled=!!value.committing;
    for(const action of ['open','reveal'])dialog.querySelector('[data-action='+action+']').hidden=value.phase!=='done';
    const details=dialog.querySelector('details');details.hidden=!value.warnings?.length;details.querySelector('pre').textContent=(value.warnings||[]).join('\n');
    if(busy){if(!elapsedTimer){elapsedStart=Date.now();elapsed.hidden=false;elapsed.textContent='已耗时 0s';elapsedTimer=setInterval(()=>{elapsed.textContent='已耗时 '+Math.floor((Date.now()-elapsedStart)/1000)+'s';},1000);}}
    else stopElapsed();
    if(!dialog.open)dialog.showModal();
  });
})();
