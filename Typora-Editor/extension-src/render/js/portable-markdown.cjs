'use strict';
const {imageBytes}=require('./media-host.cjs');
function imageSources(text){
  const items=[],references=new Set();let fence=null,offset=0;
  const definitions=[];
  for(const line of text.split('\n')){
    const marker=line.match(/^ {0,3}(?:> ?)*(`{3,}|~{3,})(.*)$/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;offset+=line.length+1;continue;}
    if(!fence&&!/^(?: {4}|\t)/.test(line)){
      const isCode=at=>{let open=0;for(const m of line.slice(0,at).matchAll(/(?<!\\)(`+)/g)){if(!open)open=m[1].length;else if(open===m[1].length)open=0;}return!!open;};
      for(const m of line.matchAll(/!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>\r\n]*)>|((?:\\.|[^\s()\\]|\([^()\r\n]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)){
        if(isCode(m.index))continue;const src=m[1]??m[2],prefix=m[0].match(/^!\[(?:\\.|[^\]\\])*\]\(\s*<?/)[0];items.push({start:offset+m.index+prefix.length,end:offset+m.index+prefix.length+src.length,src});
      }
      for(const m of line.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)){
        if(isCode(m.index))continue;const prefix=m[0].match(/^<img\b[^>]*?\bsrc\s*=\s*["']/i)[0];items.push({start:offset+m.index+prefix.length,end:offset+m.index+prefix.length+m[2].length,src:m[2].replace(/&amp;/g,'&')});
      }
      for(const m of line.matchAll(/!\[([^\]\r\n]+)\](?:\[([^\]\r\n]*)\])?/g))if(!isCode(m.index)&&line[m.index+m[0].length]!=='(')references.add((m[2]||m[1]).trim().toLowerCase());
      const definition=line.match(/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/);if(definition){const src=definition[2]||definition[3],start=offset+line.indexOf(src,line.indexOf(']:')+2);definitions.push({id:definition[1].trim().toLowerCase(),start,end:start+src.length,src});}
    }offset+=line.length+1;
  }
  return items.concat(definitions.filter(item=>references.has(item.id))).sort((a,b)=>a.start-b.start);
}
async function portableMarkdown(text,{file,signal}={}){
  const sources=imageSources(text),assets=new Map(),errors=[];let next=0,total=0;
  const unique=[...new Set(sources.map(item=>item.src))];
  await Promise.all(Array.from({length:Math.min(4,unique.length)},async()=>{
    while(next<unique.length){const src=unique[next++];signal?.throwIfAborted();try{
      if(src.startsWith('data:')){assets.set(src,src);continue;}
      const image=await imageBytes(src,file);total+=image.bytes.length;if(total>100*1024*1024)throw new Error('图片总量超过 100 MB');assets.set(src,'data:'+image.mime+';base64,'+image.bytes.toString('base64'));
    }catch(error){errors.push(src.slice(0,160)+'：'+error.message);}}
  }));
  signal?.throwIfAborted();if(errors.length)throw new Error('无法生成完整的便携 Markdown，原文未改动。以下图片尚不可用：\n'+errors.slice(0,8).join('\n'));
  let cursor=0;const parts=[];for(const item of sources){parts.push(text.slice(cursor,item.start),assets.get(item.src));cursor=item.end;}parts.push(text.slice(cursor));return{text:parts.join(''),images:sources.length,embedded:unique.filter(src=>!src.startsWith('data:')).length};
}
module.exports={imageSources,portableMarkdown};
