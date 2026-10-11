const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const doc='# t\n\n正文段落一行。\n';
  fs.writeFileSync(path.join(output,'p6.md'),doc);
  await global.doc.openFile(path.join(output,'p6.md'),{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(600);
  await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-light',true))`);
  await fe(`vditor.setValue(${JSON.stringify(doc)});true`);
  await pause(500);
  const out=await fe(`(()=>{try{
    const pre=vditor.vditor.ir.element;
    const chain=[];
    let n=pre;
    for(let i=0;i<6&&n&&n!==document;i++){
      const cs=getComputedStyle(n);
      chain.push({tag:n.tagName,cls:String(n.className).slice(0,30),offW:n.offsetWidth,zoom:cs.zoom,transform:cs.transform!=='none',writing:cs.writingMode});
      n=n.parentElement;
    }
    const cs=getComputedStyle(pre);
    return{padL:cs.paddingLeft,preOffW:pre.offsetWidth,chain,
      visualZoom:window.visualViewport?.scale,dpr:window.devicePixelRatio,innerW:window.innerWidth};
  }catch(e){return{err:String(e)}}})()`);
  console.log(JSON.stringify(out,null,1));
  fs.writeFileSync(path.join(output,'probe6.json'),JSON.stringify(out,null,2));
  return out;
};
