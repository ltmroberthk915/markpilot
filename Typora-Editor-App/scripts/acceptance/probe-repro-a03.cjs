/** A03 追问：点块公式下带 → 光标放进邻行公式源码之后，节点会不会展开、光标多久可见？
 *  用法：node scripts/acceptance/probe-repro-a03.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-a03');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const node = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]')]
    .find(n => n.contains(sel && sel.focusNode));
  return {在: at ? (at.startContainer.nodeName + (at.startContainer.nodeType === 3 ? '("' + String(at.startContainer.data).slice(0, 6) + '")' : '')) : null,
    偏移: at ? at.startOffset : -1, rect: box(at && at.getBoundingClientRect()),
    展开: node ? node.classList.contains('vditor-ir__node--expand') : null,
    合成: (() => { const b = d.querySelector('[data-typora-caret-proxy]'); return b && b.style.display !== 'none' ? box(b.getBoundingClientRect()) : 'none'; })(),
    标记: w.__typoraBlankBand || null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-a03', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
    const G = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const r = block.getBoundingClientRect();
      return {x: Math.round(r.left + 400), y: Math.round(r.bottom - 8)}; })()`);
    await session.click(frame.x + G.x, frame.y + G.y);
    for (const 等 of [0, 80, 200, 500, 1200]) {
      await sleep(等);
      console.log(`  +${等}ms：` + JSON.stringify(await session.js(读数)));
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
