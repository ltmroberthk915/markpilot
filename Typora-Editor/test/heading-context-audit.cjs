'use strict';
// Offline only: validate the completed paired run and derive cost diagnostics.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const dir=path.resolve(process.argv[2]||'test/.runs/heading-ab-2026-09-07');
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const design=read('design.json'),cases=read('cases.json'),result=read('results.json'),lock=read('grades-lock.json'),summary=read('summary.json');
assert.equal(sha(fs.readFileSync(path.join(dir,'grades.json'))),lock.sha256,'Grades changed after unblinding');
assert.equal(sha(fs.readFileSync(path.join(dir,'design.json'))),result.designSha256);
assert.equal(sha(fs.readFileSync(design.source.path)),design.source.sha256);
for(const [name,file] of Object.entries({core:'extension-src/out/completion/core.cjs',structure:'extension-src/out/completion/structure.cjs',policy:'extension-src/render/js/completion-policy.mjs'}))assert.equal(sha(fs.readFileSync(path.resolve(__dirname,'..',file))),design.production[name]);
assert.equal(result.rows.length,200);assert.equal(new Set(result.rows.map(r=>r.id+':'+r.arm)).size,200);
assert.ok(result.originalUnchanged&&result.credentialsUnchanged);
for(const c of cases){
  assert.equal(result.rows.filter(r=>r.id===c.id).length,2);
  const on=structuredClone(c.requests.on);
  on.messages[0].content=on.messages[0].content.replace(/<document_structure>\n[\s\S]*?\n<\/document_structure>\n\n/,'').replace(' Section titles provide topic context only; preserve the local notation and do not generate headings.','');
  assert.deepEqual(on,c.requests.off);
}
for(const r of result.rows.filter(r=>!r.error))assert.equal(r.responseModel,design.model);
const quantile=(values,p)=>{const v=[...values].sort((a,b)=>a-b),i=(v.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return v[lo]+(v[hi]-v[lo])*(i-lo);};
const dist=v=>({min:Math.min(...v),median:quantile(v,.5),p95:quantile(v,.95),max:Math.max(...v),mean:v.reduce((a,b)=>a+b,0)/v.length});
const totalInput=r=>['input_tokens','cache_read_input_tokens','cache_creation_input_tokens'].reduce((s,k)=>s+(r.usage?.[k]||0),0);
const paired=cases.map(c=>({id:c.id,off:result.rows.find(r=>r.id===c.id&&r.arm==='off'),on:result.rows.find(r=>r.id===c.id&&r.arm==='on')})).filter(p=>!p.off.error&&!p.on.error);
const tokenArm=arm=>{const rows=paired.map(p=>p[arm]);return{totalInput:rows.reduce((s,r)=>s+totalInput(r),0),cacheRead:rows.reduce((s,r)=>s+(r.usage.cache_read_input_tokens||0),0),output:rows.reduce((s,r)=>s+(r.usage.output_tokens||0),0)};};
const off=tokenArm('off'),on=tokenArm('on');
const scenarios={};
for(const [name,hitShare] of Object.entries({allMiss:0,halfHit:.5,ninetyPercentHit:.9,allHit:1})){
  const cost=a=>(a.totalInput*((1-hitShare)*.22+hitShare*.007)+a.output*.66)/1e6;
  const o=cost(off),n=cost(on);scenarios[name]={offUSD:o,onUSD:n,relativeIncreasePercent:(n/o-1)*100};
}
const sensitivity={};
for(const allowed of [['A'],['A','B']]){
  const rows=summary.reviewed,gains=rows.filter(r=>!allowed.includes(r.off)&&allowed.includes(r.on)).length,losses=rows.filter(r=>allowed.includes(r.off)&&!allowed.includes(r.on)).length;
  sensitivity[allowed.join('+')]={off:rows.filter(r=>allowed.includes(r.off)).length,on:rows.filter(r=>allowed.includes(r.on)).length,gains,losses};
}
require('../extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');
const lute=global.Lute.New(),slashMathHTML=lute.Md2HTML(String.raw`\(u^*\)`),dollarMathHTML=lute.Md2HTML('$u^*$');
assert.ok(!slashMathHTML.includes('language-math')&&dollarMathHTML.includes('language-math'),'Recheck P27 formatting grade');
const kinds={};for(const kind of ['math','prose'])kinds[kind]=Object.fromEntries(['off','on'].map(arm=>[arm,design.order.filter(o=>o.kind===kind&&o.arms[0]===arm).length]));
const audit={verifiedAt:new Date().toISOString(),integrity:{plannedCalls:200,actualAttempts:200,uniquePairs:100,successfulResponses:result.rows.filter(r=>!r.error).length,actualModels:[...new Set(result.rows.map(r=>r.responseModel).filter(Boolean))],gradesLocked:true,productionHashesUnchanged:true,documentUnchanged:true,credentialsUnchanged:true,onlyStructureDifference:true,firstArmByStratum:kinds},pairedUsage:{pairs:paired.length,off,on,addedInput:on.totalInput-off.totalInput,addedInputPerRequest:(on.totalInput-off.totalInput)/paired.length,relativeInputIncreasePercent:(on.totalInput/off.totalInput-1)*100,cacheReadShareOff:off.cacheRead/off.totalInput,cacheReadShareOn:on.cacheRead/on.totalInput},equalCacheScenarios:scenarios,sectionCharacters:dist(cases.map(c=>c.sectionContext.length)),localIndexBuildMs:dist(cases.map(c=>c.structureMs)),pairedSuccessfulLatencyDeltaMs:dist(paired.map(p=>p.on.totalMs-p.off.totalMs)),sensitivity,rendererEvidenceP27:{slashMathHTML,dollarMathHTML},limitations:['Matching usage pairs exclude the timeout; quality keeps all 100 pairs.','Cache scenarios are arithmetic estimates under assumed equal hit shares, not fresh API measurements or invoices.','Cold per-fixture heading-index builds are offline preparation timings, not editor UI timings.','Single fixed document with correlated gaps, one draw per arm, one blinded reviewer.']};
fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit,null,2));
