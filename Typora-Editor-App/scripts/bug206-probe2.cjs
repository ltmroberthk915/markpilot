const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const shot=async name=>{try{fs.writeFileSync(path.join(output,'probe2-'+name+'.png'),(await win.webContents.capturePage()).toPNG());}catch{}};
  await fe(`window.document.querySelector('.vditor-toolbar button[data-type="more"]').click();true`);
  await pause(700);
  const hint=await fe(`(()=>{
    const h=window.document.querySelector('.vditor-toolbar .vditor-hint');
    if(!h)return{found:false};
    const cs=getComputedStyle(h);
    const hr=h.getBoundingClientRect();
    const rows=[...h.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return{type:b.getAttribute('data-type'),text:(b.textContent||'').trim().slice(0,16),
      rect:{t:Math.round(r.top),l:Math.round(r.left),r:Math.round(r.right),b:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)},
      visibleInPanel:r.top>=hr.top-1&&r.bottom<=hr.bottom+1&&r.height>0};});
    return{found:true,cls:h.className,style:{display:cs.display,maxHeight:cs.maxHeight,overflow:cs.overflow,overflowY:cs.overflowY,position:cs.position,height:cs.height},
      rect:{t:Math.round(hr.top),l:Math.round(hr.left),r:Math.round(hr.right),b:Math.round(hr.bottom),w:Math.round(hr.width),h:Math.round(hr.height)},
      scrollInfo:{scrollH:h.scrollHeight,clientH:h.clientHeight,scrollT:h.scrollTop},
      innerHTMLLen:h.innerHTML.length,rows};})()`);
  console.log(JSON.stringify(hint,null,1));
  await shot('hint-open');
  fs.writeFileSync(path.join(output,'probe2-report.json'),JSON.stringify(hint,null,2));
  return hint;
};
