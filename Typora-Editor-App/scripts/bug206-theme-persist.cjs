// P0: telari theme must persist across restarts (v2.0.5 allowlist regression).
// phase 1: apply telari-dark with persist; phase 2 (same profile dir): assert boot theme.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const phase=process.env.THEME_PHASE||'1';
  if(phase==='1'){
    await pause(800);
    const before=await fe(`document.documentElement.getAttribute('data-editor-theme')`);
    await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-dark',true))`);
    await pause(900);
    const after=await fe(`document.documentElement.getAttribute('data-editor-theme')`);
    console.log(JSON.stringify({phase,before,after}));
    const stateFile=path.join(output,'profile','state.json');
    const persisted=JSON.parse(fs.readFileSync(stateFile,'utf8')).editorTheme||null;
    console.log(JSON.stringify({persisted}));
    if(persisted!=='telari-dark')throw new Error('theme-set dropped by main allowlist: state.editorTheme='+persisted);
    console.log('PASS telari-dark persisted to state.json');
  }else{
    await pause(1200);
    const boot=await fe(`document.documentElement.getAttribute('data-editor-theme')`);
    console.log(JSON.stringify({phase,boot}));
    if(boot!=='telari-dark')throw new Error('boot theme should restore telari-dark, got '+boot);
    console.log('PASS boot restores telari-dark after restart');
  }
};
