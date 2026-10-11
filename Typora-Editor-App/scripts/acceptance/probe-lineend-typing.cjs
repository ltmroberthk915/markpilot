/** 行尾/行外空白点击之后，**打一个字看看落在哪**——这才是权威判据。
 *
 *  为什么不用 `getBoundingClientRect()` 判：`selectOutside` 把光标放在**元素边界位置**
 *  （父元素的 childNodes 索引上），这种位置型光标的 range 矩形本来就是 0 尺寸，但它能被浏览器
 *  正常绘制、打字也如实落在那里（仓库里 probe-outside-point 的 Q1/Q2 已实测）。
 *  所以判据换成用户真正在意的两件事：
 *    ① 打的字是不是落在**公式外面**（公式源码不变）；
 *    ② 字是不是落在**段落正文**里、当前位置合理。
 *  修前（2026-09-17 实测）：行尾点击会把公式**展开**、光标落在公式源码 **offset 0**，
 *  打字直接写进公式；行外点击则把光标塞进一个**不可见**的 code。
 *
 *  用法：node scripts/acceptance/probe-lineend-typing.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-lineend-typing');
const IF = `document.getElementById('editor').contentWindow`;
const DOC = path.join(project, '.perf/repro-fence/user-doc.md');

const LAYOUT = `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const blocks = [...surface.children];
  const index = blocks.findIndex(b => b.textContent.includes('30/50') && b.textContent.includes('多用大型'));
  if (index < 0) return {ok: false};
  const block = blocks[index];
  const maths = [...block.querySelectorAll('code[data-type="math-inline"]')];
  const last = maths[maths.length - 1];
  const owner = last.closest('.vditor-ir__node');
  const r = (owner.querySelector('.vditor-ir__preview') || owner).getBoundingClientRect();
  const br = block.getBoundingClientRect();
  return {ok: true, index, frame: {x: Math.round(fr.x), y: Math.round(fr.y)},
    blockRight: Math.round(br.right), mathRight: Math.round(r.right),
    mathTop: Math.round(r.top), mathBottom: Math.round(r.bottom),
    lastMathSource: last.textContent}; })()`;

/** 一次取证：光标位置 + 公式源码 + 段落文本 + 光标矩形。 */
const STATE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const blocks = [...surface.children];
  const index = blocks.findIndex(b => b.textContent.includes('30/50') && b.textContent.includes('多用大型'));
  const block = blocks[index];
  const maths = [...block.querySelectorAll('code[data-type="math-inline"]')];
  const last = maths[maths.length - 1];
  const owner = last.closest('.vditor-ir__node');
  const selection = w.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const start = range ? range.startContainer : null;
  const at = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
  const rect = range ? range.getBoundingClientRect() : null;
  return {lastMathSource: last.textContent,
    ownerText: block.textContent.slice(-60),
    inMathCode: !!(at && at.closest && at.closest('code[data-type="math-inline"]')),
    expanded: owner.classList.contains('vditor-ir__node--expand'),
    container: start ? (start.nodeType === 3 ? 'TEXT' : start.nodeName) : null,
    caretRect: rect ? {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)} : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'user-doc.md');
  fs.copyFileSync(DOC, doc);
  fs.chmodSync(doc, 0o666);

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-lineend-typing', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
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
      ['对照：公式正中（应正常）', Math.round((layout.mathRight + 200) / 2), y],
    ];
    for (const [label, lx, ly] of spots) {
      const before = await session.js(STATE);
      await session.click(lx + layout.frame.x, ly + layout.frame.y);
      await sleep(700);
      const afterClick = await session.js(STATE);
      await session.type('Z');
      await sleep(600);
      const afterType = await session.js(STATE);
      // 公式源码有没有被改（打进去就会变）
      const mathIntact = afterType.lastMathSource === before.lastMathSource;
      // 字是不是进了段落正文
      const grewInText = afterType.ownerText.length >= before.ownerText.length;
      console.log(`\n── ${label}  (页面 ${lx + layout.frame.x},${ly + layout.frame.y}) ──`);
      console.log('  点后：' + JSON.stringify({inMathCode: afterClick.inMathCode, expanded: afterClick.expanded, container: afterClick.container, caretRect: afterClick.caretRect}));
      console.log('  打字后：' + JSON.stringify({inMathCode: afterType.inMathCode, expanded: afterType.expanded, container: afterType.container, caretRect: afterType.caretRect}));
      console.log('  末条公式源码：' + JSON.stringify(afterType.lastMathSource));
      console.log('  段落末 60 字：' + JSON.stringify(afterType.ownerText));
      console.log(`  结论：字落在公式**外面**=${mathIntact}  段落在增长=${grewInText}`);
    }
    await session.shot('lineend-typing').catch(() => {});
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
