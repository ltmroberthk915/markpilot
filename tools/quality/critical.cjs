'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep,sha256}=require('./lifecycle.cjs');
const {outputDir,snapshot,reset,frame,newWindow,recorder,waitUntil}=require('./harness.cjs');
const {bitmap}=require('./clipboard.cjs');
(async()=>{
  const o=args(process.argv.slice(2)),dir=outputDir(o.out,'critical'),release=acquireSlot();
  const aFile=path.join(dir,'primary-bom-crlf.md'),bFile=path.join(dir,'secondary-lf.md'),cFile=path.join(dir,'utf16-chinese.md'),saveAs=path.join(dir,'secondary-save-as.md');
  const aText='A_DOCUMENT_SENTINEL\n\nPRIMARY CONTENT\n',bText='B_DOCUMENT_SENTINEL\nSECOND CONTENT\n',chinese='中文测试数据记录';
  fs.writeFileSync(aFile,'\ufeff'+aText.replaceAll('\n','\r\n'));fs.writeFileSync(bFile,bText);
  fs.writeFileSync(cFile,Buffer.concat([Buffer.from([255,254]),Buffer.from(chinese,'utf16le')]));
  const runtimeTemp=path.join(dir,'runtime-temp');fs.mkdirSync(runtimeTemp);
  const result={schema:1,startedAt:new Date().toISOString(),cases:[],frames:[],observations:[]};
  const check=recorder(dir,result);let run,clip;
  const capture=async(p,n)=>result.frames.push(await frame(p,dir,n));
  async function exportHtml(p,id,text) {
    await reset(p,text,0);
    const folder=path.join(dir,'html-'+id);fs.mkdirSync(folder);
    const r=await p.evaluate(dir=>window.mpExtras.exportFolder({dir,silent:true}),folder);
    assert(r?.ok,'folder export completed: '+JSON.stringify(r));
    assert(r.file&&fs.existsSync(r.file),'export contains HTML');
    const html=fs.readFileSync(r.file,'utf8');fs.copyFileSync(r.file,path.join(folder,'export.html'));
    return p.evaluate(html=>{
      const d=new DOMParser().parseFromString(html,'text/html');
      return {body:d.body.textContent,ol:d.querySelectorAll('ol').length,ul:d.querySelectorAll('ul').length,pre:[...d.querySelectorAll('pre')].map(e=>e.textContent),tables:[...d.querySelectorAll('table')].map(t=>[...t.rows].map(r=>[...r.cells].map(c=>c.textContent)))};
    },html);
  }
  try {
    run=await launch(o,aFile,dir,{MP_TEST_SAVE_AS:saveAs,MP_EXPORT_DIR:path.join(dir,'folder-export'),MP_KEEP_STAGING:'1',TEMP:runtimeTemp,TMP:runtimeTemp});
    const p=run.page;result.metadata=run.metadata;
    // Capture-only observer: it never changes or cancels a paste event.
    await p.evaluate(()=>{window.__qualityPastes=[];document.addEventListener('paste',e=>window.__qualityPastes.push({trusted:e.isTrusted,types:[...e.clipboardData.types],items:[...e.clipboardData.items].map(i=>({kind:i.kind,type:i.type})),files:[...e.clipboardData.files].map(f=>({type:f.type,size:f.size}))}),true);});
    await reset(p,'SCREENSHOT CLIPBOARD FIXTURE\n',0);
    const bitmapFile=path.join(dir,'clipboard-fixture.png');await p.screenshot({path:bitmapFile,clip:{x:150,y:50,width:200,height:80}});
    if(process.platform==='win32') {
      clip=await bitmap(bitmapFile);result.clipboard=clip.metadata;
      for(const mode of ['assets','inline']) {
        await check('windows-bitmap-control-v-'+mode,async trace=>{
          const text='---\nmp-image-mode: '+mode+'\n---\n\n图片正文\n';await reset(p,text,text.length);
          trace.push({before:await snapshot(p),clipboard:await p.evaluate(()=>window.mpHost.clipboardHasImage())});
          assert(trace[0].clipboard.hasImage,'Windows clipboard contains a bitmap');
          await p.keyboard.press('Control+v');await sleep(1800);
          const s=await snapshot(p),events=await p.evaluate(()=>window.__qualityPastes.slice(-1));trace.push({after:s,events});
          await capture(p,'clipboard-'+mode);assert(events[0]?.trusted,'trusted browser paste event');
          assert(s.text.includes('![]('),'Ctrl+V inserts Markdown image');
          if(mode==='assets') {
            const rel=/!\[\]\((assets\/[^)]+)\)/.exec(s.text)?.[1];assert(rel,'assets link inserted');
            const disk=path.resolve(dir,rel);assert(fs.existsSync(disk),'image file exists');
            const bytes=fs.readFileSync(disk);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a','PNG signature');
            trace.push({asset:path.basename(disk),bytes:bytes.length,sha256:sha256(disk)});
          } else assert(s.text.includes('data:image/png;base64,'),'inline PNG inserted');
          await p.keyboard.insertText('\n');await p.keyboard.press('Control+Home');await sleep(300);
          const images=await p.evaluate(()=>[...document.querySelectorAll('.cm-content img')].map(i=>({complete:i.complete,width:i.naturalWidth,height:i.naturalHeight})));
          assert(images.some(i=>i.complete&&i.width>0),'inserted image actually decodes');
          const deadline=Date.now()+10000;
          while(Date.now()<deadline) {
            const disk=fs.readFileSync(aFile,'utf8').replace(/^\ufeff/,'').replaceAll('\r\n','\n');
            if(disk===(await snapshot(p)).text)break;
            await sleep(150);
          }
          const disk=fs.readFileSync(aFile,'utf8').replace(/^\ufeff/,'').replaceAll('\r\n','\n');
          assert(disk===(await snapshot(p)).text,'Markdown autosaved after the final input');
          await sleep(300);
          const reload=await p.evaluate(()=>window.mpHost.reload());assert(reload.ok,'reload after save');await sleep(400);
          assert.equal((await snapshot(p)).text,disk,'reopened Markdown bytes');
          const reopened=await p.evaluate(()=>[...document.querySelectorAll('.cm-content img')].some(i=>i.complete&&i.naturalWidth>0));assert(reopened,'image renders after reopening');
          await capture(p,'clipboard-'+mode+'-reopened');
          return {images};
        });
      }
      await check('bitmap-frontmatter-is-explicitly-refused',async trace=>{
        const text='---\nmp-image-mode: assets\n---\n\n正文\n';await reset(p,text,5);await p.keyboard.press('Control+v');await sleep(500);
        const s=await snapshot(p),toast=await p.evaluate(()=>document.querySelector('.mp-toast')?.textContent||'');trace.push({state:s,toast});
        assert.equal(s.text,text);assert(toast.includes('头部信息区'),'refusal tells the user to move to body');return {toast};
      });
      await check('bitmap-paste-after-plain-paste-shortcut',async trace=>{
        await reset(p,'正文\n',3);await p.keyboard.press('Control+Shift+v');await sleep(200);
        trace.push({plainPaste:await snapshot(p)});await p.keyboard.press('Control+v');await sleep(1000);trace.push({ordinaryPaste:await snapshot(p),events:await p.evaluate(()=>window.__qualityPastes.slice(-2))});
        assert(trace[1].ordinaryPaste.text.includes('![]('),'ordinary bitmap paste works after plain-paste shortcut');
      });
      await check('unsaved-document-bitmap-paste-falls-back-inline',async trace=>{
        await sleep(700);
        const nativeKey=await p.evaluate(()=>window.mpHost.recentTestSendKey({keyCode:'N',modifiers:['control']}));trace.push({nativeKey});assert(nativeKey.ok&&nativeKey.focused);
        await waitUntil(()=>p.evaluate(()=>window.mpHost.currentDoc().then(d=>d==null)),'new blank document');
        await reset(p,'未命名截图\n',6);
        const info=await p.evaluate(()=>window.mpHost.currentDoc());assert.equal(info,null,'fixture is genuinely unsaved');
        await p.keyboard.press('Control+v');await sleep(1100);const s=await snapshot(p);trace.push(s);await capture(p,'clipboard-unsaved');
        assert(s.text.includes('data:image/png;base64,'),'unsaved document keeps image inline');
        await p.evaluate(()=>window.mpHost.docDirty(false)); // teardown only: discard this synthetic unsaved fixture
        const opened=await p.evaluate(file=>window.mpHost.openPath(file),aFile);assert(opened.ok);await sleep(500);
      });
      result.clipboardCleanup=await clip.restore();clip=null;
    } else throw new Error('This suite includes Windows screenshot paste; run it on Windows');
    await check('fenced-code-enter-preserves-literal-list',async trace=>{
      const text='```shell\n- install foo\n```\n',pos=text.indexOf('\n```');await reset(p,text,pos);trace.push({before:await snapshot(p)});
      await p.keyboard.press('Enter');const s=await snapshot(p);trace.push({after:s});await capture(p,'fenced-enter');
      assert.equal(s.text,text.slice(0,pos)+'\n'+text.slice(pos),'Enter inside code adds no list marker');
    });
    await check('list-home-enter-does-not-duplicate-marker',async trace=>{
      await reset(p,'- 项目\n',0);await p.keyboard.press('Enter');const s=await snapshot(p);trace.push(s);await capture(p,'list-home-enter');assert.equal(s.text,'\n- 项目\n');
    });
    for(const context of ['prose','list'])for(const key of ['Enter','Tab']) {
      await check('math-completion-'+context+'-'+key.toLowerCase(),async trace=>{
        const text=(context==='list' ? '- ' : '')+'计算 $';await reset(p,text,text.length);await p.keyboard.insertText('\\fra');
        await p.locator('.mp-complete').waitFor({state:'visible',timeout:4000});
        const label=await p.locator('.mp-complete-item.is-active .k').textContent();trace.push({before:await snapshot(p),selected:label});assert(label.includes('frac'),'fraction is the selected suggestion');
        await p.keyboard.press(key);const state=await snapshot(p);trace.push({after:state});await capture(p,'completion-'+context+'-'+key.toLowerCase());
        assert(state.text.includes('\\frac{'),'open completion accepts with '+key);assert(state.focus);assert(!state.text.includes('\n- '),'completion did not create another list item');
      });
    }
    await check('quoted-fence-does-not-render-table',async trace=>{
      const text='起点\n\n> ```\n> | a | b |\n> | --- | --- |\n> ```\n\n';await reset(p,text,0);await sleep(300);
      const tables=await p.locator('.mp-table-wrap').count();trace.push({tables,text:(await snapshot(p)).text});await capture(p,'quoted-fence-table');assert.equal(tables,0,'literal code has no table widget');
    });
    await check('quoted-fence-tab-keeps-editor-focus',async trace=>{
      const text='> ```\n> const a = 1\n> ```\n';await reset(p,text,text.indexOf('const'));await p.keyboard.press('Tab');const s=await snapshot(p);trace.push(s);assert(s.focus,'Tab stays in editor');assert(s.text.includes('const a = 1'));
    });
    await check('hashtag-without-space-is-not-heading',async trace=>{
      await reset(p,'起点\n#话题\n',0);const d=await p.evaluate(()=>[...document.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,class:e.className})));trace.push(d);await capture(p,'hashtag');assert(!d.some(e=>e.class.includes('mp-h1')&&e.text.includes('话题')),'#话题 remains ordinary text');
    });
    await check('ordered-list-export-preserves-numbering',async trace=>{
      const html=await exportHtml(p,'ordered','1. 甲\n2. 乙\n');trace.push(html);assert.equal(html.ol,1,'ordered Markdown exports as ol');assert.equal(html.ul,0);
    });
    await check('tilde-fence-export-preserves-code',async trace=>{
      await reset(p,'起点\n~~~text\n*x* $y$\n~~~\n',0);
      const editorLines=await p.evaluate(()=>[...document.querySelectorAll('.cm-line')].map(e=>({text:e.textContent,class:e.className})));
      trace.push({editorLines});assert(editorLines.some(e=>e.text.includes('~~~text')&&e.class.includes('mp-code')),'editor recognizes the same code fence');
      const html=await exportHtml(p,'tilde','~~~text\n*x* $y$\n~~~\n');trace.push(html);assert(html.pre.some(t=>t.includes('*x* $y$')),'tilde-fenced code exports literally');
    });
    await check('wide-dash-table-export-matches-editor',async trace=>{
      const text='| a | b |\n| —— | —— |\n| 1 | 2 |\n';await reset(p,text,0);const visible=await p.locator('.mp-table-wrap').count();
      const html=await exportHtml(p,'wide-dash',text);trace.push({visible,html});assert(visible>0,'fixture renders as a table');assert(!html.tables.some(t=>t.some(row=>row.some(c=>c.includes('——')))),'separator is not a data row');
    });
    await check('windows-format-undo-control-y-redo',async trace=>{
      await reset(p,'前文 target 后文',3,9);await p.keyboard.press('Control+b');trace.push(await snapshot(p));assert.equal(trace[0].text,'前文 **target** 后文');
      await p.keyboard.press('Control+z');trace.push(await snapshot(p));assert.equal(trace[1].text,'前文 target 后文');
      await p.keyboard.press('Control+y');trace.push(await snapshot(p));assert.equal(trace[2].text,'前文 **target** 后文');
    });
    await check('underline-empty-toggle-removes-entire-closing-tag',async trace=>{
      await reset(p,'');await p.keyboard.press('Control+u');const before=await snapshot(p);trace.push({before});assert.equal(before.text,'<u></u>');assert.equal(before.selection.head,3);
      await p.keyboard.press('Control+u');const after=await snapshot(p);trace.push({after});await capture(p,'underline-empty-toggle');assert.equal(after.text,'','toggle removes both full tags');
    });
    // Record the ambiguous post-typing toggle contract separately from correctness tests.
    for(const [key,open,close] of [['Control+b','**','**'],['Control+i','*','*'],['Control+u','<u>','</u>'],['Alt+Shift+5','~~','~~'],['Control+e','`','`']]) {
      await reset(p,'');await p.keyboard.press(key);await p.keyboard.insertText('词体');await p.keyboard.press(key);
      result.observations.push({id:'repeat-format-after-typing',key,open,close,state:await snapshot(p)});
    }
    await reset(p,aText,aText.length);await p.keyboard.insertText('A-EDIT');await sleep(900);
    const aSaved=(await snapshot(p)).text;
    const b=await newWindow(run,p,bFile);await b.bringToFront();await b.evaluate(()=>window.mpEngine.focus());
    await check('secondary-save-preserves-own-bom-eol',async trace=>{
      await b.keyboard.press('Control+End');await b.keyboard.insertText('B-EDIT');await sleep(1100);
      const disk=fs.readFileSync(bFile),state=await snapshot(b);trace.push({state,diskHex:disk.toString('hex'),primaryDisk:fs.readFileSync(aFile,'utf8'),infoA:await p.evaluate(()=>window.mpHost.currentDoc()),infoB:await b.evaluate(()=>window.mpHost.currentDoc())});
      await capture(b,'secondary-save');assert(!disk.subarray(0,3).equals(Buffer.from([239,187,191])),'LF/no-BOM secondary gained primary BOM');assert(!disk.includes(Buffer.from('\r\n')),'secondary gained primary CRLF');assert.equal(disk.toString('utf8'),state.text);
    });
    await check('secondary-save-keeps-both-saved-texts',async trace=>{
      const infoA=await p.evaluate(()=>window.mpHost.currentDoc()),infoB=await b.evaluate(()=>window.mpHost.currentDoc());trace.push({infoA,infoB});assert.equal(infoA.text,aSaved,'primary saved text stays primary');assert.equal(infoB.text,(await snapshot(b)).text,'secondary saved text updated');
    });
    await check('primary-pdf-exports-primary-with-secondary-open',async trace=>{
      await p.bringToFront();await p.evaluate(()=>window.mpEngine.focus());
      const r=await p.evaluate(file=>window.mpHost.exportPdf({outFile:file}),path.join(dir,'primary.pdf'));trace.push(r);assert(r?.ok,'PDF operation completes');
      const html=fs.readFileSync(r.html.file,'utf8');const body=await p.evaluate(h=>new DOMParser().parseFromString(h,'text/html').body.textContent,html);trace.push({htmlBody:body});
      assert(body.includes('A_DOCUMENT_SENTINEL'),'A export contains A');assert(!body.includes('B_DOCUMENT_SENTINEL'),'A export does not contain B');
    });
    await check('secondary-save-as-keeps-primary-path',async trace=>{
      const before=await p.evaluate(()=>window.mpHost.currentDoc());await b.bringToFront();await b.evaluate(()=>window.mpEngine.focus());
      const clicked=await b.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save-as',true));assert(clicked.ok);await sleep(1200);
      const after=await p.evaluate(()=>window.mpHost.currentDoc()),infoB=await b.evaluate(()=>window.mpHost.currentDoc());trace.push({before,after,infoB,primaryDisk:fs.readFileSync(aFile,'utf8')});
      assert.equal(after.filePath,before.filePath,'primary path unchanged by B Save As');assert.equal(infoB.filePath,saveAs);assert(fs.existsSync(saveAs));
    });
    await check('utf16-chinese-safe-open-and-edit',async trace=>{
      const before=fs.readFileSync(cFile),c=b;await c.bringToFront();
      const opened=await c.evaluate(file=>window.mpHost.openPath(file),cFile);trace.push({opened});
      if(!opened.ok) {assert(opened.error,'safe refusal explains the problem');assert(fs.readFileSync(cFile).equals(before),'refusal preserves original bytes');return {safelyRefused:true};}
      await sleep(400);await c.evaluate(()=>window.mpEngine.focus());
      const loaded=await snapshot(c);trace.push({beforeHex:before.toString('hex'),loaded});await capture(c,'utf16-open');
      await c.keyboard.press('Control+End');await c.keyboard.insertText('追加');await sleep(1100);
      const after=fs.readFileSync(cFile);trace.push({afterHex:after.toString('hex'),after:await snapshot(c)});
      assert.equal(loaded.text,chinese,'UTF16 is decoded correctly, or must be refused before editing');assert.equal(after.subarray(0,2).toString('hex'),'fffe','UTF16 encoding preserved');assert.equal(after.subarray(2).toString('utf16le'),chinese+'追加');
    });
    // A fresh isolated launch prevents previous Save As and encoding probes from affecting this guard.
    const firstCleanup=await run.cleanup();assert.deepEqual(firstCleanup.residual,[]);result.firstCleanup=firstCleanup;run=null;
    fs.writeFileSync(aFile,'PRIMARY GUARD FIXTURE\n');fs.writeFileSync(bFile,'SECONDARY GUARD FIXTURE\n');
    run=await launch(o,aFile,dir,{TEMP:runtimeTemp,TMP:runtimeTemp});
    await check('unsaved-native-close-control-keeps-window-open',async trace=>{
      const primary=run.page;
      await primary.evaluate(()=>window.mpHost.recentTestSendKey({keyCode:'N',modifiers:['control']}));
      await waitUntil(()=>primary.evaluate(()=>window.mpHost.currentDoc().then(d=>d==null)),'new blank document');
      await primary.evaluate(()=>window.mpEngine.focus());await primary.keyboard.insertText('UNSAVED CONTROL DRAFT');await sleep(200);trace.push({before:await snapshot(primary)});
      assert(trace[0].before.title.startsWith('●'));
      const focus=await primary.evaluate(()=>window.mpHost.recentTestSendKey({keyCode:'Escape',modifiers:[]}));assert(focus.focused);
      const clicked=await primary.evaluate(()=>window.mpHost.recentTestMenuClick('menu-close-window',true)).catch(e=>({closedDuringClick:primary.isClosed(),error:e.message}));trace.push({clicked});
      await sleep(800);trace.push({primaryClosed:primary.isClosed()});assert.equal(primary.isClosed(),false,'control really exercises native unsaved guard');
    });
    const controlCleanup=await run.cleanup();assert.deepEqual(controlCleanup.residual,[]);result.controlCleanup=controlCleanup;run=null;
    run=await launch(o,aFile,dir,{TEMP:runtimeTemp,TMP:runtimeTemp});const primary=run.page;
    await check('secondary-save-does-not-clear-primary-unsaved-close-guard',async trace=>{
      await primary.evaluate(()=>window.mpHost.recentTestSendKey({keyCode:'N',modifiers:['control']}));
      await waitUntil(()=>primary.evaluate(()=>window.mpHost.currentDoc().then(d=>d==null)),'new blank document');
      await primary.evaluate(()=>window.mpEngine.focus());await primary.keyboard.insertText('UNSAVED PRIMARY DRAFT');await sleep(200);
      const before=await snapshot(primary);assert(before.title.startsWith('●'),'primary has unsaved changes');trace.push({before});await capture(primary,'unsaved-primary-before');
      const secondary=await newWindow(run,primary,bFile);await secondary.bringToFront();await secondary.evaluate(()=>window.mpEngine.focus());await secondary.keyboard.press('Control+End');await secondary.keyboard.insertText('SAVED SECONDARY');
      const limit=Date.now()+8000;while(Date.now()<limit&&!fs.readFileSync(bFile,'utf8').endsWith('SAVED SECONDARY'))await sleep(150);
      assert(fs.readFileSync(bFile,'utf8').endsWith('SAVED SECONDARY'),'B really saved');await sleep(200);
      const afterSave=await snapshot(primary);trace.push({afterSave,secondaryDisk:fs.readFileSync(bFile,'utf8')});assert.equal(afterSave.text,'UNSAVED PRIMARY DRAFT');
      await primary.bringToFront();const focus=await primary.evaluate(()=>window.mpHost.recentTestSendKey({keyCode:'Escape',modifiers:[]}));assert(focus.focused);
      const clicked=await primary.evaluate(()=>window.mpHost.recentTestMenuClick('menu-close-window',true)).catch(e=>({closedDuringClick:primary.isClosed(),error:e.message}));trace.push({clicked});
      await sleep(800);trace.push({primaryClosed:primary.isClosed()});
      assert.equal(primary.isClosed(),false,'unsaved primary must stay open for save/discard confirmation');
    });
  } catch(e) {result.fatal=e.stack;console.error(e.message);}
  finally {
    if(clip) {try{result.clipboardCleanup=await clip.restore();}catch(e){result.clipboardCleanup={restored:false,error:e.message};}}
    result.cleanup=run ? await run.cleanup() : {residual:[]};result.finishedAt=new Date().toISOString();
    result.passed=!result.fatal&&result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&result.cleanup.residual.length===0&&result.clipboardCleanup?.restored===true;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();
    console.log(JSON.stringify({out:dir,passed:result.passed,total:result.cases.length,failed:result.cases.filter(c=>c.status==='fail').map(c=>c.id),cleanup:result.cleanup,clipboard:result.clipboardCleanup}));process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
