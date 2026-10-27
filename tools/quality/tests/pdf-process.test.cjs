'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {publishPdf,inspectPdf}=require('../../../MarkPilot-CM6/shell/pdf-process');
const {shutdownFileWorker}=require('../../../MarkPilot-CM6/shell/safe-file');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
after(()=>shutdownFileWorker());
async function owned(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mp-pdf-contract-'));try{await fn(dir);}finally{const rel=path.relative(os.tmpdir(),dir);assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await fs.rm(dir,{recursive:true,force:true});}}
async function fixture(dir,leaf='target.pdf'){
 const source=path.join(dir,'worker.bin'),target=path.join(dir,leaf),bytes=Buffer.alloc(2*1024*1024+31,73);await fs.writeFile(source,bytes);await fs.writeFile(target,'ORIGINAL');
 return{source,target,bytes,info:{bytes:bytes.length,sha256:hash(bytes)}};
}
test('cancel after the last copied chunk preserves the old target and removes the partial',()=>owned(async dir=>{
 const x=await fixture(dir);let cancel=false,commits=0;
 await assert.rejects(publishPdf(x.source,x.target,x.info,{isCanceled:()=>cancel,onPhase:p=>{if(p.done===x.info.bytes)cancel=true;},onPublishing:()=>commits++}),e=>e.canceled===true);
 assert.equal(commits,0);assert.equal(await fs.readFile(x.target,'utf8'),'ORIGINAL');assert.equal((await fs.readdir(dir)).some(n=>n.startsWith('.mp-pdf-')),false);
}));
test('commit admission completes despite a later cancel and supports a full-length target component',()=>owned(async dir=>{
 const x=await fixture(dir,'x'.repeat(246)+'.pdf');let cancel=false;
 const r=await publishPdf(x.source,x.target,x.info,{isCanceled:()=>cancel,onPublishing:()=>{cancel=true;}});
 assert.equal(r.bytes,x.bytes.length);assert.equal(hash(await fs.readFile(x.target)),x.info.sha256);
}));
test('changed worker bytes cannot replace an existing target',()=>owned(async dir=>{
 const x=await fixture(dir);x.info.sha256=hash(Buffer.from('different worker output'));
 await assert.rejects(publishPdf(x.source,x.target,x.info),e=>e.code==='MP_PDF_OUTPUT');assert.equal(await fs.readFile(x.target,'utf8'),'ORIGINAL');
}));
test('a target changed at native commit remains intact',()=>owned(async dir=>{
 const x=await fixture(dir);
 await assert.rejects(publishPdf(x.source,x.target,x.info,{onPublishing:()=>sync.writeFileSync(x.target,'EXTERNAL CHANGE')}));
 assert.equal(await fs.readFile(x.target,'utf8'),'EXTERNAL CHANGE');
}));
test('late session ownership validation rejects publication before commit',()=>owned(async dir=>{
 const x=await fixture(dir);let checked=false;
 await assert.rejects(publishPdf(x.source,x.target,x.info,{validateTarget:async()=>{checked=true;},commitPublication:async()=>{throw Object.assign(Error('target now belongs to an editor'),{code:'MP_EXPORT_TARGET'});}}),e=>e.code==='MP_EXPORT_TARGET');
 assert(checked);assert.equal(await fs.readFile(x.target,'utf8'),'ORIGINAL');
}));
test('PDF Pages root split at a scan boundary is not counted as a leaf page',()=>owned(async dir=>{
 const header='%PDF-1.4\n',catalog='1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
 const pages='2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n';
 const needleEnd=pages.indexOf('/Type /Page')+'/Type /Page'.length,pad=65536-Buffer.byteLength(header+catalog)-needleEnd-2;
 const comment='%'+'.'.repeat(pad)+'\n',leaf=n=>n+' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>\nendobj\n';
 let text=header;const offsets=[0];for(const item of [catalog,comment+pages,leaf(3),leaf(4)]){offsets.push(Buffer.byteLength(text)+(offsets.length===2?comment.length:0));text+=item;}
 const xref=Buffer.byteLength(text);text+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
 const file=path.join(dir,'boundary.pdf');await fs.writeFile(file,text);const info=await inspectPdf(file);assert.equal(info.pages,2);assert.equal(info.bytes,Buffer.byteLength(text));
}));
