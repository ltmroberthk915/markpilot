// Runs Node-only tests. It never starts an IDE, Electron, browser or GUI helper.
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),extension=path.resolve(project,'../Typora-Editor');
const output=path.resolve(process.argv[2]||path.join(project,'.perf/release100-background'));fs.mkdirSync(output,{recursive:true});
const files=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(root,e.name)):[path.join(root,e.name)]).sort();
const tests=[path.join(project,'scripts'),path.join(extension,'test')].flatMap(root=>fs.readdirSync(root).filter(n=>/\.test\.(cjs|mjs)$/.test(n)).map(n=>path.join(root,n))).sort();
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report={startedAt:new Date().toISOString(),scope:'Node-only; no desktop input or GUI process',tests:tests.map(file=>({path:file,sha256:digest(file)}))};
report.productFiles=[path.join(project,'app'),path.join(extension,'extension-src/out'),path.join(extension,'extension-src/render')].flatMap(files).map(file=>({path:file,sha256:digest(file)}));
const log=path.join(output,'node-tests.tap'),fd=fs.openSync(log,'w');
const env={...process.env};for(const k of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_?KEY|AUTH_KEY|CREDENTIAL/i.test(k))delete env[k];
const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-concurrency=2',...tests],{cwd:project,env,windowsHide:true,stdio:['ignore',fd,fd]});
report.testExitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});fs.closeSync(fd);
const tap=fs.readFileSync(log,'utf8');report.counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>[k,Number(tap.match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1]??NaN)]));
const syntaxRoots=[path.join(project,'app/main'),path.join(extension,'extension-src/out'),path.join(extension,'extension-src/render/js')];
report.syntax=[];
for(const file of syntaxRoots.flatMap(files).filter(p=>/\.(js|cjs|mjs)$/.test(p))){const r=spawnSync(process.execPath,['--check',file],{windowsHide:true,encoding:'utf8',env});report.syntax.push({path:file,sha256:digest(file),code:r.status,error:r.status===0?undefined:r.stderr||r.error?.message});}
const shared=path.join(extension,'extension-src/render'),desktop=path.join(project,'app/renderer'),names=files(shared).map(f=>path.relative(shared,f));
const mismatches=names.filter(n=>!fs.existsSync(path.join(desktop,n))||digest(path.join(shared,n))!==digest(path.join(desktop,n)));
report.sharedRenderer={files:names.length,mismatches,extra:files(desktop).map(f=>path.relative(desktop,f)).filter(n=>!names.includes(n))};
report.publicArtifacts=JSON.parse(fs.readFileSync(path.join(project,'.perf/viewflow-delivery/public-before.json'),'utf8')).map(e=>({...e,unchanged:digest(path.resolve(project,e.path))===e.sha256}));
report.currentVersions={desktop:JSON.parse(fs.readFileSync(path.join(project,'package.json'))).version,vsix:JSON.parse(fs.readFileSync(path.join(extension,'extension-src/package.json'))).version};
report.productUnchanged=report.productFiles.every(f=>fs.existsSync(f.path)&&digest(f.path)===f.sha256);
report.finishedAt=new Date().toISOString();report.passed=report.productUnchanged&&report.testExitCode===0&&report.counts.tests>0&&report.counts.fail===0&&report.counts.cancelled===0&&report.counts.skipped===0&&report.syntax.every(r=>r.code===0)&&!mismatches.length&&!report.sharedRenderer.extra.length&&report.publicArtifacts.every(e=>e.unchanged);
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,counts:report.counts,syntaxFiles:report.syntax.length,sharedRenderer:report.sharedRenderer,publicUnchanged:report.publicArtifacts.every(e=>e.unchanged),output},null,2));
if(!report.passed){console.log(tap.slice(-5000));process.exitCode=1;}
