const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),plugin=path.resolve(root,'../Typora-Editor'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),version=pkg.version;
const extension=path.join(plugin,'extension-src'),extensionVersion=JSON.parse(fs.readFileSync(path.join(extension,'package.json'))).version;
const release=path.join(root,`dist/release-${version}-final`),archive=path.join(release,'win-unpacked/resources/app.asar');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const appFiles=files(path.join(root,'app'));
for(const file of appFiles)assert.ok(fs.readFileSync(file).equals(asar.extractFile(archive,path.relative(root,file))),'ASAR differs: '+file);
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,version);
const compare=(source,destination)=>{const list=files(source);for(const file of list)assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(destination,path.relative(source,file)))),'Copy differs: '+file);assert.equal(list.length,files(destination).length);return list.length;};
const rendererFiles=compare(path.join(extension,'render'),path.join(root,'app/renderer'));
const completionFiles=compare(path.join(extension,'out/completion'),path.join(root,'app/shared/out/completion'));
assert.ok(fs.readFileSync(path.join(extension,'render/js/completion-policy.mjs')).equals(fs.readFileSync(path.join(root,'app/shared/render/js/completion-policy.mjs'))));
const unpackedVsix=path.join(plugin,'test/.runs/vsix-0.1.22-final/extension');
const extensionFiles=compare(extension,unpackedVsix);
assert.ok(fs.readFileSync(path.join(plugin,'vsix-meta/extension.vsixmanifest')).equals(fs.readFileSync(path.join(unpackedVsix,'../extension.vsixmanifest'))));
const checks=[];
for(const [label,name,expected] of [['heading/completion units','structure-units.log',33],['desktop state/completion units','reading-app-units.log',18]]){
  const file=path.join(root,'.perf',name),text=fs.readFileSync(file,'utf8');assert.match(text,new RegExp('tests '+expected));assert.match(text,/fail 0/);checks.push({label,count:expected,path:file});
}
for(const [label,name,expected] of [['reading palettes and stationary outline','reading-test.log',12],['editing/outline/find UI regression','ui-reading.log',42],['packaged desktop completion and palette persistence','completion-reading-packaged.log',23]]){
  const file=path.join(root,'.perf',name),text=fs.readFileSync(file,'utf8');assert.ok(!/^FAIL|^AssertionError|^Error:/m.test(text),file);assert.equal((text.match(/^PASS /gm)||[]).length,expected);checks.push({label,count:expected,path:file});
}
for(const [label,id] of [['VS Code','1788713084952'],['Trae packaged VSIX','1788713324368']]){
  const file=path.join(plugin,'test/.runs','vscode-'+id,'results.json'),data=JSON.parse(fs.readFileSync(file));assert.equal(data.results.length,101);assert.ok(data.results.every(r=>r.startsWith('PASS ')));
  checks.push({label,count:data.results.length,path:file,engineVersion:data.vscode,extensionVersionDuringRun:data.version,note:label==='VS Code'?'Source run before metadata-only version bump; renderer and host code are identical to the final VSIX.':'Extracted final VSIX; all extension files verified byte-for-byte.'});
}
const local=JSON.parse(fs.readFileSync(path.join(root,'.perf/heading-benchmark.json')));assert.equal(digest(fs.readFileSync(local.file)),local.sha256,'Original textbook changed');
const artifacts=[...['Setup-'+version,'v'+version+'-portable'].map(s=>path.join(root,'dist','markpilot-'+s+'.exe')),path.join(plugin,'dist','markpilot-'+extensionVersion+'.vsix')].map(file=>{
  const data=fs.readFileSync(file);if(file.endsWith('.exe'))assert.ok(data.equals(fs.readFileSync(path.join(release,path.basename(file)))));return{path:file,bytes:data.length,sha256:digest(data)};
});
const report={desktopVersion:version,extensionVersion,checkedAt:new Date().toISOString(),packagedFiles:appFiles.length,sharedRendererFiles:rendererFiles,sharedCompletionFiles:completionFiles+1,extensionFiles,checks,totalAutomatedChecks:checks.reduce((n,c)=>n+c.count,0),headingBenchmark:{path:path.join(root,'.perf/heading-benchmark.json'),characters:local.characters,headings:local.headings,coldMs:local.coldMs,lookupP95Ms:local.lookupP95Ms,structureCharacters:local.structureCharacters,apiCalls:0},themeAudit:path.join(root,'.perf/theme-compatibility.json'),limitations:['No online LLM quality or latency A/B evaluation. API regressions use local mock servers.','General-purpose Typora CSS import remains a scoped compatibility/cost exploration.','VS Code behavior run preceded the metadata-only version bump; Trae ran the final extracted VSIX.'],artifacts,installation:'Packages built and verified; production installations and Windows file associations were not changed.'};
fs.writeFileSync(path.join(root,`docs/release-${version}.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({version,extensionVersion,checks:report.totalAutomatedChecks,packagedFiles:appFiles.length,sharedRendererFiles:rendererFiles,artifacts},null,2));
