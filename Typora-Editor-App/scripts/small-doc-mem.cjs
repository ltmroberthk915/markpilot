// 小文档内存数据点：load 指定文档 → 统计 DOM 节点与 renderer privateBytes
// 运行：electron.exe scripts/small-doc-mem.cjs <file.md>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
app.setPath('userData', path.join(project, '.perf', 'user-data-smalldoc'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
async function until(code, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return; await sleep(50); }
  throw new Error('Timed out');
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
    res.setHeader('Content-Type', ({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff'})[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  win = new BrowserWindow({ width: 1180, height: 800, show: false, webPreferences: { backgroundThrottling: false, spellcheck: false } });
  win.showInactive();
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready');
  const doc = process.argv[2];
  const source = fs.readFileSync(doc, 'utf8');
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  await sleep(4000);
  const dom = await ev(`({nodes:document.querySelectorAll('*').length, blocks:vditor.vditor.ir.element.childElementCount, formulas:document.querySelectorAll('.katex').length})`);
  const tabs = app.getAppMetrics().filter(p => p.type === 'Tab').map(p => Math.round((p.memory?.privateBytes || 0) / 1024));
  console.log('RESULT', JSON.stringify({ file: path.basename(doc), chars: source.length, ...dom, rendererPzMB: tabs }));
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
