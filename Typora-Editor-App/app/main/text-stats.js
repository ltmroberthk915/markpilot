'use strict';
// Typora-style counts shared by the status bar and snapshot metadata.
function computeStats(text) {
  let cjk=0,latin=0,chars=0,lines=1,inWord=false;
  const alnum=n=>n>=48&&n<=57||n>=65&&n<=90||n>=97&&n<=122;
  // Preserve the previous UTF-16/ECMAScript whitespace rules while avoiding
  // document-sized match arrays, a whitespace-stripped string and line array.
  for(let i=0;i<text.length;i++){
    const n=text.charCodeAt(i);
    if(n>=0x3400&&n<=0x4dbf||n>=0x4e00&&n<=0x9fff)cjk++;
    if(alnum(n)){if(!inWord)latin++;inWord=true;}
    else if(!((n===39||n===0x2019||n===45)&&inWord&&alnum(text.charCodeAt(i+1))))inWord=false;
    if(n===10)lines++;
    if(!(n===32||n>=9&&n<=13||n===0xa0||n===0x1680||n>=0x2000&&n<=0x200a||n===0x2028||n===0x2029||n===0x202f||n===0x205f||n===0x3000||n===0xfeff))chars++;
  }
  // v2.0.9:空文件统计归零（用户报告空文件仍显示"行 1"）。
  if(!text.length)return{words:0,chars:0,cjk:0,lines:0};
  return{words:cjk+latin,chars,cjk,lines};
}
module.exports={computeStats};
