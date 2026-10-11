// v2.0.9 危急复现：用户报告 2.0.8 打开 1-重识概率论.md（约 166KB）正文
// 完全空白；且空文件的状态栏统计非零。用只读副本 + 定时键帧截图取证。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const host=code=>win.webContents.executeJavaScript(code,true);
  const shot=async name=>{try{fs.writeFileSync(path.join(output,`bug209-${name}.png`),(await win.webContents.capturePage()).toPNG());}catch(e){console.log('shot fail',name,String(e));}};
  const report={checks:[]};
  const log=(k,v)=>{report.checks.push({check:k,value:v});console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));};
  const doc=path.join(output,'user-doc.md');
  const empty=path.join(output,'empty.md');
  fs.writeFileSync(empty,'');

  const t0=Date.now();
  await global.doc.openFile(doc,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(e=>log('open-error',String(e)));
  log('openFile-returned-ms',Date.now()-t0);
  // 每 2 秒探测一次 iframe 状态，共 60 秒：定位卡在哪一步
  for(let i=0;i<30;i++){
    const st=await host(`(()=>{const f=document.getElementById('editor');const w=f&&f.contentWindow;return JSON.stringify({ms:${Date.now()-t0},src:f?f.getAttribute('src'):'none',display:f?f.style.display:'?',hasVditor:!!(w&&w.vditor),lute:!!(w&&w.vditor&&w.vditor.vditor&&w.vditor.vditor.lute),patched:!!(w&&w.vditor&&w.vditor.vditor&&w.vditor.vditor.__typoraPatched),valueLen:w&&w.vditor?w.vditor.getValue().length:-1,h1:w&&w.document?w.document.querySelectorAll('.vditor-reset h1').length:-1,pCount:w&&w.document?w.document.querySelectorAll('.vditor-reset p').length:-1,theme:w&&w.document?w.document.documentElement.dataset.editorTheme:null,stroke:w&&w.document&&w.document.querySelector('.vditor-reset p')?getComputedStyle(w.document.querySelector('.vditor-reset p')).webkitTextStrokeWidth:null})})()`).catch(e=>'host-eval-err:'+e);
    log('probe-'+i,st);
    if(i===1||i===4||i===9||i===29)await shot('big-'+i);
    const parsed=(()=>{try{return JSON.parse(st)}catch{return null}})();
    if(parsed&&parsed.valueLen>1000&&parsed.pCount>10){await shot('big-rendered');break;}
    await pause(2000);
  }
  // 状态栏 vs 文档实情
  const bar=await host(`(()=>{const b=document.getElementById('statusbar');return JSON.stringify({visible:b&&b.style.display!=='none',words:document.getElementById('st-words')?.textContent,chars:document.getElementById('st-chars')?.textContent,lines:document.getElementById('st-lines')?.textContent})})()`);
  log('statusbar-bigdoc',bar);
  const disk=fs.readFileSync(doc,'utf8');
  log('disk-chars',disk.length);

  // ---- 空文件统计
  await global.doc.openFile(empty,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(1200);
  const emptyBar=await host(`(()=>{const b=document.getElementById('statusbar');return JSON.stringify({visible:b&&b.style.display!=='none',words:document.getElementById('st-words')?.textContent,chars:document.getElementById('st-chars')?.textContent,lines:document.getElementById('st-lines')?.textContent,value:document.getElementById('editor')?.contentWindow?.vditor?.getValue()?.length})})()`);
  log('statusbar-empty',emptyBar);
  await shot('empty-doc');
  fs.writeFileSync(path.join(output,'bug209-report.json'),JSON.stringify(report,null,2));
  console.log('bug209 repro pass: probes collected');
};
