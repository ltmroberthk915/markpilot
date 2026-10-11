'use strict';
// Reversible negative controls. An explicit source copy is required; never edit an artifact in use.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),acorn=require('acorn');
const {execFileSync}=require('node:child_process');const ROOT=path.resolve(__dirname,'../..');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const [mode,...argv]=process.argv.slice(2),opts={};
for(let i=0;i<argv.length;i+=2){if(!['--kind','--app','--baseline-ref'].includes(argv[i])||!argv[i+1])throw new Error('Invalid mutant option');opts[argv[i].slice(2)]=argv[i+1];}
if(!['on','off'].includes(mode)||!opts.app||!['window-sessions','receipt-revision','external-conflict','utf16-read','utf16-write'].includes(opts.kind))throw new Error('Use on|off --kind <mutation> --app <source copy> [--baseline-ref <commit>]');
const app=path.resolve(opts.app),stateDir=path.join(ROOT,'.mp-verify/quality-mutants');fs.mkdirSync(stateDir,{recursive:true});
if(app===path.join(ROOT,'MarkPilot-CM6'))throw new Error('Use a disposable source copy, not the product checkout');
const manifest=path.join(stateDir,opts.kind+'-'+hash(app).slice(0,12)+'.json');
const baseline=file=>execFileSync('git',['show',opts['baseline-ref']+':MarkPilot-CM6/'+file],{cwd:ROOT,maxBuffer:1024*1024});
function replaceOnce(source,anchor,value){if(source.split(anchor).length!==2)throw new Error('Mutation anchor must occur exactly once: '+anchor);return source.replace(anchor,value);}
function namedFunction(source,name){const nodes=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'}).body.filter(n=>n.type==='FunctionDeclaration'&&n.id.name===name);if(nodes.length!==1)throw new Error('Named function anchor: '+name);return nodes[0];}
function revertFunction(source,old,name){const a=namedFunction(source,name),b=namedFunction(old,name);return source.slice(0,a.start)+old.slice(b.start,b.end)+source.slice(a.end);}
let saved=fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest,'utf8')):null;
if(saved&&(saved.app!==app||saved.kind!==opts.kind))throw new Error('Mutant ownership changed');
if(mode==='off'){
 if(!saved?.active){console.log(JSON.stringify({kind:opts.kind,active:false,alreadyRestored:true}));process.exit(0);}
 for(const entry of saved.files){const file=path.join(app,entry.file);if(hash(fs.readFileSync(file))!==entry.mutantSha256)throw new Error('Mutated source changed; refusing to overwrite: '+entry.file);}
 for(const entry of saved.files){const bytes=Buffer.from(entry.before,'base64');if(hash(bytes)!==entry.beforeSha256)throw new Error('Backup integrity failed');fs.writeFileSync(path.join(app,entry.file),bytes);}
 saved.active=false;fs.writeFileSync(manifest,JSON.stringify(saved));console.log(JSON.stringify({kind:opts.kind,active:false,restored:true}));process.exit(0);
}
if(saved?.active){for(const entry of saved.files)if(hash(fs.readFileSync(path.join(app,entry.file)))!==entry.mutantSha256)throw new Error('Active mutant changed');console.log(JSON.stringify({kind:opts.kind,active:true,alreadyApplied:true}));process.exit(0);}
let files;
if(opts.kind==='window-sessions'){
 if(!opts['baseline-ref'])throw new Error('--baseline-ref is required for a genuine revision rollback');
 files=['main.js','preload.js','renderer/host.js'].map(file=>({file,mutant:baseline(file)}));
}else if(opts.kind.startsWith('utf16-')){
 if(!opts['baseline-ref'])throw new Error('--baseline-ref is required for a genuine codec rollback');
 const file='shell/text-codec.js',current=fs.readFileSync(path.join(app,file),'utf8'),old=baseline(file).toString('utf8'),fn=opts.kind==='utf16-read'?'decodeDocument':'encodeDocument';
 files=[{file,mutant:Buffer.from(revertFunction(current,old,fn))}];
}else{
 const file=opts.kind==='receipt-revision'?'renderer/host.js':'shell/document-store.js',current=fs.readFileSync(path.join(app,file),'utf8');
 const mutated=opts.kind==='receipt-revision'?replaceOnce(current,'dirty = revision !== capture.revision;','dirty = false;'):replaceOnce(current,"if((!baseline&&actual)||(baseline&&actual?.baseline.sha256!==baseline.sha256))","if(false && ((!baseline&&actual)||(baseline&&actual?.baseline.sha256!==baseline.sha256)))");
 files=[{file,mutant:Buffer.from(mutated)}];
}
saved={schema:1,kind:opts.kind,app,active:true,files:files.map(({file,mutant})=>{const before=fs.readFileSync(path.join(app,file));if(hash(before)===hash(mutant))throw new Error('Mutation has no effect: '+file);return {file,before:before.toString('base64'),beforeSha256:hash(before),mutantSha256:hash(mutant)};})};
fs.writeFileSync(manifest,JSON.stringify(saved));for(const entry of files)fs.writeFileSync(path.join(app,entry.file),entry.mutant);
console.log(JSON.stringify({kind:opts.kind,active:true,files:saved.files.map(({file,beforeSha256,mutantSha256})=>({file,beforeSha256,mutantSha256}))}));
