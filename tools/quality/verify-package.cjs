'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRequire}=require('node:module');const {spawnSync}=require('node:child_process');
const {ROOT,sha256}=require('./lifecycle.cjs');const {outputDir}=require('./harness.cjs');
const opts={},argv=process.argv.slice(2);
for(let i=0;i<argv.length;i+=2){if(!['--candidate','--7zip','--out'].includes(argv[i])||!argv[i+1])throw new Error('Use --candidate <directory> --7zip <7za.exe> --out <empty directory>');opts[argv[i].slice(2)]=path.resolve(argv[i+1]);}
if(!opts.candidate||!opts['7zip']||!opts.out)throw new Error('All three explicit paths are required');
const out=outputDir(opts.out,'payload'),manifest=JSON.parse(fs.readFileSync(path.join(opts.candidate,'candidate.json'),'utf8'));
const asar=createRequire(path.join(ROOT,'MarkPilot-CM6/package.json'))('@electron/asar'),digest=b=>crypto.createHash('sha256').update(b).digest('hex'),files=[];
function inventory(root,dir=root){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
 const file=path.join(dir,entry.name);if(entry.isDirectory())return inventory(root,file);
 assert(entry.isFile(),'Only regular payload files are expected: '+file);
 return{file:path.relative(root,file).replaceAll('\\','/'),bytes:fs.statSync(file).size,sha256:sha256(file)};
}).sort((a,b)=>a.file.localeCompare(b.file));}
const runtime=inventory(path.join(opts.candidate,'stage/unpacked')),source=inventory(path.join(opts.candidate,'stage/app-source'));
const expectedSource=new Map(source.map(row=>[row.file,row]));
for(const [i,entry]of manifest.files.entries()){
 const archive=path.join(opts.candidate,entry.file);assert.equal(sha256(archive),entry.sha256);
 const dest=path.join(out,'payload-'+i);fs.mkdirSync(dest);
 const r=spawnSync(opts['7zip'],['x',archive,'-o'+dest,'-y'],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:1048576});
 assert([0,1].includes(r.status),'7zip failed: '+r.stderr); // 7zip's NSIS trailing-data warning is recorded; hashes still must match.
 const app=path.join(dest,'resources/app.asar'),exe=path.join(dest,'MarkPilot.exe');assert.equal(sha256(app),manifest.asarSha256);assert.equal(sha256(exe),manifest.exeSha256);
 const sources=manifest.sourceFiles.map(f=>{const actual=digest(asar.extractFile(app,path.normalize(f.file)));assert.equal(actual,f.sha256);return{file:f.file,sha256:actual};});
 const members=asar.listPackage(app).map(name=>name.replaceAll('\\','/').replace(/^\//,'')).filter(name=>!asar.statFile(app,path.normalize(name)).files).map(name=>{
  const expected=expectedSource.get(name);assert(expected,'Unexpected ASAR member: '+name);const bytes=asar.extractFile(app,path.normalize(name));assert.equal(bytes.length,expected.bytes,name);assert.equal(digest(bytes),expected.sha256,name);return expected;
 }).sort((a,b)=>a.file.localeCompare(b.file));assert.deepEqual(members,source,'Complete ASAR member set and bytes');
 const extracted=inventory(dest),expectedRuntime=new Set(runtime.map(row=>row.file));
 for(const row of runtime)assert.deepEqual(extracted.find(actual=>actual.file===row.file),row,'Complete runtime payload: '+row.file);
 const extras=extracted.filter(row=>!expectedRuntime.has(row.file));
 // NSIS bootstrap/uninstall metadata is outside the application payload.
 for(const row of extras)assert(row.file.startsWith('$PLUGINSDIR/')||/^(Uninstall MarkPilot\.exe|uninstallerIcon\.ico)$/.test(row.file),'Unexpected packaged application file: '+row.file);
 files.push({file:entry.file,archiveSha256:entry.sha256,exeSha256:manifest.exeSha256,asarSha256:manifest.asarSha256,sources,completeAsarMembers:members,completeRuntime:runtime,installerMetadata:extras,extractExitCode:r.status,matched:true});
}
const result={schema:1,at:new Date().toISOString(),version:manifest.version,files,passed:files.length===3};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
