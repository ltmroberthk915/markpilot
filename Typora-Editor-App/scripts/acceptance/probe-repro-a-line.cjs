/** 复现用户第一张图的状态：`$$ad$$` 块折叠（只显示居中预览）+ 光标点在 `$a$` 那一行左侧。
 *  图上画校准标记：红线=实测 native 光标矩形，琥珀虚线=浮出的预渲染框，青线=下一段的上下缘。
 *  用法：node scripts/acceptance/probe-repro-a-line.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-a-line');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 几何 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
  const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => p.querySelector('.language-math[data-math="a"]'));
  const node = para.querySelector('[data-type="inline-node"]');
  const pre = node.querySelector('.vditor-ir__preview');
  const code = node.querySelector('code');
  const next = para.nextElementSibling;
  const 块上 = [...d.querySelectorAll('[data-type="math-block"]')].find(b => (b.textContent || '').includes('ad') && !(b.textContent || '').includes('养老'));
  return {段: box(para.getBoundingClientRect()), 节点: box(node.getBoundingClientRect()),
    预览: box(pre.getBoundingClientRect()), 源码: box(code.getBoundingClientRect()),
    下一块: next ? {标签: next.tagName, rect: box(next.getBoundingClientRect())} : null,
    块态: 块上 ? {展开: 块上.classList.contains('vditor-ir__node--expand'), rect: box(块上.getBoundingClientRect())} : null,
    预览样式: (() => { const s = w.getComputedStyle(pre); return {position: s.position, top: s.top, left: s.left, display: s.display, height: s.height}; })()}; })()`;

const 现场 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 4) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 8) + '")' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join(' < '); };
  return {光标: at ? {折叠: at.collapsed, 链: 链(at.startContainer), 偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    合成: bar ? {显示: bar.style.display, rect: box(bar.getBoundingClientRect())} : null,
    展开的节点: [...d.querySelectorAll('.vditor-ir__node--expand')].map(n => (n.getAttribute('data-type') || '?') + ':' + String(n.textContent || '').slice(0, 10))}; })()`;

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
    label: 'probe-repro-a-line', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe：' + JSON.stringify(frame));
    // 让 `$a$` 行居中，并从"块折叠、无光标"的干净状态开始
    await session.js(`(() => { const w = ${IF}; const d = w.document;
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => p.querySelector('.language-math[data-math="a"]'));
      para.scrollIntoView({block: 'center', behavior: 'instant'}); return 1; })()`);
    await sleep(300);
    let G = await session.js(几何);
    console.log('干净态几何：' + JSON.stringify(G, null, 1));
    const clip = {x: frame.x + Math.max(0, G.段.x - 30), y: frame.y + Math.max(0, G.段.y - 120), width: 640, height: 300, scale: 2};
    console.log('静态图：' + await shot(session, '00-静态', clip));
    // ① 点行内公式左缘（用户第一张图那个动作）
    await session.click(frame.x + G.节点.x + 1, frame.y + G.段.y + Math.round(G.段.h / 2));
    await sleep(400);
    let S = await session.js(现场);
    G = await session.js(几何);
    console.log('\n① 点公式左缘后：');
    console.log('  现场：' + JSON.stringify(S));
    console.log('  几何：' + JSON.stringify(G));
    // 校准标记：红=native 光标，琥珀虚线=浮出的预渲染框，青=下一段上下缘
    await session.js(`(() => { const w = ${IF}; const d = w.document;
      const old = d.getElementById('__cal'); if (old) old.remove();
      const layer = d.createElement('div'); layer.id = '__cal';
      layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      const add = css => { const el = d.createElement('div'); el.style.cssText = 'position:fixed;pointer-events:none;' + css; layer.appendChild(el); };
      const 光标 = ${JSON.stringify(S.光标 ? S.光标.rect : null)};
      if (光标) add('left:' + 光标.x + 'px;top:' + 光标.y + 'px;width:1px;height:' + 光标.h + 'px;background:#ff2d2d;');
      const 合成 = ${JSON.stringify(S.合成 ? (S.合成.显示 === 'none' ? null : S.合成.rect) : null)};
      if (合成) add('left:' + 合成.x + 'px;top:' + 合成.y + 'px;width:2px;height:' + 合成.h + 'px;background:#2dd4ff;');
      const 预览 = ${JSON.stringify(G.预览)};
      add('left:' + 预览.x + 'px;top:' + 预览.y + 'px;width:' + 预览.w + 'px;height:' + 预览.h + 'px;'
        + 'border:1px dashed #ffb020;box-sizing:border-box;');
      const 段 = ${JSON.stringify(G.段)};
      add('left:' + (段.x - 8) + 'px;top:' + 段.y + 'px;width:' + (段.w + 16) + 'px;height:1px;background:#2dd4ff;');
      add('left:' + (段.x - 8) + 'px;top:' + (段.y + 段.h) + 'px;width:' + (段.w + 16) + 'px;height:1px;background:#2dd4ff;');
      d.body.appendChild(layer); return 1; })()`);
    console.log('① 带标记截图：' + await shot(session, '01-点左缘-带标记', clip));
    // ② 再点同一行的更左（段左缘，公式盒子左边）
    G = await session.js(几何);
    await session.click(frame.x + G.段.x + 1, frame.y + G.段.y + Math.round(G.段.h / 2));
    await sleep(400);
    console.log('\n② 点段左缘后现场：' + JSON.stringify(await session.js(现场)));
    console.log('② 几何：' + JSON.stringify(await session.js(几何)));
    console.log('② 截图：' + await shot(session, '02-点段左缘', clip));
    // ③ 按一次 ←（用户"卡住"的动作），再点一次右移
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
    await sleep(300);
    console.log('\n③ 按 ← 后现场：' + JSON.stringify(await session.js(现场)));
    console.log('③ 截图：' + await shot(session, '03-按左', clip));
    await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39});
    await sleep(300);
    console.log('③ 再按 → 后现场：' + JSON.stringify(await session.js(现场)));
    console.log('③ 截图：' + await shot(session, '04-按右', clip));
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 4)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
