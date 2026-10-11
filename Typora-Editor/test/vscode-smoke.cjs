// Runs the real extension host and Webview in a disposable VSCode profile.
// node test/vscode-smoke.cjs [Code.exe] [extracted-extension-directory]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Injected only by this test into the provider's actual Webview HTML. All
// assets and the acquireVsCodeApi bridge still use VSCode's resource URLs.
function webviewProbe() {
  window.__completionKeys=[];
  window.__completionErrors=[];window.addEventListener('error',event=>window.__completionErrors.push(String(event.error?.stack||event.message)));
  window.addEventListener('unhandledrejection',event=>window.__completionErrors.push(String(event.reason?.stack||event.reason)));
  window.addEventListener('keydown',event=>window.__completionKeys.push({key:event.key,code:event.code,ctrl:event.ctrlKey,alt:event.altKey,shift:event.shiftKey,composing:event.isComposing,prevented:event.defaultPrevented,focus:document.hasFocus(),target:event.target.className}),true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate) {
    const end = Date.now() + 60000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Webview state timed out');
      await delay(30);
    }
  }
  async function execute(request) {
    await until(() => window.vditor?.vditor?.__typoraPerformance);
    const state = window.vditor.vditor;
    if (request.action === 'scriptHealth') return {
      errors: window.__completionErrors,
      iconScripts: document.querySelectorAll('script[src*="/icons/material.js"],script#vditorIconScript').length,
      iconLoaded: Boolean(document.getElementById('vditorIconScript')?.src),
    };
    if (request.action.startsWith('completion-')) return window.__completionProbe(request);
    if (request.action==='mathTable') return window.__mathTableProbe(request);
    if (request.action==='splitNavigation') return window.__splitNavigationProbe(request);
    if (request.action==='nativeChat') return window.__nativeChatProbe(request);
    if(request.action==='mermaid'){
      const host=document.createElement('div');document.body.append(host);
      try{
        for(const code of ['venn-beta\nset A["数学"]\nset B["应用"]\nunion A,B','treeView-beta\n    notes/\n        HJB.md']){
          const node=document.createElement('code');node.className='language-mermaid';node.textContent=code;host.append(node);
        }
        Vditor.mermaidRender(host,state.options.cdn,'light');await until(()=>host.querySelectorAll('[data-processed="true"]').length===2);
        return{svg:host.querySelectorAll('svg').length,errors:host.querySelectorAll('.error-icon,.error-text').length,url:document.getElementById('vditorMermaidScript')?.src};
      }finally{host.remove();}
    }
    if (request.action === 'mediaBad') {
      // Round-trips the media-command channel with an invalid payload: the
      // host must answer a structured error without touching the clipboard.
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve({error: 'media-result timeout'}), 5000);
        window.handler.on('media-result', value => {
          clearTimeout(timer);
          resolve(value);
        });
        window.handler.emit('media-command', {id: 'smoke-media-bad', action: 'copy-table'});
      });
    }
    if (request.action === 'shortcutPrepare') {
      window.vditor.setValue('alpha beta\n\nsecond line\n', true);
      await delay(300);
      const root = state[state.currentMode].element;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = []; let node;
      while ((node = walker.nextNode())) if (!node.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')) nodes.push(node);
      const first = nodes.find(node => node.textContent.includes('alpha'));
      const last = request.multiline ? nodes.find(node => node.textContent.includes('second line')) : first;
      root.focus();
      const range = document.createRange(); range.setStart(first,0);range.setEnd(last,request.multiline ? last.length : 5);
      getSelection().removeAllRanges();getSelection().addRange(range);
    } else if (request.action === 'shortcutSettings') {
      state.toolbar.elements['shortcut-settings'].querySelector('button').click();
      const input = document.querySelector('#typora-shortcuts input[data-action="math"]');
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'M',code:'KeyM',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));
      document.querySelector('#typora-shortcuts [data-action="save"]').click();
      await delay(100);
    } else if (request.action === 'outlineState') {
      const editor = window.vditor?.vditor;
      if (!editor) throw new Error('no editor');
      const m = window.__outlineReveal;
      const source = editor.sv?.element;
      const sel = getSelection();
      const inSource = !!(source && (source.contains(document.activeElement) || (sel.focusNode && source.contains(sel.focusNode))));
      const focusText = sel.focusNode ? sel.focusNode.textContent.slice(Math.max(0, sel.focusOffset - 40), sel.focusOffset + 40) : null;
      return {reveal: m ? {index: m.index, mode: m.mode, line: m.line} : null, current: editor.currentMode, svFocus: inSource, focusText};
    } else if (request.action === 'mode') {
      state.toolbar.elements['edit-mode'].querySelector(`button[data-mode="${request.mode}"]`).click();
      await until(() => state.currentMode === request.mode);
      await delay(300);
    } else if (request.action === 'input') {
      const root = state[state.currentMode].element;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.length > 2 && !node.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')) break;
      }
      if (!node) throw new Error('No editable source text');
      getSelection().collapse(node, node.length);
      if (!document.execCommand('insertText', false, request.text)) throw new Error('Browser insertText failed');
      await delay(350);
    } else if (request.action === 'repairFind') {
      const panel=document.getElementById('typora-find');if(!panel)throw new Error('Native Ctrl+H did not open find');
      panel.querySelector('[data-field=query]').value='alpha';panel.querySelector('[data-field=replace]').value='替换成功';
      window.vditor.__typoraFind.search();await until(()=>!window.vditor.__typoraFind.state.pending);
      if(window.vditor.__typoraFind.state.count!==1)throw new Error('Worker search failed');
      window.vditor.__typoraFind.replace(true);await delay(350);window.vditor.__typoraFind.close();
    } else if (request.action === 'uiFind') {
      const p=document.getElementById('typora-find');if(!p)throw new Error('Find panel did not open');
      p.querySelector('[data-field=query]').value='alpha';p.querySelector('[data-field=replace]').value='UI';
      window.vditor.__typoraFind.search();await until(()=>!window.vditor.__typoraFind.state.pending);
      p.querySelector('[data-mode=replace]').click();p.querySelector('[data-mode=find]').click();p.querySelector('[data-mode=replace]').click();
      if(!window.vditor.__typoraFind.state.replacing||p.querySelector('[data-field=replace]').value!=='UI')throw new Error('Mode switch lost state');
      if(request.focus==='document'){
        const root=state[state.currentMode].element;root.focus();getSelection().collapse(root,0);window.__uiCaret=getSelection().getRangeAt(0).cloneRange();
      }else p.querySelector('[data-field=replace]').focus();
    } else if (request.action === 'uiOutline') {
      state.outline.toggle(state,false);await delay(150);
      const toggle=state.toolbar.elements.outline.querySelector('button'),before=toggle.getBoundingClientRect();
      state.outline.toggle(state,true);await delay(150);
      const outline=state.outline.element.getBoundingClientRect(),host=state.element.getBoundingClientRect(),toolbar=state.toolbar.element.getBoundingClientRect(),after=toggle.getBoundingClientRect();
      if(Math.abs(outline.top-toolbar.bottom)>2||Math.abs(outline.bottom-host.bottom)>2)throw new Error('VSCode outline does not fill the area below the stationary toolbar');
      if(Math.abs(before.x-after.x)>1||Math.abs(before.y-after.y)>1||toggle.getAttribute('aria-expanded')!=='true')throw new Error('Outline toggle moved');
      const divider=document.querySelector('.typora-outline-resizer');divider.focus();
      divider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await delay(100);
      if(Math.abs(state.outline.element.getBoundingClientRect().width-outline.width-16)>2)throw new Error('VSCode outline resize failed');
    } else if (request.action === 'readingPalette') {
      const source=window.vditor.getValue(),nodes=[...state[state.currentMode].element.querySelectorAll('.katex')];
      const button=state.toolbar.elements['reading-palette'].querySelector('button');
      if(button.textContent.trim())throw new Error('Palette toolbar button is not icon-only');
      button.click();document.querySelector('#typora-palette [data-palette="beige"]').click();document.getElementById('typora-palette').close();await delay(100);
      if(window.vditor.getValue()!==source||!nodes.every(n=>n.isConnected))throw new Error('Palette affected document or formula cache');
      if(getComputedStyle(state[state.currentMode].element).backgroundColor!=='rgb(244, 239, 223)')throw new Error('Palette did not apply');
    } else if (request.action === 'repairTheme') {
      if(!state.toolbar.elements['theme-settings'].querySelector('button').getAttribute('aria-label')?.includes('主题'))throw new Error('Missing accessible theme label');
      state.toolbar.elements['theme-settings'].querySelector('button').click();
      document.querySelector('#typora-themes [data-theme="konayuki-dark"]').click();document.getElementById('typora-themes').close();await delay(150);
    } else if (request.action === 'repairImage') {
      const root=state[state.currentMode].element;root.focus();getSelection().collapse(root,root.childNodes.length);
      state.options.upload.handler([new File(['<svg xmlns="http://www.w3.org/2000/svg" width="36" height="24"><rect width="36" height="24" fill="blue"/></svg>'],'图片.svg',{type:'image/svg+xml'})]);
      await until(()=>root.querySelector('img')?.naturalWidth===36);await delay(300);
    } else if (request.action === 'history') {
      const root = state[state.currentMode].element;
      root.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: request.inputType,
      }));
      await delay(350);
    }
    await until(() => window.__typoraMathStats.pending === 0);
    const markdown = window.vditor.getValue();
    return {
      markdown,
      mode: state.currentMode,
      scheduler: typeof window.__typoraScheduleMath === 'function',
      incremental: !!state.__typoraPerformance,
      nativeEqual: state.currentMode !== 'ir' || markdown === state.lute.VditorIRDOM2Md(state.ir.element.innerHTML),
      formulas: state[state.currentMode].element.querySelectorAll('.katex').length,
      pending: window.__typoraMathStats.pending,
      katexScripts: document.querySelectorAll('script#vditorKatexScript').length,
      chemistryScripts: document.querySelectorAll('script#vditorKatexChemScript').length,
      findOpen:!!document.getElementById('typora-find'),
      mathErrors:state[state.currentMode].element.querySelectorAll('.vditor-math-error').length,
      caretRetained:!window.__uiCaret||(getSelection().anchorNode===__uiCaret.startContainer&&getSelection().anchorOffset===__uiCaret.startOffset),
      theme:document.documentElement.dataset.editorTheme,
      palette:document.documentElement.dataset.readingPalette,
    };
  }
  window.addEventListener('message', async ({data}) => {
    if (data?.type !== '__smokeRequest') return;
    try {
      const result = await execute(data.content);
      window.handler.emit('__smokeResponse', {id: data.content.id, result});
    } catch (error) {
      window.handler.emit('__smokeResponse', {id: data.content.id, error: String(error.stack || error)});
    }
  });
  window.handler.emit('__smokeReady');
}

