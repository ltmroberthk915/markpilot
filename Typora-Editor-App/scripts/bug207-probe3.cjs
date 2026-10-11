// v2.0.7 P1 probe3: deterministically replicate replaceImageSource's splice on
// a CLEAN dom and dump the serialized strings to find the duplication origin.
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
  const mkFixture=noiseRows=>{
    const png=makePng(1024,740,noiseRows);
    const dataUri='data:image/png;base64,'+png.toString('base64');
    return{fixture:[
      '# 第 1 章 重识概率论','',
      '样本空间 $\\Omega$ 上的随机变量。','',
      `<img src="${dataUri}" alt="image" width="1082" data-typora-scale="100" />`,
      '','',
      '## 1.4 期望与概率密度函数','',
      '### 1.4.1 Def 随机变量的数学期望','',
      '取 $X:=\\mathbf{1}_{E}$。','',
    ].join('\n'),b64len:dataUri.length};
  };
  const load=async fixture=>{
    const file=path.join(output,'probe3.md');
    fs.writeFileSync(file,fixture);
    await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}}).catch(()=>{});
    await pause(700);
    await fe(`vditor.setValue(${JSON.stringify(fixture)})`);
    await wait("vditor.vditor.currentMode==='ir'&&vditor.getValue().includes('1.4.1')",'load');
    await wait("window.__typoraMathStats?.pending===0",'math');
    await pause(300);
  };
  const h2c=s=>(s.match(/## 1\.4 期望与概率密度函数/g)||[]).length;
  const fold=s=>s.replace(/base64,[A-Za-z0-9+/=]{80,}/g,m=>'base64,[B64:'+m.length+']');

  // ---- 变量矩阵：噪声行数（控制 base64 长度）× 是否走 splice ----
  for(const noiseRows of [26,13,6,0]){
    const {fixture,b64len}=mkFixture(noiseRows);
    await load(fixture);
    const res=await fe(`(async()=>{
      const st=await import('/render/js/source-text.js');
      const ii=await import('/render/js/incremental-ir.js');
      const root=vditor.vditor.ir.element,lute=vditor.vditor.lute;
      const out={};
      out.liveDomH2=[...root.querySelectorAll('h2')].filter(h=>h.textContent.includes('1.4 期望')).length;
      out.cleanSerialH2=(lute.VditorIRDOM2Md(root.innerHTML).match(/## 1\\.4 期望与概率密度函数/g)||[]).length;
      // 完整复刻 replaceImageSource：clone → 定位 → splice → 序列化
      const img=[...root.querySelectorAll('img')].find(i=>i.src.startsWith('data:'));
      const preview=img.closest('.vditor-ir__preview');
      const codeEl=preview?.previousElementSibling;
      const index=st.sourceText(root);
      let start=Infinity,end=-1;
      for(const span of index.spans)if(codeEl.contains(span.node)){start=Math.min(start,span.start);end=Math.max(end,span.end);}
      out.bounds={start,end,textLen:index.text.length};
      const copy=ii.cloneSource(root,true);
      const cloned=st.sourceText(copy);
      out.cloneTextSame=cloned.text===index.text;
      const range=cloned.range(start,end);
      range.deleteContents();
      range.insertNode(document.createTextNode('<img src="REPLACED" alt="image" width="541" data-typora-scale="50" />'));
      const html=copy.innerHTML;
      const md=lute.VditorIRDOM2Md(html);
      out.splicedH2=(md.match(/## 1\\.4 期望与概率密度函数/g)||[]).length;
      out.splicedImgs=(md.match(/<img\\b/g)||[]).length;
      out.htmlAroundH2=(()=>{const i=html.indexOf('1.4 期望与概率密度函数');return i<0?null:fold(html.slice(Math.max(0,i-700),i+120));})();
      out.mdAroundH2=(()=>{const i=md.indexOf('## 1.4 期望与概率密度函数');const j=md.indexOf('## 1.4 期望与概率密度函数',i+1);return{i,j:j<0?-1:j-i,tail:fold(md.slice(Math.max(0,i-120),i+220))};})();
      out.cloneShape=(()=>{const c=[...copy.children].map(n=>n.tagName+'.'+(n.getAttribute('data-type')||'')).join(',');return c;})();
      function fold(s){return s.replace(/base64,[A-Za-z0-9+/=]{80,}/g,m=>'base64,[B64:'+m.length+']');}
      return out;})()`);
    console.log('[noise='+noiseRows+' b64='+b64len+']',JSON.stringify(res,null,1).slice(0,2200));
    if(res&&res.splicedH2>1){
      fs.writeFileSync(path.join(output,`probe3-spliced-html-noise${noiseRows}.txt`),await fe(`window.__keepHtml||''`));
    }
  }
  console.log('probe3 done');
};
