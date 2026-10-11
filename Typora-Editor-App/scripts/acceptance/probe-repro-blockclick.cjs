/** 精确到"点下去命中了哪个元素、光标落在谁身上"的复现：
 *   · `$$ad$$` 块公式：点它可见的每一处（预览、源码行、行首行尾空白）
 *   · `$a$` 行内公式独占一行：点公式左缘、点行首空白
 *  每次点击都记：elementFromPoint、选区容器链、光标矩形、合成光标矩形，并出图（红叉标出点击点）。
 *
 *  用法：node scripts/acceptance/probe-repro-blockclick.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-blockclick');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2},
  });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

/** 画一个红叉 + 短横线标出点击点（fixed，视口坐标）。 */
const 标记 = (x, y) => `(() => { const w = ${IF}; const d = w.document;
  const old = d.getElementById('__pt'); if (old) old.remove();
  const layer = d.createElement('div'); layer.id = '__pt';
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const bar = (cls, css) => { const el = d.createElement('div'); el.style.cssText = 'position:fixed;pointer-events:none;' + css; layer.appendChild(el); };
  bar('h', 'left:' + (${x} - 9) + 'px;top:${y}px;width:18px;height:1px;background:#ff2d2d;');
  bar('v', 'left:${x}px;top:' + (${y} - 9) + 'px;width:1px;height:18px;background:#ff2d2d;');
  d.body.appendChild(layer); return 1; })()`;

const 现场 = (x, y) => `(() => { const w = ${IF}; const d = w.document;
  const sel = w.getSelection();
  const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const box = rect => ({x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height)});
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 5) {
      const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 3).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 10) + '")' : (cls ? '.' + cls : '') + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '')));
      cur = cur.parentNode; }
    return out.join(' < '); };
  const bar = d.querySelector('[data-typora-caret-proxy]');
  return {命中: (() => { const el = d.elementFromPoint(${Math.round(x)}, ${Math.round(y)}); if (!el) return null;
      const cls = (typeof el.className === 'string' ? el.className : '').split(' ').slice(0, 4).join('.');
      const r = el.getBoundingClientRect();
      return {标签: el.tagName + (cls ? '.' + cls : ''), 矩形: box(r), 文本: String(el.textContent || '').slice(0, 16)}; })(),
    光标: at ? {折叠: at.collapsed, 链: 链(at.startContainer), 偏移: at.startOffset, 矩形: box(at.getBoundingClientRect())} : null,
    合成光标: bar ? {显示: bar.style.display, 矩形: box(bar.getBoundingClientRect())} : null,
    展开: (() => { const nodes = [...d.querySelectorAll('.vditor-ir__node--expand')];
      return nodes.map(n => (n.getAttribute('data-type') || '?') + ':' + String(n.textContent || '').slice(0, 8)); })()}; })()`;

async function 点并处(session, frame, x, y, 名, clip) {
  await session.js(标记(x, y));
  await session.click(frame.x + x, frame.y + y);
  await sleep(340);
  const state = await session.js(现场(x, y));
  console.log(`\n· ${名}  点(${Math.round(x)},${Math.round(y)})`);
  console.log('  命中：' + JSON.stringify(state.命中));
  console.log('  光标：' + JSON.stringify(state.光标));
  console.log('  合成：' + JSON.stringify(state.合成光标) + '  展开态：' + JSON.stringify(state.展开));
  console.log('  图：' + await shot(session, 名, clip));
  await session.js(`(() => { const w = ${IF}; const old = w.document.getElementById('__pt'); if (old) old.remove(); return 1; })()`);
  return state;
}

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-blockclick', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe：' + JSON.stringify(frame));
    // 定位：块公式 `$$ad$$` 与行内 `$a$` 行（先滚到中部）
    const 几何 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;                       // div[data-type=math-block]
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const 源码行 = code.parentElement;                                     // pre.vditor-ir__marker--pre
      const 预览 = block.querySelector('.vditor-ir__preview');
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => p.querySelector('.language-math[data-math="a"]'));
      return {块: box(block.getBoundingClientRect()), 源码行: box(源码行.getBoundingClientRect()),
        源码: box(code.getBoundingClientRect()), 预览: box(预览.getBoundingClientRect()),
        段高: box(para.getBoundingClientRect()), 段左: Math.round(para.getBoundingClientRect().left),
        源码行样式: (() => { const s = w.getComputedStyle(源码行); return {display: s.display, height: s.height, overflow: s.overflow, background: s.backgroundColor}; })(),
        预览样式: (() => { const s = w.getComputedStyle(预览); return {display: s.display, position: s.position, height: s.height, overflow: s.overflow}; })()}; })()`);
    console.log('几何：' + JSON.stringify(几何, null, 1));
    const clip块 = {x: frame.x + Math.max(0, 几何.块.x - 16), y: frame.y + Math.max(0, 几何.块.y - 40), width: 700, height: 200, scale: 2};
    const clip段 = {x: frame.x + Math.max(0, 几何.段左 - 30), y: frame.y + Math.max(0, 几何.段高.y - 40), width: 360, height: 130, scale: 3};
    console.log('静态图（块）：' + await shot(session, '00-块静态', clip块));
    // ① 点块公式的**预览**（用户看到的那行居中 "ad"）
    await 点并处(session, frame, 几何.预览.x + 8, 几何.预览.y + 12, '01-点预览左侧', clip块);
    await 点并处(session, frame, 几何.预览.x + Math.round(几何.预览.w / 2), 几何.预览.y + 12, '02-点预览正中', clip块);
    // ② 点"源码行"区域（展开后源码就在这一带）
    await 点并处(session, frame, 几何.源码行.x + 3, 几何.源码行.y + 12, '03-点源码行左', clip块);
    await 点并处(session, frame, 几何.源码行.x + 30, 几何.源码行.y + 12, '04-点源码行中', clip块);
    // ③ 行内 `$a$` 那一行的左侧空白与字形
    await 点并处(session, frame, 几何.段左 + 2, 几何.段高.y + 12, '05-行内段左2', clip段);
    await 点并处(session, frame, 几何.段左 + 6, 几何.段高.y + 12, '06-行内段左6', clip段);
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 4)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
