// Runs exactly one reviewable task. Check for user interruption before starting
// another task; no unattended chain of GUI suites is launched here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),extensionProject=path.resolve(project,'../Typora-Editor');
const task=process.argv[2];if(!task)throw Error('Specify one test task');
// A second GUI suite must never take focus while a previous one is alive.
const guard=path.join(project,'.perf/release100-gui-active.json');fs.mkdirSync(path.dirname(guard),{recursive:true});
if(fs.existsSync(guard)){
  const active=JSON.parse(fs.readFileSync(guard,'utf8'));let alive=true;
  try{process.kill(active.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  if(alive)throw Error('Another GUI task is active: '+active.task+' (PID '+active.pid+')');
  fs.unlinkSync(guard);
}
fs.writeFileSync(guard,JSON.stringify({task,pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});
process.on('exit',()=>{try{if(JSON.parse(fs.readFileSync(guard,'utf8')).pid===process.pid)fs.unlinkSync(guard);}catch{}});
const output=path.resolve(process.env.RELEASE100_ROOT||path.join(project,'.perf/release100-source'),task+'-'+Date.now());fs.mkdirSync(output,{recursive:true});
const archive=path.resolve(process.env.RELEASE100_ARCHIVE||project),extension=path.resolve(process.env.RELEASE100_EXTENSION||path.join(extensionProject,'extension-src'));
const env={...process.env};
for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(name)||/^MD_EDITOR_(?:CHAT|FOCUS|COMPLETION|NAV)_ONLY$/.test(name))delete env[name];
for(const name of ['ELECTRON_RUN_AS_NODE','MD_EDITOR_SMOKE_PROFILE','MD_EDITOR_CHAT_HOLD_DIR','SPLIT_NAV_HOLD','SPLIT_NAV_SUITE','SPLIT_NAV_OUTPUT','MATH_TABLE_HOLD','MATH_TABLE_CASES','NESTED_MATH_CASES','VIEWFLOW_PHASE','TEST_NATIVE_FOREGROUND'])delete env[name];
let args,cwd=project,executionScope;
if(/^(trae|vscode)-(focus|chat|full)$/.test(task)){
  const [host,mode]=task.split('-');cwd=extensionProject;
  args=['test/vscode-smoke.cjs',host==='trae'?'C:/Users/Ming/AppData/Local/Programs/Trae/Trae.exe':'D:/Program Files/Microsoft VS Code/Code.exe',extension];
  env.MD_EDITOR_BACKGROUND='1';
  if(mode!=='full')env.MD_EDITOR_CHAT_ONLY='1';
  if(mode==='focus')env.MD_EDITOR_FOCUS_ONLY='1';
  if(mode==='focus'&&env.RELEASE100_MANUAL_HOLD){
    const hold=path.join(output,'manual');fs.mkdirSync(hold,{recursive:true});
    env.MD_EDITOR_CHAT_HOLD_DIR=hold;
  }
  if(host==='trae')env.MD_EDITOR_SMOKE_PROFILE=path.join(extensionProject,'test/.runs/vscode-1788852017792/profile');
  executionScope='isolated real IDE; '+extension;
}else if(['nested-math','viewflow','quality-boundaries','navigation','selection','benchmark-before','benchmark-after'].includes(task)){
  const benchmark=task.startsWith('benchmark-');env.SPLIT_NAV_SUITE=benchmark?'benchmark':task==='nested-math'?'nestedmath':task;
  env.SPLIT_NAV_OUTPUT=output;
  if(task==='quality-boundaries'){env.SPLIT_NAV_SUITE='viewflow';env.VIEWFLOW_PHASE='boundaries';}
  args=['scripts/run-split-navigation.mjs',task==='benchmark-before'?path.join(project,'dist/release-1.0.18-private-final/win-unpacked/resources/app.asar'):archive];
  executionScope='real main/preload/iframe; '+args[1];
}else if(task==='math-table'){
  env.MATH_TABLE_OUTPUT=output;env.MATH_TABLE_SOAK_ROUNDS='50';args=['scripts/run-math-table.mjs',archive];executionScope='real main/preload/iframe; '+archive;
}else if(task==='file-launch'){
  env.RELEASE100_OUTPUT=output;args=['scripts/run-file-launch-tests.mjs',archive];executionScope='real desktop launch workflows; '+archive;
}else{
  const hostModes=['workflow-gaps','shell','completion','protection','export','export-large','media-office','media-repro','media-lifecycle','table-context-host','table-input-host','source-toggle-host','user-file-host'];
  const rendererModes=['regression','consistency','features','repairs','ui','source-history','math-history','math-colors','math-boundaries','reading','mermaid','table-context','history-large','theme-audit'];
  if(![...hostModes,...rendererModes].includes(task))throw Error('Unknown task: '+task);
  env.RELEASE100_OUTPUT=output;args=['scripts/run-electron-test.mjs',task];
  if(hostModes.includes(task)){args.push(archive);executionScope='real main/preload/iframe; '+archive;}
  else executionScope='shared renderer in dedicated Electron harness; '+path.join(project,'app/renderer');
}
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const treeHash=root=>{
  const all=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?all(path.join(dir,e.name)):[path.join(dir,e.name)]);
  const files=all(root).sort(),h=crypto.createHash('sha256');
  for(const file of files)h.update(path.relative(root,file).replaceAll('\\','/')+'\0'+hash(file)+'\n');
  return{root,files:files.length,sha256:h.digest('hex')};
};
const manifest={task,startedAt:new Date().toISOString(),output,executionScope,args,cwd,launcherPid:process.pid,sourceVersions:{app:JSON.parse(fs.readFileSync(path.join(project,'package.json'))).version,extension:JSON.parse(fs.readFileSync(path.join(extension,'package.json'))).version},scriptHashes:{}};
manifest.testOptions=Object.fromEntries(['RELEASE100_GAPS_FILTER','RELEASE100_HISTORY_PROFILE','RELEASE100_MANUAL_HOLD','MD_EDITOR_CHAT_HOLD_DIR','MD_EDITOR_CHAT_ONLY','MD_EDITOR_FOCUS_ONLY','VIEWFLOW_PHASE','MATH_TABLE_SOAK_ROUNDS','TYPORA_OFFICE_NATIVE'].filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
manifest.sourceTrees=[path.join(project,'app/main'),path.join(project,'app/renderer'),path.join(project,'app/shared'),path.join(project,'app/shell'),path.join(project,'app/preload'),path.join(extension,'out'),path.join(extension,'render')].map(treeHash);
const inputArchive=args.find(value=>value.endsWith('.asar'));
if(inputArchive)manifest.archiveSHA256=hash(inputArchive);
for(const file of [...new Set([fileURLToPath(import.meta.url),path.join(cwd,args[0])])])manifest.scriptHashes[file]=hash(file);
for(const dir of [path.join(project,'scripts'),path.join(extensionProject,'test')]){
  for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isFile()&&/\.(?:c?js|mjs|ps1)$/.test(name))manifest.scriptHashes[file]=hash(file);}
}
const log=path.join(output,'process.log'),fd=fs.openSync(log,'w');
const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:['ignore',fd,fd]});manifest.pid=child.pid;
fs.writeFileSync(path.join(output,'task.json'),JSON.stringify(manifest,null,2));console.log('Task output: '+output);
const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});fs.closeSync(fd);
const text=fs.readFileSync(log,'utf8');manifest.exitCode=code;manifest.finishedAt=new Date().toISOString();
manifest.ideOutput=text.match(/Isolated VSCode test output: ([^\r\n]+)/)?.[1];
manifest.passed=code===0&&!fs.existsSync(path.join(output,'fatal.txt'));
if(manifest.ideOutput){
  const file=path.join(manifest.ideOutput,'results.json');manifest.passed&&=fs.existsSync(file);
  if(fs.existsSync(file))manifest.checks=JSON.parse(fs.readFileSync(file)).results.length;
}
fs.writeFileSync(path.join(output,'task.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({task,passed:manifest.passed,exitCode:code,output,ideOutput:manifest.ideOutput,checks:manifest.checks},null,2));
if(!manifest.passed)process.exitCode=1;
