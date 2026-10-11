// Run the final portable EXE for visible manual QA with an isolated profile.
// The observer records exceptions; all editing is done in the visible window.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const guard=path.join(project,'.perf/release100-gui-active.json');
fs.mkdirSync(path.dirname(guard),{recursive:true});
if(fs.existsSync(guard)){
  const active=JSON.parse(fs.readFileSync(guard));let alive=true;
  try{process.kill(active.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  if(alive)throw Error('Another GUI task is active: '+active.task+' (PID '+active.pid+')');
  fs.unlinkSync(guard);
}
fs.writeFileSync(guard,JSON.stringify({task:'manual-portable',pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});
process.on('exit',()=>{try{if(JSON.parse(fs.readFileSync(guard)).pid===process.pid)fs.unlinkSync(guard);}catch{}});
const applicationSource=process.argv[4]?path.resolve(process.argv[4]):null;
const output=path.join(project,'.perf',(applicationSource?'release100-manual-source-':process.argv[2]?'release100-manual-exe-':'viewflow-manual-exe-')+Date.now());
const executable=path.resolve(process.argv[2]||path.join(project,'dist/release-1.0.18-private-final/markpilot-v1.0.18-portable.exe'));
const profile=path.join(output,'profile'),file=path.join(output,'人工复核-分屏与公式.md');
fs.mkdirSync(profile,{recursive:true});
fs.writeFileSync(path.join(profile,'state.json'),'{}');
const inputFile=path.resolve(process.argv[3]||path.join(project,'.backups/2026-09-08-viewflow/user-note-latest.md'));
const hash=source=>crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const inputSHA256=hash(inputFile);fs.copyFileSync(inputFile,file);
const reserve=port=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
await reserve(48190);const port=await reserve(0);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(name))delete env[name];
const log=fs.openSync(path.join(output,'process.log'),'a');
const child=spawn(executable,[...(applicationSource?[applicationSource]:[]),file,'--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--enable-logging=file','--log-file='+path.join(output,'chromium.log')],{env,windowsHide:false,stdio:['ignore',log,log]});
const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
const errors=[],resourceErrors=[],meta={executable,executableSHA256:hash(executable),inputFile,inputSHA256,output,profile,file,port,launcherPid:process.pid,pid:child.pid,started:new Date().toISOString()};
if(applicationSource){
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
  meta.applicationSource=applicationSource;
  meta.sourceFiles=walk(path.join(applicationSource,'app')).sort().map(file=>({path:path.relative(applicationSource,file),sha256:hash(file)}));
}
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
  const firstLine=fs.readFileSync(file,'utf8').trimStart().split(/\r?\n/)[0];let baseline;
  for(let i=0;i<300;i++){
    baseline=(await command('Runtime.evaluate',{expression:'document.getElementById("editor").contentWindow.vditor.getValue()',returnByValue:true})).result?.value;
    if(typeof baseline==='string'&&baseline.includes(firstLine))break;
    await new Promise(r=>setTimeout(r,50));
  }
  if(typeof baseline!=='string'||!baseline.includes(firstLine))throw new Error('Portable did not receive the input document');
  fs.writeFileSync(path.join(output,'baseline-editor.md'),baseline);
  meta.baselineEditorSHA256=crypto.createHash('sha256').update(baseline).digest('hex');
  fs.writeFileSync(path.join(output,'observer.json'),JSON.stringify(meta,null,2));
  console.log('READY: perform Computer Use actions in 人工复核-分屏与公式.md; close that window to finish.');
  const code=await exited;meta.exitCode=code;
  if(code!==0)throw new Error('Portable EXE exit code '+code);
}finally{
  socket?.close();meta.finished=new Date().toISOString();meta.runtimeErrorCount=errors.length;
  meta.inputUnchanged=hash(inputFile)===inputSHA256;meta.editedFileSHA256=hash(file);
  fs.writeFileSync(path.join(output,'observer.json'),JSON.stringify(meta,null,2));
  fs.writeFileSync(path.join(output,'runtime-errors.json'),JSON.stringify(errors,null,2));fs.writeFileSync(path.join(output,'resource-errors.json'),JSON.stringify(resourceErrors,null,2));fs.closeSync(log);
}
if(errors.length)throw new Error(errors.length+' runtime error(s) captured in the final portable EXE');
if(!meta.inputUnchanged)throw new Error('Manual input fixture was modified outside its disposable copy');
