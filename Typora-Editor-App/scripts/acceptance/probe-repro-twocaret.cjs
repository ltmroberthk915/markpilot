/** 复现用户"点空白区出现两个光标"（第二张图）——**小 fixture 定点复现**。
 *
 *  用户截图上的场景（doc A 原文第 10–18 行）：
 *    `**非整数解**:` / 长段（段末一条长行内公式，预览折行成第二行 `1w大型 = 65/40 > 小型 = 30/50`）
 *    / `**整数解**` / `$$` 块（源码一行：直接从非整数解…(16,4),(15,6)）/ 空行 / 下一段
 *  用户动作：点该块源码那一行的**右下方一点（未到下一行）**，前提可能是先按过 Enter 建了下一行 → **两根竖线**。
 *
 *  fixture 从原文原样切出来（字符逐字一致），放在文档顶端，避免滚动带来的坐标问题。
 *  用法：node scripts/acceptance/probe-repro-twocaret.cjs [--app=dev|installed|<exe>] [--real]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-twocaret');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const SOURCE = path.join(DIR, '新建 Markdown 文档-副本.md');
const IF = `document.getElementById('editor').contentWindow`;
const NEEDLE = '(16,4),(15,6)';

const ARG = (name, dflt) => {
  const hit = process.argv.slice(2).find(item => item.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const APP = ARG('app', 'dev');
const USE_REAL = process.argv.includes('--real');

const boxOf = `const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;`;

const 现场 = `(() => { const w = ${IF}; const d = w.document; ${boxOf}
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 6) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[dt=' + cur.getAttribute('data-type') + ']' : '')
        + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 12) + '",len' + String(cur.data).length + ')' : (cls ? '.' + cls : '')));
      cur = cur.parentNode; } return out.join(' < '); };
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  return {光标: at ? {折叠: at.collapsed, 链: 链(at.startContainer), 偏移: at.startOffset, rect: box(at.getBoundingClientRect())} : null,
    合成: bar ? {显示: bar.style.display, left: bar.style.left, top: bar.style.top, height: bar.style.height,
      rect: box(bar.getBoundingClientRect())} : null,
    合成计数: w.__caretProxyShown || 0, 空白带: w.__typoraBlankBand || null, 横线: w.__typoraHLine || null}; })()`;

const 复算 = `(() => { const w = ${IF}; const d = w.document; ${boxOf}
  const sel = w.getSelection(); if (!sel || !sel.rangeCount) return {无选区: true};
  const node = sel.focusNode, offset = sel.focusOffset;
  const 可绘 = n => { if (!n || n.nodeType !== 1) return null;
    const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null; return r && r.height ? r : null; };
  let 前 = null, 后 = null; const 起点0 = node;
  const 块0 = 起点0.nodeType === 3 ? 起点0.parentElement : 起点0;
  const 块 = 块0 && 块0.closest ? 块0.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : 块0;
  if (起点0.nodeType !== 3) {
    const kids = 起点0.childNodes; const index = Math.min(Math.max(offset | 0, 0), kids.length);
    for (let i = index - 1; i >= 0 && !前; i--) if (kids[i].nodeType === 1) 前 = 可绘(kids[i]);
    for (let i = index; i < kids.length && !后; i++) if (kids[i].nodeType === 1) 后 = 可绘(kids[i]);
  } else {
    let cur = 起点0;
    while (cur && cur !== 块) { for (let s = cur.previousSibling; s && !前; s = s.previousSibling) if (s.nodeType === 1) 前 = 可绘(s);
      if (前) break; cur = cur.parentNode; }
    cur = 起点0;
    while (cur && cur !== 块) { for (let s = cur.nextSibling; s && !后; s = s.nextSibling) if (s.nodeType === 1) 后 = 可绘(s);
      if (后) break; cur = cur.parentNode; }
  }
  const 块框 = 块 && 块.getBoundingClientRect ? 块.getBoundingClientRect() : null;
  const 样式 = 块 ? w.getComputedStyle(块) : null;
  const 行高值 = (() => { const v = parseFloat(样式 && 样式.lineHeight);
    if (Number.isFinite(v) && v > 0) return Math.round(v * 100) / 100;
    return Math.round(Math.max(14, parseFloat((样式 && 样式.fontSize) || 16) * 1.45) * 100) / 100; })();
  const x = 前 ? 前.right - 1 : 后 ? 后.left : (块框 ? 块框.left : null);
  const top = 前 ? 前.top : 后 ? 后.top : (块框 ? 块框.top : null);
  const height = Math.min(前 ? 前.height : 后 ? 后.height : 行高值, 行高值);
  const 源码里 = !!(node.closest && node.closest('code[data-type]'));
  return {落点类型: 起点0.nodeType === 3 ? '文本' : '元素级(' + 起点0.nodeName + ')', 在源码里: 源码里,
    块标签: 块 ? 块.tagName : null, 块框: box(块框), 前: box(前), 后: box(后), 行高值,
    算出的框: {x: Math.round(x), top: Math.round(top), height: Math.round(height)}}; })()`;

const 结构 = `(() => { const w = ${IF}; const d = w.document; ${boxOf}
  const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
  if (!blk) return {没找到: true};
  const code = blk.querySelector('code[data-type="math-block"]');
  return {展开: blk.classList.contains('vditor-ir__node--expand'), 块框: box(blk.getBoundingClientRect()),
    源码框: code ? box(code.getBoundingClientRect()) : null,
    块内节点: [...blk.childNodes].map(n => n.nodeName + (n.getAttribute && n.getAttribute('data-type') ? '[dt=' + n.getAttribute('data-type') + ']' : '')
      + (n.nodeType === 3 ? '("' + String(n.data).slice(0, 8) + '")' : '{' + box(n.getBoundingClientRect()) + '}')),
    源码子节点: code ? [...code.childNodes].map(n => n.nodeName + (n.nodeType === 3 ? '("' + String(n.data).slice(0, 30) + '",len' + String(n.data).length + ')' : '{' + box(n.getBoundingClientRect()) + '}')) : null,
    前一块: blk.previousElementSibling ? blk.previousElementSibling.tagName + ' ' + JSON.stringify(box(blk.previousElementSibling.getBoundingClientRect())) : null,
    后一块: blk.nextElementSibling ? blk.nextElementSibling.tagName + ' ' + JSON.stringify(box(blk.nextElementSibling.getBoundingClientRect())) : null,
    内高: w.innerHeight}; })()`;

async function shot(session, name, clip) {
  const result = await session.send('Page.captureScreenshot', {
    format: 'png', clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 2}});
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

const 画标记 = (S, G, 额外) => `(() => { const w = ${IF}; const d = w.document;
  const old = d.getElementById('__cal'); if (old) old.remove();
  const layer = d.createElement('div'); layer.id = '__cal';
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const add = css => { const el = d.createElement('div'); el.style.cssText = 'position:fixed;pointer-events:none;' + css; layer.appendChild(el); };
  const 光标 = ${JSON.stringify(S.光标 ? S.光标.rect : null)};
  if (光标) add('left:' + 光标.x + 'px;top:' + 光标.y + 'px;width:1px;height:' + 光标.h + 'px;background:#ff2d2d;');
  const 合成 = ${JSON.stringify(S.合成 && S.合成.显示 !== 'none' ? S.合成.rect : null)};
  if (合成) add('left:' + (合成.x - 3) + 'px;top:' + 合成.y + 'px;width:2px;height:' + 合成.h + 'px;background:#2dd4ff;');
  const 块框 = ${JSON.stringify(额外 && 额外.块框 ? 额外.块框 : null)};
  if (块框) add('left:' + 块框.x + 'px;top:' + 块框.y + 'px;width:' + 块框.w + 'px;height:' + 块框.h + 'px;border:1px dashed #ffb020;box-sizing:border-box;');
  const 源码框 = ${JSON.stringify(额外 && 额外.源码框 ? 额外.源码框 : null)};
  if (源码框) add('left:' + 源码框.x + 'px;top:' + 源码框.y + 'px;width:' + 源码框.w + 'px;height:' + 源码框.h + 'px;border:1px dashed #5ce1e6;box-sizing:border-box;');
  const 点 = ${JSON.stringify(额外 && 额外.点 ? 额外.点 : null)};
  if (点) add('left:' + (点[0] - 4) + 'px;top:' + (点[1] - 4) + 'px;width:8px;height:8px;border:1px solid #ff5cf0;border-radius:50%;box-sizing:border-box;');
  d.body.appendChild(layer); return 1; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  let doc;
  if (USE_REAL) {
    doc = path.join(OUT, 'real-copy.md');
    fs.copyFileSync(SOURCE, doc);
  } else {
    const 原文 = fs.readFileSync(SOURCE, 'utf8').split('\n');
    doc = path.join(OUT, 'fixture.md');
    fs.writeFileSync(doc, 原文.slice(10, 19).join('\n') + '\n', 'utf8');   // 第 10–18 行，原样
    console.log('fixture（原文 10–18 行）：\n' + fs.readFileSync(doc, 'utf8'));
  }
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? path.join(process.env.LOCALAPPDATA || 'D:/Users/ltmroberthk/AppData/Local', 'Programs/markpilot/MarkPilot.exe')
    : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-repro-twocaret', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    let B = await session.js(结构);
    console.log('app=' + APP + '  iframe=' + JSON.stringify(frame));
    console.log('\n【静态结构】' + JSON.stringify(B, null, 1));
    if (B.没找到) { console.log('没找到目标块，退出'); return; }
    const clip = {x: frame.x + Math.max(0, B.块框.x - 40), y: frame.y + Math.max(0, B.块框.y - 90), width: Math.min(940, frame.w), height: 300, scale: 2};

    // ① 点源码那一行末尾（"(16,4),(15,6)" 之后）
    const 行末 = await session.js(`(() => { const w = ${IF}; const d = w.document; ${boxOf}
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      const code = blk.querySelector('code[data-type="math-block"]');
      const tn = [...code.childNodes].find(n => n.nodeType === 3 && n.data.includes(${JSON.stringify(NEEDLE)}));
      if (!tn) return {没有文本节点: true, 子节点: [...code.childNodes].map(n => n.nodeName)};
      const rng = d.createRange(); const i = tn.data.indexOf(${JSON.stringify(NEEDLE)}) + ${JSON.stringify(NEEDLE)}.length;
      rng.setStart(tn, i); rng.setEnd(tn, i);
      return {行末框: box(rng.getBoundingClientRect()), 文本: String(tn.data), 行矩形们: [...code.getClientRects()].map(box)}; })()`);
    console.log('\n【① 行末】' + JSON.stringify(行末));
    if (!行末.行末框) { console.log('拿不到行末矩形，退出'); return; }
    const 点0 = [frame.x + Math.round(行末.行末框.x + 10), frame.y + 行末.行末框.y + Math.round(行末.行末框.h / 2)];
    await session.click(点0[0], 点0[1]);
    await sleep(420);
    console.log('\n① 点源码行末后：\n  现场：' + JSON.stringify(await session.js(现场)));
    console.log('  复算：' + JSON.stringify(await session.js(复算)));
    B = await session.js(结构);
    console.log('  结构：' + JSON.stringify({展开: B.展开, 块框: B.块框, 源码框: B.源码框, 源码子节点: B.源码子节点}));
    console.log('  截图：' + await shot(session, '01-点源码行末', clip));

    // ② Enter 建下一行（用户说的前提）
    await session.key({key: 'Enter', code: 'Enter', vk: 13});
    await sleep(500);
    console.log('\n② Enter 后：\n  现场：' + JSON.stringify(await session.js(现场)));
    console.log('  复算：' + JSON.stringify(await session.js(复算)));
    B = await session.js(结构);
    console.log('  结构：' + JSON.stringify({展开: B.展开, 块框: B.块框, 源码框: B.源码框, 源码子节点: B.源码子节点, 后一块: B.后一块}));
    console.log('  截图：' + await shot(session, '02-Enter后', clip));

    // ③ 用户动作：点"该行右下方一点、未到下一行"（扫几个位置）
    const 行末2 = await session.js(`(() => { const w = ${IF}; const d = w.document; ${boxOf}
      const blk = [...d.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(n => String(n.textContent).includes(${JSON.stringify(NEEDLE)}));
      const code = blk.querySelector('code[data-type="math-block"]');
      return {行矩形们: [...code.getClientRects()].map(box), 源码框: box(code.getBoundingClientRect()), 块框: box(blk.getBoundingClientRect())}; })()`);
    const 首行 = 行末2.行矩形们[0];
    console.log('\n【③前】源码行矩形：' + JSON.stringify(行末2));
    for (const dy of [2, 6, 10, 14, 18]) {
      for (const dx of [40, 240]) {
        const x = frame.x + Math.round(首行.x + dx);
        const y = frame.y + 首行.y + 首行.h + dy;
        await session.click(x, y);
        await sleep(420);
        const S = await session.js(现场);
        const G = await session.js(复算);
        const 双线 = !!(S.合成 && S.合成.显示 !== 'none' && S.合成.rect && S.合成.rect.h > 0 && S.光标 && S.光标.rect && S.光标.rect.h > 0);
        console.log(`\n③ 点(${x - frame.x},${y - frame.y})（源码首行底 +${dy}）：双线=${双线}`);
        console.log('   光标：' + JSON.stringify(S.光标));
        console.log('   合成：' + JSON.stringify(S.合成) + ' 计数=' + S.合成计数);
        console.log('   复算：' + JSON.stringify(G));
        if (双线) {
          await session.js(画标记(S, G, {块框: B.块框, 源码框: B.源码框, 点: [x - frame.x, y - frame.y]}));
          console.log('   带标记截图：' + await shot(session, `双线-x${x - frame.x}-y${y - frame.y}`, clip));
        }
      }
    }
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 4)));
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
