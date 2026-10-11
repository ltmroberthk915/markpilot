'use strict';
const {ipcMain} = require('electron');
// 2.1.0 多窗口：每个窗口一个补全设置对话框，但同一个 ipcMain 通道只能注册一次
// （第二个窗口注册时直接抛 "Attempted to register a second handler"），所以注册
// 一次、按发起它的 webContents 路由到对应实例。通道注册与窗口生命周期解耦：
// 关掉一个窗口不能再把全局通道摘掉，否则别的窗口的设置框立刻失效。
const dialogs = new Map(); // webContents.id -> CompletionDialog
let installed = false;
function route(event, response) {
  const dialog = dialogs.get(event.sender.id);
  if (!dialog) return {error:'设置窗口已失效。'};
  return dialog.receive(event, response);
}
class CompletionDialog {
  constructor(win, port) {
    this.win=win;this.port=port;this.sequence=0;this.pending=null;
    const id=win.webContents.id;this.id=id;
    dialogs.set(id,this);
    if(!installed){installed=true;ipcMain.handle('shell:completion-dialog-result',route);}
    win.on('closed',()=>{this.pending?.resolve(undefined);this.pending=null;dialogs.delete(id);});
  }
  async receive(event,response) {
    const item=this.pending;
    if(event.sender!==this.win.webContents||event.senderFrame!==this.win.webContents.mainFrame||
       event.senderFrame.url!==`http://127.0.0.1:${this.port}/shell`||!item||response?.id!==item.id)return {error:'设置窗口已失效。'};
    if(response.cancel){this.pending=null;item.resolve(undefined);return {closed:true};}
    if(item.kind==='input') {
      if(typeof response.value!=='string'||response.value.length>8192)return {error:'输入内容过长。'};
      const error=await item.options.validateInput?.(response.value);
      if(error)return {error:typeof error==='string'?error:error.message};
      this.pending=null;item.resolve(response.value);
    } else {
      if(!Number.isInteger(response.index)||!item.items[response.index])return {error:'请选择有效项目。'};
      this.pending=null;item.resolve(item.items[response.index]);
    }
    return {closed:true};
  }
  show(kind,options,items) {
    this.pending?.resolve(undefined);
    const id=++this.sequence;
    return new Promise(resolve=>{
      this.pending={id,kind,options,items,resolve};
      this.win.webContents.send('completion-dialog',{id,kind,title:options.title,prompt:options.prompt||options.placeHolder||'',
        password:!!options.password,value:options.password?'':options.value||'',items:items?.map(item=>({label:item.label,description:item.description,detail:item.detail}))});
    });
  }
  input(options){return this.show('input',options);}
  pick(items,options={}){return this.show('pick',options,items);}
}
module.exports={CompletionDialog};
