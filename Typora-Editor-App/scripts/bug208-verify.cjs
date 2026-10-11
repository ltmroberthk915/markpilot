// v2.0.8 acceptance (four user requests against 2.0.7):
//  T1 目录栏相对字号调小与正文协调（正文 14px 时目录 12px），随 Ctrl+滚轮同比缩放
//  T2 拓然宋两模式正文宋体细描边微加粗（p=0.01em≈0.14px；h2/code/th 清零、
//     strong 保持 0.015em，磅数相对排序不变）
//  T3 主题按钮改名：宋体-朙（telari-light）/ 宋体-暗（telari-dark）
//  T4 工具栏岛：宽度收缩到按钮（自适应），左右半圆端帽；岛外命中正文区
// 先 BUG208_PHASE=before 在 2.0.7 上取证基线；修复后 BUG208_PHASE=after 验收。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert');
exports.run=async({win,output})=>{
  const phase=process.env.BUG208_PHASE||'before';
  const after=phase==='after';
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const shot=async name=>{try{fs.writeFileSync(path.join(output,`bug208-${phase}-${name}.png`),(await win.webContents.capturePage()).toPNG());}catch(e){console.log('shot fail',name,String(e));}};
  const report={phase,checks:[]};
  const log=(k,v)=>{report.checks.push({check:k,value:v});console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));};
  const fixture=[
    '# 第 1 章 版式基线','',
    '普通正文一段：测量目录栏与正文的相对字号，以及宋体的描边磅数。','',
    '## 1.1 标题二','',
    '**加粗文字**与普通文字以及 `行内代码` 的对比，再有 *斜体楷体中文字样* 一段。','',
    '### 1.1.1 标题三','',
    '再一段普通正文，用于目录栏字号对比的第二行。','',
    '```js','const x=1;','```','',
    '| 表头甲 | 表头乙 |','| --- | --- |','| 单元一 | 单元二 |','| 单元三 | 单元四 |','',
    '## 1.2 第二个标题二','',
    '> 引用一行。','',
  ].join('\n');
  const file=path.join(output,'bug208.md');
  fs.writeFileSync(file,fixture);

  await wait(`vditor.getValue().length>0`,'editor ready');
  await shot('t0-start');

  // ---- 大纲开关走真实用户路径：工具栏 outline 按钮写 localStorage，重开文档生效
  const outlineFlag=await fe(`(()=>{vditor.vditor.toolbar.elements['outline'].querySelector('button').click();return localStorage.getItem('outline');})()`);
  log('outline-flag',outlineFlag);
  assert.equal(outlineFlag,'true','outline 按钮应把 localStorage 置为 true');
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  // vditor 内建 outline 工具项会在旧 iframe 上即时开关面板（干扰探测），
  // openFile 的 iframe 导航又较慢——一律等到样例文档真实就绪再量。
  await wait(`vditor.getValue().includes('版式基线')&&vditor.vditor.currentMode==='ir'`,'fixture loaded');
  await wait(`(()=>{const p=document.querySelector('.vditor-outline');return p&&getComputedStyle(p).display!=='none'&&p.querySelectorAll('li').length>=4;})()`,'outline panel visible');

  // ---- T1 目录栏字号
  const outlineFont=await fe(`(()=>{
    const panel=document.querySelector('.vditor-outline');
    const span=panel.querySelector('li > span > span');
    const p=document.querySelector('.vditor-reset p');
    return {panelFont:getComputedStyle(panel).fontSize,spanFont:getComputedStyle(span).fontSize,
            bodyFont:getComputedStyle(p).fontSize,inContent:!!panel.closest('.vditor-content'),
            items:panel.querySelectorAll('li').length,
            firstItem:(span?.textContent||'').slice(0,18),firstP:(p?.textContent||'').slice(0,18)};
  })()`);
  log('t1-outline-font',outlineFont);
  assert.equal(outlineFont.inContent,true,'目录栏应在 .vditor-content 内（随内容缩放）');
  if(after){
    assert.equal(outlineFont.panelFont,'12px','目录栏应为 12px（正文 14px 的 6/7）');
    assert.equal(outlineFont.spanFont,'12px','目录条目继承 12px');
    assert.equal(outlineFont.bodyFont,'14px','正文保持 14px');
  }else{
    assert.equal(outlineFont.panelFont,'14px','基线：2.0.7 目录栏与正文同为 14px');
    assert.equal(outlineFont.bodyFont,'14px','正文 14px');
  }
  await shot('t1-outline');

  // ---- T4 工具栏岛几何 + 命中判定 + 自适应
  const islandCode=`(()=>{
    try{
    const vd=document.querySelector('.vditor');
    if(!vd)return {error:'no .vditor'};
    const bar=vd.querySelector(':scope > .vditor-toolbar');
    if(!bar)return {error:'no toolbar child'};
    const r=bar.getBoundingClientRect(),v=vd.getBoundingClientRect();
    const style=getComputedStyle(bar);
    const y=r.top+r.height/2;
    const hitOutside=document.elementFromPoint(v.left+18,y);
    const hitCenter=document.elementFromPoint(v.left+v.width/2,y);
    return {barW:+r.width.toFixed(1),vdW:+v.width.toFixed(1),
            cx:+(((r.left+r.right)/2)-((v.left+v.right)/2)).toFixed(2),
            radius:style.borderRadius,pos:style.position,w:style.width,
            hitOutsideInBar:!!(hitOutside&&bar.contains(hitOutside)),
            hitOutsideInContent:!!(hitOutside&&hitOutside.closest('.vditor-content')),
            hitOutsideTag:hitOutside?(String(hitOutside.className&&hitOutside.className.baseVal!==undefined?hitOutside.className.baseVal:hitOutside.className).slice(0,60)||hitOutside.nodeName):'null',
            hitCenterInBar:!!(hitCenter&&bar.contains(hitCenter))};
    }catch(e){return {error:String(e)}}
  })()`;
  let island=await fe(islandCode);
  // iframe 可能在二次导航中：岛测量轮询等 vditor 就绪且探针无 error
  for(let i=0;i<80&&(!island||island.error);i++){await pause(50);island=await fe(islandCode);}
  if(!island||island.error)throw new Error('island probe failed: '+JSON.stringify(island));
  log('t4-island',island);
  assert.equal(island.pos,'absolute','工具栏仍为悬浮绝对定位');
  assert.equal(island.hitCenterInBar,true,'工具栏中部命中工具栏自身');
  if(after){
    assert.ok(island.barW<=island.vdW-100,`工具栏岛应收缩宽度（${island.barW} < ${island.vdW}-100）`);
    assert.ok(Math.abs(island.cx)<=1.5,'工具栏岛应水平居中，偏差 '+island.cx);
    assert.equal(island.radius,'999px','左右端帽应为半圆（border-radius 999px）');
    // computed width 会把 fit-content 解析成用值像素；收缩+自适应增长两断言证明语义
    assert.equal(island.hitOutsideInBar,false,'岛外（左端 18px 处）不得命中工具栏');
    assert.equal(island.hitOutsideInContent,true,'岛外应露出正文编辑区（.vditor-content）');
  }else{
    assert.ok(island.barW>=island.vdW-2,'基线：2.0.7 工具栏为全宽条带 '+island.barW);
    assert.equal(island.hitOutsideInBar,true,'基线：全宽条带左端命中工具栏');
  }
  const adapt=await fe(`(()=>{
    const bar=document.querySelector('.vditor > .vditor-toolbar');
    const before=bar.getBoundingClientRect().width;
    const item=document.createElement('div');item.className='vditor-toolbar__item';
    const b=document.createElement('button');b.type='button';b.style.width='26px';b.style.height='24px';b.textContent='⊕';
    item.append(b);bar.append(item);
    const r=bar.getBoundingClientRect();
    const vd=document.querySelector('.vditor').getBoundingClientRect();
    const out={before:+before.toFixed(1),after:+r.width.toFixed(1),grewPx:+(r.width-before).toFixed(1),
               cxAfter:+(((r.left+r.right)/2)-((vd.left+vd.right)/2)).toFixed(2)};
    item.remove();
    return out;
  })()`);
  log('t4-adaptivity',adapt);
  if(after){
    assert.ok(adapt.grewPx>=25,'新增工具按钮后岛宽应自动增长 ≥25px，实际 '+adapt.grewPx);
    assert.ok(Math.abs(adapt.cxAfter)<=1.5,'增长后仍居中，偏差 '+adapt.cxAfter);
  }
  await shot('t4-toolbar');

  // ---- T3 主题对话框（真实路径）：按钮名
  await fe(`vditor.vditor.toolbar.elements['theme-settings'].querySelector('button').click();true`);
  await wait(`!!document.getElementById('typora-themes')&&document.getElementById('typora-themes').open`,'theme dialog open');
  const labels=await fe(`[...document.querySelectorAll('#typora-themes [data-theme]')].map(b=>b.textContent)`);
  log('t3-theme-labels',labels);
  if(after){
    assert.ok(labels.includes('宋体-朙'),'应出现按钮 宋体-朙');
    assert.ok(labels.includes('宋体-暗'),'应出现按钮 宋体-暗');
    assert.ok(!labels.some(l=>l.includes('拓然宋')),'不应再出现 拓然宋 旧名');
  }else{
    assert.ok(labels.some(l=>l.includes('拓然宋')),'基线：2.0.7 仍为 拓然宋 命名');
  }
  await shot('t3-themes-dialog');

  // ---- T2 切到 telari-light 量描边（真实点击路径）
  const strokeOf=()=>fe(`(()=>{
    const p=document.querySelector('.vditor-reset p');
    const h2=document.querySelector('.vditor-reset h2');
    const strong=document.querySelector('.vditor-reset strong');
    const code=document.querySelector('.vditor-reset code');
    const th=document.querySelector('.vditor-reset th');
    const g=el=>el?getComputedStyle(el).webkitTextStrokeWidth:null;
    return {theme:document.documentElement.dataset.editorTheme,p:g(p),h2:g(h2),strong:g(strong),code:g(code),th:g(th)};
  })()`);
  await fe(`document.querySelector('#typora-themes [data-theme="telari-light"]').click();true`);
  await fe(`document.querySelector('#typora-themes footer button').click();true`);
  await wait(`document.documentElement.dataset.editorTheme==='telari-light'`,'telari-light applied');
  await pause(400);
  const light=await strokeOf();
  log('t2-stroke-light',light);
  if(after){
    assert.equal(light.p,'0.14px','拓然宋浅色：正文细描边 0.01em×14px');
    assert.equal(light.h2,'0px','标题保持无描边（原有 700 字重不变）');
    assert.equal(light.strong,'0.21px','strong 保持 fontsize.css 的 0.015em 加肥');
    assert.equal(light.code,'0px','代码不参与正文加粗');
    assert.equal(light.th,'0px','表头不参与正文加粗');
  }else{
    assert.equal(light.p,'0px','基线：2.0.7 正文无描边');
    assert.equal(light.strong,'0.21px','基线：strong 0.015em');
  }
  await shot('t2-telari-light');
  const aria=await fe(`vditor.vditor.toolbar.elements['theme-settings'].querySelector('button').getAttribute('aria-label')`);
  log('t3-aria-label',aria);
  if(after)assert.ok(aria.includes('宋体-朙'),'主题按钮 aria-label 应含新名 宋体-朙：'+aria);

  // ---- T5a/T6（light 侧）：表格协调 + 楷体字距
  const tableOf=()=>fe(`(()=>{
    const rows=[...document.querySelectorAll('.vditor-reset tbody tr')];
    const td=rows[0]?.querySelector('td');
    return {oddBg:rows[0]?getComputedStyle(rows[0]).backgroundColor:null,
            evenBg:rows[1]?getComputedStyle(rows[1]).backgroundColor:null,
            tdBorder:td?getComputedStyle(td).borderTopColor:null,
            paper:getComputedStyle(document.querySelector('.vditor')).backgroundColor,
            text:getComputedStyle(document.querySelector('.vditor-reset p')).color,
            thBg:document.querySelector('.vditor-reset th')?getComputedStyle(document.querySelector('.vditor-reset th')).backgroundColor:null};
  })()`);
  const lightTable=await tableOf();
  log('t5-table-light',lightTable);
  if(after){
    assert.equal(lightTable.oddBg,'rgba(0, 0, 0, 0)','浅色：表格正文行应透明露纸');
    assert.equal(lightTable.evenBg,'rgb(241, 239, 233)','浅色：偶数行斑马纹 #F1EFE9');
    assert.equal(lightTable.tdBorder,'rgb(216, 215, 212)','浅色：单元格边框走 --table-border-color');
  }else{
    assert.equal(lightTable.evenBg,'rgb(255, 255, 255)','基线：2.0.7 浅色偶数行为内容主题白');
  }
  const emLetter=await fe(`getComputedStyle(document.querySelector('.vditor-reset em')).letterSpacing`);
  log('t6-em-letter-spacing',emLetter);
  if(after)assert.equal(emLetter,'0.35px','楷体斜体微字距 0.025em×14px=0.35px');
  else assert.equal(emLetter,'normal','基线：2.0.7 em 无字距');

  // ---- telari-dark 同样量一遍
  await fe(`vditor.vditor.toolbar.elements['theme-settings'].querySelector('button').click();true`);
  await wait(`!!document.getElementById('typora-themes')&&document.getElementById('typora-themes').open`,'theme dialog reopen');
  await fe(`document.querySelector('#typora-themes [data-theme="telari-dark"]').click();true`);
  await fe(`document.querySelector('#typora-themes footer button').click();true`);
  await wait(`document.documentElement.dataset.editorTheme==='telari-dark'`,'telari-dark applied');
  await pause(400);
  const dark=await strokeOf();
  log('t2-stroke-dark',dark);
  if(after){
    assert.equal(dark.p,'0.14px','拓然宋深色：正文细描边同样生效');
    assert.equal(dark.strong,'0.21px','深色 strong 排序不变');
    assert.equal(dark.h2,'0px');assert.equal(dark.code,'0px');assert.equal(dark.th,'0px');
  }
  const darkTable=await tableOf();
  log('t5-table-dark',darkTable);
  if(after){
    assert.equal(darkTable.paper,'rgb(46, 52, 64)','深色纸微提亮 #2E3440');
    assert.equal(darkTable.text,'rgb(195, 199, 207)','深色正文微提亮 #C3C7CF');
    assert.equal(darkTable.oddBg,'rgba(0, 0, 0, 0)','深色：表格正文行透明露纸（黑底纹根除）');
    assert.equal(darkTable.evenBg,'rgb(53, 60, 74)','深色：偶数行温和斑马纹 #353C4A');
    assert.equal(darkTable.tdBorder,'rgb(75, 80, 91)','深色：单元格边框 #4B505B（不再浅灰）');
  }else{
    assert.equal(darkTable.paper,'rgb(43, 48, 58)','基线：2.0.7 深色纸 #2B303A');
    assert.equal(darkTable.oddBg,'rgb(42, 45, 46)','基线：奇数行 vditor--dark 硬编码 #2A2D2E');
    assert.equal(darkTable.evenBg,'rgb(43, 43, 43)','基线：偶数行 vditor--dark 硬编码近黑 #2B2B2B（用户报告的黑底纹）');
    assert.equal(darkTable.tdBorder,'rgb(88, 88, 88)','基线：单元格边框硬编码 #585858');
  }
  await shot('t2-telari-dark');

  // ---- T1b Ctrl+滚轮：目录与正文同比缩放（比值不变）
  const ratioOf=()=>fe(`(()=>{
    const span=document.querySelector('.vditor-outline li > span > span');
    const p=document.querySelector('.vditor-reset p');
    return +(span.getBoundingClientRect().height/p.getBoundingClientRect().height).toFixed(4);
  })()`);
  const ratio100=await ratioOf();
  const badge=await fe(`(()=>{
    const el=document.querySelector('.vditor-reset');
    el.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-100,bubbles:true,cancelable:true}));
    return document.querySelector('.typora-zoom-badge')?.textContent;
  })()`);
  await pause(300);
  const ratio105=await ratioOf();
  const zoomContent=await fe(`getComputedStyle(document.querySelector('.vditor-content')).zoom`);
  log('t1b-zoom',{badge,ratio100,ratio105,zoom:zoomContent});
  assert.equal(badge,'105%','合成 Ctrl+滚轮应放大一档到 105%');
  assert.equal(zoomContent,'1.05','.vditor-content zoom 应为 1.05');
  assert.ok(Math.abs(ratio105/ratio100-1)<0.05,`缩放后目录/正文高度比应不变（${ratio100} → ${ratio105}）`);
  await shot('t5-zoom105');

  fs.writeFileSync(path.join(output,`bug208-${phase}-report.json`),JSON.stringify(report,null,2));
  console.log(`bug208 ${phase}: all checks passed`);
};
