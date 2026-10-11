const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {dialog}=require('electron');
exports.run=async({win,ev,until,output})=>{
  // 原来写死在另一台机器上的桌面路径（D:/Users/Ming/…），换台机器必然 ENOENT。
  // 默认改用本机受保护素材里的长篇素材（170KB、34 个公式、14 张表格）：原文件只读，
  // 断言它一个字节都没变（见下方 sha256 校验），实际编辑都发生在 output/ 下的副本上。
  // 特意选**不含相对图片引用**的那份：带 assets/xxx.png 的素材会被渲染层改写成伪域名，
  // 于是「编辑器取值 == 宿主文本」这条断言永远不成立（那是另一条链要覆盖的场景）。
  // 可用 EXPORT_LARGE_SOURCE 覆盖。
  const original=path.resolve(process.env.EXPORT_LARGE_SOURCE||'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md');
  if(!fs.existsSync(original))throw new Error('长篇导出素材未就位：'+original+'（可用 EXPORT_LARGE_SOURCE 指定）');
  const contents=fs.readFileSync(original),hash=crypto.createHash('sha256').update(contents).digest('hex');
  const folder=path.join(output,'export-book');fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'长文档导出.md');fs.writeFileSync(file,contents);
  global.doc.setSetting('autoSave',false);global.doc.setSetting('snapshots',false);
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
  const iframe='document.getElementById("editor").contentWindow';await until(`!!${iframe}.vditor?.vditor?.__typoraPatched`);
  // The 'open' push (gated on completions.ready) lands seconds after the
  // frame boots on this notebook and would overwrite edits made before it.
  for(let i=0;i<500;i++){const view=await ev(`${iframe}.vditor.getValue()`).catch(()=>'');if(view===global.doc.current.text)break;await new Promise(r=>setTimeout(r,30));}
  if(await ev(`${iframe}.vditor.getValue()`)!==global.doc.current.text)throw new Error('Editor did not receive the open content');
  // Real edit+save timing on the full notebook (not a diff micro-benchmark):
  // one typed insertion, full change propagation, full-document save.
  const editStart=Date.now();
  // All DOM work must run inside the editor iframe's own document scope.
  await ev(`(()=>{const w=${iframe};const d=w.document;const r=w.vditor.vditor.ir.element;r.focus();const walker=d.createTreeWalker(r,w.NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){if(n.length>2&&!n.parentElement.closest('.vditor-ir__preview'))break;}if(!n)throw new Error('No editable text in notebook');w.getSelection().collapse(n,n.length);if(!d.execCommand('insertText',false,'性能测点'))throw new Error('insertText returned false');})()`);
  for(let i=0;i<500&&!global.doc.current.text.includes('性能测点');i++)await new Promise(r=>setTimeout(r,30));
  if(!global.doc.current.text.includes('性能测点'))throw new Error('Long-document edit did not propagate; editor has marker: '+await ev(`${iframe}.vditor.getValue()`).then(t=>t.includes('性能测点'))+'; cur.text chars: '+global.doc.current.text.length+'; dirty: '+global.doc.current.dirty);
  if(await global.doc.save()!==true)throw new Error('Long-document save failed');
  const editMs=Date.now()-editStart;
  const captured=await ev(`${iframe}.vditor.getValue()`),results=[];
  const old=dialog.showSaveDialog;let target;dialog.showSaveDialog=async()=>({canceled:false,filePath:target});
  try{
    for(const format of ['html','pdf','docx']){
      target=path.join(folder,'动态规划教材.'+format);const start=Date.now();
      const result=await ev(`hostApi.invoke('export',{format:${JSON.stringify(format)}})`);
      if(result.phase!=='done')throw new Error(JSON.stringify(result));
      results.push({format,ms:Date.now()-start,bytes:fs.statSync(target).size,...result});
      if(format==='html'){
        const html=fs.readFileSync(target,'utf8');const formulaCount=(html.match(/class="language-math(?: katex-error)?"/g)||[]).length;
        if(formulaCount!==result.formulas)throw new Error('Formula export count differs');
        if(html.includes('127.0.0.1'))throw new Error('Local app URL leaked');
      }
      if(format==='docx'&&!fs.readFileSync(target).subarray(0,2).equals(Buffer.from('PK')))throw new Error('DOCX missing ZIP header');
      if(await ev(`${iframe}.vditor.getValue()`)!==captured)throw new Error('Editor changed during export');
    }
    for(const theme of ['konayuki-light','konayuki-dark']){
      await ev(`document.documentElement.dataset.editorTheme=${JSON.stringify(theme)}`);
      fs.writeFileSync(path.join(folder,'export-dialog-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    const after=crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex');if(after!==hash)throw new Error('Original notebook changed');
    fs.writeFileSync(path.join(output,'export-book.json'),JSON.stringify({source:original,sourceChars:contents.length,sourceSHA256:hash,editSaveMs:editMs,results},null,2));
    return results.map(r=>`PASS full notebook ${r.format}: ${r.formulas} formulas, ${r.ms} ms, ${r.bytes} bytes, ${r.warnings.length} explicit warnings; original unchanged`).concat([`PASS full notebook real edit+save: ${contents.length} chars, ${editMs} ms end to end`]);
  }finally{dialog.showSaveDialog=old;global.doc.current.dirty=false;}
};
