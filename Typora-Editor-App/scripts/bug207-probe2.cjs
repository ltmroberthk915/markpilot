// v2.0.7 P1 probe2: why does VditorIRDOM2Md(root.innerHTML) double the H2
// while the per-block getValue() path does not? Dump raw structures.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc32=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const makePng=(w,h)=>{const raw=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4);for(let x=0;x<w;x++){const o=1+x*4;row[o]=40;row[o+1]=60;row[o+2]=90;row[o+3]=255;}raw.push(row);}
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
    return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);};
  const dataUri='data:image/png;base64,'+makePng(64,48).toString('base64');
  const fixture=[
    '# 第 1 章','',
    '正文一段。','',
    `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
    '','',
    '## 1.4 期望与概率密度函数','',
    '### 1.4.1 小节','',
  ].join('\n');
  const file=path.join(output,'probe2.md');
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(700);
  await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
  await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4.1')",'load');
  await pause(300);

  // 1) 顶层结构
  console.log('[children]',JSON.stringify(await fe(`[...vditor.vditor.ir.element.children].map(c=>c.tagName+'|'+c.className+'|'+(c.getAttribute('data-type')||'')+'|'+String(c.textContent).replace(/base64,[A-Za-z0-9+/=]+/,'[B64]').slice(0,40))`)));
  // 2) root.innerHTML 原文（base64 折叠）落盘
  fs.writeFileSync(path.join(output,'probe2-root-innerhtml.txt'),await fe(`vditor.vditor.ir.element.innerHTML.replace(/base64,[A-Za-z0-9+/=]+/g,'base64,[B64]')`));
  // 3) 各计数
  console.log('[counts]',JSON.stringify(await fe(`(async()=>{
    const root=vditor.vditor.ir.element,lute=vditor.vditor.lute;
    const m1=lute.VditorIRDOM2Md(root.innerHTML);
    const joined=[...root.children].map(c=>c.outerHTML).join('');
    const m2=lute.VditorIRDOM2Md(joined);
    return{getValue:(vditor.getValue().match(/## 1\\.4 期望/g)||[]).length,
      innerHtml:m1.match(/## 1\\.4 期望/g)?.length||0,
      joinedChildren:m2.match(/## 1\\.4 期望/g)?.length||0,
      m1tail:m1.slice(-160).replace(/base64,[A-Za-z0-9+/=]+/g,'[B64]'),
      childN:root.children.length,nodeN:root.childNodes.length};})()`)));
  // 4) 二分定位：序列化前缀 children[0..k]
  console.log('[bisect]',JSON.stringify(await fe(`(async()=>{
    const root=vditor.vditor.ir.element,lute=vditor.vditor.lute,out={};
    const cs=[...root.children];
    for(let k=1;k<=cs.length;k++){
      const md=lute.VditorIRDOM2Md(cs.slice(0,k).map(c=>c.outerHTML).join(''));
      out['first'+k]=(md.match(/## 1\\.4 期望/g)||[]).length;
    }
    return out;})()`)));
  // 5) html-block 单块序列化与 innerHTML 解析回读对比
  console.log('[htmlblock]',JSON.stringify(await fe(`(async()=>{
    const root=vditor.vditor.ir.element,lute=vditor.vditor.lute;
    const div=[...root.children].find(c=>c.getAttribute('data-type')==='html-block');
    if(!div)return{found:false};
    const outer=div.outerHTML;
    const md=lute.VditorIRDOM2Md(outer);
    // 重新解析回 DOM 看形状是否稳定
    const t=document.createElement('template');t.innerHTML=outer;
    const back=t.content.firstElementChild;
    return{found:true,outerHead:outer.slice(0,200).replace(/base64,[A-Za-z0-9+/=]+/g,'[B64]'),
      mdH2:(md.match(/## 1\\.4 期望/g)||[]).length,
      reparsedChildren:[...(back?.children||[])].map(c=>c.tagName+'.'+c.className)};})()`)));
  console.log('probe2 done');
};
