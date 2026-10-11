// 输入垃圾归因探针：捕获每次 innerHTML 读写的调用栈与体积、snapshot/getMarkdown 调用，
// 定位单次输入 ~40MB 分配的确切来源。零源码改动，运行时插桩。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
app.setPath('userData', path.join(project, '.perf', 'user-data-cv-alloc'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
async function until(code, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return; await sleep(50); }
  throw new Error('Timed out: ' + code);
}
async function main() {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8').replace('{{baseUrl}}', '/render');
      const shim = `<script>window.__ready=false;localStorage.setItem('dark','false');localStorage.setItem('edit-mode','ir');localStorage.setItem('outline','false');const sub={};window.handler={on(e,f){sub[e]=f;return this},emit(e,d){if(e==='init')window.__ready=true;}};window.__open=c=>sub.open({title:'fixture.md',content:c,language:'zh-cn',scrollTop:0,rootPath:'/render'});</script>`;
      html = html.replace('</head>', shim + '</head>');
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(html); return;
    }
    let file = null;
    if (url.pathname.startsWith('/render/')) file = path.join(renderer, decodeURIComponent(url.pathname.slice(8)));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    res.setHeader('Content-Type', ({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff'})[ext] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  win = new BrowserWindow({ width: 1180, height: 800, show: false, webPreferences: { backgroundThrottling: false, spellcheck: false } });
  win.showInactive();
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready');
  const source = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  let p; const t0 = Date.now();
  do {
    p = await ev(`(() => {const n=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];return {m:n.filter(x=>!x.hasAttribute('data-math')).length,q:window.__typoraMathStats?.pending||0,t:n.length}})()`);
    if (p.t > 1000 && !p.m && !p.q) break;
    await sleep(5000);
  } while (Date.now() < t0 + 240000);
  console.log('formulas done', Date.now() - t0);

  // 插桩：innerHTML 读写计数+调用栈去重；snapshot/getMarkdown 包装
  await ev(`(() => {
    const root = vditor.vditor.ir.element;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    window.__ih = {gets:0, sets:0, chars:0, stacks:{}};
    Object.defineProperty(root, 'innerHTML', {
      configurable: true,
      get() { window.__ih.gets++; const stack = (new Error().stack||'').split('\\n').slice(2,7).join(' | '); window.__ih.stacks['GET '+stack] = (window.__ih.stacks['GET '+stack]||0)+1; const v = desc.get.call(this); window.__ih.chars += v.length; return v; },
      set(v) { window.__ih.sets++; const stack = (new Error().stack||'').split('\\n').slice(2,7).join(' | '); window.__ih.stacks['SET '+stack] = (window.__ih.stacks['SET '+stack]||0)+1; return desc.set.call(this, v); },
    });
    const perf = vditor.vditor.__typoraPerformance;
    window.__perfCalls = {snapshot:0, snapshotChars:0, getMarkdown:0, getMarkdownChars:0, getValue:0};
    const snap = perf.snapshot.bind(perf);
    perf.snapshot = (...a) => { const r = snap(...a); window.__perfCalls.snapshot++; window.__perfCalls.snapshotChars += r.length; return r; };
    const gm = perf.getMarkdown.bind(perf);
    perf.getMarkdown = (...a) => { const r = gm(...a); window.__perfCalls.getMarkdown++; window.__perfCalls.getMarkdownChars += r.length; return r; };
    window.__vditorGetValue = vditor.getValue.bind(vditor);
    vditor.getValue = (...a) => { window.__perfCalls.getValue++; return window.__vditorGetValue(...a); };
    window.__focusText = () => { const p=[...root.querySelectorAll('p')].find(p=>p.firstChild?.nodeType===3&&p.firstChild.length>10); root.focus(); p.scrollIntoView({block:'center'}); getSelection().collapse(p.firstChild,5); };
    window.__resetCounters = () => { window.__ih.gets=0; window.__ih.sets=0; window.__ih.chars=0; window.__ih.stacks={}; window.__perfCalls.snapshot=0; window.__perfCalls.snapshotChars=0; window.__perfCalls.getMarkdown=0; window.__perfCalls.getMarkdownChars=0; window.__perfCalls.getValue=0; };
    window.__sizes = {};
  })()`);

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  const heap = async () => +((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.find(x => x.name === 'JSHeapUsedSize').value / 1048576).toFixed(1);

  const report = { inputs: [], errors: [] };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });

  for (const label of ['甲', '乙', '丙']) {
    await ev('gc();gc()');
    const before = await heap();
    await ev('__resetCounters()');
    await ev('__focusText()');
    await win.webContents.insertText(label);
    await sleep(800); // 覆盖 200ms undoDelay 分组
    const afterNoGC = await heap();
    const counters = await ev('({ih:{...__ih.stacks?{gets:__ih.gets,sets:__ih.sets,chars:__ih.chars}:{}}, stacks:__ih.stacks, perf:{...__perfCalls}})');
    await ev('gc();gc()');
    const afterGC = await heap();
    const input = { label, heapBefore: before, heapAfterNoGC: afterNoGC, heapAfterGC: afterGC, ...counters };
    console.log(JSON.stringify(input, null, 1));
    report.inputs.push(input);
  }
  // 基线尺寸（不计入输入统计）
  report.sizes = await ev(`({inner: __ih.chars = 0, live: document.getElementById ? (()=>{const d=vditor.vditor.ir.element; return 0})() : 0})`);
  report.sizes = await ev(`(() => { window.__resetCounters(); const live = vditor.vditor.ir.element.innerHTML.length; const snapLen = vditor.vditor.__typoraPerformance.snapshot().length; const mdLen = vditor.vditor.__typoraPerformance.getMarkdown().length; return {liveInnerHTML: live, snapshotHtml: snapLen, markdown: mdLen}; })()`);
  console.log('sizes', JSON.stringify(report.sizes));
  report.invariant = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
  console.log('invariant', report.invariant);
  fs.writeFileSync(path.join(project, '.perf', 'cv-alloc-probe.json'), JSON.stringify(report, null, 2));
  console.log('ALLOC PROBE COMPLETE');
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
