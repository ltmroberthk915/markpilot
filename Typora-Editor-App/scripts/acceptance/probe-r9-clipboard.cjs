/** 探针 · R9 补验 K1/K2（剪贴板域，挂起自 R3；2026-10-03 只取证不改产品）。
 *
 *  判决来源：E:/MarkPilot/.zcode-tmp/round3-findings.md「K 剪贴板/粘贴」——
 *   · K1 高：富文本粘贴的嵌入图片从不归档，存盘写成临时文件伪 URL（Word/Outlook
 *     图+字 → msohtmlclip 临时路径/cid:，源程序清缓存后永久断链）。验证口径：
 *     模拟 Word 的 CF_HTML（img src=file:///临时路径）→ Ctrl+V → Ctrl+S →
 *     看存盘 md 的 img src 与 embedded-images/ 目录。归档（src 落进文档自带的
 *     embedded-images 且文件存在）= PASS；仍是临时路径/伪 CDN 域名 = FAIL。
 *     附 K1b：cid: 形态（Outlook 无本地文件）同流程取证。
 *   · K2 高：跨格矩形选区上粘贴不走矩形落位（pasteCellText 一票否决），vendor
 *     线性删 → 并格毁表。验证口径：3×3 表真鼠标拖出 2×2 选区 → 系统剪贴板
 *     写入 2×2 TSV → Ctrl+V → 看表格结构（行列数/colspan/rowspan）与各格文本。
 *     表形完好且 2×2 区域按矩形语义改写 = PASS；并格/掉格/colspan = FAIL。
 *
 *  通道纪律（铁律）：全部真实输入——CDP Input.dispatchKeyEvent/dispatchMouseEvent，
 *  组合键走 hi.combo（修饰键真实按下再抬起）；粘贴内容一律由独立进程写进
 *  **系统剪贴板**（本探针自带 CF_HTML 写入器，clipboard.ps1 只读不写 html），
 *  产品自报不作数；磁盘 md 为最终判据。剪贴板纪律：开头 harness.saveClipboard、
 *  结束（含异常）restoreClipboard。每轮读数前断言焦点在编辑器内。
 *  截图：整页 + 关键处 2x 放大；标记口径沿用：红实线＝光标落点、琥珀虚线＝期望位、
 *  青虚线＝实际落点（CDP 抓帧拍不到原生光标，按浏览器自报矩形画）。
 *
 *  用法：node scripts/acceptance/probe-r9-clipboard.cjs [--only=k1,k1b,k2]
 *        （跑前 dev 树即 app/renderer 现状；不与其它 GUI 探针并行——铁律 3。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const fixtures = require('./fixtures.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r9-clipboard');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF, S = hi.SURFACE;

// ─── 文档 ────────────────────────────────────────────────────────────────────
const DOC_K1 = ['# R9K1 富文本粘贴归档', '',
  'K1靶点段：文字粘在前，图应落此段之后。', '',
  'K1b靶点段：cid 形态的落点。', '',
  '尾段：收尾。', ''].join('\n');

const DOC_K2 = ['# R9K2 跨格粘贴', '',
  '| K2甲 | K2乙 | K2丙 |', '| --- | --- | --- |',
  '| 甲1 | 乙1 | 丙1 |', '| 甲2 | 乙2 | 丙2 |', '| 甲3 | 乙3 | 丙3 |', ''].join('\n');

// ─── CF_HTML 写入器（PowerShell，运行时生成；ASCII-only，PowerShell 5.1 口径） ──
const SET_CLIP_PS1 = [
  'param([string]$HtmlFile = \'\', [string]$TextFile = \'\')',
  '$ErrorActionPreference = \'Stop\'',
  'Add-Type -AssemblyName System.Windows.Forms',
  "Add-Type -Namespace Acc9 -Name Clip -MemberDefinition @'",
  '[DllImport("user32.dll", SetLastError=true)] public static extern uint RegisterClipboardFormat(string format);',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool EmptyClipboard();',
  '[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetClipboardData(uint format, IntPtr hMem);',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalLock(IntPtr handle);',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GlobalUnlock(IntPtr handle);',
  "'@",
  '$html = [System.IO.File]::ReadAllBytes($HtmlFile)',
  '$text = [System.IO.File]::ReadAllText($TextFile, (New-Object System.Text.UTF8Encoding($false)))',
  'function Put-Block([uint32]$format, [byte[]]$bytes) {',
  '  $h = [Acc9.Clip]::GlobalAlloc(0x0002, [UIntPtr]::new($bytes.Length))',
  '  if ($h -eq [IntPtr]::Zero) { throw \'GlobalAlloc failed\' }',
  '  $p = [Acc9.Clip]::GlobalLock($h)',
  '  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)',
  '  [void][Acc9.Clip]::GlobalUnlock($h)',
  '  if ([Acc9.Clip]::SetClipboardData($format, $h) -eq [IntPtr]::Zero) { throw \'SetClipboardData failed\' }',
  '}',
  'if (-not [Acc9.Clip]::OpenClipboard([IntPtr]::Zero)) { throw \'OpenClipboard failed\' }',
  'try {',
  '  [void][Acc9.Clip]::EmptyClipboard()',
  '  $uformat = [Acc9.Clip]::RegisterClipboardFormat(\'HTML Format\')',
  '  Put-Block $uformat $html',
  '  $uni = [System.Text.Encoding]::Unicode.GetBytes($text + [char]0)',
  '  Put-Block 13 $uni',
  '} finally { [void][Acc9.Clip]::CloseClipboard() }',
  'Write-Output \'set-html-ok\'',
].join('\r\n');

/** CF_HTML 载荷（ASCII 内容，字符偏移==字节偏移）。 */
function cfHtml(inner) {
  const body = '<html><body>\r\n<!--StartFragment-->' + inner + '<!--EndFragment-->\r\n</body></html>';
  const head = 'Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n';
  const z = 10; // 偏移字段宽
  const pad = n => String(n).padStart(z, '0');
  const startHtml = head.length;
  const frag = body.indexOf('<!--StartFragment-->') + '<!--StartFragment-->'.length;
  const fragEnd = body.indexOf('<!--EndFragment-->');
  const header = 'Version:0.9\r\nStartHTML:' + pad(startHtml) + '\r\nEndHTML:' + pad(startHtml + body.length)
    + '\r\nStartFragment:' + pad(startHtml + frag) + '\r\nEndFragment:' + pad(startHtml + fragEnd) + '\r\n';
  return header + body;
}

