const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,output,application})=>{
  const cases=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const inputClick=async(point)=>{const frame=await win.webContents.executeJavaScript(`(()=>{const b=document.getElementById('editor').getBoundingClientRect();return{x:b.x,y:b.y}})()`);const x=Math.round(point.x+frame.x),y=Math.round(point.y+frame.y);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x,y,button:'left',clickCount:1});await pause(220);};
  const fe=code=>win.webContents.executeJavaScript(`(()=>{const w=document.getElementById('editor')?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval(${JSON.stringify(code)});})()`,true);
  const wait=async(code,message)=>{for(let i=0;i<240;i++){try{if(await fe(code))return;}catch{}await pause(25);}throw Error(message||code);};
  const file=path.join(output,'双屏定位验收副本.md');
  const fixture='# 双屏定位验收\n\n第一段 plain **加粗文字**、*斜体文字*、`inlineCode` 和中文🙂。\n\n'+
    Array.from({length:12},(_,i)=>`## 第${i+1}节\n\n第${i+1}节内容 alpha${i}，这里有一段会换行的长文本。`+'长段内容用于验证换行后的精确定位。'.repeat(8)).join('\n\n')+
    '\n\n| 名称 | 内容 | 公式 |\n| --- | --- | --- |\n| 第一行 | 重复 | $a+b$ |\n| 第二行 | 重复 | $\\frac{x}{y}$ |\n| 第三行 | 一行<br />第二行 |  |\n\n'+
    '> 引用段落 quoteTarget\n> 下一行 quoteNext\n>\n> - 列表 listTarget\n>   - 子列表 nestedTarget\n\n'+
    '- [x] 完成任务 taskTarget\n- 普通项 listSecond\n\n'+
    '公式段落 $u^2+v^2$，以及 $\\frac{m}{n}$ 结束。\n\n$$\n\\int_0^1 t^2\\,dt\n$$\n\n'+
    '```javascript\nconst codeTarget = 1;\nconst codeSecond = 2;\n```\n\n'+
    '转义 \\*escapedTarget\\* 和 &amp; entityTarget，[链接文字](https://example.org/path) 以及 ![本地图片](data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2230%22%20height=%2220%22%3E%3C/svg%3E)。\n\n'+
    '参考 [引用名称][r]，脚注 footTarget[^n]。\n\n[r]: https://example.org/reference\n\n[^n]: 脚注正文 footBody\n\n'+
    '<div>HTML <b>htmlTarget</b> 内容</div>\n\n末尾 endTarget。\n';
  fs.writeFileSync(file,fixture);
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  await wait('vditor.getValue().includes("双屏定位验收")&&!!vditor.__splitNavigation','fixture ready');
  await inputClick(await fe(`(()=>{const r=vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`));
  await wait('vditor.vditor.currentMode==="sv"&&vditor.__splitNavigation.active&&vditor.__splitNavigation.blocks.length>10','split mode ready');
  await pause(600);
  const initialSource=await fe('vditor.getValue()');
  fs.writeFileSync(path.join(output,'initial-map.json'),JSON.stringify(await fe(`({source:vditor.getValue(),sv:vditor.vditor.sv.element.textContent,html:vditor.vditor.preview.previewElement.innerHTML,blocks:vditor.__splitNavigation.blocks.map(b=>({kind:b.kind,start:b.start,end:b.end,raw:vditor.vditor.sv.element.textContent.slice(b.start,b.end),text:b.node.textContent,points:b.points.length}))})`),null,2));
  const probeSetup=`window.__navProbe={
    sourcePoint(needle,occurrence=0){const root=vditor.vditor.sv.element;let value=root.textContent,offset=-1;for(let i=0;i<=occurrence;i++)offset=value.indexOf(needle,offset+1);if(offset<0)throw Error('missing source '+needle);const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,rest=offset;while(n=walker.nextNode()){if(rest<n.length)return[n,rest,offset];rest-=n.length;}throw Error('source point missing');},
    previewPoint(needle,occurrence=0){const root=vditor.vditor.preview.previewElement,walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,count=0;while(n=walker.nextNode()){if(n.parentElement.closest('.katex-mathml,.vditor-anchor,.hljs-ln-numbers'))continue;for(let at=n.data.indexOf(needle);at>=0;at=n.data.indexOf(needle,at+needle.length)){if(count++===occurrence)return[n,at];}}throw Error('missing preview '+needle);},
    rect(point){const r=document.createRange();r.setStart(point[0],point[1]);r.setEnd(point[0],Math.min(point[0].length,point[1]+1));const b=r.getBoundingClientRect();return{x:b.left+b.width*.2,y:b.top+b.height/2,height:b.height};},
    caret(){const s=getSelection(),root=vditor.vditor.sv.element;if(!root.contains(s.focusNode))return null;const r=document.createRange();r.selectNodeContents(root);r.setEnd(s.focusNode,s.focusOffset);const c=document.createRange();c.setStart(s.focusNode,s.focusOffset);c.collapse(true);const b=c.getBoundingClientRect();return{offset:r.toString().length,y:b.top+b.height/2};}
  };true`;await fe(probeSetup);
  const test=async(name,fn)=>{try{const details=await fn();cases.push({name,status:'PASS',details});console.log('PASS '+name);}catch(error){cases.push({name,status:'FAIL',error:String(error.stack)});console.error('FAIL '+name+' '+error.message);fs.writeFileSync(path.join(output,'failure-layout.json'),JSON.stringify(await fe(`(()=>{const s=vditor.vditor.sv.element;return [s,s.parentElement,s.parentElement.parentElement,vditor.vditor.preview.element].map(n=>({className:n.className,rect:n.getBoundingClientRect().toJSON(),clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,style:n.getAttribute('style'),boxSizing:getComputedStyle(n).boxSizing,height:getComputedStyle(n).height,overflow:getComputedStyle(n).overflow}));})()`),null,2));await win.webContents.capturePage().then(img=>fs.writeFileSync(path.join(output,name.replace(/[^a-zA-Z0-9_-]/g,'_')+'.png'),img.toPNG()));throw error;}finally{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,cases,failed:cases.filter(c=>c.status==='FAIL').length},null,2));}};
  await test('native-focus-boundary-keeps-preview-target-still',async()=>{
    // Start with an independently positioned preview. A cached browser focus
    // must not jump its content underneath a pending native mouse click.
    await fe(`getSelection().removeAllRanges();vditor.vditor.preview.element.scrollTop+=80;true`);await pause(60);
    const before=await fe(`__navProbe.rect(__navProbe.previewPoint('第1节'))`);
    // Windows activation can restore the selection to the contenteditable
    // container rather than a text node before dispatching the actual click.
    await fe(`vditor.vditor.sv.element.focus({preventScroll:true});getSelection().collapse(vditor.vditor.sv.element,0);true`);await pause(250);
    const after=await fe(`__navProbe.rect(__navProbe.previewPoint('第1节'))`);
    assert.ok(Math.abs(after.y-before.y)<4,JSON.stringify({before,after}));return {before,after};
  });
  await test('first-navigation-clicks-preview-before-source',async()=>{
    const point=await fe(`(()=>{const p=__navProbe.previewPoint('第1节');p[1]++;return __navProbe.rect(p);})()`);await inputClick(point);
    const state=await fe(`(()=>{const p=__navProbe.previewPoint('第1节');p[1]++;return{caret:__navProbe.caret(),expected:__navProbe.sourcePoint('第1节')[2]+1,preview:__navProbe.rect(p)};})()`);
    assert.equal(state.caret?.offset,state.expected,JSON.stringify(state));assert.ok(Math.abs(state.caret.y-state.preview.y)<4,JSON.stringify(state));return state;
  });
  for(const needle of ['双屏定位验收','加粗文字','alpha5','长段内容','重复','quoteTarget','nestedTarget','taskTarget','inlineCode','codeSecond','escapedTarget','entityTarget','链接文字','引用名称','footBody','htmlTarget','endTarget']){
    await test('left-to-right-'+needle,async()=>{
      await fe(`(()=>{const p=__navProbe.sourcePoint(${JSON.stringify(needle)}),s=vditor.vditor.sv.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.46;return true;})()`);await pause(80);
      const point=await fe(`__navProbe.rect(__navProbe.sourcePoint(${JSON.stringify(needle)}))`);await inputClick(point);
      const state=await fe(`(()=>{const c=__navProbe.caret(),p=__navProbe.rect(__navProbe.previewPoint(${JSON.stringify(needle)}));return{caret:c,preview:p,delta:Math.abs(c.y-p.y)};})()`);
      if(state.delta>=4)fs.writeFileSync(path.join(output,'navigation-state.json'),JSON.stringify(await fe(`({active:vditor.__splitNavigation.active,rendered:vditor.__splitNavigation.source,raw:vditor.vditor.sv.element.textContent,value:vditor.getValue(),anchor:vditor.__splitNavigation.anchor,blocks:vditor.__splitNavigation.blocks.map(b=>({kind:b.kind,start:b.start,end:b.end,text:b.node.textContent}))})`),null,2));
      assert.ok(state.delta<4,JSON.stringify({point,...state}));return state;
    });
    await test('right-to-left-'+needle,async()=>{
      const point=await fe(`(()=>{const p=__navProbe.previewPoint(${JSON.stringify(needle)}),s=vditor.vditor.preview.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.4;return __navProbe.rect(p);})()`);await inputClick(point);
      const state=await fe(`({caret:__navProbe.caret(),expected:__navProbe.sourcePoint(${JSON.stringify(needle)})[2]})`);
      assert.ok(state.caret&&Math.abs(state.caret.offset-state.expected)<=1,JSON.stringify(state));return state;
    });
  }
  await fe(`__navProbe.mathPoint=(tex,offset)=>{const math=[...vditor.vditor.preview.previewElement.querySelectorAll('.language-math')].find(n=>n.getAttribute('data-math')===tex);if(!math)throw Error('math missing '+tex);const symbols=[...math.querySelectorAll('[data-typora-source-start]')].filter(n=>Number(n.dataset.typoraSourceStart)<=offset&&Number(n.dataset.typoraSourceEnd)>offset);const n=symbols.sort((a,b)=>(Number(a.dataset.typoraSourceEnd)-Number(a.dataset.typoraSourceStart))-(Number(b.dataset.typoraSourceEnd)-Number(b.dataset.typoraSourceStart))||a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0]||math,b=n.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2,source:Number(n.dataset.typoraSourceStart)||0};};true`);
  for(const [tex,local] of [['a+b',2],['\\frac{x}{y}',6],['\\frac{x}{y}',9],['u^2+v^2',2],['\\int_0^1 t^2\\,dt',9]]){
    await test('math-left-'+tex+'-'+local,async()=>{
      await fe(`(()=>{const p=__navProbe.sourcePoint(${JSON.stringify(tex)});p[1]+=${local};const s=vditor.vditor.sv.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.43;return true;})()`);await pause(60);
      const point=await fe(`(()=>{const p=__navProbe.sourcePoint(${JSON.stringify(tex)});p[1]+=${local};return __navProbe.rect(p);})()`);await inputClick(point);
      const state=await fe(`(()=>{const c=__navProbe.caret(),p=__navProbe.mathPoint(${JSON.stringify(tex)},${local});return{caret:c,preview:p,delta:Math.abs(c.y-p.y)};})()`);assert.ok(state.delta<4,JSON.stringify(state));return state;
    });
    await test('math-right-'+tex+'-'+local,async()=>{
      await fe(`(()=>{const p=__navProbe.mathPoint(${JSON.stringify(tex)},${local}),s=vditor.vditor.preview.element;s.scrollTop+=p.y-s.getBoundingClientRect().top-s.clientHeight*.4;return true;})()`);await pause(60);
      const point=await fe(`__navProbe.mathPoint(${JSON.stringify(tex)},${local})`);await inputClick(point);
      const state=await fe(`({caret:__navProbe.caret(),expected:__navProbe.sourcePoint(${JSON.stringify(tex)})[2]+${point.source}})`);assert.equal(state.caret?.offset,state.expected,JSON.stringify(state));return state;
    });
  }
  for(const occurrence of [1])await test('duplicate-second-cell-bidirectional',async()=>{
    await fe(`(()=>{const p=__navProbe.previewPoint('重复',${occurrence}),s=vditor.vditor.preview.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.4;return true;})()`);await pause(60);await inputClick(await fe(`__navProbe.rect(__navProbe.previewPoint('重复',${occurrence}))`));
    const result=await fe(`({caret:__navProbe.caret(),expected:__navProbe.sourcePoint('重复',${occurrence})[2]})`);assert.ok(Math.abs(result.caret.offset-result.expected)<=1,JSON.stringify(result));return result;
  });
  await test('empty-table-cell-to-source',async()=>{
    await fe(`(()=>{const n=vditor.vditor.preview.previewElement.querySelector('table').rows[3].cells[2],r=n.getBoundingClientRect(),s=vditor.vditor.preview.element;s.scrollTop+=r.top+r.height/2-s.getBoundingClientRect().top-s.clientHeight*.4;return true;})()`);await pause(60);
    const point=await fe(`(()=>{const n=vditor.vditor.preview.previewElement.querySelector('table').rows[3].cells[2],r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);await inputClick(point);
    const result=await fe(`(()=>{const text=vditor.vditor.sv.element.textContent,start=text.indexOf('第三行'),end=text.indexOf('\\n',start),line=text.slice(start,end);return{caret:__navProbe.caret(),expected:start+line.lastIndexOf('|')};})()`);assert.equal(result.caret?.offset,result.expected,JSON.stringify(result));return result;
  });
  await test('navigation-does-not-edit',async()=>{assert.equal(global.doc.dirty,false);assert.equal(fs.readFileSync(file,'utf8'),fixture);assert.equal(await fe('vditor.getValue()'),initialSource);return true;});
  await test('same-caret-click-restores-alignment-12-times',async()=>{
    await fe(`vditor.vditor.sv.element.scrollTop=0;true`);await pause(60);
    const deltas=[];for(let i=0;i<12;i++){
      // Both panes now follow a scroll. Reacquire the heading after returning
      // the source to the top; its old screen coordinates are no longer valid.
      await fe('vditor.vditor.preview.element.scrollTop+=170;true');await pause(80);
      await fe('vditor.vditor.sv.element.scrollTop=0;true');await pause(80);
      await inputClick(await fe(`__navProbe.rect(__navProbe.sourcePoint('双屏定位验收'))`));
      const delta=await fe(`Math.abs(__navProbe.caret().y-__navProbe.rect(__navProbe.previewPoint('双屏定位验收')).y)`);deltas.push(delta);assert.ok(delta<4,String(delta));
    }return deltas;
  });
  await test('preview-wheel-is-not-pulled-back-by-render',async()=>{
    const initial=await fe('vditor.vditor.preview.element.scrollTop');
    const frame=await win.webContents.executeJavaScript(`(()=>{const b=document.getElementById('editor').getBoundingClientRect();return{x:b.x,y:b.y}})()`),p=await fe(`(()=>{const r=vditor.vditor.preview.element.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(p.x+frame.x),y:Math.round(p.y+frame.y),deltaY:-220,deltaX:0});await pause(180);
    const before=await fe('vditor.vditor.preview.element.scrollTop');assert.ok(Math.abs(before-initial)>20,'The trusted wheel must actually scroll the preview');await fe('vditor.vditor.preview.render(vditor.vditor);true');await pause(450);
    const after=await fe('vditor.vditor.preview.element.scrollTop');assert.ok(Math.abs(after-before)<4,JSON.stringify({before,after}));return {before,after};
  });
  await test('preview-drag-keeps-reading-selection',async()=>{
    const point=await fe(`(()=>{const p=__navProbe.previewPoint('加粗文字'),s=vditor.vditor.preview.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.4;return __navProbe.rect(p);})()`);
    const frame=await win.webContents.executeJavaScript(`(()=>{const b=document.getElementById('editor').getBoundingClientRect();return{x:b.x,y:b.y}})()`),x=Math.round(point.x+frame.x),y=Math.round(point.y+frame.y);
    win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    for(let i=1;i<=6;i++)win.webContents.sendInputEvent({type:'mouseMove',x:x+i*10,y,button:'left'});
    win.webContents.sendInputEvent({type:'mouseUp',x:x+60,y,button:'left',clickCount:1});await pause(180);
    const result=await fe(`({text:getSelection().toString(),preview:vditor.vditor.preview.previewElement.contains(getSelection().focusNode),value:vditor.getValue()})`);assert.ok(result.preview&&result.text.length);assert.equal(result.value,initialSource);return {text:result.text};
  });
  await test('click-stale-preview-after-source-edit',async()=>{
    await fe(`(()=>{const p=__navProbe.sourcePoint('endTarget'),s=vditor.vditor.sv.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.4;return true;})()`);await pause(60);
    await inputClick(await fe(`__navProbe.rect(__navProbe.sourcePoint('endTarget'))`));
    await fe('vditor.vditor.options.preview.delay=800;true');
    const oldPoint=await fe(`__navProbe.rect(__navProbe.previewPoint('endTarget'))`);
    await win.webContents.insertText('navEdit ');
    await wait('vditor.getValue().includes("navEdit ")');
    assert.equal(await fe('vditor.__splitNavigation.source===vditor.getValue()'),false,'test must actually click a stale render');
    await inputClick(oldPoint);
    const state=await fe(`({caret:__navProbe.caret(),expected:__navProbe.sourcePoint('endTarget')[2]})`);assert.ok(Math.abs(state.caret.offset-state.expected)<=1,JSON.stringify(state));
    await wait('vditor.__splitNavigation.source===vditor.getValue()');await pause(80);
    const delta=await fe(`Math.abs(__navProbe.caret().y-__navProbe.rect(__navProbe.previewPoint('endTarget')).y)`);assert.ok(delta<4,String(delta));
    await fe('vditor.vditor.options.preview.delay=100;true');return state;
  });
  await test('source-edit-undo-redo-save',async()=>{
    const changed=await fe('vditor.getValue()');
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Z',modifiers:['control']});
    await wait(`vditor.getValue()===${JSON.stringify(initialSource)}`,'undo source edit');
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Y',modifiers:['control']});
    await wait(`vditor.getValue()===${JSON.stringify(changed)}`,'redo source edit');
    for(let i=0;i<200&&global.doc.current.text!==changed;i++)await pause(25);assert.equal(global.doc.current.text,changed);await global.doc.save();assert.equal(fs.readFileSync(file,'utf8'),changed);return true;
  });
  await test('leave-and-reenter-source-view',async()=>{
    const before=await fe('vditor.getValue()');await fe(`vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').click();true`);
    await wait('vditor.vditor.currentMode==="ir"&&!vditor.__splitNavigation.active');
    assert.equal(await fe('document.querySelectorAll(".typora-navigation-pane").length'),0);
    await fe(`vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').click();true`);await wait('vditor.__splitNavigation.active&&vditor.__splitNavigation.source===vditor.getValue()');
    assert.equal(await fe(`(()=>{const lute=Lute.New();return lute.Md2HTML(vditor.getValue())===lute.Md2HTML(${JSON.stringify(before)});})()`),true,'View transitions must preserve Markdown semantics');return true;
  });
  await test('resize-and-reflow-keep-alignment',async()=>{
    win.unmaximize();win.setContentSize(900,650);await pause(180);
    // Re-entering source view holds an entry anchor that keeps reverting
    // script scrolling until a real user action takes over (by design; the
    // quality-boundaries entry documents the same mechanism). Click visible
    // source text first like a user, then reveal the target.
    await inputClick(await fe(`(()=>{const s=vditor.vditor.sv.element,r=s.getBoundingClientRect();const hit=document.caretRangeFromPoint(r.left+Math.min(80,r.width/3),r.top+r.height*.35);if(!hit||!s.contains(hit.startContainer))return {x:r.left+r.width/2,y:r.top+r.height/2};const b=hit.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`));
    await fe(`(()=>{const p=__navProbe.sourcePoint('alpha5'),s=vditor.vditor.sv.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.4;return true;})()`);await pause(60);await inputClick(await fe(`__navProbe.rect(__navProbe.sourcePoint('alpha5'))`));
    const delta=await fe(`Math.abs(__navProbe.caret().y-__navProbe.rect(__navProbe.previewPoint('alpha5')).y)`);assert.ok(delta<4,String(delta));return {delta};
  });
  const noteFile=path.join(output,'真实概率论笔记副本.md'),originalNote=path.resolve(__dirname,'../.backups/2026-09-08-split-navigation/user-note-original.md');fs.copyFileSync(originalNote,noteFile);
  await global.doc.openFile(noteFile);await wait('vditor.getValue().includes("第一章 集合运算法则")&&!!vditor.__splitNavigation');
  if(await fe('vditor.vditor.currentMode!=="sv"'))await inputClick(await fe(`(()=>{const r=vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`));
  await wait('vditor.__splitNavigation.active&&vditor.__splitNavigation.blocks.length>20');await pause(250);await fe(probeSetup);
  await test('user-note-first-navigation-clicks-preview',async()=>{
    const point=await fe(`(()=>{const p=__navProbe.previewPoint('第一章 集合运算法则');p[1]+=7;return __navProbe.rect(p);})()`);await inputClick(point);
    const state=await fe(`(()=>{const p=__navProbe.previewPoint('第一章 集合运算法则');p[1]+=7;return{caret:__navProbe.caret(),expected:__navProbe.sourcePoint('第一章 集合运算法则')[2]+7,preview:__navProbe.rect(p)};})()`);
    assert.equal(state.caret?.offset,state.expected,JSON.stringify(state));assert.ok(Math.abs(state.caret.y-state.preview.y)<4,JSON.stringify(state));return state;
  });
  for(const needle of ['第一章 集合运算法则','底层状态','勒贝格积分','控制收敛']){
    await test('user-note-bidirectional-'+needle,async()=>{
      await fe(`(()=>{const p=__navProbe.sourcePoint(${JSON.stringify(needle)}),s=vditor.vditor.sv.element,r=__navProbe.rect(p);s.scrollTop+=r.y-s.getBoundingClientRect().top-s.clientHeight*.4;return true;})()`);await pause(60);await inputClick(await fe(`__navProbe.rect(__navProbe.sourcePoint(${JSON.stringify(needle)}))`));
      const delta=await fe(`Math.abs(__navProbe.caret().y-__navProbe.rect(__navProbe.previewPoint(${JSON.stringify(needle)})).y)`);assert.ok(delta<4,String(delta));
      await inputClick(await fe(`__navProbe.rect(__navProbe.previewPoint(${JSON.stringify(needle)}))`));
      const state=await fe(`({caret:__navProbe.caret(),expected:__navProbe.sourcePoint(${JSON.stringify(needle)})[2]})`);assert.ok(Math.abs(state.caret.offset-state.expected)<=1,JSON.stringify(state));return {delta,...state};
    });
  }
  await test('user-note-11-column-empty-cell',async()=>{
    const expected=await fe(`(()=>{const root=vditor.vditor.sv.element,table=root.querySelectorAll('[data-type="table"]')[1],range=document.createRange();range.selectNodeContents(root);range.setEndBefore(table);const base=range.toString().length,lines=table.textContent.split('\\n'),row=5;return base+lines.slice(0,row+1).reduce((sum,line)=>sum+line.length+1,0)+lines[row+1].lastIndexOf('|');})()`);
    await fe(`(()=>{const root=vditor.vditor.sv.element,w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,offset=${expected};while(n=w.nextNode()){if(offset<n.length)break;offset-=n.length;}window.__widePoint=[n,offset];const p=__navProbe.rect(__widePoint),r=root.getBoundingClientRect();root.scrollTop+=p.y-r.top-root.clientHeight*.4;if(p.x>r.right-20)root.scrollLeft+=p.x-r.right+20;return true;})()`);await pause(60);await inputClick(await fe('__navProbe.rect(__widePoint)'));
    const point=await fe(`(()=>{const cell=vditor.vditor.preview.previewElement.querySelectorAll('table')[1].rows[5].cells[10],r=cell.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`),caret=await fe('__navProbe.caret()');assert.ok(Math.abs(caret.y-point.y)<4,JSON.stringify({point,caret}));await inputClick(point);
    const result=await fe('__navProbe.caret()');assert.equal(result.offset,expected,JSON.stringify({result,expected}));return result;
  });
  await test('user-note-preserved',async()=>{assert.equal(global.doc.dirty,false);assert.deepEqual(fs.readFileSync(noteFile),fs.readFileSync(originalNote));return true;});
  fs.writeFileSync(path.join(output,'final-state.json'),JSON.stringify(await fe(`({value:vditor.getValue(),blocks:vditor.__splitNavigation.blocks.map(b=>({kind:b.kind,start:b.start,end:b.end,text:b.node.textContent}))})`),null,2));
  await win.webContents.capturePage().then(img=>fs.writeFileSync(path.join(output,'final.png'),img.toPNG()));
};
