// Runs the real renderer bridge with local selection/event/timer doubles only.
// No browser, IDE, clipboard or AI request is involved.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../Typora-Editor/extension-src/render/js/native-chat.js'),'utf8')
  .replace("import {selectedMarkdownRange} from './split-navigation.js';",'')
  .replace('export function installNativeChat','function installNativeChat');
const target=()=>({events:new Map(),addEventListener(name,fn){this.events.set(name,fn);},removeEventListener(name,fn){if(this.events.get(name)===fn)this.events.delete(name);}});
function fixture(options={}){
  const events=new Map(),sent=[],timers=new Map(),mapped=[];let nextTimer=0,flushes=0,closed=0;
  const roots=Object.fromEntries(['ir','wysiwyg','sv','preview'].map(mode=>[mode,{contains:n=>n?.root===mode}]));
  const node={root:options.mode||'ir',isConnected:true},outside={root:'outside',isConnected:true};
  const range={collapsed:false,startContainer:node,endContainer:node,commonAncestorContainer:node,cloneRange(){return{...this};}};
  let selection={rangeCount:1,isCollapsed:false,anchorNode:node,getRangeAt:()=>range};
  const handler={on(name,fn){events.set(name,fn);return this;},emit(name,data){sent.push({name,data:data===undefined?undefined:JSON.parse(JSON.stringify(data))});}};
  const window={...target(),handler},document={...target(),hasFocus:()=>true};
  const editor={currentMode:options.mode||'ir',preview:{previewElement:roots.preview}};
  for(const mode of ['ir','wysiwyg','sv'])editor[mode]={element:roots[mode],composingLock:false};
  const api={vditor:editor,__completion:{flushChanges(){flushes++;}},destroy(value){closed++;return value;}};
  const context={window,document,getSelection:()=>selection,
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    selectedMarkdownRange:(...args)=>{mapped.push(args);return options.map?options.map(...args):{start:6,end:10};}};
  vm.runInNewContext(source+';this.install=installNativeChat;',context);context.install(api);
  const emit=(name,data)=>events.get('chat-selection-'+name)(data);
  const key=(overrides={})=>{const event={target:node,altKey:true,code:'KeyU',key:'u',defaultPrevented:false,
    preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...overrides};window.events.get('keydown')?.(event);return event;};
  const select=(kind='valid')=>{selection=kind==='valid'?{rangeCount:1,isCollapsed:false,anchorNode:node,getRangeAt:()=>range}:
    {rangeCount:0,isCollapsed:true,anchorNode:kind==='collapsed'?node:outside,getRangeAt:()=>null};document.events.get('selectionchange')?.();};
  return{api,editor,node,outside,range,window,document,sent,mapped,timers,emit,key,select,
    get flushes(){return flushes;},get closed(){return closed;},request:()=>api.__nativeChat.request(),
    reply:(extra={})=>emit('source',{id:1,source:'alpha 中文🙂\n',version:7,...extra}),
    expire(){const pending=[...timers.values()];timers.clear();pending.forEach(t=>t.fn());},
    messages:name=>sent.filter(e=>e.name==='chat-selection-'+name)};
}

