const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.probe=async function(request){
  const api=window.vditor,e=api.vditor,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  if(!api.__nativeChat)throw Error('Native chat bridge not installed');
  if(request.op==='mode'){
    if(e.currentMode!==request.mode)e.toolbar.elements['edit-mode'].querySelector('button[data-mode="'+request.mode+'"]').click();await pause(220);
  }
  const root=e[e.currentMode].element;
  const find=(needle,occurrence=0)=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,count=0;
    while(n=walker.nextNode()){
      if(n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'))continue;
      for(let at=n.data.indexOf(needle);at>=0;at=n.data.indexOf(needle,at+needle.length))if(count++===occurrence)return[n,at];
    }throw Error('Missing selected text '+needle);
  };
  let point;
  if(request.op==='select'){
    const a=find(request.needle,request.occurrence),b=request.endNeedle?find(request.endNeedle,request.endOccurrence):a;
    a[0].parentElement.scrollIntoView({block:'center',inline:'center'});root.focus({preventScroll:true});
    const r=document.createRange();r.setStart(...a);r.setEnd(b[0],b[1]+(request.endNeedle||request.needle).length);
    const s=getSelection();s.removeAllRanges();s.addRange(r);
    if(request.reverse)s.setBaseAndExtent(r.endContainer,r.endOffset,r.startContainer,r.startOffset);
    const first=r.cloneRange();first.setEnd(a[0],Math.min(a[0].length,a[1]+1));let box=first.getBoundingClientRect();
    if(!box.height||!box.width)box=(a[0].parentElement.closest('.vditor-ir__node,.vditor-wysiwyg__block')?.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview')||a[0].parentElement).getBoundingClientRect();
    point={x:box.left+Math.min(2,box.width/2),y:box.top+box.height/2};
    await pause(60);
  }
  if(request.op==='empty'){root.focus();getSelection().collapse(root,0);await pause(50);}
  if(request.op==='typeSelect'){
    const a=find('结尾');root.focus();getSelection().collapse(a[0],a[0].length);document.execCommand('insertText',false,request.text);
    const s=getSelection(),r=document.createRange();r.setStart(s.focusNode,s.focusOffset-request.text.length);r.setEnd(s.focusNode,s.focusOffset);s.removeAllRanges();s.addRange(r);
    // No sleep: Alt+U must synchronize a pending Vditor input callback.
  }
  return{point,mode:e.currentMode,value:api.getValue(),selected:getSelection().toString(),focus:document.hasFocus(),activeElement:document.activeElement?.className,composingLock:!!e[e.currentMode].composingLock,errors:window.__completionErrors||[],keys:window.__completionKeys?.slice(-12)};
};
exports.run=async({vscode,request,shortcut,send,document,file,until,pass,testRoot,dispatches,providerInstance})=>{
  const q=fields=>request('nativeChat',fields),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),records=[];
  const isTrae=(await vscode.commands.getCommands(true)).includes('workbench.action.chat.icube.open');
  const svg='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>').toString('base64');
  const source='# AI 选区\n\n前文 **加粗中文🙂** 和 $x+1$。\n\n![图]('+svg+')\n\n重复段落\n\n重复段落\n\n| A | B |\n|---|---|\n| 一 | 重复项 |\n| 二 | 重复项 |\n\n> 引用选区\n\n```py\nprint("协作选区")\n```\n\n结尾\n';
  const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(0,0,document.lineCount,0),source);
  assert.equal(await vscode.workspace.applyEdit(edit),true);await document.save();
  for(let i=0;i<100;i++){if((await q({op:'read'})).value.includes('协作选区'))break;await pause(50);}
  const original=document.getText(),disk=fs.readFileSync(file,'utf8');
  await send('Runtime.evaluate',{expression:`window.__nativeChatReceived=[];document.addEventListener('icube.ai-chat.addToChat',event=>window.__nativeChatReceived.push(JSON.parse(JSON.stringify(event.detail))));true`});
  const occurrence=(needle,n=0)=>{let at=-1;do{at=original.indexOf(needle,at+1);}while(n-->0);return at;};
  const test=async(mode,selection)=>{
    await q({op:'mode',mode});const prepared=await q({op:'select',...selection});
    const frameState=(await send('Runtime.evaluate',{expression:`(()=>{const editor=document.getElementById('workbench.parts.editor')?.getBoundingClientRect();return{editor:editor?.toJSON(),frames:[...document.querySelectorAll('iframe')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,id:n.id,title:n.title,parent:n.parentElement?.className}}).filter(r=>r.width>100&&r.height>100)}})()`,returnByValue:true})).result.value;
    fs.writeFileSync(path.join(testRoot,'native-chat-frames.json'),JSON.stringify(frameState,null,2));
    const frame=frameState.frames.filter(r=>frameState.editor&&r.x+r.width/2>=frameState.editor.left&&r.x+r.width/2<=frameState.editor.right&&r.y+r.height/2>=frameState.editor.top&&r.y+r.height/2<=frameState.editor.bottom).sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    assert.ok(frame,'Visible custom editor frame is separate from the AI sidebar');
    await send('Page.bringToFront');
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:prepared.point.x+frame.x,y:prepared.point.y+frame.y,button:'left',clickCount:1});
    await q({op:'select',...selection});
    const before=dispatches.length;
    if(selection.command)await vscode.commands.executeCommand('markpilot.addSelectionToChat');
    else await shortcut('U',1,!selection.noCode);
    try{await until(()=>dispatches.length===before+1);}catch(error){fs.writeFileSync(path.join(testRoot,'native-chat-failure.json'),JSON.stringify({mode,selection,state:await q({op:'read'}),dispatches},null,2));throw error;}
    const called=dispatches.at(-1);assert.equal(called.command,isTrae?'workbench.action.chat.icube.open':'workbench.action.chat.open');
    assert.equal(called.args.query,undefined,'must only attach; never submit a prompt');
    const attached=isTrae?called.args.docviewPayload:called.args.attachFiles[0];
    assert.equal(attached.uri.toString(),document.uri.toString());
    const range=isTrae?attached.selection:attached.range;
    const a=document.positionAt(occurrence(selection.needle,selection.occurrence)),b=document.positionAt(occurrence(selection.endNeedle||selection.needle,selection.endNeedle?selection.endOccurrence:selection.occurrence)+(selection.endNeedle||selection.needle).length);
    assert.deepEqual([range.startLineNumber,range.startColumn,range.endLineNumber,range.endColumn],[a.line+1,a.character+1,b.line+1,b.character+1]);
    await until(()=>called.finished||called.error);assert.equal(called.error,undefined);
    assert.equal(document.getText(),original);assert.equal(document.isDirty,false);assert.equal(fs.readFileSync(file,'utf8'),disk);
    const ui=(await send('Runtime.evaluate',{expression:`JSON.stringify({received:window.__nativeChatReceived,attachments:[...document.querySelectorAll('.chat-attached-context,.chat-attachments-container')].map(n=>({text:n.textContent,html:n.outerHTML.slice(0,6000)}))})`,returnByValue:true})).result.value;
    const evidence=JSON.parse(ui);records.push({mode,selection,command:called.command,range,uri:attached.uri.toString(),evidence});
    fs.writeFileSync(path.join(testRoot,'native-chat-progress.json'),JSON.stringify({host:vscode.env.appName,records},null,2));
    if(isTrae)assert.ok(evidence.received.some(e=>e.args?.selections?.some(r=>r.startLineNumber===range.startLineNumber&&r.endLineNumber===range.endLineNumber)),'native Trae attachment event reached its workbench');
    else assert.ok(evidence.attachments.some(e=>e.text.includes('smoke.md')),'native VS Code chat displays a file attachment');
    pass('Native '+(isTrae?'Trae':'VSCode')+' '+mode+' '+(selection.command?'command':selection.noCode?'Alt+U without scan code':'Alt+U')+' attaches exact '+selection.needle+' file range');
  };
  for(const mode of ['ir','wysiwyg','sv']){
    await test(mode,{needle:'一',noCode:true});
    await test(mode,{needle:'重复项',occurrence:1});
    await test(mode,{needle:'加粗中文🙂',reverse:true});
    await test(mode,{needle:'x+1'});
    await test(mode,{needle:'协作选区'});
    await test(mode,{needle:'重复段落',endNeedle:'引用选区',command:true});
  }
  await q({op:'mode',mode:'ir'});await q({op:'empty'});const count=dispatches.length;await shortcut('U',1);await pause(200);assert.equal(dispatches.length,count);pass('Empty selection does not attach a stale range or a different native editor');
  await q({op:'typeSelect',text:'尚未保存🙂'});await shortcut('U',1);await until(()=>dispatches.length===count+1);const typed=dispatches.at(-1);await until(()=>typed.finished||typed.error);assert.equal(typed.error,undefined);
  const payload=isTrae?typed.args.docviewPayload.selection:typed.args.attachFiles[0].range;
  const selected=document.getText(new vscode.Range(payload.startLineNumber-1,payload.startColumn-1,payload.endLineNumber-1,payload.endColumn-1));
  assert.equal(selected,'尚未保存🙂');assert.equal(document.isDirty,true);assert.equal(fs.readFileSync(file,'utf8'),disk);pass('Immediate Alt+U includes freshly typed unsaved source without writing disk');
  assert.deepEqual((await q({op:'read'})).errors,[]);
  const session=[...providerInstance.nativeChat.sessions.values()].find(s=>s.panel.active);assert.ok(session);
  fs.writeFileSync(path.join(testRoot,'native-chat-evidence.json'),JSON.stringify({host:vscode.env.appName,records,unsavedRange:payload},null,2));
};
