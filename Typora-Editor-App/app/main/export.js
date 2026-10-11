'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {BrowserWindow, dialog, shell} = require('electron');
const {atomicWrite} = require('./snapshots');
const {embedImages, exportStyles} = require('./export-assets');
const {portableMarkdown}=require('../renderer/js/portable-markdown.cjs');
const FORMATS = {docx:'Word 文档（可编辑公式）',pdf:'PDF 文档', html:'HTML（独立网页）', md:'便携 Markdown（内嵌图片）'};
async function fingerprint(file) {
  try {const s=await fs.lstat(file);return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function distinctTarget(source, target) {
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) throw new Error('请另选导出路径，不能覆盖正在编辑的原文件');
  try {
    const [a,b] = await Promise.all([fs.stat(source),fs.stat(target)]);
    if (a.dev === b.dev && a.ino === b.ino) throw new Error('导出路径指向原文件，请另选路径');
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
}

// printToPDF 没有可中断通道（Electron 44 的 PrintToPDFOptions 无 signal 字段），
// 销毁 worker 后该 promise 也不保证 settle（electron#29485 关闭时无对应修复记录）。
// 把 AbortSignal 桥接成会 reject 的 promise，供 await 处与 Promise.race 竞速：
// 用户取消/180s 超时触发 abort 时立刻醒来，终态仍交回 run() 的 catch/finally 发出。
function abortPromise(signal) {
  if (signal.aborted) return Promise.reject(signal.reason||new Error('导出已取消'));
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason||new Error('导出已取消')),{once:true}));
}

