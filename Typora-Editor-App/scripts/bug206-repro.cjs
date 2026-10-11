// v2.0.6 diagnostics: seven user reports against 2.0.5.
//  P1 ⋮(more) menu: is the surface-settings(透明度) entry present?
//  P2 preview mode: device row (Desktop/tablet/mobile/WeChat/知乎) vs toolbar overlap
//  P3 toolbar icon alignment + IR scrollbar x-position with panels closed
//  P4 math layout: "(2) $formula$" gap, overflow/clipping (wide + pane width)
//  P5 measure width (.vditor-reset clientWidth vs window)
//  P6 telari-dark blockquote background in IR
//  P7 heading weight vs strong (Ctrl+B)
// Pure diagnosis first (BUG206_PHASE=before); same script is the acceptance
// pass after fixes (BUG206_PHASE=after): keyframe screenshot per operation.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const phase=process.env.BUG206_PHASE||'before';
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const shellEval=code=>win.webContents.executeJavaScript(code,true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const shot=async name=>{try{fs.writeFileSync(path.join(output,`bug206-${phase}-${name}.png`),(await win.webContents.capturePage()).toPNG());}catch(e){console.log('shot fail',name,String(e));}};
  const report={phase,checks:[]};
  const log=(k,v)=>{report.checks.push({check:k,value:v});console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));};

  // --- fixture: math-heavy document with the user's exact formula ----------
  const formula='\\{E_n\\}^{\\infty}\\subset \\sigma(X)\\Leftrightarrow \\exists \\{B_n\\}^{\\infty}\\subset\\mathcal{B},\\ s.t.\\ E_n=X^{-1}(B_n)\\ \\overset{\\cup_n B_n\\in \\mathcal{B}}{\\Longrightarrow}\\ \\bigcup_n^\\infty E_n=X^{-1}\\big(\\bigcup_{n}^\\infty B_n\\big)\\in \\sigma(X)';
  const fixture=[
    '# 第 1 章 随机变量与测度',
    '',
    '样本空间 $\\Omega$ 上的累积分布函数 $F_X$ 的导数是密度。',
    '',
    `(2) $${formula}$。`,
    '',
    '短公式行：事件 $A\\subseteq\\Omega$ 的概率 $P(A)$ 有界。',
    '',
    '$$\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi} \\qquad \\text{（Gauss 积分）}$$',
    '',
    '> 引用：一个事件的概率是样本空间上的测度，先验分布与后验分布通过 Bayes 公式相联系。',
    '',
    '## 标题粗细对照',
    '',
    '正文里的**加粗对照词**与普通词并列。',
    ''
  ].join('\n');
  const file=path.join(output,'bug206.md');
  fs.writeFileSync(file,fixture);
  let openedOnce=false;
  const open=async()=>{
    if(!openedOnce){
      await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
      openedOnce=true;await pause(700);
    }
    await fe(`vditor.setValue(${JSON.stringify(fixture)});true`);
    for(let i=0;i<400;i++){
      const ok=await fe(`vditor.getValue().length>400&&vditor.getValue().includes('(2)')&&vditor.vditor.currentMode==='ir'`);
      if(ok)break;
      if(i===399){const v=await fe('vditor.getValue()');console.log('OPEN DIAG',JSON.stringify({mode:await fe('vditor.vditor.currentMode'),len:v?.length,value:String(v).slice(0,120)}));throw new Error('fixture load failed');}
      await pause(25);
    }
    await wait("window.__typoraMathStats?.pending===0",'math idle');await pause(400);
  };
  const setTheme=async t=>{await fe(`import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'${t}',true))`);await pause(350);};
  const toolbarGeom=()=>fe(`(()=>{
    const w=window,doc=w.document;
    const tb=doc.querySelector('.vditor>.vditor-toolbar');
    const items=[...tb.querySelectorAll(':scope > .vditor-toolbar__item')];
    const first=items[0]?.getBoundingClientRect(),last=items[items.length-1]?.getBoundingClientRect();
    return{toolbar:{left:Math.round(tb.getBoundingClientRect().left),right:Math.round(tb.getBoundingClientRect().right),w:Math.round(tb.getBoundingClientRect().width),h:Math.round(tb.getBoundingClientRect().height),cls:tb.className},
      n:items.length,firstLeft:first?Math.round(first.left):null,lastRight:last?Math.round(last.right):null,
      winW:doc.documentElement.clientWidth,computedAlign:getComputedStyle(tb).textAlign||getComputedStyle(tb).justifyContent};})()`);
  const scrollGeom=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const r=ir.getBoundingClientRect();
    const host=ir.closest('.vditor-content')||ir.parentElement;
    const hr=host.getBoundingClientRect();
    return{scroller:{left:Math.round(r.left),right:Math.round(r.right),w:Math.round(r.width)},
      content:{left:Math.round(hr.left),right:Math.round(hr.right)},
      scrollW:ir.scrollWidth,clientW:ir.clientWidth,vScroll:ir.scrollHeight>ir.clientHeight+1,
      winW:window.document.documentElement.clientWidth,
      resetMaxWidth:getComputedStyle(ir).maxWidth,resetMargin:getComputedStyle(ir).marginLeft};})()`);

  // ---------------- S1: more menu contents (P1) ----------------------------
  await open();
  await shot('s1-baseline');
  const menuState=await fe(`(()=>{
    const tb=window.document.querySelector('.vditor>.vditor-toolbar');
    const more=tb.querySelector('button[data-type="more"]');
    if(!more)return{found:false};
    more.click();
    return{found:true};})()`);
  await pause(600);
  const panel=await fe(`(()=>{
    const tb=window.document.querySelector('.vditor>.vditor-toolbar');
    const hints=[...tb.querySelectorAll('.vditor-hint')].filter(p=>getComputedStyle(p).display!=='none');
    const p=hints[hints.length-1];
    if(!p)return{open:false};
    const btns=[...p.querySelectorAll('button')].map(b=>({type:b.getAttribute('data-type'),text:(b.textContent||'').trim().slice(0,24)}));
    return{open:true,panelClass:p.className,rect:(()=>{const r=p.getBoundingClientRect();return{top:Math.round(r.top),left:Math.round(r.left),bottom:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)};})(),
      tbBottom:Math.round(tb.getBoundingClientRect().bottom),tbRight:Math.round(tb.getBoundingClientRect().right),
      entries:btns,hasSurface:btns.some(b=>b.type==='surface-settings'),
      surfaceVisible:(()=>{const b=[...p.querySelectorAll('button')].find(x=>x.getAttribute('data-type')==='surface-settings');if(!b)return false;const r=b.getBoundingClientRect();const pr=p.getBoundingClientRect();return r.height>0&&r.top>=pr.top-1&&r.bottom<=pr.bottom+1&&r.top>=0&&r.bottom<=window.innerHeight;})()};})()`);
  log('S1-more-menu',panel);
  await shot('s1-more-menu');

  // ---------------- S2: preview device row vs toolbar (P2) -----------------
  if(panel.open){
    await fe(`(()=>{const p=[...window.document.querySelectorAll('.vditor-toolbar .vditor-hint')].filter(x=>getComputedStyle(x).display!=='none').pop();const b=[...p.querySelectorAll('button')].find(b=>b.getAttribute('data-type')==='preview');if(b){b.click();return true}return false})()`);
    await pause(900);
    const pv=await fe(`(()=>{
      const tb=window.document.querySelector('.vditor>.vditor-toolbar');
      const act=window.document.querySelector('.vditor-preview__action');
      const pv=window.document.querySelector('.vditor-preview');
      const tbr=tb.getBoundingClientRect();
      const out={mode:vditor.vditor.currentMode,
        toolbar:{bottom:Math.round(tbr.bottom),top:Math.round(tbr.top)},
        action:null,previewVisible:!!pv&&getComputedStyle(pv).display!=='none'};
      if(act){const r=act.getBoundingClientRect();out.action={top:Math.round(r.top),left:Math.round(r.left),h:Math.round(r.height),bottom:Math.round(r.bottom),text:(act.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60),overlapToolbar:r.top<tbr.bottom-1&&r.bottom>tbr.top+1};}
      return out;})()`);
    log('S2-preview-row',pv);
    await shot('s2-preview-row');
    // back to IR: the preview toolbar item is a toggle — click it again.
    await fe(`(()=>{const it=vditor.vditor.toolbar.elements['preview'];const b=it&&it.querySelector('button');if(b){b.click();return true}return false})()`);
    await pause(800);
    await fe(`vditor.setValue(${JSON.stringify(fixture)});true`);
    await wait(`vditor.vditor.currentMode==='ir'&&vditor.getValue().length>400&&vditor.getValue().includes('(2)')`,'back to ir');
    await wait("window.__typoraMathStats?.pending===0",'math idle 2');await pause(400);
  }

  // ---------------- S3: panels closed → scrollbar + toolbar (P3) -----------
  await shot('s3-panels-open');
  const s3={open:{toolbar:await toolbarGeom(),scroll:await scrollGeom()}};
  const st=async id=>shellEval(`(()=>{const b=document.getElementById('${id}');if(!b)return false;b.click();return true})()`);
  const panelState=async()=>shellEval(`(()=>({sidebar:getComputedStyle(document.getElementById('sidebar')).display!=='none',
    outline:!!document.querySelector('#editor')?.contentWindow?.document.querySelector('.vditor-outline')&&getComputedStyle(document.querySelector('#editor').contentWindow.document.querySelector('.vditor-outline')).display!=='none'}))()`);
  s3.stateOpen=await panelState();
  if(s3.stateOpen.sidebar){await st('st-files');await pause(700);}
  s3.stateMid=await panelState();
  s3.mid={toolbar:await toolbarGeom(),scroll:await scrollGeom()};
  await shot('s3-sidebar-closed');
  if(s3.stateMid.outline){await st('st-outline');await pause(700);}
  s3.stateClosed=await panelState();
  s3.closed={toolbar:await toolbarGeom(),scroll:await scrollGeom()};
  await shot('s3-both-closed');
  log('S3-panels',s3);
  // restore panels
  if(!(await panelState()).outline){await st('st-outline');await pause(500);}
  if(!(await panelState()).sidebar){await st('st-files');await pause(500);}

  // ---------------- S4: math layout (P4/P5) wide + pane width ---------------
  await setTheme('telari-light');
  const mathGeom=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const ps=[...ir.querySelectorAll('p')];
    const numbered=ps.find(p=>p.textContent.trim().startsWith('(2)'));
    const out={reset:{clientW:ir.clientWidth,scrollW:ir.scrollWidth,maxWidth:getComputedStyle(ir).maxWidth,computedPadLeft:getComputedStyle(ir).paddingLeft},
      hOverflow:ir.scrollWidth>ir.clientWidth+1,winW:window.innerWidth};
    if(numbered){
      const kat=numbered.querySelector('.katex');
      const text=numbered.firstChild;
      const kr=kat?.getBoundingClientRect();
      // first line rect of the paragraph
      const rg=window.document.createRange();rg.selectNodeContents(numbered);
      const line1=[...rg.getClientRects()][0];
      out.numbered={p:{left:Math.round(numbered.getBoundingClientRect().left),w:Math.round(numbered.getBoundingClientRect().width)},
        line1:line1?{left:Math.round(line1.left),right:Math.round(line1.right),h:Math.round(line1.height)}:null,
        katex:kr?{left:Math.round(kr.left),right:Math.round(kr.right),top:Math.round(kr.top),w:Math.round(kr.width)}:null,
        katexClipped:kr?Math.round(kr.right)>ir.clientWidth+Math.round(ir.getBoundingClientRect().left)+ir.scrollLeft:false,
        gapOnLine1:kr&&line1?Math.round(Math.max(0,kr.top>=line1.top-2&&kr.top<line1.bottom?kr.left-line1.right:-1)):-1};
    }
    const disp=[...ir.querySelectorAll('.katex-display')].map(d=>{const r=d.getBoundingClientRect();return{w:Math.round(r.width),right:Math.round(r.right),clipped:Math.round(r.right)>ir.clientWidth+Math.round(ir.getBoundingClientRect().left)};});
    out.displayMath=disp;
    return out;})()`);
  const wide=await mathGeom();
  log('S4-math-wide',wide);
  await shot('s4-math-telari-light');
  // pane-width window (IDE-like)
  const orig=win.getBounds();
  await win.setBounds({width:860,height:900});
  await pause(700);
  const pane=await mathGeom();
  log('S4-math-pane860',pane);
  await shot('s4-math-pane860');
  await win.setBounds({width:orig.width,height:orig.height});
  await pause(700);

  // ---------------- S5: blockquote background (P6) --------------------------
  const quoteGeom=async theme=>{await setTheme(theme);
    return fe(`(()=>{
      const q=vditor.vditor.ir.element.querySelector('blockquote');
      const cs=getComputedStyle(q);
      return{theme:'${theme}',bg:cs.backgroundColor,borderLeft:cs.borderLeftColor,borderLeftWidth:cs.borderLeftWidth,color:cs.color};})()`);};
  const qDark=await quoteGeom('telari-dark');
  await shot('s5-quote-telari-dark');
  log('S5-quote-dark',qDark);
  const qLight=await quoteGeom('telari-light');
  log('S5-quote-light',qLight);

  // ---------------- S6: heading vs strong weight (P7) ----------------------
  const weights=await fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const h2=ir.querySelector('h2'),str=ir.querySelector('p strong')||ir.querySelector('strong');
    const cs=e=>{const c=getComputedStyle(e);return{weight:c.fontWeight,stroke:c.webkitTextStrokeWidth,strokeColor:c.webkitTextStrokeColor,size:c.fontSize,family:c.fontFamily.slice(0,36)};};
    return{h2:h2?cs(h2):null,strong:str?cs(str):null};})()`);
  log('S6-weights',weights);
  await shot('s6-heading-strong-telari-light');
  await setTheme('telari-dark');
  await shot('s6-heading-strong-telari-dark');
  await setTheme('telari-light');

  fs.writeFileSync(path.join(output,`bug206-${phase}-report.json`),JSON.stringify(report,null,2));
  return report;
};
