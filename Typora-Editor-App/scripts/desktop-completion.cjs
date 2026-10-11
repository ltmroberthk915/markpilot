const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output,application})=>{
  const checks=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const pass=text=>{checks.push('PASS '+text);fs.writeFileSync(path.join(output,'desktop-completion.json'),JSON.stringify(checks,null,2));};
  const root=path.join(output,'completion-workspace');fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,'completion.md'),other=path.join(root,'关联 笔记.md');
  fs.writeFileSync(file,'# Completion\n\n$x^2$\n');fs.writeFileSync(other,'# Other\n');
  fs.writeFileSync(path.join(root,'示意 图.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=','base64'));
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
  const frame=()=>win.webContents.mainFrame.frames.find(f=>f.url.includes('/doc/'));
  const fe=code=>frame().executeJavaScript(code,true);
  await until(`!!document.getElementById('editor')?.contentWindow?.vditor?.__completion`);
  const manager=global.doc.completions;await manager.ready;
  manager.platform.window.showInformationMessage=async()=>{};
  // CDP 的 sendCommand 没有超时：渲染进程忙（长文档 + 批量负载）时它会永远挂着，
  // 整个套件就这么卡死（实测：completion 在批量跑里挂过两次、单独跑必过）。这里统一
  // 加一个有界超时，让卡住变成一条明确的失败而不是无限等待。
  const sendCommand = (dbg, method, params) => Promise.race([
    dbg.sendCommand(method, params || {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CDP 超时：' + method)), 25000)),
  ]);
  win.webContents.debugger.attach('1.3');
  const send = (method, params = {}) => sendCommand(win.webContents.debugger, method, params);
  const defaults=require(path.join(application,'app/shared/out/completion/core.cjs')).settings;
  // 2.1.23 起不再内置预置模型（用户要求不要预设过多、且要能自己删）：脚本自带两份用户配置。
  const GLM={id:'custom-glm',label:'GLM',protocol:'anthropic',baseUrl:'https://open.bigmodel.cn/api/anthropic',model:'glm-5.3-flash'};
  const DS={id:'custom-ds',label:'DeepSeek',protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'};
  const MODEL_PROFILES=[GLM,DS];
  // 2.1.23：默认配置不再内置任何地址（DEFAULTS.baseUrl 为空），而"填密钥"要求先有地址。
  // 所以这里先落一份用户自己的配置，后面所有断言都建立在这份配置上。
  await manager.update({...defaults(),profiles:MODEL_PROFILES,...GLM,activeProfile:GLM.id});
  const probe=require('../../Typora-Editor/test/completion-suite.cjs').probe.toString();
  const request=(action,params={})=>fe(`(${probe})(${JSON.stringify({action,...params})})`);
  const waitFor=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await pause(60);}fs.writeFileSync(path.join(output,'desktop-completion-debug.json'),JSON.stringify(await read(),null,2));throw new Error('Timed out: '+label);};
  const key=async(keyCode,modifiers=[])=>{
    await send('Page.bringToFront');
    const [key,code,virtual]={Space:[' ','Space',32],ESC:['Escape','Escape',27],Tab:['Tab','Tab',9],Enter:['Enter','Enter',13],Z:['z','KeyZ',90],Y:['y','KeyY',89]}[keyCode];
    const params={key,code,windowsVirtualKeyCode:virtual,modifiers:modifiers.includes('control')?2:modifiers.includes('alt')?1:0};
    await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});await send('Input.dispatchKeyEvent',{type:'keyUp',...params,modifiers:0});await pause(100);
  };
  const prepare=async(text,needle,offset)=>{await send('Page.bringToFront');const result=await request('completion-prepare',{text,needle,offset});await waitFor(()=>global.doc.current.text===result.markdown,'source sync');await request('completion-focus');return result;};
  const read=()=>request('completion-read');
  const menu=()=>waitFor(async()=>(await read()).menu,'local candidates');
  const ghost=()=>waitFor(async()=>{const s=await read();return s.preview&&s.ghost&&!s.ghost.includes('正在');},'AI suggestion');
  const initial=await read();assert.ok(initial.toolbar);assert.equal(initial.instances,1);assert.equal(initial.apiRow,false);
  assert.equal(initial.compactToolbar,true);pass('Desktop shows compact labelled theme and completion icons without bold or italic toolbar buttons');
  assert.equal(manager.config.ai,false);assert.equal(manager.config.automaticAI,false);pass('Fresh desktop enables local completion without paid requests or extra toolbar rows');
  await request('completion-api-field',{field:'key'});await until(`document.querySelector('.completion-dialog').open`);
  assert.equal(await ev(`document.querySelector('.completion-dialog input').type`),'password');
  await ev(`document.querySelector('.completion-dialog input').value='desktop-test-glm';document.querySelector('.completion-dialog form').requestSubmit();true`);
  // Dismiss the informational native message without making the test modal.
  await waitFor(async()=>!!(await manager.getAPIKey()),'encrypted key');
  // The production information dialog is replaced by the test driver below.
  assert.equal(await manager.getAPIKey(),'desktop-test-glm');
  const vaultFile=path.join(require('electron').app.getPath('userData'),'completion-secrets.json');
  const persisted=fs.readFileSync(vaultFile,'utf8');assert.ok(!persisted.includes('desktop-test-glm'));
  const {CompletionVault}=require(path.join(application,'app/main/completion-vault.js'));
  const {credentialId}=require(path.join(application,'app/shared/out/completion/profiles.cjs'));
  assert.equal(await new CompletionVault().get(credentialId(GLM)),'desktop-test-glm');
  assert.ok(!JSON.stringify(global.state.data).includes('desktop-test-glm'));pass('Password dialog saves with native encryption, survives reopening, and never puts keys in ordinary settings');
  await manager.saveAPIKey('desktop-test-ds',DS);
  for(const p of MODEL_PROFILES){await request('completion-profile',{profileId:p.id});await waitFor(()=>manager.config.model===p.model,'profile');assert.equal(await manager.getAPIKey(),p.id===DS.id?'desktop-test-ds':'desktop-test-glm');}
  const ui=await request('completion-settings');assert.equal(ui.settings.profiles.length,2);assert.equal(ui.toolbarHeight,initial.toolbarHeight);
  await pause(200);
  fs.writeFileSync(path.join(output,'desktop-completion-menu.png'),(await win.webContents.capturePage()).toPNG());
  await key('ESC');assert.equal((await read()).settings.open,false);pass('User-configured models switch in one click and preserve separate provider credentials');
  await request('completion-api-field',{field:'baseUrl'});await until(`document.querySelector('.completion-dialog').open`);
  await ev(`document.querySelector('.completion-dialog input').value='file:///bad';document.querySelector('.completion-dialog form').requestSubmit();true`);
  await until(`!!document.querySelector('.completion-dialog-error').textContent`);await key('ESC');await until(`!document.querySelector('.completion-dialog').open`);
  assert.equal(manager.config.baseUrl,DS.baseUrl);pass('Invalid addresses stay in the dialog; Escape cancels without changing configuration');
  const picking=manager.pickProfile();await until(`document.querySelector('.completion-dialog').open`);
  await ev(`[...document.querySelectorAll('.completion-dialog-items button')].find(b=>/DeepSeek/.test(b.textContent)).click();true`);await picking;
  assert.equal(manager.config.model,DS.model);pass('Desktop application menu supports the same model selector');
  await manager.update({...manager.config,ai:false,automaticAI:false,host:false});
  for(const mode of ['ir','wysiwyg','sv']){
    await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();true`);await pause(250);
    await prepare('# Completion\n\nKeep $a+1$.\n\n$\\fr$\n','\\fr');
    if(mode!=='sv'){await request('completion-formula-hit',{needle:'\\fr'});await request('completion-place',{needle:'\\fr'});}
    await key('Space',['control']);await menu();await key('Tab');
    let s=await read();assert.ok(s.markdown.includes('\\frac{}{}'));assert.ok(s.outside);await waitFor(()=>global.doc.current.text===s.markdown,'accept sync');
    await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),s.markdown);
    if(mode==='ir'){await key('Z',['control']);await pause(250);const undone=await read();if(undone.markdown!==s.original)fs.writeFileSync(path.join(output,'desktop-completion-debug.json'),JSON.stringify({before:s,after:undone},null,2));assert.equal(undone.markdown,s.original);}
    pass(mode+': formula completion, Tab insertion and actual file save');
    await prepare('# Table formula completion\n\n| Input | Pipe | Matrix |\n| --- | --- | --- |\n| $\\fr$ | $P(A\\vert{}B)$ | $\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$ |\n','\\fr');
    if(mode!=='sv'){await request('completion-formula-hit',{needle:'\\fr'});await request('completion-place',{needle:'\\fr'});}
    await key('Space',['control']);await menu();await key('Tab');await pause(250);
    const tableAccepted=await read();assert.ok(tableAccepted.markdown.includes('$\\frac{}{}$')&&tableAccepted.markdown.includes('$P(A\\vert{}B)$')&&tableAccepted.markdown.includes('$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$'));
    if(mode!=='sv')assert.deepEqual(await fe(`Array.from(vditor.vditor[vditor.vditor.currentMode].element.querySelector('table').rows,r=>r.cells.length)`),[3,3]);
    await key('Z',['control']);await pause(250);assert.equal((await read()).markdown,tableAccepted.original);await key('Y',['control']);await pause(250);assert.equal((await read()).markdown,tableAccepted.markdown);
    await waitFor(()=>global.doc.current.text===tableAccepted.markdown,'table formula accept sync');await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),tableAccepted.markdown);
    pass(mode+': native formula completion inside table preserves pipe/matrix neighbors, undo/redo and disk');
    await prepare('# Completion\n\n/table\n','/table');await key('Space',['control']);await menu();await key('Enter');
    assert.ok((await read()).markdown.includes('| 列一'));pass(mode+': Markdown table snippet');
  }
  await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="ir"]').click();true`);await pause(250);
  // Scrolling is reading: the candidate popup must stay open while the wheel
  // moves (caret unchanged) and close only when the user clicks elsewhere.
  {
    await prepare('# Completion\n\nKeep $a+1$.\n\n\\fr\n','\\fr');
    await key('Space',['control']);await menu();
    {const t0=Date.now();const probe=await fe("1+1").catch(e=>"ERR:"+e.message);console.log("PROBE 渲染进程响应: "+probe+" 用时 "+(Date.now()-t0)+"ms");}
    for(const deltaY of [-240,600]){
      win.webContents.sendInputEvent({type:'mouseWheel',x:220,y:320,deltaX:0,deltaY,canScroll:true});
      await pause(400);
      assert.ok((await read()).menu,'wheel scroll must not close the completion popup');
    }
    const outside=await fe(`(()=>{const r=vditor.vditor.ir.element.getBoundingClientRect();return{x:Math.round(r.left+40),y:Math.round(r.top+40)}})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:outside.x,y:outside.y});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:outside.x,y:outside.y});
    await pause(350);
    assert.ok(!(await read()).menu,'a click elsewhere closes the popup');
    pass('Completion popup survives wheel scrolling and closes only on a click');
  }
  // The popup belongs to the editing canvas: when the wheel scrolls the caret
  // above the visible canvas the popup must follow it off-screen instead of
  // parking on the toolbar, and it must come back with the caret.
  {
    const longBody=Array.from({length:60},(_,i)=>'段落'+i+' 的内容文本，用来把文档撑到足够长以产生真实滚动。').join('\n\n');
    await prepare('# Completion\n\n\\fr\n\n'+longBody+'\n','\\fr');
    await key('Space',['control']);await menu();
    const geom=async()=>await fe(`(()=>{const d=document,p=d.querySelector('.md-completion:not([hidden])'),t=d.querySelector('.vditor-toolbar'),r=vditor.vditor[vditor.vditor.currentMode].element.getBoundingClientRect();if(!p)return null;const q=p.getBoundingClientRect();return{popup:{top:q.top,bottom:q.bottom,left:q.left,right:q.right,styleTop:p.style.top},toolbar:{top:t.getBoundingClientRect().top,bottom:t.getBoundingClientRect().bottom},canvas:{top:r.top,bottom:r.bottom}}})()`);
    // In IR the mode root itself is the scroller (pre.vditor-reset); other
    // modes may scroll an inner .vditor-reset. Drive whichever is scrollable
    // — element scrollTop fires the same native scroll events the production
    // reposition listener consumes.
    const setScroll=async v=>{const s=await fe(`(()=>{const e=vditor.vditor[vditor.vditor.currentMode].element;const sc=e.scrollHeight>e.clientHeight+2?e:e.querySelector('.vditor-reset');if(!sc)throw new Error('no scroller in '+vditor.vditor.currentMode);sc.scrollTop=${v};return{mode:vditor.vditor.currentMode,tag:sc.tagName,st:sc.scrollTop,sh:sc.scrollHeight,ch:sc.clientHeight}})()`);await pause(450);return s;};
    const scrolled=await setScroll(1200);
    assert.ok(scrolled&&scrolled.st===1200,'long document actually scrolls (got '+JSON.stringify(scrolled)+')');
    await pause(450);
    assert.ok((await read()).menu,'popup stays open while the caret is scrolled out of view');
    const scrolledOut=await geom();assert.ok(scrolledOut,'scrolled-out popup keeps geometry');
    // 「不要贴在工具栏上」= 候选框必须落在工具栏下沿之下。原来的不等式写成 popup.bottom < toolbar.bottom，
    // 与它自己的说明相反（那个条件成立的唯一情况恰恰是候选框整个压在工具栏上），实测把这条改成
    // 与说明一致的方向：popup.top 必须在工具栏下沿之下。
    assert.ok(scrolledOut.popup.top>=scrolledOut.toolbar.bottom-1,'popup must not sit on the toolbar when the caret is above the canvas (got '+JSON.stringify(scrolledOut)+')');
    await setScroll(0);
    await pause(450);
    assert.ok((await read()).menu,'popup stays open after scrolling back to the caret');
    const back=await geom();assert.ok(back,'returned popup keeps geometry');
    assert.ok(back.popup.top>=back.toolbar.bottom-1&&back.popup.top>=back.canvas.top-1&&back.popup.bottom<=back.canvas.bottom+1,'popup returns inside the canvas below the toolbar (got '+JSON.stringify(back)+')');
    pass('Completion popup never parks on the toolbar when the caret scrolls above the canvas and returns with the caret');
  }
  await prepare('# Paths\n\n@关联\n','@关联');await key('Space',['control']);await menu();assert.ok((await read()).labels.includes('关联 笔记.md'));await key('Tab');assert.ok((await read()).markdown.includes('%20'));
  await prepare('# Images\n\n!示意\n','!示意');await key('Space',['control']);await menu();await key('Tab');assert.ok((await read()).markdown.includes('![]('));pass('File and image completion uses the desktop document folder and encodes spaces');
  const requests=[];let replyText='2x',release=null,replyStatus=200;
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;let data;try{data=JSON.parse(body)}catch{if(!res.destroyed)res.destroy();return;}requests.push({body:data,key:req.headers['x-api-key']});
    const send=()=>{if(!res.destroyed){if(replyStatus===0){res.destroy();return;}res.statusCode=replyStatus;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:data.model,content:[{type:'text',text:replyText}]}));}};
    if(release===false)release=send;else send();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const config={...manager.config,baseUrl:'http://127.0.0.1:'+server.address().port+'/anthropic',model:DS.model,ai:true,automaticAI:false,host:false};
    await manager.saveAPIKey('desktop-mock-key',config);await manager.update(config);
    await prepare('# 微积分\n\n## 导数\n\n已知 $f(x)=x^2$，则 $f\'(x)=$。\n',"f'(x)=");
    await request('completion-formula-hit',{needle:"f'(x)="});await request('completion-place',{needle:"f'(x)="});
    await fe(`vditor.__completion.request(true,true);true`);await ghost();assert.equal((await read()).ghost,'2x');
    assert.equal(requests.length,1);assert.equal(requests[0].key,'desktop-mock-key');assert.equal(requests[0].body.model,DS.model);assert.ok(requests[0].body.messages[0].content.includes('⟦INSERT⟧'));
    assert.match(requests[0].body.messages[0].content,/<document_structure>\nPARENT # 微积分\nCURRENT ## 导数/);pass('Desktop adds exact document heading ancestry to the existing AI request');
    await key('Tab');await pause(200);const accepted=await read();assert.ok(accepted.markdown.includes("f'(x)=2x"));await key('Z',['control']);await pause(250);assert.equal((await read()).markdown,accepted.original);
    pass('Main-process AI gets both context sides, inserts only the gap, and supports one-step undo');
    await request('completion-place',{needle:"f'(x)="});await fe(`vditor.__completion.request(true,true);true`);await ghost();assert.equal(requests.length,1);pass('Repeated requests reuse the cached suggestion without another model call');
    for(const status of [401,429,503,0]){
      await request('completion-dismiss');replyStatus=status;
      const prepared=await prepare('# Offline '+status+'\n\n$failure'+status+'=$\n','failure'+status+'=');
      await request('completion-formula-hit',{needle:'failure'+status+'='});await request('completion-place',{needle:'failure'+status+'='});await fe(`vditor.__completion.request(true,true);true`);
      await waitFor(async()=>{const s=await read();return s.preview&&s.ghost.includes(status?'HTTP '+status:'无法连接');},'bounded failure feedback');
      assert.equal((await read()).markdown,prepared.markdown);
      await prepare('# Offline local\n\n$\\fr$\n','\\fr');await request('completion-formula-hit',{needle:'\\fr'});await request('completion-place',{needle:'\\fr'});
      await key('Space',['control']);await menu();await key('Tab');const edited=await read();assert.ok(edited.markdown.includes('\\frac{}{}'));
      await waitFor(()=>global.doc.current.text===edited.markdown,'offline local source sync');await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),edited.markdown);
      pass('AI '+(status||'network failure')+': local formula completion, editing and save remain functional');
    }
    replyStatus=200;
    await request('completion-dismiss');replyText='3x';await manager.update({...config,automaticAI:true});
    await prepare('# 导数\n\n已知 $g(x)=3x$，$g\'(x)=$。\n',"g'(x)=");
    await request('completion-formula-hit',{needle:"g'(x)="});await request('completion-place',{needle:"g'(x)="});await ghost();pass('Entering an unfinished formula triggers an automatic suggestion without further typing');
    await request('completion-dismiss');await manager.update({...config,automaticAI:false});
    release=false;await prepare('# Slow\n\n$z=$\n','z=');await request('completion-formula-hit',{needle:'z='});await request('completion-place',{needle:'z='});await fe(`vditor.__completion.request(true,true);true`);
    await waitFor(()=>typeof release==='function','pending request');await global.doc.save();
    await fe(`vditor.vditor.toolbar.elements['reading-palette'].querySelector('button').click();document.querySelector('#typora-palette [data-palette="green"]').click();document.querySelector('#typora-palette footer button').click();true`);
    await waitFor(()=>global.doc.state.get('readingPalette')==='green','desktop palette persistence');
    const oldFrame=global.doc.current.frameId;await global.doc.openFile(other);
    await global.doc.handleRendererMsg({frameId:oldFrame},{type:'change',content:'late old document'});
    assert.equal(global.doc.current.text,'# Other\n');
    await until(`(()=>{try{const w=document.getElementById('editor').contentWindow;return w.location.pathname===${JSON.stringify('/doc/'+encodeURIComponent(other))}&&!!w.vditor?.__completion&&!!w.vditor?.vditor?.currentMode&&w.vditor.getValue()===${JSON.stringify('# Other\n')}}catch{return false}})()`);release();await pause(500);
    assert.equal(global.doc.current.text,'# Other\n');assert.equal((await read()).preview,false);assert.equal(manager.controllers.size,1);pass('Switching documents cancels stale replies and disposes the previous session');
    assert.equal(await fe('document.documentElement.dataset.readingPalette'),'green');pass('Desktop reading palette persists in application state and follows the next file');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await manager.update(defaults());}
  await global.doc.save();return checks;
};
