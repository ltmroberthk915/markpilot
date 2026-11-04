'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url'),root=path.resolve(__dirname,'../../..');
const sha=plain=>require('node:crypto').createHash('sha256').update(plain,'utf16le').digest('hex');
const host={exports:require(path.join(root,'MarkPilot-CM6/shell/clipboard-image-source.cjs'))};
const engineFile=pathToFileURL(path.join(root,'dsh-markpilot/src-cm6/image-transfer.js')).href,engine=import(engineFile);
const cm=import(pathToFileURL(path.join(root,'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href);
test.after(()=>{delete global.window;});
const source=path.resolve('pending-image-fixture','试验','L #25%','lecture.md');
const target=path.resolve('pending-image-fixture','试验','S (1)','review.md');
const clip=(text, refs)=>({length:text.length,hash:sha(text),refs:refs.map(([raw,target=raw,html=false],i)=>({from:text.indexOf(raw,i?text.indexOf(refs[i-1][0])+1:0),to:text.indexOf(raw,i?text.indexOf(refs[i-1][0])+1:0)+raw.length,raw,target,html})),linewise:false});
const setup=(out=target)=>{global.window={__mpDocDir:path.dirname(source),mpHost:{
  rememberImageSource:(_token,p,plain)=>host.exports.rememberImageSource(source,{...p,hash:sha(plain)}),recoverImageSource:(id,plain)=>host.exports.recoverImageSource(out,id,plain.length,sha(plain)),eventClipboardIntent:()=>true}};};
test('same folder keeps exact spelling, different folder keeps source resource and surrounding bytes',async()=>{
  const {readImageTransfer}=await engine; const raw='images/f%23甲.png?foo=1#v',text='[lost](notes.md)\n![图](<'+raw+'> "caption")\n`![图]('+raw+')`';
  setup();const id=host.exports.rememberImageSource(source,clip(text,[[raw]])),got=readImageTransfer(id,text);
  const changed=got.text.match(/!\[图\]\(<([^>]+)>/)[1];
  assert.equal(new URL(changed.replace(/&amp;/g,'&'),pathToFileURL(target)).href,new URL(raw,pathToFileURL(source)).href);
  assert.equal(got.text.replace(changed,raw),text);
  setup(source);assert.equal(readImageTransfer(id,text).text,text);
});
test('malformed escape or encoded separator retains its origin while other images move',async()=>{
  setup();const {readImageTransfer}=await engine;
  const refs=['images/%2F.png','images/%oops.png','images/%E4%B8%AD.png?x=1#v','<unused>'].slice(0,3);
  const text=refs.map(s=>'![x]('+s+')').join('\n');
  const id=host.exports.rememberImageSource(source,clip(text,refs.map(s=>[s]))),got=readImageTransfer(id,text);
  for(const [i,line] of got.text.split('\n').entries())assert.equal(new URL(line.slice(5,-1),pathToFileURL(target)).href,new URL(refs[i],pathToFileURL(source)).href);
});
test('unavailable source and changed image payload never rewrite unrecognized clipboard data',async()=>{
  setup();const {readImageTransfer}=await engine,raw='fig.png',text='![x](fig.png)',id=host.exports.rememberImageSource(source,clip(text,[[raw]]));
  assert.equal(readImageTransfer('expired',text),null);assert.equal(readImageTransfer(id,text+'!'),null);
  assert.equal(readImageTransfer(id,text.replace(raw,'alt.png')),null);
  const wrapper='A![](fig.png)Z', wrapped=host.exports.rememberImageSource(source,clip(wrapper,[[raw]]));
  assert.equal(readImageTransfer(wrapped,'`![](fig.png)`'),null);
});
test('volume-root targets follow the source drive, and Markdown performs exactly one entity decode',async()=>{
  const {readImageTransfer}=await engine;
  const raw='/lecture/a&amp;amp;b.png?x=1&amp;y=2#v',decoded='/lecture/a&amp;b.png?x=1&y=2#v',text='![]('+raw+')';
  const id=host.exports.rememberImageSource(source,clip(text,[[raw,decoded]]));assert(id);const otherDrive=process.platform==='win32'?(path.parse(source).root[0].toUpperCase()==='C'?'D':'C')+':/elsewhere/a.md':null;setup(otherDrive);
  const moved=readImageTransfer(id,text);assert(moved);
  const once=moved.text.slice(4,-1).replace(/&amp;/g,'&');
  assert.equal(new URL(once,pathToFileURL(otherDrive||target)).href,new URL(decoded,pathToFileURL(source)).href);
});
test('cross drive and unsaved target keep a file URL; HTML "&" stays escaped',async()=>{
  const {readImageTransfer}=await engine;
  const raw='a&amp;b.svg?x=1&amp;y=2#v',src='a&b.svg?x=1&y=2#v',text='<img src="'+raw+'">';
  const id=host.exports.rememberImageSource(source,clip(text,[[raw,src,true]]));
  for(const dest of [null, ...(process.platform==='win32'?[(path.parse(source).root[0].toUpperCase()==='C'?'D':'C')+':/elsewhere/a.md']:[])]){setup(dest);const value=readImageTransfer(id,text).text;
    assert(value.includes('src="file:///'));assert.match(value,/&amp;b\.svg\?x=1&amp;y=2#v/);}
});
test('only full selected known image marks issue a ticket; partial cuts, literal code and remote are plain',async()=>{
  const {sourceImageTicket}=await engine,{EditorState}=await cm;setup();
  const text='prefix ![a](fig.png)\n`![a](fig.png)`';const st=EditorState.create({doc:text}); const from=text.indexOf('!'),to=text.indexOf(')')+1,a=text.indexOf('fig.png');
  const region={from,to,data:{from,to,image:{src:'fig.png'},form:'markdown',payload:[a,a+7]}},idx={byKind:new Map([['image',[region]]])};
  assert(sourceImageTicket(st,idx,[{from,to}],true));assert.equal(sourceImageTicket(st,idx,[{from:from+1,to}],true),null);
  assert.equal(sourceImageTicket(st,idx,[{from:text.indexOf('`'),to:text.length}],true),null);
  region.data.image.src='https://example.test/f.png';assert.equal(sourceImageTicket(st,idx,[{from,to}],true),null);
});
test('linewise copy normalizes CRLF and distributes across simultaneous destinations while retaining literal ranges',async()=>{
  const {applyImageTransfer}=await engine,{EditorState,EditorSelection}=await cm;
  let st=EditorState.create({doc:'one\r\ntwo',extensions:[EditorState.lineSeparator.of('\r\n'),EditorState.allowMultipleSelections.of(true)],
      selection:EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(5)])});
  let view={get state(){return st;},dispatch(...spec){st=st.update(...spec).state;}};
  applyImageTransfer(view,'A\nB',{text:'newA\nnewB',linewise:true},r=>r.head===5,EditorSelection);
  assert.equal(st.sliceDoc(),'newA\r\none\r\nB\r\ntwo');
});

async function dshFrame(token) {
  const url='https://dsh.test/plugins/markpilot/view/index.html';
  const base={href:'./',setAttribute(){}};
  const document={get baseURI(){return new URL(base.href,url).href;},querySelector(){return base;},
    querySelectorAll(){return [base];},head:{firstChild:null,insertBefore(){}},documentElement:{dataset:{}}};
  const listeners=new Map(),messages=[],parent={postMessage:m=>messages.push(m)};
  const win={parent,addEventListener:(name,fn)=>listeners.set(name,fn)};
  const context={window:win,document,location:new URL(url),URL,console,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,
    AbortController,fetch:async()=>({status:404,headers:{get:()=>'text/plain'}}),localStorage:{getItem:()=>null}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'dsh-markdown-typora/renderer-cm6/dsh-bridge.js'),'utf8'),context);
  win.handler.on('open',()=>{win.mpEngine={documentSession:()=>({epoch:1,sourceRevision:0})};});
  const down=()=>listeners.get('message')({source:parent,data:{__dshmd:true,dir:'down',type:'open',content:{
    protocol:2,serial:1,content:'![](x.png)',kind:'open',expected:null,docToken:token,applyId:'test-open',rootPath:'D:/session/'+token}}});
  down();await new Promise(resolve=>setImmediate(resolve));
  assert(messages.some(m=>m.type==='apply-result'&&m.content.applied));
  return win;
}
test('DSH bridge protocol 2 keeps one iframe owner; same token in another iframe confers no cross-project trust',async()=>{
  const owner=await dshFrame('doc-a'),alien=await dshFrame('doc-a');
  assert.equal(owner.__dshBridge.protocolState().docToken,'doc-a');assert.equal(alien.__dshBridge.protocolState().docToken,'doc-a');
  const {sourceImageTicket,readImageTransfer,beginNativeImageTransfer,finishNativeImageTransfer}=await engine,{EditorState,EditorSelection}=await cm;
  const text='![](x.png)',state=EditorState.create({doc:text,selection:EditorSelection.range(0,text.length)});
  const region={from:0,to:text.length,data:{from:0,to:text.length,image:{src:'x.png'},form:'markdown',payload:[4,9]}};
  const idx={byKind:new Map([['image',[region]]])};
  global.window=owner;
  const entries=new Map([['text/plain',text]]);
  const ev={type:'cut',isTrusted:true,defaultPrevented:true,clipboardData:{get types(){return [...entries.keys()]},
    setData:(key,value)=>entries.set(key,value),getData:key=>entries.get(key)}};
  const id=beginNativeImageTransfer(ev,state,idx);finishNativeImageTransfer(ev);assert.match(id,/^dsh-[\da-f-]{36}$/);
  assert.equal(entries.get('application/x-markpilot-image-transfer'),id);
  assert(entries.get('text/html').includes(id)&&!entries.get('text/html').includes('session'));
  assert.equal(readImageTransfer(id,text).text,text);
  global.window=alien;
  assert.equal(readImageTransfer(id,text),null);
  const otherModule=await import(engineFile+'?independent-iframe');
  assert.equal(otherModule.readImageTransfer(id,text),null);
  global.window=await dshFrame('doc-b');
  assert.equal(readImageTransfer(id,text),null);
  assert.equal(readImageTransfer('unavailable',text),null);
  global.window=owner;owner.__dshBridge.docBase=()=>'/replaced-base';
  assert.equal(readImageTransfer(id,text),null);
});
