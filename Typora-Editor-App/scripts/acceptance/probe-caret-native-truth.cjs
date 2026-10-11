/** 探针 · "公式后面那根粗线"是谁画的——把合成线**摘掉**再看真屏。
 *
 *  方法（把问题变成可判定的）：合成器抓帧永远不含原生光标，真屏抓帧含原生光标但光标会闪；
 *  所以做三轮连拍对比：
 *    ① 对照（正文文字中间）：合成线按契约不画 → 真屏若有竖线，那是**原生**光标（方法自检）；
 *    ② 公式之后的元素边界位置（用户截图处）：合成线画着 → 数一数真屏上有几根；
 *    ③ 同一位置、把合成线节点从 DOM 里摘掉 → 真屏上还有没有竖线？有 = 原生也画着（双光标），
 *       没有 = 原生根本没画（那根粗线就是合成线，用户看到的"细的"是公式的右括号 `)`）。
 *
 *  每帧都先从 Electron 端把窗口顶到最前（GDI 抓的是屏幕像素，window 被盖住就拍到别人）。
 *  用法：node scripts/acceptance/probe-caret-native-truth.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-caret-native');
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
  const file = path.join(OUT, 'native.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-caret-native', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500, inspect: true });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    const 窗口 = () => session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      return {content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor}; })()`);
    const 顶前 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
    const 收顶 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      win.setAlwaysOnTop(false); return 1; })()`);
    const 状态 = () => session.js(`(() => { const w = ${IF}, d = w.document;
      const bar = d.querySelector('[data-typora-caret-proxy]');
      const sel = w.getSelection(); let 选区 = null;
      if (sel && sel.rangeCount && sel.focusNode) { const n = sel.focusNode, o = sel.focusOffset;
        const at = n.nodeType === 3 ? n.parentElement : n;
        const pr = d.createRange(); pr.setStart(n, o); pr.collapse(true); const b = pr.getBoundingClientRect();
        选区 = {容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' : n.nodeName + '.' + String(n.className || '').slice(0, 14), 偏移: o,
          原生: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
          层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,h1,h2,h3') ? '正文' : '元素级'}; }
      return {合成线: bar ? {在DOM里: bar.isConnected, 显示: bar.style.display, 框: (() => { const b = bar.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()} : null, 选区}; })()`);
    /** 真屏连拍：每帧先顶窗口再抓（PowerShell 每次 ~1.5s，帧距自然 >1s，足以跨过闪烁周期）。 */
    const 真屏连拍 = async (标签, 区域, 帧数 = 6) => {
      const 行 = [];
      for (let i = 0; i < 帧数; i++) {
        await 顶前();
        await harness.sleep(350);
        const info = await 窗口();
        const out = path.join(OUT, 标签 + '-f' + i + '.png');
        PS('win-screen-crop-xy.ps1', ['-Out', out,
          '-X', String(Math.round((info.content.x + 区域.x) * info.scale)), '-Y', String(Math.round((info.content.y + 区域.y) * info.scale)),
          '-W', String(Math.round(区域.w * info.scale)), '-H', String(Math.round(区域.h * info.scale))]);
        const 柱 = PS('win-png-bars.ps1', ['-In', out]).split('\n').slice(1).map(s => s.trim()).filter(Boolean);
        行.push('    f' + i + ': ' + 柱.join(' '));
        await harness.sleep(200);
      }
      await 收顶();
      say(`  真屏连拍 ${标签}（区域 CSS=${JSON.stringify(区域)}，1.5x）：`);
      for (const r of 行) say(r);
      return 行;
    };
    const 合成 = async (标签, 区域) => {
      const out = path.join(OUT, 标签 + '-合成器.png');
      const b64 = await session.main.js(`(async () => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        const image = await win.webContents.capturePage({x: ${Math.round(区域.x)}, y: ${Math.round(区域.y)}, width: ${Math.round(区域.w)}, height: ${Math.round(区域.h)}});
        return image.toPNG().toString('base64'); })()`);
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      say('  合成器：' + PS('win-png-bars.ps1', ['-In', out]).split('\n').slice(1).map(s => s.trim()).filter(Boolean).join(' '));
    };

    // ── ① 对照：正文文字中间 ──
    const 对照 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 段 = [...s.children].find(n => n.textContent.includes('纵向时刻表'));
      const walker = d.createTreeWalker(段, NodeFilter.SHOW_TEXT); let n = null;
      while (walker.nextNode()) if (walker.currentNode.data.length > 4) { n = walker.currentNode; break; }
      const r = d.createRange(); r.setStart(n, 5); r.setEnd(n, 6); const b = r.getBoundingClientRect();
      return {点: {x: Math.round(frame.x + b.left), y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.left) - 30, y: Math.round(frame.y + b.top) - 10, w: 70, h: Math.round(b.height + 20)}}; })()`);
    say('\n══ ① 对照 · 正文文字中间 ══');
    await session.click(对照.点.x, 对照.点.y);
    await harness.sleep(400);
    say('  DOM：' + JSON.stringify(await 状态()));
    await 合成('1对照', 对照.区);
    await 真屏连拍('1对照', 对照.区);

    // ── ② 公式之后的元素边界位置（合成线在画） ──
    const A = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const b = owner.getBoundingClientRect();
      return {点: {x: Math.round(frame.x + b.right + 24), y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.right) - 24, y: Math.round(frame.y + b.top) - 10, w: 70, h: Math.round(b.height + 20)}}; })()`);
    say('\n══ ② 公式之后（合成线画着）══');
    await session.click(A.点.x, A.点.y);
    await harness.sleep(400);
    say('  DOM：' + JSON.stringify(await 状态()));
    await 合成('2公式后', A.区);
    await 真屏连拍('2公式后', A.区);

    // ── ③ 摘掉合成线，同一位置再看真屏 ──
    say('\n══ ③ 摘掉合成线节点，同一位置再看真屏 ══');
    const 摘 = await session.js(`(() => { const w = ${IF}, d = w.document;
      const bar = d.querySelector('[data-typora-caret-proxy]');
      if (!bar) return {ok: false};
      bar.remove();
      return {ok: true}; })()`);
    say('  摘除：' + JSON.stringify(摘) + '  DOM：' + JSON.stringify(await 状态()));
    await 真屏连拍('3无合成线', A.区);
    say('  （合成线摘掉后 update() 仍会往已移除的节点上画，屏幕上不会再出现它）');
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
