/** 探针 · 合成光标（`[data-typora-caret-proxy]`）到底还有没有存在的必要：
 *  对每个"产品会画合成线"的落点，**把合成线藏起来（inline !important）再连拍真屏**——
 *  真屏是唯一能拍到原生光标的通道（合成器抓帧永远不含它）。
 *
 *  判定：藏线后真屏上还出现"竖线"（窄、高、独立成柱）→ 原生自己画着，合成线是多余的第二根；
 *        藏线后连续 6 帧都没有 → 这个位置上原生真的没画，合成线是唯一可见的光标。
 *
 *  用法：node scripts/acceptance/probe-synthetic-caret-necessity.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-synthetic-caret');
const IF = hi.IF, SURFACE = hi.SURFACE;
const PS = (script, args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(harness.project, 'scripts/acceptance', script), ...args], { stdio: 'pipe', windowsHide: true }).toString().trim();
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const BODY = [
  '# 行程问题', '',
  '第一段正文，用来提供块间空白的参照。', '',
  '行内公式收在行末：$S=L(2n-1)$', '',
  '$x_{独占一行}+1$', '',
  '第三段正文收尾。', '',
].join('\n');

const 状态 = `(() => { const w = ${IF}, d = w.document;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const sel = w.getSelection(); let 选区 = null;
  if (sel && sel.rangeCount && sel.focusNode) { const n = sel.focusNode, o = sel.focusOffset;
    const at = n.nodeType === 3 ? n.parentElement : n;
    const pr = d.createRange(); pr.setStart(n, o); pr.collapse(true); const b = pr.getBoundingClientRect();
    const rb = b && b.height ? b : null;
    选区 = {容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' : n.nodeName + '.' + String(n.className || '').slice(0, 16), 偏移: o,
      原生: rb ? [Math.round(rb.left), Math.round(rb.top), Math.round(rb.width), Math.round(rb.height)] : [0, 0, 0, 0],
      层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,li,h1,h2,h3') ? '正文' : '元素级'}; }
  return {合成线: bar ? {显示: bar.style.display, 框: (() => { const b = bar.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()} : null, 选区}; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'synth.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-synthetic-caret', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 5, settleMs: 1500, inspect: true });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  const 顶前 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
  const 收顶 = () => session.main.js(`(() => { const {BrowserWindow} = require('electron');
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    win.setAlwaysOnTop(false); return 1; })()`);
  const 窗口 = () => session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    return {content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor}; })()`);
  const 藏线 = () => session.js(`(() => { const w = ${IF}, d = w.document;
    const bar = d.querySelector('[data-typora-caret-proxy]');
    if (bar) bar.style.setProperty('display', 'none', 'important');
    return !!bar; })()`);
  const 显线 = () => session.js(`(() => { const w = ${IF}, d = w.document;
    const bar = d.querySelector('[data-typora-caret-proxy]');
    if (bar) bar.style.removeProperty('display');
    const sel = w.getSelection(); if (sel && sel.rangeCount) { const r = sel.getRangeAt(0).cloneRange(); sel.removeAllRanges(); sel.addRange(r); }
    return !!bar; })()`);
  /** 真屏连拍 6 帧：每帧先顶窗口再抓。返回每帧的柱状分组（物理像素）。 */
  const 连拍 = async (标签, 区) => {
    const 帧 = [];
    for (let i = 0; i < 6; i++) {
      await 顶前();
      await harness.sleep(320);
      const info = await 窗口();
      const out = path.join(OUT, 标签 + '-f' + i + '.png');
      PS('win-screen-crop-xy.ps1', ['-Out', out,
        '-X', String(Math.round((info.content.x + 区.x) * info.scale)), '-Y', String(Math.round((info.content.y + 区.y) * info.scale)),
        '-W', String(Math.round(区.w * info.scale)), '-H', String(Math.round(区.h * info.scale))]);
      const 柱 = PS('win-png-bars.ps1', ['-In', out]).split('\n').slice(1).map(s => s.trim()).filter(Boolean);
      帧.push('    f' + i + ': ' + (柱.join(' ') || '（空）'));
      await harness.sleep(150);
    }
    await 收顶();
    for (const f of 帧) say(f);
    return 帧;
  };
  /** 一个落点：读状态 → 藏线 → 连拍 → 恢复。 */
  const 测 = async (名, 区) => {
    const s = await session.js(状态);
    say(`\n── ${名} ──`);
    say('  状态：' + JSON.stringify(s) + '  区域=' + JSON.stringify(区) + '（1.5x）');
    if (!s.合成线 || s.合成线.显示 === 'none') { say('  ⚠ 这个落点上合成线本来就没画，无需连拍'); return; }
    await 藏线();
    say('  已藏线（inline !important），真屏连拍：');
    await 连拍(名, 区);
    await 显线();
  };
  const 区由线 = (线, 宽 = 90) => ({x: 线[0] - 30, y: 线[1] - 12, w: 宽, h: 线[3] + 24});
  try {
    await hi.ensureFocus(session);
    const 参考 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 行内 = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const 块 = [...s.children];
      const 块框 = 块.map(n => { const b = n.getBoundingClientRect(); return {t: b.top, b: b.bottom, h: b.height}; });
      return {frame: [Math.round(frame.x), Math.round(frame.y)], 行内: (() => { const b = 行内.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })(), 块框}; })()`);
    const F = 参考.frame;
    say('参考：frame=' + JSON.stringify(F) + ' 行内公式=' + JSON.stringify(参考.行内));
    say('块框（iframe 坐标）：' + JSON.stringify(参考.块框.map(b => [Math.round(b.t), Math.round(b.b)])));
    const 内右 = F[0] + 参考.行内[2] + 参考.行内[0];        // 行内公式右缘（页面坐标）
    const 内中Y = F[1] + 参考.行内[1] + 参考.行内[3] / 2;

    // 甲：段末行内公式之后（已知原生会画，作为方法自检）
    await session.click(Math.round(内右 + 30), Math.round(内中Y));
    await harness.sleep(400);
    let s = await session.js(状态);
    await 测('甲-段末公式后', 区由线(s.合成线 ? s.合成线.框 : [内右, 内中Y, 0, 20]));

    // 乙：两块之间的空白带（第 1 段与第 2 段之间）
    const 乙 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const kids = [...s.children].filter(n => n.getBoundingClientRect().height > 0);
      const a = kids[1].getBoundingClientRect(), b = kids[2].getBoundingClientRect();
      return {x: Math.round(frame.x + a.left + a.width / 2), y: Math.round(frame.y + a.bottom + (b.top - a.bottom) / 2),
        区: {x: Math.round(frame.x + a.left) - 20, y: Math.round(frame.y + a.bottom) - 14, w: 120, h: Math.round(b.top - a.bottom) + 40}}; })()`);
    await session.click(乙.x, 乙.y);
    await harness.sleep(400);
    await 测('乙-块间空白带', 乙.区);

    // 丙：正文行末右侧 40px 空白
    const 丙 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 段 = [...s.children].find(n => n.textContent.includes('第三段'));
      const b = 段.getBoundingClientRect();
      const 末 = (() => { const walker = d.createTreeWalker(段, NodeFilter.SHOW_TEXT); let n = null, last = null;
        while (walker.nextNode()) if (walker.currentNode.data.trim()) { n = walker.currentNode; }
        if (!n) return null; const r = d.createRange(); r.setStart(n, n.data.length - 1); r.setEnd(n, n.data.length);
        const bb = r.getBoundingClientRect(); return bb; })();
      return {x: Math.round(frame.x + 末.right + 40), y: Math.round(frame.y + b.top + b.height / 2),
        区: {x: Math.round(frame.x + 末.right) - 40, y: Math.round(frame.y + b.top) - 12, w: 120, h: Math.round(b.height) + 24}}; })()`);
    await session.click(丙.x, 丙.y);
    await harness.sleep(400);
    await 测('丙-行末右侧空白', 丙.区);

    // 丁：Ctrl+Home 到文档最前，再 ←（F9 的 surface 级落点）
    await session.key({ key: 'End', code: 'End', vk: 35, modifiers: harness.MOD.ctrl });
    await harness.sleep(300);
    await session.key({ key: 'H', code: 'KeyH', vk: 72, modifiers: harness.MOD.ctrl });
    await harness.sleep(400);
    await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
    await harness.sleep(400);
    s = await session.js(状态);
    await 测('丁-CtrlHome后←', 区由线(s.合成线 ? s.合成线.框 : [F[0] + 60, F[1] + 60, 0, 20]));

    // 戊：块公式上方的留白
    const 戊 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 块式 = [...s.children].find(n => (n.textContent || '').includes('独占一行'));
      const b = 块式.getBoundingClientRect();
      return {x: Math.round(frame.x + b.left + 30), y: Math.round(frame.y + b.top - 4),
        区: {x: Math.round(frame.x + b.left) - 10, y: Math.round(frame.y + b.top) - 40, w: 120, h: 60}}; })()`);
    await session.click(戊.x, 戊.y);
    await harness.sleep(400);
    await 测('戊-块公式上方留白', 戊.区);
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
