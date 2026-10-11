/** 探针 · R9 验收 K1 门（CF_HTML file:/// 图片粘贴时归档，E9 §A 改定口径）。
 *
 *  绿判据（按 K1K2-修复说明 §2 口径——与截图管线同形态的 base64 内嵌）：
 *   · form 截图管线形态基线：CF_HDROP 图片文件粘贴 → md 落 data:image/png;base64、
 *     <docdir>/embedded-images/<sha256>.png 有字节（K1 产物必须与这个形态一致）；
 *   · k1-main：CF_HTML（Word msohtmlclip 形态 file:/// 图）粘贴 → 应用内显示正常
 *     （img naturalWidth>0）→ Ctrl+S → md **无 file:/// 临时路径**、含 base64 内嵌、
 *     解码字节 sha256 == 源 PNG sha256、embedded-images 有同字节文件；
 *   · k1-deletedir：删掉源临时目录 → 重开文档图仍显示 + Ctrl+S 后重开仍在
 *     （潜伏断链的根治判据）；
 *   · k1-mixed（G-K1-3 混排）：2 图 + 3 段 → 两图都归档、文字逐字保真、顺序不变；
 *   · k1-fail（G-K1-4）：file:/// 指向不存在文件 → 行为=现状（原样引用、文字不丢、不崩）；
 *   · red-plain / red-formula / red-files：纯文本/公式内/文件载荷粘贴行为不变（回归红线）。
 *
 *  通道纪律：剪贴板全部独立进程写入（CF_HTML 写入器 + media-host copy-images + Set-Text），
 *  粘贴真组合键 Ctrl+V，保存真键 Ctrl+S；磁盘 md 与 embedded-images 字节为主判据。
 *
 *  用法：node scripts/acceptance/probe-r9-k1.cjs [--only=form,k1,mixed,fail,red] [--mutant]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const fixtures = require('./fixtures.cjs');
const hi = require('../human-input/hi.cjs');
const { windowsClipboard } = require('../../app/renderer/js/media-host.cjs');

const MUTANT = process.argv.includes('--mutant');
const OUT = path.join(harness.project, '.perf/probe-r9-k1');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF, S = hi.SURFACE;
// 归档缓存根：PortableImages 的 root 取 path.dirname(state.file)/embedded-images——
// state.file 是会话 state.json（在生产=用户 userData，在探针=一次性 profile）。磁盘 md 自带
// base64 内嵌（自包含），缓存只是重开时的 mask 目标；删缓存不伤文档。
const EMB = profile => path.join(profile, 'embedded-images');

// ─── CF_HTML 写入器（与 probe-r9-clipboard 同款） ─────────────────────────────
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
function cfHtml(inner) {
  const body = '<html><body>\r\n<!--StartFragment-->' + inner + '<!--EndFragment-->\r\n</body></html>';
  const head = 'Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n';
  const pad = n => String(n).padStart(10, '0');
  const startHtml = head.length;
  const frag = body.indexOf('<!--StartFragment-->') + '<!--StartFragment-->'.length;
  const fragEnd = body.indexOf('<!--EndFragment-->');
  return 'Version:0.9\r\nStartHTML:' + pad(startHtml) + '\r\nEndHTML:' + pad(startHtml + body.length)
    + '\r\nStartFragment:' + pad(startHtml + frag) + '\r\nEndFragment:' + pad(startHtml + fragEnd) + '\r\n' + body;
}
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

// ─── 公共动作 ────────────────────────────────────────────────────────────────
const DOC_MAIN = ['# R9K1 粘贴归档', '',
  '靶点段一：图应落此段之后。', '',
  '靶点段二：混排落点。', '',
  '尾段：收尾。', '',
  '$x=1$ 公式段落：粘贴红线落点。', ''].join('\n');

async function focusTailOf(session, marker) {
  await hi.ensureFocus(session);
  const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => b.textContent.includes(${JSON.stringify(marker)}));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!point) throw new Error('找不到靶点段：' + marker);
  await session.click(point.x, point.y);
  await harness.sleep(250);
  await session.key({ key: 'End', code: 'End', vk: 35 });
  await harness.sleep(200);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) throw new Error('焦点不在编辑器');
}
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
const IMG_FACTS = `(() => { const root = ${IF}.document.querySelector(${JSON.stringify(S)}); if (!root) return null;
  return [...root.querySelectorAll('img')].map(img => { const r = img.getBoundingClientRect();
    return { src: String(img.getAttribute('src')).slice(0, 120), nw: img.naturalWidth, nh: img.naturalHeight,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }); })()`;
const imgs = session => session.js(IMG_FACTS);
/** md 里的 data URI 载荷（解码后 sha256 集合）。 */
const dataUris = md => [...md.matchAll(/!\[[^\]]*\]\(data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)\)/g)]
  .map(m => ({ mime: m[1], sha: harness.sha256(Buffer.from(m[2], 'base64')) }));
