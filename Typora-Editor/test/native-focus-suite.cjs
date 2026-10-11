const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({vscode,request,shortcut,send,document,file,until,pass,testRoot,dispatches,debugContexts})=>{
  const commands=await vscode.commands.getCommands(true),isTrae=commands.includes('workbench.action.chat.icube.open');
  fs.writeFileSync(path.join(testRoot,'focus-commands.json'),JSON.stringify(commands.filter(c=>/focus|icube.*sidebar|chat.*open/i.test(c)),null,2));
  const source='# 焦点验收\n\n前文与选区协作。\n\n| A | B |\n|---|---|\n| 一 | 重复项 |\n| 二 | 重复项 |\n\n公式 $x+1$ 与 `code`。\n\n结尾\n';
  const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(0,0,document.lineCount,0),source);assert.equal(await vscode.workspace.applyEdit(edit),true);await document.save();
  await until(async()=> (await request('nativeChat',{op:'read'})).value.includes('选区协作'));
  const inspect=async()=>{
    const workbench=(await send('Runtime.evaluate',{expression:`(()=>{const n=document.activeElement,r=n?.getBoundingClientRect(),editor=document.getElementById('workbench.parts.editor')?.getBoundingClientRect();return{hasFocus:document.hasFocus(),tag:n?.tagName,id:n?.id,cls:n?.className,role:n?.getAttribute('role'),label:n?.getAttribute('aria-label'),rect:r?.toJSON(),inDocument:!!(document.hasFocus()&&r&&editor&&r.x+r.width/2>=editor.left&&r.x+r.width/2<=editor.right&&r.y+r.height/2>=editor.top&&r.y+r.height/2<=editor.bottom)}})()`,returnByValue:true})).result.value;
    const frames=[];
    for(const context of debugContexts.values()){if(!context.auxData?.isDefault)continue;try{const r=await send('Runtime.evaluate',{contextId:context.id,expression:`(()=>{const n=document.activeElement,url=new URL(location.href);return{url:url.origin+url.pathname,hasFocus:document.hasFocus(),tag:n?.tagName,cls:n?.className,editable:!!(n?.isContentEditable||n?.matches('textarea,input')||n?.editContext),value:n?.editContext?.text??n?.value??n?.textContent?.slice(0,20000)}})()`,returnByValue:true},context.sessionId);if(r.result?.value)frames.push({id:context.id,sessionId:context.sessionId,...r.result.value});}catch{}}
    return{workbench,frames,editor:await request('nativeChat',{op:'read'})};
  };
  await request('nativeChat',{op:'mode',mode:'ir'});const selection=await request('nativeChat',{op:'select',needle:'选区协作'});
  const rectangle=(await send('Runtime.evaluate',{expression:`(()=>{const e=document.getElementById('workbench.parts.editor').getBoundingClientRect();return [...document.querySelectorAll('iframe')].map(n=>n.getBoundingClientRect().toJSON()).find(r=>r.width>100&&r.x+r.width/2>=e.left&&r.x+r.width/2<=e.right&&r.y+r.height/2>=e.top&&r.y+r.height/2<=e.bottom)})()`,returnByValue:true})).result.value;
  for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:rectangle.x+selection.point.x,y:rectangle.y+selection.point.y,button:'left',clickCount:1});
  await request('nativeChat',{op:'select',needle:'选区协作'});const before=dispatches.length;await shortcut('U',1);await until(()=>dispatches.length>before&&dispatches.at(-1).finished);
  if(process.env.MD_EDITOR_FOCUS_COMMAND)await vscode.commands.executeCommand(process.env.MD_EDITOR_FOCUS_COMMAND,...JSON.parse(process.env.MD_EDITOR_FOCUS_ARGS||'[]'));
  const targets=(await send('Target.getTargets')).targetInfos;
  fs.writeFileSync(path.join(testRoot,'focus-targets.json'),JSON.stringify(targets.map(t=>({...t,url:t.url.split('?')[0]})),null,2));
  for(const target of targets.filter(t=>t.type==='page'&&!t.url.includes('/workbench/workbench.html'))){try{await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});}catch{}}
  let state;const deadline=Date.now()+5000;
  do{state=await inspect();if(!state.workbench.inDocument&&state.frames.some(f=>f.hasFocus&&f.editable&&!/vditor/.test(f.cls)))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  fs.writeFileSync(path.join(testRoot,'focus-after-alt-u.json'),JSON.stringify(state,null,2));
  if(process.env.MD_EDITOR_FOCUS_DIAGNOSTIC){
    fs.writeFileSync(path.join(testRoot,'focus-commands-late.json'),JSON.stringify(await vscode.commands.getCommands(true),null,2));
    fs.writeFileSync(path.join(process.env.MD_EDITOR_FOCUS_DIAGNOSTIC,'ready.json'),JSON.stringify({testRoot,debugPort:process.env.MD_EDITOR_SMOKE_DEBUG_PORT}));
    while(!fs.existsSync(path.join(process.env.MD_EDITOR_FOCUS_DIAGNOSTIC,'done'))){
      const control=path.join(process.env.MD_EDITOR_FOCUS_DIAGNOSTIC,'command.json');
      if(fs.existsSync(control)){const command=JSON.parse(fs.readFileSync(control,'utf8'));fs.unlinkSync(control);try{await vscode.commands.executeCommand(command.id,...(command.args||[]));}catch(error){fs.writeFileSync(path.join(process.env.MD_EDITOR_FOCUS_DIAGNOSTIC,'command-error.txt'),String(error));}}
      state=await inspect();fs.writeFileSync(path.join(testRoot,'focus-live.json'),JSON.stringify(state,null,2));await new Promise(r=>setTimeout(r,200));
    }
  }
  assert.equal(state.workbench.inDocument,false,'Alt+U must move focus out of the document');
  assert.ok(state.frames.some(f=>f.hasFocus&&f.editable&&!/vditor/.test(f.cls)),'AI input must have actual editing focus');
  const marker='焦点输入验收🙂',focused=state.frames.find(f=>f.hasFocus&&f.editable&&!/vditor/.test(f.cls));await send('Input.insertText',{text:marker},focused.sessionId);
  const typed=await inspect();fs.writeFileSync(path.join(testRoot,'focus-typed.json'),JSON.stringify(typed,null,2));
  assert.equal(document.getText(),source,'Typing after Alt+U must not modify the Markdown document');
  assert.ok(typed.frames.some(f=>f.hasFocus&&f.editable&&f.value?.includes(marker)),'Typing reaches the AI input');
  assert.deepEqual(typed.editor.errors,[]);pass((isTrae?'Trae':'VSCode')+' Alt+U focuses AI input and subsequent typing leaves the document unchanged');
};
