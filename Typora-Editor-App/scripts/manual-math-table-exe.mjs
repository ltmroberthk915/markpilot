// Run the final portable EXE for visible manual QA with an isolated profile.
// The observer records exceptions; all editing is done in the visible window.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(project,'.perf','math-table-manual-exe-'+Date.now());
const executable=path.join(project,'dist/release-1.0.16-private-final/markpilot-v1.0.17-portable.exe');
const profile=path.join(output,'profile'),file=path.join(output,'人工复核-概率论副本.md');
fs.mkdirSync(profile,{recursive:true});
fs.copyFileSync(path.join(project,'.backups/2026-09-08-math-table/user-note-original.md'),file);
const reserve=port=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
await reserve(48190);const port=await reserve(0);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(name))delete env[name];
const log=fs.openSync(path.join(output,'process.log'),'a');
const child=spawn(executable,[file,'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--enable-logging=file','--log-file='+path.join(output,'chromium.log')],{env,windowsHide:true,stdio:['ignore',log,log]});
const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
const errors=[],resourceErrors=[],meta={executable,output,profile,file,port,pid:child.pid,started:new Date().toISOString()};
fs.writeFileSync(path.join(output,'observer.json'),JSON.stringify(meta,null,2));
console.log('Manual EXE observation: '+output);
let socket;
try{
  const deadline=Date.now()+45000;let page;
  while(Date.now()<deadline&&!page){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page'&&/\/shell$/.test(p.url));}catch{}if(!page)await new Promise(r=>setTimeout(r,100));}
  if(!page)throw new Error('The portable EXE did not open its isolated window');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let next=0;const pending=new Map();
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  socket.onmessage=event=>{
    const msg=JSON.parse(event.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}
    if(msg.method==='Log.entryAdded'&&msg.params.entry.level==='error'&&msg.params.entry.source==='network'){resourceErrors.push(msg);fs.writeFileSync(path.join(output,'resource-errors.json'),JSON.stringify(resourceErrors,null,2));}
    else if(msg.method==='Runtime.exceptionThrown'||msg.method==='Runtime.consoleAPICalled'&&msg.params.type==='error'||msg.method==='Log.entryAdded'&&msg.params.entry.level==='error'){errors.push(msg);fs.writeFileSync(path.join(output,'runtime-errors.json'),JSON.stringify(errors,null,2));}
  };
  // Enabling Runtime on an uncommitted blank Electron frame forces a premature
  // isolated-world bootstrap. Observe the real committed document instead.
  // Native Chromium logging above still covers the entire startup interval.
  let ready=false;
  for(let i=0;i<300&&!ready;i++){
    const tree=await command('Page.getFrameTree');
    if(tree.frameTree.childFrames?.some(f=>new URL(f.frame.url).pathname.startsWith('/doc/'))){
      ready=(await command('Runtime.evaluate',{expression:'!!document.getElementById("editor")?.contentWindow?.vditor?.vditor?.__typoraPatched',returnByValue:true})).result?.value===true;
    }
    if(!ready)await new Promise(r=>setTimeout(r,50));
  }
  if(!ready)throw new Error('Portable editor did not initialize');
  await command('Runtime.enable');await command('Log.enable');
  console.log('READY: perform Computer Use actions in 人工复核-概率论副本.md; close that window to finish.');
  const code=await exited;meta.exitCode=code;
  if(code!==0)throw new Error('Portable EXE exit code '+code);
}finally{
  socket?.close();meta.finished=new Date().toISOString();meta.runtimeErrorCount=errors.length;
  fs.writeFileSync(path.join(output,'observer.json'),JSON.stringify(meta,null,2));
  fs.writeFileSync(path.join(output,'runtime-errors.json'),JSON.stringify(errors,null,2));fs.writeFileSync(path.join(output,'resource-errors.json'),JSON.stringify(resourceErrors,null,2));fs.closeSync(log);
}
if(errors.length)throw new Error(errors.length+' runtime error(s) captured in the final portable EXE');
