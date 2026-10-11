// 归因确认探针：只做一次真实输入（不开 CV），验证 JSHeapUsedSize 突增来自输入管线垃圾。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
app.setPath('userData', path.join(project, '.perf', 'user-data-cv-gc'));
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
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
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
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  const heap = async () => +(await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.find(x => x.name === 'JSHeapUsedSize').value / 1048576;
  await ev(`(() => {const root=vditor.vditor.ir.element;window.__focusText=()=>{const p=[...root.querySelectorAll('p')].find(p=>p.firstChild?.nodeType===3&&p.firstChild.length>10);root.focus();p.scrollIntoView({block:'center'});getSelection().collapse(p.firstChild,5);};})()`);
  const out = {};
  await ev('gc();gc()'); out.afterFormulas_gc = +(await heap()).toFixed(1);
  await ev('__focusText()');
  await win.webContents.insertText('归');
  await sleep(400);
  out.afterInput_noGC = +(await heap()).toFixed(1);
  await ev('gc();gc()');
  out.afterInput_gc = +(await heap()).toFixed(1);
  out.invariant = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(project, '.perf', 'cv-input-garbage.json'), JSON.stringify(out));
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
