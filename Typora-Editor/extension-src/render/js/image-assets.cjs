'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const extensions={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp','image/svg+xml':'.svg','image/bmp':'.bmp','image/avif':'.avif','image/x-icon':'.ico','image/vnd.microsoft.icon':'.ico'};
exports.saveImage=async function(documentPath,value){
  const legacy=typeof value==='string';
  const ext=legacy?'.png':extensions[value?.mime];
  if(!ext || (!legacy && typeof value.data!=='string'))throw new Error('不支持的图片格式');
  const buffer=Buffer.from(legacy?value:value.data,legacy?'binary':'base64');
  if(!buffer.length)throw new Error('图片为空');
  const folder=path.basename(documentPath,path.extname(documentPath));
  const relative=['images',folder,randomUUID()+ext];
  const file=path.join(path.dirname(documentPath),...relative);
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,buffer,{flag:'wx'});
  const alt=(legacy?folder:path.basename(value.name||'图片',path.extname(value.name||''))).replace(/[\[\]\\\r\n]/g,'');
  // Encode each path segment once: spaces, #, parentheses and Chinese names
  // remain valid Markdown URLs and resolve to the exact saved file.
  const url=relative.map(part=>encodeURIComponent(part).replace(/[()]/g,c=>'%'+c.charCodeAt(0).toString(16))).join('/');
  return {id:legacy?null:value.id,file,markdown:`![${alt}](${url})`};
};
