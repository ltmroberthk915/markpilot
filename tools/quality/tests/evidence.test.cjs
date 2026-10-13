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
test('caret zoom has its own verified hash and traversal protection',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-zoom-'));
  try {
    const input=path.join(dir,'input');fs.mkdirSync(input);const frame=path.join(input,'frame.png'),zoom=path.join(input,'zoom.png');fs.writeFileSync(frame,'frame');fs.writeFileSync(zoom,'zoom');
    const data={frames:[{file:'frame.png',sha256:sha256(frame),zoom:{file:'zoom.png',sha256:'0'.repeat(64)}}]};
    fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(data));assert.throws(()=>publish(input,path.join(dir,'bad-hash')),/SHA256 mismatch/);
    data.frames[0].zoom.file='../zoom.png';fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(data));assert.throws(()=>publish(input,path.join(dir,'bad-path')),/Invalid frame path/);
    data.frames[0].zoom={file:'zoom.png',sha256:sha256(zoom)};fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(data));publish(input,path.join(dir,'valid'));assert.equal(fs.readFileSync(path.join(dir,'valid/zoom.png'),'utf8'),'zoom');
  } finally {const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('mp-quality-zoom-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('selective evidence copies full and zoom together, rejects unknown names and still verifies omitted frames',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-selective-'));
  try {
    const input=path.join(dir,'input');fs.mkdirSync(input);
    for(const name of ['full.png','zoom.png','omitted.png'])fs.writeFileSync(path.join(input,name),name);
    const data={frames:[{file:'full.png',sha256:sha256(path.join(input,'full.png')),zoom:{file:'zoom.png',sha256:sha256(path.join(input,'zoom.png'))}},{file:'omitted.png',sha256:sha256(path.join(input,'omitted.png'))}]};
    fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(data));
    assert.throws(()=>publish(input,path.join(dir,'unknown'),['typo.png']),/Unknown selected/);
    const result=publish(input,path.join(dir,'valid'),['full.png']);assert.equal(result.frames,1);assert(fs.existsSync(path.join(dir,'valid/zoom.png')));assert(!fs.existsSync(path.join(dir,'valid/omitted.png')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'valid/result.json'),'utf8')).frames[1].published,false);
    fs.writeFileSync(path.join(input,'omitted.png'),'modified');assert.throws(()=>publish(input,path.join(dir,'corrupt'),['full.png']),/SHA256 mismatch/);
  }finally{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('mp-quality-selective-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('workflow trace screenshots publish with verified zoom and reject conflicting identities',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-workflow-evidence-'));
  try {
    const input=path.join(dir,'input');fs.mkdirSync(input);for(const name of ['full.png','zoom.png'])fs.writeFileSync(path.join(input,name),name);
    const shot={file:'full.png',sha256:sha256(path.join(input,'full.png')),zoom:{file:'zoom.png',sha256:sha256(path.join(input,'zoom.png'))}};
    const result={cases:[{trace:[{name:'actual-input-state',screenshot:shot},{name:'same-state-reference',screenshot:shot}]}]};
    fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(result));const valid=path.join(dir,'valid');assert.equal(publish(input,valid,['full.png']).frames,1);assert(fs.existsSync(path.join(valid,'zoom.png')));assert.equal(JSON.parse(fs.readFileSync(path.join(valid,'result.json'))).frames.length,1);
    result.cases[0].trace[1].screenshot={...shot,sha256:'0'.repeat(64)};fs.writeFileSync(path.join(input,'result.json'),JSON.stringify(result));assert.throws(()=>publish(input,path.join(dir,'conflict')),/Conflicting frame identity/);
  } finally {const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('mp-quality-workflow-evidence-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
