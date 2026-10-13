'use strict';
// Reversible Worker faults in an explicitly owned application copy.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {ROOT}=require('./lifecycle.cjs');
const [mode,...argv]=process.argv.slice(2),options={};
for(let i=0;i<argv.length;i+=2){assert(['--app','--kind'].includes(argv[i])&&argv[i+1],'Use on|off --app owned-copy --kind missing-script|timeout|protocol-mismatch');options[argv[i].slice(2)]=argv[i+1];}
assert(['on','off'].includes(mode)&&options.app&&['missing-script','timeout','protocol-mismatch'].includes(options.kind));
const app=fs.realpathSync(path.resolve(options.app)),product=fs.realpathSync(path.join(ROOT,'MarkPilot-CM6'));
assert(app!==product,'Never mutate the product application');assert.equal(JSON.parse(fs.readFileSync(path.join(app,'quality-run.json'),'utf8')).owner,'markpilot-quality');
const file=path.join(app,'renderer/cm6/markdown-worker.js'),parent=fs.realpathSync(path.dirname(file));assert(parent.startsWith(app+path.sep),'Worker escaped the owned copy');
if(fs.existsSync(file))assert(fs.realpathSync(file).startsWith(app+path.sep),'Worker must belong to the copy');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),current=()=>fs.existsSync(file)?hash(fs.readFileSync(file)):null;
const stateFile=path.join(app,'quality-worker-fault.json');let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
if(state)assert.equal(state.kind,options.kind,'A different fault already owns this copy');
if(mode==='off'){
 if(!state?.active){console.log(JSON.stringify({active:false,alreadyRestored:true}));process.exit(0);}
 assert.equal(current(),state.faultSha256,'Fault file was independently modified');const bytes=Buffer.from(state.before,'base64');assert.equal(hash(bytes),state.beforeSha256);fs.writeFileSync(file,bytes);state.active=false;fs.writeFileSync(stateFile,JSON.stringify(state));console.log(JSON.stringify({active:false,restoredSha256:current()}));
}else{
 if(state?.active){assert.equal(current(),state.faultSha256);console.log(JSON.stringify({active:true,alreadyApplied:true}));process.exit(0);}
 const before=fs.readFileSync(file),fault=options.kind==='missing-script'?null:Buffer.from(options.kind==='timeout'?'onmessage = () => {};\n':'onmessage = ({data}) => postMessage({type:"tree",revision:data.revision,length:data.length ?? data.text.length,wire:{schema:"deliberately-incompatible"}});\n');
 state={schema:1,kind:options.kind,active:true,before:before.toString('base64'),beforeSha256:hash(before),faultSha256:fault?hash(fault):null};fs.writeFileSync(stateFile,JSON.stringify(state));if(fault)fs.writeFileSync(file,fault);else fs.unlinkSync(file);console.log(JSON.stringify({active:true,kind:options.kind,beforeSha256:state.beforeSha256,faultSha256:state.faultSha256}));
}
