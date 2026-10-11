/** 探针 · 第 1 轮辩论"通过"项 A1/B4/B7 的实机验收 + 存疑 E1/E2 取证（math-edit.js）。
 *
 *  前提：渲染层真源（E:/MarkPilot/Typora-Editor/extension-src/render/js/math-edit.js）改完后，
 *  必须先在 Typora-Editor-App 里 `npm run sync` 把真源复制进 app/renderer —— 本探针跑的是
 *  app 副本。启动时会对比两份文件并在不一致时打警示；三处修法各带注释标记
 *  （【A1·R1】【B4·R1】【B7·R1】），突变验证（注掉任一分支 → 对应用例必须变红）就注这些点。
 *
 *  用例（每条打印「R1MATHEDIT <名> PASS/FAIL/EVIDENCE <JSON>」）：
 *    A1  闭 $ 右半外侧 Ctrl+V 一段文字 → 文字必须落 $…$ 之外（红：现状文字进源码）；
 *    B4  展开块公式点开栏 $$ 最左（marker@0）真实退格 → 不并段、> 前缀不丢、公式块仍在
 *        （红：现状块级合并/削前缀）；
 *    B7  文档末块为空 $$，Ctrl+A 后直接 insertText 'abc' → 得正文 abc 无 $$ 壳，
 *        一次 Ctrl+Z 回原文（红：现状字进 $$ 壳）；
 *    E1  展开块公式源码粘贴富文本 <b>x</b>（自建 text/html 剪贴板）→ 只取证存盘 md 与 DOM；
 *    E2  行内 $x|$ 源码粘贴 "a\nb" → 断言 getValue 与存盘都无跨行 $，且行内公式仍完整（压平为 $xa b$）。
 *
 *  输入一律真实通道：CDP Input.dispatchKeyEvent / dispatchMouseEvent / insertText（IME 上屏
 *  同通道）；Ctrl+V 走真键组合。系统剪贴板开头 save、结尾 restore，中间的写入全部由独立
 *  PowerShell 进程完成（文件交换，不经产品）。截图：每步整页 + 光标附近 2x 局部，存
 *  .perf/probe-r1-mathedit/。
 *
 *  用法：node scripts/acceptance/probe-r1-mathedit.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r1-mathedit');
const IF = hi.IF, SURFACE = hi.SURFACE;
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const TRUE_SRC = 'E:/MarkPilot/Typora-Editor/extension-src/render/js/math-edit.js';
const APP_COPY = path.join(harness.project, 'app/renderer/js/math-edit.js');
const FIX_TAGS = ['【A1·R1', '【B4·R1', '【B7·R1'];

const A1_BODY = [
  '# 行程问题', '',
  '甲在第n次相遇走的路程记为 $s_n$，则 $s_n=L(2n-1)k$', '',
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');
const A1_PASTE = '外贴文字XYZ';
const B4_BODY = [
  '公式前面的普通段落。', '',
  '> 引用前置行', '>',
  '> $$', '> a+b=c', '> $$', '',
  '> (2) 引用后置行', '',
  '收尾正文段。', '',
].join('\n');
const B7_BODY = ['# 标题甲', '', '正文一段文字，用于全选后重打。', '', '$$', '', '$$', ''].join('\n');
const E1_BODY = ['前置段落。', '', '$$', 'a+b=c', '$$', '', '后置段落。', ''].join('\n');
const E2_BODY = ['行内公式源码粘贴换行文本的取证段：$x$', '', '后续段落。', ''].join('\n');

// ─── 通用读数 ────────────────────────────────────────────────────────────────
const 光标 = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 无: true };
  const n = sel.focusNode, o = sel.focusOffset;
  const at = n.nodeType === 3 ? n.parentElement : n;
  return { 层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('[data-type$="-marker"]') ? '围栏'
      : at.closest?.('.vditor-ir__preview') ? '预览' : at.closest?.('p,li,h1,h2,h3,h4,h5,h6,blockquote') ? '正文' : '元素级',
    容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' + JSON.stringify(n.data) : n.nodeName,
    偏移: o, 折叠: sel.isCollapsed, 选区: sel.toString().slice(0, 60), 选区长: sel.toString().length }; })()`;

/** 选区/光标几何（顶层页坐标）——2x 截图的裁剪中心。 */
const 框 = `(() => { const w = ${IF}; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = w.getSelection(); if (!s || !s.rangeCount) return null;
  const r = s.getRangeAt(0).getBoundingClientRect();
  return { x: frame.x + r.left, y: frame.y + r.top, w: r.width, h: r.height }; })()`;

