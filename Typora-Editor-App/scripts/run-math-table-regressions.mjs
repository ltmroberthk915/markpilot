import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve('.perf/math-table-regressions');fs.mkdirSync(output,{recursive:true});
const cases=process.argv.slice(2);
const names=cases.length?cases:['math-history','math-colors','math-boundaries','regression','consistency','repairs','ui','table-context','table-context-host','table-input-host','source-toggle-host','shell'];
const results=[];
for(const name of names){
  const log=path.join(output,name+'.log'),fd=fs.openSync(log,'w');
  const start=Date.now();
  const child=spawn(process.execPath,['scripts/run-electron-test.mjs',name],{windowsHide:true,stdio:['ignore',fd,fd]});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});fs.closeSync(fd);
  results.push({name,code,seconds:(Date.now()-start)/1000,log});fs.writeFileSync(path.join(output,'results-'+names.join('-')+'.json'),JSON.stringify(results,null,2));
  console.log(`${code===0?'PASS':'FAIL'} ${name} (${results.at(-1).seconds.toFixed(1)}s)`);
  if(code!==0){console.log(fs.readFileSync(log,'utf8').slice(-3500));process.exitCode=1;break;}
}
