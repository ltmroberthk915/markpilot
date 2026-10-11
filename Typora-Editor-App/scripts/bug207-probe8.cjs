// v2.0.7 P2 probe8: trap programmatic scrollTop writes with stack traces
// during image deletion.
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
  const file=path.join(output,'probe8.md');
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
  await pause(700);
  await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
  await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4')",'load');
  await wait("window.__typoraMathStats?.pending===0",'math');
  await pause(300);
  await fe(`(()=>{
    window.__sets=[];window.__events=[];
    const root=vditor.vditor.ir.element;
    const desc=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
    Object.defineProperty(root,'scrollTop',{configurable:true,
      get(){return desc.get.call(this);},
      set(v){window.__sets.push({t:Math.round(performance.now()),v:Math.round(v),stack:String(new Error().stack).split('\\n').slice(2,6).map(s=>s.trim()).join(' <= ')});desc.set.call(this,v);}});
    root.addEventListener('scroll',()=>{window.__events.push({t:Math.round(performance.now()),top:Math.round(root.scrollTop)});},{passive:true});
    const img=[...root.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
    const r=img.getBoundingClientRect();
    root.scrollTop=Math.max(0,root.scrollTop+r.top-180);
    window.__t0=Math.round(performance.now());
    return true;})()`);
  await pause(200);
  const t0=await fe('window.__t0');
  await fe(`(()=>{try{const root=vditor.vditor.ir.element;const img=[...root.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));vditor.__media.removeImage(img);}catch(e){}return true;})()`);
  await pause(1000);
  const out=await fe(`({sets:window.__sets.filter(s=>s.t>window.__t0),events:window.__events.filter(s=>s.t>window.__t0),final:Math.round(vditor.vditor.ir.element.scrollTop)})`);
  console.log('[final]',out.final);
  for(const s of out.sets)console.log('[set]',JSON.stringify({t:s.t-t0,v:s.v,stack:s.stack}));
  for(const s of out.events)console.log('[event]',JSON.stringify({t:s.t-t0,top:s.top}));
};
