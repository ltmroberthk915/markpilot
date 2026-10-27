'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const implementation=path.resolve(process.env.MP_PDF_POLICY_MODULE||path.join(__dirname,'../../../MarkPilot-CM6/export-pdf.js'));
function load(){
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(implementation,'utf8'),{
    module,exports:module.exports,require:createRequire(implementation),__dirname:path.dirname(implementation),
    Buffer,console,process:{env:{}},setTimeout:(...args)=>{const timer=setTimeout(...args);timer.unref();return timer;},clearTimeout,
  },{filename:implementation});
  return module.exports.printLocalHtmlToPdf;
}
async function render(kp,{cancelAt}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-pdf-layout-'));
  assert.equal(path.dirname(dir),fs.realpathSync(os.tmpdir()));
  const htmlFile=path.join(dir,'input.html'),outFile=path.join(dir,'output.pdf');
  fs.writeFileSync(htmlFile,'<!doctype html><meta charset="utf-8"><p>Known text 中文 <strong>bold</strong></p>');
  const ipcMain=new EventEmitter(),trace={phases:[],printCalls:0,typesetCalls:0,destroyed:false};let canceled=false;
  class Window {
    constructor(){this.webContents=new EventEmitter();Object.assign(this.webContents,{
      insertCSS:async()=>{},
      executeJavaScript:async code=>{
        if(code.includes('document.querySelectorAll'))return 1;
        if(code.includes('typesetArticle(document.body')){trace.typesetCalls++;return {applied:1,lines:1};}
      },
      printToPDF:async()=>{
        trace.printCalls++;trace.phasesAtPrint=[...trace.phases];
        return Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Count 1 >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF');
      },
    });}
    loadFile(){return new Promise(resolve=>setImmediate(()=>{this.webContents.emit('dom-ready');ipcMain.emit('mp:print-ready',{sender:this.webContents},{complete:0,natural:0});resolve();}));}
    isDestroyed(){return trace.destroyed;}
    destroy(){trace.destroyed=true;}
  }
  try{
    const result=await load()({BrowserWindow:Window,ipcMain,htmlFile,outFile,kp,sourceBytes:100,
      isCanceled:()=>canceled,onPhase:p=>{trace.phases.push(p.phase);if(p.phase===cancelAt)canceled=true;},
    });
    return {result,...trace,outputExists:fs.existsSync(outFile),readyListeners:ipcMain.listenerCount('mp:print-ready')};
  }finally{
    assert.equal(path.dirname(path.resolve(dir)),fs.realpathSync(os.tmpdir()));
    assert(path.basename(dir).startsWith('mp-pdf-layout-'));fs.rmSync(dir,{recursive:true,force:true});
  }
}
test('default PDF uses native layout and reports actual print start once',async()=>{
  const r=await render(undefined);assert(r.result.ok&&r.outputExists&&r.destroyed);assert.equal(r.typesetCalls,0);
  assert.equal(r.printCalls,1);assert.equal(r.phases.filter(x=>x==='print-start').length,1);
  assert.equal(r.phasesAtPrint.at(-1),'print-start');assert.equal(r.readyListeners,0);
});
test('explicit true and object retain fine typesetting',async()=>{
  for(const kp of [true,{}]){const r=await render(kp);assert(r.result.ok);assert.equal(r.typesetCalls,1);assert.equal(r.result.kp.applied,1);assert.equal(r.phases.filter(x=>x==='print-start').length,1);}
});
test('false and null retain native layout',async()=>{
  for(const kp of [false,null]){const r=await render(kp);assert(r.result.ok);assert.equal(r.typesetCalls,0);assert.equal(r.printCalls,1);}
});
test('cancel after styles never enters native printing or publishes a PDF',async()=>{
  const r=await render(undefined,{cancelAt:'style'});assert(r.result.canceled&&r.destroyed);assert.equal(r.printCalls,0);
  assert(!r.outputExists&&!r.phases.includes('print-start'));assert.equal(r.readyListeners,0);
});
test('cancel after optional fine layout also never enters printing',async()=>{
  const r=await render({}, {cancelAt:'typeset'});assert(r.result.canceled);assert.equal(r.typesetCalls,1);assert.equal(r.printCalls,0);assert(!r.outputExists);
});
