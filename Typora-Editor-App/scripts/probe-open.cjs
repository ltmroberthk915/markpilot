exports.run=async({win,output})=>{
  const fs=require('node:fs'),path=require('node:path');
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const file=path.join(output,'probe-first.md');
  fs.writeFileSync(file,'alpha beta\n\nsecond line\n');
  const log=(k,v)=>console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));
  const r=await win.webContents.executeJavaScript(`hostApi.invoke('open-file',{path:${JSON.stringify(file)}}).then(v=>'invoke-ok:'+v).catch(e=>'invoke-err:'+e)`,true);
  log('open-file-result',r);
  for(let i=0;i<60;i++){
    const st=await win.webContents.executeJavaScript(`(()=>{const f=document.getElementById('editor');const w=f&&f.contentWindow;return JSON.stringify({display:f?f.style.display:'no-frame',src:f?f.getAttribute('src'):null,hasVditor:!!(w&&w.vditor),patched:!!(w&&w.vditor&&w.vditor.vditor&&w.vditor.vditor.__typoraPatched),value:w&&w.vditor?w.vditor.getValue().slice(0,30):null,welcome:getComputedStyle(document.getElementById('welcome')).display})})()`,true).catch(e=>'eval-err:'+e);
    log('t'+i,st);
    if(String(st).includes('alpha beta'))break;
    await pause(1000);
  }
};
