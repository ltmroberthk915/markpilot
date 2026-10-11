// Probe which inline <img> attribute sets Lute's IR pass-through accepts.
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  for(let i=0;i<400;i++){if(await fe('vditor?.vditor?.currentMode'))break;await pause(50);}
  const url=await fe(`(()=>{const img=vditor.vditor.ir.element.querySelector('img');return img?img.getAttribute('src'):null})()`);
  const src=url||'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const variants=[
    ['md inline plain',`前文 ![image](${src}) 后文`],
    ['md inline =Wx',`前文 ![image](${src} =1152x) 后文`],
    ['md inline =WxH',`前文 ![image](${src} =1152x648) 后文`],
    ['md inline {width}',`前文 ![image](${src}){width="1152px"} 后文`],
    ['md block =Wx',`![image](${src} =1152x)`],
  ];
  const results=[];
  // v7b: exact repairs-style Ctrl+U apply + toggle-off via synthetic events.
  {
    const r=await fe(`(async()=>{
      const api=window.vditor,e=api.vditor;
      const {sourceText,selectRange}=await import('/render/js/source-text.js');
      const {configureShortcuts,DEFAULT_SHORTCUTS}=await import('/render/js/edit-shortcuts.js');configureShortcuts(DEFAULT_SHORTCUTS);
      const root=e.ir.element;
      api.setValue('alpha beta\\n',true);await new Promise(r=>setTimeout(r,300));api.clearStack();
      const select=w=>{const index=sourceText(root),at=index.text.indexOf(w);selectRange(root,index.range(at,at+w.length));};
      const key=k=>root.dispatchEvent(new KeyboardEvent('keydown',{key:k,code:'Key'+k.toUpperCase(),ctrlKey:true,bubbles:true,cancelable:true}));
      select('alpha');const ev1=key('u');await new Promise(r=>setTimeout(r,300));
      const v1=api.getValue();
      select('alpha');const ev2=key('u');await new Promise(r=>setTimeout(r,300));
      const v2=api.getValue();
      const sel=getSelection();
      return JSON.stringify({v1,v2,p1:ev1.defaultPrevented,p2:ev2.defaultPrevented,selAfter:sel.toString(),rangeCount:sel.rangeCount});
    })()`);
    console.log('underline-toggle',r);
  }
  // v7: swap an inline img token for a real element, then reparse that block.
  await fe(`vditor.setValue(${JSON.stringify('# 探针\n\n前文 <img src="'+src+'" alt="image" width="1152" data-typora-scale="60" /> 后文\n')});true`);
  await pause(250);
  const swapped=await fe(`(()=>{
    const ir=vditor.vditor.ir.element;
    const token=[...ir.querySelectorAll('[data-type="html-inline"]')].find(t=>/^<img\\b/i.test(t.textContent.trim()));
    if(!token)return 'no-token';
    const tpl=document.createElement('template');tpl.innerHTML=token.textContent.trim();
    const img=tpl.content.firstElementChild;if(!img||img.tagName!=='IMG')return 'parse-fail';
    img.contentEditable='false';token.replaceWith(img);
    return {ok:true,width:img.getAttribute('width')}})()`);
  await pause(100);
  const beforeType=await fe(`(()=>({imgs:vditor.vditor.ir.element.querySelectorAll('img').length,value:vditor.getValue().slice(0,200)}))()`);
  // Type one char in that paragraph to force Lute to re-spin the block.
  await fe(`(()=>{const ir=vditor.vditor.ir.element;const n=[...ir.querySelectorAll('p')].find(p=>p.textContent.includes('前文'));if(!n)return false;const r=document.createRange();r.setStart(n.firstChild,1);r.collapse(true);const s=getSelection();ir.focus();s.removeAllRanges();s.addRange(r);return true})()`);
  await win.webContents.insertText('字');
  await pause(400);
  const afterType=await fe(`(()=>({imgs:[...vditor.vditor.ir.element.querySelectorAll('img')].filter(i=>!i.closest('.vditor-toolbar')).length,tokens:[...vditor.vditor.ir.element.querySelectorAll('[data-type="html-inline"]')].filter(t=>/^<img\\b/i.test(t.textContent.trim())).length,value:vditor.getValue().slice(0,220)}))()`);
  console.log('token-swap',JSON.stringify({swapped,beforeType,afterType}));
  for(const [name,md] of variants){
    await fe(`vditor.setValue(${JSON.stringify('# 探针\n\n'+md+'\n')});true`);
    await pause(250);
    const probe=await fe(`(()=>{const ir=vditor.vditor.ir.element;const img=[...ir.querySelectorAll('img')].filter(i=>!i.closest('.vditor-toolbar,.vditor-outline')).at(-1);const token=[...ir.querySelectorAll('[data-type="html-inline"]')].map(t=>t.textContent.slice(0,60));return{img:!!img,renderedAttrs:img?{width:img.getAttribute('width'),style:img.getAttribute('style')?.slice(0,60),scale:img.getAttribute('data-typora-scale')}:null,tokens:token.length,tokenSample:token[0]||null,value:vditor.getValue().slice(0,200)}})()`);
    results.push({name,...probe});
    console.log(name,JSON.stringify(probe));
  }
  require('node:fs').writeFileSync(require('node:path').join(output,'lutetest.json'),JSON.stringify(results,null,1));
};
