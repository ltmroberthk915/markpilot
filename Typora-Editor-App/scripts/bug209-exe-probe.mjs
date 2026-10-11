// v2.0.9：用打包 EXE + 用户 profile 副本复现"打开 1-重识概率论.md 连工具栏都没有"。
// CDP 探针 + 定时截图 + 控制台错误捕获。只读原文件（autosave 风险：副本 profile
// 的 state 已指向原文件——若触发保存会写原文件！先以只读属性锁住原文件再跑）。
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const useDev=process.env.PROBE_DEV==='1';
const exe=useDev?path.join(project,'node_modules/electron/dist/electron.exe'):path.join(project,'dist/win-unpacked/MarkPilot.exe');
const profile=path.join(project,process.env.PROBE_DEV==='1'?'.perf/bug209-exe/profile2':'.perf/bug209-exe/profile');
const output=path.join(project,process.env.PROBE_DEV==='1'?'.perf/bug209-exe/out-dev':'.perf/bug209-exe/out');
fs.mkdirSync(output,{recursive:true});
const target=process.argv[2]||'C:\\Users\\Ming\\Desktop\\实用经济与金融理论\\1-重识概率论.md';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const errlog=fs.openSync(path.join(output,'stderr.log'),'a');
const flags=['--user-data-dir='+profile,'--remote-debugging-port=9333','--no-sandbox','--enable-logging=stderr','--v=0'];
const args=useDev?[...flags,path.join(project,'app/main/main.js')]:[...flags,target];
const child=spawn(exe,args,{env,windowsHide:true,stdio:['ignore',errlog,errlog]});
child.unref();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const get=json=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:9333,path:json},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));}).on('error',reject);});
async function main(){
  let targets=null;
  for(let i=0;i<100&&!targets;i++){await pause(300);try{targets=await get('/json/list');}catch{}}
  if(!targets)throw new Error('no CDP targets');
  // 取第一个 page 类型（主窗口）
  const page=targets.find(t=>t.type==='page');
  if(!page)throw new Error('no page target: '+JSON.stringify(targets.map(t=>t.type)));
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq=0;const pending=new Map();const consoleErrors=[];
  ws.onmessage=event=>{const m=JSON.parse(event.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return;}
    if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))consoleErrors.push(m.params.args.map(a=>a.value||a.description||'').join(' ').slice(0,300));
    if(m.method==='Runtime.exceptionThrown')consoleErrors.push('EXC:'+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text||'').slice(0,400));
  };
  const send=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable').catch(()=>{});
  const evalJs=async(code)=>{const r=await send('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true});
    if(r?.exceptionDetails)return 'EXC:'+(r.exceptionDetails.exception?.description||r.exceptionDetails.text||JSON.stringify(r.exceptionDetails)).slice(0,600);
    return r?.result?.value??null;};
  const log=(k,v)=>console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));
  // 直接驱动 boot / open-file：定位 IPC 层断点
  const bootProbe=await evalJs(`hostApi ? hostApi.invoke('boot').then(v=>'boot-ok:'+JSON.stringify({ws:v.ws,file:v.file})).catch(e=>'boot-err:'+(e&&e.message||e)) : 'NO-hostApi'`);
  log('direct-boot',bootProbe);
  const openProbe=await evalJs(`hostApi.invoke('open-file',{path:${JSON.stringify(target)}}).then(v=>'open-ok:'+JSON.stringify(v)).catch(e=>'open-err:'+(e&&e.message||e))`);
  log('direct-open-file',openProbe);

  for(let i=0;i<15;i++){
    const st=await evalJs(`(()=>{const f=document.getElementById('editor');const w=f&&f.contentWindow;let inner=null;try{inner={hasVditor:!!w.vditor,lute:!!(w.vditor&&w.vditor.vditor&&w.vditor.vditor.lute),patched:!!(w.vditor&&w.vditor.vditor&&w.vditor.vditor.__typoraPatched),valueLen:w.vditor?w.vditor.getValue().length:-1,toolbar:!!(w.document&&w.document.querySelector('.vditor-toolbar')),toolbarW:w.document&&w.document.querySelector('.vditor-toolbar')?w.document.querySelector('.vditor-toolbar').getBoundingClientRect().width:0,h1:w.document?w.document.querySelectorAll('.vditor-reset h1').length:-1,theme:w.document?w.document.documentElement.dataset.editorTheme:null}}catch(e){inner='iframe-eval-err:'+e.message}
      return JSON.stringify({ready:document.readyState,welcome:getComputedStyle(document.getElementById('welcome')).display,iframeSrc:f?f.getAttribute('src'):null,iframeShown:f?f.style.display:'?',title:document.title,inner})})()`);
    log('probe-'+i,st);
    try{const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,`exe-${i}.png`),Buffer.from(shot.data,'base64'));}catch(e){log('shot-fail',String(e));}
    const parsed=(()=>{try{return typeof st==='string'?JSON.parse(st):null}catch{return null}})();
    if(parsed&&parsed.inner&&parsed.inner.patched&&parsed.inner.valueLen>1000){log('VERDICT','rendered ok — cannot reproduce user blank');break;}
    if(i>=6&&parsed&&parsed.inner&&parsed.inner.valueLen===-0){log('VERDICT','iframe dead after 12s');break;}
    await pause(2000);
  }
  log('console-errors',consoleErrors.slice(0,10));
  try{await send('Browser.close');}catch{}
  setTimeout(()=>process.exit(0),800);
}
main().catch(e=>{console.error(e);try{child.kill();}catch{} process.exit(1);});
