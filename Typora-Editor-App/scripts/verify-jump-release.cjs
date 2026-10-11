const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),version=pkg.version;
const directory=path.join(root,`dist/release-${version}-final`),archive=path.join(directory,'win-unpacked/resources/app.asar');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(path.join(dir,item.name)):[path.join(dir,item.name)]);
const appFiles=files(path.join(root,'app'));
for(const file of appFiles)assert.ok(fs.readFileSync(file).equals(asar.extractFile(archive,path.relative(root,file))),'ASAR mismatch '+file);
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,version);
assert.equal(require('../app/main/jump-list').APP_ID,pkg.build.appId,'pinned shortcut and runtime AppUserModelID must match');
const renderer=path.resolve(root,'../Typora-Editor/extension-src/render'),rendererFiles=files(renderer);
for(const file of rendererFiles)assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(root,'app/renderer',path.relative(renderer,file)))),'renderer mismatch '+file);
const checks=[['packaged file/new launch','jump-launch-packaged.log',30],['shipping executable and native Jump List',`exe-jump-${version}.log`,6]].map(([label,name,count])=>{
  const file=path.join(root,'.perf',name),text=fs.readFileSync(file,'utf8');assert.ok(!/^FAIL|^Error:/m.test(text),file);assert.equal((text.match(/^PASS /gm)||[]).length,count,file);return{label,count,path:file};
});
const unitFile=path.join(root,'.perf/jump-units.log'),units=fs.readFileSync(unitFile,'utf8');assert.match(units,/tests 44/);assert.match(units,/fail 0/);checks.push({label:'unit tests',count:44,path:unitFile});
const ui=JSON.parse(fs.readFileSync(path.join(root,'.perf/new-ui-active.json'))),uiState=JSON.parse(fs.readFileSync(path.join(ui.profile,'state.json'))),created=path.join(ui.fixtures,'未命名.md');
assert.equal(uiState.lastFile,created);assert.equal(uiState.recentFiles[0],created);assert.equal(fs.readFileSync(created,'utf8'),'');
assert.equal(fs.readFileSync(path.join(ui.fixtures,'previous.md'),'utf8'),'# Previous file remains intact\n');
const artifacts=[`markpilot-Setup-${version}.exe`,`markpilot-v${version}-portable.exe`].map(name=>{
  const file=path.join(root,'dist',name),data=fs.readFileSync(file);assert.ok(data.equals(fs.readFileSync(path.join(directory,name))));return{path:file,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
});
const report={desktopVersion:version,checkedAt:new Date().toISOString(),packagedFiles:appFiles.length,sharedRendererFiles:rendererFiles.length,checks,totalAutomatedChecks:checks.reduce((n,c)=>n+c.count,0),nativeDialogCheck:{output:ui.output,created,previousFilePreserved:true,observation:'Cold --new-md opened the native Save dialog; cancellation retained the session file; Ctrl+N created the empty document and displayed its editor.'},taskbarUiLimit:'No automatic pin/right-click on the Windows taskbar; persisted native Shell Links and their actual launches were verified.',artifacts,installation:'Packages built and verified; production installation and pins were not changed.'};
fs.writeFileSync(path.join(root,`docs/release-${version}.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({version,packagedFiles:report.packagedFiles,checks:report.totalAutomatedChecks,artifacts},null,2));
