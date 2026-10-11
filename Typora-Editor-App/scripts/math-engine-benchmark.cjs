// Local, deterministic samples from the user's notebook. No model/API calls.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {BrowserWindow,app}=require('electron');
exports.run=async({output,renderer})=>{
  app.on('window-all-closed',()=>{});
  const sourceFile='D:/Users/Ming/Desktop/动态规划教材（渲染修复副本）.md',source=fs.readFileSync(sourceFile,'utf8');
  const modules=path.join(output,'mathjax-benchmark/node_modules');
  const requests=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');requests.push(url.pathname);
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<html><head><meta charset="utf-8"><style>body{font-size:16px}#bench{width:800px}</style></head><body><div id="bench"></div></body></html>');return;}
    const [prefix,root]=url.pathname.startsWith('/render/')?['/render/',renderer]:url.pathname.startsWith('/mathjax/')?['/mathjax/',path.join(modules,'mathjax')]:['/fonts/',path.join(modules,'@mathjax')];
    const file=path.join(root,decodeURIComponent(url.pathname.slice(prefix.length)));
    if(!file.startsWith(root)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'application/octet-stream');fs.createReadStream(file).pipe(res);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const create=async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadURL(origin);return win;};
  const load=async(win,file)=>win.webContents.executeJavaScript(`new Promise((r,j)=>{const s=document.createElement('script');s.src=${JSON.stringify(file)};s.onload=()=>r(true);s.onerror=()=>j(new Error(s.src));document.head.append(s)})`);
  let samples;const prep=await create();
  try{
    await load(prep,'/render/cdn/vditor/dist/index.min.js');
    samples=await prep.webContents.executeJavaScript(`(async()=>{
      const {normalizeMathFences}=await import('/render/js/math-markdown.js');
      const html=await Vditor.md2html(normalizeMathFences(${JSON.stringify(source)}),{cdn:'/render/cdn/vditor',math:{inlineDigit:true}});
      const t=document.createElement('template');t.innerHTML=html;
      const all=[...t.content.querySelectorAll('.language-math')].map((n,i)=>({index:i,tex:n.textContent,display:n.tagName==='DIV'}));
      const unique=[...new Map(all.map(x=>[x.display+':'+x.tex,x])).values()];
      const select=(list,n)=>Array.from({length:Math.min(n,list.length)},(_,i)=>list[Math.floor(i*list.length/Math.min(n,list.length))]);
      return {total:all.length,unique:unique.length,items:[...select(unique.filter(x=>!x.display),120),...select(unique.filter(x=>x.display),120)].sort((a,b)=>a.index-b.index)};
    })()`);
  }finally{prep.destroy();}
  const report={source:sourceFile,sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),total:samples.total,unique:samples.unique,sampleCount:samples.items.length,rounds:5,engines:[],versions:process.versions};
  try {
    for(const variant of (process.env.MATH_ENGINE_VARIANTS||'katex,chtml,svg').split(',')) {
      const engine=variant.split('-')[0],lean=variant.endsWith('-lean');
      const win=await create(),evaluate=code=>win.webContents.executeJavaScript(code);
      try{
        const started=Date.now();
        if(engine==='katex'){
          await load(win,'/render/cdn/vditor/dist/js/katex/katex.min.js');await load(win,'/render/cdn/vditor/dist/js/katex/mhchem.min.js');
          await evaluate(`new Promise(r=>{const l=document.createElement('link');l.rel='stylesheet';l.href='/render/cdn/vditor/dist/js/katex/katex.min.css';l.onload=()=>r(true);document.head.append(l)})`);
        }else{
          const options=lean?{enableMenu:false,enableEnrichment:false,enableSpeech:false,enableBraille:false,enableComplexity:false,enableExplorer:false,menuOptions:{settings:{enrich:false,speech:false,braille:false,assistiveMml:false}}}:{enableMenu:false};
          await evaluate(`window.MathJax={loader:{paths:{mathjax:'/mathjax',fonts:'/fonts'}},startup:{typeset:false},options:${JSON.stringify(options)},svg:{fontCache:'local'}};true`);
          await load(win,'/mathjax/tex-'+engine+'.js');await evaluate('MathJax.startup.promise.then(()=>true)');
        }
        const loadMs=Date.now()-started;
        const outcome=await evaluate(`(async()=>{
          const items=${JSON.stringify(samples.items)},kind=${JSON.stringify(engine)},host=document.getElementById('bench'),runs=[];
          const stats=values=>{const a=[...values].sort((a,b)=>a-b);return {median:a[Math.floor(a.length/2)],p95:a[Math.floor(a.length*.95)],total:a.reduce((a,b)=>a+b,0)}};
          for(let round=0;round<6;round++){
            const times=[],failures=[],nodes=[];host.replaceChildren();
            const start=performance.now();
            for(const item of items){
              const at=performance.now();let node;
              try{
                if(kind==='katex'){
                  node=document.createElement(item.display?'div':'span');
                  node.innerHTML=katex.renderToString(item.tex,{displayMode:item.display,output:'html',sourceMap:true});
                }else node=await MathJax[kind==='svg'?'tex2svgPromise':'tex2chtmlPromise'](item.tex,{display:item.display});
                if(node.querySelector('[data-mjx-error],mjx-merror'))failures.push(item.index);
              }catch(error){failures.push(item.index);node=document.createElement('span');node.textContent=item.tex;}
              times.push(performance.now()-at);nodes.push(node);
            }
            const convertMs=performance.now()-start;
            const insert=performance.now();host.replaceChildren(...nodes);await document.fonts.ready;host.getBoundingClientRect();
            runs.push({round,conversion:stats(times),convertMs,insertLayoutMs:performance.now()-insert,failures,nodeCount:host.querySelectorAll('*').length,timings:times});
            await new Promise(r=>setTimeout(r,10));
          }
          return {version:kind==='katex'?katex.version:MathJax.version,enrichment:kind==='katex'?false:MathJax.startup.document.options.enableEnrichment,runs};
        })()`);
        report.engines.push({engine:variant,loadMs,...outcome});
        console.log(JSON.stringify({engine:variant,loadMs,version:outcome.version,enrichment:outcome.enrichment,warm:outcome.runs.slice(1).map(r=>({median:r.conversion.median,p95:r.conversion.p95,total:r.convertMs,layout:r.insertLayoutMs,failed:r.failures.length}))}));
      }finally{win.destroy();}
    }
    report.requests=requests;fs.writeFileSync(path.join(output,process.env.MATH_ENGINE_VARIANTS?'math-engine-benchmark-lean.json':'math-engine-benchmark.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(output,'math-engine-samples.json'),JSON.stringify(samples,null,2));
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
};
