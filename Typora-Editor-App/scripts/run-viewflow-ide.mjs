import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const project=path.resolve('../Typora-Editor'),output=path.resolve(process.env.VIEWFLOW_FINAL_OUTPUT||'.perf/viewflow-final-v8'),extension=path.join(project,'test/.runs/vsix-private-0.1.28-viewflow-v8-final/extension');
const results=[];
for(const [name,executable,chat,profile] of [
  ['vscode-full','D:/Program Files/Microsoft VS Code/Code.exe',false],
  ['vscode-chat','D:/Program Files/Microsoft VS Code/Code.exe',true],
  ['trae-chat','C:/Users/Ming/AppData/Local/Programs/Trae/Trae.exe',true,path.join(project,'test/.runs/vscode-1788852017792/profile')],
]){
  const env={...process.env};delete env.MD_EDITOR_CHAT_ONLY;delete env.MD_EDITOR_SMOKE_PROFILE;delete env.MD_EDITOR_COMPLETION_ONLY;delete env.MD_EDITOR_NAV_ONLY;
  env.MD_EDITOR_BACKGROUND='1';
  if(chat)env.MD_EDITOR_CHAT_ONLY='1';if(profile)env.MD_EDITOR_SMOKE_PROFILE=profile;
  const log=path.join(output,name+'.log'),fd=fs.openSync(log,'w'),start=Date.now();
  const child=spawn(process.execPath,['test/vscode-smoke.cjs',executable,extension],{cwd:project,env,windowsHide:true,stdio:['ignore',fd,fd]});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});fs.closeSync(fd);
  const location=/Isolated VSCode test output: (.+)/.exec(fs.readFileSync(log,'utf8'))?.[1].trim();
  const record={name,code,seconds:(Date.now()-start)/1000,log,location};
  if(location&&fs.existsSync(path.join(location,'results.json'))){const result=JSON.parse(fs.readFileSync(path.join(location,'results.json')));record.checks=result.results.length;record.host=result.host||'VSCode';}
  results.push(record);fs.writeFileSync(path.join(output,'ide-results.json'),JSON.stringify(results,null,2));
  console.log(`${code===0?'PASS':'FAIL'} ${name}: ${record.checks??0} checks (${record.seconds.toFixed(1)}s)`);
  if(code!==0){console.log('Inspect '+log);process.exitCode=1;break;}
}
