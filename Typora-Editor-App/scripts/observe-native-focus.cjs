const fs=require('node:fs');
(async()=>{
 const ready=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const targets=await(await fetch('http://127.0.0.1:'+ready.debugPort+'/json')).json();
 const ws=new WebSocket(targets.find(t=>t.type==='page'&&t.url.includes('/workbench/workbench.html')).webSocketDebuggerUrl);
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));let next=0;const pending=new Map();
 ws.addEventListener('message',raw=>{const x=JSON.parse(raw.data);if(x.id){pending.get(x.id)?.(x);pending.delete(x.id);}});
 const send=(method,params={})=>new Promise(r=>{const id=++next;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
 if(process.argv[3]==='install')await send('Runtime.evaluate',{expression:`window.__focusTrace=[];for(const type of ['focusin','focusout','icube.ai-chat.focusInput'])document.addEventListener(type,e=>window.__focusTrace.push({type,tag:e.target?.tagName,cls:e.target?.className}),true);true`});
 const result=await send('Runtime.evaluate',{expression:`({trace:window.__focusTrace,active:{tag:document.activeElement?.tagName,cls:document.activeElement?.className,editable:!!(document.activeElement?.isContentEditable||document.activeElement?.editContext),text:document.activeElement?.editContext?.text??document.activeElement?.value??document.activeElement?.textContent?.slice(0,240)},input:[...document.querySelectorAll('[contenteditable="true"],.native-edit-context')].map(n=>({cls:n.className,text:(n.editContext?.text??n.textContent).slice(-360)}))})`,returnByValue:true});
 console.log(JSON.stringify(result.result?.result?.value));ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
