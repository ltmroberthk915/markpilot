'use strict';
// Serial GUI arms in owned source copies; bounded child execution and exact restore.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),sha=f=>hash(fs.readFileSync(f));
function repositoryRoot(start){let p=fs.realpathSync(start);for(;;){if(fs.existsSync(path.join(p,'tools/quality/lifecycle.cjs'))&&fs.existsSync(path.join(p,'MarkPilot-CM6/main.js')))return p;const q=path.dirname(p);if(p===q)throw Error('Repository not found');p=q;}}
const ROOT=repositoryRoot(__dirname),argv=process.argv.slice(2),opts={};
for(let i=0;i<argv.length;i+=2){assert(['--runtime','--out','--kinds'].includes(argv[i])&&argv[i+1],'Invalid argument');opts[argv[i].slice(2)]=argv[i+1];}
assert(opts.runtime&&opts.out,'Use --runtime <explicit Electron directory> --out <empty owned output> [--kinds <comma-separated roots>]');
const within=(a,b)=>{const r=path.relative(a,b);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const requested=path.resolve(opts.out),verifyRoot=fs.realpathSync(path.join(ROOT,'.mp-verify'));
assert(within(verifyRoot,requested),'Output under .mp-verify');let ancestor=requested;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);const realAncestor=fs.realpathSync(ancestor);assert(realAncestor===verifyRoot||within(verifyRoot,realAncestor),'Output ancestor containment');
const runtime=fs.realpathSync(opts.runtime),{outputDir}=require(path.join(ROOT,'tools/quality/harness.cjs'));
const dir=fs.realpathSync(outputDir(requested,'protocol-mutations')),copy=path.join(dir,'source'),mutator=path.join(__dirname,'protocol-mutate.cjs');
assert(within(ROOT,dir)&&within(path.join(ROOT,'.mp-verify'),dir),'Output must stay under checkout .mp-verify');
const marker={owner:'markpilot-quality',schema:1,protocolMutationOwner:dir,sourceRoot:ROOT};
fs.writeFileSync(path.join(dir,'quality-run.json'),JSON.stringify(marker));fs.mkdirSync(copy);fs.writeFileSync(path.join(copy,'quality-run.json'),JSON.stringify(marker));
const definitions=[
 {kind:'image-pending-load',suite:'images',fails:['http-image-copy-save-use-original-bytes'],controls:[],error:/Timed out waiting for this HTTP fixture decoded at its exact source URL/},
 {kind:'image-command',suite:'images',fails:['delete-image-html'],controls:[],error:/image source command returns keyboard focus to the editor/},
 {kind:'region-eof',suite:'region-workflows',fails:['source-owned-table-eof'],controls:[],error:/literal content edit retains the producer-owned region/},
 {kind:'cell-observer',suite:'reload-workflows',fails:['native-cell-selection-maps-without-command-flush'],controls:['persistent-native-control-during-read'],error:/master source follows current DOM without a command flush/},
 {kind:'save-as-focus',suite:'reload-workflows',fails:['new-input-after-store-adoption'],controls:['new-input-before-disk-read'],error:/Save As returns the prior source input owner/},
 {kind:'watcher-recovery',suite:'reload-workflows',fails:['save-error-recovery-save-as-returns-source-owner'],controls:['new-input-before-disk-read'],error:/Timed out waiting for recovery Save As writes actual source/},
 {kind:'async-cut-owner',suite:'command-workflows',fails:['async-context-cut-selection-race'],controls:['async-context-cut-normal'],error:/Independent complete literal source/},
 {kind:'region-footprint',suite:'incremental-workflows',fails:['parent-list-context-invalidates-inactive-block'],controls:['inline-formula-local-body'],error:/inactive block immediately rebinds the removed list parent/},
];
const selected=opts.kinds?opts.kinds.split(','):definitions.map(d=>d.kind);assert(selected.length&&new Set(selected).size===selected.length,'Unique mutation roots');for(const k of selected)assert(definitions.some(d=>d.kind===k),'Unknown mutation root');
const parts=['dsh-markpilot/src-cm6','dsh-markpilot/renderer','dsh-markpilot/package.json','Typora-Editor-App/app/renderer/js/user-theme.mjs',...['package.json','main.js','preload.js','export-folder.js','export-pdf.js','shell','renderer','build'].map(p=>'MarkPilot-CM6/'+p)];
function filesUnder(base){const result=[];function visit(p){const stat=fs.lstatSync(p);assert(!stat.isSymbolicLink(),'No symlink input: '+p);if(stat.isDirectory()){for(const n of fs.readdirSync(p).sort())visit(path.join(p,n));}else if(stat.isFile())result.push(p);}visit(base);return result;}
const inputs=[...new Set(parts.flatMap(p=>filesUnder(path.join(ROOT,p))).concat(fs.readdirSync(path.join(ROOT,'tools/quality')).filter(n=>n.endsWith('.cjs')).map(n=>path.join(ROOT,'tools/quality',n))))];
const sourceIdentity=Object.fromEntries(inputs.map(f=>[path.relative(ROOT,f).replaceAll('\\','/'),sha(f)]));
const frozenBundle=fs.readFileSync(path.join(ROOT,'MarkPilot-CM6/renderer/cm6/app.js'));
const sourceUnchanged=()=>{for(const [f,h]of Object.entries(sourceIdentity))assert.equal(sha(path.join(ROOT,f)),h,'SourceROOT unchanged: '+f);};
for(const part of parts){const dest=path.join(copy,part);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(ROOT,part),dest,{recursive:true});}
const restored=()=>{for(const part of parts)for(const f of filesUnder(path.join(ROOT,part))){const rel=path.relative(ROOT,f);assert.equal(sha(path.join(copy,rel)),sourceIdentity[rel.replaceAll('\\','/')],'Exact restored copy: '+rel);}sourceUnchanged();};
const esbuild=require(path.join(ROOT,'dsh-markpilot/node_modules/esbuild')),asar=require(path.join(ROOT,'MarkPilot-CM6/node_modules/@electron/asar'));
const result={schema:1,startedAt:new Date().toISOString(),runtime,sourceIdentity,selectedKinds:selected,mutations:[],passed:false};
let cleanupVerified=true,activeKind=null;
function invoke(args){return execFileSync(process.execPath,args,{cwd:ROOT,stdio:'inherit',windowsHide:true,timeout:180000});}
function mutation(mode,kind){invoke([mutator,mode,'--root',copy,'--owned-root',dir,'--kind',kind]);}
function build(){assert(cleanupVerified,'No build while previous GUI cleanup unverified');esbuild.buildSync({absWorkingDir:path.join(copy,'dsh-markpilot'),entryPoints:['src-cm6/main.js'],bundle:true,format:'iife',minify:true,outfile:path.join(copy,'MarkPilot-CM6/renderer/cm6/app.js'),loader:{'.woff':'file','.woff2':'file','.ttf':'file'},nodePaths:[path.join(ROOT,'dsh-markpilot/node_modules')],logLevel:'error'});return sha(path.join(copy,'MarkPilot-CM6/renderer/cm6/app.js'));}
function ownStage(tag){const out=path.join(dir,tag);assert(within(dir,out));invoke(['tools/quality/stage-app.cjs','--runtime',runtime,'--app',path.join(copy,'MarkPilot-CM6'),'--out',out]);const real=fs.realpathSync(out);assert(within(dir,real));const m=JSON.parse(fs.readFileSync(path.join(real,'quality-run.json'),'utf8'));assert.equal(m.owner,'markpilot-quality');fs.writeFileSync(path.join(real,'protocol-stage.json'),JSON.stringify(marker));
 const artifact=JSON.parse(fs.readFileSync(path.join(real,'artifact.json'),'utf8')),archive=path.join(real,'unpacked/resources/app.asar');assert.equal(sha(archive),artifact.asarSha256);
 const manifest={};for(const name of asar.listPackage(archive)){const archiveRel=name.replace(/^[/\\]+/,''),rel=archiveRel.replaceAll('\\','/'),stat=asar.statFile(archive,archiveRel);if(stat.files)continue;assert(!stat.link,'No archive links');const input=path.join(copy,'MarkPilot-CM6',rel);assert(within(path.join(copy,'MarkPilot-CM6'),input));manifest[rel]=hash(asar.extractFile(archive,archiveRel));assert.equal(manifest[rel],sha(input),'Full ASAR resource bytes: '+rel);}
 const expected=filesUnder(path.join(copy,'MarkPilot-CM6')).map(f=>path.relative(path.join(copy,'MarkPilot-CM6'),f).replaceAll('\\','/')).sort();assert.deepEqual(Object.keys(manifest).sort(),expected,'Complete packaged resource set');
 const receipt={...artifact,fullResourceManifest:manifest};fs.writeFileSync(path.join(dir,tag+'-artifact.json'),JSON.stringify(receipt,null,2));return{out:real,artifact:receipt};}
