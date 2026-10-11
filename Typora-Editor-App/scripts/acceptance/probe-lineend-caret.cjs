/** 行尾/行外空白点击之后，光标**最终**是什么状态？按时间采样，把瞬态与终态分开。
 *
 *  背景（2026-09-17，四个模块的摘除实验已证明）：这类点击**我们的处理器根本没接手**
 *  （`event.target` 是 `<p>`，`closest('.vditor-ir__node')` 为 null → 所有处理器直接 return），
 *  所以位置是 Vditor/浏览器的兜底决定的。之前的探针只在点击后 450ms 读一次，读到
 *  `inMath:true, rect:"0,0"`——但"0,0"可能只是公式还没展开的瞬态。
 *
 *  本探针点击后连续采样 1.6 秒：光标在哪个节点、有没有可见矩形、公式有没有被展开、
 *  以及**光标矩形与落点的相对关系**（用户看得见的那件事：点哪儿，光标在哪儿）。
 *
 *  用法：node scripts/acceptance/probe-lineend-caret.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-lineend');
const IF = `document.getElementById('editor').contentWindow`;
const DOC = path.join(project, '.perf/repro-fence/user-doc.md');

const LAYOUT = `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const blocks = [...surface.children];
  const index = blocks.findIndex(b => b.textContent.includes('30/50') && b.textContent.includes('多用大型'));
  if (index < 0) return {ok: false};
  const block = blocks[index];
  const last = [...block.querySelectorAll('code[data-type="math-inline"]')].pop();
  const owner = last.closest('.vditor-ir__node');
  const r = (owner.querySelector('.vditor-ir__preview') || owner).getBoundingClientRect();
  const br = block.getBoundingClientRect();
  return {ok: true, index, frame: {x: Math.round(fr.x), y: Math.round(fr.y)},
    blockRight: Math.round(br.right), blockTop: Math.round(br.top), blockBottom: Math.round(br.bottom),
    mathRight: Math.round(r.right), mathTop: Math.round(r.top), mathBottom: Math.round(r.bottom)}; })()`;

/** 一次采样：光标在什么节点、可见矩形、公式展开没展开。 */
const CARET = `(() => { const w = ${IF}, d = w.document;
  const selection = w.getSelection();
  if (!selection.rangeCount) return {none: true};
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const at = start.nodeType === 3 ? start.parentElement : start;
  const code = at.closest && at.closest('code[data-type="math-inline"], code[data-type="math-block"]');
  const owner = at.closest && at.closest('.vditor-ir__node');
  const rect = range.getBoundingClientRect();
  const codeRect = code ? code.getBoundingClientRect() : null;
  return {container: start.nodeType === 3 ? 'TEXT' : start.nodeName,
    offset: range.startOffset,
    inMathCode: !!code,
    expanded: !!(owner && owner.classList.contains('vditor-ir__node--expand')),
    caretRect: {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)},
    codeVisible: codeRect ? (codeRect.width > 0 && codeRect.height > 0) : null,
    codeRect: codeRect ? {w: Math.round(codeRect.width), h: Math.round(codeRect.height)} : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'user-doc.md');
  fs.copyFileSync(DOC, doc);
  fs.chmodSync(doc, 0o666);

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-lineend-caret', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 120000, interval: 80});
    await sleep(1800);
    const layout = await session.js(LAYOUT);
    if (!layout.ok) { console.log('没找到目标段落'); return; }
    console.log('布局：' + JSON.stringify(layout));
    const y = Math.round((layout.mathTop + layout.mathBottom) / 2);
    const spots = [
      ['行尾：公式右缘 +4px', layout.mathRight + 4, y],
      ['行外：段落右缘 +40px', layout.blockRight + 40, y],
      ['对照：公式正中（应当正常）', Math.round((layout.mathRight + 200) / 2), y],
    ];
    for (const [label, lx, ly] of spots) {
      const x = lx + layout.frame.x, absY = ly + layout.frame.y;
      await session.click(x, absY);
      const series = [];
      for (let i = 0; i < 8; i++) { await sleep(200); series.push(await session.js(CARET)); }
      console.log(`\n── ${label}  (页面 ${x},${absY}) ──`);
      for (let i = 0; i < series.length; i++) {
        const s = series[i];
        console.log(`  t=${((i + 1) * 200)}ms  ` + JSON.stringify(s));
      }
      const last = series[series.length - 1];
      const dx = last.caretRect ? last.caretRect.x - x : null;
      const dy = last.caretRect ? last.caretRect.y - absY : null;
      console.log(`  终态：可见=${last.caretRect && (last.caretRect.w > 0 || last.caretRect.h > 0)}  ` +
        `Δx=${dx} Δy=${dy}  在公式源码里=${last.inMathCode} 展开=${last.expanded}`);
    }
    await session.shot('lineend').catch(() => {});
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
