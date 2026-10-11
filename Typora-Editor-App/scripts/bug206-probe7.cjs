const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const doc='# t\n\n正文段落一行。\n';
  fs.writeFileSync(path.join(output,'p7.md'),doc);
  await global.doc.openFile(path.join(output,'p7.md'),{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(600);
  await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-light',true))`);
  await pause(400);
  const out=await fe(`(()=>{try{
    const htmlCs=getComputedStyle(document.documentElement);
    const canary=document.createElement('div');
    canary.style.cssText='position:fixed;left:0;top:0;width:100vw;height:2px;pointer-events:none';
    document.body.append(canary);
    const vwPx=canary.getBoundingClientRect().width;
    const canary2=document.createElement('div');
    canary2.style.cssText='position:fixed;left:0;top:5px;width:100%;height:2px;pointer-events:none';
    document.body.append(canary2);
    const pctPx=canary2.getBoundingClientRect().width;
    canary.remove();canary2.remove();
    const pre=vditor.vditor.ir.element;
    return{vwPx,pctPx,innerW:window.innerWidth,docClientW:document.documentElement.clientWidth,
      htmlZoom:htmlCs.zoom,bodyZoom:getComputedStyle(document.body).zoom,
      prePadRaw:getComputedStyle(pre).getPropertyValue('padding-inline'),
      prePadL:getComputedStyle(pre).paddingLeft,
      metaViewport:document.querySelector('meta[name=viewport]')?.content||null};
  }catch(e){return{err:String(e)}}})()`);
  console.log(JSON.stringify(out,null,1));
  fs.writeFileSync(path.join(output,'probe7.json'),JSON.stringify(out,null,2));
  return out;
};
