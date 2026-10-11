const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const doc='# t\n\n(2) $\{E_n\}^{\infty}\subset \sigma(X)\Leftrightarrow \exists\ \{B_n\}^{\infty}\subset\mathcal{B}$。\n';
  fs.writeFileSync(path.join(output,'p4.md'),doc);
  await global.doc.openFile(path.join(output,'p4.md'),{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(600);
  await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-light',true))`);
  await fe(`vditor.setValue(${JSON.stringify(doc)});true`);
  await pause(400);
  for(let i=0;i<200;i++){if(await fe("window.__typoraMathStats?.pending===0"))break;await pause(25);}
  await pause(300);
  const out=await fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const p=[...ir.querySelectorAll('p')].find(x=>x.textContent.trim().startsWith('(2)'));
    const prev=p.querySelector('.vditor-ir__preview');
    const kat=p.querySelector('.katex');
    const pcs=getComputedStyle(p),kcs=kat?getComputedStyle(kat):null,prcs=getComputedStyle(prev);
    const kr=kat?.getBoundingClientRect();
    const rg=window.document.createRange();rg.selectNodeContents(p);
    const rects=[...rg.getClientRects()].map(r=>({l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),w:Math.round(r.width)}));
    return{pTextAlign:pcs.textAlign,justify:lastJustify(),
      prev:{display:prcs.display,maxWidth:prcs.maxWidth,overflow:prcs.overflow,inlineSize:prcs.inlineSize},
      katex:kcs?{display:kcs.display,maxWidth:kcs.maxWidth,fontSize:kcs.fontSize,width:kcs.width,whiteSpace:kcs.whiteSpace}:null,
      katexRect:kr?{l:Math.round(kr.left),r:Math.round(kr.right),w:Math.round(kr.width)}:null,
      contentW:p.clientWidth,lineRects:rects.slice(0,6),
      irClientW:ir.clientWidth,irScrollW:ir.scrollWidth};
    function lastJustify(){try{const c=document.createElement('canvas').getContext('2d');return c.measureText?'canvas-ok':'?'}catch(e){return 'err'}}})()`);
  console.log(JSON.stringify(out,null,1));
  fs.writeFileSync(path.join(output,'probe4.json'),JSON.stringify(out,null,2));
  return out;
};