/** 把 CF_HTML + 纯文本写进系统剪贴板（独立进程，独立通道）。 */
function setRichClipboard(dir, htmlInner, plainText) {
  const ps1 = path.join(dir, 'set-clipboard-html.ps1');
  if (!fs.existsSync(ps1)) fs.writeFileSync(ps1, SET_CLIP_PS1, 'utf8');
  const htmlFile = path.join(dir, 'cfhtml-' + Date.now() + '.bin');
  const textFile = path.join(dir, 'cftext-' + Date.now() + '.txt');
  fs.writeFileSync(htmlFile, cfHtml(htmlInner), 'utf8');
  fs.writeFileSync(textFile, plainText, 'utf8');
  const out = require('node:child_process').execFileSync(harness.POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-HtmlFile', htmlFile, '-TextFile', textFile],
    { encoding: 'utf8', windowsHide: true });
  return String(out).trim();
}

// ─── 页内读数 ────────────────────────────────────────────────────────────────
const inIF = expression => `(() => { const frame = document.getElementById('editor'); const w = frame && frame.contentWindow;
  const doc = w && w.document; if (!doc || !w.vditor) return { none: true };
  return (${expression}); })()`;
const ev = (session, expression) => session.js(inIF(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);

/** 页内标记：矩形虚线框（color/dash）+ 光标竖线（红实线）。 */
const MARK_INSTALL = inIF(`(() => {
  window.__r9 = { mark(list) {
    const old = document.getElementById('__r9_marks'); if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = document.createElement('div'); layer.id = '__r9_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const it of list) { if (!it) continue;
      const d = document.createElement('div');
      if (it.type === 'line') d.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:2px;height:' + Math.max(2, it.h || 18) + 'px;background:' + it.color;
      else d.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:' + Math.round(it.w) + 'px;height:' + Math.round(it.h) + 'px;border:1.5px dashed ' + it.color;
      if (it.label) { const t = document.createElement('div'); t.textContent = it.label;
        t.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;left:' + (Math.round(it.x) + 4) + 'px;top:' + (Math.round(it.y) - 14) + 'px;color:' + it.color; layer.appendChild(t); }
      layer.appendChild(d); }
    document.body.appendChild(layer); return list.length; },
    unmark() { const old = document.getElementById('__r9_marks'); if (old) old.remove(); return 1; } };
  return { ok: true }; })()`);
const mark = (session, list) => session.js(inIF(`window.__r9.mark(${JSON.stringify(list)})`));
const unmark = session => session.js(inIF('window.__r9.unmark()'));

/** 整页 + 关键处 2x 放大（anchor 为 iframe 内坐标）。 */
async function shots(session, frame, name, anchor) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor ? anchor.x : 300) - 260),
      y: frame.y + Math.max(0, (anchor ? anchor.y : 300) - 70), width: 600, height: 200, scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

