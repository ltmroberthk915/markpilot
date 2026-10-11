/** 复现 bug 2：在 `$30/50$` 之后的空白区域点击，光标跳到后面的段落。
 *
 *  用户报告（2026-09-17）：在"线性规划-整数解"那段里，点 `30/50` 之后的空白区域，
 *  光标被扔进后面很远的段落。
 *
 *  本探针同时记录**原生命中测试**（document.caretRangeFromPoint）与**真实点击后的实际落点**，
 *  用来区分"浏览器本来就落在那儿"和"我们自己的处理器把光标改坏了"
 *  （marker-caret-guard.js 的文档头记录过：标题井号那个 bug 就是后者）。
 *
 *  用法：node scripts/acceptance/probe-user-doc-click.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-fence/click');
const IF = `document.getElementById('editor').contentWindow`;
const DOC = path.join(project, '.perf/repro-fence/user-doc.md');

/** 目标线：含 `30/50` 的那条行内公式所在段落的几何，以及它的行内公式清单。 */
const LAYOUT = `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  if (!surface) return {ok: false, error: '没有编辑面'};
  const blocks = [...surface.children];
  const index = blocks.findIndex(block => block.textContent.includes('30/50') && block.textContent.includes('多用大型'));
  if (index < 0) return {ok: false, error: '没找到目标段落'};
  const block = blocks[index];
  const inlines = [...block.querySelectorAll('code[data-type="math-inline"],code[data-type="math-block"]')];
  // 折叠态下源码盒子是隐藏的、尺寸为 0，可见的是外层 inline-node / preview：
  // 三个盒子都量一遍，挑真正有面积的那个当"这条公式在屏幕上的位置"。
  const box = node => { const r = node.getBoundingClientRect();
    return {x: Math.round(r.left), y: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)}; };
  const maths = inlines.map(node => {
    const wrapper = node.closest('.vditor-ir__node') || node;
    const preview = wrapper.querySelector('.vditor-ir__preview');
    const code = box(node), wrap = box(wrapper), prev = preview ? box(preview) : null;
    return {src: node.textContent.slice(0, 24), code, wrap, prev, pick: (prev && prev.w) ? prev : (wrap.w ? wrap : code)};
  });
  const br = block.getBoundingClientRect();
  const lines = [...block.getClientRects()].map(r => ({top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right)}));
  return {ok: true, frame: {x: Math.round(fr.x), y: Math.round(fr.y)}, index, total: blocks.length, maths, lines,
    blockRect: {top: Math.round(br.top), bottom: Math.round(br.bottom), left: Math.round(br.left), right: Math.round(br.right)},
    strongs: [...surface.querySelectorAll('strong')].map(n => n.textContent),
    blockSeq: blocks.map(node => node.nodeName.toLowerCase() + (node.querySelector('code[data-type="math-block"]') ? '<MB>' : ''))}; })()`;

/** 光标落在第几个顶层块、是不是在公式源码/预览里、块内文本偏移。 */
const CARET = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const selection = w.getSelection();
  if (!selection.rangeCount) return {none: true};
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const at = start.nodeType === 3 ? start.parentElement : start;
  const inMath = !!at.closest('code[data-type="math-inline"],code[data-type="math-block"]');
  const inPreview = !!at.closest('.vditor-ir__preview');
  let top = at; while (top && top.parentElement !== surface) top = top.parentElement;
  const index = top ? [...surface.children].indexOf(top) : -1;
  let offset = null;
  if (top) { try { const prefix = d.createRange(); prefix.selectNodeContents(top); prefix.setEnd(start, range.startOffset);
    offset = prefix.toString().length; } catch (error) { offset = null; } }
  return {index, inMath, inPreview, offset, collapsed: range.isCollapsed,
    container: start.nodeType === 3 ? 'TEXT(' + JSON.stringify(start.data.slice(0, 18)) + ')' : start.nodeName,
    blockText: top ? top.innerText.replace(/\\n+/g, ' ').slice(0, 60) : null,
    rect: (() => { const b = range.getBoundingClientRect(); return Math.round(b.x) + ',' + Math.round(b.y); })()}; })()`;

/** 原生命中测试（不改状态）：这个点上浏览器自己会把光标放哪。 */
const NATIVE = (x, y) => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const local = {x: ${x} - Math.round(document.getElementById('editor').getBoundingClientRect().left),
    y: ${y} - Math.round(document.getElementById('editor').getBoundingClientRect().top)};
  const hit = d.caretRangeFromPoint(local.x, local.y);
  if (!hit) return {none: true, local};
  const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
  let top = at; while (top && top.parentElement !== surface) top = top.parentElement;
  return {local, index: top ? [...surface.children].indexOf(top) : -1, offset: hit.startOffset,
    inMath: !!at.closest('code[data-type="math-inline"]'),
    text: top ? top.innerText.replace(/\\n+/g, ' ').slice(0, 50) : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'user-doc-copy.md');
  fs.copyFileSync(DOC, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-user-doc-click', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1800);

    const layout = await session.js(LAYOUT);
    console.log('=== 文档形状 ===');
    console.log('  块序列   : ' + JSON.stringify(layout.blockSeq));
    console.log('  加粗     : ' + JSON.stringify(layout.strongs));
    console.log('  目标段落 #' + layout.index + '/' + layout.total + '  rect=' + JSON.stringify(layout.blockRect));
    console.log("  行内公式 : " + JSON.stringify(layout.maths.map(m => ({src: m.src, pick: m.pick, prev: m.prev}))));
    console.log('  段落各行的几何 : ' + JSON.stringify(layout.lines));

    // 目标：含 30/50 的那条公式（第 3 个），取它所在行的 y。
    const targetMath = layout.maths.find(m => m.src.includes('30/50')) || layout.maths[2] || layout.maths[0];
    if (!targetMath) { console.log('没找到目标公式'); return; }
    const target = targetMath.pick;
    const y = Math.round((target.y + target.bottom) / 2);
    const fx = layout.frame.x, fy = layout.frame.y;

    const spots = [
      ['① 公式右缘 +4px（紧挨公式的空白）', target.right + 4, y],
      ['② 公式右缘 +30px（同行空白）', target.right + 30, y],
      ['③ 段落右缘 -4px（行尾）', layout.blockRect.right - 4, y],
      ['④ 段落右缘 +40px（行外空白）', layout.blockRect.right + 40, y],
      ['⑤ 公式下方 6px（行间空白）', Math.round((target.x + target.right) / 2), target.bottom + 6],
    ];

    for (const [label, lx, ly] of spots) {
      const x = lx + fx, absY = ly + fy;
      const native = await session.js(NATIVE(x, absY));
      await session.click(x, absY);
      await sleep(450);
      const caret = await session.js(CARET);
      const jump = caret.index >= 0 && caret.index !== layout.index;
      console.log(`\n── ${label}  (页面坐标 ${x},${absY}) ──`);
      console.log('  原生命中   : ' + JSON.stringify(native));
      console.log('  点击后光标 : ' + JSON.stringify(caret));
      console.log('  结论       : ' + (jump ? `⚠ 跳到别的块（#${caret.index}，目标段是 #${layout.index}）`
        : caret.index === layout.index ? '落在目标段落内' : '读不到'));
    }
    await session.shot('click-probe').catch(() => {});
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
