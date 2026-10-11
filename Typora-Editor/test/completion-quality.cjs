'use strict';
// Opt-in real-provider quality test. Reads the extension's existing settings
// and SecretStorage in its ordinary IDE profile; never exports credentials,
// modifies settings, or writes to the source document. All edits target a copy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function probe() {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ready = async predicate => {const end=Date.now()+45000;while(!predicate()){if(Date.now()>end)throw new Error('Editor context timed out');await pause(40);}};
  window.addEventListener('message', async event => {
    if(event.data.type !== '__qualityRequest')return;
    const {id,action,...data}=event.data.content;
    try {
      await ready(()=>window.vditor?.__completion);
      const api=window.vditor,editor=api.vditor,root=()=>editor[editor.currentMode].element;
      const modules=await import(editor.options.extPath+'/js/completion-context.js');
      const policy=await import(editor.options.extPath+'/js/completion-policy.mjs');
      let result;
      if(action==='prepare') {
        api.__completion.externalChange();api.setValue(data.text,true);await pause(600);
        const find=()=>{const walker=document.createTreeWalker(root(),NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode())if(!n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')&&n.data.includes(data.marker))return n;throw new Error('Missing test insertion marker');};
        let node=find();
        const preview=node.parentElement.closest('.vditor-ir__node,.vditor-wysiwyg__block')?.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');
        if(preview){preview.scrollIntoView({block:'center'});preview.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));await pause(100);}
        node=find();root().focus();
        const range=document.createRange(),offset=node.data.indexOf(data.marker);
        range.setStart(node,offset);range.setEnd(node,offset+data.marker.length);getSelection().removeAllRanges();getSelection().addRange(range);
        document.execCommand('insertText',false,'');await pause(400);
        api.__completion.dismiss();window.__qualityOriginal=api.getValue();
        api.__completion.changed(window.__qualityOriginal);
        const start=performance.now(),context=modules.enrichContext(api,modules.captureContext(api));
        result={payload:policy.completionPayload(context),contextMs:performance.now()-start,markdown:window.__qualityOriginal,mode:editor.currentMode};
      } else if(action==='request') {
        root().focus();api.__completion.request(true,true);result=true;
      } else if(action==='read') {
        const preview=document.querySelector('.md-completion-preview');
        const ghost=preview?.querySelector('.md-completion-ghost');
        result={visible:!!preview&&!preview.hidden,completion:!!preview?.querySelector('small'),ghost:ghost?.textContent||'',status:preview?.textContent||'',focus:document.hasFocus()};
      } else if(action==='accept') {
        root().dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',bubbles:true,cancelable:true}));await pause(250);
        const changed=api.getValue();
        root().dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true,cancelable:true}));await pause(250);
        result={changed:changed!==window.__qualityOriginal,undoExact:api.getValue()===window.__qualityOriginal};
      } else if(action==='dismiss') {api.__completion.dismiss();result=true;}
      window.handler.emit('__qualityResponse',{id,result});
    } catch(error) {window.handler.emit('__qualityResponse',{id,error:String(error.message)});}
  });
  ready(()=>window.handler&&window.vditor?.__completion).then(()=>window.handler.emit('__qualityReady'));
}