/** 全部图片的事实（src/显示状态/几何）。 */
const IMG_FACTS = `(() => { const root = doc.querySelector(${JSON.stringify(S)}); if (!root) return { none: true };
  const fr = frame.getBoundingClientRect();
  return [...root.querySelectorAll('img')].map(img => { const r = img.getBoundingClientRect();
    return { src: String(img.getAttribute('src')).slice(0, 200), alt: img.alt || '',
      complete: !!img.complete, nw: img.naturalWidth, nh: img.naturalHeight,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }); })()`;

/** 表格事实：行列、colspan/rowspan、每格文本。 */
const TABLE_FACTS = `(() => { const root = doc.querySelector(${JSON.stringify(S)}); if (!root) return { none: true };
  const table = root.querySelector('table'); if (!table) return { 表格数: 0 };
  return { 表格数: root.querySelectorAll('table').length,
    行数: table.rows.length,
    每行格数: [...table.rows].map(row => row.cells.length),
    跨格: [...table.querySelectorAll('td,th')].filter(c => (c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1).map(c => ({ text: c.textContent.slice(0, 12), colSpan: c.colSpan, rowSpan: c.rowSpan })),
    格文: [...table.rows].map(row => [...row.cells].map(c => String(c.textContent).slice(0, 16))) }; })()`;

/** 选区事实（是否跨格）。 */
const SEL_FACTS = `(() => { const s = w.getSelection(); if (!s || !s.rangeCount) return { 无选区: true };
  const r = s.getRangeAt(0); const cellOf = n => { const at = n.nodeType === 3 ? n.parentElement : n; const c = at && at.closest && at.closest('td,th'); return c ? (c.cellIndex + ',' + c.parentElement.rowIndex) : null; };
  return { 折叠: r.collapsed, 长度: s.toString().length, 选文: s.toString().slice(0, 40),
    anchor格: cellOf(s.anchorNode), focus格: cellOf(s.focusNode),
    端点连接: !!(r.startContainer.isConnected && r.endContainer.isConnected) }; })()`;

/** Ctrl+S 真按键并等磁盘变化（不做 API 兜底——就是要测按键这条链）。 */
async function keySave(session, file, { timeout = 8000 } = {}) {
  const before = fs.readFileSync(file, 'utf8');
  await hi.combo(session, 'Ctrl+S');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await harness.sleep(120);
    if (fs.readFileSync(file, 'utf8') !== before) return { saved: true, waitedMs: Date.now() - started };
  }
  return { saved: false, waitedMs: Date.now() - started };
}

const mdAround = (md, key, span) => { const s = String(md || ''); const at = s.indexOf(key);
  return at >= 0 ? s.slice(Math.max(0, at - 10), at + (span || 120)) : s.slice(0, 80); };
const listDir = dir => { try { return fs.readdirSync(dir); } catch { return null; } };

