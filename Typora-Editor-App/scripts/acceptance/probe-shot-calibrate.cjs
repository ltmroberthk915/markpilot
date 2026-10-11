/** 标定：把"页面 CSS 坐标 → 屏幕物理像素"的两条候选口径放在同一画面里比。
 *  A) Electron `win.getContentBounds()`（DIP）× scale
 *  B) user32 `GetClientRect`+`ClientToScreen`（句柄）
 *  同一块区域三种抓法：合成器（页面坐标的真相）+ A + B，谁和合成器对得上就用谁。
 *  用法：node scripts/acceptance/probe-shot-calibrate.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-shot-calibrate');
const IF = hi.IF, SURFACE = hi.SURFACE;
const PS = (script, args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(harness.project, 'scripts/acceptance', script), ...args], { stdio: 'pipe' }).toString().trim();

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'cal.md');
  fs.writeFileSync(file, ['# 标定标题', '', '标定正文一行：$S=L(2n-1)$ 结尾。', '', '第三段。', ''].join('\n'), 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-shot-calibrate', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1500, inspect: true });
  try {
    await hi.ensureFocus(session);
    await session.main.js(`(() => { const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
    await harness.sleep(600);
    const info = await session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
      const wins = BrowserWindow.getAllWindows().map((w, i) => ({i, id: w.id, destroyed: w.isDestroyed(), visible: w.isVisible(),
        title: w.getTitle(), bounds: w.getBounds(), content: w.getContentBounds(),
        hwnd: w.getNativeWindowHandle().readBigUInt64LE(0).toString(16)}));
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      return {wins, scale: screen.getDisplayMatching(win.getBounds()).scaleFactor,
        zoom: win.webContents.getZoomFactor()}; })()`);
    console.log('窗口清单：' + JSON.stringify(info.wins, null, 1));
    console.log('scale=' + info.scale + ' zoom=' + info.zoom);
    const 页 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const p = [...s.children].find(n => n.textContent.includes('标定正文'));
      const owner = p.querySelector('.vditor-ir__node[data-type="inline-node"]'); const b = (owner || p).getBoundingClientRect();
      return {frame: [Math.round(frame.x), Math.round(frame.y)], 锚右: Math.round(frame.x + b.right), 锚顶: Math.round(frame.y + b.top),
        screenX: w.screenX, screenY: w.screenY, dpr: w.devicePixelRatio}; })()`);
    console.log('页面锚点：' + JSON.stringify(页));
    const 截 = {x: 页.锚右 - 60, y: 页.锚顶 - 12, w: 130, h: 44};
    const 合 = path.join(OUT, '合成器.png');
    const b64 = await session.main.js(`(async () => { const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      const image = await win.webContents.capturePage({x: ${截.x}, y: ${截.y}, width: ${截.w}, height: ${截.h}});
      return image.toPNG().toString('base64'); })()`);
    fs.writeFileSync(合, Buffer.from(b64, 'base64'));
    const win = info.wins.find(w => !w.destroyed);
    const A = {x: Math.round((win.content.x + 截.x) * info.scale), y: Math.round((win.content.y + 截.y) * info.scale),
      w: Math.round(截.w * info.scale), h: Math.round(截.h * info.scale)};
    const 甲图 = path.join(OUT, 'A-ElectronContentBounds.png');
    PS('win-screen-crop-xy.ps1', ['-Out', 甲图, '-X', String(A.x), '-Y', String(A.y), '-W', String(A.w), '-H', String(A.h)]);
    const 乙图 = path.join(OUT, 'B-句柄.png');
    PS('win-screen-crop.ps1', ['-Out', 乙图, '-Hwnd', win.hwnd, '-CssX', String(截.x), '-CssY', String(截.y),
      '-CssW', String(截.w), '-CssH', String(截.h), '-Scale', String(info.scale)]);
    for (const [名, 图] of [['合成器', 合], ['A-Electron', 甲图], ['B-句柄', 乙图]]) {
      console.log('\n── ' + 名 + ' (' + 图 + ') ──');
      console.log(PS('win-png-bars.ps1', ['-In', 图]).split('\n').slice(0, 10).join('\n'));
    }
  } finally { await ctx.release(session); }
})().catch(error => { console.error('标定异常：', error); process.exit(1); });