const A1_几何 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}');
  const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const owner = 全部[全部.length - 1]; if (!owner) return { ok: false };
  const b = owner.getBoundingClientRect();
  return { ok: true, 中心: Math.round(frame.x + b.left + b.width / 2), y: Math.round(frame.y + b.top + b.height / 2) }; })()`;

const A1_公式态 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const owner = 全部[全部.length - 1]; if (!owner) return { ok: false };
  const code = owner.querySelector('code[data-type]');
  const 段 = owner.closest('p');
  const 段外 = 段 ? [...段.childNodes].filter(n => n !== owner).map(n => n.textContent || '').join('') : null;
  const 后邻 = owner.nextSibling ? (owner.nextSibling.nodeType === 3 ? 'TEXT:' + owner.nextSibling.data.slice(0, 24) : owner.nextSibling.nodeName) : null;
  return { ok: true, 源码: code ? code.textContent : null, 段外, 后邻 }; })()`;

const B4_几何 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="math-block"]'); if (!owner) return { ok: false };
  const preview = owner.querySelector('.vditor-ir__preview');
  const pb = (preview && preview.getBoundingClientRect().height > 0 ? preview : owner).getBoundingClientRect();
  return { ok: true, 展开: owner.classList.contains('vditor-ir__node--expand'),
    预览中心: { x: Math.round(frame.x + pb.left + pb.width / 2), y: Math.round(frame.y + pb.top + pb.height / 2) } }; })()`;

/** 开栏 $$（open-marker）的几何与文本：点它最左 1px，fenceClick 会把光标落到 marker@0。 */
const B4_开栏 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="math-block"]'); if (!owner) return { ok: false };
  const mark = owner.querySelector(':scope > span[data-type="math-block-open-marker"]') || owner.firstElementChild;
  if (!mark || !mark.firstChild || mark.firstChild.nodeType !== 3) return { ok: false };
  const r = mark.getBoundingClientRect();
  return { ok: true, 围栏文本: mark.firstChild.data, 左: Math.round(frame.x + r.left) + 1,
    中y: Math.round(frame.y + r.top + r.height / 2), 展开: owner.classList.contains('vditor-ir__node--expand') }; })()`;

const B4_结构 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const 引用 = [...s.querySelectorAll('blockquote')];
  const 公式 = [...s.querySelectorAll('.vditor-ir__node[data-type="math-block"]')];
  const code = 公式.length ? 公式[0].querySelector('pre > code') : null;
  return { 引用块数: 引用.length,
    引用文本: 引用.map(b => b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)),
    公式块数: 公式.length, 源码: code ? code.textContent : null,
    顶层: [...s.children].map(n => n.nodeName + (n.getAttribute('data-type') ? '[' + n.getAttribute('data-type') + ']' : '')).slice(0, 12) }; })()`;

const B7_结构 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  return { 顶层: [...s.children].map(n => n.nodeName + (n.getAttribute('data-type') ? '[' + n.getAttribute('data-type') + ']' : '')
      + ':' + String(n.textContent || '').replace(/\\s+/g, '').slice(0, 16)),
    块公式数: s.querySelectorAll('.vditor-ir__node[data-type="math-block"]').length }; })()`;

const E1_公式态 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="math-block"]'); if (!owner) return { ok: false };
  const code = owner.querySelector('pre > code');
  const math = owner.querySelector('.language-math');
  return { ok: true, 展开: owner.classList.contains('vditor-ir__node--expand'),
    源码: code ? JSON.stringify(code.textContent) : null, 预览: math ? math.textContent : null }; })()`;

const E2_公式态 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]'); if (!owner) return { ok: false };
  const code = owner.querySelector('code[data-type]');
  return { ok: true, 展开: owner.classList.contains('vditor-ir__node--expand'),
    源码: code ? JSON.stringify(code.textContent) : null }; })()`;

