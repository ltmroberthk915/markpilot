// v2.0.7 P1 probe: where does the duplicated H2 land in the md produced by
// replaceImageSource (VditorIRDOM2Md of the spliced clone)?
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const report={checks:[]};
  const log=(k,v)=>{report.checks.push({check:k,value:v});console.log('['+k+']',(typeof v==='string'?v:JSON.stringify(v)).slice(0,1500));};

  const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc32=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const makePng=(w,h)=>{const raw=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4);if(y>=80&&y<86){for(let x=0;x<w;x++){const o=1+x*4;row[o]=(x*7+y*13)&255;row[o+1]=(x*3+y*5)&255;row[o+2]=(x*11+y*2)&255;row[o+3]=255;}}else{for(let x=0;x<w;x++){const o=1+x*4;row[o]=40;row[o+1]=60;row[o+2]=90;row[o+3]=255;}}raw.push(row);}
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
    return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);};
  const dataUri='data:image/png;base64,'+makePng(1024,740).toString('base64');
  const heading='## 1.4 期望与概率密度函数';
  const fixture=[
    '# 第 1 章 重识概率论','',
    '样本空间 $\\Omega$ 上的随机变量。','',
    `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
    '','',
    heading,'',
    '### 1.4.1 Def 随机变量的数学期望','',
    '取 $X:=\\mathbf{1}_{E}$。','',
  ].join('\n');
  const file=path.join(output,'probe.md');
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(700);
  await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
  await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4.1')",'load');
  await wait("window.__typoraMathStats?.pending===0",'math');
  await pause(300);

  // 1) html-block 节点结构骨架（不灌 base64）
  log('node-skeleton',await fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const img=[...ir.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    let n=img;while(n&&n.parentElement!==ir)n=n.parentElement;
    const sk=(el,d)=>{if(d>4)return '…';return '<'+el.tagName+(el.className?'.'+el.className.split(' ').join('.'):'')+'>'+[...el.children].map(c=>sk(c,d+1)).join('');};
    const preview=img.closest('.vditor-ir__preview');
    return{skeleton:sk(n,0),previewContainsH2:!!preview?.querySelector('h2'),
      previewNextSibling:preview?.nextElementSibling?.tagName||null,
      previewPrev:preview?.previousElementSibling?.tagName||null,
      codeText:preview?.previousElementSibling?.textContent.slice(0,80)||null};})()`));

  // 2) 抓 setValue 入参 md，定位两处 h2 的上下文
  await fe(`(()=>{const cap=[];const orig=vditor.setValue;vditor.setValue=function(v){cap.push(String(v));return orig.apply(this,arguments)};window.__cap=cap;return true;})()`);
  await fe(`(()=>{try{const img=[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));vditor.__media.setScale(img,'50');}catch(e){window.__scaleErr=String(e&&e.message||e)}return true;})()`);
  await pause(400);
  const ctx=await fe(`(()=>{
    const md=(window.__cap||[])[0]||'';
    const out=[];let i=-1;
    while((i=md.indexOf('## 1.4 期望与概率密度函数',i+1))>=0){
      out.push({at:i,before:md.slice(Math.max(0,i-90),i).replace(/base64,[A-Za-z0-9+/=]+/,'base64,[B64]'),after:md.slice(i+22,i+120)});
    }
    return{len:md.length,occurrences:out,err:window.__scaleErr||null};})()`);
  log('md-h2-contexts',ctx);
  fs.writeFileSync(path.join(output,'probe-captured-md.txt'),await fe(`(window.__cap||[])[0]||''`));

  // 3) 对照：直接用 lute 序列化未改动的克隆（不 splice）看 h2 是否已重复
  log('plain-clone-serial',await fe(`(async()=>{
    const st=await import('/render/js/source-text.js');
    const ii=await import('/render/js/incremental-ir.js');
    const root=vditor.vditor.ir.element;
    const copy=ii.cloneSource(root,true);
    const md=vditor.vditor.lute.VditorIRDOM2Md(copy.innerHTML);
    return{len:md.length,h2:(md.match(/## 1\\.4 期望与概率密度函数/g)||[]).length,
      imgs:(md.match(/<img\\b/g)||[]).length,
      tail:md.slice(-200).replace(/base64,[A-Za-z0-9+/=]+/,'base64,[B64]')};})()`));

  // 4) 对照：lute 直接序列化 root.innerHTML（原始、未克隆）
  log('root-innerhtml-serial',await fe(`(async()=>{
    const md=vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML);
    return{len:md.length,h2:(md.match(/## 1\\.4 期望与概率密度函数/g)||[]).length,imgs:(md.match(/<img\\b/g)||[]).length};})()`));

  fs.writeFileSync(path.join(output,'probe-report.json'),JSON.stringify(report,null,2));
  console.log('probe done');
};
