// Compare a staged candidate before changing the application implementation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
// Frozen 1.0.8 counter so this comparison remains reproducible after landing.
const baseline=text=>{const cjk=(text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)||[]).length;return{words:cjk+(text.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)||[]).length,chars:text.replace(/\s/g,'').length,cjk,lines:text.split('\n').length};};
function candidate(text){
  let cjk=0,latin=0,chars=0,lines=1,inWord=false;
  const alnum=n=>n>=48&&n<=57||n>=65&&n<=90||n>=97&&n<=122;
  for(let i=0;i<text.length;i++){
    const n=text.charCodeAt(i);
    if(n>=0x3400&&n<=0x4dbf||n>=0x4e00&&n<=0x9fff)cjk++;
    if(alnum(n)){if(!inWord)latin++;inWord=true;}
    else if(!((n===39||n===0x2019||n===45)&&inWord&&alnum(text.charCodeAt(i+1))))inWord=false;
    if(n===10)lines++;
    if(!(n===32||n>=9&&n<=13||n===0xa0||n===0x1680||n>=0x2000&&n<=0x200a||n===0x2028||n===0x2029||n===0x202f||n===0x205f||n===0x3000||n===0xfeff))chars++;
  }
  return{words:cjk+latin,chars,cjk,lines};
}
const unicode=Array.from({length:65536},(_,i)=>'a'+String.fromCharCode(i)+'b').join('');
const cases=['','\r\n',"a--b a'b a’b a--- b",'🙂𠀀\ufeff\u200b\u2028数学 $x_1$\n',unicode];
let seed=12345;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
for(let i=0;i<600;i++)cases.push(Array.from({length:random()%700},()=>String.fromCharCode(random()%65536)).join(''));
for(const text of cases)assert.deepEqual(candidate(text),baseline(text));
const desktop=require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetFolderPath('Desktop')"],{encoding:'utf8',windowsHide:true}).trim();
const real=[['12万字教材','.testws/教材合订本.md'],['动态规划笔记',path.join(desktop,'动态规划教材（渲染修复副本）.md')]].filter(([,file])=>fs.existsSync(file)).map(([label,file])=>({label,file,text:fs.readFileSync(file,'utf8')}));
assert.ok(real.length);const reports=[];
for(const {label,file,text} of real){
  assert.deepEqual(candidate(text),baseline(text));for(let i=0;i<20;i++){baseline(text);candidate(text);}
  const before=[],after=[];
  for(let i=0;i<120;i++)for(const [fn,times] of (i%2?[[baseline,before],[candidate,after]]:[[candidate,after],[baseline,before]])){
    const t=performance.now();fn(text);times.push(performance.now()-t);
  }
  const summary=values=>{values.sort((a,b)=>a-b);return{medianMs:values[Math.floor(values.length*.5)],p95Ms:values[Math.floor(values.length*.95)]};};
  reports.push({label,file:path.resolve(file),characters:text.length,before:summary(before),candidate:summary(after)});
}
const result={equivalenceCases:cases.length,unicodeCodeUnitsCovered:65536,repetitionsPerDocument:120,reports};
fs.writeFileSync('.perf/stats-candidate.json',JSON.stringify(result,null,2));
fs.mkdirSync('.perf/candidates',{recursive:true});fs.writeFileSync('.perf/candidates/text-stats.cjs',"'use strict';\nconst computeStats="+candidate.toString()+";\nmodule.exports={computeStats};\n");
console.log(JSON.stringify(result,null,2));
