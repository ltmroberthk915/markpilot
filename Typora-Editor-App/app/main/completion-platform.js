'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {dialog}=require('electron');
const {CompletionManager}=require('../shared/out/completion/host.cjs');
const {CompletionDialog}=require('./completion-dialog');
const uri=file=>({fsPath:path.resolve(file),toString(){return pathToFileURL(this.fsPath).href;}});

async function findPaths(root,token,limit=1500) {
  const files=[],queue=[root];let scanned=0;
  while(queue.length&&files.length<limit&&scanned<12000&&!token.isCancellationRequested) {
    const directory=queue.shift();let entries;
    try{entries=await fs.readdir(directory,{withFileTypes:true});}catch{continue;}
    for(const entry of entries) {
      if(token.isCancellationRequested||files.length>=limit||++scanned>=12000)break;
      if(entry.isSymbolicLink())continue;
      const full=path.join(directory,entry.name);
      if(entry.isDirectory()) {if(!/^(node_modules|\.git|dist|build|\.venv)$/i.test(entry.name))queue.push(full);}
      else if(entry.isFile()&&/\.(md|markdown|png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(entry.name))files.push(uri(full));
    }
  }
  return files;
}
function createCompletionManager(doc) {
  const ui=new CompletionDialog(doc.win,doc.port), commands=new Map();
  // 单一发行版：不再有“公版把密钥存根换掉”这条分支，远端补全与密钥保险库始终在。
  const secrets=new (require('./completion-vault').CompletionVault)();
  const context={subscriptions:[],secrets,globalState:{get:key=>doc.state.get(key),update:async(key,value)=>{doc.state.set(key,value);doc.state.saveNow();}}};
  const platform={completionProviderAvailable:false,Uri:{joinPath:(base,...parts)=>uri(path.join(base.fsPath,...parts))},
    RelativePattern:class {constructor(base,pattern){this.base=base;this.pattern=pattern;}},
    CancellationTokenSource:class {constructor(){this.token={isCancellationRequested:false};}cancel(){this.token.isCancellationRequested=true;}dispose(){}},
    Position:class {constructor(line,character){this.line=line;this.character=character;}},
    commands:{registerCommand:(name,run)=>{commands.set(name,run);return {dispose:()=>commands.delete(name)};},executeCommand:async()=>({items:[]})},
    window:{showInputBox:options=>ui.input(options),showQuickPick:(items,options)=>ui.pick(items,options),
      showInformationMessage:message=>dialog.showMessageBox(doc.win,{type:'info',message,buttons:['确定']})},
    workspace:{getWorkspaceFolder:()=>{const root=doc.workspaceRoot?.()??global.workspace?.root;return root?{uri:uri(root)}:undefined;},
      findFiles:(pattern,_exclude,limit,token)=>findPaths(pattern.base.fsPath,token,limit)},
  };
  const manager=new CompletionManager(context,platform);
  doc.win.on('closed',()=>{for(const item of context.subscriptions)item.dispose();});
  return manager;
}
module.exports={createCompletionManager,findPaths,uri};
