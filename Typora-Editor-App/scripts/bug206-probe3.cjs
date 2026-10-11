const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const shot=async name=>{try{fs.writeFileSync(path.join(output,'probe3-'+name+'.png'),(await win.webContents.capturePage()).toPNG());}catch{}};
  await fe(`window.document.querySelector('.vditor-toolbar button[data-type="more"]').click();true`);
  await pause(700);
  const hint=await fe(`(()=>{
    const hints=[...window.document.querySelectorAll('.vditor-toolbar .vditor-hint')];
    const h=hints.find(x=>getComputedStyle(x).display!=='none');
    if(!h)return{openCount:hints.filter(x=>getComputedStyle(x).display!=='none').length,total:hints.length};
    const cs=getComputedStyle(h);
    const hr=h.getBoundingClientRect();
    const rows=[...h.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return{type:b.getAttribute('data-type'),text:(b.textContent||'').trim().slice(0,18),
      rect:{t:Math.round(r.top),l:Math.round(r.left),b:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)},
      visibleInPanel:r.top>=hr.top-1&&r.bottom<=hr.bottom+1&&r.height>0};});
    const vw=window.innerWidth,vh=window.innerHeight;
    return{cls:h.className,display:cs.display,maxH:cs.maxHeight,overflowY:cs.overflowY,
      rect:{t:Math.round(hr.top),l:Math.round(hr.left),r:Math.round(hr.right),b:Math.round(hr.bottom),w:Math.round(hr.width),h:Math.round(hr.height)},
      scroll:{scrollH:h.scrollHeight,clientH:h.clientHeight},
      offViewport:hr.right>vw||hr.bottom>vh||hr.left<0||hr.top<0,viewport:{vw,vh},rows};})()`);
  console.log(JSON.stringify(hint).slice(0,3500));
  await shot('more-hint');
  fs.writeFileSync(path.join(output,'probe3-report.json'),JSON.stringify(hint,null,2));
  return hint;
};
