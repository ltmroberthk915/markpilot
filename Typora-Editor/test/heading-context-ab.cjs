'use strict';
// Opt-in paired experiment. Production prompts/cleanup, frozen real-note gaps,
// local heading index, no judge-model calls, no edits to documents or settings.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {settings,requestAI}=require('../extension-src/out/completion/core.cjs');
const {StructureCache}=require('../extension-src/out/completion/structure.cjs');
const {credentialId}=require('../extension-src/out/completion/profiles.cjs');
// 2.1.23 起不再内置预置模型：这个实验脚本自己声明它要用的 profile。
const MODEL_PROFILES=[{id:'ds-flash-vision-exp',label:'DS Flash Vision Exp',model:'deepseek-v4-flash-vision-exp',
  baseUrl:'https://api.deepseek.com/anthropic',protocol:'anthropic'}];
const root=path.resolve(__dirname,'..'),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const profile=MODEL_PROFILES.find(p=>p.id==='ds-flash-vision-exp');
const save=(dir,name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const read=(dir,name)=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const stripStructure=body=>{const copy=structuredClone(body);copy.messages[0].content=copy.messages[0].content.replace(/<document_structure>\n[\s\S]*?\n<\/document_structure>\n\n/,'').replace(' Section titles provide topic context only; preserve the local notation and do not generate headings.','');return copy;};
async function prepare(dir){
  assert.ok(!fs.existsSync(path.join(dir,'design.json')),'Use a new output directory');fs.mkdirSync(dir,{recursive:true});
  const baseline=read(path.join(__dirname,'.runs/harness-100-flash-0.1.18'),'results.json');
  const file=fs.existsSync(baseline.source.path)?baseline.source.path:'D:/Users/Ming/Desktop/动态规划教材（渲染修复副本）.md';
  const raw=fs.readFileSync(file);assert.equal(hash(raw),baseline.source.sha256,'Original textbook differs');
  const source=raw.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'),cases=[];
  for(const row of baseline.cases){
    assert.equal(source.slice(row.start,row.start+row.expected.length),row.expected,row.id);
    const fixture=source.slice(0,row.start)+source.slice(row.start+row.expected.length),start=Math.max(0,row.start-200),needle=fixture.slice(start,row.start+200);
    const document={version:1,getText:()=>fixture},t=performance.now(),cache=new StructureCache(document);
    const section=cache.forRequest(document,{needle,caret:row.start-start}),structureMs=performance.now()-t;cache.dispose();
    assert.ok(section.length>0&&section.length<=1200,row.id+' missing bounded headings');
    const payload={...row.payload,sectionContext:''},bodies={};
    for(const arm of ['off','on'])await requestAI(settings({...profile,ai:true}),'',{...payload,sectionContext:arm==='on'?section:''},undefined,async(_url,init)=>{bodies[arm]=JSON.parse(init.body);return new Response(JSON.stringify({content:[{type:'text',text:''}]}));});
    assert.deepEqual(stripStructure(bodies.on),bodies.off,row.id+' differs beyond heading feature');
    cases.push({id:row.id,label:row.label,line:row.line,kind:row.kind,start:row.start,expected:row.expected,payload,sectionContext:section,structureMs,requests:bodies});
  }
  assert.equal(cases.length,100);assert.equal(cases.filter(c=>c.kind==='math').length,70);assert.equal(cases.filter(c=>c.kind==='prose').length,30);
  // Shuffle sites, then balance AB/BA within each stratum; seed is recorded.
  const seed=crypto.randomBytes(16).toString('hex');
  const shuffled=list=>list.map(c=>({c,k:hash(seed+'|'+c.id)})).sort((a,b)=>a.k.localeCompare(b.k)).map(x=>x.c);
  const order=shuffled(['math','prose'].flatMap(kind=>shuffled(cases.filter(c=>c.kind===kind)).map((c,i)=>({id:c.id,kind,arms:i%2?['on','off']:['off','on']}))));
  const design={createdAt:new Date().toISOString(),model:profile.model,endpoint:'https://api.deepseek.com/anthropic/v1/messages',source:{...baseline.source,path:file},seed,cases:100,math:70,prose:30,plannedGenerationCalls:200,drawsPerArmPerSite:1,concurrency:1,retries:0,order,primaryMetric:'Directly usable semantic grade A, paired by gap; grades assigned with arm labels concealed.',grades:{A:'Fits the gap with correct meaning/notation; equivalent expressions accepted.',B:'Useful but needs a small manual correction.',C:'Wrong meaning/notation or fails the gap boundary.',D:'No usable output / service failure.'},method:'Same 100 previously captured editor contexts; both arms freshly generated now with production requestAI. Heading-on uses production StructureCache on the original document with the reference span removed. Fixed dataset offsets with a unique 400-character needle; no fresh UI latency measured. Only heading section and its production instruction differ.',latency:'Fetch through complete response and production cleanup; excludes automatic trigger debounce and UI display.',production:{core:hash(fs.readFileSync(path.join(root,'extension-src/out/completion/core.cjs'))),structure:hash(fs.readFileSync(path.join(root,'extension-src/out/completion/structure.cjs'))),policy:hash(fs.readFileSync(path.join(root,'extension-src/render/js/completion-policy.mjs')))}};
  save(dir,'design.json',design);save(dir,'cases.json',cases);save(dir,'blind-map.json',Object.fromEntries(cases.map(c=>[c.id,crypto.randomInt(2)?{X:'on',Y:'off'}:{X:'off',Y:'on'}])));
  console.log(JSON.stringify({output:dir,cases:100,plannedCalls:200,model:profile.model,originalUnchanged:hash(fs.readFileSync(file))===design.source.sha256}));
}
async function runLive(dir,resume=false){
  assert.ok(process.versions.electron,'Use the Electron launcher for native encrypted credentials');
  assert.ok(resume?fs.existsSync(path.join(dir,'results.json')):!fs.existsSync(path.join(dir,'results.json')),'Use resume for a partial run');
  // Windows safeStorage uses the encrypted OS-crypt key of its original
  // profile. No windows, sessions, app controllers or settings writers run.
  const {app}=require('electron');app.setName('markpilot');app.setPath('userData',path.join(process.env.APPDATA,'markpilot'));await app.whenReady();
  const design=read(dir,'design.json'),cases=read(dir,'cases.json');assert.equal(hash(fs.readFileSync(design.source.path)),design.source.sha256);
  const {CompletionVault}=require('../../Typora-Editor-App/app/main/completion-vault');
  const vaultFile=path.join(process.env.APPDATA,'markpilot/completion-secrets.json'),vaultHash=hash(fs.readFileSync(vaultFile));
  const vault=new CompletionVault({file:vaultFile});let key=await vault.get(credentialId(profile));assert.ok(key,'Saved DeepSeek key is unavailable');
  const result=resume?read(dir,'results.json'):{startedAt:new Date().toISOString(),designSha256:hash(fs.readFileSync(path.join(dir,'design.json'))),model:profile.model,rows:[]};
  assert.equal(result.designSha256,hash(fs.readFileSync(path.join(dir,'design.json'))));assert.ok(result.rows.length<200);
  if(resume){result.interruptions ||= [];result.interruptions.push({afterCalls:result.rows.length,reason:result.stoppedEarly,at:new Date().toISOString(),handling:'Keep the failed draw, no retry. Resume only unattempted scheduled requests; stop on terminal HTTP errors or three consecutive transport failures.'});delete result.stoppedEarly;delete result.finishedAt;}
  save(dir,'results.json',result);
  const katex=require('../extension-src/render/cdn/vditor/dist/js/katex/katex.min.js');
  const config=settings({...profile,ai:true});
  try{
    outer:for(const pair of design.order)for(const arm of pair.arms){
      if(result.rows.some(r=>r.id===pair.id&&r.arm===arm))continue;
      const sample=cases.find(c=>c.id===pair.id),row={id:sample.id,kind:sample.kind,arm,sequence:result.rows.length+1};result.rows.push(row);const start=performance.now();
      try{
        row.suggestion=await requestAI(config,key,{...sample.payload,sectionContext:arm==='on'?sample.sectionContext:''},AbortSignal.timeout(15000),async(url,init)=>{
          assert.equal(url,design.endpoint);assert.deepEqual(JSON.parse(init.body),sample.requests[arm],'Frozen request changed');
          const response=await fetch(url,init);row.httpStatus=response.status;const body=await response.clone().json().catch(()=>null);
          row.apiMs=performance.now()-start;row.responseModel=body?.model;row.usage=body?.usage;row.stopReason=body?.stop_reason;
          row.rawSuggestion=body?.content?.filter(c=>c.type==='text').map(c=>c.text).join('');return response;
        });
        row.totalMs=performance.now()-start;
        if(row.suggestion&&sample.kind==='math')try{katex.renderToString(sample.payload.mathBefore+row.suggestion+sample.payload.mathAfter,{displayMode:true,throwOnError:true,strict:'ignore'});row.katexValid=true;}catch{row.katexValid=false;}
        if(row.responseModel!==profile.model)result.stoppedEarly='unexpected_model';
      }catch(error){row.totalMs=performance.now()-start;row.error=error.name;}
      // Never persist credentials, request headers or untrusted error messages.
      if(row.httpStatus>=400)result.stoppedEarly='HTTP_'+row.httpStatus;
      if(row.error&&result.rows.slice(-3).length===3&&result.rows.slice(-3).every(r=>r.error))result.stoppedEarly ||= 'three_consecutive_errors';
      save(dir,'results.json',result);console.log(JSON.stringify({completed:result.rows.length,planned:200,http:row.httpStatus,ms:Math.round(row.totalMs),stop:result.stoppedEarly}));
      if(result.stoppedEarly)break outer;
    }
  }finally{key='';result.finishedAt=new Date().toISOString();result.originalUnchanged=hash(fs.readFileSync(design.source.path))===design.source.sha256;result.credentialsUnchanged=hash(fs.readFileSync(vaultFile))===vaultHash;save(dir,'results.json',result);}
  if(!result.stoppedEarly){
    const map=read(dir,'blind-map.json');save(dir,'blind-review.json',cases.map(c=>({id:c.id,line:c.line,kind:c.kind,expected:c.expected,heading:c.payload.heading,before:c.payload.before,after:c.payload.after,nearby:c.payload.nearby,mathBefore:c.payload.mathBefore,mathAfter:c.payload.mathAfter,...Object.fromEntries(['X','Y'].map(label=>[label,result.rows.find(r=>r.id===c.id&&r.arm===map[c.id][label]).suggestion]))})));
  }
  app.exit(result.stoppedEarly?2:0);
}
async function main(){
  const [mode,out]=process.argv.slice(2),dir=path.resolve(out||'test/.runs/heading-ab-2026-09-07');
  if(mode==='prepare')return prepare(dir);
  if(mode==='live'||mode==='resume-live')return runLive(dir,mode==='resume-live');
  if(mode==='launch'||mode==='resume'){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const n of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(n))delete env[n];
    const child=require('node:child_process').spawn(path.resolve(root,'../Typora-Editor-App/node_modules/electron/dist/electron.exe'),[__filename,mode==='resume'?'resume-live':'live',dir],{env,windowsHide:true,stdio:'inherit'});
    child.on('exit',code=>{process.exitCode=code??1;});child.on('error',()=>{console.error('Electron launcher failed');process.exitCode=1;});return;
  }
  throw new Error('Usage: heading-context-ab.cjs prepare|launch OUTPUT');
}
if(require.main===module || process.versions.electron&&process.type==='browser')main().catch(error=>{console.error(error.name==='AssertionError'?error.message:error.name);console.error(String(error.stack||'').split('\n').slice(1,5).join('\n'));if(process.versions.electron)require('electron').app.exit(1);else process.exitCode=1;});