exports.run = async function () {
  const vscode = require('vscode');
  const testRoot = process.env.MD_EDITOR_SMOKE_ROOT;
  if (!testRoot) throw new Error('Use the Node launcher to create an isolated test profile');
  const extension = vscode.extensions.all.find(item => item.packageJSON?.name === 'markpilot') ||
    vscode.extensions.getExtension('markpilot.markpilot');
  assert.ok(extension, 'Development extension was discovered');
  await extension.activate();
  // VSCode can lowercase drive letters when exposing extensionPath. Requiring
  // it again with different casing creates a second Windows module instance.
  const providerPath = path.join(extension.extensionPath, 'out/provider/markdownEditorProvider.js').toLowerCase();
  const provider = Object.values(require.cache).find(module => module.filename?.toLowerCase() === providerPath)?.exports;
  assert.ok(provider?.MarkdownEditorProvider, 'Use the provider already loaded by VSCode');
  const prototype = provider.MarkdownEditorProvider.prototype;
  const original = prototype.resolveCustomTextEditor;
  const pending = new Map();
  const results = [];
  const unhandled=[];
  const onUnhandled=error=>{unhandled.push(String(error?.stack||error));fs.writeFileSync(path.join(testRoot,'unhandled-errors.json'),JSON.stringify(unhandled,null,2));};
  process.on('unhandledRejection',onUnhandled);
  let panel;
  let providerInstance;
  const nativeChatDispatches=[];
  let debugSocket;
  let nextId = 0;
  let resolveReady;
  let readyCount=0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const pass = message => { results.push('PASS ' + message); console.log(results.at(-1)); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate) {
    const end = Date.now() + 60000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Extension host state timed out');
      await delay(30);
    }
  }
  async function request(action, fields = {}) {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Webview request timed out: ' + action));
      }, 65000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
    const posted = await panel.webview.postMessage({type: '__smokeRequest', content: {id, action, ...fields}});
    if (!posted) {
      pending.get(id)?.reject(new Error('Webview rejected request: ' + action));
      pending.delete(id);
    }
    return response;
  }
  prototype.resolveCustomTextEditor = function (document, webviewPanel, token) {
    providerInstance = this;
    if(this.nativeChat&&!this.nativeChat.__observed){
      this.nativeChat.__observed=true;
      this.nativeChat.platform={...vscode,commands:{...vscode.commands,executeCommand:async(command,...args)=>{
        if(!['workbench.action.chat.icube.open','workbench.action.chat.open'].includes(command)||!(args[0]?.docviewPayload||args[0]?.attachFiles))return vscode.commands.executeCommand(command,...args);
        const called={command,args:args[0]};nativeChatDispatches.push(called);
        try{const result=await vscode.commands.executeCommand(command,...args);called.finished=true;return result;}catch(error){called.error=error.message;throw error;}
      }}};
    }
    panel = webviewPanel;
    panel.webview.onDidReceiveMessage(message => {
      if (message.type === '__smokeReady') {readyCount++;resolveReady();}
      if (message.type !== '__smokeResponse') return;
      const item = pending.get(message.content.id);
      if (!item) return;
      pending.delete(message.content.id);
      if (message.content.error) item.reject(new Error(message.content.error));
      else item.resolve(message.content.result);
    });
    const result = original.call(this, document, webviewPanel, token);
    panel.webview.html = panel.webview.html.replace('</html>', `<script>window.__nativeChatProbe=(${require('./native-chat-suite.cjs').probe.toString()});window.__splitNavigationProbe=(${require('./split-navigation-suite.cjs').probe.toString()});window.__mathTableProbe=(${require('./math-table-suite.cjs').probe.toString()});window.__completionProbe=(${require('./completion-suite.cjs').probe.toString()});(${webviewProbe.toString()})();</script></html>`);
    return result;
  };
  try {
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname,'../extension-src/package.json'),'utf8')).version;
    assert.equal(extension.packageJSON.version, expectedVersion);
    pass('VSCode activates ' + expectedVersion);
    const file = path.join(testRoot, 'workspace', 'smoke.md');
    const uri = vscode.Uri.file(file);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'markpilot.editor');
    assert.ok(panel, 'VSCode resolved the actual custom editor provider');
    fs.writeFileSync(path.join(testRoot, 'webview.html'), panel.webview.html);
    let readyTimer;
    try {
      await Promise.race([ready, new Promise((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Webview did not initialize')), 65000);
      })]);
    } finally { clearTimeout(readyTimer); }
    let state = await request('read');
    assert.ok(state.scheduler && state.incremental && state.nativeEqual);
    assert.ok(state.formulas >= 2);
    assert.equal(state.katexScripts, 1);
    assert.equal(state.chemistryScripts, 1);
    pass('VSCode resource URLs load both optimization modules, KaTeX and mhchem');
    const scripts=await request('scriptHealth');assert.deepEqual(scripts.errors,[]);assert.equal(scripts.iconScripts,1);assert.equal(scripts.iconLoaded,true);
    pass('Actual VSIX preloaded icons avoid duplicate synchronous XHR and startup JavaScript errors');
    assert.equal(state.mathErrors,0);assert.ok(state.markdown.includes(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`)&&state.markdown.includes(', 后面正文 $z+1$'));
    pass('Actual VSIX initial load keeps trailing punctuation and prose outside matrix math');
    const diagrams=await request('mermaid');assert.equal(diagrams.svg,2);assert.equal(diagrams.errors,0);assert.ok(diagrams.url.includes('11.17.2'));
    pass('Official Mermaid 11.17.2 loads via actual Webview URLs and renders Venn and TreeView');
    if (!process.env.MD_EDITOR_COMPLETION_ONLY&&!process.env.MD_EDITOR_CHAT_ONLY&&!process.env.MD_EDITOR_NAV_ONLY) {
    const formula = '$x+1$';
    for (const mode of ['ir', 'wysiwyg', 'sv', 'ir']) {
      await request('mode', {mode});
      const before = (await request('read')).markdown;
      const marker = '保存' + mode + nextId + '中文🙂';
      state = await request('input', {text: marker});
      assert.ok(state.markdown.includes(marker) && state.markdown.includes(formula));
      assert.ok(state.nativeEqual);
      await until(() => document.getText() === state.markdown);
      assert.equal(document.isDirty, true);
      assert.equal(await document.save(), true);
      assert.equal(fs.readFileSync(file, 'utf8'), state.markdown);
      pass('Webview input reaches TextDocument and saves exact Markdown in ' + mode);
      if (mode === 'ir') {
        const after = state.markdown;
        state = await request('history', {inputType: 'historyUndo'});
        assert.equal(state.markdown, before);
        await until(() => document.getText() === before);
        state = await request('history', {inputType: 'historyRedo'});
        assert.equal(state.markdown, after);
        await until(() => document.getText() === after);
        pass('Host history events preserve source cache, formulas and document synchronization');
      }
    }
    const external = '# External update\n\nnew $\\Omega$\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), external);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await document.save(), true);
    const end = Date.now() + 10000;
    do {
      state = await request('read');
      if (state.markdown === external) break;
      await delay(50);
    } while (Date.now() < end);
    assert.equal(state.markdown, external);
    assert.ok(state.nativeEqual);
    assert.equal(state.pending, 0);
    pass('External document save refreshes Webview source cache and drains math work');
    }
    // Chromium input is trusted and travels through VSCode's real Webview
    // keyboard forwarding, unlike dispatching a synthetic KeyboardEvent.
    const targets = await (await fetch('http://127.0.0.1:' + process.env.MD_EDITOR_SMOKE_DEBUG_PORT + '/json/list')).json();
    const page = targets.find(target => target.type === 'page' && target.url.includes('workbench'));
    assert.ok(page, 'Isolated VSCode debugging target');
    debugSocket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {debugSocket.addEventListener('open',resolve,{once:true});debugSocket.addEventListener('error',reject,{once:true});});
    let debugId = 0;
    const debugPending = new Map(),debugContexts=new Map();
    debugSocket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if(message.method==='Runtime.executionContextCreated')debugContexts.set((message.sessionId||'')+':'+message.params.context.id,{...message.params.context,sessionId:message.sessionId});
      if(message.method==='Runtime.executionContextDestroyed')debugContexts.delete((message.sessionId||'')+':'+message.params.executionContextId);
      if(message.method==='Target.attachedToTarget')send('Runtime.enable',{},message.params.sessionId).catch(()=>{});
      const item = debugPending.get(message.id);
      if (!item) return;debugPending.delete(message.id);clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));else item.resolve(message.result);
    });
    const send = (method,params={},sessionId) => new Promise((resolve,reject) => {
      if(method==='Page.bringToFront'&&process.env.MD_EDITOR_BACKGROUND==='1'){resolve({});return;}
      const id=++debugId;const timer=setTimeout(()=>{debugPending.delete(id);reject(new Error('CDP timeout: '+method));},5000);
      debugPending.set(id,{resolve,reject,timer});debugSocket.send(JSON.stringify({id,method,params,sessionId}));
    });
    if(process.env.MD_EDITOR_BACKGROUND==='1'&&!process.env.MD_EDITOR_FOCUS_ONLY)await send('Emulation.setFocusEmulationEnabled',{enabled:true});
    // The outline assertions read live webview state, so webview (OOPIF)
    // contexts must always be attached, not only in focus-matrix runs.
    await send('Runtime.enable');await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
    const shortcut = async (letter,modifiers=10,withCode=true) => {
      await send('Page.bringToFront');
      const params={key:withCode?letter.toUpperCase():letter.toLowerCase(),code:withCode?'Key'+letter.toUpperCase():'',modifiers,windowsVirtualKeyCode:letter.toUpperCase().charCodeAt(0)};
      await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});
      await send('Input.dispatchKeyEvent',{type:'keyUp',...params,modifiers:0});
      await delay(350);
    };
    const escape=async()=>{
      const params={key:'Escape',code:'Escape',windowsVirtualKeyCode:27};
      await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});
      await send('Input.dispatchKeyEvent',{type:'keyUp',...params});await delay(150);
    };
    if(process.env.MD_EDITOR_NAV_ONLY){
      await require('./split-navigation-suite.cjs').run({request,send,document,file,until,pass,testRoot});
      assert.deepEqual(unhandled,[]);assert.deepEqual((await request('scriptHealth')).errors,[]);
      fs.writeFileSync(path.join(testRoot,'results.json'),JSON.stringify({vscode:vscode.version,host:vscode.env.appName,version:extension.packageJSON.version,results},null,2));return;
    }
    if(process.env.MD_EDITOR_CHAT_ONLY){
      await require(process.env.MD_EDITOR_FOCUS_ONLY?'./native-focus-matrix.cjs':'./native-chat-suite.cjs').run({vscode,request,shortcut,send,document,file,until,pass,testRoot,dispatches:nativeChatDispatches,providerInstance,debugContexts});
      if(process.env.MD_EDITOR_CHAT_HOLD_DIR){
        const manual=path.resolve(process.env.MD_EDITOR_CHAT_HOLD_DIR);fs.mkdirSync(manual,{recursive:true});
        await document.save();await request('nativeChat',{op:'mode',mode:'ir'});
        await send('Emulation.setFocusEmulationEnabled',{enabled:false});
        await send('Runtime.evaluate',{expression:"window.__manualKeys=[];window.addEventListener('keydown',event=>window.__manualKeys.push({key:event.key,code:event.code,alt:event.altKey,ctrl:event.ctrlKey,shift:event.shiftKey,prevented:event.defaultPrevented,target:event.target?.className}),true)"});
        const before=nativeChatDispatches.length,manualBaseline=document.getText();
        fs.writeFileSync(path.join(manual,'ready.json'),JSON.stringify({testRoot,file,extensionPath:extension.extensionPath,before,baseline:manualBaseline,debugPort:process.env.MD_EDITOR_SMOKE_DEBUG_PORT},null,2));
        console.log('MANUAL_READY '+manual);
        while(!fs.existsSync(path.join(manual,'done'))){
          const state=await request('nativeChat',{op:'read'});
          const workbench=(await send('Runtime.evaluate',{expression:'JSON.stringify(window.__manualKeys||[])',returnByValue:true})).result.value;
          fs.writeFileSync(path.join(manual,'manual-live.json'),JSON.stringify({state,workbench:JSON.parse(workbench),newCalls:nativeChatDispatches.slice(before)},null,2));
          await delay(250);
        }
        const received=(await send('Runtime.evaluate',{expression:'JSON.stringify(window.__nativeChatReceived||[])',returnByValue:true})).result.value;
        assert.ok(nativeChatDispatches.length>before,'Manual Alt+U reached the real native chat command');
        const newCalls=nativeChatDispatches.slice(before);assert.ok(newCalls.every(c=>c.finished&&!c.error));
        assert.equal(document.getText(),manualBaseline,'Manual Alt+U followed by AI draft typing must preserve Markdown');
        assert.equal(fs.readFileSync(file,'utf8'),manualBaseline,'Manual AI draft typing must preserve the saved file');
        fs.writeFileSync(path.join(manual,'native-receipts.json'),JSON.stringify({newCalls,received:JSON.parse(received),errors:(await request('scriptHealth')).errors},null,2));
      }
      assert.deepEqual(unhandled,[]);assert.deepEqual((await request('scriptHealth')).errors,[]);
      fs.writeFileSync(path.join(testRoot,'results.json'),JSON.stringify({vscode:vscode.version,host:vscode.env.appName,version:extension.packageJSON.version,results},null,2));
      fs.writeFileSync(path.join(testRoot,'webview-errors.json'),'[]\n');fs.writeFileSync(path.join(testRoot,'unhandled-errors.json'),'[]\n');return;
    }
    if (!process.env.MD_EDITOR_COMPLETION_ONLY) {
    await require('./math-table-suite.cjs').run({request,shortcut,send,document,file,until,pass,testRoot});
    await require('./split-navigation-suite.cjs').run({request,send,document,file,until,pass,testRoot});
    for(const mode of ['ir','wysiwyg','sv']) {
      await request('mode',{mode});
      for(const [letter,multiline,label] of [['E',false,'math'],['Q',true,'quote'],['K',false,'inline code'],['K',true,'code block']]) {
        await request('shortcutPrepare',{multiline});
        await shortcut(letter);
        state=await request('read');
        assert.ok(letter==='E' ? state.markdown.includes('$alpha$') : letter==='Q'
          ? /^> alpha beta/m.test(state.markdown)&&/^> second line/m.test(state.markdown)
          : state.markdown.includes(multiline?'```':'`alpha`'), mode+' native '+label+' failed: '+state.markdown);
        await until(()=>document.getText()===state.markdown);
        await document.save();assert.equal(fs.readFileSync(file,'utf8'),state.markdown);
        pass('Trusted Ctrl+Shift+'+letter+' applies '+label+' and saves in VSCode '+mode);
      }
    }
    await request('mode',{mode:'ir'});
    for(const mode of ['ir','wysiwyg','sv']) {
      await request('mode',{mode});await request('shortcutPrepare');await shortcut('U',2);state=await request('read');
      assert.ok(state.markdown.includes('<u>alpha</u> beta'));await until(()=>document.getText()===state.markdown);await document.save();
      pass('Trusted Ctrl+U underlines and saves in VSCode '+mode);
      await request('shortcutPrepare');await shortcut('H',2);state=await request('repairFind');
      assert.ok(state.markdown.includes('替换成功 beta'));await until(()=>document.getText()===state.markdown);await document.save();
      pass('Trusted Ctrl+H uses worker search and replacement in VSCode '+mode);
      for(const focus of ['panel','document']){
        await request('shortcutPrepare');await shortcut('F',2);await request('uiFind',{focus});await escape();state=await request('read');
        assert.equal(state.findOpen,false);if(focus==='document')assert.equal(state.caretRetained,true);
        pass('VSCode '+mode+' mode buttons preserve search and native Esc closes from '+focus);
      }
    }
    await request('mode',{mode:'ir'});await request('uiOutline');pass('VSCode outline fills below a stationary toolbar and resizes');
    // IDE sidebar outline (markpilot.outline): live parsing and interactive
    // reveal into the webview for both VS Code and Trae.
    {
      // until() only supports sync predicates; the outline flow needs awaits.
      const poll=async(predicate,label)=>{const end=Date.now()+60000;while(Date.now()<end){let ok=false;try{ok=await predicate()}catch{}if(ok)return;await delay(30);}throw new Error('Timed out: '+label);};
      const outlineSource='# 大纲顶部\n\n引言文字。\n\n## 第一节 甲\n\n正文一。\n\n```md\n# 围栏假标题\n```\n\n## 第二节 乙\n\n### 深层 小丙\n\n正文二。\n\n# 大纲尾部\n';
      const editOutline=new vscode.WorkspaceEdit();editOutline.replace(document.uri,new vscode.Range(0,0,document.lineCount,0),outlineSource);assert.equal(await vscode.workspace.applyEdit(editOutline),true);await document.save();
      await poll(async()=>((await request('read')).markdown??'').includes('大纲尾部'),'outline source reaches the webview');
      const outline=providerInstance.outline;
      assert.ok(outline,'Sidebar outline view is installed');
      await until(()=>outline.headings().length===5,'outline tree parses the saved headings');
      assert.deepEqual(outline.headings().map(h=>[h.level,h.text]),[[1,'大纲顶部'],[2,'第一节 甲'],[2,'第二节 乙'],[3,'深层 小丙'],[1,'大纲尾部']],'fenced # is not a heading');
      const inWebview=async expression=>{
        for(const context of debugContexts.values()){
          if(!context.auxData?.isDefault)continue;
          try{const result=await send('Runtime.evaluate',{contextId:context.id,expression,returnByValue:true},context.sessionId);
            if(result.result?.value!==undefined)return result.result.value;}catch{}
        }
        return undefined;
      };
      // Let the tree's 250ms refresh debounce settle, then reveal. Webview
      // message delivery right after a save can lag, so re-issue the command
      // with a fresh node (the view guards by node identity) until it lands.
      await delay(400);
      await vscode.commands.executeCommand('markpilot.outline.reveal',outline.headings()[3]);
      const inWebviewTagged=async expression=>{
        for(const context of debugContexts.values()){
          if(!context.auxData?.isDefault)continue;
          try{const result=await send('Runtime.evaluate',{contextId:context.id,expression:`(function(){try{const v=(${expression})();return {ctx:${context.id},origin:${JSON.stringify(context.origin)},now:Math.round(performance.now()),v}}catch(e){return {ctx:${context.id},err:String(e)}}})()`,returnByValue:true},context.sessionId);
            if(result.result?.value!==undefined&&!result.result.value.err)return result.result.value;}catch{}
        }
        return undefined;
      };
      let pollState;
      try{
        await poll(async()=>{pollState=await inWebviewTagged(`()=>{const e=vditor?.vditor;if(!e)throw new Error('no editor here');const m=window.__outlineReveal;if(!m)return null;const hs=[...e[e.currentMode].element.querySelectorAll('h1,h2,h3,h4,h5,h6')];const h=hs[3];const r=h?.getBoundingClientRect();const n=getSelection().focusNode;return{index:m.index,mode:m.mode,heading:(h?.textContent||'').replace(/^#+\\s*/,'').replace(/\\u200b/g,'').trim(),visible:!!(r&&r.bottom>0&&r.top<innerHeight),caretIn:(n?.nodeType===3?n.parentElement:n)?.closest('h1,h2,h3,h4,h5,h6')===h}}`);const s=pollState&&pollState.v;return !!(s&&s.index===3&&s.mode==='ir'&&s.heading==='深层 小丙'&&s.visible&&s.caretIn);},'outline reveal scrolls the webview to the heading and places the caret');
      }catch(error){
        revealDiag=await inWebviewTagged(`()=>{const m=window.__outlineReveal;const hs=[...vditor.vditor[vditor.vditor.currentMode].element.querySelectorAll('h1,h2,h3,h4,h5,h6')];const h=hs[3];const r=h?.getBoundingClientRect();const n=getSelection().focusNode;return{reveal:m,heads:hs.map(x=>x.textContent.trim()),caretIn:(n?.nodeType===3?n.parentElement:n)?.closest('h1,h2,h3,h4,h5,h6')===h,focusTag:document.activeElement?.tagName}}`);
        throw new Error(error.message+' poll='+JSON.stringify(pollState)+' state='+JSON.stringify(revealDiag));
      }
      pass('IDE sidebar outline parses live and reveal focuses the heading in the webview');
      // Honesty gate: the outline must render REAL rows in the workbench DOM.
      // Command-driven checks once passed while Trae never displayed the tree
      // (it does not render views contributed to 'explorer'; the view now
      // lives in its own activity-bar container).
      const inWorkbench=async expression=>{
        for(const context of debugContexts.values()){
          if(!context.auxData?.isDefault)continue;
          try{const result=await send('Runtime.evaluate',{contextId:context.id,expression:`(function(){try{const v=(${expression})();return v==null?null:{sessionId:${JSON.stringify(context.sessionId||null)},v}}catch(e){return null}})()`,returnByValue:true},context.sessionId);
            const value=result.result?.value;if(value&&value.v!==undefined)return value;}catch{}
        }
        return undefined;
      };
      await vscode.commands.executeCommand('markpilot.outline.focus');
      await poll(async()=>{const ui=await inWorkbench(`()=>{const wb=document.querySelector('.monaco-workbench');if(!wb)return null;const sb=wb.querySelector('.part.sidebar');if(!sb)return null;return{rows:[...sb.querySelectorAll('.monaco-list-row')].map(row=>((row.querySelector('.monaco-tl-contents')||row).textContent||'').trim())}}`);
        return !!(ui&&ui.v.rows.length>=5&&ui.v.rows.some(t=>t.includes('大纲顶部'))&&ui.v.rows.some(t=>t.includes('深层 小丙'))&&ui.v.rows.some(t=>t.includes('大纲尾部')));},'outline viewlet renders real heading rows in the workbench DOM');
      const rowTarget=await inWorkbench(`()=>{const sb=document.querySelector('.monaco-workbench .part.sidebar');if(!sb)return null;for(const row of sb.querySelectorAll('.monaco-list-row')){if((((row.querySelector('.monaco-tl-contents')||row).textContent)||'').includes('第一节 甲')){const q=row.getBoundingClientRect();if(q.width&&q.height)return{x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)}}}return null}`);
      assert.ok(rowTarget&&rowTarget.v,'outline row renders with clickable on-screen coordinates');
      // The reveal mark lives in the editor webview; after focusing the
      // outline viewlet extra default contexts may be attached, so the
      // baseline and the assertion scan every context instead of trusting
      // the first non-throwing one (a null from a bystander context once
      // masked the real value).
      const anyReveal=async()=>{const marks=[];for(const context of debugContexts.values()){
        if(!context.auxData?.isDefault)continue;
        try{const r=await send('Runtime.evaluate',{contextId:context.id,expression:`(function(){try{const e=vditor?.vditor;if(!e)return null;const m=window.__outlineReveal;return m?{index:m.index,at:m.at}:null}catch(err){return null}})()`,returnByValue:true},context.sessionId);
          if(r.result?.value)marks.push(r.result.value);}catch{}}
        return marks;};
      const baseline=Math.max(0,...(await anyReveal()).map(m=>m.at||0));
      const clickAt=(type,count=1)=>send('Input.dispatchMouseEvent',{type,x:rowTarget.v.x,y:rowTarget.v.y,button:'left',clickCount:count},rowTarget.sessionId||undefined);
      await clickAt('mouseMoved');
      await clickAt('mousePressed');await clickAt('mouseReleased');await clickAt('mousePressed',2);await clickAt('mouseReleased',2);
      let clickDiag;
      try{
      await poll(async()=>{const marks=await anyReveal();const row=await inWorkbench(`()=>{const sb=document.querySelector('.monaco-workbench .part.sidebar');if(!sb)return null;for(const r of sb.querySelectorAll('.monaco-list-row')){if((((r.querySelector('.monaco-tl-contents')||r).textContent)||'').includes('第一节 甲'))return{selected:r.getAttribute('aria-selected'),cls:(r.className||'').toString().slice(0,80)}}return null}`);clickDiag={marks,row:row&&row.v,at:rowTarget&&rowTarget.v,baseline};
        return marks.some(m=>m.index===1&&m.at>baseline);},'clicking the rendered outline row reveals the heading in the webview');
      }catch(error){throw new Error(error.message+' diag='+JSON.stringify(clickDiag));}
      pass('IDE outline tree renders real rows; a workbench DOM click reveals the heading');
      await request('mode',{mode:'sv'});await delay(500);
      fs.writeFileSync(path.join(testRoot,'sv-reveal-host.json'),JSON.stringify({headings:outline.headings().length,active:!!outline.active,first:outline.headings()[1]||null}));
      let svAttempts=0;
      try{
        await poll(async()=>{if(++svAttempts%10===0){try{await vscode.commands.executeCommand('markpilot.outline.reveal',outline.headings()[1]);}catch(cmdError){fs.writeFileSync(path.join(testRoot,'sv-reveal-cmd-error.json'),String(cmdError&&cmdError.stack||cmdError));}}
        let st;try{st=await request('outlineState');}catch(reqError){fs.writeFileSync(path.join(testRoot,'sv-reveal-req-error.json'),String(reqError&&reqError.stack||reqError));return false;}
        fs.writeFileSync(path.join(testRoot,'sv-reveal-state.json'),JSON.stringify(st));return !!(st&&st.reveal&&st.reveal.index===1&&st.reveal.mode==='sv'&&st.current==='sv'&&st.svFocus&&st.focusText&&st.focusText.includes('第一节 甲'));},'source-view outline reveal scrolls by line');
      }catch(error){const tagged=await inWebviewTagged(`()=>{const e=vditor?.vditor;if(!e)throw new Error('no editor here');const m=window.__outlineReveal;const s=e.sv.element;return{reveal:m,mode:e.currentMode,selStart:s.selectionStart,line:s.value.slice(0,s.selectionStart).split('\\n').length-1,active:document.activeElement?.tagName,inside:s.contains(document.activeElement)}}`);throw new Error(error.message+' sv='+JSON.stringify(tagged&&tagged.v));}
      pass('IDE sidebar outline reveal works in source view by source line');
      await request('mode',{mode:'ir'});
    }
    state=await request('repairImage');
    // Embedded semantics: the Webview edits through a short cache URL while
    // the native document (and the saved file) carry the full data URI.
    const imageURL=state.markdown.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1];
    assert.ok(imageURL,'image inserted with a compact URL');
    assert.ok(!state.markdown.includes('base64'),'editor text keeps image encodings out');
    await until(()=>document.getText().includes('data:image/svg+xml;base64,'));
    await document.save();
    const smokeDisk=fs.readFileSync(file,'utf8');
    assert.ok(smokeDisk.includes('data:image/svg+xml;base64,'),'VSIX embeds the uploaded image on save');
    assert.ok(!smokeDisk.includes(imageURL),'no internal cache URLs reach disk');
    pass('VSIX upload embeds the image as a data URI in the saved Markdown');
    // Offset mapping across the compact↔native boundary, plus the error path
    // for positions that fall inside an image encoding.
    const stored=providerInstance.documents.get(document);
    const compact=stored.text;
    const spans=stored.images.spans(compact);
    assert.equal(spans.length,1,'exactly the embedded image is masked');
    const after=stored.images.rawOffset(compact,spans[0].end);
    const native=document.getText();
    assert.equal(native.charAt(after),')','a caret right after the image URL maps right after the data URI');
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(native.slice(after-24,after)),'mapping lands at the end of the encoding');
    assert.throws(()=>stored.images.rawOffset(compact,spans[0].start+5),/图片编码内部映射/);
    pass('Compact-to-native offset mapping works and rejects positions inside image encodings');
    // Undo/redo across the embedded image keeps Webview and TextDocument in sync.
    state=await request('history',{inputType:'historyUndo'});
    await until(()=>!document.getText().includes('data:image/svg+xml'));
    state=await request('history',{inputType:'historyRedo'});
    await until(()=>document.getText().includes('data:image/svg+xml;base64,'));
    await document.save();
    assert.ok(fs.readFileSync(file,'utf8').includes('data:image/svg+xml;base64,'),'image survives undo/redo and save');
    pass('Undo and redo keep the embedded image consistent between Webview and TextDocument');
    const mediaBad=await request('mediaBad');
    assert.equal(mediaBad.error,'无效或过大的表格');
    pass('media-command channel returns structured errors without touching the clipboard');
    state=await request('repairTheme');assert.equal(state.theme,'konayuki-dark');await until(()=>providerInstance.state.get('editorTheme')==='konayuki-dark');
    pass('Konayuki selection persists in VSCode global state');
    await request('shortcutSettings');
    await until(()=>providerInstance.state.get('editorShortcuts')?.math==='Ctrl+Alt+M');
    pass('Shortcut settings persist in the VSCode extension global state');
    await request('shortcutPrepare');await shortcut('M',3);state=await request('read');
    assert.ok(state.markdown.includes('$alpha$'));
    await until(()=>document.getText()===state.markdown);await document.save();
    pass('Trusted custom Ctrl+Alt+M applies immediately');
    }
    if(process.env.MD_EDITOR_COMPLETION_ONLY)await request('completion-prepare',{text:'# Completion\n\nKeep $x+1$.\n',needle:'Completion'});
    state=await request('readingPalette');await until(()=>providerInstance.state.get('readingPalette')==='beige');
    const chosenTheme=state.theme;
    await until(()=>document.getText()===state.markdown);await document.save();
    const oldReady=readyCount;panel.dispose();await delay(200);await vscode.commands.executeCommand('vscode.openWith',uri,'markpilot.editor');await until(()=>readyCount>oldReady);
    state=await request('read');assert.equal(state.palette,'beige');assert.equal(state.theme,chosenTheme);
    pass('Independent reading palette persists through actual Webview disposal and reopen without editing Markdown');
    const completionSuite = extension.packageJSON.markpilotDistribution === 'public'
      ? require('./public-completion-suite.cjs')
      : require('./completion-suite.cjs');
    await completionSuite.run({vscode,request,send,until,delay,pass,document,providerInstance,testRoot,panel});
    // CRLF document round-trip with an embedded image: the native document
    // keeps \r\n while the Webview edits through the compact cache URL.
    const svgData='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="24"><rect width="36" height="24" fill="blue"/></svg>').toString('base64');
    const crlfFile=path.join(testRoot,'workspace','crlf.md');
    fs.writeFileSync(crlfFile,'# CRLF\r\n\r\nbody $x+1$\r\n\r\n![图]('+svgData+')\r\n');
    const crlfUri=vscode.Uri.file(crlfFile);
    const crlfDoc=await vscode.workspace.openTextDocument(crlfUri);
    const readyBefore=readyCount;
    await vscode.commands.executeCommand('vscode.openWith',crlfUri,'markpilot.editor');
    await until(()=>readyCount>readyBefore);
    state=await request('read');
    assert.ok(state.formulas>=1&&state.nativeEqual);
    assert.ok(!state.markdown.includes('base64'),'CRLF view keeps the image encoding out of editor text');
    assert.ok(crlfDoc.getText().includes('\r\n'),'CRLF endings preserved in the TextDocument');
    assert.ok(crlfDoc.getText().includes(svgData),'data URI preserved in the TextDocument');
    await request('input',{text:'标记'});
    await until(()=>crlfDoc.getText().includes('标记'));
    assert.equal(await crlfDoc.save(),true);
    const crlfDisk=fs.readFileSync(crlfFile,'utf8');
    assert.ok(crlfDisk.includes('标记')&&crlfDisk.includes('\r\n')&&crlfDisk.includes(svgData),'CRLF file keeps endings and the embedded image');
    pass('CRLF documents round-trip edits while keeping endings and embedded images');
    assert.deepEqual(unhandled,[],'The actual extension-host test emitted an unhandled rejection');
    const finalScripts=await request('scriptHealth');assert.deepEqual(finalScripts.errors,[],'The Webview emitted a JavaScript error or unhandled rejection');
    fs.writeFileSync(path.join(testRoot,'webview-errors.json'),JSON.stringify(finalScripts.errors,null,2));
    fs.writeFileSync(path.join(testRoot,'unhandled-errors.json'),'[]\n');
    fs.writeFileSync(path.join(testRoot, 'results.json'), JSON.stringify({
      vscode: vscode.version, extensionPath: extension.extensionPath,
      version: extension.packageJSON.version, results,
    }, null, 2));
  } finally {
    process.removeListener('unhandledRejection',onUnhandled);
    debugSocket?.close();
    prototype.resolveCustomTextEditor = original;
    for (const item of pending.values()) item.reject(new Error('Test finished'));
    pending.clear();
    panel?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};

