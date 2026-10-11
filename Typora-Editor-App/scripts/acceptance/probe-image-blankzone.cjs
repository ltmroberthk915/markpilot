/** 探针 · 图片空白带的命中目标与落点（坐标系修正版）。
 *
 *  上一批探针用 iframe 的 elementFromPoint 传了顶层页坐标（错的）。这次一律换算到
 *  iframe 坐标系，并把命中链（点到谁、它在不在可编辑区里）与点击后的落点一起钉出来。
 *  场景：截图粘在文档最后、独占一段（整栏宽图片）。测试点：
 *    · 图右缘 +8px（段落里，窄空白带）
 *    · 图右缘 +24px（段落里更靠右）
 *    · 块右缘 -4px（段落右padding）
 *    · 图下方 3/12/30px（左半、右半各一列）
 *    · 编辑面右 padding（块右缘 +10px）
 *
 *  用法：node scripts/acceptance/probe-image-blankzone.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-blankzone');
const IF = hi.IF;
const BODY = ['# 粘贴测试', '', '正文一行。', ''].join('\n');

const GEO = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect(); const sb = s.getBoundingClientRect();
  let top = img; while (top.parentElement && top.parentElement !== s) top = top.parentElement;
  const pb = top.getBoundingClientRect();
  const P = (x, y) => ({ x: Math.round(fr.x + x), y: Math.round(fr.y + y) });
  return { ok: true,
    编辑面: { l: Math.round(fr.x + sb.left), r: Math.round(fr.x + sb.right), t: Math.round(fr.y + sb.top), b: Math.round(fr.y + sb.bottom) },
    块: { l: Math.round(fr.x + pb.left), r: Math.round(fr.x + pb.right), t: Math.round(fr.y + pb.top), b: Math.round(fr.y + pb.bottom) },
    图: { l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), t: Math.round(fr.y + r.top), b: Math.round(fr.y + r.bottom) },
    点: {
      图右外8: P(r.right + 8, r.top + r.height / 2), 图右外24: P(r.right + 24, r.top + r.height / 2),
      块右padding: P(sb.width - 6, r.top + r.height / 2),
      图下左3: P(r.left + 20, r.bottom + 3), 图下右3: P(r.right + 8, r.bottom + 3),
      图下左30: P(r.left + 20, r.bottom + 30), 图下右30: P(r.right + 8, r.bottom + 30),
      编辑面右外: P(sb.width + 10, r.top + r.height / 2),
    } }; })()`;

const HIT = 点 => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const el = d.elementFromPoint(${点.x} - fr.x, ${点.y} - fr.y);
  if (!el) return null;
  const s = d.querySelector('${hi.SURFACE}');
  const chain = []; let node = el;
  while (node && chain.length < 6) { chain.push(node.nodeName + (node.className ? '.' + String(node.className).split(' ').slice(0, 2).join('.') : '') + (node.isContentEditable ? '[ed]' : '')); node = node.parentElement; }
  return { 在编辑面内: !!s && s.contains(el), 链: chain }; })()`;

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  if (!sel || !sel.rangeCount) return { 选区: null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  const info = { 在编辑面内: inEditor, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName, 偏移: r.startOffset, 折叠: r.collapsed };
  if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; info.块 = [...s.children].indexOf(top); info.块标签 = top.nodeName; }
  return info; })()`;

async function clickAt(session, x, y, clickCount = 1) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}
async function combo(session, key, code, vk, modifiers = 2) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
async function enter(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await session.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, 'screenshot-like.png');
  fs.writeFileSync(shot, hi.fixtures.png(1600, 900, [40, 44, 60]));
  const file = path.join(OUT, 'blankzone.md');
  fs.writeFileSync(file, BODY, 'utf8');
  let clipState = null;
  try { clipState = harness.saveClipboard(OUT); } catch (error) { console.log('剪贴板存档失败（继续）：' + error.message); }
  const setter = path.join(OUT, 'set-clipboard-image.ps1');
  fs.writeFileSync(setter, ['param([string]$Path)', 'Add-Type -AssemblyName System.Windows.Forms', 'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Drawing.Image]::FromFile($Path)', '[System.Windows.Forms.Clipboard]::SetImage($img)', '$img.Dispose()', 'Write-Output "set"'].join('\r\n'), 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-blankzone', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); log.push(line); };
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1500 });
  try {
    execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', setter, '-Path', shot], { encoding: 'utf8' });
    const tp = await session.js(textPointOf('正文一行'));
    await clickAt(session, tp.x, tp.y); await harness.sleep(250);
    await combo(session, 'End', 'End', 35, 2); await harness.sleep(150);
    await enter(session); await harness.sleep(250);
    await combo(session, 'v', 'KeyV', 86);
    let geom = null;
    for (let i = 0; i < 30; i++) { await harness.sleep(400); const g = await session.js(GEO); if (g.ok) { geom = g; break; } }
    if (!geom) throw new Error('粘贴后没等到图片');
    say({ 几何: { 编辑面: geom.编辑面, 块: geom.块, 图: geom.图 } });
    for (const [名, 点] of Object.entries(geom.点)) {
      const hit = await session.js(HIT(点));
      const tp2 = await session.js(textPointOf('正文一行'));
      await clickAt(session, tp2.x, tp2.y); await harness.sleep(240);
      await clickAt(session, 点.x, 点.y); await harness.sleep(320);
      const 落 = await session.js(READ);
      await session.type('W'); await harness.sleep(360);
      const md = String(await hi.mdNow(session));
      const 打字去 = md.includes('W') ? '进了文档' : '丢了';
      say({ [名]: { 点, 命中: hit, 落点: 落, 打字: 打字去, 尾: md.slice(-30) } });
      await combo(session, 'z', 'KeyZ', 90); await harness.sleep(240);
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
    await ctx.release(session);
    if (clipState && clipState.__file) { try { harness.restoreClipboard(OUT, clipState.__file); } catch (error) { console.log('剪贴板恢复失败：' + error.message); } }
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
