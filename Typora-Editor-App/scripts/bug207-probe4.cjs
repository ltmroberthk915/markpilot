// v2.0.7 P1 probe4: instrument every VditorIRDOM2Md call during the REAL
// setImageScale to find which converter invocation doubles the H2.
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
  const mkFixture=withDisplayMath=>{
    const png=makePng(1024,740,26);
    const dataUri='data:image/png;base64,'+png.toString('base64');
    const math=withDisplayMath?['$$\\mathbb{E}_{\\mathbb{P}}[X]:=\\int_{\\Omega} X\\,d\\mathbb{P}$$','']:[''];
    return[
      '# 第 1 章 重识概率论','',
      '样本空间 $\\Omega$ 上的随机变量。','',
      ...math,
      `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
      '','',
      '## 1.4 期望与概率密度函数','',
      '### 1.4.1 Def 随机变量的数学期望','',
      '取 $X:=\\mathbf{1}_{E}$。','',
    ].join('\n');
  };
  const load=async fixture=>{
    const file=path.join(output,'probe4.md');
    fs.writeFileSync(file,fixture);
    await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
    await pause(700);
    await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
    await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4.1')",'load');
    await wait("window.__typoraMathStats?.pending===0",'math');
    await pause(400);
  };
  const instrument=()=>fe(`(()=>{
    window.__calls=[];
    const lute=vditor.vditor.lute;
    const orig=lute.VditorIRDOM2Md.bind(lute);
    lute.VditorIRDOM2Md=function(html){
      const out=orig(html);
      window.__calls.push({inLen:String(html).length,outLen:out.length,
        h2:(out.match(/## 1\\.4 期望与概率密度函数/g)||[]).length,
        imgs:(out.match(/<img\\b/g)||[]).length,
        h2InHtml:(String(html).match(/1\\.4 期望与概率密度函数/g)||[]).length,
        replIn:html.includes('data-typora-scale="50"')});
      return out;};
    const cap=[];const origSet=vditor.setValue;
    vditor.setValue=function(v){cap.push(String(v));return origSet.apply(this,arguments)};
    window.__cap=cap;return true;})()`);
  const snapshot=tag=>fe(`(async()=>{
    const ir=vditor.vditor.ir.element;
    return{tag:'${tag}',
      domH2:[...ir.querySelectorAll('h2')].filter(h=>h.textContent.includes('1.4 期望')).length,
      mdH2:(vditor.getValue().match(/## 1\\.4 期望与概率密度函数/g)||[]).length,
      capH2:(window.__cap||[]).map(v=>(v.match(/## 1\\.4 期望与概率密度函数/g)||[]).length),
      calls:window.__calls};})()`);

  for(const withMath of [true,false]){
    await load(mkFixture(withMath));
    await instrument();
    await fe(`(()=>{try{const img=[...vditor.vditor.ir.element.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));vditor.__media.setScale(img,'50');}catch(e){window.__scaleErr=String(e&&e.message||e)}return true;})()`);
    await pause(600);
    const r=await snapshot(withMath?'with-$$':'no-$$');
    console.log('[result '+(withMath?'with-$$':'no-$$')+']');
    console.log(JSON.stringify({domH2:r.domH2,mdH2:r.mdH2,capH2:r.capH2,err:await fe('window.__scaleErr||null')}));
    for(const c of r.calls)console.log('  call:',JSON.stringify(c));
  }
  console.log('probe4 done');
};
