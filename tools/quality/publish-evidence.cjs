'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {ROOT,sha256}=require('./lifecycle.cjs');
function sanitize(value) {
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));
  if(typeof value!=='string')return value;
  let text=value;
  for(const root of [ROOT,ROOT.replaceAll('\\','/'),ROOT.replaceAll('\\','\\\\'),ROOT.replaceAll('\\','\\\\\\\\')])text=text.replaceAll(root,'<repo>');
  text=text.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/"\s]+/g,'<user>');
  if(text.length>4096)return {characters:text.length,sha256:crypto.createHash('sha256').update(text).digest('hex'),preview:text.slice(0,256)+'\n…\n'+text.slice(-256)};
  return text;
}
function publish(input,output,includeFrames=true) {
  const source=path.resolve(input),dest=path.resolve(output);
  if(dest===source||dest.startsWith(source+path.sep))throw new Error('Evidence destination must be outside the private run');
  const result=JSON.parse(fs.readFileSync(path.join(source,'result.json'),'utf8'));
  // Workflow probes keep each screenshot alongside the corresponding input
  // state. Publish those frames under the same verified manifest as old suites.
  const listed=[...(result.frames||[]),...(result.cases||[]).flatMap(c=>(c.trace||[]).map(t=>t.screenshot).filter(Boolean))],unique=new Map();
  for(const f of listed){const old=unique.get(f.file);if(old&&(old.sha256!==f.sha256||JSON.stringify(old.zoom)!==JSON.stringify(f.zoom)))throw new Error('Conflicting frame identity: '+f.file);if(!old)unique.set(f.file,f);}
  result.frames=[...unique.values()];const small=sanitize(result);let total=0,publishedFrames=0;
  const selected=Array.isArray(includeFrames)?new Set(includeFrames):null;
  if(selected)for(const name of selected)if(!(result.frames||[]).some(f=>f.file===name))throw new Error('Unknown selected frame: '+name);
  fs.mkdirSync(dest,{recursive:true});
  if(fs.readdirSync(dest).length)throw new Error('Evidence destination must be empty');
  for(const f of (result.frames||[]).flatMap(f=>f.zoom?[f,f.zoom]:[f])) {
    if(path.basename(f.file)!==f.file||!f.file.endsWith('.png'))throw new Error('Invalid frame path');
    const file=path.join(source,f.file);assertHash(file,f.sha256);
    const owner=(result.frames||[]).find(e=>e.file===f.file||e.zoom?.file===f.file);
    if(!includeFrames||(selected&&!selected.has(owner.file))){const entry=small.frames.find(e=>e.file===f.file)||small.frames.find(e=>e.zoom?.file===f.file)?.zoom;if(entry)entry.published=false;continue;}
    const size=fs.statSync(file).size;total+=size;if(size>1048576||total>5242880)throw new Error('Evidence exceeds small-artifact budget');
    fs.copyFileSync(file,path.join(dest,f.file));
    if(owner.file===f.file)publishedFrames++;
  }
  fs.writeFileSync(path.join(dest,'result.json'),JSON.stringify(small,null,2));
  return {frames:publishedFrames,bytes:total,cases:result.cases?.length||0};
}
function assertHash(file,expected) {if(!expected||sha256(file)!==expected)throw new Error('Frame SHA256 mismatch: '+path.basename(file));}
if(require.main===module) {
  const argv=process.argv.slice(2);if(![4,5,6].includes(argv.length)||argv[0]!=='--in'||argv[2]!=='--out'||(argv.length===5&&argv[4]!=='--json-only')||(argv.length===6&&(argv[4]!=='--frames'||!argv[5])))throw new Error('Use --in private-run --out public-evidence [--json-only | --frames full-frame.png,other.png]');
  console.log(JSON.stringify(publish(argv[1],argv[3],argv.length===6?argv[5].split(','):!argv.includes('--json-only'))));
}
module.exports={sanitize,publish,assertHash};
