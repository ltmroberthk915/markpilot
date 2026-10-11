/** 承接 probe-repro-aftermath.cjs：公式展开后，"设"那一点的命中测试与几何到底是谁的。
 *  用法：node scripts/acceptance/probe-repro-aftermath2.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-aftermath2');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 诊断 = (x, y) => `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const 名 = el => { if (!el) return null; const cls = (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 3).join('.');
    return el.nodeName + (cls ? '.' + cls : '') + (el.getAttribute && el.getAttribute('data-type') ? '[' + el.getAttribute('data-type') + ']' : ''); };
  const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
  const node = para.querySelector('[data-type="inline-node"]');
  const code = node.querySelector('code[data-type="math-inline"]');
  const preview = node.querySelector('.vditor-ir__preview');
  const markers = [...node.querySelectorAll('.vditor-ir__marker')];
  // 点后面那段正文的每个文本节点（结构 + 首字符矩形）
  const 后继 = [];
  const walker = d.createTreeWalker(para, NodeFilter.SHOW_TEXT);
  let text;
  while ((text = walker.nextNode())) {
    if (!text.data.trim()) continue;
    const r = d.createRange(); r.setStart(text, 0); r.setEnd(text, Math.min(1, text.data.length));
    const b = r.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    后继.push({文本: String(text.data).slice(0, 12), 父: 名(text.parentElement), 首字: box(b)});
  }
  const hit = d.elementFromPoint(${x}, ${y});
  const caret = d.caretRangeFromPoint ? d.caretRangeFromPoint(${x}, ${y}) : null;
  const caretBox = caret ? box(caret.getBoundingClientRect()) : null;
  return {公式节点: {类: String(node.className), rect: box(node.getBoundingClientRect())},
    源码: {显示: w.getComputedStyle(code).display, rect: box(code.getBoundingClientRect())},
    围栏: markers.map(m => ({类: String(m.className).split(' ').join('.'), rect: box(m.getBoundingClientRect()), 文本: String(m.textContent)})),
    预览: box(preview.getBoundingClientRect()),
    段内文本节点: 后继,
    命中元素: 名(hit), 命中矩形: hit ? box(hit.getBoundingClientRect()) : null,
    命中链: (() => { const out = []; let cur = hit; while (cur && out.length < 5) { out.push(名(cur)); cur = cur.parentElement; } return out.join(' < '); })(),
    落点: caret ? {在: 名(caret.startContainer.nodeType === 3 ? caret.startContainer.parentElement : caret.startContainer), 偏移: caret.startOffset, rect: caretBox} : null}; })()`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png', clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2}});
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-aftermath2', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
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
    const clip = {x: frame.x + Math.max(0, 锚.公式.x - 40), y: frame.y + Math.max(0, 锚.公式.y - 40), width: 620, height: 170, scale: 3};
    // 点公式让它展开
    await session.click(frame.x + 锚.公式.x + Math.round(锚.公式.w / 2), frame.y + 锚.公式.y + Math.round(锚.公式.h / 2));
    await sleep(420);
    console.log('公式已展开。带标记图：' + await shot(session, '01-展开态', clip));
    // "设"字矩形（展开态下重新算）
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
    console.log('“设”字中心：' + JSON.stringify(字));
    console.log('\n展开态几何 + 命中诊断：\n' + JSON.stringify(await session.js(诊断(字.x, 字.y)), null, 1));
    console.log('\n点"设"：');
    await session.click(frame.x + 字.x, frame.y + 字.y);
    await sleep(420);
    console.log(JSON.stringify(await session.js(诊断(字.x, 字.y)), null, 1));
    console.log('带标记图：' + await shot(session, '02-点设之后', clip));
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
