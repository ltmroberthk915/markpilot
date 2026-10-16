'use strict';
// Uses the same launcher, focus checks, snapshots and real inputs as critical.cjs.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {args,launch,acquireSlot,sleep}=require('./lifecycle.cjs');
const {outputDir,snapshot,frame,newWindow,newBlankWindow,recorder,waitUntil}=require('./harness.cjs');
const argv=process.argv.slice(2),si=argv.indexOf('--scope');
const scope=si<0?'all':argv.splice(si,2)[1];
if(!['all','sessions','encoding'].includes(scope))throw new Error('Use --scope all|sessions|encoding');
const ci=argv.indexOf('--case'),singleCase=ci<0?null:argv.splice(ci,2)[1];
if(singleCase&&!['save-receipt-does-not-clear-later-edit','external-change-with-identical-size-and-mtime-is-refused'].includes(singleCase))throw new Error('--case supports the independent receipt or external-conflict negative control');
const o=args(argv);
(async()=>{
  const dir=outputDir(o.out,'data-safety'),release=acquireSlot();
  const result={schema:1,scope,singleCase,startedAt:new Date().toISOString(),cases:[],frames:[]};
  const record=recorder(dir,result),check=(id,body)=>singleCase&&id!==singleCase?Promise.resolve():record(id,body),aFile=path.join(dir,'primary-bom-crlf.md'),bFile=path.join(dir,'secondary-lf.md'),saveAs=path.join(dir,'save-as.md');
  const aText='A_DOCUMENT_SENTINEL\nPRIMARY CONTENT\n',bText='B_DOCUMENT_SENTINEL\nSECOND CONTENT\n';
  fs.writeFileSync(aFile,'\ufeff'+aText.replaceAll('\n','\r\n'));fs.writeFileSync(bFile,bText);
  const temp=path.join(dir,'runtime-temp');fs.mkdirSync(temp);
  let run;
  async function focus(p){await p.bringToFront();await p.evaluate(()=>window.mpEngine.focus());await sleep(70);assert((await snapshot(p)).focus,'editor has genuine focus');}
  async function settled(p){await waitUntil(()=>p.evaluate(()=>window.mpHost.currentDoc().then(d=>d?.text===window.mpEngine.getValue()&&!document.title.startsWith('●'))),'saved text and clean title');await sleep(100);}
  async function capture(p,n){result.frames.push(await frame(p,dir,n));}
  async function open(p,file){const r=await p.evaluate(file=>window.mpHost.openPath(file),file);assert(r.ok,'open succeeded: '+JSON.stringify(r));await waitUntil(()=>p.evaluate(file=>window.mpHost.currentDoc().then(d=>d?.filePath===file),file),'opened document');await sleep(200);await focus(p);}
  try{
    run=await launch(o,aFile,dir,{MP_TEST_SAVE_AS:saveAs,MP_KEEP_STAGING:'1',MP_TEST_SAVE_DELAY_MS:'300',MP_TEST_REPLACE_RESPONSE:'discard',TEMP:temp,TMP:temp});
    result.metadata=run.metadata;const p=run.page;await focus(p);
    if(scope!=='encoding'){
      const b=await newWindow(run,p,bFile);await focus(b);
      await check('secondary-save-preserves-own-bom-eol',async trace=>{
        await b.keyboard.press('Control+End');await b.keyboard.insertText('B-EDIT');await settled(b);
        const disk=fs.readFileSync(bFile),s=await snapshot(b);trace.push({state:s,diskHex:disk.toString('hex')});await capture(b,'secondary-save');
        assert(!disk.subarray(0,3).equals(Buffer.from([239,187,191])),'B must not gain A BOM');assert(!disk.includes(Buffer.from('\r\n')),'B must not gain A CRLF');assert.equal(disk.toString('utf8'),s.text);assert.equal(fs.readFileSync(aFile,'utf8'),'\ufeff'+aText.replaceAll('\n','\r\n'));
      });
      await check('secondary-save-keeps-both-saved-texts',async trace=>{
        const a=await p.evaluate(()=>window.mpHost.currentDoc()),bi=await b.evaluate(()=>window.mpHost.currentDoc());trace.push({a,b:bi});assert.equal(a.text,aText);assert.equal(bi.text,(await snapshot(b)).text);
      });
      await check('focused-primary-native-menu-save',async trace=>{
        await focus(p);await p.keyboard.press('Control+End');await p.keyboard.insertText('A-EDIT');
        const before=Date.now(),r=await p.evaluate(()=>window.mpHost.recentTestSendKey({keyCode:'S',modifiers:['control']}));assert(r.focused);
        await waitUntil(()=>p.evaluate(at=>window.__mpDbg.saveTrace?.some(t=>t.step==='doSave:start'&&t.at>=at),before),'explicit save starts before autosave',350);await settled(p);
        trace.push({key:r,a:await p.evaluate(()=>window.mpHost.currentDoc()),b:await b.evaluate(()=>window.mpHost.currentDoc())});assert(fs.readFileSync(aFile,'utf8').includes('A-EDIT'));assert.equal(fs.readFileSync(bFile,'utf8'),bText+'B-EDIT');
      });
      await check('primary-pdf-exports-primary-with-secondary-open',async trace=>{
        await focus(p);const r=await p.evaluate(file=>window.mpHost.exportPdf({outFile:file}),path.join(dir,'primary.pdf'));trace.push(r);assert(r.ok,'PDF completes');
        const html=fs.readFileSync(r.html.file,'utf8'),body=await p.evaluate(h=>new DOMParser().parseFromString(h,'text/html').body.textContent,html);trace.push({htmlBody:body});assert(body.includes('A_DOCUMENT_SENTINEL'));assert(!body.includes('B_DOCUMENT_SENTINEL'));
      });
      await check('secondary-save-as-keeps-primary-path',async trace=>{
        const before=await p.evaluate(()=>window.mpHost.currentDoc());await focus(b);const r=await b.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save-as',true));assert(r.ok);await waitUntil(()=>b.evaluate(f=>window.mpHost.currentDoc().then(d=>d?.filePath===f),saveAs),'Save As commit');await settled(b);
        const after=await p.evaluate(()=>window.mpHost.currentDoc());trace.push({before,after,b:await snapshot(b)});assert.equal(after.filePath,before.filePath);assert.equal(fs.readFileSync(saveAs,'utf8'),(await snapshot(b)).text);assert.equal(fs.readFileSync(bFile,'utf8'),bText+'B-EDIT');
      });
      await check('failed-save-as-retains-source-and-dirty-state',async trace=>{
        fs.unlinkSync(saveAs);fs.mkdirSync(saveAs);await focus(p);const before=await p.evaluate(()=>window.mpHost.currentDoc());
        await p.keyboard.press('Control+End');await p.keyboard.insertText(' SAVE-AS-FAIL');await p.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save-as',true));await sleep(250);
        const after=await p.evaluate(()=>window.mpHost.currentDoc()),s=await snapshot(p);trace.push({before,after,state:s});assert.equal(after.filePath,before.filePath);assert(s.text.includes('SAVE-AS-FAIL'));assert(s.banner.includes('失败'));fs.rmdirSync(saveAs);await settled(p);
      });
      await check('same-file-two-windows-conflict-keeps-both-drafts',async trace=>{
        const file=path.join(dir,'shared.md');fs.writeFileSync(file,'SHARED BASE\n');const x=await newWindow(run,p,file),y=await newWindow(run,p,file);
        await focus(y);await y.keyboard.press('Control+End');await y.keyboard.insertText('Y-DRAFT');await y.evaluate(()=>doSave(true));await settled(y);
        // Set the second buffer dirty before bringing its window to front, preventing clean-focus reload.
        await x.evaluate(()=>window.mpEngine._view().dispatch({changes:{from:12,insert:'X-DRAFT'}}));await sleep(70);await focus(x);await x.keyboard.press('Control+End');await x.keyboard.insertText('!');await sleep(1200);
        const disk=fs.readFileSync(file,'utf8'),xs=await snapshot(x),ys=await snapshot(y);trace.push({disk,x:xs,y:ys});await capture(x,'same-file-conflict');assert.equal(disk,'SHARED BASE\nY-DRAFT');assert(xs.text.includes('X-DRAFT!'));assert(xs.title.startsWith('●'));assert(xs.banner.includes('修改')&&xs.banner.includes(file),'fresh conflict identifies this file');assert.equal(ys.text,disk);
      });
      await check('external-change-with-identical-size-and-mtime-is-refused',async trace=>{
        const file=path.join(dir,'external.md');fs.writeFileSync(file,'ORIGINAL\n');const x=await newWindow(run,p,file);await focus(x);const st=fs.statSync(file);fs.writeFileSync(file,'EXTERNAL\n');fs.utimesSync(file,st.atime,st.mtime);
        await x.keyboard.press('Control+End');await x.keyboard.insertText('LOCAL');await sleep(1200);const s=await snapshot(x);trace.push({state:s,disk:fs.readFileSync(file,'utf8')});await capture(x,'external-conflict');assert.equal(fs.readFileSync(file,'utf8'),'EXTERNAL\n');assert(s.text.includes('LOCAL'));assert(s.title.startsWith('●'));assert(s.banner.includes('修改')&&s.banner.includes(file));
      });
      await check('deleted-original-is-not-silently-recreated',async trace=>{
        const file=path.join(dir,'deleted.md');fs.writeFileSync(file,'DELETE BASE\n');const x=await newWindow(run,p,file);await focus(x);fs.unlinkSync(file);await x.keyboard.press('Control+End');await x.keyboard.insertText('LOCAL');await sleep(1200);const s=await snapshot(x);trace.push(s);assert(!fs.existsSync(file));assert(s.title.startsWith('●'));assert(s.banner.includes('不在'));
      });
      await check('save-receipt-does-not-clear-later-edit',async trace=>{
        const file=path.join(dir,'in-flight.md');fs.writeFileSync(file,'FLIGHT BASE\n');const x=await newWindow(run,p,file);await focus(x);await x.keyboard.press('Control+End');await x.keyboard.insertText('FIRST');
        await x.evaluate(()=>{window.__qualitySave=doSave(true);});await x.waitForFunction(()=>saveInFlight);await sleep(80);await x.keyboard.insertText('SECOND');await x.evaluate(()=>window.__qualitySave);const s=await snapshot(x);trace.push({afterFirst:s,disk:fs.readFileSync(file,'utf8')});assert(s.title.startsWith('●'),'second edit remains dirty after first receipt');assert(s.text.endsWith('FIRSTSECOND'));await settled(x);assert.equal(fs.readFileSync(file,'utf8'),s.text);
      });
      await check('late-save-receipt-does-not-change-new-document',async trace=>{
        const old=path.join(dir,'switch-old.md'),next=path.join(dir,'switch-new.md');fs.writeFileSync(old,'OLD\n');fs.writeFileSync(next,'NEW\n');const x=await newWindow(run,p,old);await focus(x);await x.keyboard.press('Control+End');await x.keyboard.insertText('SAVING');await x.evaluate(()=>{window.__qualitySave=doSave(true);});await x.waitForFunction(()=>saveInFlight);
        // The guarded test dialog explicitly selects discard. Clearing only the
        // main dirty flag cannot override the renderer's fresh source handshake.
        await open(x,next);await x.evaluate(()=>window.__qualitySave);const s=await snapshot(x),info=await x.evaluate(()=>window.mpHost.currentDoc());trace.push({state:s,info,old:fs.readFileSync(old,'utf8')});assert.equal(s.text,'NEW\n');assert.equal(info.filePath,next);assert.equal(info.text,'NEW\n');assert.equal(fs.readFileSync(next,'utf8'),'NEW\n');
      });
      await check('clean-view-reload-restores-revision-and-allows-later-save',async trace=>{
        const file=path.join(dir,'view-reload.md');fs.writeFileSync(file,'RELOAD BASE\n');const x=await newWindow(run,p,file);await focus(x);
        for(let i=0;i<4;i++)await x.keyboard.insertText('EDIT'+i);await settled(x);
        const before=await x.evaluate(()=>window.mpHost.currentDoc());await x.evaluate(()=>window.mpHost.recentTestMenuClick('menu-reload-view',true)).catch(()=>{});
        await waitUntil(()=>x.evaluate(()=>!!window.mpEngine?._view?.()&&booted).catch(()=>false),'view reload handshake');await sleep(350);await focus(x);
        const restored=await x.evaluate(()=>window.mpHost.currentDoc());assert.equal(restored.documentId,before.documentId);assert.equal((await snapshot(x)).text,before.text);
        await x.keyboard.press('Control+End');await x.keyboard.insertText('AFTER RELOAD');await settled(x);assert.equal(fs.readFileSync(file,'utf8'),(await snapshot(x)).text);trace.push({before,restored,after:await snapshot(x)});await capture(x,'view-reload');
      });
      await check('dirty-view-reload-cancel-preserves-unnamed-draft',async trace=>{
        const x=await newWindow(run,p,null);await focus(x);await x.keyboard.insertText('UNNAMED RELOAD DRAFT');const before=await snapshot(x);
        const r=await x.evaluate(()=>window.mpHost.recentTestMenuClick('menu-reload-view',true));await sleep(450);const after=await snapshot(x);trace.push({menu:r,before,after});assert.equal(after.text,before.text);assert(after.title.startsWith('●'));
        const log=fs.readFileSync(path.join(run.profile,'main-debug.log'),'utf8');assert(log.includes('doc:reload-confirm'),'dirty native refresh requests confirmation');
      });
      // Close-guard regression uses a fresh app so failed/conflicting fixtures cannot alter the oracle.
      result.firstCleanup=await run.cleanup();assert.deepEqual(result.firstCleanup.residual,[]);run=null;
      run=await launch(o,aFile,dir,{TEMP:temp,TMP:temp});
      await check('secondary-save-does-not-clear-primary-unsaved-close-guard',async trace=>{
        const primary=await newBlankWindow(run,run.page);await focus(primary);await primary.keyboard.insertText('UNSAVED PRIMARY DRAFT');await sleep(150);
        const secondary=await newWindow(run,primary,bFile);await focus(secondary);await secondary.keyboard.press('Control+End');await secondary.keyboard.insertText('SAVED SECONDARY');await settled(secondary);await capture(primary,'unsaved-primary');await focus(primary);
        const r=await primary.evaluate(()=>window.mpHost.recentTestMenuClick('menu-close-window',true)).catch(e=>({closed:primary.isClosed(),error:e.message}));await sleep(600);const log=fs.readFileSync(path.join(run.profile,'main-debug.log'),'utf8');trace.push({clicked:r,closed:primary.isClosed(),nativeConfirmationRequested:log.includes('doc:close-confirm')});assert.equal(primary.isClosed(),false,'native close requires save/discard confirmation for A');assert(log.includes('doc:close-confirm'),'this close actually entered the native unsaved confirmation');
      });
      result.closeGuardCleanup=await run.cleanup();assert.deepEqual(result.closeGuardCleanup.residual,[]);run=null;
      run=await launch(o,aFile,dir,{MP_TEST_SAVE_AS_CANCEL:'1',MP_TEST_CLOSE_RESPONSE:'0',TEMP:temp,TMP:temp});
      await check('save-and-close-with-cancelled-save-as-keeps-draft-and-cancels-close-intent',async trace=>{
        const x=await newBlankWindow(run,run.page);await focus(x);await x.keyboard.insertText('CANCELLED CLOSE DRAFT');
        await x.evaluate(()=>window.mpHost.docDirty(dirty,{documentId,revision}));
        await x.evaluate(()=>window.mpHost.recentTestMenuClick('menu-close-window',true));await sleep(400);assert(!x.isClosed());assert.equal((await snapshot(x)).text,'CANCELLED CLOSE DRAFT');assert((await snapshot(x)).title.startsWith('●'));
        const log=fs.readFileSync(path.join(run.profile,'main-debug.log'),'utf8');assert(log.includes('doc:close-confirm'));assert(/doc:close-save-cancelled .*"hadCloseIntent":true/.test(log),'cancelled Save As clears the actual pending close intent');trace.push({state:await snapshot(x),dialogSelection:'test-only native response 0; Save As cancellation hook'});
      });
    }
    if(scope!=='sessions'){
      result.beforeEncodingCleanup=await run.cleanup();assert.deepEqual(result.beforeEncodingCleanup.residual,[]);run=null;
      run=await launch(o,aFile,dir,{MP_TEST_SAVE_AS:saveAs,TEMP:temp,TMP:temp});const p=run.page;
      const text='中文测试数据记录\nASCII & emoji 😀\n\ufeff正文\n';
      for(const [encoding,bom,eol] of [['utf16le','fffe','\r\n'],['utf16be','feff','\n']]){
        const file=path.join(dir,encoding+'.md'),body=Buffer.from(text.replaceAll('\n',eol),'utf16le'),bytes=Buffer.concat([Buffer.from(bom,'hex'),encoding==='utf16be'?body.swap16():body]);fs.writeFileSync(file,bytes);
        await check(encoding+'-open-edit-reload-save-as-roundtrip',async trace=>{
          await open(p,file);const loaded=await snapshot(p);trace.push({loaded,originalHex:bytes.toString('hex')});await capture(p,encoding+'-open');assert.equal(loaded.text,text);assert(fs.readFileSync(file).equals(bytes),'opening never rewrites original');
          await p.keyboard.press('Control+End');await p.keyboard.insertText('追加');await settled(p);const expectedBody=Buffer.from((text+'追加').replaceAll('\n',eol),'utf16le'),expected=Buffer.concat([Buffer.from(bom,'hex'),encoding==='utf16be'?expectedBody.swap16():expectedBody]);assert(fs.readFileSync(file).equals(expected),'byte order, BOM and EOL survive editing');
          const r=await p.evaluate(()=>window.mpHost.reload());assert(r.ok);await sleep(200);assert.equal((await snapshot(p)).text,text+'追加');
          if(fs.existsSync(saveAs))fs.unlinkSync(saveAs);await p.evaluate(()=>window.mpHost.recentTestMenuClick('menu-save-as',true));await waitUntil(()=>p.evaluate(f=>window.mpHost.currentDoc().then(d=>d?.filePath===f),saveAs),'Save As commit');await settled(p);assert(fs.readFileSync(saveAs).equals(expected),'Save As preserves encoding');trace.push({afterHex:expected.toString('hex')});
        });
      }
      const invalid=[['odd-utf16','fffe61'],['unpaired-utf16','fffe00d8'],['utf32le','fffe000041000000'],['utf32be','0000feff00000041'],['invalid-utf8','c328']];
      for(const [name,hex]of invalid)await check(name+'-refused-without-mutating-current-document',async trace=>{
        const file=path.join(dir,name+'.md'),bytes=Buffer.from(hex,'hex');fs.writeFileSync(file,bytes);const before=await snapshot(p),info=await p.evaluate(()=>window.mpHost.currentDoc());const opened=await p.evaluate(file=>window.mpHost.openPath(file),file);trace.push({opened});assert.equal(opened.ok,false);assert(opened.error);assert(fs.readFileSync(file).equals(bytes));assert.equal((await snapshot(p)).text,before.text);assert.equal((await p.evaluate(()=>window.mpHost.currentDoc())).filePath,info.filePath);
      });
      await check('utf8-nul-and-literal-replacement-character-remain-valid',async trace=>{
        const file=path.join(dir,'utf8-controls.md'),text='合法文字 containing NUL\0 and literal �\n';fs.writeFileSync(file,text);await open(p,file);assert.equal((await snapshot(p)).text,text);await p.keyboard.press('Control+End');await p.keyboard.insertText('继续');await settled(p);assert.equal(fs.readFileSync(file,'utf8'),text+'继续');trace.push(await snapshot(p));
      });
    }
  }catch(e){result.fatal=e.stack;console.error(e.stack);}
  finally{
    result.cleanup=run?await run.cleanup():{residual:[]};result.finishedAt=new Date().toISOString();result.passed=!result.fatal&&result.cases.length>0&&result.cases.every(c=>c.status==='pass')&&result.cleanup.residual.length===0;
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));release();console.log(JSON.stringify({out:dir,passed:result.passed,total:result.cases.length,failed:result.cases.filter(c=>c.status==='fail').map(c=>c.id),cleanup:result.cleanup}));process.exitCode=result.passed?0:1;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
