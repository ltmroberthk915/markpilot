const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output,application})=>{
  require('electron').app.on('browser-window-created',(_event,window)=>window.webContents.on('console-message',event=>{if(event.level==='error')console.error('Export renderer:',event.message);}));
  const checks=[],root=path.join(output,'media-office-1.0.15','workspace');fs.mkdirSync(root,{recursive:true});
  const pass=text=>{checks.push('PASS '+text);fs.writeFileSync(path.join(output,'media-office-1.0.15','desktop-results.json'),JSON.stringify(checks,null,2));};
  const {nativeImage}=require('electron'),bitmap=Buffer.alloc(640*320*4);
  for(let y=0;y<320;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;bitmap[i]=x%256;bitmap[i+1]=y%256;bitmap[i+2]=160;bitmap[i+3]=255;}
  const png=nativeImage.createFromBitmap(bitmap,{width:640,height:320}).toPNG(),data='data:image/png;base64,'+png.toString('base64');
  const file=path.join(root,'media.md');fs.writeFileSync(file,'# Media\n\nBefore $x^2$.\n\n| 名称 | 公式 | 代码 | 引用 |\n| --- | --- | --- | --- |\n| 普通 | $x+1$ | `const a=1` | [链接][ref] |\n| 第二 | $y+1$ | `=1+1` | [ref][ref] |\n\n[ref]: https://example.org\n\n![示意图]('+data+')\n\nAfter $y^2$.\n');
  // Always evaluate through the shell's current iframe. During open/reload
  // the old and new frames coexist briefly; searching mainFrame.frames can
  // accidentally edit a stale document and then wait forever on the new one.
  const fe=code=>win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w||!w.vditor)throw new Error('editor frame not ready');return w.eval(${JSON.stringify(code)});})()`,true);
  const waitForEditor=async()=>{
    const version=global.doc.docVersion;
    await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;try{return !!w&&w.location.search.includes('v=${version}')&&!!w.vditor?.__media&&!!w.vditor?.__completion;}catch{return false;}})()`);
    const marker=global.doc.current.text.split('\n').find(line=>line.trim())?.trim().slice(0,32)||'';
    for(let i=0;i<200;i++){try{if(!marker||String(await fe('vditor.getValue()')).includes(marker))return;}catch{}await new Promise(r=>setTimeout(r,30));}
    throw new Error('editor did not receive the current open content: '+JSON.stringify({version,file:global.doc.file,marker}));
  };
  const imageCount=text=>(text.match(/<img\b/gi)||[]).length;
  const markdownImageCount=text=>(text.match(/!\[[^\]]*\]\(/g)||[]).length;
  const waitFrame=async expression=>{for(let i=0;i<100;i++){if(await fe(expression))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timed out in current document frame: '+expression);};
  const applyScaleViaDialog=async percent=>{
    const dispatched=await fe(`(()=>{const img=[...document.querySelectorAll('.vditor-content img')].find(item=>item.closest('.vditor-'+vditor.vditor.currentMode));if(!img)throw new Error('没有可缩放的图片');const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,view:window});const returned=img.dispatchEvent(event),menu=document.getElementById('typora-editor-context-menu');return{returned,defaultPrevented:event.defaultPrevented,matches:!!img.closest('.vditor-content img'),ancestors:[...function*(){let n=img;while(n){yield n; n=n.parentElement;}}()].slice(0,8).map(n=>n.className||n.tagName),menu:!!menu,imageSettings:!!menu?.querySelector('[data-action="image-settings"]')}})()`);
    if(!dispatched.menu||!dispatched.imageSettings)throw new Error('右键菜单未提供图片设置：'+JSON.stringify(dispatched));
    await fe(`(()=>{const button=document.querySelector('#typora-editor-context-menu [data-action="image-settings"]');button.click();return true})()`);
    await waitFrame(`!!document.getElementById('typora-image-settings')`);
    await fe(`(()=>{const dialog=document.getElementById('typora-image-settings'),button=[...dialog.querySelectorAll('.media-presets button')].find(item=>item.textContent===${JSON.stringify(String(percent)+'%')});if(!button)throw new Error('缩放预设不存在');button.click();dialog.querySelector('form button[type="submit"]').click();return true})()`);
    await waitFrame(`!document.getElementById('typora-image-settings')`);
  };
  await global.doc.openFile(file);await waitForEditor();
  for(let i=0;i<200;i++){if(await fe(`!!document.querySelector('.vditor-ir img')?.naturalWidth`))break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(await fe(`document.querySelector('.vditor-ir img')?.naturalWidth`),640);assert.ok(!global.doc.current.text.includes('base64,'));pass('Embedded PNG decodes at original resolution while editable and completion text contains no Base64');
  fs.writeFileSync(path.join(output,'media-office-1.0.15','image-dom.txt'),await fe(`document.querySelector('.vditor-ir img').parentElement.outerHTML`));
  global.doc.setSetting('autoSave',false);
  await fe(`window.__mediaUnchanged=[...document.querySelectorAll('.vditor-ir .katex')];true`);
  await applyScaleViaDialog(50);
  for(let i=0;i<100&&!global.doc.current.text.includes('width="320"');i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(imageCount(global.doc.current.text),1,'scaling replaces the Markdown image instead of appending a second image');
  assert.equal(markdownImageCount(global.doc.current.text),0,'scaling promotes the Markdown image to one canonical HTML image');
  assert.ok(global.doc.current.text.includes('width="320"')&&global.doc.current.text.includes('data-typora-scale="50"'));
  assert.equal(await global.doc.save(),true);
  const scaledDisk=fs.readFileSync(file,'utf8');assert.equal(imageCount(scaledDisk),1);assert.equal(markdownImageCount(scaledDisk),0);assert.equal((scaledDisk.match(/data:image\//gi)||[]).length,1);assert.ok(scaledDisk.includes(data));
  assert.equal(await fe(`window.__mediaUnchanged.every(node=>node.isConnected)`),true);pass('Image scaling writes a 50% display width and preserves original pixels plus unrelated formula nodes');
  const typeInTableCell=async(col,label)=>{
    const token=`T${col}`;
    const mode=await fe('vditor.vditor.currentMode');
    const point=await fe(`(()=>{const root=vditor.vditor[${JSON.stringify(mode)}].element,cell=root.querySelector('table')?.rows[1]?.cells[${col}];if(!cell)throw new Error('table cell missing');const rect=cell.getBoundingClientRect(),frame=window.frameElement?.getBoundingClientRect()||{left:0,top:0};return{x:Math.round(frame.left+rect.left+Math.min(rect.width-4,Math.max(4,rect.width*.65))),y:Math.round(frame.top+rect.top+Math.min(rect.height-4,Math.max(4,rect.height*.55)))}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y});
    await new Promise(r=>setTimeout(r,80));
    for(const key of token){
      win.webContents.sendInputEvent({type:'keyDown',keyCode:key});
      win.webContents.sendInputEvent({type:'char',keyCode:key});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:key});
      await new Promise(r=>setTimeout(r,30));
    }
    let state;
    for(let i=0;i<200;i++){
      state=await fe(`(()=>{const table=vditor.vditor[${JSON.stringify(mode)}].element.querySelector('table');return{table:!!table,rows:table?.rows.length||0,value:vditor.getValue()}})()`);
      if(state.value.includes(token))break;
      await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(state?.table&&state.rows===3&&state.value.includes(token),`${label} keeps the table after real typing: ${JSON.stringify({mode,table:state?.table,rows:state?.rows,value:state?.value?.slice(0,800)})}`);
    pass(`${label} keeps the table and source after real typing`);
  };
  await typeInTableCell(0,'IR ordinary cell');
  await typeInTableCell(1,'IR formula cell');
  await typeInTableCell(2,'IR inline-code cell');
  await typeInTableCell(3,'IR reference cell');
  await fe(`(()=>{vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="wysiwyg"]').click();return true})()`);
  await waitFrame(`vditor.vditor.currentMode==='wysiwyg'&&!!vditor.vditor.wysiwyg.element.querySelector('table')`);
  await typeInTableCell(0,'WYSIWYG ordinary cell');
  await typeInTableCell(1,'WYSIWYG formula cell');
  await typeInTableCell(2,'WYSIWYG inline-code cell');
  await typeInTableCell(3,'WYSIWYG reference cell');
  await fe(`(()=>{vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="ir"]').click();return true})()`);
  await waitFrame(`vditor.vditor.currentMode==='ir'&&!!vditor.vditor.ir.element.querySelector('table')`);
  await global.doc.save();
  const reopened=path.join(root,'media-reopened.md');fs.copyFileSync(file,reopened);await global.doc.openFile(reopened);await waitForEditor();
  await waitFrame(`vditor.vditor.currentMode==='ir'&&!!vditor.vditor.ir.element.querySelector('table')`);
  await typeInTableCell(0,'IR reopened independent copy');
  await global.doc.save();
  fs.writeFileSync(path.join(output,'media-office-1.0.15','scaled-dom.txt'),await fe(`document.querySelector('.vditor-ir').innerHTML`));
  const archive=fs.readFileSync(reopened,'utf8'),moved=path.join(root,'moved-single-file.md');fs.writeFileSync(moved,archive);await global.doc.openFile(moved);await waitForEditor();
  for(let i=0;i<100;i++){if(await fe(`!!document.querySelector('.vditor-ir img')?.naturalWidth`))break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(await fe(`document.querySelector('.vditor-ir img')?.naturalWidth`),640);assert.equal(imageCount(global.doc.current.text),1);assert.equal(markdownImageCount(global.doc.current.text),0);assert.ok(global.doc.current.text.includes('data-typora-scale="50"'));pass('Moving only the saved .md reopens its original embedded image and display size');
  await applyScaleViaDialog(150);
  for(let i=0;i<100&&!global.doc.current.text.includes('data-typora-scale="150"');i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(imageCount(global.doc.current.text),1,'rescaling an HTML image updates it in place');assert.equal(markdownImageCount(global.doc.current.text),0);assert.ok(global.doc.current.text.includes('width="960"')&&!global.doc.current.text.includes('data-typora-scale="50"'));
  await fe(`vditor.vditor.undo.undo(vditor.vditor);true`);
  for(let i=0;i<100&&!global.doc.current.text.includes('data-typora-scale="50"');i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(imageCount(global.doc.current.text),1,'scale undo restores one previous HTML image');assert.equal(markdownImageCount(global.doc.current.text),0);assert.ok(global.doc.current.text.includes('width="320"'));
  await fe(`vditor.vditor.undo.redo(vditor.vditor);true`);
  for(let i=0;i<100&&!global.doc.current.text.includes('data-typora-scale="150"');i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(imageCount(global.doc.current.text),1,'scale redo restores one updated HTML image');assert.equal(markdownImageCount(global.doc.current.text),0);assert.ok(global.doc.current.text.includes('width="960"'));
  assert.equal(await global.doc.save(),true);const movedDisk=fs.readFileSync(moved,'utf8');assert.equal(imageCount(movedDisk),1);assert.equal((movedDisk.match(/data:image\//gi)||[]).length,1);assert.ok(movedDisk.includes('width="960"')&&movedDisk.includes('data-typora-scale="150"'));pass('Right-click scaling an existing HTML image is idempotent and undo/redo never duplicates image source');
  await fe(`(()=>{const button=vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="wysiwyg"]');if(!button)throw new Error('WYSIWYG mode button is missing');button.click();return true})()`);
  await waitFrame(`vditor.vditor.currentMode==='wysiwyg'&&!!document.querySelector('.vditor-wysiwyg img')?.naturalWidth`);
  assert.equal(imageCount(await fe('vditor.getValue()')),1);assert.equal(markdownImageCount(await fe('vditor.getValue()')),0);
  await applyScaleViaDialog(75);
  for(let i=0;i<100&&!global.doc.current.text.includes('data-typora-scale="75"');i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(imageCount(global.doc.current.text),1);assert.equal(markdownImageCount(global.doc.current.text),0);assert.ok(global.doc.current.text.includes('width="480"')&&global.doc.current.text.includes('data-typora-scale="75"'));
  assert.equal(await global.doc.save(),true);const wysiwygDisk=fs.readFileSync(moved,'utf8');assert.equal(imageCount(wysiwygDisk),1);assert.equal((wysiwygDisk.match(/data:image\//gi)||[]).length,1);assert.ok(wysiwygDisk.includes('width="480"')&&wysiwygDisk.includes('data-typora-scale="75"'));pass('WYSIWYG right-click scaling also updates the source image in place without duplicating it');
  await fe(`(()=>{vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="ir"]').click();return true})()`);await waitFrame(`vditor.vditor.currentMode==='ir'&&!!document.querySelector('.vditor-ir img')?.naturalWidth`);
  const source='# 数学与图片导出测试\n\n中文 **加粗**、*斜体*、<u>下划线</u>，公式 $x^2+1$。\n\n## 动态规划\n\n终值 $V(T,x)=\\Phi(x)$，积分与梯度如下。\n\n$$\n\\partial_t V+\\sup_u\\left\\{f+\\nabla_x V^\\top g+\\frac12\\operatorname{tr}(\\sigma\\sigma^\\top\\nabla_x^2V)\\right\\}=0\n$$\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\begin{pmatrix}x\\\\y\\end{pmatrix}=\\begin{pmatrix}ax+by\\\\cx+dy\\end{pmatrix}\n$$\n\n$$\n\\int_0^T e^{-rt}f(x_t,u_t)\\,dt+e^{-rT}\\Phi(x_T)\n$$\n\n| 编号 | 值 | 公式 |\n| --- | --- | --- |\n| 00123 | =1+1 | $\\frac{a}{b}$ |\n| 中文 | 3.14159 | $\\sum_{i=1}^n p_i$ |\n\n> 引用：模型的变量应与原文一致。\n\n1. 第一步\n2. 第二步\n   - 子项目\n\n```python\ndef value(x):\n    return x ** 2\n```\n\n'+`<img src="${data}" alt="原始像素图" width="320" data-typora-align="center" />`+'\n\n[参考链接](https://example.org)\n';
  const wordSource=path.join(root,'word-source.md');fs.writeFileSync(wordSource,source);await global.doc.openFile(wordSource);await waitForEditor();
  const {dialog}=require('electron'),oldDialog=dialog.showSaveDialog,target=path.join(root,'office-quality.docx');dialog.showSaveDialog=async()=>({canceled:false,filePath:target});
  try{
    const started=performance.now(),result=await ev(`hostApi.invoke('export',{format:'docx'})`);fs.writeFileSync(path.join(output,'media-office-1.0.15','word-result.json'),JSON.stringify({...result,elapsedMs:performance.now()-started},null,2));
    assert.equal(result.phase,'done',JSON.stringify(result));assert.equal(result.warnings.length,0,result.warnings.join(';'));assert.ok(fs.readFileSync(target).subarray(0,2).equals(Buffer.from('PK')));pass('Native DOCX export completes with editable math, original image, table, list and formatting without warnings');
    assert.equal(fs.readFileSync(wordSource,'utf8'),source);pass('Word export does not modify or save over its Markdown source');
    // v2.0.7：对齐图片导出——docx 段落 jc=center；HTML 保留属性与对齐 CSS。
    {
      const {execFileSync}=require('node:child_process');
      // Windows 自带 bsdtar 可读 zip；Git Bash 的 GNU tar 不行，必须指名 System32。
      const tarExe=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
      const docDir=path.join(root,'docx-extract');fs.rmSync(docDir,{recursive:true,force:true});fs.mkdirSync(docDir,{recursive:true});
      execFileSync(tarExe,['-xf',target,'-C',docDir,'word/document.xml'],{stdio:'ignore'});
      const xml=fs.readFileSync(path.join(docDir,'word/document.xml'),'utf8');
      assert.ok(xml.includes('<w:jc w:val="center"/>'),'v2.0.7 居中图片应导出为 docx 居中段落 w:jc');
      pass('v2.0.7 对齐图片导出为 docx 居中段落（w:jc=center）');
    }
    const htmlTarget=path.join(root,'office-quality.html');dialog.showSaveDialog=async()=>({canceled:false,filePath:htmlTarget});
    try{
      const htmlResult=await ev(`hostApi.invoke('export',{format:'html'})`);
      assert.equal(htmlResult.phase,'done',JSON.stringify(htmlResult));
      const html=fs.readFileSync(htmlTarget,'utf8');
      assert.ok(html.includes('data-typora-align="center"'),'v2.0.7 HTML 导出应保留 data-typora-align');
      assert.ok(html.includes('img[data-typora-align="center"]'),'v2.0.7 HTML 导出应内联对齐 CSS');
      pass('v2.0.7 对齐图片导出 HTML：属性保留 + 对齐 CSS 内联');
    }finally{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});}
  }finally{dialog.showSaveDialog=oldDialog;}
  if(process.env.TYPORA_OFFICE_NATIVE==='1'){
    const restoreClipboard=await require('./test-clipboard.cjs').preserveClipboard();
    const officeRoot=path.join(output,'media-office-1.0.15','office-native');
    // Each Office app is verified by its own PowerShell run with its own
    // timeout; if a COM call hangs, the harness kills exactly the PIDs the
    // script registered, so one app can neither mask nor orphan the others.
    const native=async(mode,app='all',timeout=45000)=>{
      const command=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
      const stamp=app==='all'?mode:`${mode}-${app}`,pidsFile=path.join(officeRoot,`${stamp}-pids.json`);
      try{fs.rmSync(pidsFile);}catch{}
      const args=['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'office-native-verify.ps1'),'-Mode',mode,'-App',app];
      const killPids=()=>{let pids=[];try{const parsed=JSON.parse(fs.readFileSync(pidsFile,'utf8'));pids=Array.isArray(parsed)?parsed:[parsed];}catch{}for(const pid of pids){try{require('node:child_process').execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{/* already exited */}}};
      try{
        const result=await require('node:util').promisify(require('node:child_process').execFile)(command,args,{windowsHide:true,timeout,encoding:'utf8',maxBuffer:10*1024*1024});
        fs.writeFileSync(path.join(output,'media-office-1.0.15',`native-${stamp}.log`),(result.stdout||'')+(result.stderr||''));
      }catch(error){
        const detail=`${error.stdout||''}\n${error.stderr||''}\n[code=${error.code} killed=${error.killed||''} signal=${error.signal||''}]`;
        fs.writeFileSync(path.join(output,'media-office-1.0.15',`native-${stamp}.log`),detail);
        killPids();
        throw new Error(`native ${stamp} verification failed:\n${detail}`);
      }
      return JSON.parse(fs.readFileSync(path.join(officeRoot,`${stamp}-result.json`),'utf8').replace(/^\uFEFF/,''));
    };
    const {createHash}=require('node:crypto'),{pathToFileURL}=require('node:url');
    const {unzipSync}=await import(pathToFileURL(path.join(__dirname,'..','app','renderer','js','vendor','fflate.mjs')).href);
    const sourceSha=createHash('sha256').update(png).digest('hex');
    const mediaEntries=(file,prefix)=>Object.entries(unzipSync(new Uint8Array(fs.readFileSync(file)))).filter(([name])=>name.startsWith(prefix)).map(([name,data])=>({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
    // Bit-identical media bytes inside the saved Office package prove the
    // paste kept original pixels and alpha channel instead of re-encoding.
    const assertPastedBytes=(app,file,prefix)=>{
      const media=mediaEntries(file,prefix);
      assert.ok(media.some(entry=>entry.sha256===sourceSha),`pasted ${app} media bytes differ from source PNG: ${JSON.stringify(media)}`);
    };
    const imageOffices=[['word','image-word.docx','word/media/'],['excel','image-excel.xlsx','xl/media/'],['powerpoint','image-powerpoint.pptx','ppt/media/']];
    const pasteEverywhere=async label=>{
      for(const [app] of imageOffices){const result=await native('image',app);assert.equal(result[app+'Images'],1,`native ${app} paste: ${JSON.stringify(result)}`);}
      for(const [app,file,prefix] of imageOffices)assertPastedBytes(app,path.join(officeRoot,file),prefix);
      pass(label);
    };
    try{
      await fe(`import(${JSON.stringify(new URL('/render/js/media-tools.js',win.webContents.getURL()).href)}).then(module=>module.mediaRequest('copy-table',vditor.__media.tablePayload(document.querySelector('.vditor-ir table'))))`);
      const table=await native('table');assert.equal(table.leadingZeros,'00123');assert.equal(table.formulaText,'=1+1');assert.equal(table.hasFormula,false);assert.equal(table.chinese,'中文');pass('Actual Excel paste preserves table cells, leading zeros, Chinese and literal formula-like text');
      await fe(`import(${JSON.stringify(new URL('/render/js/media-tools.js',win.webContents.getURL()).href)}).then(module=>module.mediaRequest('copy-image',{src:document.querySelector('.vditor-ir img').getAttribute('src')}))`);
      await pasteEverywhere('Original-size image pastes into actual Word, Excel and PowerPoint with bit-identical PNG bytes');
      const {windowsClipboard}=require('../../Typora-Editor/extension-src/render/js/media-host.cjs');
      const payload=await fe(`vditor.__media.tablePayload(document.querySelector('.vditor-ir table'))`);await windowsClipboard({action:'copy-table',...payload});await native('table');
      await windowsClipboard({action:'copy-image',mime:'image/png',data:png.toString('base64')});
      await pasteEverywhere('VSIX native clipboard bridge also pastes tables and bit-identical images into installed Office applications');
    }finally{await restoreClipboard();}
  }
  return checks;
};
