const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),plugin=path.resolve(root,'../Typora-Editor'),extension=path.join(plugin,'extension-src');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,extensionVersion=JSON.parse(fs.readFileSync(path.join(extension,'package.json'))).version;
const release=path.join(root,`dist/release-${version}-final`),archive=path.join(release,'win-unpacked/resources/app.asar'),previous=path.join(root,'dist/release-1.0.12-final/win-unpacked/resources/app.asar');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const appFiles=files(path.join(root,'app')),changed=[];
for(const file of appFiles){const key=path.relative(root,file),data=fs.readFileSync(file);assert.ok(data.equals(asar.extractFile(archive,key)),file);if(!data.equals(asar.extractFile(previous,key)))changed.push(key.replaceAll('\\','/'));}
assert.deepEqual(changed,['app/renderer/css/reading-palette.css']);
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,version);
const compare=(a,b)=>{const source=files(a);for(const file of source)assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(b,path.relative(a,file)))),file);assert.equal(source.length,files(b).length);return source.length;};
const sharedRendererFiles=compare(path.join(extension,'render'),path.join(root,'app/renderer'));
const extracted=path.join(plugin,'test/.runs/vsix-'+extensionVersion.replace('-local','')+'-final/extension'),extensionFiles=compare(extension,extracted);
assert.ok(fs.readFileSync(path.join(plugin,'vsix-meta/extension.vsixmanifest')).equals(fs.readFileSync(path.join(extracted,'../extension.vsixmanifest'))));
const checks=[['packaged source/caret/preview colors','math-colors-packaged.log',48],['packaged reading/outline regression','reading-1.0.13.log',12],['math undo/redo and continued editing','math-history-1.0.13.log',8]].map(([label,name,count])=>{
  const file=path.join(root,'.perf',name),text=fs.readFileSync(file,'utf8');assert.ok(!/^FAIL|^AssertionError|^Error:/m.test(text),file);assert.equal((text.match(/^PASS /gm)||[]).length,count);return{label,count,path:file};
});
const before=JSON.parse(fs.readFileSync(path.join(root,'.perf/math-colors-before.json'))),after=JSON.parse(fs.readFileSync(path.join(root,'.perf/math-colors.json')));
assert.equal(before.samples.length,48);assert.equal(before.failures.length,4);assert.equal(after.samples.length,48);assert.equal(after.failures.length,0);
const artifacts=[...['Setup-'+version,'v'+version+'-portable'].map(s=>path.join(root,'dist','markpilot-'+s+'.exe')),path.join(plugin,'dist','markpilot-'+extensionVersion+'.vsix')].map(file=>{const data=fs.readFileSync(file);if(file.endsWith('.exe'))assert.ok(data.equals(fs.readFileSync(path.join(release,path.basename(file)))));return{path:file,bytes:data.length,sha256:hash(data)};});
const baseline=JSON.parse(fs.readFileSync(path.join(root,'docs/release-1.0.12.json')));
const report={desktopVersion:version,extensionVersion,checkedAt:new Date().toISOString(),packagedFiles:appFiles.length,sharedRendererFiles,extensionFiles,changedAppFilesSince1_0_12:changed,checks,newAutomatedChecks:checks.reduce((n,c)=>n+c.count,0),baselineVerification:{path:path.join(root,'docs/release-1.0.12.json'),checks:baseline.totalAutomatedChecks,note:'JavaScript and host logic are byte-identical to the previously verified release; only reading-palette.css and package metadata changed.'},beforeAfter:{combinations:48,oldUnreadable:4,newUnreadable:0},artifacts,installation:'Packages built and verified; install/reload the new version to apply. Production installations were not changed.'};
fs.writeFileSync(path.join(root,`docs/release-${version}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
