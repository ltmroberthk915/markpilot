const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.runUI=async({win,ev,until,output})=>{
  const results=[],pass=label=>{results.push('PASS '+label);fs.writeFileSync(path.join(output,'ui-progress.json'),JSON.stringify(results,null,2));};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const key=async(keyCode,modifiers=[])=>{
    win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(80);
  };
  const click=async selector=>{
    const point=await ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(100);
  };
  const geometry=()=>ev(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return{host:rect(vditor.vditor.element),outline:rect(vditor.vditor.outline.element),toolbar:rect(vditor.vditor.toolbar.element),divider:rect(document.querySelector('.typora-outline-resizer'))}})()`);
  const aligned=async label=>{
    await delay(150);const g=await geometry();
    assert.ok(Math.abs(g.outline.top-g.toolbar.bottom)<2&&Math.abs(g.outline.bottom-g.host.bottom)<2,label+JSON.stringify(g));
    assert.ok(Math.abs(g.divider.top-g.toolbar.bottom)<2,label+JSON.stringify(g));
    assert.ok(Math.abs(g.divider.left+4-g.outline.right)<2,label+JSON.stringify(g));pass(label);
  };
  const drag=async delta=>{
    const g=await geometry(),x=Math.round(g.divider.left+4),y=200;
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y});
    for(let i=1;i<=5;i++){win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(x+delta*i/5),y,modifiers:['leftButtonDown']});await delay(25);}
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(x+delta),y});await delay(150);
  };
  const fixture='# 第一部分 高等概率论基础\n\n普通文字与 **加粗文字 Bold**，<u>下划线文字</u>。\n\n> 普通引用与 **严格性注记：这段文字需要足够明显**。\n\n公式 $a^2+b^2=c^2$\n\n'+Array.from({length:30},(_,i)=>`## 第 ${i+1} 章 集合运算法则与随机变量\n\nAlpha alpha 第 ${i+1} 章正文 $x_${i}+1$\n\n`).join('');
  await ev(`__open(${JSON.stringify(fixture)})`);await until('window.vditor?.vditor?.__typoraPatched');
  await ev(`vditor.vditor.outline.toggle(vditor.vditor,true);vditor.vditor.ir.element.blur();getSelection().removeAllRanges();true`);
  await until('__typoraMathStats.pending===0');await delay(300);
  await aligned('Outline fills the available space below the stationary toolbar');
  assert.ok(await ev(`['bold','italic'].every(name=>vditor.vditor.toolbar.elements[name].getBoundingClientRect().width===0)`));
  assert.ok(await ev(`(()=>{const b=document.querySelector('button[data-type="theme-settings"]');return !b.textContent.trim()&&!!b.querySelector('svg')&&b.getAttribute('aria-label').includes('主题')&&b.getBoundingClientRect().width<=28})()`));
  pass('Formatting buttons leave no space; compact theme icon has an accessible hover label');
  await click('button[data-type="theme-settings"]');
  assert.equal(await ev(`document.querySelectorAll('#typora-themes [data-theme]').length`),6);
  pass('Theme icon opens all six choices by native mouse click');
  await click('#typora-themes [data-theme="konayuki-light"]');await click('#typora-themes footer button');
  await ev(`window.__uiMD=vditor.getValue();window.__uiMath=[...vditor.vditor.ir.element.querySelectorAll('.language-math[data-math]')];window.__uiRendered=__typoraMathStats.rendered;true`);
  const start=(await geometry()).outline.width;await drag(108);
  assert.ok(Math.abs((await geometry()).outline.width-start-108)<2);
  assert.ok(Math.abs(Number(await ev(`localStorage.getItem('outline-width')`))-start-108)<2);pass('Native drag changes and persists outline width');
  assert.ok(await ev(`vditor.getValue()===__uiMD&&__uiMath.every(n=>n.isConnected)&&__typoraMathStats.rendered===__uiRendered`));pass('Resizing preserves document and rendered formula nodes');
  await aligned('Resized outline fills the available height below the toolbar');
  await click('.vditor-outline__content li li:nth-child(10) > span');
  assert.ok(await ev('vditor.vditor.ir.element.scrollTop>100'));pass('Heading clicks still navigate the document after resizing');
  await ev(`document.querySelector('.typora-outline-resizer').focus();true`);await key('Left');
  assert.ok(Math.abs((await geometry()).outline.width-start-92)<2);pass('Keyboard arrows resize the accessible separator');
  const outlineButton=await ev(`(()=>{const r=document.querySelector('button[data-type="outline"]').getBoundingClientRect();return{x:r.x,y:r.y}})()`);
  await click('button[data-type="outline"]');
  assert.ok(await ev(`document.querySelector('.typora-outline-resizer').hidden&&parseFloat(getComputedStyle(vditor.vditor.toolbar.element).paddingLeft)===8`));pass('Hiding outline releases toolbar space and hides divider');
  await click('button[data-type="outline"]');await aligned('Showing outline restores its available-height layout');
  assert.ok(await ev(`(()=>{const r=document.querySelector('button[data-type="outline"]').getBoundingClientRect();return Math.abs(r.x-${outlineButton.x})<1&&Math.abs(r.y-${outlineButton.y})<1})()`));pass('Outline toggle returns to exactly the same pointer position');
  await ev(`document.querySelector('.vditor-content').style.zoom='150%';true`);await delay(250);
  await aligned('150 percent content zoom keeps outline aligned');
  const zoomWidth=(await geometry()).outline.width;await drag(40);
  assert.ok(Math.abs((await geometry()).outline.width-zoomWidth-40)<2);pass('Drag distance remains accurate with zoomed content');
  await delay(200);
  await ev(`window.__uiIdleMutations=0;window.__uiObserver=new MutationObserver(r=>__uiIdleMutations+=r.length);__uiObserver.observe(vditor.vditor.outline.element,{attributes:true,attributeFilter:['style']});true`);
  await delay(400);await ev('__uiObserver.disconnect();true');
  assert.equal(await ev('__uiIdleMutations'),0);pass('Fractional drag coordinates do not cause idle layout or animation loops');
  await ev(`document.querySelector('.vditor-content').style.zoom='100%';true`);
  win.setContentSize(650,700);await delay(300);await aligned('Narrow window wraps toolbar without a blank outline corner');
  assert.ok((await geometry()).outline.width<=410);pass('Outline width leaves room for text in narrow windows');
  win.setContentSize(1180,800);await delay(300);
  await click('button[data-type="fullscreen"]');await aligned('Full-screen outline stays aligned');
  await ev('vditor.__typoraFind.open(false);true');
  assert.ok(await ev(`(()=>{const q=document.querySelector('#typora-find [data-field=query]'),r=q.getBoundingClientRect();return document.elementFromPoint(r.x+10,r.y+10)===q})()`));
  await key('Escape');await click('button[data-type="fullscreen"]');pass('Find panel remains usable above full-screen editor');
  for(const mode of ['ir','wysiwyg','sv']){
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="${mode}"]').click();true`);await delay(300);
    if(mode==='sv'){
      assert.ok(await ev(`document.querySelector('.typora-outline-resizer').hidden`));pass('Source mode hides the divider with its native hidden outline');
    }else await aligned(mode+' outline geometry');
    await ev(`(()=>{const root=vditor.vditor[vditor.vditor.currentMode].element;root.focus();getSelection().collapse(root,0)})()`);
    await key('F',['control']);await until(`!!document.getElementById('typora-find')`);
    assert.equal(await ev(`vditor.__typoraFind.state.replacing`),false);
    // Mode controls must work with an empty query and while search is pending.
    await click('#typora-find [data-mode="replace"]');
    assert.ok(await ev(`vditor.__typoraFind.state.replacing&&!document.querySelector('#typora-find .find-replace-row').hidden`));
    await ev(`(()=>{const p=document.getElementById('typora-find');p.querySelector('[data-field=query]').value='Alpha';p.querySelector('[data-field=replace]').value='NEW';p.querySelector('[data-field=case]').checked=true;vditor.__typoraFind.search()})()`);
    await until('!vditor.__typoraFind.state.pending');await ev('vditor.__typoraFind.navigate(1);true');
    const state=await ev('vditor.__typoraFind.state');
    await click('#typora-find [data-mode="find"]');
    await key('Tab');await key('Return');
    assert.ok(await ev(`(()=>{const p=document.getElementById('typora-find');return vditor.__typoraFind.state.replacing&&p.querySelector('[data-field=query]').value==='Alpha'&&p.querySelector('[data-field=replace]').value==='NEW'&&p.querySelector('[data-field=case]').checked})()`));
    assert.equal((await ev('vditor.__typoraFind.state')).active,state.active);pass(mode+' mouse and keyboard mode switches preserve query, replacement, case and current match');
    await key('Escape');assert.equal(await ev(`!!document.getElementById('typora-find')`),false);pass(mode+' native Esc closes panel from mode button');
    await key('H',['control']);await until(`!!document.getElementById('typora-find')`);
    await ev(`document.querySelector('#typora-find [data-field=replace]').focus();true`);await key('Escape');
    assert.ok(await ev(`!document.getElementById('typora-find')&&!CSS.highlights.has('typora-find')`));pass(mode+' native Esc closes replacement input and clears highlights');
    await key('F',['control']);await until(`!!document.getElementById('typora-find')`);
    await ev(`(()=>{const root=vditor.vditor[vditor.vditor.currentMode].element;root.focus();getSelection().collapse(root,0);window.__uiCaret=getSelection().getRangeAt(0).cloneRange()})()`);
    await key('Escape');
    const escaped=await ev(`(()=>{const s=getSelection(),n=s.anchorNode,root=vditor.vditor[vditor.vditor.currentMode].element,prefix=document.createRange();prefix.selectNodeContents(root);prefix.setEnd(n,s.anchorOffset);return{closed:!document.getElementById('typora-find'),same:n===__uiCaret.startContainer&&s.anchorOffset===__uiCaret.startOffset,sameDocumentStart:s.isCollapsed&&root.contains(n)&&__uiCaret.startContainer===root&&__uiCaret.startOffset===0&&prefix.toString()==='',before:{node:__uiCaret.startContainer.nodeName,offset:__uiCaret.startOffset,text:__uiCaret.startContainer.textContent.slice(0,80)},after:{node:n?.nodeName,offset:s.anchorOffset,text:n?.textContent.slice(0,80)},active:document.activeElement?.className,markdown:vditor.getValue()}})()`);
    if(!escaped.closed||!escaped.same&&!escaped.sameDocumentStart)fs.writeFileSync(path.join(output,'ui-escape-failure.json'),JSON.stringify({mode,...escaped},null,2));
    assert.ok(escaped.closed&&(escaped.same||escaped.sameDocumentStart),JSON.stringify({mode,...escaped}));pass(mode+' native Esc from document preserves its caret');
    if(mode==='sv'){
      // Chromium can normalize (PRE,0) to the first text node at offset zero.
      // Verify the observable insertion and undo, not only DOM node identity.
      await win.webContents.insertText('Q');await until(`vditor.getValue()===${JSON.stringify('Q'+escaped.markdown)}`,3000);
      await key('Z',['control']);await delay(350);
      const undoState=await ev(`({markdown:vditor.getValue(),mode:vditor.vditor.currentMode,undo:vditor.vditor.undo.sv.undoStack.length,redo:vditor.vditor.undo.sv.redoStack.length})`);
      if(undoState.markdown!==escaped.markdown)fs.writeFileSync(path.join(output,'ui-escape-undo-failure.json'),JSON.stringify({expected:escaped.markdown,...undoState},null,2));
      assert.equal(undoState.markdown,escaped.markdown,'Native source insertion after Escape must undo exactly');
      pass('Source document-start Escape retains the exact native insertion offset and undo');
    }
  }
  await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="ir"]').click();vditor.__typoraFind.open(false);true`);
  await click('button[data-type="theme-settings"]');await key('Escape');
  assert.ok(await ev(`!document.getElementById('typora-themes')&&!!document.getElementById('typora-find')`));pass('Esc closes a foreground theme dialog before the background find panel');
  await key('Escape');assert.ok(await ev(`!document.getElementById('typora-find')`));
  await ev(`vditor.__typoraFind.open(false);document.querySelector('#typora-find [data-field=query]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}));true`);
  assert.ok(await ev(`!!document.getElementById('typora-find')`));pass('IME Escape does not close find during composition');
  await ev('vditor.__typoraFind.close();true');
  for(const mode of ['ir','wysiwyg','sv']){
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();true`);await delay(250);
    for(const [letter,expected] of [['B','**format** tail'],['I','*format* tail']]){
      await ev(`vditor.setValue('format tail\\n',true);true`);await delay(250);
      await ev(`(()=>{const root=vditor.vditor[vditor.vditor.currentMode].element,walker=document.createTreeWalker(root,4);let n;while((n=walker.nextNode()))if(n.data.includes('format'))break;root.focus();const r=document.createRange();r.setStart(n,n.data.indexOf('format'));r.setEnd(n,n.data.indexOf('format')+6);getSelection().removeAllRanges();getSelection().addRange(r)})()`);
      await key(letter,['control']);await delay(200);
      assert.equal(await ev('vditor.getValue().trim()'),expected);pass(mode+' Ctrl+'+letter+' still formats text with its toolbar button hidden');
    }
  }
  await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="ir"]').click();true`);await delay(200);
  await ev(`vditor.__typoraFind.close();vditor.setValue(${JSON.stringify(fixture)},true);vditor.vditor.ir.element.scrollTop=0;getSelection().removeAllRanges();true`);
  for(const theme of ['konayuki-light','konayuki-dark']){
    await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,${JSON.stringify(theme)}))`);await delay(300);
    win.webContents.sendInputEvent({type:'mouseMove',x:900,y:600});
    await ev('document.activeElement.blur();true');await delay(100);
    fs.writeFileSync(path.join(output,'ui-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(output,'ui-toolbar-debug.json'),JSON.stringify(await ev(`Object.entries(vditor.vditor.toolbar.elements).map(([name,node])=>{const b=node.querySelector('button')||node,r=b.getBoundingClientRect();return{name,tag:b.tagName,x:r.x,y:r.y,w:r.width,h:r.height,visible:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})`),null,2));
  await ev(`vditor.__typoraFind.open(true);document.querySelector('#typora-find [data-field=query]').value='Alpha';vditor.__typoraFind.search();true`);await until('!vditor.__typoraFind.state.pending');
  fs.writeFileSync(path.join(output,'ui-find.png'),(await win.webContents.capturePage()).toPNG());
  // Recreate the editor to exercise the actual persisted preference path.
  const width=(await geometry()).outline.width;
  await ev(`vditor.__typoraFind.close();vditor.destroy();__open(${JSON.stringify(fixture)});true`);await until('window.vditor?.vditor?.__typoraPatched');
  await ev('vditor.vditor.outline.toggle(vditor.vditor,true);true');await delay(300);
  assert.ok(Math.abs((await geometry()).outline.width-width)<2);pass('Recreating the editor restores saved outline width');
  return results;
};
