// Release evidence for the desktop export/auth update. Never count old VSIX runs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const directory=path.join(root,`dist/release-${version}-final`),archive=path.join(directory,'win-unpacked/resources/app.asar');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(path.join(dir,item.name)):[path.join(dir,item.name)]);
const appFiles=files(path.join(root,'app'));
for(const file of appFiles)assert.ok(fs.readFileSync(file).equals(asar.extractFile(archive,path.relative(root,file))),'ASAR mismatch '+file);
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,version);
const renderer=path.resolve(root,'../Typora-Editor/extension-src/render'),rendererFiles=files(renderer);
for(const file of rendererFiles)assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(root,'app/renderer',path.relative(renderer,file)))),'renderer mismatch '+file);
const logs=[['export',`export-packaged-${version}.log`,28],['snapshots/autosave',`protection-packaged-${version}.log`,10],['AI/local completion',`completion-packaged-${version}.log`,17],['shared toolbar/formatting/Mermaid',`features-${version}.log`,66],['image/edit/save host','shell-auth.log',31],['file association launch',`file-launch-${version}.log`,22],['shipping executable',`exe-launch-${version}.log`,4]];
const checks=logs.map(([label,file,expected])=>{
  const filename=path.join(root,'.perf',file),text=fs.readFileSync(filename,'utf8');
  assert.ok(!/^FAIL|^Error:/m.test(text),file);const count=(text.match(/^PASS /gm)||[]).length;assert.equal(count,expected,file);
  return {label,count,path:filename};
});
const unitFile=path.join(root,'.perf',`unit-${version}.log`),units=fs.readFileSync(unitFile,'utf8');assert.match(units,/tests 71/);assert.match(units,/fail 0/);
const security=fs.readFileSync(path.join(root,'.perf/export-security-units.log'),'utf8');assert.match(security,/tests 16/);assert.match(security,/fail 0/);
checks.push({label:'unit tests (71 + 3 image/export units; authentication counted once)',count:74,path:unitFile});
const book=JSON.parse(fs.readFileSync(path.join(root,'.perf/export-book.json')));assert.ok(book.results.length===2&&book.results.every(result=>result.phase==='done'&&result.formulas===2844&&!result.warnings.length));
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(book.source)).digest('hex'),book.sourceSHA256);
const artifacts=[`markpilot-Setup-${version}.exe`,`markpilot-v${version}-portable.exe`].map(name=>{
  const file=path.join(root,'dist',name),data=fs.readFileSync(file);assert.ok(data.equals(fs.readFileSync(path.join(directory,name))));return {path:file,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
});
const report={desktopVersion:version,checkedAt:new Date().toISOString(),packagedFiles:appFiles.length,sharedRendererFiles:rendererFiles.length,checks,totalChecks:checks.reduce((n,item)=>n+item.count,0)+2,bookExport:book,mathBenchmark:path.join(root,'.perf/math-engine-benchmark-lean.json'),artifacts,installation:'Packages generated and tested; production user installation was not launched.'};
fs.writeFileSync(path.join(root,`docs/release-${version}.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({version,packagedFiles:report.packagedFiles,checks:report.totalChecks,artifacts},null,2));
