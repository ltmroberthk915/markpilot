// v2.0.7 P1 probe5: capture the EXACT html string fed to VditorIRDOM2Md by the
// real setScale, and the manual-splice counterpart; diff them node-side.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc32=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const makePng=(w,h,noiseRows)=>{const raw=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4);if(y>=80&&y<80+noiseRows){for(let x=0;x<w;x++){const o=1+x*4;row[o]=(x*7+y*13)&255;row[o+1]=(x*3+y*5)&255;row[o+2]=(x*11+y*2)&255;row[o+3]=255;}}else{for(let x=0;x<w;x++){const o=1+x*4;row[o]=40;row[o+1]=60;row[o+2]=90;row[o+3]=255;}}raw.push(row);}
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
    return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);};
  const png=makePng(1024,740,26);
  const dataUri='data:image/png;base64,'+png.toString('base64');
  const replacement='<img src="'+dataUri.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'" alt="image" width="541" data-typora-scale="50" />';
  const fixture=[
    '# 第 1 章 重识概率论','',
    '样本空间 $\\Omega$ 上的随机变量。','',
    `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
    '','',
    '## 1.4 期望与概率密度函数','',
    '### 1.4.1 Def 随机变量的数学期望','',
    '取 $X:=\\mathbf{1}_{E}$。','',
  ].join('\n');
  const load=async()=>{
    const file=path.join(output,'probe5.md');
    fs.writeFileSync(file,fixture);
    await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
    await pause(700);
    await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
    await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4.1')",'load');
    await wait("window.__typoraMathStats?.pending===0",'math');
    await pause(400);
  };

  // A) 真实 setScale 抓 lute 输入
  await load();
  await fe(`(()=>{
    window.__inHtml=null;
    const lute=vditor.vditor.lute;
    const orig=lute.VditorIRDOM2Md.bind(lute);
    lute.VditorIRDOM2Md=function(html){if(window.__inHtml===null)window.__inHtml=String(html);return orig(html);};
    return true;})()`);
  await fe(`(()=>{try{const img=[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));vditor.__media.setScale(img,'50');}catch(e){}return true;})()`);
  await pause(500);
  const realHtml=await fe('window.__inHtml');
  fs.writeFileSync(path.join(output,'probe5-real-input.html'),realHtml||'');

  // B) 手工复刻（全量 replacement）
  await load();
  const manual=await fe(`(async()=>{
    const st=await import('/render/js/source-text.js');
    const ii=await import('/render/js/incremental-ir.js');
    const root=vditor.vditor.ir.element;
    const img=[...root.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    const preview=img.closest('.vditor-ir__preview');
    const codeEl=preview?.previousElementSibling;
    const index=st.sourceText(root);
    let start=Infinity,end=-1;
    for(const span of index.spans)if(codeEl.contains(span.node)){start=Math.min(start,span.start);end=Math.max(end,span.end);}
    const copy=ii.cloneSource(root,true);
    const cloned=st.sourceText(copy);
    const range=cloned.range(start,end);
    range.deleteContents();
    range.insertNode(document.createTextNode(${JSON.stringify(replacement)}));
    return copy.innerHTML;})()`);
  fs.writeFileSync(path.join(output,'probe5-manual-input.html'),manual||'');

  // C) 对比
  const count=(s,re)=>(s.match(re)||[]).length;
  console.log('[counts]',JSON.stringify({
    real:{len:realHtml?.length,h2Tags:count(realHtml||'',/<h2[\s>]/g),imgTags:count(realHtml||'',/<img\b/g),scale50:count(realHtml||'',/scale="50"/g)},
    manual:{len:manual?.length,h2Tags:count(manual||'',/<h2[\s>]/g),imgTags:count(manual||'',/<img\b/g),scale50:count(manual||'',/scale="50"/g)},
  }));
  // 逐字符找第一个分歧点
  if(realHtml&&manual){
    let i=0;const n=Math.min(realHtml.length,manual.length);
    while(i<n&&realHtml[i]===manual[i])i++;
    console.log('[first-divergence]',JSON.stringify({at:i,
      realCtx:realHtml.slice(Math.max(0,i-120),i+180).replace(/base64,[A-Za-z0-9+/=]+/g,'[B64]'),
      manualCtx:manual.slice(Math.max(0,i-120),i+180).replace(/base64,[A-Za-z0-9+/=]+/g,'[B64]')}));
  }
  console.log('probe5 done');
};
