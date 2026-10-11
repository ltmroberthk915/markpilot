/** 探针 · 粘贴图（整栏宽）空白带的逐步光标：mousedown → mouseup → 稳定，各读一次。
 *  用法：node scripts/acceptance/probe-image-paste-steps.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-paste-steps');
const IF = hi.IF;
const BODY = ['# 粘贴测试', '', '正文一行。', ''].join('\n');

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  if (!sel || !sel.rangeCount) return { 选区: null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  let 块 = -1; if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; 块 = [...s.children].indexOf(top); }
  return { 块, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName, 偏移: r.startOffset, 折叠: r.collapsed }; })()`;

const GEO = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  let top = img; while (top.parentElement && top.parentElement !== s) top = top.parentElement;
  const pb = top.getBoundingClientRect(); const sb = s.getBoundingClientRect();
  const P = (x, y) => ({ x: Math.round(frame.x + x), y: Math.round(frame.y + y), 局: { x: Math.round(x), y: Math.round(y) } });
  const 点 = {
    右外8: P(r.right + 8, r.top + r.height / 2), 右外24: P(r.right + 24, r.top + r.height / 2),
    右外60: P(r.right + 60, r.top + r.height / 2), 图下12: P(r.left + 20, r.bottom + 12),
  };
  for (const [名, 点项] of Object.entries(点)) {
    const el = d.elementFromPoint(点项.局.x, 点项.局.y);
    const native = d.caretRangeFromPoint ? d.caretRangeFromPoint(点项.局.x, 点项.局.y) : null;
    点项.命中 = el ? el.nodeName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') : null;
    点项.原生 = native ? { 容器: native.startContainer.nodeType === 3 ? 'TEXT' : native.startContainer.nodeName, 偏移: native.startOffset } : null;
  }
  return { ok: true, 点, 图盒: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
    块盒: { l: Math.round(pb.left), r: Math.round(pb.right), t: Math.round(pb.top), b: Math.round(pb.bottom) },
    编辑面: { l: Math.round(sb.left), r: Math.round(sb.right) } }; })()`;

const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

async function combo(session, key, code, vk, modifiers = 2) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, 'screenshot-like.png');
  fs.writeFileSync(shot, hi.fixtures.png(1600, 900, [40, 44, 60]));
  const file = path.join(OUT, 'paste-steps.md');
  fs.writeFileSync(file, BODY, 'utf8');
  let clipState = null;
  try { clipState = harness.saveClipboard(OUT); } catch (error) { console.log('剪贴板存档失败（继续）：' + error.message); }
  const setter = path.join(OUT, 'set-clipboard-image.ps1');
  fs.writeFileSync(setter, ['param([string]$Path)', 'Add-Type -AssemblyName System.Windows.Forms', 'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Drawing.Image]::FromFile($Path)', '[System.Windows.Forms.Clipboard]::SetImage($img)', '$img.Dispose()', 'Write-Output "set"'].join('\r\n'), 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-paste-steps', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1500 });
  try {
    execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', setter, '-Path', shot], { encoding: 'utf8' });
    const tp = await session.js(textPointOf('正文一行'));
    await session.click(tp.x, tp.y); await harness.sleep(250);
    await combo(session, 'End', 'End', 35, 2); await harness.sleep(150);
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await session.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await harness.sleep(250);
    await combo(session, 'v', 'KeyV', 86);
    let geom = null;
    for (let i = 0; i < 30; i++) { await harness.sleep(400); const g = await session.js(GEO); if (g.ok) { geom = g; break; } }
    if (!geom) throw new Error('粘贴后没等到图片');
    console.log(JSON.stringify({ 几何: { 图盒: geom.图盒, 块盒: geom.块盒, 编辑面: geom.编辑面 }, 点: geom.点 }, null, 1));
    for (const 名 of ['右外8', '右外24', '右外60', '图下12']) {
      const 点 = geom.点[名];
      await session.click(tp.x, tp.y); await harness.sleep(240);
      const 起点 = await session.js(READ);
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: 1 });
      await harness.sleep(120);
      const 按下后 = await session.js(READ);
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: 1 });
      await harness.sleep(200);
      const 稳定后 = await session.js(READ);
      await session.type('Z'); await harness.sleep(320);
      const md = String(await hi.mdNow(session));
      const 空 = await session.js(`(() => { const w = ${IF}; return false; })()`);
      console.log(JSON.stringify({ [名]: { 点: 点.命中 + '/' + JSON.stringify(点.原生), 起点: 起点.容器 + '@' + 起点.偏移,
        按下后: 按下后.容器 + '@' + 按下后.偏移 + ' 块' + 按下后.块, 稳定后: 稳定后.容器 + '@' + 稳定后.偏移 + ' 块' + 稳定后.块,
        打Z尾: md.slice(-40) } }));
      await combo(session, 'z', 'KeyZ', 90); await harness.sleep(220);
    }
  } finally {
    await ctx.release(session);
    if (clipState && clipState.__file) { try { harness.restoreClipboard(OUT, clipState.__file); } catch (error) { console.log('剪贴板恢复失败：' + error.message); } }
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
