'use strict';
// The file contains standard data: image URLs. The editor and completion host
// see only short cache URLs; image bytes are materialized at I/O boundaries.
const fs=require('node:fs/promises'),fsSync=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const TYPES={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg','image/bmp':'bmp','image/avif':'avif','image/x-icon':'ico','image/vnd.microsoft.icon':'ico'};
const DATA=/data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}/gi;
// Matches both cache URL spellings: the desktop app emits a literal 'file+'
// authority, while current VS Code webview Uris percent-encode it as 'file%2B'.
const CACHE=/https:\/\/file(?:\+|%2b)\.vscode-resource\.vscode-cdn\.net\/[^\s"'<>()[\]]*\/([a-f0-9]{64}\.(?:png|jpg|gif|webp|svg|bmp|avif|ico))/gi;
const MAX=20*1024*1024;
const pseudo=file=>'https://file+.vscode-resource.vscode-cdn.net/'+pathToFileURL(file).href.slice('file:///'.length);
// 【P7】会话期常驻的 data 字符串条数上限（LRU）。entries 永远保留
// key→{file,url,mime,…} 的轻量映射；可安全重建的条目（base64 规范且磁盘
// sha256 缓存写成功）被淘汰后，expand/rawOffset 从磁盘回读。重建出的
// data 字符串与被淘汰前逐字节相同——canonical 检查保证这一点，任何一项
// 不满足的条目常驻内存不走 LRU，保存输出的 markdown 与没有 LRU 时完全
// 一致（保真优先于内存）。
const RESIDENT_CAP=32;
class PortableImages{
  constructor({root,urlFor=pseudo}){this.root=path.resolve(root);this.urlFor=urlFor;this.entries=new Map();this.urls=new Map();this.pending=new Set();this.warnings=[];
    this.resident=new Set();this.cap=RESIDENT_CAP;this.pin=0;}
  get residentData(){return this.resident.size;}
  // Fault-tolerant callers (opening/reloading existing files) pass tolerant to
  // keep the document openable when one image is bad; insert() stays strict.
  _warn(text){if(!this.warnings.includes(text))this.warnings.push(text);}
  consumeWarnings(){const list=this.warnings;this.warnings=[];return list;}
  _touch(key){
    const item=this.entries.get(key);
    if(!item||item.data===undefined)return;
    this.resident.delete(key);this.resident.add(key);
    this._trim();
  }
  _trim(){
    if(this.pin)return;
    let excess=this.resident.size-this.cap;
    for(const key of this.resident){
      if(excess<=0)break;
      const item=this.entries.get(key);
      // 【P7】只有 reload（可逐字节重建）且 onDisk（磁盘缓存写成功）的条目才
      // 允许淘汰；写盘还在飞行中的条目等它落地后再由下一次 trim 收走。
      if(!item||!item.reload||!item.onDisk)continue;
      delete item.data;this.resident.delete(key);excess--;
    }
  }
  // 淘汰后的回读：磁盘 sha256 缓存文件 → data URL。pinned（单次 expand 遍历
  // 中）不触发 trim，避免"逐张回读又逐张淘汰"的抖动；遍历收尾统一 trim。
  _data(item,pinned=false){
    if(!item)return undefined;
    if(item.data!==undefined){if(!pinned)this._touch(item.key);return item.data;}
    if(!item.reload)return undefined;
    let bytes;
    try{bytes=fsSync.readFileSync(item.file);}
    catch(error){this._warn('图片缓存回读失败（'+item.key.slice(0,12)+'…）：'+error.message+'；该图保留为短 URL');return undefined;}
    const data='data:'+item.mime+';base64,'+bytes.toString('base64');
    item.data=data;
    if(pinned)this.resident.add(item.key);else this._touch(item.key);
    return data;
  }
  register(data,{tolerant=false}={}){
    const fail=message=>{if(tolerant){this._warn('已保留原文，未内嵌该图片：'+message);return null;}throw new Error(message);};
    const split=data.indexOf(','),mime=data.slice(5,split).split(';')[0].toLowerCase(),ext=TYPES[mime];
    if(!ext||data.length>MAX*1.4)return fail('单张内嵌图片不能超过 20 MB');
    const key=crypto.createHash('sha256').update(data).digest('hex')+'.'+ext;
    if(this.entries.has(key)){this._touch(key);return this.entries.get(key).url;}
    const b64=data.slice(split+1),bytes=Buffer.from(b64,'base64');if(!bytes.length||bytes.length>MAX)return fail('图片为空或超过 20 MB');
    const file=path.join(this.root,key),url=this.urlFor(file);
    // reload：字节重编码必须逐字节还原原 data 串，否则不能从磁盘重建。
    const item={key,data,file,url,mime,dataLen:data.length,reload:bytes.toString('base64')===b64,onDisk:false};
    this.entries.set(key,item);this.urls.set(url,item);
    this._touch(key);
    // A failed cache write only loses the on-disk copy; the in-memory entry
    // still expands on save, so degrade to a warning instead of throwing.
    const pending=fs.mkdir(this.root,{recursive:true}).then(()=>fs.writeFile(file,bytes,{flag:'wx'})).then(
      ()=>{item.onDisk=true;this._trim();},
      error=>{
        if(error.code==='EEXIST'){item.onDisk=true;this._trim();}
        else this._warn('图片缓存写入失败（'+key.slice(0,12)+'…）：'+error.message+'；编辑与保存不受影响');
      });
    this.pending.add(pending);pending.catch(()=>{});return url;
  }
  // Only image destinations are hidden. Literal examples in fenced/inline
  // code stay source text; no normalized save or re-encoding of their bytes.
  maskSync(source,{tolerant=false}={}){
    if(!/data:image\//i.test(source))return source;
    let fence=null,inline=0,offset=0;const replacements=[];
    for(const line of source.split('\n')){
      const marker=line.match(/^ {0,3}(?:> ?)*(`{3,}|~{3,})(.*)$/);
      if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;offset+=line.length+1;continue;}
      if(!fence&&!/^ {4}|^\t/.test(line)){
        for(const match of line.matchAll(DATA)){
          const before=line.slice(0,match.index);
          inline=0;for(const tick of before.matchAll(/(?<!\\)(`+)/g)){if(!inline)inline=tick[1].length;else if(inline===tick[1].length)inline=0;}
          if(inline)continue;
          if(!/(?:!\[[^\]\n]*\]\(\s*<?|<img\b[^>]*\bsrc\s*=\s*["']|^ {0,3}\[[^\]\n]+\]:\s*<?)$/i.test(before))continue;
          const url=this.register(match[0],{tolerant});
          if(url)replacements.push({start:offset+match.index,end:offset+match.index+match[0].length,url});
        }
      }offset+=line.length+1;
    }
    if(!replacements.length)return source;
    let last=0;const pieces=[];for(const item of replacements){pieces.push(source.slice(last,item.start),item.url);last=item.end;}pieces.push(source.slice(last));return pieces.join('');
  }
  // Pending writes never reject: failures already became warnings, so await
  // is safe for every caller (a failed cache write must not block opening).
  async flush(){const pending=[...this.pending];await Promise.all(pending);for(const item of pending)this.pending.delete(item);}
  async mask(source,{tolerant=false}={}){const result=this.maskSync(source,{tolerant});await this.flush();return result;}
  spans(text){const result=[];for(const match of text.matchAll(CACHE)){const item=this.urls.get(match[0]);if(item)result.push({start:match.index,end:match.index+match[0].length,item});}return result;}
  expand(text){
    if(!this.urls.size)return text;
    // 【P7】单次遍历把回读钉住（pin），避免"读一张淘汰一张"的抖动；收尾统一
    // 按上限裁剪。淘汰过的条目在这里从磁盘 sha256 缓存重建，重建串与原串
    // 逐字节相同（见 register 的 reload 判定），保存输出不变。
    this.pin++;
    try{return text.replace(CACHE,url=>this._data(this.urls.get(url),true)||url);}
    finally{this.pin--;this._trim();}
  }
  rawOffset(text,offset){let extra=0;for(const span of this.spans(text)){if(span.end<=offset)extra+=span.item.dataLen-(span.end-span.start);else if(span.start<offset)throw new Error('不能在图片编码内部映射文本位置');}return offset+extra;}
  // VS Code already owns a full TextDocument. Apply only the changed span,
  // keeping multi-megabyte data URLs out of per-keystroke workspace edits.
  diff(before,after){
    let start=0,a=before.length,b=after.length;
    while(start<a&&start<b&&before.charCodeAt(start)===after.charCodeAt(start))start++;
    while(a>start&&b>start&&before.charCodeAt(a-1)===after.charCodeAt(b-1)){a--;b--;}
    if(start>0&&/[\uDC00-\uDFFF]/.test(before[start]||''))start--;
    if(/[\uDC00-\uDFFF]/.test(before[a]||'')){a++;b++;}
    const left=this.spans(before),right=this.spans(after);
    for(const span of [...left,...right])if(span.start<start&&span.end>start)start=span.start;
    for(const span of left)if(span.start<a&&span.end>a){const delta=span.end-a;a+=delta;b+=delta;}
    for(const span of right)if(span.start<b&&span.end>b){const delta=span.end-b;a+=delta;b+=delta;}
    return{start:this.rawOffset(before,start),end:this.rawOffset(before,a),text:this.expand(after.slice(start,b))};
  }
  async insert(value){
    if(!TYPES[value?.mime]||typeof value.data!=='string')throw new Error('不支持的图片格式');
    const data='data:'+value.mime+';base64,'+value.data,url=this.register(data);await this.flush();
    const alt=path.basename(value.name||'图片',path.extname(value.name||'')).replace(/[\[\]\\\r\n]/g,'');
    return{id:value.id,markdown:`![${alt}](${url})`};
  }
}
module.exports={PortableImages,TYPES,MAX,pseudo};
