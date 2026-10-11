/** 验收图 · 用户 2026-10-01 报的两件事（修复后）：
 *   ① 公式后面不再多一根"偏粗的合成线"（只留原生那根大而细的光标）；
 *   ② 点右围栏之后那一带，光标落到公式**外面**第一个正常文本位置。
 *
 *  每例两张图：真屏（含原生光标，GDI）+ 合成器（只见 DOM 画的东西），各 2x 放大。
 *  用法：node scripts/acceptance/probe-accept-inline-math-caret.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/accept-inline-math-caret');
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
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'accept.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-accept-inline-math-caret', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500, inspect: true });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    const 框 = async (标签, 区) => {
      const info = await session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        return {content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor}; })()`);
      const 真 = path.join(OUT, 标签 + '-真屏.png');
      await session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
      await harness.sleep(400);
      PS('win-screen-crop-xy.ps1', ['-Out', 真,
        '-X', String(Math.round((info.content.x + 区.x) * info.scale)), '-Y', String(Math.round((info.content.y + 区.y) * info.scale)),
        '-W', String(Math.round(区.w * info.scale)), '-H', String(Math.round(区.h * info.scale))]);
      await session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        win.setAlwaysOnTop(false); return 1; })()`);
      const 合 = path.join(OUT, 标签 + '-合成器.png');
      const b64 = await session.main.js(`(async () => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        const image = await win.webContents.capturePage({x: ${Math.round(区.x)}, y: ${Math.round(区.y)}, width: ${Math.round(区.w)}, height: ${Math.round(区.h)}});
        return image.toPNG().toString('base64'); })()`);
      fs.writeFileSync(合, Buffer.from(b64, 'base64'));
      const 真2 = 真.replace('-真屏.png', '-真屏-2x.png'), 合2 = 合.replace('-合成器.png', '-合成器-2x.png');
      PS('win-png-zoom.ps1', ['-In', 真, '-Out', 真2, '-Factor', '2']);
      PS('win-png-zoom.ps1', ['-In', 合, '-Out', 合2, '-Factor', '2']);
      say(`【${标签}】真屏柱：` + PS('win-png-bars.ps1', ['-In', 真]).split('\n').slice(1).map(s => s.trim()).filter(Boolean).join(' '));
      say(`【${标签}】合成器柱：` + PS('win-png-bars.ps1', ['-In', 合]).split('\n').slice(1).map(s => s.trim()).filter(Boolean).join(' '));
      say(`【${标签}】图：${真2}  |  ${合2}`);
    };
    const 读 = () => session.js(`(() => { const w = ${IF}, d = w.document;
      const bar = d.querySelector('[data-typora-caret-proxy]');
      const sel = w.getSelection(); const n = sel && sel.focusNode;
      const at = n ? (n.nodeType === 3 ? n.parentElement : n) : null;
      return {合成线: bar ? bar.style.display : null, 合成线框: bar && bar.style.display !== 'none' ? (() => { const b = bar.getBoundingClientRect();
          return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })() : null,
        光标: n ? {层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,h1,h2,h3') ? '正文' : '元素级',
          容器: n.nodeType === 3 ? 'TEXT' : n.nodeName, 偏移: sel.focusOffset,
          在公式内: !!at.closest?.('.vditor-ir__node[data-type="inline-node"]')} : null,
        展开: !!d.querySelector('.vditor-ir__node[data-type="inline-node"].vditor-ir__node--expand')}; })()`);

    // ── ① 光标落在公式之后：只该有一根（原生），合成线不许画 ──
    const A = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const b = owner.getBoundingClientRect();
      return {点: {x: Math.round(frame.x + b.right + 24), y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.right) - 60, y: Math.round(frame.y + b.top) - 12, w: 110, h: Math.round(b.height) + 24}}; })()`);
    say('\n══ ① 段末公式之后点空白（用户截图处）══');
    await session.click(A.点.x, A.点.y);
    await harness.sleep(500);
    say('  状态=' + JSON.stringify(await 读()));
    await 框('1公式后', A.区);

    // ── ② 展开态：点右围栏之后 2px（用户报的"偏后半个像素区"）──
    const B = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const b = owner.getBoundingClientRect();
      return {点: {x: Math.round(frame.x + b.right + 24), y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.right) - 60, y: Math.round(frame.y + b.top) - 12, w: 110, h: Math.round(b.height) + 24}}; })()`);
    // 进展开态：点行末空白 → ←
    await session.click(B.点.x, B.点.y);
    await harness.sleep(300);
    await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
    await harness.sleep(400);
    const 展开态 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const b = owner.getBoundingClientRect();
      const 子 = [...owner.children].map(c => { const r = c.getBoundingClientRect();
        return {tag: c.nodeName, cls: String(c.className || '').slice(0, 36), 框: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]}; });
      const 标 = [...owner.children].filter(子2 => 子2.nodeName === 'SPAN' && 子2.classList.contains('vditor-ir__marker'));
      const 右报 = 标[标.length - 1].getBoundingClientRect();
      const 右围栏中 = Math.round(frame.x + 右报.left + 右报.width / 2);
      return {框: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
        子, 右围栏中, 点击: {x: 右围栏中 + 2, y: Math.round(frame.y + b.top + b.height / 2)},
        区: {x: Math.round(frame.x + b.right) - 60, y: Math.round(frame.y + b.top) - 12, w: 110, h: Math.round(b.height) + 24}}; })()`);
    say('\n══ ② 展开态 · 右围栏之后 +2px ══');
    say('  展开态几何：owner=' + JSON.stringify(展开态.框) + ' 子节点=' + JSON.stringify(展开态.子));
    await session.js(`(() => { const w = ${IF}; delete w.__typoraInlineMathOutside; delete w.__typoraInlineMathClick; return 1; })()`);
    await session.click(展开态.点击.x, 展开态.点击.y);
    await harness.sleep(500);
    say('  点后状态=' + JSON.stringify(await 读()));
    const 标记 = await session.js(`(() => { const w = ${IF}; return {外部: w.__typoraInlineMathOutside || null, 定位: w.__typoraInlineMathClick || null}; })()`);
    say('  标记=' + JSON.stringify(标记) + '  点击点=' + JSON.stringify(展开态.点击));
    await 框('2围栏后2px', 展开态.区);
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
