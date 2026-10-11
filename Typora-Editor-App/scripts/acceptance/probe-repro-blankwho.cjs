/** 空白带点击：mousedown 到底有没有走到我们的监听？(对比：先点正文、再点空白带)
 *  用法：node scripts/acceptance/probe-repro-blankwho.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-blankwho');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 名 = node => { let cur = node, out = [];
    while (cur && out.length < 3) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 1).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 6) + '")' : (cls ? '.' + cls : ''))); cur = cur.parentNode; }
    return out.join('<'); };
  const r = at && at.getBoundingClientRect();
  return {在: at ? 名(at.startContainer) : null, 偏移: at ? at.startOffset : -1,
    rect: r ? {x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height)} : null,
    轨迹: w.__typoraBlankTrace || null, 记录: w.__typoraBlankClick || null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-blankwho', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    const G = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('修量不少'));
      return {块: box(block.getBoundingClientRect()), 段点: (() => { const r = para.getBoundingClientRect();
        return {x: Math.round(r.left + 30), y: Math.round(r.top + 12)}; })()}; })()`);
    console.log('几何：' + JSON.stringify(G));
    console.log('\n① 先点正文（暖一下焦点）：');
    await session.js(`(() => { const w = ${IF}; w.__typoraBlankTrace = null; w.__typoraBlankClick = null; return 1; })()`);
    await session.click(frame.x + G.段点.x, frame.y + G.段点.y);
    await sleep(320);
    console.log('   ' + JSON.stringify(await session.js(读数)));
    console.log('\n② 再点块公式的空白带（源码条上沿）：');
    await session.js(`(() => { const w = ${IF}; w.__typoraBlankTrace = null; w.__typoraBlankClick = null; return 1; })()`);
    await session.click(frame.x + G.块.x + 8, frame.y + G.块.y + 18);
    await sleep(420);
    console.log('   ' + JSON.stringify(await session.js(读数)));
    console.log('\n③ 再点块内右侧空白：');
    await session.js(`(() => { const w = ${IF}; w.__typoraBlankTrace = null; w.__typoraBlankClick = null; return 1; })()`);
    await session.click(frame.x + 500, frame.y + G.块.y + 18);
    await sleep(420);
    console.log('   ' + JSON.stringify(await session.js(读数)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('失败：', error); process.exit(1); });
