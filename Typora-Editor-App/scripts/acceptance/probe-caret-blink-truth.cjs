/** 探针 · 原生光标到底画没画：**闪烁**特性决定单帧不能作证，必须连拍。
 *
 *  用户 2026-10-01 报"公式后面有个偏粗的多余光标"。要判"多出来的那根"是谁，先得知道
 *  在"段末行内公式之后的元素边界位置"上，Chromium 自己画不画光标：
 *   · 合成器（capturePage）**永远不含**原生光标——图上有竖线就一定是我们的合成线；
 *   · 真屏 GDI 含原生光标，但它 ~500ms 亮 / ~500ms 灭，单帧拍到"灭"就是假阴性。
 *  所以两种落点各连拍 8 帧（跨 1.04s > 一个闪烁周期），逐帧列柱计数。
 *
 *  用法：node scripts/acceptance/probe-caret-blink-truth.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-caret-blink');
const IF = hi.IF, SURFACE = hi.SURFACE;
const PS = (script, args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(harness.project, 'scripts/acceptance', script), ...args], { stdio: 'pipe', windowsHide: true }).toString().trim();
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const BODY = [
  '# 行程问题', '',
  '纵向时刻表，横向：路程/速度=时间', '',
  '循环往返问题：对侧相向出发：$S=L(2n-1)$', '',
  '第三段正文收尾。', '',
].join('\n');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'blink.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-caret-blink', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500, inspect: true });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    const 窗口 = () => session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      return {content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor,
        hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16)}; })()`);
    const 顶前 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
    const 收顶 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      win.setAlwaysOnTop(false); return 1; })()`);
    const 状态 = () => session.js(`(() => { const w = ${IF}, d = w.document;
      const bar = d.querySelector('[data-typora-caret-proxy]');
      const sel = w.getSelection();
      let 选区 = null;
      if (sel && sel.rangeCount && sel.focusNode) { const n = sel.focusNode, o = sel.focusOffset;
        const at = n.nodeType === 3 ? n.parentElement : n;
        const pr = d.createRange(); pr.setStart(n, o); pr.collapse(true); const b = pr.getBoundingClientRect();
        选区 = {容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' : n.nodeName + '.' + String(n.className || '').slice(0, 16), 偏移: o,
          原生: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
          层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,li,h1,h2,h3,h4,h5,h6') ? '正文' : '元素级'}; }
      return {合成线: bar ? {显示: bar.style.display, 框: (() => { const b = bar.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()} : null, 选区}; })()`);
    const 连拍 = async (标签, 区域, 帧数 = 12) => {
      await 顶前();
      await harness.sleep(500);
      const info = await 窗口();
      const 前 = await 状态();
      const 回执 = PS('win-screen-burst.ps1', ['-OutPrefix', path.join(OUT, 标签), '-Hwnd', info.hwnd,
        '-X', String(Math.round((info.content.x + 区域.x) * info.scale)),
        '-Y', String(Math.round((info.content.y + 区域.y) * info.scale)), '-W', String(Math.round(区域.w * info.scale)),
        '-H', String(Math.round(区域.h * info.scale)), '-Count', String(帧数), '-IntervalMs', '150']);
      const 后 = await 状态();
      await 收顶();
      say(`\n── ${标签} ──`);
      say('  区域(CSS)=' + JSON.stringify(区域) + '  原生框=' + JSON.stringify(前.选区?.原生) + ' 合成线=' + JSON.stringify(前.合成线));
      say('  逐帧列柱（物理像素，1.5x）：');
      for (const line of 回执.split('\n')) say('    ' + line);
      say('  拍后状态：' + JSON.stringify(后.选区) + ' 合成线=' + JSON.stringify(后.合成线));
      return 回执;
    };

    // 0 对照：正文文字中间（原生光标一定画得出来）
    const 对照 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 段 = [...s.children].find(n => n.textContent.includes('纵向时刻表'));
      const walker = d.createTreeWalker(段, NodeFilter.SHOW_TEXT); let n = null;
      while (walker.nextNode()) if (walker.currentNode.data.length > 4) { n = walker.currentNode; break; }
      const r = d.createRange(); r.setStart(n, 5); r.setEnd(n, 6); const b = r.getBoundingClientRect();
      return {点: {x: Math.round(frame.x + b.left), y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.left) - 30, y: Math.round(frame.y + b.top) - 10, w: 80, h: Math.round(b.height + 20)}}; })()`);
    say('【0 对照】点=' + JSON.stringify(对照.点));
    await session.click(对照.点.x, 对照.点.y);
    await harness.sleep(400);
    await 连拍('0对照', 对照.区);

    // A：段末行内公式之后的元素边界位置（点行末外侧空白）
    const A = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const b = owner.getBoundingClientRect();
      return {点: {x: Math.round(frame.x + b.right + 24), y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.right) - 30, y: Math.round(frame.y + b.top) - 10, w: 80, h: Math.round(b.height + 20)}}; })()`);
    say('\n【A】点=' + JSON.stringify(A.点) + '（公式之后的元素边界位置）');
    await session.click(A.点.x, A.点.y);
    await harness.sleep(400);
    await 连拍('A段末公式后', A.区);
    // 顺带：同位置再来一次连拍（若第一次的相位是"灭"，第二次仍要有一致的结论）
    await 连拍('A段末公式后-第二遍', A.区, 12);
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
