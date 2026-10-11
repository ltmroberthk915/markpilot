const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const doc='# t\n\n正文段落一行。\n';
  fs.writeFileSync(path.join(output,'p8.md'),doc);
  await global.doc.openFile(path.join(output,'p8.md'),{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(600);
  await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-light',true))`);
  await pause(400);
  const out=await fe(`(()=>{try{
    const hits=[];
    for(const sheet of document.styleSheets){
      let rules;try{rules=sheet.cssRules}catch(e){hits.push({href:sheet.href,skip:true});continue}
      const walk=(list,media)=>{for(const r of list||[]){
        if(r.cssRules){walk(r.cssRules,r.media&&r.media.mediaText||media);continue}
        if(!r.selectorText||!r.style)continue;
        const pi=r.style.paddingInline||r.style.padding||r.style.paddingLeft;
        if(pi&&/vditor-reset|^pre$/.test(r.selectorText))hits.push({href:(sheet.href||'inline').split('/').slice(-1)[0],media,sel:r.selectorText.slice(0,90),padding:String(pi).slice(0,70)});
      }};
      walk(rules);
    }
    return{hits};
  }catch(e){return{err:String(e)}}})()`);
  console.log(JSON.stringify(out,null,1));
  fs.writeFileSync(path.join(output,'probe8.json'),JSON.stringify(out,null,2));
  return out;
};
