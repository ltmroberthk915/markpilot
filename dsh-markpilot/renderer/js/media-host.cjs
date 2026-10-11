'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{fileURLToPath}=require('node:url'),{spawn}=require('node:child_process');
const {TYPES,MAX}=require('./portable-images.cjs');
const {resolveExternal}=require('./external-resource.cjs');
const byExt=Object.fromEntries(Object.entries(TYPES).map(([mime,ext])=>['.'+ext,mime]));byExt['.jpeg']='image/jpeg';
async function imageBytes(source,file){
  if(typeof source!=='string')throw new Error('无效的图片地址');
  if(source.startsWith('data:')){const match=source.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);if(!match||!TYPES[match[1]]||match[2].length>MAX*1.4)throw new Error('无效或过大的内嵌图片');return{bytes:Buffer.from(match[2],'base64'),mime:match[1]};}
  let local;
  if(/^[a-z]:[\\/]/i.test(source))local=source;
  else if(source.startsWith('file:'))local=fileURLToPath(source);
  else if(/^https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\//i.test(source)){local=decodeURIComponent(new URL(source).pathname.slice(1));if(process.platform!=='win32')local='/'+local;}
  else if(!/^[a-z][a-z\d+.-]*:|^\/\//i.test(source)){
    // Local references keep literal '#', '?' and '%' file names; only remote
    // URLs ever carry a query or fragment worth stripping.
    let relative=source;
    try{relative=decodeURIComponent(source);}catch{/* a literal % is not percent-encoding */}
    local=path.resolve(path.dirname(file),relative);
  }
  if(local){
    // The whole string is the local file name; only retry without a query
    // suffix when the raw extension is unknown (cache-buster style names).
    const extension=path.extname(local).toLowerCase();
    const mime=byExt[extension]||byExt[path.extname(extension.split(/[?#]/,1)[0])];
    if(!mime)throw new Error('不支持的图片格式');const stat=await fs.stat(local);if(!stat.isFile()||stat.size>MAX)throw new Error('图片超过 20 MB 或不是文件');return{bytes:await fs.readFile(local),mime};
  }
  const url=new URL(source.startsWith('//')?'https:'+source:source);if(!['http:','https:'].includes(url.protocol))throw new Error('不支持的图片地址');
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)}),mime=(response.headers.get('content-type')||'').split(';')[0];
  if(!response.ok||!TYPES[mime]){await response.body?.cancel();throw new Error('图片下载失败');}
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX)throw new Error('图片超过 20 MB');chunks.push(chunk);}return{bytes:Buffer.concat(chunks),mime};
}
// PowerShell 自己的报错（-File 路径不存在、策略拦截等）走的是控制台码页
// （中文 Windows 是 GBK）。上一版把它按 UTF-8 解码拼进提示，用户看到的就是
// 满屏乱码 + 一段 "-File ..." 用法文本。凡不是合法 UTF-8 的按 GBK 再解一次。
const decodeConsole=part=>{
  const utf8=part.toString('utf8');
  if(!utf8.includes('\uFFFD'))return utf8;
  try{return new TextDecoder('gbk').decode(part);}catch{return utf8;}
};
function windowsClipboard(payload){
  if(process.platform!=='win32')return Promise.reject(new Error('此宿主的 Office 图片剪贴板暂只支持 Windows；可用“导出原图”迁移原始文件'));
  // 交给外部进程的脚本路径必须解析到真实文件：打包后 __dirname 在 app.asar 里，
  // PowerShell 打不开（本轮用户实测的“复制图片失败”就是这个）。
  let script;
  try{script=resolveExternal(__dirname,'media-clipboard.ps1');}
  catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    const command=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child=spawn(command,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script.path],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',error='',finished=false;
    const done=(reason,report)=>{if(finished)return;finished=true;clearTimeout(timer);reason?reject(reason):resolve(report);};
    // 多图拼接要读盘、解码并画一张大图：给足时间（单图仍是 10s）。
    const timeout=payload&&payload.action==='copy-images'?30000:10000;
    const timer=setTimeout(()=>{child.kill();done(new Error('剪贴板正被占用，请重试'));},timeout);
    child.stdout.on('data',part=>{out+=part.toString('utf8');});
    child.stderr.on('data',part=>{error+=decodeConsole(part).slice(0,2000);});
    child.on('error',done);
    child.on('exit',code=>{
      // 脚本成功失败都往 stdout 写一行 JSON；解析失败才退回到 PowerShell 文本。
      let report=null;
      const line=out.trim().split('\n').filter(Boolean).pop();
      if(line){try{report=JSON.parse(line);}catch{/* 非 JSON：当纯文本错误处理 */}}
      if(code===0&&report&&report.ok!==false)return done(null,report);
      const message=(report&&report.error)||error.trim()||out.trim()||('退出码 '+code);
      done(new Error('无法写入系统剪贴板：'+String(message).slice(0,300)));
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
  });
}
module.exports={imageBytes,windowsClipboard,resolveExternal,TYPES};
