'use strict';
// Build candidates from an explicitly supplied runtime, without syncing/rebuilding the engine.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {ROOT,sha256}=require('./lifecycle.cjs');
const {outputDir}=require('./harness.cjs');
const options={},argv=process.argv.slice(2);
for(let i=0;i<argv.length;i+=2){if(!['--runtime','--rcedit','--out','--builder-cache'].includes(argv[i])||!argv[i+1])throw new Error('Use --runtime <Electron runtime> --rcedit <exe> --out <empty directory> [--builder-cache <offline cache>]');options[argv[i].slice(2)]=path.resolve(argv[i+1]);}
if(!options.runtime||!options.rcedit||!options.out)throw new Error('All three explicit paths are required');
const dir=outputDir(options.out,'candidate'),app=path.join(ROOT,'MarkPilot-CM6'),pkg=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
if(options['builder-cache'])process.env.ELECTRON_BUILDER_CACHE=options['builder-cache'];
const run=(file,args,extra={})=>execFileSync(file,args,{cwd:ROOT,stdio:'inherit',windowsHide:true,timeout:600000,...extra});
run(process.execPath,[path.join(__dirname,'stage-app.cjs'),'--runtime',options.runtime,'--out',path.join(dir,'stage')]);
const stage=JSON.parse(fs.readFileSync(path.join(dir,'stage/artifact.json'),'utf8')),unpacked=path.dirname(stage.executable);
assert(stage.files.find(f=>f.file==='renderer/cm6/markdown-worker.js')?.sha256,'Build the parser Worker before packaging');
run(options.rcedit,[stage.executable,'--set-icon',path.join(app,'build/icon.ico'),'--set-version-string','ProductName','MarkPilot','--set-version-string','FileDescription','MarkPilot — Markdown 编辑器','--set-file-version',pkg.version+'.0','--set-product-version',pkg.version]);
const resource=JSON.parse(execFileSync(process.env.MP_PWSH||'pwsh.exe',['-NoProfile','-NonInteractive','-Command',"$v=(Get-Item -LiteralPath $env:MP_CANDIDATE_EXE).VersionInfo; @{fileVersion=$v.FileVersion;productVersion=$v.ProductVersion;productName=$v.ProductName}|ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,env:{...process.env,MP_CANDIDATE_EXE:stage.executable},timeout:10000}));
assert.equal(resource.fileVersion,pkg.version+'.0');assert.equal(resource.productVersion,pkg.version);assert.equal(resource.productName,'MarkPilot');
const builder=path.join(app,'node_modules/electron-builder/out/cli/cli.js'),builderVersion=JSON.parse(fs.readFileSync(path.join(app,'node_modules/electron-builder/package.json'),'utf8')).version;
const config={...pkg.build,afterPack:null,directories:{output:path.join(dir,'production')}};
const configFile=path.join(dir,'production-config.json');fs.writeFileSync(configFile,JSON.stringify(config,null,2));
run(process.execPath,[builder,'--projectDir',app,'--config',configFile,'--win','nsis','portable','--x64','--prepackaged',unpacked]);
// The test installer has its own NSIS identity and creates no shortcuts. Its application payload is identical.
const testId='app.markpilot.quality.'+crypto.randomUUID().replaceAll('-','');
const isolated={...config,appId:testId,directories:{output:path.join(dir,'isolated')},nsis:{...config.nsis,oneClick:true,allowToChangeInstallationDirectory:false,perMachine:false,createDesktopShortcut:false,createStartMenuShortcut:false,deleteAppDataOnUninstall:false,runAfterFinish:false,artifactName:'markpilot-quality-Setup-'+pkg.version+'.${ext}'}};
const isolatedFile=path.join(dir,'isolated-config.json');fs.writeFileSync(isolatedFile,JSON.stringify(isolated,null,2));
run(process.execPath,[builder,'--projectDir',app,'--config',isolatedFile,'--win','nsis','--x64','--prepackaged',unpacked]);
const files=[];for(const folder of ['production','isolated'])for(const name of fs.readdirSync(path.join(dir,folder)).filter(f=>f.endsWith('.exe'))){const file=path.join(dir,folder,name);files.push({file:path.relative(dir,file).replaceAll('\\','/'),bytes:fs.statSync(file).size,sha256:sha256(file)});}
assert.equal(files.length,3,'Expected normal setup, portable and isolated test setup');
const result={schema:1,version:pkg.version,builderVersion,at:new Date().toISOString(),resource,exeSha256:sha256(stage.executable),asarSha256:stage.asarSha256,sourceFiles:stage.files,isolatedAppId:testId,files,published:false};
fs.writeFileSync(path.join(dir,'candidate.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
