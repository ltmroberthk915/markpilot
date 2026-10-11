const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {dialog,BrowserWindow,Menu}=require('electron');
const {portableMarkdown}=require('../app/renderer/js/portable-markdown.cjs');
exports.run=async({win,ev,until,output})=>{
  const results=[];const check=(ok,label)=>{if(!ok)throw new Error(label);results.push('PASS '+label);};
  const folder=path.join(output,'export-fixture');fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'数学笔记.md'),image=path.join(folder,'图 #1.png');
  fs.copyFileSync(path.join(__dirname,'../app/assets/icon.png'),image);
  const original='# 数学导出测试\n\n上文 **粗体** 与 $x^2+1$。\n\n$$\n\\int_0^1 x^2\\,dx=\\frac{1}{3}\n$$\n\n![图片](图%20%231.png)\n\n```mermaid\nvenn-beta\nset A["数学"]\nset B["应用"]\nunion A,B["交集"]\n```\n\n```mermaid\ntreeView-beta\n    notes/\n        HJB.md\n```\n\n```js\nconst value = 1;\n```\n\n| 标题 | 值 |\n| --- | --- |\n| 测试 | 42 |\n\n[外部链接](https://example.org)\n';
  fs.writeFileSync(file,original);global.doc.setSetting('autoSave',false);global.doc.setSetting('snapshots',false);
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
  const iframe='document.getElementById("editor").contentWindow';await until(`!!${iframe}.vditor?.vditor?.__typoraPatched`);
  const live=original+'\n未保存的尾部文字。\n';await ev(`${iframe}.vditor.setValue(${JSON.stringify(live)});true`);
  check(Menu.getApplicationMenu().getMenuItemById('file-export').enabled,'File export submenu is enabled for a document');
  check(await ev(`!!${iframe}.document.querySelector('[data-type=document-export]')`),'compact toolbar exposes native export menu');
  const before=await ev(`${iframe}.vditor.getValue()`);
  const portableExpected=(await portableMarkdown(before,{file})).text;
  const oldDialog=dialog.showSaveDialog;let target;
  dialog.showSaveDialog=async()=>target?{canceled:false,filePath:target}:{canceled:true};
  try {
    check((await ev(`hostApi.invoke('export',{format:'html'})`)).canceled,'cancel Save dialog creates no file');
    target=file;const refuse=await ev(`hostApi.invoke('export',{format:'md'})`);check(!!refuse.error&&fs.readFileSync(file,'utf8')===original,'refuses export over original Markdown');
    for(const format of ['html','pdf','md']){
      target=path.join(folder,'result.'+format);const result=await ev(`hostApi.invoke('export',{format:${JSON.stringify(format)}})`);
      fs.writeFileSync(path.join(folder,format+'-result.json'),JSON.stringify(result,null,2));
      check(result.phase==='done','native '+format+' export completes: '+(result.error||''));
      check(!result.warnings.length,'all '+format+' formulas, Venn, TreeView and local image export without warnings: '+result.warnings.join(';'));
      const data=fs.readFileSync(target);
      if(format==='html'){
        const html=data.toString('utf8');
        check(html.includes('未保存的尾部文字')&&html.includes('katex')&&html.includes('<svg'),'HTML captures unsaved source and static math/diagrams');
        check(html.includes('data:image/png;base64,')&&html.includes('data:font/woff2;base64,'),'HTML embeds local images and math fonts');
        check(!/<script\b|<iframe\b|<base\b|127\.0\.0\.1|vscode-cdn|X-Typora-Token/.test(html),'HTML contains no scripts, app URLs, credentials or hidden print frame');
        const reader=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false}});
        try {await reader.loadFile(target);check(await reader.webContents.executeJavaScript(`document.images.length===1&&document.images[0].naturalWidth>0&&document.querySelectorAll('.export-diagram svg').length===2`),'standalone HTML opens offline with images and both diagrams');}
        finally{reader.destroy();}
      } else if(format==='pdf')check(data.subarray(0,5).toString()==='%PDF-'&&data.length>15000,'native PDF contains actual printable output');
      else {
        const actual=data.toString('utf8');
        const first=[...actual].findIndex((char,index)=>char!==portableExpected[index]);
        check(actual===portableExpected,`Markdown export is byte exact portable source (expected ${portableExpected.length}, got ${actual.length}, first difference ${first})`);
      }
    }
    check(await ev(`${iframe}.vditor.getValue()===${JSON.stringify(before)}`),'export leaves editor source and active document intact');
    check(fs.readFileSync(file,'utf8')===original,'export never saves over the original');
    check(await ev(`document.querySelector('#export-dialog [data-action=open]').hidden===false`),'export success offers Open and Reveal');
    // A separate local process/window gets no native capability.
    const origin=new URL(win.webContents.getURL()).origin;
    const denied=await fetch(origin+'/ws-file/'+encodeURIComponent(file));check(denied.status===403,'Node process cannot read a known file through the app port');
    const stranger=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    try{await stranger.loadURL(origin+'/shell');check(await stranger.webContents.executeJavaScript(`document.body.innerText==='forbidden'`),'unregistered Electron window cannot bootstrap an authenticated page');}finally{stranger.destroy();}
    const imgUrl=await ev(`${iframe}.document.querySelector('.vditor-ir img').src`);
    check(await ev(`fetch(${JSON.stringify(imgUrl)}).then(r=>r.status===200)`),'registered shell fetch retains authenticated local image access');
    await ev(`document.querySelector('#export-dialog').close()`);
    // Malicious raw HTML cannot execute in the export worker or exported artifact.
    const hostile='# edge\n\n<script>window.__bad=1</script>\n\n<img src="missing.png" onerror="window.__bad=2">\n\n[bad](javascript:alert(1))\n\n$\\unknowncommand{x}$\n';
    await ev(`${iframe}.vditor.setValue(${JSON.stringify(hostile)});true`);target=path.join(folder,'edge.html');
    const edge=await ev(`hostApi.invoke('export',{format:'html'})`);check(edge.phase==='done'&&edge.warnings.length>=2,'missing images and invalid TeX are reported without dropping the document');
    const html=fs.readFileSync(target,'utf8');check(!/<script\b|onerror=|href="javascript:/i.test(html)&&html.includes('图片未能嵌入'),'raw HTML is inert; missing image has a visible placeholder');
    // A slow remote image permits cancellation and protects concurrent edits to
    // an existing destination while the renderer is still working.
    const slow=http.createServer((_req,res)=>{setTimeout(()=>{res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(image));},1500).unref();});await new Promise(r=>slow.listen(0,'127.0.0.1',r));
    try{
      await ev(`${iframe}.vditor.setValue(${JSON.stringify('![slow](http://127.0.0.1:'+slow.address().port+'/slow.png)')});true`);target=path.join(folder,'canceled.html');
      const pending=ev(`hostApi.invoke('export',{format:'html'})`);await until(`document.querySelector('#export-dialog').open&&document.querySelector('#export-message').textContent.includes('嵌入图片')`);
      check(!!(await ev(`hostApi.invoke('export',{format:'html'})`)).error,'duplicate export is rejected while a job is active');
      await ev(`hostApi.invoke('export-cancel')`);check((await pending).canceled&&!fs.existsSync(target),'cancellation stops export without a partial destination');
      target=path.join(folder,'concurrent.html');fs.writeFileSync(target,'before');
      const concurrent=ev(`hostApi.invoke('export',{format:'html'})`);await until(`document.querySelector('#export-message').textContent.includes('嵌入图片')`);fs.writeFileSync(target,'external change');
      check(!!(await concurrent).error&&fs.readFileSync(target,'utf8')==='external change','concurrent destination modification is preserved');
    }finally{slow.closeAllConnections();await new Promise(r=>slow.close(r));}
    target=path.join(folder,'missing-parent','fail.md');check(!!(await ev(`hostApi.invoke('export',{format:'md'})`)).error,'write failure returns an error instead of reporting success');
  } finally {dialog.showSaveDialog=oldDialog;global.doc.current.dirty=false;}
  fs.writeFileSync(path.join(output,'desktop-export.json'),JSON.stringify(results,null,2));return results;
};
