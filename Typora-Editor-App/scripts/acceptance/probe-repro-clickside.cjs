/** 定点复现两件事（2026-09-19 用户截图）：
 *   A. `$a$` 独占一行时，点在公式左侧 → 光标长什么样（native 0×0？合成光标在哪？字形有没有被裁）。
 *   B. `$$ad$$` 块公式展开（源码行）时，在源码行里点不同 x → 光标落在哪个字符位置（"绕过 a 左侧"）。
 *
 *  用法：node scripts/acceptance/probe-repro-clickside.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-clickside');
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

/** 当前光标/选区现场（帧内坐标 + 合成光标）。 */
const 现场 = `(() => { const w = ${IF}; const d = w.document;
  const sel = w.getSelection();
  const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const box = rect => ({x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height)});
  const bar = d.querySelector('[data-typora-caret-proxy]');
  let 落点 = null;
  if (at) {
    const 容器 = at.startContainer;
    const 名字 = 容器.nodeType === 3 ? '#' + String(容器.data).slice(0, 12) : 容器.nodeName + (容器.getAttribute && 容器.getAttribute('data-type') ? '[' + 容器.getAttribute('data-type') + ']' : '');
    落点 = {折叠: at.collapsed, 在: 名字, 偏移: at.startOffset, rect: box(at.getBoundingClientRect()),
      选中文本: at.toString().slice(0, 20)};
  }
  return {落点, 合成光标: bar ? {显示: bar.style.display, rect: box(bar.getBoundingClientRect())} : null, 焦点: d.hasFocus()}; })()`;

/** 把 `$a$` 那一行（inline-node 独占的段落）找出来。 */
const 找A行 = `(() => { const w = ${IF}; const d = w.document;
  const paras = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')];
  const target = paras.find(p => { const node = p.querySelector('.language-math[data-math="a"]'); return !!node; });
  if (!target) return null;
  target.scrollIntoView({block: 'center', behavior: 'instant'});
  const r = target.getBoundingClientRect();
  const node = target.querySelector('[data-type="inline-node"]');
  const nr = node.getBoundingClientRect();
  const pre = node.querySelector('.vditor-ir__preview');
  const katex = node.querySelector('span.katex');
  const cs = w.getComputedStyle(pre);
  return {段: boxify(r), 节点: boxify(nr), 预览: boxify(pre.getBoundingClientRect()), katex: boxify(katex.getBoundingClientRect()),
    预览样式: {overflow: cs.overflow, height: cs.height, lineHeight: cs.lineHeight, verticalAlign: cs.verticalAlign, display: cs.display},
    段样式: (() => { const s = w.getComputedStyle(target); return {lineHeight: s.lineHeight, height: s.height, overflow: s.overflow}; })()};
  function boxify(r) { return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}; } })()`;

/** 把 `$$ad$$` 块（源码 code 里是 "ad"）找出来。 */
const 找B块 = `(() => { const w = ${IF}; const d = w.document;
  const codes = [...d.querySelectorAll('code[data-type="math-block"]')];
  const code = codes.find(c => (c.textContent || '').trim() === 'ad');
  if (!code) return null;
  const block = code.closest('[data-type="math-block"]');
  block.scrollIntoView({block: 'center', behavior: 'instant'});
  const cr = code.getBoundingClientRect();
  return {块: boxify(block.getBoundingClientRect()), 源码: boxify(cr), 源码文本: code.textContent};
  function boxify(r) { return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}; } })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(SOURCE, doc);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-clickside', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2000);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('iframe：' + JSON.stringify(frame));

    // ---------- A. `$a$` 行：公式左侧 ----------
    const A = await session.js(找A行);
    console.log('\n=== A. `$a$` 行结构 ===\n' + JSON.stringify(A, null, 1));
    const clipA = {x: frame.x + Math.max(0, A.段.x - 30), y: frame.y + Math.max(0, A.段.y - 46), width: 320, height: 110, scale: 3};
    console.log('A0 静态截图：' + await shot(session, 'A0-静态', clipA));
    for (const 偏移 of [1, 3, 6, 10, 20]) {
      const x = A.段.x + 偏移;
      const y = A.段.y + Math.round(A.段.h / 2);
      await session.click(frame.x + x, frame.y + y);
      await sleep(320);
      const state = await session.js(现场);
      console.log(`A 点 x=${偏移}（段左+${偏移}）→ ` + JSON.stringify(state));
      if (偏移 === 1 || 偏移 === 6) console.log('   截图：' + await shot(session, 'A-点左' + 偏移, clipA));
    }
    // A 末：按 ← 一次（用户"卡住"的动作）
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37});
    await sleep(250);
    console.log('A 再按 ←：' + JSON.stringify(await session.js(现场)));
    console.log('   截图：' + await shot(session, 'A-按左键后', clipA));

    // ---------- B. `$$ad$$` 源码行：横扫点击 ----------
    const B = await session.js(找B块);
    console.log('\n=== B. `$$ad$$` 块结构 ===\n' + JSON.stringify(B, null, 1));
    // 先点源码正中，让块进入展开态（用户第二张截图就是展开态）
    await session.click(frame.x + B.源码.x + Math.round(B.源码.w / 2), frame.y + B.源码.y + Math.round(B.源码.h / 2));
    await sleep(400);
    const 展开后 = await session.js(找B块);
    console.log('B 展开后结构：' + JSON.stringify(展开后));
    console.log('B 展开后现场：' + JSON.stringify(await session.js(现场)));
    const clipB = {x: frame.x + Math.max(0, B.块.x - 10), y: frame.y + Math.max(0, B.块.y - 20), width: 700, height: 130, scale: 2};
    console.log('B0 展开态截图：' + await shot(session, 'B0-展开态', clipB));
    const xs = [1, 3, 5, 8, 12, 18, 26, 40, 80, 200, 500, 700, 760];
    console.log('\n点击 x（相对源码行左）→ 落点：');
    for (const 偏移 of xs) {
      const x = 展开后.源码.x + 偏移;
      const y = 展开后.源码.y + Math.round(展开后.源码.h / 2);
      await session.click(frame.x + x, frame.y + y);
      await sleep(260);
      const state = await session.js(现场);
      console.log(`  x=+${String(偏移).padStart(3)} → ` + JSON.stringify(state.落点) + ' 合成光标=' + JSON.stringify(state.合成光标 && state.合成光标.rect));
      if ([1, 8, 40].includes(偏移)) console.log('     截图：' + await shot(session, 'B-点左' + 偏移, clipB));
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 6)));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
