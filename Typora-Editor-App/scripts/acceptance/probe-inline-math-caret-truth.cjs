/** 探针 · 用户 2026-10-01 报的两件事（素材形态：段末行内公式）：
 *   ① 公式后面"偏粗的多余光标"（用户要求：只留大而细的那根）；
 *   ② 点在行内公式右缘之后的极小区域，光标仍进公式源码（用户要求：跳到公式外紧后面第一个正常文本位置）。
 *
 *  取证跑：不改产品代码，只把事实钉下来。每个光标状态都抓**两个独立通道**：
 *   · 合成器 `capturePage`（DOM 画出来的那一层）；
 *   · 真屏 GDI（用户肉眼看到的那一层，含原生光标）——按**窗口句柄**定位，不再猜内容偏移。
 *  另附 2x 放大图与竖线条柱分析（win-png-bars.ps1），"几根线、各多宽多高"用像素说话。
 *
 *  用法：node scripts/acceptance/probe-inline-math-caret-truth.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-inline-math-caret');
const IF = hi.IF, SURFACE = hi.SURFACE;
const PS = (script, args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(harness.project, 'scripts/acceptance', script), ...args], { stdio: 'pipe' }).toString().trim();
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const BODY = [
  '# 行程问题', '',
  '纵向时刻表，横向：路程/速度=时间', '',
  '循环往返问题：对侧相向出发：$S=L(2n-1)$', '',
  '$x_{独占一行}+1$', '',
  '第三段正文收尾。', '',
].join('\n');

const GEOM = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector(${JSON.stringify(SURFACE)});
  const frame = document.getElementById('editor').getBoundingClientRect();
  const box = n => { if (!n) return null; const r = n.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
  if (!owner) return {error: '没有行内公式节点'};
  const pre = owner.querySelector('[data-type="text-open-marker"],.vditor-ir__marker--pre');
  const post = owner.querySelector('[data-type="text-close-marker"],.vditor-ir__marker--post');
  const code = owner.querySelector('code[data-type="math-inline"]');
  const preview = owner.querySelector('.vditor-ir__preview');
  const katex = preview && preview.querySelector('.katex');
  const pb = preview ? preview.getBoundingClientRect() : owner.getBoundingClientRect();
  const kb = katex ? katex.getBoundingClientRect() : null;
  const y = Math.round(frame.y + pb.top + pb.height / 2);
  const 命中 = [];
  for (const dx of [-24, -12, -6, -3, -1.5, -0.5, 0.5, 1.5, 3, 6, 12]) {
    const x = Math.round(frame.x + pb.right + dx);
    const el = d.elementFromPoint(x, y);
    const chain = []; let cur = el;
    while (cur && chain.length < 4) { chain.push(cur.nodeName + (cur.getAttribute?.('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '') + (cur.className && typeof cur.className === 'string' ? '.' + cur.className.split(' ').slice(0, 2).join('.') : '')); cur = cur.parentElement; }
    const hit = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
    命中.push({dx, 元素: chain.join(' < ').slice(0, 70),
      落点: hit ? (hit.startContainer.nodeType === 3 ? 'TEXT(len' + hit.startContainer.data.length + ')' : hit.startContainer.nodeName + '.' + String(hit.startContainer.className || '').slice(0, 14)) + '@' + hit.startOffset : null});
  }
  // 逐元素盒：这一段里所有可见子元素（找"右缘之外那根线"是谁画的）
  const 邻居 = [];
  for (const n of owner.closest('p').querySelectorAll('*')) {
    const b = n.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.left + b.width > pb.right - 20 && b.left < pb.right + 20) {
      邻居.push({el: n.nodeName + (n.getAttribute('data-type') ? '[' + n.getAttribute('data-type') + ']' : '') + '.' + String(n.className || '').slice(0, 30), 框: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]});
    }
  }
  return {展开: owner.classList.contains('vditor-ir__node--expand'), owner: box(owner), 围栏后: box(post), code: box(code),
    preview: box(preview), katex: box(katex), 段: box(owner.closest('p')), 邻居, 命中, y,
    preview右: Math.round(frame.x + pb.right), frame: [Math.round(frame.x), Math.round(frame.y)]};
})()`;

const CARET = `(() => { const w = ${IF}, d = w.document;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const out = {bar: bar ? {显示: bar.style.display, 框: (() => { const b = bar.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()} : null};
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount || !sel.focusNode) { out.sel = null; return out; }
  const n = sel.focusNode, o = sel.focusOffset;
  const at = n.nodeType === 3 ? n.parentElement : n;
  const pr = d.createRange(); pr.setStart(n, o); pr.collapse(true);
  const rb = pr.getBoundingClientRect();
  out.sel = {容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' + JSON.stringify(n.data.slice(0, 10)) : n.nodeName + '.' + String(n.className || '').slice(0, 22),
    偏移: o, 折叠: sel.isCollapsed, 原生: [Math.round(rb.left), Math.round(rb.top), Math.round(rb.width), Math.round(rb.height)],
    层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('.vditor-ir__preview') ? '预览' : at.closest?.('[data-type$="-marker"]') ? '围栏' : at.closest?.('p,li,h1,h2,h3,h4,h5,h6') ? '正文' : '元素级'};
  return out; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'inline-math.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-inline-math-caret', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 5, settleMs: 1500, inspect: true });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    const 窗口信息 = async () => session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      const b = win.getBounds();
      const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
      return {hwnd, bounds: b, content: win.getContentBounds(), scale: screen.getDisplayMatching(b).scaleFactor,
        zoom: win.webContents.getZoomFactor()}; })()`);
    /** 真屏 GDI：按 window 句柄定位（CSS 坐标 → 物理像素由 user32 自己算）。
     *  抓前必须把窗口顶到最前——GDI 抓的是屏幕像素，被别的窗口盖住就拍到别人的画面
     *  （第一次跑就拍到了另一个窗口的英文正文，图上一看就穿帮）。 */
    const 抓屏 = async (标签, cssX, cssY, cssW, cssH) => {
      const info = await 窗口信息();
      await session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
      await harness.sleep(400);
      const out = path.join(OUT, 标签 + '-真屏.png');
      const s = info.scale;
      const 回执 = PS('win-screen-crop-xy.ps1', ['-Out', out,
        '-X', String(Math.round((info.content.x + cssX) * s)), '-Y', String(Math.round((info.content.y + cssY) * s)),
        '-W', String(Math.round(cssW * s)), '-H', String(Math.round(cssH * s))]);
      await session.main.js(`(() => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        win.setAlwaysOnTop(false); return 1; })()`);
      return {file: out, 回执, scale: info.scale, zoom: info.zoom};
    };
    const 抓合成 = async (标签, cssX, cssY, cssW, cssH) => {
      const out = path.join(OUT, 标签 + '-合成器.png');
      const b64 = await session.main.js(`(async () => { const {BrowserWindow} = require('electron');
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        const image = await win.webContents.capturePage({x: ${Math.round(cssX)}, y: ${Math.round(cssY)}, width: ${Math.round(cssW)}, height: ${Math.round(cssH)}});
        return image.toPNG().toString('base64'); })()`);
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      return out;
    };
    const 柱 = 图 => { try { return PS('win-png-bars.ps1', ['-In', 图]).split('\n').slice(0, 12).join('\n    '); } catch (error) { return 'ERR ' + error.message; } };
    const 放大 = 图 => { const out = 图.replace('-真屏.png', '-真屏-2x.png').replace('-合成器.png', '-合成器-2x.png');
      PS('win-png-zoom.ps1', ['-In', 图, '-Out', out, '-Factor', '2']); return out; };
    const 取证 = async (标签, 区域) => {
      const 态 = await session.js(CARET);
      say(`  【${标签}】状态=${JSON.stringify(态)}`);
      const 截 = {x: 区域.x - 45, y: 区域.y - 8, w: 110, h: Math.round(区域.h + 16)};
      // 先抓合成器（不受遮挡影响、瞬时），再抓真屏（要顶窗口、慢）——抓完各读一次状态，
      // "图上有几根线"必须配上"那一刻的 DOM 是什么"。
      const 合 = await 抓合成(标签, 截.x, 截.y, 截.w, 截.h);
      const 合后 = await session.js(CARET);
      const 真 = await 抓屏(标签, 截.x, 截.y, 截.w, 截.h);
      const 真后 = await session.js(CARET);
      say(`  【${标签}】截=${JSON.stringify(截)} 真屏回执=${真.回执} scale=${真.scale} zoom=${真.zoom}`);
      say(`  【${标签}】合成器=  ${合}`);
      say(`  【${标签}】合成器柱：\n    ${柱(合)}`);
      say(`  【${标签}】合成器抓后 DOM=${JSON.stringify(合后)}`);
      say(`  【${标签}】真屏=    ${真.file}`);
      say(`  【${标签}】真屏柱：\n    ${柱(真.file)}`);
      say(`  【${标签}】真屏抓后 DOM=${JSON.stringify(真后)}`);
      say(`  【${标签}】2x：${放大(真.file)}  |  ${放大(合)}`);
      return 态;
    };

    say('\n══ 甲 · 折叠态几何与命中表（行内公式右缘一带）══');
    const geom = await session.js(GEOM);
    say('  owner=' + JSON.stringify(geom.owner) + ' 围栏后=' + JSON.stringify(geom.围栏后) + ' code=' + JSON.stringify(geom.code));
    say('  preview=' + JSON.stringify(geom.preview) + ' katex=' + JSON.stringify(geom.katex) + ' 段=' + JSON.stringify(geom.段));
    say('  frame=' + JSON.stringify(geom.frame) + ' preview 右缘（页面坐标）=' + geom.preview右 + ' y=' + geom.y);
    say('  右缘 ±20px 内的可见元素：');
    for (const n of geom.邻居) say('    ' + JSON.stringify(n));
    for (const h of geom.命中) say(`   dx=${String(h.dx).padStart(6)} 落点=${h.落点}  元素=${h.元素}`);

    say('\n══ 乙 · 三处落点的双通道取证 ══');
    const 对照点 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 段 = [...s.children].find(n => n.textContent.includes('纵向时刻表'));
      const walker = d.createTreeWalker(段, NodeFilter.SHOW_TEXT); let n = null;
      while (walker.nextNode()) if (walker.currentNode.data.length > 4) { n = walker.currentNode; break; }
      const r = d.createRange(); r.setStart(n, 5); r.setEnd(n, 6); const b = r.getBoundingClientRect();
      return {x: Math.round(frame.x + b.left), y: Math.round(frame.y + b.top + b.height / 2), h: Math.round(b.height), 字: n.data.slice(4, 7)}; })()`);
    say('\n[0 对照] 正文文字中间 ' + JSON.stringify(对照点));
    await session.click(对照点.x, 对照点.y);
    await harness.sleep(400);
    await 取证('0对照', 对照点);

    const A点 = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const b = owner.getBoundingClientRect();
      return {x: Math.round(frame.x + b.right + 24), y: Math.round(frame.y + b.top + b.height / 2), h: Math.round(b.height)}; })()`);
    say('\n[A] 行末外侧点空白（公式之后的元素边界位置）' + JSON.stringify(A点));
    await session.click(A点.x, A点.y);
    await harness.sleep(500);
    await 取证('A段末公式后', A点);
    const 日记 = await session.js(`(() => (${IF}.__caretProxyLog || []).slice(-3))()`);
    for (const e of (日记 || [])) say('      日记 ' + JSON.stringify(e));
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
