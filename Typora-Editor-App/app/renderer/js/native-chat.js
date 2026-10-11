import {selectedMarkdownRange} from './split-navigation.js';

// Installed only when the extension host advertises native chat support.
// Remember the range, not copied text: repeated words/cells keep their identity.
export function installNativeChat(api){
  const editor=api.vditor,handler=window.handler,listeners=[];
  let saved=null,pending=null,sequence=0,revision=0,destroyed=false;
  const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);listeners.push(()=>target.removeEventListener(type,fn,options));};
  const valid=range=>range&&!range.collapsed&&range.startContainer.isConnected&&range.endContainer.isConnected&&
    (editor[editor.currentMode].element.contains(range.commonAncestorContainer)||editor.currentMode==='sv'&&editor.preview.previewElement.contains(range.commonAncestorContainer));
  const remember=()=>{
    const selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0):null;
    if(valid(range))saved={range:range.cloneRange(),mode:editor.currentMode};
    else if(selection.isCollapsed&&editor[editor.currentMode].element.contains(selection.anchorNode)&&document.hasFocus())saved=null;
  };
  const finish=()=>{if(pending)clearTimeout(pending.timer);pending=null;};
  const request=()=>{
    if(destroyed||pending)return;
    remember();
    if(!saved||saved.mode!==editor.currentMode||!valid(saved.range)){handler.emit('chat-selection-empty');return;}
    api.__completion?.flushChanges();
    const id=++sequence;
    pending={id,range:saved.range.cloneRange(),mode:saved.mode,revision,timer:setTimeout(()=>{finish();handler.emit('chat-selection-failed',{id,error:'选区同步超时，请重试 Alt+U。'});},10000)};
    handler.emit('chat-selection-start',{id});
  };
  handler.on('chat-selection-request',request).on('chat-selection-source',message=>{
    if(destroyed||!pending||pending.id!==message?.id)return;
    try{
      if(pending.revision!==revision||pending.mode!==editor.currentMode||!valid(pending.range))throw Error('选区已改变，请重新选择后按 Alt+U。');
      const range=selectedMarkdownRange(api,pending.range,message.source);
      if(!range)throw Error('请选中需要加入 AI 对话的正文。');
      handler.emit('chat-selection-range',{id:pending.id,version:message.version,...range});
    }catch(error){handler.emit('chat-selection-failed',{id:pending.id,error:error.message});finish();}
  }).on('chat-selection-result',message=>{if(pending?.id===message?.id)finish();});
  listen(document,'selectionchange',remember);
  listen(window,'input',()=>{revision++;saved=null;},true);
  listen(window,'keydown',event=>{
    // Accessibility and remote input can provide a key without a scan code.
    const isU=event.code==='KeyU'||(!event.code&&event.key?.toLowerCase()==='u');
    if(event.defaultPrevented||!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!isU)return;
    const root=editor[editor.currentMode].element;
    if(!root.contains(event.target)&&!(editor.currentMode==='sv'&&editor.preview.previewElement.contains(getSelection().anchorNode)))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(!event.repeat&&!event.isComposing&&!editor[editor.currentMode].composingLock)request();
  },true);
  api.__nativeChat={request,destroy(){destroyed=true;finish();saved=null;listeners.forEach(remove=>remove());}};
  const destroy=api.destroy.bind(api);api.destroy=(...args)=>{api.__nativeChat.destroy();return destroy(...args);};
}