const 首段点 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}');
  const p = [...s.children].find(n => n.nodeName === 'P' && n.textContent.trim());
  if (!p) return null; const r = p.getBoundingClientRect();
  return { x: Math.round(frame.x + r.left + Math.min(60, r.width / 2)), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

// ─── 基座 ────────────────────────────────────────────────────────────────────
const LOG = [];
const say = line => { console.log(line); LOG.push(line); };
const 判 = (名, 态, 据) => say(`R1MATHEDIT ${名} ${态} ${JSON.stringify(据)}`);

const ctx = {
  launch: options => harness.launch({ exe: EXE, appArgs: [path.join(harness.project, 'app/main/main.js')],
    label: 'probe-r1-mathedit', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
  release: async session => { await session.close(); },
};

/** 整页 + 光标附近 2x 局部各一张。box 为顶层页坐标的选区框（可空）。 */
async function 拍(session, stem, box) {
  await session.shot(stem + '-整页');
  if (!box) return;
  const frame = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const padY = 46, halfW = 300;
  const clip = {
    x: Math.max(0, box.x - halfW), y: Math.max(frame.y, box.y - padY),
    width: halfW * 2, height: Math.min(frame.h, (box.h || 20) + padY * 2), scale: 2,
  };
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, stem + '-2x.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { say('  （2x 截图失败：' + String(error.message).slice(0, 80) + '）'); }
}

const 开文档 = (名, body, minBlocks) => {
  const file = path.join(OUT, 名 + '.md');
  fs.writeFileSync(file, body, 'utf8');
  return hi.openDoc(ctx, file, { minBlocks, settleMs: 1500 }).then(session => ({ session, file }));
};

/** 自建 text/html + text/plain 双格式剪贴板（独立 PowerShell 进程，文件交换，ASCII 脚本）。 */
async function 写富文本(html, plain) {
  const ps1 = path.join(OUT, 'r1-html-clipboard.ps1');
  const payload = path.join(OUT, 'r1-html-payload.html');
  const plainFile = path.join(OUT, 'r1-html-payload.txt');
  fs.writeFileSync(payload, html, 'utf8');
  fs.writeFileSync(plainFile, plain, 'utf8');
  // ASCII only（PowerShell 5.1 对 BOM-less 脚本按 ANSI 解码，非 ASCII 字节会炸解析）。
  fs.writeFileSync(ps1, [
    'param([Parameter(Mandatory=$true)][string]$In,[Parameter(Mandatory=$true)][string]$Plain)',
    '$ErrorActionPreference=\'Stop\'',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$enc=New-Object System.Text.UTF8Encoding($false)',
    '$frag=[System.IO.File]::ReadAllText($In,$enc)',
    '$text=[System.IO.File]::ReadAllText($Plain,$enc)',
    // CF_HTML 头的字节偏移必须是定宽（10 位零填充），先摆占位再回填，长度不变。
    '$head="Version:0.9`r`nStartHTML:0000000000`r`nEndHTML:0000000000`r`nStartFragment:0000000000`r`nEndFragment:0000000000`r`n"',
    '$open=\'<html><body><!--StartFragment-->\'',
    '$close=\'<!--EndFragment--></body></html>\'',
    '$bH=$enc.GetBytes($head);$bO=$enc.GetBytes($open);$bF=$enc.GetBytes($frag);$bC=$enc.GetBytes($close)',
    '$sF=$bH.Length+$bO.Length;$eF=$sF+$bF.Length;$eH=$eF+$bC.Length',
    '$head=$head.Replace(\'StartHTML:0000000000\',(\'StartHTML:{0:D10}\' -f $bH.Length)).Replace(\'EndHTML:0000000000\',(\'EndHTML:{0:D10}\' -f $eH)).Replace(\'StartFragment:0000000000\',(\'StartFragment:{0:D10}\' -f $sF)).Replace(\'EndFragment:0000000000\',(\'EndFragment:{0:D10}\' -f $eF))',
    '$html=$head+$open+$frag+$close',
    '$data=New-Object System.Windows.Forms.DataObject',
    '$stream=New-Object System.IO.MemoryStream(,$enc.GetBytes($html))',
    '$data.SetData(\'HTML Format\',$false,$stream)',
    '$data.SetText($text)',
    '[System.Windows.Forms.Clipboard]::SetDataObject($data,$true)',
    'Write-Output \'ok\'',
  ].join('\r\n'), 'ascii');
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', ps1, '-In', payload, '-Plain', plainFile], { encoding: 'utf8' });
    if (run.status === 0) return true;
    lastError = String((run.stderr || '') + (run.stdout || '')).slice(0, 160);
    await hi.sleep(700);
  }
  say('  富文本剪贴板写入失败：' + lastError);
  return false;
}

// ─── 用例 ────────────────────────────────────────────────────────────────────
/** A1：闭 $ 右半外侧 Ctrl+V → 文字必须落 $…$ 之外。进到"闭围栏外半"的路径与
 *  probe-math-exit-type V6 同款：点公式中心展开 → End 到源码末 → → 一步上围栏外半。 */
async function 用例A1() {
  const { session, file } = await 开文档('a1-fence-outside-paste', A1_BODY, 4);
  try {
    await hi.ensureFocus(session);
    const g = await session.js(A1_几何);
    await session.click(g.中心, g.y);            // 点公式中心：展开 + 光标进源码
    await hi.sleep(380);
    await hi.press(session, 'End');              // 源码末尾
    await hi.sleep(280);
    await hi.press(session, 'ArrowRight');       // → 一步：闭 $ 文本的外半（offset 1/1）
    await hi.sleep(300);
    const 落点 = await session.js(光标);
    const 前 = await session.js(A1_公式态);
    await 拍(session, 'A1-粘贴前', await session.js(框));
    await harness.writeClipboard(OUT, A1_PASTE);
    await hi.combo(session, 'Ctrl+V');
    await hi.sleep(650);
    const 后 = await session.js(A1_公式态);
    const md = await hi.mdNow(session);
    await 拍(session, 'A1-粘贴后', await session.js(框));
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    const 在公式里 = new RegExp('\\$[^$\\n]*' + A1_PASTE + '[^$\\n]*\\$').test(disk);
    const 据前 = { 落点, 源码前: 前.源码 };
    const 据 = { 落点: { 层: 落点.层, 容器: 落点.容器, 偏移: 落点.偏移 },
      源码前: 前.源码, 源码后: 后.源码, 段外后: 后.段外, 后邻: 后.后邻,
      md: md && md.slice(0, 120), 盘含文字: disk.includes(A1_PASTE), 盘在公式里: 在公式里,
      磁盘: disk.slice(0, 160) };
    const 通过 = 后.源码 === 前.源码 && disk.includes(A1_PASTE) && !在公式里 && String(后.段外).includes(A1_PASTE);
    判('A1', 通过 ? 'PASS' : 'FAIL', { ...据前, ...据 });
  } finally { await ctx.release(session); }
}

/** B4：展开块公式，点开栏 $$ 最左（fenceClick → marker@0），真实退格 → 不并段、
 *  > 前缀不丢、公式块仍在；修法走 action:'open'，源码整条被选中且文档一字不改。 */
async function 用例B4() {
  const { session, file } = await 开文档('b4-fence-start-backspace', B4_BODY, 4);
  try {
    await hi.ensureFocus(session);
    let g = await session.js(B4_几何);
    await session.click(g.预览中心.x, g.预览中心.y);   // 点渲染结果：展开 + 光标进源码
    await hi.sleep(450);
    const 开 = await session.js(B4_开栏);
    if (!开.ok || !开.展开) { 判('B4', 'FAIL', { 原因: '前置失败：块公式没展开或找不到开栏围栏', 开 }); return; }
    await session.click(开.左, 开.中y);               // 开栏 $$ 最左 1px → marker@0
    await hi.sleep(320);
    const 落点 = await session.js(光标);
    const md前 = await hi.mdNow(session);
    await 拍(session, 'B4-退格前', await session.js(框));
    await hi.press(session, 'Backspace');
    await hi.sleep(550);
    const 结构 = await session.js(B4_结构);
    const md后 = await hi.mdNow(session);
    const 退后 = await session.js(光标);
    await 拍(session, 'B4-退格后', await session.js(框));
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    const 据 = { 落点: { 层: 落点.层, 容器: 落点.容器, 偏移: 落点.偏移 }, 围栏文本: 开.围栏文本,
      退格后光标: { 层: 退后.层, 选区: 退后.选区 },
      结构, md不变: md后 === md前, md前: md前 && md前.slice(0, 120), md后: md后 && md后.slice(0, 120),
      盘: disk.slice(0, 160) };
    const 通过 = md后 === md前 && 结构.引用块数 >= 1 && 结构.公式块数 === 1
      && String(结构.源码).includes('a+b=c') && (结构.引用文本 || []).some(t => String(t).includes('(2)'))
      && disk.includes('(2)') && disk.includes('a+b=c');
    判('B4', 通过 ? 'PASS' : 'FAIL', 据);
  } finally { await ctx.release(session); }
}

/** B7：文档末块为空 $$，Ctrl+A 后直接 insertText 'abc' → 正文 abc 无 $$ 壳，一次 Ctrl+Z 回原文。
 *  中途在 +70ms / +700ms 采样顶层结构（若红，给下一轮辩论留中间态）。 */
async function 用例B7() {
  const { session, file } = await 开文档('b7-selectall-type', B7_BODY, 2);
  try {
    await hi.ensureFocus(session);
    const 点 = await session.js(首段点);
    await session.click(点.x, 点.y);                  // 真点一下正文，Ctrl+A 才落进 iframe
    await hi.sleep(250);
    const md0 = await hi.mdNow(session);
    await hi.combo(session, 'Ctrl+A');
    await hi.sleep(450);
    const 全选 = await session.js(光标);
    await 拍(session, 'B7-全选', await session.js(框));
    await session.type('abc');                        // insertText：IME 上屏同一通道
    await hi.sleep(70);
    const 快照1 = await session.js(B7_结构);
    await hi.sleep(630);
    const 快照2 = await session.js(B7_结构);
    await hi.sleep(700);
    const 值 = await hi.mdNow(session);
    const 终态 = await session.js(B7_结构);
    await 拍(session, 'B7-打字后', await session.js(框));
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    await hi.combo(session, 'Ctrl+Z');
    await hi.sleep(800);
    const 撤后 = await hi.mdNow(session);
    await 拍(session, 'B7-撤销后', await session.js(框));
    const 正文ok = !!值 && !值.includes('$$') && 值.includes('abc') && 终态.块公式数 === 0;
    const 盘ok = !disk.includes('$$') && disk.includes('abc');
    const 撤销ok = 撤后 === md0;
    const 通过 = 正文ok && 盘ok && 撤销ok;
    判('B7', 通过 ? 'PASS' : 'FAIL', { 全选: { 选区长: 全选.选区长, 折叠: 全选.折叠 },
      快照70ms: 快照1, 快照700ms: 快照2, 终态, 值: 值 && 值.slice(0, 80), 磁盘: disk.slice(0, 80),
      正文ok, 盘ok, 撤销ok, 撤销后: 撤后 && 撤后.slice(0, 60), 原文: md0 && md0.slice(0, 60) });
  } finally { await ctx.release(session); }
}

/** E1（只取证）：展开块公式源码，粘贴富文本 <b>x</b> —— 记录 DOM 与存盘 md。 */
async function 用例E1() {
  const { session, file } = await 开文档('e1-rich-paste-block', E1_BODY, 3);
  try {
    await hi.ensureFocus(session);
    const g = await session.js(B4_几何);
    await session.click(g.预览中心.x, g.预览中心.y);
    await hi.sleep(450);
    const 前 = await session.js(E1_公式态);
    const 置好 = await 写富文本('<b>x</b>', 'x');
    const 证人 = await harness.readClipboard(OUT);
    await 拍(session, 'E1-粘贴前', await session.js(框));
    if (置好) { await hi.combo(session, 'Ctrl+V'); await hi.sleep(650); }
    const 后 = await session.js(E1_公式态);
    const 值 = await hi.mdNow(session);
    await 拍(session, 'E1-粘贴后', await session.js(框));
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    判('E1', 'EVIDENCE', { 前置: { 展开: 前.展开, 源码: 前.源码 }, 剪贴板有HTML: !!(证人 && 证人.hasHtml),
      剪贴板HTML: 证人 && 证人.htmlRawUtf8 ? String(证人.htmlRawUtf8).slice(0, 120) : null,
      置好, 后: 后, 值: 值 && 值.slice(0, 160), 磁盘: disk.slice(0, 200),
      盘含标签: disk.includes('<b>x</b>'), 盘含裸x: /\$[^$]*\bx\b[^$]*\$|^\s*x\s*$/m.test(disk) });
  } finally { await ctx.release(session); }
}

/** E2：行内 $x|$ 源码末尾粘贴 "a\nb" → 断言 getValue 与存盘都不出现跨行 $（\$…\n…\$），
 *  且行内公式仍完整（值里 \$x a b\$ 形态或至少存在单行 \$…\$）。修法：math-edit.js paste 分支压平 \n。 */
async function 用例E2() {
  const { session, file } = await 开文档('e2-inline-paste-newline', E2_BODY, 2);
  try {
    await hi.ensureFocus(session);
    const g = await session.js(A1_几何);
    await session.click(g.中心, g.y);                 // 点公式中心：展开 + 光标进源码
    await hi.sleep(380);
    const 落点 = await session.js(光标);              // 点中心后光标本就落在源码内被点字符处（A1 红轮同位），无需 End
    if (落点.层 !== '源码') { 判('E2', 'FAIL', { 为什么: '落点未在源码内（用例前置失败）', 落点 }); return; }
    await 拍(session, 'E2-粘贴前', await session.js(框));
    await harness.writeClipboard(OUT, 'a\nb');
    await hi.combo(session, 'Ctrl+V');
    await hi.sleep(650);
    const 后 = await session.js(E2_公式态);
    const 值 = await hi.mdNow(session);
    await 拍(session, 'E2-粘贴后', await session.js(框));
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    const zhiKuaHang = /\$[^\n$]*\n[^\n$]*\$/.test(值);      // getValue 里不得出现跨行 $…\n…$
    const panKuaHang = /\$[^\n$]*\n[^\n$]*\$/.test(disk);    // 存盘同口径
    const sheHang = disk.split('\n').filter(l => l.includes('$')).slice(0, 4);
    const gongshiWanzheng = /\$[^$\n]+\$/.test(值);           // 仍存在完整单行行内公式（压平后 $xa b$）
    const tongguo = !zhiKuaHang && !panKuaHang && gongshiWanzheng;
    判('E2', tongguo ? 'PASS' : 'FAIL', { 落点: { 层: 落点.层, 容器: 落点.容器, 偏移: 落点.偏移 },
      后, 值: 值 && 值.slice(0, 160), 磁盘: disk, 值跨行: zhiKuaHang, 盘跨行: panKuaHang, 涉$行: sheHang,
      公式完整: gongshiWanzheng, 盘含ab同行: /a\s*b/.test(disk) });
  } finally { await ctx.release(session); }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });

  // 源-副本一致性哨兵：本探针跑 app 副本，真源改完必须先 npm run sync。
  let 剪贴板存档 = null;
  try {
    const 真源 = fs.existsSync(TRUE_SRC) ? fs.readFileSync(TRUE_SRC) : null;
    const 副本 = fs.existsSync(APP_COPY) ? fs.readFileSync(APP_COPY) : null;
    const 一致 = !!真源 && !!副本 && 真源.equals(副本);
    const 标记 = Object.fromEntries(FIX_TAGS.map(tag => [tag.slice(1), !!(副本 && 副本.toString('utf8').includes(tag))]));
  say('源-副本一致=' + 一致 + '  app 副本里的修法标记=' + JSON.stringify(标记));
    if (!一致) say('  ⚠ app/renderer/js/math-edit.js 与真源不一致——先在 Typora-Editor-App 跑 npm run sync，否则下面测的是旧代码！');
    if (副本 && !FIX_TAGS.every(tag => 副本.toString('utf8').includes(tag))) say('  ⚠ app 副本里缺部分修法标记（突变验证中？）——A1/B4/B7 的红绿请对照本行核对。');

    剪贴板存档 = harness.saveClipboard(OUT);          // 系统剪贴板：开头存、结尾还
    for (const [名, 用例] of [['A1', 用例A1], ['B4', 用例B4], ['B7', 用例B7], ['E1', 用例E1], ['E2', 用例E2]]) {
      say(`\n══ ${名} ══`);
      try { await 用例(); }
      catch (error) { say(`  ${名} 用例异常：` + String(error && error.message || error).slice(0, 300)); 判(名, 'FAIL', { 异常: String(error && error.message || error).slice(0, 200) }); }
    }
  } finally {
    if (剪贴板存档) {
      try { harness.restoreClipboard(OUT, 剪贴板存档.__file || 剪贴板存档.file); say('\n系统剪贴板已恢复。'); }
      catch (error) { say('恢复剪贴板失败：' + String(error.message).slice(0, 120)); }
    }
    fs.writeFileSync(path.join(OUT, 'trace.txt'), LOG.join('\n'), 'utf8');
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
