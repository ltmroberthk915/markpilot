// 表格剪贴板矩阵（CSV 级矩形语义）：确定性载荷（合成 ClipboardEvent + 自建
// DataTransfer），真实按键 Ctrl+C/Ctrl+V 只做一处端到端验证。
// 运行：node_modules/electron/dist/electron.exe scripts/table-clipboard-probe.cjs
const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'app/renderer');
const output = path.join(project, '.perf');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'user-data-table-clip'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win;
const ev = code => win.webContents.executeJavaScript(code, true);
const until = async (code, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await ev(code)) return true; } catch { /* transient */ } await sleep(20); }
  return false;
};
const results = [];
const check = (ok, label, detail = '') => { results.push({ ok: !!ok, label, detail: String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail !== '' ? '  [' + detail + ']' : '')); };
const info = (label, detail) => console.log('INFO ' + label + ' = ' + detail);

const png = (() => {
  const w = 24, h = 12, raw = [];
  for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 4); for (let x = 0; x < w; x++) { const o = 1 + x * 4; row[o] = 200; row[o + 1] = 60 + y; row[o + 2] = 60; row[o + 3] = 255; } raw.push(row); }
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))), chunk('IEND', Buffer.alloc(0))]);
})();

const fixture = [
  '# 表格剪贴板矩阵', '',
  '## 普通表', '',
  '| col1 | col2 | col3 | col4 |',
  '| --- | --- | --- | --- |',
  '|  |  |  |  |',
  '|  |  |  |  |',
  '|  |  |  |  |',
  '',
  '## 富文本表', '',
  '| 名称 | 内容 |',
  '| --- | --- |',
  '| 普通 | 文本 **粗体** |',
  '| 公式 | $x_{1}+1$ |',
  '| 代码 | `const a=1` |',
  `| 图片 | ![表内图](data:image/png;base64,${png.toString('base64')}) |`,
  '| 留空 |  |',
  '', '结尾段。', '',
].join('\n');
const headerOnlyFixture = '# t\n\n| a | b |\n| --- | --- |\n';

const PAGE_HELPERS = `(() => {
  const cellText = cell => { const b=cell.cloneNode(true);
    b.querySelectorAll('.vditor-ir__preview,.vditor-wysiwyg__preview').forEach(n=>n.remove());
    return b.textContent.replaceAll('\\u200b','').trim(); };
  window.__t = {
    table: which => vditor.vditor.ir.element.querySelectorAll('table')[which],
    state: which => { const t=window.__t.table(which); return {rows:t.rows.length, shape:[...t.rows].map(r=>r.cells.length),
      cells:[...t.rows].map(r=>[...r.cells].map(cellText)),
      imgs:t.querySelectorAll('img').length, katex:t.querySelectorAll('.katex').length}; },
    selectCells: (which,r1,c1,r2,c2) => { const t=window.__t.table(which);
      const a=t.rows[r1].cells[c1], b=t.rows[r2].cells[c2];
      const range=document.createRange(); range.setStart(a,0); range.setEnd(b,b.childNodes.length);
      const s=getSelection(); s.removeAllRanges(); s.addRange(range);
      vditor.vditor.ir.element.focus({preventScroll:true}); return s.toString(); },
    selectInner: (which,r,c,from,to) => { const cell=window.__t.table(which).rows[r].cells[c];
      const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT); const nodes=[]; for(let n;n=walker.nextNode();)nodes.push(n);
      if(!nodes.length) return null; const target=nodes[0];
      const range=document.createRange(); range.setStart(target,Math.min(from,target.length)); range.setEnd(target,Math.min(to,target.length));
      const s=getSelection(); s.removeAllRanges(); s.addRange(range); vditor.vditor.ir.element.focus({preventScroll:true}); return s.toString(); },
    caretAt: (which,r,c) => { const cell=window.__t.table(which).rows[r].cells[c];
      const range=document.createRange(); range.selectNodeContents(cell); range.collapse(true);
      const s=getSelection(); s.removeAllRanges(); s.addRange(range); vditor.vditor.ir.element.focus({preventScroll:true}); return true; },
    copy: () => { const dt=new DataTransfer();
      const event=new ClipboardEvent('copy',{clipboardData:dt,bubbles:true,cancelable:true});
      vditor.vditor.ir.element.dispatchEvent(event);
      return {prevented:event.defaultPrevented, html:dt.getData('text/html'), text:dt.getData('text/plain')}; },
    paste: (which,r,c,payload) => { const cell=window.__t.table(which).rows[r].cells[c];
      const range=document.createRange(); range.selectNodeContents(cell); range.collapse(true);
      const s=getSelection(); s.removeAllRanges(); s.addRange(range); vditor.vditor.ir.element.focus({preventScroll:true});
      const dt=new DataTransfer(); if(payload&&payload.html)dt.setData('text/html',payload.html); if(payload&&payload.text)dt.setData('text/plain',payload.text);
      const event=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});
      vditor.vditor.ir.element.dispatchEvent(event);
      return {prevented:event.defaultPrevented}; },
    setValue: value => vditor.setValue(value),
    tableCount: () => vditor.vditor.ir.element.querySelectorAll('table').length,
    firstCellState: () => { const t=vditor.vditor.ir.element.querySelector('table');
      return {rows:t.rows.length, shape:[...t.rows].map(r=>r.cells.length), cells:[...t.rows].map(r=>[...r.cells].map(cellText))}; },
  };
})()`;

