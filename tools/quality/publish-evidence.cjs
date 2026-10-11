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
  const result=JSON.parse(fs.readFileSync(path.join(source,'result.json'),'utf8')),small=sanitize(result);let total=0;
  fs.mkdirSync(dest,{recursive:true});
  if(fs.readdirSync(dest).length)throw new Error('Evidence destination must be empty');
  for(const f of result.frames||[]) {
    if(path.basename(f.file)!==f.file||!f.file.endsWith('.png'))throw new Error('Invalid frame path');
    const file=path.join(source,f.file);assertHash(file,f.sha256);
    if(!includeFrames){small.frames.find(e=>e.file===f.file).published=false;continue;}
    const size=fs.statSync(file).size;total+=size;if(size>1048576||total>5242880)throw new Error('Evidence exceeds small-artifact budget');
    fs.copyFileSync(file,path.join(dest,f.file));
  }
  fs.writeFileSync(path.join(dest,'result.json'),JSON.stringify(small,null,2));
  return {frames:includeFrames ? result.frames?.length||0 : 0,bytes:total,cases:result.cases?.length||0};
}
function assertHash(file,expected) {if(!expected||sha256(file)!==expected)throw new Error('Frame SHA256 mismatch: '+path.basename(file));}
if(require.main===module) {
  const argv=process.argv.slice(2);if(![4,5].includes(argv.length)||argv[0]!=='--in'||argv[2]!=='--out'||(argv.length===5&&argv[4]!=='--json-only'))throw new Error('Use --in private-run --out public-evidence [--json-only]');
  console.log(JSON.stringify(publish(argv[1],argv[3],!argv.includes('--json-only'))));
}
module.exports={sanitize,publish,assertHash};
