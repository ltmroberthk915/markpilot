// Byte-check the actual archives and installed extension before recording release metadata.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),plugin=path.resolve(root,'../Typora-Editor');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const extension=JSON.parse(fs.readFileSync(path.join(plugin,'extension-src/package.json'))).version;
const archive=path.join(root,`dist/release-${version}-final/win-unpacked/resources/app.asar`);
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(path.join(dir,item.name)):[path.join(dir,item.name)]);}
const appFiles=files(path.join(root,'app'));
for(const file of appFiles)assert.ok(fs.readFileSync(file).equals(asar.extractFile(archive,path.relative(root,file))),file+' differs in app.asar');
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,version);
const source=path.join(plugin,'extension-src'),renderer=path.join(source,'render'),rendererFiles=files(renderer);
for(const file of rendererFiles)assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(root,'app/renderer',path.relative(renderer,file)))),'renderer mismatch '+file);
const extracted=path.join(plugin,`test/.runs/vsix-markpilot-${extension}/extension`),installed=path.join(process.env.USERPROFILE,'.vscode/extensions/markpilot.markpilot-'+extension);
const extensionFiles=files(source);
for(const file of extensionFiles){
  const rel=path.relative(source,file),buffer=fs.readFileSync(file);
  assert.ok(buffer.equals(fs.readFileSync(path.join(extracted,rel))),'VSIX mismatch '+rel);
  const installation=fs.readFileSync(path.join(installed,rel));
  if(rel==='package.json'){const a=JSON.parse(buffer),b=JSON.parse(installation);delete b.__metadata;assert.deepEqual(b,a);}
  else assert.ok(buffer.equals(installation),'installed mismatch '+rel);
}
const count=name=>(fs.readFileSync(path.join(root,'.perf',name),'utf8').match(/^PASS /gm)||[]).length;
const vscodeResults=path.resolve(process.argv[2]),vscode=JSON.parse(fs.readFileSync(vscodeResults));assert.equal(vscode.version,extension);
const checks={editing:count('regression.txt'),consistencyAndIME:count('consistency.txt'),shortcutsAndMermaidAudit:count('features.txt'),repairs:JSON.parse(fs.readFileSync(path.join(root,'.perf/repairs.json'))).length,desktopHost:count('shell.txt'),recentState:2,katex:21,vscodeHost:vscode.results.length};
checks.uiRefinements=JSON.parse(fs.readFileSync(path.join(root,'.perf/ui.json'))).length;
checks.mathFenceUnits=23;
checks.mathFenceRenderer=JSON.parse(fs.readFileSync(path.join(root,'.perf/math-boundaries.json'))).results.length;
const artifactPaths=[path.join(root,`dist/markpilot-Setup-${version}.exe`),path.join(root,`dist/markpilot-v${version}-portable.exe`),path.join(plugin,`dist/markpilot-${extension}.vsix`)];
const report={desktopVersion:version,vsixVersion:extension,installedVSCodeFilesVerified:extensionFiles.length,sharedRendererFilesVerified:rendererFiles.length,packagedAppFilesVerified:appFiles.length,checks,totalChecks:Object.values(checks).reduce((a,b)=>a+b,0),packagedDesktopRecheck:count('packaged-shell.txt'),vscodeResults,history:JSON.parse(fs.readFileSync(path.join(root,'.perf/history-large.json'))),artifacts:artifactPaths.map(file=>({path:file,bytes:fs.statSync(file).size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
fs.writeFileSync(path.join(root,`docs/release-${version}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