// ─── K1：Word 式 CF_HTML（file:/// 临时路径图）粘贴归档 ────────────────────────
async function caseK1(session, env) {
  const file = env.file, dir = path.dirname(file);
  const frame = await frameOf(session);
  // 造一张真 PNG 当"Word 临时目录里的图"
  const simDir = path.join(OUT, 'k1', 'msohtmlclip101');
  fs.mkdirSync(simDir, { recursive: true });
  const pngPath = path.join(simDir, 'clip_image002.png');
  fs.writeFileSync(pngPath, fixtures.png(96, 64, [200, 60, 30]));
  const pngUrl = pngPath.replace(/\\/g, '/');
  const htmlInner = '<p style="margin:0in">WordK1 alpha paragraph.</p>'
    + '<p style="margin:0in"><img width="96" height="64" src="file:///' + pngUrl + '"></p>'
    + '<p style="margin:0in">WordK1 gamma paragraph.</p>';
  const setOut = setRichClipboard(OUT, htmlInner, 'WordK1 alpha paragraph.\r\nWordK1 gamma paragraph.');

  // 焦点 + 真点击落点段
  const focus = await hi.ensureFocus(session);
  const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => b.textContent.includes('K1靶点段'));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 30), y: Math.round(fr.y + r.top + r.height / 2), bx: Math.round(r.x), by: Math.round(r.y) }; })()`);
  if (!point) return { verdict: 'FAIL', detail: { 错: '找不到 K1靶点段' } };
  await session.click(point.x, point.y);
  await harness.sleep(300);
  await session.key({ key: 'End', code: 'End', vk: 35 });
  await harness.sleep(250);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '焦点不在编辑器', focus: focusOK } };

  const imgsBefore = await ev(session, IMG_FACTS);
  await hi.combo(session, 'Ctrl+V');   // 组合键：修饰键真实按下再抬起
  // 等图出现（或超时）
  let imgsAfter = imgsBefore;
  for (let i = 0; i < 30; i++) {
    await harness.sleep(150);
    imgsAfter = await ev(session, IMG_FACTS);
    if (imgsAfter && imgsAfter.length > (imgsBefore || []).length) break;
  }
  const pastedImg = (imgsAfter || []).find(img => /msohtmlclip|clip_image|vscode-cdn|WordK1/i.test(img.src)) || (imgsAfter || [])[0] || null;
  await shots(session, frame, 'K1-粘贴后', pastedImg ? { x: pastedImg.x, y: pastedImg.y } : point);

  // 存盘（真 Ctrl+S）→ 磁盘 md + embedded-images
  const save = await keySave(session, file);
  await harness.sleep(400);
  const md = fs.readFileSync(file, 'utf8');
  const embDir = path.join(dir, 'embedded-images');
  const emb = listDir(embDir);

  const srcInMd = (md.match(/!\[[^\]]*\]\(([^)]+)\)/g) || []).map(s => s.replace(/!\[[^\]]*\]\(/, '').replace(/\)$/, ''));
  // 归档判据：src 相对指向本文档 embedded-images/<文件> 且该文件真存在
  const archived = srcInMd.some(src => {
    const rel = String(src).replace(/\\/g, '/');
    const hit = /embedded-images\/([^/?#]+)/.exec(rel);
    return !!hit && fs.existsSync(path.join(dir, 'embedded-images', hit[1]));
  });
  const verdict = save.saved && archived ? 'PASS' : 'FAIL';
  return { verdict, detail: {
    剪贴板写入: setOut,
    图事实: pastedImg, 图总数: { 前: (imgsBefore || []).length, 后: (imgsAfter || []).length },
    存盘: save,
    md图片src: srcInMd.map(s => s.slice(0, 160)),
    md上下文: mdAround(md, '!['),
    embedded目录: emb,
    判据: 'src 落 embedded-images 且文件存在=归档；临时路径/伪CDN=断链', } };
}

// ─── K1b：cid: 形态（Outlook，无本地文件） ────────────────────────────────────
async function caseK1b(session, env) {
  const file = env.file;
  const frame = await frameOf(session);
  const htmlInner = '<p style="margin:0in">WordK1b cid paragraph.</p>'
    + '<p style="margin:0in"><img width="96" height="64" src="cid:image007.png@01D20000.0000ABCD"></p>';
  setRichClipboard(OUT, htmlInner, 'WordK1b cid paragraph.');
  const focus = await hi.ensureFocus(session);
  const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => b.textContent.includes('K1b靶点段'));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 30), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!point) return { verdict: 'FAIL', detail: { 错: '找不到 K1b靶点段' } };
  await session.click(point.x, point.y);
  await harness.sleep(300);
  await session.key({ key: 'End', code: 'End', vk: 35 });
  await harness.sleep(250);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '焦点不在编辑器', focus: focusOK } };
  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(1200);
  const imgs = await ev(session, IMG_FACTS);
  const mdNow = String(await hi.mdNow(session) || '');
  const save = await keySave(session, file);
  const md = fs.readFileSync(file, 'utf8');
  await shots(session, frame, 'K1b-粘贴后', point);
  return { verdict: 'EVIDENCE', detail: {
    图事实: imgs, getValue图片行: mdAround(mdNow, 'cid'), 存盘: save,
    磁盘cid出现: (md.split('cid:').length - 1), md图片src: (md.match(/!\[[^\]]*\]\([^)]+\)/g) || []).map(s => s.slice(0, 120)),
    定性: 'cid 图无可归档字节——记录落盘形态（断链占位 vs 丢弃），供口径裁决', } };
}

// ─── K2：跨格 2×2 选区上粘贴 TSV ─────────────────────────────────────────────
async function caseK2(session, env) {
  const file = env.file;
  const frame = await frameOf(session);
  await hi.ensureFocus(session);
  const facts0 = await ev(session, TABLE_FACTS);
  if (!facts0 || facts0.表格数 !== 1) return { verdict: 'FAIL', detail: { 错: '没找到表格', facts0 } };
  // 表格滚进视口（探针 setup，允许 JS 滚动；输入动作仍走真实通道）
  await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)}); root.querySelector('table').scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`);
  await harness.sleep(300);

  // 四个角格中心（顶层页坐标）——拖 2×2：从 甲1 拖到 乙2
  const cells = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)}); const table = root.querySelector('table');
    const fr = frame.getBoundingClientRect(); const out = {};
    for (const [name, row, col] of [['甲1', 1, 0], ['乙1', 1, 1], ['甲2', 2, 0], ['乙2', 2, 1], ['丙3', 3, 2]]) {
      const cell = table.rows[row].cells[col]; const r = cell.getBoundingClientRect();
      out[name] = { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2),
        ix: Math.round(r.x), iy: Math.round(r.top), iw: Math.round(r.width), ih: Math.round(r.height) }; }
    return out; })()`);
  if (!cells || !cells.甲1) return { verdict: 'FAIL', detail: { 错: '格坐标没取到', cells } };

  // 真拖拽：甲1 → 乙2（按下 → 多次移动 → 抬起）
  await hi.drag(session, { x: cells.甲1.x, y: cells.甲1.y }, { x: cells.乙2.x, y: cells.乙2.y }, { steps: 10, interval: 35 });
  const sel = await ev(session, SEL_FACTS);
  if (!sel || sel.折叠 || !sel.anchor格 || !sel.focus格) return { verdict: 'FAIL', detail: { 错: '2×2 拖选没成立', sel } };

  // 系统剪贴板写 2×2 TSV（独立进程）
  harness.writeClipboard(OUT, 'P11\tP12\nP21\tP22');
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '粘贴前焦点不在编辑器', focus: focusOK } };
  await shots(session, frame, 'K2-拖选后', { x: cells.乙1.x, y: cells.乙1.y });

  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(900);
  const facts1 = await ev(session, TABLE_FACTS);
  const caret = await hi.caret(session);
  await shots(session, frame, 'K2-粘贴后', { x: cells.乙1.x, y: cells.乙1.y });

  // 存盘 → 磁盘表
  const save = await keySave(session, file);
  await harness.sleep(400);
  const md = fs.readFileSync(file, 'utf8');
  const tableLines = (md.match(/^\|.*$/gm) || []);

  // 判据：表形完好（3 行数据 + 无跨格）且 2×2 命中矩形语义
  const shapeOK = facts1 && facts1.行数 === 4 && (facts1.每行格数 || []).join() === '3,3,3,3' && !(facts1.跨格 || []).length;
  const texts = (facts1 && facts1.格文) || [];
  const rectOK = texts.length >= 3 && /P11/.test(texts[1][0] || '') && /P12/.test(texts[1][1] || '')
    && /P21/.test(texts[2][0] || '') && /P22/.test(texts[2][1] || '')
    && /K2丙/.test((texts[0] || [])[2] || '') && /丙1/.test((texts[1] || [])[2] || '') && /丙3/.test((texts[3] || [])[2] || '');
  const verdict = save.saved && shapeOK && rectOK ? 'PASS' : 'FAIL';
  return { verdict, detail: {
    拖选: sel, 粘贴前表: facts0, 粘贴后表: facts1, 光标: caret, 存盘: save,
    磁盘表行: tableLines,
    判据: { shapeOK, rectOK, saved: save.saved },
    口径: '表形完好+2×2 矩形改写=PASS；并格/掉格/colspan/rowspan=FAIL（K2 病灶）', } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
const GROUPS = [
  { doc: 'r9-k1.md', content: DOC_K1, cases: [['K1富文本图归档', caseK1], ['K1b-cid形态', caseK1b]] },
  { doc: 'r9-k2.md', content: DOC_K2, cases: [['K2跨格粘贴', caseK2]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  // --selftest：CF_HTML 写入器独立冒烟（写入→独立进程读回→断言 html/text 都在）
  if (process.argv.includes('--selftest')) {
    const setOut = setRichClipboard(OUT, '<p>selftest-alpha</p><img src="file:///E:/tmp/clip.png">', 'selftest-alpha');
    const read = harness.readClipboard(OUT);
    const htmlOk = read.hasHtml && /selftest-alpha/.test(String(read.htmlRawUtf8 || '')) && /clip\.png/.test(String(read.htmlRawUtf8 || ''));
    const textOk = read.hasText && read.text === 'selftest-alpha';
    const headerOk = /^Version:0\.9\r?\nStartHTML:\d{10}/.test(String(read.htmlRawUtf8 || ''));
    console.log('SELFTEST', JSON.stringify({ setOut, htmlOk, textOk, headerOk, formats: read.formats, htmlBytes: read.htmlRawBytes }));
    process.exit(htmlOk && textOk && headerOk ? 0 : 1);
  }
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase());
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R9CLIP ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line); log.push(line);
  };
  console.log((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + EXE);
  const saved = harness.saveClipboard(OUT);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r9-clipboard', outDir: OUT, timeout: 240000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let pass = 0, fail = 0, evidence = 0;
  try {
    for (const group of GROUPS) {
      const todo = group.cases.filter(([name]) => want(name));
      if (!todo.length) continue;
      const file = path.join(OUT, group.doc);
      fs.writeFileSync(file, group.content, 'utf8');
      console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
      let session = null;
      try {
        session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1800, timeout: 200000 });
        const installed = await session.js(MARK_INSTALL);
        if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
        for (const [name, run] of todo) {
          try {
            const outcome = await run(session, { file }) || {};
            report(name, outcome.verdict || 'FAIL', outcome.detail || {});
            if ((outcome.verdict || '') === 'PASS') pass += 1;
            else if ((outcome.verdict || '') === 'EVIDENCE') evidence += 1;
            else fail += 1;
          } catch (error) {
            report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) }); fail += 1;
          }
        }
      } catch (error) {
        console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
        for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); fail += 1; }
      } finally {
        if (session) await ctx.release(session);
      }
    }
  } finally {
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('\n=== 汇总：PASS ' + pass + ' / FAIL ' + fail + ' / EVIDENCE ' + evidence + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r9-clipboard 失败：', error); process.exit(1); });