async function main() {
  const savedText = clipboard.readText();
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    let file = null;
    if (url.pathname.startsWith('/render/')) file = path.join(renderer, decodeURIComponent(url.pathname.slice(8)));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' })[ext] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false, spellcheck: false } });
  win.showInactive();
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  await until('window.__ready', 30000);
  const helpersResult = await ev(PAGE_HELPERS).catch(error => 'ERR ' + error.message);
  info('page helpers', String(helpersResult));
  info('page errors', JSON.stringify(errors.slice(0, 3)));
  info('step','open');
  await ev(`__open(${JSON.stringify(fixture)})`);
  info('step','opened');
  await until('window.vditor?.vditor?.__typoraPatched', 30000);
  await until('!window.__typoraMathStats?.pending', 30000);
  await sleep(150);

  const state = which => ev(`window.__t.state(${which})`);
  const key = async (k, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers });
    if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers });
    await sleep(70);
  };
  const copyRegion = async (which, r, c, r2, c2) => {
    await ev(`window.__t.selectCells(${which},${r},${c},${r2},${c2})`);
    return ev(`window.__t.copy()`);
  };
  const pasteAt = async (which, r, c, payload) => {
    const out = await ev(`window.__t.paste(${which},${r},${c},${JSON.stringify(payload)})`);
    await until('!window.__typoraMathStats?.pending', 8000);
    await sleep(80);
    return out;
  };
  const reset = async () => {
    try {
      await ev(`window.__t.setValue(${JSON.stringify(fixture)})`);
      await until('window.__t.tableCount()===2', 20000);
      await until('!window.__typoraMathStats?.pending', 20000);
      await sleep(60);
    } catch (error) { info('reset failed', String(error)); }
  };
  const payloadInfo = p => `prevented=${p.prevented} text=${JSON.stringify((p.text || '').slice(0, 90))} html=${(p.html || '').replace(/\s+/g, ' ').slice(0, 110)}`;

  /* ---------- D7 只有表头的表：粘贴要自己长出正文行 ---------- */
  info('step','d7-setValue');
  await ev(`window.__t.setValue(${JSON.stringify(headerOnlyFixture)})`);
  info('step','d7-setValue-done');
  await until('window.__t.tableCount()===1', 8000);
  await sleep(150);
  await ev(`(() => {const cell=vditor.vditor.ir.element.querySelector('table').rows[0].cells[0];
    const range=document.createRange();range.selectNodeContents(cell);range.collapse(true);
    const s=getSelection();s.removeAllRanges();s.addRange(range);vditor.vditor.ir.element.focus({preventScroll:true});
    const dt=new DataTransfer();dt.setData('text/plain',${JSON.stringify('x1\ty1\r\nx2\ty2\r\n')});
    vditor.vditor.ir.element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
  await sleep(220);
  const headerOnly = await ev(`window.__t.firstCellState()`);
  info('D7 header-only table', JSON.stringify(headerOnly));
  check(headerOnly.rows === 2 && headerOnly.shape.every(width => width === 2) && headerOnly.cells[1][1] === 'y2',
    'D7 a header-only table grows a body row for the payload', JSON.stringify(headerOnly));

  await reset();
  const base0 = await state(0), base1 = await state(1);
  info('baseline table0', JSON.stringify({ rows: base0.rows, shape: base0.shape, cells: base0.cells }));
  info('baseline table1', JSON.stringify({ rows: base1.rows, shape: base1.shape, katex: base1.katex, imgs: base1.imgs }));

  /* ---------- C1 表头整行 → 载荷是单行 TSV ---------- */
  let p = await copyRegion(0, 0, 0, 0, 3);
  info('C1 row copy payload', payloadInfo(p));
  check(p.prevented, 'C1 copy of a full row is intercepted', String(p.prevented));
  check(p.text === 'col1\tcol2\tcol3\tcol4', 'C1 payload text is TSV with one line per row', JSON.stringify(p.text));
  check(/<table[\s\S]*<t[rd][\s\S]*col1/.test(p.html), 'C1 payload html keeps a real table', (p.html || '').slice(0, 80));

  /* ---------- C2 前两格 → 两列（不再并成一格） ---------- */
  p = await copyRegion(0, 0, 0, 0, 1);
  info('C2 two-cell copy payload', payloadInfo(p));
  check(p.prevented, 'C2 copy of a partial-cell range is intercepted', String(p.prevented));
  check(p.text === 'col1\tcol2', 'C2 payload text keeps the two columns', JSON.stringify(p.text));

  /* ---------- C3 2×2 块 → 2×2 矩形 ---------- */
  p = await copyRegion(0, 0, 0, 1, 1);
  info('C3 2x2 copy payload', payloadInfo(p));
  check(p.text === 'col1\tcol2\r\n\t', 'C3 payload text is a 2x2 rectangle', JSON.stringify(p.text));

  /* ---------- C4 整表 → 每行一行文本 ---------- */
  await ev(`(() => {const t=window.__t.table(0),s=getSelection(),r=document.createRange();r.selectNodeContents(t);s.removeAllRanges();s.addRange(r);vditor.vditor.ir.element.focus({preventScroll:true});})()`);
  p = await ev(`window.__t.copy()`);
  info('C4 whole-table copy payload', payloadInfo(p));
  check(p.prevented && p.text.split('\r\n').length === base0.rows, 'C4 whole-table payload has one text line per row',
    `lines=${p.text.split('\r\n').length} rows=${base0.rows}`);

  /* ---------- C5 外部 TSV → 矩形 ---------- */
  await pasteAt(0, 1, 0, { text: 'a1\tb1\tc1\r\n2\t3\t4\r\n' });
  let s0 = await state(0);
  info('C5 after external TSV paste', JSON.stringify(s0.cells));
  check(JSON.stringify(s0.cells[1]) === JSON.stringify(['a1', 'b1', 'c1', '']) && JSON.stringify(s0.cells[2]) === JSON.stringify(['2', '3', '4', '']),
    'C5 external TSV fills a rectangle', JSON.stringify(s0.cells.slice(1, 3)));
  check(s0.rows === base0.rows, 'C5 external TSV does not change the row count', `rows=${s0.rows} (was ${base0.rows})`);

  /* ---------- C6 矩形复制 → 落到别处的矩形 ---------- */
  await reset();
  await pasteAt(0, 1, 0, { text: 'A\tB\r\nC\tD\r\n' });
  p = await copyRegion(0, 1, 0, 2, 1);
  await pasteAt(0, 3, 2, { html: p.html, text: p.text });
  s0 = await state(0);
  info('C6 after rectangle paste', JSON.stringify(s0.cells));
  check(JSON.stringify(s0.cells[3].slice(2, 4)) === JSON.stringify(['A', 'B']) && JSON.stringify(s0.cells[4].slice(2, 4)) === JSON.stringify(['C', 'D']),
    'C6 rectangle paste lands cell by cell at the caret', JSON.stringify(s0.cells.slice(3, 5)));

  /* ---------- C7 表头整行粘到下一行：不多出一行 ---------- */
  await reset();
  p = await copyRegion(0, 0, 0, 0, 3);
  await pasteAt(0, 1, 0, { html: p.html, text: p.text });
  s0 = await state(0);
  info('C7 after header-row paste', JSON.stringify({ rows: s0.rows, cells: s0.cells.slice(0, 3) }));
  check(s0.rows === base0.rows, 'C7 pasting a header row does not add a blank row', `rows=${s0.rows}`);
  check(JSON.stringify(s0.cells[1]) === JSON.stringify(['col1', 'col2', 'col3', 'col4']),
    'C7 header row fills the target row cell by cell', JSON.stringify(s0.cells[1]));

  /* ---------- C8 富文本列（公式/代码/图片）复制粘贴 ---------- */
  await reset();
  const richBefore = await state(1);
  p = await copyRegion(1, 1, 1, 4, 1);
  info('C8 rich copy payload', payloadInfo(p));
  await pasteAt(1, 5, 0, { html: p.html, text: p.text });
  const richAfter = await state(1);
  info('C8 rich after', JSON.stringify({ rows: richAfter.rows, katex: richAfter.katex, imgs: richAfter.imgs }));
  check(richAfter.katex >= richBefore.katex + 1, 'C8 pasted formula renders again', `${richBefore.katex} -> ${richAfter.katex}`);
  check(richAfter.imgs >= richBefore.imgs + 1, 'C8 pasted image survives', `${richBefore.imgs} -> ${richAfter.imgs}`);

  /* ---------- C9 格内部分文字 → 不建表 ---------- */
  await reset();
  await pasteAt(0, 1, 0, { text: 'abcdef' });
  await ev(`window.__t.selectInner(0,1,0,0,2)`);
  p = await ev(`window.__t.copy()`);
  info('C9 inner-text copy payload', payloadInfo(p));
  await pasteAt(0, 3, 0, { html: p.html, text: p.text });
  s0 = await state(0);
  check(s0.rows === base0.rows, 'C9 copying text inside one cell does not build a table', `rows=${s0.rows}`);

  /* ---------- C10 真按键 Ctrl+C/Ctrl+V 端到端 ---------- */
  await reset();
  await sleep(200);
  await ev(`window.__t.selectCells(0,0,0,0,3)`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
  await sleep(140);
  await ev(`window.__t.caretAt(0,3,0)`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
  await sleep(220);
  s0 = await state(0);
  info('C10 real-key roundtrip row3', JSON.stringify(s0.cells[3]));
  check(JSON.stringify(s0.cells[3]) === JSON.stringify(['col1', 'col2', 'col3', 'col4']), 'C10 real Ctrl+C/Ctrl+V roundtrip fills the row', JSON.stringify(s0.cells[3]));

  /* ---------- D1 多格选区 + Delete：整格清空，不改形状 ---------- */
  await reset();
  await pasteAt(0, 1, 0, { text: 'a\tb\tc\td\r\ne\tf\tg\th\r\n' });
  await ev(`window.__t.selectCells(0,1,0,2,1)`);
  await key('Delete');
  s0 = await state(0);
  info('D1 after multi-cell delete', JSON.stringify(s0.cells.slice(1, 3)));
  check(s0.rows === 4 && JSON.stringify(s0.shape) === JSON.stringify([4, 4, 4, 4]),
    'D1 Delete over a multi-cell selection keeps the table shape', JSON.stringify({ rows: s0.rows, shape: s0.shape }));
  check(s0.cells[1][0] === '' && s0.cells[1][1] === '' && s0.cells[2][0] === '' && s0.cells[2][1] === '' &&
    s0.cells[1][2] === 'c' && s0.cells[2][2] === 'g',
    'D1 Delete clears exactly the selected cells', JSON.stringify(s0.cells.slice(1, 3)));

  /* ---------- D2 多格选区内打字：清空选区，字符落在首格 ---------- */
  await reset();
  await pasteAt(0, 1, 0, { text: 'a\tb\tc\td\r\ne\tf\tg\th\r\n' });
  await ev(`window.__t.selectCells(0,1,0,2,1)`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z' });
  await until('!window.__typoraMathStats?.pending', 8000);
  await sleep(120);
  s0 = await state(0);
  info('D2 after typing over a multi-cell selection', JSON.stringify(s0.cells.slice(1, 3)));
  check(s0.rows === 4 && s0.cells[1][0] === 'Z' && s0.cells[1][1] === '' && s0.cells[2][0] === '' && s0.cells[1][2] === 'c',
    'D2 typing replaces the whole selection inside the first cell', JSON.stringify(s0.cells.slice(1, 3)));

  /* ---------- D3 整格单选 → 1×1 矩形 ---------- */
  await reset();
  await pasteAt(0, 1, 0, { text: 'solo' });
  p = await copyRegion(0, 1, 0, 1, 0);
  info('D3 single-cell payload', payloadInfo(p));
  check(p.prevented && p.text === 'solo' && p.html.includes('<table'), 'D3 a whole single cell copies as a 1x1 rectangle', JSON.stringify(p.text));
  await pasteAt(0, 3, 2, { html: p.html, text: p.text });
  s0 = await state(0);
  check(s0.cells[3][2] === 'solo', 'D3 1x1 payload pastes into the caret cell', JSON.stringify(s0.cells[3]));

  /* ---------- D4 跨表选区 → 不接管 ---------- */
  await reset();
  await ev(`(() => {const t0=window.__t.table(0),t1=window.__t.table(1);const a=t0.rows[1].cells[0],b=t1.rows[1].cells[0];
    const r=document.createRange();r.setStart(a,0);r.setEnd(b,b.childNodes.length);
    const s=getSelection();s.removeAllRanges();s.addRange(r);vditor.vditor.ir.element.focus({preventScroll:true});})()`);
  p = await ev(`window.__t.copy()`);
  info('D4 cross-table payload', payloadInfo(p));
  check(!(p.html || '').includes('<table'), 'D4 a cross-table selection is not rewritten into one table', (p.html || '').slice(0, 60));

  /* ---------- D5 右下角越界粘贴：行列一起长 ---------- */
  await reset();
  await pasteAt(0, 2, 2, { text: '1\t2\t3\t4\t5\r\n6\t7\t8\t9\t10\r\n11\t12\t13\t14\t15\r\n' });
  s0 = await state(0);
  info('D5 after row+column growth', JSON.stringify({ rows: s0.rows, shape: s0.shape }));
  check(s0.rows === 5 && s0.shape.every(width => width === 7),
    'D5 pasting past the corner grows rows and columns together', JSON.stringify({ rows: s0.rows, shape: s0.shape }));
  check(s0.cells[4][6] === '15', 'D5 the last payload cell lands in the grown corner', JSON.stringify(s0.cells[4]));

  info('console errors', JSON.stringify(errors.slice(0, 5)));
  const passed = results.filter(r => r.ok).length;
  console.log(`\n== table clipboard probe: ${passed}/${results.length} PASS, ${results.length - passed} FAIL ==`);
  fs.writeFileSync(path.join(output, 'table-clipboard-probe.json'), JSON.stringify({ results, errors, baseline: { table0: base0, table1: base1 } }, null, 2));
  clipboard.writeText(typeof savedText === 'string' ? savedText : '');
  win.destroy(); server.close(); app.exit(results.some(r => !r.ok) ? 1 : 0);
}
main().catch(e => { console.error('FAIL', e); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
