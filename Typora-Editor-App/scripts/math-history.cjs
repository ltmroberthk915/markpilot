const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.runMathHistory=async({win,ev,until,output})=>{
  const checks=[],states=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  await ev(`__open('# History\\n\\nKeep $a+1$.\\n\\n$x^2+y$\\n')`);await until('vditor?.vditor?.__typoraPatched');await pause(500);
  for(const mode of ['ir','wysiwyg']) for(const kind of ['inline','block','quote','list']) {
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();true`);
    const fragment={inline:'$x^2+y$',block:'$$\nx^2+y\n$$',quote:'> $$\n> x^2+y\n> $$',list:'- Math $x^2+y$'}[kind];
    const source='# History\n\nKeep $a+1$.\n\n'+fragment+'\n\nAfter.\n';
    await ev(`vditor.setValue(${JSON.stringify(source)},true);true`);await pause(500);
    await ev(`(()=>{const e=vditor.vditor,r=e[e.currentMode].element,c=[...r.querySelectorAll('code')].find(n=>n.textContent.replaceAll('\u200b','').trim()==='x^2+y'),owner=c.closest('.vditor-ir__node,.vditor-wysiwyg__block'),p=owner.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');window.__historyOriginal=vditor.getValue();window.__historyKeep=r.querySelector('.katex');p.dispatchEvent(new MouseEvent('click',{bubbles:true}));r.focus();window.__historyOffset=2+(c.textContent.startsWith('\u200b')?1:0);getSelection().collapse(c.firstChild,__historyOffset);})()`);
    win.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode:'7'});win.webContents.sendInputEvent({type:'char',keyCode:'7'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'7'});
    await pause(80);
    const changed=await ev('vditor.getValue()');if(changed===await ev('__historyOriginal'))fs.writeFileSync(path.join(output,'math-history-input-failure.json'),JSON.stringify(await ev(`(()=>{const e=vditor.vditor,r=e[e.currentMode].element,s=getSelection();return{mode:${JSON.stringify(mode)},kind:${JSON.stringify(kind)},html:r.innerHTML,focus:s.focusNode?.parentElement?.outerHTML,offset:s.focusOffset,active:document.activeElement?.outerHTML?.slice(0,100),documentFocus:document.hasFocus()}})()`),null,2));assert.notEqual(changed,await ev('__historyOriginal'));
    for(const action of ['undo','redo','undo']) {
      const keyCode=action==='undo'?'Z':'Y';
      win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers:['control']});
      await pause(650);
      const state=await ev(`(()=>{const e=vditor.vditor,r=e[e.currentMode].element,s=getSelection(),c=(s.focusNode?.nodeType===3?s.focusNode.parentElement:s.focusNode)?.closest('code'),o=c?.closest('.vditor-ir__node,.vditor-wysiwyg__block'),p=o?.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');return{mode:e.currentMode,md:vditor.getValue(),expected:__historyOriginal,source:c?.textContent,offset:s.focusOffset,expectedOffset:__historyOffset,owner:o?.outerHTML,expanded:o?.classList.contains('vditor-ir__node--expand'),height:c?.getBoundingClientRect().height,preview:p?.getBoundingClientRect().height,render:p?.querySelector('[data-math]')?.getAttribute('data-math'),kept:__historyKeep?.isConnected}})()`);
      states.push({mode,kind,action,...state});fs.writeFileSync(path.join(output,'math-history-state.json'),JSON.stringify(states,null,2));
      assert.equal(state.md,action==='redo'?changed:state.expected,mode+' '+kind+' '+action+' content');
      assert.ok(state.source&&state.height>0&&state.preview>0,mode+' '+kind+' '+action+' source and preview visible');
      if(mode==='ir'){assert.equal(state.expanded,true);assert.equal(state.kept,true);}
      assert.equal(state.render?.trim(),state.source?.replaceAll('\u200b','').trim());
      if(action==='undo')assert.equal(state.offset,state.expectedOffset,mode+' restored insertion point');
    }
    await ev(`document.execCommand('insertText',false,'k');true`);await pause(250);
    assert.ok((await ev('vditor.getValue()')).includes('x^k2+y'));
    checks.push('PASS '+mode+' '+kind+': undo/redo retains editable math, live preview, insertion point and subsequent typing');
  }
  fs.writeFileSync(path.join(output,'math-history.json'),JSON.stringify({checks},null,2));return checks;
};