test('selected range survives the async source round trip with its exact version',()=>{const f=fixture();f.request();assert.equal(f.flushes,1);assert.deepEqual(f.messages('start').map(e=>e.data),[{id:1}]);f.reply();assert.deepEqual(f.messages('range').map(e=>e.data),[{id:1,version:7,start:6,end:10}]);assert.notEqual(f.mapped[0][1],f.range);assert.equal(f.mapped[0][1].startContainer,f.node);assert.equal(f.mapped[0][2],'alpha 中文🙂\n');f.emit('result',{id:1});assert.equal(f.timers.size,0);});
test('selection saved before clicking the sidebar remains available',()=>{const f=fixture();f.select();f.select('outside');f.emit('request');f.reply();assert.equal(f.messages('range').length,1);});
test('an explicitly collapsed document selection cannot reuse an older range',()=>{const f=fixture();f.select();f.select('collapsed');f.request();assert.equal(f.messages('empty').length,1);assert.equal(f.messages('start').length,0);});
test('Alt+U works when accessibility input provides only the key',()=>{const f=fixture();const e=f.key({code:'',key:'U'});assert.equal(e.defaultPrevented,true);assert.equal(e.stopped,true);assert.equal(f.messages('start').length,1);});
test('source-mode rendered preview selection can trigger Alt+U',()=>{const f=fixture({mode:'sv'});f.node.root='preview';const e=f.key({target:f.outside});assert.equal(e.defaultPrevented,true);f.reply();assert.equal(f.messages('range').length,1);});
test('an unrelated window element cannot intercept Alt+U',()=>{const f=fixture();const e=f.key({target:f.outside});assert.equal(e.defaultPrevented,false);assert.equal(f.sent.length,0);});
for(const [name,overrides] of [['Control',{ctrlKey:true}],['Meta',{metaKey:true}],['Shift',{shiftKey:true}],['missing Alt',{altKey:false}],['wrong scan code',{code:'KeyA'}],['already handled',{defaultPrevented:true}]]){
  test(name+' does not start an AI selection request',()=>{const f=fixture();f.key(overrides);assert.equal(f.sent.length,0);});
}
test('key repeat and IME composition cannot create attachments',()=>{for(const option of ['repeat','isComposing','composingLock']){const f=fixture();if(option==='composingLock')f.editor.ir.composingLock=true;f.key(option==='composingLock'?{}:{[option]:true});assert.equal(f.sent.length,0,option);}});
test('repeated requests during synchronization send only one start',()=>{const f=fixture();f.request();f.request();f.emit('request');f.key();assert.equal(f.messages('start').length,1);assert.equal(f.timers.size,1);});
test('empty late source messages cannot throw when there is no pending request',()=>{const f=fixture();for(const message of [undefined,null,{}, {id:1}])assert.doesNotThrow(()=>f.emit('source',message));assert.equal(f.sent.length,0);assert.equal(f.mapped.length,0);});
test('source messages after completion cannot revive the finished request',()=>{const f=fixture();f.request();f.reply();f.emit('result',{id:1});for(const message of [undefined,null,{}, {id:1,source:'late'}])assert.doesNotThrow(()=>f.emit('source',message));assert.equal(f.messages('range').length,1);assert.equal(f.messages('failed').length,0);});
test('timeout rejects once and late messages do not block a later retry',()=>{const f=fixture();f.request();assert.equal([...f.timers.values()][0].ms,10000);f.expire();assert.equal(f.messages('failed').length,1);for(const message of [undefined,{}, {id:1}])assert.doesNotThrow(()=>f.emit('source',message));f.request();f.reply({id:2});assert.equal(f.messages('range').at(-1).data.id,2);});
test('typing while source synchronization is pending invalidates the range',()=>{const f=fixture();f.request();f.window.events.get('input')();f.reply();assert.equal(f.mapped.length,0);assert.match(f.messages('failed')[0].data.error,/选区已改变/);assert.equal(f.timers.size,0);});
test('switching modes before a source response cannot map a stale DOM range',()=>{const f=fixture();f.request();f.editor.currentMode='wysiwyg';f.reply();assert.equal(f.mapped.length,0);assert.equal(f.messages('failed').length,1);});
test('a removed selection node is rejected before source mapping',()=>{const f=fixture();f.request();f.node.isConnected=false;f.reply();assert.equal(f.mapped.length,0);assert.equal(f.messages('failed').length,1);});
test('a response for another request leaves the current range pending',()=>{const f=fixture();f.request();f.reply({id:99});f.emit('result',{id:99});assert.equal(f.mapped.length,0);assert.equal(f.timers.size,1);f.reply();assert.equal(f.messages('range').length,1);});
test('a missing mapped range fails cleanly and allows a new request',()=>{const f=fixture({map:()=>null});f.request();f.reply();assert.match(f.messages('failed')[0].data.error,/请选中/);assert.equal(f.timers.size,0);f.request();assert.equal(f.messages('start').length,2);});
test('a mapping error is reported without escaping the event listener',()=>{const f=fixture({map:()=>{throw Error('mapping unavailable');}});f.request();assert.doesNotThrow(()=>f.reply());assert.equal(f.messages('failed')[0].data.error,'mapping unavailable');assert.equal(f.timers.size,0);});
test('destroy drops delayed callbacks, removes listeners and preserves the original destroy result',()=>{const f=fixture();f.request();assert.equal(f.api.destroy('closed'),'closed');assert.equal(f.closed,1);assert.equal(f.timers.size,0);assert.equal(f.window.events.size,0);assert.equal(f.document.events.size,0);for(const name of ['request','source','result'])assert.doesNotThrow(()=>f.emit(name));f.request();f.expire();assert.equal(f.messages('start').length,1);assert.equal(f.messages('failed').length,0);});
