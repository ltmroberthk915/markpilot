import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve('.perf/split-navigation-regressions');fs.mkdirSync(output,{recursive:true});
const archive=path.resolve('dist/release-1.0.17-private-final/win-unpacked/resources/app.asar');
const results=[];
const tasks=[
  ['markdown-locations',['--test','scripts/markdown-locations.test.cjs']],
  ['source-toggle-host',['scripts/run-electron-test.mjs','source-toggle-host',archive]],
  ['math-history',['scripts/run-electron-test.mjs','math-history']],
];
for(const [name,args] of tasks){
  const log=path.join(output,name+'.log'),fd=fs.openSync(log,'w'),start=Date.now();
  const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore',fd,fd]});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});fs.closeSync(fd);
  results.push({name,args,code,seconds:(Date.now()-start)/1000,log});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  console.log(`${code===0?'PASS':'FAIL'} ${name} (${results.at(-1).seconds.toFixed(1)}s)`);
  if(code!==0){console.log(fs.readFileSync(log,'utf8').slice(-3500));process.exitCode=1;break;}
}
