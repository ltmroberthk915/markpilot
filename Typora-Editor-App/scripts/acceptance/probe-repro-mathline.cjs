/** 定点复现：单独一行 `$a$`（行内公式独占一段）被点到时光标与字形如何显示。
 *
 *  来源：2026-09-19 用户截图（那份 1717 字节的《新建 Markdown 文档-副本.md》里，
 *  `$$ad$$` 块公式下面紧跟着一行的 `$a$`）。截图上那一行只有一个竖条光标，
 *  右边露出半个字形。本探针把那一行放大拍下来，并把 DOM 结构、几何、展开态一起打出来。
 *
 *  用法：node scripts/acceptance/probe-repro-mathline.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-mathline');
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

/** 那一行（含行内公式的段落）的现场：结构 + 几何 + 展开态 + 选区。 */
const 现场 = `(() => { const w = ${IF}; const d = w.document;
  const paras = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
  const target = paras.find(p => (p.textContent || '').trim() === 'a') || paras[2] || paras[0];
  if (!target) return {无: true};
  const r = target.getBoundingClientRect();
  const sel = w.getSelection();
  const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const box = rect => rect ? {x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height)} : null;
  const 节点 = target.querySelector('[data-type="inline-node"]');
  const pre = 节点 ? 节点.querySelector('.vditor-ir__preview') : null;
  const code = 节点 ? 节点.querySelector('code[data-type]') : null;
  const 样式 = node => node ? (() => { const s = w.getComputedStyle(node);
    return {display: s.display, position: s.position, overflow: s.overflow, height: s.height, lineHeight: s.lineHeight, fontSize: s.fontSize, opacity: s.opacity, clip: s.clipPath, zIndex: s.zIndex, top: s.top, left: s.left}; })() : null;
  return {
    段: {text: (target.textContent || '').slice(0, 30), rect: box(r), cls: target.className,
      html: target.innerHTML.slice(0, 600)},
    行内节点: 节点 ? {cls: 节点.className, rect: box(节点.getBoundingClientRect()), style: 样式(节点)} : null,
    预览: pre ? {cls: pre.className, rect: box(pre.getBoundingClientRect()), style: 样式(pre),
      子: (pre.firstElementChild ? pre.firstElementChild.className : null),
      子rect: pre.firstElementChild ? box(pre.firstElementChild.getBoundingClientRect()) : null} : null,
    源码: code ? {text: code.textContent, rect: box(code.getBoundingClientRect()), style: 样式(code),
      父cls: code.parentElement.className} : null,
    选区: at ? {锚: at.startContainer.nodeType === 3 ? ('文本:' + at.startContainer.data.slice(0, 20)) : (at.startContainer.nodeName + '[' + at.startContainer.className + ']'),
      偏移: at.startOffset, 折叠: at.collapsed, 文本: at.toString().slice(0, 20), rect: box(at.getBoundingClientRect()),
      锚父: (at.startContainer.nodeType === 3 ? at.startContainer.parentElement.className : at.startContainer.parentElement ? at.startContainer.parentElement.className : null)} : null,
    焦点: d.hasFocus(),
  }; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  console.log('工作副本：' + doc + '（原文件未动）');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-mathline', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe：' + JSON.stringify(frame));
    // 把那一行滚到视口中部，拿到它在帧内的坐标
    const 目标 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const paras = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
      const target = paras.find(p => (p.textContent || '').trim() === 'a');
      if (!target) return null;
      target.scrollIntoView({block: 'center', behavior: 'instant'});
      const r = target.getBoundingClientRect();
      return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        文本: (target.textContent || '').slice(0, 20)}; })()`);
    console.log('目标段（帧内）：' + JSON.stringify(目标));
    if (!目标) throw new Error('没找到 `$a$` 那一行');
    const clip = {
      x: frame.x + Math.max(0, 目标.x - 24),
      y: frame.y + Math.max(0, 目标.y - 70),
      width: 520, height: 190, scale: 2,
    };
    // ⓪ 未点击的静态态
    console.log('⓪ 静态：' + await shot(session, '00-未点击', clip));
    // ① 点在行首（公式左边）
    await session.click(frame.x + 目标.x + 3, frame.y + 目标.y + Math.round(目标.h / 2));
    await sleep(400);
    console.log('① 点行首后现场：' + JSON.stringify(await session.js(现场), null, 1));
    console.log('① 截图：' + await shot(session, '01-点行首', clip));
    // ② 点在字形上（公式正中）
    const 字形 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const paras = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
      const target = paras.find(p => (p.textContent || '').trim() === 'a');
      const node = target && target.querySelector('[data-type="inline-node"]');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    if (字形) {
      await session.click(frame.x + 字形.x + Math.round(字形.w / 2), frame.y + 字形.y + Math.round(字形.h / 2));
      await sleep(400);
      console.log('② 点字形后现场：' + JSON.stringify(await session.js(现场), null, 1));
      console.log('② 截图：' + await shot(session, '02-点字形', clip));
    }
    // ③ 行内公式源码里按 → 走出去（用户最可能的后续动作）
    const 板 = await session.js(`(() => { const w = ${IF}; const sel = w.getSelection();
      if (!sel || !sel.rangeCount) return null; const r = w.getSelection().getRangeAt(0);
      return {折叠: r.collapsed, 文本: r.toString(), x: Math.round(r.getBoundingClientRect().left), h: Math.round(r.getBoundingClientRect().height)}; })()`);
    console.log('③ 按键前选区：' + JSON.stringify(板));
    for (let index = 0; index < 4; index++) {
      await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39});
      await sleep(120);
    }
    await sleep(200);
    console.log('③ 按 4 次 → 之后：' + JSON.stringify(await session.js(现场), null, 1));
    console.log('③ 截图：' + await shot(session, '03-右移四次', clip));
    // ④ 整幅（缩放到能看全）作对照
    console.log('④ 整幅：' + await shot(session, '04-整幅', {x: frame.x, y: frame.y, width: frame.w, height: Math.min(700, frame.h), scale: 1}));
    console.log('console 错误：' + JSON.stringify(session.errors.slice(0, 6)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
