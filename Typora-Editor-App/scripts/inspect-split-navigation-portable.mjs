// Read-only DOM diagnostics for the isolated portable EXE under manual QA.
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve(process.argv[2]),meta=JSON.parse(fs.readFileSync(path.join(output,'observer.json'),'utf8'));
const page=(await(await fetch(`http://127.0.0.1:${meta.port}/json/list`)).json()).find(p=>p.type==='page'&&/\/shell$/.test(p.url));
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});
const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Diagnostic timeout')),10000);
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id===1){clearTimeout(timer);resolve(message.result);}};
  socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,expression:`(()=>{
    const f=document.getElementById('editor'),w=f.contentWindow,e=w.vditor.vditor,s=w.getSelection();
    const rect=n=>n?.getBoundingClientRect().toJSON();
    const describe=n=>n?{name:n.nodeName,className:n.className,text:n.nodeType===3?n.data.slice(0,160):n.textContent?.slice(0,160),html:(n.nodeType===3?n.parentElement:n).outerHTML?.slice(0,500)}:null;
    const pane=n=>({rect:rect(n),scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,style:n.getAttribute('style'),before:w.getComputedStyle(n,'::before').height,after:w.getComputedStyle(n,'::after').height});
    let caret=null;if(s.rangeCount){const r=s.getRangeAt(0);caret={rect:r.getBoundingClientRect().toJSON(),rects:[...r.getClientRects()].map(r=>r.toJSON())};}
    return{frame:rect(f),pixelRatio:w.devicePixelRatio,innerWidth:w.innerWidth,innerHeight:w.innerHeight,selection:{anchor:describe(s.anchorNode),anchorOffset:s.anchorOffset,focus:describe(s.focusNode),focusOffset:s.focusOffset,collapsed:s.isCollapsed,text:s.toString(),source:e.sv.element.contains(s.focusNode)},active:describe(w.document.activeElement),caret,source:pane(e.sv.element),preview:pane(e.preview.element),content:pane(e.preview.previewElement),navigation:{active:w.vditor.__splitNavigation.active,anchor:w.vditor.__splitNavigation.anchor,sourceSame:w.vditor.__splitNavigation.source===w.vditor.getValue()},sourceHeading:[...e.sv.element.querySelectorAll('[data-type="heading-marker"]')].map(n=>({text:n.parentElement.textContent.slice(0,80),rect:rect(n.parentElement)})),previewHeading:[...e.preview.previewElement.querySelectorAll('h1')].slice(0,2).map(n=>({text:n.textContent,rect:rect(n)}))};
  })()`}}));
});
socket.close();if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
const diagnostics=result.result.value;delete diagnostics.sourceHeading;fs.writeFileSync(path.join(output,'navigation-diagnostic.json'),JSON.stringify(diagnostics,null,2));console.log(JSON.stringify(diagnostics,null,2));
