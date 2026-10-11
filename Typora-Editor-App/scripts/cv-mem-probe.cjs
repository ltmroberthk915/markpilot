// content-visibility 内存归因探针：分离启用成本/滚动成本、瞬态垃圾/真实驻留。
// 运行：node_modules/electron/dist/electron.exe scripts/cv-mem-probe.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
const output = path.join(project, '.perf');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'user-data-cv-mem-probe'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('js-flags', '--expose-gc'); // 页内可调用 gc() 区分垃圾与驻留
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
async function until(code, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return; await sleep(50); }
  throw new Error('Timed out: ' + code);
}
const mb = b => +(b / 1048576).toFixed(1);

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
  await until('typeof gc === "function"').catch(() => console.log('WARN: gc() not exposed'));

  const source = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  let progress; const t0 = Date.now();
  do {
    progress = await ev(`(() => {const n=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];return {total:n.length,missing:n.filter(x=>!x.hasAttribute('data-math')).length,q:window.__typoraMathStats}})()`);
    if (progress.total > 1000 && !progress.missing && !progress.q?.pending) break;
    await sleep(5000);
  } while (Date.now() < t0 + 240000);
  console.log('formulas done', Date.now() - t0);

  await ev(`(() => {
    window.__setCV = on => { let s=document.getElementById('cv-probe'); if(on){ if(!s){s=document.createElement('style');s.id='cv-probe';s.textContent='.vditor-ir .vditor-reset>*{content-visibility:auto;contain-intrinsic-size:auto 320px;}';document.head.append(s);} } else s?.remove(); return !!document.getElementById('cv-probe'); };
    window.__scrollRun = () => { window.__frames=[]; window.__scrollDone=false; let start; const f=t=>{start??=t;__frames.push(t);if(t-start<2000)requestAnimationFrame(f);else__scrollDone=true;}; vditor.vditor.ir.element.scrollTop=0; requestAnimationFrame(f); setTimeout(()=>{window.__scrollDone=true},3400); };
  })()`);

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  const heapMB = async () => {
    const { metrics: m } = await win.webContents.debugger.sendCommand('Performance.getMetrics');
    return +(m.find(x => x.name === 'JSHeapUsedSize')?.value || 0) / 1048576;
  };
  const rssMB = async () => {
    const appm = app.getAppMetrics();
    return { raw: appm.map(p => ({ type: p.type, pid: p.pid, pzMB: p.memory?.privateBytes ? +(p.memory.privateBytes / 1024).toFixed(0) : null })) };
  };
  const domCount = () => ev(`({dom:document.querySelectorAll('*').length, blocks:vditor.vditor.ir.element.childElementCount, math:window.__typoraMathStats.rendered})`);
  const gc = () => ev('gc(); gc();');
  const phase = async name => {
    await sleep(400);
    const p = { phase: name, heapMB: +(await heapMB()).toFixed(1), ...(await rssMB()), ...(await domCount()) };
    console.log(JSON.stringify(p));
    return p;
  };
  const scroll = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      win.showInactive(); // 刷新遮挡状态；被前台窗口盖住时 rAF 会被节流
      await ev('vditor.vditor.ir.element.scrollTop=0');
      await sleep(250);
      await ev('__scrollRun()');
      for (let i = 0; i <100; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: 550, y: 400, deltaX: 0, deltaY: 130, canScroll: true }); await sleep(20); }
      try { await until('window.__scrollDone', 20000); await ev('vditor.vditor.ir.element.scrollTop=0'); return; }
      catch {
        console.log('scroll retry', attempt, JSON.stringify(await ev(`({hidden:document.hidden,vis:document.visibilityState,frames:window.__frames?.length})`)));
        await sleep(500);
      }
    }
    throw new Error('scroll measurement failed after retries');
  };
  const fps = () => ev(`(() => {const f=window.__frames;const iv=f.slice(1).map((t,i)=>t-f[i]).sort((a,b)=>a-b);return {fps:+((f.length-1)*1000/(f.at(-1)-f[0])).toFixed(1),maxFrameMs:+iv[iv.length-1].toFixed(1)}})()`);

  const report = { phases: [], scroll: [], errors };
  // P0 基线
  report.phases.push(await phase('P0-idle-cv-off'));
  await gc();
  report.phases.push(await phase('P1-after-gc'));
  // P2 无 CV 滚动（垃圾基线）
  await scroll(); report.scroll.push({ label: 'off', ...(await fps()) });
  report.phases.push(await phase('P2-after-scroll-off'));
  await gc();
  report.phases.push(await phase('P3-after-scroll-off-gc'));
  // P4 仅启用 CV 不滚动（分离启用成本）
  await ev('__setCV(true)');
  await sleep(600);
  report.phases.push(await phase('P4-cv-on-idle'));
  await gc();
  report.phases.push(await phase('P5-cv-on-idle-gc'));
  // P6 CV 滚动
  await scroll(); report.scroll.push({ label: 'on', ...(await fps()) });
  report.phases.push(await phase('P6-after-scroll-on'));
  await gc();
  report.phases.push(await phase('P7-after-scroll-on-gc'));
  // P8 再滚一轮 + GC（驻留是否复现/增长）
  await scroll(); report.scroll.push({ label: 'on-2', ...(await fps()) });
  await gc();
  report.phases.push(await phase('P8-second-scroll-on-gc'));
  // P9 关闭 CV + GC（可逆性）
  await ev('__setCV(false)');
  await sleep(400);
  await gc();
  report.phases.push(await phase('P9-cv-off-again-gc'));
  // 不变式
  report.invariant = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
  console.log('invariant', report.invariant);
  fs.writeFileSync(path.join(output, 'cv-mem-probe.json'), JSON.stringify(report, null, 2));
  console.log('MEM PROBE COMPLETE');
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
