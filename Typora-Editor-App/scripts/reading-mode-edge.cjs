// 阅读模式（路线 #3）edge-case 套件。
// 覆盖主探针（12 万字真实教材）之外的边界：小文档不窗口化、空文档、表格/公式块点击、
// 缩放/宽度变化重排、连续进出、销毁、阅读态打字不改文档、查找交接、选区跨占位复制、
// 编辑面不变式、滚动位置记忆。
// 运行：node_modules/electron/dist/electron.exe scripts/reading-mode-edge.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
const output = path.join(project, '.perf');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'user-data-reading-edge'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
async function until(code, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return true; await sleep(80); }
  return false;
}
const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail: String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail !== '' ? '  [' + detail + ']' : ''));
};
const info = (label, detail) => console.log('INFO ' + label + ' = ' + detail);

// 合成 fixture：可控块数，避免依赖长公式渲染。
const buildDoc = blocks => {
  const out = [];
  for (let i = 0; i < blocks; i++) {
    if (i % 10 === 0) out.push(`## 小节 ${i}`);
    else if (i % 7 === 0) out.push(`| 列 A | 列 B |\n| --- | --- |\n| ${i}-1 | ${i}-2 |`);
    else if (i % 5 === 0) out.push('数学块：\n$$\n a_{' + i + '} + b = c\n$$');
    else if (i % 3 === 0) out.push(`- 列表项 ${i}\n- 第二项 ${i}`);
    else out.push(`第 ${i} 段落。这里是一段用于占位高度测量的正文，包含**粗体**与 $x_{${i}}+1$ 行内公式。`);
  }
  return out.join('\n\n') + '\n';
};

