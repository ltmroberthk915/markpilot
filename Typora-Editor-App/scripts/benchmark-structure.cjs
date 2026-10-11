const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {parseHeadings,sectionAt,StructureCache}=require('../../Typora-Editor/extension-src/out/completion/structure.cjs');
const file=process.argv[2]||'D:/Users/Ming/Desktop/动态规划教材（渲染修复副本）.md',data=fs.readFileSync(file),source=data.toString('utf8');
const start=performance.now(),index=parseHeadings(source),coldMs=performance.now()-start,warm=[];
for(let i=0;i<40;i++){const at=performance.now();parseHeadings(source);warm.push(performance.now()-at);}
warm.sort((a,b)=>a-b);
const sample=(list,n)=>Array.from({length:Math.min(list.length,n)},(_,i)=>list[Math.floor(i*list.length/n)]);
const math=[...index.text.matchAll(/(?<![\\$])\$[^$\n]+\$/g)].map(m=>m.index+Math.floor(m[0].length/2));
const text=[...index.text.matchAll(/^[ \t]*(?:>\s*)?(?:[-+*] |\d+[.)] )?(?:\*\*)?[\p{L}][^\n$]{12,}/gmu)].map(m=>m.index+Math.floor(m[0].length/2));
const positions=[...sample(math,70).map(offset=>({kind:'math',offset})),...sample(text,30).map(offset=>({kind:'text',offset}))];
const doc={version:1,getText:()=>source},cache=new StructureCache(doc),lookups=[];
const samples=positions.map(({kind,offset})=>{
  const begin=Math.max(0,offset-80),needle=index.text.slice(begin,offset+80),start=performance.now();
  const excerpt=cache.forRequest(doc,{needle,caret:offset-begin});lookups.push(performance.now()-start);
  return{kind,offset,characters:excerpt.length,section:excerpt};
});
lookups.sort((a,b)=>a-b);const sizes=samples.map(s=>s.characters).sort((a,b)=>a-b);
const report={file,sha256:crypto.createHash('sha256').update(data).digest('hex'),characters:source.length,headings:index.headings.length,coldMs,warmP50Ms:warm[20],warmP95Ms:warm[38],lookupP50Ms:lookups[Math.floor(lookups.length*.5)],lookupP95Ms:lookups[Math.floor(lookups.length*.95)],sampleCounts:{math:samples.filter(s=>s.kind==='math').length,text:samples.filter(s=>s.kind==='text').length},structureCharacters:{min:sizes[0],median:sizes[Math.floor(sizes.length/2)],max:sizes.at(-1)},samples,apiCalls:0,note:'Local preprocessing/payload measurements only; no model quality or network-latency claim.'};
fs.writeFileSync(path.resolve(__dirname,'../.perf/heading-benchmark.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,samples:undefined},null,2));
