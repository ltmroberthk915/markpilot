// content-visibility 离屏渲染探针（Guanmo 虚拟化思路的可插拔验证）。
// 零源码改动：运行时注入/移除 CSS，交错 A/B/A/B 抵抗时间漂移。
// 运行：node_modules/electron/dist/electron.exe scripts/cv-probe.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
const output = path.join(project, '.perf');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'user-data-cv-probe'));
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
      const shim = `<script>
        window.__ready = false;
        localStorage.setItem('dark','false'); localStorage.setItem('edit-mode','ir'); localStorage.setItem('outline','false');
        const subscribers = {};
        window.handler = {on(e,f){subscribers[e]=f;return this}, emit(e,d){if(e==='init')window.__ready=true;}};
        window.__open = content => subscribers.open({title:'fixture.md',content,language:'zh-cn',scrollTop:0,rootPath:'/render'});
      </script>`;
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
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready');

  const source = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
  const t0 = Date.now();
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  console.log('ready', Date.now() - t0);

  // 公式队列清空（官方口径：total>1000 且无 missing 且无 pending）
  let progress;
  do {
    progress = await ev(`(() => {const nodes=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];return {total:nodes.length,missing:nodes.filter(n=>!n.hasAttribute('data-math')).length,queue:window.__typoraMathStats}})()`);
    if (progress.total > 1000 && !progress.missing && !progress.queue?.pending) break;
    await sleep(5000);
  } while (Date.now() < t0 + 240000);
  if (progress.missing || progress.queue?.pending) throw new Error('formula queue unfinished: ' + JSON.stringify(progress));
  console.log('formulas done', Date.now() - t0, 'rendered=' + progress.queue.rendered);

  // 页面内安装：滚动测量、输入测量、CSS 开关
  await ev(`(() => {
    window.__scrollRun = () => { window.__frames=[]; window.__scrollDone=false; let start; const frame=t=>{start??=t;__frames.push(t);if(t-start<2000)requestAnimationFrame(frame);else __scrollDone=true;}; vditor.vditor.ir.element.scrollTop=0; requestAnimationFrame(frame); };
    window.__installInputProbe = () => { window.__inputResult=null; vditor.vditor.ir.element.addEventListener('beforeinput',()=>{const t=performance.now();window.__inputResult=null;requestAnimationFrame(()=>{window.__inputResult={paintMs:performance.now()-t};});},{once:true,capture:true}); };
    window.__focusText = () => { const root=vditor.vditor.ir.element; const p=[...root.querySelectorAll('p')].find(p=>p.firstChild?.nodeType===3&&p.firstChild.length>10); root.focus(); p.scrollIntoView({block:'center'}); getSelection().collapse(p.firstChild,5); };
    window.__setCV = on => { let s=document.getElementById('cv-probe'); if(on){ if(!s){s=document.createElement('style');s.id='cv-probe';s.textContent='.vditor-ir .vditor-reset>*{content-visibility:auto;contain-intrinsic-size:auto 320px;}';document.head.append(s);} } else s?.remove(); const root=vditor.vditor.ir.element; return {on:!!document.getElementById('cv-probe'), computed:getComputedStyle(root.children[1000]).contentVisibility, scrollHeight:root.scrollHeight}; };
  })()`);

  // Performance 指标
  win.webContents.debugger.attach('1.3');
  const perf = command => win.webContents.debugger.sendCommand(command);
  await perf('Performance.enable');
  const metrics = async () => {
    const { metrics: m } = await perf('Performance.getMetrics');
    const get = n => m.find(x => x.name === n)?.value ?? 0;
    return { LayoutCount: get('LayoutCount'), RecalcStyleCount: get('RecalcStyleCount'),
      LayoutDuration: get('LayoutDuration'), RecalcStyleDuration: get('RecalcStyleDuration'),
      JSHeapUsedSize: get('JSHeapUsedSize'), Nodes: get('Nodes') };
  };

  const scrollOnce = async label => {
    await ev('vditor.vditor.ir.element.scrollTop=0');
    await sleep(300);
    const before = await metrics();
    await ev('__scrollRun()');
    for (let i = 0; i < 100; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: 550, y: 400, deltaX: 0, deltaY: 130, canScroll: true }); await sleep(20); }
    await until('window.__scrollDone');
    const after = await metrics();
    const fps = await ev(`(() => {const f=window.__frames;const iv=f.slice(1).map((t,i)=>t-f[i]).sort((a,b)=>a-b);return {fps:(f.length-1)*1000/(f.at(-1)-f[0]),p95FrameMs:iv[Math.floor(iv.length*.95)],maxFrameMs:iv[iv.length-1]}})()`);
    const d = { label, ...fps,
      layoutCount: after.LayoutCount - before.LayoutCount, recalcCount: after.RecalcStyleCount - before.RecalcStyleCount,
      layoutMs: +(after.LayoutDuration - before.LayoutDuration).toFixed(1), recalcMs: +(after.RecalcStyleDuration - before.RecalcStyleDuration).toFixed(1),
      heapMB: +(after.JSHeapUsedSize / 1048576).toFixed(1), nodes: after.Nodes };
    console.log(label, JSON.stringify(d));
    return d;
  };
  const inputOnce = async label => {
    await ev('__focusText(); __installInputProbe()');
    const t = Date.now();
    await win.webContents.insertText(label.includes('after') ? 'cv后' : 'cv前');
    await until('window.__inputResult');
    const r = await ev('({...__inputResult})');
    r.wallMs = Date.now() - t;
    console.log(label, JSON.stringify(r));
    return r;
  };
  const invariant = async label => {
    const ok = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
    console.log(label, 'markdown-invariant=' + ok);
    if (!ok) throw new Error('invariant broken at ' + label);
    return ok;
  };

  const report = { readyMs: Date.now() - t0, dom: await ev(`({nodes:document.querySelectorAll('*').length,formulas:document.querySelectorAll('.katex').length,blocks:vditor.vditor.ir.element.childElementCount})`), scrolls: [], inputs: [], errors };
  console.log('DOM', JSON.stringify(report.dom));
  await invariant('before-cv');

  // A(无CV) → B(有CV) → A → B 交错
  await ev('__setCV(false)');
  report.scrolls.push(await scrollOnce('A1-cv-off'));
  fs.writeFileSync(path.join(output, 'cv-probe-before.png'), (await win.webContents.capturePage()).toPNG());
  report.inputs.push({ label: 'before', ...(await inputOnce('before')) });
  const cvOn = await ev('__setCV(true)');
  console.log('cv state', JSON.stringify(cvOn));
  await sleep(400);
  await invariant('after-cv-on');
  report.scrolls.push(await scrollOnce('B1-cv-on'));
  fs.writeFileSync(path.join(output, 'cv-probe-after.png'), (await win.webContents.capturePage()).toPNG());
  report.inputs.push({ label: 'after', ...(await inputOnce('after')) });
  await ev('__setCV(false)');
  await sleep(300);
  report.scrolls.push(await scrollOnce('A2-cv-off'));
  await ev('__setCV(true)');
  await sleep(300);
  report.scrolls.push(await scrollOnce('B2-cv-on'));
  // 编辑往返后不变式
  await ev('__focusText()');
  await win.webContents.insertText('尾');
  await sleep(300);
  await ev('vditor.vditor.undo.undo(vditor.vditor)');
  await sleep(300);
  await invariant('after-edit-undo');
  await ev('__setCV(false)');
  await invariant('final-cv-off');

  fs.writeFileSync(path.join(output, 'cv-probe.json'), JSON.stringify(report, null, 2));
  console.log('PROBE COMPLETE');
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
