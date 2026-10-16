'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {args,launch,acquireSlot,sha256,sleep}=require('./lifecycle.cjs');
const {outputDir,snapshot,waitUntil,newWindow,recorder}=require('./harness.cjs');
const raw='\ufeff/* Synthetic CSS license 中文 */\r\n:root { --bg-color:#f7f1e3; --text-color:#4d443a; --primary-color:#306790; }\r\n#write h1 { color:#774422; }\r\n';
const sample=Array.from({length:6},(_,i)=>'#'.repeat(i+1)+' H'+(i+1)+' Heading\n\n').join('')+'Body *italic* **bold** and `code`.\n\n$a+b=c$\n\n~~~txt\ncode sample\n~~~\n\n| A | B |\n| --- | --- |\n| alpha | beta |\n';
async function settings(p,section='theme'){
 await p.locator('[data-mp-id="more"]').click({delay:65});await p.locator('.mp-pop-item').filter({hasText:/^设置启动/}).count().then(async n=>{if(n)await p.locator('.mp-pop-item').filter({hasText:/^设置启动/}).click({delay:65});else await p.getByRole('menuitem',{name:/^设置/}).click({delay:65});});
 await p.locator(`[data-settings-tab="${section}"]`).click({delay:65});
}
async function bg(p){return p.evaluate(()=>getComputedStyle(document.body).backgroundColor);}
(async()=>{
 const o=args(process.argv.slice(2)),dir=outputDir(o.out,'appearance'),release=acquireSlot();let run;
 const result={schema:1,suite:'appearance-workflows',startedAt:new Date().toISOString(),probeSha256:sha256(__filename),cases:[],frames:[],errors:[]};
 const file=path.join(dir,'sample.md'),source=path.join(dir,'主题 import.css'),other=path.join(dir,'other.md');fs.writeFileSync(file,sample);fs.writeFileSync(other,'Other document\n');fs.writeFileSync(source,raw);
 const record=recorder(dir,result),check=async(id,fn)=>{await record(id,fn);if(result.cases.at(-1).status==='fail')throw new Error('Stopped at first failed case: '+id);},capture=async(p,name)=>{const f=path.join(dir,name+'.png');await p.screenshot({path:f});result.frames.push({file:path.basename(f),sha256:sha256(f)});};
 const watch=p=>p.on('pageerror',e=>result.errors.push(e.message));
 let p,q,profile;
 try{
  run=await launch({...o,settings:{restoreLast:false,theme:'light',autosaveEnabled:false},keepProfile:true},file,dir,{MP_TEST_THEME_CSS:source,MP_TEST_THEME_PICK_DELAY_MS:'300'});p=run.page;watch(p);profile=run.profile;result.artifact=run.metadata;
  await check('copy-exact-css-and-apply-before-and-after-reload',async trace=>{
   await settings(p);await p.locator('#mp-theme-install').click({delay:65});await p.locator('[data-settings-tab="fonts"]').click({delay:65});await waitUntil(async()=>await bg(p)==='rgb(247, 241, 227)','imported background');assert.equal(await p.locator('.mp-settings').getAttribute('data-section'),'fonts','late import does not jump sections');await p.locator('[data-settings-tab="theme"]').click({delay:65});
   const native=await p.evaluate(()=>window.mpHost.themeRead());assert(native.ok&&native.theme);const target=path.join(profile,'themes',native.theme.file);assert.deepEqual(fs.readFileSync(target),Buffer.from(raw));assert.equal(native.theme.bytes,Buffer.byteLength(raw));
   trace.push({beforeReload:await bg(p),bytes:native.theme.bytes,sha256:sha256(target),revision:native.revision});await capture(p,'theme-imported');await p.keyboard.press('Escape');
   await p.reload();await p.waitForFunction(()=>!!window.mpExtras?.refreshAppearance);await waitUntil(async()=>await bg(p)==='rgb(247, 241, 227)','reload retains CSS colors');trace.push({afterReload:await bg(p)});assert.equal((await snapshot(p)).text,sample);return{rawCopyExact:true};
  });
  await check('native-light-dark-toggle-and-unknown-palette-keep-imported-css',async()=>{
   await p.locator('[data-mp-id="theme-toggle"]').click({delay:65});await sleep(150);assert.equal(await bg(p),'rgb(247, 241, 227)');await p.locator('[data-mp-id="theme-toggle"]').click({delay:65});await sleep(150);assert.equal(await bg(p),'rgb(247, 241, 227)');
   await p.evaluate(()=>localStorage.setItem('editor-theme','retired-palette'));await p.reload();await p.waitForFunction(()=>!!window.mpExtras?.userThemeInfo);await waitUntil(async()=>await bg(p)==='rgb(247, 241, 227)','unknown palette fallback preserves custom CSS');return{nativeToggles:2};
  });
  await check('valid-last-css-declaration-and-comment-preserve-readable-colors',async trace=>{
   const extraSource=fs.readFileSync(path.resolve(__dirname,'../../dsh-markpilot/src-cm6/extras.js'),'utf8'),extract=extraSource.slice(extraSource.indexOf('  function extractThemeVars('),extraSource.indexOf('  /* 【版式守卫'));
   const fixtures=[
    [':root{--text-color:#4d443a}','--text-color','#4d443a'],
    ['/* --text-color:#fafafa; */ :root{--text-color:#4d443a;}','--text-color','#4d443a'],
    ['@media screen{@supports(display:block){:root{--primary-color:#774422}}}:root{--primary-color:#112233}','--primary-color','#774422'],
    [':root{--text-color:#111;--text-color:#4d443a!important;--text-color:#222}.later{--text-color:#333}','--text-color','#4d443a'],
    [':root{--marker:"x;y{z}";--text-color:#4d443a}','--marker','"x;y{z}"'],
   ];
   for(const [css,key,value]of fixtures){const parsed=await p.evaluate('('+extract+')('+JSON.stringify(css)+')');assert.equal(parsed[key],value);trace.push({realBrowserCssom:true,css,key,actual:parsed[key]});}
   const compact='/* --text-color:#ffffff; */ :root{--bg-color:#f7f1e3;--text-color:#4d443a} #write h1{color:#774422}';
   fs.writeFileSync(source,compact);await settings(p);await p.locator('#mp-theme-install').click({delay:65});await waitUntil(()=>p.evaluate(()=>window.mpExtras.userThemeInfo().bytes===new TextEncoder().encode('/* --text-color:#ffffff; */ :root{--bg-color:#f7f1e3;--text-color:#4d443a} #write h1{color:#774422}').length),'compact theme imported');
   const colors=await p.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,body:getComputedStyle(document.querySelector('.cm-content')).color,panel:getComputedStyle(document.querySelector('.mp-settings')).color}));trace.push(colors);assert.equal(colors.bg,'rgb(247, 241, 227)');assert.equal(colors.body,'rgb(77, 68, 58)');assert.equal(colors.panel,'rgb(77, 68, 58)');await capture(p,'theme-minified');await p.keyboard.press('Escape');fs.writeFileSync(source,raw);return{lastDeclarationRead:true,commentIgnored:true};
  });
  await check('roles-independent-ui-math-and-source-unchanged',async trace=>{
   await settings(p,'fonts');const beforeUI=await p.locator('.mp-settings').evaluate(el=>getComputedStyle(el).fontFamily);
   const roles={body:'Arial',h1:'Georgia',h2:'Verdana',h3:'Consolas',h4:'Arial',h5:'Georgia',h6:'Verdana',italic:'Consolas',bold:'Tahoma',code:'Consolas'};
   for(const[id,value]of Object.entries(roles)){const input=p.locator('#mp-font-'+id);await input.click({delay:60});await p.keyboard.press('Control+a');await p.keyboard.insertText(value);await p.keyboard.press('Tab');trace.push(await p.evaluate(id=>({id,active:document.activeElement.id,value:document.querySelector('#mp-font-'+id).value,toast:document.querySelector('.mp-toast')?.textContent}),id));await waitUntil(()=>p.evaluate(({id,value})=>window.mpExtras.fontPreferences()[id]===value,{id,value}),id+' font committed');}
   assert.equal(await p.locator('.mp-settings').evaluate(el=>getComputedStyle(el).fontFamily),beforeUI,'document font does not change settings font');
   const inputPaint=await p.locator('#mp-font-h1').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,fg:getComputedStyle(el).color}));trace.push({inputPaint});assert.equal(inputPaint.bg,await bg(p),'font input remains readable when a theme supplies only background and foreground');assert.equal(inputPaint.fg,'rgb(77, 68, 58)');
   const styles=await p.evaluate(()=>{const root=document.querySelector('.cm-content');const read=el=>el&&getComputedStyle(el).fontFamily;return{body:read(root),headings:[1,2,3,4,5,6].map(n=>read(document.querySelector('.mp-h'+n))),math:[...document.querySelectorAll('.katex .mord')].map(read).filter(Boolean)};});
   assert(styles.body.includes('Arial'));for(let i=0;i<6;i++)assert(styles.headings[i].includes(roles['h'+(i+1)]),'heading '+(i+1));assert(styles.math.some(f=>f.includes('KaTeX')));trace.push(styles);
   assert.equal((await snapshot(p)).text,sample);assert.equal(fs.readFileSync(file,'utf8'),sample);await capture(p,'font-roles');await p.keyboard.press('Escape');return{roles,unchangedSource:true};
  });
  await check('shared-window-field-merges-and-theme-removal',async trace=>{
   q=await newWindow(run,p,other);watch(q);await waitUntil(()=>q.evaluate(()=>window.mpExtras.fontPreferences().body==='Arial'),'new window font restoration');
   const writes=await Promise.all([p.evaluate(()=>window.mpHost.fontSave({h2:'Tahoma'})),q.evaluate(()=>window.mpHost.fontSave({h3:'Georgia'}))]);assert(writes.every(r=>r.ok));
   await waitUntil(()=>p.evaluate(()=>window.mpExtras.fontPreferences().h2==='Tahoma'&&window.mpExtras.fontPreferences().h3==='Georgia'),'field merges');await waitUntil(async()=>await bg(q)==='rgb(247, 241, 227)','other window custom color');
   await q.evaluate(()=>window.mpExtras.removeTyporaTheme());await waitUntil(()=>p.evaluate(()=>!window.mpExtras.userThemeInfo().name),'removal broadcast');assert.equal((await snapshot(p)).text,sample);assert.equal((await snapshot(q)).text,'Other document\n');trace.push({revisions:writes.map(r=>r.revision)});await q.close();q=null;await p.bringToFront();return{merged:true};
  });
  await check('late-import-completion-cannot-reopen-closed-settings',async()=>{
   fs.writeFileSync(source,raw);await settings(p);const before=await p.evaluate(()=>window.mpHost.themeRead());await p.locator('#mp-theme-install').click({delay:65});await p.keyboard.press('Escape');await waitUntil(async()=>(await p.evaluate(()=>window.mpHost.themeRead())).revision>before.revision,'delayed import committed');assert.equal(await p.locator('.mp-settings').count(),0);assert.equal((await snapshot(p)).text,sample);return{closedRemainsClosed:true};
  });
  await check('font-fixed-css-locks-and-removal-restores-preferences',async()=>{
   fs.writeFileSync(source,raw+'\n@media screen { #write h1 { font:700 30px Georgia; } }\n');await settings(p);await p.locator('#mp-theme-install').click({delay:65});await waitUntil(()=>p.evaluate(()=>window.mpExtras.userThemeInfo().fontsLocked),'theme font lock');
   await p.locator('[data-settings-tab="fonts"]').click({delay:65});assert(await p.locator('#mp-font-body').isDisabled());assert(await p.locator('#mp-font-h6').isDisabled());await capture(p,'font-lock');
   await p.locator('[data-settings-tab="theme"]').click({delay:65});const samePanel=await p.locator('.mp-settings').elementHandle();await p.locator('#mp-theme-remove').click({delay:65});await waitUntil(()=>p.evaluate(()=>!window.mpExtras.userThemeInfo().name),'removed');assert(await samePanel.evaluate(el=>el.isConnected),'removing a theme retains the same settings panel');assert.equal(await p.locator('.mp-settings').getAttribute('data-section'),'theme');await p.locator('[data-settings-tab="fonts"]').click({delay:65});assert(await p.locator('#mp-font-body').isEnabled());assert.equal(await p.locator('#mp-font-body').inputValue(),'Arial');await p.keyboard.press('Escape');return{preferencesPreserved:true,panelRetained:true};
  });
  await check('invalid-css-preserves-active-copy-and-settings-identity',async()=>{
   fs.writeFileSync(source,raw);await settings(p);await p.locator('#mp-theme-install').click({delay:65});await waitUntil(async()=>await bg(p)==='rgb(247, 241, 227)','installed again');
   const before=fs.readFileSync(path.join(profile,'themes','active.json'),'utf8');const identity=await p.locator('.mp-settings').elementHandle();fs.writeFileSync(source,'');await p.locator('#mp-theme-install').click({delay:65});await waitUntil(()=>p.locator('.mp-toast').innerText().then(t=>t.includes('没有可用')),'invalid-theme error');
   assert.equal(fs.readFileSync(path.join(profile,'themes','active.json'),'utf8'),before);assert(await identity.evaluate(el=>el.isConnected));assert.equal(await bg(p),'rgb(247, 241, 227)');await p.keyboard.press('Escape');return{unchangedManifest:true};
  });
  await check('navigation-keyboard-mouse-combinations-and-slider-drag',async trace=>{
   await settings(p,'layout');const slider=p.locator('input[data-p="pageWidth"]');const box=await slider.boundingBox(),before=await slider.inputValue();await p.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await p.mouse.down();for(let i=1;i<=6;i++)await p.mouse.move(box.x+box.width*(.5+i*.05),box.y+box.height*.5);await p.mouse.up();
   const after=await slider.inputValue();assert.notEqual(after,before);await slider.press('ArrowLeft');const value=await slider.inputValue();assert.equal(await p.evaluate(()=>window.mpEngine.prefs().pageWidth),Number(value));
   await p.locator('[data-settings-tab="layout"]').click({delay:65});await p.keyboard.press('ArrowDown');assert.equal(await p.locator('.mp-settings').getAttribute('data-section'),'reading');await p.keyboard.press('ArrowUp');assert.equal(await p.locator('.mp-settings').getAttribute('data-section'),'layout');await capture(p,'settings-layout');await p.keyboard.press('Escape');
   await p.keyboard.press('Control+Home');await p.keyboard.down('Shift');await p.keyboard.press('ArrowRight');await p.keyboard.up('Shift');const s=await snapshot(p);assert(s.selection.anchor!==s.selection.head);assert.equal(s.text,sample);trace.push({before,after,value,selected:s.selection});return{fiveChannels:true};
  });
  await check('theme-style-changes-preserve-undo-redo-and-real-save',async()=>{
   await p.keyboard.press('Control+End');await p.keyboard.insertText('TAIL');const expected=sample+'TAIL';assert.equal((await snapshot(p)).text,expected);
   await p.evaluate(()=>window.mpExtras.setFontPreference({body:'Verdana'}));await p.keyboard.press('Control+z');assert.equal((await snapshot(p)).text,sample);await p.keyboard.press('Control+y');assert.equal((await snapshot(p)).text,expected);await p.keyboard.press('Control+s');await waitUntil(()=>fs.readFileSync(file,'utf8')===expected,'exact saved bytes');return{savedBytes:Buffer.byteLength(expected)};
  });
  await check('delete-original-and-restart-real-process-same-profile',async trace=>{
   fs.unlinkSync(source);trace.push({before:await p.evaluate(()=>window.mpHost.themeRead())});result.firstCleanup=await run.cleanup();assert.deepEqual(result.firstCleanup.residual,[]);run=null;
   run=await launch({...o,profilePath:profile,keepProfile:true},file,dir,{MP_TEST_THEME_CSS:''});p=run.page;watch(p);result.restartedArtifact=run.metadata;await waitUntil(async()=>await bg(p)==='rgb(247, 241, 227)','real process restart after deleting source');assert.equal(await p.evaluate(()=>window.mpExtras.fontPreferences().body),'Verdana');assert.equal((await snapshot(p)).text,sample+'TAIL');return{sameProfile:true,originalAbsent:!fs.existsSync(source)};
  });
  await check('canceled-import-does-not-rebuild-or-change-section',async()=>{
   await settings(p);const el=await p.locator('.mp-settings').elementHandle(),before=await p.evaluate(()=>window.mpHost.themeRead());await p.locator('#mp-theme-install').click({delay:65});await sleep(150);assert(await el.evaluate(el=>el.isConnected));assert.equal(await p.locator('.mp-settings').getAttribute('data-section'),'theme');assert.equal((await p.evaluate(()=>window.mpHost.themeRead())).revision,before.revision);await p.keyboard.press('Escape');return{panelRetained:true};
  });
  await check('corrupt-managed-css-reports-error-without-cache-resurrection',async()=>{
   const t=await p.evaluate(()=>window.mpHost.themeRead()),manifest=fs.readFileSync(path.join(profile,'themes','active.json'));fs.writeFileSync(path.join(profile,'themes',t.theme.file),'corrupt');await p.reload();await p.waitForFunction(()=>!!window.mpExtras?.userThemeInfo);await waitUntil(()=>p.locator('.mp-toast').innerText().then(t=>t.includes('校验失败')),'corrupt-theme message');assert.equal(await p.evaluate(()=>document.documentElement.hasAttribute('data-mp-user-theme')),false);assert.deepEqual(fs.readFileSync(path.join(profile,'themes','active.json')),manifest);return{diskNotOverwritten:true};
  });
 }catch(e){result.fatal=e.stack;}
 finally{if(run){result.cleanup=await run.cleanup();}release();result.passed=result.cases.length===13&&result.cases.every(c=>c.status==='pass')&&!result.errors.length&&!result.fatal;result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,cases:result.cases.map(c=>({id:c.id,status:c.status,error:c.error})),fatal:result.fatal,errors:result.errors,out:dir}));if(!result.passed)process.exitCode=1;}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