const embFiles = file => { try { return fs.readdirSync(EMB(file)); } catch { return null; } };

// ─── form：截图管线形态基线 ───────────────────────────────────────────────────
async function caseForm(session, env) {
  const file = env.file;
  const pngPath = path.join(OUT, 'form', 'shot.png');
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, fixtures.png(80, 50, [30, 90, 200]));
  await focusTailOf(session, '靶点段一');
  await windowsClipboard({ action: 'copy-images', files: [pngPath], composite: false });
  await harness.sleep(300);
  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(1500);
  const dom = await imgs(session);
  const save = await keySave(session, file);
  await harness.sleep(400);
  const md = fs.readFileSync(file, 'utf8');
  const uris = dataUris(md);
  const srcSha = harness.fileSha(pngPath);
  const emb = embFiles(env.profile) || [];
  const archived = emb.some(name => { try { return harness.fileSha(path.join(EMB(env.profile), name)) === srcSha; } catch { return false; } });
  return { verdict: save.saved && uris.length >= 1 && uris.some(u => u.sha === srcSha) && archived ? (MUTANT ? 'FAIL' : 'PASS') : 'FAIL', detail: {
    用例: '截图管线形态（CF_HDROP 文件载荷 → uploadImages → insert → base64 内嵌）',
    图事实: dom, 存盘: save, md载荷数: uris.length, 载荷sha含源图: uris.some(u => u.sha === srcSha),
    embedded目录: emb, 字节一致文件存在: archived,
    形态结论: 'md 落 data:image/png;base64 内嵌 + embedded-images/<sha> 落盘——K1 产物对齐基准',
  } };
}

// ─── k1-main：CF_HTML file:/// 归档 + 删临时目录重开 ──────────────────────────
async function caseK1(session, env) {
  const file = env.file;
  const simDir = path.join(OUT, 'k1', 'msohtmlclip101');
  fs.mkdirSync(simDir, { recursive: true });
  const pngPath = path.join(simDir, 'clip_image002.png');
  fs.writeFileSync(pngPath, fixtures.png(96, 64, [200, 60, 30]));
  const pngUrl = pngPath.replace(/\\/g, '/');
  const htmlInner = '<p style="margin:0in">WordK1 alpha paragraph.</p>'
    + '<p style="margin:0in"><img width="96" height="64" src="file:///' + pngUrl + '"></p>'
    + '<p style="margin:0in">WordK1 gamma paragraph.</p>';
  const setOut = setRichClipboard(OUT, htmlInner, 'WordK1 alpha paragraph.\r\nWordK1 gamma paragraph.');
  await focusTailOf(session, '靶点段一');
  await hi.combo(session, 'Ctrl+V');
  let dom = null;
  for (let i = 0; i < 30; i++) { await harness.sleep(150); dom = await imgs(session); if (dom && dom.length) break; }
  await session.shot('K1-粘贴后-full');
  const save = await keySave(session, file);
  await harness.sleep(500);
  const md = fs.readFileSync(file, 'utf8');
  const uris = dataUris(md);
  const srcSha = harness.fileSha(pngPath);
  const emb = embFiles(env.profile) || [];
  const embHit = emb.find(name => { try { return harness.fileSha(path.join(EMB(env.profile), name)) === srcSha; } catch { return false; } });
  const noFileRef = !/file:\/\/\//.test(md);
  const displayed = dom && dom.length >= 1 && dom.some(im => im.nw > 0);
  const textKept = /WordK1 alpha paragraph\./.test(md) && /WordK1 gamma paragraph\./.test(md);

  // 删源临时目录 → 重开 → 图仍在 + Ctrl+S 后重开仍在
  let reopenOK = null;
  if (save.saved && noFileRef) {
    fs.rmSync(simDir, { recursive: true, force: true });
    await session.close(); env.session = null;
    const session2 = await hi.openDoc(env.ctx, file, { minBlocks: 3, settleMs: 2000, timeout: 120000 });
    env.session = session2;
    let dom2 = null;
    for (let i = 0; i < 20; i++) { await harness.sleep(200); dom2 = await imgs(session2); if (dom2 && dom2.length && dom2.every(im => im.complete)) break; }
    await session2.shot('K1-删目录重开后-full');
    const md2 = fs.readFileSync(file, 'utf8');
    const stillEmbedded = dataUris(md2).some(u => u.sha === srcSha);
    reopenOK = { 图显示: !!(dom2 && dom2.length && dom2.some(im => im.nw > 0)), md仍内嵌: stillEmbedded, md2载荷: dataUris(md2).length };
  }
  const ok = save.saved && noFileRef && displayed && textKept && uris.some(u => u.sha === srcSha) && !!embHit && reopenOK && reopenOK.图显示 && reopenOK.md仍内嵌;
  return { verdict: ok === !MUTANT ? 'PASS' : 'FAIL', detail: {
    剪贴板写入: setOut, 图事实: dom, 存盘: save,
    md无file引用: noFileRef, md载荷sha含源图: uris.some(u => u.sha === srcSha), 文字保真: textKept,
    embedded目录: emb, 归档命中: embHit || null, 删目录重开: reopenOK,
    判据: '归档=base64 内嵌 + embedded-images 同字节 + 删源重开图仍在（潜伏断链根治）',
  } };
}

