// CV 几何定参探针：
//  A) 四种"每块估算高度"公式的拟合误差（对照 CV 关闭时的真实 total）
//  B) 对跳过子树的 scrollIntoView 落点精度（find/大纲跳转依赖），含"先取消跳过再滚动"的对照
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
app.setPath('userData', path.join(project, '.perf', 'user-data-cv-geometry'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
async function until(code, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return true; await sleep(60); }
  return false;
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
  const source = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  await until(`(() => {const n=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];const q=window.__typoraMathStats;return n.length>1000&&n.every(x=>x.hasAttribute('data-math'))&&!(q&&q.pending)})()`, 240000);

  const report = { fit: [], hit: [] };
  // 采集基准几何（CV 关闭状态）
  const geom = await ev(`(() => {
    const root = vditor.vditor.ir.element;
    root.classList.remove('typora-cv');
    for (const b of root.children) b.style.removeProperty('contain-intrinsic-size');
    const blocks = root.children, n = blocks.length;
    const off = new Array(n), top = new Array(n);
    for (let i=0;i<n;i++){ off[i]=blocks[i].offsetHeight; top[i]=blocks[i].offsetTop; }
    const total = root.scrollHeight;
    let sumOff=0, sumDelta=0;
    for (let i=0;i<n;i++){ sumOff+=off[i]; sumDelta += (i+1<n? top[i+1]-top[i] : total-top[i]); }
    window.__geom = {off, top, total, n};
    return { n, total, sumOff, sumDelta, avgMargin: (total - sumOff)/n };
  })()`);
  report.geom = geom;
  console.log('CV-off geometry:', JSON.stringify(geom));

  // A) 四种公式的拟合
  const formulas = {
    offsetHeight: `g.off[i]`,
    offsetTopDelta: `(i+1<g.n? g.top[i+1]-g.top[i] : g.total-g.top[i])`,
    offsetHeightPlusAvgMargin: `g.off[i] + (g.total - g.sumOff)/g.n`,
    deltaMinusOwnMargins: `(i+1<g.n? g.top[i+1]-g.top[i] : g.total-g.top[i]) - (parseFloat(getComputedStyle(b).marginTop)+parseFloat(getComputedStyle(b).marginBottom))`,
  };
  for (const [name, expr] of Object.entries(formulas)) {
    const measured = await ev(`(() => {
      const root = vditor.vditor.ir.element, g = window.__geom;
      root.classList.remove('typora-cv');
      const blocks = root.children;
      for (let i=0;i<blocks.length;i++){
        const b = blocks[i];
        const v = ${expr};
        if (v > 0) b.style.containIntrinsicSize = 'auto ' + Math.round(v) + 'px';
      }
      root.classList.add('typora-cv');
      const h = root.scrollHeight;
      return h;
    })()`);
    await sleep(300);
    const h2 = await ev('vditor.vditor.ir.element.scrollHeight');
    const row = { formula: name, cvOn: h2, real: geom.total, ratio: +(h2 / geom.total).toFixed(3) };
    console.log('FIT', JSON.stringify(row));
    report.fit.push(row);
  }

  // 用当前产品实现（offsetTop 差值）继续做 B 部分
  await ev(`(() => {
    const root=vditor.vditor.ir.element, g=window.__geom;
    for (let i=0;i<g.n;i++){ const b=root.children[i]; const v=(i+1<g.n? g.top[i+1]-g.top[i] : g.total-g.top[i]); if(v>0) b.style.containIntrinsicSize='auto '+Math.round(v)+'px'; }
    return true;
  })()`);

  // B) scrollIntoView 落点：跳过态 vs 先取消跳过
  for (const target of [2575, 2000, 1200, 600, 1800]) {
    const attempt = async (unskipFirst) => {
      await ev('vditor.vditor.ir.element.scrollTop=0');
      await sleep(300);
      const res = await ev(`(async () => {
        const root=vditor.vditor.ir.element;
        const b=root.children[${target}];
        const want=b.offsetTop;
        if (${unskipFirst}) { b.style.contentVisibility='visible'; await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }
        b.scrollIntoView({block:'center',inline:'nearest'});
        const got=root.scrollTop;
        const max=root.scrollHeight-root.clientHeight;
        if (${unskipFirst}) { b.style.removeProperty('content-visibility'); }
        return {want, got, max, off: Math.round(got-(want-root.clientHeight/2))};
      })()`);
      return res;
    };
    const plain = await attempt(false);
    await sleep(200);
    const unskipped = await attempt(true);
    console.log(`HIT target=${target} plain=`, JSON.stringify(plain), 'unskip=', JSON.stringify(unskipped));
    report.hit.push({ target, plain, unskipped });
  }
  fs.writeFileSync(path.join(project, '.perf', 'cv-geometry.json'), JSON.stringify(report, null, 2));
  console.log('GEOMETRY PROBE COMPLETE');
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