exports.run=async()=>{
  const vscode=require('vscode');
  const testRoot=process.env.MD_EDITOR_QUALITY_ROOT;
  assert.ok(testRoot && fs.existsSync(path.join(testRoot,'cases.json')),'Use the quality launcher');
  const extension=vscode.extensions.getExtension('markpilot.markpilot');await extension.activate();
  const providerPath=path.join(extension.extensionPath,'out/provider/markdownEditorProvider.js').toLowerCase();
  const provider=Object.values(require.cache).find(module=>module.filename?.toLowerCase()===providerPath).exports;
  const prototype=provider.MarkdownEditorProvider.prototype,original=prototype.resolveCustomTextEditor;
  const pending=new Map();let panel,manager,config,id=0,activeCase=null,debugSocket,resolveReady;
  const webviewReady=new Promise(resolve=>{resolveReady=resolve;});
  const results={version:extension.packageJSON.version,source:JSON.parse(fs.readFileSync(path.join(testRoot,'source-info.json'),'utf8')),cases:[]};
  const save=()=>fs.writeFileSync(path.join(testRoot,'results.json'),JSON.stringify(results,null,2));
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const request=(action,fields={})=>new Promise((resolve,reject)=>{
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Webview timeout '+action));},55000);
    pending.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    panel.webview.postMessage({type:'__qualityRequest',content:{id:requestId,action,...fields}});
  });
  prototype.resolveCustomTextEditor=function(document,webviewPanel,token){
    manager=this.completions;config=manager.config;
    if(process.env.MD_EDITOR_QUALITY_MODEL==='deepseek-v4-flash-vision-exp') {
      config={...config,protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-v4-flash-vision-exp'};
    }
    // Per-instance, in-memory test setting. The user's persisted preferences
    // and saved key are read only, and incidental cursor events make no calls.
    Object.defineProperty(manager,'config',{configurable:true,get:()=>({...config,automaticAI:false,host:false})});
    panel=webviewPanel;
    panel.webview.onDidReceiveMessage(message=>{if(message.type==='__qualityReady'){resolveReady();return;}if(message.type!=='__qualityResponse')return;const item=pending.get(message.content.id);if(!item)return;pending.delete(message.content.id);message.content.error?item.reject(new Error(message.content.error)):item.resolve(message.content.result);});
    const value=original.call(this,document,webviewPanel,token);
    panel.webview.html=panel.webview.html.replace('</html>','<script>('+probe.toString()+')();</script></html>');
    return value;
  };
  const originalFetch=globalThis.fetch;
  try {
    const uri=vscode.Uri.file(path.join(testRoot,'workspace','quality-copy.md'));
    const document=await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand('vscode.openWith',uri,'markpilot.editor');
    assert.ok(manager&&panel);
    const credential=await (manager.getAPIKey ? manager.getAPIKey() : manager.context.secrets.get('completion.apiKey'));
    const credentialAvailable=!!credential;
    results.provider={protocol:config.protocol,baseUrl:config.baseUrl,model:config.model,enabled:config.ai,credentialAvailable};save();
    assert.ok(config.ai&&credentialAvailable,'The plugin needs an enabled API and saved key');
    const endpoint=require(path.join(extension.extensionPath,'out/completion/core.cjs')).endpoint(config.baseUrl,config.protocol);
    globalThis.fetch=async(input,init)=>{
      if(String(input)!==endpoint)return originalFetch(input,init);
      if(process.env.MD_EDITOR_QUALITY_VARIANT==='no-reasoning'){
        init={...init,body:JSON.stringify({...JSON.parse(init.body),reasoning_effort:'none'})};
        results.variant='GLM reasoning_effort=none, same endpoint/model';
      }
      if(process.env.MD_EDITOR_QUALITY_VARIANT==='literal-gap'){
        init={...init,body:JSON.stringify(require('./completion-request-variants.cjs').literalGap(JSON.parse(init.body)))};
        results.variant='Literal source with explicit math/prose insertion site; same document fields, model and output controls';
      }
      const row=activeCase,start=Date.now();
      if(row){row.apiCalls=(row.apiCalls||0)+1;row.requestBody=JSON.parse(init.body);}
      try {
        const response=await originalFetch(input,init);
        const body=await response.clone().json().catch(()=>null);
        if(row){row.apiMs=Date.now()-start;row.httpStatus=response.status;row.responseModel=body?.model;row.usage=body?.usage||null;row.stopReason=body?.stop_reason||body?.choices?.[0]?.finish_reason||null;row.contentBlocks=body?.content?.map(b=>({type:b.type,characters:(b.text||b.thinking||'').length}));row.rawSuggestion=Array.isArray(body?.content)?body.content.filter(b=>b.type==='text').map(b=>b.text).join(''):body?.choices?.[0]?.message?.content;}
        return response;
      }catch(error){if(row){row.apiMs=Date.now()-start;row.networkError=error.name;}throw error;}
    };
    const targets=await(await originalFetch('http://127.0.0.1:'+process.env.MD_EDITOR_QUALITY_PORT+'/json/list')).json();
    const page=targets.find(t=>t.type==='page'&&t.url.includes('workbench'));assert.ok(page);
    debugSocket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{debugSocket.addEventListener('open',resolve,{once:true});debugSocket.addEventListener('error',reject,{once:true});});
    let debugId=0;const debugPending=new Map();debugSocket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=debugPending.get(m.id);if(p){debugPending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++debugId,timer=setTimeout(()=>{debugPending.delete(id);reject(new Error('CDP timeout'));},8000);debugPending.set(id,{resolve,reject,timer});debugSocket.send(JSON.stringify({id,method,params}));});
    let readyTimer;try{await Promise.race([webviewReady,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error('Editor did not initialize')),60000);})]);}finally{clearTimeout(readyTimer);}
    const source=fs.readFileSync(path.join(testRoot,'original-copy.md'),'utf8');
    const selected=process.env.MD_EDITOR_QUALITY_CASES?.split(',');
    const replay=process.env.MD_EDITOR_QUALITY_REPLAY ? JSON.parse(fs.readFileSync(process.env.MD_EDITOR_QUALITY_REPLAY,'utf8')) : null;
    const cases=(replay?.cases||JSON.parse(fs.readFileSync(path.join(testRoot,'cases.json'),'utf8'))).filter(item=>!selected||selected.includes(item.id));
    const katex=require(path.join(extension.extensionPath,'render/cdn/vditor/dist/js/katex/katex.min.js'));
    for(const item of cases){
      const row=replay ? {id:item.id,label:item.label,line:item.line,kind:item.kind,start:item.start,expected:item.expected,group:item.group,payload:item.payload,trial:1,replay:true} : {...item,trial:1};results.cases.push(row);activeCase=row;
      try {
        if(replay){
          row.suggestion=await require(path.join(extension.extensionPath,'out/completion/core.cjs')).requestAI(config,credential,row.payload,AbortSignal.timeout(15000));
          if(row.kind==='math'&&row.suggestion){row.completedMath=row.payload.mathBefore+row.suggestion+row.payload.mathAfter;try{katex.renderToString(row.completedMath,{displayMode:true,throwOnError:true,strict:'ignore'});row.katexValid=true;}catch(error){row.katexValid=false;row.katexError=error.message.slice(0,350);}}
        }else{
        assert.equal(source.slice(item.start,item.start+item.expected.length),item.expected);
        const marker='MDQUALITY'+item.id.replace(/\W/g,'')+'CURSOR';
        const fixture=source.slice(0,item.start)+marker+source.slice(item.start+item.expected.length);
        await send('Page.bringToFront');const prepared=await request('prepare',{text:fixture,marker});
        const end=Date.now()+15000;while(document.getText()!==prepared.markdown&&Date.now()<end)await pause(40);
        await pause(600);
        row.payload=prepared.payload;row.contextMs=prepared.contextMs;row.mode=prepared.mode;
        assert.equal(row.payload.kind,item.kind,'Editing context kind');
        await send('Page.bringToFront');const started=Date.now();await request('request');
        let state;const until=Date.now()+16500;
        do {state=await request('read');if(state.visible&&state.completion&&state.ghost)break;if(row.httpStatus>=400||row.networkError||row.httpStatus===200&&row.rawSuggestion==='')break;await pause(60);}while(Date.now()<until);
        row.visibleMs=Date.now()-started;row.suggestion=state.completion?state.ghost:'';row.displayed=state.visible&&state.completion&&!!state.ghost;
        row.status=state.status;
        if(row.displayed){
          if(item.kind==='math'){
            row.completedMath=row.payload.mathBefore+row.suggestion+row.payload.mathAfter;
            try{katex.renderToString(row.completedMath,{displayMode:true,throwOnError:true,strict:'ignore'});row.katexValid=true;}catch(error){row.katexValid=false;row.katexError=error.message.slice(0,350);}
          }
          row.edit=await request('accept');
        }else await request('dismiss');
        }
      }catch(error){row.testError=error.message;}
      save();console.log('QUALITY '+row.id+' '+(row.displayed?'suggested':'no suggestion')+' '+(row.apiMs||0)+' ms');
      // Authentication/service failures are shared by every sample; one failed
      // call is enough evidence and must not be repeated across the textbook.
      if(row.httpStatus>=400){results.stoppedEarly='provider_http_'+row.httpStatus;break;}
    }
    // Repeated draws bypass the local result cache deliberately. They reuse the
    // exact captured contexts and production requestAI, while the credential
    // remains inside the extension host's memory. No additional UI edits.
    const repeatedIds=process.env.MD_EDITOR_QUALITY_REPEAT_CASES?.split(',')||[];
    const repeatCount=Math.max(1,Math.min(3,Number(process.env.MD_EDITOR_QUALITY_REPEAT_COUNT)||1));
    results.repeats=[];
    if(!results.stoppedEarly)for(let trial=2;trial<=repeatCount;trial++)for(const sample of results.cases.filter(row=>repeatedIds.includes(row.id)&&row.payload&&row.requestBody)){
      const row={id:sample.id,label:sample.label,line:sample.line,kind:sample.kind,group:sample.group,expected:sample.expected,payload:sample.payload,trial};
      results.repeats.push(row);activeCase=row;
      try{
        row.suggestion=await require(path.join(extension.extensionPath,'out/completion/core.cjs')).requestAI(config,credential,row.payload,AbortSignal.timeout(15000));
        assert.deepEqual(row.requestBody,sample.requestBody,'Repeated draws must use the identical request');
        if(row.kind==='math'&&row.suggestion){row.completedMath=row.payload.mathBefore+row.suggestion+row.payload.mathAfter;try{katex.renderToString(row.completedMath,{displayMode:true,throwOnError:true,strict:'ignore'});row.katexValid=true;}catch(error){row.katexValid=false;row.katexError=error.message.slice(0,350);}}
      }catch(error){row.testError=error.name;}
      save();console.log('QUALITY REPEAT '+row.id+' trial '+trial+' '+(row.apiMs||0)+' ms');
      if(row.httpStatus>=400){results.stoppedEarly='provider_http_'+row.httpStatus;break;}
    }
    save();
  }catch(error){results.error=error.message;save();throw error;}
  finally{
    globalThis.fetch=originalFetch;prototype.resolveCustomTextEditor=original;if(manager)delete manager.config;debugSocket?.close();
    const copyPath=path.join(testRoot,'workspace','quality-copy.md').toLowerCase();
    for(const document of vscode.workspace.textDocuments)if(document.uri.fsPath.toLowerCase()===copyPath&&document.isDirty)await document.save();
    panel?.dispose();
  }
};

