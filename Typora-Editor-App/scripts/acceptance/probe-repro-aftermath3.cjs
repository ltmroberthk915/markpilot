/** 展开态公式后面那一下点击：谁把光标写进了源码？（Selection 写入口代理 + 事件目标日志）
 *  用法：node scripts/acceptance/probe-repro-aftermath3.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-aftermath3');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 装 = `(() => { const w = ${IF}; const d = w.document;
  if (w.__t3) { w.__t3.acts.length = 0; w.__t3.events.length = 0; return 'reuse'; }
  const t = w.__t3 = {acts: [], events: [], t0: performance.now()};
  const 名 = node => { if (!node) return 'null';
    if (node.nodeType === 3) return '#' + String(node.data).slice(0, 10);
    const cls = (typeof node.className === 'string' ? node.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return node.nodeName + (cls ? '.' + cls : '') + (node.getAttribute && node.getAttribute('data-type') ? '[' + node.getAttribute('data-type') + ']' : ''); };
  for (const m of ['removeAllRanges', 'addRange', 'setBaseAndExtent', 'collapse', 'extend']) {
    const orig = w.Selection.prototype[m];
    if (typeof orig !== 'function') continue;
    w.Selection.prototype[m] = function (...args) {
      let st = ''; try { st = String(new Error().stack).split('\\n').slice(1, 5).map(l => l.trim().replace(/^at\\s+/, '')).join(' | ').slice(0, 300); } catch {}
      t.acts.push({t: Math.round(performance.now() - t.t0), m, args: args.map(a => (a && a.nodeType ? 名(a) : String(a).slice(0, 16))), st});
      return orig.apply(this, args);
    };
  }
  for (const type of ['mousedown', 'mouseup', 'click']) {
    d.addEventListener(type, event => {
      t.events.push({t: Math.round(performance.now() - t.t0), type, 目标: 名(event.target),
        链: (() => { const out = []; let cur = event.target; while (cur && out.length < 4) { out.push(名(cur)); cur = cur.parentElement; } return out.join('<'); })(),
        x: Math.round(event.clientX), y: Math.round(event.clientY), 默认被阻止: event.defaultPrevented});
    }, true);
  }
  d.addEventListener('selectionchange', () => { const s = w.getSelection(); const r = s && s.rangeCount ? s.getRangeAt(0) : null;
    t.events.push({t: Math.round(performance.now() - t.t0), type: 'selectionchange', 目标: r ? 名(r.startContainer) + '@' + r.startOffset : 'null', 长度: r && !r.collapsed ? r.toString().length : 0}); }, true);
  return 'installed'; })()`;

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const 名 = node => { if (!node) return 'null'; let cur = node, out = [];
    while (cur && out.length < 3) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 1).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 8) + '")' : (cls ? '.' + cls : ''))); cur = cur.parentNode; }
    return out.join('<'); };
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
  const node = para && para.querySelector('[data-type="inline-node"]');
  return {在: at ? 名(at.startContainer) : null, 偏移: at ? at.startOffset : -1, rect: box(at && at.getBoundingClientRect()),
    展开: node ? node.classList.contains('vditor-ir__node--expand') : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-aftermath3', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    const 锚 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
      para.scrollIntoView({block: 'center', behavior: 'instant'});
      const node = para.querySelector('[data-type="inline-node"]');
      const r = node.getBoundingClientRect();
      return {公式: {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}}; })()`);
    await session.click(frame.x + 锚.公式.x + Math.round(锚.公式.w / 2), frame.y + 锚.公式.y + Math.round(锚.公式.h / 2));
    await sleep(420);
    console.log('公式展开态：' + JSON.stringify(await session.js(读数)));
    console.log('装埋点：' + await session.js(装));
    const 字 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
      const walker = d.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        const index = String(text.data).indexOf('设');
        if (index < 0 || text.parentElement.closest('.vditor-ir__preview')) continue;
        const r = d.createRange(); r.setStart(text, index); r.setEnd(text, index + 1);
        const b = r.getBoundingClientRect();
        return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)}; }
      return null; })()`);
    console.log('点“设”于 (' + 字.x + ',' + 字.y + ')');
    await session.click(frame.x + 字.x, frame.y + 字.y);
    for (const 等 of [0, 40, 150, 400]) {
      await sleep(等);
      console.log(`  +${等}ms：` + JSON.stringify(await session.js(读数)));
    }
    const 轨 = await session.js(`(() => { const w = ${IF}; return {acts: w.__t3.acts.slice(0, 14), events: w.__t3.events.slice(0, 26)}; })()`);
    console.log('\n事件时间线：'); for (const 项 of 轨.events) console.log('   ' + JSON.stringify(项));
    console.log('Selection 写入口：'); for (const 项 of 轨.acts) console.log('   ' + JSON.stringify(项));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
