'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const dir=path.resolve(process.argv[2]||'test/.runs/lowcost-v3-2026-09-07'),root=path.resolve(__dirname,'..');
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const design=read('design.json'),run=read('results.json'),cases=read('cases.json'),scores=read('summary.json'),lock=read('grades-lock.json'),plan=read('evaluation-plan.json');
assert.equal(sha(fs.readFileSync(path.join(dir,'grades.json'))),lock.sha256);
assert.equal(sha(fs.readFileSync(path.join(dir,'design.json'))),run.designSha256);
assert.equal(sha(fs.readFileSync(design.source.path)),design.source.sha256);
assert.equal(run.rows.length,200);assert.equal(new Set(run.rows.map(r=>r.id+':'+r.arm)).size,200);
assert.ok(run.originalUnchanged&&run.credentialsUnchanged);
for(const r of run.rows){assert.ok(!r.error);assert.equal(r.responseModel,design.model);assert.equal(r.httpStatus,200);}
for(const [key,file] of Object.entries({core:'out/completion/core.cjs',structure:'out/completion/structure.cjs',policy:'render/js/completion-policy.mjs'}))assert.equal(sha(fs.readFileSync(path.join(dir,'candidate',file))),design.production[key]);
const s=scores.summary,old=s.all.off,now=s.all.on,ratio=(a,b)=>(a/b-1)*100;
const inputGrowth=ratio(now.totalInput,old.totalInput),outputGrowth=ratio(now.usage.output_tokens,old.usage.output_tokens),latencyGrowth=ratio(now.p95Ms,old.p95Ms);
const gates={directUse:s.all.paired.differencePercentagePoints>=plan.engineeringGates.directUseNetGainAtLeast,math:s.math.on.grades.A>=s.math.off.grades.A,hardErrors:now.grades.C+now.grades.D<=old.grades.C+old.grades.D,input:inputGrowth<=plan.engineeringGates.pairedTotalInputGrowthAtMostPercent,p95:latencyGrowth<=plan.engineeringGates.observedP95LatencyGrowthAtMostPercent};
const quantile=(list,p)=>{const a=[...list].sort((x,y)=>x-y),i=(a.length-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);};
const source=fs.readFileSync(design.source.path,'utf8').replace(/\r\n/g,'\n'),doc={version:1,getText:()=>source},bench={};
for(const arm of ['baseline','candidate']){
  const {StructureCache}=require(path.join(dir,arm,'out/completion/structure.cjs'));
  const t=performance.now(),cache=new StructureCache(doc),coldMs=performance.now()-t,times=[];
  for(const c of cases){const begin=Math.max(0,c.start-200),needle=source.slice(begin,c.start+200),at=performance.now();cache.forRequest(doc,{needle,caret:c.start-begin,aiContext:c.payload});times.push(performance.now()-at);}
  bench[arm]={coldMs,lookupMedianMs:quantile(times,.5),lookupP95Ms:quantile(times,.95),apiCalls:0};
}
(async()=>{
  const {cleanSuggestion}=await import(require('node:url').pathToFileURL(path.join(root,'extension-src/render/js/completion-policy.mjs')));
  for(const r of run.rows.filter(r=>r.arm==='on'))assert.equal(cleanSuggestion(r.rawSuggestion,cases.find(c=>c.id===r.id).payload),r.suggestion,'Final edge guard changes experiment output');
  const audit={checkedAt:new Date().toISOString(),attempts:200,successful:200,models:[...new Set(run.rows.map(r=>r.responseModel))],gradesLocked:true,documentUnchanged:true,credentialsUnchanged:true,candidateSnapshotsMatchDesign:true,finalCleanupPreservesAllCandidateOutputs:true,hintsUsed:cases.filter(c=>c.sections.on.includes('DEFINITIONS')).length,maxCombinedSectionCharacters:Math.max(...cases.map(c=>c.sections.on.length)),inputGrowthPercent:inputGrowth,outputGrowthPercent:outputGrowth,observedP95GrowthPercent:latencyGrowth,mathP95GrowthPercent:ratio(s.math.on.p95Ms,s.math.off.p95Ms),cacheReadShare:{baseline:old.usage.cache_read_input_tokens/old.totalInput,candidate:now.usage.cache_read_input_tokens/now.totalInput},estimatedTotalOffPeakUSD:old.estimatedOffPeakUSD+now.estimatedOffPeakUSD,equalCacheAllMissUSD:{baseline:(old.totalInput*.22+old.usage.output_tokens*.66)/1e6,candidate:(now.totalInput*.22+now.usage.output_tokens*.66)/1e6},gates,accepted:Object.values(gates).every(Boolean),benchmark:bench,review:{reusedIdenticalPriorRatings:120,newBlindRatings:80,singleReviewer:true},finalPolicySha256:sha(fs.readFileSync(path.join(root,'extension-src/render/js/completion-policy.mjs')))};
  fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit,null,2));
})();
