/** 两处新口径的验收探针（2026-09-19 用户选定）：
 *   A. 点块公式四周空白带 → 光标落在**最近的可见正文**（上一行行尾 / 下一行行首），不再"没有光标"；
 *      文档首块公式上方那条页边距**不受影响**（保持原语义，场景 84 B / 75 钉着）。
 *   B. 编辑行内公式时，浮出的预渲染框**只在会盖住正文时翻到源码上方**；不会盖住时保持下方；
 *      翻上去顶出编辑面时不翻；表格里（静态流式）不参与。
 *  用法：node scripts/acceptance/probe-repro-flipband.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-flipband');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png', clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2}});
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

const 光标读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 3) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 1).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(-10) + '")' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join('<'); };
  return {在: at ? 链(at.startContainer) : null, 偏移: at ? at.startOffset : -1, rect: box(at && at.getBoundingClientRect()),
    可见: !!(at && at.getBoundingClientRect().height), 标记: w.__typoraBlankBand || null}; })()`;

const 浮框读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const node = [...d.querySelectorAll('.vditor-ir__node--expand[data-type="inline-node"]')][0];
  if (!node) return {没有展开的公式: true};
  const pre = node.querySelector(':scope > .vditor-ir__preview');
  const code = node.querySelector(':scope > code[data-type]');
  // 与浮框相交的正文（探针自己算一遍，不信任产品自报）
  const hit = [];
  const walker = d.createTreeWalker(node.closest('p,li,blockquote,td,th') || d.body, NodeFilter.SHOW_TEXT, {acceptNode: t => {
    if (!t.data || !t.data.trim()) return NodeFilter.FILTER_REJECT;
    const at = t.parentElement;
    if (at?.closest?.('.vditor-ir__preview,code[data-type],[data-type$="-marker"],.vditor-ir__marker')) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT; }});
  let t;
  const preBox = pre.getBoundingClientRect();
  while ((t = walker.nextNode())) {
    const r = d.createRange(); r.selectNodeContents(t);
    for (const rect of r.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.right - preBox.left > 2 && preBox.right - rect.left > 2 && rect.bottom - preBox.top > 2 && preBox.bottom - rect.top > 2) {
        hit.push(String(t.data).trim().slice(0, 14));
        break;
      }
    }
  }
  return {类: String(node.className), 翻到上方: node.classList.contains('typora-preview-above'),
    源码: box(code.getBoundingClientRect()), 浮框: box(preBox),
    浮框在源码下方: preBox.top >= code.getBoundingClientRect().bottom - 2,
    浮框压住的正文: hit.slice(0, 3), 产品自报: w.__typoraPreviewFlip || null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  // 另造两份小素材：① 公式在段落最后一行（下方是空行）② 表格里的公式
  const 尾行文件 = path.join(OUT, '公式在末行.md');
  fs.writeFileSync(尾行文件, ['上面一段文字。', '', '这一段里公式在最后：$a+b=c$', '', '下面一段。', ''].join('\n'), 'utf8');
  const 表格文件 = path.join(OUT, '表格里的公式.md');
  fs.writeFileSync(表格文件, ['| 项 | 值 |', '| --- | --- |', '| 一 | $\\alpha+\\beta$ |', ''].join('\n'), 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-flipband', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);

    // ===== A. 空白带 =====
    const G = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('所有移动的树'));
      return {块: box(block.getBoundingClientRect()), 上一段末尾x: Math.round(para.getBoundingClientRect().right) - 20}; })()`);
    console.log('A 几何：' + JSON.stringify(G));
    const clipA = {x: frame.x + Math.max(0, G.块.x - 16), y: frame.y + Math.max(0, G.块.y - 100), width: 700, height: 240, scale: 2};
    for (const [名, x, y] of [['A01-上带左', G.块.x + 8, G.块.y + 18], ['A02-上带右', 500, G.块.y + 18], ['A03-下带', 500, G.块.y + G.块.h - 8]]) {
      await session.js(`(() => { const w = ${IF}; w.__typoraBlankBand = null; w.__typoraPreviewFlip = null; return 1; })()`);
      await session.click(frame.x + x, frame.y + y);
      await sleep(380);
      console.log(`· ${名} 点(${Math.round(x)},${Math.round(y)}) → ` + JSON.stringify(await session.js(光标读数)));
      console.log('   图：' + await shot(session, 名, clipA));
      await session.js(`(() => { const w = ${IF}; const d = w.document;
        const t = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('养老院'));
        if (t && t.firstChild) { const s = w.getSelection(); s.removeAllRanges(); const r = d.createRange(); r.setStart(t.firstChild, 1); r.collapse(true); s.addRange(r); }
        return 1; })()`);
      await sleep(220);
    }
    // 文档首块公式上方那条页边距：必须仍是"公式之前"（场景 84 B / 75 的口径）
    const 首 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const root = d.querySelector('.vditor-ir .vditor-reset');
      const first = root.children[0];
      const box = first.getBoundingClientRect();
      first.scrollIntoView({block: 'start', behavior: 'instant'});
      const box2 = first.getBoundingClientRect();
      return {x: Math.round(box2.left + 40), y: Math.round(box2.top - 5), 首块类型: first.dataset ? (first.dataset.type || first.tagName) : first.tagName}; })()`);
    await session.js(`(() => { const w = ${IF}; w.__typoraBlankBand = null; return 1; })()`);
    await session.click(frame.x + 首.x, frame.y + 首.y);
    await sleep(360);
    const 首落 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const root = d.querySelector('.vditor-ir .vditor-reset');
      const s = w.getSelection(); if (!s.rangeCount) return {none: true};
      const r = s.getRangeAt(0);
      return {在根元素: r.startContainer === root, 偏移: r.startOffset, 在源码里: !!(r.startContainer.nodeType === 1 ? r.startContainer.closest('code[data-type]') : r.startContainer.parentElement?.closest?.('code[data-type]')),
        标记: w.__typoraBlankBand || null}; })()`);
    console.log('· A04 首块页边距（本素材首块是标题，真正的公式首块用例在场景 84 B）→ ' + JSON.stringify(首落) + '（期望：在根元素、offset 0、不在源码里、无标记）');
    if (首落.标记) console.log('   ✗ 不该被我们的校正动过！');
    await session.close();

  } finally {
    await session.close();
  }

  // ===== B. 浮框翻边（三种素材各起一个实例）=====
  const 测试 = [
    ['B1-用户截图那条', doc, '转化为间隔'],
    ['B2-公式在末行', 尾行文件, '这一段里公式在最后'],
    ['B3-表格里的公式', 表格文件, ''],
  ];
  for (const [标签, 文件, 关键字] of 测试) {
    const s2 = await harness.launch({
      exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
      appArgs: [path.join(project, 'app/main/main.js')],
      label: 'probe-repro-flipband', outDir: OUT, args: [文件], timeout: 300000, inspect: false,
    });
    try {
      await s2.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 200000, interval: 100});
      await sleep(2200);
      const fr = await s2.js(`(() => { const f = document.getElementById('editor');
        const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
      const 点 = await s2.js(`(() => { const w = ${IF}; const d = w.document;
        const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
        ${关键字 ? `const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes(${JSON.stringify(关键字)}));` : `const para = d.querySelector('.vditor-ir .vditor-reset table td');`}
        if (!para) return null;
        const node = para.querySelector('[data-type="inline-node"]');
        if (!node) return null;
        node.scrollIntoView({block: 'center', behavior: 'instant'});
        const r = node.getBoundingClientRect();
        return {x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + r.height / 2), 节点: box(r)}; })()`);
      if (!点) { console.log(`· ${标签}：没找到公式，跳过`); continue; }
      await s2.click(fr.x + 点.x, fr.y + 点.y);
      await sleep(450);
      const 读 = await s2.js(浮框读数);
      console.log(`· ${标签} 点公式(${点.x},${点.y}) → ` + JSON.stringify(读));
      const clip = {x: fr.x + Math.max(0, 点.节点.x - 40), y: fr.y + Math.max(0, 点.节点.y - 60), width: 640, height: 190, scale: 2};
      console.log('   图：' + await shot(s2, 标签, clip));
    } finally {
      await s2.close();
    }
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
