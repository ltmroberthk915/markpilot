'use strict';

// Use the IDE's own attachment command. No prompt is submitted and no
// clipboard/native text editor switch is involved.
class NativeChat {
  constructor(context,platform=require('vscode')){
    this.platform=platform;this.sessions=new Map();
    context.subscriptions.push(platform.commands.registerCommand('markpilot.addSelectionToChat',()=>{
      const session=[...this.sessions.values()].find(item=>item.panel.active);
      if(session)session.handler.emit('chat-selection-request');
    }));
  }
  bind({document,panel,handler,compact,images,synchronized}){
    const vscode=this.platform,session={panel,handler};this.sessions.set(panel,session);
    let pending=null,disposed=false;
    const finish=id=>{if(pending?.id===id)pending=null;if(!disposed)handler.emit('chat-selection-result',{id});};
    const failed=(id,error)=>{finish(id);if(!disposed)vscode.window.showWarningMessage(error);};
    handler.on('chat-selection-empty',()=>{if(!disposed)vscode.window.showInformationMessage('请先选中需要加入 AI 对话的正文。');});
    handler.on('chat-selection-start',async message=>{
      if(!message||!Number.isSafeInteger(message.id)||disposed)return;
      const job={id:message.id};pending=job;
      try{
        await synchronized();
        if(disposed||pending!==job)return;
        job.source=compact();job.version=document.version;
        handler.emit('chat-selection-source',{id:job.id,source:job.source,version:job.version});
      }catch(error){if(!disposed&&pending===job)failed(job.id,'选区同步失败：'+(error?.message||String(error)));}
    });
    handler.on('chat-selection-failed',message=>{
      if(pending&&pending.id===message?.id)failed(message.id,typeof message.error==='string'?message.error:'选区同步失败，请重试 Alt+U。');
    });
    handler.on('chat-selection-range',async message=>{
      const job=pending;if(!job||message?.id!==job.id||disposed||job.sending)return;
      job.sending=true;
      try{
        await synchronized();
        if(disposed||pending!==job)return;
        if(!panel.active)return finish(job.id);
        const {start,end,version}=message;
        if(version!==job.version||version!==document.version||job.source!==compact())throw Error('正文已更新，请重新选择后按 Alt+U。');
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>job.source.length)throw Error('无效的正文选区。');
        const a=document.positionAt(images.rawOffset(job.source,start)),b=document.positionAt(images.rawOffset(job.source,end));
        const range={startLineNumber:a.line+1,startColumn:a.character+1,endLineNumber:b.line+1,endColumn:b.character+1};
        const commands=await vscode.commands.getCommands(true);
        if(disposed||pending!==job)return;
        if(!panel.active)return finish(job.id);
        if(document.version!==version)throw Error('正文已更新，请重新选择后按 Alt+U。');
        // Trae uses this same payload for its built-in document view.
        if(commands.includes('workbench.action.chat.icube.open')){
          await vscode.commands.executeCommand('workbench.action.chat.icube.open',{
            source:10,addToChat:true,keepOpen:true,
            docviewPayload:{type:'file',uri:document.uri,selection:{...range,
              selectionStartLineNumber:range.startLineNumber,selectionStartColumn:range.startColumn,
              positionLineNumber:range.endLineNumber,positionColumn:range.endColumn}},
          });
          if(disposed||pending!==job||!panel.active)return finish(job.id);
          // Trae's v2 input ignores its legacy focusInput event and view.focus.
          // Completing an empty native attachment batch focuses the live input;
          // the empty list adds nothing, preserves its draft and submits nothing.
          await vscode.commands.executeCommand('workbench.action.chat.icube.open',{
            source:10,addToChat:true,keepOpen:true,figmaPayload:{figmaList:[]},
          });
        }else if(commands.includes('workbench.action.chat.open')){
          await vscode.commands.executeCommand('workbench.action.chat.open',{attachFiles:[{uri:document.uri,range}]});
          if(disposed||pending!==job||!panel.active)return finish(job.id);
          await vscode.commands.executeCommand('workbench.action.chat.focusInput');
        }else throw Error('当前 IDE 没有可用的 AI 对话侧边栏。');
        finish(job.id);
      }catch(error){if(!disposed&&pending===job)failed(job.id,'加入 AI 对话失败：'+(error?.message||String(error)));}
    });
    panel.onDidDispose(()=>{disposed=true;pending=null;this.sessions.delete(panel);});
  }
}
module.exports={NativeChat};
