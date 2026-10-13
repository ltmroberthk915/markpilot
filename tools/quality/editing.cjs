'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,reset,snapshot,frame,recorder}=require('./harness.cjs');
(async()=>{
  const argv=process.argv.slice(2),index=argv.indexOf('--family');let family='all';
  if(index>=0){family=argv[index+1];argv.splice(index,2);}
  assert(['all','code','lists','completion','headings','format','export'].includes(family),'Unknown family');
  const o=args(argv),dir=outputDir(o.out,'editing'),release=acquireSlot();
  const file=path.join(dir,'editing-fixture.md');fs.writeFileSync(file,'EDITING FIXTURE\n');
  const result={schema:1,startedAt:new Date().toISOString(),family,cases:[],frames:[],errors:[]};
  const check=recorder(dir,result);let run;
  const included=f=>family==='all'||family===f;
  try {
    run=await launch(o,file,dir,{MP_EXPORT_DIR:path.join(dir,'folder-export')});result.metadata=run.metadata;const p=run.page;
    p.on('pageerror',e=>result.errors.push(e.message));
    const capture=async n=>result.frames.push(await frame(p,dir,n));
    const focused=async()=>assert((await snapshot(p)).focus,'Real input has editor and document focus');
    if(included('code')) {
      for(const [id,open,close,lead,body] of [
        ['backticks','```shell','```','','- install foo'],
        ['tildes','~~~text','~~~','','1. literal'],
        ['quoted','```js','```','> ','- literal'],
        ['nested-quote','````js','````','> > ','- literal'],
        ['longer-close','````','`````','','- literal'],
        ['shorter-inner','````','````','','```\n- literal'],
        ['different-inner','```','```','','~~~\n- literal'],
        ['unclosed','```','','','- literal']
      ])await check('code-enter-'+id,async trace=>{
        const text=lead+open+'\n'+body.split('\n').map(l=>lead+l).join('\n')+'\n'+(close?lead+close+'\n':'');
        const pos=text.indexOf('- literal')>=0?text.indexOf('- literal')+'- literal'.length:text.indexOf(body)+body.length;
        await reset(p,text,pos);await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push({before:text,at:pos,after:state});
        if(['backticks','quoted','nested-quote'].includes(id))await capture('code-enter-'+id);
        assert(!state.text.slice(pos+1,pos+10).match(/^[-*+] |^\d+[.)] /),'Literal code must not continue a Markdown list');
        assert(state.focus);assert(state.text.includes(body.split('\n').at(-1)));
        assert.equal(state.text,text.slice(0,pos)+'\n'+lead+text.slice(pos),'Enter preserves the quote container and inserts exactly one newline');
      });
      for(const [id,lead,fence]of[['plain','','```'],['quoted','> ','~~~']])await check('code-tab-'+id,async trace=>{
        const text=lead+fence+'js\n'+lead+'const value = 1\n'+lead+fence+'\n',pos=text.indexOf('const');
        await reset(p,text,pos);await focused();await p.keyboard.press('Tab');let state=await snapshot(p);trace.push(state);await capture('code-tab-'+id);assert(state.focus);assert(state.text.includes('const value = 1'));assert.notEqual(state.text,text,'Tab edits indentation');
        await p.keyboard.press('Control+z');state=await snapshot(p);trace.push(state);assert.equal(state.text,text,'Undo restores the exact code');
      });
      for(const [id,text]of[
        ['quoted-table','起点\n\n> ```\n> | a | b |\n> | --- | --- |\n> ```\n'],
        ['different-fence','起点\n\n````\n~~~\n| a | b |\n| --- | --- |\n````\n'],
        ['unclosed','起点\n\n~~~\n| a | b |\n| --- | --- |\n']
      ])await check('code-no-table-'+id,async trace=>{
        await reset(p,text,0);await sleep(200);const tables=await p.locator('.mp-table-wrap').count();trace.push({text:(await snapshot(p)).text,tables});if(id==='quoted-table')await capture('quoted-literal-table');assert.equal(tables,0);
      });
      await check('code-checkmark-is-literal',async trace=>{
        await reset(p,'起点\n```\n- [ ] literal\n```\n',0);await capture('literal-task');assert.equal(await p.locator('.mp-cm6-check').count(),0,'Code has no clickable task widget');
      });
      await check('code-pipe-tab-does-not-enter-table',async trace=>{
        const text='> ~~~\n> | a | b |\n> | --- | --- |\n> ~~~\n',at=text.indexOf('a');await reset(p,text,at);await focused();await p.keyboard.press('Tab');const state=await snapshot(p);trace.push(state);await capture('code-pipe-tab');assert.equal(state.text,text.slice(0,at)+'  '+text.slice(at));assert(state.focus);assert.equal(await p.locator('.mp-table-wrap').count(),0);
      });
      await check('pipe-without-delimiter-editor-control',async trace=>{await reset(p,'起点\n| a | b |\n| 1 | 2 |\n',0);trace.push(await snapshot(p));assert.equal(await p.locator('.mp-table-wrap').count(),0);});
      for(const [id,lead,fence]of[['plain','','~~~'],['quoted','> ','~~~']])await check('code-math-is-literal-'+id,async trace=>{
        const text='起点\n'+lead+fence+'text\n'+lead+'*literal* $x$\n'+lead+'$$\n'+lead+'y\n'+lead+'$$\n'+lead+fence+'\n';
        await reset(p,text,0);await sleep(180);const math=await p.locator('.katex').count();const codeLines=await p.evaluate(()=>[...document.querySelectorAll('.cm-line.mp-code')].map(e=>({text:e.textContent,n:e.getAttribute('data-mp-n')})));trace.push({state:await snapshot(p),math,codeLines});await capture('code-math-'+id);assert.equal(math,0);assert.equal((await snapshot(p)).text,text);assert.equal(codeLines.find(l=>l.text.includes('literal'))?.n,'1','First code content line has number 1');
      });
      await check('code-quoted-completion-and-auto-break-disabled',async trace=>{
        const text='> ~~~js\n> a $';await reset(p,text,text.length);await focused();await p.keyboard.insertText('\\fra');await sleep(180);assert.equal(await p.locator('.mp-complete:visible').count(),0);
        await p.keyboard.press('Tab');assert.equal((await snapshot(p)).text,text+'\\fra  ');assert((await snapshot(p)).focus);
        const dollars='> ~~~js\n> a $$x$';await reset(p,dollars,dollars.length);await focused();await p.keyboard.insertText('$');await sleep(180);trace.push(await snapshot(p));assert.equal((await snapshot(p)).text,dollars+'$');await capture('code-quoted-dollars');
      });
      await check('code-closing-info-keeps-literal',async trace=>{
        const text='```\nx\n``` js\n- literal\n';await reset(p,text,text.indexOf('- literal')+9);await focused();await p.keyboard.press('Enter');trace.push(await snapshot(p));assert.equal((await snapshot(p)).text,text.replace('- literal\n','- literal\n\n'));
      });
      await check('code-closing-tail-edit-and-undo',async trace=>{
        const text='~~~\nx\n~~~\n- after\n';await reset(p,text,9);await focused();await p.keyboard.insertText('a');assert.equal((await snapshot(p)).text,'~~~\nx\n~~~a\n- after\n');
        await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,text);await p.keyboard.press('Control+y');assert.equal((await snapshot(p)).text,'~~~\nx\n~~~a\n- after\n');
        await p.keyboard.press('Control+End');await p.keyboard.press('ArrowLeft');await focused();await p.keyboard.press('Enter');trace.push(await snapshot(p));assert.equal((await snapshot(p)).text,'~~~\nx\n~~~a\n- after\n\n');
      });
      await check('code-quoted-shift-tab-preserves-container',async trace=>{
        const text='> ~~~js\n>   x\n> ~~~\n';await reset(p,text,text.indexOf('x')+1);await focused();await p.keyboard.press('Shift+Tab');const state=await snapshot(p);trace.push(state);await capture('code-outdent-quoted');assert.equal(state.text,'> ~~~js\n> x\n> ~~~\n');assert(state.focus);await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,text);
      });
      for(const [id,text,at,to,expected]of[
        ['indent','> ```js\n>     ab\n> ```\n',16,16,'> ```js\n>     ab\n>     \n> ```\n'],
        ['body-home','> ```js\n> ab\n> ```\n',10,10,'> ```js\n> \n> ab\n> ```\n'],
        ['selection','> ```js\n> abcdef\n> ```\n',12,14,'> ```js\n> ab\n> ef\n> ```\n'],
        ['closing-default','> ```js\n> ab\n> ```\n',18,18,'> ```js\n> ab\n> ```\n\n']
      ])await check('code-enter-'+id,async trace=>{
        await reset(p,text,at,to);await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push(state);await capture('code-enter-'+id);assert.equal(state.text,expected);assert(state.focus);await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,text);
      });
      await check('code-enter-multiple-cursors',async trace=>{
        const text='> ```\n> ab\n> cd\n> ```\n';await reset(p,text,10);await p.evaluate(()=>{const v=window.mpEngine._view(),E=v.state.selection.constructor;v.dispatch({selection:E.create([E.cursor(10),E.cursor(15)],0)});});await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push(state);await capture('code-enter-multiple');assert.equal(state.text,'> ```\n> ab\n> \n> cd\n> \n> ```\n');assert.equal(await p.evaluate(()=>window.mpEngine._view().state.selection.ranges.length),2);assert(state.focus);
      });
      await check('code-line-numbers-map-and-remove',async trace=>{
        const text='before\n~~~\nfirst\nsecond\n~~~\n';await reset(p,text,0);await p.keyboard.insertText('above\n');await p.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));let lines=await p.evaluate(()=>[...document.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,n:e.getAttribute('data-mp-n')})));trace.push(lines);assert.equal(lines.find(l=>l.text==='first')?.n,'1');assert.equal(lines.find(l=>l.text==='second')?.n,'2');
        await p.keyboard.press('ArrowDown');await p.keyboard.press('Home');await p.keyboard.press('Delete');await p.keyboard.press('Delete');await p.keyboard.press('Delete');await p.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));lines=await p.evaluate(()=>[...document.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,n:e.getAttribute('data-mp-n')})));trace.push(lines);await capture('code-number-clear');assert.equal(lines.find(l=>l.text==='first')?.n,null);assert.equal(lines.find(l=>l.text==='second')?.n,null);
      });
      await check('code-bare-blank-line-ends-quote-like-parser',async trace=>{
        const text='> ```\n> a\n\n> b\n> ```\n> c';await reset(p,text,0);const lines=await p.evaluate(()=>[...document.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,code:e.classList.contains('mp-code')})));trace.push(lines);assert.equal(lines.find(l=>l.text==='b')?.code,false);assert.equal(lines.find(l=>l.text==='c')?.code,true);
      });
    }
    if(included('lists')) {
      for(const [id,text,at,expected]of[
        ['home','- 项目\n',0,'\n- 项目\n'],
        ['tail','- 项目\n',4,'- 项目\n- \n'],
        ['ordered','9. item\n',7,'9. item\n10. \n'],
        ['task','- [x] task\n',10,'- [x] task\n- [ ] \n'],
        ['empty','- ',2,''],
        ['empty-task','- [ ] ',6,''],
        ['indented','  - word\n',8,'  - word\n  - \n']
      ])await check('list-enter-'+id,async trace=>{
        await reset(p,text,at);await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push(state);if(id==='home')await capture('list-home');assert.equal(state.text,expected);assert(state.focus);
      });
      await check('list-enter-replaces-selection',async trace=>{
        await reset(p,'- abcdef\n',4,6);assert.equal((await snapshot(p)).text.slice(4,6),'cd');await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push(state);await capture('list-selection');assert.equal(state.text,'- ab\n- ef\n');assert(state.focus);
      });
      await check('list-enter-multiple-cursors',async trace=>{
        await reset(p,'- ab\n- cd',4);await p.evaluate(()=>{const v=window.mpEngine._view(),E=v.state.selection.constructor;v.dispatch({selection:E.create([E.cursor(4),E.cursor(9)],0)});});await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push(state);await capture('list-multiple');assert.equal(state.text,'- ab\n- \n- cd\n- ');const ranges=await p.evaluate(()=>window.mpEngine._view().state.selection.ranges.length);assert.equal(ranges,2);
      });
      await check('list-before-fence-plain-edit-maps-context',async trace=>{
        const text='- ab\n```\nx\n```\n';await reset(p,text,4);await focused();await p.keyboard.insertText('c');await p.keyboard.press('Enter');trace.push(await snapshot(p));assert.equal((await snapshot(p)).text,'- abc\n- \n```\nx\n```\n');
      });
      await check('task-widget-positive-control',async trace=>{await reset(p,'起点\n- [ ] task\n',0);trace.push(await snapshot(p));assert.equal(await p.locator('.mp-cm6-check').count(),1);});
    }
    if(included('completion')) {
      for(const [id,lead]of[['prose',''],['list','- '],['nested-list','  - '],['ordered','1. '],['quote','> ']])for(const key of ['Enter','Tab'])await check('completion-'+id+'-'+key,async trace=>{
        const text=lead+'计算 $';await reset(p,text,text.length);await focused();await p.keyboard.insertText('\\fra');
        await p.locator('.mp-complete').waitFor({state:'visible',timeout:4000});const selected=await p.locator('.mp-complete-item.is-active .k').textContent();assert(selected.includes('frac'));
        if(id==='list'&&key==='Enter')await capture('completion-list-open');
        await focused();await p.keyboard.press(key);const state=await snapshot(p);trace.push({selected,state});if(lead==='- ')await capture('completion-list-'+key.toLowerCase());assert(state.text.startsWith(lead));assert(state.text.includes('\\frac{'));assert(!state.text.includes('\n'));assert(state.focus);
      });
      await check('completion-mouse-acceptance',async trace=>{
        await reset(p,'- 计算 $',6);await p.keyboard.insertText('\\fra');const item=p.locator('.mp-complete-item.is-active');await item.waitFor({state:'visible'});await item.click();const state=await snapshot(p);trace.push(state);assert(state.text.includes('\\frac{'));assert(state.focus);await capture('completion-mouse');
      });
      await check('completion-escape-resumes-list-enter',async trace=>{
        const text='- 计算 $';await reset(p,text,text.length);await p.keyboard.insertText('\\fra');await p.locator('.mp-complete').waitFor({state:'visible'});await p.keyboard.press('Escape');await focused();await p.keyboard.press('Enter');const state=await snapshot(p);trace.push(state);assert(state.text.includes('\n- '));assert(!state.text.includes('\\frac{'));
      });
    }
    if(included('headings'))for(const [id,line,level]of[
      ['hashtag','#话题',0],['tag-many','###topic',0],['space','# 标题',1],['tab','##\t标题',2],['empty','###',3],['seven','####### 标题',0],['indented','  ## 标题',2]
    ])await check('heading-'+id,async trace=>{
      const text='起点\n'+line+'\n';await reset(p,text,0);const lines=await p.evaluate(()=>[...document.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,class:e.className})));
      trace.push(lines);const actual=lines[1];assert(actual);if(id==='hashtag'||id==='indented')await capture('heading-'+id);if(level)assert(actual.class.includes('mp-h'+level));else assert(!/mp-h\d/.test(actual.class));assert.equal((await snapshot(p)).text,text);
    });
    if(included('format')) {
      await check('bold-single-star-existing-toggle',async trace=>{await reset(p,'**',1);await focused();await p.keyboard.press('Control+b');const state=await snapshot(p);trace.push(state);assert.equal(state.text,'');assert(state.focus);});
      await check('underline-empty-toggle',async trace=>{
        await reset(p,'');await focused();await p.keyboard.press('Control+u');assert.equal((await snapshot(p)).text,'<u></u>');await focused();await p.keyboard.press('Control+u');const state=await snapshot(p);trace.push(state);await capture('underline-empty');assert.equal(state.text,'');
      });
      for(const [id,anchor,head]of[['forward',3,5],['reverse',5,3]])await check('underline-remove-'+id,async trace=>{
        const text='<u>词体</u>';await reset(p,text,anchor,head);assert.equal(text.slice(Math.min(anchor,head),Math.max(anchor,head)),'词体');await focused();await p.keyboard.press('Control+u');const state=await snapshot(p);trace.push(state);assert.equal(state.text,'词体');await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,text);
      });
      await check('underline-real-drag-shift-toggle',async trace=>{
        const text='abcdef\n';await reset(p,text,0);const points=await p.evaluate(()=>[1,5].map(pos=>window.mpEngine._view().coordsAtPos(pos)));assert(points.every(Boolean));
        const y=(points[0].top+points[0].bottom)/2;await p.mouse.move(points[0].left,y);await p.mouse.down();for(let i=1;i<=8;i++){await p.mouse.move(points[0].left+(points[1].left-points[0].left)*i/8,y);await sleep(16);}await p.mouse.up();
        await focused();await p.keyboard.press('Shift+ArrowRight');const selected=await snapshot(p);trace.push(selected);assert.equal(text.slice(Math.min(selected.selection.anchor,selected.selection.head),Math.max(selected.selection.anchor,selected.selection.head)),'bcdef');
        await p.keyboard.press('Control+u');assert.equal((await snapshot(p)).text,'a<u>bcdef</u>\n');for(let i=0;i<5;i++)await p.keyboard.press('Shift+ArrowLeft');
        const inner=await snapshot(p);trace.push(inner);assert.equal(inner.text.slice(Math.min(inner.selection.anchor,inner.selection.head),Math.max(inner.selection.anchor,inner.selection.head)),'bcdef');
        await p.keyboard.press('Control+u');const state=await snapshot(p);trace.push(state);await capture('underline-drag');assert.equal(state.text,'abcdef\n');
      });
    }
    if(included('export'))for(const [id,text,verify]of[
      ['ordered','1. 甲\n2. 乙\n',d=>{assert.equal(d.ol.length,1);assert.equal(d.ul,0);assert.deepEqual(d.ol[0].items,['甲','乙']);}],
      ['ordered-start','7) 甲\n8) 乙\n',d=>{assert.equal(d.ol.length,1);assert.equal(d.ol[0].start,'7');}],
      ['mixed-lists','1. 甲\n2. 乙\n\n- 丙\n- 丁\n',d=>{assert.equal(d.ol.length,1);assert.equal(d.ul,1);}],
      ['tilde','~~~text\n*x* $y$\n~~~\n',d=>assert(d.pre.some(t=>t.includes('*x* $y$')))],
      ['fence-literal-inner','````text\n```\n*x* $y$\n````\n',d=>assert(d.pre.some(t=>t.includes('```\n*x* $y$')))],
      ['fence-unclosed','~~~text\n*x* $y$\n',d=>assert(d.pre.some(t=>t.includes('*x* $y$')))],
      ['quoted-fence','> ~~~text\n> | a | b |\n> | --- | --- |\n> ~~~\n',d=>{assert.equal(d.tables.length,0);assert(d.pre.some(t=>t.includes('| a | b |')));}],
      ['quoted-extra-marker','> ~~~text\n> > literal\n>\t~~~\n',d=>{assert.equal(d.pre.length,1);assert.equal(d.pre[0].trim(),'> literal');}],
      ['pipe-without-delimiter','| a | b |\n| 1 | 2 |\n',d=>assert.equal(d.tables.length,0)],
      ['wide-dash','| a | b |\n| —— | —— |\n| 1 | 2 |\n',d=>{assert.equal(d.tables.length,1);assert.deepEqual(d.tables[0],[['a','b'],['1','2']]);}],
      ['en-dash-align','| a | b |\n| :–– | ––: |\n| 1 | 2 |\n',d=>{assert.equal(d.tables.length,1);assert.deepEqual(d.tables[0],[['a','b'],['1','2']]);}]
    ])await check('export-'+id,async trace=>{
      await reset(p,text,0);const folder=path.join(dir,'html-'+id);fs.mkdirSync(folder);const response=await p.evaluate(dir=>window.mpExtras.exportFolder({dir,silent:true}),folder);trace.push(response);assert(response?.ok);assert(fs.existsSync(response.file));
      const html=path.join(folder,'export.html');fs.copyFileSync(response.file,html);
      await p.evaluate(html=>new Promise(resolve=>{const iframe=document.createElement('iframe');iframe.id='quality-export-frame';iframe.sandbox='allow-same-origin';Object.assign(iframe.style,{position:'fixed',inset:'0',width:'100vw',height:'100vh',border:'0',zIndex:'2147483647',background:'white'});iframe.onload=()=>resolve();iframe.srcdoc=html;document.body.appendChild(iframe);}),fs.readFileSync(html,'utf8'));
      try {
        const state=await p.evaluate(()=>{const d=document.getElementById('quality-export-frame').contentDocument;return{body:d.body.textContent,ol:[...d.querySelectorAll('ol')].map(e=>({start:e.getAttribute('start'),items:[...e.querySelectorAll(':scope > li')].map(li=>li.textContent)})),ul:d.querySelectorAll('ul').length,pre:[...d.querySelectorAll('pre')].map(e=>e.textContent),tables:[...d.querySelectorAll('table')].map(t=>[...t.rows].map(r=>[...r.cells].map(c=>c.textContent)))};});trace.push(state);
        const imageName='export-'+id+'.png';await p.screenshot({path:path.join(dir,imageName),animations:'disabled'});result.frames.push({kind:'html-export',file:imageName,sha256:sha256(path.join(dir,imageName))});verify(state);
      }finally{await p.evaluate(()=>document.getElementById('quality-export-frame')?.remove());await p.bringToFront();await p.evaluate(()=>window.mpEngine.focus());}
    });
    assert.deepEqual(result.errors,[],'No renderer exceptions');
  }catch(e){result.fatal=e.stack;}
  finally {
    result.cleanup=run?await run.cleanup():{residual:[]};result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&!result.errors.length&&!result.cleanup.residual.length;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();console.log(JSON.stringify({out:dir,passed:result.passed,total:result.cases.length,failed:result.cases.filter(c=>c.status==='fail').map(c=>c.id),fatal:result.fatal,cleanup:result.cleanup}));process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