if(require.main===module){
  (async()=>{
    const {spawn}=require('node:child_process');
    const testRoot=path.resolve(process.argv[2]);
    const info=JSON.parse(fs.readFileSync(path.join(testRoot,'source-info.json'),'utf8'));
    const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(info.path)).digest('hex');
    assert.equal(hash(),info.sha256);
    const listener=require('node:net').createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const env={...process.env,MD_EDITOR_QUALITY_ROOT:testRoot,MD_EDITOR_QUALITY_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
    // The ordinary profile supplies its own saved credential. Do not inherit
    // unrelated process credentials into a GUI host that logs startup env.
    for(const name of Object.keys(env))if(/(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL)/i.test(name))delete env[name];
    // --extensionTestsPath intentionally uses isolated storage in the host,
    // so it cannot see the user's API settings. A temporary development copy
    // uses normal extension activation and ordinary SecretStorage instead.
    const development=path.join(testRoot,'development-extension');fs.cpSync(path.resolve('extension-src'),development,{recursive:true});
    const manifestPath=path.join(development,'package.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));manifest.activationEvents=['*'];fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
    const driver='\nconst qualityActivate=exports.activate;exports.activate=function(context){const value=qualityActivate(context);setTimeout(async()=>{try{await require('+JSON.stringify(__filename)+').run();}catch(error){console.error("Quality test: "+error.message);}finally{require("node:fs").writeFileSync('+JSON.stringify(path.join(testRoot,'done.json'))+',JSON.stringify({done:true}));await require("vscode").commands.executeCommand("workbench.action.closeWindow");}},500);return value;};\n';
    fs.appendFileSync(path.join(development,'out/extension.js'),driver);
    const child=spawn('C:\\Users\\Ming\\AppData\\Local\\Programs\\Trae\\Trae.exe',['--new-window','--skip-welcome','--skip-release-notes','--skip-add-to-recently-opened','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--extensionDevelopmentPath='+development,path.join(testRoot,'workspace')],{env,windowsHide:true,stdio:'inherit'});
    child.on('exit',code=>{assert.equal(hash(),info.sha256,'Original textbook must be unchanged');console.log('Quality results: '+testRoot);process.exitCode=code??1;});
    child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