if (require.main === module) {
  (async () => {
  // The focus matrix is a specialization of native-chat tests, not a full
  // editor run with focus emulation disabled.
  if(process.env.MD_EDITOR_FOCUS_ONLY)process.env.MD_EDITOR_CHAT_ONLY='1';
  const {spawn} = require('node:child_process');
  const code = process.argv[2] || 'D:\\Program Files\\Microsoft VS Code\\Code.exe';
  const extensionPath = path.resolve(process.argv[3] || path.join(__dirname, '../extension-src'));
  const testRoot = path.join(__dirname, '.runs', 'vscode-' + Date.now());
  const profile = process.env.MD_EDITOR_SMOKE_PROFILE ? path.resolve(process.env.MD_EDITOR_SMOKE_PROFILE) : path.join(testRoot, 'profile');
  if (process.env.MD_EDITOR_SMOKE_PROFILE) {
    // Reuse only a previous disposable test profile (e.g. Trae's completed
    // welcome screen), never the user's actual IDE profile or credentials.
    const relative = path.relative(fs.realpathSync(path.join(__dirname, '.runs')), fs.realpathSync(profile));
    if (!/^vscode-\d+[\\/]profile$/.test(relative)) throw new Error('Only an existing isolated smoke profile may be reused');
  }
  const workspace = path.join(testRoot, 'workspace');
  fs.mkdirSync(path.join(profile, 'User'), {recursive: true});
  fs.mkdirSync(workspace, {recursive: true});
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
    'files.autoSave': 'off', 'files.eol': '\n', 'window.restoreWindows': 'none',
  }));
  fs.writeFileSync(path.join(workspace, 'smoke.md'), '# VSCode smoke\n\n正文 $x+1$\n\n$$\n\\frac{a}{b}+\\Omega\n$$\n\n'+String.raw`> $$\begin{pmatrix}a&b\\c&d\end{pmatrix}$$, 后面正文 $z+1$`+'\n');
  const reservation = require('node:net').createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const debugPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const env = {...process.env, MD_EDITOR_SMOKE_ROOT: testRoot, MD_EDITOR_SMOKE_DEBUG_PORT:String(debugPort)};
  for(const name of Object.keys(env))if(/(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL)/i.test(name))delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(code, [
    '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port='+debugPort,
    '--user-data-dir', profile, '--extensions-dir', path.join(testRoot, 'extensions'),
    '--extensionDevelopmentPath=' + extensionPath, '--extensionTestsPath=' + __filename,
    workspace,
  ], {env, windowsHide: !process.env.MD_EDITOR_CHAT_HOLD_DIR, stdio: 'inherit'});
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    console.log('Isolated VSCode test output: ' + testRoot);
    process.exitCode = code ?? 1;
    if (!fs.existsSync(path.join(testRoot, 'results.json'))) process.exitCode = 1;
  });
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
