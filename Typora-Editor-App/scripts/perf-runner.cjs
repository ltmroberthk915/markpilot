// Isolated Electron renderer tests. Never opens or writes the user's documents.
// node_modules/electron/dist/electron.exe scripts/perf-runner.cjs [baseline|optimized|regression]
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const mode = process.argv[2] || 'optimized';
const project = path.resolve(__dirname, '..');
const plugin = path.resolve(project, '../Typora-Editor');
const renderer = mode === 'baseline'
  ? path.join(plugin, 'tools/backups/2026-09-05-performance/render')
  : (['math-colors','math-colors-before','reading'].includes(mode)&&process.argv[3]
    ? path.resolve(process.argv[3]) : path.join(project, 'app/renderer'));
const output = path.resolve(process.env.RELEASE100_OUTPUT || path.join(project, '.perf'));
fs.mkdirSync(output, {recursive: true});
if(process.env.RELEASE100_OUTPUT)require('./test-runtime-health.cjs').install({app,webFrameMain:require('electron').webFrameMain,output});
app.setPath('userData', path.join(output, 'user-data-' + mode));
{
  // 每次运行都从干净的会话开始。2.1.0 起会话里存的是「开着哪些窗口」，上一轮留下的
  // 窗口会被恢复出来，套件于是在上一个测试的残留文档上跑（实测：同一套件连跑两次，
  // 第二次看到的是上一轮的编辑内容，保存断言因此对不上）。
  // 一并清掉套件自己会改的可变项：键盘映射（shell 套件自己就写了注释——一次中途失败
  // 会让下一轮 Ctrl+Shift+E 直接报错）、阅读位置、文件树展开状态。保留真正的偏好
  // （主题、配色、侧边栏宽度、补全设置），它们不该影响断言。
  // 要跨进程验证「会话恢复」的套件用 RELEASE100_KEEP_SESSION=1 显式保留。
  const profile=app.getPath('userData');
  fs.mkdirSync(profile,{recursive:true});
  const stateFile=path.join(profile,'state.json');
  const volatile=['windows','lastFile','lastWs','editorShortcuts','scrollStore','scrollAnchor','expanded','maximized'];
  if(process.env.RELEASE100_KEEP_SESSION==='1'){
    if(!fs.existsSync(stateFile))fs.writeFileSync(stateFile,'{}');
  }else{
    // 写成一个显式的空/精简 profile 也避免了 AppState 的 legacy 迁移链。
    let current={};
    try{current=JSON.parse(fs.readFileSync(stateFile,'utf8'))||{};}catch{current={};}
    for(const key of volatile)delete current[key];
    fs.writeFileSync(stateFile,JSON.stringify(current));
  }
}
app.commandLine.appendSwitch('disable-background-timer-throttling');
// app.exit() 是硬退出，Windows 下异步的 stdout 缓冲会丢掉刚打印的套件结果
// （实测：套件 33 条全绿、.perf/shell.txt 写对了，但重定向到文件的日志是空的）。
// 结果统一走同步写 fd 1，保证退出前已经落盘。
const emit = (...args) => {try{fs.writeSync(1,args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ')+'\n');}catch{/* 无 stdout 时忽略 */}};
// 套件跑一半「静默退出」时，重定向的 stdout 会连同缓冲一起丢，事后无从判断走到哪
// 一步。所以关键节点同时同步追加到 runner-<mode>.log：这个文件一定在磁盘上。
const runnerLog = path.join(output, 'runner-' + mode + '.log');
const trace = (...args) => {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  try { fs.appendFileSync(runnerLog, line + '\n'); } catch { /* ignore */ }
  emit(line);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true).catch(error => {console.error('evaluate:',code.slice(0,140));throw error});
async function until(code, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await ev(code)) return;
    await sleep(50);
  }
  throw new Error('Timed out: ' + code);
}
async function main() {
  await app.whenReady();
  if(mode==='theme-audit'){
    await require('./theme-compatibility-audit.cjs').run({output,renderer});app.exit(0);return;
  }
  if(mode==='math-engines'){
    await require('./math-engine-benchmark.cjs').run({output,renderer});app.exit(0);return;
  }
    if (mode === 'workflow-gaps' || mode === 'shell' || mode === 'completion' || mode === 'protection' || mode === 'export' || mode === 'export-entry' || mode === 'nav-guard' || mode === 'export-large' || mode==='media-office' || mode==='media-repro' || mode==='media-lifecycle' || mode==='table-context-host' || mode==='table-input-host' || mode==='source-toggle-host' || mode==='math-caret-probe' || mode==='math-matrix-probe' || mode==='math-edit-perf' || mode==='math-geometry-probe' || mode==='math-debug-probe' || mode==='math-caret' || mode==='user-file-host' || mode==='residue-app' || mode==='windows' || mode==='windows-scale' || mode==='windows-quit' || mode==='windows-clipboard' || mode==='toolbar-autohide') {
    // Exercise the real main/preload/iframe/save chain with a private profile
    // and a disposable file, also usable against a packaged app.asar.
    const packaged = !!process.argv[3];
    const application = packaged ? path.resolve(process.argv[3]) : project;
    process.argv.splice(2); // Test options are not document paths for main.js.
    const serverModule = require(path.join(application, 'app/main/server.js'));
    const startServer = serverModule.startServer;
    serverModule.startServer = options => startServer({...options, port: 0});
    require(path.join(application,'app/main/main.js'));
    // 窗口/退出时间线：判断「套件静默退出」到底是谁关掉了窗口
    app.on('browser-window-created',(_e,created)=>{
      const id=created.webContents.id;
      trace('[win] created '+id);
      created.on('close',()=>trace('[win] close '+id));
      created.on('closed',()=>trace('[win] closed '+id));
      // 套件驱动的窗口必须始终保持「可见」。多窗口下新建的窗口会盖在它上面，
      // 被遮挡的窗口 document.hidden=true，而**隐藏文档不会派发 dialog 的 close
      // 事件**（实测：新建的 <dialog> showModal() 再 close()，close 事件永不触发，
      // 于是「快捷键设置」弹窗关不掉、断言超时）。这是浏览器既有行为，不是产品缺陷：
      // 真实使用中用户只能操作看到的那扇窗。测试里把驱动窗口抬回前台即可——注意
      // 必须在对方 show() 之后再抬，否则会被对方盖回去。
      if(created!==win)created.once('ready-to-show',()=>{if(win&&!win.isDestroyed()){win.focus();win.moveTop?.();}});
      if(win&&!win.isDestroyed()&&created!==win){win.focus();win.moveTop?.();}
    });
    app.on('before-quit',()=>trace('[app] before-quit'));
    app.on('will-quit',()=>trace('[app] will-quit'));
    app.on('window-all-closed',()=>{trace('[app] window-all-closed');app.quit();});
    for(let i=0;i<200&&!global.win;i++) await sleep(50);
    win=global.win;
    if(!win) throw new Error('Application did not create its window');
    // 套件里的 global.doc / global.win / global.workspace 指的是「我正在驱动的那个
    // 窗口」。多窗口下产品里的这三个是可写的聚焦窗口访问器，无人操作焦点时会随新建
    // 窗口漂移（实测：套件打开第二个文件后 global.doc 指向了新窗口，断言全错位）。
    // 所以测试进程里把它们钉在套件驱动的窗口上——产品代码不依赖它们，主进程所有跨
    // 窗口逻辑都按 event.sender 找窗口，所以这只影响测试的观察点。
    const recOfWin = target => (global.windows || []).find(rec => rec.win === target) || null;
    Object.defineProperty(global,'win',{configurable:true,get:()=>win});
    Object.defineProperty(global,'doc',{configurable:true,get:()=>recOfWin(win)?.doc || null});
    Object.defineProperty(global,'workspace',{configurable:true,get:()=>recOfWin(win)?.workspace || null});
    // 没有人给窗口焦点时 BrowserWindow.getFocusedWindow() 恒为 null，产品里「作用于
    // 当前文档」的菜单项与 send() 于是会漂到最后一个新建的窗口上（实测：套件点菜单
    // 「快捷键设置…」，推送发给了新窗口，被驱动的窗口一直等不到弹窗）。测试进程里把
    // 焦点查询固定成套件驱动的那个窗口；真实使用中焦点来自用户点击，不受影响。
    const {BrowserWindow: BW} = require('electron');
    BW.getFocusedWindow = () => win;
    await until('!!window.hostApi && document.readyState === "complete"');
    await ev("hostApi.invoke('boot')");
    if(mode==='workflow-gaps'){
      try{emit((await require('./release100-workflow-gaps.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='media-office'){
      try{emit((await require('./desktop-media-office.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='residue-app'){
      try{emit(JSON.stringify((await require('./desktop-residue.cjs').run({win,ev,until,output})),null,1));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='media-repro'){
      try{emit((await require('./desktop-media-repro.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='media-lifecycle'){
      try{emit((await require('./desktop-media-lifecycle.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='table-context-host'){
      try{emit((await require('./desktop-table-context.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='table-input-host'){
      try{emit((await require('./desktop-table-input.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='math-caret'){
      try{emit((await require('./desktop-math-caret.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='math-debug-probe'){
      try{emit((await require('./math-debug-probe.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='math-geometry-probe'){
      try{emit((await require('./math-geometry-probe.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='math-matrix-probe'){
      try{emit((await require('./math-matrix-probe.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='math-caret-probe'){
      try{emit((await require('./math-caret-probe.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='math-edit-perf'){
      try{emit((await require('./math-edit-perf-probe.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='source-toggle-host'){
      try{emit((await require('./desktop-source-toggle.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='user-file-host'){
      try{emit((await require('./desktop-user-file.cjs').run({win,until,output})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='export-large'){
      emit((await require('./desktop-export-large.cjs').run({win,ev,until,output,application})).join('\n'));
      win.destroy();app.exit(0);return;
    }
    if(mode==='export'){
      emit((await require('./desktop-export.cjs').run({win,ev,until,output,application})).join('\n'));
      win.destroy();app.exit(0);return;
    }
    if(mode==='nav-guard'){
      emit((await require('./desktop-nav-guard.cjs').run({win,ev,until,output,application})).join('\n'));
      win.destroy();app.exit(0);return;
    }
    if(mode==='export-entry'){
      emit((await require('./desktop-export-entry.cjs').run({win,ev,until,output,application})).join('\n'));
      win.destroy();app.exit(0);return;
    }
    if(mode==='protection'){
      emit((await require('./desktop-protection.cjs').run({win,ev,until,output,application})).join('\n'));
      win.destroy();app.exit(0);return;
    }
    if(mode==='toolbar-autohide'){
      try{emit((await require('./desktop-toolbar-autohide.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='windows'){
      // 多窗口契约套件：结尾会触发一次真实退出（验证「全部确认后正常退出」），
      // 那条路径下进程直接消失、下面的收尾代码不会执行——这是设计如此。
      try{emit((await require('./desktop-windows.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='windows-scale'){
      try{emit((await require('./windows-scale.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='windows-clipboard'){
      // 跨窗口剪贴板压力套件：两扇真实窗口之间复制/剪切/粘贴图片、表格与复杂表格。
      try{emit((await require('./windows-clipboard.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='windows-quit'){
      // 成功判据是「进程自己退出」：套件一旦返回，就说明「全部确认后退出」没生效。
      try{emit((await require('./windows-quit.cjs').run({win,ev,until,output,application})).join('\n'));}
      catch(error){console.error(error);process.exitCode=1;}
      finally{if(!win.isDestroyed())win.destroy();app.exit(process.exitCode||0);}
      return;
    }
    if(mode==='completion') {
      emit((await require('./desktop-completion.cjs').run({win,ev,until,output,application})).join('\n'));
      win.destroy();app.exit(0);return;
    }
    const file=path.join(output,'shell-document.md');
    fs.writeFileSync(file,'# Shell test\n\nbody $x+1$\n\n$$\na^2+b^2\n$$\n');
    await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
    const iframe='document.getElementById("editor").contentWindow';
    await until(`!!${iframe}?.vditor?.vditor?.__typoraPatched`);
    await sleep(500);
    const read=()=>ev(`${iframe}.vditor.getValue()`);
    const results=[];
    const assert=(condition,message)=>{if(!condition)throw new Error(message);results.push('PASS '+message)};
    for(const editMode of ['ir','wysiwyg','sv','ir']) {
      await ev(`(() => {const w=${iframe};w.vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="${editMode}"]').click()})()`);
      await sleep(300);
      await ev(`(() => {const w=${iframe},e=w.vditor.vditor,root=e[e.currentMode].element;w.focus();root.focus();const walker=w.document.createTreeWalker(root,4);let text;while((text=walker.nextNode()))if(text.length>3&&!text.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'))break;if(!text)throw new Error('No source text');w.getSelection().collapse(text,text.length)})()`);
      const marker='保存'+editMode+'🙂';
      await win.webContents.insertText(marker);
      await until(`${iframe}.vditor.getValue().includes(${JSON.stringify(marker)})`);
      await sleep(400);
      assert(global.doc.dirty && global.doc.current.text.includes(marker),'host receives actual input in '+editMode);
      await ev(`hostApi.invoke('save',{})`);
      const expected=await read();
      assert(fs.readFileSync(file,'utf8')===expected && expected.includes(marker) && expected.includes('$x+1$'),'real edit/save in '+editMode);
    }
    const external='# External update\n\nnew $\\Omega$\n';
    fs.writeFileSync(file,external);
    await until(`${iframe}.vditor.getValue()===${JSON.stringify(external)}`);
    assert(await read()===external,'external reload keeps cache fresh');
    // 每个子套件跑完立刻打印：某个 until 超时时，已经通过的断言不会跟着一起丢
    // （只抛异常的话只剩一行错误，得反复重跑才能知道走到哪一条）。
    const step=async(label,fn)=>{
      try{const part=await fn();results.push(...part);emit(part.join('\n'));}
      catch(error){emit(results.join('\n'));emit('FAILED in '+label+': '+error.message);throw error;}
    };
    await step('features',()=>require('./shell-features.cjs').runShellFeatures({win,ev,until,output}));
    await step('repairs',()=>require('./shell-repairs.cjs').runShellRepairs({win,ev,until,output}));
    await step('math',()=>require('./shell-math.cjs').runShellMath({win,ev,until,output}));
    // 内联那几条（4 个编辑模式 + 外部刷新）也要进日志，否则只存在于汇总文件里
    emit(results.join('\n'));
    fs.writeFileSync(path.join(output,packaged?'packaged-shell.txt':'shell.txt'),results.join('\n'));
    win.destroy();app.exit(0);return;
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8').replace('{{baseUrl}}', '/render');
      // Windowed math rendering defers off-screen formulas, so a suite that counts how many of
      // the textbook's formulas rendered asks for a fully rendered surface. The boundary suite
      // validates the KaTeX engine over the whole document (`rendered === 2844`, no error
      // tails); every other suite runs the shipped default and therefore covers the windowed
      // path as well. Override either way with MATH_WINDOW=on|off.
      const mathWindow = process.env.MATH_WINDOW || (mode === 'math-boundaries' ? 'off' : 'on');
      const shim = `<script>
        window.__changes = []; window.__ready = false;
        localStorage.setItem('dark', 'false'); localStorage.setItem('edit-mode', 'ir'); localStorage.setItem('outline', 'false');
        localStorage.setItem('mathWindow', '${mathWindow}');
        const subscribers = {};
        window.handler = {on(e, f) {subscribers[e] = f; return this}, emit(e, d) {
          if (e === 'change') {window.__lastChange = d; window.__changes.push(performance.now())}
          if (e === 'init') window.__ready = true;
        }};
        window.__open = content => subscribers.open({title:'fixture.md', content, language:'zh-cn', scrollTop:0, rootPath:'/render'});
      </script>`;
      html = html.replace('</head>', shim + '</head>');
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(html); return;
    }
    let file;
    if (mode === 'mermaid' && process.argv[3] && url.pathname.endsWith('/js/mermaid/mermaid.min.js')) file = path.resolve(process.argv[3]);
    else if (url.pathname.startsWith('/render/')) file = path.join(renderer, decodeURIComponent(url.pathname.slice(8)));
    else if (url.pathname === '/regression.js') file = path.join(plugin, 'test/regression.js');
    else if (url.pathname === '/consistency.js') file = path.join(project, 'scripts/renderer-consistency.js');
    else if (url.pathname === '/features.js') file = path.join(project, 'scripts/renderer-features.js');
    else if (url.pathname === '/repairs.js') file = path.join(project, 'scripts/renderer-repairs.js');
    else if (url.pathname === '/table-context.js') file = path.join(project, 'scripts/renderer-table-context.js');
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404); res.end(); return;}
    const ext = path.extname(file);
    res.setHeader('Content-Type', ({'.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.woff':'font/woff'})[ext] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({width:1180, height:800, show:false, webPreferences:{backgroundThrottling:false, spellcheck:false}});
  win.showInactive();
  const errors = [];
  win.webContents.on('console-message', event => {if (event.level === 'error') {errors.push(event.message);console.error(event.message, event.sourceId, event.lineNumber)}});
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready');
  if (mode === 'mermaid') {
    emit((await require('./mermaid-regression.cjs').run({win,ev,until,output})).join('\n'));
  } else if (mode === 'math-colors' || mode === 'math-colors-before') {
    emit((await require('./math-colors.cjs').run({win,ev,until,output,baseline:mode.endsWith('-before')})).join('\n'));
  } else if (mode === 'math-history') {
    emit((await require('./math-history.cjs').runMathHistory({win,ev,until,output})).join('\n'));
  } else if (mode === 'math-boundaries') {
    emit((await require('./math-boundaries.cjs').runMathBoundaries({win,ev,until,output})).join('\n'));
  } else if (mode === 'reading') {
    emit((await require('./reading-experience.cjs').run({win,ev,until,output})).join('\n'));
  } else if (mode === 'typography') {
    emit((await require('./typography-visual.cjs').run({win,ev,until,output})).join('\n'));
  } else if (mode === 'repaint') {
    emit(JSON.stringify((await require('./repaint-residue.cjs').run({win,ev,until,output})),null,1));
  } else if (mode === 'source-history') {
    emit((await require('./source-history.cjs').run({win,ev,until,output})).join('\n'));
  } else if (mode === 'ui') {
    const results=await require('./ui-refinements.cjs').runUI({win,ev,until,output});
    emit(results.join('\n'));fs.writeFileSync(path.join(output,'ui.json'),JSON.stringify(results,null,2));
  } else if (mode === 'repairs') {
    await ev(`__open(${JSON.stringify('# Repairs\n\n**加粗 bold** 普通 text $x+1$\n\nnext $y+2$\n')})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    const results = await ev(`import('/repairs.js').then(module=>module.runRepairs())`);
    for(const theme of ['konayuki-light','konayuki-dark']){
      await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,${JSON.stringify(theme)}))`);
      await sleep(350);
      fs.writeFileSync(path.join(output,theme+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    emit(JSON.stringify(results,null,2));
    fs.writeFileSync(path.join(output, 'repairs.json'), JSON.stringify(results,null,2));
  } else if (mode === 'history-large') {
    const source='**撤销测试 bold**\n\n'+fs.readFileSync(path.join(project,'.testws/教材合订本.md'),'utf8');
    await ev(`__open(${JSON.stringify(source)})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    await until('window.__typoraMathStats.pending===0',180000);
    await sleep(1200);
    await until('window.__typoraMathStats.pending===0',180000);
    await ev(`(() => {const e=vditor.vditor,root=e.ir.element;root.focus();const t=root.querySelector('strong').firstChild;const r=document.createRange();r.selectNodeContents(t);getSelection().removeAllRanges();getSelection().addRange(r);vditor.clearStack();window.__historyBefore=vditor.getValue();window.__cachedMath=[...root.querySelectorAll('.language-math[data-math]')];})()`);
    for(const key of ['B','Z']){
      if(key==='Z')await ev(`window.__missingMath=[...document.querySelectorAll('.language-math:not([data-math])')].map(n=>({html:n.outerHTML.slice(0,300),parent:n.parentElement.outerHTML.slice(0,300)}));window.__renderedBeforeUndo=__typoraMathStats.rendered;window.__cachedMath=[...vditor.vditor.ir.element.querySelectorAll('.language-math[data-math]')];window.__undoStarted=performance.now()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:['control']});
      if(key==='Z')await ev(`window.__undoReport={ms:performance.now()-__undoStarted,formulas:__cachedMath.length,retained:__cachedMath.filter(n=>n.isConnected).length,reuse:vditor.vditor.__typoraRenderReuse,sourceEqual:vditor.getValue()===__historyBefore}`);
      await sleep(500);
    }
    const report=await ev(`({...__undoReport,rerendered:__typoraMathStats.rendered-__renderedBeforeUndo,pending:__typoraMathStats.pending})`);
    fs.writeFileSync(path.join(output,'history-large-debug.json'),JSON.stringify({report,missing:await ev('__missingMath')},null,2));
    if(!report.sourceEqual||report.formulas!==report.retained||report.rerendered)throw new Error(JSON.stringify(report));
    await ev(`vditor.__typoraFind.open(true);document.querySelector('#typora-find [data-field=query]').value='函数';vditor.__typoraFind.search();true`);
    await until('!vditor.__typoraFind.state.pending');
    report.search=await ev(`({matches:vditor.__typoraFind.state.count,workerMs:vditor.vditor.__typoraSearchMs})`);
    fs.writeFileSync(path.join(output,'history-large.json'),JSON.stringify(report,null,2));emit(JSON.stringify(report,null,2));
  } else if (mode === 'table-context') {
    await ev(`__open(${JSON.stringify('# Table context\n\nready\n')})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    const results = await ev(`import('/table-context.js').then(module=>module.runTableContext()).catch(error=>{throw new Error(error?.stack||String(error))})`);
    emit(results.join('\n'));fs.writeFileSync(path.join(output,'table-context.txt'),results.join('\n'));
  } else if (mode === 'features') {
    await ev(`__open(${JSON.stringify('# Features\n\n正文 alpha beta\n')})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    const results = await ev(`import('/features.js').then(module=>module.runFeatures())`);
    emit(results.join('\n'));
    fs.writeFileSync(path.join(output, 'features.txt'), results.join('\n'));
  } else if (mode === 'regression') {
    await ev(`__open(${JSON.stringify('# 标题\n\n正文 $x+1$\n')})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    await ev(`import('/regression.js').then(() => true)`);
    await ev(`document.getElementById('run-regression').click()`);
    // The handler is async; invoke directly to await its full test suite.
    await sleep(300);
    await until(`document.getElementById('regression-results').textContent.includes('Incomplete math maps')`);
    const result = await ev(`document.getElementById('regression-results').textContent`);
    emit(result);
    fs.writeFileSync(path.join(output, 'regression.txt'), result);
    if (result.includes('FAIL')) throw new Error('Regression failures');
  } else if (mode === 'consistency') {
    await ev(`__open(${JSON.stringify('# Consistency\n\ntext $x$\n')})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    const results = await ev(`import('/consistency.js').then(module=>module.runConsistency())`);
    await ev(`vditor.setValue('alpha $x+1$\\n',true); true`);
    await sleep(300);
    await ev(`(() => {const root=vditor.vditor.ir.element;root.focus();getSelection().collapse(root.querySelector('p').firstChild,2);window.__imeBefore=vditor.getValue()})()`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});
    await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'中文'});
    await sleep(300);
    const ime = await ev(`(() => {const e=vditor.vditor, md=vditor.getValue();if(md!==e.lute.VditorIRDOM2Md(e.ir.element.innerHTML)||!md.includes('al中文pha'))throw new Error('IME commit mismatch: '+md);e.undo.undo(e);if(vditor.getValue()!==__imeBefore)throw new Error('IME undo mismatch');e.undo.redo(e);if(vditor.getValue()!==md)throw new Error('IME redo mismatch');return true})()`);
    if (ime) results.push('PASS native Chinese IME composition, commit, undo and redo');
    win.webContents.debugger.detach();
    emit(results.join('\n'));
    fs.writeFileSync(path.join(output, 'consistency.txt'),results.join('\n'));
  } else if (mode === 'probe') {
    await ev(`__open(${JSON.stringify('# Probe\n\ntext $x$\n')})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    const results = await ev(`(() => {
      const l=vditor.vditor.lute;
      return ['a\\n\\nb\\n','a\\n\\n\\n\\nb\\n','- a\\n- b\\n\\ntext\\n','> a\\n>\\n> b\\n\\ntext\\n','text[^x]\\n\\n[^x]: footnote\\n','[link][id]\\n\\n[id]: https://example.org\\n','[toc]\\n\\n# Title\\n','---\\na: b\\n---\\n\\ntext\\n','a\\n\\n---\\n\\nb\\n'].map(md=>{
        const h=l.Md2VditorIRDOM(md), t=document.createElement('template');t.innerHTML=h;
        return {input:md, full:l.VditorIRDOM2Md(h), parts:[...t.content.childNodes].map(n=>({tag:n.nodeName,html:n.outerHTML||n.textContent,md:l.VditorIRDOM2Md(n.outerHTML||n.textContent)}))};
      });
    })()`);
    const textbook = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
    const large = await ev(`(() => {
      const l=vditor.vditor.lute, h=l.Md2VditorIRDOM(${JSON.stringify(textbook)}), t=document.createElement('template');t.innerHTML=h;
      const full=l.VditorIRDOM2Md(h), parts=[...t.content.children].map(n=>l.VditorIRDOM2Md(n.outerHTML));
      const joined=parts.filter(Boolean).join('\\n'); let first=0;while(first<full.length && full[first]===joined[first])first++;
      return {equal:full===joined,fullLength:full.length,joinedLength:joined.length,first,full:full.slice(first-80,first+180),joined:joined.slice(first-80,first+180),types:[...new Set([...t.content.children].map(n=>n.tagName+':'+n.getAttribute('data-type')))]};
    })()`);
    fs.writeFileSync(path.join(output, 'probe.json'), JSON.stringify({results,large},null,2));
    emit(JSON.stringify(large,null,2));
  } else {
    const source = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
    const start = Date.now();
    await ev(`__open(${JSON.stringify(source)})`);
    await until('window.vditor?.vditor?.__typoraPatched');
    const report = {mode, versions:process.versions, readyMs:Date.now()-start, samples:[]};
    emit('ready', report.readyMs);
    // Observe actual input dispatch and paint; inspecting the whole body's
    // innerText would itself force layout and contaminate the measurement.
    await ev(`(() => {
      const e=vditor.vditor, root=e.ir.element;
      window.__calls=[];
      for (const key of ['SpinVditorIRDOM','VditorIRDOM2Md']) {
        const original=e.lute[key]; e.lute[key]=function(html,...args) {
          const t=performance.now(); const value=original.call(this,html,...args);
          __calls.push({key,chars:html.length,ms:performance.now()-t});return value;
        };
      }
      window.__inputResult=null;
      root.addEventListener('beforeinput', () => {
        const t=performance.now(); window.__inputResult=null;
        requestAnimationFrame(() => { window.__inputResult={paintMs:performance.now()-t}; });
      },true);
      window.__focusText=() => {
        const p=[...root.querySelectorAll('p')].find(p=>p.firstChild?.nodeType===3 && p.firstChild.length>10);
        root.focus(); p.scrollIntoView({block:'center'}); getSelection().collapse(p.firstChild,5);
      };
      __focusText();
    })()`);
    for (let i=0;i<4;i++) {
      if(i===1) await sleep(1500);
      if(i===2) await sleep(7000);
      if(i===3) await sleep(1000);
      await ev('__focusText(); __calls=[]; __inputResult=null');
      const wall=Date.now();
      await win.webContents.insertText('测'+i);
      await until('window.__inputResult');
      const result=await ev('({...__inputResult, calls:__calls})');
      result.wallMs=Date.now()-wall;
      await sleep(350);
      result.withHistory=await ev('__calls');
      report.samples.push(result); emit('input',i,JSON.stringify(result));
    }
    report.dom=await ev(`({nodes:document.querySelectorAll('*').length, formulas:document.querySelectorAll('.katex').length, scripts:document.scripts.length, blocks:vditor.vditor.ir.element.childElementCount})`);
    emit('waiting for complete formula rendering');
    const completeDeadline=Date.now()+240000;
    let progress;
    do {
      progress=await ev(`(() => {const nodes=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];return {total:nodes.length,missing:nodes.filter(node=>!node.hasAttribute('data-math')).length,hidden:document.hidden,queue:window.__typoraMathStats}})()`);
      emit('formula progress',JSON.stringify(progress));
      if(progress.total>1000 && !progress.missing && (!progress.queue||!progress.queue.pending))break;
      await sleep(10000);
    } while(Date.now()<completeDeadline);
    if(progress.missing || progress.queue?.pending) throw new Error('Formula queue did not finish: '+JSON.stringify(progress));
    report.completeMs=Date.now()-start;
    report.completeDOM=await ev(`({nodes:document.querySelectorAll('*').length,formulas:document.querySelectorAll('.katex').length,math:window.__typoraMathStats,sourceCache:vditor.vditor.__typoraPerformance?.stats})`);
    await ev('__focusText(); __calls=[]; __inputResult=null');
    const lastInput=Date.now();
    await win.webContents.insertText('稳态');
    await until('window.__inputResult');
    report.steadyInput=await ev('({...__inputResult,calls:__calls})');
    report.steadyInput.wallMs=Date.now()-lastInput;
    await sleep(400);
    report.steadyInput.withHistory=await ev('__calls');
    report.savedMarkdownMatches=await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
    if(!report.savedMarkdownMatches) throw new Error('Large document Markdown mismatch');
    report.formulaClicks=[];
    for(const fraction of [0.5,0.75,0.95]) {
      await ev(`(() => {const root=vditor.vditor.ir.element;root.scrollTop=(root.scrollHeight-root.clientHeight)*${fraction};getSelection().removeAllRanges()})()`);
      await sleep(350);
      const target=await ev(`(() => {
        const root=vditor.vditor.ir.element;
        const node=[...root.querySelectorAll('.vditor-ir__preview .katex')].find(node=>{const r=node.getBoundingClientRect();return r.top>80&&r.bottom<innerHeight-60&&r.width>20});
        if(!node)throw new Error('No visible formula');
        const preview=node.closest('.vditor-ir__preview'),code=preview.previousElementSibling;
        window.__formulaResult=null;
        root.addEventListener('mousedown',()=>{const t=performance.now();requestAnimationFrame(()=>{
          const source=code.matches('code')?code:code.querySelector('code');
          __formulaResult={ms:performance.now()-t,caretInSource:!!source?.contains(getSelection().focusNode),sourceVisible:source?.getBoundingClientRect().height>0};
        })},{once:true,capture:true});
        const r=node.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      })()`);
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...target});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...target});
      await until('window.__formulaResult');
      const clicked=await ev('window.__formulaResult');
      report.formulaClicks.push({fraction,...clicked});
      if(!clicked.caretInSource||!clicked.sourceVisible) throw new Error('Formula click did not enter editable source');
    }
    await ev(`(() => {vditor.vditor.ir.element.scrollTop=0;window.__frames=[];window.__scrollDone=false;let start;const frame=t=>{start??=t;__frames.push(t);if(t-start<2000)requestAnimationFrame(frame);else __scrollDone=true};requestAnimationFrame(frame)})()`);
    for(let i=0;i<100;i++) {
      win.webContents.sendInputEvent({type:'mouseWheel',x:550,y:400,deltaX:0,deltaY:130,canScroll:true});
      await sleep(20);
    }
    await until('window.__scrollDone');
    report.scroll=await ev(`(() => {const intervals=__frames.slice(1).map((t,i)=>t-__frames[i]).sort((a,b)=>a-b);return {fps:(__frames.length-1)*1000/(__frames.at(-1)-__frames[0]),p95FrameMs:intervals[Math.floor(intervals.length*.95)]}})()`);
    await sleep(500);
    report.idleStart=app.getAppMetrics().filter(p=>p.type==='Tab').map(p=>({pid:p.pid,cpu:p.cpu}));
    await sleep(1500);
    report.idleEnd=app.getAppMetrics().filter(p=>p.type==='Tab').map(p=>({pid:p.pid,cpu:p.cpu}));
    report.scriptRequests=await ev(`performance.getEntriesByType('resource').filter(r=>/katex.min.js|mhchem.min.js/.test(r.name)).map(r=>r.name)`);
    report.errors=errors;
    fs.writeFileSync(path.join(output, mode+'.json'), JSON.stringify(report,null,2));
    emit('DOM',JSON.stringify(report.dom));
  }
  win.destroy(); server.close(); app.exit(0);
}
main().catch(error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1)});
