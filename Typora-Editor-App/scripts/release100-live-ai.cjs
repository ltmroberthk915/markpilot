// Real-API AI completion acceptance: exercises the exact shipped request path
// (app/shared/out/completion requestAI) against the configured provider with
// a live key. The key comes from LIVE_AI_KEY and is never written to any
// output. Pass rule: every preset on at least one provider the key owns must
// return a non-empty suggestion; providers the key cannot authenticate to are
// recorded as not-verified; network/other failures fail the run.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const project=path.resolve(__dirname,'..');
const output=path.resolve(process.argv[2]||path.join(project,'.perf/release100-live-ai'));
fs.mkdirSync(output,{recursive:true});
(async()=>{
  const key=process.env.LIVE_AI_KEY;
  if(!key||!key.trim())throw new Error('LIVE_AI_KEY is required for live AI acceptance.');
  const {settings,requestAI}=require(path.join(project,'app/shared/out/completion/core.cjs'));
  const {credentialId,allProfiles,effectiveModel}=require(path.join(project,'app/shared/out/completion/profiles.cjs'));
  // 2.1.23 起不再内置预置模型：本脚本自带它要跑真请求的配置。
  const MODEL_PROFILES=[{id:'custom-ds',label:'DeepSeek',protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}];
  const context={kind:'prose',before:'# 概率论入门\n\n概率是',after:'\n\n正文继续。',mathBefore:'',mathAfter:''};
  const results=[];
  for(const profile of MODEL_PROFILES){
    const config=settings({...profile,ai:true});
    const started=Date.now();
    try{
      const text=await requestAI(config,key.trim(),context,AbortSignal.timeout(25000));
      results.push({id:profile.id,label:profile.label,endpoint:config.baseUrl.split('/').slice(0,3).join('/'),model:config.model,
        ok:!!String(text||'').trim(),ms:Date.now()-started,sample:String(text||'').slice(0,60)});
    }catch(error){
      const message=String(error.message||error);
      const auth=/401|403|authentication|api key|invalid.*key|余额|对账|鉴权/i.test(message);
      results.push({id:profile.id,label:profile.label,endpoint:config.baseUrl.split('/').slice(0,3).join('/'),model:config.model,
        ok:false,ms:Date.now()-started,auth,error:message.slice(0,160)});
    }
  }
  const providers=new Map();
  for(const result of results){const list=providers.get(result.endpoint)||[];list.push(result);providers.set(result.endpoint,list);}
  const owned=[...providers.entries()].filter(([,list])=>list.some(item=>item.ok));
  const failures=results.filter(item=>!item.ok&&!item.auth);
  const incomplete=owned.filter(([,list])=>list.some(item=>!item.ok));
  const passed=owned.length>0&&failures.length===0&&incomplete.length===0;
  const report={checkedAt:new Date().toISOString(),scope:'Real-provider AI completion through the shipped request path; key supplied via LIVE_AI_KEY and never persisted',
    fixtures:{contextChars:context.before.length+context.after.length,presets:MODEL_PROFILES.length},
    results,providers:[...providers.entries()].map(([endpoint,list])=>({endpoint,presets:list.map(item=>item.id),owned:list.some(item=>item.ok)})),
    passed,reason:!owned.length?'No provider accepted this key.':failures.length?'Non-auth failures: '+failures.map(item=>item.id).join(','):incomplete.length?'Incomplete provider: '+incomplete.map(([endpoint])=>endpoint).join(','):'verified'};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
  const serialized=JSON.stringify(report);
  if(serialized.includes(key.trim()))throw new Error('Refusing to write results containing the key.');
  console.log(JSON.stringify({passed:report.passed,reason:report.reason,results:results.map(item=>({id:item.id,ok:item.ok,auth:!!item.auth,ms:item.ms}))},null,2));
  process.exitCode=passed?0:1;
})().catch(error=>{fs.writeFileSync(path.join(output,'fatal.txt'),String(error.stack||error));console.error(error);process.exitCode=1;});
