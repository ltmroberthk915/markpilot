const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.probe = async function probe(request) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const api = window.vditor, editor = api.vditor;
  for(let i=0;i<100&&!api.__completion;i++) await pause(30);
  if(!api.__completion) throw new Error('Completion module did not initialize');
  const root = () => editor[editor.currentMode].element;
  const caretState=()=>{const s=getSelection(),n=s.anchorNode;return {node:n?.nodeName,text:n?.nodeType===3?n.data.slice(0,80):n?.outerHTML?.slice(0,220),offset:s.anchorOffset,parent:n?.parentElement?.className,collapsed:s.isCollapsed,lock:editor[editor.currentMode].composingLock};};
  if(!window.__completionTrace) {
    window.__completionTrace=[];
    for(const name of ['input','beforeinput','selectionchange','scroll','compositionstart','compositionend']) window.addEventListener(name,event=>{window.__completionTrace.push({at:Math.round(performance.now()),type:name,target:event.target.className,caret:caretState()});if(window.__completionTrace.length>20)window.__completionTrace.shift();},true);
  }
  const findText = text => {
    const walker=document.createTreeWalker(root(),NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())) if(!node.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')&&node.data.includes(text)) return node;
    throw new Error('Missing caret text '+text+' in '+root().innerHTML.slice(0,500));
  };
  if(request.action==='completion-prepare') {
    api.__completion.externalChange();api.setValue(request.text,true);await pause(400);
    const node=findText(request.needle);
    root().focus();getSelection().collapse(node,node.data.indexOf(request.needle)+(request.offset??request.needle.length));
    await pause(100);api.__completion.dismiss();
    window.__completionOriginal=api.getValue();window.__completionMath=[...root().querySelectorAll('.katex')];
    // setValue is a host-to-webview API and intentionally does not emit input.
    // Our artificial fixture replacement must also update the test document.
    api.__completion.changed(window.__completionOriginal);
    window.__completionTrace.length=0;
  } else if(request.action==='completion-context') {
    const {captureContext}=await import(editor.options.extPath+'/js/completion-context.js');
    const start=performance.now();const context=captureContext(api);const elapsed=performance.now()-start;
    return context?{needle:context.needle,caret:context.caret,prefix:context.prefix,suffix:context.suffix,elapsed}:null;
  } else if(request.action==='completion-math-context') {
    const {captureContext,enrichContext}=await import(editor.options.extPath+'/js/completion-context.js');
    const {completionPayload}=await import(editor.options.extPath+'/js/completion-policy.mjs');
    return completionPayload(enrichContext(api,captureContext(api)));
  } else if(request.action==='completion-move') {
    const node=findText(request.needle);getSelection().collapse(node,0);await pause(100);
  } else if(request.action==='completion-ime') {
    root().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    const event=new KeyboardEvent('keydown',{key:'Tab',code:'Tab',isComposing:true,bubbles:true,cancelable:true});root().dispatchEvent(event);
    const prevented=event.defaultPrevented;
    root().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));
    return {prevented,menu:!document.querySelector('.md-completion').hidden};
  } else if(request.action==='completion-zoom') {
    document.querySelector('.vditor-content').style.zoom=request.zoom||'150%';await pause(150);api.__completion.request(true);
    await pause(100);
  } else if(request.action==='completion-dismiss') api.__completion.dismiss();
  else if(request.action==='completion-settings') document.querySelector('.md-completion-tool button').click();
  else if(request.action==='completion-api-field') {
    if(!document.querySelector('#md-completion-settings').open) document.querySelector('.md-completion-tool button').click();
    const button=document.querySelector('[data-api-field="'+request.field+'"]');
    if(!button.getBoundingClientRect().height) throw new Error('API menu item is not visible');
    button.click();
  }
  else if(request.action==='completion-profile') {
    if(!document.querySelector('#md-completion-settings').open) document.querySelector('.md-completion-tool button').click();
    document.querySelector('[data-completion-profile="'+request.profileId+'"]').click();await pause(180);
  }
  else if(request.action==='completion-focus') root().focus();
  else if(request.action==='completion-toggle') {
    if(!document.querySelector('#md-completion-settings').open) document.querySelector('.md-completion-tool button').click();
    document.querySelector('[data-completion-toggle="'+request.field+'"]').click();await pause(150);
  }
  else if(request.action==='completion-boundary') {
    const node=findText(request.needle);getSelection().collapse(node.parentNode,[...node.parentNode.childNodes].indexOf(node)+1);await pause(40);
  }
  else if(request.action==='completion-formula-hit') {
    const node=findText(request.needle),preview=node.parentElement.closest('.vditor-ir__node,.vditor-wysiwyg__block')?.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');
    if(!preview) return null;
    window.__completionMath=window.__completionMath?.filter(formula=>!preview.contains(formula));
    preview.scrollIntoView({block:'center'});preview.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));await pause(100);
    return {source:node.parentElement.outerHTML.slice(0,500),owner:preview.parentElement.outerHTML.slice(0,800)};
  }
  else if(request.action==='completion-place') {
    const node=findText(request.needle);root().focus();getSelection().collapse(node,node.data.indexOf(request.needle)+(request.offset??request.needle.length));await pause(80);
  }
  else if(request.action==='completion-benchmark') {
    const {captureContext}=await import(editor.options.extPath+'/js/completion-context.js');
    const getValue=api.getValue;let calls=0;api.getValue=function(...args){calls++;return getValue.apply(this,args)};
    const times=[];for(let i=0;i<10;i++){const start=performance.now();if(!captureContext(api))throw new Error('Missing large-file context');times.push(performance.now()-start);}
    api.getValue=getValue;return {times,calls,characters:getValue.call(api).length};
  }
  const popup=document.querySelector('.md-completion'),preview=document.querySelector('.md-completion-preview');
  const rect=popup.getBoundingClientRect();
  const {captureContext}=await import(editor.options.extPath+'/js/completion-context.js');
  const liveContext=captureContext(api);
  const settings=document.querySelector('#md-completion-settings'), settingsRect=settings?.getBoundingClientRect();
  return {markdown:api.getValue(),original:window.__completionOriginal,mode:editor.currentMode,
    menu:!popup.hidden,labels:[...popup.querySelectorAll('[role=option] span')].map(node=>node.textContent),
    preview:!preview.hidden,ghost:preview.querySelector('.md-completion-ghost')?.textContent,
    toolbar:!!document.querySelector('.md-completion-tool button'),
    compactToolbar:(()=>{const c=document.querySelector('.md-completion-tool button'),t=document.querySelector('button[data-type="theme-settings"]');return !c.textContent.trim()&&!t.textContent.trim()&&!!c.querySelector('svg')&&!!t.querySelector('svg')&&c.getAttribute('aria-label').includes('补全')&&t.getAttribute('aria-label').includes('主题')&&c.getBoundingClientRect().width<=28&&t.getBoundingClientRect().width<=28&&['bold','italic'].every(name=>editor.toolbar.elements[name].getBoundingClientRect().width===0)})(),
    settings:{open:settings.open,text:settings.textContent,top:settingsRect.top,right:settingsRect.right,bottom:settingsRect.bottom,keyVisible:!!settings.querySelector('[data-api-field=key]')&&settings.querySelector('[data-api-field=key]').getBoundingClientRect().height>0,
      profiles:[...settings.querySelectorAll('[data-completion-profile]')].map(button=>({id:button.dataset.completionProfile,checked:button.getAttribute('aria-checked')==='true',label:button.querySelector('span').textContent}))},
    toolbarHeight:editor.element.querySelector('.vditor-toolbar').getBoundingClientRect().height,apiRow:!!document.querySelector('.md-completion-api-row'),
    focus:document.hasFocus(),active:document.activeElement.className,keys:window.__completionKeys?.slice(-4),
    context:liveContext?{prefix:liveContext.prefix,matches:liveContext.matches(),caret:liveContext.caret}:null,caret:caretState(),trace:window.__completionTrace,errors:window.__completionErrors,instances:document.querySelectorAll('.md-completion').length,
    outside:!root().contains(popup)&&!root().contains(preview),
    keptMath:window.__completionMath?.every(node=>node.isConnected),
    mathCount:root().querySelectorAll('.katex').length,
    mathEditing:(()=>{const s=getSelection(),c=(s.focusNode?.nodeType===3?s.focusNode.parentElement:s.focusNode)?.closest('code'),o=c?.closest('.vditor-ir__node,.vditor-wysiwyg__block');return{source:c?.getBoundingClientRect().height||0,preview:o?.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview')?.getBoundingClientRect().height||0};})(),
    bounds:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight},
    outline:request.debug?editor.outline.element.innerHTML:undefined};
};

exports.run = async function run({vscode,request,send,until,delay,pass,document,providerInstance,testRoot}) {
  const manager=providerInstance.completions, initial=manager.config;
  const disposable=[];let server;
  const key=async(key,code,virtual,modifiers=0)=>{
    await send('Page.bringToFront');const params={key,code,windowsVirtualKeyCode:virtual,modifiers};
    await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});
    await send('Input.dispatchKeyEvent',{type:'keyUp',...params,modifiers:0});await delay(120);
  };
  const inspect=()=>request('completion-read');
  const prepare=async(text,needle,offset)=>{
    await send('Page.bringToFront');
    const state=await request('completion-prepare',{text,needle,offset});await until(()=>document.getText()===state.markdown);
    // A host welcome/chat panel may take focus during startup. Restore the
    // editable Webview before delivering the next scripted typing event.
    await request('completion-focus');return state;
  };
  const menu=async()=>{let state;for(let i=0;i<40;i++){state=await inspect();if(state.menu)return state;await delay(70);}throw new Error('No menu: '+JSON.stringify({...state,markdown:state.markdown.slice(-500),original:state.original?.slice(-500)}));};
  const ghost=async()=>{let state;for(let i=0;i<130;i++){state=await inspect();if(state.preview&&state.ghost&&!state.ghost.includes('正在'))return state;await delay(70);}throw new Error('No ghost: '+JSON.stringify({...state,markdown:state.markdown.slice(-500),original:state.original?.slice(-500)}));};
  const selectedProfile=async id=>{let state;for(let i=0;i<50;i++){state=await inspect();if(!state.settings.open&&state.settings.profiles.some(item=>item.id===id&&item.checked))return state;await delay(50);}throw new Error('Profile UI did not settle: '+JSON.stringify(state.settings.profiles));};
  // 2.1.23 起不再内置任何预设模型（用户要求"不要预设过多"）：套件自己造两份
  // 用户配置，跑同一套切换/密钥断言。
  const FIRST={id:'custom-glm',label:'GLM',protocol:'anthropic',baseUrl:'https://open.bigmodel.cn/api/anthropic',model:'glm-5.3-flash'};
  const SECOND={id:'custom-ds',label:'DeepSeek',protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'};
  try {
    await manager.update({...initial,local:true,host:true,ai:false,automaticAI:false,profiles:[FIRST,SECOND],...FIRST,activeProfile:FIRST.id});
    assert.ok((await vscode.commands.getCommands(true)).includes('markpilot.completionSettings'));
    const initialUI=await inspect();assert.ok(initialUI.toolbar);assert.equal(initialUI.instances,1);pass('One completion instance, settings command and visible toolbar entry are available');
    assert.equal(initialUI.compactToolbar,true);pass('Theme and completion use labelled compact icons; bold and italic buttons take no toolbar space');
    assert.equal(initialUI.apiRow,false);assert.equal(initialUI.settings.open,false);
    let settings=await request('completion-settings');assert.ok(settings.settings.open&&settings.settings.keyVisible&&settings.settings.right<=settings.bounds.width&&settings.settings.bottom<=settings.bounds.height);
    assert.equal(settings.toolbarHeight,initialUI.toolbarHeight);assert.equal(settings.markdown,initialUI.markdown);
    const menuScreenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(testRoot,'completion-menu.png'),Buffer.from(menuScreenshot.data,'base64'));
    await key('ArrowDown','ArrowDown',40);await key('Escape','Escape',27);assert.equal((await inspect()).settings.open,false);
    await request('completion-settings');await request('completion-focus');assert.equal((await inspect()).settings.open,false);
    pass('API dropdown opens without another toolbar row and closes on Escape or outside focus');
    await request('completion-api-field',{field:'key'});await delay(250);
    await send('Input.insertText',{text:'isolated-settings-key'});await key('Enter','Enter',13);await delay(250);
    assert.equal(await manager.getAPIKey(),'isolated-settings-key');
    assert.equal(manager.config.baseUrl,FIRST.baseUrl);assert.equal(manager.config.model,FIRST.model);assert.equal(manager.config.ai,true);
    assert.ok(!JSON.stringify(manager.context.globalState.get('completionSettings')).includes('isolated-settings-key'));
    assert.equal((await inspect()).markdown,initialUI.markdown);pass('One-click API Key entry opens native password input and stores only in SecretStorage');
    await request('completion-toggle',{field:'automaticAI'});await until(()=>manager.config.automaticAI);
    assert.ok((await inspect()).settings.text.includes('自动 AI 已开启'));await request('completion-toggle',{field:'automaticAI'});await until(()=>!manager.config.automaticAI);
    await request('completion-toggle',{field:'local'});await until(()=>!manager.config.local);await request('completion-toggle',{field:'local'});await until(()=>manager.config.local);
    await request('completion-toggle',{field:'cursorSuggestions'});await until(()=>!manager.config.cursorSuggestions);await request('completion-toggle',{field:'cursorSuggestions'});await until(()=>manager.config.cursorSuggestions);
    await key('Escape','Escape',27);pass('Dropdown toggles persist automatic AI and local completion settings immediately');
    await request('completion-api-field',{field:'model'});await delay(150);await key('a','KeyA',65,2);await send('Input.insertText',{text:'glm-5.3[1M]'});await key('Enter','Enter',13);await delay(180);
    assert.equal(manager.config.model,'glm-5.3');assert.ok((await inspect()).settings.text.includes('glm-5.3'));
    assert.equal(await manager.getAPIKey(),'isolated-settings-key');pass('Model can be edited directly and the API dropdown updates without losing its key');
    const profiles=[FIRST,SECOND];
    await manager.update({...manager.config,profiles});
    await manager.saveAPIKey('isolated-ds-key',profiles[1]);
    for(const profile of profiles) {
      // A model edited on a preset stays bound to it across switches (that
      // persistence is the shipped behavior); other presets switch to their
      // own default models. glm-flash was edited to glm-5.3 earlier above.
      const expectedModel = profile.id===FIRST.id ? 'glm-5.3' : profile.model;
      await request('completion-profile',{profileId:profile.id});await until(()=>manager.config.model===expectedModel);
      assert.equal(manager.publicConfig.profiles.find(item=>item.id===FIRST.id).model,'glm-5.3');
      const ui=await selectedProfile(profile.id);assert.equal(ui.settings.open,false);assert.equal(ui.toolbarHeight,initialUI.toolbarHeight);assert.equal(ui.markdown,initialUI.markdown);
      assert.deepEqual(ui.settings.profiles.map(item=>item.id),profiles.map(item=>item.id));assert.equal(ui.settings.profiles.filter(item=>item.checked)[0].id,profile.id);
      assert.equal(await manager.getAPIKey(),profile.id===SECOND.id?'isolated-ds-key':'isolated-settings-key');
      assert.equal(manager.config.ai,true);assert.equal(manager.config.local,true);assert.equal(manager.config.automaticAI,false);
    }
    assert.ok((await vscode.commands.getCommands(true)).includes('markpilot.completionModel'));
    pass('User-configured models preserve keys and preferences without changing the document or toolbar height');
    await request('completion-settings');const profileScreenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(testRoot,'completion-profiles.png'),Buffer.from(profileScreenshot.data,'base64'));await key('Escape','Escape',27);
    await manager.selectProfile(FIRST.id);
    for(const [address,kept] of [['https://open.bigmodel.cn/api/anthropic/',true],['http://127.0.0.1:8555/v1',false]]) {
      await request('completion-api-field',{field:'baseUrl'});await delay(150);await key('a','KeyA',65,2);await send('Input.insertText',{text:address});await key('Enter','Enter',13);await delay(180);
      assert.equal(manager.config.baseUrl,address);assert.equal(!!(await manager.getAPIKey()),kept);
    }
    assert.equal(manager.config.ai,false);assert.equal(await manager.getAPIKey(profiles[0]),'isolated-settings-key');pass('Address editing retains saved platform keys without reusing them at a different service');
    await manager.update(initial);
    for(const mode of ['ir','wysiwyg','sv']) {
      await request('mode',{mode});
      await prepare('# Completion\n\nKeep $x+1$.\n\n\\f\n','\\f');
      await send('Input.insertText',{text:'r'});let automatic=await menu();assert.ok(automatic.labels.includes('\\frac'));
      pass('Actual typing automatically triggers formula candidates in '+mode);
      await prepare('# Completion\n\nKeep $x+1$.\n\n$\\f$\n','\\f');
      await request('completion-formula-hit',{needle:'\\f'});
      await request('completion-place',{needle:'\\f'});
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'r',code:'KeyR',windowsVirtualKeyCode:82,text:'r',unmodifiedText:'r'});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'r',code:'KeyR',windowsVirtualKeyCode:82});automatic=await menu();assert.ok(automatic.labels.includes('\\frac'));
      await key('Tab','Tab',9);assert.ok((await inspect()).markdown.includes('\\frac{}{}'));pass('Automatic formula candidates work inside an opened rendered formula in '+mode);
      await prepare('# Completion\n\nKeep $x+1$.\n\n$\\fr$\n','\\fr');
      const context=await request('completion-context');assert.ok(context?.prefix==='\\fr',mode+' math context '+JSON.stringify(context));
      await key(' ','Space',32,2);let state=await menu();assert.ok(state.labels.includes('\\frac'));
      await key('Tab','Tab',9);await delay(300);state=await inspect();
      assert.ok(state.markdown.includes('\\frac{}{}'),mode+' formula insert '+state.markdown);assert.ok(state.outside);
      await until(()=>document.getText()===state.markdown);await document.save();pass('Trusted Ctrl+Space / Tab inserts and saves LaTeX in '+mode);
      if(mode==='ir'||mode==='wysiwyg') {
        await key('z','KeyZ',90,2);await delay(250);state=await inspect();assert.equal(state.markdown,state.original);
        assert.ok(state.mathEditing.source>0&&state.mathEditing.preview>0);pass('Completion undo retains math source editing and lower preview in '+mode);
      }
      await prepare('# Completion\n\n/table\n','/table');await key(' ','Space',32,2);await menu();await key('Enter','Enter',13);await delay(300);state=await inspect();
      assert.ok(state.markdown.includes('| 列一')&&!state.markdown.includes('/table'));await until(()=>document.getText()===state.markdown);pass('Markdown template renders as a table in '+mode);
    }
    await request('mode',{mode:'ir'});
    await prepare('# Completion\n\n\\fr\n','\\fr');await key(' ','Space',32,2);await menu();
    const ime=await request('completion-ime');assert.equal(ime.prevented,false);assert.equal(ime.menu,false);pass('IME composition dismisses suggestions without consuming Tab');
    await prepare('# Completion\n\n```text\nplain text\n```\n','plain text');await key('Tab','Tab',9);await delay(250);let state=await inspect();
    assert.ok(state.markdown!==state.original&&!state.markdown.includes('undefined'));pass('Tab retains ordinary editor behavior without suggestions');
    await prepare('# Completion\n\n/table\n','/table');await key(' ','Space',32,2);await menu();await key('Escape','Escape',27);state=await inspect();assert.equal(state.menu,false);assert.equal(state.markdown,state.original);pass('Esc dismisses candidates without editing the document');
    await key(' ','Space',32,2);await menu();state=await request('completion-zoom',{zoom:'150%'});assert.ok(state.menu&&state.bounds.left>=0&&state.bounds.right<=state.bounds.width&&state.bounds.bottom<=state.bounds.height,JSON.stringify(state));await request('completion-zoom',{zoom:'100%'});await request('completion-dismiss');pass('Completion popup stays within the viewport when editor zoom changes');

    const positions=[];let providerDelay=0,providerActive=0,providerPeak=0;
    disposable.push(vscode.languages.registerCompletionItemProvider({scheme:'file',language:'markdown'},{async provideCompletionItems(doc,position){
      if(!doc.lineAt(position.line).text.slice(0,position.character).endsWith('prov'))return [];
      providerActive++;providerPeak=Math.max(providerPeak,providerActive);
      if(providerDelay)await delay(providerDelay);
      providerActive--;
      positions.push({line:position.line,character:position.character});
      const safe=new vscode.CompletionItem('provider-result');safe.insertText='provider-result';safe.range=new vscode.Range(position.translate(0,-4),position.translate(0,4));
      const unsafe=new vscode.CompletionItem('prov-danger');unsafe.insertText='danger';unsafe.additionalTextEdits=[vscode.TextEdit.insert(new vscode.Position(0,0),'wrong')];return [safe,unsafe];
    }}));
    const source='# 😀 Heading\n\nKeep $x+1$.\n\n> **bold** provTail\n';
    await prepare(source,'provTail',4);await key(' ','Space',32,2);state=await menu();
    assert.ok(state.labels.includes('provider-result')&&!state.labels.includes('prov-danger'));assert.deepEqual(positions.at(-1),{line:4,character:15});
    await key('Tab','Tab',9);await delay(300);state=await inspect();assert.ok(state.markdown.includes('> **bold** provider-result')&&!state.markdown.includes('Tail'));assert.ok(state.keptMath);await until(()=>document.getText()===state.markdown);pass('Real CompletionItemProvider receives exact Markdown position and applies its safe replacement range');
    await key('z','KeyZ',90,2);await delay(250);state=await inspect();assert.equal(state.markdown,state.original);assert.ok(state.keptMath);pass('Provider completion undo preserves unrelated rendered formula nodes');
    providerDelay=450;await prepare(source,'provTail',4);await key(' ','Space',32,2);await key(' ','Space',32,2);await menu();assert.equal(providerPeak,1);providerDelay=0;await request('completion-dismiss');pass('Repeated requests do not overlap uncancellable native provider work');
    fs.writeFileSync(path.join(testRoot,'workspace','completion-note.md'),'# Linked file\n');
    fs.writeFileSync(path.join(testRoot,'workspace','completion-image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"/>');
    for(const [prefix,expected] of [['@completion-note','[completion-note.md](completion-note.md)'],['!completion-image','![](completion-image.svg)']]) {
      await prepare('# Completion\n\n'+prefix+'\n',prefix);await key(' ','Space',32,2);await menu();await key('Tab','Tab',9);await delay(300);state=await inspect();assert.ok(state.markdown.includes(expected),state.markdown);pass('Workspace path completion inserts '+(prefix[0]==='!'?'an image':'a document link'));
    }
    await prepare('# Destination\n\nReference #Des\n','#Des');await key(' ','Space',32,2);state=await menu();assert.ok(state.labels.some(label=>label.includes('Destination')));await key('Tab','Tab',9);await delay(250);state=await inspect();assert.ok(/\[Destination\]\(#.+?\)/.test(state.markdown));pass('Heading completion uses an existing document anchor');

    const requests=[],mockErrors=[];let slow=false,serverDelay=0,serverText='继续写作',serverStatus=200;
    server=require('node:http').createServer(async(req,res)=>{
      try {
        let raw='';for await(const chunk of req)raw+=chunk;
        // A cancelled request can close before sending its body. The mock API
        // must reject that request, not throw an unhandled JSON parse error in
        // the extension host while the editor cancellation test keeps going.
        let body;try{body=JSON.parse(raw);}catch{if(!res.destroyed){res.statusCode=400;res.end('{"error":"Invalid JSON request"}');}return;}
        requests.push({url:req.url,body,key:req.headers['x-api-key'],at:Date.now()});
        if(slow||serverDelay)await delay(serverDelay||900);
        if(!res.destroyed){if(serverStatus===0){res.destroy();return;}res.statusCode=serverStatus;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:[{type:'text',text:serverText}]}));}
      }catch(error){if(!req.aborted)mockErrors.push(String(error.stack||error));if(!res.destroyed)res.destroy();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await manager.update({...initial,ai:true,automaticAI:false,baseUrl:'http://127.0.0.1:'+server.address().port+'/api/anthropic',protocol:'anthropic',model:'glm-5.3-flash[1M]'});
    await manager.saveAPIKey('isolated-test-token');
    await prepare('# 数学笔记\n\n## 微积分\n\nKeep $x+1$.\n\n文章开始，\n','文章开始，');
    await key('\\','Backslash',220,1);state=await ghost();assert.equal(state.ghost,'继续写作');assert.equal(state.markdown,state.original);assert.ok(state.outside);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(testRoot,'completion-ui.png'),Buffer.from(screenshot.data,'base64'));
    assert.equal(requests.at(-1).url,'/api/anthropic/v1/messages');assert.equal(requests.at(-1).body.model,'glm-5.3-flash');assert.equal(requests.at(-1).key,'isolated-test-token');pass('Anthropic API returns grey preview outside document and history');
    assert.match(requests.at(-1).body.messages[0].content,/<document_structure>\nPARENT # 数学笔记\nCURRENT ## 微积分/);pass('Actual extension host adds exact document heading ancestry to the existing AI request');
    await key('Tab','Tab',9);await delay(300);state=await inspect();assert.ok(state.markdown.includes('文章开始，继续写作'));assert.ok(state.keptMath);await until(()=>document.getText()===state.markdown);await document.save();
    await key('z','KeyZ',90,2);await delay(300);state=await inspect();assert.equal(state.markdown,state.original);assert.ok(state.keptMath);pass('AI acceptance saves correctly and undo retains unrelated formula cache');
    for(const status of [401,429,503,0]){
      serverStatus=status;await prepare('# Offline '+status+'\n\n失败请求'+status+'，\n','失败请求'+status+'，');
      await key('\\','Backslash',220,1);state=await ghost();assert.ok(state.ghost.includes(status?'HTTP '+status:'无法连接'),state.ghost);assert.equal(state.markdown,state.original);
      await prepare('# Offline local\n\n$\\fr$\n','\\fr');await request('completion-formula-hit',{needle:'\\fr'});await request('completion-place',{needle:'\\fr'});
      await key(' ','Space',32,2);await menu();await key('Tab','Tab',9);state=await inspect();assert.ok(state.markdown.includes('\\frac{}{}'));
      await until(()=>document.getText()===state.markdown);await document.save();assert.equal(fs.readFileSync(document.uri.fsPath,'utf8'),state.markdown);
      pass('AI '+(status||'network failure')+': local completion, editing and save remain functional in the actual extension');
    }
    serverStatus=200;
    slow=true;await prepare('# Completion\n\n文章开始，\n','文章开始，');const previous=requests.length;await key('\\','Backslash',220,1);await until(()=>requests.length>previous);
    await send('Input.insertText',{text:'新输入'});await delay(1100);state=await inspect();assert.equal(state.preview,false);assert.ok(state.markdown.includes('新输入'));pass('Typing cancels pending API work and stale results never reappear');
    await prepare('# Completion\n\n文章开始，\n','文章开始，');await key('\\','Backslash',220,1);await key('Escape','Escape',27);await delay(1100);state=await inspect();assert.equal(state.preview,false);assert.equal(state.markdown,state.original);pass('Esc cancels an outstanding AI request');
    slow=false;await manager.update({...manager.config,automaticAI:true,delay:400});await prepare('# Completion\n\n文章开始，\n','文章开始，');
    await send('Input.insertText',{text:'自动，'});await delay(1000);state=await ghost();assert.equal(state.ghost,'继续写作');const idleCount=requests.length;await delay(1000);assert.equal(requests.length,idleCount);pass('Automatic AI debounces actual input and sends no repeated idle requests');
    await prepare('# Completion\n\n输入法测试，\n','输入法测试，');const imeStart=requests.length;
    await send('Input.imeSetComposition',{text:'中文组词',selectionStart:4,selectionEnd:4});await delay(600);assert.equal(requests.length,imeStart);
    await send('Input.insertText',{text:'中文组词，'});state=await ghost();assert.equal(state.ghost,'继续写作');assert.ok(state.markdown.includes('中文组词，'));pass('Native Chinese IME sends no request while composing and resumes automatically on commit');
    await prepare('# Completion\n\n连续输入，\n','连续输入，');const burstStart=requests.length;
    for(const text of ['甲','乙','丙，']) {await send('Input.insertText',{text});await delay(60);}
    const stopped=Date.now();state=await ghost();assert.equal(state.ghost,'继续写作');assert.equal(requests.length,burstStart+1);
    assert.ok(requests.at(-1).at-stopped<1000);fs.writeFileSync(path.join(testRoot,'completion-trigger.json'),JSON.stringify({delay:manager.config.delay,requestAfterStopMs:requests.at(-1).at-stopped}));pass('Burst typing sends one AI request promptly after the last keystroke');
    await prepare('# Completion\n\n边界光标，\n','边界光标，');state=await request('completion-boundary',{needle:'边界光标，'});assert.equal(state.context?.matches,true);
    await key('\\','Backslash',220,1);state=await ghost();assert.equal(state.ghost,'继续写作');await key('Tab','Tab',9);assert.ok((await inspect()).markdown.includes('边界光标，继续写作'));pass('Element-boundary carets can request and accept AI without moving the insertion point');
    await prepare('# Long paragraph\n\n'+'中文'.repeat(17000)+'末尾，\n','末尾，');
    await send('Input.insertText',{text:'接着，'});state=await ghost();assert.equal(state.ghost,'继续写作');assert.ok(require('./completion-request-variants.cjs').inspectSource(requests.at(-1).body.messages[0].content).before.length<=4000);pass('Automatic AI remains available in a large paragraph with bounded context');
    serverDelay=5500;await prepare('# Completion\n\n慢响应，\n','慢响应，');await send('Input.insertText',{text:'继续，'});
    state=await ghost();assert.equal(state.ghost,'继续写作');serverDelay=0;pass('AI response slower than five seconds is retained instead of silently timing out');
    await prepare('# 复用建议\n\n这段正文，\n','这段正文，');await send('Input.insertText',{text:'因此，'});state=await ghost();assert.equal(state.ghost,'继续写作');
    const reusedCount=requests.length;await send('Input.insertText',{text:'继续'});state=await ghost();assert.equal(state.ghost,'写作');assert.equal(requests.length,reusedCount);
    await key('Tab','Tab',9);assert.ok((await inspect()).markdown.includes('因此，继续写作'));pass('Typing the beginning of a suggestion reuses its remainder without another API request');

    const formulaSource="# 导数定义\n\n设 $f(x)=x^2$，计算导函数。\n\n$f'(x)=$\n";
    const focusFormula=async(source,needle,offset)=>{
      await prepare(source,needle,offset);await request('completion-formula-hit',{needle});await request('completion-place',{needle,offset});
      await key('ArrowLeft','ArrowLeft',37);await key('ArrowRight','ArrowRight',39);
    };
    serverText='2x';const mathStart=requests.length;await focusFormula(formulaSource,"f'(x)=");state=await ghost();
    assert.equal(state.ghost,'2x');assert.equal(state.markdown,state.original);assert.equal(requests.length,mathStart+1);
    const mathPayload=require('./completion-request-variants.cjs').inspectSource(requests.at(-1).body.messages[0].content);
    assert.equal(mathPayload.kind,'math');assert.equal(mathPayload.intent,'derivation');assert.equal(mathPayload.formula,"f'(x)=⟦INSERT⟧");
    assert.ok(mathPayload.before.includes('f(x)=x^2'));assert.ok(mathPayload.heading.includes('导数定义'));
    assert.equal(requests.at(-1).body.max_tokens,256);assert.ok(mathPayload.after.startsWith('$'));
    pass('Entering a formula and moving the caret triggers one direct math request without typing');
    await key('Tab','Tab',9);state=await inspect();assert.ok(state.markdown.includes("$f'(x)=2x$"));assert.ok(state.keptMath);
    await key('z','KeyZ',90,2);await delay(300);assert.equal((await inspect()).markdown,formulaSource);pass('Math continuation accepts at the gap and undo preserves other formula nodes');
    await focusFormula(formulaSource,"f'(x)=");state=await ghost();assert.equal(state.ghost,'2x');assert.equal(requests.length,mathStart+1);
    await request('completion-dismiss');await key('\\','Backslash',220,1);state=await ghost();assert.equal(state.ghost,'2x');assert.equal(requests.length,mathStart+1);
    pass('Revisiting identical math context and explicit requests reuse the cached API result');

    serverText='\\partial V';const holeSource='# 偏导\n\n价值函数记为 $V(t,x)$。\n\n$\\frac{}{\\partial x}$\n';
    await focusFormula(holeSource,'\\frac{}{\\partial x}',6);state=await ghost();assert.equal(state.ghost,'\\partial V');
    const hole=require('./completion-request-variants.cjs').inspectSource(requests.at(-1).body.messages[0].content);assert.equal(hole.formula,'\\frac{⟦INSERT⟧}{\\partial x}');assert.equal(hole.intent,'argument');
    await key('Tab','Tab',9);assert.ok((await inspect()).markdown.includes('\\frac{\\partial V}{\\partial x}'));pass('A formula argument uses its denominator and retains existing right-side braces');

    await manager.update({...manager.config,automaticAI:false});
    await focusFormula('# 命令中间\n\n$\\frac{x}{y}$\n','\\frac{x}{y}',3);await key(' ','Space',32,2);await menu();await key('Tab','Tab',9);
    assert.ok((await inspect()).markdown.includes('$\\frac{x}{y}$'));pass('Command completion in the middle of a token retains its suffix arguments');
    await manager.update({...manager.config,automaticAI:true});serverText='ac{x}{y}';
    await send('Page.bringToFront');
    await prepare('# 候选共存\n\n$\\f$\n','\\f');await request('completion-formula-hit',{needle:'\\f'});await request('completion-place',{needle:'\\f'});
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'r',code:'KeyR',windowsVirtualKeyCode:82,text:'r',unmodifiedText:'r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'r',code:'KeyR',windowsVirtualKeyCode:82});
    state=await menu();assert.ok(state.labels.includes('\\frac'));
    for(let i=0;i<50&&!state.labels.includes(serverText);i++){await delay(60);state=await inspect();}
    assert.ok(state.labels.includes('\\frac')&&state.labels.includes(serverText),JSON.stringify(state.labels));
    await key('Tab','Tab',9);assert.ok((await inspect()).markdown.includes('$\\frac{x}{y}$'));pass('AI math suggestions remain selectable alongside fast local command candidates');
    await prepare('# 阅读正文\n\n这是一段完整的句子。\n','这是一段完整的句子。');const quietCount=requests.length;
    await key('ArrowLeft','ArrowLeft',37);await key('ArrowRight','ArrowRight',39);await delay(1600);assert.equal(requests.length,quietCount);pass('Local cursor checks on complete prose cause zero API calls');
    serverText='继续写作';serverDelay=500;await prepare('# 请求复用\n\n已发起，\n','已发起，');const pendingStart=requests.length;
    await key('\\','Backslash',220,1);await until(()=>requests.length>pendingStart);await key('\\','Backslash',220,1);
    state=await ghost();assert.equal(requests.length,pendingStart+1);pass('Repeated manual requests at the same pending caret do not create duplicate API calls');
    await prepare('# 移动期间缓存\n\n缓存位置，\n','缓存位置，');const navigateStart=requests.length;
    await key('\\','Backslash',220,1);await until(()=>requests.length>navigateStart);await key('ArrowLeft','ArrowLeft',37);await delay(600);
    assert.equal((await inspect()).preview,false);await key('ArrowRight','ArrowRight',39);state=await ghost();assert.equal(state.ghost,'继续写作');assert.equal(requests.length,navigateStart+1);serverDelay=0;
    pass('An in-flight result after cursor navigation is cached and reused only at its original context');
    await request('completion-dismiss');await manager.update({...initial,ai:false,automaticAI:false});
    const large='# Large\n\n'+Array.from({length:2200},(_,index)=>'第'+index+'段 '+'教材内容'.repeat(13)+' $x_'+index+'+1$\n\n').join('')+'END /ta\n';
    await prepare(large,'/ta');const benchmark=await request('completion-benchmark');assert.equal(benchmark.calls,0);assert.ok(benchmark.characters>120000);assert.ok(Math.max(...benchmark.times)<100);
    fs.writeFileSync(path.join(testRoot,'completion-performance.json'),JSON.stringify(benchmark,null,2));pass('Large-document context extraction remains local without calling whole-document getValue');
    await send('Input.insertText',{text:'b'});state=await menu();assert.ok(state.labels.includes('/table'));pass('Automatic candidates survive caret scrolling at the end of a large document');
    await prepare('# Large paragraph\n\n'+'正文'.repeat(17000)+' /ta\n','/ta');
    await send('Input.insertText',{text:'b'});state=await menu();assert.ok(state.labels.includes('/table'));pass('Local templates trigger inside a paragraph larger than the source mapping budget');
    assert.deepEqual(mockErrors,[],'Mock completion API threw an unexpected error');
  } finally {
    disposable.forEach(item=>item.dispose());
    for(const profile of manager.publicConfig.profiles)await manager.deleteAPIKey(profile);
    if(server?.address())await manager.deleteAPIKey({...initial,baseUrl:'http://127.0.0.1:'+server.address().port+'/api/anthropic',protocol:'anthropic'});
    await manager.update(initial);server?.close();
  }
};
