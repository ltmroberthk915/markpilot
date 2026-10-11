'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {ROOT,sha256}=require('../lifecycle.cjs');
const {sanitize,publish}=require('../publish-evidence.cjs');
test('published evidence removes machine paths and bounds large inline payloads',()=>{
  assert.equal(sanitize(ROOT+path.sep+'file.md'),'<repo>'+path.sep+'file.md');
  assert.equal(sanitize('C:\\Users\\PrivateName\\file.md'),'<user>\\file.md');
  assert.equal(sanitize(ROOT.replaceAll('\\','\\\\')+'\\\\file.md'),'<repo>\\\\file.md');
  assert.equal(sanitize('C:\\\\Users\\\\PrivateName\\\\file.md'),'<user>\\\\file.md');
  try {assert.equal(ROOT+path.sep+'a.md',ROOT+path.sep+'b.md');}
  catch(e){const message=sanitize(e.message);assert(!message.includes(ROOT));assert(!message.includes(ROOT.replaceAll('\\','\\\\')));assert(message.includes('<repo>'));}
  const large=sanitize('data:image/png;base64,'+'A'.repeat(10000));assert.equal(large.characters,10022);assert.equal(large.sha256.length,64);assert(large.preview.length<600);
});
test('wrong screenshot hash and traversal cannot be published',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-evidence-'));
  try{
    const input=path.join(dir,'input'),dest=path.join(dir,'output');fs.mkdirSync(input);fs.writeFileSync(path.join(input,'frame.png'),'test bytes');
    const result={frames:[{file:'frame.png',sha256:'0'.repeat(64)}]};fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(result));assert.throws(()=>publish(input,dest),/SHA256 mismatch/);
    result.frames[0]={file:'../outside.png',sha256:'0'.repeat(64)};fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(result));assert.throws(()=>publish(input,dest),/Invalid frame path/);
    result.frames[0]={file:'frame.png',sha256:sha256(path.join(input,'frame.png'))};fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(result));assert.equal(publish(input,dest).frames,1);assert.equal(fs.readFileSync(path.join(dest,'frame.png'),'utf8'),'test bytes');
    assert.throws(()=>publish(input,dest),/must be empty/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
