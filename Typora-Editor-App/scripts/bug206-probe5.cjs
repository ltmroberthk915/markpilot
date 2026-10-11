const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const doc='# t\n\n正文段落一行。\n';
  fs.writeFileSync(path.join(output,'p5.md'),doc);
  await global.doc.openFile(path.join(output,'p5.md'),{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(600);
  await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-light',true))`);
  await fe(`vditor.setValue(${JSON.stringify(doc)});true`);
  await pause(500);
  const out=await fe(`(()=>{try{
    const ir=vditor.vditor.ir.element;
    const cs=getComputedStyle(ir);
    const host=document.createElement('div');
    host.style.cssText='width:900px';
    const canary=document.createElement('div');
    canary.style.paddingInline='max(28px, calc((100% - 1280px) / 2))';
    host.append(canary);document.body.append(host);
    const canaryPad=getComputedStyle(canary).paddingLeft;host.remove();
    const winners=[];
    for(const sheet of document.styleSheets){
      let rules;try{rules=sheet.cssRules}catch(e){continue}
      const walk=list=>{for(const r of list||[]){
        if(r.cssRules){walk(r.cssRules);continue}
        if(!r.selectorText)continue;
        let hit=false;try{hit=ir.matches(r.selectorText)}catch(e){}
        if(hit&&(r.style&&(r.style.paddingLeft||r.style.padding||r.style.paddingInline)))winners.push(r.selectorText.slice(0,80)+' :: '+[(r.style.padding||'').slice(0,40),(r.style.paddingLeft||'').slice(0,20),(r.style.paddingInline||'').slice(0,60)].filter(Boolean).join(' | '));
      }};
      walk(rules);
    }
    return{paddingLeft:cs.paddingLeft,paddingRight:cs.paddingRight,paddingInline:cs.paddingInline,
      irOffsetW:ir.offsetWidth,irClientW:ir.clientWidth,winW:window.innerWidth,
      canaryPad,winners:winners.slice(0,12)};
  }catch(e){return{probeError:String(e&&e.stack||e)}}})()`);
  console.log(JSON.stringify(out,null,1));
  fs.writeFileSync(path.join(output,'probe5.json'),JSON.stringify(out,null,2));
  return out;
};