function clean(stage){if(!stage)return;assert(cleanupVerified,'Leave stage intact when live cleanup unverified');const real=fs.realpathSync(stage.out);assert(within(dir,real)&&!fs.existsSync(path.join(real,'.git')),'Cleanup containment');const m=JSON.parse(fs.readFileSync(path.join(real,'protocol-stage.json'),'utf8'));assert.equal(m.protocolMutationOwner,dir);assert.equal(m.sourceRoot,ROOT);assert.equal(JSON.parse(fs.readFileSync(path.join(real,'quality-run.json'),'utf8')).owner,'markpilot-quality');assert.equal(execFileSync('git',['ls-files','-z','--',path.relative(ROOT,real).replaceAll('\\','/')],{cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:10000}),'','Tracked files prohibit stage removal');fs.rmSync(real,{recursive:true,force:true});}
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function arm(def,stage,negative){const out=path.join(dir,(negative?'negative-':'positive-')+def.kind),ids=[...def.fails,...def.controls],filter='^('+ids.map(escape).join('|')+')$';cleanupVerified=false;
 const suiteEnv={...process.env,MP_QUALITY_CASES:filter},suiteExtra=[];
 if(def.suite==='images'){assert.equal(ids.length,1,'Images mutation selects exactly one --case');suiteExtra.push('--case',ids[0]);delete suiteEnv.MP_QUALITY_CASES;}
 const child=spawnSync(process.execPath,['tools/quality/'+def.suite+'.cjs','--exe',stage.artifact.executable,'--expected-sha256',stage.artifact.exeSha256,'--out',out,...suiteExtra],{cwd:ROOT,env:suiteEnv,stdio:'inherit',windowsHide:true,timeout:180000});
 assert(!child.error&&!child.signal,'Suite child exceeded bound or failed launch; cleanup is unverified');const report=JSON.parse(fs.readFileSync(path.join(out,'result.json'),'utf8'));assert.deepEqual(report.cleanup?.residual,[],'No residual GUI processes');assert(!report.cleanupError&&!(report.cleanupErrors||[]).length,'Cleanup completed');cleanupVerified=true;
 assert.equal(child.status,negative?1:0,'Mutant must RED; restored must GREEN');assert.deepEqual(report.cases.map(c=>c.id).sort(),ids.slice().sort(),'Exact selected cases');assert(!(report.errors||[]).length,'No unrelated page errors');
 const actuals=report.artifacts?.length?report.artifacts:[report.metadata||report.artifact];assert(actuals.length,'Actual artifact metadata');for(const actual of actuals){assert(actual&&!actual.sourceMode,'Actual packaged run');assert.equal(actual.asarSha256,stage.artifact.asarSha256,'Actual full ASAR binds complete resource manifest');assert.equal(actual.runtimeExecutableSha256,stage.artifact.exeSha256,'Actual runtime');for(const f of stage.artifact.files)assert.equal(actual.artifactFiles.find(x=>x.file===f.file)?.sha256,f.sha256,'Actual packaged loaded resource: '+f.file);}
 for(const item of report.cases){const fail=negative&&def.fails.includes(item.id);assert.equal(item.status,fail?'fail':'pass','Specific case outcome '+item.id);if(fail)assert.match(item.error,def.error,'Specific original oracle, not arbitrary failure');}
 if(def.suite==='images')assert.equal(report.clipboardCleanup?.restored,true,'Images independent clipboard restoration');
 else if(['region-workflows','command-workflows'].includes(def.suite))assert.equal(report.clipboard?.restored,true,'Held clipboard restored');
 else assert(!Object.hasOwn(report,'clipboard'),'Suite has no clipboard contract');
 if(!negative)assert.equal(report.passed,true);sourceUnchanged();return report;}
