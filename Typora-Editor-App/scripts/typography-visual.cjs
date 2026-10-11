const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const checks=[],pass=label=>checks.push('PASS '+label),delay=ms=>new Promise(r=>setTimeout(r,ms));
  const dump=(name,data)=>fs.writeFileSync(path.join(output,'typography-'+name+'.json'),JSON.stringify(data,null,2));
  // 300+ 字中英混排：必须足够长以在 1180px 视口内自然折行；含斜体、公式、禁则标点、引用、表格、代码。
  const source='# 排版验收 Typography\n\n'
    +'排版引擎需要在固定的行宽之内决定每一行的断点位置。Knuth-Plass 算法会评估所有可能的断行方案并选择让词间距变化最小的那一种，这正是 TeX 排版系统数十年来输出的书籍如此整齐的原因。中文与 English 混排的时候，两类文字之间应当保留细小的呼吸空隙，2026 年的数字与标点也参与断行决策。句末标点不允许出现在行首，（开括号也不允许出现在行尾）这是排版禁则的基本要求。两端对齐让每一行都抵达左右边界，视觉上整齐而稳定，适合长文阅读。\n\n'
    +'第二段继续混排验证：*用于楷书对照的中文斜体文本* 与 *English italic probe* 以及 *中英mixed混排italic* 三种斜体并存，公式 $E=m\\c^2$ 保持 KaTeX 渲染，代码 `print(42)` 保持等宽字体，还有一段更长的英文文本 the quick brown fox jumps over the lazy dog while typography engines measure every glyph and decide where lines should break to keep the page balanced.\n\n'
    +'> 引用块中的中文与 English 同样参与断行与间距规则。\n\n'
    +'- 列表项一：中文内容 with English words\n- 列表项二：数字 42 与公式 $a+b$ 的混排\n\n'
    +'| 表头一 | Header B |\n| --- | --- |\n| 单元格 | cell |\n\n'
    +'```python\n# 代码块不参与断行\nvalue = 42\n```\n';
  await ev(`__open(${JSON.stringify(source)})`);
  await until('vditor?.vditor?.__typoraPatched');
  await until('__typoraMathStats.pending===0');
  await delay(300);
  // v2.0.5 起新用户默认 telari-light；本套件的 Segoe 斜体对照断言需要经典浅色主题，先钉住。
  await ev("import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'light'))");
  await delay(200);

  /* ---- 目标 2：两端对齐 + 中英文间距 ---- */
  const typo=await ev(`(()=>{const ir=vditor.vditor.ir.element;const p=[...ir.querySelectorAll('p')].find(n=>n.textContent.includes('Knuth-Plass'));const th=ir.querySelector('th,td');const code=ir.querySelector('.hljs')||ir.querySelector('pre code');const preview=ir.querySelector('.vditor-ir__preview');return{pAlign:p?getComputedStyle(p).textAlign:null,liAlign:(()=>{const li=ir.querySelector('li');return li?getComputedStyle(li).textAlign:null})(),root:getComputedStyle(ir).textAutospace,supportsAutospace:CSS.supports('text-autospace','normal'),supportsSynthesis:CSS.supports('font-synthesis-style','none'),thAlign:th?getComputedStyle(th).textAlign:null,code:code?getComputedStyle(code).textAutospace:null,preview:preview?getComputedStyle(preview).textAutospace:null,h:(()=>{const h=ir.querySelector('h1');return h?getComputedStyle(h).textAlign:null})()}})()`);
  dump('justify',typo);
  // v2.0.6 起撤销两端对齐：justify 会把含行内公式的行的词间距拉伸出大空档。
  assert.equal(typo.pAlign,'start','v2.0.6 正文段落应左对齐（撤销 justify）');
  assert.equal(typo.liAlign,'start','v2.0.6 列表项应左对齐（撤销 justify）');
  assert.ok(typo.supportsAutospace,'Chromium 需支持 text-autospace');
  assert.equal(typo.root,'normal','.vditor-reset 应启用中英文间距(normal=开启)');
  assert.notEqual(typo.thAlign,'justify','表格单元不应两端对齐');
  assert.notEqual(typo.h,'justify','标题不应两端对齐');
  if(typo.code!==null)assert.equal(typo.code,'no-autospace','代码不应插入自动间距');
  if(typo.preview!==null)assert.equal(typo.preview,'no-autospace','公式预览不应插入自动间距');
  pass('v2.0.6 正文/列表左对齐（公式行不再被 justify 拉出空档）；中英文自动间距开启；表格、标题、代码、公式层不受影响');

  /* ---- 目标 2：Knuth-Plass DOM 应用器（导出排版核心） ---- */
  const kp=await ev(`(async()=>{const m=await import('/render/js/knuth-plass.mjs');
    const host=document.createElement('div');
    host.style.cssText='position:fixed;left:12px;top:12px;width:336px;font:16px/1.6 "Microsoft YaHei",sans-serif;padding:0;margin:0;z-index:1;background:#fff;color:#111';
    const p=document.createElement('p');
    p.textContent='排版引擎需要在固定的行宽内决定每一行的断点位置，Knuth-Plass 算法会评估所有可能的断行方案，选择让词间距变化最小的那一种。中文与English混排时，还应在两类文字之间保留呼吸空隙，2026年的数字也参与断行。句末标点不允许出现在行首、（括号也不允许出现在行尾），这是排版禁则的基本要求。';
    host.append(p);document.body.append(host);
    const text=p.textContent;
    const result=m.typesetBlock(p);
    const hostRect=host.getBoundingClientRect();
    const lines=[[]];let overflow=false;
    for(const node of [...p.childNodes]){
      if(node.nodeType===Node.ELEMENT_NODE&&node.tagName==='BR'&&node.dataset.kp){lines.push([]);continue;}
      if(node.nodeType===Node.ELEMENT_NODE&&node.classList.contains('kp-gap'))continue;
      if(node.nodeType===Node.TEXT_NODE){if(!node.textContent.trim())continue;const r=document.createRange();r.selectNodeContents(node);const rect=r.getBoundingClientRect();lines[lines.length-1].push({text:node.textContent,rect});continue;}
      const rect=node.getBoundingClientRect();
      if(node.classList.contains('kp-token'))lines[lines.length-1].push({text:node.textContent,rect,margin:node.style.marginLeft||'(none)'});
      else lines[lines.length-1].push({text:node.textContent,rect});
    }
    const closing=new Set(['，','。','、','；','：','？','！','）','】','》','」','』','”','’','…','.',',',';',':',')',']','}']);
    const opening=new Set(['（','【','《','「','『','“','‘','(','[','{']);
    const metrics=lines.map(tokens=>tokens.filter(t=>t.rect.width>0).map(t=>({left:t.rect.left,right:t.rect.right,text:t.text,margin:t.margin||null})));
    const flush=metrics.slice(0,-1).map(line=>Math.max(...line.map(t=>t.right))-hostRect.right);
    const detail=metrics.map((line,i)=>({line:i,flush:i<metrics.length-1?flush[i]:null,tokens:line.map(t=>({t:t.text,left:+t.left.toFixed(1),right:+t.right.toFixed(1),w:+(t.right-t.left).toFixed(1),m:t.margin||null}))}));
    const kinsokuStart=metrics.slice(1).filter(line=>line.length).map(line=>line[0].text[0]).filter(ch=>closing.has(ch));
    const kinsokuEnd=metrics.slice(0,-1).filter(line=>line.length).map(line=>line[line.length-1].text[line[line.length-1].text.length-1]).filter(ch=>opening.has(ch));
    const screenshot={ok:true};
    const stats={applied:result.applied,lines:metrics.length,flush,kinsokuStart,kinsokuEnd,textLost:p.textContent!==text,hostRight:hostRect.right,detail,diag:result.diag||null,target:result.target||null,boundaryDump:result.boundaryDump||null};
    // 回退路径：不可拆分超宽元素必须整体回退且不留痕迹
    const fb=document.createElement('p');
    const wide=document.createElement('img');wide.src='data:image/gif;base64,R0lGODlhAQABAAAAACw=';wide.style.width='500px';wide.style.height='8px';
    fb.append('超宽内容',wide,'尾部');
    host.append(fb);
    const fallback=m.typesetBlock(fb);
    stats.fallback={applied:fallback.applied,reason:fallback.fallback||null,residue:fb.querySelectorAll('.kp-token,br[data-kp]').length};
    m.restoreBlock(p);m.restoreBlock(fb);
    stats.restored={tokens:p.querySelectorAll('.kp-token').length,brs:p.querySelectorAll('br[data-kp]').length};
    host.remove();
    return stats;})()`);
  dump('knuth-plass',kp);
  assert.equal(kp.applied,true,'混排段落应完成 Knuth-Plass 排版');
  assert.ok(kp.lines>=2,'336px 行宽下该段落应折为多行，实际 '+kp.lines);
  assert.ok(kp.flush.length===kp.lines-1,'每一段行都应有 flush 数据');
  for(const gap of kp.flush){assert.ok(gap<=1.5&&gap>=-4,'非末行应两端齐平(±4px 内)，偏差 '+gap);}
  assert.equal(kp.kinsokuStart.length,0,'行首不得出现句末标点：'+JSON.stringify(kp.kinsokuStart));
  assert.equal(kp.kinsokuEnd.length,0,'行尾不得出现开括号：'+JSON.stringify(kp.kinsokuEnd));
  assert.equal(kp.textLost,false,'排版不得丢失任何文本');
  assert.equal(kp.fallback.applied,false,'超宽不可拆分内容应回退');
  assert.equal(kp.fallback.residue,0,'回退后不得残留包装痕迹');
  assert.equal(kp.restored.tokens+kp.restored.brs,0,'restoreBlock 应清空全部排版痕迹');
  pass('Knuth-Plass 应用器：两端齐平、禁则成立、文本无损、超宽回退、可完整还原');

  /* ---- 目标 3：中文斜体楷书化（v2.0.3 保持原始字号）、西文真斜体 ---- */
  const em=await ev(`(()=>{const ir=vditor.vditor.ir.element;
    const emCJK=[...ir.querySelectorAll('em')].find(e=>/^[\u4e00-\u9fff\u3000-\u303f，。、]+$/.test(e.textContent));
    const emEN=[...ir.querySelectorAll('em')].find(e=>/^[A-Za-z0-9 .]+$/.test(e.textContent));
    const fsPx=getComputedStyle(emCJK).fontSize;
    // v2.0.8:em 规则带 0.025em 微字距（楷体与相邻文字的呼吸间距），克隆基线
    // 必须同款字距，否则设计间距会被误判为"拉伸"。断言语义仍是字体保真。
    const mk=(css,text)=>{const s=document.createElement('span');s.style.cssText='position:fixed;left:-9999px;top:0;white-space:nowrap;visibility:hidden;'+css+';font-size:'+fsPx+';letter-spacing:.025em';s.textContent=text;document.body.append(s);const w=s.getBoundingClientRect().width;s.remove();return w;};
    const textCJK=emCJK.textContent;
    const kai=mk('font-family:markpilot-kai;font-style:italic',textCJK);
    const rawKai=mk("font-family:'KaiTi','楷体';font-style:normal",textCJK);
    const yahei=mk("font-family:'Microsoft YaHei';font-style:italic",textCJK);
    const textEN=emEN.textContent;
    const segoe=mk("font-family:'Segoe UI';font-style:italic",textEN);
    const yaheiEN=mk("font-family:'Microsoft YaHei';font-style:italic",textEN);
    return{fontFamily:getComputedStyle(emCJK).fontFamily,fontStyle:getComputedStyle(emCJK).fontStyle,synthesis:getComputedStyle(emCJK).fontSynthesisStyle||'',fsPx,
      emCJK:emCJK.getBoundingClientRect().width,kai,rawKai,yahei,diffKai:Math.abs(emCJK.getBoundingClientRect().width-kai),diffRawKai:Math.abs(emCJK.getBoundingClientRect().width-rawKai),diffYahei:Math.abs(emCJK.getBoundingClientRect().width-yahei),
      emEN:emEN.getBoundingClientRect().width,segoe,yaheiEN,diffEN:Math.abs(emEN.getBoundingClientRect().width-segoe),diffENyahei:Math.abs(emEN.getBoundingClientRect().width-yaheiEN),
      kaiLoaded:document.fonts.check('italic '+fsPx+' markpilot-kai','永')};})()`);
  dump('em-kai',em);
  assert.ok(em.fontFamily.startsWith('markpilot-kai'),'em 字体栈应以楷书字面开头：'+em.fontFamily);
  assert.equal(em.fontStyle,'italic');
  assert.ok(em.kaiLoaded,'markpilot-kai 本地字面（KaiTi）应可用');
  assert.ok(em.diffKai<2.5,'中文斜体宽度应等于楷书字面宽度（差 '+em.diffKai+'px）');
  assert.ok(em.diffRawKai<3.5,'中文斜体应保持原始字号（与裸 KaiTi 等宽，差 '+em.diffRawKai+'px）');
  // v2.0.6：纯 CJK 字形在中文字体里都是 1em 步进，宽度法无法区分楷体/雅黑
  // （旧 diffYahei>2 断言靠 justify 拉伸的假差异才通过，撤 justify 后归零）。
  // 字体身份由上面的字面栈 + fonts.check + 零拉伸三重保证。
  assert.ok(em.diffKai<0.5,'em 宽度须与楷书克隆零拉伸（justify 已撤销，差 '+em.diffKai+'px）');
  assert.ok(em.diffEN<2.5,'英文斜体应保持 Segoe UI 真斜体（差 '+em.diffEN+'px）');
  assert.ok(em.diffENyahei>1,'英文斜体不应落入中文字体（差 '+em.diffENyahei+'px）');
  pass('中文斜体→楷书原始字号直立（不再缩小），英文保持主题真斜体');

  /* ---- v2.0.3：全局表面不透明度（默认66%）、工具栏独立、图片设置对话框修复 ---- */
  // harness 未启用补全时 completion.css 不会由 completion.js 注入，
  // 这里显式挂载同一路径的样式表再测量（真实桌面行为由 desktop-completion 套件守护）。
  await ev(`(async()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/render/css/completion.css';const done=new Promise(r=>{link.onload=r;link.onerror=r;});document.head.append(link);await done;return true})()`);
  await delay(80);
  // 确定性起点：强制默认 66/100（localStorage 可能残留上一轮的保存值）。
  await ev(`import('/render/js/surface.js').then(m=>m.applySurfacePreferences({popups:66,toolbar:100}));true`);
  await delay(50);
  const alphaOf=bg=>{const m=/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,\/]+([\d.]+))?\s*\)/.exec(bg)||/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(bg);return m?(m[4]===undefined?1:parseFloat(m[4])):-1;};
  const boxOf=async cls=>await ev(`(()=>{const d=document.createElement('div');d.className=${JSON.stringify(cls)};document.body.append(d);const s=getComputedStyle(d);const out={bg:s.backgroundColor,blur:s.backdropFilter||s.webkitBackdropFilter||'',will:s.willChange};d.remove();return out})()`);
  const defaults={};
  for(const [name,cls] of [['补全候选框','md-completion'],['补全预览框','md-completion-preview'],['补全设置面板','md-completion-settings'],['右键菜单','typora-editor-context-menu'],['图片设置对话框','typora-media-dialog']])defaults[name]=await boxOf(cls);
  const toolbarDefault=await ev(`(()=>{const bar=document.querySelector('.vditor-toolbar');return bar?getComputedStyle(bar).backgroundColor:null})()`);
  dump('surface-default',{...defaults,toolbarDefault});
  for(const [name,box] of Object.entries(defaults)){
    const alpha=alphaOf(box.bg);
    assert.ok(alpha>=0.64&&alpha<=0.68,name+' 默认应为 66% 不透明，实际 '+box.bg);
    assert.ok(!/blur/.test(box.blur),name+' 不得使用 backdrop-filter（编辑残迹 bug 根源）');
    assert.ok(/transform/.test(box.will),name+' 应提升为独立合成层（will-change:transform）');
  }
  assert.equal(alphaOf(toolbarDefault),1,'工具栏默认应保持完全不透明（独立设置，未改时不变）');
  pass('补全框/预览框/设置面板/右键菜单/图片设置对话框：默认 66% 表面、无模糊、独立合成层；工具栏默认不透明');

  // 设置入口与联动：⋮ 菜单配置项、对话框真实打开、实时预览、独立生效、取消恢复
  const surface=await ev(`(async()=>{
    const m=await import('/render/js/surface.js');
    const more=(vditor.vditor.options.toolbar||[]).find(item=>item&&item.name==='more');
    const entry=(more&&more.toolbar||[]).find(item=>item&&item.name==='surface-settings');
    const alpha=bg=>{const match=/rgba?\\(\\s*[\\d.]+[\\s,]+[\\d.]+[\\s,]+[\\d.]+[\\s,\\/]+([\\d.]+)\\s*\\)/.exec(bg)||/color\\(srgb\\s+[\\d.]+\\s+[\\d.]+\\s+[\\d.]+(?:\\s*\\/\\s*([\\d.]+))?\\)/.exec(bg);return match?parseFloat(match[1]??match[2]??'1'):-1;};
    const probe=()=>{
      const box=document.createElement('div');box.className='md-completion';document.body.append(box);
      const menu=document.createElement('div');menu.className='typora-editor-context-menu';document.body.append(menu);
      const img=document.createElement('div');img.className='typora-media-dialog';document.body.append(img);
      const bar=document.querySelector('.vditor-toolbar');
      const out={popup:alpha(getComputedStyle(box).backgroundColor),menu:alpha(getComputedStyle(menu).backgroundColor),imageDialog:alpha(getComputedStyle(img).backgroundColor),toolbar:bar?alpha(getComputedStyle(bar).backgroundColor):-2};
      box.remove();menu.remove();img.remove();return out;};
    const idle=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const before=probe();
    m.showSurfaceSettings();
    const dialog=document.getElementById('typora-surface-settings');
    const dialogOpen=!!dialog&&dialog.open;
    const inputs=dialog?{popups:dialog.querySelector('[name=popups]')?.value,toolbar:dialog.querySelector('[name=toolbar]')?.value}:null;
    const set=(name,value)=>{const input=dialog.querySelector('[name='+name+']');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));};
    await idle();const popup85=probe();
    set('popups',85);await idle();const popup85b=probe();
    set('toolbar',40);await idle();const toolbar40=probe();
    dialog.querySelector('[value=cancel]').click();
    await idle();const restored=probe();
    return {entryInMoreMenu:!!entry,dialogOpen,inputs,before,popup85,popup85b,toolbar40,restored,prefs:m.surfacePreferences()};
  })()`);
  dump('surface-settings',surface);
  assert.equal(surface.entryInMoreMenu,true,'工具栏 ⋮ 菜单应包含"界面透明度"入口');
  assert.equal(surface.dialogOpen,true,'设置对话框应真实打开（<dialog>.open）');
  assert.deepEqual(surface.inputs,{popups:'66',toolbar:'100'},'输入框默认值应为 66% / 100%');
  for(const key of ['popup','menu','imageDialog']){
    assert.ok(surface.popup85b[key]>0.83&&surface.popup85b[key]<0.87,'弹窗不透明度 85% 应实时生效于 '+key+'，实际 '+surface.popup85b[key]);
  }
  assert.ok(surface.popup85b.toolbar===1,'弹窗设置不得影响工具栏');
  assert.ok(surface.toolbar40.toolbar>0.37&&surface.toolbar40.toolbar<0.43,'工具栏不透明度 40% 应独立生效，实际 '+surface.toolbar40.toolbar);
  assert.ok(Math.abs(surface.toolbar40.popup-0.85)<0.03,'工具栏设置不得影响弹窗表面');
  for(const key of ['popup','menu','imageDialog'])assert.ok(Math.abs(surface.restored[key]-0.66)<0.03,'取消后 '+key+' 应恢复默认 66%');
  assert.equal(surface.restored.toolbar,1,'取消后工具栏应恢复完全不透明');
  assert.deepEqual(surface.prefs,{popups:66,toolbar:100},'取消不应保留未保存的预览值');
  pass('界面透明度设置：⋮入口、默认66/100、实时预览、弹窗与工具栏互不影响、取消完整恢复');

  // 右键菜单：真实 contextmenu 事件 → 真实菜单 DOM
  const menuOpened=await ev(`(()=>{const ir=vditor.vditor.ir.element;const p=[...ir.querySelectorAll('p')].find(n=>n.textContent.includes('Knuth-Plass'));p.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:280,clientY:260}));return true})()`);
  await delay(120);
  const menu=await ev(`(()=>{const m=document.getElementById('typora-editor-context-menu');if(!m)return null;const s=getComputedStyle(m);return{bg:s.backgroundColor,blur:s.backdropFilter||s.webkitBackdropFilter||'',opacity:s.opacity,buttonBg:(()=>{const b=m.querySelector('button');return b?getComputedStyle(b).backgroundColor:null})(),buttons:m.querySelectorAll('button').length}})()`);
  dump('context-menu',menu);
  assert.ok(menuOpened);
  assert.ok(menu,'右键菜单应真实弹出');
  const menuAlpha=alphaOf(menu.bg);
  assert.ok(menuAlpha>=0.64&&menuAlpha<=0.68,'右键菜单背景应为 66% 不透明（跟随全局设置），实际 '+menu.bg);
  assert.ok(!/blur/.test(menu.blur),'右键菜单不得使用背景模糊（残迹 bug）');
  assert.equal(menu.opacity,'1','菜单整体 opacity 保持 1（文字不透明）');
  assert.equal(alphaOf(menu.buttonBg),0,'菜单按钮背景应为透明（避免双层叠加）');
  await ev(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:8,clientY:8}));true`);
  await delay(100);
  assert.equal(await ev(`document.getElementById('typora-editor-context-menu')?1:0`),0,'点击外部应关闭菜单');
  pass('右键菜单：真实事件弹出，66% 表面跟随全局设置，按钮透明，点击外部关闭');

  // KaTeX 预渲染框必须保持完全不透明（用户红线）
  const katexBox=await ev(`(()=>{const irRoot=vditor.vditor.ir.element;const host=irRoot.closest('.vditor-ir')||irRoot.parentElement;const node=document.createElement('span');node.className='vditor-ir__node vditor-ir__node--expand';node.dataset.type='inline-node';const pv=document.createElement('span');pv.className='vditor-ir__preview';node.append(pv);host.append(node);const s=getComputedStyle(pv);const out={bg:s.backgroundColor,blur:s.backdropFilter||''};node.remove();return out})()`);
  dump('katex-preview',katexBox);
  assert.equal(alphaOf(katexBox.bg),1,'KaTeX 预渲染框必须保持完全不透明，实际 '+katexBox.bg);
  assert.ok(!/blur/.test(katexBox.blur),'KaTeX 预渲染框不得有背景模糊');
  pass('KaTeX 数学预渲染框保持完全不透明（不受透明化影响）');

  /* ---- 编辑能力不受排版影响 ---- */
  const before=await ev(`vditor.getValue()`);
  await ev(`(()=>{const ir=vditor.vditor.ir.element;ir.focus();const p=[...ir.querySelectorAll('p')].find(n=>n.textContent.includes('Knuth-Plass'));const range=document.createRange();range.setStart(p.firstChild,0);range.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(range);return true})()`);
  await win.webContents.insertText('排版验收插入🙂');
  await delay(400);
  const after=await ev(`vditor.getValue()`);
  assert.notEqual(after,before,'排版层不影响输入');
  assert.ok(after.includes('排版验收插入🙂'),'真实输入应进入文档');
  pass('排版对齐与自动间距为纯视觉层：真实输入/序列化不受影响');

  /* ---- 截图证据（人工复核用） ---- */
  fs.writeFileSync(path.join(output,'typography-light.png'),(await win.webContents.capturePage()).toPNG());
  await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,'konayuki-dark'));true`);
  await delay(350);await until('__typoraMathStats.pending===0');
  fs.writeFileSync(path.join(output,'typography-dark.png'),(await win.webContents.capturePage()).toPNG());
  await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,'konayuki-light'));true`);
  await delay(200);
  pass('浅色/深色主题截图已存档（typography-light/dark.png）');

  fs.writeFileSync(path.join(output,'typography-visual.json'),JSON.stringify({checks},null,2));
  /* ---- 目标 4：拓然宋（Telari）主题 —— 宋体+Georgia 衬线阅读（v2.0.5） ---- */
  {
    const themes=await ev("import('/render/js/themes.js').then(m=>Object.keys(m.THEMES).length)");
    assert.equal(themes,6,'主题数应为 6（含 telari-light/dark）');
    await ev("import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-light'))");
    await delay(300);
    const t=await ev(`(()=>{
      const ir=vditor.vditor.ir.element;
      const p=[...ir.querySelectorAll('p')].find(n=>n.textContent.includes('Knuth-Plass'));
      const emCJK=[...ir.querySelectorAll('em')].find(e=>/[一-鿿]/.test(e.textContent));
      const emEN=[...ir.querySelectorAll('em')].find(e=>/^[A-Za-z0-9 .]+$/.test(e.textContent));
      const cs=getComputedStyle(p);
      const fsPx=cs.fontSize;
      // v2.0.8:em 规则带 0.025em 微字距（楷体与相邻文字的呼吸间距），克隆基线
    // 必须同款字距，否则设计间距会被误判为"拉伸"。断言语义仍是字体保真。
    const mk=(css,text)=>{const s=document.createElement('span');s.style.cssText='position:fixed;left:-9999px;top:0;white-space:nowrap;visibility:hidden;'+css+';font-size:'+fsPx+';letter-spacing:.025em';s.textContent=text;document.body.append(s);const w=s.getBoundingClientRect().width;s.remove();return w;};
      const cjk=emCJK.textContent;
      const emFace=getComputedStyle(emCJK).fontFamily;
      // 克隆法：两端对齐会在 CJK 行内分配字间距，直接量元素宽会把排版拉伸
      // 误算成字体差异；用相同字面克隆离屏测量字体保真度。
      const kaiClone=mk('font-family:'+emFace+';font-style:italic',cjk);
      const kai=mk('font-family:KaiTi',cjk);
      const stackCjk=mk('font-family:'+cs.fontFamily,cjk);
      const song=mk('font-family:SimSun',cjk);
      const latin=emEN.textContent;
      const enFace=getComputedStyle(emEN).fontFamily;
      const geoClone=mk('font-family:'+enFace+';font-style:italic',latin);
      const geo=mk('font-family:Georgia;font-style:italic',latin);
      const reset=getComputedStyle(vditor.vditor.ir.element);
      const rr=vditor.vditor.ir.element.getBoundingClientRect();
      const h2=ir.querySelector('h2')||ir.querySelector('h1');
      const bq=ir.querySelector('blockquote');
      return{fontFamily:cs.fontFamily,lineHeight:cs.lineHeight,fontSizePx:parseFloat(cs.fontSize),maxWidth:reset.maxWidth,paddingInline:reset.paddingInline,
        resetRight:Math.round(rr.right),winW:window.innerWidth,
        measure:Math.round(p.getBoundingClientRect().width),
        h2Weight:h2?getComputedStyle(h2).fontWeight:null,
        quoteBg:bq?getComputedStyle(bq).backgroundColor:null,
        paper:getComputedStyle(document.querySelector('.vditor')).backgroundColor,
        emCJK:emCJK.getBoundingClientRect().width,kai,diffKai:Math.abs(kaiClone-kai),
        stackCjk,song,diffSong:Math.abs(stackCjk-song),
        emEN:emEN.getBoundingClientRect().width,geo,diffGeo:Math.abs(geoClone-geo),
        emLatinFace:getComputedStyle(emEN).fontFamily.slice(0,40)};})()`);
    dump('telari',t);
    assert.ok(t.fontFamily.startsWith('Georgia'),'拓然宋正文栈应以 Georgia 开头：'+t.fontFamily);
    assert.ok(t.fontFamily.includes('SimSun'),'拓然宋正文栈应含宋体：'+t.fontFamily);
    assert.ok(Math.abs(parseFloat(t.lineHeight)/t.fontSizePx-1.8)<0.05,'行高应为 1.8：'+t.lineHeight+'/'+t.fontSizePx);
    // v2.0.6:限宽改由 padding 承担（pre.vditor-reset 同时是滚动容器，max-width
    // 会把滚动条带到画面中部）。滚动器必须全宽贴右缘。
    assert.equal(t.maxWidth,'none','v2.0.6 滚动器不得再限宽（滚动条须贴最右缘）');
    assert.ok(t.resetRight>=t.winW-18,'滚动器右缘应贴视口右缘（差 '+(t.winW-t.resetRight)+'px）');
    assert.ok(t.measure<=1281,'版心（1280px 版心 + padding 上限）不应超宽：'+t.measure);
    assert.ok(t.h2Weight==='700','v2.0.6 拓然宋标题应为 700 半加粗：'+t.h2Weight);
    assert.equal(t.quoteBg,'rgb(241, 239, 233)','v2.0.6 浅色引用底纹 #F1EFE9');
    assert.equal(t.paper,'rgb(250, 249, 246)','浅色纸应为 Telari #FAF9F6');
    fs.writeFileSync(path.join(output,'typography-telari-light.png'),(await win.webContents.capturePage()).toPNG());
    assert.ok(t.diffSong<2.5,'正文栈中文宽度应等于宋体原宽（差 '+t.diffSong+'px）');
    assert.ok(t.diffKai<2.5,'em 中文宽度应等于楷体原宽（差 '+t.diffKai+'px）');
    assert.ok(t.diffGeo<2.5,'西文斜体宽度应等于 Georgia 斜体（差 '+t.diffGeo+'px）');
    assert.ok(t.emLatinFace.startsWith('markpilot-kai'),'em 栈应以楷体字面开头：'+t.emLatinFace);
    await ev("import('/render/js/themes.js').then(m=>m.applyTheme(window.vditor,'telari-dark'))");
    await delay(300);
    const dark=await ev(`(()=>({paper:getComputedStyle(document.querySelector('.vditor')).backgroundColor,
      quoteBg:(()=>{const q=vditor.vditor.ir.element.querySelector('blockquote');return q?getComputedStyle(q).backgroundColor:null})()}))()`);
    assert.equal(dark.paper,'rgb(46, 52, 64)','v2.0.8 深色纸微提亮 #2E3440');
    assert.equal(dark.quoteBg,'rgb(53, 60, 74)','v2.0.8 深色引用底纹 #353C4A（随纸面平移）');
    fs.writeFileSync(path.join(output,'typography-telari-dark.png'),(await win.webContents.capturePage()).toPNG());
    pass('拓然宋主题：宋体+Georgia 正文、楷体斜体、Telari 纸色、1280px 版心+全宽滚动器、700 标题、双纸引用底纹');
  }

  return checks;
};
