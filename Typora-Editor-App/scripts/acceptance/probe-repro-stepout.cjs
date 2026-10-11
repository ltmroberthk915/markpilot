/** 复现"光标在公式源码里时，按 ← 会不会绕过公式左边"。
 *  对块公式 `$$ad$$` 与行内公式 `$a$` 各做一遍：先把光标放进源码，然后逐步按 ←（再按 →），
 *  每次记录：容器链、偏移、native 光标矩形、合成光标、展开态，并出图。
 *  用法：node scripts/acceptance/probe-repro-stepout.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-stepout');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;

const 现场 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 4) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 8) + '")' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join(' < '); };
  return {光标: at ? {折叠: at.collapsed, 链: 链(at.startContainer), 偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    合成: bar ? (bar.style.display === 'none' ? 'none' : box(bar.getBoundingClientRect())) : null,
    展开: [...d.querySelectorAll('.vditor-ir__node--expand')].map(n => (n.getAttribute('data-type') || '?') + ':' + String(n.textContent || '').slice(0, 8))}; })()`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png', clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2}});
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

async function 按(session, key, vk, n = 1) {
  for (let index = 0; index < n; index++) {
    await session.key({key, code: key, vk});
    await sleep(180);
  }
}

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-stepout', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe：' + JSON.stringify(frame));

    // ============ 块公式 `$$ad$$` ============
    const 块点 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const code = [...d.querySelectorAll('code[data-type="math-block"]')].find(c => (c.textContent || '').trim() === 'ad');
      const block = code.parentElement.parentElement;
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const r = block.getBoundingClientRect();
      return {块: box(r), 预览: box(block.querySelector('.vditor-ir__preview').getBoundingClientRect())}; })()`);
    console.log('\n=== 块公式 ===\n几何：' + JSON.stringify(块点));
    const clip块 = {x: frame.x + Math.max(0, 块点.块.x - 20), y: frame.y + Math.max(0, 块点.块.y - 30), width: 620, height: 200, scale: 2};
    // 点它可见的渲染结果，让光标进入源码（用户第二张图的状态）
    await session.click(frame.x + 块点.预览.x + 8, frame.y + 块点.预览.y + Math.round(块点.预览.h / 2));
    await sleep(400);
    console.log('① 点预览后：' + JSON.stringify(await session.js(现场)));
    console.log('   图：' + await shot(session, 'B1-进源码', clip块));
    // 先按 → 一次到源码尾部（a d |），再看 ← 一步步走
    await 按(session, 'ArrowRight', 39, 1);
    console.log('② 按 → 一次：' + JSON.stringify(await session.js(现场)));
    for (const step of [1, 2, 3, 4]) {
      await 按(session, 'ArrowLeft', 37, 1);
      console.log('③ ← 第 ' + step + ' 次：' + JSON.stringify(await session.js(现场)));
      console.log('   图：' + await shot(session, 'B-←' + step, clip块));
    }
    // 反向：从块外按 → 进块
    await 按(session, 'ArrowRight', 39, 2);
    console.log('④ 再按 → ×2：' + JSON.stringify(await session.js(现场)));

    // ============ 行内 `$a$` ============
    const 段点 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const para = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => p.querySelector('.language-math[data-math="a"]'));
      para.scrollIntoView({block: 'center', behavior: 'instant'});
      return {段: box(para.getBoundingClientRect()), 节点: box(para.querySelector('[data-type="inline-node"]').getBoundingClientRect())}; })()`);
    console.log('\n=== 行内公式 ===\n几何：' + JSON.stringify(段点));
    const clip段 = {x: frame.x + Math.max(0, 段点.段.x - 30), y: frame.y + Math.max(0, 段点.段.y - 60), width: 420, height: 170, scale: 3};
    await session.click(frame.x + 段点.节点.x + 2, frame.y + 段点.段.y + Math.round(段点.段.h / 2));
    await sleep(400);
    console.log('① 点公式后：' + JSON.stringify(await session.js(现场)));
    console.log('   图：' + await shot(session, 'I1-进源码', clip段));
    for (const step of [1, 2, 3]) {
      await 按(session, 'ArrowLeft', 37, 1);
      console.log('② ← 第 ' + step + ' 次：' + JSON.stringify(await session.js(现场)));
      console.log('   图：' + await shot(session, 'I-←' + step, clip段));
    }
    for (const step of [1, 2, 3]) {
      await 按(session, 'ArrowRight', 39, 1);
      console.log('③ → 第 ' + step + ' 次：' + JSON.stringify(await session.js(现场)));
      console.log('   图：' + await shot(session, 'I-→' + step, clip段));
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 4)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
