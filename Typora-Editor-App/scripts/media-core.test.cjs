const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {PortableImages}=require('../../Typora-Editor/extension-src/render/js/portable-images.cjs');
const {atomicWrite}=require('../app/main/snapshots');
const base=path.resolve(__dirname,'../.perf/media-office-1.0.15');
async function fixture(fn){await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'media-test-'));try{await fn(root);}finally{assert.ok(root.startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});}}
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
test('Embedded images reopen using only the moved Markdown; exact original bytes survive, literal code remains literal',()=>fixture(async root=>{
  const raw=`# 图片\n\n![一](${png})\n\n<img alt="二" src="${png}" width="50">\n\n\`![literal](${png})\`\n\n\`\`\`md\n![literal](${png})\n\`\`\`\n`;
  const first=new PortableImages({root:path.join(root,'cache-a')}),view=await first.mask(raw);assert.equal(first.entries.size,1);assert.equal(first.expand(view),raw);assert.equal((view.match(/data:image/g)||[]).length,2);
  const file=path.join(root,'moved.md');await fs.writeFile(file,first.expand(view));
  const second=new PortableImages({root:path.join(root,'cache-b')}),moved=await second.mask(await fs.readFile(file,'utf8'));
  assert.equal(second.expand(moved),raw);assert.notEqual(view,moved);for(const item of second.entries.values())assert.deepEqual(await fs.readFile(item.file),Buffer.from(png.split(',')[1],'base64'));
}));
test('Incremental native edits never resend unchanged image data, including undo, repeated images, emoji and partial URLs',()=>fixture(async root=>{
  const images=new PortableImages({root}),raw=`左🙂 ![一](${png}) 中 ![二](${png}) 右\n`,view=await images.mask(raw);
  for(const after of [view+'文字',view.replace('中','中间'),view.replace('🙂','🙃'),view.replace('![一]','![改名]'),view.replace(/!\[一\]\([^)]*\)/,''),view.replace('.png)', '.jpg)'),'',view]){
    const d=images.diff(view,after),actual=raw.slice(0,d.start)+d.text+raw.slice(d.end);assert.equal(actual,images.expand(after),after);
  }
  const d=images.diff(view,view+'x');assert.equal(d.text,'x');assert.equal(d.start,raw.length);assert.equal(d.end,raw.length);
  const deleted=view.replace(/!\[一\]\([^)]*\)/,'');const undo=images.diff(deleted,view),deletedRaw=images.expand(deleted);assert.equal(deletedRaw.slice(0,undo.start)+undo.text+deletedRaw.slice(undo.end),raw);
}));
test('Large embedded blobs stay outside the editable and AI text',()=>fixture(async root=>{
  const blob='data:image/png;base64,'+Buffer.alloc(5*1024*1024,77).toString('base64'),raw='# 数学\n'+ '正文 $x^2$\n'.repeat(16000)+`\n![大图](${blob})\n`,images=new PortableImages({root});
  const view=await images.mask(raw);assert.ok(raw.length-view.length>6*1024*1024);assert.ok(view.length<180000);
  const times=[];for(let i=0;i<100;i++){const start=performance.now(),d=images.diff(view,view+'x');times.push(performance.now()-start);assert.equal(d.text,'x');}
  times.sort((a,b)=>a-b);console.log('compact 5 MB image edit diff p95 ms:',times[95].toFixed(3));
}));
test('Read-only Windows files reproduce EPERM; save reports the reason without truncating or leaving temporary files',()=>fixture(async root=>{
  if(process.platform!=='win32')return;
  const file=path.join(root,'readonly.md'),temp=path.join(root,'baseline.tmp');await fs.writeFile(file,'original');await fs.writeFile(temp,'changed');await fs.chmod(file,0o444);
  try{await assert.rejects(fs.rename(temp,file),{code:'EPERM'});await assert.rejects(atomicWrite(file,'changed'),{code:'EREADONLY'});assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual((await fs.readdir(root)).sort(),['baseline.tmp','readonly.md']);}
  finally{await fs.chmod(file,0o644);}
  await atomicWrite(file,'changed');assert.equal(await fs.readFile(file,'utf8'),'changed');
}));
test('Temporary replacement locks retry, rechecking external changes before commit',t=>fixture(async root=>{
  const file=path.join(root,'lock.md');await fs.writeFile(file,'original');const rename=fs.rename;let count=0,checks=0;
  t.mock.method(fs,'rename',async(...args)=>{if(count++<2)throw Object.assign(new Error('fixture lock'),{code:'EPERM'});return rename(...args);});
  await atomicWrite(file,'changed',{beforeCommit:async()=>{checks++;assert.equal(await fs.readFile(file,'utf8'),'original');}});assert.equal(checks,3);assert.equal(await fs.readFile(file,'utf8'),'changed');
  count=0;checks=0;await assert.rejects(atomicWrite(file,'must not overwrite',{beforeCommit:async()=>{if(checks++===0)await fs.writeFile(file,'external');else throw new Error('external conflict');}}),/external conflict/);assert.equal(await fs.readFile(file,'utf8'),'external');
}));
test('Oversized or bad embedded images never block opening; strict mode still rejects them',()=>fixture(async root=>{
  const oversize='data:image/png;base64,'+'A'.repeat(27*1024*1024); // ~20.25 MB decoded: over the byte cap, under the string cap
  const raw=`# 文档\n\n![好](${png})\n\n![超大](${oversize})\n`;
  const images=new PortableImages({root:path.join(root,'cache')});
  await assert.rejects(images.mask(raw),/20 MB/); // strict insert/open path keeps the limit
  const tolerant=new PortableImages({root:path.join(root,'cache2')});
  const view=await tolerant.mask(raw,{tolerant:true});
  assert.ok(view.includes(oversize),'oversized image keeps its original text');
  assert.ok(!view.includes(png),'good image is still masked');
  assert.equal(tolerant.expand(view),raw);
  const warnings=tolerant.consumeWarnings();
  assert.equal(warnings.length,1);assert.match(warnings[0],/20 MB/);
  await assert.rejects(tolerant.insert({mime:'image/png',data:'A'.repeat(27*1024*1024)}),/20 MB/);
}));
test('A read-only or unusable cache directory degrades to a warning; editing and saving stay intact',()=>fixture(async root=>{
  const blocker=path.join(root,'blocker');await fs.writeFile(blocker,'file occupying the path');
  const images=new PortableImages({root:path.join(blocker,'nested','cache')});
  const raw=`![图](${png})\n`,view=await images.mask(raw);
  await images.flush(); // must not reject even though the cache write failed
  assert.equal(images.expand(view),raw);
  const warnings=images.consumeWarnings();
  assert.ok(warnings.length>=1);assert.match(warnings.join('\n'),/缓存写入失败/);
  const edited=view+'正文';assert.equal(images.diff(view,edited).text,'正文');
}));
