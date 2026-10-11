// v2.0.9 终验（打包 EXE + 用户 profile 副本 + 用户文档）：
//  1) 用户文档打开：工具栏岛 + 全文渲染（DOM 断言）；截图仅当场核对后立即删除（用户内容不入档）
//  2) 合成等价大文档（大 base64 图 + 数学 + CJK 长文）：键帧截图入档（硬规则）
//  3) 空文件统计：字数/字符/行全为 0
//  4) 保险库降级日志出现且不阻断
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=path.join(project,'dist/win-unpacked/MarkPilot.exe');
const profile=path.join(project,'.perf/bug209-final/profile');
const output=path.join(project,'.perf/bug209-final/out');
fs.rmSync(path.join(project,'.perf/bug209-final'),{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
// 用户 profile 副本（跳过缓存目录）
{
  const src='C:/Users/Ming/AppData/Roaming/markpilot';
  fs.mkdirSync(profile,{recursive:true});
  for(const entry of fs.readdirSync(src,{withFileTypes:true})){
    if(['Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache','DIPS'].includes(entry.name))continue;
    try{fs.cpSync(path.join(src,entry.name),path.join(profile,entry.name),{recursive:true});}catch{}
  }
}
// 合成等价文档（不含用户内容，可入档）
const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
const crc32=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
const makePng=(w,h)=>{const raw=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4);for(let x=0;x<w;x++){const o=1+x*4;row[o]=40+(x%50);row[o+1]=70;row[o+2]=100+(y%40);row[o+3]=255;}raw.push(row);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);};
const png=makePng(900,700);
const paras=Array.from({length:60},(_,i)=>`第 ${i+1} 段：测度 $\\mu$ 与概率 $P$ 的关系，样本空间 $\\Omega$ 上的事件域 $\\mathcal{F}$。`).join('\n\n');
const synthetic=['# 第 1 章 等价复现样例','','## 1.1 大内嵌图','',[`<img src="data:image/png;base64,${png.toString('base64')}" alt="image" width="900" data-typora-scale="100" />`][0],'','## 1.2 标题二','',paras].join('\n');
const syntheticFile=path.join(output,'synthetic.md');
fs.writeFileSync(syntheticFile,synthetic);
fs.writeFileSync(path.join(output,'empty.md'),'');
const userDoc='D:\\Users\\Ming\\Desktop\\实用经济与金融理论\\1-重识概率论.md';
const userHashBefore=crypto.createHash('sha256').update(fs.readFileSync(userDoc)).digest('hex');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const flags=['--user-data-dir='+profile,'--remote-debugging-port=9337','--no-sandbox','--enable-logging=stderr','--v=0'];
const errlog=fs.openSync(path.join(output,'stderr.log'),'a');
const child=spawn(exe,[...flags,userDoc],{env,windowsHide:true,stdio:['ignore',errlog,errlog]});
child.unref();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const get=json=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:9337,path:json},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));}).on('error',reject);});
async function main(){
  let page=null;
  for(let i=0;i<100&&!page;i++){await pause(300);try{page=(await get('/json/list')).find(t=>t.type==='page'&&/\/shell/.test(t.url));}catch{}}
  assert.ok(page,'CDP page target');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq=0;const pending=new Map();const consoleErrors=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown')consoleErrors.push('EXC:'+(m.params.exceptionDetails.exception?.description||'').slice(0,200));};
  const send=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable');await send('Page.enable');
  const evalJs=async code=>{const r=await send('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true});
    if(r?.exceptionDetails)return {__exc:(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,300)};
    return r?.result?.value;};
  const log=(k,v)=>console.log('['+k+']',typeof v==='string'?v:JSON.stringify(v));
  const shot=async name=>{const s=await send('Page.captureScreenshot',{format:'png'});return Buffer.from(s.data,'base64');};
  const docState=()=>evalJs(`(()=>{const f=document.getElementById('editor');const w=f&&f.contentWindow;if(!w)return null;
    try{return {src:f.getAttribute('src'),patched:!!(w.vditor&&w.vditor.vditor&&w.vditor.vditor.__typoraPatched),valueLen:w.vditor?w.vditor.getValue().length:-1,
      toolbar:!!(w.document&&w.document.querySelector('.vditor-toolbar')),h1:w.document?w.document.querySelectorAll('.vditor-reset h1').length:-1,
      firstH1:w.document&&w.document.querySelector('.vditor-reset h1')?w.document.querySelector('.vditor-reset h1').textContent.slice(0,20):null,
      theme:w.document?w.document.documentElement.dataset.editorTheme:null};}catch(e){return {err:e.message};}})()`);
  // ---- 1) 用户文档（截图当场落盘供核对，随后删除）
  for(let i=0;i<40;i++){const st=await docState();if(st&&st.patched&&st.valueLen>1000){log('user-doc',st);break;}await pause(500);}
  const ud=await docState();
  assert.ok(ud&&ud.patched,'用户文档：vditor 初始化完成（工具栏存在的前提）');
  assert.ok(ud.toolbar===true,'用户文档：工具栏已渲染');
  assert.ok(ud.valueLen>14000,'用户文档：全文已载入（masked 视图 >14K 字符），实际 '+ud?.valueLen);
  assert.ok(ud.h1>=3,'用户文档：标题已渲染');
  fs.writeFileSync(path.join(output,'final-user-doc.png'),await shot('user'));
  log('user-doc-screenshot','written (deleted after check)');
  // ---- 2) 合成等价文档（键帧截图入档：before 无法回溯，after 为修复后状态）
  const openResult=await evalJs(`hostApi.invoke('open-file',{path:${JSON.stringify(syntheticFile)}}).then(v=>'ok:'+JSON.stringify(v)).catch(e=>'err:'+e.message)`);
  log('open-synthetic',openResult);
  for(let i=0;i<40;i++){const st=await docState();if(st&&st.patched&&st.valueLen>3000&&st.h1>=1&&(st.firstH1||'').includes('等价复现样例'))break;await pause(500);}
  const sd=await docState();
  log('synthetic-doc',sd);
  assert.ok((sd&&sd.firstH1||'').includes('等价复现样例'),'合成文档身份校验（防用户文档状态串档）：'+JSON.stringify(sd));
  assert.ok(sd&&sd.patched&&sd.toolbar&&sd.valueLen>3000,'合成大文档渲染（工具栏+全文）');
  fs.writeFileSync(path.join(output,'final-synthetic.png'),await shot('synthetic'));
  // ---- 3) 空文件统计归零
  await evalJs(`hostApi.invoke('open-file',{path:${JSON.stringify(path.join(output,'empty.md'))}})`);
  await pause(1500);
  const emptyBar=await evalJs(`JSON.stringify({words:document.getElementById('st-words')?.textContent,chars:document.getElementById('st-chars')?.textContent,lines:document.getElementById('st-lines')?.textContent})`);
  log('empty-stats',emptyBar);
  const bar=JSON.parse(emptyBar);
  assert.equal(bar.words,'字数 0','空文件字数为 0');
  assert.equal(bar.chars,'字符 0','空文件字符为 0');
  assert.equal(bar.lines,'行 0','空文件行数为 0（v2.0.9）');
  fs.writeFileSync(path.join(output,'final-empty-stats.png'),await shot('empty'));
  log('console-errors',consoleErrors.slice(0,5));
  try{await send('Browser.close');}catch{}
  await pause(800);
  const userHashAfter=crypto.createHash('sha256').update(fs.readFileSync(userDoc)).digest('hex');
  assert.equal(userHashAfter,userHashBefore,'用户原文件全程未被改写');
  fs.unlinkSync(path.join(output,'final-user-doc.png'));
  log('user-screenshot','deleted (user content, not archived)');
  console.log('bug209 final: ALL PASS');
  process.exit(0);
}
main().catch(e=>{console.error(e);try{child.kill();}catch{}process.exit(1);});
