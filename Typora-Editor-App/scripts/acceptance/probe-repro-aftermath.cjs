/** 复现用户 2026-09-19 第二条：点开行内公式之后，点它**后面**的正文（"设"字）
 *  ——光标进不去，公式的展开态也不收回。
 *  用法：node scripts/acceptance/probe-repro-aftermath.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-aftermath');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 现场 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 4) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 10) + '")' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join(' < '); };
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
  const node = para && para.querySelector('[data-type="inline-node"]');
  const 展开 = node ? node.classList.contains('vditor-ir__node--expand') : null;
  const 预览 = node ? node.querySelector('.vditor-ir__preview') : null;
  return {光标: at ? {链: 链(at.startContainer), 偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    合成: bar ? (bar.style.display === 'none' ? 'none' : box(bar.getBoundingClientRect())) : null,
    公式展开: 展开, 公式类: node ? String(node.className) : null,
    预览框: 预览 ? box(预览.getBoundingClientRect()) : null,
    预览定位: 预览 ? (() => { const s = w.getComputedStyle(预览); return {position: s.position, left: s.left, top: s.top, display: s.display}; })() : null}; })()`;

/** 找一个字符的矩形（在编辑器 iframe 里按文本找）。 */
const 字矩形 = (字) => `(() => { const w = ${IF}; const d = w.document;
  const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
  if (!para) return null;
  const walker = d.createTreeWalker(para, NodeFilter.SHOW_TEXT);
  let text;
  while ((text = walker.nextNode())) {
    const index = String(text.data).indexOf(${JSON.stringify(字)});
    if (index < 0) continue;
    if (text.parentElement.closest('.vditor-ir__preview')) continue;
    const r = d.createRange(); r.setStart(text, index); r.setEnd(text, index + 1);
    const b = r.getBoundingClientRect();
    return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), rect: {x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height)},
      文本: String(text.data).slice(0, 16), 父: text.parentElement.tagName + '.' + String(text.parentElement.className).split(' ')[0]};
  }
  return null; })()`;

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
    label: 'probe-repro-aftermath', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    // 滚到那一行
    const 锚 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes('转化为间隔'));
      para.scrollIntoView({block: 'center', behavior: 'instant'});
      const node = para.querySelector('[data-type="inline-node"]');
      const r = node.getBoundingClientRect();
      return {公式: {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}}; })()`);
    const 字 = await session.js(字矩形('设'));
    console.log('公式：' + JSON.stringify(锚.公式) + '\n"设"字：' + JSON.stringify(字));
    const clip = {x: frame.x + Math.max(0, 锚.公式.x - 40), y: frame.y + Math.max(0, 锚.公式.y - 40), width: 900, height: 200, scale: 2};
    console.log('0 起始：' + await shot(session, '00-起始', clip));
    // ① 点公式（让它展开，和用户截图一样）
    await session.click(frame.x + 锚.公式.x + Math.round(锚.公式.w / 2), frame.y + 锚.公式.y + Math.round(锚.公式.h / 2));
    await sleep(420);
    console.log('\n① 点公式后：' + JSON.stringify(await session.js(现场)));
    console.log('   图：' + await shot(session, '01-点公式', clip));
    // ② 点公式后面的"设"字
    const 字2 = await session.js(字矩形('设'));
    await session.click(frame.x + 字2.x, frame.y + 字2.y);
    await sleep(420);
    console.log('\n② 点"设"后：' + JSON.stringify(await session.js(现场)));
    console.log('   图：' + await shot(session, '02-点设', clip));
    // ③ 再点更后面一点（"总"字旁边）
    const 总 = await session.js(字矩形('设总'));
    if (总) {
      await session.click(frame.x + 总.x, frame.y + 总.y);
      await sleep(420);
      console.log('\n③ 点"设总"后：' + JSON.stringify(await session.js(现场)));
    }
    // ④ 点下一行的正文（远离公式）
    const 下 = await session.js(字矩形('密后'));
    if (下) {
      await session.click(frame.x + 下.x, frame.y + 下.y);
      await sleep(420);
      console.log('\n④ 点下一行"密后"：' + JSON.stringify(await session.js(现场)));
      console.log('   图：' + await shot(session, '04-点下一行', clip));
    }
    // ⑤ 键盘：把光标放进公式再按 →（走出公式）看能不能收回
    await session.click(frame.x + 锚.公式.x + Math.round(锚.公式.w / 2), frame.y + 锚.公式.y + Math.round(锚.公式.h / 2));
    await sleep(300);
    for (let index = 0; index < 12; index++) { await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39}); await sleep(120); }
    await sleep(300);
    console.log('\n⑤ 进公式后连按 12 次 →：' + JSON.stringify(await session.js(现场)));
    console.log('   图：' + await shot(session, '05-右移出公式', clip));
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 4)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
