/** 空白带点击校正：跑没跑？跑了之后被谁改回去？——点击后按时间采样光标。
 *  用法：node scripts/acceptance/probe-repro-blankdebug.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-blankdebug');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 名 = node => { let cur = node, out = [];
    while (cur && out.length < 3) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 1).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 6) + '")' : (cls ? '.' + cls : ''))); cur = cur.parentNode; }
    return out.join('<'); };
  return {在: at ? 名(at.startContainer) : null, 偏移: at ? at.startOffset : -1, rect: box(at && at.getBoundingClientRect()),
    记号: w.__typoraBlankClick || null, 轨迹: w.__typoraBlankTrace || null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-blankdebug', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    const G = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      // 记录器：谁在改选区
      const trace = w.__trace = {log: [], acts: [], t0: performance.now()};
      const 名 = n => n ? (n.nodeType === 3 ? '#' + String(n.data).slice(0, 8) : n.nodeName + '.' + String(n.className).split(' ')[0]) : 'null';
      d.addEventListener('selectionchange', () => { const s = w.getSelection(); const a = s && s.rangeCount ? s.getRangeAt(0) : null;
        trace.log.push({t: Math.round(performance.now() - trace.t0), 在: a ? 名(a.startContainer) : null, 偏移: a ? a.startOffset : -1}); }, true);
      for (const m of ['removeAllRanges', 'addRange', 'collapse', 'setBaseAndExtent']) {
        const o = w.Selection.prototype[m];
        w.Selection.prototype[m] = function (...args) {
          let st = ''; try { st = String(new Error().stack).split('\\n').slice(2, 4).map(l => l.trim().replace(/^at\\s+/, '').slice(0, 90)).join(' | '); } catch {}
          trace.acts.push({t: Math.round(performance.now() - trace.t0), m, args: args.map(a => (a && a.nodeType ? 名(a) : String(a).slice(0, 12))), st});
          return o.apply(this, args);
        };
      }
      return {块: box(block.getBoundingClientRect())}; })()`);
    console.log('几何：' + JSON.stringify(G));
    const 点x = G.块.x + 8, 点y = G.块.y + 18;
    console.log('点 (' + 点x + ',' + 点y + ') —— 块内空白带');
    await session.click(frame.x + 点x, frame.y + 点y);
    for (const 等 of [0, 40, 120, 300, 700]) {
      await sleep(等);
      console.log(`  +${等}ms：` + JSON.stringify(await session.js(读数)));
    }
    const 轨 = await session.js(`(() => { const w = ${IF}; return {轨迹: w.__trace.log.slice(-12), 动作: w.__trace.acts.slice(-10)}; })()`);
    console.log('selectionchange 轨迹：'); for (const 项 of 轨.轨迹) console.log('   ' + JSON.stringify(项));
    console.log('Selection API 动作：'); for (const 项 of 轨.动作) console.log('   ' + JSON.stringify(项));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
