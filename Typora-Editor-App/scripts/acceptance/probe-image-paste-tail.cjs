/** 探针 · 粘贴流程第二批：截图粘在**文档最后、独占一段**（用户口径"文档最后如果是一个图片"）。
 *
 *  步骤：打开 '# 粘贴测试\n\n正文一行。\n' → Ctrl+End → 回车（新空段）→ Ctrl+V 粘截图
 *  （1600×900，落成整栏宽图片）→ 此时文档以图片结尾。然后：
 *    ① 连点 1..4 次：每次读展开态 + class 变更时间线（谁在摘 --expand）
 *    ② 点"图片右侧窄空白"（图右缘 +8/+24px，图垂直中线）→ 落点 → 回车 → 打字 Z → 源码 + 磁盘
 *    ③ 点"图片下方空白" → 同上
 *    ④ 对照组：把光标先放到正文里，再按 Ctrl+End（键盘到底）→ 打字，看是否落在图后
 *
 *  用法：node scripts/acceptance/probe-image-paste-tail.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-paste-tail');
const IF = hi.IF;
const BODY = ['# 粘贴测试', '', '正文一行。', ''].join('\n');

const PICK = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const imgs = [...d.querySelectorAll('${hi.SURFACE} img')];
  const img = imgs[imgs.length - 1];
  if (!img) return { ok: false, 图数: imgs.length };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  let top = img; while (top.parentElement && top.parentElement !== s) top = top.parentElement;
  const pb = top.getBoundingClientRect();
  return { ok: true, 图数: imgs.length, 自然: img.naturalWidth + 'x' + img.naturalHeight,
    显示: Math.round(r.width) + 'x' + Math.round(r.height),
    图盒: { l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), t: Math.round(fr.y + r.top), b: Math.round(fr.y + r.bottom) },
    块盒: { l: Math.round(fr.x + pb.left), r: Math.round(fr.x + pb.right), t: Math.round(fr.y + pb.top), b: Math.round(fr.y + pb.bottom) },
    中心: { x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) },
    右外8: { x: Math.round(fr.x + r.right + 8), y: Math.round(fr.y + r.top + r.height / 2) },
    右外24: { x: Math.round(fr.x + r.right + 24), y: Math.round(fr.y + r.top + r.height / 2) },
    图下12: { x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.bottom + 12) },
    图下右12: { x: Math.round(fr.x + r.right + 8), y: Math.round(fr.y + r.bottom + 12) },
    块数: s.children.length }; })()`;

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  const exp = d.querySelector('.vditor-ir__node[data-type].vditor-ir__node--expand');
  if (!sel || !sel.rangeCount) return { 选区: null, 展开: exp ? exp.getAttribute('data-type') : null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  let 块 = -1; if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; 块 = [...s.children].indexOf(top); }
  const 层 = !inEditor ? '外' : (at.closest('code') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文');
  const ib = r.getBoundingClientRect();
  return { 展开: exp ? exp.getAttribute('data-type') : null, 块, 层,
    容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed, 在图上: !!(at.closest && at.closest('img')),
    光标盒: { x: Math.round(ib.left), y: Math.round(ib.top), w: Math.round(ib.width), h: Math.round(ib.height) },
    焦点: (() => { const f = document.getElementById('editor'); return !!(f && f.contentWindow && f.contentWindow.document.hasFocus()); })() }; })()`;

const ARM = `(() => { const w = ${IF}; if (w.__clsArmed) { w.__clsProbe.changes.length = 0; return { ok: true }; }
  const log = w.__clsProbe = { changes: [] }; const t0 = w.performance.now();
  const proto = Object.getPrototypeOf(w.document.querySelector('${hi.SURFACE}').classList);
  const wrap = (name, original) => function (...args) {
    let val = null; try { val = this.value; } catch { val = null; }
    if (val && String(val).includes('vditor-ir__node')) {
      log.changes.push({ t: +(w.performance.now() - t0).toFixed(1), op: name + '(' + args.join(',') + ')', 前: String(val).slice(0, 60),
        栈: String(new Error().stack || '').split('\\n').slice(2, 5).map(s => s.trim().replace(/https?:[^)]*\\//, '').slice(0, 100)) });
    }
    return original.apply(this, args);
  };
  proto.add = wrap('add', proto.add); proto.remove = wrap('remove', proto.remove); w.__clsArmed = true; return { ok: true }; })()`;
const READ_CLS = `(() => { const w = ${IF}; return w.__clsProbe ? w.__clsProbe.changes : null; })()`;

const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

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

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, 'screenshot-like.png');
  fs.writeFileSync(shot, hi.fixtures.png(1600, 900, [40, 44, 60]));
  const file = path.join(OUT, 'paste-tail.md');
  fs.writeFileSync(file, BODY, 'utf8');
  let clipState = null;
  try { clipState = harness.saveClipboard(OUT); } catch (error) { console.log('剪贴板存档失败（继续）：' + error.message); }
  const setter = path.join(OUT, 'set-clipboard-image.ps1');
  fs.writeFileSync(setter, ['param([string]$Path)', '-Add-Type -AssemblyName System.Windows.Forms'.slice(1), '-Add-Type -AssemblyName System.Drawing'.slice(1),
    '$img = [System.Drawing.Image]::FromFile($Path)', '[System.Windows.Forms.Clipboard]::SetImage($img)', '$img.Dispose()', 'Write-Output "set"'].join('\r\n'), 'utf8');

  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-paste-tail', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); log.push(line); };
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1500 });
  try {
    execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', setter, '-Path', shot], { encoding: 'utf8' });
    const tp = await session.js(textPointOf('正文一行'));
    await clickAt(session, tp.x, tp.y); await harness.sleep(250);
    await combo(session, 'End', 'End', 35, 2); await harness.sleep(150);   // Ctrl+End 到文末
    await enter(session); await harness.sleep(250);                         // 新空段（图片独占一行）
    await combo(session, 'v', 'KeyV', 86);                                  // 真 Ctrl+V
    let geom = null;
    for (let i = 0; i < 30; i++) { await harness.sleep(400); const g = await session.js(PICK); if (g.ok) { geom = g; break; } }
    say({ 粘贴后: { 图片: geom, 源码: String(await hi.mdNow(session)).slice(0, 120) } });
    if (!geom) throw new Error('粘贴后没等到图片');
    await session.shot('粘贴完成');

    // ① 连点 1..4 次（每次从折叠态起步）
    await session.js(ARM);
    for (const 次数 of [1, 2, 3, 4]) {
      const tp2 = await session.js(textPointOf('正文一行'));
      await clickAt(session, tp2.x, tp2.y); await harness.sleep(260);
      await session.js(ARM);
      for (let i = 1; i <= 次数; i++) { await clickAt(session, geom.中心.x, geom.中心.y, i); await harness.sleep(45); }
      await harness.sleep(380);
      const 终 = await session.js(READ);
      const 轨迹 = (await session.js(READ_CLS)) || [];
      say({ ['①/连点' + 次数 + '次']: { 展开: 终.展开, 层: 终.层, 容器: 终.容器, 偏移: 终.偏移, 折叠: 终.折叠, 焦点: 终.焦点,
        变更: 轨迹.map(c => ({ op: c.op, 栈顶: c.栈[0] })) } });
      if (次数 === 3) await session.shot('①连点3次');
    }

    // ② / ③ 点右侧窄空白、点下方空白 → 回车 → 打字
    for (const 名 of ['右外8', '右外24', '图下12', '图下右12']) {
      const tp2 = await session.js(textPointOf('正文一行'));
      await clickAt(session, tp2.x, tp2.y); await harness.sleep(240);
      const 前 = String(await hi.mdNow(session));
      await clickAt(session, geom[名].x, geom[名].y); await harness.sleep(340);
      const 落 = await session.js(READ);
      await session.shot('②' + 名 + '-落点');
      await enter(session); await harness.sleep(420);
      const 回车后 = String(await hi.mdNow(session));
      await session.type('Z'); await harness.sleep(420);
      const 打Z = String(await hi.mdNow(session));
      await session.shot('②' + 名 + '-回车打Z');
      say({ ['②/' + 名]: { 落点: 落, 回车变化: 回车后 === 前 ? '无' : '有', 打Z尾: 打Z.slice(-44) } });
      await combo(session, 'z', 'KeyZ', 90); await harness.sleep(200);
      await combo(session, 'z', 'KeyZ', 90); await harness.sleep(260);
    }

    // ④ 对照组：Ctrl+End 到底打字
    const tp3 = await session.js(textPointOf('正文一行'));
    await clickAt(session, tp3.x, tp3.y); await harness.sleep(220);
    await combo(session, 'End', 'End', 35, 2); await harness.sleep(200);
    const 落4 = await session.js(READ);
    await session.type('Y'); await harness.sleep(400);
    say({ '④/Ctrl+End': { 落点: 落4, 打Y尾: String(await hi.mdNow(session)).slice(-44) } });
    await session.shot('④CtrlEnd打Y');
  } finally {
    say({ console错误: session.errors.slice(0, 3) });
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
    await ctx.release(session);
    if (clipState && clipState.__file) { try { harness.restoreClipboard(OUT, clipState.__file); } catch (error) { console.log('剪贴板恢复失败：' + error.message); } }
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
