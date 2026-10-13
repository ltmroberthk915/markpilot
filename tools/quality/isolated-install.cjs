'use strict';
// Install only the uniquely identified test NSIS package. Preserve existing MarkPilot entries.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {ROOT,sha256,acquireSlot}=require('./lifecycle.cjs');
const {outputDir}=require('./harness.cjs');
const [mode,...argv]=process.argv.slice(2),opts={};
for(let i=0;i<argv.length;i+=2){if(!['--candidate','--out'].includes(argv[i])||!argv[i+1])throw new Error('Use install|verify|uninstall --candidate <candidate directory> --out <owned verification directory>');opts[argv[i].slice(2)]=path.resolve(argv[i+1]);}
if(!['install','verify','uninstall'].includes(mode)||!opts.candidate||!opts.out)throw new Error('Explicit candidate and verification directories are required');
const privateRoot=path.join(ROOT,'.mp-verify'),absolute=opts.out;
if(!absolute.startsWith(privateRoot+path.sep))throw new Error('Install verification must remain inside .mp-verify');
const candidate=JSON.parse(fs.readFileSync(path.join(opts.candidate,'candidate.json'),'utf8'));
assert(candidate.isolatedAppId.startsWith('app.markpilot.quality.'),'Only a uniquely identified test installer is allowed');
const installerEntry=candidate.files.find(f=>f.file.startsWith('isolated/')&&f.file.endsWith('.exe'));assert(installerEntry);
const installer=path.join(opts.candidate,installerEntry.file);assert.equal(sha256(installer),installerEntry.sha256);
const release=acquireSlot(),stateFile=path.join(absolute,'install-state.json');
function registry(){
 const script="$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); $rows=@(foreach($root in $roots){Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue|ForEach-Object{$p=Get-ItemProperty -LiteralPath $_.PSPath;if($p.DisplayName -like 'MarkPilot*'){@{key=$_.Name;name=$p.DisplayName;version=$p.DisplayVersion;location=$p.InstallLocation;uninstall=$p.UninstallString}}}}); ConvertTo-Json -InputObject @($rows|Sort-Object key) -Compress";
 return JSON.parse(execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000}));
}
function preserved(before,after){for(const row of before)assert.deepEqual(after.find(e=>e.key===row.key),row,'Existing installation must remain identical: '+row.key);}
function uninstallerPath(row){const command=row.uninstall||'',match=command.match(/^"([^"]+\.exe)"/i)||command.match(/^(.+?\.exe)(?:\s|$)/i);assert(match,'An explicit uninstaller executable is required');return path.resolve(match[1]);}
function installationDirectory(row){return row.location?path.resolve(row.location):path.dirname(uninstallerPath(row));}
function run(exe,args){execFileSync(exe,args,{windowsHide:true,windowsVerbatimArguments:true,stdio:'inherit',timeout:180000});}
try{
 if(mode==='install'||mode==='verify'){
  let state;
  if(mode==='install'){
   outputDir(absolute,'install');const actualRoot=fs.realpathSync(absolute);assert(actualRoot.startsWith(fs.realpathSync(privateRoot)+path.sep));
   const target=path.join(actualRoot,'installed'),before=registry();assert(!fs.existsSync(target));
   // electron-builder 25 uses StdUtils.GetParameter: quote the value itself
   // when passing verbatim arguments, or a space truncates the target path.
   state={schema:1,isolatedAppId:candidate.isolatedAppId,target,before,installed:false};fs.writeFileSync(stateFile,JSON.stringify(state,null,2));run(installer,['/S','/D="'+target+'"']);
  }else{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.equal(state.isolatedAppId,candidate.isolatedAppId);assert.equal(path.dirname(state.target),fs.realpathSync(absolute));}
  const {before,target}=state,after=registry();preserved(before,after);
  const added=after.filter(e=>!before.some(b=>b.key===e.key));assert.equal(added.length,1,'Exactly one isolated uninstall entry is expected');
  assert.equal(installationDirectory(added[0]),target);assert.equal(sha256(path.join(target,'resources/app.asar')),candidate.asarSha256);assert.equal(sha256(path.join(target,'MarkPilot.exe')),candidate.exeSha256);
  Object.assign(state,{installed:true,after,added,exeSha256:candidate.exeSha256,asarSha256:candidate.asarSha256,at:new Date().toISOString()});fs.writeFileSync(stateFile,JSON.stringify(state,null,2));console.log(JSON.stringify({installed:true,target,previousInstallationsPreserved:before.length,exeSha256:state.exeSha256,asarSha256:state.asarSha256}));
 }else{
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.equal(state.isolatedAppId,candidate.isolatedAppId);assert.equal(path.dirname(state.target),fs.realpathSync(absolute));
  const before=registry();preserved(state.before,before);const added=state.added||before.filter(e=>!state.before.some(b=>b.key===e.key)&&installationDirectory(e)===state.target);
  assert.equal(added.length,1);const uninstaller=uninstallerPath(added[0]);assert.equal(path.dirname(uninstaller),state.target,'Uninstaller must belong to the owned test directory');
  run(uninstaller,['/S']);const end=Date.now()+15000;let after;
  do{execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-Command','Start-Sleep -Milliseconds 250'],{windowsHide:true,timeout:3000});after=registry();}while(after.some(e=>e.key===added[0].key)&&Date.now()<end);
  assert.deepEqual(after,state.before,'Uninstall must restore the original installation records');
  Object.assign(state,{uninstalled:true,afterUninstall:after,finishedAt:new Date().toISOString()});fs.writeFileSync(stateFile,JSON.stringify(state,null,2));console.log(JSON.stringify({uninstalled:true,previousInstallationsPreserved:after.length}));
 }
}finally{release();}
