/** 真文档（doc A 副本）上复现"两根竖线"：滚到那个 `$$` 块，按用户动作点，
 *  每一步用 60ms 采样 + selectionchange 记录，找出"合成线可见且原生 caret 也可见"的状态。
 *  用法：node scripts/acceptance/probe-repro-twocaret-real.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret-real');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const 采样 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const 链 = at ? (() => { const out = []; let cur = at.startContainer;
    while (cur && out.length < 4) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '')
      + (cur.nodeType === 3 ? '(len' + cur.data.length + ')' : '')); cur = cur.parentNode; } return out.join('<'); })() : null;
  return {光标: at ? [链, at.startOffset, box(at.getBoundingClientRect())] : null,
    线: bar ? [bar.style.display, box(bar.getBoundingClientRect())] : null, 计数: w.__caretProxyShown || 0,
    焦点: d.hasFocus()}; })()`;

/** 把目标块滚进视口（滚动容器在外壳层，只能用 scrollIntoView 迭代）。 */
const 滚到 = async (session) => {
  for (let i = 0; i < 10; i++) {
    const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      if (!blk) return {没有: true};
      const b = blk.getBoundingClientRect();
      const 视口高 = w.innerHeight;
      if (b.top >= 80 && b.bottom <= 视口高 - 80) return {好了: true, top: Math.round(b.top), bottom: Math.round(b.bottom), 视口高};
      const 点y = b.top > 视口高 / 2 ? Math.min(视口高 - 20, 视口高 - 60) : Math.max(20, 60);
      const el = d.elementFromPoint(500, 点y);
      const 锚 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
      if (!锚) return {没锚: true, top: Math.round(b.top), 视口高};
      const before = Math.round(锚.getBoundingClientRect().top);
      锚.scrollIntoView({block: b.top > 视口高 / 2 ? 'end' : 'start'});
      const after = Math.round(锚.getBoundingClientRect().top);
      return {迭代: i, 动: after - before, 块top: Math.round(b.top), 视口高}; })()`);
    if (r.好了 || r.没有 || r.没锚) return r;
    await sleep(260);
  }
  return {超次数: true};
};

const 几何 = (session) => session.js(`(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  const code = blk ? blk.querySelector('code[data-type="math-block"]') : null;
  const prev = blk ? blk.previousElementSibling : null;
  const next = blk ? blk.nextElementSibling : null;
  return {展开: blk ? blk.classList.contains('vditor-ir__node--expand') : null, 块框: blk ? box(blk.getBoundingClientRect()) : null,
    源码框: code ? box(code.getBoundingClientRect()) : null,
    源码行: code ? [...code.getClientRects()].map(box) : null,
    预览框: blk && blk.querySelector('.vditor-ir__preview') ? box(blk.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null,
    上一块: prev ? prev.tagName + JSON.stringify(box(prev.getBoundingClientRect())) + ' " ' + String(prev.textContent).slice(0, 14) + '"' : null,
    下一块: next ? next.tagName + JSON.stringify(box(next.getBoundingClientRect())) + ' " ' + String(next.textContent).slice(0, 14) + '"' : null,
    视口高: w.innerHeight}; })()`);

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? path.join(process.env.LOCALAPPDATA || 'D:/Users/ltmroberthk/AppData/Local', 'Programs/markpilot/MarkPilot.exe') : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-twocaret-real', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 序列 = async (标签, ms = 2600) => {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { out.push([Date.now() - t0, await session.js(采样)]); await sleep(60); }
    let 上 = null;
    console.log('\n--- ' + 标签 + ' ---');
    for (const [t, s] of out) { const k = JSON.stringify(s); if (k === 上) continue; 上 = k;
      const 双线 = !!(s.线 && s.线[0] !== 'none' && s.线[1] && s.线[1][3] > 0 && s.光标 && s.光标[2] && s.光标[2][3] > 0);
      console.log(`  +${t}ms${双线 ? '  ⟵⟵ 双线！' : ''} ` + JSON.stringify(s)); }
    return out;
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe=' + JSON.stringify(frame));
    console.log('滚动：' + JSON.stringify(await 滚到(session)));
    await sleep(400);
    let G = await 几何(session);
    console.log('几何：' + JSON.stringify(G, null, 1));
    const clip = {x: frame.x + 20, y: frame.y + 60, width: Math.min(880, frame.w), height: 420, scale: 2};
    await session.shot('00-静态');

    const 点块 = async (dy = 0.5, dx = 200) => { const g = await 几何(session);
      return session.click(frame.x + g.块框.x + dx, frame.y + g.块框.y + Math.round(g.块框.h * dy)); };

    // ① 点块预览（展开）
    await 点块(0.5, 200);
    await 序列('① 点块预览后');

    // ② 点源码行末（展开态）
    G = await 几何(session);
    if (G.源码行 && G.源码行[0]) {
      const 行 = G.源码行[0];
      await session.click(frame.x + 行.x + Math.min(行.w - 10, 700), frame.y + 行.y + Math.round(行.h / 2));
      await 序列('② 点源码行末后');
    }
    // ③ 点源码行右下方一点（用户动作）
    for (const dy of [3, 10, 18, 26]) {
      G = await 几何(session);
      const 行 = (G.源码行 && G.源码行[G.源码行.length - 1]) || null;
      const 底 = 行 ? 行.y + 行.h : (G.预览框 ? G.预览框.y + G.预览框.h : G.块框.y + G.块框.h);
      const x = frame.x + G.块框.x + 600;
      const y = frame.y + 底 + dy;
      await session.click(x, y);
      await 序列(`③ 点源码行底 +${dy}（${x - frame.x},${y - frame.y}）`);
      await session.shot('03-底+' + dy);
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
