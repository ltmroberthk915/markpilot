'use strict';
// Build an owned unpacked artifact with an explicitly supplied, matching Electron runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {outputDir}=require('./harness.cjs');
const ROOT=path.resolve(__dirname,'../..');
const argv=process.argv.slice(2),opts={};
for(let i=0;i<argv.length;i+=2){if(!['--runtime','--out','--asar-tool','--app'].includes(argv[i])||!argv[i+1])throw new Error('Use --runtime <directory> --out <empty directory> [--app <source copy>] [--asar-tool <module>]');opts[argv[i].slice(2)]=argv[i+1];}
if(!opts.runtime||!opts.out)throw new Error('--runtime and --out are required');
(async()=>{
 const out=outputDir(opts.out,'staged-app'),runtime=path.resolve(opts.runtime),source=path.resolve(opts.app||path.join(ROOT,'MarkPilot-CM6')),app=path.join(out,'app-source'),bin=path.join(out,'unpacked');
 const name=['electron.exe','MarkPilot.exe'].find(n=>fs.existsSync(path.join(runtime,n)));if(!name)throw new Error('Runtime executable is missing');
 // An installed application may supply the matching Electron runtime. Its
 // generated uninstaller belongs to that installation, never to a new payload.
 fs.cpSync(runtime,bin,{recursive:true,filter:f=>!['resources/app.asar','resources/default_app.asar','Uninstall MarkPilot.exe','uninstallerIcon.ico'].includes(path.relative(runtime,f).replaceAll('\\','/'))});
 if(name!=='MarkPilot.exe')fs.renameSync(path.join(bin,name),path.join(bin,'MarkPilot.exe'));
 fs.mkdirSync(app);
 for(const rel of ['package.json','main.js','preload.js','export-folder.js','export-pdf.js','shell','renderer','build'])fs.cpSync(path.join(source,rel),path.join(app,rel),{recursive:true});
 fs.mkdirSync(path.join(bin,'resources'),{recursive:true});
 const asar=require(path.resolve(opts['asar-tool']||path.join(ROOT,'MarkPilot-CM6/node_modules/@electron/asar')));
 await asar.createPackage(app,path.join(bin,'resources/app.asar'));
 const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 const artifact={schema:1,executable:path.join(bin,'MarkPilot.exe'),exeSha256:hash(path.join(bin,'MarkPilot.exe')),asarSha256:hash(path.join(bin,'resources/app.asar')),version:JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version,
  files:require('./artifact-files.cjs').map(file=>({file,sha256:fs.existsSync(path.join(source,file))?hash(path.join(source,file)):null}))};
 fs.writeFileSync(path.join(out,'artifact.json'),JSON.stringify(artifact,null,2));console.log(JSON.stringify(artifact));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