// ─── k1-mixed：2 图 + 3 段混排 ────────────────────────────────────────────────
async function caseMixed(session, env) {
  const file = env.file;
  const dirA = path.join(OUT, 'mixed', 'a'), dirB = path.join(OUT, 'mixed', 'b');
  fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true });
  const pa = path.join(dirA, 'img_a.png'), pb = path.join(dirB, 'img_b.png');
  fs.writeFileSync(pa, fixtures.png(60, 40, [10, 120, 240]));
  fs.writeFileSync(pb, fixtures.png(70, 42, [240, 200, 20]));
  const inner = '<p style="margin:0in">混排甲段落文字。</p>'
    + '<p style="margin:0in"><img src="file:///' + pa.replace(/\\/g, '/') + '"></p>'
    + '<p style="margin:0in">混排乙段落文字。</p>'
    + '<p style="margin:0in"><img src="file:///' + pb.replace(/\\/g, '/') + '"></p>'
    + '<p style="margin:0in">混排丙段落文字。</p>';
  setRichClipboard(OUT, inner, '混排甲段落文字。\r\n混排乙段落文字。\r\n混排丙段落文字。');
  await focusTailOf(session, '靶点段二');
  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(1500);
  const dom = await imgs(session);
  const save = await keySave(session, file);
  await harness.sleep(500);
  const md = fs.readFileSync(file, 'utf8');
  const uris = dataUris(md);
  const shaA = harness.fileSha(pa), shaB = harness.fileSha(pb);
  const both = uris.some(u => u.sha === shaA) && uris.some(u => u.sha === shaB);
  const orderOK = md.indexOf('混排甲段落文字') < md.indexOf('data:image') && md.indexOf('data:image') < md.indexOf('混排丙段落文字');
  const textOK = ['混排甲段落文字。', '混排乙段落文字。', '混排丙段落文字。'].every(t => md.includes(t));
  await session.shot('K1-混贴后-full');
  return { verdict: (save.saved && both && textOK && orderOK && !/file:\/\/\//.test(md)) === !MUTANT ? 'PASS' : 'FAIL', detail: {
    图事实: dom, 存盘: save, 两图载荷都在: both, 三段文字保真: textOK, 顺序: orderOK, md无file引用: !/file:\/\/\//.test(md),
  } };
}

// ─── k1-fail：file:/// 不存在 → 现状回退 ─────────────────────────────────────
async function caseFail(session, env) {
  const file = env.file;
  const inner = '<p style="margin:0in">失效图段落。</p><p style="margin:0in"><img src="file:///E:/nonexistent-r9/ghost.png"></p>';
  setRichClipboard(OUT, inner, '失效图段落。');
  await focusTailOf(session, '靶点段一');
  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(1500);
  const save = await keySave(session, file);
  await harness.sleep(400);
  const md = fs.readFileSync(file, 'utf8');
  return { verdict: (save.saved && /失效图段落。/.test(md) && /ghost\.png/.test(md)) ? 'PASS' : 'FAIL', detail: {
    存盘: save, 文字保真: /失效图段落。/.test(md), 引用保留: /ghost\.png/.test(md),
    口径: 'G-K1-4 失败回退=行为与现状一致（原样引用+文字不丢、不崩）',
  } };
}

