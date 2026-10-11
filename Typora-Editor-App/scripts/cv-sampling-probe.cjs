// 输入垃圾采样探针：CDP HeapProfiler 采样分配，聚合出单次输入的分配热点栈。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
app.setPath('userData', path.join(project, '.perf', 'user-data-cv-samp'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
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
  await ev(`(() => { const root=vditor.vditor.ir.element; window.__focusText=()=>{const p=[...root.querySelectorAll('p')].find(p=>p.firstChild?.nodeType===3&&p.firstChild.length>10);root.focus();p.scrollIntoView({block:'center'});getSelection().collapse(p.firstChild,5);}; })()`);
  // 预热一轮输入（消除首输入特有效应）
  await ev('__focusText()');
  await win.webContents.insertText('预');
  await sleep(900);

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('HeapProfiler.enable');
  await dbg.sendCommand('HeapProfiler.startSampling', { samplingInterval: 32768 });
  await ev('__focusText()');
  await win.webContents.insertText('样');
  await sleep(900);
  const { profile } = await dbg.sendCommand('HeapProfiler.stopSampling');
  // SamplingHeapProfile 是树：head.children 递归，节点自带 selfSize（已聚合）
  const keyOf = cf => (cf.functionName || '(anonymous)') + ' @ ' + (cf.url || '').split('/').slice(-1)[0] + ':' + cf.lineNumber;
  const selfBytes = new Map();
  const paths = new Map(); // key -> 代表性完整调用链
  let totalSampled = 0;
  const walk = (node, chain) => {
    const key = keyOf(node.callFrame);
    selfBytes.set(key, (selfBytes.get(key) || 0) + (node.selfSize || 0));
    totalSampled += node.selfSize || 0;
    if (!paths.has(key) && (node.selfSize || 0) > 512 * 1024) paths.set(key, [...chain, key]);
    for (const child of node.children || []) walk(child, [...chain, key]);
  };
  walk(profile.head, []);
  const top = [...selfBytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([k, v]) => ({ site: k, MB: +(v / 1048576).toFixed(2) }));
  console.log('total sampled allocation:', +(totalSampled / 1048576).toFixed(1), 'MB');
  console.log(JSON.stringify(top, null, 1));
  const stacks = top.slice(0, 4).filter(t => paths.get(t.site)).map(t => ({ site: t.site, MB: t.MB, chain: paths.get(t.site).slice(-10) }));
  fs.writeFileSync(path.join(project, '.perf', 'cv-sampling-probe.json'), JSON.stringify({ totalMB: +(totalSampled / 1048576).toFixed(1), top, stacks }, null, 2));
  console.log('SAMPLING PROBE COMPLETE');
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
