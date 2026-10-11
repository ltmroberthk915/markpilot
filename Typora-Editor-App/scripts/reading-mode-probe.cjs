// 阅读模式（路线 #3）功能与量化探针。
// 覆盖：进入/全宽只读/窗口化生效/总高不变式/DOM 与内存/滚动覆盖/全选复制/
//       点击进编辑/大纲跳转/Esc 退出/编辑面还原/二次进出稳定性。
// 运行：node_modules/electron/dist/electron.exe scripts/reading-mode-probe.cjs
// 环境：RM_FIXTURE（默认 .testws/教材合订本.md）、RM_LABEL
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
const output = path.join(project, '.perf');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'user-data-reading-probe'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
async function until(code, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return true; await sleep(100); }
  return false;
}
const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail: String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail !== '' ? '  [' + detail + ']' : ''));
};
const info = (label, detail) => console.log('INFO ' + label + ' = ' + detail);

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

  const fixture = process.env.RM_FIXTURE || '.testws/教材合订本.md';
  const label = process.env.RM_LABEL || path.basename(fixture);
  const source = fs.readFileSync(path.join(project, fixture), 'utf8');
  const t0 = Date.now();
  await ev(`__open(${JSON.stringify(source)})`);
  await until('window.vditor?.vditor?.__typoraPatched');
  info('open ready ms', Date.now() - t0);
  // 公式队列清空
  let progress;
  do {
    progress = await ev(`(() => {const n=[...vditor.vditor.ir.element.querySelectorAll('.vditor-ir__preview .language-math')];return {total:n.length,missing:n.filter(x=>!x.hasAttribute('data-math')).length,q:window.__typoraMathStats}})()`);
    if (progress.total > 1000 && !progress.missing && !progress.q?.pending) break;
    await sleep(5000);
  } while (Date.now() - t0 < 300000);
  info('formulas done ms', Date.now() - t0);

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  const heapMB = async () => {
    const { metrics } = await win.webContents.debugger.sendCommand('Performance.getMetrics');
    return +(((metrics.find(x => x.name === 'JSHeapUsedSize')?.value) || 0) / 1048576).toFixed(1);
  };
  const priv = () => {
    const list = app.getAppMetrics().filter(p => p.type === 'Tab' || p.type === 'renderer');
    return list.map(p => (p.memory?.privateBytes ? Math.round(p.memory.privateBytes / 1024) : 0)).reduce((a, b) => a + b, 0);
  };
  const gc = async () => { await ev('gc(); gc();'); await sleep(400); };

  await ev(`(() => {
    const e=vditor.vditor, R=()=>e.preview.previewElement;
    window.__rm = {
      nodes: () => ({total:document.querySelectorAll('*').length, ir:e.ir.element.querySelectorAll('*').length,
        preview:R().querySelectorAll('*').length, slots:document.querySelectorAll('.typora-read-slot').length,
        mounted:[...R().children].filter(n=>!n.classList.contains('typora-read-slot')).length}),
      textLen: () => { const s=getSelection(); s.removeAllRanges(); const r=document.createRange(); r.selectNodeContents(R()); s.addRange(r); const t=s.toString(); s.removeAllRanges(); return t.length; },
      // 视口内是否真的有已挂载的真实块（防"滚动到空白"）
      coverage: () => { const sc=e.preview.element, box=sc.getBoundingClientRect();
        const mounted=[...R().children].filter(n=>!n.classList.contains('typora-read-slot'));
        const visible=mounted.filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>box.top+1&&r.top<box.bottom-1;});
        return {mounted:mounted.length, visible:visible.length, tags:visible.slice(0,3).map(n=>n.tagName)}; },
    };
  })()`);

  const nodes0 = await ev(`window.__rm.nodes()`);
  const priv0 = priv(), heap0 = await gc().then(heapMB);
  info('baseline (edit mode) nodes/heap/priv', JSON.stringify({...nodes0, heapMB: heap0, privMB: priv0}));

  // ---- 进入阅读模式 ----
  const tEnter = Date.now();
  const entered = await ev(`window.vditor.__typoraReading.enter()`);
  check(entered === true, 'enter() returns true', JSON.stringify(entered));
  // 准备期的峰值：完整预览面（未窗口化）的 DOM 规模，退出后再比窗口化后的值。
  await until(`vditor.vditor.preview.previewElement.querySelectorAll('*').length > 50000`, 180000);
  const peakNodes = await ev(`window.__rm.nodes()`);
  info('un-windowed preview peak nodes', JSON.stringify(peakNodes));
  check(await until(`window.vditor.__typoraReading.prepared`, 120000), 'reading view prepared within 120s', `${Date.now() - tEnter}ms`);
  const prepMs = Date.now() - tEnter;
  info('prepare ms (entry -> windowed)', prepMs);
  const surfaceState = await ev(`(() => {const e=vditor.vditor;const oc=e.outline.element;
    const outlineShown=oc&&getComputedStyle(oc).display!=='none'?oc.offsetWidth:0;
    const content=e.preview.element.parentElement;
    return {
    reading:document.querySelector('.vditor.typora-reading')!==null,
    previewDisplay:getComputedStyle(e.preview.element).display,
    editorDisplay:getComputedStyle(e.ir.element.parentElement).display,
    previewWidth:Math.round(e.preview.element.getBoundingClientRect().width),
    contentWidth:Math.round(content.clientWidth),
    outlineWidth:Math.round(outlineShown),
    scrollerFocused:document.activeElement===e.preview.element,
    stats:window.vditor.__typoraReading.stats};})()`);
  check(surfaceState.reading && surfaceState.previewDisplay !== 'none', 'reading surface visible', JSON.stringify({reading: surfaceState.reading, display: surfaceState.previewDisplay}));
  check(surfaceState.editorDisplay === 'none', 'editing pane hidden while reading', surfaceState.editorDisplay);
  check(surfaceState.previewWidth >= surfaceState.contentWidth - surfaceState.outlineWidth - 4,
    'reading surface is full width (besides the outline)', `${surfaceState.previewWidth} vs ${surfaceState.contentWidth}-${surfaceState.outlineWidth}`);
  check(surfaceState.scrollerFocused, 'scroller takes focus (keyboard scrolling)', String(surfaceState.scrollerFocused));
  info('windowize stats', JSON.stringify(surfaceState.stats));

  const nodes1 = await ev(`window.__rm.nodes()`);
  check(nodes1.slots > 1000, 'offscreen blocks replaced by placeholders', `slots=${nodes1.slots}`);
  check(nodes1.mounted > 0 && nodes1.mounted < 120, 'only a window of blocks stays mounted', `mounted=${nodes1.mounted} of ${nodes1.slots + nodes1.mounted}`);
  check(nodes1.preview < peakNodes.preview / 10, 'windowed preview DOM shrinks by >10x vs the full preview surface',
    `${nodes1.preview} vs ${peakNodes.preview}`);
  info('reading nodes', JSON.stringify(nodes1));
  await gc(); await sleep(500);
  const priv1 = priv(), heap1 = await heapMB();
  info(`memory reading: heapMB=${heap1} privMB=${priv1} (edit baseline heap=${heap0} priv=${priv0})`);
  check(priv1 < priv0, 'renderer privateBytes drops in reading mode', `${priv1} vs ${priv0}`);
  check(heap1 < 200, 'JS heap stays small', String(heap1));

  // ---- 总高不变式 + 全选复制完整 ----
  const height = await ev(`(() => {const sc=vditor.vditor.preview.element;const R=vditor.vditor.preview.previewElement;
    const plain=[...R.children].reduce((a,n)=>a+(n.textContent||'').length,0);
    return {scrollH:sc.scrollHeight, plain, selected:window.__rm.textLen()};})()`);
  info('height/plain/selected', JSON.stringify(height));
  check(height.selected > height.plain * 0.98, 'select-all copy keeps every block (placeholder text is selectable)', `${height.selected} vs ${height.plain}`);

  // ---- 滚动覆盖 + 窗口迁移 ----
  const scan = async () => ev(`(async () => {
    const sc=vditor.vditor.preview.element, R=vditor.vditor.preview.previewElement, out=[];
    const total=sc.scrollHeight;
    for(let f=0;f<=1.0001;f+=0.08){
      sc.scrollTop=Math.min(sc.scrollHeight-sc.clientHeight, total*f);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const cov=window.__rm.coverage();
      out.push({f:+f.toFixed(2), top:Math.round(sc.scrollTop), mounted:cov.mounted, visible:cov.visible, slots:[...R.children].filter(n=>n.classList.contains('typora-read-slot')).length});
    }
    return out;})()`);
  const frames = await scan();
  const blanks = frames.filter(x => x.visible === 0);
  check(blanks.length === 0, 'no blank viewport at any scroll position', JSON.stringify(blanks));
  const maxMounted = Math.max(...frames.map(f => f.mounted));
  check(maxMounted < 120, 'mounted block count stays bounded while scrolling', `max=${maxMounted}`);
  info('scroll samples', JSON.stringify(frames.slice(0, 4)));
  await ev(`vditor.vditor.preview.element.scrollTop=0`);

  // ---- 大纲跳转 ----
  const outlineIds = await ev(`(() => {const e=vditor.vditor;
    const items=[...e.outline.element.querySelectorAll('li > span[data-target-id]')].slice(0,3).map(i=>i.getAttribute('data-target-id'));
    const heads=[...e.preview.previewElement.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0,3).map(h=>h.id||'(no id)');
    return {items, heads, outlineDisplay:getComputedStyle(e.outline.element).display};})()`);
  info('outline ids', JSON.stringify(outlineIds));
  const idProbe = await ev(`(() => { try {
    const e=vditor.vditor, b=window.vditor.__typoraReading.bounds;
    const items=[...e.outline.element.querySelectorAll('li > span[data-target-id]')];
    const pick=items[Math.floor(items.length*0.7)];
    const id=pick.getAttribute('data-target-id');
    const heads=(b?.surface||[]).filter(x=>x.kind==='heading');
    return {stats:window.vditor.__typoraReading.stats, id,
      byId:!!e.preview.previewElement.querySelector('#'+CSS.escape(id)),
      inDoc:!!document.getElementById(id),
      surfaceBlocks:b?.surface.length, editorBlocks:b?.editor.length, headingBlocks:heads.length,
      headingIds:heads.slice(0,3).map(x=>x.node?.id||'(none)'),
      headingIdsAtSuffix:[1735,1736].map(i=>heads[i]?.node?.id||'(none)'),
      domHeadings:e.preview.previewElement.querySelectorAll('h1,h2,h3,h4,h5,h6').length};
  } catch(error) { return {error:String(error)}; } })()`);
  info('id probe', JSON.stringify(idProbe));
  const parseSplit = await ev(`(async () => { try {
    const {markdownLocations} = await import('/render/js/markdown-locations.js');
    const {normalizeMathFences} = await import('/render/js/math-markdown.js');
    const md=vditor.getValue();
    const t0=performance.now(); const json=vditor.vditor.lute.RenderJSON(normalizeMathFences(md)); const t1=performance.now();
    const loc=markdownLocations(md, JSON.parse(json), {coarse:true}); const t2=performance.now();
    const t3=performance.now(); markdownLocations(md, JSON.parse(json), {coarse:true}); const t4=performance.now();
    return {renderJSONMs:+(t1-t0).toFixed(1), markdownLocationsMs:+(t2-t1).toFixed(1),
      markdownLocationsMs2:+(t4-t3).toFixed(1), blocks:loc.length};
  } catch(error) { return {error:String(error)}; } })()`);
  info('parse split', JSON.stringify(parseSplit));
  const deep = await ev(`(() => { try {
    const e=vditor.vditor;
    // 绑定表按需计算（正常路径在窗口化后自动算好）；这里先强制确保可用
    if(!window.vditor.__typoraReading.bounds) window.vditor.__typoraReading.bind();
    const stats0=window.vditor.__typoraReading.stats;
    const items=[...e.outline.element.querySelectorAll('li > span[data-target-id]')];
    if(!items.length) return {error:'no outline items'};
    const pick=items[Math.floor(items.length*0.7)];
    const before=Math.round(e.preview.element.scrollTop);
    pick.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    const sc=e.preview.element;
    const stats1=window.vditor.__typoraReading.stats;
    return {ok:true, count:items.length, before, got:Math.round(sc.scrollTop), bindMs:stats1.bindMs,
      jumps:stats1.jumps-stats0.jumps, misses:stats1.jumpMisses-stats0.jumpMisses,
      maxScroll:Math.round(sc.scrollHeight-sc.clientHeight), id:pick.getAttribute('data-target-id')};
  } catch(error) { return {error:String(error)}; } })()`);
  info('outline deep jump', JSON.stringify(deep));
  check(deep.ok && deep.got > 0 && deep.got < deep.maxScroll, 'outline jump scrolls the reading surface', JSON.stringify(deep));
  const outlineLanding = await ev(`window.__rm.coverage()`);
  check(outlineLanding.visible > 0, 'viewport is populated after an outline jump', JSON.stringify(outlineLanding));
  await ev(`vditor.vditor.preview.element.scrollTop=0`);

  // ---- 点击进编辑（视口内一个已挂载的块）----
  const clicked = await ev(`(() => { try {
    const e=vditor.vditor, sc=e.preview.element, R=e.preview.previewElement;
    sc.scrollTop=Math.min(sc.scrollHeight-sc.clientHeight, sc.scrollHeight*0.55);
    window.vditor.__typoraReading.update();
    const box=sc.getBoundingClientRect();
    const el=[...R.children].find(n=>!n.classList.contains('typora-read-slot')&&(()=>{const r=n.getBoundingClientRect();return r.top>box.top+40&&r.bottom<box.bottom-40&&r.height>20;})());
    if(!el) return {error:'no mounted block inside the viewport'};
    const r=el.getBoundingClientRect();
    // 记录这次点击应当落到哪个源码区间（用同一份绑定表独立复算）
    window.__rmSaved=window.vditor.__typoraReading.bounds;
    const cand=(window.__rmSaved?.surface||[]).filter(x=>x.node===el||el.contains(x.node));
    const target=cand[0];
    const frac=target?Math.max(0,Math.min(1,(r.top+r.height/2-r.top)/Math.max(1,r.height))):0;
    window.__rmExpect=target?{offset:Math.round(target.start+(target.end-target.start)*frac),start:target.start,end:target.end}:null;
    return {index:[...R.children].indexOf(el), tag:el.tagName, slot:false, expect:window.__rmExpect,
      x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), top:Math.round(r.top), h:Math.round(r.height)};
  } catch(error) { return {error:String(error)}; } })()`);
  info('click target', JSON.stringify(clicked));
  if (clicked.error) { check(false, 'a mounted block is clickable inside the viewport', clicked.error); }
  else {
  win.webContents.sendInputEvent({ type: 'mouseDown', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 });
  await sleep(900);
  const afterClick = await ev(`(() => {const e=vditor.vditor, sel=getSelection(), node=sel.focusNode;
    const root=e.ir.element;
    const el=node&&(node.nodeType===3?node.parentElement:node);
    const rect=(()=>{const r=sel.rangeCount?sel.getRangeAt(0).getBoundingClientRect():null;return r?{top:Math.round(r.top),bottom:Math.round(r.bottom)}:null;})();
    let block=null, index=-1;
    if(el){ for(let n=el;n&&n!==root;n=n.parentElement){ if(n.parentElement===root){block=n;break;} } if(block) index=[...root.children].indexOf(block); }
    // 用点击前的绑定表独立复算：光标所在编辑块是否覆盖"这次点击应落到"的源码区间
    const expect=window.__rmExpect, editor=window.__rmSaved?.editor||[];
    const hit=expect?editor.find(x=>x.node===node||(node&&x.node.contains(node))||x.node===el):null;
    const covers=!!(hit&&expect&&expect.offset>=hit.start&&expect.offset<=hit.end);
    return {reading:window.vditor.__typoraReading.active, editorDisplay:getComputedStyle(root.parentElement).display,
      collapsed:sel.isCollapsed, insideEditor:!!(node&&root.contains(node)), blockIndex:index,
      blockTag:block?block.tagName:null, rect, viewportBottom:window.innerHeight, expect,
      caretBlock:hit?{start:hit.start,end:hit.end}:null, covers};})()`);
  info('after click', JSON.stringify(afterClick));
  check(afterClick.reading === false, 'click exits reading mode', String(afterClick.reading));
  check(afterClick.editorDisplay !== 'none', 'editing pane restored after click', afterClick.editorDisplay);
  check(afterClick.collapsed && afterClick.insideEditor, 'caret placed inside the editor', JSON.stringify({c: afterClick.collapsed, i: afterClick.insideEditor}));
  check(afterClick.covers, 'caret lands on the source range that was clicked', JSON.stringify({expect: afterClick.expect, caretBlock: afterClick.caretBlock}));
  check(afterClick.rect && afterClick.rect.top > 0 && afterClick.rect.bottom < afterClick.viewportBottom, 'caret block scrolled into view', JSON.stringify(afterClick.rect));
  }

  // 编辑面完好：块数不变
  const afterExitNodes = await ev(`window.__rm.nodes()`);
  check(afterExitNodes.ir === nodes0.ir, 'editing DOM fully restored after click-to-edit', `${afterExitNodes.ir} vs ${nodes0.ir}`);
  check(afterExitNodes.slots === 0, 'no placeholders left behind', String(afterExitNodes.slots));

  // ---- 二次进出（稳定性）----
  const again = await ev(`window.vditor.__typoraReading.enter()`);
  check(again === true, 'second enter() works', String(again));
  check(await until(`window.vditor.__typoraReading.prepared`, 120000), 'second prepare completes', '');
  const nodes2 = await ev(`window.__rm.nodes()`);
  check(nodes2.mounted > 0 && nodes2.mounted < 120, 'second windowing is bounded too', `mounted=${nodes2.mounted}`);
  // Esc 退出
  await ev(`vditor.vditor.preview.element.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  const escExit = await ev(`(() => {const e=vditor.vditor;return {reading:window.vditor.__typoraReading.active,
    editorDisplay:getComputedStyle(e.ir.element.parentElement).display, slots:document.querySelectorAll('.typora-read-slot').length,
    readingClass:!!document.querySelector('.vditor.typora-reading')};})()`);
  check(escExit.reading === false && escExit.editorDisplay !== 'none' && escExit.slots === 0 && !escExit.readingClass,
    'Esc exits reading mode and cleans up', JSON.stringify(escExit));
  const nodes3 = await ev(`window.__rm.nodes()`);
  check(nodes3.ir === nodes0.ir && Math.abs(nodes3.total - nodes0.total) / nodes0.total < 0.01, 'DOM node counts return to baseline after exit', JSON.stringify({after: nodes3, before: nodes0}));
  await gc();
  const priv3 = priv();
  check(priv3 <= priv0 * 1.15, 'renderer privateBytes does not grow after a reading session', `${priv3} vs ${priv0}`);

  // ---- 外部重载（setValue）安全 ----
  await ev(`window.vditor.__typoraReading.enter()`);
  await sleep(1200);
  await ev(`window.__emitSetValue(${JSON.stringify('# 外部重载\n\n' + source.slice(0, 3000))})`);
  await sleep(1200);
  const reload = await ev(`(() => ({reading:window.vditor.__typoraReading.active, head:vditor.getValue().slice(0,12), slots:document.querySelectorAll('.typora-read-slot').length}))()`);
  check(reload.reading === false && reload.head.startsWith('# 外部重载') && reload.slots === 0, 'external reload exits reading mode safely', JSON.stringify(reload));

  // ---- 阅读会话之后，源码视图仍要能正常渲染预览面（退出时清空了预览 DOM）----
  await ev(`vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').click()`);
  await sleep(4000);
  const svState = await ev(`(() => {const e=vditor.vditor;return {mode:e.currentMode,
    previewChildren:e.preview.previewElement.childElementCount,
    previewDisplay:getComputedStyle(e.preview.element).display, reading:window.vditor.__typoraReading.active};})()`);
  check(svState.mode === 'sv' && svState.previewChildren > 0 && svState.previewDisplay !== 'none',
    'source view still renders its preview after a reading session', JSON.stringify(svState));
  await ev(`vditor.vditor.toolbar.elements['source-toggle'].querySelector('button').click()`);
  await sleep(1500);

  // ---- 控制台分级 ----
  const own = errors.filter(e => !/cdn\/vditor/.test(e));
  check(own.length === 0, 'no project-level console errors', JSON.stringify(own.slice(0, 3)));
  info('all errors', JSON.stringify(errors.slice(0, 5)));

  const passed = results.filter(r => r.ok).length;
  console.log(`\n== ${label}: ${passed}/${results.length} PASS, ${results.length - passed} FAIL ==`);
  fs.writeFileSync(path.join(output, `reading-mode-probe${process.env.RM_LABEL ? '-' + process.env.RM_LABEL : ''}.json`),
    JSON.stringify({fixture, label, results, errors, nodes: {baseline: nodes0, reading: nodes1}}, null, 2));
  win.destroy(); server.close(); app.exit(results.some(r => !r.ok) ? 1 : 0);
}
main().catch(e => { console.error('PROBE FAIL', e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
