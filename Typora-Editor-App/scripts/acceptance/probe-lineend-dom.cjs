/** 行尾右侧那几像素上，**浏览器自己**看到的是什么？
 *
 *  合成几何（固定余量扫描）复现不出"公式被展开 + 光标进公式源码"这条用户现象，
 *  而用户文档上一打就中。差别只可能在命中的元素上——所以这里直接把
 *  `elementFromPoint` / `caretRangeFromPoint` 在**公式右缘附近逐像素**问一遍，
 *  并把公式节点的 DOM 子树连盒子一起倒出来（含标记 span、预览、hidden 的 code）。
 *
 *  两张素材同一次运行：用户文档（现象源）+ 合成段（扫出来的等价几何），
 *  输出对齐比较，找出"到底哪一层盒子不一样"。
 *
 *  用法：node scripts/acceptance/probe-lineend-dom.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-lineend-dom');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';
const USER_DOC = path.join(project, '.perf/repro-fence/user-doc.md');

/** 合成段：固定余量的一行，用来和用户文档对齐比较（几何等价、DOM 应当同形）。 */
const SYNTH = [
  '# 合成对照',
  '',
  '第 0 段：' + 'A'.repeat(76) + ' $x+1$',
  '',
  '第 1 段：' + 'A'.repeat(60) + ' $x+1$',
  '',
].join('\n');

