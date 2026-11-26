'use strict';
const fs=require('node:fs');
const tooLarge=()=>Object.assign(Error('图片超过允许的字节上限'),{code:'E_TOO_LARGE'});
async function readCappedFile(file,limit) {
  const chunks=[];let size=0;
  // The limit applies while reading, including a file growing after stat.
  for await(const chunk of fs.createReadStream(file,{highWaterMark:65536})){
    if(chunk.length>limit-size)throw tooLarge();
    size+=chunk.length;chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}
async function readCappedResponse(response,limit) {
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel().catch(()=>{});throw tooLarge();}
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      if(value.byteLength>limit-size)throw tooLarge();
      size+=value.byteLength;chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,size);
  }catch(error){await reader.cancel(error).catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
module.exports={readCappedFile,readCappedResponse};
