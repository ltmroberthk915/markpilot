/** 探针 · 用户流程复刻：**Windows 截图 → 粘贴进文档**（2026-10-02 用户令："图片是通过
 *  windows 截图后粘贴进文档的 你试试"）。
 *
 *  流程：把一张 1600×900 的"截图"放进系统剪贴板（独立进程）→ 应用里真按 Ctrl+V →
 *  等图片归档并插入 → 在**粘贴出来的这张图**上复测：
 *    ① 单击 / 连点 2..4 次：`vditor-ir__node--expand` 的终态（源码展不开的概率从哪来）
 *    ② 点图右侧空白 → 落点读数 → 回车 → 打字 Z → 源码与磁盘（"图片之后的光标 + 回车新行"）
 *    ③ 点图下方空白 → 同上
 *  结束时恢复剪贴板（save/restore，剪贴板是共享资源）。
 *
 *  用法：node scripts/acceptance/probe-image-paste-flow.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-paste-flow');
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
  const sb = s.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  return { ok: true, 图数: imgs.length, 自然: img.naturalWidth + 'x' + img.naturalHeight,
    显示: Math.round(r.width) + 'x' + Math.round(r.height),
    图盒: { l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), t: Math.round(fr.y + r.top), b: Math.round(fr.y + r.bottom) },
    块盒: { l: Math.round(fr.x + pb.left), r: Math.round(fr.x + pb.right), t: Math.round(fr.y + pb.top), b: Math.round(fr.y + pb.bottom) },
    编辑面: { l: Math.round(fr.x + sb.left), r: Math.round(fr.x + sb.right) },
    中心: { x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) },
    右外40: { x: Math.round(fr.x + r.right + 40), y: Math.round(fr.y + r.top + r.height / 2) },
    右外8: { x: Math.round(fr.x + r.right + 8), y: Math.round(fr.y + r.top + r.height / 2) },
    图下20: { x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.bottom + 20) },
    节点类: owner ? owner.className : null, dataType: owner ? owner.getAttribute('data-type') : null }; })()`;

const READ = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  const ownerNow = d.querySelector('.vditor-ir__node[data-type].vditor-ir__node--expand');
  if (!sel || !sel.rangeCount) return { 选区: null, 展开节点: ownerNow ? ownerNow.getAttribute('data-type') : null };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  let 块 = -1; if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; 块 = [...s.children].indexOf(top); }
  const 层 = !inEditor ? '外' : (at.closest('code') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文');
  const ib = r.getBoundingClientRect();
  return { 展开节点: ownerNow ? ownerNow.getAttribute('data-type') : null, 块, 层,
    容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed, 在图上: !!(at.closest && at.closest('img')),
    光标盒: { x: Math.round(ib.left), y: Math.round(ib.top), w: Math.round(ib.width), h: Math.round(ib.height) } }; })()`;

const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

async function clickAt(session, x, y, clickCount = 1) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}
async function combo(session, key, code, vk) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
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
  const file = path.join(OUT, 'paste-flow.md');
  fs.writeFileSync(file, BODY, 'utf8');

  // 剪贴板：先存档（结束时恢复），再放图
  let clipState = null;
  try { clipState = harness.saveClipboard(OUT); } catch (error) { console.log('剪贴板存档失败（继续）：' + error.message); }
  const setter = path.join(OUT, 'set-clipboard-image.ps1');
  fs.writeFileSync(setter, [
    'param([string]$Path)',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Drawing.Image]::FromFile($Path)',
    '[System.Windows.Forms.Clipboard]::SetImage($img)',
    '$img.Dispose()',
    'Write-Output "set"',
  ].join('\r\n'), 'utf8');

  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-paste-flow', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); log.push(line); };
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1500 });
  try {
    execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', setter, '-Path', shot], { encoding: 'utf8' });
    say('剪贴板已放入截图 1600×900');
    // 光标放到正文行尾，再真按 Ctrl+V
    const tp = await session.js(textPointOf('正文一行'));
    await clickAt(session, tp.x, tp.y); await harness.sleep(250);
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
    await harness.sleep(150);
    await combo(session, 'v', 'KeyV', 86);
    // 等图片归档并插入
    let geom = null;
    for (let i = 0; i < 30; i++) {
      await harness.sleep(400);
      const g = await session.js(PICK);
      if (g.ok) { geom = g; break; }
    }
    const md = String(await hi.mdNow(session));
    say({ 粘贴后: { 图片: geom, 源码: md } });
    if (!geom) throw new Error('粘贴后没等到图片元素');
    await session.shot('粘贴完成');

    // ══ ① 单击 / 连点 2..4 次：展开态 ═══════════════════════════════════════
    for (const 次数 of [1, 2, 3, 4]) {
      const tp2 = await session.js(textPointOf('正文一行'));
      await clickAt(session, tp2.x, tp2.y); await harness.sleep(260);
      for (let i = 1; i <= 次数; i++) { await clickAt(session, geom.中心.x, geom.中心.y, i); await harness.sleep(45); }
      await harness.sleep(380);
      const 终 = await session.js(READ);
      say({ ['①/连点' + 次数 + '次']: { 展开节点: 终.展开节点, 层: 终.层, 容器: 终.容器, 偏移: 终.偏移 } });
      if (次数 === 3) await session.shot('①连点3次');
    }

    // ══ ② 点图右侧空白 → 回车 → 打字 ════════════════════════════════════════
    for (const 名 of ['右外8', '右外40', '图下20']) {
      const tp2 = await session.js(textPointOf('正文一行'));
      await clickAt(session, tp2.x, tp2.y); await harness.sleep(240);
      const 前 = String(await hi.mdNow(session));
      const 命中 = await session.js(`(() => { const w = ${IF}, d = w.document; const el = d.elementFromPoint(${geom[名].x}, ${geom[名].y});
        return el ? el.nodeName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') : null; })()`);
      await clickAt(session, geom[名].x, geom[名].y); await harness.sleep(340);
      const 落 = await session.js(READ);
      await session.shot('②' + 名 + '-落点');
      await enter(session); await harness.sleep(420);
      const 回车后 = String(await hi.mdNow(session));
      await session.type('Z'); await harness.sleep(420);
      const 打Z = String(await hi.mdNow(session));
      await session.shot('②' + 名 + '-回车打Z');
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      say({ ['②/' + 名]: { 命中元素: 命中, 落点: 落, 回车新增块: 回车后 !== 前, 打Z尾: 打Z.slice(-70), 磁盘尾: String(saved.after).replace(/\r/g, '').slice(-70) } });
      // 复原：两次撤销（Z、回车）
      await combo(session, 'z', 'KeyZ', 90); await harness.sleep(200);
      await combo(session, 'z', 'KeyZ', 90); await harness.sleep(260);
    }
  } finally {
    say({ console错误: session.errors.slice(0, 3) });
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
    await ctx.release(session);
    if (clipState && clipState.__file) { try { harness.restoreClipboard(OUT, clipState.__file); } catch (error) { console.log('剪贴板恢复失败：' + error.message); } }
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
