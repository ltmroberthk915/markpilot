// Verifies already-built private artifacts; it never builds, installs or publishes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),asar=require('@electron/asar'),{pathToFileURL}=require('node:url');
(async()=>{
  const project=path.resolve(__dirname,'..'),extension=path.resolve(project,'../Typora-Editor/extension-src');
  const release=path.resolve(process.argv[2]||path.join(project,'dist/release-1.0.0-private-final'));
  const vsix=path.resolve(process.argv[3]||path.join(extension,'../dist/markpilot-1.0.0.vsix'));
  const output=path.resolve(process.argv[4]||path.join(project,'.perf/release100-delivery'));fs.mkdirSync(output,{recursive:true});
  const archive=path.join(release,'win-unpacked/resources/app.asar');
  // Version policy: the patch component increments per delivery; every build
  // input and artifact must agree on the version declared in the App package.
  const version=JSON.parse(fs.readFileSync(path.join(project,'package.json'))).version;
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  const names=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?names(path.join(root,e.name)).map(n=>e.name+'/'+n):[e.name]).sort();
  const {unzipSync}=await import(pathToFileURL(path.join(extension,'render/js/vendor/fflate.mjs')));
  const zip=unzipSync(fs.readFileSync(vsix)),get=name=>{assert.ok(zip[name],name+' missing from VSIX');return Buffer.from(zip[name]);};
  const packageSource=JSON.parse(fs.readFileSync(path.join(extension,'package.json'))),packageVsix=JSON.parse(get('extension/package.json'));
  const packageApp=JSON.parse(asar.extractFile(archive,'package.json'));
  assert.equal(packageApp.version,version);assert.equal(packageVsix.version,version);assert.deepEqual(packageVsix,packageSource);
  assert.match(get('extension.vsixmanifest').toString(),new RegExp('<Identity\\b[^>]*\\bVersion="'+version.replace(/[.\\]/g,'\\$&')+'"'));
  assert.equal(get('extension.vsixmanifest').toString(),fs.readFileSync(path.join(extension,'../vsix-meta/extension.vsixmanifest'),'utf8'));
  assert.notEqual(packageVsix.markpilotDistribution,'public');assert.equal(packageVsix.publisher,'markpilot');
  assert.ok(packageVsix.contributes.commands.some(c=>c.command==='markpilot.addSelectionToChat'));
  assert.ok(!(packageVsix.contributes.keybindings||[]).some(c=>c.command==='markpilot.addSelectionToChat'));
  const renderer=path.join(extension,'render'),desktop=path.join(project,'app/renderer'),shared=names(renderer),files=[];
  assert.deepEqual(names(desktop),shared);
  assert.deepEqual(Object.keys(zip).filter(n=>n.startsWith('extension/render/')&&!n.endsWith('/')).map(n=>n.slice(17)).sort(),shared);
  for(const name of shared){
    const expected=hash(fs.readFileSync(path.join(renderer,name)));
    for(const [label,data] of [['desktop source',fs.readFileSync(path.join(desktop,name))],['ASAR',asar.extractFile(archive,path.join('app/renderer',name))],['VSIX',get('extension/render/'+name)]])assert.equal(hash(data),expected,label+' mismatch: '+name);
    files.push({path:name,sha256:expected});
  }
  const host=[];
  for(const name of names(path.join(extension,'out'))){const digest=hash(fs.readFileSync(path.join(extension,'out',name)));assert.equal(hash(get('extension/out/'+name)),digest,'VSIX host mismatch: '+name);host.push({path:name,sha256:digest});}
  const desktopFiles=[];
  for(const name of names(path.join(project,'app'))){
    const digest=hash(fs.readFileSync(path.join(project,'app',name)));
    assert.equal(hash(asar.extractFile(archive,path.join('app',name))),digest,'ASAR application mismatch: '+name);
    desktopFiles.push({path:'app/'+name,sha256:digest});
  }
  for(const name of names(path.join(extension,'out/completion'))){
    const expected=hash(fs.readFileSync(path.join(extension,'out/completion',name)));
    assert.equal(hash(fs.readFileSync(path.join(project,'app/shared/out/completion',name))),expected,'Desktop shared completion source mismatch: '+name);
    assert.equal(hash(asar.extractFile(archive,path.join('app/shared/out/completion',name))),expected,'ASAR shared completion mismatch: '+name);
  }
  const policy=hash(fs.readFileSync(path.join(extension,'render/js/completion-policy.mjs')));
  assert.equal(hash(asar.extractFile(archive,path.join('app','shared','render','js','completion-policy.mjs'))),policy,'ASAR shared completion policy mismatch');
  // 2.1.23：公版产线与 build-flavor 标记一起去掉了（只留一个发行版）。
  assert.ok(!names.includes('extension/out/completion/build-flavor.cjs'),'flavor flag must be gone');
  assert.ok(!names.includes('extension/render/js/build-flavor.mjs'),'renderer flavor flag must be gone');
  const publicArtifacts=JSON.parse(fs.readFileSync(path.join(project,'.perf/viewflow-delivery/public-before.json')));
  for(const a of publicArtifacts)assert.equal(hash(fs.readFileSync(path.resolve(project,a.path))),a.sha256,'Public artifact changed: '+a.path);
  const artifacts=[path.join(release,'markpilot-Setup-'+version+'.exe'),path.join(release,'markpilot-v'+version+'-portable.exe'),archive,vsix].map(file=>({path:file,sha256:hash(fs.readFileSync(file)),bytes:fs.statSync(file).size,modifiedAt:fs.statSync(file).mtime.toISOString()}));
  const report={checkedAt:new Date().toISOString(),verified:true,version,rendererFiles:shared.length,files,hostFiles:host,desktopFiles,publicArtifacts,artifacts,scope:'Artifact byte coherence only. GUI and manual acceptance evidence is required separately.'};
  fs.writeFileSync(path.join(output,'coherence.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({verified:true,rendererFiles:shared.length,hostFiles:host.length,publicArtifactsUnchanged:true,artifacts},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
