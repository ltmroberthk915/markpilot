const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
exports.run=async({vscode,request,shortcut,send,document,file,until,pass,testRoot,dispatches,debugContexts})=>{
  const isTrae=(await vscode.commands.getCommands(true)).includes('workbench.action.chat.icube.open'),q=x=>request('nativeChat',x),records=[],markers=[],runId=randomUUID();
  const waitAsync=async predicate=>{const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,40));}throw Error('Asynchronous focus state timed out');};
  const source='# 焦点验收\n\n前文与选区协作。**加粗中文🙂**\n\n| A | B |\n|---|---|\n| 一 | 重复项 |\n| 二 | 重复项 |\n\n公式 $x+1$ 与 `code`。\n\n重复段落\n\n重复段落\n\n> 引用选区\n\n```js\nfirstCode();\nsecondCode();\n```\n\n结尾\n';
  const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(0,0,document.lineCount,0),source);assert.equal(await vscode.workspace.applyEdit(edit),true);await document.save();
  await waitAsync(async()=> (await q({op:'read'})).value.includes('选区协作'));
  const disk=fs.readFileSync(file,'utf8');
  await send('Runtime.evaluate',{expression:`window.__focusOperationErrors=[];window.addEventListener('error',e=>__focusOperationErrors.push(String(e.error?.stack||e.message)));window.addEventListener('unhandledrejection',e=>__focusOperationErrors.push(String(e.reason?.stack||e.reason)));true`});
  const inspect=async()=>{
    const workbench=(await send('Runtime.evaluate',{expression:`(()=>{const n=document.activeElement,r=n?.getBoundingClientRect(),editor=document.getElementById('workbench.parts.editor')?.getBoundingClientRect();return{hasFocus:document.hasFocus(),tag:n?.tagName,cls:n?.className,inDocument:!!(document.hasFocus()&&r&&editor&&r.x+r.width/2>=editor.left&&r.x+r.width/2<=editor.right&&r.y+r.height/2>=editor.top&&r.y+r.height/2<=editor.bottom),figma:document.querySelectorAll('.figma-mention-symbol-wrap').length,errors:window.__focusOperationErrors}})()`,returnByValue:true})).result.value;
    const frames=[];
    for(const context of debugContexts.values()){
      if(!context.auxData?.isDefault)continue;
      try{const result=await send('Runtime.evaluate',{contextId:context.id,expression:`(()=>{const n=document.activeElement;return{hasFocus:document.hasFocus(),tag:n?.tagName,cls:n?.className,editable:!!(n?.isContentEditable||n?.matches('textarea,input')||n?.editContext),value:n?.editContext?.text??n?.value??n?.textContent?.slice(0,20000)}})()`,returnByValue:true},context.sessionId);
        if(result.result?.value)frames.push({id:context.id,sessionId:context.sessionId,...result.result.value});}catch{}
    }
    return{workbench,frames};
  };
  const variants=[
    {kind:'basic',needle:'选区协作'},
    {kind:'basic',needle:'一'},
    {kind:'edge',needle:'重复项',occurrence:1,reverse:true},
    {kind:'edge',needle:'加粗中文🙂',reverse:true},
    {kind:'edge',needle:'x+1'},
    {kind:'edge',needle:'firstCode',endNeedle:'secondCode'},
    {kind:'edge',needle:'重复段落',occurrence:1,endNeedle:'引用选区'},
    {kind:'edge',needle:'结尾',noCode:true,closed:true},
  ];
  for(const mode of ['ir','wysiwyg','sv'])for(const selection of variants){
    await q({op:'mode',mode});
    if(selection.closed)await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    const prepared=await q({op:'select',...selection});
    const rectangle=(await send('Runtime.evaluate',{expression:`(()=>{const e=document.getElementById('workbench.parts.editor').getBoundingClientRect();return [...document.querySelectorAll('iframe')].map(n=>n.getBoundingClientRect().toJSON()).find(r=>r.width>100&&r.x+r.width/2>=e.left&&r.x+r.width/2<=e.right&&r.y+r.height/2>=e.top&&r.y+r.height/2<=e.bottom)})()`,returnByValue:true})).result.value;
    assert.ok(rectangle,'The custom document is visible');await send('Page.bringToFront');
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:rectangle.x+prepared.point.x,y:rectangle.y+prepared.point.y,button:'left',clickCount:1});
    await q({op:'select',...selection});const before=dispatches.length;await shortcut('U',1,!selection.noCode);await until(()=>dispatches.length>before&&dispatches.at(-1).finished);
    let state;const deadline=Date.now()+5000;
    do{state=await inspect();if(!state.workbench.inDocument&&state.frames.some(f=>f.hasFocus&&f.editable&&!/vditor/.test(f.cls)))break;await new Promise(r=>setTimeout(r,70));}while(Date.now()<deadline);
    fs.writeFileSync(path.join(testRoot,'focus-after-alt-u.json'),JSON.stringify({mode,selection,state},null,2));
    assert.equal(dispatches.length,before+1,'Only one file range is attached');assert.equal(state.workbench.inDocument,false,'Alt+U must move focus out of the document');
    const focused=state.frames.find(f=>f.hasFocus&&f.editable&&!/vditor/.test(f.cls));assert.ok(focused,'AI input must have actual editing focus');
    assert.equal(state.workbench.figma,0,'Empty native focus batch must not create an attachment');
    for(const marker of markers)assert.ok(focused.value.includes(marker),'Existing AI draft is preserved: '+marker);
    const marker='焦点-'+runId+'-'+String(records.length+1).padStart(2,'0')+'🙂';
    assert.equal(focused.value.includes(marker),false,'A stale draft must not satisfy the typing assertion');
    await send('Input.insertText',{text:marker},focused.sessionId);markers.push(marker);
    let typed;await waitAsync(async()=>{typed=await inspect();return typed.frames.some(f=>f.hasFocus&&f.editable&&f.value?.includes(marker));});
    const input=typed.frames.find(f=>f.hasFocus&&f.editable&&!/vditor/.test(f.cls));for(const previous of markers)assert.ok(input.value.includes(previous));
    assert.equal(document.getText(),source,'Typing after Alt+U must not modify Markdown');assert.equal(document.isDirty,false);assert.equal(fs.readFileSync(file,'utf8'),disk);
    assert.deepEqual(typed.workbench.errors,[]);assert.deepEqual((await q({op:'read'})).errors,[]);
    records.push({mode,selection,marker,focusedClass:input.cls,draftMarkers:markers.length,documentUnchanged:true,errors:typed.workbench.errors});
    fs.writeFileSync(path.join(testRoot,'native-focus-evidence.json'),JSON.stringify({host:vscode.env.appName,runId,source,records,basic:records.filter(r=>r.selection.kind==='basic').length,edge:records.filter(r=>r.selection.kind==='edge').length},null,2));
    pass((isTrae?'Trae':'VSCode')+' '+mode+' Alt+U focuses AI: '+selection.needle+(selection.closed?' (reopened sidebar, no scan code)':''));
  }
};
