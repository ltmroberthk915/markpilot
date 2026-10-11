// v2.0.7 P2 probe7: who resets scrollTop after image deletion — log scroll
// events with timestamps across candidate scrollers.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async(code,label)=>{for(let i=0;i<400;i++){if(await fe(code))return;await pause(25);}throw Error('Not ready: '+(label||code));};
  const crcTable=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc32=buf=>{let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const makePng=(w,h)=>{const raw=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4);if(y>=80&&y<106){for(let x=0;x<w;x++){const o=1+x*4;row[o]=(x*7+y*13)&255;row[o+1]=(x*3+y*5)&255;row[o+2]=(x*11+y*2)&255;row[o+3]=255;}}else{for(let x=0;x<w;x++){const o=1+x*4;row[o]=40;row[o+1]=60;row[o+2]=90;row[o+3]=255;}}raw.push(row);}
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
    return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(raw))),chunk('IEND',Buffer.alloc(0))]);};
  const dataUri='data:image/png;base64,'+makePng(1024,740).toString('base64');
  const fixture=[
    '# 第 1 章','',
    '段落一。','',
    '段落二。','',
    `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
    '','',
    '## 1.4 期望与概率密度函数','',
    '段落三。','',
  ].join('\n');
  const file=path.join(output,'probe7.md');
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(700);
  await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
  await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4')",'load');
  await wait("window.__typoraMathStats?.pending===0",'math');
  await pause(300);
  // 滚动日志 + 各候选滚动器
  await fe(`(()=>{
    window.__log=[];
    const root=vditor.vditor.ir.element;
    for(const el of [root,root.closest('.vditor-ir'),root.closest('.vditor-content')]){
      if(!el)continue;
      el.addEventListener('scroll',()=>{window.__log.push({t:Math.round(performance.now()),who:el.tagName+'.'+String(el.className).split(' ')[0],top:Math.round(el.scrollTop)});},{passive:true});
    }
    const img=[...root.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    const r=img.getBoundingClientRect();
    root.scrollTop=Math.max(0,root.scrollTop+r.top-180);
    window.__t0=Math.round(performance.now());
    return Math.round(root.scrollTop);})()`);
  await pause(200);
  const before=await fe(`({top:Math.round(vditor.vditor.ir.element.scrollTop),logLen:window.__log.length})`);
  const err=await fe(`(()=>{window.__e=null;try{const root=vditor.vditor.ir.element;const img=[...root.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));vditor.__media.removeImage(img);}catch(e){window.__e=String(e&&e.message||e)}return window.__e||'ok'})()`);
  await pause(900);
  const after=await fe(`({top:Math.round(vditor.vditor.ir.element.scrollTop),log:window.__log,sel:(()=>{const s=getSelection();return s.rangeCount?{node:s.anchorNode?.nodeName||'text',off:s.anchorOffset,editable:!!s.anchorNode?.parentElement?.closest('.vditor-reset')}:null;})(),pending:window.__typoraMathStats?.pending})`);
  console.log('[delete]',err);
  console.log('[before]',JSON.stringify(before));
  console.log('[after]',JSON.stringify(after));
};
