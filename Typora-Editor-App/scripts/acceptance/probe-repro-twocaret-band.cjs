/** 真文档（doc A 副本）复现"两根竖线"：**从折叠态**直接点块公式下方的空白带（用户动作），
 *  每一步 60ms 采样：原生 caret / 我们的合成线 / blankLanding 标记 / 块几何。找"双线"状态。
 *  用法：node scripts/acceptance/probe-repro-twocaret-band.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret-band');
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
      + (cur.nodeType === 3 ? '(len' + String(cur.data).length + ':"' + String(cur.data).slice(0, 8) + '")' : '')); cur = cur.parentNode; } return out.join('<'); })() : null;
  return {光标: at ? [链, at.startOffset, box(at.getBoundingClientRect())] : null,
    线: bar ? [bar.style.display, box(bar.getBoundingClientRect())] : null, 计数: w.__caretProxyShown || 0,
    带: w.__typoraBlankBand || null, 焦点: d.hasFocus()}; })()`;

const 几何 = (session) => session.js(`(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  const code = blk ? blk.querySelector('code[data-type="math-block"]') : null;
  const prev = blk ? blk.previousElementSibling : null;
  const next = blk ? blk.nextElementSibling : null;
  const prevText = prev ? [...prev.querySelectorAll('*')].length : 0;
  return {展开: blk ? blk.classList.contains('vditor-ir__node--expand') : null, 块框: blk ? box(blk.getBoundingClientRect()) : null,
    源码框: code ? box(code.getBoundingClientRect()) : null, 源码显示: code ? w.getComputedStyle(code.parentElement).display + '/' + w.getComputedStyle(code.parentElement).width : null,
    预览框: blk && blk.querySelector('.vditor-ir__preview') ? box(blk.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null,
    块子节点: blk ? [...blk.childNodes].map(n => n.nodeName + (n.nodeType === 1 && n.getBoundingClientRect ? '(' + n.getBoundingClientRect().top.toFixed(0) + ',' + n.getBoundingClientRect().height.toFixed(0) + ')' : '')).join(' ') : null,
    上一块: prev ? prev.tagName + JSON.stringify(box(prev.getBoundingClientRect())) + ' " ' + String(prev.textContent).slice(0, 12) + '"' : null,
    下一块: next ? next.tagName + JSON.stringify(box(next.getBoundingClientRect())) + ' " ' + String(next.textContent).slice(0, 12) + '"' : null,
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
    label: 'probe-twocaret-band', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 序列 = async (标签, ms = 1500) => {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { out.push([Date.now() - t0, await session.js(采样)]); await sleep(60); }
    let 上 = null, 双线 = false;
    console.log('\n--- ' + 标签 + ' ---');
    for (const [t, s] of out) {
      const 有 = !!(s.线 && s.线[0] !== 'none' && s.线[1] && s.线[1][3] > 0);
      const 原生可见 = !!(s.光标 && s.光标[2] && s.光标[2][3] > 0);
      if (有 && 原生可见) 双线 = true;
      const k = JSON.stringify(s);
      if (k === 上) continue;
      上 = k;
      console.log(`  +${t}ms${有 && 原生可见 ? '  ⟵ 双线' : ''} ` + JSON.stringify(s));
    }
    return 双线;
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe=' + JSON.stringify(frame));
    // 滚到目标块
    for (let i = 0; i < 10; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
        const b = blk.getBoundingClientRect(); const 视口高 = w.innerHeight;
        if (b.top >= 100 && b.bottom <= 视口高 - 100) return {好了: true, top: Math.round(b.top), bottom: Math.round(b.bottom)};
        const 点y = b.top > 视口高 / 2 ? Math.min(视口高 - 20, 视口高 - 60) : 60;
        const el = d.elementFromPoint(500, 点y);
        const 锚 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
        if (!锚) return {没锚: true};
        const before = Math.round(锚.getBoundingClientRect().top);
        锚.scrollIntoView({block: b.top > 视口高 / 2 ? 'end' : 'start'});
        return {迭代: i, 动: Math.round(锚.getBoundingClientRect().top) - before, 块top: Math.round(b.top)}; })()`);
      if (r.好了 || r.没锚) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(260);
    }
    await sleep(400);
    let G = await 几何(session);
    console.log('几何：' + JSON.stringify(G, null, 1));
    await session.shot('00-折叠静态');

    // 用户动作：从折叠态点块下方空白带
    const 底 = G.预览框.y + G.预览框.h;
    const 组 = [];
    for (const dx of [120, 600]) for (const dy of [2, 8, 14, 22, 34]) 组.push([dx, dy]);
    for (const [dx, dy] of 组) {
      const x = frame.x + G.块框.x + dx;
      const y = frame.y + 底 + dy;
      if (y - frame.y > G.视口高 - 10) continue;
      await session.click(x, y);
      const 双 = await 序列(`点空白带 dx=${dx} dy=${dy}（iframe ${x - frame.x},${y - frame.y}）`);
      if (双) { await session.shot(`双线-dx${dx}-dy${dy}`); console.log('  ⇒ 复现双线，截图已存'); }
      const G2 = await 几何(session);
      if (G2.展开 !== G.展开) { console.log('  块展开态变了：' + G.展开 + ' → ' + G2.展开 + '，后续坐标按新几何算'); G = G2; }
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
