/** 探针 · 行内公式右缘"点击带"扫描：折叠态 vs 展开态，点在哪一格、光标落在哪一层。
 *
 *  用户 2026-10-01 报 "点击右 `$` 之后半个像素的区域，光标仍进公式源码"。折叠态实测落点
 *  是元素边界位置（公式外），所以嫌疑落在**展开态**：源码 `$ … $` 摊开后，右围栏那一带
 *  的命中几何变了。本探针把两种状态下、右缘前后每个 dx 的落点逐格记下来。
 *
 *  用法：node scripts/acceptance/probe-inline-math-click-band.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-inline-math-click-band');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const BODY = [
  '# 行程问题', '',
  '纵向时刻表，横向：路程/速度=时间', '',
  '循环往返问题：对侧相向出发：$S=L(2n-1)$', '',
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');

const GEOM = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector(${JSON.stringify(SURFACE)});
  const frame = document.getElementById('editor').getBoundingClientRect();
  const R = n => { if (!n) return null; const r = n.getBoundingClientRect();
    return {l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)}; };
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
  const pre = owner.querySelector('[data-type="text-open-marker"],.vditor-ir__marker--pre');
  const post = owner.querySelector('[data-type="text-close-marker"],.vditor-ir__marker--post');
  const code = owner.querySelector('code[data-type="math-inline"]');
  const preview = owner.querySelector('.vditor-ir__preview');
  const 文本 = code && code.firstChild && code.firstChild.nodeType === 3 ? code.firstChild : null;
  const 字符盒 = [];
  if (文本 && owner.classList.contains('vditor-ir__node--expand')) {
    for (let i = 0; i < 文本.length; i++) { const r = d.createRange(); r.setStart(文本, i); r.setEnd(文本, i + 1);
      const b = r.getBoundingClientRect(); 字符盒.push({i, ch: 文本.data[i], l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width * 10) / 10}); }
  }
  return {展开: owner.classList.contains('vditor-ir__node--expand'),
    owner: R(owner), 前围栏: R(pre), 后围栏: R(post), code: R(code), preview: R(preview), 文本: 文本 ? 文本.data : null, 字符盒,
    frame: [Math.round(frame.x), Math.round(frame.y)], y: Math.round(frame.y + owner.getBoundingClientRect().top + owner.getBoundingClientRect().height / 2)}; })()`;

const CARET = `(() => { const w = ${IF}, d = w.document;
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount || !sel.focusNode) return {sel: null};
  const n = sel.focusNode, o = sel.focusOffset;
  const at = n.nodeType === 3 ? n.parentElement : n;
  const pr = d.createRange(); pr.setStart(n, o); pr.collapse(true); const b = pr.getBoundingClientRect();
  return {容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' + JSON.stringify(n.data.slice(0, 12)) : n.nodeName + '.' + String(n.className || '').slice(0, 20),
    偏移: o, 原生: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
    层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('.vditor-ir__preview') ? '预览' : at.closest?.('[data-type$="-marker"]') ? '围栏' : at.closest?.('p,li,h1,h2,h3,h4,h5,h6') ? '正文' : '元素级',
    在公式节点内: !!at.closest?.('.vditor-ir__node[data-type="inline-node"]')}; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'click-band.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-inline-math-click-band', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  /** 把光标落在公式外（点第 4 段正文），并保证公式是折叠的。 */
  const 复位 = async () => {
    const p = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const s = d.querySelector(${JSON.stringify(SURFACE)});
      const 段 = [...s.children].find(n => n.textContent.includes('错时接送'));
      const walker = d.createTreeWalker(段, NodeFilter.SHOW_TEXT); let n = null;
      while (walker.nextNode()) if (walker.currentNode.data.length > 3) { n = walker.currentNode; break; }
      const r = d.createRange(); r.setStart(n, 2); r.setEnd(n, 3); const b = r.getBoundingClientRect();
      return {x: Math.round(frame.x + b.left), y: Math.round(frame.y + b.top + b.height / 2)}; })()`);
    await session.click(p.x, p.y);
    await harness.sleep(250);
    await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
    await harness.sleep(250);
  };
  try {
    await hi.ensureFocus(session);
    // ── 甲：折叠态扫描 ──
    say('\n══ 甲 · 折叠态：右缘前后逐格点击 ══');
    let geom = await session.js(GEOM);
    say('  折叠=' + !geom.展开 + ' owner=' + JSON.stringify(geom.owner) + ' preview=' + JSON.stringify(geom.preview)
      + ' code=' + JSON.stringify(geom.code) + ' 后围栏=' + JSON.stringify(geom.后围栏));
    for (const dx of [-20, -6, -2, -0.5, 0.5, 2, 6, 20]) {
      await 复位();
      geom = await session.js(GEOM);
      const 基点 = geom.owner.r;                       // owner 右缘（iframe 坐标）
      const 点 = {x: Math.round(geom.frame[0] + 基点 + dx), y: geom.y};
      await session.click(点.x, 点.y);
      await harness.sleep(300);
      const 态 = await session.js(CARET);
      const 后 = await session.js(GEOM);
      say(`  dx=${String(dx).padStart(5)} 点(${点.x},${点.y}) → 层=${态.层} 容器=${态.容器} 偏移=${态.偏移} 在公式节点内=${态.在公式节点内} 之后展开=${后.展开}`);
    }
    // ── 乙：展开态扫描 ──
    say('\n══ 乙 · 展开态：先进源码，再看右围栏一带的点击 ══');
    await 复位();
    geom = await session.js(GEOM);
    // 展开：点行末外侧空白（光标到公式外）→ 按 ←（进源码）
    await session.click(Math.round(geom.frame[0] + geom.owner.r + 24), geom.y);
    await harness.sleep(300);
    say('  行末外侧点空白后：' + JSON.stringify(await session.js(CARET)));
    await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
    await harness.sleep(400);
    geom = await session.js(GEOM);
    say('  按 ← 之后：展开=' + geom.展开 + ' 容器/偏移=' + JSON.stringify(await session.js(CARET)));
    say('  展开态几何：前围栏=' + JSON.stringify(geom.前围栏) + ' 后围栏=' + JSON.stringify(geom.后围栏)
      + ' code=' + JSON.stringify(geom.code) + ' preview=' + JSON.stringify(geom.preview) + ' owner=' + JSON.stringify(geom.owner));
    say('  源码文本=' + JSON.stringify(geom.文本) + ' 末尾字符盒=' + JSON.stringify(geom.字符盒.slice(-3)));
    for (const dx of [-8, -3, -1, -0.5, 0.5, 2, 5, 12]) {
      // 每次重新进源码态
      await 复位();
      const g0 = await session.js(GEOM);
      await session.click(Math.round(g0.frame[0] + g0.owner.r + 24), g0.y);
      await harness.sleep(250);
      await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
      await harness.sleep(350);
      const g1 = await session.js(GEOM);
      if (!g1.展开) { say(`  dx=${dx} § 没能进展开态，跳过（${JSON.stringify(await session.js(CARET))}）`); continue; }
      const 基点 = g1.后围栏 ? g1.后围栏.r : g1.code.r;      // 后围栏右缘（展开态的关键边界）
      const 点 = {x: Math.round(g1.frame[0] + 基点 + dx), y: g1.y};
      await session.js(`(() => { const w = ${IF}; delete w.__typoraInlineMathOutside; delete w.__typoraInlineMathClick; return 1; })()`);
      await session.click(点.x, 点.y);
      await harness.sleep(350);
      const 态 = await session.js(CARET);
      const 标记 = await session.js(`(() => { const w = ${IF}; return {外部点击: w.__typoraInlineMathOutside || null, 定位: w.__typoraInlineMathClick || null}; })()`);
      const 后 = await session.js(GEOM);
      say(`  dx=${String(dx).padStart(5)} 点(${点.x},${点.y}) → 层=${态.层} 容器=${态.容器} 偏移=${态.偏移} 在公式节点内=${态.在公式节点内} 之后展开=${后.展开} 标记=${JSON.stringify(标记)}`);
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
