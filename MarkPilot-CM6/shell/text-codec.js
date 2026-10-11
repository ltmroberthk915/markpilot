'use strict';
// Shared by open and reload. UTF-16 support is a separate change.
function decodeDocument(buf,file=''){
  const head=buf.subarray(0,4096),b=i=>head[i];let printable=0;
  for(const c of head)if(c===9||c===10||c===13||(c>=32&&c<127)||c>=128)printable++;
  const magic=(b(0)===0x89&&b(1)===0x50&&b(2)===0x4e&&b(3)===0x47)||(b(0)===0xff&&b(1)===0xd8&&b(2)===0xff)||(b(0)===0x47&&b(1)===0x49&&b(2)===0x46)||(b(0)===0x42&&b(1)===0x4d)||(b(0)===0x25&&b(1)===0x50&&b(2)===0x44&&b(3)===0x46)||(b(0)===0x50&&b(1)===0x4b)||(b(0)===0x7f&&b(1)===0x45&&b(2)===0x4c&&b(3)===0x46)||(b(0)===0x52&&b(1)===0x49&&b(2)===0x46&&b(3)===0x46)||(b(0)===0&&b(1)===0&&b(2)===1&&b(3)===0);
  if(magic||(head.includes(0)&&head.length&&printable/head.length<0.8))throw Object.assign(new Error('这是一个二进制文件，MarkPilot 只打开文本文件：'+file),{code:'MP_BINARY'});
  let text=buf.toString('utf8');const bom=text.charCodeAt(0)===0xfeff;if(bom)text=text.slice(1);
  const crlf=(text.match(/\r\n/g)||[]).length,lf=(text.match(/\n/g)||[]).length,eol=crlf>0&&crlf>=lf-crlf?'\r\n':'\n';
  return {text:text.replace(/\r\n/g,'\n'),bom,eol,encoding:'utf8'};
}
function encodeDocument(text,{bom=false,eol='\n'}={}){return Buffer.from((bom?'\ufeff':'')+(eol==='\r\n'?text.replace(/\n/g,'\r\n'):text),'utf8');}
module.exports={decodeDocument,encodeDocument};
