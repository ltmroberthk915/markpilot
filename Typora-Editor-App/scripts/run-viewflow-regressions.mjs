import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve(process.env.VIEWFLOW_FINAL_OUTPUT||'.perf/viewflow-final-v2');fs.mkdirSync(output,{recursive:true});
const archive=path.resolve('dist/release-1.0.18-private-final/win-unpacked/resources/app.asar');
const results=[];
const tasks=[
  ['nested-math',['scripts/run-split-navigation.mjs',archive],{SPLIT_NAV_SUITE:'nestedmath',SPLIT_NAV_OUTPUT:path.join(output,'nested-math')}],
  ['viewflow',['scripts/run-split-navigation.mjs',archive],{SPLIT_NAV_SUITE:'viewflow',SPLIT_NAV_OUTPUT:path.join(output,'viewflow')}],
  ['split-navigation',['scripts/run-split-navigation.mjs',archive],{SPLIT_NAV_SUITE:'navigation',SPLIT_NAV_OUTPUT:path.join(output,'navigation')}],
  ['math-table',['scripts/run-math-table.mjs',archive],{MATH_TABLE_OUTPUT:path.join(output,'math-table')}],
  ['chat-selection',['scripts/run-split-navigation.mjs',archive],{SPLIT_NAV_SUITE:'selection',SPLIT_NAV_OUTPUT:path.join(output,'chat-selection')}],
  ['markdown-locations',['--test','scripts/markdown-locations.test.cjs']],
  ['source-toggle-host',['scripts/run-electron-test.mjs','source-toggle-host',archive]],
  ['math-history',['scripts/run-electron-test.mjs','math-history',archive]],
];
for(const [name,args,extra] of tasks){
  const log=path.join(output,name+'.log'),fd=fs.openSync(log,'w'),start=Date.now(),env={...process.env,...extra};delete env.VIEWFLOW_PHASE;
  const child=spawn(process.execPath,args,{windowsHide:true,env,stdio:['ignore',fd,fd]});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});fs.closeSync(fd);
  results.push({name,args,code,seconds:(Date.now()-start)/1000,log});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  console.log(`${code===0?'PASS':'FAIL'} ${name} (${results.at(-1).seconds.toFixed(1)}s)`);
  if(code!==0){console.log(fs.readFileSync(log,'utf8').slice(-2500));process.exitCode=1;break;}
}