async function main() {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8').replace('{{baseUrl}}', '/render');
      const shim = `<script>
        window.__ready = false;
        localStorage.setItem('dark','false'); localStorage.setItem('edit-mode','ir'); localStorage.setItem('outline','true');
        const subscribers = {};
        window.handler = {on(e,f){subscribers[e]=f;return this}, emit(e,d){if(e==='init')window.__ready=true;}};
        window.__open = content => subscribers.open({title:'fixture.md',content,language:'zh-cn',scrollTop:0,rootPath:'/render'});
        window.__emitSetValue = value => subscribers.setValue(value);
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
  win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false, spellcheck: false } });
  win.showInactive();
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready');
  await ev(`(() => {
    window.__rm = {
      nodes: () => ({total:document.querySelectorAll('*').length,
        ir:vditor.vditor.ir.element.querySelectorAll('*').length,
        preview:vditor.vditor.preview.previewElement.querySelectorAll('*').length,
        slots:document.querySelectorAll('.typora-read-slot').length,
        mounted:[...vditor.vditor.preview.previewElement.children].filter(n=>!n.classList.contains('typora-read-slot')).length}),
      open: source => __open(source),
      settle: () => new Promise(r => setTimeout(r, 300)),
    };
  })()`);

  let opened = false;
  // 只 open 一次：同一个页面里重建 Vditor 不是产品流程，后续换文档走 setValue
  // （外部重载路径），这也顺带把"重载后阅读态是否正确让位"纳入覆盖。
  const openDoc = async (source, waitMs = 2500) => {
    const literal = JSON.stringify(source);
    if (opened) {
      const result = await ev(`(() => { try { vditor.setValue(${literal}); return 'ok'; } catch(error) { return 'ERR ' + error.message; } })()`);
      if (result !== 'ok') { info('setValue failed', result); return false; }
    } else {
      opened = true;
      await ev(`__open(${literal})`);
    }
    await until('window.vditor?.vditor?.__typoraPatched');
    await sleep(waitMs);
    await until('!window.__typoraMathStats?.pending', 60000);
    return true;
  };
  const enter = async () => {
    const ok = await ev(`window.vditor.__typoraReading.enter()`);
    await until('window.vditor.__typoraReading.prepared || !window.vditor.__typoraReading.active', 60000);
    return ok;
  };
  const exit = () => ev(`window.vditor.__typoraReading.exit()`);

  /* ---------- A. 阈值之上的文档：窗口化生效 ---------- */
  const big = buildDoc(1500);
  const tBig = Date.now();
  await openDoc(big);
  check(await enter(), 'A1 large synthetic doc enters reading mode', `${Date.now() - tBig}ms`);
  const a = await ev(`window.__rm.nodes()`);
  check(a.slots > 1000 && a.mounted > 0 && a.mounted < 120, 'A2 windowing active above threshold', JSON.stringify(a));
  const aCover = await ev(`(() => {const sc=vditor.vditor.preview.element,R=vditor.vditor.preview.previewElement,box=sc.getBoundingClientRect();
    return [...R.children].filter(n=>!n.classList.contains('typora-read-slot')).filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>box.top+1&&r.top<box.bottom-1;}).length;})()`);
  check(aCover > 0, 'A3 viewport populated at entry', String(aCover));
  // 滚动到任意位置都不断档
  const blanks = await ev(`(async () => {
    const sc=vditor.vditor.preview.element,R=vditor.vditor.preview.previewElement,out=[];
    for(let f=0;f<=1.0001;f+=0.05){
      sc.scrollTop=Math.min(sc.scrollHeight-sc.clientHeight, sc.scrollHeight*f);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const box=sc.getBoundingClientRect();
      const visible=[...R.children].filter(n=>!n.classList.contains('typora-read-slot')).filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>box.top+1&&r.top<box.bottom-1;}).length;
      if(!visible) out.push({f:+f.toFixed(2),top:Math.round(sc.scrollTop)});
    }
    return out;})()`);
  check(blanks.length === 0, 'A4 no blank viewport across the whole document', JSON.stringify(blanks));
  // 打字不改文档
  const before = await ev(`vditor.getValue().length`);
  await win.webContents.insertText('不应写入');
  await sleep(500);
  const after = await ev(`vditor.getValue().length`);
  check(after === before, 'A5 typing in reading mode does not modify the document', `${before} -> ${after}`);
  // 查找交接
  await ev(`vditor.vditor.preview.element.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))`);
  await sleep(600);
  const findState = await ev(`({reading:window.vditor.__typoraReading.active, panel:!!document.getElementById('typora-find'),
    editorDisplay:getComputedStyle(vditor.vditor.ir.element.parentElement).display, slots:document.querySelectorAll('.typora-read-slot').length})`);
  check(!findState.reading && findState.panel && findState.editorDisplay !== 'none' && findState.slots === 0,
    'A6 Ctrl+F hands off to the editor find bar and cleans up', JSON.stringify(findState));
  await ev(`vditor.__typoraFind.close()`);
  await sleep(300);
  // 滚动位置记忆：进出后回到原处（按"顶部块序号 + 块内偏移"还原）
  await enter();
  await ev(`vditor.vditor.preview.element.scrollTop=Math.round(vditor.vditor.preview.element.scrollHeight*0.5)`);
  await sleep(300);
  const readingTop = await ev(`Math.round(vditor.vditor.preview.element.scrollTop)`);
  await exit();
  await sleep(400);
  check(await enter(), 'A7 re-enter after scroll', '');
  const backTop = await ev(`Math.round(vditor.vditor.preview.element.scrollTop)`);
  check(Math.abs(backTop - readingTop) < 120, 'A8 reading-mode re-entry restores the reading position', `${readingTop} -> ${backTop}`);
  // 缩放/宽度变化触发重排：改宽度后占位高度要跟着变，窗口化保持
  const widthBefore = await ev(`(() => {const sc=vditor.vditor.preview.element;return {w:Math.round(sc.clientWidth), h:sc.scrollHeight};})()`);
  win.setSize(820, 860);
  await sleep(600);
  await until('window.vditor.__typoraReading.prepared', 60000);
  await sleep(400);
  const widthAfter = await ev(`(() => {const sc=vditor.vditor.preview.element;return {w:Math.round(sc.clientWidth), h:sc.scrollHeight,
    mounted:[...vditor.vditor.preview.previewElement.children].filter(n=>!n.classList.contains('typora-read-slot')).length,
    slots:document.querySelectorAll('.typora-read-slot').length};})()`);
  win.setSize(1280, 860);
  await sleep(600);
  await until('window.vditor.__typoraReading.prepared', 60000);
  await sleep(400);
  const widthRestored = await ev(`(() => {const sc=vditor.vditor.preview.element;return {w:Math.round(sc.clientWidth), h:sc.scrollHeight,
    slots:document.querySelectorAll('.typora-read-slot').length};})()`);
  info('resize', JSON.stringify({widthBefore, widthAfter, widthRestored}));
  check(widthAfter.w < widthBefore.w && widthAfter.slots > 1000 && widthAfter.mounted < 200,
    'A9 narrow window re-measures placeholder heights and keeps windowing', JSON.stringify({widthBefore, widthAfter}));
  check(Math.abs(widthRestored.h - widthBefore.h) / Math.max(1, widthBefore.h) < 0.02,
    'A10 widening back restores the original total height', `${widthBefore.h} -> ${widthRestored.h}`);
  // 连点：5 次进出后状态干净
  for (let i = 0; i < 5; i++) { await enter(); await exit(); }
  await sleep(400);
  const churn = await ev(`({reading:window.vditor.__typoraReading.active, slots:document.querySelectorAll('.typora-read-slot').length,
    readingClass:!!document.querySelector('.vditor.typora-reading'), irNodes:vditor.vditor.ir.element.querySelectorAll('*').length})`);
  check(!churn.reading && churn.slots === 0 && !churn.readingClass, 'A11 five enter/exit cycles leave no residue', JSON.stringify(churn));
  // 表格与公式块点击进编辑
  for (const kind of ['TABLE', 'math-block']) {
    await enter();
    const target = await ev(`(() => {const sc=vditor.vditor.preview.element,R=vditor.vditor.preview.previewElement;
      sc.scrollTop=Math.round(sc.scrollHeight*0.35); window.vditor.__typoraReading.update();
      const sel=${JSON.stringify(kind)}==='TABLE'?'table':'div[data-type="math-block"],.language-math';
      const el=[...R.querySelectorAll(sel)].find(n=>{const r=n.getBoundingClientRect();const b=sc.getBoundingClientRect();return r.top>b.top+20&&r.bottom<b.bottom-20&&r.height>8;});
      if(!el) return {error:'not found'};
      const r=el.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
    if (target.error) { check(false, `A12 click on ${kind} exits to the editor`, target.error); continue; }
    win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(800);
    const state = await ev(`(() => {const e=vditor.vditor,sel=getSelection(),root=e.ir.element;
      return {reading:window.vditor.__typoraReading.active, display:getComputedStyle(root.parentElement).display,
        inside:!!(sel.focusNode&&root.contains(sel.focusNode)), rect:(()=>{const r=sel.rangeCount?sel.getRangeAt(0).getBoundingClientRect():null;return r?{top:Math.round(r.top)}:null;})()};})()`);
    check(!state.reading && state.display !== 'none' && state.inside, `A12 click on ${kind} exits to the editor with a caret`, JSON.stringify(state));
    await sleep(200);
  }

  /* ---------- B. 阈值之下：不窗口化 ---------- */
  await openDoc(buildDoc(120), 2000);
  const b0 = await ev(`window.__rm.nodes()`);
  check(await enter(), 'B1 small doc enters reading mode', '');
  const b1 = await ev(`window.__rm.nodes()`);
  const bCover = await ev(`window.vditor.__typoraReading.stats.skipped`);
  check(b1.slots === 0 && bCover >= 1, 'B2 small doc skips windowing entirely (zero rule hits)', JSON.stringify({...b1, skipped: bCover}));
  await exit();
  await sleep(300);
  const b2 = await ev(`window.__rm.nodes()`);
  check(b2.preview === 0 || b2.preview < b0.preview + 500, 'B3 small doc exit leaves no preview residue', JSON.stringify({after: b2, before: b0}));

  /* ---------- C. 空文档 ---------- */
  await ev(`window.__emitSetValue('')`);
  await sleep(900);
  const empty = await ev(`window.vditor.__typoraReading.enter()`);
  check(empty === false, 'C1 empty document refuses to enter reading mode', String(empty));

  /* ---------- D. 选区跨占位复制 ---------- */
  const docBuilt = buildDoc(1500);
  await openDoc(docBuilt);
  await enter();
  const partial = await ev(`(() => { try {
    const R=vditor.vditor.preview.previewElement, kids=[...R.children];
    // 从前部一个挂载块选到后部一个未挂载块的占位槽
    const first=kids.find(n=>!n.classList.contains('typora-read-slot'));
    const slot=kids.slice(200).find(n=>n.classList.contains('typora-read-slot'));
    if(!first||!slot) return {error:'missing mounted block or slot', kids:kids.length,
      slots:kids.filter(n=>n.classList.contains('typora-read-slot')).length};
    const s=getSelection(); s.removeAllRanges(); const r=document.createRange();
    r.setStart(first,0); r.setEnd(slot,1); s.addRange(r);
    const text=s.toString();
    // 区间覆盖 kids[0..200]（绝大多数是占位槽）：长度应与这些块的纯文本之和相当
    const covered=kids.slice(0,201).reduce((sum,n)=>sum+(n.textContent||'').length,0);
    return {len:text.length, covered, ratio:+(text.length/Math.max(1,covered)).toFixed(3),
      mountedCovered:kids.slice(0,201).filter(n=>!n.classList.contains('typora-read-slot')).length,
      tail:text.slice(-30)};
  } catch(error) { return {error:String(error)}; } })()`);
  info('partial selection copy', JSON.stringify(partial));
  check(partial.len > 1000 && partial.ratio > 0.95 && partial.ratio <= 1.05,
    'D1 selection spanning unmounted blocks keeps their text', JSON.stringify(partial));
  await exit();

  /* ---------- E. 销毁 ---------- */
  await enter();
  const destroyed = await ev(`(() => { try { vditor.destroy(); return {ok:true,
    slots:document.querySelectorAll('.typora-read-slot').length,
    readingClass:!!document.querySelector('.vditor.typora-reading'),
    status:!!document.querySelector('.typora-reading-status')}; } catch(error) { return {ok:false, error:String(error)}; } })()`);
  check(destroyed.ok && destroyed.slots === 0 && !destroyed.readingClass && !destroyed.status,
    'E1 destroy() during reading mode tears everything down', JSON.stringify(destroyed));

  const own = errors.filter(e => !/cdn\/vditor/.test(e));
  check(own.length === 0, 'F1 no project-level console errors', JSON.stringify(own.slice(0, 4)));
  info('all errors', JSON.stringify(errors.slice(0, 6)));

  const passed = results.filter(r => r.ok).length;
  console.log(`\n== reading-mode edge: ${passed}/${results.length} PASS, ${results.length - passed} FAIL ==`);
  fs.writeFileSync(path.join(output, 'reading-mode-edge.json'), JSON.stringify({results, errors}, null, 2));
  win.destroy(); server.close(); app.exit(results.some(r => !r.ok) ? 1 : 0);
}
main().catch(e => { console.error('EDGE FAIL', e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