/** 目标块的定位：用户文档按文字找，合成文档按第几段找。 */
const FIND_USER = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = [...surface.children];
  const index = blocks.findIndex(b => b.textContent.includes('30/50') && b.textContent.includes('多用大型'));
  return {index, count: blocks.length}; })()`;

/** 一个块的"事实全景"：行盒、行内公式的每一层盒子、以及右缘附近的逐点命中。 */
const FACTS = `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = [...surface.children];
  const block = blocks[__INDEX__];
  if (!block) return {ok: false, error: '没有这一段'};
  block.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const fr = frame.getBoundingClientRect();
  const br = block.getBoundingClientRect();
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect();
    return {l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)}; };
  const style = node => { const s = w.getComputedStyle(node); return {display: s.display, visibility: s.visibility, position: s.position, w: s.width}; };
  const maths = [...block.querySelectorAll('code[data-type="math-inline"]')];
  const last = maths[maths.length - 1];
  const owner = last ? last.closest('.vditor-ir__node') : null;
  // 公式节点的整棵子树（含标记、预览、hidden 的 code），逐层盒子
  const tree = node => [...node.children].map(child => ({
    tag: child.tagName.toLowerCase(), cls: String(child.className).slice(0, 60),
    data: child.dataset ? JSON.stringify(child.dataset).slice(0, 60) : null,
    text: child.children.length ? null : String(child.textContent).slice(0, 24),
    box: box(child), style: style(child),
    kids: child.children.length ? tree(child) : []}));
  const lastLine = (() => { const rr = d.createRange(); rr.selectNodeContents(block);
    const rects = [...rr.getClientRects()].filter(x => x.width > 0 && x.height > 0);
    return rects.length ? {count: rects.length, box: box({getBoundingClientRect: () => rects[rects.length - 1]})} : {count: 0}; })();
  const pr = owner ? (owner.querySelector('.vditor-ir__preview') || owner).getBoundingClientRect() : null;
  const y = pr ? Math.round((pr.top + pr.bottom) / 2) : Math.round((br.top + br.bottom) / 2);
  const line = pr ? {top: Math.round(pr.top), bottom: Math.round(pr.bottom)} : {top: Math.round(br.top), bottom: Math.round(br.bottom)};
  // 沿公式右缘往右逐点问浏览器：命中的元素是谁、原生 caret 落在哪
  const probes = [];
  if (pr) {
    for (const dx of [-6, -2, 0, 2, 4, 6, 8, 12, 20, 40]) {
      const x = pr.right + dx;
      const hit = d.elementFromPoint(x, y);
      const caret = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
      const start = caret ? caret.startContainer : null;
      const at = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
      probes.push({dx, x: Math.round(x), y,
        hit: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 40) : null,
        hitData: hit && hit.dataset ? JSON.stringify(hit.dataset) : null,
        caret: caret ? {容器: start.nodeType === 3 ? 'TEXT' : start.nodeName, 偏移: caret.startOffset,
          inPreview: !!(at.closest && at.closest('.vditor-ir__preview')),
          inCode: !!(at.closest && at.closest('code')),
          inNode: !!(at.closest && at.closest('.vditor-ir__node')),
          文本: start.nodeType === 3 ? String(start.data).slice(0, 12) : String(start.textContent || '').slice(0, 12)} : null});
    }
  }
  return {ok: true, block: box(block), blockText: block.textContent.slice(0, 40),
    lineCount: lastLine.count, lastLine: lastLine.box,
    previewBox: box(owner && owner.querySelector('.vditor-ir__preview')),
    ownerBox: box(owner), codeBox: box(last),
    outerHTML: String(block.innerHTML).slice(0, 1500),
    ownerTree: owner ? tree(owner) : null,
    probes, frame: {x: Math.round(fr.x), y: Math.round(fr.y)}}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const report = {};
  const dump = (title, facts) => {
    console.log('\n══════ ' + title + ' ══════');
    if (!facts.ok) { console.log('  ✗ ' + facts.error); return; }
    console.log('  块盒=' + JSON.stringify(facts.block) + '  行数=' + facts.lineCount + '  末行=' + JSON.stringify(facts.lastLine));
    console.log('  公式：owner=' + JSON.stringify(facts.ownerBox) + ' preview=' + JSON.stringify(facts.previewBox) + ' code=' + JSON.stringify(facts.codeBox));
    console.log('  右缘余量 = 块右 - 预览右 = ' + (facts.block.r - facts.previewBox.r) + '   预览右→块右 = ' + (facts.block.r - facts.previewBox.r) + 'px');
    console.log('  owner 子树：');
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        console.log('    ' + '  '.repeat(depth) + `<${node.tag} class="${node.cls}"${node.data ? ' data=' + node.data : ''}>` +
          ` box=${JSON.stringify(node.box)} display=${node.style.display} vis=${node.style.visibility}` + (node.text ? ' text=' + JSON.stringify(node.text) : ''));
        walk(node.kids, depth + 1);
      }
    };
    if (facts.ownerTree) walk(facts.ownerTree, 0);
    console.log('  逐点命中（x = 预览右缘 + dx）：');
    for (const probe of facts.probes) {
      console.log(`    dx=${String(probe.dx).padStart(4)} x=${probe.x} 命中=<${probe.hit}>${probe.hitData || ''} 原生 caret=` + JSON.stringify(probe.caret));
    }
  };

  // '' = 用文字找（用户文档）；否则按"第几个含公式的段"找（合成文档里第 0 段是标题）
  const FIND_MATH = `(() => { const w = ${IF}, d = w.document;
    const surface = d.querySelector(${JSON.stringify(SURFACE)});
    const blocks = [...surface.children];
    const index = blocks.findIndex(b => b.querySelector('code[data-type="math-inline"]'));
    return {index, count: blocks.length}; })()`;
  for (const [title, doc, indexOf] of [
    ['用户文档', USER_DOC, null],
    ['合成对照', path.join(OUT, 'synth.md'), 'math'],
  ]) {
    if (doc !== USER_DOC) fs.writeFileSync(doc, SYNTH);
    const session = await harness.launch({
      exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
      appArgs: [path.join(project, 'app/main/main.js')],
      label: 'probe-lineend-dom', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
    });
    try {
      const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
      if (!ready) { console.log('编辑器没有就绪：' + title); continue; }
      await sleep(1800);
      const found = indexOf === null ? await session.js(FIND_USER)
        : indexOf === 'math' ? await session.js(FIND_MATH) : {index: indexOf};
      report[title] = {found};
      if (found.index < 0) { console.log('\n══════ ' + title + ' ══════ 没找到目标段'); continue; }
      const facts = await session.js(FACTS.replace('__INDEX__', String(found.index)));
      report[title].facts = facts;
      dump(title, facts);
      await session.shot('dom-' + title).catch(() => {});
    } finally {
      await session.close();
    }
  }
  fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify(report, null, 2));
  console.log('\n明细：' + path.join(OUT, 'facts.json'));
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
