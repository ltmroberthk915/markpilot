const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,fe,ev,until,load,key,type,select,value,shapes,check,pause,root,ready,output})=>{
  // 原来只认 .perf/release100-manual-fixtures/概率论-人工复核副本.md（早期人工放进去的
  // 副本，清理 .perf 时会被一起删掉，于是这条链整段 ENOENT 跑不起来）。缺失时回退到
  // 受保护的原素材（只读，一个字节都不改），保持这条人工复核链随时可用。
  const manualPath=path.resolve(__dirname,'../.perf/release100-manual-fixtures/概率论-人工复核副本.md');
  const manualSource=fs.existsSync(manualPath)?manualPath:'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md';
  const manual=fs.readFileSync(manualSource,'utf8');
  const idle=async()=>{await until("document.getElementById('editor')?.contentWindow.__typoraMathStats?.pending===0");await pause(180);};
  const click=async expr=>{
    const point=await fe(`(()=>{const n=${expr};n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),f=frameElement.getBoundingClientRect();return{x:Math.round(f.x+r.x+r.width/2),y:Math.round(f.y+r.y+r.height/2)}})()`);
    const zoom=win.webContents.getZoomFactor();
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(point.x*zoom),y:Math.round(point.y*zoom)});await pause(100);
  };
  const modeClick=async mode=>{
    await click("vditor.vditor.toolbar.elements['edit-mode'].querySelector('button')");
    await click(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]')`);await pause(220);
    assert.equal(await fe('vditor.vditor.currentMode'),mode);
  };
  const sourceClick=async()=>{await click("vditor.vditor.toolbar.elements['source-toggle'].querySelector('button')");await pause(220);};
  const trim=text=>text.replace(/\n+$/,'\n'); // native SV canonicalizes the terminal blank line
  // Native visual serialization pads table columns and IR adds a blank line
  // before tables. Ignore only those syntactic differences: retain every cell
  // character (including HTML/entities/math/code), every other line and space.
  const tableSource=text=>{
    const lines=trim(text).split('\n'),result=[];
    const padding=s=>s.replace(/^[ \t]+|[ \t]+$/g,'');
    const row=line=>{const cells=[];let start=0,slashes=0;for(let i=0;i<line.length;i++){if(line[i]==='|'&&slashes%2===0){cells.push(padding(line.slice(start,i)));start=i+1;}slashes=line[i]==='\\'?slashes+1:0;}cells.push(padding(line.slice(start)));return cells;};
    for(let i=0;i<lines.length;i++){
      if(lines[i].startsWith('|')&&/^\|[\s|:-]*-[\s|:-]*\|\s*$/.test(lines[i+1]||'')){
        while(result.at(-1)===''&&result.at(-2)==='')result.pop();
        result.push(JSON.stringify(row(lines[i++])));result.push(JSON.stringify(row(lines[i]).map(x=>x.replace(/-+/g,'-'))));
        while(lines[i+1]?.startsWith('|'))result.push(JSON.stringify(row(lines[++i])));
      }else result.push(lines[i]);
    }
    return result.join('\n');
  };
  const bounds=win.getBounds(),zoom=win.webContents.getZoomFactor();
  const sidebarHidden=await ev("document.querySelector('#app').classList.contains('sb-hidden')");
  try{
    for(const mode of ['ir','wysiwyg'])for(const narrow of [false,true])await check('E18',mode+' large-note history viewport '+(narrow?'narrow-zoom':'normal'),async()=>{
      win.setSize(narrow?754:1200,760);win.webContents.setZoomFactor(narrow?1.21:1);await pause(180);
      const {before}=await load(manual,mode);await idle();
      await ev("document.querySelector('#app').classList.add('sb-hidden');true");await pause(100);
      await fe(`vditor.vditor.toolbar.elements['reading-palette'].querySelector('button').click();document.querySelector('#typora-palette [data-palette="beige"]').click();document.querySelector('#typora-palette').close();document.querySelector('#typora-palette').remove();true`);await pause(120);
      const target=`[...${root}.querySelectorAll('td')].find(n=>n.textContent==='不变乙')`;
      await click(target);await key('Home');await key('End',['shift']);
      assert.equal(await fe('getSelection().toString()'),'不变乙');
      await key('Backspace');assert.equal(await fe(`${target}?.textContent??''`),'');
      await key('Z',['control'],0);await idle();assert.equal(await value(),before);
      const metrics=await fe(`(()=>{const s=getSelection(),r=document.createRange();r.setStart(s.focusNode,s.focusOffset);r.collapse(true);const c=r.getBoundingClientRect(),e=${root},b=e.getBoundingClientRect(),cell=(s.focusNode.nodeType===3?s.focusNode.parentElement:s.focusNode).closest('td'),p=vditor.vditor.wysiwyg.popover;return{caret:c.toJSON(),viewport:b.toJSON(),height:innerHeight,cell:cell?.textContent,cellRect:cell?.getBoundingClientRect().toJSON(),table:cell?.closest('table').getBoundingClientRect().toJSON(),popover:p.style.display==='block'?p.getBoundingClientRect().toJSON():null,scroll:e.scrollTop}})()`);
      fs.writeFileSync(path.join(output,mode+'-history-viewport-'+narrow+'.json'),JSON.stringify(metrics,null,2));
      assert.equal(metrics.cell,'不变乙');assert.ok(metrics.caret.height>0,'restored caret must have a visible line');
      assert.ok(metrics.caret.top>=metrics.viewport.top-1&&metrics.caret.bottom<=Math.min(metrics.height,metrics.viewport.bottom)+1,'restored focus line must remain within the viewport after math settles');
      assert.ok(metrics.cellRect.top>=metrics.viewport.top-1&&metrics.cellRect.bottom<=Math.min(metrics.height,metrics.viewport.bottom)+1,'normal-height restored cell must fit wholly in the viewport');
      if(mode==='wysiwyg'&&metrics.popover?.height)assert.ok(metrics.popover.bottom<=metrics.table.top+2,'table controls must remain above the table after undo and reflow');
      await type('光标验证');assert.ok((await value()).includes('光标验证'));assert.equal(await fe(`${root}.querySelector('table:last-of-type')?.textContent.includes('光标验证')`),true);
      await key('Z',['control'],0);await idle();assert.equal(await value(),before);return{metrics};
    });
  }finally{win.webContents.setZoomFactor(zoom);win.setBounds(bounds);await ev(`document.querySelector('#app').classList.toggle('sb-hidden',${sidebarHidden});true`);await pause(180);}
  const literalCode='<br /> <table> &amp; &lt; &#124;';
  const literalMath=String.raw`\text{\&amp; \&lt; \&#124;}`;
  const literalHTML='<div data-note="&amp;">literal &lt; &#124;</div>';
  const mixed='正文 **粗体 $x<y$ 和 $z>1$** 与 `<br /> &amp;`。\n\n| A | B | C |\n| - | - | - |\n| 首格<br />第二行 | <u>下划线</u> &amp; &lt; | `$a<b$` |\n| `a<br />b` | $\\begin{matrix}a&b\\\\c&d\\end{matrix}$ | 不变乙 |\n\n```html\n'+literalCode+'\n```\n\n$$\n'+literalMath+'\n$$\n\n'+literalHTML+'\n\n末段保留\n';
  for(const mode of ['ir','wysiwyg'])for(const kind of ['code-block','math-block'])await check('E30',mode+' block source entity native history '+kind,async()=>{
    const content=kind==='code-block'?literalCode:literalMath,block=kind==='code-block'?'```html\n'+content+'\n```':'$$\n'+content+'\n$$';
    const {before}=await load('前文\n\n'+block+'\n\n| A | B |\n| - | - |\n| 不变甲 | 不变乙 |\n',mode);await idle();
    assert.ok(before.includes(content),'initial source serialization must retain literal entities');
    const owner=`${root}.querySelector('[data-type="${kind}"]')`,code=`${owner}.querySelector('pre:not(.vditor-ir__preview):not(.vditor-wysiwyg__preview) code')`;
    await click(`${owner}.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview')`);await pause(180);
    assert.equal(await fe(`${code}.getBoundingClientRect().height>0`),true,'native preview click must expose source before typing');
    await select(code,'&amp;',{end:true});await type('Q');const changed=await value();assert.equal(changed,before.replace('&amp;','&amp;Q'));
    await key('Z',['control'],250);assert.equal(await value(),before);await key('Y',['control'],250);assert.equal(await value(),changed);await key('Z',['control'],250);assert.equal(await value(),before);
    await click(`[...${root}.querySelectorAll('td')].find(n=>n.textContent==='不变乙')`);assert.equal(await value(),before);assert.deepEqual(await shapes(),[[2,2]]);return{kind,content,exactHistory:true};
  });
  for(const mode of ['ir','wysiwyg'])for(const entry of ['menu','toggle'])for(const [name,source]of [['real-note',manual],['mixed-html',mixed]])await check('E26',mode+' table HTML source roundtrip '+entry+' '+name,async()=>{
    const {before,file}=await load(source,mode);await idle();const originalShape=await shapes();
    if(name==='mixed-html')for(const text of [literalCode,literalMath,literalHTML])assert.ok(before.includes(text),'initial literal block source: '+text);
    assert.ok(before.includes('首格<br />第二行'),'visual baseline must contain the multiline test cell');
    if(entry==='menu')await modeClick('sv');else await sourceClick();await idle();
    assert.equal(await fe('vditor.vditor.currentMode'),'sv');assert.equal(tableSource(await value()),tableSource(before),'entering SV must preserve cell characters and all surrounding content');
    const sourceBaseline=await value();
    const target=`[...${root}.querySelectorAll('[data-type="table"]')].find(n=>n.textContent.includes('首格'))`;
    assert.equal(await fe(`[...${target}.querySelectorAll('br')].every(n=>!!n.closest('[data-type="newline"]'))`),true,'source must contain only generated newline elements');
    await select(target,'第二行',{end:true});await type(' 续写🙂');await pause(250);const edited=await value();
    try{assert.equal(edited,sourceBaseline.replace('第二行','第二行 续写🙂'),'SV typing must preserve every other source byte');}
    catch(error){fs.writeFileSync(path.join(output,'roundtrip-mismatch.json'),JSON.stringify({mode,entry,name,expected:sourceBaseline.replace('第二行','第二行 续写🙂'),actual:edited},null,1));throw error;}
    await key('Z',['control'],250);
    try{assert.equal(await value(),sourceBaseline);}
    catch(error){fs.writeFileSync(path.join(output,'roundtrip-mismatch.json'),JSON.stringify({mode,entry,name,stage:'undo',expected:sourceBaseline,actual:await value()},null,1));throw error;}
    await key('Y',['control'],250);assert.equal(await value(),edited);
    if(entry==='menu')await modeClick(mode);else await sourceClick();await idle();
    assert.equal(await fe('vditor.vditor.currentMode'),mode);assert.deepEqual(await shapes(),originalShape);
    const returned=await value();assert.equal(tableSource(returned),tableSource(edited));
    const br=await fe(`(()=>{const t=[...${root}.querySelectorAll('td')].find(n=>n.textContent.includes('首格'));return{count:t.querySelectorAll('br').length,text:t.textContent}})()`);
    assert.ok(br.count>=1,'visual multiline cell must still contain its break');assert.ok(br.text.includes('第二行 续写🙂'));
    await pause(400);const host=global.doc.current.text;
    // A view-only switch need not rewrite the host's last edited Markdown just
    // to repad columns. Saving must preserve its exact bytes and cell content.
    assert.equal(tableSource(host),tableSource(returned));assert.equal(await global.doc.save(),true);assert.equal(fs.readFileSync(file,'utf8'),host);
    await load('# separate document\n');assert.equal(await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current.text}}),true);await ready();
    if(await fe('vditor.vditor.currentMode')!==mode)await modeClick(mode);await idle();assert.equal(tableSource(await value()),tableSource(returned));assert.deepEqual(await shapes(),originalShape);
    return{entry,mode,source:name,shape:originalShape,br,diskExact:true,sourceTypingExact:true,serialization:'Only table column padding, preceding blank lines and terminal blank lines canonicalized.'};
  });
};
