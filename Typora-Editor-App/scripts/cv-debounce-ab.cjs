// 防抖窗口 A/B：量化"合并发射次数"的收益与"脏标记延迟"的代价，用数据选默认值。
// 运行：node_modules/electron/dist/electron.exe scripts/cv-debounce-ab.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
app.setPath('userData', path.join(project, '.perf', 'user-data-debounce-ab'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
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
      const shim = `<script>window.__ready=false;window.__changes=[];localStorage.setItem('dark','false');localStorage.setItem('edit-mode','ir');localStorage.setItem('outline','false');const sub={};window.handler={on(e,f){sub[e]=f;return this},emit(e,d){if(e==='init'){window.__ready=true;return;}if(e==='change')window.__changes.push(performance.now());sub[e]&&sub[e](d);}};window.__open=c=>sub.open({title:'fixture.md',content:c,language:'zh-cn',scrollTop:0,rootPath:'/render'});</script>`;
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
  const t0 = Date.now();
  await until(`(() => {const n=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];const q=window.__typoraMathStats;return n.length>1000&&n.every(x=>x.hasAttribute('data-math'))&&!(q&&q.pending)})()`, 240000);
  console.log('formulas done', Date.now() - t0);
  await ev(`(() => { const root=vditor.vditor.ir.element; window.__focusTextAt=(bi,off=5)=>{for(let i=bi;i<root.childElementCount;i++){const b=root.children[i];const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest('.vditor-ir__preview')?NodeFilter.FILTER_REJECT:(n.length>3?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP)});const n=w.nextNode();if(!n)continue;root.focus();b.scrollIntoView({block:'center'});getSelection().collapse(n,Math.min(off,n.length));return i}throw new Error('no text')}; })()`);
  const heap = async () => {
    const { metrics: m } = await win.webContents.debugger.sendCommand('Performance.getMetrics');
    return +((m.find(x => x.name === 'JSHeapUsedSize')?.value || 0) / 1048576).toFixed(1);
  };
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');

  const chars = ['一','二','三','四','五','六','七','八','九','十'];
  const report = { rows: [] };
  // 顺序打散 + 重复 window=0，排除"首次打字"混淆
  for (const w of [0, 150, 0, 300, 150]) {
    await ev(`window.__typoraChangeDebounceMs=${w}; true`);
    await ev(`(() => { const o=vditor.vditor.options; if(!o.__probed){const orig=o.input;o.input=function(...a){window.__inputCb=(window.__inputCb||0)+1;return orig?.apply(this,a)};o.__probed=true;} window.__inputCb=0; return true })()`);
    await ev('gc();gc()');
    const before = await heap();
    await ev('__focusTextAt(300)');
    await ev('window.__changes.length=0');
    const start = Date.now();
    for (const ch of chars) { await win.webContents.insertText(ch); await sleep(120); }
    const typedMs = Date.now() - start;
    await sleep(900);
    const emissions = await ev('window.__changes.length');
    const inputCb = await ev('window.__inputCb');
    const landed = await ev(`(${JSON.stringify(chars)}).every(c=>vditor.getValue().includes(c))`);
    const afterNoGC = await heap();
    await ev('gc();gc()');
    const afterGC = await heap();
    const row = { windowMs: w, keystrokes: chars.length, inputCallbacks: inputCb, emissions, typedMs, landed, heapBefore: before, heapAfterNoGC: afterNoGC, heapGrowth: +(afterNoGC - before).toFixed(1), heapAfterGC: afterGC, retainedPerKey: +((afterGC - before) / chars.length).toFixed(2) };
    console.log(JSON.stringify(row));
    report.rows.push(row);
    for (let i = 0; i < chars.length; i++) {
      await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
      await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
      await sleep(120);
    }
    await sleep(400);
  }
  // 单键延迟（每档）
  for (const w of [0, 150, 300]) {
    await ev(`window.__typoraChangeDebounceMs=${w}; true`);
    await ev('__focusTextAt(300)');
    await ev('window.__changes.length=0');
    const t = Date.now();
    await win.webContents.insertText('测');
    let ms = -1;
    for (let i = 0; i < 30; i++) { if (await ev('window.__changes.length') > 0) { ms = Date.now() - t; break; } await sleep(20); }
    console.log(`latency window=${w}ms -> ${ms}ms`);
    report[`latency_${w}`] = ms;
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
    await sleep(300);
  }
  fs.writeFileSync(path.join(project, '.perf', 'cv-debounce-ab.json'), JSON.stringify(report, null, 2));
  console.log('DEBOUNCE AB COMPLETE');
  win.destroy(); server.close(); app.exit(0);
}
main().catch(e => { console.error(e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
