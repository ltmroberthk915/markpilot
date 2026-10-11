'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [mode,out,selection]=process.argv.slice(2),dir=path.resolve(out||'test/.runs/heading-ab-2026-09-07');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')),save=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const order=(a,b)=>a.kind.localeCompare(b.kind)||Number(a.id.slice(1))-Number(b.id.slice(1));
if(mode==='blind'){
  const cases=read('cases.json'),results=read('results.json'),map=read('blind-map.json');
  const complete=cases.filter(c=>results.rows.filter(r=>r.id===c.id).length===2);
  save('blind-review.json',complete.map(c=>({id:c.id,label:c.label,line:c.line,kind:c.kind,expected:c.expected,heading:c.payload.heading,before:c.payload.before,after:c.payload.after,nearby:c.payload.nearby,mathBefore:c.payload.mathBefore,mathAfter:c.payload.mathAfter,...Object.fromEntries(['X','Y'].map(label=>[label,results.rows.find(r=>r.id===c.id&&r.arm===map[c.id][label]).suggestion||'']))})).sort(order));
  console.log(JSON.stringify({completePairs:complete.length,ready:complete.map(c=>c.id)}));
}else if(mode==='show'){
  let rows=read('blind-review.json');if(selection)rows=rows.filter(r=>selection.split(',').includes(r.id));
  for(const r of rows)console.log(JSON.stringify({id:r.id,label:r.label,reference:r.expected,site:r.kind==='math'?r.mathBefore+'⟦INSERT⟧'+r.mathAfter:r.before.slice(-260)+'⟦INSERT⟧'+r.after.slice(0,260),X:r.X,Y:r.Y}));
}else if(mode==='context'){
  for(const r of read('blind-review.json').filter(r=>selection.split(',').includes(r.id)))console.log(JSON.stringify(r));
}else if(mode==='stats'){
  const design=read('design.json'),results=read('results.json'),map=read('blind-map.json'),reviews=read('grades.json'),cases=read('cases.json');
  assert.equal(results.rows.length,200);assert.equal(Object.keys(reviews).length,100);
  const scores={A:3,B:2,C:1,D:0},reviewed=cases.map(c=>{const g=reviews[c.id];assert.ok(g&&scores[g.X]>=0&&scores[g.Y]>=0,c.id);const key=arm=>map[c.id].X===arm?'X':'Y';return{id:c.id,kind:c.kind,off:g[key('off')],on:g[key('on')],reasonOff:g['reason'+key('off')]||g.reason,reasonOn:g['reason'+key('on')]||g.reason};});
  const quantile=(a,p)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!s.length)return null;const i=(s.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo);};
  const summary={};
  for(const kind of ['all','math','prose']){
    const r=reviewed.filter(x=>kind==='all'||x.kind===kind),s={n:r.length};
    for(const arm of ['off','on']){
      const rows=results.rows.filter(x=>x.arm===arm&&(kind==='all'||x.kind===kind)),success=rows.filter(x=>!x.error&&x.httpStatus===200);
      const usage={input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0};for(const x of success)for(const k of Object.keys(usage))usage[k]+=x.usage?.[k]||0;
      s[arm]={grades:Object.fromEntries(Object.keys(scores).map(g=>[g,r.filter(x=>x[arm]===g).length])),medianMs:quantile(rows.map(x=>x.totalMs),.5),p95Ms:quantile(rows.map(x=>x.totalMs),.95),successMedianMs:quantile(success.map(x=>x.totalMs),.5),successP95Ms:quantile(success.map(x=>x.totalMs),.95),errors:rows.length-success.length,usage,totalInput:usage.input_tokens+usage.cache_read_input_tokens+usage.cache_creation_input_tokens,estimatedOffPeakUSD:(usage.input_tokens*.22+usage.cache_read_input_tokens*.007+usage.output_tokens*.66)/1e6};
    }
    const gains=r.filter(x=>x.on==='A'&&x.off!=='A').length,losses=r.filter(x=>x.off==='A'&&x.on!=='A').length;
    let p=0,choose=1;for(let k=0;k<=Math.min(gains,losses);k++){if(k>0)choose*=((gains+losses)-k+1)/k;p+=choose*2**-(gains+losses);}p=Math.min(1,2*p);
    s.paired={directUseGains:gains,directUseLosses:losses,differencePercentagePoints:100*(gains-losses)/r.length,mcnemarExactP:p,ordinalImproved:r.filter(x=>scores[x.on]>scores[x.off]).length,ordinalWorse:r.filter(x=>scores[x.on]<scores[x.off]).length,tied:r.filter(x=>x.on===x.off).length};summary[kind]=s;
  }
  // Stratified paired bootstrap over document sites. This describes this
  // fixed corpus, not repeated-draw stability or other users' acceptance rate.
  let state=941731;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const strata=['math','prose'].map(k=>reviewed.filter(r=>r.kind===k)),deltas=[];
  for(let b=0;b<20000;b++){let difference=0;for(const group of strata)for(let i=0;i<group.length;i++){const r=group[Math.floor(random()*group.length)];difference+=Number(r.on==='A')-Number(r.off==='A');}deltas.push(difference);}
  summary.all.paired.bootstrap95PercentagePoints=[quantile(deltas,.025),quantile(deltas,.975)];
  const pairs=cases.map(c=>{const off=results.rows.find(r=>r.id===c.id&&r.arm==='off'),on=results.rows.find(r=>r.id===c.id&&r.arm==='on');return{id:c.id,kind:c.kind,...reviewed.find(r=>r.id===c.id),offMs:off.totalMs,onMs:on.totalMs,offSuggestion:off.suggestion||'',onSuggestion:on.suggestion||''};});
  save('summary.json',{summary,reviewed,pairs,gradeSource:'Codex semantic review with X/Y labels concealed; reviewer knew reference and visible note context. No judge API calls.',tokenEstimateNote:'Sum Anthropic-compatible input/cache-read/cache-creation fields. USD estimate uses published off-peak prices, excludes usage unavailable for failed requests.'});console.log(JSON.stringify(summary,null,2));
}else throw new Error('Use blind|show|context|stats OUTPUT [comma-separated IDs]');