let baseline;
try{baseline=build();assert.equal(baseline,sourceIdentity['MarkPilot-CM6/renderer/cm6/app.js'],'Rebuild equals frozen bundle');restored();result.baselineEngine=baseline;
 for(const def of definitions.filter(d=>selected.includes(d.kind))){let red,green;activeKind=def.kind;
  try{mutation('on',def.kind);mutation('on',def.kind);const mutantEngine=build();sourceUnchanged();red=ownStage('stage-'+def.kind);const redAsar=red.artifact.asarSha256,negative=arm(def,red,true);clean(red);red=null;
   mutation('off',def.kind);mutation('off',def.kind);assert.equal(build(),baseline);restored();green=ownStage('restored-'+def.kind);assert.notEqual(green.artifact.asarSha256,redAsar,'Mutation reached full staged ASAR');const positive=arm(def,green,false);const entry={kind:def.kind,suite:def.suite,fails:def.fails,controls:def.controls,expectedError:def.error.source,negativeErrors:negative.cases.filter(c=>c.status==='fail').map(c=>({id:c.id,error:c.error})),mutantEngine,restoredEngine:baseline,redAsar,greenAsar:green.artifact.asarSha256,idempotentOnOff:true,sourceRestored:true,passed:positive.passed};clean(green);green=null;result.mutations.push(entry);
  }finally{mutation('off',def.kind);activeKind=null;if(cleanupVerified){assert.equal(build(),baseline);restored();clean(red);clean(green);}else{fs.writeFileSync(path.join(copy,'MarkPilot-CM6/renderer/cm6/app.js'),frozenBundle);restored();}sourceUnchanged();}
 }
 result.passed=result.mutations.length===selected.length;
}catch(e){result.fatal=e.stack||e.message;process.exitCode=1;}
finally{try{if(activeKind)mutation('off',activeKind);fs.writeFileSync(path.join(copy,'MarkPilot-CM6/renderer/cm6/app.js'),frozenBundle);restored();sourceUnchanged();result.checkoutUnchanged=true;}catch(e){result.checkoutUnchanged=false;result.passed=false;result.restoreError=e.stack||e.message;process.exitCode=1;}result.cleanupVerified=cleanupVerified;result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({passed:result.passed,total:result.mutations.length,fatal:result.fatal,cleanupVerified}));
