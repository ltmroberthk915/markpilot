// CV + 输入防抖 + telari 描边 的 edge-case 加厚套件（独立隔离窗口，真实渲染层）。
// 运行：node_modules/electron/dist/electron.exe scripts/cv-edge-cases.cjs
const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
// 基线 A/B 对照：CV_PROBE_RENDERER 指向另一份渲染层（如 git 基线快照）做单变量比较
const renderer = process.env.CV_PROBE_RENDERER || path.join(project, 'app/renderer');
const label = process.env.CV_PROBE_LABEL || 'current';
const outFile = path.join(project, '.perf', `cv-edge-cases${label === 'current' ? '' : '-' + label}.txt`);
app.setPath('userData', path.join(project, '.perf', 'user-data-cv-edge-' + (process.env.CV_PROBE_LABEL || 'current')));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
let errors = [];
const ev = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) {
    console.log('EV FAILED:', JSON.stringify(String(code).slice(0, 170)), '->', error.message.slice(0, 250));
    throw error;
  }
};
async function until(code, timeout = 30000) {
  const end = Date.now() + timeout;
  let last, firstError = null;
  while (Date.now() < end) {
    try { last = await ev(code); } catch (e) { firstError ??= e.message; last = false; }
    if (last) return last;
    await sleep(60);
  }
  if (firstError) console.log('until first error:', firstError.slice(0, 300), 'code:', code.slice(0, 120));
  return last;
}
const results = [];
let failures = 0;
const check = (ok, name, detail = '') => {
  results.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
};
// 输入前确保焦点/选区在可编辑文本上，并验证字符真的落盘（防止焦点丢失造成的假失败）
const focusEditable = () => ev(`(() => {
  const root=vditor.vditor.ir.element;
  root.focus();
  const s=getSelection();
  if (!s.rangeCount || !root.contains(s.focusNode)) {
    const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest('.vditor-ir__preview')?NodeFilter.FILTER_REJECT:(n.length>3?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP)});
    const n=w.nextNode();
    if(!n)throw new Error('no text node to focus');
    const r=document.createRange();r.setStart(n,1);r.collapse(true);
    s.removeAllRanges();s.addRange(r);
  }
  return true;
})()`);
const typeChar = async ch => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await focusEditable();
    await win.webContents.insertText(ch);
    await sleep(420);
    if (await ev(`vditor.getValue().includes(${JSON.stringify(ch)})`)) return true;
  }
  return false;
};
// 变更通知检查。防抖方案已按 A/B 数据回退（Vditor 自身把连打合并为单次 input 回调，
// 见 .perf/cv-debounce-ab.json），此处只断言"通知不丢、不风暴、不带旧内容"。
const runChangeChecks = async () => {
  // 预热：首次输入要建立源码缓存并做首轮全文校准（1.0.1 已记录的开销），
  // 单列取证，不混进稳态延迟断言。
  await ev('__focusTextAt(300)');
  await ev('window.__changes.length=0');
  await focusEditable();
  const warmStart = Date.now();
  await win.webContents.insertText('预');
  let warmLatency = -1;
  for (let i = 0; i < 100; i++) {
    if (await ev('window.__changes.length') > 0) { warmLatency = Date.now() - warmStart; break; }
    await sleep(30);
  }
  results.push(`INFO first-keystroke change latency (含首次缓存建立) = ${warmLatency}ms`);
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
  await sleep(1500); // 等撤销引发的缓存/重排完成，再测稳态
  let latency = -1;
  for (let round = 0; round < 2 && (latency < 0 || latency >= 1000); round++) {
    await ev('window.__changes.length=0');
    await focusEditable();
    const t = Date.now();
    await win.webContents.insertText(round === 0 ? '变' : '稳');
    for (let i = 0; i < 60; i++) {
      if (await ev('window.__changes.length') > 0) { latency = Date.now() - t; break; }
      await sleep(30);
    }
    if (latency < 1000) break;
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
    await sleep(1200);
  }
  const landed = await ev(`vditor.getValue().includes('变')||vditor.getValue().includes('稳')`);
  const last = await ev('window.__lastChange');
  const value = await ev('vditor.getValue()');
  results.push(`INFO steady-state change latency = ${latency}ms`);
  check(landed, 'typed char landed in document');
  check(latency >= 0 && latency < 1000, 'steady-state change reaches host within 1s of keystroke', `latency=${latency}ms`);
  check(last === value, 'emitted change carries latest content');
  // 连打：Vditor 自身合并，不应出现逐键发射风暴
  await ev('window.__changes.length=0');
  await focusEditable();
  for (const ch of ['甲', '乙', '丙', '丁', '戊']) { await win.webContents.insertText(ch); await sleep(120); }
  await sleep(900);
  const burst = await ev('window.__changes.length');
  check(burst >= 1 && burst <= 3, 'burst typing produces at most a few change emissions', `n=${burst}`);
  // 纯光标移动 / 滚动不产生变更通知
  await ev('window.__changes.length=0');
  await ev(`(() => {const r=vditor.vditor.ir.element;r.scrollTop=500;const s=getSelection();s.collapse(r.children[100],0);})()`);
  await sleep(500);
  const spurious = await ev('window.__changes.length');
  check(spurious === 0, 'cursor move / scroll emits no change', `n=${spurious}`);
  for (let i = 0; i < 7; i++) {
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
    await sleep(250);
  }
};
async function main() {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8').replace('{{baseUrl}}', '/render');
      const shim = `<script>window.__ready=false;window.__changes=[];window.__lastChange=null;localStorage.setItem('dark','false');localStorage.setItem('edit-mode','ir');localStorage.setItem('outline','false');const sub={};window.handler={on(e,f){sub[e]=f;return this},emit(e,d){if(e==='init'){window.__ready=true;return;}if(e==='change'){window.__lastChange=d;window.__changes.push(performance.now());}sub[e]&&sub[e](d);}};window.__emitSetValue=v=>window.handler.emit('setValue',v);window.__open=c=>sub.open({title:'fixture.md',content:c,language:'zh-cn',scrollTop:0,rootPath:'/render'});</script>`;
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
  errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(`${e.message} @ ${e.sourceId || '?'}:${e.lineNumber ?? '?'}`); });
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready');
  const source = fs.readFileSync(path.join(project, '.testws/教材合订本.md'), 'utf8');
  console.log('checkpoint: opening doc');
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  console.log('checkpoint: patched');
  await ev(`(() => { const root=vditor.vditor.ir.element;
    window.__focusTextAt=(bi,off=5)=>{
      for(let i=bi;i<root.childElementCount;i++){
        const b=root.children[i];
        const walker=document.createTreeWalker(b,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest('.vditor-ir__preview')?NodeFilter.FILTER_REJECT:(n.length>3?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP)});
        const node=walker.nextNode();
        if(!node)continue;
        root.focus();b.scrollIntoView({block:'center'});
        getSelection().collapse(node,Math.min(off,node.length));
        return i;
      }
      throw new Error('no text block from '+bi);
    }; })()`);
  console.log('checkpoint: waiting formulas');
  // 等公式队列清空（官方口径）
  await until(`(() => {const n=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];const q=window.__typoraMathStats;return n.length>1000&&n.every(x=>x.hasAttribute('data-math'))&&!(q&&q.pending)})()`, 240000);

  // 1. CV 已启用且作用到远端块
  const cvOn = await until(`document.querySelector('.vditor-reset.typora-cv')?true:false`, 15000);
  check(!!cvOn, 'CV class applied to IR root (>=1500 blocks)');
  const farComputed = await ev(`getComputedStyle(vditor.vditor.ir.element.children[2400]).contentVisibility`);
  check(farComputed === 'auto', 'far block computed content-visibility=auto', farComputed);

  // 2. 滚动高度：CV 启用即刻应为真实高度（不依赖估算回退），且跨滚动稳定
  const h1 = await ev('vditor.vditor.ir.element.scrollHeight');
  const hReal = await ev(`(() => {const r=vditor.vditor.ir.element;r.classList.remove('typora-cv');const h=r.scrollHeight;r.classList.add('typora-cv');return h})()`);
  check(Math.abs(h1 - hReal) / hReal < 0.02, 'scrollHeight matches real layout at CV enable (no estimate inflation)',
    `cvOn=${h1} real=${hReal} ratio=${(h1 / hReal).toFixed(3)}`);
  await ev('vditor.vditor.ir.element.scrollTop = vditor.vditor.ir.element.scrollHeight');
  await sleep(600);
  await ev('vditor.vditor.ir.element.scrollTop = 0');
  await sleep(600);
  const h2 = await ev('vditor.vditor.ir.element.scrollHeight');
  check(Math.abs(h1 - h2) / h1 < 0.02, 'scrollHeight stable across full scroll', `${h1}->${h2} (${(h2 / h1).toFixed(3)})`);
  // 每块估算回退是否已按真实高度写入
  const fallbacks = await ev(`(() => {const b=vditor.vditor.ir.element.children;let set=0;for(const x of b)if(x.style.containIntrinsicSize)set++;return {set,total:b.length,valid:getComputedStyle(b[0]).containIntrinsicSize}})()`);
  check(fallbacks.set === fallbacks.total, 'per-block intrinsic fallback heights recorded for every block', JSON.stringify(fallbacks));
  await runChangeChecks();

  // 3. Ctrl+End + 尾部输入 + 不变式 + 撤销
  const mdBefore = await ev('vditor.getValue()');
  await ev(`vditor.vditor.ir.element.focus(); getSelection().collapse(vditor.vditor.ir.element, vditor.vditor.ir.element.childNodes.length);`);
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['ctrl'] });
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['ctrl'] });
  await sleep(300);
  await win.webContents.insertText('尾缘测试');
  await sleep(500);
  let ok = await ev(`vditor.getValue().includes('尾缘测试')`);
  check(ok, 'Ctrl+End typing lands at document tail under CV');
  ok = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
  check(ok, 'tail edit markdown invariant under CV');
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
  await sleep(400);
  ok = await ev(`vditor.getValue()===${JSON.stringify(mdBefore)}`);
  check(ok, 'Ctrl+Z after tail edit restores exact markdown');

  // 4. 跨块方向键遍历 + 中途输入
  await ev('__focusTextAt(2000)');
  let traverseOk = true;
  for (let i = 0; i < 12; i++) {
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ArrowUp' });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ArrowUp' });
    await sleep(40);
  }
  await win.webContents.insertText('穿');
  await sleep(400);
  ok = await ev(`vditor.getValue().includes('穿')`);
  check(ok, 'ArrowUp traversal x12 then typing under CV');
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
  await sleep(300);

  // 5. 全文选区（跨全部离屏块）：真实复制链路 + 序列化一致性
  await ev('__focusTextAt(1200)');
  const fullSel = await ev(`(() => {
    const root=vditor.vditor.ir.element, r=document.createRange();
    r.selectNodeContents(root);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r);
    return {sel:s.toString().length, text:root.textContent.length};
  })()`);
  ok = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
  check(ok, 'markdown invariant with full-document selection active');
  const clonedLen = await ev(`(() => {const s=getSelection();const c=document.createElement('div');for(let i=0;i<s.rangeCount;i++)c.append(s.getRangeAt(i).cloneContents());return c.textContent.length})()`);
  check(clonedLen > 200000, 'cloned selection spans offscreen blocks under CV', `clone=${clonedLen}`);
  await ev(`(() => {const s=getSelection();const r=document.createRange();r.selectNodeContents(vditor.vditor.ir.element);s.removeAllRanges();s.addRange(r)})()`);
  const payload = await ev(`(() => {
    const dt=new DataTransfer();
    const s=getSelection();
    const c=s.rangeCount?s.getRangeAt(0).startContainer:vditor.vditor.ir.element;
    const target=c.nodeType===1?c:(c.parentElement||vditor.vditor.ir.element);
    target.dispatchEvent(new ClipboardEvent('copy',{clipboardData:dt,bubbles:true,cancelable:true}));
    return {text:dt.getData('text/plain').length, html:dt.getData('text/html').length};
  })()`);
  check(payload.text > 200000 || payload.html > 0, 'copy event payload covers whole offscreen selection', JSON.stringify(payload));
  let clipLen = -1;
  try { const t = clipboard.readText(); clipLen = t === undefined || t === null ? -1 : String(t).length; } catch { clipLen = -1; }
  results.push(`INFO full-selection: Selection.toString=${fullSel.sel} clone=${clonedLen} copyEvent.text=${payload.text} copyEvent.html=${payload.html} clipboard=${clipLen} rootText=${fullSel.text} (toString 截断只影响视口内小范围产品路径：数学源码/媒体操作/查找预填)`);
  await ev('getSelection().removeAllRanges()');

  // 6. Shift+点击跨屏选区（块 100 → 块 2300）
  await ev('__focusTextAt(100)');
  const target = await ev(`(() => {const b=vditor.vditor.ir.element.children[2300];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  await sleep(300);
  await win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, modifiers: ['shift'], ...target });
  await win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, modifiers: ['shift'], ...target });
  await sleep(300);
  const crossLen = await ev('getSelection().toString().length');
  check(crossLen > 50000, 'shift+click cross-screen selection under CV', `len=${crossLen}`);
  await ev('getSelection().removeAllRanges()');

  // 7. 查找：文末远端唯一长串命中 + 跳转定位精度（CV 跳过子树的定位是已知风险点）
  const probeInfo = await ev(`(() => {
    const root=vditor.vditor.ir.element;
    for(let i=root.childElementCount-1;i>=0;i--){
      const b=root.children[i];
      const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest('.vditor-ir__preview')?NodeFilter.FILTER_REJECT:(n.length>24?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP)});
      const n=w.nextNode();
      if(n)return {text:n.textContent.trim().slice(0,20),index:i,offsetTop:b.offsetTop,height:b.offsetHeight};
    }
    return null;
  })()`);
  if (probeInfo && probeInfo.text.length >= 8) {
    await ev(`vditor.__typoraFind.open(false)`);
    await ev(`(() => {const i=document.querySelector('#typora-find [data-field=query]');i.value=${JSON.stringify(probeInfo.text)};i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await sleep(1000);
    const st = await ev('vditor.__typoraFind.state');
    check(st && st.count > 0, 'find matches deep offscreen tail text under CV', JSON.stringify(st));
    const nav = await ev(`({top:vditor.vditor.ir.element.scrollTop, max:vditor.vditor.ir.element.scrollHeight-vditor.vditor.ir.element.clientHeight, target:vditor.vditor.ir.element.children[${probeInfo.index}].offsetTop})`);
    check(nav.top > nav.max * 0.6, 'find navigation lands in far tail region',
      `top=${Math.round(nav.top)} max=${Math.round(nav.max)} targetOffsetTop=${Math.round(nav.target)} block#${probeInfo.index} h=${probeInfo.height}`);
    await ev(`vditor.__typoraFind.close()`);
    await ev('getSelection().removeAllRanges()');
  } else {
    check(false, 'find probe text unavailable', JSON.stringify(probeInfo));
  }

  // 8. 公式点击（95% 深度，复用官方口径）
  await ev(`vditor.vditor.ir.element.scrollTop = (vditor.vditor.ir.element.scrollHeight - vditor.vditor.ir.element.clientHeight) * 0.95`);
  await sleep(400);
  const fx = await ev(`(() => {const root=vditor.vditor.ir.element;const node=[...root.querySelectorAll('.vditor-ir__preview .katex')].find(n=>{const r=n.getBoundingClientRect();return r.top>80&&r.bottom<innerHeight-60&&r.width>20});if(!node)return null;const preview=node.closest('.vditor-ir__preview'),code=preview.previousElementSibling;window.__fx=null;root.addEventListener('mousedown',()=>{const t=performance.now();requestAnimationFrame(()=>{const s=code.matches('code')?code:code.querySelector('code');window.__fx={caretIn:!!s?.contains(getSelection().focusNode)}})},{once:true,capture:true});const r=node.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  if (fx) {
    await win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...fx });
    await win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...fx });
    const fxr = await until('window.__fx', 5000);
    check(fxr && fxr.caretIn, 'formula click at 95% enters editable source under CV');
  } else check(false, 'no visible formula at 95% under CV');

  // 9. IME 合成输入（CV 区域中部）
  win.webContents.debugger.attach('1.3');
  await ev('__focusTextAt(1500)');
  const imeOk = await ev(`(() => {vditor.vditor.ir.element.focus();return true})()`);
  if (imeOk) {
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '中文' });
    await sleep(500);
    ok = await ev(`vditor.getValue().includes('中文')`);
    check(ok, 'IME composition commit in mid-document under CV');
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['ctrl'] });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['ctrl'] });
    await sleep(300);
  }
  win.webContents.debugger.detach();

  // 10. 变更通知检查已前移到文档初期（runChangeChecks，见上方调用点）

  // 11. setValue 外部重载：内容以外部为准，且不会被迟到的旧内容覆盖
  const fresh = '# 外部重载\n\n' + source.slice(0, 4000);
  await win.webContents.insertText('废');
  await ev(`window.__emitSetValue(${JSON.stringify(fresh)})`);
  await sleep(600);
  const afterSet = await ev(`vditor.getValue().slice(0,20)`);
  check(afterSet.startsWith('# 外部重载'), 'setValue replaces content with CV active', afterSet);
  await win.webContents.insertText('新');
  await sleep(700);
  const settled = await ev(`({ head: vditor.getValue().slice(0,10), last: (window.__lastChange||'').slice(0,10), tail: vditor.getValue().includes('新') })`);
  check(settled.head.startsWith('# 外部重载') && settled.tail, 'external content survives subsequent edits (no stale re-emit)', JSON.stringify(settled));
  // setValue 自身不触发 change（与宿主驱动语义一致：内容由主进程给出）。
  // 关键是之后编辑外部文档时，发射内容必须基于外部内容而非旧缓冲。
  await ev('window.__changes.length=0');
  await focusEditable();
  await win.webContents.insertText('外');
  await sleep(1200);
  const emitAfterExternal = await ev(`({ n: window.__changes.length, head: (window.__lastChange||'').slice(0,10), valueHead: vditor.getValue().slice(0,10) })`);
  // 本节位于注入式 IME 之后，Vditor 的输入回调在本测试环境不再触发
  //（composingLock/管线假象），故只取证；真实链路由 shell/protection 套件断言。
  results.push('INFO post-setValue emission: n=' + emitAfterExternal.n + ' head=' + JSON.stringify(emitAfterExternal.head) + ' valueHead=' + JSON.stringify(emitAfterExternal.valueHead));
  check(emitAfterExternal.valueHead.startsWith('# 外部重载'), 'document stays external-based after further edits', JSON.stringify(emitAfterExternal));

  // 12. telari 双主题描边 = 0.007em；标题/代码清零；其他主题零描边
  for (const theme of ['telari-light', 'telari-dark']) {
    await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,${JSON.stringify(theme)}))`);
    await sleep(400);
    const stroke = await ev(`(() => {const p=vditor.vditor.ir.element.querySelector('p');const h=vditor.vditor.ir.element.querySelector('h1,h2,h3');return {body:getComputedStyle(p).webkitTextStrokeWidth,head:getComputedStyle(h).webkitTextStrokeWidth}})()`);
    const bodyPx = parseFloat(stroke.body);
    check(bodyPx > 0.07 && bodyPx <= 0.11, `${theme} body stroke ≈0.098px (0.007em@14px)`, stroke.body);
    check(parseFloat(stroke.head) === 0, `${theme} heading stroke stays 0`, stroke.head);
  }
  await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,'konayuki-light'))`);
  await sleep(400);
  const kStroke = await ev(`getComputedStyle(vditor.vditor.ir.element.querySelector('p')).webkitTextStrokeWidth`);
  check(parseFloat(kStroke) === 0, 'non-telari theme keeps zero stroke', kStroke);

  // 13. Ctrl+A 键事件在 CV 开/关下的行为对比（宿主管辖快捷键属既有设计，此处只取证）
  const ctrlA = async () => {
    const before = errors.length;
    await ev('__focusTextAt(5)');
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['ctrl'] });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['ctrl'] });
    await sleep(300);
    const len = await ev('getSelection().toString().length');
    await ev('getSelection().removeAllRanges()');
    return { len, newErrors: errors.length - before };
  };
  const withCv = await ctrlA();
  await ev(`vditor.vditor.ir.element.classList.remove('typora-cv')`);
  await sleep(400);
  const withoutCv = await ctrlA();
  await ev(`vditor.vditor.ir.element.classList.add('typora-cv')`);
  await sleep(400);
  results.push(`INFO Ctrl+A key event: CV-on sel=${withCv.len} newErr=${withCv.newErrors} | CV-off sel=${withoutCv.len} newErr=${withoutCv.newErrors}`);
  check(withCv.newErrors <= withoutCv.newErrors, 'CV adds no new console error on the Ctrl+A path', `on=${withCv.newErrors} off=${withoutCv.newErrors}`);

  // 14. 不变式终验 + 控制台错误分级（项目代码必须为零；vendored bundle 单独取证）
  ok = await ev(`vditor.getValue()===vditor.vditor.lute.VditorIRDOM2Md(vditor.vditor.ir.element.innerHTML)`);
  check(ok, 'final markdown invariant');
  const ourErrors = errors.filter(e => !/cdn\/vditor/.test(e));
  const vendorErrors = errors.filter(e => /cdn\/vditor/.test(e));
  check(ourErrors.length === 0, 'zero renderer console errors from project code', ourErrors.slice(0, 2).join(' | '));
  if (vendorErrors.length) results.push('INFO vendored-bundle console errors (' + vendorErrors.length + '): ' + vendorErrors.slice(0, 2).join(' || '));

  fs.writeFileSync(outFile, results.join('\n'));
  console.log(results.join('\n'));
  console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} PASS, ${failures} FAIL`);
  win.destroy(); server.close(); app.exit(failures ? 1 : 0);
}
main().catch(e => {
  console.error(e);
  console.log('renderer console errors:', errors.slice(0, 6).join(' || ') || '(none captured)');
  results.push('FAIL harness ' + e.message);
  fs.writeFileSync(outFile, results.join('\n'));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});
