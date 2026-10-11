const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const shot=async name=>{try{fs.writeFileSync(path.join(output,'probe-'+name+'.png'),(await win.webContents.capturePage()).toPNG());}catch{}};
  const out={};
  // boot theme + IR DOM of the (2) paragraph
  out.boot=await fe(`(()=>{
    const html=document.documentElement;
    const ir=vditor.vditor.ir.element;
    const ps=[...ir.querySelectorAll('p')];
    const numbered=ps.find(p=>p.textContent.trim().startsWith('(2)'));
    return{dataTheme:html.getAttribute('data-editor-theme'),
      localTheme:localStorage.getItem('editor-theme'),
      resetMaxWidth:getComputedStyle(ir).maxWidth,
      numberedHTML:numbered?numbered.outerHTML.slice(0,900):null};})()`);
  console.log(JSON.stringify(out.boot,null,2).slice(0,1800));
  // more button real structure
  out.more=await fe(`(()=>{
    const tb=window.document.querySelector('.vditor>.vditor-toolbar');
    const btns=[...tb.querySelectorAll('button')].map(b=>b.getAttribute('data-type')).filter(Boolean);
    const more=tb.querySelector('[data-type="more"]');
    const item=more?more.closest('.vditor-toolbar__item'):null;
    let panelInfo=null;
    if(more){more.click();}
    return{dataTypes:btns.slice(-15),moreTag:more?more.tagName:null,
      moreHTML:more?more.outerHTML.slice(0,300):null,
      itemChildren:item?[...item.children].map(c=>c.tagName+'.'+String(c.className).slice(0,50)):null};})()`);
  await pause(700);
  out.afterClick=await fe(`(()=>{
    const tb=window.document.querySelector('.vditor>.vditor-toolbar');
    const panels=[...tb.querySelectorAll('.vditor-panel')];
    return{panels:panels.map(p=>({cls:p.className,display:getComputedStyle(p).display,rect:(()=>{const r=p.getBoundingClientRect();return{t:Math.round(r.top),l:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)};})(),
      buttons:[...p.querySelectorAll('button')].map(b=>b.getAttribute('data-type')+':'+(b.textContent||'').trim().slice(0,14)).slice(0,20)}))};})()`);
  console.log('MORE',JSON.stringify(out.more));
  console.log('AFTER',JSON.stringify(out.afterClick).slice(0,2500));
  await shot('more-open');
  fs.writeFileSync(path.join(output,'probe-report.json'),JSON.stringify(out,null,2));
  return out;
};
