const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  await pause(600);
  const probe=async w=>{
    await win.setBounds({width:w,height:900});
    await pause(600);
    return fe(`(()=>{
      const tb=window.document.querySelector('.vditor>.vditor-toolbar');
      const btn=vditor.vditor.toolbar.elements['source-toggle']?.querySelector('button');
      const r=btn?.getBoundingClientRect();
      const tbr=tb.getBoundingClientRect();
      return{winW:window.innerWidth,tbClientW:tb.clientWidth,tbScrollW:tb.scrollWidth,
        justify:getComputedStyle(tb).justifyContent,
        btnRect:r?{x:Math.round(r.x),right:Math.round(r.right),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}:null,
        tbH:Math.round(tbr.height),btnOffscreen:r?(r.right>window.innerWidth||r.x<0||r.width===0):'no-btn'}})()`);
  };
  const out={w700:await probe(760),w1000:await probe(1060),w1400:await probe(1460)};
  console.log(JSON.stringify(out,null,1));
  fs.writeFileSync(path.join(output,'probe9.json'),JSON.stringify(out,null,2));
  return out;
};