class DocumentExporter {
  constructor({win, doc, resourceAuth, rendererRoot, shellRoot}) {Object.assign(this,{win,doc,resourceAuth,rendererRoot,shellRoot});this.job=null;this.last=null;win.once('closed',()=>this.cancel());}
  send(value) {if (!this.win.isDestroyed()) this.win.webContents.send('export-status',value);}
  cancel() {if(this.job&&!this.job.committing){this.job.controller.abort();this.job.window?.destroy();}}
  async openResult(reveal) {
    if(!this.last)return false;
    if(reveal)shell.showItemInFolder(this.last);
    else {const error=await shell.openPath(this.last);if(error)throw new Error(error);}
    return true;
  }
  async run(format) {
    if (!FORMATS[format]) return {error:'不支持的导出格式'};
    if (this.job) return {error:'已有导出任务正在进行'};
    const current = this.doc.current;
    if (!current) return {error:'请先打开文件'};
    const job = {controller:new AbortController(), window:null, committing:false};this.job=job;
    let timeout;
    try {
      // Capture the live editor, including input still waiting in its debounce.
      const captured = await this.win.webContents.executeJavaScript(`(() => {const frame=document.getElementById('editor');const editor=frame?.contentWindow?.vditor;if(!editor)return null;return {text:editor.getValue(),url:frame.src};})()`);
      if (this.doc.current !== current || !captured || decodeURIComponent(new URL(captured.url).pathname.slice(5)) !== current.file) throw new Error('编辑器尚未就绪或文件已切换，请重试');
      captured.text=this.doc.diskText(current,captured.text);
      const source = current.file, ext = path.extname(source), title = path.basename(source,ext);
      const chosen = await dialog.showSaveDialog(this.win, {title:'导出 ' + FORMATS[format], defaultPath:path.join(path.dirname(source),title+(format==='md'?'-导出':'')+'.'+format), filters:[{name:FORMATS[format],extensions:[format]}], properties:['showOverwriteConfirmation','createDirectory']});
      // 取消保存对话框不产出文件，但要给外壳一条 quiet 通知，清掉上一次导出留在
      // 对话框里的「已导出 …」残影（否则用户会以为刚取消的这次真导出了）。
      if (chosen.canceled || !chosen.filePath) { this.send({phase:'canceled',canceled:true,quiet:true}); return {canceled:true}; }
      const target = chosen.filePath.toLowerCase().endsWith('.'+format) ? chosen.filePath : chosen.filePath+'.'+format;
      await distinctTarget(source,target);
      const initialTarget=await fingerprint(target);
      job.controller.signal.throwIfAborted();
      this.send({phase:'working',message:'正在生成 '+FORMATS[format]+'…'});
      timeout=setTimeout(()=>{job.timedOut=true;this.cancel();},180000);
      let data = captured.text, warnings = [], counts = {};
      if(format==='md')data=(await portableMarkdown(captured.text,{file:source,signal:job.controller.signal})).text;
      if(format==='docx'){
        const worker=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,spellcheck:false}});job.window=worker;this.resourceAuth.allow(worker.webContents);
        worker.webContents.setWindowOpenHandler(()=>({action:'deny'}));worker.webContents.on('will-navigate',event=>event.preventDefault());
        await worker.loadURL(this.resourceAuth.origin+'/render/office.html');
        const evaluate=async code=>{const result=await worker.webContents.executeJavaScript(`(async()=>{try{return{ok:true,value:await (${code})};}catch(error){return{ok:false,error:error.message};}})()`);if(!result.ok)throw new Error(result.error);return result.value;};
        for(let i=0;i<200&&!await evaluate('!!window.prepareWord');i++)await new Promise(resolve=>setTimeout(resolve,20));
        const prepared=await evaluate(`window.prepareWord(${JSON.stringify({text:captured.text,title})})`);
        this.send({phase:'working',message:`正在转换 ${prepared.formulas} 个公式并嵌入图片…`});
        const embedded=await embedImages(prepared.images,{file:source,origin:this.resourceAuth.origin,signal:job.controller.signal});
        const result=await evaluate(`window.finishWord(${JSON.stringify({assets:embedded.assets,assetWarnings:embedded.warnings})})`);
        // Word 产物 base64 上限与 VSIX 侧 office-export.cjs 同口径（200,000,000 字符），
        // 在 Buffer.from 之前拦截，超限拒绝落盘，避免巨量 Buffer 再放大内存。
        if (typeof result.data!=='string'||result.data.length>200000000) throw new Error('Word 导出数据无效或过大');
        data=Buffer.from(result.data,'base64');warnings=result.warnings;counts={...prepared,...result.counts,packMs:result.packMs};
      }else if (format !== 'md') {
        const worker = new BrowserWindow({show:false, width:900, height:1000, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,spellcheck:false}});
        job.window=worker;this.resourceAuth.allow(worker.webContents);
        worker.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        worker.webContents.on('will-navigate',event=>event.preventDefault());
        await worker.loadURL(this.resourceAuth.origin+'/shell/export.html');
        if(format==='pdf'){
          worker.webContents.debugger.attach('1.3');
          await worker.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{media:'print'});
        }
        const evaluate=code=>worker.webContents.executeJavaScript(code);
        const css=await exportStyles(this.rendererRoot,this.shellRoot);
        counts=await evaluate(`window.prepareExport(${JSON.stringify({text:captured.text,title,css,format})})`);
        this.send({phase:'working',message:`已处理 ${counts.formulas} 个公式、${counts.diagrams} 个图表，正在嵌入图片…`});
        const embedded=await embedImages(counts.images,{file:source,origin:this.resourceAuth.origin,signal:job.controller.signal});
        const rendered=await evaluate(`window.finishExport(${JSON.stringify({assets:embedded.assets,assetWarnings:embedded.warnings})})`);
        warnings=rendered.warnings;
        if (format==='pdf' && rendered.kpSkipped) this.send({phase:'working',message:'超大文档兼容模式：已跳过精细断行（Knuth-Plass），改用标准两端对齐，正在打印 PDF…'});
        // 标题书签与无障碍结构是已宣传特性，小文档必须保留；两者的构建成本随
        // 「节点数×页数」放大打印内存，仅在 worker 侧 KP 预算跳过（rendered.kpSkipped，
        // 与 F2 同一判定、单点计算）的超大文档上联动关闭。
        if (format==='html') data=rendered.html;
        else {
          // 正常（非超大）文档的打印阶段此前从「正在嵌入图片…」直接静默到「正在保存」，
          // printToPDF 布局是全程最长的黑窗；超大文档的上一条消息已含「正在打印 PDF…」，不重发。
          if (!rendered.kpSkipped) this.send({phase:'working',message:'正在打印 PDF…'});
          // 与 abort 桥接 promise 竞速：取消/超时触发 abort 时这里立刻 reject，走 run()
          // 的 catch/finally 收尾；输掉的迟到 printToPDF promise 由下面的 catch 吞掉，防
          // 主进程未处理拒绝。atomicWrite 只在竞速胜出且其后的 throwIfAborted 通过后
          // 才可达——迟到 resolve 的数据永远到不了落盘。
          const printing=worker.webContents.printToPDF({printBackground:true,preferCSSPageSize:true,pageSize:'A4',margins:{top:0,bottom:0,left:0,right:0},generateTaggedPDF:!rendered.kpSkipped,generateDocumentOutline:!rendered.kpSkipped});
          printing.catch(()=>{});
          data=await Promise.race([printing,abortPromise(job.controller.signal)]);
        }
      }
      job.controller.signal.throwIfAborted();
      job.committing=true;clearTimeout(timeout);
      this.send({phase:'working',message:'正在保存导出文件…',committing:true});
      await atomicWrite(target,data,{beforeCommit:async()=>{
        await distinctTarget(source,target);
        if(await fingerprint(target)!==initialTarget)throw new Error('导出目标在生成期间被修改，请另选路径或重新导出');
      }});
      this.last=target;
      // 「导出完不知道文件去哪了」的直接解法：成功后就在资源管理器里选中该文件。
      // 定位失败（无桌面环境、路径已消失）绝不能把一次成功的导出变成失败。
      try { shell.showItemInFolder(target); } catch {}
      const result={phase:'done',path:target,warnings,formulas:counts.formulas||0,diagrams:counts.diagrams||0};this.send(result);return result;
    } catch(error) {
      const result=job.controller.signal.aborted&&!job.timedOut ? {phase:'canceled',canceled:true} : {phase:'error',error:job.timedOut?'导出超时，请重试或检查文档中的大型图表':error.message};
      this.send(result);return result;
    } finally {clearTimeout(timeout);if(job.window&&!job.window.isDestroyed())job.window.destroy();if(this.job===job)this.job=null;}
  }
}
module.exports={DocumentExporter,FORMATS,distinctTarget,fingerprint};
