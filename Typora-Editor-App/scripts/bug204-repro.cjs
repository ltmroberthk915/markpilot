// v2.0.4 diagnostics: (0) deleting the tail after an inline formula must not
// leave the formula node expanded with a broken-geometry preview; (1) Ctrl+U
// must not leak a visible </u> marker chip. Pure diagnosis: per-frame anomaly
// sampler during deletion, full geometry after every step, DOM snapshots.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const key=(k,mods=[])=>{for(const t of ['keyDown','keyUp'])win.webContents.sendInputEvent({type:t,keyCode:k,modifiers:mods});};
  const shot=async name=>{try{fs.writeFileSync(path.join(output,'bug204-'+name+'.png'),(await win.webContents.capturePage()).toPNG());}catch{}};
  const report=[];
  const log=(...a)=>{console.log(...a);report.push(a.join(' '));};

  const fixture='# 2.0.4 问题复现\n\n给定路径空间 $\\Omega$ 与其上的直接像。\n\n既有 <u>下划线词</u> 与公式 $G+1$ 的健康段落。\n\n由于随机变量将样本空间中的每个重要事件映射为实数，事件 $A\\subseteq\\Omega$ 的概率 $P(A)$ 规范。\n\n路径空间上的直接后裔。）也就是累积分布函数 $F_X$ 的导数。\n';
  const file=path.join(output,'bug204.md');
  const loaded=()=>`vditor.getValue()===${JSON.stringify(fixture)}&&vditor.vditor.currentMode==='ir'`;
  let openedOnce=false;
  const open=async()=>{
    if(!openedOnce){
      fs.writeFileSync(file,fixture);
      await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
      openedOnce=true;await pause(700);
    }
    // Hot-exit session restore can pin stale content: always force the value.
    await fe(`vditor.setValue(${JSON.stringify(fixture)});true`);
    try{await wait(loaded(),'fixture loaded');}catch{const value=await fe('vditor.getValue()');let at=0;while(at<Math.min(value.length,fixture.length)&&value[at]===fixture[at])at++;console.log('OPEN DIAG',JSON.stringify({len:value.length,fixtureLen:fixture.length,firstDiff:at,got:value.slice(Math.max(0,at-25),at+25)}));throw new Error('fixture load failed');}
    await wait("window.__typoraMathStats?.pending===0",'math idle');await pause(400);};

  // Every expanded inline node, with geometry: catches the stuck/stretched
  // state regardless of whether the formula's own source still matches.
  const expandedProbe=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const nodes=[...ir.querySelectorAll('.vditor-ir__node--expand[data-type="inline-node"]')];
    const value=vditor.getValue();
    return{count:nodes.length,nodes:nodes.map(node=>{
      const code=node.querySelector(':scope > code[data-type="math-inline"]');
      const prev=node.querySelector(':scope > .vditor-ir__preview');
      const box=r=>r?{top:Math.round(r.top),h:Math.round(r.height),w:Math.round(r.width)}:null;
      return{codeText:code?.textContent?.replace(/\\u200b/g,''),codeBox:box(code?.getBoundingClientRect()),
        prevStyle:prev?.getAttribute('style'),prevBox:box(prev?.getBoundingClientRect()),
        prevDataRender:prev?.getAttribute('data-render'),prevKids:prev?[...prev.children].map(ch=>ch.tagName+'.'+String(ch.className).slice(0,40)):null,
        katexDisplay:!!prev?.querySelector('.katex-display'),katexCount:prev?.querySelectorAll('.katex').length||0,
        html:node.outerHTML.slice(0,400)};}),
      guard:ir.__inputPreviewGuard?{swaps:ir.__inputPreviewGuard.swaps,cached:ir.__inputPreviewGuard.cached,batches:ir.__inputPreviewGuard.batches}:null,
      tail:value.slice(-20)};})()`);
  const markerProbe=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const markers=[...ir.querySelectorAll('[data-type="html-inline"]')].map(m=>{const cs=getComputedStyle(m);const r=m.getBoundingClientRect();return{tag:m.tagName,cls:String(m.className),text:m.textContent,display:cs.display,w:Math.round(r.width),h:Math.round(r.height),visible:r.width>0&&r.height>0,inNode:!!m.closest('.vditor-ir__node'),nodeExpand:!!m.closest('.vditor-ir__node--expand')};});
    const value=vditor.getValue();
    return{markers,openCount:(value.match(/<u>/g)||[]).length,closeCount:(value.match(/<\\/u>/g)||[]).length,
      underlinePainted:!!CSS.highlights.get('typora-underline'),
      guard:ir.__inputPreviewGuard?{swaps:ir.__inputPreviewGuard.swaps,cached:ir.__inputPreviewGuard.cached}:null,value};})()`);
  const armSampler=()=>fe(`(()=>{
    window.__anomaly=[];window.__samplerOn=true;
    const sample=()=>{if(!window.__samplerOn)return;
      for(const node of vditor.vditor.ir.element.querySelectorAll('.vditor-ir__node--expand[data-type="inline-node"]')){
        const code=node.querySelector(':scope > code[data-type="math-inline"]');
        const prev=node.querySelector(':scope > .vditor-ir__preview');
        const ch=Math.max(code?.getBoundingClientRect().height||0,prev?.getBoundingClientRect().height||0);
        if(ch>60)window.__anomaly.push({t:performance.now().toFixed(0),h:Math.round(ch),codeH:Math.round(code?.getBoundingClientRect().height||0),prevH:Math.round(prev?.getBoundingClientRect().height||0),prevTop:Math.round(prev?.getBoundingClientRect().top||0),code:code?.textContent?.slice(0,20),html:node.outerHTML.slice(0,700)});
      }
      requestAnimationFrame(sample);};
    requestAnimationFrame(sample);return true})()`);
  const readSampler=()=>fe('(window.__anomaly||[]');
  const disarmSampler=()=>fe('window.__samplerOn=false;(window.__anomaly||[]).slice(0,6)');
  const caretEnd=()=>fe(`(()=>{const ir=vditor.vditor.ir.element;const last=[...ir.children].find(b=>b.textContent.includes('F_X'));if(!last)return false;const r=document.createRange();r.selectNodeContents(last);r.collapse(false);const s=getSelection();ir.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  const selectWord=(needle,word)=>fe(`(()=>{const root=vditor.vditor.ir.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.data.includes(${JSON.stringify(needle)}))break;}if(!n)return false;const at=n.data.indexOf(${JSON.stringify(word)});if(at<0)return false;const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+${word.length});const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return s.toString()===${JSON.stringify(word)}})()`);
  const caretWord=(needle,word)=>fe(`(()=>{const root=vditor.vditor.ir.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.data.includes(${JSON.stringify(needle)}))break;}if(!n)return false;const at=n.data.indexOf(${JSON.stringify(word)});if(at<0)return false;const r=document.createRange();r.setStart(n,at+1);r.collapse(true);const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  const caretElsewhere=()=>fe(`(()=>{const root=vditor.vditor.ir.element;const n=root.querySelector('h1')?.firstChild;if(!n)return false;const r=document.createRange();r.setStart(n,1);r.collapse(true);const s=getSelection();root.focus();s.removeAllRanges();s.addRange(r);return true})()`);

  /* ---- anatomy: healthy <u> markers shipped in the fixture ---- */
  await open();
  const anatomy=await markerProbe();
  log('ANATOMY healthy markers:',JSON.stringify(anatomy.markers),'painted:',anatomy.underlinePainted);

  /* ---- scenario E: engine ground truth on a freshly loaded document ---- */
  {
    const E=await fe(`(()=>{
      const raw=window.katex?katex.renderToString('F_X',{output:'html'}):null;
      let live=null;
      for(const n of vditor.vditor.ir.element.querySelectorAll('code[data-type="math-inline"]')){
        if(n.textContent.replace(/\\u200b/g,'').includes('F_X')){
          live=n.closest('.vditor-ir__node').querySelector('.language-math')?.innerHTML.slice(0,320);break;}}
      const css=[...document.querySelectorAll('link[href*=katex]')].map(l=>({href:l.href.split('/render/')[1],loaded:l.sheet!==null&&!!l.sheet.cssCountKnown!==false,rules:(()=>{try{return l.sheet?l.sheet.cssRules.length:-1}catch(e){return 'ERR:'+e.message}})()}));
      let vlistRules=0;try{for(const sheet of document.styleSheets){if(String(sheet.href||'').includes('katex')){for(const rule of sheet.cssRules){if(String(rule.selectorText||'').includes('vlist'))vlistRules++;}}}}catch(e){vlistRules=-1}
      const fx=(()=>{for(const n of vditor.vditor.ir.element.querySelectorAll('code[data-type="math-inline"]')){if(n.textContent.replace(/\\u200b/g,'').includes('F_X')){const m=n.closest('.vditor-ir__node').querySelector('.mtight');return m?Math.round(m.getBoundingClientRect().top):null}}})();
      return{rawHasStyle:raw?raw.includes('style='):null,rawSlice:raw?raw.slice(0,300):null,live,vlistRules,css,fxTop:fx};})()`);
    log('E engine:',JSON.stringify(E));
  }

  /* ---- scenario F: catch the style-stripper in the act during one deletion.
     Wraps removeAttribute + renderToString and observes the F_X preview subtree. ---- */
  await open();
  if(!await caretEnd())throw new Error('F caret failed');
  await pause(600);
  const armed=await fe(`(()=>{
    window.__f={strips:[],rts:[],styleless:null,mo:[]};
    const origRemove=Element.prototype.removeAttribute;
    Element.prototype.removeAttribute=function(name){
      try{
        if(String(name).toLowerCase()==='style'&&this.closest?.('.vditor-ir__preview')){
          window.__f.strips.push({cls:String(this.className).slice(0,44),stack:(new Error().stack||'').split('\\n').slice(1,6).join(' | ').slice(0,420)});
        }
      }catch{}
      return origRemove.call(this,name);
    };
    if(window.katex){
      const rts=katex.renderToString;
      katex.renderToString=function(...args){
        const out=rts.apply(this,args);
        window.__f.rts.push({src:String(args[0]).slice(0,16),styled:out.includes('style='),len:out.length});
        if(window.__f.rts.length>16)window.__f.rts.shift();
        if(!out.includes('style='))window.__f.styleless={src:String(args[0]).slice(0,30),slice:out.slice(0,220)};
        return out;
      };
    }
    const ir=vditor.vditor.ir.element;
    let target=null;
    for(const n of ir.querySelectorAll('code[data-type="math-inline"]')){
      if(n.textContent.replace(/\\u200b/g,'').includes('F_X')){target=n.closest('.vditor-ir__node').querySelector('.vditor-ir__preview');break;}}
    if(!target)return false;
    window.__f.baseStyles=target.querySelectorAll('[style]').length;
    new MutationObserver(records=>{
      for(const r of records){
        if(r.type==='attributes'&&r.attributeName==='style'){
          window.__f.mo.push({cls:String(r.target.className).slice(0,40),old:(r.oldValue||'').slice(0,40)});
        }
      }
    }).observe(target,{subtree:true,attributes:true,attributeFilter:['style'],attributeOldValue:true});
    return true;})()`);
  if(!armed)throw new Error('F instrumentation failed');
  key('Backspace');
  await pause(300);
  const F=await fe(`(()=>{
    let live=null;
    for(const n of vditor.vditor.ir.element.querySelectorAll('code[data-type="math-inline"]')){
      if(n.textContent.replace(/\\u200b/g,'').includes('F_X')){
        const p=n.closest('.vditor-ir__node').querySelector('.vditor-ir__preview');
        const m=p.querySelector('.mtight');
        live={styled:p.querySelectorAll('[style]').length,top:m?Math.round(m.getBoundingClientRect().top):null,html:p.innerHTML.slice(0,240)};break;}}
    return{live,baseStyles:window.__f.baseStyles,mo:window.__f.mo.slice(0,8),strips:window.__f.strips.slice(0,4),rts:window.__f.rts.slice(-6),styleless:window.__f.styleless};})()`);
  log('F result:',JSON.stringify(F));
  await shot('F-after');

  await open();
  if(!await caretEnd())throw new Error('A0f2 caret failed');
  await pause(600);
  const forensic2=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const codes=[...ir.querySelectorAll('code[data-type="math-inline"]')];
    const f=codes.find(c=>c.textContent.replace(/\\u200b/g,'').includes('F_X'));
    if(!f)return{found:false};
    const node=f.closest('.vditor-ir__node');
    const prev=node.querySelector('.vditor-ir__preview');
    const math=prev?.querySelector('.language-math');
    const katex=prev?.querySelector('.katex');
    const vlist=prev?.querySelector('.vlist');
    const mtight=prev?.querySelector('.mtight');
    return{found:true,expanded:node.classList.contains('vditor-ir__node--expand'),
      keep:!!math?.dataset.fx,sourceStart:prev?.querySelectorAll('[data-typora-source-start]').length||0,
      mathml:!!prev?.querySelector('.katex-mathml'),dataRender:prev?.getAttribute('data-render'),
      vlistStyle:vlist?.getAttribute('style'),vlistRect:vlist?(r=>({t:Math.round(r.top),h:Math.round(r.height)}))(vlist.getBoundingClientRect()):null,
      mtightRect:mtight?(r=>({t:Math.round(r.top),h:Math.round(r.height)}))(mtight.getBoundingClientRect()):null,
      kidClasses:katex?[...katex.children].map(k=>k.className):null,
      guard:ir.__inputPreviewGuard?{swaps:ir.__inputPreviewGuard.swaps,cached:ir.__inputPreviewGuard.cached}:null,
      stats:{rendered:window.__typoraMathStats?.rendered,commits:window.__typoraMathStats?.commits}};})()`);
  const tagFx=()=>fe(`(()=>{const ir=vditor.vditor.ir.element;for(const n of ir.querySelectorAll('code[data-type="math-inline"]')){if(n.textContent.replace(/\\u200b/g,'').includes('F_X')){const m=n.closest('.vditor-ir__node').querySelector('.language-math');if(m){m.dataset.fx='1';return true}}}return false})()`);
  if(!await tagFx())throw new Error('A0f tag failed');
  const g0=await forensic2();log('A0f2 before:',JSON.stringify(g0));
  key('Backspace');
  const g1=await forensic2();log('A0f2 t0:',JSON.stringify(g1));
  await pause(250);const g2=await forensic2();log('A0f2 t250:',JSON.stringify(g2));
  await pause(900);const g3=await forensic2();log('A0f2 t1150:',JSON.stringify(g3));
  await shot('A0f2-after');

  // Engine identity + full subtree HTML before/after one more deletion.
  await open();
  if(!await caretEnd())throw new Error('A0f3 caret failed');
  await pause(600);
  const env=await fe(`(()=>({scripts:[...document.querySelectorAll('script[src]')].map(s=>s.src).filter(s=>/katex|math/i.test(s)),
    math:JSON.stringify(vditor.vditor.options.preview.math),engine:(typeof katex!=='undefined'&&katex.version)||null,
    ourKatex:!!window.__typoraScheduleMath}))()`);
  log('A0f3 env:',JSON.stringify(env));
  const dumpHtml=()=>fe(`(()=>{const ir=vditor.vditor.ir.element;for(const n of ir.querySelectorAll('code[data-type="math-inline"]')){if(n.textContent.replace(/\\u200b/g,'').includes('F_X')){const p=n.closest('.vditor-ir__node').querySelector('.vditor-ir__preview');const v=p?.querySelector('.vlist');const m=p?.querySelector('.mtight');return{html:p?.outerHTML.slice(0,3000),len:p?.outerHTML.length,vlistStyle:v?.getAttribute('style'),mtightTop:m?Math.round(m.getBoundingClientRect().top):null,inlineStyleCount:p?.querySelectorAll('[style]').length}}}return null})()`);
  const h0=await dumpHtml();log('A0f3 before:',JSON.stringify({len:h0.len,vlistStyle:h0.vlistStyle,mtightTop:h0.mtightTop,inlineStyleCount:h0.inlineStyleCount}));
  key('Backspace');
  const h1=await dumpHtml();log('A0f3 t0:',JSON.stringify({len:h1.len,vlistStyle:h1.vlistStyle,mtightTop:h1.mtightTop,inlineStyleCount:h1.inlineStyleCount}));
  await pause(300);
  const h2=await dumpHtml();log('A0f3 t300:',JSON.stringify({len:h2.len,vlistStyle:h2.vlistStyle,mtightTop:h2.mtightTop,inlineStyleCount:h2.inlineStyleCount}));
  fs.writeFileSync(path.join(output,'bug204-A0f3-html.json'),JSON.stringify({before:h0,t0:h1,t300:h2},null,1));
  await shot('A0f3-after');

  /* ---- scenario A: op-bound capture. Baseline first, then screencast every
     composited frame while single Backspace operations run (user directive:
     one screenshot per operation, never sample by wall time). ---- */
  await open();
  if(!await caretEnd())throw new Error('scenario A caret placement failed');
  const fastState=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const codes=[...ir.querySelectorAll('code[data-type="math-inline"]')];
    const f=codes.find(c=>c.textContent.replace(/\\u200b/g,'').includes('F_X'));
    const sel=getSelection();
    const selText=sel&&sel.rangeCount&&!sel.isCollapsed?sel.toString().slice(0,24):'caret';
    const tall=[...ir.querySelectorAll('.vditor-ir__preview')].filter(p=>p.getBoundingClientRect().height>45).map(p=>Math.round(p.getBoundingClientRect().height));
    const orphans=[...ir.querySelectorAll('.vditor-ir__preview')].filter(p=>!p.closest('.vditor-ir__node')).length;
    return{fx:!!f,expanded:ir.querySelectorAll('.vditor-ir__node--expand').length,tall,orphans,selText,tail:vditor.getValue().slice(-16)};})()`);
  await pause(600);
  await shot('A-baseline');
  const baselineState=await fastState();
  log('A baseline:',JSON.stringify(baselineState));
  const dbg=win.webContents.debugger;
  let capturing=false,frameIndex=0;
  const castDir=path.join(output,'cast');fs.rmSync(castDir,{recursive:true,force:true});fs.mkdirSync(castDir,{recursive:true});
  const onFrame=(_event,method,params)=>{
    if(method!=='Page.screencastFrame'||!capturing)return;
    fs.writeFileSync(path.join(castDir,'f'+String(frameIndex).padStart(4,'0')+'.png'),Buffer.from(params.data,'base64'));
    frameIndex++;
    dbg.sendCommand('Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
  };
  dbg.on('message',onFrame);
  await dbg.sendCommand('Page.startScreencast',{format:'png',everyNthFrame:1});
  capturing=true;
  const timeline=[];
  for(let i=0;i<10;i++){
    const before=await fastState();
    key('Backspace');
    await pause(350);
    timeline.push({i,before,after:await fastState()});
  }
  await pause(500);
  capturing=false;
  await dbg.sendCommand('Page.stopScreencast').catch(()=>{});
  dbg.off('message',onFrame);
  for(const t of timeline)log('A op',t.i,JSON.stringify({before:t.before,after:t.after}));
  fs.writeFileSync(path.join(output,'bug204-A-timeline.json'),JSON.stringify({baselineState,timeline,frames:frameIndex},null,2));
  log('A screencast frames:',frameIndex);

  /* ---- scenario A2: delete the tail, then CLICK the formula (user path) ---- */
  const clickFormula=async(name)=>{
    const at=await fe(`(()=>{const ir=vditor.vditor.ir.element;const codes=[...ir.querySelectorAll('code[data-type="math-inline"]')];const f=codes.find(c=>c.textContent.replace(/\\u200b/g,'')==='F_X');if(!f)return null;const node=f.closest('.vditor-ir__node');const target=node.querySelector('.vditor-ir__preview')?.querySelector('.katex')||node.querySelector('.vditor-ir__preview')||node;const r=target.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(8,r.height/2)),expanded:node.classList.contains('vditor-ir__node--expand')}})()`);
    if(!at)throw new Error(name+': F_X not found for clicking');
    win.webContents.sendInputEvent({type:'mouseDown',x:at.x,y:at.y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:at.x,y:at.y,button:'left',clickCount:1});
    await pause(500);
    const probe=await expandedProbe();
    log('A2',name,'wasExpanded:',at.expanded,'-> expanded:',probe.count,JSON.stringify(probe.nodes.map(n=>({c:n.codeText,codeH:n.codeBox?.h,codeTop:n.codeBox?.top,prevH:n.prevBox?.h,prevTop:n.prevBox?.top,prevW:n.prevBox?.w,dr:n.prevDataRender,disp:n.katexDisplay,katex:n.katexCount}))));
    log('A2',name,'html:',probe.nodes[0]?.html?.slice(0,380));
    await shot('A2-'+name);
    return probe;
  };
  await open();
  if(!await caretEnd())throw new Error('A2 caret placement failed');
  for(let i=0;i<5;i++){key('Backspace');await pause(180);}
  const tailAfterDelete=await fe('vditor.getValue().slice(-24)');
  log('A2 after 5 backspaces tail:',JSON.stringify(tailAfterDelete));
  await clickFormula('after-delete');
  await caretElsewhere();await pause(400);
  await clickFormula('after-delete-reopened');
  // Control: same click on a freshly loaded doc, no deletions.
  await open();
  await clickFormula('fresh-control');

  /* ---- scenario B: Ctrl+U variants on a formula-bearing line ---- */
  await open();
  const variants=[];
  const recordVariant=async(name)=>{const dump=await markerProbe();variants.push({name,...dump});log('B',name,'markers:',JSON.stringify(dump.markers),'balanced:',dump.openCount+'/'+dump.closeCount,'painted:',dump.underlinePainted,'swaps:',dump.guard?.swaps);return dump;};
  if(!await selectWord('每个重要事件','重要事件'))throw new Error('B1 selection failed');
  key('U',['control']);await pause(800);
  await recordVariant('underline-on');
  await shot('B1-underline-on');
  if(!await caretWord('重要事件','重要事件'))throw new Error('B2 caret failed');
  key('U',['control']);await pause(800);
  await recordVariant('underline-off');
  await shot('B2-underline-off');
  if(!await selectWord('映射为实数，事件','映射为实数，事件'))throw new Error('B3 selection failed');
  key('U',['control']);await pause(800);
  await recordVariant('underline-before-formula');
  await shot('B3-before-formula');
  fs.writeFileSync(path.join(output,'bug204-B-variants.json'),JSON.stringify(variants,null,2));

  const visible=variants.flatMap(v=>v.markers.filter(m=>m.visible).map(m=>v.name+':'+m.text));
  log('SUMMARY visible chips:',JSON.stringify(visible),'unbalanced:',JSON.stringify(variants.map(v=>[v.name,v.openCount,v.closeCount])));

  /* ---- scenario G: markdown-syntax image, custom scale via settings dialog ---- */
  {
    const dataUrl=await fe(`(()=>{const c=document.createElement('canvas');c.width=320;c.height=160;const g=c.getContext('2d');g.fillStyle='#446688';g.fillRect(0,0,320,160);g.fillStyle='#fff';g.fillRect(40,40,240,80);return c.toDataURL('image/png')})()`);
    const gdir=path.join(output,'g');fs.mkdirSync(gdir,{recursive:true});
    const pic=path.join(gdir,'pic204.png');fs.writeFileSync(pic,Buffer.from(dataUrl.split(',')[1],'base64'));
    const gfile=path.join(gdir,'image-scale.md');
    fs.writeFileSync(gfile,'# 图片缩放\n\n![插图](./pic204.png)\n\n段落文字与公式 $F_X$ 收尾。\n');
    await global.doc.openFile(gfile,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
    await wait(`vditor.getValue().includes('插图')&&vditor.vditor.currentMode==='ir'`,'G doc loaded');
    await wait("window.__typoraMathStats?.pending===0",'G math idle');
    await wait(`(()=>{const i=vditor.vditor.ir.element.querySelector('img');return !!i&&i.naturalWidth>0})()`,'G image loaded');
    const menuInfo=await fe(`(()=>{const img=vditor.vditor.ir.element.querySelector('img');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,view:window});img.dispatchEvent(event);const menu=document.getElementById('typora-editor-context-menu');return{menu:!!menu,settings:!!menu?.querySelector('[data-action="image-settings"]')}})()`);
    if(!menuInfo.settings)throw new Error('G menu missing '+JSON.stringify(menuInfo));
    const applied=await fe(`(()=>{document.querySelector('#typora-editor-context-menu [data-action="image-settings"]').click();const dialog=document.getElementById('typora-image-settings');if(!dialog)return 'no-dialog';const input=dialog.querySelector('input[name="scale"]');input.value='60';dialog.querySelector('form button[type="submit"]').click();return 'submitted'})()`);
    await pause(700);
    const g=await fe(`(()=>{const ir=vditor.vditor.ir.element;const img=[...ir.querySelectorAll('img')];const s=getSelection();return{applied:${JSON.stringify(applied)},imgs:img.length,width:img[0]?.getAttribute('width'),scale:img[0]?.getAttribute('data-typora-scale'),
      valueHasImg:/!\\[[^\\]]*\\]\\(\\.?\\/?.*pic204/.test(vditor.getValue())||vditor.getValue().includes('pic204'),
      valueSlice:vditor.getValue().slice(0,300),
      focusIn:ir.contains(s.focusNode)||s.focusNode===ir,rangeCount:s.rangeCount,
      active:(document.activeElement||{}).id||String((document.activeElement||{}).tagName),
      dialogGone:!document.getElementById('typora-image-settings'),menuGone:!document.getElementById('typora-editor-context-menu')}})()`);
    log('G after custom scale:',JSON.stringify(g));
    await shot('G-after-scale');
  }

  /* ---- scenario H: real screenshot on clipboard -> Ctrl+V -> resize ---- */
  {
    const restoreClipboard=await require('./test-clipboard.cjs').preserveClipboard();
    const electron=require('electron');
    const screenshot=await fe(`(()=>{const c=document.createElement('canvas');c.width=1920;c.height=1080;const g=c.getContext('2d');for(let i=0;i<40;i++){g.fillStyle='hsl('+i*9+',60%,55%)';g.fillRect(i*48,0,48,1080);}g.fillStyle='#111';g.font='48px sans-serif';g.fillText('SCREENSHOT '+Date.now(),80,140);return c.toDataURL('image/png')})()`);
    await electron.clipboard.write([new electron.ClipboardItem({'image/png':Buffer.from(screenshot.split(',')[1],'base64')})]);
    const hdir=path.join(output,'g');fs.mkdirSync(hdir,{recursive:true});
    const hfile=path.join(hdir,'paste-image.md');
    fs.writeFileSync(hfile,'# 粘贴图片\n\n粘贴目标段落，图片将出现在这里。\n\n结尾段落。\n');
    await global.doc.openFile(hfile,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
    await wait(`vditor.getValue().includes('粘贴目标')&&vditor.vditor.currentMode==='ir'`,'H doc loaded');
    await pause(400);
    // Real click into the paragraph, then real Ctrl+V.
    const point=await fe(`(()=>{const p=[...vditor.vditor.ir.element.querySelectorAll('p')].find(n=>n.textContent.includes('粘贴目标'));if(!p)return null;const r=p.getBoundingClientRect(),f=window.frameElement.getBoundingClientRect();return{x:Math.round(f.left+r.left+r.width*.5),y:Math.round(f.top+r.top+r.height*.5)}})()`);
    if(!point)throw new Error('H paragraph missing');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y});
    await pause(300);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers:['control']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers:['control']});
    let pasted=false;
    for(let i=0;i<60;i++){pasted=await fe(`!!vditor.vditor.ir.element.querySelector('img')`);if(pasted)break;await pause(100);}
    const hPaste=await fe(`(()=>{const img=vditor.vditor.ir.element.querySelector('img');const src=img?.getAttribute('src')||'';return{pasted:!!img,srcKind:src.startsWith('data:')?'data:'+src.slice(5,30):src.slice(0,80),natural:img?.naturalWidth,shownW:img?Math.round(img.getBoundingClientRect().width):null,value:vditor.getValue().length}})()`);
    log('H pasted:',JSON.stringify(hPaste));
    await shot('H-pasted');
    if(pasted){
      await wait(`(()=>{const i=vditor.vditor.ir.element.querySelector('img');return !!i&&i.naturalWidth>0})()`,'H image decoded');
      const menuInfo=await fe(`(()=>{const img=vditor.vditor.ir.element.querySelector('img');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,view:window});img.dispatchEvent(event);const menu=document.getElementById('typora-editor-context-menu');return{settings:!!menu?.querySelector('[data-action="image-settings"]')}})()`);
      if(!menuInfo.settings)throw new Error('H menu missing');
      const applied=await fe(`(()=>{document.querySelector('#typora-editor-context-menu [data-action="image-settings"]').click();const dialog=document.getElementById('typora-image-settings');if(!dialog)return 'no-dialog';dialog.querySelector('input[name="scale"]').value='60';dialog.querySelector('form button[type="submit"]').click();return 'submitted'})()`);
      await pause(800);
      const hState=async tag=>fe(`(()=>{const ir=vditor.vditor.ir.element;const img=[...ir.querySelectorAll('img')].at(-1);const s=getSelection();return{tag:${JSON.stringify(tag)},imgs:ir.querySelectorAll('img').length,natural:img?.naturalWidth,widthAttr:img?.getAttribute('width'),scaleAttr:img?.getAttribute('data-typora-scale'),shownW:img?Math.round(img.getBoundingClientRect().width):null,
        valueLen:vditor.getValue().length,valueHasImg:/<img|!\\[/.test(vditor.getValue()),
        focusIn:ir.contains(s.focusNode)||s.focusNode===ir,rangeCount:s.rangeCount,
        active:(document.activeElement||{}).id||String((document.activeElement||{}).tagName||''),
        dialogGone:!document.getElementById('typora-image-settings')}})()`);
      log('H after scale:',JSON.stringify({...await hState('after'),applied}));
      // Idempotence: applying 60% again must not shrink further.
      const again=await fe(`(()=>{const img=vditor.vditor.ir.element.querySelector('img');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,view:window});img.dispatchEvent(event);document.querySelector('#typora-editor-context-menu [data-action="image-settings"]').click();const dialog=document.getElementById('typora-image-settings');const input=dialog.querySelector('input[name="scale"]');const preset=input.value;input.value='60';dialog.querySelector('form button[type="submit"]').click();return preset})()`);
      await pause(800);
      const second=await hState('second-apply');
      log('H second apply (preset was',again+'):',JSON.stringify(second));
      const hDump=await fe(`(()=>{const ir=vditor.vditor.ir.element;const blocks=[...ir.children].map(b=>({tag:b.tagName,html:b.outerHTML.slice(0,320)}));return{value:vditor.getValue(),blocks:blocks.slice(0,6)}})()`);
      log('H dump after scale:',JSON.stringify(hDump));
      await shot('H-after-scale');
      // The user's recovery: click once to re-activate, then Ctrl+Z restores.
      const p2=await fe(`(()=>{const p=[...vditor.vditor.ir.element.querySelectorAll('p')].find(n=>n.textContent.includes('结尾'));if(!p)return null;const r=p.getBoundingClientRect(),f=window.frameElement.getBoundingClientRect();return{x:Math.round(f.left+r.left+r.width*.5),y:Math.round(f.top+r.top+r.height*.5)}})()`);
      if(p2){win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:p2.x,y:p2.y});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p2.x,y:p2.y});await pause(300);}
      log('H after click:',JSON.stringify(await hState('click')));
      key('Z',['control']);await pause(600);
      log('H after undo:',JSON.stringify(await hState('undo')));
      await shot('H-after-undo');
    }
    await restoreClipboard();
  }

  /* ---- scenario I: toolbar overlay translucency + labeled menu item ---- */
  {
    await open();
    await fe(`vditor.vditor.ir.element.scrollTop=120;true`);
    await pause(400);
    await shot('I-toolbar-opaque');
    const before=await fe(`(()=>{const tb=vditor.vditor.toolbar.element;const r=tb.getBoundingClientRect();return{toolbarTop:Math.round(r.top),toolbarBottom:Math.round(r.bottom),firstBlockTop:Math.round(vditor.vditor.ir.element.firstElementChild.getBoundingClientRect().top)}})()`);
    await fe(`document.documentElement.style.setProperty('--typora-toolbar-opacity','0.4');true`);
    await pause(400);
    await shot('I-toolbar-alpha40');
    await fe(`document.documentElement.style.setProperty('--typora-toolbar-opacity','1');true`);
    // ⋮ menu with the labeled item.
    const menuProbe=await fe(`(()=>{const more=[...vditor.vditor.toolbar.element.querySelectorAll('button')].find(b=>(b.getAttribute('data-type')||'').includes('more'));if(!more)return{more:false};more.click();const item=[...document.querySelectorAll('.vditor-toolbar button,[data-type="surface-settings"]')].find(b=>b.getAttribute('data-type')==='surface-settings'||b.textContent.includes('透明度'));return{more:true,found:!!item,text:item?(item.textContent||'').trim():null,hasLabel:!!item?.querySelector('.typora-toolbar-label')}})()`);
    log('I label probe:',JSON.stringify(menuProbe));
    await shot('I-more-menu');
    await fe(`(()=>{document.body.click();true})()`);
    log('I layout:',JSON.stringify(before));
  }

  /* ---- scenario B4: does the expanded </u> collapse once the caret leaves? ---- */
  await open();
  if(!await selectWord('每个重要事件','重要事件'))throw new Error('B4 selection failed');
  key('U',['control']);await pause(700);
  const beforeMove=await markerProbe();
  await caretElsewhere();await pause(700);
  const afterLeave=await markerProbe();
  log('B4 before-move visible:',JSON.stringify(beforeMove.markers.filter(m=>m.visible).map(m=>m.text)),
      'after-caret-away visible:',JSON.stringify(afterLeave.markers.filter(m=>m.visible).map(m=>m.text)),
      'stuck-expanded:',JSON.stringify(afterLeave.markers.filter(m=>m.nodeExpand).map(m=>m.text)));

  /* ---- scenario C: verified in a prior round; kept out to keep runs short ---- */
};
