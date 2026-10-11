'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ROOT, sleep } = require('./lifecycle.cjs');
async function waitUntil(predicate, label = 'condition', timeoutMs = 10000) {
  const end=Date.now()+timeoutMs;
  do { if(await predicate())return; await sleep(60); } while(Date.now()<end);
  throw new Error('Timed out waiting for '+label);
}
function outputDir(out, label) {
  const dir = path.resolve(out || path.join(ROOT, '.mp-verify/quality', label + '-' + Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error('Output directory must be empty: ' + dir);
  fs.writeFileSync(path.join(dir, 'quality-run.json'), JSON.stringify({ owner:'markpilot-quality', schema:1 }));
  return dir;
}
async function snapshot(page) {
  return page.evaluate(() => {
    const v = window.mpEngine._view(), s = v.state.selection.main, c = v.coordsAtPos(s.head);
    const ae=document.activeElement;
    return { text:v.state.doc.toString(), selection:{anchor:s.anchor,head:s.head}, focus:v.hasFocus && document.hasFocus(), activeElement:{tag:ae?.tagName,class:ae?.className},caret:c, scrollTop:v.scrollDOM.scrollTop, title:document.title, banner:document.getElementById('mp-banner')?.textContent || '' };
  });
}
async function reset(page, text, anchor = 0, head = anchor) {
  await page.bringToFront();
  await page.evaluate(({text,anchor,head}) => {
    window.mpEngine.setValue(text);
    const v=window.mpEngine._view(); v.dispatch({selection:{anchor,head},scrollIntoView:true}); v.focus();
  }, {text,anchor,head});
  await sleep(120);
  const state=await snapshot(page);
  assert.equal(state.text,text,'fixture text'); assert.deepEqual(state.selection,{anchor,head},'fixture selection'); assert(state.focus,'editor focus');
}
async function frame(page, dir, name) {
  const caret=await page.evaluate(() => {
    const v=window.mpEngine._view(), r=v.coordsAtPos(v.state.selection.main.head);
    if(!r || !(r.bottom>r.top)) return null;
    const d=document.createElement('div');d.id='quality-caret-marker';
    Object.assign(d.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:'2px',height:(r.bottom-r.top)+'px',background:'#ff3030',zIndex:'2147483646',pointerEvents:'none'});
    document.body.appendChild(d);return r;
  });
  assert(caret && Number.isFinite(caret.left) && caret.bottom>caret.top,'screenshot must include a measurable caret position');
  try {
    const bytes=await page.screenshot({path:path.join(dir,name+'.png'),animations:'disabled'});
    const viewport=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    const clip={x:Math.max(0,Math.min(caret.left-120,viewport.width-300)),y:Math.max(0,Math.min(caret.top-25,viewport.height-90)),width:Math.min(300,viewport.width),height:Math.min(90,viewport.height),scale:2};
    const cdp=await page.context().newCDPSession(page);
    let zoomBytes;
    try {const shot=await cdp.send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:false});zoomBytes=Buffer.from(shot.data,'base64');}
    finally {await cdp.detach();}
    fs.writeFileSync(path.join(dir,name+'-caret-2x.png'),zoomBytes);
    return {file:name+'.png',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),caret,zoom:{file:name+'-caret-2x.png',sha256:crypto.createHash('sha256').update(zoomBytes).digest('hex'),clip}};
  } finally { await page.evaluate(()=>document.getElementById('quality-caret-marker')?.remove()).catch(()=>{}); }
}
async function newWindow(run, owner, file) {
  const old=new Set(run.browser.contexts().flatMap(c=>c.pages()));
  const response=await owner.evaluate(p=>window.mpHost.openInNewWindow(p),file); assert(response.ok,'new window response');
  const limit=Date.now()+15000;
  while(Date.now()<limit) {
    for(const p of run.browser.contexts().flatMap(c=>c.pages())) {
      if(old.has(p))continue;
      if(await p.evaluate(()=>!!window.mpEngine?._view?.()).catch(()=>false)) {
        await waitUntil(()=>p.evaluate(file=>window.mpHost.currentDoc().then(d=>file==null ? d==null : d?.filePath===file),file),'new-window document handshake');
        await sleep(300);return p;
      }
    }
    await sleep(100);
  }
  throw new Error('New window boot timed out');
}
function recorder(dir, result) {
  return async (id, body) => {
    const entry={id,status:'running',trace:[]},start=performance.now();
    result.cases.push(entry);
    let timer;
    try { entry.detail=await Promise.race([body(entry.trace),new Promise((_,reject)=>{timer=setTimeout(()=>{entry.timeout=true;reject(new Error('Case exceeded 45 seconds; suite aborted for cleanup'));},45000);})]);entry.status='pass'; }
    catch(e) { entry.status='fail';entry.error=e.message; }
    finally { clearTimeout(timer); }
    entry.ms=Math.round(performance.now()-start);
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
    console.log(entry.status.toUpperCase()+' '+id+(entry.error ? ': '+entry.error : ''));
    if(entry.timeout)throw new Error('Timed out: '+id);
  };
}
module.exports={outputDir,snapshot,reset,frame,newWindow,recorder,waitUntil};
