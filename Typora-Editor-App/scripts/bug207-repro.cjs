// v2.0.7 diagnostics: four user reports against 2.0.6.
//  S1/P1 图片缩放 100%→50% 后下方 H2 标题被复制一份（用户原文档 1-重识概率论.md）
//  S2/P2 图片单击选中 + Backspace 直接删除；删除后焦点/滚动跳到后面页面
//  S3/P3 图片右键菜单缺左/中/右对齐项
//  S4/P4 Ctrl+= 不能恢复缩放（Electron zoomIn role 加速键是 Plus）；Ctrl+滚轮为
//      .vditor-content CSS zoom；用户要求下拉+自由输入的比例控件可校准 100%
// 先跑 BUG207_PHASE=before 取证；修复后同脚本 BUG207_PHASE=after 验收（关键帧截图）。
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
exports.run=async({win,output})=>{
  const phase=process.env.BUG207_PHASE||'before';
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const shot=async name=>{try{fs.writeFileSync(path.join(output,`bug207-${phase}-${name}.png`),(await win.webContents.capturePage()).toPNG());}catch(e){console.log('shot fail',name,String(e));}};
  const report={phase,checks:[]};
  const log=(k,v)=>{report.checks.push({check:k,value:v});console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));};

  // ---- fixture: 用户文档 1-重识概率论.md 的等价结构（大 base64 图 + 两个空行 + H2）
  const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc32=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const makePng=(w,h)=>{ // 大部分纯色 + 一条噪声带：解码后 naturalWidth>0，体积 ~100KB+
    const raw=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4);if(y>=80&&y<106){for(let x=0;x<w;x++){const o=1+x*4;row[o]=(x*7+y*13)&255;row[o+1]=(x*3+y*5)&255;row[o+2]=(x*11+y*2)&255;row[o+3]=255;}}else{for(let x=0;x<w;x++){const o=1+x*4;row[o]=40;row[o+1]=60;row[o+2]=90;row[o+3]=255;}}raw.push(row);}
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
    return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);
  };
  const png=makePng(1024,740);
  const dataUri='data:image/png;base64,'+png.toString('base64');
  log('fixture-png-bytes',png.length,'base64-chars',dataUri.length);
  const heading='## 1.4 期望与概率密度函数';
  // 长尾：删除大图后文档仍远高于视口，滚动位置物理上仍存在
  // （短文档删图后内容矮于视口，scrollTop 必然被钳到 0，那是布局约束不是跳页）。
  const tail=Array.from({length:40},(_,i)=>`尾段 ${i+1}：测度论的基本对象是 σ-代数上的概率测度 $P(A)$。`).join('\n\n');
  const fixture=[
    '# 第 1 章 重识概率论','',
    '样本空间 $\\Omega$ 上的随机变量 $X:\\Omega\\to\\mathbb{R}$。','',
    '$$\\mathbb{E}_{\\mathbb{P}}[X]:=\\int_{\\Omega} X\\,d\\mathbb{P}$$','',
    '**Lebesgue 方法**——先在**值域**上取一组点 $\\{f_k\\}$。','',
    '下图上半为 Riemann（竖切），下半为 Lebesgue（横切）：','',
    `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
    '','',
    heading,'',
    '### 1.4.1 Def 随机变量的数学期望','',
    '取 $X:=\\mathbf{1}_{E}$，则 $\\mathbb{E}[X]=\\mathbb{P}(E)$。','',
    '',tail,'',
  ].join('\n');
  const file=path.join(output,'bug207.md');
  fs.writeFileSync(file,fixture);
  let opened=false;
  const open=async()=>{
    if(!opened){
      await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
      opened=true;await pause(700);
    }
    await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
    for(let i=0;i<400;i++){
      const ok=await fe(`vditor.getValue().includes('1.4.1')&&vditor.vditor.currentMode==='ir'`);
      if(ok)break;
      if(i===399)throw new Error('fixture load failed');
      await pause(25);
    }
    await wait("window.__typoraMathStats?.pending===0",'math idle');await pause(400);
  };
  const imgProbe=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const img=[...ir.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    if(!img)return null;
    const r=img.getBoundingClientRect();
    const block=(()=>{let n=img;while(n&&n.parentElement!==ir)n=n.parentElement;return n;})();
    return{loaded:img.complete&&img.naturalWidth>0,naturalWidth:img.naturalWidth,
      rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      scale:img.getAttribute('data-typora-scale'),width:img.getAttribute('width'),
      blockTag:block?.tagName,blockType:block?.getAttribute('data-type'),
      blockHtml:(block?.outerHTML||'').slice(0,300)};})()`);
  const headingCount=()=>fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const dom=[...ir.querySelectorAll('h2')].filter(h=>h.textContent.includes('1.4 期望与概率密度函数')).length;
    const value=vditor.getValue();
    const md=(value.match(/## 1\\.4 期望与概率密度函数/g)||[]).length;
    const imgTags=(value.match(/<img\\b/g)||[]).length;
    const domImgs=[...ir.querySelectorAll('img')].filter(i=>i.src.startsWith('data:')).length;
    return{domH2:dom,mdH2:md,imgTags,domImgs,scrollTop:Math.round(ir.scrollTop),
      reuse:vditor.vditor.__typoraRenderReuse||null};})()`);

  // ---------------- S1: 缩放 100→50 复制标题？ -----------------------------
  await open();
  await wait("(()=>{const img=[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));return !!(img&&img.complete&&img.naturalWidth>0);})()",'img load');
  log('S1-before',await headingCount());
  log('S1-img',await imgProbe());
  await shot('s1-before');
  // 抓 setValue 入参：区分「序列化出的 md 已含重复」与「reconcile 渲染重复」
  await fe(`(()=>{const cap=[];const orig=vditor.setValue;vditor.setValue=function(v){cap.push(String(v));return orig.apply(this,arguments)};window.__cap=cap;return true;})()`);
  const err=await fe(`(()=>{window.__scaleErr=null;try{const img=[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));vditor.__media.setScale(img,'50');}catch(e){window.__scaleErr=String(e&&e.message||e)}return window.__scaleErr||'ok';})()`);
  log('S1-setScale',err);
  await pause(600);
  const cap=await fe(`(window.__cap||[]).map(v=>({len:v.length,h2:(v.match(/## 1\\.4 期望与概率密度函数/g)||[]).length,imgTags:(v.match(/<img\\b/g)||[]).length,scale50:v.includes('data-typora-scale="50"')}))`);
  log('S1-captured-md',cap);
  log('S1-after',await headingCount());
  await shot('s1-after');
  const ok1=cap.length>0&&cap[0].h2===1&&(await headingCount()).mdH2===1&&(await headingCount()).domH2===1;
  log('S1-verdict',ok1?'PASS':'FAIL');
  // 复原：重新载入（后续场景用干净文档）
  await open();

  // ---------------- S2: 单击选中 + Backspace 删除 --------------------------
  const iframeRect=()=>win.webContents.executeJavaScript(`document.getElementById('editor').getBoundingClientRect().toJSON()`,true);
  const clickImg=async button=>{
    const info=await imgProbe();const fr=await iframeRect();
    const x=Math.round(fr.left+info.rect.x+info.rect.w/2),y=Math.round(fr.top+info.rect.y+Math.min(30,info.rect.h/2));
    win.webContents.sendInputEvent({type:'mouseDown',x,y,button,clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x,y,button,clickCount:1});
    await pause(250);
    return{x,y};
  };
  const selState=()=>fe(`(()=>{const s=getSelection();if(!s.rangeCount)return{none:true};
    const img=[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    const r=s.getRangeAt(0);
    const contains=img?r.intersectsNode(img)&&!s.isCollapsed:false;
    return{containsImg:contains,selectedClass:img?.classList.contains('typora-img-selected')||false,
      collapsed:s.isCollapsed,txt:String(s.toString()).slice(0,40)};})()`);
  // 把图滚到视口中部，删除后才有"跳页"可言
  await fe(`(()=>{const ir=vditor.vditor.ir.element;const img=[...ir.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));const r=img.getBoundingClientRect();ir.scrollTop=Math.max(0,ir.scrollTop+r.top-180);return true;})()`);
  await pause(200);
  const scrollBefore=await fe('Math.round(vditor.vditor.ir.element.scrollTop)');
  await clickImg('left');
  log('S2-click-select',await selState());
  await shot('s2-clicked');
  const before2=await headingCount();
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});
  await pause(500);
  const after2=await headingCount();
  log('S2-backspace',{before:{imgTags:before2.imgTags,scrollTop:scrollBefore},after:{imgTags:after2.imgTags,mdH2:after2.mdH2,domH2:after2.domH2,scrollTop:after2.scrollTop},sel:await selState()});
  await shot('s2-backspace');
  const selAfter=await selState();
  const caretInHeading=await fe(`(()=>{const s=getSelection();if(!s.rangeCount)return false;const n=s.anchorNode?.nodeType===3?s.anchorNode.parentElement:s.anchorNode;return !!n?.closest?.('h2,h3')||!!n?.closest?.('p');})()`);
  const ok2=after2.imgTags===0&&after2.mdH2===1&&after2.domH2===1&&Math.abs(after2.scrollTop-scrollBefore)<=4&&selAfter.containsImg===false&&caretInHeading;
  log('S2-verdict',ok2?'PASS':'FAIL');
  // S2b: 图片下方最近光标位 + 单次 Backspace（旧路径回归观察：不腐蚀文档、不跳页）
  await open();
  const caretBelow=await fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const h=[...ir.querySelectorAll('h2')].find(x=>x.textContent.includes('1.4 期望'));
    const r=h?h.getBoundingClientRect():null;
    return r?{x:Math.round(r.x+30),y:Math.round(r.y+6),beforeScroll:Math.round(ir.scrollTop)}:null;})()`);
  if(caretBelow){
    await fe(`vditor.vditor.ir.element.scrollTop=${Math.max(0,caretBelow.beforeScroll)};true`);
    const fr=await iframeRect();
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(fr.left+caretBelow.x),y:Math.round(fr.top+caretBelow.y),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(fr.left+caretBelow.x),y:Math.round(fr.top+caretBelow.y),button:'left',clickCount:1});
    await pause(250);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});
    await pause(400);
    const st=await headingCount();
    log('S2b-below-backspace',{startScroll:caretBelow.beforeScroll,endScroll:st.scrollTop,jump:Math.abs(st.scrollTop-caretBelow.beforeScroll),imgTags:st.imgTags,mdH2:st.mdH2,domH2:st.domH2});
    await shot('s2b-after');
  }

  // ---------------- S3: 右键菜单项 + 对齐生效 ------------------------------
  await open();
  await clickImg('right');
  const items=await fe(`[...document.querySelectorAll('#typora-editor-context-menu button,[role=menuitem]')].map(b=>b.textContent)`);
  log('S3-menu-items',items);
  const hasAlign=['左对齐','居中对齐','右对齐'].every(t=>items.some(x=>x.includes(t)));
  await shot('s3-menu');
  await fe(`document.getElementById('typora-editor-context-menu')?.__typoraClose?.();true`);
  await pause(150);
  // 功能验证：居中 → 源码与渲染都应变化；再切右对齐、回左对齐（属性应消失）
  const alignResult=await fe(`(async()=>{
    const out={};
    const img=()=>[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    vditor.__media.setAlign(img(),'center');
    out.center={attr:img().getAttribute('data-typora-align'),display:getComputedStyle(img()).display,
      marginLeft:autoPx(img(),'marginLeft'),marginRight:autoPx(img(),'marginRight'),
      inSource:vditor.getValue().includes('data-typora-align="center"')};
    vditor.__media.setAlign(img(),'right');
    out.right={attr:img().getAttribute('data-typora-align'),inSource:vditor.getValue().includes('data-typora-align="right"')};
    vditor.__media.setAlign(img(),'left');
    out.left={attr:img().getAttribute('data-typora-align'),removedFromSource:!vditor.getValue().includes('data-typora-align')};
    out.h2AfterAlign=(vditor.getValue().match(/## 1\\.4 期望与概率密度函数/g)||[]).length;
    function autoPx(el,prop){const v=getComputedStyle(el)[prop];return v==='auto'?'auto':Math.round(parseFloat(v));}
    return out;})()`);
  log('S3-align-functional',alignResult);
  const ok3=hasAlign&&alignResult.center.attr==='center'&&alignResult.center.display==='block'
    &&alignResult.center.inSource&&alignResult.right.attr==='right'&&alignResult.right.inSource
    &&alignResult.left.attr===null&&alignResult.left.removedFromSource&&alignResult.h2AfterAlign===1;
  log('S3-verdict',ok3?'PASS':'FAIL');

  // ---------------- S4: 缩放键 / 滚轮 / 徽章控件 ---------------------------
  await open();
  const contentZoom=()=>fe(`(()=>{const el=document.querySelector('.vditor-content');return el?(el.style.zoom||'100%'):null;})()`);
  // 聚焦编辑区
  {
    const info=await imgProbe();const fr=await iframeRect();
    const x=Math.round(fr.left+info.rect.x-40),y=Math.round(fr.top+info.rect.y-20);
    win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
    await pause(200);
  }
  const z0={content:await contentZoom(),webContents:win.webContents.getZoomFactor()};
  // 键盘走页面内合成事件（真实注入通道的 ctrlKey 恒为 false——probe6 实测，
  // 属注入通道限制而非应用缺陷；滚轮保留真实注入路径）。
  const press=async(key,extra={})=>{
    await fe(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true,...${JSON.stringify(extra)}}));return true;})()`);
    await pause(150);
  };
  await press('=');const zEq={content:await contentZoom(),webContents:win.webContents.getZoomFactor()};
  await press('+');const zPlus={content:await contentZoom(),webContents:win.webContents.getZoomFactor()};
  await press('-');const zMinus={content:await contentZoom(),webContents:win.webContents.getZoomFactor()};
  await press('0');const zZero={content:await contentZoom(),webContents:win.webContents.getZoomFactor()};
  // Ctrl+滚轮：先页面内合成事件验证方向（deltaY<0 = 放大，确定值），再用真实
  // 注入验证 5% 步进（该注入通道会翻转 deltaY 符号——before 阶段 100→90 双触
  // 发已证实——所以只断言步长，不断言方向）。
  await fe(`(()=>{document.querySelector('.vditor-content').dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-100,bubbles:true,cancelable:true}));return true;})()`);
  await pause(150);
  const zWheelSynthetic=await contentZoom();
  {
    const fr=await iframeRect();
    win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(fr.left+200),y:Math.round(fr.top+300),deltaY:-100,modifiers:['control']});
    await pause(250);
  }
  const zWheel={content:await contentZoom(),webContents:win.webContents.getZoomFactor()};
  const badge=await fe(`(()=>{const b=document.querySelector('.typora-zoom-badge');if(!b)return null;const r=b.getBoundingClientRect();return{txt:b.textContent,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()`);
  // 徽章点击 → 弹出面板 → 自由输入 83% → 应用
  let popupInfo=null,custom=null,stored=null;
  if(badge){
    const fr=await iframeRect();
    const bx=Math.round(fr.left+badge.x+badge.w/2),by=Math.round(fr.top+badge.y+badge.h/2);
    win.webContents.sendInputEvent({type:'mouseDown',x:bx,y:by,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:bx,y:by,button:'left',clickCount:1});
    await pause(250);
    popupInfo=await fe(`(()=>{const p=document.querySelector('.typora-zoom-pop');if(!p)return null;return{visible:!p.hidden,presets:[...p.querySelectorAll('[data-preset]')].map(b=>b.textContent),hasInput:!!p.querySelector('input[type=number]')};})()`);
    if(popupInfo?.visible){
      await fe(`(()=>{const p=document.querySelector('.typora-zoom-pop');const i=p.querySelector('input[type=number]');i.value='83';i.dispatchEvent(new Event('input',{bubbles:true}));p.querySelectorAll('button').forEach(b=>{if(b.textContent==='应用')b.click();});return true;})()`);
      await pause(200);
      custom=await contentZoom();
      stored=await fe(`localStorage.getItem('typora-content-zoom')`);
      await shot('s4-popup');
      // 关闭面板并复位 100%
      await fe(`document.querySelector('.typora-zoom-pop').hidden=true;window.__zoomReset?.();true`);
      await fe(`(()=>{const m=window.__typoraZoom;if(m)m.set(100);return document.querySelector('.vditor-content')?.style.zoom;})()`);
    }
  }
  log('S4-zoom',{base:z0,ctrlEq:zEq,ctrlShiftEq:zPlus,ctrlMinus:zMinus,ctrlZero:zZero,ctrlWheelSynthetic:zWheelSynthetic,ctrlWheelReal:zWheel,badge,popup:popupInfo,customInput:custom,localStorage:stored});
  const syn=parseInt(zWheelSynthetic)||0,real=parseInt(zWheel.content)||100;
  const ok4=zEq.content==='105%'&&zPlus.content==='110%'&&zMinus.content==='105%'&&zZero.content==='100%'
    &&zWheelSynthetic==='105%'&&Math.abs(real-syn)===5
    &&!!badge&&badge.txt.endsWith('%')&&popupInfo?.visible&&popupInfo.presets.length>=8&&popupInfo.hasInput&&custom==='83%'&&stored==='83'
    &&zEq.webContents===1&&zZero.webContents===1;
  log('S4-verdict',ok4?'PASS':'FAIL');
  await shot('s4-zoom');
  // 复原 content zoom，避免影响后续套件
  await fe(`(()=>{document.querySelector('.vditor-content')?.style.setProperty('zoom','');try{localStorage.removeItem('typora-content-zoom')}catch(e){}true})()`);

  fs.writeFileSync(path.join(output,`bug207-${phase}-report.json`),JSON.stringify(report,null,2));
  console.log('bug207 done, phase='+phase);
};
