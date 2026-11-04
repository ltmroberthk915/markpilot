'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {DocumentStore}=require('../../../MarkPilot-CM6/shell/document-store');
const {captureExportTarget,publishImage}=require('../../../MarkPilot-CM6/shell/export-target');
const {publishPdf}=require('../../../MarkPilot-CM6/shell/pdf-process');

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mp-export-grant-'));
  t.after(async()=>{
    assert.equal(path.dirname(await fs.realpath(dir)),await fs.realpath(os.tmpdir()));
    await fs.rm(dir,{recursive:true});
  });
  const documents=new DocumentStore(),held=new Set(),open=new Set();
  const capture=file=>captureExportTarget(file,{documents,held,check(key){
    if(open.has(key))throw Object.assign(Error('Open document owns destination'),{code:'MP_EXPORT_TARGET'});
  }});
  return {dir,capture,held,open};
}

test('PDF leaves a destination created or changed after the picker intact',async t=>{
  const {dir,capture,held}=await fixture(t),source=path.join(dir,'printed.pdf');
  const bytes=Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF\n');
  await fs.writeFile(source,bytes);
  const info={bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  for(const existing of [false,true]){
    const target=path.join(dir,existing?'edited.pdf':'new.pdf');
    if(existing)await fs.writeFile(target,'selection-time contents');
    const grant=await capture(target);
    await fs.writeFile(target,'new independent contents');
    await assert.rejects(grant.withPublication(()=>publishPdf(source,target,info,{
      outputGrant:grant,validateTarget:grant.validate,commitPublication:grant.commitPublication,
    })));
    assert.equal(await fs.readFile(target,'utf8'),'new independent contents');
    assert.equal(held.size,0);
  }
  assert(!(await fs.readdir(dir)).some(name=>name.startsWith('.mp-pdf-')));
});

test('image Save As retains existing bytes on a partial write and can retry normally',async t=>{
  const {dir,capture,held}=await fixture(t),target=path.join(dir,'chosen.png');
  const old=Buffer.from('existing image'),next=Buffer.from('new image');await fs.writeFile(target,old);
  const grant=await capture(target),write=fs.writeFile;let injected=0;
  const mock=t.mock.method(fs,'writeFile',async(file,bytes,opts)=>{
    if(file===target||path.basename(file).startsWith('.mp-image-')){
      injected++;await write(file,bytes.subarray(0,1),opts);
      throw Object.assign(Error('injected partial image write'),{code:'ENOSPC'});
    }
    return write(file,bytes,opts);
  });
  try { await assert.rejects(publishImage(grant,next),{code:'ENOSPC'}); }
  finally {mock.mock.restore();}
  assert.equal(injected,1);assert.deepEqual(await fs.readFile(target),old);
  await publishImage(await capture(target),next);assert.deepEqual(await fs.readFile(target),next);
  assert.equal(held.size,0);assert.deepEqual(await fs.readdir(dir),['chosen.png']);
});

test('open document guard is checked at selection and again at publication',async t=>{
  const {dir,capture,open}=await fixture(t),target=path.join(dir,'active.md');await fs.writeFile(target,'active draft');
  const grant=await capture(target);open.add(grant.key);
  await assert.rejects(capture(target),{code:'MP_EXPORT_TARGET'});
  await assert.rejects(publishImage(grant,Buffer.from('image')),{code:'MP_EXPORT_TARGET'});
  assert.equal(await fs.readFile(target,'utf8'),'active draft');
});
