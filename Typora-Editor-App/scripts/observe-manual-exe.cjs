// Read-only observer for the disposable, visibly operated final portable EXE.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
  const root=path.resolve(process.argv[2]),meta=JSON.parse(fs.readFileSync(path.join(root,'observer.json')));
  const targets=await(await fetch('http://127.0.0.1:'+meta.port+'/json/list')).json();
  const target=targets.find(t=>t.type==='page'&&/\/shell$/.test(t.url));if(!target)throw Error('Isolated portable target missing');
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  const result=await new Promise((resolve,reject)=>{
    ws.onmessage=event=>{const r=JSON.parse(event.data);if(r.id!==1)return;r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result);};
    ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,expression:"(()=>{\n  const w=document.getElementById('editor')?.contentWindow,e=w?.vditor?.vditor;\n  if(!e?.__typoraPatched)return null;\n  const root=e[e.currentMode].element,s=w.getSelection(),n=s?.focusNode,element=n?.nodeType===3?n.parentElement:n;\n  const cell=element?.closest?.('td,th'),tables=[...root.querySelectorAll('table')];\n  let caret=null;if(n&&root.contains(n)){const r=w.document.createRange();r.setStart(n,s.focusOffset);r.collapse(true);caret=r.getBoundingClientRect().toJSON();}\n  const sources=[...root.querySelectorAll('code[data-type=\"math-inline\"],[data-type=\"math-block\"] code')].filter(c=>!c.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'));\n  const visibleFormulaSources=sources.filter(c=>w.getComputedStyle(c).visibility!=='hidden'&&[...c.getClientRects()].some(r=>r.width&&r.height)).map(c=>({text:c.textContent.slice(0,200),rect:c.getBoundingClientRect().toJSON(),owner:c.closest('.vditor-ir__node,.vditor-wysiwyg__block')?.className}));\n  return{markdown:w.vditor.getValue(),mode:e.currentMode,tableShapes:tables.map(t=>[...t.rows].map(r=>r.cells.length)),focus:w.document.activeElement?.className,focusCell:cell?[tables.indexOf(cell.closest('table')),cell.parentElement.rowIndex,cell.cellIndex]:null,focusBoundary:{node:n?.nodeName,offset:s?.focusOffset,parent:n?.parentElement?.tagName,head:n?.textContent?.slice(0,60)},selection:s?.toString(),viewport:[w.innerWidth,w.innerHeight],rootRect:root.getBoundingClientRect().toJSON(),cellRect:cell?.getBoundingClientRect().toJSON(),caret,scroll:root.scrollTop,mathPending:w.__typoraMathStats?.pending,visibleFormulaSources,expanded:visibleFormulaSources.map(c=>c.text)};\n})()"}}));
  });ws.close();if(result.exceptionDetails||!result.result?.value)throw Error('Portable state was not readable');
  const state=result.result.value,baseline=fs.readFileSync(path.join(root,'baseline-editor.md'),'utf8');
  state.checkedAt=new Date().toISOString();state.baselineEqual=state.markdown===baseline;
  state.markdownSHA256=crypto.createHash('sha256').update(state.markdown).digest('hex');
  const file=path.join(root,(process.argv[3]||'observed-state')+'.json');fs.writeFileSync(file,JSON.stringify(state,null,2));
  console.log(JSON.stringify({...state,markdown:undefined,output:file}));
})().catch(error=>{console.error(error);process.exitCode=1;});