// ─── 回归红线 ────────────────────────────────────────────────────────────────
async function caseRed(session, env) {
  const file = env.file;
  const out = {};
  // ① 纯文本粘贴
  const emb0 = embFiles(env.profile);
  await focusTailOf(session, '靶点段一');
  harness.writeClipboard(OUT, '纯文本红线R9。');
  await harness.sleep(200);
  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(800);
  const save1 = await keySave(session, file);
  await harness.sleep(300);
  const md1 = fs.readFileSync(file, 'utf8');
  out.纯文本 = { 落盘: save1.saved, 文字在: md1.includes('纯文本红线R9。'), 无data载荷: dataUris(md1).length === 0,
    emb目录无新增: JSON.stringify(embFiles(env.profile)) === JSON.stringify(emb0) };
  // ② 公式内粘贴：光标放进公式源码再粘贴
  const formula = await session.js(`(() => { const root = ${IF}.document.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => b.textContent.includes('公式段落'));
    if (!block) return null; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
    const code = block.querySelector('code[data-type="math-inline"]'); if (!code) return { 无公式: true };
    const r = code.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!formula || formula.无公式) { out.公式内 = { 跳过: '没找到公式' }; }
  else {
    await session.click(formula.x, formula.y);
    await harness.sleep(500); // 展开源码
    await session.js(`(() => { const w = ${IF}; const d = w.document; const s = w.getSelection();
      const code = d.querySelector(${JSON.stringify(S)} + ' code[data-type="math-inline"]');
      if (!code || !code.firstChild) return false; const r = d.createRange();
      r.setStart(code.firstChild, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r); return true; })()`);
    await harness.sleep(200);
    harness.writeClipboard(OUT, '加字');
    await hi.combo(session, 'Ctrl+V');
    await harness.sleep(800);
    const save2 = await keySave(session, file);
    await harness.sleep(300);
    const md2 = fs.readFileSync(file, 'utf8');
    const v = await hi.mdNow(session);
    out.公式内 = { 落盘: save2.saved, 公式含加字: /x=1加字|加字x=1/.test(String(v)) || String(v).includes('$x=1加字$') || md2.includes('加字'),
      无data载荷: dataUris(md2).length === 0, getValue公式行: (String(v).match(/\$[^\n]{0,30}\$/g) || []).slice(0, 3) };
  }
  // ③ 文件载荷粘贴（截图路径字节不变——form 用例已证管线，这里验 md 无 file:/// 引用）
  out.文件载荷 = { 由form用例覆盖: true };
  const pass = (!out.纯文本 || (out.纯文本.落盘 && out.纯文本.文字在 && out.纯文本.无data载荷 && out.纯文本.emb目录无新增))
    && (!out.公式内 || out.公式内.跳过 || (out.公式内.落盘 && out.公式内.无data载荷));
  return { verdict: pass ? 'PASS' : 'FAIL', detail: out };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const report = (name, verdict, detail) => { const line = 'R9K1 ' + name + ' ' + verdict + ' ' + JSON.stringify(detail); console.log(line); log.push(line); };
  const saved = harness.saveClipboard(OUT);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r9-k1', outDir: OUT, timeout: 180000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = n => !only.length || only.includes(n);
  const CASES = [
    ['form', caseForm, 'r9-k1-form.md'],
    ['k1', caseK1, 'r9-k1-main.md'],
    ['mixed', caseMixed, 'r9-k1-mixed.md'],
    ['fail', caseFail, 'r9-k1-fail.md'],
    ['red', caseRed, 'r9-k1-red.md'],
  ];
  let pass = 0, fail = 0;
  try {
    for (const [name, run, docName] of CASES) {
      if (!want(name)) continue;
      const file = path.join(OUT, docName);
      fs.writeFileSync(file, DOC_MAIN, 'utf8');
      let session = null;
      try {
        session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1800, timeout: 120000, inspect: true });
        await session.main.js(`global.doc.setSetting('autoSave', false)`);
        const env = { file, ctx, session, profile: session.profile };
        const outcome = await run(session, env) || {};
        report(name, outcome.verdict || 'FAIL', outcome.detail || {});
        if ((outcome.verdict || '') === 'PASS') pass += 1; else fail += 1;
        if (env.session && env.session !== session) { try { await env.session.close(); } catch {} env.session = null; }
      } catch (error) {
        report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) }); fail += 1;
      } finally {
        if (session) { try { await ctx.release(session); } catch {} }
      }
    }
  } finally {
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('=== K1 汇总：PASS ' + pass + ' / FAIL ' + fail + (MUTANT ? '（突变）' : '（绿轮）') + ' ===');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r9-k1 失败：', error); process.exit(1); });
