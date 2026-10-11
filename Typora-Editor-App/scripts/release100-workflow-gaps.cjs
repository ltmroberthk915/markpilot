// Additional workflow evidence. Uses disposable files and native Electron input.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms)),results=[],base=path.join(output,'workflow-fixtures');
  fs.mkdirSync(base,{recursive:true});global.doc.setSetting('autoSave',false);
  const fe=code=>ev(`document.getElementById('editor').contentWindow.eval(${JSON.stringify(code)})`);
  const root='vditor.vditor[vditor.vditor.currentMode].element';
  const value=()=>fe('vditor.getValue()');let serial=0;
  const ready=async()=>{const version=global.doc.docVersion;await until(`(()=>{const w=document.getElementById('editor')?.contentWindow;return w&&new URL(w.location.href).searchParams.get('v')==='${version}'&&!!w.vditor?.__completion})()`);await pause(180);};
  const load=async(text,mode='ir')=>{
    const file=path.join(base,'case-'+(++serial)+'.md');fs.writeFileSync(file,text);
    await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});await ready();
    if(await fe('vditor.vditor.currentMode')!==mode){await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();true`);await pause(150);}
    await fe('vditor.clearStack();true');return{file,before:await value()};
  };
  const key=async(keyCode,modifiers=[],delay=80)=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode,modifiers});await pause(delay);};
  const type=async(text)=>{await win.webContents.insertText(text);await pause(100);};
  const select=async(expr,text,{end=false,reverse=false,collapsed=false}={})=>{
    await fe(`(()=>{const root=${root},target=${expr};target.scrollIntoView({block:'center',inline:'center'});const w=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(!n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')&&n.data.includes(${JSON.stringify(text)}))break;if(!n)throw Error('Missing text');root.focus();const at=n.data.indexOf(${JSON.stringify(text)})+${end?text.length:0},s=getSelection();s.setBaseAndExtent(n,at+${reverse?text.length:0},n,at+${collapsed||end?0:reverse?0:text.length});return s.toString()})()`);
  };
  const table='('+root+').querySelector("table")',cell=(r,c)=>`${table}.rows[${r}].cells[${c}]`;
  const shapes=()=>fe(`[...${root}.querySelectorAll('table')].map(t=>[...t.rows].map(r=>r.cells.length))`);
  const action=async(r,c,name)=>{
    await fe(`(()=>{const t=${cell(r,c)};t.scrollIntoView({block:'center',inline:'center'});const b=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:Math.min(innerWidth-4,b.right-3),clientY:Math.min(innerHeight-4,b.top+12)}));const button=document.querySelector('#typora-editor-context-menu [data-action="${name}"]');if(!button)throw Error('Missing action ${name}');button.click();return true})()`);await pause(150);
  };
  const check=async(id,name,fn)=>{
    if(process.env.RELEASE100_GAPS_FILTER&&!new RegExp(process.env.RELEASE100_GAPS_FILTER).test(name))return;
    try{const evidence=await fn();results.push({id,name,passed:true,evidence});console.log('PASS '+id+' '+name);}
    catch(error){results.push({id,name,passed:false,error:error.stack,value:await value().catch(()=>null)});fs.writeFileSync(path.join(output,'gap-failure-'+results.length+'.png'),(await win.webContents.capturePage()).toPNG());console.log('FAIL '+id+' '+name+': '+error.message.slice(0,220));}
    fs.writeFileSync(path.join(output,'workflow-gaps.json'),JSON.stringify(results,null,2));
  };
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const {dialog,clipboard,ClipboardItem}=require('electron'),show=dialog.showMessageBoxSync,restoreClipboard=await require('./test-clipboard.cjs').preserveClipboard();
  try{
    await require('./release100-render-roundtrip.cjs').run({win,fe,ev,until,load,key,type,select,value,shapes,check,pause,root,ready,output});
    await check('E01','same basename in Chinese/space/emoji paths',async()=>{
      const files=['甲 空格🙂','乙 空格🙂'].map(d=>path.join(base,d,'相同名称.md'));
      for(const [i,file] of files.entries()){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# distinct-'+i+'\n\n正文🙂\n');}
      for(const i of [0,1,0,1]){const result=await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(files[i])}})`);assert.equal(result.ok,true);await ready();assert.equal(global.doc.file,files[i]);assert.ok((await value()).includes('distinct-'+i));}
      return{files};
    });
    for(const [choice,label]of [[2,'cancel'],[0,'save'],[1,'discard']])await check('E02','dirty file switch '+label,async()=>{
      const {file,before}=await load('正文\n'),other=path.join(base,'other-'+choice+'.md');fs.writeFileSync(other,'# other\n');
      await select(`${root}.querySelector('p')`,'正文',{end:true});await type('未保存🙂');await pause(350);const changed=await value();assert.equal(global.doc.current.text,changed);
      const messages=[];dialog.showMessageBoxSync=(_w,o)=>{messages.push(o.message);return choice;};
      try{assert.equal(await global.doc.openFile(other),choice!==2);if(choice!==2)await ready();
        assert.equal(fs.readFileSync(file,'utf8'),choice===0?changed:before);if(choice===2){assert.equal(await value(),changed);assert.equal(global.doc.file,file);assert.equal(global.doc.dirty,true);}else assert.equal(global.doc.file,other);
        assert.ok(messages.some(x=>x.includes('未保存')));return{choice,changed};
      }finally{dialog.showMessageBoxSync=show;}
    });
    await check('E05','save failure keeps edit then retry and snapshot restore',async()=>{
      const {file,before}=await load('待保存正文\n');await select(`${root}.querySelector('p')`,'正文',{end:true});await type('修改🙂');await pause(350);const changed=await value();
      const rename=fsp.rename,messages=[];dialog.showMessageBoxSync=(_w,o)=>{messages.push(o.message);return 0;};
      fsp.rename=async(from,to)=>{if(path.resolve(to)===file)throw Object.assign(Error('fixture write denied'),{code:'EACCES'});return rename(from,to);};
      try{assert.equal(await global.doc.save(),false);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(global.doc.dirty,true);assert.equal(await value(),changed);assert.ok(messages.includes('保存失败'));}
      finally{fsp.rename=rename;dialog.showMessageBoxSync=show;}
      assert.equal(await global.doc.save(),true);assert.equal(fs.readFileSync(file,'utf8'),changed);assert.equal(global.doc.dirty,false);
      await Promise.all([...global.doc.snapshots.queues.values()]);const items=await global.doc.snapshots.list(file);assert.ok(items.length>=2);return{versions:items.length,changed};
    });
    const fixture='# table\n\n| A | B | C |\n| --- | --- | --- |\n| left | $x+1$ | right |\n| first<br>second | `a` | [link](https://example.org) |\n| last |  | end |\n\nTAIL 🙂\n';
    for(const mode of ['ir','wysiwyg']){
      for(const place of ['plain','bold','table'])for(const boundary of ['start','end'])for(const kind of ['type','paste','commit','cancel'])await check('E20',mode+' formula boundary input '+place+' '+boundary+' '+kind,async()=>{
        const math='前 $x+1$ 后 $y+2$。',body=place==='table'?'| A | B |\n| - | - |\n| '+math+' | 不变乙 |\n':place==='bold'?'**'+math+'**\n':math+'\n';
        const {before}=await load('先前正文\n\n'+body+'\nTAIL\n',mode);
        await select(`${root}.querySelector('p')`,'先前正文',{end:true});await type('旧编辑');await pause(250);const previous=await value();
        const target=`[...${root}.querySelectorAll('code[data-type="math-inline"]')].find(n=>n.textContent.includes('x+1'))`;
        const p=await fe(`(()=>{const c=${target},p=c.closest('.vditor-ir__node,.vditor-wysiwyg__block').querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');p.scrollIntoView({block:'center'});const r=p.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+r.x+r.width/2),y:Math.round(f.y+r.y+r.height/2)}})()`);
        for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(80);
        await select(target,'x+1',{end:boundary==='end',collapsed:true});
        let inserted='q';
        if(kind==='type')await type(inserted);
        else if(kind==='paste'){inserted=place==='table'?String.raw`q\vert{}r`:'q|r';await clipboard.writeText('q|r');await key('V',['control'],150);}
        else{
          inserted='中文';await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:inserted,selectionStart:2,selectionEnd:2});
          if(kind==='cancel')await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
          else await win.webContents.debugger.sendCommand('Input.insertText',{text:inserted});
        }
        await pause(300);const changed=await value();
        if(kind==='cancel'){assert.equal(changed,previous);await key('Z',['control'],250);assert.equal(await value(),before);return{cancelHasNoUndoStep:true};}
        const expected=boundary==='start'?inserted+'x+1':'x+1'+inserted;
        const state=await fe(`(()=>{const c=${target},o=c.closest('.vditor-ir__node,.vditor-wysiwyg__block');return{source:c.textContent.replaceAll('\u200b',''),render:o.querySelector('[data-math]')?.getAttribute('data-math'),markers:[...o.children].filter(n=>n.tagName!=='CODE'&&n.classList.contains('vditor-ir__marker')).map(n=>n.textContent)}})()`);
        assert.equal(state.source,expected,'all inserted text must belong to the formula source');assert.equal(state.render,expected,'preview must match the actual edited formula');if(mode==='ir')assert.deepEqual(state.markers,['$','$']);
        assert.ok(changed.includes('$y+2$'));if(place==='table'){assert.deepEqual(await shapes(),[[2,2]]);assert.ok(changed.includes('不变乙'));}
        await key('Z',['control'],250);assert.equal(await value(),previous);await key('Y',['control'],250);assert.equal(await value(),changed);return{state,previous,changed};
      });
      for(const place of ['paragraph','table'])for(const oldHistory of [false,true])await check('E21',mode+' native formula shortcut undo focus '+place+' '+oldHistory,async()=>{
        const rn=String.raw`可见**概率密度正是观测样本空间 $(\mathbb{R}^k,\mathcal{B})$ 上，诱导概率测度 $\mathbb{P}_X$ 对平凡勒贝格测度 $\mathcal{L}$ 的 Radon–Nikodym 导数**。`;
        const {before}=await load('前文旧位置\n\n'+(place==='table'?'| A | B |\n| - | - |\n| '+rn+' | 不变乙 |\n':rn+'\n')+'\nTAIL\n',mode);
        if(oldHistory){await select(`${root}.querySelector('p')`,'前文旧位置',{end:true});await type('旧编辑');await key('Z',['control'],250);assert.equal(await value(),before);}
        const target=`[...${root}.querySelectorAll('code[data-type="math-inline"]')].find(n=>n.textContent.includes('mathbb{R}'))`;
        const point=await fe(`(()=>{const c=${target},p=c.closest('.vditor-ir__node,.vditor-wysiwyg__block').querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');p.scrollIntoView({block:'center',inline:'center'});const r=p.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+r.x+r.width/2),y:Math.round(f.y+r.y+r.height/2)}})()`);
        for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(100);
        assert.equal(await fe(`(getSelection().focusNode?.nodeType===3?getSelection().focusNode.parentElement:getSelection().focusNode)?.closest('code')===${target}`),true,'native formula click must enter source');
        await key('E',['control','shift'],200);const unwrapped=await value();assert.notEqual(unwrapped,before);
        await key('Z',['control'],250);assert.equal(await value(),before);
        assert.equal(await fe(`(getSelection().focusNode?.nodeType===3?getSelection().focusNode.parentElement:getSelection().focusNode)?.closest('code')===${target}`),true,'formula shortcut undo must restore editable formula source');
        const inspect=()=>fe(`(()=>{const c=${target},s=getSelection();return{code:c.outerHTML,owner:c.closest('.vditor-ir__node,.vditor-wysiwyg__block').outerHTML.slice(0,1100),focus:{node:s.focusNode?.nodeName,text:s.focusNode?.textContent?.slice(0,100),offset:s.focusOffset,parent:s.focusNode?.parentElement?.tagName}}})()`);
        const restored=await inspect();await type('q');const changed=await value(),typed=await inspect();
        fs.writeFileSync(path.join(output,mode+'-formula-undo-'+place+'-'+oldHistory+'.json'),JSON.stringify({restored,typed,changed},null,2));
        assert.notEqual(changed,before);assert.ok((await fe(`${target}.textContent`)).includes('q'));assert.ok(changed.includes('$\\mathbb{P}_X$')&&changed.includes('$\\mathcal{L}$'));
        await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),changed);return{place,oldHistory,unwrapped,changed};
      });
      await check('B03',mode+' focused editor sidebar accelerator',async()=>{
        const {before}=await load('快捷键位置 $x+1$\n',mode);await select(`${root}.querySelector('p')`,'快捷键位置',{end:true});
        const hidden=()=>ev("document.querySelector('#app').classList.contains('sb-hidden')"),initial=await hidden();
        const menu=require('electron').Menu.getApplicationMenu(),item=menu.items.flatMap(n=>n.submenu?.items||[]).find(n=>n.label==='侧边栏');
        assert.equal(item.accelerator,'CmdOrCtrl+Alt+B');
        await key('B',['control','alt'],200);assert.equal(await hidden(),!initial,'focused editor must deliver sidebar shortcut');assert.equal(await value(),before);
        await key('B',['control','alt'],200);assert.equal(await hidden(),initial);assert.equal(await value(),before);return{accelerator:item.accelerator,documentPreserved:true};
      });
      for(const kind of ['reverse Unicode','line break','composition commit','composition cancel'])await check('E18',mode+' undo input position '+kind,async()=>{
        const {before}=await load('正文旧位置\n\n| A | B |\n| - | - |\n| 第一行<br>中文🙂é末行 | 不变乙 |\n\nTAIL\n',mode);
        await select(`${root}.querySelector('p')`,'正文旧位置',{end:true});await type('第一改动');await pause(260);const first=await value();
        await select(cell(1,0),'中文🙂é末行',{reverse:kind==='reverse Unicode',end:kind!=='reverse Unicode'});
        if(kind==='line break')await key('Enter',['shift'],100);
        else if(kind.startsWith('composition')){
          await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'输入',selectionStart:2,selectionEnd:2});
          if(kind==='composition cancel'){
            await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await pause(260);assert.equal(await value(),first);
            await select(cell(1,1),'不变乙',{end:true});
          }else await win.webContents.debugger.sendCommand('Input.insertText',{text:'输入'});
        }else await type('反向替换🙂');
        if(kind!=='line break'&&kind!=='reverse Unicode')await type('继续');
        await pause(260);const second=await value(),target=cell(1,kind==='composition cancel'?1:0);
        assert.notEqual(second,first);await key('Z',['control'],250);assert.equal(await value(),first);
        assert.equal(await fe(`(getSelection().focusNode?.nodeType===3?getSelection().focusNode.parentElement:getSelection().focusNode)?.closest('td')===${target}`),true);
        const selection=await fe('getSelection().toString()');if(kind==='reverse Unicode')assert.equal(selection,'中文🙂é末行');
        await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),first);await key('Y',['control'],250);assert.equal(await value(),second);
        await key('Z',['control'],250);await type('定位验证');assert.ok((await fe(`${target}.textContent`)).includes('定位验证'));assert.deepEqual(await shapes(),[[2,2]]);return{selection,first,second};
      });
      await check('E18',mode+' undo at another cell retains input position',async()=>{
        const {before}=await load('旧位置 $a+1$。\n\n| A | B | C |\n| - | - | - |\n| first<br>second | $x+1$ | 不变甲 |\n| last | $y+1$ | 不变乙 |\n\nTAIL\n',mode);
        await select(`${root}.querySelector('p')`,'旧位置',{end:true});await type('旧编辑');await key('Z',['control'],250);assert.equal(await value(),before);
        const target=cell(2,2),point=await fe(`(()=>{const c=${target};c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+r.x+10),y:Math.round(f.y+r.y+r.height/2)}})()`);
        for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(100);
        assert.equal(await fe(`getSelection().focusNode?.parentElement?.closest('td')===${target}`),true);
        await key('Home');await key('End',['shift']);assert.equal(await fe('getSelection().toString()'),'不变乙');
        await key('Backspace',[],150);const empty=await value();assert.ok(!empty.includes('不变乙')&&empty.includes('不变甲'));assert.deepEqual(await shapes(),[[3,3,3]]);
        await key('Delete');assert.equal(await value(),empty);await key('Z',['control'],250);assert.equal(await value(),before);
        const focus=await fe(`(()=>{const s=getSelection();return{inCell:(s.focusNode?.nodeType===3?s.focusNode.parentElement:s.focusNode)?.closest('td')===${target},text:s.toString(),offset:s.focusOffset}})()`);
        assert.equal(focus.inCell,true,'undo must restore the edited cell before any new click');
        await key('Y',['control'],250);assert.equal(await value(),empty);await key('Z',['control'],250);assert.equal(await value(),before);
        await type('原格续写🙂');const changed=await value();assert.ok((await fe(`${target}.textContent`)).includes('原格续写🙂'));assert.ok(changed.includes('旧位置')&&!changed.includes('旧编辑')&&changed.includes('不变甲')&&changed.includes('$x+1$')&&changed.includes('$y+1$'));
        await key('Z',['control'],250);assert.equal(await value(),before);return{focus,changed,nativeMouseAndKeys:true};
      });
      await check('E20',mode+' native empty math multiline paste',async()=>{
        await load('| A | B |\n| - | - |\n|  | untouched |\n',mode);
        await fe(`(()=>{const root=${root},r=document.createRange();root.focus();r.selectNodeContents(${cell(1,0)});r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);return true})()`);
        await key('E',['control','shift']);const empty=await value();await clipboard.writeText('a|b\nc');await key('V',['control'],250);const changed=await value();
        assert.equal(await fe(`(${cell(1,0)}).querySelector('code[data-type="math-inline"]')?.textContent.replaceAll('\u200b','')`),String.raw`a\vert{}b c`);assert.ok(changed.includes('untouched'));assert.deepEqual(await shapes(),[[2,2]]);
        await key('Z',['control'],250);assert.equal(await value(),empty);await key('Y',['control'],250);assert.equal(await value(),changed);return{changed};
      });
      for(const cancel of [false,true])await check('E09',mode+' native IME shortcut and source click '+(cancel?'cancel':'commit'),async()=>{
        const {before}=await load('target\n\nunchanged $a+1$\n',mode);
        await select(`${root}.querySelector('p')`,'arget',{collapsed:true});
        const send=(method,params)=>win.webContents.debugger.sendCommand(method,params);
        await send('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});await send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
        await key('E',['control','shift'],80);assert.ok(!(await value()).includes('$中文$'));
        if(cancel)await send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
        const point=await fe(`(()=>{const n=vditor.vditor.toolbar.elements['source-toggle'].querySelector('button'),r=n.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+r.x+r.width/2),y:Math.round(f.y+r.y+r.height/2)}})()`);
        for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(350);
        assert.equal(await fe('vditor.vditor.currentMode'),'sv');const changed=await value(),expected=cancel?before:before.replace('target','t中文arget');assert.equal(changed.replace(/\n+$/,'\n'),expected.replace(/\n+$/,'\n'));return{cancel,changed};
      });
      for(const [r,c,op,expected]of [[0,0,'table-col-left',[3,4]],[3,2,'table-col-right',[3,4]],[0,0,'table-delete-col',[3,2]],[3,2,'table-delete-col',[3,2]],[0,0,'table-row-above',[4,3]],[3,2,'table-row-below',[4,3]],[1,0,'table-delete-row',[2,3]],[3,2,'table-delete-row',[2,3]]])await check('E13',mode+' boundary '+op+' '+r+'/'+c,async()=>{
        const {before}=await load(fixture,mode);await action(r,c,op);const current=await shapes(),changed=await value();assert.equal(current[0].length,expected[0]+1);assert.ok(current[0].every(n=>n===expected[1]));assert.ok(changed.includes('TAIL 🙂'));
        if(op!=='table-delete-row')assert.ok(changed.includes('$x+1$')||op==='table-delete-col'&&c===1);await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),changed);return{shape:current};
      });
      await check('E07',mode+' nested format boundary insert and history',async()=>{
        const {before}=await load('开始 **粗体 *边界🙂*** 后续 $x+1$。\n\n不变段落\n',mode);
        await select(`${root}.querySelector('em')`,'边界🙂',{end:true});await type('界');const changed=await value();assert.ok(changed.includes('边界🙂界'));assert.ok(changed.includes('$x+1$')&&changed.includes('不变段落'));await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),changed);return{changed};
      });
      for(const reverse of [false,true])await check('E08',mode+' cross paragraph Unicode '+(reverse?'reverse':'forward'),async()=>{
        const {before}=await load('首段 中文🙂é\n\n末段 内容🙂结束\n\n保持段 $x+1$\n',mode);
        const selected=await fe(`(()=>{const root=${root},p=root.querySelectorAll('p'),a=p[0].firstChild,b=p[1].firstChild;root.focus();getSelection().setBaseAndExtent(${reverse?'b,b.length,a,0':'a,0,b,b.length'});return getSelection().toString()})()`);assert.ok(selected.includes('中文🙂é')&&selected.includes('内容🙂结束'));
        await key('B',['control'],250);const changed=await value();assert.notEqual(changed,before);assert.ok(changed.includes('**首段 中文🙂é**\n\n**末段 内容🙂结束**')&&changed.includes('$x+1$'));
        await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),changed);
        const canonical=x=>x.replace(/\n+$/,'\n');
        await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="sv"]').click();true`);await pause(150);assert.equal(canonical(await value()),canonical(changed));await fe(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();true`);await pause(150);assert.equal(canonical(await value()),canonical(changed));return{selected,changed,modeRoundTrip:'exact except native terminal blank-line normalization'};
      });
      await check('E08',mode+' cross block bold apply and cancel with adjacent math',async()=>{
        const {before}=await load('第一段🙂\n\n第二段🙂\n\n不变 $a+1$\n',mode);
        await fe(`(()=>{const root=${root},p=root.querySelectorAll('p'),r=document.createRange();root.focus();r.setStart(p[0],0);r.setEnd(p[1],p[1].childNodes.length);getSelection().removeAllRanges();getSelection().addRange(r);return true})()`);
        await key('B',['control'],250);assert.ok((await value()).includes('**第一段🙂**\n\n**第二段🙂**'));
        await key('B',['control'],250);assert.equal(await value(),before);return{exactToggleRoundTrip:true};
      });
      await check('E11',mode+' nested list Enter Backspace Tab and undo',async()=>{
        const {before}=await load('> - 父级\n>   - 子级🙂\n>   - 保留项\n\n| A | B |\n| - | - |\n| 原格 | $x+1$ |\n',mode);
        await select(`[...${root}.querySelectorAll('li')].find(n=>n.textContent.includes('子级🙂')&&!n.querySelector('li'))`,'子级🙂',{end:true});
        for(const k of ['Enter','Tab','Backspace']){const previous=await value();await key(k,[],300);const changed=await value();assert.ok(changed.includes('保留项')&&changed.includes('$x+1$'));assert.deepEqual(await shapes(),[[2,2]]);if(changed!==previous){await key('Z',['control'],300);assert.equal(await value(),previous);}}
        assert.equal(await value(),before);return{before};
      });
      await check('E16',mode+' duplicate cell reverse replacement preserves neighbors',async()=>{
        const {before}=await load('| A | B | C |\n| - | - | - |\n| 相同🙂 | 相同🙂 | 相同🙂 |\n',mode);
        await select(cell(1,1),'相同🙂',{reverse:true});await type('目标🙂');const changed=await value();assert.equal((changed.match(/相同🙂/g)||[]).length,2);assert.equal((changed.match(/目标🙂/g)||[]).length,1);assert.deepEqual(await shapes(),[[3,3]]);await key('Z',['control'],250);assert.equal(await value(),before);return{changed};
      });
      await check('E17',mode+' TSV pipe paste into cell then undo',async()=>{
        const {before}=await load('| A | B |\n| - | - |\n| target | untouched |\n',mode);await select(cell(1,0),'target');await clipboard.writeText('一\t二\n三|四');await key('V',['control'],400);const changed=await value();assert.ok(changed.includes('一')&&changed.includes('二')&&changed.includes('三')&&changed.includes('四')&&changed.includes('untouched'));assert.deepEqual(await shapes(),[[2,2]]);await key('Z',['control'],300);assert.equal(await value(),before);return{changed};
      });
      for(const text of ['left|right','一\r\n二\r三','**bold** | $x+1$ <b>tag</b>','\\frac{x}{y}\n`code`\t🙂'])await check('E17',mode+' single cell literal paste '+JSON.stringify(text),async()=>{
        const {before}=await load('| A | B |\n| - | - |\n| target | untouched |\n',mode);await select(cell(1,0),'target');await clipboard.writeText(text);await key('V',['control'],350);const changed=await value();
        assert.ok(changed.includes('untouched'));assert.deepEqual(await shapes(),[[2,2]]);await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),changed);
        await fe(`vditor.setValue(${JSON.stringify(changed)},true);true`);await pause(250);assert.deepEqual(await shapes(),[[2,2]]);assert.equal((await value()).replace(/\n+$/,'\n'),changed.replace(/\n+$/,'\n'));return{clipboardText:text,changed};
      });
      await check('E40',mode+' Office HTML table paste undo and repeat',async()=>{
        const {before}=await load('PASTE\n\n保留 $x+1$\n',mode);
        const html='<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><table><tr><td>编号</td><td>内容</td></tr><tr><td style="mso-number-format:\'\\@\'">00123</td><td>中文🙂 &amp; 文本</td></tr></table><!--EndFragment--></body></html>';
        for(let i=0;i<2;i++){await select(`${root}.querySelector('p')`,'PASTE');await clipboard.write([new ClipboardItem({'text/html':html,'text/plain':'编号\t内容\n00123\t中文🙂 & 文本'})]);await key('V',['control'],450);const changed=await value();assert.ok(changed.includes('00123')&&changed.includes('中文🙂')&&changed.includes('$x+1$'));assert.deepEqual(await shapes(),[[2,2]]);await key('Z',['control'],300);assert.equal(await value(),before);}return{nativeClipboardHTML:true};
      });
      await check('E15',mode+' wide table after resize and final-column menu',async()=>{
        const md='|'+Array.from({length:12},(_,i)=>'column_'+i).join('|')+'|\n|'+Array(12).fill('---').join('|')+'|\n|'+Array.from({length:12},(_,i)=>i===11?'$\\frac{x_1+x_2}{1+y^2}$':'value_'+i).join('|')+'|\n\nTAIL\n';
        const {before}=await load(md,mode),oldSize=win.getSize();
        try{win.setSize(720,650);await pause(250);await action(1,11,'table-col-right');assert.deepEqual(await shapes(),[[13,13]]);assert.ok((await value()).includes('value_0')&&(await value()).includes('$\\frac{x_1+x_2}{1+y^2}$'));await key('Z',['control'],300);assert.equal(await value(),before);return{viewport:[720,650],columns:12};}
        finally{win.setSize(...oldSize);await pause(120);}
      });
    }
  }finally{dialog.showMessageBoxSync=show;await restoreClipboard();win.webContents.debugger.detach();}
  assert.ok(results.every(x=>x.passed),results.filter(x=>!x.passed).map(x=>x.name).join('; '));return results.map(x=>'PASS '+x.id+' '+x.name);
};
